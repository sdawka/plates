// The System One questions for a thread reply, built from the state machine: the action options are
// "none" plus one "<ref>:<action>" per allowed pair, so the model can only pick what could be applied.

import { decide, pMax, type Answers, type ChoiceQuestion, type NoulQuestion, type Question } from "../decide";
import { localDateInfo, upcomingDates } from "../extract/dates";
import { thresholdsFor } from "../thresholds";
import { SIZE_LABEL, type Env } from "../types";
import { type Candidate, type IntentDecision, type IntentKind, type Shared } from "./validate";

const MAX_REPLY = 2000;
const DEADLINE_DAYS = 21;

/** What each action means, for the option descriptions. */
const ACTION_MEANING: Record<IntentKind, string> = {
  accept_now: "the owner starts on it now",
  accept_later: "the owner commits to it for later",
  done: "the owner says it is finished or hands over the result",
  ack: "the owner acknowledges it and says what happens next",
  reject: "the owner declines it",
  send_back: "the owner needs information before they can do it and asks for it",
  set_deadline: "the owner moves the deadline",
  redirect: "the speaker hands it to another person, who is @-mentioned",
  close: "the requester accepts the result and is satisfied",
  put_back: "the requester sends it back to the owner with an answer, more detail or pushback",
  withdraw: "the requester drops the ask entirely",
};

const NEEDS_DEADLINE: readonly IntentKind[] = ["accept_later", "set_deadline"];

export interface IntentQuestionInput extends Shared {
  speaker: string;
  text: string;
  tz: string;
  now: number;
  candidates: Candidate[];
}

const deliverers = (i: IntentQuestionInput) =>
  i.links.length > 0 || i.files.length > 0 ? i.candidates.filter((c) => c.role === "owner" && c.allowed.includes("done")) : [];

export function buildIntentQuestions(i: IntentQuestionInput): { state: unknown; questions: Record<string, Question> } {
  const { date } = localDateInfo(i.now, i.tz);
  const withActions = i.candidates.filter((c) => c.allowed.length > 0);

  const criteria: ChoiceQuestion["criteria"] = { none: "Ordinary chat, a question to someone else, status chatter or a joke: no action." };
  for (const c of withActions) for (const kind of c.allowed) criteria[`${c.ref}:${kind}`] = `On ${c.ref} (${c.ask.title}): ${ACTION_MEANING[kind]}.`;

  const questions: Record<string, Question> = {
    action: {
      type: "choice",
      instructions:
        "Which action, if any, does the reply perform on one of the open asks? Choose none unless the reply clearly states the action; vague acknowledgements such as 'ok' or 'thanks' from an owner are not done.",
      criteria,
    },
  };
  if (withActions.length > 1) {
    questions.ambiguous = {
      type: "noul",
      instructions: "The reply could apply to more than one open ask and does not make clear which.",
    } satisfies NoulQuestion;
  }
  if (withActions.some((c) => c.allowed.some((k) => NEEDS_DEADLINE.includes(k)))) {
    const days = upcomingDates(i.now, i.tz, DEADLINE_DAYS);
    questions.deadline = {
      type: "choice",
      instructions: `The date the reply says the work will be done by or the deadline moves to, resolved against today (${date}). Choose none if the reply names no date.`,
      criteria: { none: "No date is named.", ...Object.fromEntries(days.map((d) => [d.date, d.label])) },
    };
  }
  for (const c of deliverers(i)) {
    questions[`delivers_${c.ref}`] = {
      type: "noul",
      instructions: `The reply shares a file or link that delivers ${c.ask.title}.`,
    };
  }

  const state = {
    today: date,
    tz: i.tz,
    speaker: i.speaker,
    untrusted_chat_reply: i.text.slice(0, MAX_REPLY),
    links: i.links,
    files: i.files.map((f) => f.name ?? "(unnamed)"),
    open_asks: i.candidates.map((c) => ({
      ref: c.ref,
      title: c.ask.title,
      state: c.ask.state,
      speaker_role: c.role,
      type: c.ask.type,
      size: SIZE_LABEL[c.ask.size],
      deadline: c.ask.deadline_at ? new Date(c.ask.deadline_at).toISOString().slice(0, 10) : null,
    })),
  };
  return { state, questions };
}

/** One System One call for the reply, reduced to the numbers validateDecision gates on. */
export async function decideIntent(env: Env, i: IntentQuestionInput): Promise<IntentDecision> {
  const { state, questions } = buildIntentQuestions(i);
  const answers: Answers<Record<string, Question>> = await decide(env, { state, questions });
  return reduceIntentAnswers(answers, i, thresholdsFor(env.DECIDE_MODEL).DEADLINE_P);
}

/** The raw answers reduced to an IntentDecision; the deadline is kept only at or above `deadlineP`. */
export function reduceIntentAnswers(answers: Answers<Record<string, Question>>, i: IntentQuestionInput, deadlineP: number): IntentDecision {
  const action = answers.action;
  if (action?.type !== "choice") throw new Error("systemone: no action answer");

  const deadline = answers.deadline;
  const picked = deadline?.type === "choice" && deadline.choice !== "none" && pMax(deadline) >= deadlineP ? deadline.choice : null;
  const noul = (id: string) => {
    const a = answers[id];
    return a?.type === "noul" ? a.noul : 0;
  };
  return {
    choice: action.choice,
    p: pMax(action),
    ambiguous: noul("ambiguous"),
    deadline: picked,
    delivers: Object.fromEntries(deliverers(i).map((c) => [c.ref, noul(`delivers_${c.ref}`)])),
  };
}
