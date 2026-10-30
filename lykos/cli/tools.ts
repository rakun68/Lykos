// `lykos tools` — the report that makes residency a measured decision rather
// than a taste decision.
//
// It is a REPORTER and it changes nothing (plan D1). No flag on it demotes,
// promotes or deletes a tool. ADR-0014's kill criterion is worded `suggests`,
// and the whole point of the narrowing recorded there is that a human decides:
// a tool that is never called costs its schema, the transport already takes
// that to zero, so nothing here has to delete anything to satisfy the
// criterion.
//
// Three sections (plan D2):
//   registry  every row, with residency, prompt presence, risk tier and
//             whether it is wired yet.
//   cost      measured schema tokens per tool, the RESIDENT total that rides
//             every request, and the MOUNTED total that rides none. Both,
//             always — a reader who sees only one cannot tell which kind of
//             surface grew, which is exactly the question the phase's
//             schema-tax criterion turns on.
//   use       dispatch counts over a window, with the wire identity and the
//             actual identity in SEPARATE columns (plan D3).
//
// Two rules bind harder here than anywhere else in the CLI:
//
// **`unmeasured` is a value this report prints** (plan D4, AGENTS.md rule 4).
// A window with no rows, a tool with no catalog entry and a session that
// predates a column each print `unmeasured`. None of them prints 0. A reader
// must always be able to tell "zero uses" from "no data", because arming a
// demotion suggestion against absence of evidence is precisely the mistake
// rule 4 exists to prevent.
//
// **The two identities are never summed** (plan D3). A transport dispatch has
// two names — `tool_call` on the wire and, say, `lsp` underneath — and
// `tool_call` being the busiest name in the ledger is not the same claim as
// the tool it dispatched being busy. Collapsing them would hide exactly what
// this report exists to show.
//
// One further rule, forced by the ledger rather than chosen: **each identity
// column is fed by ONE source, never by two summed.** `sessions.tool_call_counts`
// and `calls.wire_tool_name` both record the wire name, and on a ledger that
// carries both they describe the same dispatches — adding them would double
// count a real event into a fabricated number. So the wire column takes the
// session tally when the window has one and the per-call column otherwise, and
// the report names which source it used.

import { existsSync } from "node:fs";

import { openLedgerSync, type Ledger } from "../ledger/use.js";
import {
  SCHEMA_TOKENS_BASIS,
  formatShare,
  measureToolset,
  schemaShareOfPrompt,
} from "../ledger/tool-schema.js";
import {
  DEFAULT_RESIDENT_TOOLS,
  RUNTIME_AVAILABLE_TOOLS,
  TOOL_REGISTRY,
  type PromptPresence,
  type ToolRegistryEntry,
  type ToolResidency,
} from "../tools/tool-surface.js";
import { resolveStandaloneTools } from "../tools/session-tools.js";
import type { RiskTier } from "../tools/tool-risk.js";
import { stdoutWrite } from "../tui/io-mode.js";
import { pad } from "../tui/format.js";

/** The one string this report prints where it has no measurement. Never "0", never "-". */
export const UNMEASURED = "unmeasured";

/** ADR-0014's kill criterion is stated in ninety days, so that is the default window. */
export const DEFAULT_WINDOW_DAYS = 90;

export interface ToolsOptions {
  /** "<N>d", e.g. "7d". Defaults to DEFAULT_WINDOW_DAYS. */
  since?: string;
}

export interface RegistryRow {
  name: string;
  residency: ToolResidency;
  promptPresence: PromptPresence;
  riskTier: RiskTier;
  /** Whether the tool is reachable at runtime yet (RUNTIME_AVAILABLE_TOOLS). */
  wired: boolean;
  /**
   * Schema tokens for this tool measured ALONE. NULL when the catalog does
   * not know the name — a tool nobody can price is unmeasured, not free.
   *
   * These do NOT sum to a surface total: each is its own canonical payload,
   * with its own array punctuation and its own chars/4 rounding. The totals
   * below are measured over the whole surface for that reason.
   */
  schemaTokens: number | null;
}

