// Fake Slack Web API, shaped after api.slack.com/methods/* (response bodies, error codes, argument
// rules). Stateful: channels hold messages, so posted/updated messages show up in conversations.history
// and conversations.replies. Every call is recorded. Block Kit limits are enforced (see blockKit.ts).
import { validateBlocks, validateView, type Surface } from "./blockKit";
import { json, type Network } from "./net";

type Obj = Record<string, unknown>;

export const TEAM_ID = "T0001";
export const BOT_USER_ID = "UBOT";
export const BOT_ID = "B0001";
export const APP_ID = "A0001";
export const BOT_TOKEN = "xoxb-test-token";
export const API_URL = "https://slack.test/api";
export const RESPONSE_URL_BASE = "https://hooks.slack.test/actions";

export interface FakeUser {
  id: string;
  name: string;
  real_name?: string;
  display_name?: string;
  tz?: string;
  /** Returned in profile.email, as it is for apps with the users:read.email scope. */
  email?: string;
  is_bot?: boolean;
  deleted?: boolean;
}

export interface StoredMessage extends Obj {
  type: "message";
  ts: string;
  text: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  subtype?: string;
  thread_ts?: string;
  blocks?: Obj[];
  files?: Obj[];
  reactions?: { name: string; users: string[]; count: number }[];
  edited?: { user: string; ts: string };
}

export interface FakeChannel {
  id: string;
  name: string;
  is_im: boolean;
  is_private: boolean;
  /** For IMs: the human on the other side. */
  imUser?: string;
  is_mpim?: boolean;
  members: Set<string>;
  messages: StoredMessage[];
}

export interface RecordedCall {
  method: string;
  args: Obj;
  token: string | null;
  contentType: string;
  ok: boolean;
  error?: string;
  response: Obj;
  at: number;
}

interface Identity {
  kind: "bot" | "user";
  userId: string;
}

class SlackError extends Error {
  constructor(readonly code: string, readonly messages?: string[], readonly extra: Obj = {}) {
    super(code);
  }
}

const invalidArgs = (...messages: string[]) => new SlackError("invalid_arguments", messages.map((m) => `[ERROR] ${m}`));

/** Methods that read via query/form only: Slack ignores JSON bodies for them. */
const FORM_ONLY = new Set(["conversations.history", "conversations.replies", "users.info", "conversations.info", "conversations.members"]);
/** Parameters that arrive as JSON strings in form-encoded calls. */
const JSON_PARAMS = new Set(["blocks", "view", "attachments", "metadata"]);

const pad6 = (n: number) => String(n).padStart(6, "0");

export interface FakeView extends Obj {
  id: string;
  type: "modal" | "home";
  blocks: Obj[];
  callback_id: string;
  private_metadata: string;
  hash: string;
  external_id: string;
  state: { values: Obj };
}

export class FakeSlack {
  readonly users = new Map<string, FakeUser>();
  readonly channels = new Map<string, FakeChannel>();
  readonly calls: RecordedCall[] = [];
  readonly ephemerals: { channel: string; user: string; text: string; blocks?: Obj[]; message_ts: string }[] = [];
  readonly tokens = new Map<string, Identity>([[BOT_TOKEN, { kind: "bot", userId: BOT_USER_ID }]]);
  /** Modals opened with views.open (latest last), keyed by view id in `viewsById`. */
  readonly openViews: FakeView[] = [];
  readonly viewsById = new Map<string, FakeView>();
  readonly homeViews = new Map<string, FakeView>();
  readonly responseUrlPosts: { url: string; body: Obj }[] = [];
  readonly oauth = { clientId: "111.222", clientSecret: "client-secret", codes: new Map<string, OAuthCode>() };

  private lastMicro = 0;
  private seq = 0;
  private triggers = new Map<string, { userId: string; at: number; used: boolean }>();
  private responseUrls = new Map<string, { uses: number; at: number }>();
  private rateLimits: { method: string; retryAfter: number; times: number }[] = [];

  constructor(private now: () => number) {
    this.users.set(BOT_USER_ID, { id: BOT_USER_ID, name: "plates", real_name: "Plates", is_bot: true, tz: "UTC" });
  }

  attach(net: Network): void {
    net.route(`${API_URL}/`, (req) => this.handleApi(req));
    net.route(`${RESPONSE_URL_BASE}/`, (req) => this.handleResponseUrl(req));
  }

  // ---------- workspace setup ----------

