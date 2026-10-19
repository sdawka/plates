// Slack -> Worker side: signed requests and payloads shaped like Slack's Events API, interactivity
// (block_actions, view_submission, message_action) and slash commands.
import { signSlackBody } from "../../src/slack/verify";
import { APP_ID, BOT_USER_ID, TEAM_ID, interactiveElements, type FakeSlack, type FakeView } from "./fakeSlack";

type Obj = Record<string, unknown>;

export const SIGNING_SECRET = "test-signing-secret";

export interface SignOpts {
  /** Seconds since epoch; defaults to the (fake) clock. */
  timestamp?: number;
  secret?: string;
  retryNum?: number;
  /** Replace the computed signature (to test rejection). */
  signature?: string;
}

export class SlackIngress {
  private eventSeq = 0;

  constructor(
    private send: (req: Request) => Promise<Response>,
    private now: () => number,
    private slack: FakeSlack,
    readonly baseUrl = "https://plates.test",
  ) {}

  async signed(path: string, body: string, contentType: string, o: SignOpts = {}): Promise<Request> {
    const ts = String(o.timestamp ?? Math.floor(this.now() / 1000));
    const signature = o.signature ?? (await signSlackBody(o.secret ?? SIGNING_SECRET, ts, body));
    return new Request(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        "content-type": contentType,
        "x-slack-request-timestamp": ts,
        "x-slack-signature": signature,
        ...(o.retryNum !== undefined ? { "x-slack-retry-num": String(o.retryNum), "x-slack-retry-reason": "http_timeout" } : {}),
      },
      body,
    });
  }

  // ---------- Events API ----------

  envelope(event: Obj): Obj {
    const n = ++this.eventSeq;
    return {
      token: "deprecated-verification-token",
      team_id: TEAM_ID,
      context_team_id: TEAM_ID,
      api_app_id: APP_ID,
      event,
      type: "event_callback",
      event_id: `Ev${String(n).padStart(8, "0")}`,
      event_time: Math.floor(this.now() / 1000),
      authorizations: [{ enterprise_id: null, team_id: TEAM_ID, user_id: BOT_USER_ID, is_bot: true, is_enterprise_install: false }],
      is_ext_shared_channel: false,
    };
  }

  async event(event: Obj, o: SignOpts = {}): Promise<Response> {
    return this.send(await this.signed("/slack/events", JSON.stringify(this.envelope(event)), "application/json", o));
  }

  async urlVerification(challenge = "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P", o: SignOpts = {}): Promise<Response> {
    const body = JSON.stringify({ token: "deprecated-verification-token", challenge, type: "url_verification" });
    return this.send(await this.signed("/slack/events", body, "application/json", o));
  }

  messageEvent(m: { channel: string; user: string; text: string; ts: string; thread_ts?: string }): Obj {
    const ch = this.slack.channel(m.channel);
    return {
      type: "message",
      user: m.user,
      text: m.text,
      ts: m.ts,
      ...(m.thread_ts ? { thread_ts: m.thread_ts } : {}),
      channel: m.channel,
      event_ts: m.ts,
      channel_type: ch.is_im ? "im" : ch.is_private ? "group" : "channel",
      team: TEAM_ID,
      client_msg_id: crypto.randomUUID(),
      blocks: [{ type: "rich_text", block_id: "x", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: m.text }] }] }],
    };
  }

  appMentionEvent(m: { channel: string; user: string; text: string; ts: string; thread_ts?: string }): Obj {
    return {
      type: "app_mention",
      user: m.user,
      text: m.text,
      ts: m.ts,
      ...(m.thread_ts ? { thread_ts: m.thread_ts } : {}),
      channel: m.channel,
      event_ts: m.ts,
      team: TEAM_ID,
      client_msg_id: crypto.randomUUID(),
    };
  }

  reactionEvent(r: { user: string; reaction: string; channel: string; ts: string; itemUser?: string }): Obj {
    return {
      type: "reaction_added",
      user: r.user,
      reaction: r.reaction,
      item: { type: "message", channel: r.channel, ts: r.ts },
      item_user: r.itemUser ?? BOT_USER_ID,
      event_ts: this.slack.nextTs(),
    };
  }

  // ---------- interactivity ----------

  private userRef(userId: string): Obj {
    const u = this.slack.users.get(userId);
    return { id: userId, username: u?.name ?? userId, name: u?.name ?? userId, team_id: TEAM_ID };
  }

  async interaction(payload: Obj, o: SignOpts = {}): Promise<Response> {
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    return this.send(await this.signed("/slack/events", body, "application/x-www-form-urlencoded", o));
  }

  /**
   * A block_actions payload for an element that really exists in `blocks`. Throws when the button or
   * select is not there, so a test can only click what Slack would have rendered.
   */
  blockActions(o: {
    user: string;
    blocks: Obj[];
    actionId: string;
    /** Disambiguates buttons sharing an action_id (value for buttons, option value for selects). */
    value?: string;
    /** For selects: the chosen option value. */
    selectedOption?: string;
    where: { channel: string; ts: string } | { home: string };
  }): Obj {
    const hits = interactiveElements(o.blocks).filter(
      (x) =>
        x.element.action_id === o.actionId &&
        (o.value === undefined || x.element.value === o.value) &&
        (o.selectedOption === undefined || ((x.element.options as Obj[] | undefined) ?? []).some((opt) => opt.value === o.selectedOption)),
    );
    const hit = hits[0];
    if (!hit) {
      const have = interactiveElements(o.blocks).map((x) => `${x.element.action_id}${x.element.value ? `=${String(x.element.value)}` : ""}`);
      throw new Error(`no element ${o.actionId}${o.value ? `=${o.value}` : ""} on that surface. Available: ${have.join(", ")}`);
    }
    const { element, block } = hit;
    const action: Obj = { action_id: element.action_id, block_id: block.block_id, type: element.type, action_ts: String(this.now() / 1000) };
    if (element.type === "button") {
      Object.assign(action, { text: element.text, value: element.value, ...(element.style ? { style: element.style } : {}) });
    } else if (element.type === "static_select" || element.type === "overflow") {
      const opt = ((element.options as Obj[]) ?? []).find((x) => x.value === o.selectedOption);
      if (!opt) throw new Error(`option ${String(o.selectedOption)} not offered by ${o.actionId}`);
      action.selected_option = opt;
    }
    const base: Obj = {
      type: "block_actions",
      user: this.userRef(o.user),
      api_app_id: APP_ID,
      token: "deprecated-verification-token",
      trigger_id: this.slack.issueTrigger(o.user),
      team: { id: TEAM_ID, domain: "plates-test" },
      enterprise: null,
      is_enterprise_install: false,
      actions: [action],
    };
    if ("home" in o.where) {
      const view = this.slack.homeViews.get(o.where.home);
      return { ...base, container: { type: "view", view_id: view?.id }, view: { ...view, state: { values: {} } } };
    }
    const { channel, ts } = o.where;
    const msg = this.slack.message(channel, ts);
    return {
      ...base,
      response_url: this.slack.issueResponseUrl(),
      channel: { id: channel, name: this.slack.channel(channel).name },
      container: { type: "message", message_ts: ts, channel_id: channel, is_ephemeral: false },
      message: msg,
      state: { values: {} },
    };
  }

  /** view_submission for an open modal, with `state.values` built from `answers` (see buildViewState). */
  viewSubmission(user: string, view: FakeView, answers: Record<string, unknown>): Obj {
    return {
      type: "view_submission",
      team: { id: TEAM_ID, domain: "plates-test" },
      user: this.userRef(user),
      api_app_id: APP_ID,
      token: "deprecated-verification-token",
      trigger_id: this.slack.issueTrigger(user),
      view: { ...view, state: { values: buildViewState(view, answers, this.slack) } },
      response_urls: [],
      is_enterprise_install: false,
      enterprise: null,
    };
  }

  messageAction(o: { user: string; callbackId: string; channel: string; ts: string }): Obj {
    return {
      type: "message_action",
      callback_id: o.callbackId,
      user: this.userRef(o.user),
      api_app_id: APP_ID,
      token: "deprecated-verification-token",
      trigger_id: this.slack.issueTrigger(o.user),
      team: { id: TEAM_ID, domain: "plates-test" },
      channel: { id: o.channel, name: this.slack.channel(o.channel).name },
      message_ts: o.ts,
      message: this.slack.message(o.channel, o.ts),
      response_url: this.slack.issueResponseUrl(),
    };
  }

  // ---------- slash commands ----------

  async slashCommand(o: { user: string; channel: string; command?: string; text?: string; path?: string }, so: SignOpts = {}): Promise<Response> {
    const ch = this.slack.channel(o.channel);
    const body = new URLSearchParams({
      token: "deprecated-verification-token",
      team_id: TEAM_ID,
      team_domain: "plates-test",
      channel_id: o.channel,
      channel_name: ch.is_im ? "directmessage" : ch.name,
      user_id: o.user,
      user_name: this.slack.users.get(o.user)?.name ?? o.user,
      command: o.command ?? "/plates",
      text: o.text ?? "",
      api_app_id: APP_ID,
      is_enterprise_install: "false",
      response_url: this.slack.issueResponseUrl(),
      trigger_id: this.slack.issueTrigger(o.user),
    }).toString();
    return this.send(await this.signed(o.path ?? "/slack/events", body, "application/x-www-form-urlencoded", so));
  }
}

