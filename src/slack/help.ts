// Plates introducing itself: the help message, the first-open intro, the channel-join hello, and the
// plain-words DM questions ("help", "what's on my plate?") that are answered without a model call.
// Pure: no I/O.

import { HELP_OPEN_ACTION_ID, SETTINGS_OPEN_ACTION_ID } from "./actions";
import type { Block, Rendered } from "./blocks";
import { HELP_TEXT } from "./parse";

const mrkdwn = (text: string) => ({ type: "mrkdwn", text });
const plain = (text: string) => ({ type: "plain_text", text, emoji: true });
const section = (text: string): Block => ({ type: "section", text: mrkdwn(text) });
const context = (text: string): Block => ({ type: "context", elements: [mrkdwn(text)] });

/** The starter prompts, shared by the manifest's agent_view and the help message. */
export const SUGGESTED_PROMPTS = [
  { title: "What's on my plate?", message: "What's on my plate?" },
  { title: "What am I waiting on?", message: "What am I waiting on?" },
  { title: "Track an ask", message: "Remind me to send Dana the Q3 deck by Friday" },
  { title: "How does Plates work?", message: "How does Plates work?" },
] as const;

const HELP_BODY: string[] = [
  "*Capture an ask*\n• Tag @plates in a thread. I read it and work out who's asking whom.\n• On any message, ⋯ → *Put on someone's plate*.\n• `/plates @bob send the Q3 deck by Friday`\n• Or DM me the ask: “remind me to…”, “Dana needs the deck from Bob by Friday”.",
  "*Confirm*\nI always post what I understood first. The person asking or the person doing it presses *✅ Confirm* (a ✅ reaction works too), or replies to fix it (“it's Carol, not Bob”).",
  "*Work through it*\nYour plate lives in my *Home* tab: start, snooze, mark done, send back, hand it off. You can also reply in the ask's thread in plain words (“done, here's the link”, “Dana owns this”) and I'll apply it, with Undo.",
  "*Reminders*\nA daily digest at a time you choose, then a nudge on the due date. Only the person who asked can close an ask, so nothing disappears unnoticed.",
];

export interface HelpOptions {
  /** Include the Settings / help buttons (not inside a modal, which can't open another one this way). */
  buttons?: boolean;
  /** Greeting line on top, for the first time someone opens the DM. */
  greeting?: boolean;
}

export function helpBlocks(opts: HelpOptions = {}): Block[] {
  const blocks: Block[] = [];
  if (opts.greeting) {
    blocks.push(section("👋 *Hi, I'm Plates.* I keep track of who asked whom for what, so nothing falls off anyone's plate."));
  } else {
    blocks.push(section("*Plates* keeps track of who asked whom for what, so nothing falls off anyone's plate."));
  }
  for (const text of HELP_BODY) blocks.push({ type: "divider" }, section(text));
  blocks.push(context("Ask me “what's on my plate?” or “what am I waiting on?” any time. Say “help” to see this again."));
  if (opts.buttons !== false) {
    blocks.push({
      type: "actions",
      block_id: "help_actions",
      elements: [{ type: "button", action_id: SETTINGS_OPEN_ACTION_ID, text: plain("⚙ Settings"), value: "open" }],
    });
  }
  return blocks;
}

export function helpMessage(opts: HelpOptions = {}): Rendered {
  return { text: opts.greeting ? "Hi, I'm Plates. Here's how I work." : HELP_TEXT, blocks: helpBlocks(opts) };
}

export function helpModal(): Block {
  return { type: "modal", title: plain("How Plates works"), close: plain("Close"), blocks: helpBlocks({ buttons: false }) };
}

/** Button that opens the help modal (Home tab). */
export const helpButton = (): Block => ({ type: "button", action_id: HELP_OPEN_ACTION_ID, text: plain("❓ How it works"), value: "open" });

/** Posted once when someone adds Plates to a channel. */
export function channelIntro(inviterId?: string): Rendered {
  const thanks = inviterId ? `Thanks for adding me, <@${inviterId}>. ` : "";
  const text = `👋 ${thanks}I'm Plates: I keep track of who asked whom for what. Tag @plates in a thread with an ask and I'll put it on the right person's plate. Say \`@plates help\` for more.`;
  return { text, blocks: [section(text)] };
}

const EXPLICIT_HELP_RE = /^(help|what can you do|how does plates work|how do you work|how do i use (this|plates|you))$/;

/** "@plates help" in a channel: only explicit help, never a greeting, which may come with an ask in the thread. */
export function isExplicitHelp(text: string): boolean {
  const t = norm(text.replace(/<@[A-Z0-9]+>/g, ""));
  return t === "" ? false : EXPLICIT_HELP_RE.test(t);
}

export type DmQuestion = "help" | "plate" | "waiting";

const norm = (s: string) =>
  s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z' ]+/g, " ").replace(/\s+/g, " ").trim();

const HELP_RE = /^(help|hi|hello|hey|hiya|yo|start|intro|about|what can you do|what do you do|who are you|how does plates work|how do you work|how does this work|how do i use (this|plates|you))$/;
const PLATE_RE = /^(what'?s|what is|show( me)?|list)? ?(on )?my plate( today)?$|^(my )?(plate|todo|to do|tasks|asks)$|^what do i (have|owe)( to do)?( today)?$/;
const WAITING_RE = /^(what am i|who am i|what'?s i'?m|show( me)?)? ?waiting (on|for)( anyone| others| people)?$|^waiting$/;

/** A DM that is a question for Plates rather than an ask to track, or null. Matches plain phrasings only. */
export function parseDmQuestion(text: string): DmQuestion | null {
  if (text.trim() === "?") return "help";
  const t = norm(text.replace(/<@[A-Z0-9]+>/g, ""));
  if (t === "") return null;
  if (HELP_RE.test(t) || HELP_RE.test(t.replace(/^plates /, ""))) return "help";
  if (PLATE_RE.test(t)) return "plate";
  if (WAITING_RE.test(t)) return "waiting";
  return null;
}
