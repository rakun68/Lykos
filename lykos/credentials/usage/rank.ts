// Usage ranking and usage-limit reset.
//
// Ranks a provider's credentials by how much of each usage window is left and
// how fast it is draining, with Codex plan requirements and Claude model
// families scoping which windows count.
//
// Lykos never fetches during selection (plan D3), so
// ranking reads whatever report is cached; a window whose stated reset has
// already passed no longer describes the account and is ignored.

import type { UsageReport, UsageWindow } from "./types.js";

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;

export const PRIMARY_WINDOW_HOT_FRACTION = 0.85;
const USAGE_RANKING_METRIC_EPSILON = 1e-9;

export function compareUsageRankingMetric(left: number, right: number): number {
  if (left === right) return 0;
  if (!Number.isFinite(left) || !Number.isFinite(right)) return left < right ? -1 : 1;
  const delta = left - right;
  const tolerance = Math.max(USAGE_RANKING_METRIC_EPSILON, Math.max(Math.abs(left), Math.abs(right)) * 0.000001);
  return Math.abs(delta) <= tolerance ? 0 : delta;
}

// ---------------------------------------------------------------------------
// Codex plan requirement and priority
// ---------------------------------------------------------------------------

export type PlanRequirement = "none" | "paid" | "pro";
type PlanClass = "free" | "paid" | "pro" | "unknown";

const PRO_PLAN_TOKENS = new Set(["pro"]);
const PAID_PLAN_TOKENS = new Set([
  "plus",
  "business",
  "team",
  "enterprise",
  "edu",
  "education",
  "teacher",
  "teachers",
  "health",
  "gov",
  "government",
]);
const FREE_PLAN_TOKENS = new Set(["free", "go"]);
const PAID_MODELS = new Set(["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-sol-pro", "gpt-5.6-luna", "gpt-5.6-luna-pro"]);

/** `-spark` needs Pro, the GPT-5.6 paid list needs a paid plan. */
export function planRequirementFor(provider: string, modelId: string | undefined): PlanRequirement {
  if (provider !== "openai-codex" || typeof modelId !== "string") return "none";
  const lower = modelId.toLowerCase();
  if (lower.includes("-spark")) return "pro";
  const bare = lower.slice(lower.lastIndexOf("/") + 1);
  if (PAID_MODELS.has(lower) || (lower.includes("/") && PAID_MODELS.has(bare))) return "paid";
  return "none";
}

function classifyPlan(plan: string | undefined): PlanClass {
  if (plan === undefined) return "unknown";
  let normalized = plan.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized.startsWith("chatgpt_")) normalized = normalized.slice("chatgpt_".length);
  if (!normalized) return "unknown";
  if (normalized === "prolite" || normalized === "pro_lite") return "paid";
  const tokens = normalized.split("_");
  if (tokens.some((t) => PRO_PLAN_TOKENS.has(t))) return "pro";
  if (tokens.some((t) => PAID_PLAN_TOKENS.has(t))) return "paid";
  if (tokens.some((t) => FREE_PLAN_TOKENS.has(t))) return "free";
  return "unknown";
}

