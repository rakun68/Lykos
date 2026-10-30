// T109 — continuation across a context boundary.
//
// This module deliberately contains no session, ledger, or model calls. The
// decision is made after the current session has been ingested and its gate
// has run, so the only question left here is whether the persisted state
// warrants one more session.

import { renderTaskList, type TaskListState } from "../tools/task-list.js";

export type ContinuationStopReason =
  | "disabled"
  | "below-threshold"
  | "gate-passed"
  | "no-open-items"
  | "cap-reached"
  | "stagnated";

export type ContinuationDecision =
  | { action: "continue"; reason: "unfinished-and-unverified" }
  | { action: "stop"; reason: ContinuationStopReason };

/** The small handoff record passed from a finished session to its successor. */
export interface ContinuationPlan {
  predecessorSessionId: string;
  index: number;
  prompt: string;
  originalPrompt: string;
  taskId?: string;
  projectId?: string;
}

export interface ContinuationDecisionInput {
  enabled: boolean;
  thresholdReached: boolean;
  openItems: boolean;
  /** True only when T100 recorded outcome=success for this session. */
  gateGreen: boolean;
  /** Number of predecessor boundaries already crossed by this task. */
  continuationsUsed: number;
  /** Hard cap. A value of 1 permits one successor session. */
  cap: number;
  /** A successful edit/write call changed the working tree. */
  fileChanged: boolean;
  /** The persisted task list changed during this session. */
  taskListMoved: boolean;
}

/**
 * The gate, not the model, decides whether a context boundary may be crossed.
 *
 * The order is intentional. A disabled mechanism and a session that never
 * reached its threshold must not be reported as stagnated; a green gate wins
 * over open task-list state; and the cap is checked before the second-line
 * stagnation brake.
 */
export function decideContinuation(input: ContinuationDecisionInput): ContinuationDecision {
  if (!input.enabled) return { action: "stop", reason: "disabled" };
  if (!input.thresholdReached) return { action: "stop", reason: "below-threshold" };
  if (input.gateGreen) return { action: "stop", reason: "gate-passed" };
  if (!input.openItems) return { action: "stop", reason: "no-open-items" };

  const cap = Math.max(0, Math.floor(input.cap));
  const used = Math.max(0, Math.floor(input.continuationsUsed));
  if (used >= cap) return { action: "stop", reason: "cap-reached" };
  if (!input.fileChanged && !input.taskListMoved) return { action: "stop", reason: "stagnated" };

  return { action: "continue", reason: "unfinished-and-unverified" };
}

export interface ContinuationContextFile {
  path: string;
  bytes: number;
}

export interface ContinuationDiskState {
  predecessorSessionId: string;
  continuationIndex: number;
  taskListPath: string;
  taskList: TaskListState;
  checkpointRef: string;
  checkpointCommit?: string;
  verificationCommand?: string;
  contextFiles: readonly ContinuationContextFile[];
  originalPrompt?: string;
}

/**
 * Builds the first instruction for the successor session from facts that
 * were read from disk at boot. It intentionally contains no model summary:
 * the task list, checkpoint, gate command, and context-file inventory are
 * each named as independent facts, and the original request is preserved
 * verbatim when the caller has it.
 */
export function buildContinuationPrompt(input: ContinuationDiskState): string {
  const checkpoint =
    input.checkpointCommit === undefined
      ? `${input.checkpointRef} (no checkpoint recorded)`
      : `${input.checkpointRef} -> ${input.checkpointCommit}`;
  const contextFiles =
    input.contextFiles.length === 0
      ? "(none)"
      : input.contextFiles.map((file) => `${file.path} (${file.bytes} bytes)`).join(", ");
  const verification = input.verificationCommand ?? "(none discovered)";
  const original = input.originalPrompt === undefined ? "" : `\n\nOriginal task instruction:\n${input.originalPrompt}`;

  return [
    `Continue the unfinished task after context boundary ${input.continuationIndex}.`,
    `This is a fresh session linked to predecessor ${input.predecessorSessionId}.`,
    "",
    "Do not rely on a conversation summary. Rebuild the state from these disk facts:",
    `- task list: ${input.taskListPath}`,
    renderTaskList(input.taskList),
    `- checkpoint: ${checkpoint}`,
    `- verification command: ${verification}`,
    `- context files frozen for this session: ${contextFiles}`,
    "",
    "The task list and files are authoritative. Continue the open items, write down any new state, and do not declare the task complete unless the verification gate can prove it.",
  ].join("\n") + original;
}

// ---------------------------------------------------------------------------
// T150 — continuation as the `lykos-continuation` default extension.
//
// The threshold watch that used to live inside the harness extension is now a
// Pi extension shipped in Lykos's package (`extensions/defaults/
// lykos-continuation.ts`). Everything below is the boundary between that
// extension and the session that loads it, on the pattern `lykos-repo-map`
// set: the policy travels in by one env var, and the crossing travels out as
// one custom session entry. The decision above and the successor below stay
// with the session owner — an extension cannot start a session.
// ---------------------------------------------------------------------------

/**
 * D2.1's share of the context window at which a session stops for a
 * successor, and the point the context-budget notice names. It is
 * `compaction.threshold`'s shipped value; it moved here from the deleted
 * snip-then-prune module (backlog X1), which held it for this one use.
 */
export const DEFAULT_COMPACTION_THRESHOLD = 0.8;

/** The resolved continuation policy, as JSON, for the extension to read at load. */
export const CONTINUATION_POLICY_ENV = "LYKOS_CONTINUATION_POLICY";

/** `customType` of the entry the extension appends when the threshold is crossed. */
export const CONTINUATION_ENTRY_TYPE = "lykos-continuation";

export interface ContinuationPolicy {
  /** False when the context strategy is not `continue`, the cap is used, or this is a child. */
  enabled: boolean;
  /** Share of the context window, `compaction.threshold`. */
  threshold: number;
}

export interface ContinuationCrossing {
  tokens: number;
  contextWindow: number;
}

export function encodeContinuationPolicyEnv(policy: ContinuationPolicy): string {
  return JSON.stringify(policy);
}

/** Null on anything malformed — the extension then does nothing, which is Pi in charge. */
export function decodeContinuationPolicyEnv(raw: string | undefined): ContinuationPolicy | null {
  if (raw === undefined || raw === "") return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (typeof p.enabled !== "boolean" || typeof p.threshold !== "number" || !Number.isFinite(p.threshold)) return null;
    return { enabled: p.enabled, threshold: p.threshold };
  } catch {
    return null;
  }
}

/** The crossing this session recorded, read back from its entries; undefined when it never crossed. */
export function continuationFromEntries(
  entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
): ContinuationCrossing | undefined {
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CONTINUATION_ENTRY_TYPE) continue;
    const d = entry.data as Partial<ContinuationCrossing> | undefined;
    if (d === undefined || typeof d.tokens !== "number" || typeof d.contextWindow !== "number") continue;
    return { tokens: d.tokens, contextWindow: d.contextWindow };
  }
  return undefined;
}
