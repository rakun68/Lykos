// T86 — tell the model how much room it has left.
// (`docs/25-phase15-sharpening-tasks.md` T86.)
//
// `session/head-view.ts` has computed head tokens, context tokens and schema
// tokens since T28 — for the HUMAN. `lykos prompt --show` prints them and
// the model is never told any of it. So it cannot decide to write its
// findings down before a compaction, stop opening large files, or wrap up:
// it has no idea it is near the edge.
//
// WHY THIS CANNOT BE A SKILL. Prose can tell a model to be careful with
// context. Only the harness can tell it *"you are at 78%, and compaction
// triggers at 80%."* The number is live session state, and there is no way
// to put live state into loaded prose.
//
// TWO RULES THIS OBEYS.
//
// 1. It lands in the TAIL, never the head. A changing number in the head
//    would break the prefix on every turn — that is T18's drift detector
//    firing by design, and it would cost far more in lost cache than the
//    notice could ever save. T17 is not suspended.
// 2. It says what happens next, not just a number. "Compaction will trigger
//    in roughly two more tool results at this rate" is actionable;
//    "context: 78%" is trivia the model has no policy for.
//
// It fires on BANDS, once each, not every turn. A notice on every result
// would be a per-turn tax for a fact that changes slowly, and a model that
// sees the same warning five times learns to ignore it.

import { NULL_EVENT_SINK, type LykosEventSink } from "../extensions/api.js";

/** Fractions of the window at which the model is told once. */
export const DEFAULT_BUDGET_BANDS = [0.7, 0.85, 0.95] as const;

export interface ContextBudgetState {
  /** Bands already announced, so each is said exactly once per session. */
  announced: Set<number>;
  notices: number;
}

export function newContextBudgetState(): ContextBudgetState {
  return { announced: new Set(), notices: 0 };
}

export interface ContextBudgetInput {
  /** Tokens currently in the context — the last call's input + cache_read. */
  contextTokens: number;
  /** The model's context window. 0 or undefined means unknown: say nothing. */
  contextWindow: number | undefined;
  /** Fraction of the window at which compaction fires (T19's default is 0.8). */
  compactionThreshold: number;
}

/**
 * Decide whether to say something, and what.
 *
 * Returns undefined far more often than not — the common case is silence,
 * and that is the point.
 */
export function budgetNotice(
  state: ContextBudgetState,
  input: ContextBudgetInput,
  bands: readonly number[] = DEFAULT_BUDGET_BANDS,
  /**
   * P10.9 (ticket 21, D2): where `budget_threshold` fires from.
   *
   * This function already decides which band was crossed and already computes
   * the percentage and the compaction point for the sentence it returns. The
   * caller sees only that sentence, and only when it is allowed to show one —
   * so firing at the call site would lose both the band and every crossing
   * that some other notice outranked.
   */
  events: LykosEventSink = NULL_EVENT_SINK,
): string | undefined {
  const { contextTokens, contextWindow, compactionThreshold } = input;
  // An unknown window is not a small window. Guessing one would produce a
  // confidently wrong percentage, which is worse than no percentage: the
  // model would act on it.
  if (!contextWindow || contextWindow <= 0) return undefined;
  if (contextTokens <= 0) return undefined;

  const used = contextTokens / contextWindow;
  // Highest band crossed, so a jump from 60% to 96% announces 95% rather
  // than dribbling out 70% and 85% on the next two calls.
  let crossed: number | undefined;
  for (const band of bands) {
    if (used >= band && !state.announced.has(band)) crossed = band;
  }
  if (crossed === undefined) return undefined;
  // Every band at or below the one being announced is now spent.
  for (const band of bands) {
    if (band <= crossed) state.announced.add(band);
  }
  state.notices += 1;

  const pct = Math.round(used * 100);
  const remaining = Math.max(0, contextWindow - contextTokens);
  const compactAt = Math.floor(contextWindow * compactionThreshold);
  const toCompaction = compactAt - contextTokens;

  // Fired on the CROSSING, which is what an extension asked to react to a
  // budget band wants — not on whether the model was shown a sentence about
  // it. Every number below is one this function just computed.
  events.emit("budget_threshold", {
    band: crossed,
    contextTokens,
    contextWindow,
    usedFraction: used,
    compactAt,
  });

  const consequence =
    toCompaction <= 0
      ? "Compaction will run on the next call, and older tool results will be summarised away."
      : `Compaction triggers at ${compactAt.toLocaleString("en-US")} tokens — about ${toCompaction.toLocaleString("en-US")} from here.`;

  return (
    `[lykos-context] ${contextTokens.toLocaleString("en-US")} of ${contextWindow.toLocaleString("en-US")} tokens used (${pct}%), ` +
    `${remaining.toLocaleString("en-US")} left. ${consequence}\n` +
    `If there is anything you have worked out that is not yet written to a file, write it down now rather than after.`
  );
}

/** `LYKOS_CONTEXT_NOTICE=0` turns it off. On by default: it is information the model was missing. */
export function contextNoticeEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LYKOS_CONTEXT_NOTICE !== "0";
}
