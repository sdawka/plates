// Tail events -> rows. Pure, so it runs in node tests.

export type Level = "error" | "warn" | "info";

export interface Line {
  t: number;
  level: Level;
  text: string;
}

export interface InvocationRow {
  at: number;
  kind: string;
  summary: string;
  outcome: string;
  level: Level;
  cpu_ms: number | null;
  wall_ms: number | null;
  lines: Line[];
}

/** The parts of a TraceItem we read; typed loosely because the event union varies by trigger. */
export interface TailItem {
  eventTimestamp: number | null;
  outcome: string;
  event: Record<string, unknown> | null;
  logs: { timestamp: number; level: string; message: unknown[] }[];
  exceptions: { timestamp: number; name: string; message: string; stack?: string }[];
  cpuTime?: number;
  wallTime?: number;
  entrypoint?: string;
}

const MAX_LINE = 4000;
const MAX_LINES = 200;

const levelOf = (l: string): Level => (l === "error" ? "error" : l === "warn" ? "warn" : "info");

function stringify(parts: unknown[]): string {
  const text = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
  return text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text;
}

/** Fields from Plates' JSON info lines ({"msg": …}), for the summary. */
function infoFields(lines: Line[]): Record<string, unknown>[] {
  return lines.flatMap((l) => {
    if (!l.text.startsWith("{")) return [];
    try {
      const v = JSON.parse(l.text) as unknown;
      return v && typeof v === "object" && "msg" in v ? [v as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

function kindOf(e: Record<string, unknown> | null, entrypoint?: string): string {
  if (!e) return "other";
  if ("request" in e) return "fetch";
  if ("queue" in e) return "queue";
  if ("cron" in e) return "scheduled";
  if ("scheduledTime" in e) return "alarm";
  if ("rpcMethod" in e) return "rpc";
  return entrypoint ? "rpc" : "other";
}

function summarize(kind: string, e: Record<string, unknown> | null, fields: Record<string, unknown>[], item: TailItem): string {
  const parts: string[] = [];
  const first = fields[0];
  if (first?.msg === "slack event") parts.push(`slack event ${first.type}${first.subtype ? `/${first.subtype}` : ""}${first.tab ? ` (${first.tab})` : ""}`);
  else if (first?.msg === "slack interaction") parts.push(`${first.type} ${first.action ?? first.callback ?? ""}`.trim());
  else if (first?.msg === "slash command") parts.push(`/plates ${first.word}`);
  const jobs = fields.filter((f) => f.msg === "job").map((f) => `${f.kind}${Number(f.attempt) > 1 ? ` (try ${f.attempt})` : ""}`);
  if (kind === "fetch") {
    const req = e?.request as { method?: string; url?: string } | undefined;
    const res = e?.response as { status?: number } | undefined;
    if (parts.length === 0) {
      let path = req?.url ?? "";
      try {
        path = new URL(path).pathname;
      } catch {
        /* keep the raw url */
      }
      parts.push(`${req?.method ?? ""} ${path}`.trim());
    }
    if (res?.status !== undefined) parts.push(String(res.status));
  } else if (kind === "queue") {
    parts.push(jobs.length ? `queue: ${jobs.join(", ")}` : `queue ${e?.queue} ×${e?.batchSize}`);
  } else if (kind === "alarm") {
    parts.push(`alarm${item.entrypoint ? ` ${item.entrypoint}` : ""}`);
  } else if (kind === "scheduled") {
    parts.push(`cron ${e?.cron}`);
  } else {
    parts.push(kind);
  }
  const calls = fields.filter((f) => f.msg === "llm call" || f.msg === "systemone call").length;
  if (calls) parts.push(`${calls} model call${calls > 1 ? "s" : ""}`);
  return parts.join(" · ");
}

export function toRow(item: TailItem): InvocationRow {
  const lines: Line[] = [
    ...item.logs.map((l) => ({ t: l.timestamp, level: levelOf(l.level), text: stringify(l.message) })),
    ...item.exceptions.map((x) => ({ t: x.timestamp, level: "error" as const, text: `${x.name}: ${x.message}${x.stack ? `\n${x.stack}` : ""}`.slice(0, MAX_LINE) })),
  ]
    .sort((a, b) => a.t - b.t)
    .slice(0, MAX_LINES);
  const kind = kindOf(item.event, item.entrypoint);
  const failed = item.outcome !== "ok" && item.outcome !== "unknown";
  const level: Level = failed || lines.some((l) => l.level === "error") ? "error" : lines.some((l) => l.level === "warn") ? "warn" : "info";
  return {
    at: item.eventTimestamp ?? lines[0]?.t ?? Date.now(),
    kind,
    summary: summarize(kind, item.event, infoFields(lines), item),
    outcome: item.outcome,
    level,
    cpu_ms: item.cpuTime ?? null,
    wall_ms: item.wallTime ?? null,
    lines,
  };
}

/** Plain GETs (health checks, favicon) carry nothing worth keeping. */
export function worthKeeping(row: InvocationRow): boolean {
  return !(row.kind === "fetch" && row.level === "info" && row.lines.length === 0 && /^GET /.test(row.summary));
}
