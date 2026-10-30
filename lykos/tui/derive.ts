// derive(): Snapshot -> ViewModel. Every ratio, gauge, and alert lives here
// so no renderer computes anything (docs/07-ui-and-hud.md §1.2) — this is
// what keeps the status line and `lykos cost` from disagreeing about
// arithmetic.
//
// Deliberately narrower than the full §3 field inventory. Alerts that need
// data no writer populates yet are left out rather than wired against a
// field that is always null — H-3 (cost inversions — T6.1/T6.2 now set
// real avoided_usd, including genuinely negative ones (v_cost_inversions
// returns real rows), so the DATA gap T4 originally cited is closed; what
// blocks a live alert now is T9's own honest-subset limit instead: the only
// capture path is one terminal snapshot ingested after a run already
// finished, so live.json is never refreshed mid-run and an H-3 alert here
// could only ever fire at the exact moment the run ends — no earlier than
// `lykos cost`'s own post-run summary line already shows the same number.
// Revisit once a live per-turn capture path exists (Phase 2 territory, not
// T6's), H-4 (unpriced model — priceCall() throws before a row is ever
// written, so this can't be observed from the ledger), H-7 (ledger write
// failure — the writer's own concern, not something a reader can detect),
// H-9 (rate-limit countdown — needs a live countdown timer, not just the
// alert condition).
// H-2 is the T4.2 subset: tool-schema wire-JSON hash, not the full system
// prompt (Phase 2 D2.1). H-1 is T18: Phase 2 cache-hit-ratio floor on a
// multi-turn session, using the same hitRatio the HUD already displays.
// AGENTS.md rule 4: no number, no mechanism.

import { cacheHitRatioBelowPhase2Floor, PHASE2_CACHE_HIT_THRESHOLD } from "../loop/drift-detector.js";
import type { Alert, Gauge, Snapshot, TokenCounters, ViewModel } from "./types.js";
import { deriveCacheGauge } from "./cache-gauge.js";

const DELEGATE_SILENT_MS = 90_000;

function costAlert(runUsd: number, perRunUsd: number, todayUsd: number | null, perDayUsd: number): Alert | null {
  const runPct = perRunUsd > 0 ? runUsd / perRunUsd : 0;
  const dayPct = todayUsd !== null && perDayUsd > 0 ? todayUsd / perDayUsd : 0;
  const pct = Math.max(runPct, dayPct);
  const horizon = runPct >= dayPct ? "run" : "day";
  if (pct >= 1) {
    return {
      id: "H-5",
      severity: "danger",
      message: `budget cap reached (${horizon})`,
      remedy: "on_exceed mode applies now",
    };
  }
  if (pct >= 0.8) {
    return {
      id: "H-5",
      severity: "warn",
      message: `budget ${Math.round(pct * 100)}% of cap (${horizon})`,
      remedy: "watch spend — approaching the cap",
    };
  }
  return null;
}

function contextAlert(parent: Gauge | null, delegate: Gauge | null): Alert | null {
  const worst = [parent, delegate]
    .filter((g): g is Gauge => g !== null && g.pct !== null)
    .sort((a, b) => (b.pct as number) - (a.pct as number))[0];
  if (!worst || worst.pct === null || worst.pct < 0.85) return null;
  return { id: "H-6", severity: "warn", message: `context ${Math.round(worst.pct * 100)}%`, remedy: "compact or delegate" };
}

function outcomeAlert(outcome: string | null, source: string | null): Alert | null {
  if (outcome === null || source !== "agent_claim") return null;
  return {
    id: "H-8",
    severity: "warn",
    message: "success claimed by agent_claim only",
    remedy: "unverified — no verification command ran",
  };
}

function silentDelegateAlert(now: Date, heartbeatUtc: string | null, endedUtc: string | null): Alert | null {
  if (heartbeatUtc === null || endedUtc !== null) return null;
  const ageMs = now.getTime() - new Date(heartbeatUtc).getTime();
  if (ageMs < DELEGATE_SILENT_MS) return null;
  return {
    id: "H-10",
    severity: "info",
    message: `delegate silent ${Math.round(ageMs / 1000)}s`,
    remedy: "inactivity watchdog — no update from the delegate recently",
  };
}

function prefixAlert(changed: boolean | undefined): Alert | null {
  if (changed !== true) return null;
  return {
    id: "H-2",
    severity: "warn",
    message: "prefix hash changed",
    remedy: "tool-schema set or order shifted — see `lykos cost` / v_prefix_breaks",
  };
}

/**
 * T18.2: H-1, the existing cache-hit-ratio alert (`07-ui-and-hud.md` §3.1),
 * wired to the Phase 2 exit threshold on a multi-turn session. Same
 * `hitRatio` the HUD already displays — a second, later-call-only number
 * would disagree with the line (docs/07 §1.2). Original "drops > 20 points
 * in 3 turns" trigger still needs per-turn history T4 never captured.
 */
