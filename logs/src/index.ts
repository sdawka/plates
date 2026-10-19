// plates-logs: a Tail Worker for Plates. It stores each invocation's logs in its own D1 database and serves
// them, plus Plates' requests and ask history, behind Cloudflare Access.

import { isConfigured, verifyAccess } from "./access";
import { toRow, worthKeeping, type InvocationRow, type TailItem } from "./ingest";
import { logsPage, requestPage, requestsPage, setupPage, type InvocationView, type LogFilters, type Names, type RequestDetail, type RequestListItem } from "./pages";

export interface LogsEnv {
  LOGS: D1Database;
  /** Plates' database, read only. */
  APP: D1Database;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Optional: shows names instead of Slack ids. */
  SLACK_BOT_TOKEN?: string;
  RETENTION_DAYS?: string;
}

const PAGE = 100;
const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    },
  });

export async function storeRows(db: D1Database, rows: InvocationRow[]): Promise<void> {
  const keep = rows.filter(worthKeeping);
  if (keep.length === 0) return;
  await db.batch(
    keep.map((r) =>
      db
        .prepare("INSERT INTO invocations (at, kind, summary, outcome, level, cpu_ms, wall_ms, lines_json, search) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(r.at, r.kind, r.summary, r.outcome, r.level, r.cpu_ms, r.wall_ms, JSON.stringify(r.lines), `${r.summary}\n${r.lines.map((l) => l.text).join("\n")}`.toLowerCase()),
    ),
  );
}

export async function queryLogs(db: D1Database, f: LogFilters): Promise<{ rows: InvocationView[]; hasMore: boolean }> {
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.level === "error") where.push("level = 'error'");
  if (f.level === "warn") where.push("level IN ('error', 'warn')");
  if (f.kind !== "all") (where.push("kind = ?"), args.push(f.kind));
  if (f.q) (where.push("search LIKE ? ESCAPE '\\'"), args.push(`%${f.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
  if (f.before !== null) (where.push("id < ?"), args.push(f.before));
  const sql = `SELECT id, at, kind, summary, outcome, level, cpu_ms, wall_ms, lines_json FROM invocations ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${PAGE + 1}`;
  const res = await db.prepare(sql).bind(...args).all<Omit<InvocationView, "lines"> & { lines_json: string }>();
  const rows = res.results.slice(0, PAGE).map(({ lines_json, ...r }) => ({ ...r, lines: JSON.parse(lines_json) as InvocationView["lines"] }));
  return { rows, hasMore: res.results.length > PAGE };
}

function parseFilters(url: URL): LogFilters {
  const level = url.searchParams.get("level");
  const before = Number(url.searchParams.get("before"));
  return {
    level: level === "warn" || level === "error" ? level : "all",
    kind: /^(fetch|queue|alarm|scheduled|rpc)$/.test(url.searchParams.get("kind") ?? "") ? url.searchParams.get("kind")! : "all",
    q: (url.searchParams.get("q") ?? "").trim().slice(0, 200),
    before: Number.isInteger(before) && before > 0 ? before : null,
  };
}

const nameCache = new Map<string, string>();
async function resolveNames(env: LogsEnv, ids: (string | null | undefined)[]): Promise<Names> {
  const want = [...new Set(ids.filter((x): x is string => !!x && /^[UW][A-Z0-9]+$/.test(x)))];
  if (env.SLACK_BOT_TOKEN) {
    await Promise.all(
      want.filter((id) => !nameCache.has(id)).map(async (id) => {
        try {
          const res = await fetch(`https://slack.com/api/users.info?user=${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } });
          const body = (await res.json()) as { ok: boolean; user?: { real_name?: string; name?: string; profile?: { display_name?: string } } };
          if (body.ok && body.user) nameCache.set(id, body.user.profile?.display_name || body.user.real_name || body.user.name || id);
        } catch {
          /* show the id */
        }
      }),
    );
  }
  return new Map(want.flatMap((id) => (nameCache.has(id) ? [[id, nameCache.get(id)!] as const] : [])));
}

