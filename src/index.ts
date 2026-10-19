// Worker entry: Slack HTTP ingress (events + interactivity) and the extract-queue consumer.

import { handleOAuth } from "./oauth";
import { dispatch } from "./effects";
import { JOB_FAILED_REPLY, failureReply, handleExtractJob } from "./extract/index";
import { handleSlashCommand } from "./slack/commands";
import { handleEvent, type SlackEvent } from "./slack/events";
import { handleInteraction, type InteractionPayload } from "./slack/interactions";
import { verifySlackSignature } from "./slack/verify";
import { info } from "./log";
import type { Env, ExtractJob } from "./types";

/** Must match max_retries for the plates-extract consumer in wrangler.jsonc. */
const QUEUE_MAX_RETRIES = 3;

export { PlateKeeper } from "./keeper/PlateKeeper";

interface EventEnvelope {
  type: "url_verification" | "event_callback" | string;
  challenge?: string;
  event?: SlackEvent;
  authorizations?: { user_id?: string; is_bot?: boolean }[];
}

const text = (body: string, status = 200) => new Response(body, { status });

async function handleSlackRequest(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await req.text();
  const valid = await verifySlackSignature({
    secret: env.SLACK_SIGNING_SECRET,
    body,
    timestamp: req.headers.get("x-slack-request-timestamp"),
    signature: req.headers.get("x-slack-signature"),
  });
  if (!valid) return text("invalid signature", 401);

  // Slack retries when we were slow to ack. The first delivery is already being processed.
  if (req.headers.get("x-slack-retry-num")) return text("ok");

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return handleEnvelope(JSON.parse(body) as EventEnvelope, env, ctx);

  const params = new URLSearchParams(body);
  const payload = params.get("payload");
  if (payload) {
    const p = JSON.parse(payload) as InteractionPayload;
    info("slack interaction", interactionFields(p));
    return handleInteraction(env, ctx, p);
  }
  info("slash command", { user: params.get("user_id"), channel: params.get("channel_id"), word: (params.get("text") ?? "").trim().split(/\s+/)[0] || "help" });
  return handleSlashCommand(env, ctx, params) ?? text("ok");
}

function interactionFields(p: InteractionPayload): Record<string, unknown> {
  switch (p.type) {
    case "block_actions": return { type: p.type, user: p.user.id, action: p.actions[0]?.action_id, surface: p.view?.type ?? (p.channel?.id ?? p.container?.channel_id) };
    case "view_submission": return { type: p.type, user: p.user.id, callback: p.view.callback_id };
    case "message_action": return { type: p.type, user: p.user.id, callback: p.callback_id, channel: p.channel.id };
  }
}

function handleEnvelope(envelope: EventEnvelope, env: Env, ctx: ExecutionContext): Response {
  if (envelope.type === "url_verification") return text(envelope.challenge ?? "");
  if (envelope.type === "event_callback" && envelope.event) {
    const event = envelope.event;
    const e = event as { type: string; user?: string; channel?: string; channel_type?: string; subtype?: string; tab?: string; reaction?: string };
    info("slack event", { type: e.type, user: e.user, channel: e.channel, channel_type: e.channel_type, subtype: e.subtype, tab: e.tab, reaction: e.reaction });
    const botUserId = envelope.authorizations?.find((a) => a.is_bot !== false)?.user_id ?? null;
    ctx.waitUntil(
      handleEvent(env, event, { botUserId }).catch((err) => console.error("event failed", event.type, err)),
    );
  }
  return text("ok");
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(req.url).pathname.startsWith("/oauth/")) return handleOAuth(req, env);
    if (req.method !== "POST") return text("plates", 200);
    try {
      return await handleSlackRequest(req, env, ctx);
    } catch (err) {
      console.error("request failed", err);
      return text("error", 500);
    }
  },

  async queue(batch: MessageBatch<ExtractJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const job = message.body;
      const lastAttempt = message.attempts > QUEUE_MAX_RETRIES;
      const started = Date.now();
      try {
        const effects = await handleExtractJob(env, job);
        const failed = await dispatch(env, effects);
        info("job", { kind: job.kind, attempt: message.attempts, ms: Date.now() - started, effects: effects.map((x) => x.kind), failed: failed.map((x) => x.kind) });
        // A new request whose message never got posted would sit unseen; redelivery re-renders it.
        if (job.kind === "extract" && failed.some((e) => e.kind === "render_request") && !lastAttempt) {
          message.retry({ delaySeconds: 15 });
        } else {
          message.ack();
        }
      } catch (err) {
        console.error("extract job failed", job.kind, `attempt ${message.attempts}`, err);
        if (!lastAttempt) {
          message.retry({ delaySeconds: 15 });
          continue;
        }
        // Out of retries: don't leave people looking at "Reading the thread…" forever.
        await dispatch(env, await failureReply(env, job, JOB_FAILED_REPLY).catch(() => []));
        message.ack();
      }
    }
  },
} satisfies ExportedHandler<Env, ExtractJob>;
