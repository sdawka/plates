import { describe, expect, it } from "vitest";
import { buildIntentJob, commandPostText, linksFromText, normalizeCommandText, parseSlashCommand, parseSlashText } from "../src/slack/parse";

describe("linksFromText", () => {
  it("extracts and unescapes links, dropping labels and duplicates", () => {
    expect(linksFromText("see <https://x.test/a?b=1&amp;c=2|the doc> and <http://y.test> and <https://x.test/a?b=1&amp;c=2>")).toEqual([
      "https://x.test/a?b=1&c=2",
      "http://y.test",
    ]);
  });
  it("ignores mentions, channels and mailto", () => {
    expect(linksFromText("<@U1> <#C1|general> <mailto:a@b.c|a@b.c> plain https://not-wrapped.test")).toEqual([]);
  });
});

describe("buildIntentJob", () => {
  it("collects files and links", () => {
    const job = buildIntentJob({
      channel: "C1", ts: "2.2", thread_ts: "1.1", user: "U1", text: "here: <https://x.test/doc|doc>",
      files: [{ name: "a.pdf", title: "Deck", permalink: "https://slack.test/f/1" }, { name: "b.png" }],
    });
    expect(job).toEqual({
      kind: "intent", channelId: "C1", threadTs: "1.1", messageTs: "2.2", userId: "U1", text: "here: <https://x.test/doc|doc>",
      files: [{ name: "Deck", permalink: "https://slack.test/f/1" }, { name: "b.png", permalink: null }],
      links: ["https://x.test/doc"],
    });
  });
  it("tolerates a missing text and files", () => {
    expect(buildIntentJob({ channel: "C", ts: "2", thread_ts: "1", user: "U" })).toMatchObject({ text: "", files: [], links: [] });
  });
});

describe("slash command", () => {
  const form = (o: Record<string, string>) => new URLSearchParams(o);

  it("parses Slack's form payload", () => {
    expect(
      parseSlashCommand(form({ command: "/plates", text: "help", user_id: "U1", channel_id: "C1", response_url: "https://hooks.slack.test/r", trigger_id: "t1" })),
    ).toEqual({ command: "/plates", text: "help", userId: "U1", channelId: "C1", responseUrl: "https://hooks.slack.test/r", triggerId: "t1" });
  });
  it("is null for other bodies", () => {
    expect(parseSlashCommand(form({ foo: "bar" }))).toBeNull();
    expect(parseSlashCommand(form({ command: "/plates" }))).toBeNull();
  });
  it("routes help, settings and capture", () => {
    expect(parseSlashText("")).toEqual({ kind: "help" });
    expect(parseSlashText("  Help ")).toEqual({ kind: "help" });
    expect(parseSlashText("settings")).toEqual({ kind: "settings" });
    expect(parseSlashText("<@UBOB|bob> send the deck by Friday")).toEqual({ kind: "capture", text: "<@UBOB> send the deck by Friday" });
    expect(parseSlashText("settings please")).toMatchObject({ kind: "capture" });
  });
  it("normalizes escaped mentions only", () => {
    expect(normalizeCommandText(" <@U1|a> and <#C1|general> and <@U2> ")).toBe("<@U1> and <#C1|general> and <@U2>");
  });
  it("builds the channel post", () => {
    expect(commandPostText("U1", "<@U2> send the deck")).toBe("<@U1> via /plates: <@U2> send the deck");
  });
});
