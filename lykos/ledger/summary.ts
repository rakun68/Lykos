// T5.1 — session summary (docs/03-telemetry.md §1.2). Printed at the end of
// a run and stored verbatim (lykos/session/<id>/summary.txt, written from
// ingest.ts next to the transcript), and reused by `lykos cost`'s
// current-session view (T5.2).
//
// The spec's mock includes an "avoided" block and an "effective spend" line
// computed from it. T6.1 (cache, exact) now sets `calls.avoided_usd` on every
// call and `endSession()` sums it onto `sessions.total_avoided_usd`; T6.2/T6.3
// (delegation, cost-inversion counter) have not landed. A session with no
// calls yet, or one recorded before T6.1 existed, still has a NULL
// `total_avoided_usd` -- per AGENTS.md rule 4 ("no number, no mechanism")
// that prints as an explicit, named absence, never as $0.00 or an omitted
// section. $0.00 would claim zero was avoided, which is a different, false
// statement from "not yet computed."

import type { Ledger } from "./ledger.js";
import { formatShare } from "./tool-schema.js";

export interface SessionSummaryRow {
  id: string;
  brief: string | null;
  task_id: string | null;
  started_utc: string;
  ended_utc: string | null;
  outcome: "success" | "fail" | "abandoned" | null;
  outcome_source: "verification_command" | "human" | "agent_claim" | null;
  total_cost_usd: number | null;
  total_avoided_usd: number | null;
  turns: number;
  tool_calls: number;
  compactions: number;
  escalations: number;
  human_interventions: number;
}

export interface HopCostRow {
  hop: number;
  provider: string;
  model: string;
  n: number;
  cost_usd: number;
}

export interface SessionSummary {
  session: SessionSummaryRow;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  hopCosts: HopCostRow[];
  /**
   * Sum of `cost_usd` across this session AND every hop-1 child session
   * (T8.3: a subagent is its own session row, linked by `parent_session_id`,
   * not a call tagged inline in the parent). NOT `session.total_cost_usd` --
   * that column is scoped to this one session's own calls only, so reading
   * it directly here would silently omit all delegated spend, which is
   * exactly the gap docs/03-telemetry.md §1.2's mock does NOT have (its
   * "cost" line already includes both "parent" and "delegates" sub-lines).
   */
  totalCostUsd: number;
  /**
   * Summed the same way, across this session and its hop-1 children --
   * `sessions.total_avoided_usd` (which `endSession()` fills from
   * `SUM(calls.avoided_usd)`, T6.1) is scoped per-session, so a delegation's
   * avoided figure (T6.2, recorded on the CHILD session) would otherwise
   * never reach the summary a person actually looks at. NULL means what it
   * always meant: no call anywhere in this family has a computed avoided
   * figure yet.
   */
  avoidedUsd: number | null;
  /**
   * T20.1 / T4.1: per-session tool-schema tax from `v_schema_tax`.
   * `share` is null when nothing was measured (catalog miss or no
   * activeTools) — never a silent 0%.
   */
  schemaTax: {
    measuredCalls: number;
    avgTokens: number | null;
    share: number | null;
  };
  /** T39: child sessions with parent link and resumable status. */
  children: Array<{
    id: string;
    costUsd: number | null;
    resumable: boolean;
    notResumableReason: string | null;
  }>;
}

