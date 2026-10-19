// Local end-to-end run: the real Worker in workerd (`wrangler dev --local`) with real local D1, Queues and
// Durable Object alarms. Slack and Anthropic are the mock servers in ./mock-servers.ts. Scenarios play Slack:
// they POST correctly signed requests to the Worker and assert on what the mocks recorded and on D1.
//
//   npm run local:e2e
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ANTHROPIC_KEY } from "../test/helpers/fakeAnthropic.ts";
import { BOT_TOKEN, BOT_USER_ID, interactiveElements, type FakeView, type StoredMessage } from "../test/helpers/fakeSlack.ts";
import { SIGNING_SECRET, SlackIngress } from "../test/helpers/slackIngress.ts";
import { CAST, CHANNEL, MOCK_PORT, MockServers } from "./mock-servers.ts";

type Obj = Record<string, unknown>;
type Cast = (typeof CAST)[string];

const ROOT = process.cwd(); // npm runs scripts from the repo root
const WRANGLER = join(ROOT, "node_modules/.bin/wrangler");
const DAY = 86_400_000;
const SNOOZE_SECONDS = 50;

// ---------- tiny test framework ----------

interface Result {
  scenario: string;
  checks: { label: string; ok: boolean; detail?: string }[];
  error?: string;
}
const results: Result[] = [];
let current: Result;

function check(label: string, ok: boolean, detail?: unknown): void {
  current.checks.push({ label, ok, detail: ok || detail === undefined ? undefined : typeof detail === "string" ? detail : JSON.stringify(detail) });
  console.log(`    ${ok ? "ok  " : "FAIL"} ${label}${ok || detail === undefined ? "" : `  -> ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
}
const eq = (label: string, actual: unknown, expected: unknown) => check(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

/** ONLY=c,e runs just the scenarios whose name starts with "(c" or "(e" (the global check always runs). */
const only = process.env.ONLY?.split(",").map((x) => `(${x.trim()}`);

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  if (only && !name.startsWith("global") && !only.some((p) => name.startsWith(p))) return;
  current = { scenario: name, checks: [] };
  results.push(current);
  console.log(`\n== ${name}`);
  try {
    await fn();
  } catch (err) {
    current.error = err instanceof Error ? err.message : String(err);
    console.log(`    FAIL scenario aborted: ${current.error}`);
  }
}

async function waitFor<T>(what: string, probe: () => T | Promise<T>, timeoutMs = 30_000, everyMs = 250): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v) return v as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// ---------- processes ----------

const children: ChildProcess[] = [];
const workerLog: string[] = [];

function killAll(): void {
  for (const c of children) {
    try {
      if (c.pid) process.kill(-c.pid, "SIGKILL"); // whole group: wrangler spawns workerd
    } catch {}
  }
}

function run(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((ok) => {
    const c = spawn(cmd, args, { cwd: ROOT, env: wranglerEnv });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => ok({ code: code ?? 1, out }));
  });
}

const wranglerEnv = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" };

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer().once("error", fail).listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

// ---------- environment ----------

let persistDir = "";
let workerUrl = "";
let mocks: MockServers;
let ingress: SlackIngress;

async function d1(sql: string): Promise<Obj[]> {
  const { code, out } = await run(WRANGLER, ["d1", "execute", "plates", "--local", "--persist-to", persistDir, "--command", sql, "--json"]);
  const start = out.indexOf("[");
  if (code !== 0 || start < 0) throw new Error(`d1 execute failed (${code}): ${out.slice(0, 500)}`);
  const parsed = JSON.parse(out.slice(start)) as { results?: Obj[] }[];
  return parsed.flatMap((p) => p.results ?? []);
}
const q = (s: string) => `'${s.replaceAll("'", "''")}'`;

