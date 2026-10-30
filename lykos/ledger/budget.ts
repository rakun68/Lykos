// T7 — the spend kill switch (docs/04-phase0-tasks.md T7, docs/03-telemetry.md
// §8 point 7, problems/11 mitigation 4). "Enforced before the API call, not
// after the invoice": this module is called from `checkStandaloneBudget`
// (session/session.ts) once per run and before each new interactive turn,
// and from the `spawn` tool (tools/spawn.ts) before a child session starts.
//
// Only `run`, `spawn`, `spawn_batch`, and `follow_up` are gated (GATED_TOOLS below): the calls that
// start new spend. Any other tool name passes untouched, so a caller can never be blocked from
// stopping or redirecting work that is already running. Today only `run` (checkStandaloneBudget)
// and `spawn` (runChildSession) reach the guard.
//
// Honest limits of what "before the API call" can mean here: the guard is a pure decision made
// once, before a run or a child session starts (and before each new interactive turn, for `run`).
// It sees no live per-turn usage stream, so it cannot preempt spend mid-call. The per-run cap is
// enforced in three real but partial ways:
//   1. A preflight estimate of the outgoing prompt's own input cost (chars/4, input tokens only).
//      This catches a pathologically large briefing before it is ever sent — it cannot see output
//      tokens or multi-turn cost building up inside a single call. `spawn` also passes
//      `taskSpentUsd` (the task tree's recorded spend), so the estimate is added to what the tree
//      has already cost; `run` passes none.
//   2. `spawn` separately refuses when the task tree's recorded cost already exceeds the cap
//      (`taskExceedsRunCap`, T39.4), before it calls the guard.
//   3. A `trippedSessions` set naming sessionIds already seen over the cap refuses any request
//      carrying one of them as `args.sessionId`. Neither live caller passes a sessionId or a
//      non-empty set, so this path is exercised only by tests today.
// (Historical, before 2026-10-11: the deleted delegate server also fed this guard `follow_up`
// calls against a session already over the cap, and its only usage signal was one terminal
// snapshot read after a run had finished. #38 removed that path.)
// The verdict names which cap applied (`capKind`) so a caller never has to guess which
// guarantee actually applied.

import { parseProviderModel } from "./ingest.js";
import type { Ledger, StartSessionInput } from "./ledger.js";
import { readTodayRollup } from "./live.js";
import { priceCall } from "./prices.js";
import { estimateTokensChars4 } from "./tool-schema.js";
import type { BudgetConfig } from "../config/types.js";

/** The tool calls that start new provider spend. */
// Callers today pass `run` (session.ts) and `spawn` (tools/spawn.ts). `spawn_batch` and `follow_up`
// came from the deleted delegate server and no caller passes them now; they stay because the
// concurrency cap and the session run-cap verdicts below are still tested and configured
// (`max_concurrent_delegates`), and removing them is a budget-behaviour decision, not part of T185.
const GATED_TOOLS = new Set(["run", "spawn", "spawn_batch", "follow_up"]);

export function isGatedTool(toolName: string): boolean {
  return GATED_TOOLS.has(toolName);
}

export type BudgetCapKind = "day" | "run" | "concurrency";

export type BudgetVerdict =
  | { tripped: false }
  | {
      tripped: true;
      capKind: BudgetCapKind;
      reason: string;
      detail: Record<string, number | string>;
    };

export interface BudgetGuardInput {
  toolName: string;
  /** Parsed `params.arguments` of the `tools/call` request. */
  args: Record<string, unknown> | undefined;
  ledgerPath: string;
  budget: Required<BudgetConfig>;
  /** Fallback model (the configured default model) when the call names none of its own. */
  defaultModel: string;
  now?: Date;
  /** sessionIds this process has already seen exceed the per-run cap. */
  trippedSessions: ReadonlySet<string>;
  /**
   * T39.4: spend already recorded across the task tree (parent + children).
   * When set, the per-run preflight compares `taskSpentUsd + estimated prompt`
   * against the cap — a parent within budget that has already spawned
   * expensive children must not get another free pass on a "fresh" node.
   */
  taskSpentUsd?: number;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function extractPromptTexts(toolName: string, args: Record<string, unknown> | undefined): string[] {
  if (!args) return [];
  if (toolName === "spawn_batch") {
    const tasks = Array.isArray(args.tasks) ? (args.tasks as Array<Record<string, unknown>>) : [];
    return tasks
      .map((t) => (typeof t?.prompt === "string" ? t.prompt : ""))
      .filter((s) => s.length > 0);
  }
  return typeof args.prompt === "string" ? [args.prompt] : [];
}

function requestSessionId(args: Record<string, unknown> | undefined): string | undefined {
  const id = args?.sessionId;
  return typeof id === "string" ? id : undefined;
}

/**
 * Estimate the input-only cost of the outgoing prompt text(s). Returns null
 * (never a guessed number) when the target model has no price row — an
 * unpriced model must not silently block, or silently pass, every call
 * naming it; the caller decides what "cannot estimate" means for the gate.
 */
function estimatePromptCostUsd(
  texts: string[],
  provider: string,
  model: string,
  now: Date,
): number | null {
  let total = 0;
  for (const text of texts) {
    const tokens = estimateTokensChars4(text);
    try {
      total += priceCall({
        provider,
        model,
        tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 },
        ts: now,
      }).costUsd;
    } catch {
      return null;
    }
  }
  return total;
}