// ---------- modal state ----------

/**
 * `view.state.values` as Slack sends it: block_id -> action_id -> typed value. `answers` maps an input
 * block_id to a plain value (string, number, string[] ...). Required inputs must be answered; initial
 * values are used for unanswered inputs, like the Slack client does.
 */
export function buildViewState(view: FakeView, answers: Record<string, unknown>, slack?: FakeSlack): Obj {
  const out: Obj = {};
  const inputs = view.blocks.filter((b) => b.type === "input");
  for (const key of Object.keys(answers)) {
    if (!inputs.some((b) => b.block_id === key)) {
      throw new Error(`answer for "${key}" but the modal has input blocks [${inputs.map((b) => String(b.block_id)).join(", ")}]`);
    }
  }
  for (const b of inputs) {
    const id = String(b.block_id);
    const el = b.element as Obj;
    const actionId = String(el.action_id);
    const answer = answers[id];
    const optional = b.optional === true;
    const opts = (el.options as Obj[] | undefined) ?? [];
    let v: Obj;
    switch (el.type) {
      case "plain_text_input": {
        const text = answer === undefined ? ((el.initial_value as string | undefined) ?? null) : String(answer);
        if ((text === null || text === "") && !optional) throw new Error(`required input "${id}" is empty`);
        if (typeof text === "string" && typeof el.max_length === "number" && text.length > el.max_length) throw new Error(`input "${id}" exceeds max_length`);
        v = { type: "plain_text_input", value: text === "" ? null : text };
        break;
      }
      case "datepicker": {
        const d = answer === undefined ? ((el.initial_date as string | undefined) ?? null) : (answer as string | null);
        if (d === null && !optional) throw new Error(`required input "${id}" is empty`);
        if (d !== null && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error(`datepicker "${id}" needs YYYY-MM-DD`);
        v = { type: "datepicker", selected_date: d };
        break;
      }
      case "datetimepicker": {
        const t = answer === undefined ? ((el.initial_date_time as number | undefined) ?? null) : (answer as number | null);
        if (t === null && !optional) throw new Error(`required input "${id}" is empty`);
        v = { type: "datetimepicker", selected_date_time: t };
        break;
      }
      case "static_select": {
        const raw = answer === undefined ? (el.initial_option as Obj | undefined)?.value : answer;
        if (raw === undefined || raw === null) {
          if (!optional) throw new Error(`required input "${id}" is empty`);
          v = { type: "static_select", selected_option: null };
        } else {
          const opt = opts.find((x) => x.value === raw);
          if (!opt) throw new Error(`"${String(raw)}" is not an option of "${id}"`);
          v = { type: "static_select", selected_option: opt };
        }
        break;
      }
      case "users_select": {
        const u = answer === undefined ? ((el.initial_user as string | undefined) ?? null) : (answer as string | null);
        if (u === null && !optional) throw new Error(`required input "${id}" is empty`);
        if (u !== null && slack && !slack.users.has(u)) throw new Error(`users_select "${id}": unknown user ${u}`);
        v = { type: "users_select", selected_user: u };
        break;
      }
      case "checkboxes": {
        const values = answer === undefined ? ((el.initial_options as Obj[] | undefined) ?? []).map((o) => o.value as string) : (answer as string[]);
        const selected = values.map((val) => {
          const opt = opts.find((x) => x.value === val);
          if (!opt) throw new Error(`"${val}" is not an option of "${id}"`);
          return opt;
        });
        if (selected.length === 0 && !optional) throw new Error(`required input "${id}" is empty`);
        v = { type: "checkboxes", selected_options: selected };
        break;
      }
      default:
        throw new Error(`buildViewState: element type ${String(el.type)} not supported`);
    }
    out[id] = { [actionId]: v };
  }
  return out;
}
