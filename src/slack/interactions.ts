// Slack interactivity: block_actions (buttons, menus) and view_submission (modals).
// block_actions are acked immediately and processed in ctx.waitUntil. view_submission runs the
// state change inline so TransitionErrors and validation problems can be shown inside the modal.

import { dispatch } from "../effects";
import { applyAction, bumpAsk, confirmDiscarded } from "../domain/service";
import { getAsk, getPrefs, getRequest, updateRequestIfPending, upsertPrefs } from "../domain/repo";
import { onProposalNo, onProposalPick, onProposalYes, onUndoClick, type ClickTarget } from "../intent/interact";
import { availableActions } from "../domain/transitions";
import { TransitionError, type AskAction, type Effect, type Env, type RequestRow } from "../types";
import { helpModal } from "./help";
import { slackCall } from "./api";
import {
  ACTION_LABEL, BUMP_ACTION_ID, NEEDS_MODAL, PROPOSAL_ACTIONS, REQ_ACTIONS, SETTINGS_CALLBACK_ID, SETTINGS_OPEN_ACTION_ID, UNDO_ACTION_ID, HELP_OPEN_ACTION_ID,
  parseAskActionId, parseModalCallbackId, type AskActionKind, type ModalMeta,
} from "./actions";
import { openModalLazily, openSettings } from "./commands";
import { OAUTH_DISCONNECT_ACTION_ID } from "./dmaccess";
import { disconnect } from "../oauth";
import { parseSettingsSubmission } from "./settings";
import { ASK_MENU_ACTION_ID } from "./blocks";
import {
  EDIT_CALLBACK_ID, FIRST_BLOCK, buildAskModal, buildEditModal, parseAskSubmission, parseEditSubmission,
  type EditMeta, type ViewValues,
} from "./modals";

interface ActionItem {
  action_id: string;
  value?: string;
  selected_option?: { value: string };
}
interface PayloadBase {
  user: { id: string };
  trigger_id?: string;
}
export interface BlockActionsPayload extends PayloadBase {
  type: "block_actions";
  actions: ActionItem[];
  channel?: { id: string };
  container?: { channel_id?: string; message_ts?: string };
  message?: { ts?: string };
  view?: { type?: string };
}
export interface ViewSubmissionPayload extends PayloadBase {
  type: "view_submission";
  view: { callback_id: string; private_metadata: string; state: { values: ViewValues } };
}
/** Message shortcut ("⋯ → Put on someone's plate"). */
export interface MessageActionPayload extends PayloadBase {
  type: "message_action";
  callback_id: string;
  channel: { id: string; name?: string };
  message: { ts: string; thread_ts?: string; text?: string; user?: string };
}
export type InteractionPayload = BlockActionsPayload | ViewSubmissionPayload | MessageActionPayload;

export const CAPTURE_SHORTCUT_ID = "plates_capture";

const ok = () => new Response(null, { status: 200 });
const errorsResponse = (errors: Record<string, string>) =>
  new Response(JSON.stringify({ response_action: "errors", errors }), { headers: { "content-type": "application/json" } });

export async function handleInteraction(env: Env, ctx: ExecutionContext, payload: InteractionPayload): Promise<Response> {
  if (payload.type === "view_submission") return onViewSubmission(env, ctx, payload);
  if (payload.type === "message_action") {
    if (payload.callback_id === CAPTURE_SHORTCUT_ID) ctx.waitUntil(onCaptureShortcut(env, payload));
    return ok();
  }
  ctx.waitUntil(
    onBlockAction(env, payload).catch(async (err) => {
      if (err instanceof TransitionError) return tellUser(env, payload, err.userMessage);
      console.error("block_action failed", err);
      return tellUser(env, payload, "Something went wrong. Please try again.");
    }),
  );
  return ok();
}

/** Same pipeline as an @plates tag, with the shortcut's message as the tag message. */
async function onCaptureShortcut(env: Env, p: MessageActionPayload): Promise<void> {
  try {
    await env.EXTRACT_QUEUE.send({
      kind: "extract",
      channelId: p.channel.id,
      threadTs: p.message.thread_ts ?? null,
      messageTs: p.message.ts,
      taggerId: p.user.id,
      text: p.message.text ?? "",
      origin: "shortcut",
      channelName: p.channel.name,
      sourceUserId: p.message.user,
    });
  } catch (err) {
    console.error("capture shortcut enqueue failed", err);
  }
}

// ---------- helpers ----------

export function viaOf(p: BlockActionsPayload): ModalMeta["via"] {
  if (p.view?.type === "home") return "home";
  const channel = p.channel?.id ?? p.container?.channel_id;
  return channel?.startsWith("D") ? "dm" : "button";
}