  addUser(user: FakeUser): FakeUser {
    const u = { tz: "UTC", real_name: user.name, ...user };
    this.users.set(u.id, u);
    return u;
  }

  /** Creates a public (default) channel the bot is a member of unless `botIn` is false. */
  addChannel(id: string, opts: { name?: string; members?: string[]; botIn?: boolean; private?: boolean } = {}): FakeChannel {
    const members = new Set(opts.members ?? []);
    if (opts.botIn !== false) members.add(BOT_USER_ID);
    const ch: FakeChannel = { id, name: opts.name ?? id.toLowerCase(), is_im: false, is_private: !!opts.private, members, messages: [] };
    this.channels.set(id, ch);
    return ch;
  }

  /** The bot's DM with a user (created on demand, like conversations.open). */
  im(userId: string): FakeChannel {
    const id = `D${userId.replace(/^[UW]/, "")}`;
    let ch = this.channels.get(id);
    if (!ch) {
      ch = { id, name: id, is_im: true, is_private: true, imUser: userId, members: new Set([BOT_USER_ID, userId]), messages: [] };
      this.channels.set(id, ch);
    }
    return ch;
  }

  /** A DM between two humans: the bot is not a member (like a real 1:1 DM). */
  addDirect(id: string, a: string, b: string): FakeChannel {
    const ch: FakeChannel = { id, name: id, is_im: true, is_private: true, imUser: b, members: new Set([a, b]), messages: [] };
    this.channels.set(id, ch);
    return ch;
  }

  /** A group DM (mpim) between humans; the bot is not a member. */
  addGroupDm(id: string, users: string[]): FakeChannel {
    const ch: FakeChannel = { id, name: `mpdm-${users.join("--")}-1`, is_im: false, is_private: true, is_mpim: true, members: new Set(users), messages: [] };
    this.channels.set(id, ch);
    return ch;
  }

  channel(id: string): FakeChannel {
    const ch = this.channels.get(id);
    if (!ch) throw new Error(`FakeSlack: no channel ${id}`);
    return ch;
  }

  rateLimit(method: string, retryAfterSeconds = 1, times = 1): void {
    this.rateLimits.push({ method, retryAfter: retryAfterSeconds, times });
  }

  // ---------- human activity (used by the scenario driver) ----------

  nextTs(): string {
    const micro = Math.max(this.now() * 1000, this.lastMicro + 1);
    this.lastMicro = micro;
    return `${Math.floor(micro / 1e6)}.${pad6(micro % 1e6)}`;
  }

  addHumanMessage(o: { channel: string; user: string; text: string; thread_ts?: string; files?: Obj[]; ts?: string }): StoredMessage {
    const ch = this.channel(o.channel);
    if (!this.users.has(o.user)) throw new Error(`FakeSlack: unknown user ${o.user}`);
    if (o.thread_ts && !ch.messages.some((m) => m.ts === o.thread_ts)) throw new Error(`FakeSlack: thread ${o.thread_ts} not in ${o.channel}`);
    const msg: StoredMessage = {
      type: "message",
      user: o.user,
      text: o.text,
      ts: o.ts ?? this.nextTs(),
      team: TEAM_ID,
      ...(o.thread_ts ? { thread_ts: o.thread_ts } : {}),
      ...(o.files ? { files: o.files } : {}),
    };
    ch.messages.push(msg);
    return msg;
  }

  addReaction(channel: string, ts: string, user: string, name: string): void {
    const msg = this.message(channel, ts);
    const r = (msg.reactions ??= []).find((x) => x.name === name);
    if (r) {
      if (!r.users.includes(user)) {
        r.users.push(user);
        r.count++;
      }
    } else msg.reactions.push({ name, users: [user], count: 1 });
  }

  issueTrigger(userId: string): string {
    const id = `${1e10 + ++this.seq}.${Math.floor(this.now() / 1000)}.${Math.random().toString(16).slice(2, 12)}`;
    this.triggers.set(id, { userId, at: this.now(), used: false });
    return id;
  }

  issueResponseUrl(): string {
    const url = `${RESPONSE_URL_BASE}/${TEAM_ID}/${++this.seq}${Math.floor(this.now() / 1000)}/${Math.random().toString(36).slice(2, 14)}`;
    this.responseUrls.set(url, { uses: 0, at: this.now() });
    return url;
  }

  issueOAuthCode(o: { userId: string; userScopes?: string[]; botScopes?: string[]; redirectUri?: string }): string {
    const code = `${this.users.size}.${++this.seq}.${Math.random().toString(16).slice(2, 10)}`;
    this.oauth.codes.set(code, { ...o, at: this.now(), used: false });
    return code;
  }

