// The System One questions the extraction path asks (besides the thread-reply intent ones in src/intent).
// Kept as pure builders so the eval runner (scripts/eval.ts) asks exactly what production asks.

import type { ChoiceQuestion, NoulQuestion } from "../decide";

/** Cheap filter before the extraction call: does the DM ask someone to do, deliver, decide or acknowledge something? */
export function buildIsAskQuestions(text: string): { state: unknown; questions: { is_ask: NoulQuestion } } {
  return {
    state: { untrusted_chat_message: text.slice(0, 2000) },
    questions: { is_ask: { type: "noul", instructions: "The message asks someone to do, deliver, decide or acknowledge something." } },
  };
}

export interface ReactionQuestionInput {
  emoji: string;
  reactedBy: string;
  requester: string | null;
  owner: string | null;
  askTitles: string[];
}

/** Does an unrecognized emoji on a confirmation mean yes or no? */
export function buildReactionQuestions(i: ReactionQuestionInput): { state: unknown; questions: { meaning: ChoiceQuestion } } {
  return {
    state: {
      emoji: i.emoji,
      reacted_by: i.reactedBy,
      confirmation: { requester: i.requester, owner: i.owner, asks: i.askTitles },
    },
    questions: {
      meaning: {
        type: "choice",
        instructions: "The person reacted to a confirmation ('is this who asked whom for what?') with this emoji. What do they mean?",
        criteria: {
          yes: "Approval: the summary is right.",
          no: "Disapproval: the summary is wrong or something is off.",
          unclear: "The emoji says nothing about whether the summary is right.",
        },
      },
    },
  };
}
