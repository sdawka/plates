// Local mock of Slack's Web API and Anthropic's Messages API, one Node HTTP server.
//
//   /slack/api/<method>         Slack Web API (form or JSON bodies), backed by the stateful FakeSlack
//   /slack/response/<path>      response_url target (the fake issues these, see MockSlack)
//   /anthropic/v1/messages      Messages API, answers come from scripted per-tool FIFO queues
//   POST /control/script        {toolName, input}  queue the next tool_use for that tool
//   GET  /control/calls         recorded Slack calls, response_url posts and Anthropic requests
//   POST /control/reset         wipe all state and re-seed the workspace
//
// A scripted input may contain the string "$LATEST_TS": it is replaced, when the model is called, by the ts of
// the most recent message in any channel (handy when the thread root is created by the worker itself).
//
// The fakes are the ones the vitest suite uses (test/helpers), so Block Kit validation, trigger_id expiry and
// request validation behave the same here as there. Run standalone with `npm run local:mock` (scripts/serve-mock.ts).
import { createServer, type IncomingMessage, type Server } from "node:http";
import { ANTHROPIC_URL, FakeAnthropic } from "../test/helpers/fakeAnthropic.ts";
import { API_URL, FakeSlack, RESPONSE_URL_BASE } from "../test/helpers/fakeSlack.ts";
import { Network } from "../test/helpers/net.ts";
import type { FakeUser } from "../test/helpers/fakeSlack.ts";

export const MOCK_PORT = 8788;
export const CHANNEL = "C100";

/** A requester, owner and tagger per scenario, so scenarios never share plates, DMs or alarms. */
export const CAST = Object.fromEntries(
  ["A", "B", "C", "D", "E"].map((s) => [s, { requester: `UREQ${s}`, owner: `UOWN${s}`, tagger: `UTAG${s}` }]),
) as Record<string, { requester: string; owner: string; tagger: string }>;

function seed(slack: FakeSlack): void {
  const users: FakeUser[] = Object.values(CAST).flatMap((c) => [
    { id: c.requester, name: `req-${c.requester.at(-1)}`, real_name: `Requester ${c.requester.at(-1)}`, tz: "UTC" },
    { id: c.owner, name: `own-${c.owner.at(-1)}`, real_name: `Owner ${c.owner.at(-1)}`, tz: "UTC" },
    { id: c.tagger, name: `tag-${c.tagger.at(-1)}`, real_name: `Tagger ${c.tagger.at(-1)}`, tz: "UTC" },
  ]);
  for (const u of users) slack.addUser(u);
  slack.addChannel(CHANNEL, { name: "proj", members: users.map((u) => u.id) });
}

/** FakeSlack whose response_urls point at this server, because the worker really fetches them. */
class MockSlack extends FakeSlack {
  constructor(private origin: string) {
    super(Date.now);
    seed(this);
  }
  override issueResponseUrl(): string {
    return super.issueResponseUrl().replace(RESPONSE_URL_BASE, `${this.origin}/slack/response`);
  }
}

interface Script {
  toolName: string;
  input: unknown;
}

export class MockServers {
  slack!: MockSlack;
  anthropic!: FakeAnthropic;
  private net!: Network;
  private scripts: Script[] = [];
  private server: Server | null = null;

  constructor(readonly port = MOCK_PORT) {
    this.reset();
  }

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  get slackApiUrl(): string {
    return `${this.origin}/slack/api`;
  }
  get anthropicBaseUrl(): string {
    return `${this.origin}/anthropic`;
  }

  /** Queue the next answer of a tool-forced Anthropic call. */
  script(toolName: string, input: unknown): void {
    this.scripts.push({ toolName, input });
  }

  reset(): void {
    this.slack = new MockSlack(this.origin);
    this.anthropic = new FakeAnthropic();
    this.net = new Network();
    this.slack.attach(this.net);
    this.anthropic.attach(this.net);
    this.scripts = [];
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handle(req)
        .then(async (r) => {
          res.writeHead(r.status, Object.fromEntries(r.headers));
          res.end(Buffer.from(await r.arrayBuffer()));
        })
        .catch((err) => {
          console.error("[mock] handler crashed:", err);
          res.writeHead(500).end(String(err));
        });
    });
    await new Promise<void>((ok, fail) => this.server!.once("error", fail).listen(this.port, "127.0.0.1", ok));
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((ok) => (this.server ? this.server.close(() => ok()) : ok()));
  }

  // ---------- routing ----------

  private async handle(incoming: IncomingMessage): Promise<Response> {
    const url = new URL(incoming.url ?? "/", this.origin);
    const body = await readBody(incoming);
    const init = { method: incoming.method, headers: incoming.headers as Record<string, string>, body: body.length ? body : undefined };
    const path = url.pathname;

    if (path.startsWith("/slack/api/")) {
      return this.net.fetch(new Request(`${API_URL}/${path.slice("/slack/api/".length)}`, init));
    }
    if (path.startsWith("/slack/response/")) {
      return this.net.fetch(new Request(`${RESPONSE_URL_BASE}/${path.slice("/slack/response/".length)}`, init));
    }
    if (path === "/anthropic/v1/messages") {
      this.feedScript(body.toString("utf8"));
      return this.net.fetch(new Request(`${ANTHROPIC_URL}/v1/messages`, init));
    }
    if (path === "/control/script" && incoming.method === "POST") {
      const s = JSON.parse(body.toString("utf8")) as Script;
      this.script(s.toolName, s.input);
      return Response.json({ queued: this.scripts.length });
    }
    if (path === "/control/calls") {
      return Response.json({
        slack: this.slack.calls,
        responseUrlPosts: this.slack.responseUrlPosts,
        anthropic: this.anthropic.requests.map(({ model, prompt, toolNames, forcedTool, answeredWith }) => ({ model, prompt, toolNames, forcedTool, answeredWith })),
        unscripted: this.anthropic.unscripted.length,
      });
    }
    if (path === "/control/reset" && incoming.method === "POST") {
      this.reset();
      return Response.json({ ok: true });
    }
    return new Response(`mock: no route for ${incoming.method} ${path}`, { status: 404 });
  }

  /** Hand the next script for a tool this request offers (the forced one, if any) to the fake just in time, with placeholders resolved. */
  private feedScript(rawBody: string): void {
    let names: string[];
    try {
      const b = JSON.parse(rawBody) as { tools?: { name: string }[]; tool_choice?: { type?: string; name?: string } };
      names = b.tool_choice?.type === "tool" && b.tool_choice.name ? [b.tool_choice.name] : (b.tools ?? []).map((t) => t.name);
    } catch {
      return;
    }
    const i = this.scripts.findIndex((s) => names.includes(s.toolName));
    if (i < 0) return;
    const [s] = this.scripts.splice(i, 1);
    const input = JSON.parse(JSON.stringify(s!.input).replaceAll("$LATEST_TS", this.latestTs()));
    this.anthropic.queueToolUse(s!.toolName, input);
  }

  private latestTs(): string {
    let best = "0";
    for (const ch of this.slack.channels.values()) for (const m of ch.messages) if (m.ts > best) best = m.ts;
    return best;
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c)).on("end", () => ok(Buffer.concat(chunks))).on("error", fail);
  });
}

