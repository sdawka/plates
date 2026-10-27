// README screenshots: plays a scenario through the test harness (real Worker code, fake Slack and models),
// renders the Block Kit Plates actually produced as Slack-styled HTML, and screenshots it with Chrome.
//
//   npm run screenshots          writes docs/images/*.png
//
// Needs Google Chrome and python3 with Pillow (to trim the whitespace around each capture).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CHANNEL, USERS, createHarness, extractionInput, type Harness } from "../test/helpers/env.ts";
import type { StoredMessage } from "../test/helpers/fakeSlack.ts";
import { BOT, channelFrame, dmFrame, homeFrame, page, type Person, type ShownMessage } from "./screenshots/render.ts";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = "docs/images";

const PEOPLE: Record<string, Person> = {
  [USERS.dana]: { name: "Dana Reed", initials: "DR", color: "#d9e8ff" },
  [USERS.bob]: { name: "Bob Ortiz", initials: "BO", color: "#ffe3c4" },
  [USERS.tara]: { name: "Tara Lin", initials: "TL", color: "#e2f5d8" },
  [USERS.eve]: { name: "Eve Park", initials: "EP", color: "#f3dcf5" },
};
const NAMES = Object.fromEntries(Object.entries(PEOPLE).map(([id, p]) => [id, p.name.split(" ")[0]!]));
NAMES.UBOT = "plates";

const human = (user: string, text: string, time: string, reply = true, reactions?: string[]): ShownMessage => ({ by: PEOPLE[user]!, text, time, reply, reactions });
const bot = (m: StoredMessage, time: string, reply = true, reactions?: string[]): ShownMessage => ({ by: BOT, blocks: m.blocks as ShownMessage["blocks"], text: m.text as string, time, reply, reactions });

/** A confirmed request from dana to bob with the given asks; returns the live card and the owner DM. */
async function request(h: Harness, rootText: string, asks: { title: string; type?: string; size?: string; due?: string | null }[], requester = USERS.dana, owner = USERS.bob) {
  const root = await h.say({ user: requester, text: rootText });
  h.anthropic.queueToolUse("record_asks", extractionInput({ requester, owner, asks: asks.map((a) => ({ ...a, source_ts: root.ts })) }));
  const tag = await h.say({ user: USERS.tara, text: "<@UBOT>", thread_ts: root.ts });
  await h.drain();
  const req = h.requests().at(-1)!;
  // The fake extractor labels every estimate "scripted"; the DM shows that line, so give it a real reason.
  const draft = JSON.parse(req.draft_json as string) as { estimate_reason?: string; size?: string }[];
  for (const d of draft) d.estimate_reason = d.size === "days" ? "needs quotes from a few venues" : d.size === "2-5min" ? "one decision, no prep" : d.size === "lt1h" ? "a read-through and comments" : "pulling from the finance sheet";
  h.q("UPDATE requests SET draft_json = ? WHERE id = ?", JSON.stringify(draft), req.id);
  const card = h.slack.message(CHANNEL, req.message_ts as string);
  return { root, tag, req, card };
}

async function reply(h: Harness, root: StoredMessage, user: string, text: string, a: { choice: string; p?: number; deadline?: string; delivers?: number }) {
  h.systemOne.queueChoice("action", a.choice, a.p ?? 0.95);
  h.systemOne.queueNoul("ambiguous", 0.02);
  if (a.deadline !== undefined) h.systemOne.queueChoice("deadline", a.deadline);
  if (a.delivers !== undefined) h.systemOne.queueNoul("delivers_A1", a.delivers);
  const msg = await h.say({ user, text, thread_ts: root.ts });
  await h.drain();
  return msg;
}

const lastThreadBot = (h: Harness, root: StoredMessage) => h.slack.botMessages(CHANNEL).filter((m) => m.thread_ts === root.ts).at(-1)!;

