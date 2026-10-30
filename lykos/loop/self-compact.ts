// Self-compact, part 1: the gauge, and part 2: the handoff's records.
//
// The pure half of the `lykos-self-compact` default extension: the tier table,
// its validation, the lookup that turns a model's context window into three
// thresholds, the level a token count sits at, the boundary (one env var)
// between the session that resolves configuration and the extension that reads
// it, and the shape of what the extension records about each handoff and each
// compaction. Nothing here touches Pi, a session or the ledger.
//
// **The tier table** (spec, "The tier table"). A model's window maps to the
// LARGEST tier at or below it (story 48), so a 131 072-token model is a 128k
// model and a 180k one is a 128k one too. Below the smallest tier self-compact
// is off (story 51) and Pi's own compaction is in charge. Every shipped value
// is a starting setting and is unmeasured.
//
// **Token counts are decimal.** `64k` is 64 000 and `1M` is 1 000 000, because
// a provider that advertises "1M" reports 1 000 000 or 1 048 576 and both must
// land in the 1M tier; a binary `1M` would drop a 1 000 000 model to 500k.
//
// **Validation refuses, it never repairs** (story 53). A table whose rows are
// out of order, whose thresholds are not notice < warning < cutoff <= window,
// or in which a larger tier would compact earlier than a smaller one (story
// 52, "monotone") is refused at startup with the offending value named — a
// typo must not silently switch the mechanism off.
//
// **Overrides sit on top** (story 50): `self_compact.models.<model>` and then
// `self_compact.specialists.<specialist>`, each a whole notice/warning/cutoff
// triple, the specialist winning because it is the narrower choice. An override
// replaces a tier's thresholds; it never switches self-compact on below the
// smallest tier.

import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { parseMethodOrder, type CompactionMethod, type CompactionUsage, type FellThrough } from "./compaction-chain.js";

export type { CompactionUsage } from "./compaction-chain.js";
import { SELF_COMPACT_SECTION_LIST, type SelfCompactSection } from "./self-compact-template.js";

/** One row of the tier table. Every value is a token count. */
export interface SelfCompactTier {
  /** The smallest context window this row applies to. */
  window: number;
  notice: number;
  warning: number;
  cutoff: number;
}

export interface SelfCompactThresholds {
  notice: number;
  warning: number;
  cutoff: number;
}

/** `self_compact:` after validation. */
export interface SelfCompactTable {
  /** Ascending by `window`, monotone in every threshold. */
  tiers: SelfCompactTier[];
  /** T157: the recent context every compaction keeps, in tokens (`self_compact.keep_recent_tokens`). */
  keepRecentTokens: number;
  /** Keyed by `provider/model` or bare model id. */
  models: Record<string, SelfCompactThresholds>;
  /** Keyed by specialist name. */
  specialists: Record<string, SelfCompactThresholds>;
}

/** The spec's table (Q18, Q23), decimal k and M. Unmeasured starting values. */
export const DEFAULT_SELF_COMPACT_TIERS: readonly SelfCompactTier[] = [
  { window: 64_000, notice: 24_000, warning: 32_000, cutoff: 44_000 },
  { window: 128_000, notice: 30_000, warning: 60_000, cutoff: 90_000 },
  { window: 200_000, notice: 50_000, warning: 100_000, cutoff: 135_000 },
  { window: 256_000, notice: 60_000, warning: 120_000, cutoff: 160_000 },
  { window: 400_000, notice: 90_000, warning: 180_000, cutoff: 240_000 },
  { window: 500_000, notice: 120_000, warning: 240_000, cutoff: 310_000 },
  { window: 1_000_000, notice: 120_000, warning: 240_000, cutoff: 320_000 },
  { window: 2_000_000, notice: 120_000, warning: 240_000, cutoff: 320_000 },
];

/** The name of the tool that shows the agent its own usage and thresholds (story 46). */
export const CONTEXT_USAGE_TOOL_NAME = "context_usage";

/** T152: the tool that takes a note to self, compacts once idle, and returns the note word for word (stories 43, 44). */
export const SELF_COMPACT_TOOL_NAME = "self_compact";

/** T189: the note's sections as the prompts below name them; the template file owns the list. */
const NOTE_SHAPE = `under the \`##\` headings ${SELF_COMPACT_SECTION_LIST}`;

