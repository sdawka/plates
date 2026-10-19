// Behaviours pinned by the official Slack / Anthropic docs (verified in Round 2).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANTHROPIC_KEY } from "../helpers/fakeAnthropic";
import { createHarness, type Harness } from "../helpers/env";
import { tagThread } from "../helpers/scenario";

let h: Harness;
beforeEach(() => void (h = createHarness()));
afterEach(() => h.dispose());

describe("Anthropic forced tool use (docs: tool use > Forcing tool use)", () => {
  it("the extraction request with the configured EXTRACT_MODEL is accepted by the API", async () => {
    const t = await tagThread(h);
    expect(t.card).toBeTruthy();
  });

  it("strict tool schemas used by the app are accepted (no unsupported keywords)", async () => {
    await tagThread(h);
    const tools = h.anthropic.requests.flatMap((r) => (r.body.tools as { strict?: boolean }[]) ?? []);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t.strict === true)).toBe(true);
  });

  it("the fake rejects forced tool use on Sonnet 5.5 and allows it on Haiku 5.5", async () => {
    const call = (model: string) =>
      fetch("https://anthropic.test/v1/messages", {
        method: "POST",
        headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model, max_tokens: 10, messages: [{ role: "user", content: "x" }],
          tools: [{ name: "t", input_schema: { type: "object" } }], tool_choice: { type: "tool", name: "t" },
        }),
      });
    const res = await call("claude-sonnet-5-5");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { type: string } }).error.type).toBe("invalid_request_error");
    // Haiku passes validation (the 400 here is only the fake's "nothing scripted" answer).
    expect(JSON.stringify(await (await call("claude-haiku-5-5")).json())).toContain("nothing scripted");
  });
});
