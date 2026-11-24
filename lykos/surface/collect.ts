// collect(): turns raw sources (live.json, today.json, config, and — for S1
// only — Claude Code's stdin JSON) into a Snapshot. No ratios, no gauges, no
// opinions — that is derive()'s job (docs/07-ui-and-hud.md §1.2).

import { readLiveSnapshot, readTodayRollup } from "../ledger/live.js";
import { contextTokens } from "../ledger/context-tokens.js";
import type { ResolvedConfig } from "../config/types.js";
import type { ParentContextSnapshot, RateLimitSnapshot, Snapshot } from "./types.js";

export interface CollectOptions {
  ledgerPath: string;
  sessionId: string | null;
  config: ResolvedConfig;
  /** Claude Code's status-line stdin JSON — only present for S1. */
  statuslineInput?: ClaudeCodeStatuslineInput;
  now?: Date;
  /**
   * T38: when live.json is gone, watch supplies a ledger-built RunSnapshot
   * here so collect still does no SQLite itself.
   */
  runOverride?: import("./types.js").RunSnapshot | null;
  /** T39: children for the delegates panel — watch supplies these. */
  children?: import("./types.js").ChildSessionView[];
}

/** The subset of Claude Code's documented status-line stdin contract this needs. */
export interface ClaudeCodeStatuslineInput {
  context_window?: {
    used_percentage?: number;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    context_window_size?: number;
  };
  cost?: { total_cost_usd?: number };
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: string };
    seven_day?: { used_percentage?: number; resets_at?: string };
  };
}

function deriveParentContext(input: ClaudeCodeStatuslineInput | undefined): ParentContextSnapshot | null {
  const cw = input?.context_window;
  if (!cw?.current_usage) return null;
  // Input-only formula (§2.3): input + cache_creation + cache_read, output excluded,
  // so this matches what Claude Code itself displays.
  const usage = cw.current_usage;
  const usedTokens =
    (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const totalTokens = cw.context_window_size ?? 0;
  return {
    usedTokens,
    totalTokens,
    usedPercentage: cw.used_percentage ?? (totalTokens > 0 ? usedTokens / totalTokens : null),
  };
}

function deriveRateLimits(
  input: ClaudeCodeStatuslineInput | undefined,
): Snapshot["rateLimits"] {
  const rl = input?.rate_limits;
  if (!rl) return null;
  const toSnapshot = (
    r: { used_percentage?: number; resets_at?: string } | undefined,
  ): RateLimitSnapshot | null =>
    r && r.used_percentage !== undefined
      ? { usedPercentage: r.used_percentage, resetsAt: r.resets_at ?? null }
      : null;
  return { fiveHour: toSnapshot(rl.five_hour), sevenDay: toSnapshot(rl.seven_day) };
}

export function collect(opts: CollectOptions): Snapshot {
  const now = opts.now ?? new Date();
  const run =
    opts.runOverride !== undefined
      ? opts.runOverride
      : opts.sessionId
        ? readLiveSnapshot(opts.ledgerPath, opts.sessionId)
        : null;
  const todayCache = readTodayRollup(opts.ledgerPath);

  const delegateContextTokens = run?.lastCall
    ? contextTokens(run.lastCall.provider, run.lastCall.model)
    : undefined;

  return {
    now,
    run,
    today: todayCache
      ? {
          date: todayCache.date,
          spentUsd: todayCache.spentUsd,
          sessions: todayCache.sessions,
          successes: todayCache.successes,
        }
      : null,
    budget: {
      perRunUsd: opts.config.budget.per_run_usd,
      perDayUsd: opts.config.budget.per_day_usd,
      onExceed: opts.config.budget.on_exceed,
    },
    parentContext: deriveParentContext(opts.statuslineInput),
    rateLimits: deriveRateLimits(opts.statuslineInput),
    delegateContextTokens,
    ...(opts.children !== undefined ? { children: opts.children } : {}),
  };
}