/** Private feedback: ephemeral in the channel when there is one, otherwise a DM. */
async function tellUser(env: Env, p: BlockActionsPayload, text: string): Promise<void> {
  const channel = p.channel?.id ?? p.container?.channel_id;
  try {
    if (channel && p.view?.type !== "home") await slackCall(env, "chat.postEphemeral", { channel, user: p.user.id, text });
    else await slackCall(env, "chat.postMessage", { channel: p.user.id, text });
  } catch (err) {
    console.error("tellUser failed", err);
  }
}

async function userTz(env: Env, userId: string): Promise<string> {
  try {
    const r = await slackCall<{ user?: { tz?: string } }>(env, "users.info", { user: userId });
    return r.user?.tz ?? "UTC";
  } catch (err) {
    console.error("users.info failed", err);
    return "UTC";
  }
}

const TZ_KINDS: ReadonlySet<AskActionKind> = new Set<AskActionKind>(["accept_later", "set_deadline", "snooze"]);

function simpleAction(kind: AskActionKind): AskAction | null {
  return kind === "accept_now" || kind === "close" ? { kind } : null;
}

const involved = (req: RequestRow, userId: string) =>
  userId === req.tagged_by_id || userId === req.requester_id || userId === req.owner_id;

// ---------- block_actions ----------

async function onBlockAction(env: Env, p: BlockActionsPayload): Promise<void> {
  const action = p.actions[0];
  if (!action) return;

  if (action.action_id === REQ_ACTIONS.confirm && action.value) return confirmRequestAction(env, p, action.value);
  if (action.action_id === REQ_ACTIONS.edit && action.value) return openEdit(env, p, action.value);
  if (action.action_id === UNDO_ACTION_ID && action.value) return withClick(p, (c) => onUndoClick(env, c, action.value!));
  if (action.action_id === PROPOSAL_ACTIONS.yes && action.value) return withClick(p, (c) => onProposalYes(env, c, action.value!));
  if (action.action_id === PROPOSAL_ACTIONS.no && action.value) return withClick(p, (c) => onProposalNo(env, c, action.value!));
  if (action.action_id === PROPOSAL_ACTIONS.pick && action.selected_option) {
    const value = action.selected_option.value;
    return withClick(p, (c) => onProposalPick(env, c, value));
  }
  if (action.action_id === BUMP_ACTION_ID && action.value) return bump(env, p, action.value);
  if (action.action_id === OAUTH_DISCONNECT_ACTION_ID) {
    await disconnect(env, p.user.id);
    await dispatch(env, [{ kind: "refresh_home", userId: p.user.id }]);
    return;
  }
  if (action.action_id === SETTINGS_OPEN_ACTION_ID) return openSettings(env, p.trigger_id ?? "", p.user.id);
  if (action.action_id === HELP_OPEN_ACTION_ID) {
    if (p.trigger_id) await slackCall(env, "views.open", { trigger_id: p.trigger_id, view: helpModal() });
    return;
  }
  if (action.action_id === ASK_MENU_ACTION_ID) {
    const [actionId, askId] = (action.selected_option?.value ?? "").split("|");
    if (actionId === BUMP_ACTION_ID && askId) return bump(env, p, askId);
    const kind = actionId ? parseAskActionId(actionId) : null;
    if (kind && askId) return askAction(env, p, kind, askId);
    return;
  }
  const kind = parseAskActionId(action.action_id);
  if (kind && action.value) return askAction(env, p, kind, action.value);
}

/** Message-bound clicks need the channel and ts of the message the button sits on. */
async function withClick(p: BlockActionsPayload, fn: (c: ClickTarget) => Promise<void>): Promise<void> {
  const channelId = p.channel?.id ?? p.container?.channel_id;
  const messageTs = p.container?.message_ts ?? p.message?.ts;
  if (!channelId || !messageTs) return;
  await fn({ userId: p.user.id, channelId, messageTs });
}

async function bump(env: Env, p: BlockActionsPayload, askId: string): Promise<void> {
  await dispatch(env, await bumpAsk(env, askId, p.user.id, viaOf(p)));
}

async function confirmRequestAction(env: Env, p: BlockActionsPayload, requestId: string): Promise<void> {
  await dispatch(env, await confirmDiscarded(env, requestId, p.user.id, viaOf(p)));
}

async function askAction(env: Env, p: BlockActionsPayload, kind: AskActionKind, askId: string): Promise<void> {
  const via = viaOf(p);
  if (!NEEDS_MODAL.has(kind)) {
    const action = simpleAction(kind);
    if (!action) return;
    await dispatch(env, await applyAction(env, askId, action, p.user.id, via));
    return;
  }
  if (!p.trigger_id) return;
  const meta: ModalMeta = { askId, via };
  const build = async () => {
    const ask = await getAsk(env.DB, askId);
    if (!ask) throw new TransitionError(`ask ${askId} not found`, "That ask no longer exists.");
    if (!availableActions(ask, p.user.id).includes(kind)) {
      throw new TransitionError(`${kind} unavailable`, "That isn't possible for this ask right now.");
    }
    const tz = kind === "set_deadline" ? await userTz(env, p.user.id) : "UTC";
    return buildAskModal(kind, ask, meta, tz);
  };
  // Only set_deadline does a slow lookup (users.info); open it first and fill in after.
  if (kind === "set_deadline") return openModalLazily(env, p.trigger_id, ACTION_LABEL[kind], build);
  await slackCall(env, "views.open", { trigger_id: p.trigger_id, view: await build() });
}

