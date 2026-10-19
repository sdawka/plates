// Button handlers for the conversational layer: Undo, and Yes / No / Pick on proposals.
// Errors that the clicker should see privately are thrown as TransitionError; the interaction
// router turns them into ephemeral messages.

import { dispatch } from "../effects";
import { getAsksByRequest, getRequestsInThread } from "../domain/repo";
import { applyActionDetailed, undoEvent } from "../domain/service";
import { availableActions } from "../domain/transitions";
import { slackCall } from "../slack/api";
import type { Rendered } from "../slack/blocks";
import { mention } from "../slack/format";
import { TransitionError, type AskAction, type AskRow, type Env, type ProposalRow } from "../types";
import { appliedMessage, dismissedMessage, expiredMessage, proposalMessage, undoneMessage } from "./messages";
import { getProposal, isExpired, moveProposal, setProposalAsk } from "./proposals";

export interface ClickTarget {
  userId: string;
  channelId: string;
  messageTs: string;
}

const update = (env: Env, t: { channelId: string; messageTs: string }, msg: Rendered) =>
  slackCall(env, "chat.update", { channel: t.channelId, ts: t.messageTs, ...msg });

export async function onUndoClick(env: Env, click: ClickTarget, eventId: string): Promise<void> {
  const effects = await undoEvent(env, eventId, click.userId, "button");
  await update(env, click, undoneMessage());
  await dispatch(env, effects);
}

const gone = () => new TransitionError("proposal missing", "That suggestion is no longer available.");

async function loadForClick(env: Env, click: ClickTarget, proposalId: string): Promise<ProposalRow | null> {
  const p = await getProposal(env.DB, proposalId);
  if (!p) throw gone();
  if (click.userId !== p.actor_id) throw new TransitionError("not actor", `This is for ${mention(p.actor_id)}.`);
  if (p.status !== "pending" && p.status !== "expired") throw new TransitionError("already handled", "That's already been dealt with.");
  if (p.status === "expired" || isExpired(p, Date.now())) {
    if (p.status === "pending") await moveProposal(env.DB, p.id, "pending", "expired");
    await update(env, { channelId: p.channel_id, messageTs: click.messageTs }, expiredMessage());
    return null;
  }
  return p;
}

const target = (p: ProposalRow, click: ClickTarget) => ({ channelId: p.channel_id, messageTs: p.message_ts ?? click.messageTs });

/** Open asks in the thread that the actor may perform this proposal's action on. */
async function eligibleAsks(env: Env, p: ProposalRow, action: AskAction): Promise<AskRow[]> {
  const requests = (await getRequestsInThread(env.DB, p.channel_id, p.thread_ts)).filter((r) => r.status === "confirmed");
  const asks = (await Promise.all(requests.map((r) => getAsksByRequest(env.DB, r.id)))).flat();
  return asks.filter((a) => availableActions(a, p.actor_id).includes(action.kind));
}

export async function onProposalYes(env: Env, click: ClickTarget, proposalId: string): Promise<void> {
  const p = await loadForClick(env, click, proposalId);
  if (!p) return;
  if (!p.ask_id) throw new TransitionError("no ask picked", "Pick which ask you mean first.");
  const action = JSON.parse(p.action_json) as AskAction;
  if (!(await moveProposal(env.DB, p.id, "pending", "applied"))) throw new TransitionError("already handled", "That's already been dealt with.");
  let r;
  try {
    r = await applyActionDetailed(env, p.ask_id, action, p.actor_id, "thread_reply", p.source_ts);
  } catch (err) {
    // Not applied: let them try again (or pick a different ask).
    await moveProposal(env.DB, p.id, "applied", "pending");
    throw err;
  }
  await update(env, target(p, click), appliedMessage(p.actor_id, action, r.after, r.eventId));
  await dispatch(env, r.effects);
}

export async function onProposalNo(env: Env, click: ClickTarget, proposalId: string): Promise<void> {
  const p = await loadForClick(env, click, proposalId);
  if (!p) return;
  if (!(await moveProposal(env.DB, p.id, "pending", "dismissed"))) throw new TransitionError("already handled", "That's already been dealt with.");
  await update(env, target(p, click), dismissedMessage());
}

/** "Pick ask" menu: remember the choice and redraw the question about that ask. */
export async function onProposalPick(env: Env, click: ClickTarget, optionValue: string): Promise<void> {
  const [proposalId, askId] = optionValue.split("|");
  if (!proposalId || !askId) return;
  const p = await loadForClick(env, click, proposalId);
  if (!p) return;
  const action = JSON.parse(p.action_json) as AskAction;
  const options = await eligibleAsks(env, p, action);
  const picked = options.find((a) => a.id === askId);
  if (!picked) throw new TransitionError("ask not eligible", "That isn't possible for that ask.");
  await setProposalAsk(env.DB, p.id, picked.id, picked.request_id);
  await update(
    env,
    target(p, click),
    proposalMessage({
      id: p.id, source: p.source, actor: p.actor_id, action, ask: picked,
      options: options.map((a) => ({ id: a.id, title: a.title })), picker: true,
    }),
  );
}
