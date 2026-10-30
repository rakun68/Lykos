// `lykos cost` — reads the ledger (T3.5.3 acceptance: "lykos cost reads the
// ledger"). T5: the current-session summary (T5.1/T5.2), `--since` rollups
// (T5.3), and `--compare` (T5.4, "the closest thing to an experiment that
// costs nothing," docs/03-telemetry.md §6 — observational, always labelled
// as such).

import { existsSync } from "node:fs";
import {
  extensionSetLabel,
  HOP0_SCOPE,
  type ResolvedExtension,
} from "../config/extensions.js";

import { openLedgerSync, type Ledger } from "../ledger/use.js";

import { formatSessionSummary, loadSessionSummary, outcomeLabel } from "../ledger/summary.js";
import {
  catalogMeta,
  formatShare,
  piDefaultBaseline,
  piDefaultPlusSubagentsBaseline,
  SCHEMA_TOKENS_BASIS,
  schemaShareOfPrompt,
} from "../ledger/tool-schema.js";
import {
  omitToolsMeasurement,
  workerPlusHostMeasurement,
  workerSurfaceMeasurement,
} from "../tools.js";
import { EXPLORE_METRIC_VERSION } from "../loop/exploration.js";
import { stdoutWrite } from "../tui/io-mode.js";
// T61: `--by task`'s table. `fmtUsd` is defined locally in this file (below)
// and deliberately not re-imported.
import { pad, truncate } from "../tui/format.js";

export interface CostOptions {
  since?: string;
  compare?: string;
  /** T61: `--by task` — sessions per task, total spend, outcome. */
  by?: string;
}

interface SessionRow {
  id: string;
  brief: string | null;
  started_utc: string;
  ended_utc: string | null;
  outcome: string | null;
  outcome_source: string | null;
  total_cost_usd: number | null;
}

interface OverallRow {
  sessions: number;
  successes: number;
  fails: number;
  abandoned: number;
  unresolved: number;
  spent_usd: number | null;
}

interface SchemaLedgerRow {
  calls: number;
  measured: number;
  avg_tokens: number | null;
  sum_schema: number | null;
  sum_prompt: number | null;
}

function fmtUsd(n: number | null | undefined): string {
  return `$${(n ?? 0).toFixed(4)}`;
}

function writeCatalogBaselines(): void {
  const meta = catalogMeta();
  const without = piDefaultBaseline();
  const withExt = piDefaultPlusSubagentsBaseline();
  const delta = withExt.tokens - without.tokens;
  stdoutWrite("\ntool-schema tax (catalog, not billed)\n");
  stdoutWrite(
    `  Pi ${meta.piVersion} / pi-subagents ${meta.piSubagentsVersion}  basis ${SCHEMA_TOKENS_BASIS}\n`,
  );
  stdoutWrite(
    `  without pi-subagents  ${without.tokens} tokens  (${without.count} tools)\n`,
  );
  stdoutWrite(
    `  with pi-subagents     ${withExt.tokens} tokens  (${withExt.count} tools)\n`,
  );
  stdoutWrite(`  delta                 ${delta} tokens\n`);
  stdoutWrite(
    "  Agent/SubagentWorkflow descriptions are a lower bound (representative roster; isolation/schedule omitted).\n",
  );
  const omit = omitToolsMeasurement();
  const worker = workerSurfaceMeasurement();
  const host = workerPlusHostMeasurement();
  stdoutWrite(
    `  T20 hop-0 worker      ${worker.tokens} tokens  (${worker.count} tools: read,bash,edit,write)\n`,
  );
  stdoutWrite(
    `  T20 before (omit)     ${omit.tokens} tokens  (${omit.count} tools: read,grep,find,ls)\n`,
  );
  stdoutWrite(
    `  T20 + subagent host   ${host.tokens} tokens  (${host.count} tools, no SubagentWorkflow)\n`,
  );
}