async function listRequests(db: D1Database): Promise<RequestListItem[]> {
  const res = await db
    .prepare(
      `SELECT r.id, r.created_at, r.status, r.channel_id, r.tagged_by_id, r.requester_id, r.owner_id, r.draft_json,
              (SELECT COUNT(*) FROM asks a WHERE a.request_id = r.id) AS ask_count
       FROM requests r ORDER BY r.created_at DESC LIMIT 100`,
    )
    .all<RequestListItem & { draft_json: string }>();
  return res.results.map(({ draft_json, ...r }) => {
    let titles: string[] = [];
    try {
      titles = (JSON.parse(draft_json) as { title?: string }[]).flatMap((d) => (typeof d.title === "string" ? [d.title] : []));
    } catch {
      /* no titles */
    }
    return { ...r, titles };
  });
}

async function loadRequest(db: D1Database, id: string): Promise<RequestDetail | null> {
  const request = await db.prepare("SELECT * FROM requests WHERE id = ?").bind(id).first<RequestDetail["request"]>();
  if (!request) return null;
  const [asks, events] = await Promise.all([
    db.prepare("SELECT * FROM asks WHERE request_id = ? ORDER BY created_at").bind(id).all<RequestDetail["asks"][number]>(),
    db.prepare("SELECT at, ask_id, actor_id, kind, from_state, to_state, note, via FROM ask_events WHERE request_id = ? ORDER BY at").bind(id).all<RequestDetail["events"][number]>(),
  ]);
  return { request, asks: asks.results, events: events.results };
}

export async function handleFetch(req: Request, env: LogsEnv, fetcher: typeof fetch = fetch): Promise<Response> {
  const access = { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD };
  if (!isConfigured(access)) return html(setupPage(), 403);
  const user = await verifyAccess(req, access, fetcher);
  if (!user) return new Response("Forbidden", { status: 403 });
  if (req.method !== "GET") return new Response("Method not allowed", { status: 405 });

  const url = new URL(req.url);
  if (url.pathname === "/") {
    const f = parseFilters(url);
    const { rows, hasMore } = await queryLogs(env.LOGS, f);
    return html(logsPage(rows, f, user.email, hasMore));
  }
  if (url.pathname === "/requests") {
    const items = await listRequests(env.APP);
    const names = await resolveNames(env, items.flatMap((r) => [r.tagged_by_id, r.requester_id, r.owner_id]));
    return html(requestsPage(items, names, user.email));
  }
  const m = url.pathname.match(/^\/requests\/([^/]+)$/);
  if (m) {
    const detail = await loadRequest(env.APP, decodeURIComponent(m[1]!));
    if (!detail) return html("Not found", 404);
    const r = detail.request as Record<string, unknown>;
    const ids = [r.tagged_by_id, r.requester_id, r.owner_id, r.confirmed_by, ...detail.asks.flatMap((a) => [a.owner_id, a.holder_id]), ...detail.events.map((e) => e.actor_id)];
    const names = await resolveNames(env, ids as string[]);
    return html(requestPage(detail, names, user.email));
  }
  return html("Not found", 404);
}

export async function prune(env: LogsEnv, now = Date.now()): Promise<void> {
  const days = Number(env.RETENTION_DAYS ?? 14) || 14;
  await env.LOGS.prepare("DELETE FROM invocations WHERE at < ?").bind(now - days * 86_400_000).run();
}

export default {
  async tail(events: TraceItem[], env: LogsEnv): Promise<void> {
    await storeRows(env.LOGS, (events as unknown as TailItem[]).map(toRow));
    // No cron on the Free plan: about one tail in fifty also trims what's past retention.
    if (Math.random() < 0.02) await prune(env);
  },

  fetch(req: Request, env: LogsEnv): Promise<Response> {
    return handleFetch(req, env);
  },

} satisfies ExportedHandler<LogsEnv>;
