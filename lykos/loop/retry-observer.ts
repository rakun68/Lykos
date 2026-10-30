// T83 — observe the transient-provider-failure retry that Pi already does.
// (`docs/25-phase15-sharpening-tasks.md` T83.)
//
// THE TASK'S PREMISE WAS WRONG AND IS CORRECTED HERE. The Phase 15 plan
// said "there is no retry anywhere in the codebase — no `backoff`, and the
// string `429` does not appear in `lykos/` at all." Both halves are true of
// `lykos/` and both are misleading about the behaviour, because the retry
// lives one layer down and is **on by default**:
//
//   SettingsManager.getRetrySettings() -> { enabled: true, maxRetries: 3,
//                                           baseDelayMs: 2000 }
//
// verified empirically against @earendil-works/pi-coding-agent, not inferred
// from the bundle. `retryAssistantCall()` does exponential backoff
// (baseDelayMs * 2^(attempt-1)), sleeps abortably, and classifies with two
// regex batteries — RETRYABLE_PROVIDER_ERROR_PATTERN covers 429, 5xx,
// "overloaded", "socket hang up", "fetch failed", ECONNRESET-shaped strings
// and more; NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN excludes quota and
// billing exhaustion so a dead key is not retried three times.
//
// So Lykos inherits a better retry than the one T83 proposed to build, and
// AGENTS.md rule 2 (adopt, don't rebuild) and rule 3 (use the tools Pi
// ships) both say to leave it alone. What Lykos does NOT have is any record
// that it happened: `subscribeStandaloneUsage()` ignores `auto_retry_start`
// and `auto_retry_end`, so a session that survived three rate limits is
// indistinguishable in the ledger from one that sailed through, and a
// session that died *after* exhausting retries is indistinguishable from a
// session that died on a real error. That is the actual gap, and this
// module is it.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: change the policy.
// `session.setAutoRetryEnabled()` delegates to
// `SettingsManager.setRetryEnabled()`, which calls `this.save()` and writes
// the user's GLOBAL `~/.pi/agent` settings. Lykos writing another product's
// config file is exactly the boundary violation AGENTS.md rule 6 and
// `problems/13` exist to prevent, so the policy is read and reported, never
// set. Owning the policy from `.lykos/config.yaml` needs a Lykos-owned
// SettingsManager instance and is left for a task that can be measured.

/** Pi's effective defaults when no `retry` block is configured. Verified, not assumed. */
export const PI_DEFAULT_RETRY = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 2000,
} as const;

export interface RetryPolicyView {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  /** Where the numbers came from, so a report can never imply Lykos chose them. */
  source: "pi_settings" | "pi_default";
}

/**
 * A settings-manager-shaped object, loose enough to accept Pi's real one and
 * a fake in tests. Read-only by construction: no setter is named here, so
 * this module cannot write the user's global Pi settings even by mistake.
 */
export interface RetrySettingsReader {
  getRetrySettings?: () => { enabled?: unknown; maxRetries?: unknown; baseDelayMs?: unknown };
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

/**
 * Read the retry policy actually in force. Never throws: a settings manager
 * that cannot answer yields Pi's documented defaults, marked as such, rather
 * than a guess presented as a reading.
 */
export function readRetryPolicy(settings: RetrySettingsReader | undefined): RetryPolicyView {
  const raw = (() => {
    try {
      return settings?.getRetrySettings?.();
    } catch {
      return undefined;
    }
  })();
  if (!raw || typeof raw !== "object") {
    return { ...PI_DEFAULT_RETRY, source: "pi_default" };
  }
  return {
    enabled: raw.enabled !== false,
    maxRetries: positiveInt(raw.maxRetries, PI_DEFAULT_RETRY.maxRetries),
    baseDelayMs: positiveInt(raw.baseDelayMs, PI_DEFAULT_RETRY.baseDelayMs),
    source: "pi_settings",
  };
}

/** One line for `lykos doctor` / `lykos prompt --show`. Names the owner, because Lykos is not it. */
export function describeRetryPolicy(view: RetryPolicyView): string {
  const state = view.enabled ? "on" : "OFF";
  const origin = view.source === "pi_settings" ? "pi settings" : "pi built-in default";
  return `transient-failure retry ${state}: ${view.maxRetries} attempts, ${view.baseDelayMs}ms base backoff (owned by ${origin}, not by .lykos/config.yaml)`;
}

/** What a session observed. Every field is a count of something that actually happened. */
export interface RetryObservation {
  /** `auto_retry_start` events: a transient failure that Pi decided to retry. */
  retryStarts: number;
  /** Distinct retry episodes that ended with `success: true`. */
  retriesRecovered: number;
  /** Distinct retry episodes that ended with `success: false` — the session lost the turn. */
  retriesExhausted: number;
  /** Highest attempt number reached in any episode. 0 when nothing retried. */
  maxAttempt: number;
  /** The last error text Pi retried on, redacted downstream like every other stored string. */
  lastError: string | undefined;
}

export function newRetryObservation(): RetryObservation {
  return { retryStarts: 0, retriesRecovered: 0, retriesExhausted: 0, maxAttempt: 0, lastError: undefined };
}

/** The two event shapes this cares about, structurally typed so tests need no SDK. */
export type RetryEventLike =
  | { type: "auto_retry_start"; attempt?: number; maxAttempts?: number; delayMs?: number; errorMessage?: string }
  | { type: "auto_retry_end"; success?: boolean; attempt?: number; finalError?: string }
  | { type: string };

/**
 * Fold one session event into the observation. Unknown events are ignored,
 * so this can be called from the existing `session.subscribe` switch without
 * a second subscription.
 */
export function observeRetryEvent(obs: RetryObservation, ev: RetryEventLike): void {
  if (ev.type === "auto_retry_start") {
    const e = ev as { attempt?: number; errorMessage?: string };
    obs.retryStarts += 1;
    if (typeof e.attempt === "number" && e.attempt > obs.maxAttempt) obs.maxAttempt = e.attempt;
    if (typeof e.errorMessage === "string" && e.errorMessage.length > 0) obs.lastError = e.errorMessage;
    return;
  }
  if (ev.type === "auto_retry_end") {
    const e = ev as { success?: boolean; attempt?: number; finalError?: string };
    // An episode that never started cannot end. Pi emits `auto_retry_end`
    // only after at least one `auto_retry_start`, but guard anyway rather
    // than record an episode this session did not observe the start of.
    if (obs.retryStarts === 0) return;
    if (e.success === true) obs.retriesRecovered += 1;
    else obs.retriesExhausted += 1;
    if (typeof e.attempt === "number" && e.attempt > obs.maxAttempt) obs.maxAttempt = e.attempt;
    if (typeof e.finalError === "string" && e.finalError.length > 0) obs.lastError = e.finalError;
  }
}

/**
 * True when this session's failure is attributable to a provider that would
 * not come back, rather than to the work. `runStandaloneTask` uses it to say
 * so in the returned message — the ledger keeps `outcome` as-is, because a
 * lost turn is a lost turn and inventing a kinder outcome would be exactly
 * the flattering fiction CLAUDE.md forbids.
 */
export function endedOnExhaustedRetry(obs: RetryObservation, runState: string): boolean {
  return runState === "error" && obs.retriesExhausted > 0;
}