  // ---------- inspection ----------

  message(channel: string, ts: string): StoredMessage {
    const m = this.channel(channel).messages.find((x) => x.ts === ts);
    if (!m) throw new Error(`FakeSlack: no message ${channel}/${ts}`);
    return m;
  }

  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Successful chat.postMessage calls, in order. */
  posts(filter: { channel?: string; thread_ts?: string } = {}): RecordedCall[] {
    return this.callsTo("chat.postMessage").filter(
      (c) => c.ok && (!filter.channel || c.response.channel === filter.channel) && (!filter.thread_ts || c.args.thread_ts === filter.thread_ts),
    );
  }

  /** Messages the bot posted in a channel (current state, after updates). */
  botMessages(channel: string): StoredMessage[] {
    return this.channel(channel).messages.filter((m) => m.user === BOT_USER_ID);
  }

  /** Text of every DM the bot sent to a user, flattened (text fallback plus block text). */
  dmTexts(userId: string): string[] {
    return this.im(userId).messages.map((m) => flatText(m));
  }

  lastModal(): FakeView {
    const v = this.openViews.at(-1);
    if (!v) throw new Error("FakeSlack: no modal opened");
    return v;
  }

  clearCalls(): void {
    this.calls.length = 0;
  }

  // ---------- HTTP surface ----------

  private async parseArgs(req: Request, method: string): Promise<{ args: Obj; contentType: string }> {
    const contentType = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    const raw = await req.text();
    let args: Obj = {};
    if (contentType === "application/json") {
      // Slack ignores JSON bodies on read methods, treating the call as having no arguments.
      if (!FORM_ONLY.has(method)) args = raw ? (JSON.parse(raw) as Obj) : {};
    } else if (contentType === "application/x-www-form-urlencoded" || contentType === "") {
      for (const [k, v] of new URLSearchParams(raw)) args[k] = v;
    } else {
      throw new SlackError("invalid_post_type");
    }
    return { args, contentType };
  }