function writeLedgerSchemaTax(ledger: Ledger): void {
  const row = ledger.db
    .prepare(
      `SELECT
         COUNT(*)                                          AS calls,
         SUM(tool_schema_tokens IS NOT NULL)               AS measured,
         AVG(tool_schema_tokens)                           AS avg_tokens,
         SUM(tool_schema_tokens)                           AS sum_schema,
         SUM(CASE WHEN tool_schema_tokens IS NOT NULL
                  THEN input_tokens + cache_read_tokens END) AS sum_prompt
       FROM calls`,
    )
    .get() as SchemaLedgerRow;

  const calls = row.calls ?? 0;
  const measured = row.measured ?? 0;
  const unmeasured = calls - measured;

  if (calls === 0) {
    stdoutWrite("  ledger     no calls recorded yet\n");
    return;
  }

  if (measured === 0) {
    stdoutWrite(
      `  ledger     ${unmeasured} call(s) unmeasured (activeTools absent or catalog miss — tokens left NULL, not 0)\n`,
    );
  } else {
    const avg = row.avg_tokens;
    const share = schemaShareOfPrompt(
      row.sum_schema ?? null,
      // schemaShareOfPrompt takes (schema, input, cacheRead) and sums input+cacheRead.
      // We already have the prompt denominator in sum_prompt; pass it as input and 0 cache.
      row.sum_prompt ?? 0,
      0,
    );
    const avgText = avg === null ? "?" : String(Math.round(avg));
    stdoutWrite(
      `  ledger     avg ${avgText} tokens/call across ${measured} measured` +
        (unmeasured > 0 ? ` (${unmeasured} unmeasured left NULL)` : "") +
        "\n",
    );
    if (share) {
      stdoutWrite(
        `  share of prompt  ${formatShare(share.share)}  (schema / (input + cache_read), measured calls only)\n`,
      );
    }
  }

  const breaks = ledger.db.prepare(`SELECT COUNT(*) AS n FROM v_prefix_breaks`).get() as { n: number };
  if (breaks.n > 0) {
    stdoutWrite(
      `  ⚠ prefix hash changed on ${breaks.n} call(s) — tool set or order shifted mid-session (v_prefix_breaks)\n`,
    );
  }
}

/**
 * T29.4: the ledger stores `extensions` as bare {name, version} JSON, not
 * full ResolvedExtension records (scope/path/hop0 aren't session facts worth
 * a column each). Rebuild the shape extensionSetLabel() expects rather than
 * duplicating its "name@version, ..." formatting here — the placeholders are
 * never read by that function, only name/version are.
 */
function labelFromStoredExtensions(json: string | null): string {
  if (json === null) return "(none)";
  try {
    const parsed = JSON.parse(json) as Array<{ name: string; version: string }>;
    const resolved: ResolvedExtension[] = parsed.map((e) => ({
      name: e.name,
      version: e.version,
      scope: [HOP0_SCOPE],
      hop0: true,
    }));
    return extensionSetLabel(resolved);
  } catch {
    return "(unreadable)";
  }
}

interface CurrentSessionExtensionRow {
  extension_set: string | null;
  extensions: string | null;
  extension_schema_tokens: number | null;
  extension_schema_share: number | null;
  notes: string | null;
}

/**
 * T29.3/T29.4: the current session's declared set and its measured schema
 * tax, printed beside the ledger-wide schema-tax section. NULL share is
 * reported as "unmeasured", never guessed at — the unknown tool names live
 * in `notes` (extensionSchemaTax() in ingest.ts put them there) and are
 * surfaced here rather than re-derived.
 */
function writeExtensionSchemaTax(ledger: Ledger, sessionId: string | undefined): void {
  if (!sessionId) return;
  const row = ledger.db
    .prepare(
      `SELECT extension_set, extensions, extension_schema_tokens, extension_schema_share, notes
       FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as CurrentSessionExtensionRow | undefined;
  if (!row) return;

  stdoutWrite("\nextensions (T29)\n");
  stdoutWrite(
    `  current session  set ${row.extension_set ?? "(unrecorded)"}  ${labelFromStoredExtensions(row.extensions)}\n`,
  );
  if (row.extension_set === null) {
    // A session that ran before T29 added the columns. That is not the same
    // answer as "declared none" or "could not measure", and collapsing the
    // three would make the ledger's own history look comparable when it is not.
    stdoutWrite("  schema tax        not recorded — this session ran before T29 added the columns\n");
  } else if (row.extension_schema_share !== null) {
    stdoutWrite(
      `  schema tax        ${formatShare(row.extension_schema_share)} of billed input  ` +
        `(${row.extension_schema_tokens} tokens beyond Pi's own built-ins)\n`,
    );
  } else {
    const m = row.notes ? /catalog does not know: ([^—]+)—/.exec(row.notes) : null;
    stdoutWrite(
      `  schema tax        unmeasured (catalog does not know: ${m?.[1] ? m[1].trim() : "see session notes"})\n`,
    );
  }
}

interface PriceBasisRow {
  price_basis: string | null;
  calls: number;
  spent_usd: number | null;
}

/**
 * T25.3 (docs/13-model-access.md §5.2): `lykos cost` never sums across
 * price_basis values -- the same discipline it already applies to cache
 * figures across providers. Grouped over `calls`, not `sessions.total_cost_usd`,
 * because price_basis is a per-call fact; a session mixing bases (not
 * possible with today's single-provider worker, but not ruled out once
 * Phase 3 lands) must not collapse into one blended number. `unpriced` rows
 * always have cost_usd NULL (SUM() ignores them automatically) and are
 * reported by their own count rather than folded silently into 0.
 */
