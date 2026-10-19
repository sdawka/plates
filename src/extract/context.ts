// Gathers the conversation the model reads: messages with stable ids, speaker names and tz.

import { SlackApiError, slackCall, type SlackMessage } from "../slack/api";
import type { Env } from "../types";

export interface ContextMessage {
  ts: string;
  userId: string | null;
  name: string;
  text: string;
  files: string[];
}

export interface Participant {
  id: string;
  name: string;
  tz: string;
}

export interface ConversationContext {
  messages: ContextMessage[];
  /** Real (non-bot) people who spoke or were mentioned, plus the tagger. */
  participants: Map<string, Participant>;
}

/** Channel can't be read: the caller should ask for an invite. */
export class ChannelUnreadableError extends Error {}

const UNREADABLE = new Set(["not_in_channel", "channel_not_found", "missing_scope", "no_permission"]);
const MAX_THREAD_MESSAGES = 200;
const MAX_HISTORY_MESSAGES = 30;
const HISTORY_WINDOW_MS = 24 * 3600 * 1000;
const MAX_MENTION_LOOKUPS = 30;

interface RepliesResponse {
  messages?: SlackMessage[];
  response_metadata?: { next_cursor?: string };
}
interface HistoryResponse {
  messages?: SlackMessage[];
}
interface UserInfoResponse {
  user?: {
    id: string;
    is_bot?: boolean;
    deleted?: boolean;
    name?: string;
    real_name?: string;
    tz?: string;
    profile?: { display_name?: string; real_name?: string };
  };
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof SlackApiError && UNREADABLE.has(e.error)) throw new ChannelUnreadableError(e.error);
    throw e;
  }
}

export async function fetchThread(env: Env, channel: string, threadTs: string): Promise<SlackMessage[]> {
  const all: SlackMessage[] = [];
  let cursor: string | undefined;
  do {
    const res: RepliesResponse = await guarded(() =>
      slackCall<RepliesResponse>(env, "conversations.replies", { channel, ts: threadTs, limit: 100, ...(cursor ? { cursor } : {}) }),
    );
    all.push(...(res.messages ?? []));
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor && all.length < MAX_THREAD_MESSAGES);
  return all.slice(0, MAX_THREAD_MESSAGES);
}

/** Last ~30 messages / 24h ending at (and including) `endTs`, oldest first. */
export async function fetchHistory(env: Env, channel: string, endTs: string): Promise<SlackMessage[]> {
  const oldest = (Math.max(Number(endTs) * 1000 - HISTORY_WINDOW_MS, 0) / 1000).toFixed(6);
  const res = await guarded(() =>
    slackCall<HistoryResponse>(env, "conversations.history", {
      channel,
      latest: endTs,
      inclusive: true,
      oldest,
      limit: MAX_HISTORY_MESSAGES,
    }),
  );
  return [...(res.messages ?? [])].reverse();
}

const MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

/** Resolves ids to names/tz, caching within one job. Returns null for bots / unknown users. */
export class UserDirectory {
  private cache = new Map<string, Promise<(Participant & { isBot: boolean }) | null>>();
  constructor(private env: Env) {}

  lookup(id: string): Promise<(Participant & { isBot: boolean }) | null> {
    let p = this.cache.get(id);
    if (!p) {
      p = slackCall<UserInfoResponse>(this.env, "users.info", { user: id })
        .then((r) => {
          const u = r.user;
          if (!u) return null;
          const name = u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || id;
          return { id, name, tz: u.tz || "UTC", isBot: !!u.is_bot };
        })
        .catch((e: unknown) => {
          if (e instanceof SlackApiError) return { id, name: id, tz: "UTC", isBot: false };
          throw e;
        });
      this.cache.set(id, p);
    }
    return p;
  }
}

function describeFiles(m: SlackMessage): string[] {
  return (m.files ?? []).map((f) => f.title || f.name || "file").filter(Boolean);
}

/** Build model context from raw Slack messages. Bot messages are dropped unless they carry files. */
export async function buildContext(
  env: Env,
  raw: SlackMessage[],
  extraUserIds: string[],
  directory = new UserDirectory(env),
): Promise<ConversationContext> {
  const seen = new Set<string>();
  const kept: SlackMessage[] = [];
  for (const m of raw) {
    if (seen.has(m.ts)) continue;
    seen.add(m.ts);
    const isBot = !!m.bot_id || m.subtype === "bot_message";
    if (isBot && describeFiles(m).length === 0) continue;
    if (!isBot && !m.text && describeFiles(m).length === 0) continue;
    kept.push(m);
  }
  kept.sort((a, b) => Number(a.ts) - Number(b.ts));

  const ids = new Set<string>(extraUserIds);
  for (const m of kept) {
    if (m.user && !m.bot_id) ids.add(m.user);
  }
  let mentionBudget = MAX_MENTION_LOOKUPS;
  for (const m of kept) {
    for (const mm of (m.text ?? "").matchAll(MENTION_RE)) {
      const id = mm[1];
      if (id && !ids.has(id) && mentionBudget-- > 0) ids.add(id);
    }
  }

  const participants = new Map<string, Participant>();
  await Promise.all(
    [...ids].map(async (id) => {
      const u = await directory.lookup(id);
      if (u && !u.isBot) participants.set(id, { id: u.id, name: u.name, tz: u.tz });
    }),
  );

  const messages: ContextMessage[] = kept.map((m) => {
    const uid = m.user && !m.bot_id ? m.user : null;
    const text = (m.text ?? "").replace(MENTION_RE, (_all, id: string) => {
      const p = participants.get(id);
      return p ? `@${p.name} (${id})` : "";
    });
    return {
      ts: m.ts,
      userId: uid,
      name: uid ? (participants.get(uid)?.name ?? uid) : "bot",
      text: text.trim(),
      files: describeFiles(m),
    };
  });
  return { messages, participants };
}

/** Context for a fresh tag: the thread, or recent channel history ending at the tag message. */
export async function gatherForTag(
  env: Env,
  channelId: string,
  threadTs: string | null,
  messageTs: string,
  taggerId: string,
  /** Credentials for reading messages (a user token for DMs); names are always resolved with `env`. */
  readEnv: Env = env,
): Promise<ConversationContext> {
  const raw = threadTs ? await fetchThread(readEnv, channelId, threadTs) : await fetchHistory(readEnv, channelId, messageTs);
  return buildContext(env, raw, [taggerId]);
}

/** Context built from the one captured message, when nothing else can be read. */
export function singleMessage(ts: string, userId: string, text: string): SlackMessage[] {
  return [{ ts, user: userId, text }];
}

/** Context for re-extraction: the thread, plus the channel history before it if the original tag was top level. */
export async function gatherForThread(
  env: Env,
  channelId: string,
  threadTs: string,
  includeHistoryBefore: boolean,
  extraUserIds: string[],
): Promise<ConversationContext> {
  const thread = await fetchThread(env, channelId, threadTs);
  const history = includeHistoryBefore ? await fetchHistory(env, channelId, threadTs) : [];
  return buildContext(env, [...history, ...thread], extraUserIds);
}

export async function getPermalink(env: Env, channel: string, messageTs: string): Promise<string | null> {
  try {
    const r = await slackCall<{ permalink?: string }>(env, "chat.getPermalink", { channel, message_ts: messageTs });
    return r.permalink ?? null;
  } catch (e) {
    if (e instanceof SlackApiError) return null;
    throw e;
  }
}