export interface SurfaceTotal {
  names: string[];
  count: number;
  /** NULL when any name is unknown to the catalog — a partial sum would read as a complete tax. */
  tokens: number | null;
  unknown: string[];
}

/** Which ledger column fed the wire column. `none` means the window had neither. */
export type WireSource = "sessions.tool_call_counts" | "calls.wire_tool_name" | "none";

/** Which ledger column fed the actual column (D26). `none` means the window had neither. */
export type ActualSource = "sessions.actual_tool_call_counts" | "calls.tool_name" | "none";

export interface DispatchCounts {
  /** Wire identity: the name the runtime dispatched. NULL = no evidence in the window. */
  wire: Record<string, number> | null;
  wireSource: WireSource;
  /** Actual identity: the tool a transport dispatch resolved to. NULL = no evidence in the window. */
  actual: Record<string, number> | null;
  actualSource: ActualSource;
  sessionsInWindow: number;
  sessionsWithWireCounts: number;
  sessionsWithActualCounts: number;
  /** Sessions in the window whose tool_call_counts is NULL — they predate the column. */
  sessionsPredatingColumn: number;
  callsWithWireIdentity: number;
  callsWithActualIdentity: number;
}

export interface DemotionSuggestion {
  /** False when the window carries no dispatch evidence at all; then `names` is empty by rule. */
  measured: boolean;
  names: string[];
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

export function measureRegistry(
  entries: readonly ToolRegistryEntry[] = TOOL_REGISTRY,
  wired: ReadonlySet<string> = RUNTIME_AVAILABLE_TOOLS,
): RegistryRow[] {
  return entries.map((entry) => {
    const alone = measureToolset([entry.name]);
    return {
      name: entry.name,
      residency: entry.residency,
      promptPresence: entry.promptPresence,
      riskTier: entry.risk.tier,
      wired: wired.has(entry.name),
      schemaTokens: alone.complete ? alone.tokens : null,
    };
  });
}

export function surfaceTotal(names: readonly string[]): SurfaceTotal {
  const m = measureToolset(names);
  return { names: [...names], count: m.count, tokens: m.tokens, unknown: m.unknown };
}

/** `unmeasured` when the column has no source at all; the count otherwise, 0 included. */
export function formatCount(map: Record<string, number> | null, name: string): string {
  if (map === null) return UNMEASURED;
  return String(map[name] ?? 0);
}

interface SessionCountsRow {
  tool_call_counts: string | null;
  actual_tool_call_counts: string | null;
}

function parseCounts(json: string | null): Record<string, number> | null {
  if (json === null) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    }
    return out;
  } catch {
    // An unreadable column is not a zero. It is one more thing nobody measured.
    return null;
  }
}