function cacheHitRatioAlert(hitRatio: number | null, calls: number): Alert | null {
  if (hitRatio === null || !cacheHitRatioBelowPhase2Floor(hitRatio, calls)) return null;
  const pct = Math.round(hitRatio * 100);
  const floor = Math.round(PHASE2_CACHE_HIT_THRESHOLD * 100);
  return {
    id: "H-1",
    severity: "warn",
    message: `cache hit ratio ${pct}% is below the Phase 2 floor (${floor}%)`,
    remedy: "prefix contract broken — `lykos cost` / v_head_drift",
  };
}

function gaugeFrom(usedTokens: number | null, totalTokens: number | undefined | null): Gauge | null {
  if (usedTokens === null) return null;
  const total = totalTokens ?? null;
  return { usedTokens, totalTokens: total, pct: total && total > 0 ? usedTokens / total : null };
}

export function derive(s: Snapshot): ViewModel {
  const run = s.run;
  const totals = run?.totals ?? { costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 };

  const counters: TokenCounters = {
    fresh: totals.input,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    output: totals.output,
    reasoning: totals.reasoning,
  };
  const hitDenominator = counters.fresh + counters.cacheRead;
  const hitRatio = hitDenominator > 0 ? counters.cacheRead / hitDenominator : null;

  const parentGauge = s.parentContext
    ? { usedTokens: s.parentContext.usedTokens, totalTokens: s.parentContext.totalTokens, pct: s.parentContext.usedPercentage }
    : null;
  const delegateUsed = run?.lastCall?.contextAfter ?? run?.lastCall?.contextBefore ?? null;
  // Before the first call there is no `lastCall` to read a used figure
  // off — but a LIVE session still knows its model's context window, and
  // `deriveHud` passes it as `delegateContextTokens`. Showing a gauge at
  // zero-used is what renders as `—/1.0M` (see `line.ts`'s
  // `contextSegment`), which is 2026-09-02 round six, item 4: "At the
  // start of each session, no message sent, ctx still show ? instead of
  // nothing / <max-context>". A ledger-backed surface reaches neither
  // branch — `collect.ts` only sets `delegateContextTokens` when there IS
  // a last call — so `ctx ?` stays the honest answer wherever the window
  // genuinely is not known.
  const delegateGauge = run?.lastCall
    ? gaugeFrom(delegateUsed, s.delegateContextTokens)
    : s.delegateContextTokens !== undefined
      ? gaugeFrom(0, s.delegateContextTokens)
      : null;

  const outcome = run?.outcome
    ? { value: run.outcome, source: run.outcomeSource, verified: run.outcomeSource !== "agent_claim" }
    : null;

  const alerts: Alert[] = [
    cacheHitRatioAlert(hitRatio, totals.calls),
    costAlert(totals.costUsd, s.budget.perRunUsd, s.today?.spentUsd ?? null, s.budget.perDayUsd),
    contextAlert(parentGauge, delegateGauge),
    outcomeAlert(run?.outcome ?? null, run?.outcomeSource ?? null),
    silentDelegateAlert(s.now, run?.heartbeatUtc ?? null, run?.endedUtc ?? null),
    prefixAlert(run?.lastCall?.prefixChanged),
  ].filter((a): a is Alert => a !== null);

  const startedUtc = run?.startedUtc ?? null;
  const elapsedSec =
    startedUtc !== null ? Math.max(0, Math.floor((s.now.getTime() - new Date(startedUtc).getTime()) / 1000)) : null;

  return {
    cost: {
      runUsd: totals.costUsd,
      todayUsd: s.today?.spentUsd ?? null,
      capRunUsd: s.budget.perRunUsd,
      capDayUsd: s.budget.perDayUsd,
      onExceed: s.budget.onExceed,
    },
    tokens: { counters, hitRatio, calls: totals.calls },
    context: { parent: parentGauge, delegate: delegateGauge },
    outcome,
    alerts,
    session: {
      id: run?.sessionId ?? null,
      brief: run?.brief ?? null,
      agent: run?.lastCall?.agent ?? null,
      model: run?.lastCall?.model ?? null,
      phase: run?.lastCall?.phase ?? null,
      startedUtc,
      endedUtc: run?.endedUtc ?? null,
      heartbeatUtc: run?.heartbeatUtc ?? null,
      elapsedSec,
      thinkingLevel: s.thinkingLevel ?? null,
    },
    health: {
      toolSchemaTokens: run?.lastCall?.toolSchemaTokens ?? null,
      toolCount: run?.lastCall?.toolCount ?? null,
      prefixChanged: run?.lastCall?.prefixChanged === true,
    },
    children: s.children ?? [],
    cache: deriveCacheGauge(s.run?.cacheObservations ?? [], s.now, s.run?.currentModel ?? s.run?.lastCall?.model),
  };
}