async function setup(): Promise<void> {
  persistDir = mkdtempSync(join(tmpdir(), "plates-e2e-"));
  console.log(`persist dir: ${persistDir}`);

  console.log("applying migrations to local D1 ...");
  const mig = await run(WRANGLER, ["d1", "migrations", "apply", "plates", "--local", "--persist-to", persistDir]);
  if (mig.code !== 0) throw new Error(`migrations failed:\n${mig.out}`);

  mocks = new MockServers(Number(process.env.MOCK_PORT ?? MOCK_PORT));
  await mocks.start();
  console.log(`mock servers on ${mocks.origin}`);

  const port = await freePort();
  const inspector = await freePort();
  workerUrl = `http://127.0.0.1:${port}`;
  const vars: Record<string, string> = {
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    SLACK_BOT_TOKEN: BOT_TOKEN,
    OPENROUTER_API_KEY: ANTHROPIC_KEY,
    SLACK_API_URL: mocks.slackApiUrl,
    LLM_BASE_URL: mocks.anthropicBaseUrl,
  };
  const args = ["dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(inspector), "--persist-to", persistDir];
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
  const dev = spawn(WRANGLER, args, { cwd: ROOT, env: wranglerEnv, detached: true });
  children.push(dev);
  const sink = (d: Buffer) => workerLog.push(...d.toString().split("\n").filter(Boolean));
  dev.stdout!.on("data", sink);
  dev.stderr!.on("data", sink);
  let exited = false;
  dev.on("exit", () => (exited = true));

  console.log(`starting wrangler dev on ${workerUrl} ...`);
  await waitFor(
    "wrangler dev to answer",
    async () => {
      if (exited) throw new Error(`wrangler dev exited early:\n${workerLog.slice(-30).join("\n")}`);
      try {
        return (await fetch(workerUrl)).ok;
      } catch {
        return false;
      }
    },
    120_000,
    500,
  );
  console.log("worker is up");

  ingress = new SlackIngress((req) => fetch(req), Date.now, mocks.slack, workerUrl);
}

// ---------- playing Slack ----------

const slack = () => mocks.slack;

/** A human posts; Slack sends a `message` event, plus `app_mention` when the bot is mentioned. */
async function say(o: { user: string; text: string; thread_ts?: string; channel?: string }): Promise<StoredMessage> {
  const channel = o.channel ?? CHANNEL;
  const msg = slack().addHumanMessage({ ...o, channel });
  const m = { channel, user: o.user, text: o.text, ts: msg.ts, thread_ts: o.thread_ts };
  await ok200(ingress.event(ingress.messageEvent(m)));
  if (o.text.includes(`<@${BOT_USER_ID}>`)) await ok200(ingress.event(ingress.appMentionEvent(m)));
  return msg;
}

async function react(user: string, ref: Ref, name: string): Promise<void> {
  slack().addReaction(ref.channel, ref.ts, user, name);
  await ok200(ingress.event(ingress.reactionEvent({ user, reaction: name, channel: ref.channel, ts: ref.ts })));
}

async function ok200(p: Promise<Response>): Promise<Response> {
  const res = await p;
  if (res.status !== 200) throw new Error(`worker answered ${res.status}: ${await res.clone().text()}`);
  return res;
}

interface Ref {
  channel: string;
  ts: string;
}

/** The newest message in a channel that has this button (action_id, and value when given). */
function messageWith(channel: string, actionId: string, value?: string): Ref | null {
  const msgs = slack().channel(channel).messages;
  for (const m of [...msgs].reverse()) {
    if (m.user !== BOT_USER_ID) continue;
    const hit = interactiveElements(m.blocks).some((x) => x.element.action_id === actionId && (value === undefined || x.element.value === value));
    if (hit) return { channel, ts: m.ts };
  }
  return null;
}
const dmChannel = (user: string) => slack().im(user).id;

async function click(user: string, ref: Ref, actionId: string, value?: string): Promise<void> {
  const blocks = slack().message(ref.channel, ref.ts).blocks ?? [];
  await ok200(ingress.interaction(ingress.blockActions({ user, blocks, actionId, value, where: ref })));
}
async function choose(user: string, ref: Ref, actionId: string, selectedOption: string): Promise<void> {
  const blocks = slack().message(ref.channel, ref.ts).blocks ?? [];
  await ok200(ingress.interaction(ingress.blockActions({ user, blocks, actionId, selectedOption, where: ref })));
}

/** Wait for a modal opened by the click that just happened, then submit it. */
async function openAndSubmit(user: string, openedBefore: number, answers: Record<string, unknown>): Promise<FakeView> {
  await waitFor("views.open", () => slack().callsTo("views.open").length > openedBefore);
  const view = slack().lastModal();
  const res = await ok200(ingress.interaction(ingress.viewSubmission(user, view, answers)));
  const text = await res.text();
  if (text) throw new Error(`view_submission was refused: ${text}`);
  return view;
}

// ---------- shared steps ----------

function extraction(c: Cast, title: string, sourceTs: string): Obj {
  return {
    groups: [
      {
        requester_id: c.requester,
        owner_id: c.owner,
        attribution_confidence: 0.95,
        attribution_reason: "scripted",
        clarify_question: null,
        asks: [
          {
            title, detail: null, type: "deliverable", size: "hours", urgency: "normal", estimate_reason: "scripted",
            inferred_due_at: null, owner_already_committed: false, source_ts: sourceTs,
          },
        ],
      },
    ],
  };
}

interface Tagged {
  root: StoredMessage;
  requestId: string;
  card: Ref;
  askId: string;
}

/** requester asks owner in a thread, tagger tags @plates, the queue consumer extracts, the requester confirms with a check mark. */
async function tagAndConfirm(c: Cast, title: string): Promise<Tagged> {
  const root = await say({ user: c.requester, text: `<@${c.owner}> can you send the Q3 numbers by Friday?` });
  mocks.script("record_asks", extraction(c, title, root.ts));
  await say({ user: c.tagger, text: `<@${BOT_USER_ID}> put this on the owner's plate`, thread_ts: root.ts });

  const req = await waitFor(
    "the confirmation card (queue consumer ran in workerd)",
    async () => (await d1(`SELECT id, message_ts, status FROM requests WHERE thread_ts = ${q(root.ts)}`)).find((r) => r.message_ts),
    45_000,
    1000,
  );
  const card = { channel: CHANNEL, ts: String(req.message_ts) };
  eq("request is pending confirmation after extraction", req.status, "pending_confirmation");
  check("card is a bot message in the thread", slack().message(card.channel, card.ts).user === BOT_USER_ID);

  await react(c.requester, card, "white_check_mark");
  const ask = await waitFor(
    "the owner DM after the check-mark reaction",
    async () => messageWith(dmChannel(c.owner), "ask:accept_later"),
    30_000,
  );
  const rows = await d1(`SELECT id, state FROM asks WHERE request_id = ${q(String(req.id))}`);
  eq("one ask, proposed", rows.map((r) => r.state), ["proposed"]);
  void ask;
  return { root, requestId: String(req.id), card, askId: String(rows[0]!.id) };
}

const askState = async (askId: string) => String((await d1(`SELECT state FROM asks WHERE id = ${q(askId)}`))[0]?.state);
const waitState = (askId: string, state: string, ms = 30_000) =>
  waitFor(`ask ${askId} to be ${state}`, async () => (await askState(askId)) === state, ms, 1000);
const events = async (askId: string) =>
  (await d1(`SELECT kind, via, actor_id, from_state, to_state FROM ask_events WHERE ask_id = ${q(askId)} ORDER BY at, id`)) as {
    kind: string; via: string; actor_id: string; from_state: string | null; to_state: string | null;
  }[];
const dmTextsOf = (user: string) => slack().dmTexts(user).join("\n");
const isoDate = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

// ---------- scenarios ----------

async function scenarioCoreLoop(): Promise<void> {
  const c = CAST.A!;
  const t = await tagAndConfirm(c, "Send the Q3 numbers");
  eq("request confirmed by the requester via reaction", (await d1(`SELECT status, confirmed_by, confirmed_via FROM requests WHERE id = ${q(t.requestId)}`))[0], {
    status: "confirmed", confirmed_by: c.requester, confirmed_via: "reaction",
  });
  check("thread got the 'Reading the thread' ack", slack().posts({ channel: CHANNEL, thread_ts: t.root.ts }).length >= 1);

  // owner: accept later -> modal -> date
  const dm = messageWith(dmChannel(c.owner), "ask:accept_later", t.askId)!;
  const opened = slack().callsTo("views.open").length;
  await click(c.owner, dm, "ask:accept_later", t.askId);
  const date = isoDate(3);
  const view = await openAndSubmit(c.owner, opened, { date });
  eq("accept_later opened modal:accept_later", view.callback_id, "modal:accept_later");
  await waitState(t.askId, "accepted");
  const [row] = await d1(`SELECT deadline_at FROM asks WHERE id = ${q(t.askId)}`);
  eq("deadline stored as end of the chosen day (UTC)", new Date(Number(row!.deadline_at)).toISOString().slice(0, 16), `${date}T23:59`);
  await waitFor("deadline DM to the requester", () => dmTextsOf(c.requester).includes("expects"));
  check("requester DM names the date", dmTextsOf(c.requester).includes(date));

  // owner: done -> modal
  const dm2 = await waitFor("done button on the owner DM", () => messageWith(dmChannel(c.owner), "ask:done", t.askId));
  const opened2 = slack().callsTo("views.open").length;
  await click(c.owner, dm2, "ask:done", t.askId);
  await openAndSubmit(c.owner, opened2, { link: "https://docs.example.com/q3", note: "numbers attached" });
  await waitState(t.askId, "delivered");
  await waitFor("delivered DM to the requester", () => dmTextsOf(c.requester).includes("delivered"));
  check("delivered DM carries the link and note", dmTextsOf(c.requester).includes("https://docs.example.com/q3") && dmTextsOf(c.requester).includes("numbers attached"));

  // requester: close
  const dm3 = await waitFor("close button on the requester DM", () => messageWith(dmChannel(c.requester), "ask:close", t.askId));
  await click(c.requester, dm3, "ask:close", t.askId);
  await waitState(t.askId, "closed");
  const [fin] = await d1(`SELECT state, holder_id, closed_at FROM asks WHERE id = ${q(t.askId)}`);
  check("final state closed with closed_at set", fin!.state === "closed" && fin!.closed_at !== null, fin);
  const ev = await events(t.askId);
  eq("event log", ev.map((e) => [e.kind, e.via, e.actor_id]), [
    ["accept_later", "dm", c.owner], ["done", "dm", c.owner], ["close", "dm", c.requester],
  ]);
  await waitFor("live thread message to read closed", () => JSON.stringify(slack().message(t.card.channel, t.card.ts)).includes("closed"));
  check("live thread message reflects closed", true);
}

async function scenarioReplyAndUndo(): Promise<void> {
  const c = CAST.B!;
  const t = await tagAndConfirm(c, "Review the contract");
  mocks.script("decide_action", { action: "accept_now", ask_id: "A1", note: null, deadline: null, confidence: 0.97, delivers_ask_id: null });
  const reply = await say({ user: c.owner, text: "on it, starting now", thread_ts: t.root.ts });
  await waitState(t.askId, "in_progress");
  const ev = await events(t.askId);
  eq("reply applied as accept_now via thread_reply", ev.map((e) => [e.kind, e.via, e.actor_id]), [["accept_now", "thread_reply", c.owner]]);
  const applied = await waitFor("applied line with an Undo button", () => messageWith(CHANNEL, "event:undo"));
  check("Undo line sits in the thread", slack().message(applied.channel, applied.ts).thread_ts === t.root.ts, slack().message(applied.channel, applied.ts));
  check("intent model was asked once", mocks.anthropic.callsFor("decide_action").length === 1);
  void reply;

  await click(c.owner, applied, "event:undo");
  await waitState(t.askId, "proposed");
  const after = await events(t.askId);
  eq("undo event appended", after.map((e) => e.kind), ["accept_now", "undo"]);
  await waitFor("undone line in the thread", () => JSON.stringify(slack().message(applied.channel, applied.ts)).includes("Undone"));
  check("Undo line replaced by 'Undone'", true);
}

async function scenarioSlashCommand(): Promise<void> {
  const c = CAST.C!;
  const help = await ok200(ingress.slashCommand({ user: c.requester, channel: CHANNEL, text: "help" }));
  const body = (await help.json()) as Obj;
  check("/plates help answers ephemerally with the help text", body.response_type === "ephemeral" && String(body.text).includes("Plates"), body);

  const opened = slack().callsTo("views.open").length;
  await ok200(ingress.slashCommand({ user: c.requester, channel: CHANNEL, text: "settings" }));
  await waitFor("settings modal", () => slack().callsTo("views.open").length > opened);
  // The modal may open as a loading placeholder first and be filled by views.update.
  const filled = await waitFor("the settings modal to be filled in", () => slack().lastModal().callback_id === "settings:save", 10_000).catch(() => false);
  check("/plates settings opens the settings modal", filled, { callback_id: slack().lastModal().callback_id });

  const text = `<@${c.owner}> send me the Q3 deck by Friday`;
  mocks.script("record_asks", extraction(c, "Send the Q3 deck", "$LATEST_TS"));
  await ok200(ingress.slashCommand({ user: c.requester, channel: CHANNEL, text }));
  // Either the request appears, or the worker tells the thread it found no ask (see the SRC BUG note in test/e2e/commands.test.ts).
  const outcome = await waitFor(
    "a request or a 'couldn't find an ask' reply for the /plates capture",
    async () => {
      const req = (await d1(`SELECT id, message_ts, status, tagged_by_id, requester_id, owner_id FROM requests WHERE tagged_by_id = ${q(c.requester)}`)).find((r) => r.message_ts);
      if (req) return { req };
      const none = slack().posts({ channel: CHANNEL }).find((p) => /couldn.t find/i.test(String(p.args.text)));
      return none ? { none: String(none.args.text) } : null;
    },
    45_000,
    1000,
  );
  check("/plates capture created a request (not 'couldn't find an ask')", "req" in outcome, outcome);
  if (!("req" in outcome)) return;
  const req = outcome.req;
  check("capture posted '<@user> via /plates: ...' as the bot", slack().posts({ channel: CHANNEL }).some((p) => String(p.args.text).includes("via /plates:")));
  check("request pending with the scripted people", req.status === "pending_confirmation" && req.requester_id === c.requester && req.owner_id === c.owner, req);
}

async function scenarioVerification(): Promise<void> {
  const challenge = "challenge-abc-123";
  const res = await ingress.urlVerification(challenge);
  eq("url_verification echoes the challenge", [res.status, await res.text()], [200, challenge]);

  const bad = await ingress.urlVerification(challenge, { signature: "v0=deadbeef" });
  eq("bad signature -> 401", bad.status, 401);
  const wrongSecret = await ingress.urlVerification(challenge, { secret: "not-the-secret" });
  eq("wrong signing secret -> 401", wrongSecret.status, 401);
  const stale = await ingress.urlVerification(challenge, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
  eq("stale timestamp -> 401", stale.status, 401);
}

/** Phase 1 sets the snooze up and returns; phase 2 waits for the real Durable Object alarm. */
async function snoozeSetup(): Promise<{ t: Tagged; wakeAt: number; owner: string }> {
  const c = CAST.D!;
  const t = await tagAndConfirm(c, "Prepare the board deck");
  const dm = messageWith(dmChannel(c.owner), "ask:accept_now", t.askId)!;
  await click(c.owner, dm, "ask:accept_now", t.askId);
  await waitState(t.askId, "in_progress");

  const opened = slack().callsTo("views.open").length;
  await choose(c.owner, t.card, "ask:overflow", `ask:snooze|${t.askId}`);
  const wakeAt = Math.floor(Date.now() / 1000) + SNOOZE_SECONDS;
  await openAndSubmit(c.owner, opened, { preset: "custom", custom: wakeAt });
  await waitState(t.askId, "snoozed");
  const [row] = await d1(`SELECT snoozed_from, snoozed_until, snooze_count FROM asks WHERE id = ${q(t.askId)}`);
  eq("snoozed from in_progress until the chosen time", [row!.snoozed_from, row!.snoozed_until, row!.snooze_count], ["in_progress", wakeAt * 1000, 1]);
  return { t, wakeAt: wakeAt * 1000, owner: c.owner };
}

async function snoozeFinish(s: { t: Tagged; wakeAt: number }): Promise<void> {
  const wait = Math.max(0, s.wakeAt - Date.now());
  console.log(`    waiting up to ${Math.ceil(wait / 1000) + 60}s for the Durable Object alarm ...`);
  await waitState(s.t.askId, "in_progress", wait + 60_000);
  const lateBy = Date.now() - s.wakeAt;
  check("alarm woke the ask within a minute of the wake time", lateBy < 60_000, `${Math.round(lateBy / 1000)}s late`);
  const ev = await events(s.t.askId);
  const last = ev.at(-1)!;
  check("last event is wake by system", last.kind === "wake" && last.actor_id === "system" && last.via === "system", ev);
  const [row] = await d1(`SELECT snoozed_until, snoozed_from FROM asks WHERE id = ${q(s.t.askId)}`);
  check("snooze fields cleared", row!.snoozed_until === null && row!.snoozed_from === null, row);
}

// ---------- main ----------

async function main(): Promise<number> {
  const started = Date.now();
  await setup();

  let snooze: Awaited<ReturnType<typeof snoozeSetup>> | undefined;
  await scenario("(d1) snooze: set up (alarm ~50s ahead)", async () => void (snooze = await snoozeSetup()));
  await scenario("(a) core loop: mention -> confirm -> accept later -> done -> close", scenarioCoreLoop);
  await scenario("(b) thread reply auto-applied, then Undo", scenarioReplyAndUndo);
  await scenario("(c) /plates command", scenarioSlashCommand);
  await scenario("(e) url_verification and bad signatures", scenarioVerification);
  await scenario("(d2) snooze: real DO alarm wakes the ask", async () => {
    if (!snooze) throw new Error("snooze setup did not complete");
    await snoozeFinish(snooze);
  });

  await scenario("global: mocks and worker log are clean", async () => {
    const failed = slack().calls.filter((x) => !x.ok);
    check("no failed Slack API calls", failed.length === 0, failed.map((x) => `${x.method}:${x.error}`));
    check("no unscripted Anthropic calls", mocks.anthropic.unscripted.length === 0, mocks.anthropic.unscripted.map((r) => r.toolNames));
    const errs = workerLog.filter((l) => /\b(event|request|extract job|effect)\b.*\bfailed\b|\[ERROR\]|Uncaught/i.test(l));
    check("no error lines from the worker", errs.length === 0, errs.slice(0, 5));
  });

  console.log("\n==================== SUMMARY ====================");
  let failures = 0;
  for (const r of results) {
    const bad = r.checks.filter((c) => !c.ok).length + (r.error ? 1 : 0);
    failures += bad;
    console.log(`${bad === 0 ? "PASS" : "FAIL"}  ${r.scenario}  (${r.checks.length - r.checks.filter((c) => !c.ok).length}/${r.checks.length} checks${r.error ? `, aborted: ${r.error}` : ""})`);
  }
  console.log(`${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`} in ${Math.round((Date.now() - started) / 1000)}s`);
  if (failures) {
    console.log("\n--- Anthropic requests seen by the mock ---");
    for (const r of mocks.anthropic.requests) console.log(`${r.model} forced=${r.forcedTool} answered=${r.answeredWith} prompt=${JSON.stringify(r.prompt.slice(0, Number(process.env.PROMPT_CHARS ?? 160)))}`);
    console.log("\n--- worker log (without binding tables) ---");
    console.log(workerLog.filter((l) => !/^(env\.|Binding|Your Worker|⎔)/.test(l)).slice(-40).join("\n"));
    console.log(`\n(persist dir kept: ${persistDir})`);
  }
  return failures === 0 ? 0 : 1;
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (killAll(), process.exit(130)));

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error("\nsetup failed:", err);
  console.error(workerLog.slice(-30).join("\n"));
} finally {
  killAll();
  await mocks?.stop().catch(() => {});
  if (code === 0 && persistDir) rmSync(persistDir, { recursive: true, force: true });
}
process.exit(code);
