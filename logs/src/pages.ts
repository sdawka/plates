// Server-rendered pages. Pure: data in, HTML out.

import type { Level, Line } from "./ingest";

export interface InvocationView {
  id: number;
  at: number;
  kind: string;
  summary: string;
  outcome: string;
  level: Level;
  cpu_ms: number | null;
  wall_ms: number | null;
  lines: Line[];
}

export interface LogFilters {
  level: "all" | "warn" | "error";
  kind: string;
  q: string;
  before: number | null;
}

export interface RequestListItem {
  id: string;
  created_at: number;
  status: string;
  channel_id: string;
  tagged_by_id: string;
  requester_id: string | null;
  owner_id: string | null;
  titles: string[];
  ask_count: number;
}

export interface RequestDetail {
  request: Record<string, unknown> & { id: string; created_at: number; status: string };
  asks: (Record<string, unknown> & { id: string; title: string; state: string })[];
  events: { at: number; ask_id: string | null; actor_id: string; kind: string; from_state: string | null; to_state: string | null; note: string | null; via: string }[];
}

export type Names = Map<string, string>;

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const time = (ms: number) => `<time datetime="${new Date(ms).toISOString()}">${esc(new Date(ms).toISOString().replace("T", " ").slice(0, 19))} UTC</time>`;
const who = (id: string | null | undefined, names: Names) =>
  id ? `<span class="who" title="${esc(id)}">${esc(names.get(id) ?? id)}</span>` : `<span class="muted">—</span>`;

const CSS = `
:root { --bg:#f7f7f5; --panel:#fff; --text:#1d1d1b; --muted:#6b6b66; --line:#e4e4df; --accent:#3b5bdb;
  --err:#c92a2a; --err-bg:#fff0f0; --warn:#b35c00; --warn-bg:#fff6e6; --ok:#2b8a3e; --code:#f1f1ee; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#141413; --panel:#1d1d1b; --text:#ecebe6;
  --muted:#9a9993; --line:#2e2e2b; --accent:#8ea4ff; --err:#ff8787; --err-bg:#2a1414; --warn:#ffc078; --warn-bg:#2a2010; --ok:#69db7c; --code:#252523; } }
:root[data-theme="dark"] { --bg:#141413; --panel:#1d1d1b; --text:#ecebe6; --muted:#9a9993; --line:#2e2e2b; --accent:#8ea4ff;
  --err:#ff8787; --err-bg:#2a1414; --warn:#ffc078; --warn-bg:#2a2010; --ok:#69db7c; --code:#252523; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
header { display:flex; gap:16px; align-items:center; padding:12px 16px; border-bottom:1px solid var(--line); background:var(--panel); position:sticky; top:0; z-index:1; flex-wrap:wrap; }
header h1 { font-size:15px; margin:0; }
nav a { color:var(--muted); text-decoration:none; margin-right:12px; }
nav a.on { color:var(--text); font-weight:600; }
.user { margin-left:auto; color:var(--muted); font-size:12px; }
main { padding:16px; max-width:1200px; margin:0 auto; }
form.filters { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; align-items:center; }
input, select, button { font:inherit; color:inherit; background:var(--panel); border:1px solid var(--line); border-radius:6px; padding:6px 8px; }
input[type=search] { flex:1 1 220px; min-width:0; }
button { cursor:pointer; }
label.auto { color:var(--muted); font-size:13px; display:flex; gap:4px; align-items:center; }
.list { background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
details { border-bottom:1px solid var(--line); }
details:last-child { border-bottom:0; }
summary { list-style:none; cursor:pointer; display:grid; grid-template-columns: 170px 64px 1fr auto; gap:10px; padding:8px 12px; align-items:baseline; }
summary::-webkit-details-marker { display:none; }
summary:hover { background:var(--bg); }
.lvl-error summary { background:var(--err-bg); }
.lvl-warn summary { background:var(--warn-bg); }
.kind { font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:.03em; }
.sum { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.meta { color:var(--muted); font-size:12px; white-space:nowrap; }
.bad { color:var(--err); font-weight:600; }
.lines { margin:0; padding:8px 12px 12px; background:var(--code); font:12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space:pre-wrap; word-break:break-word; }
.lines .error { color:var(--err); }
.lines .warn { color:var(--warn); }
.lines .t { color:var(--muted); }
.muted { color:var(--muted); }
.empty { padding:24px; text-align:center; color:var(--muted); }
.more { display:block; padding:10px; text-align:center; color:var(--accent); }
table { width:100%; border-collapse:collapse; background:var(--panel); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { font-size:12px; color:var(--muted); font-weight:600; }
td a { color:var(--accent); text-decoration:none; }
.pill { display:inline-block; padding:1px 8px; border-radius:999px; background:var(--code); font-size:12px; }
.scroll { overflow-x:auto; }
h2 { font-size:15px; margin:20px 0 8px; }
dl { display:grid; grid-template-columns: 160px 1fr; gap:4px 12px; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px; margin:0; }
dt { color:var(--muted); } dd { margin:0; word-break:break-word; }
@media (max-width: 640px) {
  summary { grid-template-columns: 1fr auto; }
  summary .kind, summary time { grid-column: 1 / -1; }
  dl { grid-template-columns: 1fr; }
}
`;

