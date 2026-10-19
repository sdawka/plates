// Reusable scenario steps for e2e tests.
import { expect } from "vitest";
import { flatText, type StoredMessage } from "./fakeSlack";
import { CHANNEL, USERS, extractionInput, type Harness } from "./env";

export interface Tagged {
  root: StoredMessage;
  tag: StoredMessage;
  requestId: string;
  /** The bot's confirmation message in the thread. */
  card: StoredMessage;
}

/** dana asks bob in a channel message; tara tags @plates in the thread; the queue extracts. */
export async function tagThread(
  h: Harness,
  o: {
    titles?: string[];
    requester?: string | null;
    owner?: string | null;
    tagger?: string;
    rootText?: string;
    tagText?: string;
    type?: string;
    due?: string | null;
    confidence?: number;
    clarify?: string | null;
  } = {},
): Promise<Tagged> {
  const root = await h.say({ user: USERS.dana, text: o.rootText ?? `<@${USERS.bob}> can you send the Q3 numbers by Friday?` });
  const titles = o.titles ?? ["Send the Q3 numbers"];
  h.anthropic.queueToolUse(
    "record_asks",
    extractionInput({
      requester: o.requester === undefined ? USERS.dana : o.requester,
      owner: o.owner === undefined ? USERS.bob : o.owner,
      confidence: o.confidence,
      clarify: o.clarify,
      asks: titles.map((title) => ({ title, source_ts: root.ts, type: o.type, due: o.due })),
    }),
  );
  const tag = await h.say({ user: o.tagger ?? USERS.tara, text: o.tagText ?? "<@UBOT> put this on Bob's plate", thread_ts: root.ts });
  await h.drain();
  const [request] = h.requests().slice(-1);
  expect(request, "a request row was created").toBeTruthy();
  const card = h.slack.message(CHANNEL, request!.message_ts as string);
  return { root, tag, requestId: request!.id as string, card };
}

/** tagThread, then the requester reacts with a check mark. Returns the confirmed live message and the owner DM. */
export async function tagAndConfirm(h: Harness, o: Parameters<typeof tagThread>[1] = {}) {
  const t = await tagThread(h, o);
  await h.react(USERS.dana, { channel: CHANNEL, ts: t.card.ts }, "white_check_mark");
  const live = h.slack.message(CHANNEL, t.card.ts);
  const ownerDms = h.slack.im(USERS.bob).messages;
  return { ...t, live, ownerDm: ownerDms.at(-1)!, asks: h.asks() };
}

export const text = (m: StoredMessage) => flatText(m);
