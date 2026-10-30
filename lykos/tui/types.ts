// Shared Snapshot/ViewModel types (docs/07-ui-and-hud.md §1.2). Renderers
// never compute — every ratio, gauge, or alert here is already derived, so
// the status line and `lykos cost` cannot disagree about arithmetic.

import type { CacheGaugeEntry, CacheObservation } from "./cache-gauge.js";

export interface RunTotals {
  costUsd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  calls: number;
}

export interface RunLastCall {
  tsUtc: string;
  agent: string;
  phase: string | null;
  provider: string;
  model: string;
  contextBefore: number | null;
  contextAfter: number | null;
  toolSchemaTokens: number | null;
  toolCount: number | null;
  prefixChanged: boolean;
}

export interface RunSnapshot {
  sessionId: string;
  brief: string | null;
  startedUtc: string;
  heartbeatUtc: string;
  endedUtc: string | null;
  outcome: string | null;
  outcomeSource: string | null;
  totals: RunTotals;
  lastCall: RunLastCall | null;
  cacheObservations?: CacheObservation[];
  currentModel?: string;
}

export interface TodaySnapshot {
  date: string;
  spentUsd: number;
  sessions: number;
  successes: number;
}

export interface BudgetSnapshot {
  perRunUsd: number;
  perDayUsd: number;
  onExceed: string;
}

/** From Claude Code's status-line stdin JSON (docs/07-ui-and-hud.md §1.3). */
export interface ParentContextSnapshot {
  usedTokens: number;
  totalTokens: number;
  usedPercentage: number | null;
}

export interface RateLimitSnapshot {
  usedPercentage: number;
  resetsAt: string | null;
}

/** Raw facts collected before any ratio or gauge is computed. */
export interface Snapshot {
  now: Date;
  run: RunSnapshot | null;
  today: TodaySnapshot | null;
  budget: BudgetSnapshot;
  parentContext: ParentContextSnapshot | null;
  rateLimits: { fiveHour: RateLimitSnapshot | null; sevenDay: RateLimitSnapshot | null } | null;
  /** The model whose context window prices delegate context — needed for R-D3's gauge. */
  delegateContextTokens: number | undefined;
  /** Live reasoning effort, when the caller has a running session to read it off. */
  thinkingLevel?: string;
  /** T39: children of the focused session, for the delegates panel. */
  children?: ChildSessionView[];
}

export interface Gauge {
  usedTokens: number;
  totalTokens: number | null; // null when the model's context window is unknown (R-D3)
  pct: number | null;
}

export interface TokenCounters {
  fresh: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

export type AlertSeverity = "info" | "warn" | "danger";

export interface Alert {
  id: string;
  severity: AlertSeverity;
  message: string;
  remedy: string;
}

export interface OutcomeView {
  value: string;
  source: string | null;
  /** True only when source is 'verification_command' or 'human' — never 'agent_claim'. */
  verified: boolean;
}

/** Session identity / "what is it doing" — T38 Health/Now/Session panels. */
export interface SessionView {
  id: string | null;
  brief: string | null;
  agent: string | null;
  model: string | null;
  phase: string | null;
  startedUtc: string | null;
  endedUtc: string | null;
  heartbeatUtc: string | null;
  /** Seconds since startedUtc (null when no session). */
  elapsedSec: number | null;
  /**
   * Pi's current reasoning-effort setting for this session — one of
   * `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`, or null where
   * the surface has no live session to ask (the ledger-backed `lykos
   * hud`, `lykos watch`). Read from `AgentSession.thinkingLevel`, never
   * inferred: 2026-09-02 UI feedback item 6 asked for it beside the model
   * name, and a guessed effort level beside a real model name would be
   * the most quietly misleading thing on the footer.
   */
  thinkingLevel: string | null;
}

/**
 * Machinery health that S3's Health panel finally shows (docs/07-ui-and-hud.md
 * §9: schema-token display deferred to Phase 3 / `lykos watch`).
 */
export interface HealthView {
  toolSchemaTokens: number | null;
  toolCount: number | null;
  prefixChanged: boolean;
}

/** T39: one child under the watched session — UI says resumable vs not. */
export interface ChildSessionView {
  id: string;
  brief: string | null;
  agent: string | null;
  costUsd: number;
  resumable: boolean;
  notResumableReason: string | null;
  executionShape: string | null;
}

export interface ViewModel {
  cost: {
    runUsd: number;
    todayUsd: number | null;
    capRunUsd: number;
    capDayUsd: number;
    onExceed: string;
  };
  tokens: {
    counters: TokenCounters;
    hitRatio: number | null;
    calls: number;
  };
  context: {
    parent: Gauge | null;
    delegate: Gauge | null;
  };
  outcome: OutcomeView | null;
  alerts: Alert[];
  session: SessionView;
  health: HealthView;
  /** T39: hop-1 children of the focused session (empty when none). */
  children: ChildSessionView[];
  /** T121: provider-backed cache readings, kept per model. */
  cache?: CacheGaugeEntry[];
}