/** 0 eligible, 1 unknown, 2 ineligible. */
function planPriority(plan: string | undefined, requirement: PlanRequirement): number {
  if (requirement === "none") return 0;
  const planClass = classifyPlan(plan);
  if (planClass === "unknown") return 1;
  const eligible = requirement === "paid" ? planClass !== "free" : planClass === "pro";
  return eligible ? 0 : 2;
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

interface RankingStrategy {
  /** The windows a request for `modelId` is gated on. */
  scopeWindows(report: UsageReport, modelId: string | undefined, nowMs: number): UsageWindow[];
  findWindows(report: UsageReport, modelId: string | undefined, nowMs: number): { primary?: UsageWindow; secondary?: UsageWindow };
  hasPriorityBoost?(primary: UsageWindow | undefined, primaryUncapped: boolean, modelId: string | undefined): boolean;
  windowDefaults: { primaryMs: number; secondaryMs: number };
}

type ClaudeKind = "opus" | "sonnet" | "fable" | "mythos";

/** Reads the Claude model family out of the id. */
function claudeKind(modelId: string | undefined): ClaudeKind | undefined {
  if (modelId === undefined) return undefined;
  const lower = modelId.toLowerCase();
  for (const kind of ["opus", "sonnet", "fable", "mythos"] as const) if (lower.includes(kind)) return kind;
  return undefined;
}

/** Shared windows plus the requested family's tier. */
function claudeScopeForModel(report: UsageReport, modelId: string | undefined): UsageWindow[] {
  const kind = claudeKind(modelId);
  return report.windows.filter((w) => w.tier === undefined || (kind !== undefined && w.tier === kind));
}

function claudeDrainRate(window: UsageWindow, nowMs: number): number {
  const usedFraction = Math.min(Math.max(window.usedFraction, 0), 1);
  const durationMs = window.durationMs ?? WEEK_MS;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return usedFraction;
  const resetAt = window.resetAtMs;
  if (resetAt === undefined || !Number.isFinite(resetAt)) return usedFraction;
  const remaining = Math.min(Math.max(resetAt - nowMs, 0), durationMs);
  const elapsed = durationMs - remaining;
  if (elapsed <= 0) return usedFraction;
  return usedFraction / (elapsed / HOUR_MS);
}

const claudeStrategy: RankingStrategy = {
  // A Fable/Mythos tier row gates only when confirmed exhausted.
  scopeWindows(report, modelId, nowMs) {
    const kind = claudeKind(modelId);
    const confirmOnly = kind === "fable" || kind === "mythos";
    return report.windows.filter((w) => {
      if (w.tier === undefined) return true;
      if (kind === undefined || w.tier !== kind) return false;
      return !confirmOnly || (w.exhausted && w.resetAtMs !== undefined && w.resetAtMs > nowMs);
    });
  },
  findWindows(report, modelId, nowMs) {
    const primary = report.windows.find((w) => w.id === "5h" && w.tier === undefined);
    let secondary: UsageWindow | undefined;
    for (const w of claudeScopeForModel(report, modelId)) {
      if (w.role !== "secondary") continue;
      if (secondary === undefined) {
        secondary = w;
        continue;
      }
      // Keep the more pressured of the two.
      const a = claudeDrainRate(secondary, nowMs);
      const b = claudeDrainRate(w, nowMs);
      if (b !== a) secondary = b > a ? w : secondary;
      else if (w.usedFraction > secondary.usedFraction) secondary = w;
    }
    return { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) };
  },
  windowDefaults: { primaryMs: 5 * HOUR_MS, secondaryMs: WEEK_MS },
};

function isSparkRequest(modelId: string | undefined): boolean {
  return modelId !== undefined && modelId.toLowerCase().includes("spark");
}

/** Chat windows for chat, the Spark meter for Spark. */
function codexScope(report: UsageReport, modelId: string | undefined): UsageWindow[] {
  const spark = isSparkRequest(modelId);
  return report.windows.filter((w) => (w.tier === undefined ? !spark : w.tier === "spark" && spark));
}

const codexStrategy: RankingStrategy = {
  scopeWindows: (report, modelId) => codexScope(report, modelId),
  findWindows(report, modelId) {
    const scoped = codexScope(report, modelId);
    const primary = scoped.find((w) => w.role === "primary");
    const secondary = scoped.find((w) => w.role === "secondary");
    return { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) };
  },
  hasPriorityBoost(primary, primaryUncapped, modelId) {
    if (!primary) return primaryUncapped && !isSparkRequest(modelId);
    const baseId = primary.id.slice(primary.id.lastIndexOf(":") + 1);
    const isFiveHour =
      baseId === "5h" ||
      (primary.durationMs !== undefined && Math.abs(primary.durationMs - 5 * HOUR_MS) <= 60_000);
    return isFiveHour && primary.usedFraction === 0;
  },
  windowDefaults: { primaryMs: HOUR_MS, secondaryMs: WEEK_MS },
};

const STRATEGIES = new Map<string, RankingStrategy>([
  ["anthropic", claudeStrategy],
  ["openai-codex", codexStrategy],
]);

/** Whether the provider has a ranking strategy. */
export function hasRankingStrategy(provider: string): boolean {
  return STRATEGIES.has(provider);
}

/** The report without windows whose stated reset has passed (see the header). */
function liveReport(report: UsageReport, nowMs: number): UsageReport {
  return { ...report, windows: report.windows.filter((w) => w.resetAtMs === undefined || w.resetAtMs > nowMs) };
}

/**
 * D2: when the report shows the request's windows exhausted, the time every
 * exhausted window has reset (the latest future reset). Undefined when nothing the
 * request uses is exhausted or no exhausted window states a future reset.
 */
