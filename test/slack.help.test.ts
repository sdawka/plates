import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUGGESTED_PROMPTS, isExplicitHelp, parseDmQuestion } from "../src/slack/help";

describe("parseDmQuestion", () => {
  it.each([
    ["help", "help"], ["Hi!", "help"], ["?", "help"], ["How does Plates work?", "help"], ["what can you do", "help"],
    ["What's on my plate?", "plate"], ["whats on my plate", "plate"], ["my plate", "plate"], ["What do I have to do today?", "plate"],
    ["What am I waiting on?", "waiting"], ["who am i waiting for", "waiting"], ["waiting", "waiting"],
  ])("%j is %s", (text, kind) => expect(parseDmQuestion(text)).toBe(kind));

  it.each(["Remind me to send Dana the Q3 deck by Friday", "help Bob with the plate design", "hi, can you ask Bob for the deck?", ""])(
    "%j is an ask or nothing, not a question",
    (text) => expect(parseDmQuestion(text)).toBeNull(),
  );

  it("every suggested prompt but 'Track an ask' is answered directly", () => {
    const kinds = SUGGESTED_PROMPTS.map((p) => parseDmQuestion(p.message));
    expect(kinds).toEqual(["plate", "waiting", null, "help"]);
  });

  it("the manifest's suggested prompts match", () => {
    const yaml = readFileSync("slack-manifest.yaml", "utf8");
    for (const p of SUGGESTED_PROMPTS) expect(yaml).toContain(`message: ${p.message}`);
  });
});

describe("isExplicitHelp", () => {
  it("only explicit help in a channel, not greetings", () => {
    expect(isExplicitHelp("<@UBOT> help")).toBe(true);
    expect(isExplicitHelp("<@UBOT> how does plates work?")).toBe(true);
    expect(isExplicitHelp("<@UBOT> hi")).toBe(false);
    expect(isExplicitHelp("<@UBOT> help bob with this")).toBe(false);
    expect(isExplicitHelp("<@UBOT>")).toBe(false);
  });
});
