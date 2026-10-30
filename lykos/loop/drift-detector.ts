// T18 — drift detector (`docs/10-phase2-tasks.md`, `02-plan.md` §4 D2.1,
// `07-ui-and-hud.md` §3.1 alert H-1).
//
// A silently broken prefix means paying the write premium on every call
// forever, and nothing else will announce it. This module is the
// announcement. It does not rebuild the head (T18.3): an automatic fix
// hides the bug that caused the drift.
//
// T18.1 lives here as a log line that *names the field*. T18.2 is H-1 in
// `tui/derive.ts`, firing against the same cache hit ratio the HUD already
// displays, using PHASE2_CACHE_HIT_THRESHOLD.

import type { HeadContract, ObserveResult } from "../session/head-contract.js";
import { stderrWrite } from "../tui/io-mode.js";

/** Phase 2 exit criterion (`02-plan.md` §4): cache hit ratio above ~80% on multi-turn sessions. */
export const PHASE2_CACHE_HIT_THRESHOLD = 0.8;

/** A session with at least this many calls is multi-turn for H-1. */
export const MULTI_TURN_MIN_CALLS = 2;

export const HEAD_DRIFT_LOG_PREFIX = "lykos head-drift: changed field(s):";

export type WriteLine = (line: string) => void;

/**
 * Fields to put on the log line. Never the bare phrase "prefix changed" —
 * a message that does not name a field costs a debugging session.
 * `systemPrompt` is the remainder when the hash moved and no boot-block
 * field or volatile kind could be attributed.
 */
export function namedDriftFields(result: ObserveResult): string[] {
  return result.driftedFields.length > 0 ? [...result.driftedFields] : ["systemPrompt"];
}

export function formatHeadDriftLog(result: ObserveResult): string {
  const fields = namedDriftFields(result);
  const from = result.fingerprint.slice(0, 12);
  return `${HEAD_DRIFT_LOG_PREFIX} ${fields.join(", ")}  (now ${from}…) — not rebuilding the head (T18.3)\n`;
}

/**
 * T18.1: on fingerprint mismatch, write one loud stderr line naming the
 * field. T18.3: does not call rebase(), does not mutate the contract, does
 * not throw. A wrong number is worse than a loud failure; a silent rebuild
 * is worse than both.
 *
 * Default writer is stderr — stdout belongs to the MCP transport.
 */
export function announceHeadDrift(
  result: ObserveResult,
  write: WriteLine = (line) => {
    stderrWrite(line);
  },
): boolean {
  if (!result.changed) return false;
  write(formatHeadDriftLog(result));
  return true;
}

/**
 * Observe this call, announce if the head moved, return the result.
 * The contract is left as-is (T17.3 / T18.3): whatever the head actually
 * is becomes the new comparison baseline, never a repaired copy of boot.
 */
export function observeAndAnnounce(
  contract: HeadContract,
  systemPrompt: string,
  toolNames: readonly string[],
  write?: WriteLine,
): ObserveResult {
  const result = contract.observe(systemPrompt, toolNames);
  announceHeadDrift(result, write);
  return result;
}

/** True when H-1 should fire. Same arithmetic the HUD already shows as hitRatio. */
export function cacheHitRatioBelowPhase2Floor(hitRatio: number | null, calls: number): boolean {
  return hitRatio !== null && calls >= MULTI_TURN_MIN_CALLS && hitRatio < PHASE2_CACHE_HIT_THRESHOLD;
}
