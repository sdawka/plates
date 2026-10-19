// Test harness: a full Env (FakeD1 with all migrations, FakeQueue, real PlateKeeper per user on shim
// storage), the fakes for Slack, Anthropic and System One behind one fetch stub, a controllable clock, and a
// driver that plays Slack users against `worker.fetch` with correctly signed requests.
import { vi } from "vitest";
import worker from "../../src/index";
import { PlateKeeper } from "../../src/keeper/PlateKeeper";
import type { Env, ExtractJob } from "../../src/types";
import { MemoryDurableObjectState } from "./cloudflare-workers";
import { FakeTrackers } from "./fakeTrackers";
import { ANTHROPIC_KEY, ANTHROPIC_URL, FakeAnthropic } from "./fakeAnthropic";
import { FakeSystemOne } from "./fakeSystemOne";
import { asD1, makeDb, type FakeD1 } from "./fakeD1";
import { API_URL, BOT_TOKEN, BOT_USER_ID, FakeSlack, type FakeUser, type StoredMessage } from "./fakeSlack";
import { Network } from "./net";
import { SIGNING_SECRET, SlackIngress } from "./slackIngress";

type Obj = Record<string, unknown>;
export { SIGNING_SECRET, BOT_USER_ID };

// ---------- clock ----------

/** Only Date is faked, so timers and promises behave normally. */
export class Clock {
  constructor(start: number) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
  }
  now = () => Date.now();
  set(ms: number): void {
    vi.setSystemTime(ms);
  }
  advance(ms: number): void {
    vi.setSystemTime(Date.now() + ms);
  }
  dispose(): void {
    vi.useRealTimers();
  }
}

// ---------- queue ----------

export interface QueuedMessage {
  id: string;
  body: ExtractJob;
  attempts: number;
}
export interface DrainResult {
  acked: ExtractJob[];
  retried: { body: ExtractJob; delaySeconds?: number }[];
  deadLettered: ExtractJob[];
}

const MAX_RETRIES = 3; // wrangler.jsonc consumers[0].max_retries
const MAX_BATCH = 5;

export class FakeQueue {
  /** Everything ever sent, in order. */
  readonly sent: ExtractJob[] = [];
  private pending: QueuedMessage[] = [];
  readonly acked: ExtractJob[] = [];
  readonly retried: { body: ExtractJob; delaySeconds?: number }[] = [];
  readonly deadLettered: ExtractJob[] = [];
  private seq = 0;
  deliver: (batch: unknown) => Promise<void> = async () => {};

  async send(body: ExtractJob, _opts?: { delaySeconds?: number }): Promise<void> {
    this.sent.push(structuredClone(body));
    this.pending.push({ id: `msg-${++this.seq}`, body: structuredClone(body), attempts: 1 });
  }

  async sendBatch(msgs: Iterable<{ body: ExtractJob }>): Promise<void> {
    for (const m of msgs) await this.send(m.body);
  }

  get depth(): number {
    return this.pending.length;
  }

  sentOfKind<K extends ExtractJob["kind"]>(kind: K): Extract<ExtractJob, { kind: K }>[] {
    return this.sent.filter((j): j is Extract<ExtractJob, { kind: K }> => j.kind === kind);
  }

  /**
   * Delivers pending messages to the worker's queue() in batches of up to 5, including jobs enqueued while
   * draining. Messages that call retry() wait for the next drain() with attempts + 1 (past max_retries
   * they are dead-lettered).
   */
  async drain(): Promise<DrainResult> {
    const result: DrainResult = { acked: [], retried: [], deadLettered: [] };
    const deferred: QueuedMessage[] = [];
    while (this.pending.length > 0) {
      const batchMsgs = this.pending.splice(0, MAX_BATCH);
      const outcomes = new Map<string, { kind: "ack" } | { kind: "retry"; delaySeconds?: number }>();
      const messages = batchMsgs.map((m) => ({
        id: m.id,
        timestamp: new Date(),
        body: structuredClone(m.body),
        attempts: m.attempts,
        ack: () => void outcomes.set(m.id, { kind: "ack" }),
        retry: (o?: { delaySeconds?: number }) => void outcomes.set(m.id, { kind: "retry", delaySeconds: o?.delaySeconds }),
      }));
      await this.deliver({
        queue: "plates-extract",
        messages,
        ackAll: () => messages.forEach((m) => m.ack()),
        retryAll: (o?: { delaySeconds?: number }) => messages.forEach((m) => m.retry(o)),
      });
      for (const m of batchMsgs) {
        // A message neither acked nor retried is acked implicitly when queue() returns without throwing.
        const o = outcomes.get(m.id) ?? { kind: "ack" as const };
        if (o.kind === "ack") {
          result.acked.push(m.body);
          this.acked.push(m.body);
        } else if (m.attempts > MAX_RETRIES) {
          result.deadLettered.push(m.body);
          this.deadLettered.push(m.body);
        } else {
          result.retried.push({ body: m.body, delaySeconds: o.delaySeconds });
          this.retried.push({ body: m.body, delaySeconds: o.delaySeconds });
          deferred.push({ ...m, attempts: m.attempts + 1 });
        }
      }
    }
    this.pending.push(...deferred);
    return result;
  }
}

