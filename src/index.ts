// Worker entry: Slack HTTP ingress (events + interactivity) and the extract-queue consumer.

import { handleOAuth } from "./oauth";
import { dispatch } from "./effects";
import { handleExtractJob } from "./extract/index";
import { handleSlashCommand } from "./slack/commands";
import { handleEvent, type SlackEvent } from "./slack/events";
import { handleInteraction, type InteractionPayload } from "./slack/interactions";
import { verifySlackSignature } from "./slack/verify";
import type { Env, ExtractJob } from "./types";

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
  if (payload) return handleInteraction(env, ctx, JSON.parse(payload) as InteractionPayload);
  return handleSlashCommand(env, ctx, params) ?? text("ok");
}

function handleEnvelope(envelope: EventEnvelope, env: Env, ctx: ExecutionContext): Response {
  if (envelope.type === "url_verification") return text(envelope.challenge ?? "");
  if (envelope.type === "event_callback" && envelope.event) {
    const event = envelope.event;
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
      try {
        await dispatch(env, await handleExtractJob(env, message.body));
        message.ack();
      } catch (err) {
        console.error("extract job failed", message.body.kind, err);
        message.retry({ delaySeconds: 15 });
      }
    }
  },
} satisfies ExportedHandler<Env, ExtractJob>;