function writePriceBasisBreakdown(ledger: Ledger, whereSql = "", params: unknown[] = []): void {
  const rows = ledger.db
    .prepare(
      `SELECT price_basis, COUNT(*) AS calls, SUM(cost_usd) AS spent_usd
       FROM calls ${whereSql}
       GROUP BY price_basis
       ORDER BY spent_usd IS NULL, spent_usd DESC`,
    )
    .all(...params) as PriceBasisRow[];
  if (rows.length === 0) return;

  stdoutWrite("\nprice basis (T25 — never summed across bases)\n");
  let excluded = 0;
  for (const row of rows) {
    const basis = row.price_basis ?? "(pre-T25, unrecorded)";
    if (basis === "unpriced") excluded += row.calls;
    stdoutWrite(
      `  ${basis.padEnd(22)} ${String(row.calls).padStart(4)} calls   ${fmtUsd(row.spent_usd)}` +
        (row.spent_usd === null ? "  (no dollar figure — never invented)" : "") +
        "\n",
    );
  }
  if (excluded > 0) {
    stdoutWrite(`  excluded from cost claims: ${excluded} unpriced call(s)\n`);
  }
}

const FLAG_COLUMNS: Record<string, string> = {
  retrieval: "flag_retrieval",
  proactive_compaction: "flag_proactive_compaction",
  proactiveCompaction: "flag_proactive_compaction",
  routing: "flag_routing",
  draft_verify: "flag_draft_verify",
  draftVerify: "flag_draft_verify",
  delegation: "flag_delegation",
  cache_stable_head: "flag_cache_stable_head",
  cacheStableHead: "flag_cache_stable_head",
  trimmed_tool_surface: "flag_trimmed_tool_surface",
  trimmedToolSurface: "flag_trimmed_tool_surface",
  prompt_diet: "flag_prompt_diet",
  promptDiet: "flag_prompt_diet",
  output_diet: "flag_output_diet",
  outputDiet: "flag_output_diet",
};

/** "7d" -> 7. Only whole days are supported today; anything else is a caller error. */
function parseSinceDays(since: string): number | null {
  const m = /^(\d+)d$/.exec(since.trim());
  if (!m) return null;
  const days = Number(m[1]);
  return days > 0 ? days : null;
}

interface WindowRow {
  sessions: number;
  successes: number;
  fails: number;
  abandoned: number;
  spent_usd: number | null;
  escalations: number | null;
  interventions: number | null;
  tool_calls: number | null;
  explore_tool_calls: number | null;
  // T63: the current metric's two halves, plus how many sessions in this window
  // are on which definition. A window can straddle multiple definitions, and
  // averaging across them would compare two different measurements.
  sessions_current: number | null;
  sessions_v2: number | null;
  sessions_v1: number | null;
  explore_result_bytes: number | null;
  tool_result_bytes: number | null;
  edit_tool_calls: number | null;
  edit_error_count: number | null;
  edit_retry_count: number | null;
}

function windowStats(ledger: Ledger, fromIso: string, toIso: string): WindowRow {
  return ledger.db
    .prepare(
      `SELECT
         COUNT(*)                     AS sessions,
         SUM(outcome = 'success')     AS successes,
         SUM(outcome = 'fail')        AS fails,
         SUM(outcome = 'abandoned')   AS abandoned,
         SUM(total_cost_usd)          AS spent_usd,
         SUM(escalations)             AS escalations,
         SUM(human_interventions)     AS interventions,
         SUM(tool_calls)              AS tool_calls,
         SUM(CASE WHEN explore_metric_version = ${EXPLORE_METRIC_VERSION}
                  THEN explore_tool_calls END) AS explore_tool_calls,
         SUM(explore_metric_version = ${EXPLORE_METRIC_VERSION}) AS sessions_current,
         SUM(explore_metric_version = 2)              AS sessions_v2,
         SUM(COALESCE(explore_metric_version, 1) = 1) AS sessions_v1,
         SUM(CASE WHEN explore_metric_version = ${EXPLORE_METRIC_VERSION}
                  THEN explore_result_bytes END)      AS explore_result_bytes,
         SUM(CASE WHEN explore_metric_version = ${EXPLORE_METRIC_VERSION}
                  THEN tool_result_bytes END)         AS tool_result_bytes,
         SUM(edit_tool_calls)         AS edit_tool_calls,
         SUM(edit_error_count)        AS edit_error_count,
         SUM(edit_retry_count)        AS edit_retry_count
       FROM sessions WHERE started_utc >= ? AND started_utc < ?`,
    )
    .get(fromIso, toIso) as WindowRow;
}

function costPerSuccess(row: WindowRow): number | null {
  if (!row.successes) return null;
  return (row.spent_usd ?? 0) / row.successes;
}

/**
 * T26.4: nearest-rank percentile over a value already sorted ascending. NULL
 * on an empty array — never a fabricated 0, the same discipline every other
 * "not yet measured" figure in this file follows.
 */