  private async handleApi(req: Request): Promise<Response> {
    const method = new URL(req.url).pathname.replace(/^\/api\//, "");
    const authHeader = req.headers.get("authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    let args: Obj = {};
    let contentType = "";
    let response: Obj;
    let status = 200;
    const extraHeaders: Record<string, string> = {};
    try {
      if (req.method !== "POST" && req.method !== "GET") throw new SlackError("invalid_request");
      ({ args, contentType } = await this.parseArgs(req, method));
      const limited = this.rateLimits.find((r) => r.method === method && r.times > 0);
      if (limited) {
        limited.times--;
        status = 429;
        extraHeaders["retry-after"] = String(limited.retryAfter);
        response = { ok: false, error: "ratelimited" };
      } else {
        response = { ok: true, ...this.dispatch(method, args, token, contentType, req) };
      }
    } catch (e) {
      if (!(e instanceof SlackError)) throw e;
      response = {
        ok: false,
        error: e.code,
        ...(e.messages ? { response_metadata: { messages: e.messages } } : {}),
        ...e.extra,
      };
    }
    this.calls.push({
      method, args, token, contentType, ok: response.ok === true, response, at: this.now(),
      ...(response.ok === true ? {} : { error: String(response.error) }),
    });
    return json(response, status, extraHeaders);
  }

  private identity(token: string | null): Identity {
    const id = token ? this.tokens.get(token) : undefined;
    if (!token) throw new SlackError("not_authed");
    if (!id) throw new SlackError("invalid_auth");
    return id;
  }

  private dispatch(method: string, a: Obj, token: string | null, contentType: string, req: Request): Obj {
    if (method === "oauth.v2.access") return this.oauthAccess(a, req);
    const who = this.identity(token);
    for (const key of JSON_PARAMS) {
      if (typeof a[key] === "string") {
        try {
          a[key] = JSON.parse(a[key] as string);
        } catch {
          throw new SlackError(key === "blocks" ? "invalid_blocks_format" : "invalid_arguments", [`[ERROR] ${key} is not valid JSON`]);
        }
      }
    }
    switch (method) {
      case "auth.test": return this.authTest(who);
      case "auth.revoke": return this.authRevoke(a, token!);
      case "chat.postMessage": return this.postMessage(a, who);
      case "chat.update": return this.update(a, who);
      case "chat.delete": return this.deleteMessage(a, who);
      case "chat.postEphemeral": return this.postEphemeral(a, who);
      case "chat.getPermalink": return this.getPermalink(a, who);
      case "conversations.replies": return this.replies(a, who);
      case "conversations.history": return this.history(a, who);
      case "conversations.open": return this.open(a);
      case "conversations.info": return { channel: this.channelInfo(this.access(this.str(a, "channel"), who)) };
      case "conversations.members": return this.members(a, who);
      case "users.info": return this.usersInfo(a);
      case "reactions.add": return this.reactionsAdd(a, who);
      case "views.publish": return this.viewsPublish(a);
      case "views.open": return this.viewsOpen(a);
      case "views.update": return this.viewsUpdate(a);
      default: throw new SlackError("unknown_method", undefined, { req_method: method });
    }
  }

  // ---------- argument helpers ----------

  private str(a: Obj, key: string): string {
    const v = a[key];
    if (typeof v !== "string" || v === "") throw invalidArgs(`missing required field: ${key}`);
    return v;
  }

  private num(a: Obj, key: string, dflt: number): number {
    if (a[key] === undefined || a[key] === "") return dflt;
    const n = Number(a[key]);
    if (!Number.isFinite(n)) throw invalidArgs(`${key} must be a number`);
    return n;
  }

  private bool(a: Obj, key: string): boolean {
    return a[key] === true || a[key] === "true" || a[key] === "1";
  }

  /** Channel by id with the caller's access rules. Bots must be members to read or post. */
  private access(channelId: string, who: Identity, opts: { allowUserId?: boolean } = {}): FakeChannel {
    let ch = this.channels.get(channelId);
    if (!ch && opts.allowUserId && /^[UW]/.test(channelId)) {
      if (!this.users.has(channelId)) throw new SlackError("channel_not_found");
      ch = this.im(channelId);
    }
    if (!ch) throw new SlackError("channel_not_found");
    if (!ch.members.has(who.userId)) throw new SlackError(ch.is_private ? "channel_not_found" : "not_in_channel");
    return ch;
  }

  private checkBlocks(blocks: unknown, surface: Surface): void {
    const errors = validateBlocks(blocks, surface);
    if (errors.length) throw new SlackError("invalid_blocks", errors.map((e) => `[ERROR] ${e}`));
  }

  /** Common body of chat.postMessage / chat.update / chat.postEphemeral. */
  private content(a: Obj, opts: { requireContent: boolean }): { text: string; blocks?: Obj[]; attachments?: Obj[] } {
    if (a.text !== undefined && typeof a.text !== "string") throw invalidArgs("text must be a string");
    const text = (a.text as string | undefined) ?? "";
    // Docs: chat.postMessage truncates text over 40000 chars; chat.update rejects text over 4000 with msg_too_long.
    if (opts.requireContent === false && text.length > 4000) throw new SlackError("msg_too_long");
    if (a.blocks !== undefined) this.checkBlocks(a.blocks, "message");
    const blocks = a.blocks as Obj[] | undefined;
    const attachments = a.attachments as Obj[] | undefined;
    if (opts.requireContent && !text && !blocks?.length && !attachments?.length) throw new SlackError("no_text");
    return { text, blocks, attachments };
  }

  private botFields(): Obj {
    return { user: BOT_USER_ID, bot_id: BOT_ID, app_id: APP_ID, team: TEAM_ID };
  }

  private threadInfo(ch: FakeChannel, m: StoredMessage): Obj {
    const replies = ch.messages.filter((r) => r.thread_ts === m.ts && r.ts !== m.ts);
    if (replies.length === 0) return { ...m };
    const users = [...new Set(replies.map((r) => r.user).filter((u): u is string => !!u))];
    return {
      ...m,
      thread_ts: m.ts,
      reply_count: replies.length,
      reply_users_count: users.length,
      latest_reply: replies.at(-1)!.ts,
      reply_users: users,
      is_locked: false,
      subscribed: false,
    };
  }

  // ---------- methods ----------

  private authTest(who: Identity): Obj {
    const u = this.users.get(who.userId);
    return {
      url: "https://plates-test.slack.com/",
      team: "Plates Test",
      user: u?.name ?? who.userId,
      team_id: TEAM_ID,
      user_id: who.userId,
      ...(who.kind === "bot" ? { bot_id: BOT_ID } : {}),
      is_enterprise_install: false,
    };
  }

  /** Docs: auth.revoke -> {ok, revoked:true}; `test=true` revokes nothing. */
  private authRevoke(a: Obj, token: string): Obj {
    if (this.bool(a, "test")) return { revoked: false };
    this.tokens.delete(token);
    return { revoked: true };
  }

  private postMessage(a: Obj, who: Identity): Obj {
    const channel = this.str(a, "channel");
    const { text, blocks, attachments } = this.content(a, { requireContent: true });
    const ch = this.access(channel, who, { allowUserId: true });
    if (a.thread_ts !== undefined) {
      const parentTs = this.str(a, "thread_ts");
      if (!ch.messages.some((m) => m.ts === parentTs)) throw new SlackError("thread_not_found");
    }
    const msg: StoredMessage = {
      type: "message",
      ...this.botFields(),
      text,
      ts: this.nextTs(),
      ...(a.thread_ts ? { thread_ts: a.thread_ts as string } : {}),
      ...(blocks ? { blocks } : {}),
      ...(attachments ? { attachments } : {}),
    };
    ch.messages.push(msg);
    return { channel: ch.id, ts: msg.ts, message: { ...msg } };
  }

  private update(a: Obj, who: Identity): Obj {
    const ch = this.access(this.str(a, "channel"), who);
    const ts = this.str(a, "ts");
    const { text, blocks, attachments } = this.content(a, { requireContent: false });
    const msg = ch.messages.find((m) => m.ts === ts);
    if (!msg) throw new SlackError("message_not_found");
    if (msg.user !== who.userId) throw new SlackError("cant_update_message");
    if (a.text === undefined && !blocks && !attachments) throw new SlackError("no_text");
    // Per the docs, fields that are omitted keep their previous value.
    // Docs: text without blocks removes the old blocks; omitting both keeps them.
    if (a.text !== undefined) msg.text = text;
    if (blocks) msg.blocks = blocks;
    else if (a.text !== undefined) delete msg.blocks;
    if (attachments) msg.attachments = attachments;
    msg.edited = { user: who.userId, ts: this.nextTs() };
    return { channel: ch.id, ts, text: msg.text, message: { ...msg } };
  }

  private deleteMessage(a: Obj, who: Identity): Obj {
    const ch = this.access(this.str(a, "channel"), who);
    const ts = this.str(a, "ts");
    const i = ch.messages.findIndex((m) => m.ts === ts);
    if (i < 0) throw new SlackError("message_not_found");
    if (ch.messages[i]!.user !== who.userId) throw new SlackError("cant_delete_message");
    ch.messages.splice(i, 1);
    return { channel: ch.id, ts };
  }

  private postEphemeral(a: Obj, who: Identity): Obj {
    const channel = this.str(a, "channel");
    const user = this.str(a, "user");
    const { text, blocks } = this.content(a, { requireContent: true });
    const ch = this.access(channel, who);
    if (!this.users.has(user)) throw new SlackError("user_not_found");
    if (!ch.members.has(user)) throw new SlackError("user_not_in_channel");
    const message_ts = this.nextTs();
    this.ephemerals.push({ channel, user, text, blocks, message_ts });
    return { message_ts };
  }

  private getPermalink(a: Obj, who: Identity): Obj {
    const ch = this.access(this.str(a, "channel"), who);
    const ts = this.str(a, "message_ts");
    const m = ch.messages.find((x) => x.ts === ts);
    if (!m) throw new SlackError("message_not_found");
    const base = `https://plates-test.slack.com/archives/${ch.id}/p${ts.replace(".", "")}`;
    const reply = m.thread_ts && m.thread_ts !== m.ts;
    return { channel: ch.id, permalink: reply ? `${base}?thread_ts=${m.thread_ts}&cid=${ch.id}` : base };
  }

  private page(all: StoredMessage[], a: Obj, dflt: number, max: number): { messages: StoredMessage[]; has_more: boolean; next?: string } {
    const limit = this.num(a, "limit", dflt);
    if (limit < 1) throw invalidArgs("limit must be positive");
    const size = Math.min(limit, max);
    let offset = 0;
    if (a.cursor !== undefined && a.cursor !== "") {
      const decoded = Number(atob(String(a.cursor)).replace(/^o:/, ""));
      if (!Number.isInteger(decoded)) throw new SlackError("invalid_cursor");
      offset = decoded;
    }
    const messages = all.slice(offset, offset + size);
    const has_more = offset + size < all.length;
    return { messages, has_more, next: has_more ? btoa(`o:${offset + size}`) : undefined };
  }

  /** oldest/latest/inclusive semantics shared by history and replies. */
  private inRange(a: Obj, ts: string): boolean {
    const hasBound = a.oldest !== undefined || a.latest !== undefined;
    const inclusive = hasBound && this.bool(a, "inclusive");
    const oldest = this.num(a, "oldest", 0);
    const latest = a.latest === undefined || a.latest === "" ? Infinity : this.num(a, "latest", Infinity);
    const t = Number(ts);
    const lo = inclusive ? t >= oldest : t > oldest;
    const hi = inclusive ? t <= latest : t < latest;
    return lo && hi;
  }

  private replies(a: Obj, who: Identity): Obj {
    const ch = this.access(this.str(a, "channel"), who);
    const ts = this.str(a, "ts");
    const parent = ch.messages.find((m) => m.ts === ts);
    if (!parent) throw new SlackError("thread_not_found");
    const isReply = parent.thread_ts !== undefined && parent.thread_ts !== parent.ts;
    // A reply's ts returns just that message; a parent's ts returns parent first, then replies oldest-first.
    const thread = isReply
      ? [parent]
      : [parent, ...ch.messages.filter((m) => m.thread_ts === ts && m.ts !== ts).sort((x, y) => Number(x.ts) - Number(y.ts))];
    const filtered = thread.filter((m) => m.ts === ts || this.inRange(a, m.ts));
    const p = this.page(filtered, a, 1000, 1000);
    return {
      messages: p.messages.map((m) => this.threadInfo(ch, m)),
      has_more: p.has_more,
      ...(p.next ? { response_metadata: { next_cursor: p.next } } : {}),
    };
  }

  private history(a: Obj, who: Identity): Obj {
    const ch = this.access(this.str(a, "channel"), who);
    const top = ch.messages
      .filter((m) => (m.thread_ts === undefined || m.thread_ts === m.ts || m.subtype === "thread_broadcast") && this.inRange(a, m.ts))
      .sort((x, y) => Number(y.ts) - Number(x.ts)); // newest first
    const p = this.page(top, a, 100, 999);
    return {
      messages: p.messages.map((m) => this.threadInfo(ch, m)),
      has_more: p.has_more,
      pin_count: 0,
      ...(p.next ? { response_metadata: { next_cursor: p.next } } : {}),
    };
  }

  private channelInfo(ch: FakeChannel): Obj {
    return {
      id: ch.id,
      name: ch.is_im ? undefined : ch.name,
      is_channel: !ch.is_im && !ch.is_private,
      is_group: !ch.is_im && ch.is_private,
      is_im: ch.is_im,
      is_mpim: !!ch.is_mpim,
      is_private: ch.is_private,
      is_member: ch.members.has(BOT_USER_ID),
      ...(ch.imUser ? { user: ch.imUser } : {}),
    };
  }

  private members(a: Obj, who: Identity): Obj {
    const ch = this.access(this.str(a, "channel"), who);
    return { members: [...ch.members], response_metadata: { next_cursor: "" } };
  }

  private open(a: Obj): Obj {
    if (a.channel !== undefined) {
      const ch = this.channels.get(this.str(a, "channel"));
      if (!ch) throw new SlackError("channel_not_found");
      return { channel: { id: ch.id } };
    }
    const users = this.str(a, "users").split(",");
    if (users.length > 8) throw new SlackError("too_many_users");
    for (const u of users) if (!this.users.has(u)) throw new SlackError("user_not_found");
    if (users.length !== 1) throw new SlackError("not_supported", ["[ERROR] fake supports a single user"]);
    const existed = this.channels.has(this.im(users[0]!).id) && this.im(users[0]!).messages.length > 0;
    return { ...(existed ? { already_open: true } : {}), channel: { id: this.im(users[0]!).id } };
  }

  private usersInfo(a: Obj): Obj {
    const id = this.str(a, "user");
    const u = this.users.get(id);
    if (!u) throw new SlackError("user_not_found");
    const tz = u.tz ?? "UTC";
    const real = u.real_name ?? u.name;
    return {
      user: {
        id: u.id,
        team_id: TEAM_ID,
        name: u.name,
        deleted: !!u.deleted,
        color: "9f69e7",
        real_name: real,
        tz,
        tz_label: tz,
        tz_offset: tzOffsetSeconds(tz, this.now()),
        profile: {
          title: "",
          real_name: real,
          display_name: u.display_name ?? u.name,
          real_name_normalized: real,
          display_name_normalized: u.display_name ?? u.name,
          team: TEAM_ID,
          ...(u.email ? { email: u.email } : {}),
        },
        is_admin: false,
        is_owner: false,
        is_bot: !!u.is_bot,
        is_app_user: false,
        updated: Math.floor(this.now() / 1000),
        is_email_confirmed: true,
      },
    };
  }

  private reactionsAdd(a: Obj, who: Identity): Obj {
    const ch = this.access(this.str(a, "channel"), who);
    const name = this.str(a, "name");
    const ts = this.str(a, "timestamp");
    const m = ch.messages.find((x) => x.ts === ts);
    if (!m) throw new SlackError("message_not_found");
    if (m.reactions?.some((r) => r.name === name && r.users.includes(who.userId))) throw new SlackError("already_reacted");
    this.addReaction(ch.id, ts, who.userId, name);
    return {};
  }

  // ---------- views ----------

  private makeView(v: Obj, type: "modal" | "home", prevId?: string): FakeView {
    const id = prevId ?? `V${String(++this.seq).padStart(8, "0")}`;
    return {
      ...v,
      id,
      team_id: TEAM_ID,
      type,
      blocks: (v.blocks as Obj[]) ?? [],
      callback_id: (v.callback_id as string) ?? "",
      private_metadata: (v.private_metadata as string) ?? "",
      external_id: (v.external_id as string) ?? "",
      state: { values: {} },
      hash: `${Math.floor(this.now() / 1000)}.${Math.random().toString(16).slice(2, 10)}`,
      app_id: APP_ID,
      bot_id: BOT_ID,
      root_view_id: id,
      previous_view_id: null,
      clear_on_close: false,
      notify_on_close: false,
    };
  }

  private checkView(a: Obj, type: "modal" | "home"): Obj {
    if (a.view === undefined) throw invalidArgs("missing required field: view");
    if (typeof a.view !== "object" || a.view === null) throw invalidArgs("view must be an object");
    if (JSON.stringify(a.view).length > 250_000) throw new SlackError("view_too_large");
    const errors = validateView(a.view, type);
    if (errors.length) throw new SlackError("invalid_blocks", errors.map((e) => `[ERROR] ${e}`));
    return a.view as Obj;
  }

  private viewsPublish(a: Obj): Obj {
    const userId = this.str(a, "user_id");
    const view = this.checkView(a, "home");
    if (!this.users.has(userId)) throw invalidArgs("user_id: unknown user");
    const prev = this.homeViews.get(userId);
    if (typeof a.hash === "string" && prev && a.hash !== prev.hash) throw new SlackError("hash_conflict");
    const v = this.makeView(view, "home", prev?.id);
    this.homeViews.set(userId, v);
    return { view: v };
  }

  private viewsOpen(a: Obj): Obj {
    const triggerId = this.str(a, "trigger_id");
    const view = this.checkView(a, "modal");
    const t = this.triggers.get(triggerId);
    if (!t) throw new SlackError("invalid_trigger_id");
    if (t.used) throw new SlackError("exchanged_trigger_id");
    if (this.now() - t.at > 3000) throw new SlackError("expired_trigger_id");
    t.used = true;
    const v = this.makeView(view, "modal");
    this.openViews.push(v);
    this.viewsById.set(v.id, v);
    return { view: v };
  }

  private viewsUpdate(a: Obj): Obj {
    const view = this.checkView(a, "modal");
    const id = (a.view_id as string | undefined) ?? [...this.viewsById.values()].find((v) => v.external_id && v.external_id === a.external_id)?.id;
    if (!id) throw invalidArgs("one of view_id or external_id is required");
    const prev = this.viewsById.get(id);
    if (!prev) throw new SlackError("not_found");
    if (typeof a.hash === "string" && a.hash !== prev.hash) throw new SlackError("hash_conflict");
    const v = this.makeView(view, "modal", id);
    this.viewsById.set(id, v);
    this.openViews[this.openViews.indexOf(prev)] = v;
    return { view: v };
  }

  // ---------- oauth.v2.access ----------

  private oauthAccess(a: Obj, req: Request): Obj {
    let clientId = a.client_id as string | undefined;
    let clientSecret = a.client_secret as string | undefined;
    const basic = req.headers.get("authorization");
    if (basic?.startsWith("Basic ")) {
      const [id, secret] = atob(basic.slice(6)).split(":");
      clientId ??= id;
      clientSecret ??= secret;
    }
    if (!clientId) throw new SlackError("invalid_client_id");
    if (clientId !== this.oauth.clientId) throw new SlackError("invalid_client_id");
    if (clientSecret !== this.oauth.clientSecret) throw new SlackError("bad_client_secret");
    const code = this.str(a, "code");
    const issued = this.oauth.codes.get(code);
    if (!issued) throw new SlackError("invalid_code");
    if (issued.used) throw new SlackError("code_already_used");
    if (this.now() - issued.at > 10 * 60_000) throw new SlackError("invalid_code");
    if (issued.redirectUri && a.redirect_uri !== issued.redirectUri) throw new SlackError("bad_redirect_uri");
    issued.used = true;

    const out: Obj = { app_id: APP_ID, team: { id: TEAM_ID, name: "Plates Test" }, enterprise: null, is_enterprise_install: false };
    if (issued.botScopes?.length) {
      Object.assign(out, {
        access_token: BOT_TOKEN,
        token_type: "bot",
        scope: issued.botScopes.join(","),
        bot_user_id: BOT_USER_ID,
      });
    }
    if (issued.userScopes?.length) {
      const access_token = `xoxp-${issued.userId}-${this.seq++}`;
      this.tokens.set(access_token, { kind: "user", userId: issued.userId });
      out.authed_user = { id: issued.userId, scope: issued.userScopes.join(","), access_token, token_type: "user" };
    } else {
      out.authed_user = { id: issued.userId };
    }
    return out;
  }

  // ---------- response_url ----------

  private async handleResponseUrl(req: Request): Promise<Response> {
    const url = req.url;
    const state = this.responseUrls.get(url);
    const raw = await req.text();
    if (!state) return new Response("invalid_token", { status: 404 });
    if (this.now() - state.at > 30 * 60_000 || state.uses >= 5) return new Response("used_url", { status: 404 });
    if ((req.headers.get("content-type") ?? "").split(";")[0] !== "application/json") return new Response("invalid_payload", { status: 400 });
    let body: Obj;
    try {
      body = JSON.parse(raw) as Obj;
    } catch {
      return new Response("invalid_payload", { status: 400 });
    }
    if (body.delete_original !== true && !body.text && !(body.blocks as unknown[] | undefined)?.length && !body.attachments) {
      return new Response("no_text", { status: 400 });
    }
    if (body.response_type !== undefined && body.response_type !== "ephemeral" && body.response_type !== "in_channel") {
      return new Response("invalid_payload", { status: 400 });
    }
    if (body.blocks !== undefined && validateBlocks(body.blocks, "message").length) return new Response("invalid_blocks", { status: 400 });
    state.uses++;
    this.responseUrlPosts.push({ url, body });
    return new Response("ok", { status: 200 });
  }
}

export interface OAuthCode {
  userId: string;
  userScopes?: string[];
  botScopes?: string[];
  redirectUri?: string;
  at: number;
  used: boolean;
}

// ---------- shared helpers ----------

function tzOffsetSeconds(tz: string, ms: number): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    }).formatToParts(new Date(ms));
    const p: Record<string, number> = {};
    for (const x of parts) if (x.type !== "literal") p[x.type] = Number(x.value);
    return Math.round((Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(ms / 1000) * 1000) / 1000);
  } catch {
    return 0;
  }
}

