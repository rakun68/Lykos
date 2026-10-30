// T80 — the rediscovery annotation (`docs/23-phase10-tasks.md` §2).
//
// **Why this exists.** T66 measures the cross-session *exact-repeat* rate: a
// path read in more than one session, a normalised command run again, a tool
// failing the same way twice. That is a real signal and it is not the thing
// memory is scoped to store. `DECISIONS.md` 2026-08-28 scoped memory to
// *"project gotchas, its own mistakes, approaches tried and failed and why"*
// and explicitly banned structural facts — and a lesson of that kind, when
// it is re-derived, **leaves no repeated tool call at all**. Two different
// commands can reach the same conclusion.
//
// So the instrument and the mechanism are looking at different things, which
// is why `docs/22-memory-and-retrieval-source-review.md` §11.6 withdrew the
// claim that scoped memory has "an addressable market of zero" in favour of
// the defensible one: *the current evidence does not show an addressable
// market, and the instrument cannot see most of the market the scope
// decision permits.*
//
// **Why it is human-authored, and why that is not a compromise.** The
// cheapest honest signal for semantic re-derivation is a person saying "I
// worked that out again". It costs no per-turn tool schema, no model call,
// and no head tokens. At this workload's volume, human labelling is both
// cheaper than a semantic detector and more trustworthy than one.
//
// **An agent may never write one.** This is `outcome_source`'s rule applied
// to memory: an agent reports success by default and is not a reliable
// narrator of its own work, and an agent that can manufacture the evidence
// for memory's value will. `recordRediscovery` refuses any author but
// `human`, the same way `recordOutcome` refuses `agent_claim`.
//
// **Its bias is recorded with it, not discovered later.** The maintainer
// annotates only the rediscovery they notice. So this establishes a **lower
// bound, never a rate** — every report built on it must say so. It is still
// decisive in one direction: ten sessions of real work with no annotation
// filed is evidence that the semantic market is not there either.

import type { Ledger } from "./ledger.js";

export interface RediscoveryAnnotation {
  id: number;
  tsUtc: string;
  /** The session in which the lesson was re-derived. */
  sessionId: string | null;
  /** The earlier session that first learned it, when the maintainer knows. */
  sourceSessionId: string | null;
  lesson: string;
  /** Would remembering it have changed the work? NULL when not answered. */
  wouldHaveHelped: number | null;
  /** Tool calls spent re-deriving it, if the maintainer counted. */
  callsSpent: number | null;
}

export interface AnnotationReport {
  annotations: RediscoveryAnnotation[];
  total: number;
  /** Of those answered, how many said remembering it would have changed the work. */
  helpful: number;
  answered: number;
  /** Sum of `callsSpent` where given. A floor on the cost of semantic re-derivation. */
  callsSpent: number;
}

export function listRediscoveries(ledger: Ledger, limit = 50): AnnotationReport {
  const rows = ledger.db
    .prepare(
      `SELECT id, ts_utc, session_id, source_session_id, lesson, would_have_helped, calls_spent
       FROM rediscovery_annotations ORDER BY ts_utc DESC, id DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    id: number;
    ts_utc: string;
    session_id: string | null;
    source_session_id: string | null;
    lesson: string;
    would_have_helped: number | null;
    calls_spent: number | null;
  }>;
  const totals = ledger.db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(would_have_helped IS NOT NULL)              AS answered,
              SUM(would_have_helped = 1)                      AS helpful,
              COALESCE(SUM(calls_spent), 0)                   AS calls
       FROM rediscovery_annotations`,
    )
    .get() as { total: number; answered: number | null; helpful: number | null; calls: number };

  return {
    annotations: rows.map((r) => ({
      id: r.id,
      tsUtc: r.ts_utc,
      sessionId: r.session_id,
      sourceSessionId: r.source_session_id,
      lesson: r.lesson,
      wouldHaveHelped: r.would_have_helped,
      callsSpent: r.calls_spent,
    })),
    total: totals.total,
    answered: totals.answered ?? 0,
    helpful: totals.helpful ?? 0,
    callsSpent: totals.calls,
  };
}

export function formatAnnotationReport(r: AnnotationReport): string {
  const L: string[] = [];
  L.push("rediscovery annotations (T80 — the semantic repeats T66 cannot see)");
  L.push(`  filed                     ${r.total}`);
  if (r.total === 0) {
    L.push("  none yet. This is a LOWER BOUND on semantic rediscovery, never a rate —");
    L.push("  but ten sessions of real work with none filed is itself evidence.");
    return L.join("\n");
  }
  L.push(`  would have helped         ${r.helpful} of ${r.answered} answered`);
  L.push(`  calls spent re-deriving   ${r.callsSpent}  (only where counted — a floor, not a total)`);
  L.push("");
  for (const a of r.annotations.slice(0, 10)) {
    const help = a.wouldHaveHelped === null ? "?" : a.wouldHaveHelped === 1 ? "helps" : "no";
    L.push(`  ${a.tsUtc.slice(0, 10)}  [${help}]  ${a.lesson}`);
    if (a.sourceSessionId) L.push(`              first learned in ${a.sourceSessionId}`);
  }
  L.push("");
  L.push("  Human-authored by design: an agent may not write these (the outcome_source");
  L.push("  rule applied to memory). The maintainer annotates only what they notice, so");
  L.push("  this is a lower bound on semantic rediscovery and never a rate.");
  return L.join("\n");
}