export function readDispatchCounts(ledger: Ledger, fromIso: string, toIso: string): DispatchCounts {
  const sessions = ledger.db
    .prepare(
      `SELECT tool_call_counts, actual_tool_call_counts FROM sessions WHERE started_utc >= ? AND started_utc < ?`,
    )
    .all(fromIso, toIso) as SessionCountsRow[];

  let sessionsWithWireCounts = 0;
  let sessionsPredatingColumn = 0;
  const sessionTally: Record<string, number> = {};
  let sessionsWithActualCounts = 0;
  const sessionActualTally: Record<string, number> = {};
  for (const row of sessions) {
    const actualCounts = parseCounts(row.actual_tool_call_counts);
    if (actualCounts !== null) {
      sessionsWithActualCounts += 1;
      for (const [name, n] of Object.entries(actualCounts)) {
        sessionActualTally[name] = (sessionActualTally[name] ?? 0) + n;
      }
    }
    const counts = parseCounts(row.tool_call_counts);
    if (counts === null) {
      sessionsPredatingColumn += 1;
      continue;
    }
    sessionsWithWireCounts += 1;
    for (const [name, n] of Object.entries(counts)) {
      sessionTally[name] = (sessionTally[name] ?? 0) + n;
    }
  }

  const wireRows = ledger.db
    .prepare(
      `SELECT wire_tool_name AS name, COUNT(*) AS n FROM calls
       WHERE ts_utc >= ? AND ts_utc < ? AND wire_tool_name IS NOT NULL
       GROUP BY wire_tool_name`,
    )
    .all(fromIso, toIso) as Array<{ name: string; n: number }>;
  const callWireTally: Record<string, number> = {};
  let callsWithWireIdentity = 0;
  for (const row of wireRows) {
    callWireTally[row.name] = (callWireTally[row.name] ?? 0) + row.n;
    callsWithWireIdentity += row.n;
  }

  const actualRows = ledger.db
    .prepare(
      `SELECT tool_name AS name, COUNT(*) AS n FROM calls
       WHERE ts_utc >= ? AND ts_utc < ? AND tool_name IS NOT NULL
       GROUP BY tool_name`,
    )
    .all(fromIso, toIso) as Array<{ name: string; n: number }>;
  const actualTally: Record<string, number> = {};
  let callsWithActualIdentity = 0;
  for (const row of actualRows) {
    actualTally[row.name] = (actualTally[row.name] ?? 0) + row.n;
    callsWithActualIdentity += row.n;
  }

  // One source, never two summed — see the module comment.
  const wireSource: WireSource =
    sessionsWithWireCounts > 0
      ? "sessions.tool_call_counts"
      : callsWithWireIdentity > 0
        ? "calls.wire_tool_name"
        : "none";
  const wire =
    wireSource === "sessions.tool_call_counts"
      ? sessionTally
      : wireSource === "calls.wire_tool_name"
        ? callWireTally
        : null;
  // The same rule for the actual identity: the session tally when the window
  // has one, the per-call column otherwise, never both.
  const actualSource: ActualSource =
    sessionsWithActualCounts > 0
      ? "sessions.actual_tool_call_counts"
      : callsWithActualIdentity > 0
        ? "calls.tool_name"
        : "none";
  const actual =
    actualSource === "sessions.actual_tool_call_counts"
      ? sessionActualTally
      : actualSource === "calls.tool_name"
        ? actualTally
        : null;

  return {
    wire,
    wireSource,
    actual,
    actualSource,
    sessionsInWindow: sessions.length,
    sessionsWithWireCounts,
    sessionsWithActualCounts,
    sessionsPredatingColumn,
    callsWithWireIdentity,
    callsWithActualIdentity,
  };
}

/**
 * Plan D5. Computed from the ledger, never from a config list.
 *
 * A tool is named only when it is RESIDENT (there is somewhere to demote it
 * to), WIRED (an unwired tool could not have been dispatched, so its zero
 * says nothing about demand) and MEASURED at zero. A tool with no data is not
 * named at all: absence of evidence is the thing `unmeasured` exists to keep
 * separate, and it is not evidence of absence.
 *
 * The wire column is the right identity for a resident tool, because a
 * resident tool rides the wire under its own name. The actual column is still
 * consulted, but only to VETO: a tool something dispatched is never named
 * unused, whichever column saw it.
 */
