// Probability thresholds the System One answers are gated on, keyed by decision model. Probabilities are
// not comparable across models (each is calibrated differently), so a new DECIDE_MODEL gets its own entry,
// tuned from an eval run (`npm run eval -- --model <id>`, results in eval/results/).

export interface Thresholds {
  /** Probability of the chosen action at or above which it is applied without asking (given no ambiguity). */
  AUTO_P: number;
  /** Below this the reply is treated as chatter; between this and AUTO_P it becomes a "Did you mean". */
  PROPOSE_P: number;
  /** At or above this the reply may apply to another ask, so the speaker picks. */
  AMBIGUOUS_P: number;
  /** Probability that a shared file or link delivers an ask, for the "looks done?" suggestion. */
  DELIVERS_P: number;
  /** The deadline answer is used only when this sure of the date. */
  DEADLINE_P: number;
  /** Below this a DM to the bot is not an ask, so nothing is extracted. */
  IS_ASK_MIN: number;
  /** Below this probability an emoji is not taken as a yes or a no. */
  REACTION_MIN: number;
}

/** Hand-set for TypeSafe Jev; every other model starts from these until an eval run says otherwise. */
export const JEV_THRESHOLDS: Thresholds = {
  AUTO_P: 0.85,
  PROPOSE_P: 0.5,
  AMBIGUOUS_P: 0.2,
  DELIVERS_P: 0.6,
  DEADLINE_P: 0.5,
  IS_ASK_MIN: 0.3,
  REACTION_MIN: 0.8,
};

/**
 * Overrides per model id or family (the id without its trailing "-<version>"). List only what differs
 * from JEV_THRESHOLDS, with the eval results file the values came from.
 */
const BY_MODEL: Record<string, Partial<Thresholds>> = {
  "typesafe/jev": {}, // eval/results/typesafe__jev-1.14.systemone.json
};

/** "typesafe/jev-1.14" -> "typesafe/jev"; ids without a version are returned unchanged. */
export function modelFamily(model: string): string {
  return model.replace(/-[0-9][0-9A-Za-z.]*$/, "");
}

/** Thresholds for a model: exact id, then its family, then the Jev defaults; overrides merge onto the defaults. */
export function thresholdsFor(model: string | undefined): Thresholds {
  const over = model ? BY_MODEL[model] ?? BY_MODEL[modelFamily(model)] ?? {} : {};
  return { ...JEV_THRESHOLDS, ...over };
}