/** T8.3: hop-1 subagents are first-class sessions, one level deep today. */
function childSessionIds(ledger: Ledger, sessionId: string): string[] {
  const rows = ledger.db
    .prepare(`SELECT id FROM sessions WHERE parent_session_id = ?`)
    .all(sessionId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export function loadSessionSummary(ledger: Ledger, sessionId: string): SessionSummary | null {
  const session = ledger.db
    .prepare(
      `SELECT id, brief, task_id, started_utc, ended_utc, outcome, outcome_source,
              total_cost_usd, total_avoided_usd, turns, tool_calls, compactions,
              escalations, human_interventions
       FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as SessionSummaryRow | undefined;
  if (!session) return null;

  const familyIds = [sessionId, ...childSessionIds(ledger, sessionId)];
  const placeholders = familyIds.map(() => "?").join(", ");

  const totals = ledger.db
    .prepare(
      `SELECT
         COALESCE(SUM(input_tokens), 0)       AS input,
         COALESCE(SUM(output_tokens), 0)      AS output,
         COALESCE(SUM(cache_read_tokens), 0)  AS cacheRead,
         COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite
       FROM calls WHERE session_id IN (${placeholders})`,
    )
    .get(...familyIds) as { input: number; output: number; cacheRead: number; cacheWrite: number };

  const hopCosts = ledger.db
    .prepare(
      `SELECT hop, provider, model, COUNT(*) AS n, ROUND(SUM(cost_usd), 6) AS cost_usd
       FROM calls WHERE session_id IN (${placeholders})
       GROUP BY hop, provider, model
       ORDER BY hop ASC, cost_usd DESC`,
    )
    .all(...familyIds) as HopCostRow[];

  const avoidedRow = ledger.db
    .prepare(`SELECT SUM(avoided_usd) AS sum FROM calls WHERE session_id IN (${placeholders})`)
    .get(...familyIds) as { sum: number | null };

  const tax = ledger.db
    .prepare(
      `SELECT measured_calls, avg_schema_tokens, share_of_prompt
       FROM v_schema_tax WHERE session_id = ?`,
    )
    .get(sessionId) as
      | { measured_calls: number; avg_schema_tokens: number | null; share_of_prompt: number | null }
      | undefined;

  const childIds = childSessionIds(ledger, sessionId);
  const children = childIds.map((id) => {
    const row = ledger.db
      .prepare(`SELECT resumable, not_resumable_reason FROM sessions WHERE id = ?`)
      .get(id) as { resumable: number | null; not_resumable_reason: string | null };
    const totals = ledger.callTotals(id);
    return {
      id,
      costUsd: totals.costUsd,
      resumable: row.resumable !== 0,
      notResumableReason: row.not_resumable_reason,
    };
  });

  return {
    session,
    tokens: {
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
    },
    hopCosts,
    totalCostUsd: hopCosts.reduce((sum, row) => sum + row.cost_usd, 0),
    avoidedUsd: avoidedRow.sum,
    schemaTax: {
      measuredCalls: tax?.measured_calls ?? 0,
      avgTokens: tax?.avg_schema_tokens ?? null,
      share: tax?.share_of_prompt ?? null,
    },
    children,
  };
}

function fmtUsd(n: number | null | undefined): string {
  return `$${(n ?? 0).toFixed(4)}`;
}

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function fmtDuration(ms: number): string {
  if (ms < 0) return "0s";
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Shared by the summary box and `lykos cost`'s recent-sessions list (T5) so
 * the two never disagree on what the same row means. `endedUtc` matters: a
 * session with none is still running, but one that ended with `outcome`
 * still NULL finished without anyone (a verification command or a human)
 * ever judging it -- its own honest state, not "still going." A bare `done`
 * from the delegate is never enough on its own (rule 6: never let an
 * agent's self-report count as success).
 */
export function outcomeLabel(
  outcome: string | null,
  outcomeSource: string | null,
  endedUtc: string | null,
): string {
  if (outcome === null) {
    return endedUtc === null ? "in progress" : "unresolved (no outcome recorded)";
  }
  const label = outcomeSource === "agent_claim" ? `${outcome} (unverified — agent_claim)` : outcome;
  return `${label}${outcomeSource && outcomeSource !== "agent_claim" ? ` (${outcomeSource})` : ""}`;
}

function outcomeLine(session: SessionSummaryRow): string {
  return outcomeLabel(session.outcome, session.outcome_source, session.ended_utc);
}

function hopLabel(hop: number): string {
  return hop === 0 ? "hop 0 (direct)" : `hop ${hop} (subagent)`;
}

export function formatSessionSummary(summary: SessionSummary): string {
  const { session, tokens, hopCosts, totalCostUsd, avoidedUsd, schemaTax, children } = summary;
  const rule = "─".repeat(63);
  const lines: string[] = [];

  lines.push(rule);
  lines.push(` lykos  session ${session.id.slice(0, 8)}  │  ${session.brief ?? "(no brief)"}`);
  lines.push(rule);

  lines.push(` outcome        ${outcomeLine(session)}`);
  if (session.ended_utc) {
    const wallMs = new Date(session.ended_utc).getTime() - new Date(session.started_utc).getTime();
    lines.push(` wall time      ${fmtDuration(wallMs)}`);
  }
  lines.push(` turns          ${session.turns}              tool calls ${session.tool_calls}`);
  lines.push("");

  const promptTotal = tokens.input + tokens.cacheRead;
  lines.push(` tokens         input      ${fmtInt(promptTotal)}`);
  if (promptTotal > 0) {
    lines.push(`                ├ cached    ${fmtInt(tokens.cacheRead)}  (${fmtPct(tokens.cacheRead / promptTotal)})`);
    lines.push(`                └ fresh     ${fmtInt(tokens.input)}`);
  }
  lines.push(`                output     ${fmtInt(tokens.output)}`);
  if (schemaTax.measuredCalls > 0) {
    const avg = schemaTax.avgTokens === null ? "?" : fmtInt(Math.round(schemaTax.avgTokens));
    const share = formatShare(schemaTax.share);
    lines.push(` schema tax     ${avg} tokens/call  ${share} of prompt`);
  } else {
    lines.push(" schema tax     not measured (activeTools absent or catalog miss)");
  }
  lines.push("");

  lines.push(` cost           ${fmtUsd(totalCostUsd)}`);
  const byHop = new Map<number, HopCostRow[]>();
  for (const row of hopCosts) {
    const list = byHop.get(row.hop) ?? [];
    list.push(row);
    byHop.set(row.hop, list);
  }
  const hops = [...byHop.keys()].sort((a, b) => a - b);
  hops.forEach((hop, i) => {
    const rows = byHop.get(hop) ?? [];
    const branch = i === hops.length - 1 ? "└" : "├";
    const hopCost = rows.reduce((sum, r) => sum + r.cost_usd, 0);
    const models = rows.map((r) => `${r.provider}/${r.model}`).join(", ");
    lines.push(`                ${branch} ${hopLabel(hop).padEnd(20)} ${fmtUsd(hopCost)}  (${models})`);
  });
  lines.push("");

  if (children && children.length > 0) {
    lines.push(" children");
    children.forEach((c, i) => {
      const branch = i === children.length - 1 ? "└" : "├";
      const resume = c.resumable ? "resumable" : "not resumable";
      lines.push(
        `                ${branch} ${c.id.slice(0, 8)}  parent=${session.id.slice(0, 8)}  ` +
          `${fmtUsd(c.costUsd)}  ${resume}` +
          (c.notResumableReason ? `  (${c.notResumableReason.slice(0, 48)})` : ""),
      );
    });
    lines.push("");
  }

  if (avoidedUsd !== null) {
    lines.push(` avoided        ~${fmtUsd(avoidedUsd)}`);
  } else {
    lines.push(" avoided        not yet computed — counterfactual accounting is T6");
  }
  lines.push("");

  lines.push(` compactions    ${session.compactions}              escalations ${session.escalations}`);
  lines.push(` interventions  ${session.human_interventions}`);
  lines.push(rule);

  return lines.join("\n");
}