function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(p * sortedAsc.length));
  return sortedAsc[idx] ?? null;
}

function fmtMs(n: number | null): string {
  return n === null ? "n/a" : n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`;
}

/**
 * T26.3/T26.4: wall-clock per successful task, beside cost per successful
 * task the way `01-idea.md` §2.2 has listed it since the start. Computed
 * from sessions.started_utc/ended_utc directly in JS (not SQLite date
 * arithmetic) so the ms math is unambiguous. A session with no ended_utc
 * (still running, or never closed) is excluded rather than treated as 0.
 */
function wallClockMsPerSuccess(ledger: Ledger, fromIso: string, toIso: string): number | null {
  const rows = ledger.db
    .prepare(
      `SELECT started_utc, ended_utc FROM sessions
       WHERE started_utc >= ? AND started_utc < ? AND outcome = 'success' AND ended_utc IS NOT NULL`,
    )
    .all(fromIso, toIso) as Array<{ started_utc: string; ended_utc: string }>;
  if (rows.length === 0) return null;
  const totalMs = rows.reduce(
    (sum, r) => sum + (new Date(r.ended_utc).getTime() - new Date(r.started_utc).getTime()),
    0,
  );
  return totalMs / rows.length;
}

/**
 * T26.4/T26.5: p50/p95 of per-call latency_ms and ttft_ms in the window,
 * beside the cache hit ratio that already prints here — T17's contract cut
 * prefill (the TTFT term) and nobody had a number to show for it until now.
 * NULL on every field until real traffic populates latency_ms/ttft_ms
 * (T26.1) — this ledger has none yet (DECISIONS.md 2026-08-31), and that is
 * reported as "not yet measured", never a fabricated figure.
 */
function writeLatencyAndCacheHitRatio(ledger: Ledger, fromIso: string, toIso: string): void {
  const latencyRows = ledger.db
    .prepare(
      `SELECT latency_ms, ttft_ms FROM calls
       WHERE ts_utc >= ? AND ts_utc < ? AND (latency_ms IS NOT NULL OR ttft_ms IS NOT NULL)`,
    )
    .all(fromIso, toIso) as Array<{ latency_ms: number | null; ttft_ms: number | null }>;
  const latencies = latencyRows.map((r) => r.latency_ms).filter((v): v is number => v !== null).sort((a, b) => a - b);
  const ttfts = latencyRows.map((r) => r.ttft_ms).filter((v): v is number => v !== null).sort((a, b) => a - b);

  const cacheRow = ledger.db
    .prepare(
      `SELECT SUM(cache_read_tokens) AS cache_read, SUM(input_tokens) AS input
       FROM calls WHERE ts_utc >= ? AND ts_utc < ?`,
    )
    .get(fromIso, toIso) as { cache_read: number | null; input: number | null };
  const promptTotal = (cacheRow.cache_read ?? 0) + (cacheRow.input ?? 0);
  const hitRatio = promptTotal > 0 ? formatShare((cacheRow.cache_read ?? 0) / promptTotal) : "n/a";

  stdoutWrite(
    ` cache hit ratio              ${hitRatio}` +
      `   TTFT p50 ${fmtMs(percentile(ttfts, 0.5))} p95 ${fmtMs(percentile(ttfts, 0.95))}` +
      "  (cache reads cut prefill — T17's contract is also a latency mechanism, T26.5)\n",
  );
  if (latencies.length > 0) {
    stdoutWrite(
      ` call latency                 p50 ${fmtMs(percentile(latencies, 0.5))}  p95 ${fmtMs(percentile(latencies, 0.95))}` +
        `  (${latencies.length} call(s) measured)\n`,
    );
  } else {
    stdoutWrite(
      " call latency                 not yet measured — no call in this window recorded latency_ms (T26.1)\n",
    );
  }
}

/**
 * T61 — `lykos cost --by task`.
 *
 * The reporting that makes the headline metric CHECKABLE: a task that
 * quietly acquired six sessions should be visible rather than inferred.
 * Every column comes from the tasks table and the sessions belonging to it;
 * nothing here derives a number the ledger does not already hold.
 */
function runByTaskReport(ledger: Ledger, by: string): number {
  if (by !== "task") {
    stdoutWrite(`lykos cost --by: only "task" is supported today, got "${by}"\n`);
    return 1;
  }
  const rows = ledger.db
    .prepare(
      `SELECT t.id AS id, t.brief AS brief, t.state AS state,
              COUNT(s.id) AS sessions,
              COALESCE(SUM(s.outcome = 'success'), 0) AS successes,
              COALESCE(SUM(s.outcome = 'fail'), 0) AS failures,
              COALESCE(SUM(s.outcome = 'abandoned'), 0) AS abandoned,
              COALESCE(SUM(s.outcome IS NULL), 0) AS unresolved,
              SUM(s.total_cost_usd) AS spent_usd
         FROM tasks t
         LEFT JOIN sessions s ON s.task_id = t.id
        GROUP BY t.id
        ORDER BY COALESCE(MAX(s.started_utc), t.created_utc) DESC`,
    )
    .all() as Array<{
    id: string;
    brief: string;
    state: string | null;
    sessions: number;
    successes: number;
    failures: number;
    abandoned: number;
    unresolved: number;
    spent_usd: number | null;
  }>;

  if (rows.length === 0) {
    stdoutWrite("no tasks recorded yet.\n");
    return 0;
  }

  stdoutWrite(
    `${pad("task", 10)} ${pad("state", 10)} ${pad("sessions", 9)} ${pad("spent", 10)} ${pad("ok/fail/ab/?", 14)} brief\n`,
  );
  for (const row of rows) {
    stdoutWrite(
      `${pad(row.id.slice(0, 8), 10)} ${pad(row.state ?? "—", 10)} ${pad(String(row.sessions), 9)} ` +
        `${pad(fmtUsd(row.spent_usd), 10)} ` +
        `${pad(`${row.successes}/${row.failures}/${row.abandoned}/${row.unresolved}`, 14)} ${truncate(row.brief, 50)}\n`,
    );
  }

  const multi = rows.filter((r) => r.sessions > 1);
  const spentOnMulti = multi.reduce((acc, r) => acc + (r.spent_usd ?? 0), 0);
  stdoutWrite(
    `\n${rows.length} task(s); ${multi.length} span more than one session` +
      (multi.length > 0 ? ` (${fmtUsd(spentOnMulti)} of the total)` : "") +
      ".\n",
  );
  // A naive per-SESSION figure counts each attempt as its own task, which is
  // exactly the flattery T61 exists to prevent. Both are printed so the
  // difference is visible rather than argued about.
  const successes = rows.reduce((acc, r) => acc + r.successes, 0);
  const spent = rows.reduce((acc, r) => acc + (r.spent_usd ?? 0), 0);
  const tasksWithSuccess = rows.filter((r) => r.successes > 0).length;
  stdoutWrite(
    successes === 0
      ? "no verified successes yet, so cost per successful task is undefined — the honest answer, not a zero.\n"
      : `cost per successful TASK ${fmtUsd(spent / tasksWithSuccess)} vs a naive per-SESSION figure of ${fmtUsd(spent / successes)}.\n`,
  );
  return 0;
}

/** T5.3 — `lykos cost --since <Nd>`, docs/03-telemetry.md §6. */
function runSinceReport(ledger: Ledger, since: string): number {
  const days = parseSinceDays(since);
  if (days === null) {
    stdoutWrite(`lykos cost --since: expected "<N>d" (e.g. "7d"), got "${since}"\n`);
    return 1;
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const prevCutoff = new Date(now.getTime() - 2 * days * 86_400_000).toISOString();
  const nowIso = now.toISOString();

  const current = windowStats(ledger, cutoff, nowIso);
  const previous = windowStats(ledger, prevCutoff, cutoff);

  stdoutWrite(
    ` ${days} days  │  ${current.sessions} sessions  │  ${current.successes ?? 0} success  ` +
      `${current.fails ?? 0} fail  ${current.abandoned ?? 0} abandoned\n`,
  );

  const curPerSuccess = costPerSuccess(current);
  const prevPerSuccess = costPerSuccess(previous);
  if (curPerSuccess !== null) {
    let line = ` cost per successful task     ${fmtUsd(curPerSuccess)}`;
    if (prevPerSuccess !== null && prevPerSuccess > 0) {
      const pct = ((curPerSuccess - prevPerSuccess) / prevPerSuccess) * 100;
      const arrow = pct <= 0 ? "▼" : "▲";
      line += `     (prev ${days}d: ${fmtUsd(prevPerSuccess)})  ${arrow} ${Math.abs(pct).toFixed(0)}%`;
    }
    stdoutWrite(`${line}\n`);
  } else {
    stdoutWrite(" cost per successful task     n/a (no successes in window)\n");
  }
  stdoutWrite("  (suggestive, not conclusive — T21.4; explore-calls are the better T21.3 proxy)\n");

  // T26.3/T26.4: wall-clock per successful task, listed since 01-idea.md §2.2
  // and unrecorded until now (DECISIONS.md 2026-08-31).
  const wallClockMs = wallClockMsPerSuccess(ledger, cutoff, nowIso);
  stdoutWrite(
    ` wall-clock per successful task ${wallClockMs === null ? "n/a (no successes in window)" : fmtMs(wallClockMs)}\n`,
  );

  if (current.sessions > 0) {
    const tokenRow = ledger.db
      .prepare(
        `SELECT SUM(c.input_tokens + c.output_tokens + c.cache_read_tokens) AS tokens
         FROM calls c JOIN sessions s ON s.id = c.session_id
         WHERE s.started_utc >= ? AND s.started_utc < ?`,
      )
      .get(cutoff, nowIso) as { tokens: number | null };
    const tokens = tokenRow.tokens ?? 0;
    stdoutWrite(` tokens per task              ${Math.round(tokens / current.sessions)}\n`);
    stdoutWrite(
      ` tool-calls per task          ${((current.tool_calls ?? 0) / current.sessions).toFixed(1)}\n`,
    );
    // T63 (docs/20-phase9-tasks.md §2). This line used to print the v1 count
    // with the caveat "bash search is invisible after T20" appended — the
    // limitation was known *here* and never fixed at the source. It is fixed
    // now, and the two definitions are never averaged into one number.
    const currentMetricSessions = current.sessions_current ?? 0;
    const v2Sessions = current.sessions_v2 ?? 0;
    const v1Sessions = current.sessions_v1 ?? 0;
    if (currentMetricSessions > 0) {
      stdoutWrite(
        ` explore-calls per task       ${((current.explore_tool_calls ?? 0) / currentMetricSessions).toFixed(1)}` +
          `  (v${EXPLORE_METRIC_VERSION}: bash classified by command word)\n`,
      );
      const exploreBytes = current.explore_result_bytes ?? 0;
      const allBytes = current.tool_result_bytes ?? 0;
      stdoutWrite(
        ` exploration share            ${
          allBytes > 0 ? `${((exploreBytes / allBytes) * 100).toFixed(1)}% of tool-result bytes` : "n/a (no tool results)"
        }  (T67 reads this)\n`,
      );
      if (v1Sessions > 0 || v2Sessions > 0) {
        stdoutWrite(
          `                              over ${currentMetricSessions} of ${currentMetricSessions + v1Sessions + v2Sessions} sessions; ` +
            `${v1Sessions} pre-T63 excluded — a different metric, not backfilled\n`,
        );
      }
      if (v2Sessions > 0) {
        stdoutWrite(
          `                              ${v2Sessions} v2 sessions excluded — a different metric, not backfilled\n`,
        );
      }
    } else {
      stdoutWrite(` explore-calls per task       n/a (no v${EXPLORE_METRIC_VERSION} exploration metric rows)\n`);
    }
    const editCalls = current.edit_tool_calls ?? 0;
    const editErrors = current.edit_error_count ?? 0;
    const editRetries = current.edit_retry_count ?? 0;
    if (editCalls > 0) {
      stdoutWrite(
        ` edit-retry rate               ${editRetries}/${editCalls} \`edit\` calls retried ` +
          `(${editErrors} failed; ast_edit and lsp not counted)  (T24.3 baseline)\n`,
      );
    }
  }

  stdoutWrite(` total spent                  ${fmtUsd(current.spent_usd)}\n`);

  const avoidedRow = ledger.db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(total_avoided_usd) AS sum FROM sessions
       WHERE started_utc >= ? AND started_utc < ? AND total_avoided_usd IS NOT NULL`,
    )
    .get(cutoff, nowIso) as { n: number; sum: number | null };
  if (avoidedRow.n > 0) {
    stdoutWrite(` total avoided (modelled)    ~${fmtUsd(avoidedRow.sum)}\n`);
    const inversions = ledger.db
      .prepare(
        `SELECT COUNT(*) AS n, SUM(avoided_usd) AS sum FROM calls c
         JOIN sessions s ON s.id = c.session_id
         WHERE s.started_utc >= ? AND s.started_utc < ? AND c.avoided_usd < 0`,
      )
      .get(cutoff, nowIso) as { n: number; sum: number | null };
    stdoutWrite(` cost inversions              ${inversions.n}          (${fmtUsd(inversions.sum)})\n`);
  } else {
    stdoutWrite(
      " total avoided                not yet computed — no session in this window has a completed call (T6.1)\n",
    );
  }

  writeLatencyAndCacheHitRatio(ledger, cutoff, nowIso);

  const hopRow = ledger.db
    .prepare(
      `SELECT
         SUM(CASE WHEN c.hop > 0 THEN c.input_tokens + c.output_tokens + c.cache_read_tokens ELSE 0 END) AS delegate_tokens,
         SUM(c.input_tokens + c.output_tokens + c.cache_read_tokens)                                       AS all_tokens,
         SUM(CASE WHEN c.hop > 0 THEN c.cost_usd ELSE 0 END)                                                AS delegate_cost,
         SUM(c.cost_usd)                                                                                    AS all_cost
       FROM calls c JOIN sessions s ON s.id = c.session_id
       WHERE s.started_utc >= ? AND s.started_utc < ?`,
    )
    .get(cutoff, nowIso) as {
    delegate_tokens: number | null;
    all_tokens: number | null;
    delegate_cost: number | null;
    all_cost: number | null;
  };
  if ((hopRow.all_tokens ?? 0) > 0 && (hopRow.delegate_tokens ?? 0) > 0) {
    stdoutWrite(
      ` delegate share of tokens     ${formatShare((hopRow.delegate_tokens ?? 0) / (hopRow.all_tokens ?? 1))}` +
        `        of cost ${formatShare((hopRow.delegate_cost ?? 0) / (hopRow.all_cost ?? 1))}\n`,
    );
  }

  stdoutWrite(` escalations                  ${current.escalations ?? 0}\n`);
  stdoutWrite(` interventions                ${current.interventions ?? 0}\n`);

  writePriceBasisBreakdown(ledger, "WHERE ts_utc >= ? AND ts_utc < ?", [cutoff, nowIso]);

  return 0;
}

/**
 * T29.4: extensions are a SET, not a boolean — `lykos cost --compare
 * extensions` groups by `sessions.extension_set` instead of an ON/OFF flag
 * column, and prints one row per distinct set actually seen, `none` (the
 * control group) included like any other rather than special-cased away. A
 * pre-T29 row that never recorded a set groups separately, under its own
 * label, rather than being folded into `none` — the two are different
 * facts (no ledger says the mechanism is off).
 */
function runExtensionsCompareReport(ledger: Ledger): number {
  stdoutWrite(
    "lykos cost --compare extensions   (observational — not a controlled experiment)\n",
  );
  stdoutWrite("─".repeat(63) + "\n");

  const rows = ledger.db
    .prepare(
      `SELECT
         extension_set                AS extension_set,
         MIN(extensions)               AS extensions_json,
         COUNT(*)                      AS sessions,
         SUM(outcome = 'success')      AS successes,
         SUM(total_cost_usd)           AS spent_usd
       FROM sessions
       GROUP BY extension_set
       ORDER BY sessions DESC`,
    )
    .all() as Array<{
    extension_set: string | null;
    extensions_json: string | null;
    sessions: number;
    successes: number | null;
    spent_usd: number | null;
  }>;

  if (rows.length === 0) {
    stdoutWrite("  no sessions recorded yet.\n");
    return 0;
  }

  for (const row of rows) {
    const key = row.extension_set ?? "(unrecorded, pre-T29)";
    const label = row.extension_set === null ? "" : `   ${labelFromStoredExtensions(row.extensions_json)}`;
    const perSuccess = row.successes ? (row.spent_usd ?? 0) / row.successes : null;
    stdoutWrite(
      ` ${key.padEnd(20)} ${String(row.sessions).padStart(3)} sessions   ` +
        `${String(row.successes ?? 0).padStart(3)} success   ` +
        `cost/success ${perSuccess !== null ? fmtUsd(perSuccess) : "n/a"}${label}\n`,
    );
  }
  return 0;
}

/**
 * T31.3 (docs/15-phase3-tasks.md): execution shape is categorical, not a
 * boolean, same reason T29.4's extension set is — `lykos cost --compare
 * shape` groups by `sessions.execution_shape` and prints every value seen,
 * including a pre-T31 row that never recorded one, under its own label
 * rather than folded into a guess.
 */
function runShapeCompareReport(ledger: Ledger): number {
  stdoutWrite(
    "lykos cost --compare shape   (observational — not a controlled experiment)\n",
  );
  stdoutWrite("─".repeat(63) + "\n");

  const rows = ledger.db
    .prepare(
      `SELECT
         execution_shape               AS execution_shape,
         COUNT(*)                      AS sessions,
         SUM(outcome = 'success')      AS successes,
         SUM(total_cost_usd)           AS spent_usd
       FROM sessions
       GROUP BY execution_shape
       ORDER BY sessions DESC`,
    )
    .all() as Array<{
    execution_shape: string | null;
    sessions: number;
    successes: number | null;
    spent_usd: number | null;
  }>;

  if (rows.length === 0) {
    stdoutWrite("  no sessions recorded yet.\n");
    return 0;
  }

  for (const row of rows) {
    const key = row.execution_shape ?? "(unrecorded, pre-T31)";
    const perSuccess = row.successes ? (row.spent_usd ?? 0) / row.successes : null;
    stdoutWrite(
      ` ${key.padEnd(20)} ${String(row.sessions).padStart(3)} sessions   ` +
        `${String(row.successes ?? 0).padStart(3)} success   ` +
        `cost/success ${perSuccess !== null ? fmtUsd(perSuccess) : "n/a"}\n`,
    );
  }
  return 0;
}

/** T5.4 — `lykos cost --compare <flag>`. Observational, never presented otherwise. */
function runCompareReport(ledger: Ledger, flag: string): number {
  if (flag === "extensions" || flag === "extension_set") return runExtensionsCompareReport(ledger);
  if (flag === "shape" || flag === "execution_shape") return runShapeCompareReport(ledger);

  const column = FLAG_COLUMNS[flag];
  if (!column) {
    stdoutWrite(
      `lykos cost --compare: unknown flag "${flag}". Valid: retrieval, proactive_compaction, routing, draft_verify, delegation, cache_stable_head, trimmed_tool_surface, prompt_diet, output_diet, extensions, shape.\n`,
    );
    return 1;
  }

  stdoutWrite(
    `lykos cost --compare ${flag}   (observational — not a controlled experiment)\n`,
  );
  stdoutWrite("─".repeat(63) + "\n");

  for (const on of [1, 0]) {
    const row = ledger.db
      .prepare(
        `SELECT COUNT(*) AS sessions, SUM(outcome = 'success') AS successes, SUM(total_cost_usd) AS spent_usd
         FROM sessions WHERE ${column} = ?`,
      )
      .get(on) as { sessions: number; successes: number | null; spent_usd: number | null };
    const perSuccess = row.successes ? (row.spent_usd ?? 0) / row.successes : null;
    stdoutWrite(
      ` ${flag} ${on ? "ON " : "OFF"}   ${String(row.sessions).padStart(3)} sessions   ` +
        `${String(row.successes ?? 0).padStart(3)} success   ` +
        `cost/success ${perSuccess !== null ? fmtUsd(perSuccess) : "n/a"}\n`,
    );
  }
  return 0;
}

export function runCost(ledgerPath: string, opts: CostOptions = {}): number {
  const hasLedger = existsSync(ledgerPath);

  if (!hasLedger) {
    stdoutWrite(
      `no ledger at ${ledgerPath} yet — run a task through the delegate first.\n`,
    );
    writeCatalogBaselines();
    return 0;
  }

  const ledger = openLedgerSync(ledgerPath);
  try {
    if (opts.by) return runByTaskReport(ledger, opts.by);
    if (opts.compare) return runCompareReport(ledger, opts.compare);
    if (opts.since) return runSinceReport(ledger, opts.since);

    const currentId = ledger.db
      .prepare(
        `SELECT id FROM sessions WHERE parent_session_id IS NULL ORDER BY started_utc DESC LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (currentId) {
      const summary = loadSessionSummary(ledger, currentId.id);
      if (summary) stdoutWrite(`${formatSessionSummary(summary)}\n\n`);
    }

    const overall = ledger.db
      .prepare(
        `SELECT
           COUNT(*)                         AS sessions,
           SUM(outcome = 'success')         AS successes,
           SUM(outcome = 'fail')            AS fails,
           SUM(outcome = 'abandoned')       AS abandoned,
           SUM(outcome IS NULL)             AS unresolved,
           SUM(total_cost_usd)              AS spent_usd
         FROM sessions`,
      )
      .get() as OverallRow;

    stdoutWrite("lykos cost — all sessions\n");
    stdoutWrite("─".repeat(48) + "\n");
    if (overall.sessions === 0) {
      stdoutWrite("no sessions recorded yet.\n");
      writeCatalogBaselines();
      writeLedgerSchemaTax(ledger);
      writeExtensionSchemaTax(ledger, currentId?.id);
      return 0;
    }
    stdoutWrite(
      `sessions   ${overall.sessions}  (${overall.successes ?? 0} success, ` +
        `${overall.fails ?? 0} fail, ${overall.abandoned ?? 0} abandoned, ` +
        `${overall.unresolved ?? 0} unresolved)\n`,
    );
    stdoutWrite(`spent      ${fmtUsd(overall.spent_usd)}\n`);
    if ((overall.successes ?? 0) > 0) {
      stdoutWrite(
        `per success ${fmtUsd((overall.spent_usd ?? 0) / (overall.successes as number))}\n`,
      );
    }

    const recent = ledger.db
      .prepare(
        `SELECT id, brief, started_utc, ended_utc, outcome, outcome_source, total_cost_usd
         FROM sessions ORDER BY started_utc DESC LIMIT 10`,
      )
      .all() as SessionRow[];

    stdoutWrite("\nrecent sessions\n");
    for (const row of recent) {
      const outcome = outcomeLabel(row.outcome, row.outcome_source, row.ended_utc);
      const brief = row.brief ?? "(no brief)";
      stdoutWrite(
        `  ${row.started_utc}  ${fmtUsd(row.total_cost_usd)}  ${outcome.padEnd(28)}  ${brief}\n`,
      );
    }

    writeCatalogBaselines();
    writeLedgerSchemaTax(ledger);
    writeExtensionSchemaTax(ledger, currentId?.id);
    writePriceBasisBreakdown(ledger);

    return 0;
  } finally {
    ledger.close();
  }
}