// ---------- durable object namespace ----------

export class FakeKeeperNamespace {
  readonly instances = new Map<string, PlateKeeper>();
  readonly states = new Map<string, MemoryDurableObjectState>();
  constructor(private env: () => Env) {}

  idFromName(name: string) {
    return { name, toString: () => name };
  }

  get(id: { name: string }): PlateKeeper {
    let k = this.instances.get(id.name);
    if (!k) {
      const state = new MemoryDurableObjectState({ name: id.name });
      this.states.set(id.name, state);
      k = new PlateKeeper(state as never, this.env());
      this.instances.set(id.name, k);
    }
    return k;
  }

  async alarmOf(userId: string): Promise<number | null> {
    return (await this.states.get(userId)?.storage.getAlarm()) ?? null;
  }

  /** Sets the clock to `now` and runs every keeper alarm that is due, as the runtime would. */
  async fireAlarms(now: number, setClock: (ms: number) => void): Promise<string[]> {
    setClock(now);
    const fired: string[] = [];
    for (let round = 0; round < 10; round++) {
      let any = false;
      for (const [name, state] of this.states) {
        const at = await state.storage.getAlarm();
        if (at !== null && at <= now) {
          await state.storage.deleteAlarm(); // the runtime clears the alarm before invoking alarm()
          await this.instances.get(name)!.alarm();
          fired.push(name);
          any = true;
        }
      }
      if (!any) break;
    }
    return fired;
  }
}

// ---------- harness ----------

export interface HarnessOptions {
  /** Epoch ms for the fake clock. Default: Monday 2026-10-19 10:00 UTC. */
  now?: number;
  users?: FakeUser[];
  env?: Partial<Env>;
  channels?: { id: string; name?: string; members: string[] }[];
}

/** base64 of 32 bytes, as `wrangler secret put TOKEN_ENC_KEY` expects. */
export const TOKEN_ENC_KEY = btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => i * 7 + 1)));

export const MONDAY_10AM = Date.UTC(2026, 9, 19, 10, 0, 0);
export const CHANNEL = "C100";
export const USERS = {
  dana: "UDANA", // requester in most scenarios
  bob: "UBOB", // owner
  tara: "UTARA", // tagger, a third party
  eve: "UEVE",
} as const;

export class Harness {
  readonly clock: Clock;
  readonly net = new Network();
  readonly slack: FakeSlack;
  readonly anthropic = new FakeAnthropic();
  readonly systemOne = new FakeSystemOne();
  readonly trackers: FakeTrackers;
  readonly queue = new FakeQueue();
  readonly db: FakeD1;
  readonly keepers: FakeKeeperNamespace;
  readonly env: Env;
  readonly ingress: SlackIngress;
  private consoleErrors: unknown[][] = [];