/** T152: the Pi command that asks the agent to self-compact now (story 57): `/self-compact`. */
export const SELF_COMPACT_COMMAND = "self-compact";

/** The resolved policy, as JSON, for the extension to read at load. */
export const SELF_COMPACT_POLICY_ENV = "LYKOS_SELF_COMPACT_POLICY";

/** Where the guidance prompts are read from, relative to the project and to the home directory (story 56). */
export const SELF_COMPACT_PROMPTS_DIR = [".lykos", "prompts", "self-compact"] as const;

export class SelfCompactConfigError extends Error {
  constructor(message: string) {
    super(`lykos: invalid self_compact configuration: ${message}`);
    this.name = "SelfCompactConfigError";
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * A token count as configuration writes it: an integer, or a string such as
 * `64k`, `1.5M` or `128000`. Returns undefined for anything else.
 */
/**
 * T157: `self_compact.keep_recent_tokens`' default — Pi's own
 * (`compaction.keepRecentTokens`, 20000 in the installed Pi).
 * A starting setting, unmeasured.
 */
export const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

export function parseTokenCount(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : undefined;
  if (typeof value !== "string") return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(value);
  if (m === null) return undefined;
  const scale = m[2] === "" ? 1 : m[2]!.toLowerCase() === "k" ? 1_000 : 1_000_000;
  const n = Number(m[1]) * scale;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function show(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : JSON.stringify(value) ?? String(value);
}

function count(raw: Record<string, unknown>, key: string, path: string): number {
  const v = parseTokenCount(raw[key]);
  if (v === undefined) {
    throw new SelfCompactConfigError(
      `${path}.${key} is ${show(raw[key])}; expected a positive token count such as 30000 or "30k"`,
    );
  }
  return v;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function thresholds(raw: unknown, path: string): SelfCompactThresholds {
  if (!isRecord(raw)) throw new SelfCompactConfigError(`${path} is ${show(raw)}; expected { notice, warning, cutoff }`);
  const t = { notice: count(raw, "notice", path), warning: count(raw, "warning", path), cutoff: count(raw, "cutoff", path) };
  if (t.warning <= t.notice) {
    throw new SelfCompactConfigError(`${path}.warning is ${t.warning}, which is not above notice ${t.notice}`);
  }
  if (t.cutoff <= t.warning) {
    throw new SelfCompactConfigError(`${path}.cutoff is ${t.cutoff}, which is not above warning ${t.warning}`);
  }
  return t;
}

function overrides(raw: unknown, path: string): Record<string, SelfCompactThresholds> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new SelfCompactConfigError(`${path} is ${show(raw)}; expected a map of name to thresholds`);
  const out: Record<string, SelfCompactThresholds> = {};
  for (const [name, value] of Object.entries(raw)) out[name] = thresholds(value, `${path}.${name}`);
  return out;
}

/**
 * `self_compact:` as configuration wrote it, validated. Throws
 * `SelfCompactConfigError` naming the first wrong value.
 */
export function validateSelfCompactConfig(raw: unknown): SelfCompactTable {
  if (raw === undefined || raw === null) {
    return {
      tiers: DEFAULT_SELF_COMPACT_TIERS.map((t) => ({ ...t })),
      models: {},
      specialists: {},
      keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
    };
  }
  if (!isRecord(raw)) throw new SelfCompactConfigError(`self_compact is ${show(raw)}; expected a section`);
  for (const key of Object.keys(raw)) {
    if (!["tiers", "models", "specialists", "keep_recent_tokens"].includes(key)) {
      throw new SelfCompactConfigError(
        `self_compact.${key} is not a setting; expected tiers, models, specialists or keep_recent_tokens`,
      );
    }
  }
  const keepRecentTokens =
    raw.keep_recent_tokens === undefined ? DEFAULT_KEEP_RECENT_TOKENS : count(raw, "keep_recent_tokens", "self_compact");
  const tiers: SelfCompactTier[] = [];
  if (raw.tiers === undefined) {
    tiers.push(...DEFAULT_SELF_COMPACT_TIERS.map((t) => ({ ...t })));
  } else {
    if (!Array.isArray(raw.tiers) || raw.tiers.length === 0) {
      throw new SelfCompactConfigError(`self_compact.tiers is ${show(raw.tiers)}; expected a non-empty list of rows`);
    }
    raw.tiers.forEach((row: unknown, i: number) => {
      const path = `self_compact.tiers[${i}]`;
      if (!isRecord(row)) throw new SelfCompactConfigError(`${path} is ${show(row)}; expected { window, notice, warning, cutoff }`);
      const window = count(row, "window", path);
      const t = thresholds(row, path);
      if (t.cutoff > window) {
        throw new SelfCompactConfigError(`${path}.cutoff is ${t.cutoff}, which is above its window ${window}`);
      }
      const prev = tiers[tiers.length - 1];
      if (prev !== undefined) {
        if (window <= prev.window) {
          throw new SelfCompactConfigError(
            `${path}.window is ${window}, which is not above the previous tier's ${prev.window}; list tiers smallest first`,
          );
        }
        for (const k of ["notice", "warning", "cutoff"] as const) {
          if (t[k] < prev[k]) {
            throw new SelfCompactConfigError(
              `${path}.${k} is ${t[k]}, below the smaller tier's ${prev[k]}; a larger tier may never compact earlier`,
            );
          }
        }
      }
      tiers.push({ window, ...t });
    });
  }
  return {
    tiers,
    models: overrides(raw.models, "self_compact.models"),
    specialists: overrides(raw.specialists, "self_compact.specialists"),
    keepRecentTokens,
  };
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/** The largest tier at or below `contextWindow`; undefined below the smallest, which is "off". */
export function lookupTier(tiers: readonly SelfCompactTier[], contextWindow: number): SelfCompactTier | undefined {
  let found: SelfCompactTier | undefined;
  for (const t of tiers) if (t.window <= contextWindow && (found === undefined || t.window > found.window)) found = t;
  return found;
}

export type ThresholdSource = "tier" | "model" | "specialist";

export interface ResolvedSelfCompact {
  tier: SelfCompactTier;
  thresholds: SelfCompactThresholds;
  /** Which layer the thresholds came from. */
  source: ThresholdSource;
}

/** `provider/id` and bare `id`, the two ways configuration can name a model. */
function modelOverride(
  models: Record<string, SelfCompactThresholds>,
  model: { provider?: string; id?: string } | undefined,
): SelfCompactThresholds | undefined {
  if (model?.id === undefined) return undefined;
  if (model.provider !== undefined) {
    const qualified = models[`${model.provider}/${model.id}`];
    if (qualified !== undefined) return qualified;
  }
  return models[model.id];
}

/**
 * The thresholds for one model on one window, or undefined when self-compact
 * is off for it (a window below the smallest tier).
 */
export function resolveSelfCompact(
  table: SelfCompactTable,
  input: { contextWindow: number; model?: { provider?: string; id?: string }; specialist?: string },
): ResolvedSelfCompact | undefined {
  const tier = lookupTier(table.tiers, input.contextWindow);
  if (tier === undefined) return undefined;
  const specialist = input.specialist !== undefined ? table.specialists[input.specialist] : undefined;
  if (specialist !== undefined) return { tier, thresholds: specialist, source: "specialist" };
  const model = modelOverride(table.models, input.model);
  if (model !== undefined) return { tier, thresholds: model, source: "model" };
  return { tier, thresholds: { notice: tier.notice, warning: tier.warning, cutoff: tier.cutoff }, source: "tier" };
}

/** Where a token count stands. Ordered: each level implies the ones before it. */
export type SelfCompactLevel = "below" | "notice" | "warning" | "cutoff";

const LEVEL_RANK: Record<SelfCompactLevel, number> = { below: 0, notice: 1, warning: 2, cutoff: 3 };

export function levelRank(level: SelfCompactLevel): number {
  return LEVEL_RANK[level];
}

export function levelFor(tokens: number, t: SelfCompactThresholds): SelfCompactLevel {
  if (tokens >= t.cutoff) return "cutoff";
  if (tokens >= t.warning) return "warning";
  if (tokens >= t.notice) return "notice";
  return "below";
}

/** `64000` → `64k`, `1000000` → `1M`: how a tier is named to the agent and in `lykos show`. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000 && n % 100_000 === 0) return `${n / 1_000_000}M`;
  if (n >= 1_000 && n % 1_000 === 0) return `${n / 1_000}k`;
  return String(n);
}

// ---------------------------------------------------------------------------
// Guidance prompts
// ---------------------------------------------------------------------------

/**
 * The shipped notice. A file at `.lykos/prompts/self-compact/notice.md` (the
 * project's, then the home directory's) replaces it. Placeholders:
 * `{tokens}`, `{window}`, `{tier}`, `{notice}`, `{warning}`, `{cutoff}`.
 */
export const DEFAULT_NOTICE_PROMPT =
  "[self-compact notice] Your context holds about {tokens} tokens of a {window}-token window ({tier} tier). " +
  "This is information, not an instruction to stop: carry on with the task. At {warning} tokens you will be asked " +
  "to finish your current step, write a note to self and call self_compact; past {cutoff} tokens only self_compact will run. " +
  "Call context_usage whenever you want the current figures.";

/** The shipped warning; `.lykos/prompts/self-compact/warning.md` replaces it. Same placeholders. */
export const DEFAULT_WARNING_PROMPT =
  "[self-compact warning] Your context holds about {tokens} tokens of a {window}-token window ({tier} tier), past " +
  "the {warning}-token warning line. Finish the step you are on, then write a note to self " +
  `${NOTE_SHAPE} — and call self_compact with it. The ` +
  "note comes back to you word for word after compaction. Past {cutoff} tokens every tool but self_compact is refused.";

export interface GuidanceVars {
  tokens: number;
  window: number;
  tier: SelfCompactTier;
  thresholds: SelfCompactThresholds;
}

/** Fills a prompt's placeholders. An unknown placeholder is left as written. */
export function renderGuidance(template: string, v: GuidanceVars): string {
  const values: Record<string, string> = {
    tokens: String(v.tokens),
    window: String(v.window),
    tier: formatTokens(v.tier.window),
    notice: String(v.thresholds.notice),
    warning: String(v.thresholds.warning),
    cutoff: String(v.thresholds.cutoff),
  };
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
}

// ---------------------------------------------------------------------------
// The boundary between the session and the extension
// ---------------------------------------------------------------------------

export interface SelfCompactPolicy {
  /** True only when `self-compact` is the active context strategy of a top-level session. */
  enabled: boolean;
  table: SelfCompactTable;
  /** The session's specialist, for `self_compact.specialists`. */
  specialist?: string;
  /**
   * T190: `compaction.method_order`, parsed. Absent means the default order.
   * The extension tries these when a compaction runs.
   */
  methodOrder?: CompactionMethod[];
  /**
   * The Pi settings the live agent was built with that the handoff side call
   * repeats (`thinkingBudgets`, `transport`): an extension has no handle on
   * Pi's settings manager, so the session carries them across with the rest.
   */
  thinkingBudgets?: NonNullable<ReturnType<SettingsManager["getThinkingBudgets"]>>;
  transport?: ReturnType<SettingsManager["getTransport"]>;
}

export function encodeSelfCompactPolicyEnv(policy: SelfCompactPolicy): string {
  // The table crosses in its configuration shape, because the extension reads
  // it back through `validateSelfCompactConfig` — the one validator.
  const { keepRecentTokens, ...rest } = policy.table;
  return JSON.stringify({ ...policy, table: { ...rest, keep_recent_tokens: keepRecentTokens } });
}

function decodeLiveRequestSettings(p: Record<string, unknown>): Pick<SelfCompactPolicy, "thinkingBudgets" | "transport"> {
  const out: Pick<SelfCompactPolicy, "thinkingBudgets" | "transport"> = {};
  const tb = p.thinkingBudgets;
  if (tb !== null && typeof tb === "object") {
    const budgets: NonNullable<SelfCompactPolicy["thinkingBudgets"]> = {};
    for (const level of ["minimal", "low", "medium", "high"] as const) {
      const v = (tb as Record<string, unknown>)[level];
      if (typeof v === "number" && Number.isFinite(v)) budgets[level] = v;
    }
    out.thinkingBudgets = budgets;
  }
  const transports: readonly NonNullable<SelfCompactPolicy["transport"]>[] = ["sse", "websocket", "websocket-cached", "auto"];
  const transport = transports.find((t) => t === p.transport);
  if (transport !== undefined) out.transport = transport;
  return out;
}

/** Null on anything malformed — the extension then does nothing, which is Pi in charge. */
export function decodeSelfCompactPolicyEnv(raw: string | undefined): SelfCompactPolicy | null {
  if (raw === undefined || raw === "") return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (typeof p.enabled !== "boolean") return null;
    const table = validateSelfCompactConfig(p.table);
    return {
      enabled: p.enabled,
      table,
      ...(typeof p.specialist === "string" ? { specialist: p.specialist } : {}),
      methodOrder: parseMethodOrder(p.methodOrder).order,
      ...decodeLiveRequestSettings(p),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// T152: the handoff's records
// ---------------------------------------------------------------------------

/** The `appendEntry` type every handoff and compaction record is written under. */
export const SELF_COMPACT_ENTRY_TYPE = "lykos-self-compact";

/** The custom message that returns the note to the agent after compaction. */
export const SELF_COMPACT_NOTE_TYPE = "lykos-self-compact-note";

/** The custom message `/self-compact` sends the agent. */
export const SELF_COMPACT_REQUEST_TYPE = "lykos-self-compact-request";

/**
 * Where the host copies every record as it is appended, one JSON object per
 * line, in the session directory beside `tasks.json` and `post-edit.jsonl` —
 * so a resumed session can finish a handoff its predecessor left open.
 */
export const SELF_COMPACT_RECORD_FILE = "self-compact.jsonl";

/** Compaction attempts in a row before the handoff waits for the next idle moment. */
export const SELF_COMPACT_MAX_ATTEMPTS = 3;

/**
 * One handoff: the note, and how far it got. `pending` — saved, not yet
 * compacted; `compacted` — compacted, note not yet returned; `delivered` —
 * the note is back in the agent's context, which ends the handoff. Every
 * change of phase is a new record with the same `id`; the last one wins.
 */
export interface HandoffRecord {
  kind: "handoff";
  id: string;
  phase: "pending" | "compacted" | "delivered";
  note: string;
  /** T189: the template sections the note leaves out; absent when it has them all. The note is kept either way. */
  missing_sections?: SelfCompactSection[];
  /** Who started it: the agent on its own, or the person through `/self-compact`. */
  trigger: "agent" | "command";
  ts: string;
  /**
   * On `delivered`: after this session's own compaction; on resuming a
   * session whose context was rebuilt from disk; or `uncompacted` when Pi
   * declined to compact (nothing to cut) and the note was returned anyway.
   */
  via?: "compaction" | "resume" | "uncompacted";
}

/** Why a compaction ran: a handoff's (`agent`/`command`), or Pi's own underneath (`manual`, `pi-threshold`, `pi-overflow`). */
export type CompactionTrigger = "agent" | "command" | "manual" | "pi-threshold" | "pi-overflow";

/** One compaction attempt, as the ledger's `compactions` table stores it (story 54). */
export interface CompactionRecord extends CompactionUsage {
  kind: "compaction";
  /** Unique per attempt: the ledger's key, so a second ingest adds nothing. */
  id: string;
  handoff_id?: string;
  trigger: CompactionTrigger;
  /** The active context strategy. Always `self-compact` today: only this extension writes the record. */
  strategy: "self-compact";
  /** `provider/model`, or null when the session had none. */
  model: string | null;
  /** The self-compact tier, e.g. `128k`; null when none applied. */
  tier: string | null;
  context_window: number | null;
  /** The context the gauge measured when the attempt started (Pi's own figure for Pi's compactions); null when unknown. */
  tokens_before: number | null;
  /** Pi's estimate of the context after a successful compaction; null otherwise. */
  tokens_after: number | null;
  result: "ok" | "failed" | "cancelled";
  error?: string;
  /** 1 for a handoff's first attempt; Pi's own compactions are always 1. */
  attempt: number;
  ts: string;
  /** T190: the chain method that ran (or, for a failed row, was running). Absent on a record written before the chain. */
  method?: CompactionMethod;
  /** T190: the methods tried before it, each with why it fell through. */
  fell_through?: FellThrough[];
}

/** A provider usage report as a record's figures; all null when the compaction reported none. */
export function compactionUsage(
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number } | undefined,
): CompactionUsage {
  return {
    input_tokens: usage?.input ?? null,
    output_tokens: usage?.output ?? null,
    cache_read_tokens: usage?.cacheRead ?? null,
    cache_write_tokens: usage?.cacheWrite ?? null,
    cache_write_1h_tokens: usage?.cacheWrite1h ?? null,
  };
}

/** Shake makes no model call: its figures are zero, a fact and not a gap. */
export const NO_MODEL_CALL: CompactionUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cache_write_1h_tokens: 0,
};

/** The custom entry a side call's usage is appended under when the call did not become the compaction (it failed or wrote nothing), so its cost still reaches `calls`. */
export const HANDOFF_USAGE_ENTRY_TYPE = "lykos-handoff-usage";

export type SelfCompactRecord = HandoffRecord | CompactionRecord;

/** A value as one of our records, or undefined when it is not one. */
export function asSelfCompactRecord(value: unknown): SelfCompactRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (
    value.kind === "handoff" &&
    typeof value.id === "string" &&
    typeof value.note === "string" &&
    (value.phase === "pending" || value.phase === "compacted" || value.phase === "delivered")
  ) {
    return value as unknown as HandoffRecord;
  }
  if (value.kind === "compaction" && typeof value.id === "string" && typeof value.result === "string") {
    return value as unknown as CompactionRecord;
  }
  return undefined;
}

/** Every record in a Pi session's entries, in order. */
export function selfCompactRecordsFromEntries(
  entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
): SelfCompactRecord[] {
  const out: SelfCompactRecord[] = [];
  for (const e of entries) {
    if (e.type !== "custom" || e.customType !== SELF_COMPACT_ENTRY_TYPE) continue;
    const r = asSelfCompactRecord(e.data);
    if (r !== undefined) out.push(r);
  }
  return out;
}

/** Records from a `self-compact.jsonl` body; a line that is not one is skipped. */
export function parseSelfCompactRecords(text: string): SelfCompactRecord[] {
  const out: SelfCompactRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const r = asSelfCompactRecord(JSON.parse(line));
      if (r !== undefined) out.push(r);
    } catch {
      // A torn last line (a killed process) is not a reason to lose the rest.
    }
  }
  return out;
}

/**
 * The handoff still open at the end of these records, if any: the latest
 * record of the latest handoff, when that record is not `delivered`.
 */
export function unfinishedHandoff(records: readonly SelfCompactRecord[]): HandoffRecord | undefined {
  let last: HandoffRecord | undefined;
  for (const r of records) if (r.kind === "handoff") last = r;
  return last !== undefined && last.phase !== "delivered" ? last : undefined;
}

/** The shipped text past the cutoff, said once; `.lykos/prompts/self-compact/cutoff.md` replaces it. Same placeholders. */
export const DEFAULT_CUTOFF_PROMPT =
  "[self-compact cutoff] Your context holds about {tokens} tokens of a {window}-token window ({tier} tier), past the " +
  "{cutoff}-token cutoff. Every tool but self_compact is now refused. Call self_compact with your note to self " +
  `${NOTE_SHAPE} — then end your turn.`;

/**
 * What `/self-compact` sends the agent; `.lykos/prompts/self-compact/command.md`
 * replaces it. `{request}` is whatever the person typed after the command.
 */
export const DEFAULT_COMMAND_PROMPT =
  "[self-compact] The person asked you to compact now. Finish the step you are on, then call self_compact with a " +
  `note to self ${NOTE_SHAPE} — and end your turn.{request}`;

/** The line above the returned note. The note itself follows as its own text block, byte for byte. */
export const NOTE_HEADER =
  "[self-compact] Your context was compacted. Below, word for word, is the note to self you wrote before it was; " +
  "continue the task from it.";

/** What the summariser is told, so it does not spend its budget repeating the note. */
export const COMPACTION_INSTRUCTIONS =
  "The agent wrote its own note to self before this compaction, and that note is returned to it word for word " +
  "afterwards. Summarise the conversation without repeating the note.";

/** Why a tool call past the cutoff was refused: names the one tool that still runs. */
export function cutoffRefusal(toolName: string, tokens: number, cutoff: number): string {
  return (
    `lykos-self-compact: ${toolName} refused — the context holds about ${tokens} tokens, past the ${cutoff}-token ` +
    `cutoff, and only ${SELF_COMPACT_TOOL_NAME} runs now. Call ${SELF_COMPACT_TOOL_NAME} with your note to self, then ` +
    "end your turn; the note comes back to you word for word after compaction."
  );
}

/** T191: the compactions `lykos-self-compact` recorded in a session, oldest first; what `/compact <method>` reads to say how it went. */
export function compactionRecordsOf(booted: { selfCompactRecords?: SelfCompactRecord[] }): CompactionRecord[] {
  return (booted.selfCompactRecords ?? []).filter((r): r is CompactionRecord => r.kind === "compaction");
}