function collectText(node: unknown, out: string[]): void {
  if (Array.isArray(node)) return node.forEach((n) => collectText(n, out));
  if (typeof node !== "object" || node === null) return;
  const o = node as Obj;
  if ((o.type === "mrkdwn" || o.type === "plain_text") && typeof o.text === "string") out.push(o.text);
  for (const [k, v] of Object.entries(o)) if (k !== "text" || typeof v !== "string") collectText(v, out);
}

/** All visible text of a message or view: the fallback text plus every text object in its blocks. */
export function flatText(msg: { text?: unknown; blocks?: unknown }): string {
  const out: string[] = [];
  if (typeof msg.text === "string") out.push(msg.text);
  collectText(msg.blocks, out);
  return out.join("\n");
}

export interface BlockElement extends Obj {
  type: string;
  action_id?: string;
}

/** Every interactive element in blocks (actions elements, section accessories), with its block. */
export function interactiveElements(blocks: Obj[] | undefined): { block: Obj; element: BlockElement }[] {
  const out: { block: Obj; element: BlockElement }[] = [];
  for (const block of blocks ?? []) {
    if (block.type === "actions") for (const e of (block.elements as BlockElement[]) ?? []) out.push({ block, element: e });
    if (block.type === "section" && block.accessory) out.push({ block, element: block.accessory as BlockElement });
  }
  return out;
}