export function usageLimitResetAt(
  provider: string,
  report: UsageReport,
  nowMs: number,
  modelId?: string,
): number | undefined {
  const strategy = STRATEGIES.get(provider);
  const scoped = strategy ? strategy.scopeWindows(report, modelId, nowMs) : report.windows;
  let latest: number | undefined;
  for (const w of scoped) {
    if (!w.exhausted || w.resetAtMs === undefined || w.resetAtMs <= nowMs) continue;
    if (latest === undefined || w.resetAtMs > latest) latest = w.resetAtMs;
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

export interface RankCandidate {
  id: number;
  /** The cached report, if any. */
  report: UsageReport | undefined;
}

interface Ranked {
  id: number;
  blocked: boolean;
  blockedUntil: number | undefined;
  hasPriorityBoost: boolean;
  usageMeasured: boolean;
  planPriority: number;
  secondaryUsed: number;
  secondaryRequiredDrain: number;
  primaryUsed: number;
  primaryRequiredDrain: number;
  orderPos: number;
}

/** An unknown fraction counts as half used. */
function normalizeFraction(window: UsageWindow | undefined): number {
  const f = window?.usedFraction;
  if (typeof f !== "number" || !Number.isFinite(f)) return 0.5;
  return Math.min(Math.max(f, 0), 1);
}

/**
 * Headroom / hours left before the
 * window resets. Higher = more quota lost if not used = ranked first.
 */
function requiredDrain(window: UsageWindow | undefined, nowMs: number, fallbackDurationMs: number): number {
  const headroom = 1 - normalizeFraction(window);
  if (headroom <= 0) return 0;
  const durationMs = window?.durationMs ?? fallbackDurationMs;
  let remainingMs = window?.resetAtMs === undefined ? durationMs : window.resetAtMs - nowMs;
  if (Number.isFinite(durationMs) && durationMs > 0) remainingMs = Math.min(remainingMs, durationMs);
  return headroom / (Math.max(remainingMs, 60_000) / HOUR_MS);
}

function compareRanked(left: Ranked, right: Ranked, requirement: PlanRequirement): number {
  if (left.blocked !== right.blocked) return left.blocked ? 1 : -1;
  if (left.blocked && right.blocked) {
    const l = left.blockedUntil ?? Number.POSITIVE_INFINITY;
    const r = right.blockedUntil ?? Number.POSITIVE_INFINITY;
    if (l !== r) return l - r;
    return left.orderPos - right.orderPos;
  }
  if (requirement !== "none" && left.planPriority !== right.planPriority) return left.planPriority - right.planPriority;
  if (left.hasPriorityBoost !== right.hasPriorityBoost) return left.hasPriorityBoost ? -1 : 1;
  const leftHot = left.primaryUsed >= PRIMARY_WINDOW_HOT_FRACTION;
  const rightHot = right.primaryUsed >= PRIMARY_WINDOW_HOT_FRACTION;
  if (leftHot !== rightHot) return leftHot ? 1 : -1;
  if (left.usageMeasured !== right.usageMeasured) return left.usageMeasured ? -1 : 1;
  let metric = compareUsageRankingMetric(right.secondaryRequiredDrain, left.secondaryRequiredDrain);
  if (metric !== 0) return metric;
  metric = compareUsageRankingMetric(left.secondaryUsed, right.secondaryUsed);
  if (metric !== 0) return metric;
  metric = compareUsageRankingMetric(right.primaryRequiredDrain, left.primaryRequiredDrain);
  if (metric !== 0) return metric;
  metric = compareUsageRankingMetric(left.primaryUsed, right.primaryUsed);
  if (metric !== 0) return metric;
  return left.orderPos - right.orderPos;
}

/**
 * Order `candidates` (already in tie-break order) by cached usage. Returns the ids best first. A provider without a
 * strategy keeps the given order. Pure: reads no db and makes no request.
 */
export function rankByUsage(
  provider: string,
  candidates: readonly RankCandidate[],
  opts: { nowMs: number; modelId?: string },
): number[] {
  const strategy = STRATEGIES.get(provider);
  if (strategy === undefined) return candidates.map((c) => c.id);
  const { nowMs, modelId } = opts;
  const requirement = planRequirementFor(provider, modelId);
  const ranked: Ranked[] = candidates.map((candidate, orderPos) => {
    const report = candidate.report === undefined ? undefined : liveReport(candidate.report, nowMs);
    const blockedUntil = report === undefined ? undefined : usageLimitResetAt(provider, report, nowMs, modelId);
    const blocked =
      report !== undefined && strategy.scopeWindows(report, modelId, nowMs).some((w) => w.exhausted);
    const windows = report === undefined ? {} : strategy.findWindows(report, modelId, nowMs);
    const { primary, secondary } = windows as { primary?: UsageWindow; secondary?: UsageWindow };
    const primaryUncapped = primary === undefined && secondary !== undefined;
    return {
      id: candidate.id,
      blocked,
      blockedUntil,
      usageMeasured: primary !== undefined || secondary !== undefined,
      hasPriorityBoost: strategy.hasPriorityBoost?.(primary, primaryUncapped, modelId) ?? false,
      planPriority: planPriority(report?.plan, requirement),
      secondaryUsed: normalizeFraction(secondary),
      secondaryRequiredDrain: requiredDrain(secondary, nowMs, strategy.windowDefaults.secondaryMs),
      primaryUsed: normalizeFraction(primary),
      primaryRequiredDrain: requiredDrain(primary, nowMs, strategy.windowDefaults.primaryMs),
      orderPos,
    };
  });
  ranked.sort((a, b) => compareRanked(a, b, requirement));
  return ranked.map((r) => r.id);
}