const SCRIPT = `
document.querySelectorAll("time").forEach(t => { const d = new Date(t.getAttribute("datetime")); t.textContent = d.toLocaleString(); t.title = d.toISOString(); });
const auto = document.getElementById("auto");
if (auto) {
  try { auto.checked = localStorage.getItem("plates-logs-auto") === "1"; } catch {}
  let timer = null;
  const arm = () => { clearInterval(timer); if (auto.checked && !document.querySelector("details[open]")) timer = setInterval(() => location.reload(), 10000); };
  auto.addEventListener("change", () => { try { localStorage.setItem("plates-logs-auto", auto.checked ? "1" : "0"); } catch {} arm(); });
  document.addEventListener("toggle", arm, true);
  arm();
}
`;

function layout(title: string, active: "logs" | "requests", user: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<header><h1>Plates logs</h1><nav><a href="/" class="${active === "logs" ? "on" : ""}">Logs</a><a href="/requests" class="${active === "requests" ? "on" : ""}">Requests</a></nav><span class="user">${esc(user)}</span></header>
<main>${body}</main><script>${SCRIPT}</script></body></html>`;
}

function linesHtml(lines: Line[]): string {
  if (lines.length === 0) return `<pre class="lines muted">No log lines.</pre>`;
  return `<pre class="lines">${lines
    .map((l) => `<span class="${l.level}"><span class="t">${esc(new Date(l.t).toISOString().slice(11, 23))}</span> ${esc(l.text)}</span>`)
    .join("\n")}</pre>`;
}

export function logsPage(rows: InvocationView[], f: LogFilters, user: string, hasMore: boolean): string {
  const opt = (v: string, label: string, cur: string) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`;
  const filters = `<form class="filters" method="get">
<input type="search" name="q" value="${esc(f.q)}" placeholder="Search: user id, event, error text…" aria-label="Search">
<select name="level" aria-label="Level">${opt("all", "All levels", f.level)}${opt("warn", "Warnings and errors", f.level)}${opt("error", "Errors only", f.level)}</select>
<select name="kind" aria-label="Kind">${["all", "fetch", "queue", "alarm", "scheduled", "rpc"].map((k) => opt(k, k === "all" ? "All kinds" : k, f.kind)).join("")}</select>
<button type="submit">Filter</button>
<label class="auto"><input type="checkbox" id="auto"> Auto-refresh</label>
</form>`;
  const items = rows
    .map((r) => {
      const ms = [r.wall_ms !== null ? `${r.wall_ms} ms` : null, r.cpu_ms ? `cpu ${r.cpu_ms} ms` : null].filter(Boolean).join(" · ");
      const outcome = r.outcome === "ok" ? "" : ` · <span class="bad">${esc(r.outcome)}</span>`;
      return `<details class="lvl-${r.level}"><summary>${time(r.at)}<span class="kind">${esc(r.kind)}</span><span class="sum">${esc(r.summary)}</span><span class="meta">${r.lines.length} lines${ms ? ` · ${esc(ms)}` : ""}${outcome}</span></summary>${linesHtml(r.lines)}</details>`;
    })
    .join("");
  const next = new URLSearchParams({ level: f.level, kind: f.kind, q: f.q, before: String(rows.at(-1)?.id ?? "") });
  const more = hasMore ? `<a class="more" href="/?${esc(next.toString())}">Older →</a>` : "";
  const list = rows.length ? `<div class="list">${items}${more}</div>` : `<div class="list"><div class="empty">Nothing logged${f.q || f.level !== "all" || f.kind !== "all" ? " for these filters" : " yet"}.</div></div>`;
  return layout("Plates logs", "logs", user, filters + list);
}

