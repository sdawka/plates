import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOT_USER_ID, CHANNEL, USERS, createHarness, type Harness } from "../helpers/env";
import { tagAndConfirm, text } from "../helpers/scenario";
import { HELP_OPEN_ACTION_ID } from "../../src/slack/actions";

let h: Harness;
beforeEach(() => void (h = createHarness()));
afterEach(() => h.dispose());

const openMessagesTab = (user: string) =>
  h.ingress.event({ type: "app_home_opened", user, channel: h.slack.im(user).id, tab: "messages", event_ts: h.slack.nextTs() });

describe("introducing itself", () => {
  it("greets someone the first time they open the DM, and only the first time", async () => {
    expect((await openMessagesTab(USERS.dana)).status).toBe(200);
    await openMessagesTab(USERS.dana);
    const posts = h.slack.botMessages(h.slack.im(USERS.dana).id);
    expect(posts).toHaveLength(1);
    expect(text(posts[0]!)).toContain("Hi, I'm Plates");
    expect(text(posts[0]!)).toContain("Put on someone's plate");
  });

  it("says hello when added to a channel, and ignores other people joining", async () => {
    h.slack.addChannel("C300", { members: [USERS.dana] });
    await h.ingress.event({ type: "member_joined_channel", user: USERS.eve, channel: "C300", channel_type: "C", event_ts: h.slack.nextTs() });
    expect(h.slack.botMessages("C300")).toHaveLength(0);
    await h.ingress.event({ type: "member_joined_channel", user: BOT_USER_ID, channel: "C300", inviter: USERS.dana, event_ts: h.slack.nextTs() });
    const posts = h.slack.botMessages("C300");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain(`Thanks for adding me, <@${USERS.dana}>`);
  });

  it("answers @plates help privately, without reading the thread", async () => {
    const root = await h.say({ user: USERS.dana, text: "hello all" });
    await h.say({ user: USERS.tara, text: "<@UBOT> help", thread_ts: root.ts });
    expect(h.queue.sentOfKind("extract")).toHaveLength(0);
    expect(h.slack.ephemerals).toHaveLength(1);
    expect(h.slack.ephemerals[0]).toMatchObject({ channel: CHANNEL, user: USERS.tara });
    expect(JSON.stringify(h.slack.ephemerals[0]!.blocks)).toContain("Capture an ask");
  });

  it("opens the help from the Home tab", async () => {
    await h.openHome(USERS.dana);
    expect((await h.clickHome(USERS.dana, HELP_OPEN_ACTION_ID, "open")).status).toBe(200);
    const modal = h.slack.lastModal();
    expect(JSON.stringify(modal.blocks)).toContain("Capture an ask");
  });
});

describe("asking Plates in the DM", () => {
  const dm = (u: string) => h.slack.im(u).id;

  it("help in the DM replies in the message's thread without a model call", async () => {
    const msg = await h.say({ channel: dm(USERS.dana), user: USERS.dana, text: "How does Plates work?" });
    const replies = h.slack.botMessages(dm(USERS.dana)).filter((m) => m.thread_ts === msg.ts);
    expect(replies).toHaveLength(1);
    expect(text(replies[0]!)).toContain("Capture an ask");
    expect(h.queue.sentOfKind("extract")).toHaveLength(0);
    expect(h.systemOne.requests).toHaveLength(0);
  });

  it("lists the owner's plate and the requester's waiting list, read-only", async () => {
    await tagAndConfirm(h);

    const q1 = await h.say({ channel: dm(USERS.bob), user: USERS.bob, text: "What's on my plate?" });
    const plate = h.slack.botMessages(dm(USERS.bob)).find((m) => m.thread_ts === q1.ts)!;
    expect(text(plate)).toContain("Send the Q3 numbers");
    expect(text(plate)).toContain("Home");
    expect(JSON.stringify(plate.blocks)).not.toContain('"type":"button"');

    const q2 = await h.say({ channel: dm(USERS.dana), user: USERS.dana, text: "what am i waiting on" });
    const waiting = h.slack.botMessages(dm(USERS.dana)).find((m) => m.thread_ts === q2.ts)!;
    expect(text(waiting)).toContain("Send the Q3 numbers");
    expect(waiting.text).toBe("You're waiting on 1 ask.");

    expect(h.queue.sentOfKind("extract")).toHaveLength(1); // only the original tag
  });

  it("an empty plate says so", async () => {
    const q = await h.say({ channel: dm(USERS.eve), user: USERS.eve, text: "my plate" });
    const reply = h.slack.botMessages(dm(USERS.eve)).find((m) => m.thread_ts === q.ts)!;
    expect(reply.text).toBe("Your plate is clear. 🎉");
  });
});