  constructor(opts: HarnessOptions = {}) {
    this.clock = new Clock(opts.now ?? MONDAY_10AM);
    this.slack = new FakeSlack(this.clock.now);
    this.trackers = new FakeTrackers(this.clock.now);
    this.db = makeDb();
    this.keepers = new FakeKeeperNamespace(() => this.env);
    this.env = {
      DB: asD1(this.db),
      EXTRACT_QUEUE: this.queue,
      KEEPER: this.keepers,
      SLACK_SIGNING_SECRET: SIGNING_SECRET,
      SLACK_BOT_TOKEN: BOT_TOKEN,
      OPENROUTER_API_KEY: ANTHROPIC_KEY,
      EXTRACT_MODEL: "anthropic/claude-sonnet-5.5",
      FAST_MODEL: "anthropic/claude-haiku-5.5",
      DECIDE_MODEL: "typesafe/jev-1.14",
      SLACK_API_URL: API_URL,
      LLM_BASE_URL: ANTHROPIC_URL,
      PUBLIC_URL: "https://plates.test",
      SLACK_CLIENT_ID: "111.222",
      SLACK_CLIENT_SECRET: "client-secret",
      TOKEN_ENC_KEY: TOKEN_ENC_KEY,
      ...opts.env,
    } as unknown as Env;
    this.queue.deliver = (batch) => (worker as { queue: (b: unknown, e: Env) => Promise<void> }).queue(batch, this.env);

    this.slack.attach(this.net);
    this.anthropic.attach(this.net);
    this.systemOne.attach(this.net, ANTHROPIC_URL);
    this.trackers.attach(this.net);
    this.net.install();
    this.ingress = new SlackIngress((req) => this.fetch(req), this.clock.now, this.slack);

    const users: FakeUser[] = opts.users ?? [
      { id: USERS.dana, name: "dana", real_name: "Dana Reed" },
      { id: USERS.bob, name: "bob", real_name: "Bob Ortiz" },
      { id: USERS.tara, name: "tara", real_name: "Tara Lin" },
      { id: USERS.eve, name: "eve", real_name: "Eve Park" },
    ];
    for (const u of users) this.slack.addUser(u);
    const everyone = users.map((u) => u.id);
    for (const c of opts.channels ?? [{ id: CHANNEL, name: "proj", members: everyone }]) this.slack.addChannel(c.id, c);

    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void this.consoleErrors.push(a));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  }

  dispose(): void {
    this.net.uninstall();
    this.clock.dispose();
    vi.restoreAllMocks();
  }

  /** console.error output captured from the worker (failed effects, failed jobs ...). */
  get errors(): string[] {
    return this.consoleErrors.map((a) => a.map((x) => (x instanceof Error ? x.message : String(x))).join(" "));
  }

  // ---------- worker ----------

  /** worker.fetch with an ExecutionContext whose waitUntil promises are awaited before returning. */
  async fetch(req: Request): Promise<Response> {
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(Promise.resolve(p).catch(() => {})), passThroughOnException() {} };
    const res = await (worker as { fetch: (r: Request, e: Env, c: unknown) => Promise<Response> }).fetch(req, this.env, ctx);
    while (pending.length) await Promise.all(pending.splice(0));
    return res;
  }

  drain(): Promise<DrainResult> {
    return this.queue.drain();
  }

  fireAlarms(now: number): Promise<string[]> {
    return this.keepers.fireAlarms(now, (ms) => this.clock.set(ms));
  }

  // ---------- Slack users ----------

  /** A human posts; Slack delivers a `message` event, plus `app_mention` when the bot is mentioned. */
  async say(o: { channel?: string; user: string; text: string; thread_ts?: string; files?: Obj[] }): Promise<StoredMessage> {
    const channel = o.channel ?? CHANNEL;
    const msg = this.slack.addHumanMessage({ ...o, channel });
    const m = { channel, user: o.user, text: o.text, ts: msg.ts, thread_ts: o.thread_ts, files: o.files };
    await this.expectOk(this.ingress.event(this.ingress.messageEvent(m)));
    if (o.text.includes(`<@${BOT_USER_ID}>`)) await this.expectOk(this.ingress.event(this.ingress.appMentionEvent(m)));
    return msg;
  }

  async react(user: string, msg: { channel: string; ts: string }, name: string): Promise<void> {
    this.slack.addReaction(msg.channel, msg.ts, user, name);
    await this.expectOk(this.ingress.event(this.ingress.reactionEvent({ user, reaction: name, channel: msg.channel, ts: msg.ts })));
  }

  async openHome(user: string): Promise<void> {
    await this.expectOk(this.ingress.event({ type: "app_home_opened", user, channel: this.slack.im(user).id, tab: "home", event_ts: this.slack.nextTs() }));
  }

  /** Click a button on a message the bot posted (thread message or DM). */
  async click(user: string, msg: { channel: string; ts: string }, actionId: string, value?: string): Promise<Response> {
    const stored = this.slack.message(msg.channel, msg.ts);
    return this.ingress.interaction(this.ingress.blockActions({ user, blocks: stored.blocks ?? [], actionId, value, where: msg }));
  }

  /** Pick an option from a select menu on a bot message. */
  async choose(user: string, msg: { channel: string; ts: string }, actionId: string, optionValue: string): Promise<Response> {
    const stored = this.slack.message(msg.channel, msg.ts);
    return this.ingress.interaction(
      this.ingress.blockActions({ user, blocks: stored.blocks ?? [], actionId, selectedOption: optionValue, where: msg }),
    );
  }

  async clickHome(user: string, actionId: string, value?: string): Promise<Response> {
    const view = this.slack.homeViews.get(user);
    if (!view) throw new Error(`no Home view published for ${user}`);
    return this.ingress.interaction(this.ingress.blockActions({ user, blocks: view.blocks, actionId, value, where: { home: user } }));
  }

  /** Submit the most recently opened modal as `user`. Returns Slack's view_submission response body. */
  async submit(user: string, answers: Record<string, unknown>, view = this.slack.lastModal()): Promise<{ status: number; body: Obj | null }> {
    const res = await this.ingress.interaction(this.ingress.viewSubmission(user, view, answers));
    const text = await res.text();
    const body = text ? (JSON.parse(text) as Obj) : null;
    if (body?.response_action === "errors") {
      const inputIds = view.blocks.filter((b) => b.type === "input").map((b) => b.block_id);
      for (const k of Object.keys(body.errors as Obj)) {
        if (!inputIds.includes(k)) throw new Error(`view_submission errors key "${k}" is not an input block_id of the modal (${inputIds.join(", ")}); Slack would reject this`);
      }
    }
    return { status: res.status, body };
  }

  /** The bot's latest message in a channel (optionally the latest matching `pred`). */
  lastBot(channel: string, pred: (m: StoredMessage) => boolean = () => true): StoredMessage {
    const m = this.slack.botMessages(channel).filter(pred).at(-1);
    if (!m) throw new Error(`no bot message in ${channel}`);
    return m;
  }

  private async expectOk(p: Promise<Response>): Promise<void> {
    const res = await p;
    if (res.status !== 200) throw new Error(`worker answered ${res.status}: ${await res.text()}`);
  }

  // ---------- D1 ----------

  q(sql: string, ...params: unknown[]): Record<string, unknown>[] {
    return this.db.all(sql, ...params);
  }

  requests(): Record<string, unknown>[] {
    return this.q("SELECT * FROM requests ORDER BY created_at, rowid");
  }
  asks(): Record<string, unknown>[] {
    return this.q("SELECT * FROM asks ORDER BY created_at, rowid");
  }
  events(askId?: string): Record<string, unknown>[] {
    return askId ? this.q("SELECT * FROM ask_events WHERE ask_id = ? ORDER BY at, rowid", askId) : this.q("SELECT * FROM ask_events ORDER BY at, rowid");
  }
}

export function createHarness(opts: HarnessOptions = {}): Harness {
  return new Harness(opts);
}

/** extract tool input for a single group, as the model would send it. */
export function extractionInput(g: {
  requester: string | null;
  owner: string | null;
  asks: { title: string; source_ts: string; type?: string; size?: string; urgency?: string; due?: string | null; detail?: string | null }[];
  confidence?: number;
  clarify?: string | null;
}): Obj {
  return {
    groups: [
      {
        requester_id: g.requester,
        owner_id: g.owner,
        attribution_confidence: g.confidence ?? 0.95,
        attribution_reason: "scripted",
        clarify_question: g.clarify ?? null,
        asks: g.asks.map((a) => ({
          title: a.title,
          detail: a.detail ?? null,
          type: a.type ?? "deliverable",
          size: a.size ?? "hours",
          urgency: a.urgency ?? "normal",
          estimate_reason: "scripted",
          inferred_due_at: a.due ?? null,
          owner_already_committed: false,
          source_ts: a.source_ts,
        })),
      },
    ],
  };
}