export function requestsPage(items: RequestListItem[], names: Names, user: string): string {
  const rows = items
    .map(
      (r) => `<tr><td>${time(r.created_at)}</td><td><span class="pill">${esc(r.status)}</span></td>
<td>${who(r.requester_id, names)} → ${who(r.owner_id, names)}<div class="muted">tagged by ${who(r.tagged_by_id, names)} in ${esc(r.channel_id)}</div></td>
<td><a href="/requests/${esc(encodeURIComponent(r.id))}">${r.titles.map(esc).join("<br>") || "<span class=muted>(no items)</span>"}</a></td><td>${r.ask_count}</td></tr>`,
    )
    .join("");
  const table = items.length
    ? `<div class="scroll"><table><thead><tr><th>Created</th><th>Status</th><th>Who</th><th>Items</th><th>Asks</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<div class="list"><div class="empty">No requests yet.</div></div>`;
  return layout("Requests · Plates logs", "requests", user, table);
}

export function requestPage(d: RequestDetail, names: Names, user: string): string {
  const r = d.request;
  const fields = ["id", "status", "channel_id", "thread_ts", "message_ts", "tag_message_ts", "tagged_by_id", "requester_id", "owner_id", "attribution_confidence", "attribution_reason", "clarify_question", "confirmed_by", "confirmed_via", "created_at", "updated_at"];
  const fmt = (k: string, v: unknown) =>
    v === null || v === undefined ? `<span class="muted">—</span>` : /_at$/.test(k) && typeof v === "number" ? time(v) : /_id$|^confirmed_by$/.test(k) && k !== "channel_id" ? who(String(v), names) : esc(v);
  const dl = `<dl>${fields.map((k) => `<dt>${esc(k)}</dt><dd>${fmt(k, r[k])}</dd>`).join("")}</dl>`;
  let drafts = "";
  try {
    const parsed = JSON.parse(String(r.draft_json ?? "[]")) as { title?: string; source_ts?: string }[];
    drafts = parsed.map((x) => `<li>${esc(x.title)} <span class="muted">from ${esc(x.source_ts)}</span></li>`).join("");
  } catch {
    drafts = "";
  }
  const asks = d.asks.length
    ? `<div class="scroll"><table><thead><tr><th>Ask</th><th>State</th><th>Owner / holder</th><th>Size · urgency</th><th>Deadline</th></tr></thead><tbody>${d.asks
        .map(
          (a) => `<tr><td>${esc(a.title)}<div class="muted">${esc(a.id)}</div></td><td><span class="pill">${esc(a.state)}</span></td>
<td>${who(a.owner_id as string, names)} / ${who(a.holder_id as string, names)}</td><td>${esc(a.size)} · ${esc(a.urgency)}</td><td>${typeof a.deadline_at === "number" ? time(a.deadline_at) : "—"}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : `<p class="muted">Not confirmed yet, so no asks.</p>`;
  const titleOf = new Map(d.asks.map((a) => [a.id, a.title]));
  const events = d.events.length
    ? `<div class="scroll"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Ask</th><th>Note</th></tr></thead><tbody>${d.events
        .map(
          (e) => `<tr><td>${time(e.at)}</td><td>${e.actor_id === "system" ? "system" : who(e.actor_id, names)}<div class="muted">via ${esc(e.via)}</div></td>
<td>${esc(e.kind)}${e.from_state || e.to_state ? `<div class="muted">${esc(e.from_state ?? "")} → ${esc(e.to_state ?? "")}</div>` : ""}</td>
<td>${esc(e.ask_id ? (titleOf.get(e.ask_id) ?? e.ask_id) : "request")}</td><td>${esc(e.note ?? "")}</td></tr>`,
        )
        .join("")}</tbody></table></div>`
    : `<p class="muted">No events.</p>`;
  const body = `<p><a href="/requests">← Requests</a></p><h2>Request</h2>${dl}<h2>Drafted items</h2><ul>${drafts || "<li class=muted>none</li>"}</ul><h2>Asks</h2>${asks}<h2>History</h2>${events}
<p class="muted"><a href="/?q=${esc(encodeURIComponent(String(r.channel_id ?? "")))}">Logs for this channel</a></p>`;
  return layout(`Request · Plates logs`, "requests", user, body);
}

export function setupPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Plates logs</title><style>${CSS}</style></head>
<body><main><h2>Locked</h2><p>This app only opens behind Cloudflare Access. Turn on Access for this Worker and set <code>ACCESS_TEAM_DOMAIN</code> and <code>ACCESS_AUD</code>.</p></main></body></html>`;
}