async function openEdit(env: Env, p: BlockActionsPayload, requestId: string): Promise<void> {
  const req = await getRequest(env.DB, requestId);
  if (!req) throw new TransitionError("request missing", "That request no longer exists.");
  if (req.status === "confirmed") throw new TransitionError("already confirmed", "This request is already confirmed.");
  if (!involved(req, p.user.id)) throw new TransitionError("not involved", "Only the people involved can edit this.");
  if (p.trigger_id) await slackCall(env, "views.open", { trigger_id: p.trigger_id, view: buildEditModal(req) });
}

// ---------- view_submission ----------

async function onViewSubmission(env: Env, ctx: ExecutionContext, p: ViewSubmissionPayload): Promise<Response> {
  const id = p.view.callback_id;
  try {
    if (id === EDIT_CALLBACK_ID) return await submitEdit(env, ctx, p);
    if (id === SETTINGS_CALLBACK_ID) return await submitSettings(env, ctx, p);
    const kind = parseModalCallbackId(id);
    return kind ? await submitAskModal(env, ctx, p, kind) : ok();
  } catch (err) {
    const field =
      id === EDIT_CALLBACK_ID ? "requester" : id === SETTINGS_CALLBACK_ID ? "tz" : FIRST_BLOCK[parseModalCallbackId(id) ?? "accept_now"];
    if (err instanceof TransitionError) return errorsResponse({ [field]: err.userMessage });
    console.error("view_submission failed", err);
    return errorsResponse({ [field]: "Something went wrong. Please try again." });
  }
}

async function submitAskModal(env: Env, ctx: ExecutionContext, p: ViewSubmissionPayload, kind: AskActionKind): Promise<Response> {
  const meta = JSON.parse(p.view.private_metadata) as ModalMeta;
  const tz = TZ_KINDS.has(kind) ? await userTz(env, p.user.id) : "UTC";
  const parsed = parseAskSubmission(kind, p.view.state.values, { now: Date.now(), tz });
  if (!parsed.ok) return errorsResponse(parsed.errors);
  const effects = await applyAction(env, meta.askId, parsed.value, p.user.id, meta.via);
  ctx.waitUntil(dispatch(env, effects));
  return ok();
}

async function submitEdit(env: Env, ctx: ExecutionContext, p: ViewSubmissionPayload): Promise<Response> {
  const { requestId } = JSON.parse(p.view.private_metadata) as EditMeta;
  const req = await getRequest(env.DB, requestId);
  if (!req) throw new TransitionError("request missing", "That request no longer exists.");
  if (req.status === "confirmed") throw new TransitionError("already confirmed", "This request is already confirmed.");
  if (!involved(req, p.user.id)) throw new TransitionError("not involved", "Only the people involved can edit this.");

  const parsed = parseEditSubmission(p.view.state.values, req);
  if (!parsed.ok) return errorsResponse(parsed.errors);
  const saved = await updateRequestIfPending(env.DB, req.id, { ...parsed.value, attribution_confidence: 1, clarify_question: null });
  if (!saved) throw new TransitionError("lost race to confirm", "That request was already confirmed, so I couldn't change it.");

  const people = [req.requester_id, req.owner_id, parsed.value.requester_id, parsed.value.owner_id, req.tagged_by_id];
  const effects: Effect[] = [
    { kind: "render_request", requestId: req.id },
    ...[...new Set(people.filter((u): u is string => !!u))].flatMap((userId): Effect[] => [
      { kind: "refresh_home", userId },
      { kind: "reschedule", userId },
    ]),
  ];
  ctx.waitUntil(dispatch(env, effects));
  return ok();
}

async function submitSettings(env: Env, ctx: ExecutionContext, p: ViewSubmissionPayload): Promise<Response> {
  const prev = await getPrefs(env.DB, p.user.id);
  const parsed = parseSettingsSubmission(p.view.state.values, prev);
  if (!parsed.ok) return errorsResponse(parsed.errors);
  await upsertPrefs(env.DB, parsed.value);
  const effects: Effect[] = [
    { kind: "reschedule", userId: p.user.id },
    { kind: "refresh_home", userId: p.user.id },
  ];
  ctx.waitUntil(dispatch(env, effects));
  return ok();
}