export function suggestDemotions(
  rows: readonly RegistryRow[],
  counts: DispatchCounts,
): DemotionSuggestion {
  if (counts.wire === null) return { measured: false, names: [] };
  const wire = counts.wire;
  const actual = counts.actual;
  const names = rows
    .filter((row) => row.residency === "resident" && row.wired)
    .filter((row) => (wire[row.name] ?? 0) === 0 && (actual?.[row.name] ?? 0) === 0)
    .map((row) => row.name);
  return { measured: true, names };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const NAME_W = 22;
const WIRE_W = 10;
const ACTUAL_W = 12;

function padStart(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

function tokensText(tokens: number | null): string {
  return tokens === null ? UNMEASURED : String(tokens);
}

/** "7d" -> 7. Whole days only, the same shape `lykos cost --since` accepts. */
function parseSinceDays(since: string): number | null {
  const m = /^(\d+)d$/.exec(since.trim());
  if (!m) return null;
  const days = Number(m[1]);
  return days > 0 ? days : null;
}

function writeRegistrySection(rows: readonly RegistryRow[]): void {
  const wired = rows.filter((r) => r.wired).length;
  stdoutWrite(`\nregistry — ${rows.length} row(s), ${wired} wired\n`);
  stdoutWrite(
    `  ${pad("tool", NAME_W)}${pad("residency", 11)}${pad("prompt", 9)}${pad("risk", 13)}${pad("wired", 7)}${padStart("schema", 8)}\n`,
  );
  for (const row of rows) {
    stdoutWrite(
      `  ${pad(row.name, NAME_W)}${pad(row.residency, 11)}${pad(row.promptPresence, 9)}` +
        `${pad(row.riskTier, 13)}${pad(row.wired ? "yes" : "no", 7)}${padStart(tokensText(row.schemaTokens), 8)}\n`,
    );
  }
  stdoutWrite(
    `  schema is each tool measured ALONE (basis ${SCHEMA_TOKENS_BASIS}); a name the catalog\n` +
      `  does not know prints ${UNMEASURED}, and the per-tool figures deliberately do not sum to\n` +
      "  a surface total — each is its own canonical payload, measured separately below.\n",
  );
}

interface SchemaLedgerRow {
  calls: number;
  measured: number | null;
  sum_schema: number | null;
  sum_prompt: number | null;
}

function writeCostSection(ledger: Ledger | null, fromIso: string, toIso: string): void {
  const standalone = surfaceTotal(resolveStandaloneTools({}));
  const worker = surfaceTotal(DEFAULT_RESIDENT_TOOLS);
  const mounted = surfaceTotal(
    TOOL_REGISTRY.filter((e) => e.residency === "mounted" && RUNTIME_AVAILABLE_TOOLS.has(e.name)).map(
      (e) => e.name,
    ),
  );

  const surfaceLine = (label: string, total: SurfaceTotal, note: string): string =>
    `  ${pad(label, 24)}${padStart(tokensText(total.tokens), 10)} tokens over ${padStart(String(total.count), 2)} tool(s)   ${note}\n`;

  stdoutWrite("\ncost — what a request actually carries, measured now\n");
  stdoutWrite(surfaceLine("resident (standalone)", standalone, "— rides EVERY request"));
  stdoutWrite(surfaceLine("resident (worker)", worker, "— rides every delegate request"));
  stdoutWrite(surfaceLine("mounted catalog", mounted, "— rides NO request"));
  stdoutWrite(
    "  Both totals are printed on purpose: a reader who sees only one cannot tell which\n" +
      "  kind of surface grew. Mounted tools are reached through tool_call, so their schemas\n" +
      "  are never on the wire.\n",
  );

  if (ledger === null) {
    stdoutWrite(`  ${pad("share of prompt", 24)}${UNMEASURED} (no ledger to read)\n`);
  } else {
    const row = ledger.db
      .prepare(
        `SELECT COUNT(*) AS calls,
                SUM(tool_schema_tokens IS NOT NULL) AS measured,
                SUM(tool_schema_tokens) AS sum_schema,
                SUM(CASE WHEN tool_schema_tokens IS NOT NULL
                         THEN input_tokens + cache_read_tokens END) AS sum_prompt
           FROM calls WHERE ts_utc >= ? AND ts_utc < ?`,
      )
      .get(fromIso, toIso) as SchemaLedgerRow;
    const measured = row.measured ?? 0;
    if (measured === 0) {
      stdoutWrite(
        `  ${pad("share of prompt", 24)}${UNMEASURED} (no call in the window recorded tool_schema_tokens)\n`,
      );
    } else {
      // `schemaShareOfPrompt` sums its last two arguments; the denominator is
      // already summed here, so it is passed as the input term with 0 cache —
      // the same call `lykos cost` makes, for the same reason.
      const share = schemaShareOfPrompt(row.sum_schema ?? null, row.sum_prompt ?? 0, 0);
      stdoutWrite(
        `  ${pad("share of prompt", 24)}${formatShare(share?.share ?? null)}` +
          `  (schema / (input + cache_read) over ${measured} measured call(s) of ${row.calls})\n`,
      );
    }
  }
  stdoutWrite(
    `  ${pad("basis", 24)}${SCHEMA_TOKENS_BASIS} — a local measurement of the wire\n` +
      "  payload, comparable across toolsets and never billed as cost.\n",
  );
}

function writeUseSection(
  rows: readonly RegistryRow[],
  counts: DispatchCounts,
  days: number,
  fromIso: string,
  toIso: string,
): void {
  stdoutWrite(
    `\nuse — dispatches in the last ${days} day(s)  (${fromIso.slice(0, 10)} .. ${toIso.slice(0, 10)})\n`,
  );
  stdoutWrite(
    "  wire    the name the runtime dispatched\n" +
      "  actual  the tool a transport dispatch resolved to\n" +
      "  Two columns, never one sum: `tool_call` being the busiest name on the wire is not\n" +
      "  the same claim as the tool it dispatched being busy.\n",
  );
  stdoutWrite(
    `  wire source  ${counts.wireSource === "none" ? `${UNMEASURED} — neither column carried a wire name in this window` : counts.wireSource}\n` +
      `  actual source ${counts.actualSource === "none" ? `${UNMEASURED} — neither column carried an actual name in this window` : counts.actualSource}\n`,
  );
  stdoutWrite(
    `  coverage     ${counts.sessionsInWindow} session(s) in window; ${counts.sessionsWithWireCounts} carry wire counts; ` +
      `${counts.sessionsPredatingColumn} predate the column (${UNMEASURED}, not zero)\n` +
      `               ${counts.callsWithActualIdentity} call(s) carry an actual identity; ` +
      `${counts.callsWithWireIdentity} carry a wire identity\n`,
  );

  stdoutWrite(`  ${pad("tool", NAME_W)}${padStart("wire", WIRE_W)}${padStart("actual", ACTUAL_W)}\n`);
  for (const row of rows) {
    if (!row.wired) continue;
    stdoutWrite(
      `  ${pad(row.name, NAME_W)}${padStart(formatCount(counts.wire, row.name), WIRE_W)}` +
        `${padStart(formatCount(counts.actual, row.name), ACTUAL_W)}\n`,
    );
  }

  const known = new Set(rows.map((r) => r.name));
  const extra = [
    ...new Set([...Object.keys(counts.wire ?? {}), ...Object.keys(counts.actual ?? {})]),
  ]
    .filter((name) => !known.has(name))
    .sort();
  if (extra.length > 0) {
    stdoutWrite("  not in the registry (seen in the ledger, no row in TOOL_REGISTRY):\n");
    for (const name of extra) {
      stdoutWrite(
        `  ${pad(name, NAME_W)}${padStart(formatCount(counts.wire, name), WIRE_W)}` +
          `${padStart(formatCount(counts.actual, name), ACTUAL_W)}\n`,
      );
    }
  }
}

function writeSuggestionSection(
  suggestion: DemotionSuggestion,
  days: number,
  counts: DispatchCounts,
): void {
  stdoutWrite(`\nninety-day suggestion — the phase's armed kill criterion (ADR-0014)\n`);
  if (!suggestion.measured) {
    stdoutWrite(
      `  ${UNMEASURED} — no session in the last ${days} day(s) recorded dispatch counts, so nothing\n` +
        "  is named. Absence of evidence is not evidence of absence (AGENTS.md rule 4).\n",
    );
    return;
  }

  // How THIN the evidence is belongs next to the names. A suggestion resting
  // on one session that ran no tools at all is a different claim from the same
  // suggestion resting on a month of work, and the reader deciding whether to
  // act on it is the one who needs to be able to tell.
  const dispatches = Object.values(suggestion.measured ? (counts.wire ?? {}) : {}).reduce(
    (a, b) => a + b,
    0,
  );
  stdoutWrite(
    `  evidence   ${counts.sessionsWithWireCounts} of ${counts.sessionsInWindow} session(s) in the window carry wire\n` +
      `             counts, recording ${dispatches} dispatch(es) between them.\n`,
  );
  if (dispatches === 0) {
    stdoutWrite(
      "  Every measured session in this window ran no tools at all, so the rule below names the\n" +
        "  whole resident surface. That is the rule working rather than a finding about any tool:\n" +
        "  widen the window, or do some work, before acting on it.\n",
    );
  }

  if (suggestion.names.length === 0) {
    stdoutWrite(`  every wired resident tool was dispatched at least once in the last ${days} day(s).\n`);
    return;
  }
  stdoutWrite(`  ${suggestion.names.length} resident tool(s) had no dispatch in the window:\n`);
  for (const name of suggestion.names) {
    stdoutWrite(`    ${name}\n`);
  }
  stdoutWrite(
    '  To demote one, a human edits its row in lykos/tools/tool-surface.ts and sets\n' +
      '  residency: "mounted" — or drops it for a single session with tools_remove in a\n' +
      "  specialist. Nothing was demoted, deleted or changed by this command: ADR-0014 words\n" +
      "  the criterion as SUGGESTS, and a human decides.\n",
  );
}

export function runTools(ledgerPath: string, opts: ToolsOptions = {}): number {
  const days = opts.since === undefined ? DEFAULT_WINDOW_DAYS : parseSinceDays(opts.since);
  if (days === null) {
    stdoutWrite(`lykos tools --since: expected "<N>d" (e.g. "7d"), got "${opts.since}"\n`);
    return 1;
  }

  const now = new Date();
  const toIso = now.toISOString();
  const fromIso = new Date(now.getTime() - days * 86_400_000).toISOString();

  const rows = measureRegistry();

  stdoutWrite("lykos tools — the registry, what it costs, and what it was used for\n");
  stdoutWrite("─".repeat(72) + "\n");
  stdoutWrite("This command reports. It demotes nothing, promotes nothing and deletes nothing.\n");

  const hasLedger = existsSync(ledgerPath);
  if (!hasLedger) {
    stdoutWrite(`no ledger at ${ledgerPath} yet — the use section has nothing to read.\n`);
    writeRegistrySection(rows);
    writeCostSection(null, fromIso, toIso);
    const empty: DispatchCounts = {
      wire: null,
      wireSource: "none",
      actual: null,
      actualSource: "none",
      sessionsInWindow: 0,
      sessionsWithWireCounts: 0,
      sessionsWithActualCounts: 0,
      sessionsPredatingColumn: 0,
      callsWithWireIdentity: 0,
      callsWithActualIdentity: 0,
    };
    writeUseSection(rows, empty, days, fromIso, toIso);
    writeSuggestionSection(suggestDemotions(rows, empty), days, empty);
    return 0;
  }

  const ledger = openLedgerSync(ledgerPath);
  try {
    writeRegistrySection(rows);
    writeCostSection(ledger, fromIso, toIso);
    const counts = readDispatchCounts(ledger, fromIso, toIso);
    writeUseSection(rows, counts, days, fromIso, toIso);
    writeSuggestionSection(suggestDemotions(rows, counts), days, counts);
    return 0;
  } finally {
    ledger.close();
  }
}