/**
 * Pure decision function — no I/O beyond the one fast cache read
 * (`readTodayRollup`, a plain JSON file, not SQLite). Safe to call on every
 * gated tool call without meaningfully slowing the request.
 */
export function guardToolCall(input: BudgetGuardInput): BudgetVerdict {
  if (!isGatedTool(input.toolName)) return { tripped: false };
  const now = input.now ?? new Date();

  const rollup = readTodayRollup(input.ledgerPath);
  const spentToday = rollup?.spentUsd ?? 0;
  if (spentToday >= input.budget.per_day_usd) {
    return {
      tripped: true,
      capKind: "day",
      reason: `daily spend cap reached: ${fmtUsd(spentToday)} already spent today >= ${fmtUsd(input.budget.per_day_usd)} cap`,
      detail: { spentTodayUsd: spentToday, capUsd: input.budget.per_day_usd },
    };
  }

  if (input.toolName === "spawn_batch") {
    const tasks = Array.isArray(input.args?.tasks) ? (input.args!.tasks as unknown[]) : [];
    if (tasks.length > input.budget.max_concurrent_delegates) {
      return {
        tripped: true,
        capKind: "concurrency",
        reason:
          `spawn_batch requested ${tasks.length} delegates, over the ` +
          `${input.budget.max_concurrent_delegates} concurrency cap`,
        detail: { requested: tasks.length, capCount: input.budget.max_concurrent_delegates },
      };
    }
  }

  const sessionId = requestSessionId(input.args);
  if (sessionId !== undefined && input.trippedSessions.has(sessionId)) {
    return {
      tripped: true,
      capKind: "run",
      reason: `session ${sessionId} already exceeded the ${fmtUsd(input.budget.per_run_usd)} per-run cap on a previous call`,
      detail: { sessionId, capUsd: input.budget.per_run_usd },
    };
  }

  const promptTexts = extractPromptTexts(input.toolName, input.args);
  if (promptTexts.length > 0) {
    const modelArg = typeof input.args?.model === "string" ? (input.args.model as string) : undefined;
    const { provider, model } = parseProviderModel(modelArg ?? input.defaultModel);
    const estimatedUsd = estimatePromptCostUsd(promptTexts, provider, model, now);
    const treeSpent = input.taskSpentUsd ?? 0;
    if (estimatedUsd !== null && estimatedUsd + treeSpent >= input.budget.per_run_usd) {
      return {
        tripped: true,
        capKind: "run",
        reason:
          treeSpent > 0
            ? `task tree already at ${fmtUsd(treeSpent)} plus this prompt estimated at ${fmtUsd(estimatedUsd)} ` +
              `(chars/4, input tokens only) reaches or exceeds the ${fmtUsd(input.budget.per_run_usd)} per-run cap`
            : `prompt alone is estimated at ${fmtUsd(estimatedUsd)} (chars/4, input tokens only), ` +
              `already at or over the ${fmtUsd(input.budget.per_run_usd)} per-run cap`,
        detail: {
          estimatedUsd,
          ...(treeSpent > 0 ? { taskSpentUsd: treeSpent } : {}),
          capUsd: input.budget.per_run_usd,
        },
      };
    }
  }

  return { tripped: false };
}

/**
 * True once a session's actual recorded cost (from calls already ingested)
 * exceeds the per-run cap. Called after ingest, never before — it is reading
 * real ledger rows, not estimating.
 */
export function sessionExceedsRunCap(ledger: Ledger, sessionId: string, perRunUsd: number): boolean {
  return (ledger.callTotals(sessionId).costUsd ?? 0) > perRunUsd;
}

/**
 * T39.4: the budget applies to the tree, not the node. Walks from `sessionId`
 * up to the root parent (if any), then sums cost across that root and every
 * descendant linked by `parent_session_id`. Prefer task_id when the root has
 * one — that is the unit `08-sessions-and-archive.md` §5 prices.
 */
export function taskExceedsRunCap(ledger: Ledger, sessionId: string, perRunUsd: number): boolean {
  return (ledger.taskCallTotals(sessionId).costUsd ?? 0) > perRunUsd;
}

/**
 * Records a tripped cap as an abandoned session with zero calls — "recorded,
 * never dropped" (CLAUDE.md, docs/04-phase0-tasks.md T7). Runs even though no
 * delegate session ever started: the session row IS the record that a
 * request was refused, and why.
 */
export function recordBudgetTrip(
  ledger: Ledger,
  input: { toolName: string; verdict: Extract<BudgetVerdict, { tripped: true }>; workspace?: string },
): string {
  const startInput: StartSessionInput = {
    brief: `blocked: ${input.toolName} — ${input.verdict.capKind} cap`,
    ...(input.workspace !== undefined ? { workspace: input.workspace } : {}),
  };
  const id = ledger.startSession(startInput);
  ledger.endSession({
    id,
    outcome: "abandoned",
    notes: `spend kill switch tripped (${input.verdict.capKind} cap): ${input.verdict.reason}`,
  });
  return id;
}
