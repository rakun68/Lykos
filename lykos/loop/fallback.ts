// T89 — a provider that is down should not take the session with it.
// (`docs/25-phase15-sharpening-tasks.md` T89.)
//
// Depends on T83, and is the escalation past it: Pi retries a transient
// failure three times with exponential backoff, and when those are exhausted
// the session ends and its whole context is lost. This module decides
// whether to continue on a different model instead.
//
// WHAT THIS IS NOT: routing. Phase 7 decides which model *should* do a piece
// of work, on cost and capability grounds. This decides only what happens
// when the chosen one is unreachable, and it fires solely after T83's
// retries have already failed.
//
// OFF BY DEFAULT, AND DELIBERATELY. `fallback:` is empty in the shipped
// config. An implicit fallback chain is exactly how a ledger starts lying:
// a session that quietly finished on a different model than the one
// requested makes every per-model number in the archive wrong, and nobody
// would know to look. So it is opt-in, it is recorded per call, and the
// human is told in the session and in `lykos show`.
//
// IT COSTS MONEY BY DESIGN. Switching providers discards the warm prefix
// and pays a full cache write on the new one. That is a capability
// mechanism buying a completed task with real spend, and it must be
// reported as spend — never as an avoided loss, which is the trap
// CLAUDE.md names about `avoided` being a model and never a measurement.

/** A `provider/model` spec, exactly as `config.yaml` and `--model` write it. */
export type ModelSpec = string;

export interface FallbackPolicy {
  /** Ordered alternates. Empty means the feature is off, which is the default. */
  chain: ModelSpec[];
  /** Hard cap on switches in one session, so a bad day cannot walk the whole chain repeatedly. */
  maxSwitches: number;
}

export const DEFAULT_MAX_SWITCHES = 1;

export function resolveFallbackPolicy(input: unknown): FallbackPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { chain: [], maxSwitches: DEFAULT_MAX_SWITCHES };
  }
  const rec = input as { chain?: unknown; models?: unknown; max_switches?: unknown; maxSwitches?: unknown };
  const rawChain = Array.isArray(rec.chain) ? rec.chain : Array.isArray(rec.models) ? rec.models : [];
  const chain: ModelSpec[] = [];
  for (const entry of rawChain) {
    // A spec must look like `provider/model`. A malformed entry is dropped
    // loudly at doctor time rather than resolved to "first available" —
    // CLAUDE.md's provider trap: reachable is not the same as priced.
    if (typeof entry === "string" && entry.includes("/") && !chain.includes(entry)) chain.push(entry);
  }
  const rawMax = rec.max_switches ?? rec.maxSwitches;
  const maxSwitches =
    typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax >= 0
      ? Math.floor(rawMax)
      : DEFAULT_MAX_SWITCHES;
  return { chain, maxSwitches };
}

export interface FallbackState {
  switches: number;
  /** Specs already tried this session, so the chain never revisits one. */
  used: Set<ModelSpec>;
  /** Every switch made, for the ledger note and the human. */
  history: Array<{ from: ModelSpec; to: ModelSpec; reason: string }>;
}

export function newFallbackState(current: ModelSpec): FallbackState {
  return { switches: 0, used: new Set([current]), history: [] };
}

export type FallbackDecision =
  | { action: "none"; why: string }
  | { action: "switch"; to: ModelSpec; note: string };

export interface FallbackInput {
  policy: FallbackPolicy;
  state: FallbackState;
  current: ModelSpec;
  /** T83: true only when the session died AFTER Pi's own retries ran out. */
  exhaustedRetry: boolean;
  /** The provider error, quoted to the human so the switch is never mysterious. */
  error: string | undefined;
}

/**
 * Decide whether to continue on another model.
 *
 * Returns `none` in every case except the narrow one this exists for, and
 * the `why` is kept so the decision can be explained rather than guessed at.
 */
export function decideFallback(input: FallbackInput): FallbackDecision {
  const { policy, state, current, exhaustedRetry, error } = input;
  if (policy.chain.length === 0) return { action: "none", why: "no fallback configured" };
  // The whole point of the gate: an ordinary failure — a bad edit, a failing
  // test, a budget trip — must never move the session to another model.
  // Only an exhausted transient-failure retry does.
  if (!exhaustedRetry) return { action: "none", why: "not a provider failure" };
  if (state.switches >= policy.maxSwitches) {
    return { action: "none", why: `switch limit reached (${policy.maxSwitches})` };
  }
  const next = policy.chain.find((spec) => !state.used.has(spec));
  if (next === undefined) return { action: "none", why: "every configured fallback already tried" };
  return {
    action: "switch",
    to: next,
    note:
      `lykos: ${current} was unreachable after its retries ran out` +
      `${error ? ` (${error})` : ""}. Continuing this session on ${next}.\n` +
      `The warm prefix is gone, so the next call pays a full cache write on the new provider. ` +
      `This session's cost now spans two price bases and must not be summed across them.`,
  };
}

/** Record the switch. Called only after the model actually changed. */
export function recordSwitch(state: FallbackState, from: ModelSpec, to: ModelSpec, reason: string): void {
  state.switches += 1;
  state.used.add(to);
  state.history.push({ from, to, reason });
}

/** Serialised for the session row: `deepseek/x>anthropic/y`. NULL when nothing switched. */
export function serializeFallbacks(state: FallbackState): string | undefined {
  if (state.history.length === 0) return undefined;
  return state.history.map((h) => `${h.from}>${h.to}`).join(",");
}
