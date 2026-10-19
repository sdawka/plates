// Behaviours pinned by the official Slack / Anthropic docs (verified in Round 2).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANTHROPIC_KEY } from "../helpers/fakeAnthropic";
import { createHarness, type Harness } from "../helpers/env";
import { tagThread } from "../helpers/scenario";

let h: Harness;
beforeEach(() => void (h = createHarness()));
afterEach(() => h.dispose());

describe("Anthropic forced tool use (docs: tool use > Forcing tool use)", () => {
  // SRC BUG: src/extract/llm.ts:16 (and src/intent/llm.ts:14) send tool_choice {type:"tool"} with
  // EXTRACT_MODEL=claude-sonnet-5-5 (wrangler.jsonc:24), which the API rejects with a 400.
  // Fix: tool_choice {type:"auto"} + strict:true on the tool + an instruction to call it, or use a model that allows forcing.
  it.fails("the extraction request with the configured EXTRACT_MODEL is accepted by the API", async () => {
    h.anthropic.rejectForcedToolOnNewModels = true;
    const t = await tagThread(h);
    expect(t.card).toBeTruthy();
  });

  it("the fake rejects forced tool use on Sonnet 5.5 and allows it on Haiku 5.5", async () => {
    h.anthropic.rejectForcedToolOnNewModels = true;
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