function shoot(name: string, html: string): void {
  mkdirSync(OUT, { recursive: true });
  const file = resolve(OUT, `${name}.html`);
  const png = resolve(OUT, `${name}.png`);
  writeFileSync(file, html);
  execFileSync(CHROME, ["--headless=new", "--hide-scrollbars", "--force-device-scale-factor=2", "--window-size=840,2400", `--screenshot=${png}`, `file://${file}`], { stdio: "ignore" });
  execFileSync("python3", ["-c", `
from PIL import Image, ImageChops
im = Image.open("${png}").convert("RGB")
bg = Image.new("RGB", im.size, (255, 255, 255))
box = ImageChops.difference(im, bg).getbbox()
im.crop((max(box[0]-24,0), max(box[1]-24,0), min(box[2]+24, im.width), min(box[3]+24, im.height))).save("${png}", optimize=True)
`]);
  execFileSync("rm", [file]);
  console.log(`wrote ${png}`);
}

async function main(): Promise<void> {
  const h = createHarness();
  h.systemOne.alwaysChoice("deadline", "none").alwaysNoul("ambiguous", 0.02).alwaysNoul("delivers_A1", 0.05);
  try {
    // 1. Capture and confirmation.
    const a = await request(h, "<@UBOB> can you send the Q3 numbers by Friday, and review the launch deck when you get a sec?", [
      { title: "Send the Q3 numbers", size: "hours", due: "2026-10-23" },
      { title: "Review the launch deck", size: "lt1h" },
    ]);
    shoot("capture", page(channelFrame("proj", "Dana, Bob, Tara and 4 others", [
      human(USERS.dana, "@Bob can you send the Q3 numbers by Friday, and review the launch deck when you get a sec?", "10:02 AM", false),
      human(USERS.tara, "@plates", "10:03 AM"),
      bot(a.card, "10:03 AM"),
    ], NAMES)));

    // 2. Confirmed, then the owner replies in plain words: applied with Undo; a less sure one becomes a proposal.
    await h.react(USERS.dana, { channel: CHANNEL, ts: a.card.ts }, "white_check_mark");
    const live = h.slack.message(CHANNEL, a.card.ts);
    const ownerDm = h.slack.im(USERS.bob).messages.at(-1)!;
    await reply(h, a.root, USERS.bob, "on it, numbers by Thursday", { choice: "A1:accept_later", deadline: "2026-10-22" });
    const applied = lastThreadBot(h, a.root);
    await reply(h, a.root, USERS.bob, "hmm the deck might need Eve's eyes first", { choice: "A2:send_back", p: 0.62 });
    const proposal = lastThreadBot(h, a.root);
    shoot("thread", page(channelFrame("proj", "Dana, Bob, Tara and 4 others", [
      bot(live, "10:03 AM", true, ["✅ 1"]),
      human(USERS.bob, "on it, numbers by Thursday", "10:41 AM"),
      bot(applied, "10:41 AM"),
      human(USERS.bob, "hmm the deck might need Eve's eyes first", "10:44 AM"),
      bot(proposal, "10:44 AM"),
    ], NAMES)));

    // 3. The owner's DM.
    shoot("owner-dm", page(dmFrame("Plates", [bot(ownerDm, "10:03 AM", false)], NAMES)));

    // 4. Home tab for Bob, with work in several states and something he is waiting on.
    const b = await request(h, "<@UBOB> could you book the offsite venue? we need it locked in", [{ title: "Book the offsite venue", size: "days" }], USERS.eve);
    await h.react(USERS.eve, { channel: CHANNEL, ts: b.card.ts }, "white_check_mark");
    await reply(h, b.root, USERS.bob, "on it", { choice: "A1:accept_now" });
    const c = await request(h, "<@UDANA> can you approve the vendor contract today?", [{ title: "Approve the vendor contract", type: "decision", size: "2-5min" }], USERS.bob, USERS.dana);
    await h.react(USERS.dana, { channel: CHANNEL, ts: c.card.ts }, "white_check_mark");
    await reply(h, c.root, USERS.dana, "approved, go ahead", { choice: "A1:done" });
    await h.openHome(USERS.bob);
    const home = h.slack.homeViews.get(USERS.bob)!;
    shoot("home", page(homeFrame(home.blocks as Record<string, unknown>[], NAMES)));

    const problems = h.errors;
    if (problems.length) throw new Error(`worker errors:\n${problems.join("\n")}`);
  } finally {
    h.dispose();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
