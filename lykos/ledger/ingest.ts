// Turn a delegate snapshot (the JSON text inside an MCP tool result)
// into ledger rows. Re-prices raw tokens through priceCall(); never writes
// a cost that arrived already computed (DECISIONS.md T0.6).

import type { ContainmentRecord } from "../containment/containment.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { matchesDocumentedSurface, riskForTool, type RiskTier } from "../tools.js";
import { serializeCounts, summarizeToolSubstrate } from "../session/tool-substrate.js";
import { serializeBreakdown, summarizeExploration } from "../loop/exploration.js";
import { computeHitQuality, serializeEditedFiles } from "../session/hit-quality.js";
import { retrievalEffect } from "../context/retrieval-effect.js";
import { countEditErrors, countEditRetries, countEditToolCalls } from "../loop/edit-retry.js";
import {
  extensionSetKey,
  extensionSetLabel,
  HOP0_SCOPE,
  type ResolvedExtension,
} from "../config/extensions.js";
import { SHIPPED_DEFAULTS } from "../config/defaults.js";
import { loadConfig } from "../config/load.js";
import { resolveCallAccounting } from "../config/providers.js";
import type { ProvidersConfig } from "../config/types.js";
import { defaultLedgerPath, Ledger, type ExecutionShape, type Runtime, type SessionModelSource } from "./ledger.js";
import { priceCall } from "./prices.js";
import { formatSessionSummary, loadSessionSummary } from "./summary.js";
import { estimateTokensChars4, measureToolset, piDefaultBaseline, schemaShareOfPrompt } from "./tool-schema.js";
import { currentGitCommit, isGitDirty, resolveProject } from "../session/identity.js";
import { TranscriptWriter, transcriptDir, writeSessionMeta, type ToolCallEvent } from "../session/transcript.js";
import type { LiveTranscriptRecorder } from "../session/live-capture.js";

export interface DelegateUsageCall {
  hop?: string | number;
  source?: string;
  provider?: string;
  model?: string;
  subagentType?: string;
  tool?: string;
  wireTool?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  reasoning?: number;
  costUsd?: number;
  ts?: string | number;
  /** T16.2: SHA-256 of the real observed request head, read host-side by the
   *  session engine. Present
   *  only on hop-0 "direct"/assistant_message calls — the engine has no live
   *  session reference for a hop-1 child's own head. */
  headFingerprint?: string;
  /** T19: tokens the snip stage removed before this summariser call. */
  snipTokensRemoved?: number;
  pruneTokensRemoved?: number;
  contextBefore?: number;
  contextAfter?: number;
  /** T26.1: per-call latency and TTFT, read host-side from message_start/
   *  message_update/message_end (or compaction_start/compaction_end for a
   *  summariser call). Absent when the worker observed no start event. */
  latencyMs?: number;
  ttftMs?: number;
  /** T119: the first call after a user-selected model switch. */
  modelSwitched?: boolean;
  /** Specialists ticket 04: the first call after a mid-session `/specialist <name>` switch. */
  specialistSwitched?: boolean;
  /**
   * P14.6 ticket 06: the Lykos credential that served this call, recorded by
   * the rotation wrapper per assistant message. The label is non-secret (an
   * email, `key#2`); the type decides `auth_mode`. Both absent when no Lykos
   * credential served the call (an ambient env var, a compaction).
   */
  credentialLabel?: string;
  credentialType?: "oauth" | "api_key";
}

export interface DelegateUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  reasoning?: number;
  nestedInput?: number;
  nestedOutput?: number;
  nestedCacheRead?: number;
  nestedCacheWrite?: number;
  nestedBasis?: string;
  nestedCostUsd?: number;
  calls?: DelegateUsageCall[];
}

export interface DelegateToolCall {
  seq?: number;
  id?: string;
  name: string;
  args?: unknown;
  state?: string;
  ms?: number;
  result?: unknown;
}

export interface DelegateSnapshot {
  sessionId: string;
  label?: string;
  state?: string;
  model?: string;
  cwd?: string;
  /** Tool names in API order. Absent → schema tax stays NULL. */
  activeTools?: string[];
  turns?: number;
  toolCalls?: DelegateToolCall[];
  /** The snapshot's one final assistant text — not a per-turn stream. See transcript.ts's module doc. */
  lastText?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  usage?: DelegateUsage;
  /** T17: whether the cache-stable head contract was in force this session. */
  headContract?: { enabled?: boolean; cacheOptimizerLoaded?: boolean };
  /** T19: compaction policy in force, and last snip→prune stage counts. */
  compaction?: {
    enabled?: boolean;
    threshold?: number;
    reserveTokens?: number;
    contextWindow?: number;
    snipAfterTurns?: number;
    snipMaxBytes?: number;
    reason?: string;
    stages?: {
      tokensBefore?: number;
      snipTokensRemoved?: number;
      pruneTokensRemoved?: number;
      tokensAfter?: number;
    };
  };
  /**
   * T89: model switches forced by an unreachable provider, as `from>to`.
   * Present only when a switch happened. A session carrying this spans more
   * than one price basis and `lykos cost` must never sum across them.
   */
  modelFallbacks?: string;
  /** T119: user-selected model path, `a>b>c`, and count. */
  modelSwitches?: number;
  modelPath?: string;
  /** Specialists ticket 04: mid-session `/specialist <name>` path, same shape as modelSwitches/modelPath. */
  specialistSwitches?: number;
  specialistPath?: string;
  browserFanout?: { elapsedMs?: number; projectsScanned?: number; rowsReturned?: number };
  /** T117: how the session crossed the workspace trust boundary. */
  trustSource?: "stored" | "flag" | "prompt";
  /**
   * Specialists ticket 01: the specialist this session ran under, or absent when
   * none was selected. Was hardcoded to "budget" until this ticket — see the
   * comment at its one writer below.
   */
  specialist?: string;
  /** T173: what the session asked of containment and what it got. */
  containment?: ContainmentRecord;
  /**
   * T111.2: approval friction, counted at the gate by tier and by mode.
   * Absent → no gate observed this session (an MCP worker, a subagent, a
   * `--yes` run), which is not the same answer as a gate that never asked.
   * `byTier`/`byMode` are pre-serialised JSON from `ApprovalMetrics`.
   */
  approvals?: {
    requested?: number;
    denied?: number;
    autoDenied?: number;
    byTier?: string;
    byMode?: string;
  };
  /**
   * T111.1: bytes spilled to `artifacts/`. Absent → nothing observed the
   * spill. The live-capture path supplies it from the transcript writer,
   * which is the only thing that knows.
   */
  artifactBytes?: number;
  /**
   * T132: the loader surface. Absent → the session had no loader at all.
   * `enabled: true` with `activations: 0` is the answer the kill criterion
   * reads, and is why this block is present even when nothing fired.
   */
  toolLoader?: {
    enabled?: boolean;
    path?: string;
    deferred?: string[];
    activated?: string[];
    activations?: number;
    loaderTokens?: number;
    deferredTokens?: number;
  };
  /**
   * T105: the hook surface. Absent → the session had none at all. `registered`
   * with zero denials is the healthy case, not a missing measurement.
   */
  hooks?: { registered?: number; denials?: number; notes?: number };
  /**
   * T104: turn checkpoints. Absent → the session had no checkpointing at all
   * (not a git repository, or a path that predates T104). `enabled: true` with
   * `written: 0` means nothing changed all session.
   */
  checkpoints?: { enabled?: boolean; written?: number };
  /**
   * T170: why git was unusable, when it was. Absent or `repo` → nothing to
   * say. `not-a-repo` and `git-missing` each become a note on the session, so
   * the ledger tells a folder without a repository from a machine without git.
   */
  git?: { state?: "repo" | "not-a-repo" | "git-missing" };
  /**
   * T103: agent → human clarification. Absent → the session had no human
   * channel at all (a one-shot run, an MCP worker, a subagent), which is not
   * the same as a channel nobody used.
   */
  ask?: { asked?: number; answered?: number; unanswered?: number };
  /**
   * T102: the skills roster offered in the head, and what the session read
   * from it. Absent → the session had no skills surface at all. `available`
   * with an empty `invoked` is store pressure, not an error.
   */
  skills?: {
    available?: number;
    invoked?: string[];
    reads?: number;
    headTokens?: number;
  };
  /**
   * T99: the post-edit feedback loop. Absent → the session had no loop at
   * all, which is every pre-T99 row and every path that is not the
   * standalone agent. `enabled: true` with `command: null` is a third
   * answer: the loop was on and the project offered nothing to run.
   */
  postEdit?: {
    enabled?: boolean;
    command?: string | null;
    runs?: number;
    failures?: number;
    passes?: number;
    totalMs?: number;
    disabled?: boolean;
    disabledReason?: string;
  };
  /**
   * T98/T100: the session-owned task list. Absent on every snapshot from a
   * path that has no list (the container/MCP shape, and every pre-T98 row) —
   * absent leaves the columns NULL, and is not the same answer as zeros.
   */
  taskList?: {
    calls?: number;
    created?: number;
    completed?: number;
    open?: number;
    reminders?: number;
    gateRefusals?: number;
    verified?: number;
  };
  /** T85: the stagnation brake's activity this session. */
  stagnation?: {
    trips?: number;
    stopped?: boolean;
    key?: string;
  };
  /**
   * T83: Pi's own transient-failure retry, observed rather than built.
   * Absent on every pre-T83 snapshot, and absent is not zero — nothing is
   * backfilled, so a NULL column means "not measured" and a 0 means "measured,
   * nothing retried."
   */
  retry?: {
    starts?: number;
    recovered?: number;
    exhausted?: number;
    maxAttempt?: number;
    lastError?: string;
  };
  /** T21: prompt diet in force, and which context files were frozen into the head. */
  promptDiet?: {
    enabled?: boolean;
    toolResultMaxBytes?: number;
    truncatedResults?: number;
    unchangedStubs?: number;
    /** T84: bytes the clamp kept out of the context. Measured, not modelled. */
    bytesElided?: number;
    contextFiles?: Array<{ path?: string; name?: string; kind?: string; bytes?: number }>;
  };
  /** T23: output diet (YAGNI/one-liner rule) in force this session. */
  outputDiet?: { enabled?: boolean };
  /** T69: the repo map frozen into this session's head, and its cost. */
  repoMap?: {
    enabled?: boolean;
    /** T70: the rendered map, scored against this session's trace at ingest and not stored. */
    text?: string;
    tokens?: number;
    files?: number;
    dropped?: number;
    tracked?: number;
  };
  /** T65: the memory block frozen into this session's head, and its cost. */
  memory?: {
    enabled?: boolean;
    injectedIds?: string[];
    injectTokens?: number;
    available?: number;
    skipped?: number;
    /** T76: one row per eligible entry, injected or not. */
    eligibility?: Array<{
      entryId?: string;
      scope?: string;
      file?: string;
      state?: string;
      position?: number;
      tokens?: number;
    }>;
  };
  /** T34.3 (docs/15-phase3-tasks.md): count of `session.steer()` calls on the standalone interactive path — the first writer `sessions.human_interventions` has ever had. */
  humanInterventions?: number;
  /** T29 (docs/10-phase2-tasks.md, lykos/config/extensions.ts): which
   * declarative third-party extensions were in force this session. Written
   * host-side by the session engine, not by this module. */
  extensions?: {
    /** config.yaml declarations, in declaration order (= load order). */
    declared?: Array<{ name?: string; version?: string; path?: string }>;
    /** Names actually passed to `additionalExtensionPaths`. */
    loaded?: string[];
    /** Declared but the package was not present in the image — never silent. */
    missing?: string[];
    source?: "env" | "default";
  };
}

const TERMINAL = new Set(["done", "aborted", "error", "failed"]);

let cached: Ledger | undefined;

export function openWorkspaceLedger(workspace: string, ledgerPath?: string): Ledger {
  const path = ledgerPath ?? defaultLedgerPath(workspace);
  if (cached && cached.path === path) return cached;
  cached?.close();
  cached = Ledger.open(path);
  return cached;
}

export function parseProviderModel(ref: string | undefined): { provider: string; model: string } {
  if (!ref) return { provider: "deepseek", model: "deepseek-v4-flash" };
  const slash = ref.indexOf("/");
  if (slash <= 0) return { provider: "deepseek", model: ref };
  return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
}

function providersForIngest(opts?: IngestOpts): ProvidersConfig {
  if (opts?.providers) return opts.providers;
  if (opts?.workspace) return loadConfig({ cwd: opts.workspace }).resolved.providers;
  return SHIPPED_DEFAULTS.providers;
}

function isSnapshot(value: unknown): value is DelegateSnapshot {
  if (value === null || typeof value !== "object") return false;
  const v = value as DelegateSnapshot;
  return typeof v.sessionId === "string" && v.usage !== undefined && typeof v.usage === "object";
}

function isTerminal(snap: DelegateSnapshot): boolean {
  if (snap.state && TERMINAL.has(snap.state)) return true;
  return Boolean(snap.finishedAt);
}

function callTs(call: DelegateUsageCall, fallback: Date): Date {
  if (typeof call.ts === "number") {
    return new Date(call.ts < 1e12 ? call.ts * 1000 : call.ts);
  }
  if (typeof call.ts === "string" && call.ts.length > 0) {
    const d = new Date(call.ts);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return fallback;
}

function cacheTtlSeconds(cacheWrite: number, cacheWrite1h: number | undefined): number | undefined {
  if (!cacheWrite) return undefined;
  if ((cacheWrite1h ?? 0) > 0) return 3600;
  return 300;
}

/**
 * T107.5: the risk tier of a call, from the tool's declaration.
 *
 * A tool whose declaration says its tier is derived from something this row
 * does not carry — `bash`, whose tier is a function of its command — records
 * NOTHING rather than its declared fallback. `DelegateUsageCall` has a tool
 * name and no arguments, and there is no id tying it to the entry in
 * `snap.toolCalls` that does have them, so the command genuinely is not
 * available here. NULL says "not knowable on this row"; `hard-write` would
 * say "measured", and one of those is true.
 *
 * The skip is keyed on `tierDerivedFrom` rather than on the literal name
 * "bash", which is the whole point of T107: a tool declares what it does,
 * and the code that consumes the declaration never learns tool names.
 */
function riskTierField(tool: string | undefined): { riskTier: RiskTier } | Record<string, never> {
  if (tool === undefined) return {};
  const declared = riskForTool(tool);
  if (declared === undefined || declared.tierDerivedFrom !== undefined) return {};
  return { riskTier: declared.tier };
}

/**
 * Tool-schema tax is the parent's resident tool list. Nested hops have no
 * child tool list in the snapshot, so leaving names unset keeps tokens NULL
 * rather than attributing the parent's schemas to the child.
 */
function hop0ToolNames(
  snap: DelegateSnapshot,
  hop: number,
  isLykosChild = false,
): { toolNames: string[] } | Record<string, never> {
  if ((hop !== 0 && !isLykosChild) || snap.activeTools === undefined) return {};
  return { toolNames: snap.activeTools };
}

/**
 * T29.3 (problems/14-extension-sprawl.md): the kill line, and crossing it must
 * be visible the day it happens rather than three weeks later.
 *
 * The denominator is **billed input** (fresh + cache-read), not the tool schema.
 * problems/14 states the ~5%/~10% thresholds "in *billed* share-of-prompt
 * terms", and `v_schema_tax.share_of_prompt` already uses that denominator.
 * Measured against the schema instead, pi-subagents' host trio alone would sit
 * near 75% and the line would fire on every session while meaning nothing --
 * a threshold that always trips is a threshold nobody reads.
 */
const EXTENSION_SCHEMA_SHARE_KILL_LINE = 0.1;

interface SnapshotExtensions {
  /** JSON array of {name, version}, declaration order. NULL if none declared. */
  extensionsJson: string | null;
  /** extensionSetKey() handle for the declared set. "none" for an empty one. */
  extensionSet: string;
  /** The same set, as full ResolvedExtension records, for extensionSetLabel(). */
  resolved: ResolvedExtension[];
}

/**
 * T29.4: translate the delegate's `extensions.declared` into the ledger's
 * columns via lykos/config/extensions.ts's own contract (`extensionSetKey`,
 * `extensionSetLabel`) rather than re-deriving the hash/label here. Declared
 * entries missing a name or version are dropped rather than guessed — the
 * config side is what validates them; this only ever transcribes.
 */
function resolveSnapshotExtensions(ext: DelegateSnapshot["extensions"]): SnapshotExtensions {
  const resolved: ResolvedExtension[] = [];
  for (const d of ext?.declared ?? []) {
    if (typeof d.name !== "string" || typeof d.version !== "string") continue;
    resolved.push({
      name: d.name,
      version: d.version,
      scope: [HOP0_SCOPE],
      hop0: true,
    });
  }
  return {
    extensionsJson:
      resolved.length > 0 ? JSON.stringify(resolved.map((e) => ({ name: e.name, version: e.version }))) : null,
    extensionSet: extensionSetKey(resolved),
    resolved,
  };
}

/**
 * T29.3: the schema-tax delta an extension's tools add beyond Pi's own four
 * built-ins (piDefaultBaseline(), T20). Both fields NULL together — never a
 * partial number — when measureToolset() hits a tool name the catalog
 * doesn't know, which is exactly what a genuinely new extension produces.
 * The unknown names are pushed onto `notes` so the gap is visible and
 * actionable rather than a silent NULL nobody investigates.
 */
function extensionSchemaTax(
  snap: DelegateSnapshot,
  extSet: SnapshotExtensions,
  notes: string[],
): { tokens: number | null; share: number | null } {
  if (snap.activeTools === undefined) return { tokens: null, share: null };
  const measured = measureToolset(snap.activeTools);
  if (!measured.complete || measured.tokens === null) {
    notes.push(
      `extension schema tax unmeasured — catalog does not know: ${measured.unknown.join(", ")} — ` +
        "add them to tool-catalog.ts to measure this set",
    );
    return { tokens: null, share: null };
  }
  const tokens = Math.max(0, measured.tokens - piDefaultBaseline().tokens);
  // Share of the BILLED input side, the same denominator v_schema_tax uses and
  // the one problems/14 states its thresholds in. A session with no input
  // tokens recorded has no denominator, so the share is NULL rather than 0.
  const share = schemaShareOfPrompt(tokens, snap.usage?.input ?? 0, snap.usage?.cacheRead ?? 0)?.share ?? null;
  if (share !== null && share > EXTENSION_SCHEMA_SHARE_KILL_LINE) {
    notes.push(
      `extension schema tax ${(share * 100).toFixed(1)}% of billed input ` +
        `(set ${extSet.extensionSet} — ${extensionSetLabel(extSet.resolved)}) crosses the ` +
        `${(EXTENSION_SCHEMA_SHARE_KILL_LINE * 100).toFixed(0)}% kill line`,
    );
  }
  return { tokens, share };
}

/**
 * Record one delegate snapshot. Idempotent on session id: the first write
 * wins, because call rows are append-only and a later `status --verbose`
 * must not double-count the same spend.
 *
 * Returns the session id if anything was written, or null if skipped.
 */
export interface IngestOpts {
  workspace?: string;
  /** Override for ~/.lykos/projects.json — tests only. */
  registryPath?: string;
  /**
   * T33 (docs/15-phase3-tasks.md): the in-process host path (session/session.ts)
   * knows its own shape and runtime directly — it never has to guess from a
   * snapshot's `label`, the way the container path's auto-detect below does.
   * Omit for the container path; every caller written since T31 must supply
   * it going forward on any path that isn't the pre-existing MCP/CLI one.
   */
  executionShape?: ExecutionShape;
  runtime?: Runtime;
  /**
   * T35.3: who chose the session's boot model. The host path knows this
   * directly (resolveBootModel); the container path currently does not
   * and leaves it NULL rather than guessing config_default.
   */
  modelSource?: SessionModelSource;
  /**
   * T36.1: the resolved `providers:` block. When omitted, ingest loads
   * config from `workspace` (or falls back to shipped defaults) so a
   * call never silently inherits recordCall()'s pre-T35 `api_key` default
   * for an undeclared provider.
   */
  providers?: ProvidersConfig;
  /**
   * T39.1: Lykos-spawned child — the parent session id already in the
   * ledger (ensured on first Agent call). When set, this snapshot IS the
   * child: `execution_shape=subagent`, its calls are hop=1, and it does
   * not synthesize a further hop-1 bucket from `nested*`.
   */
  parentSessionId?: string;
  /**
   * T57: this session continues `resumedFrom`. Written to the new row and
   * nowhere else — the original's cost, tokens and outcome stand exactly as
   * they were, forever. A resume never rewrites history.
   */
  resumedFrom?: string;
  /** T109: boundaries crossed by this task. NULL on pre-T109 rows. */
  continuationsUsed?: number;
  /** T39: reuse the parent's task rather than auto-creating a new one. */
  taskId?: string;
  projectId?: string;
  trustSource?: "stored" | "flag" | "prompt";
  /** T39.3: defaults true for Lykos-spawned children; MCP hop-1 stays false. */
  resumable?: boolean;
  notResumableReason?: string;
  agentRole?: string;
  /**
   * T53 (docs/19-phase4-tasks.md): the live transcript recorder that has
   * been appending events since this session BOOTED. When present, ingest
   * writes no transcript events of its own from the snapshot and no
   * `meta.json` (both already exist, and richer): it appends only the
   * closing `error`/`outcome` lines through the same recorder, finalizes the
   * hash, and records `capture_mode = 'stream'` on the row.
   *
   * Omitted, everything behaves exactly as it did before T53 and the session
   * is recorded as `capture_mode = 'snapshot'` — which is the honest label
   * for the delegate/MCP path, not a downgrade of it.
   *
   * This does NOT make the recorder a second ledger writer. `sessions` and
   * `calls` are still written here and only here.
   */
  liveTranscript?: LiveTranscriptRecorder;
}

export function ingestDelegateSnapshot(
  ledger: Ledger,
  snap: DelegateSnapshot,
  opts?: IngestOpts,
): string | null {
  if (!isTerminal(snap) || !snap.usage) return null;
  // A second ingest of an already-finished snapshot is idempotent. A resumed
  // session, however, is explicitly reopened first, so its existing calls
  // must not suppress the next run's accounting.
  if (
    ledger.hasCalls(snap.sessionId) &&
    (ledger.db.prepare(`SELECT ended_utc FROM sessions WHERE id = ?`).get(snap.sessionId) as
      | { ended_utc: string | null }
      | undefined)?.ended_utc !== null
  ) {
    return null;
  }

  const write = ledger.db.transaction(() => {
    ingestSnapshotBody(ledger, snap, opts);
    return snap.sessionId;
  });
  return write();
}

/** T9.1 (docs/08-sessions-and-archive.md §1.1, DECISIONS.md 2026-08-29) verified
 * this empirically: `pi-subagents`' own tool surface (`Agent`/`get_subagent_result`)
 * does hand back a working id and a final-answer string, but only as free text
 * inside one container invocation's tool-call results, never as a structured field
 * the worker's usage capture attaches to a `calls` row — and it stops resolving to
 * anything the moment that container exits. A hop-1 session Lykos creates here is
 * an aggregate bucket it synthesized, not a resumable conversation. */
const HOP1_NOT_RESUMABLE_REASON =
  "hop-1 identity is synthesized by Lykos; pi-subagents exposes an agent id and final " +
  "answer only as free text within one container's own tool-call results, never as a " +
  "structured, persisted field the ledger can read";

/**
 * T6.2 (docs/03-telemetry.md §4.1) — high confidence, not exact: the same
 * T9.1 gap named above means the subagent's returned summary is never a
 * structured token count, only free text inside a `get_subagent_result`
 * tool-call result. Estimated with the same chars/4 estimator T4.1 already
 * uses for tool schemas (never billed, always an estimate). `handoff_loss`
 * is not measurable at all from one terminal snapshot — there is no signal
 * here for "the parent later re-asked for something the summary omitted" —
 * so it stays 0 rather than a guess, per AGENTS.md rule 4.
 */
const DELEGATION_AVOIDED_BASIS =
  "delegation_hop1 (T6.2): child_input+cache_read minus summary/briefing (chars/4 estimate), " +
  "priced at the worker's own input rate, minus the child's actual cost; handoff_loss not " +
  "measurable from a terminal snapshot and is always 0";

function resultOrArgsText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Sum of chars/4-estimated tokens across every tool call of the given name
 * in this snapshot's tool-call trace — `Agent` for what the worker briefed
 * the subagent with, `get_subagent_result` for what came back. Both are read
 * from the PARENT's own tool-call list (`snap.toolCalls`): the parent is who
 * calls both tools, per the T9.1 experiment.
 */
function estimatedToolTextTokens(
  toolCalls: DelegateToolCall[] | undefined,
  name: string,
  field: "args" | "result",
): number {
  let total = 0;
  for (const call of toolCalls ?? []) {
    if (call.name !== name) continue;
    total += estimateTokensChars4(resultOrArgsText(field === "args" ? call.args : call.result));
  }
  return total;
}

/**
 * Project + task identity for one snapshot (T8.2/T8.4). Only resolved when a
 * workspace is known — ingest call sites with no workspace (all of the unit
 * tests, and any caller that hasn't wired one through) get NULL project_id
 * and task_id rather than shelling out to git or touching the real
 * ~/.lykos/projects.json.
 */
function resolveIdentity(
  ledger: Ledger,
  workspace: string | undefined,
  brief: string,
  opts?: IngestOpts,
): { projectId?: string; taskId?: string; gitCommit?: string; gitDirty?: boolean } {
  // T39: a Lykos-spawned child reuses the parent's task/project — creating a
  // fresh task here would split one piece of work into two in the headline
  // metric (08-sessions-and-archive.md §5).
  if (opts?.taskId !== undefined || opts?.projectId !== undefined) {
    const gitCommit = workspace !== undefined ? currentGitCommit(workspace) : undefined;
    return {
      ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
      ...(workspace !== undefined ? { gitDirty: isGitDirty(workspace) } : {}),
      ...(gitCommit !== undefined ? { gitCommit } : {}),
    };
  }
  if (workspace === undefined) return {};
  const resolved = resolveProject(workspace, opts?.registryPath !== undefined ? { registryPath: opts.registryPath } : {});
  ledger.ensureProject({
    id: resolved.id,
    rootPath: resolved.record.root_path,
    gitRemote: resolved.record.git_remote,
    firstCommit: resolved.record.first_commit,
    name: resolved.record.name,
    createdUtc: resolved.record.created_utc,
    lastSeenUtc: resolved.record.last_seen_utc,
  });
  // Auto-create one task per snapshot from its brief (docs/08 §8 open
  // question: "auto-create from the first brief and let it be renamed
  // later"). True resumption-chaining onto an EXISTING task is `lykos
  // resume`'s job (Phase 4, not built) — this just guarantees every session
  // belongs to a task, which is what the headline metric needs.
  const taskId = ledger.startTask({ projectId: resolved.id, brief });
  const gitCommit = currentGitCommit(workspace);
  return {
    projectId: resolved.id,
    taskId,
    gitDirty: isGitDirty(workspace),
    ...(gitCommit !== undefined ? { gitCommit } : {}),
  };
}

function ingestSnapshotBody(
  ledger: Ledger,
  snap: DelegateSnapshot,
  opts?: IngestOpts,
): void {
  const usage = snap.usage;
  if (!usage) throw new Error("ingestDelegateSnapshot: snapshot has no usage");
  const fallback = parseProviderModel(snap.model);
  const providers = providersForIngest(opts);
  const ts = snap.finishedAt ? new Date(snap.finishedAt) : new Date();
  const notes: string[] = [];
  // 2026-09-07 (UI feedback item 9): `"(delegate)"` used to be the brief of
  // every session `lykos run` ever started, including the interactive one a
  // person drives — so the browser listed a screen of identical rows named
  // after a code path the user never chose. The literal is kept for the
  // shape it was ever true of (the container delegate) and every other
  // shape now falls back to a name that says what it is, or to NULL, which
  // the browser reads as "nobody named this" and fills in from the first
  // thing that was typed (`session/preview.ts`).
  //
  // Note the ORDER: `executionShape` is computed below and this needs it,
  // so the shape is resolved first and the brief afterwards. A placeholder
  // that pretends to be a human-chosen name is worse than no name at all,
  // because every surface that ranks a human name above a derived one will
  // rank the placeholder above the truth.
  const brief = snap.label ?? null;
  // T31.1: mcp-server.ts's four tools pass `label: def.name` — one of these
  // four literal strings — into runTask(), which ingest.ts sees back here as
  // `snap.label`. `lykos run` never sets a label, so the only other shape a
  // top-level (non-subagent) session in this process can be is the CLI
  // delegate path. Not imported from delegate/mcp-server.ts: ledger/ is
  // the lower layer and delegate/ already imports FROM it, not the reverse.
  // T39.1: an explicit parentSessionId means this snapshot IS the Lykos-
  // spawned child — shape is `subagent` regardless of label.
  const isLykosChild = opts?.parentSessionId !== undefined;
  const executionShape: ExecutionShape =
    opts?.executionShape ??
    (isLykosChild
      ? "subagent"
      : snap.label !== undefined &&
          (["lykos_implement", "lykos_refactor", "lykos_debug", "lykos_review"] as const).includes(
            snap.label as "lykos_implement" | "lykos_refactor" | "lykos_debug" | "lykos_review",
          )
        ? "mcp_worker"
        : "cli_delegate");

  const sessionBrief = brief ?? (executionShape === "cli_delegate" ? "(delegate)" : null);
  const identity = resolveIdentity(ledger, opts?.workspace, sessionBrief ?? "(no brief)", opts);

  // T53: declared here, above startSession(), because `capture_mode` is
  // written on the row this function inserts and the transcript decision
  // below reads the same variable — one source of "was this captured live".
  const liveRecorder = opts?.liveTranscript;

  // T29.4/T29.3: which set was declared, and what its tools cost beyond Pi's
  // own built-ins. Computed before startSession() so both land on the same
  // row they describe, and before the missing-declaration note below so a
  // silently-absent extension is never lost to the caller.
  const extSet = resolveSnapshotExtensions(snap.extensions);
  const extTax = extensionSchemaTax(snap, extSet, notes);
  if (snap.extensions?.missing && snap.extensions.missing.length > 0) {
    notes.push(`extensions declared but missing from image: ${snap.extensions.missing.join(", ")}`);
  }

  if (snap.git?.state !== undefined && snap.git.state !== "repo") notes.push(`git: ${snap.git.state}`);

  const agentRole = opts?.agentRole ?? (isLykosChild ? "subagent" : "worker");
  // T39.3: Lykos-spawned children are resumable; MCP hop-1 stays degraded.
  const resumable = opts?.resumable ?? (isLykosChild ? true : undefined);
  const notResumableReason = opts?.notResumableReason;

  // T39: the parent row may already exist (ensured on first Agent spawn).
  // Re-INSERT would violate the PK; skip start and keep the existing identity.
  const sessionAlreadyExists =
    (ledger.db.prepare(`SELECT 1 AS ok FROM sessions WHERE id = ?`).get(snap.sessionId) as
      | { ok: number }
      | undefined) !== undefined;

  // T70: did the map surface what the session went on to need? Scored here
  // because ingest is the one place that holds both the map and the trace.
  const effect = retrievalEffect(snap.repoMap?.text ?? "", snap.toolCalls);

  if (!sessionAlreadyExists) {
    ledger.startSession({
      id: snap.sessionId,
      ...(sessionBrief !== null ? { brief: sessionBrief } : {}),
      flags: {
        delegation: true,
        cacheStableHead: snap.headContract?.enabled === true,
        proactiveCompaction: snap.compaction?.enabled === true,
        trimmedToolSurface: matchesDocumentedSurface(snap.activeTools),
        promptDiet: snap.promptDiet?.enabled === true,
        outputDiet: snap.outputDiet?.enabled === true,
        memoryInject: snap.memory?.enabled === true && (snap.memory.injectedIds?.length ?? 0) > 0,
        // T69: the first writer flag_retrieval has ever had. True only when a
        // map actually rode the head — "configured on with no map" is not the
        // arm an on/off comparison wants.
        retrieval: snap.repoMap?.enabled === true && (snap.repoMap.tokens ?? 0) > 0,
      },
      ...(snap.repoMap
        ? {
            repoMapTokens: snap.repoMap.tokens ?? 0,
            repoMapFiles: snap.repoMap.files ?? 0,
            repoMapDropped: snap.repoMap.dropped ?? 0,
            repoMapTracked: snap.repoMap.tracked ?? 0,
            // T70. NULL-free only because the map section exists at all; a
            // snapshot with no map leaves every one of these unwritten.
            mapEditedCovered: effect.editedCovered,
            mapEditedMissed: effect.editedMissed,
            ...(effect.missedPaths.length > 0 ? { mapMissedPaths: JSON.stringify(effect.missedPaths) } : {}),
            mapExploreCovered: effect.exploreCovered,
            mapExploreUncovered: effect.exploreUncovered,
          }
        : {}),
      // T65: recorded whenever the snapshot carried a memory section at all,
      // including the disabled case — "memory was off this session" is a
      // measurement, and Experiment H needs both arms.
      ...(snap.memory
        ? {
            memoryInjectedIds: JSON.stringify(snap.memory.injectedIds ?? []),
            memoryInjectTokens: snap.memory.injectTokens ?? 0,
            memoryEntriesAvailable: snap.memory.available ?? 0,
            memoryEntriesSkipped: snap.memory.skipped ?? 0,
          }
        : {}),
      ...(typeof snap.compaction?.threshold === "number" ? { compactionThreshold: snap.compaction.threshold } : {}),
      ...(snap.promptDiet?.contextFiles && snap.promptDiet.contextFiles.length > 0
        ? {
            contextFiles: JSON.stringify(
              snap.promptDiet.contextFiles.map((f) => ({
                name: f.name ?? f.path,
                kind: f.kind,
                bytes: f.bytes,
              })),
            ),
          }
        : {}),
      ...(extSet.extensionsJson !== null ? { extensions: extSet.extensionsJson } : {}),
      extensionSet: extSet.extensionSet,
      ...(extTax.tokens !== null ? { extensionSchemaTokens: extTax.tokens } : {}),
      ...(extTax.share !== null ? { extensionSchemaShare: extTax.share } : {}),
      agentRole,
      model: fallback.model,
      ...(snap.modelSwitches !== undefined ? { modelSwitches: snap.modelSwitches } : {}),
      ...(snap.modelPath !== undefined ? { modelPath: snap.modelPath } : {}),
      ...(snap.specialistSwitches !== undefined ? { specialistSwitches: snap.specialistSwitches } : {}),
      ...(snap.specialistPath !== undefined ? { specialistPath: snap.specialistPath } : {}),
      ...(snap.browserFanout !== undefined
        ? {
            browserFanoutMs: snap.browserFanout.elapsedMs,
            browserProjectsScanned: snap.browserFanout.projectsScanned,
            browserRowsReturned: snap.browserFanout.rowsReturned,
          }
        : {}),
      ...((opts?.trustSource ?? snap.trustSource) !== undefined
        ? { trustSource: opts?.trustSource ?? snap.trustSource }
        : {}),
      ...(opts?.modelSource !== undefined ? { modelSource: opts.modelSource } : {}),
      // Specialists ticket 01: whatever specialist the session actually ran under,
      // or absent (NULL) when none was selected. Previously hardcoded to
      // "budget" (T23.3's note, predating specialists existing as a real
      // mechanism) — that value is not backfilled onto old rows; it was
      // never true of them either.
      ...(snap.specialist !== undefined ? { specialist: snap.specialist } : {}),
      ...(snap.containment !== undefined ? { containment: snap.containment } : {}),
      executionShape,
      // T53: named, never guessed. `stream` only when a live recorder
      // actually captured this run; everything else is the snapshot subset
      // and says so, which is what T56 refuses to resume as a conversation.
      captureMode: liveRecorder ? "stream" : "snapshot",
      // T31.2: defaults to "container" — every session ingest.ts wrote before
      // T33 ran in the sandbox. session/session.ts (T33) passes "host" explicitly.
      runtime: opts?.runtime ?? "container",
      ...identity,
      ...(opts?.parentSessionId !== undefined ? { parentSessionId: opts.parentSessionId } : {}),
      ...(opts?.resumedFrom !== undefined ? { resumedFrom: opts.resumedFrom } : {}),
      ...(opts?.continuationsUsed !== undefined ? { continuationsUsed: opts.continuationsUsed } : {}),
      ...(resumable !== undefined ? { resumable } : {}),
      ...(notResumableReason !== undefined ? { notResumableReason } : {}),
      ...(opts?.workspace !== undefined ? { workspace: opts.workspace } : {}),
      // The real start of the run this snapshot describes, not "now" -- ingest
      // happens once, after the whole run already finished, so without this
      // every session's wall time (docs/03-telemetry.md §1.2) would read ~0s
      // regardless of how long the delegate actually ran.
      ...(snap.startedAt !== undefined ? { startedUtc: snap.startedAt } : {}),
    });
  } else if (identity.taskId || identity.projectId) {
    // Parent was ensured early for spawn — attach the task if the early row
    // somehow lacked one (should already be set by ensureParentSessionForSpawn).
    ledger.db
      .prepare(
        `UPDATE sessions SET
           task_id = COALESCE(task_id, ?),
           project_id = COALESCE(project_id, ?),
           brief = COALESCE(NULLIF(brief, ''), ?)
         WHERE id = ?`,
      )
      .run(identity.taskId ?? null, identity.projectId ?? null, sessionBrief, snap.sessionId);
  }
  // T76: the per-entry eligibility rows, written once the session row is
  // guaranteed to exist (the FK points at it). Idempotent, so a re-ingest of
  // the same snapshot does not double-count an entry.
  if (snap.memory?.eligibility && snap.memory.eligibility.length > 0) {
    ledger.recordMemoryEligibility(
      snap.sessionId,
      snap.memory.eligibility.flatMap((e) =>
        typeof e.entryId === "string" &&
        typeof e.scope === "string" &&
        typeof e.file === "string" &&
        typeof e.state === "string"
          ? [
              {
                entryId: e.entryId,
                scope: e.scope,
                file: e.file,
                state: e.state,
                position: typeof e.position === "number" ? e.position : 0,
                tokens: typeof e.tokens === "number" ? e.tokens : 0,
              },
            ]
          : // A row missing its identity is dropped rather than guessed at:
            // a made-up entry id would attach a measurement to a memory that
            // does not exist.
            [],
      ),
    );
  }

  if (sessionAlreadyExists && liveRecorder) {
    // A parent row ensured early by a subagent spawn never went through the
    // startSession() above, so it would otherwise carry a NULL capture_mode
    // for a session that WAS captured live. COALESCE, so an existing value
    // is never rewritten.
    ledger.db
      .prepare(`UPDATE sessions SET capture_mode = COALESCE(capture_mode, 'stream') WHERE id = ?`)
      .run(snap.sessionId);
  }

  // T53: when a live recorder captured this session, its writer already
  // holds every event and its meta.json was written at boot — ingest must
  // not open a SECOND writer on the same file (two writers, two turn_index
  // counters, one interleaved file) or overwrite the richer meta with the
  // subset this function can see.
  //
  // T9: :memory: ledgers (all unit tests, unless a real ledgerPath is given)
  // have no directory to write a transcript into — same guard live.ts uses
  // for live.json. A real ingest always has a real ledger.path.
  const parentWriter = liveRecorder
    ? liveRecorder.writer
    : ledger.path !== ":memory:"
      ? new TranscriptWriter(ledger.path, snap.sessionId)
      : undefined;
  if (parentWriter && !liveRecorder) {
    // T54: v2 even on this path — the version is about the FILE's shape, not
    // about how much of it a given writer can fill. What the snapshot path
    // genuinely does not know (the head fingerprint, the tool surface, the
    // frozen context files) is left absent, which a reader reports as "not
    // recorded" rather than filling with a guess.
    writeSessionMeta(ledger.path, {
      schemaVersion: 2,
      captureMode: "snapshot",
      sessionId: snap.sessionId,
      taskId: identity.taskId ?? null,
      projectId: identity.projectId ?? null,
      parentSessionId: opts?.parentSessionId ?? null,
      resumedFrom: null,
      agentRole,
      model: fallback.model,
      cwd: snap.cwd ?? null,
      startedUtc: snap.startedAt ?? ts.toISOString(),
    });
    for (const call of snap.toolCalls ?? []) {
      parentWriter.append(toToolCallEvent(call), ts);
    }
  }

  // Hop-1 spend gets ONE child session per snapshot (not one per call): the
  // capture layer cannot currently tell separate subagent spawns apart
  // (§1.1), so a session per call would fabricate a distinction the data
  // doesn't support. Lazily created on first hop-1 call encountered.
  // T39.2: a Lykos-spawned child IS already the hop-1 session — never
  // synthesize another bucket from nested* on top of it (that would
  // double-count).
  let childSessionId: string | undefined;
  let childWriter: TranscriptWriter | undefined;
  function hop1Session(agent: string, model: string): string {
    if (isLykosChild) {
      throw new Error(
        "ingestDelegateSnapshot: refused to synthesize a hop-1 child under a Lykos-spawned subagent (T39.2 double-count guard)",
      );
    }
    if (childSessionId !== undefined) return childSessionId;
    childSessionId = ledger.startSession({
      parentSessionId: snap.sessionId,
      ...(identity.taskId !== undefined ? { taskId: identity.taskId } : {}),
      ...(identity.projectId !== undefined ? { projectId: identity.projectId } : {}),
      brief: `${sessionBrief ?? "(session)"} — subagent`,
      flags: { delegation: true, cacheStableHead: snap.headContract?.enabled === true },
      agentRole: agent,
      model,
      resumable: false,
      notResumableReason: HOP1_NOT_RESUMABLE_REASON,
      executionShape: "subagent",
      runtime: "container",
      // Same aggregate-bucket caveat as the parent: no real per-child start
      // time reaches Lykos (T9.1), so this uses the overall run's start
      // rather than "now" -- ingestion happening after snap.finishedAt would
      // otherwise make endedUtc land BEFORE startedUtc's default "now".
      ...(snap.startedAt !== undefined ? { startedUtc: snap.startedAt } : {}),
    });
    if (ledger.path !== ":memory:") {
      childWriter = new TranscriptWriter(ledger.path, childSessionId);
      writeSessionMeta(ledger.path, {
        schemaVersion: 2,
        captureMode: "snapshot",
        sessionId: childSessionId,
        taskId: identity.taskId ?? null,
        projectId: identity.projectId ?? null,
        parentSessionId: snap.sessionId,
        resumedFrom: null,
        agentRole: agent,
        model,
        cwd: null,
        startedUtc: ts.toISOString(),
      });
    }
    return childSessionId;
  }

  const calls = usage.calls;
  if (Array.isArray(calls) && calls.length > 0) {
    for (const call of calls) {
      if (call.source === "tool_details") {
        notes.push("skipped nested tool_details row (foreign cost, no tokens to re-price)");
        continue;
      }
      // A "direct" call carries `provider` and `model` as two
      // separate bare fields (`provider: ev.message.provider, model:
      // ev.message.model`), never as one "provider/model" string. Combining them
      // directly is required: falling through to parseProviderModel(call.model)
      // alone would treat a bare non-DeepSeek model id (e.g. "claude-haiku-4-5")
      // as DeepSeek's own default and mis-price or throw. Only bare-string
      // parsing (which assumes DeepSeek) applies when the call carries no
      // explicit provider of its own.
      const ref = call.provider && call.model
        ? { provider: call.provider, model: call.model }
        : parseProviderModel(call.model ?? (call.provider ? `${call.provider}/${fallback.model}` : snap.model));
      // T39: every call on a Lykos-spawned child session is hop=1 — the child
      // session is the hop boundary, not a nested* aggregate on the parent.
      const hop = isLykosChild ? 1 : call.hop === "nested" || call.hop === 1 ? 1 : 0;
      const agent = hop === 0 ? "worker" : (call.subagentType ?? agentRole).toLowerCase();
      const sessionId = isLykosChild
        ? snap.sessionId
        : hop === 0
          ? snap.sessionId
          : hop1Session(agent, ref.model);
      const ttl = cacheTtlSeconds(call.cacheWrite ?? 0, call.cacheWrite1h);
      const callTimestamp = callTs(call, ts);
      const accounting = resolveCallAccounting(ref.provider, ref.model, providers, call.credentialType);
      const callId = ledger.recordCall({
        sessionId,
        hop,
        ts: callTimestamp,
        agent,
        ...(call.source === "compaction" ? { phase: "compact", compactionTriggered: true } : {}),
        provider: ref.provider,
        model: ref.model,
        authMode: accounting.authMode,
        ...(call.credentialLabel !== undefined ? { credentialLabel: call.credentialLabel } : {}),
        priceBasis: accounting.priceBasis,
        tokens: {
          input: call.input ?? 0,
          output: call.output ?? 0,
          cacheRead: call.cacheRead ?? 0,
          cacheWrite: call.cacheWrite ?? 0,
          reasoning: call.reasoning ?? 0,
        },
        ...(ttl !== undefined ? { cacheTtlSeconds: ttl } : {}),
        ...(call.tool !== undefined ? { toolName: call.tool } : {}),
        ...(call.wireTool !== undefined ? { wireToolName: call.wireTool } : {}),
        ...riskTierField(call.tool),
        ...hop0ToolNames(snap, hop, isLykosChild),
        ...((hop === 0 || isLykosChild) && call.headFingerprint !== undefined
          ? { prefixFingerprint: call.headFingerprint }
          : {}),
        ...(call.source === "compaction"
          ? {
              ...(call.contextBefore !== undefined ? { contextBefore: call.contextBefore } : {}),
              ...(call.contextAfter !== undefined ? { contextAfter: call.contextAfter } : {}),
              ...(call.snipTokensRemoved !== undefined ? { snipTokensRemoved: call.snipTokensRemoved } : {}),
              ...(call.pruneTokensRemoved !== undefined ? { pruneTokensRemoved: call.pruneTokensRemoved } : {}),
            }
          : {}),
        // T26.1: undefined stays undefined — recordCall() already leaves
        // latency_ms/ttft_ms NULL rather than guessing when omitted.
        ...(call.latencyMs !== undefined ? { latencyMs: call.latencyMs } : {}),
        ...(call.ttftMs !== undefined ? { ttftMs: call.ttftMs } : {}),
        ...(call.modelSwitched === true ? { modelSwitched: true } : {}),
        ...(call.specialistSwitched === true ? { specialistSwitched: true } : {}),
      });
      (hop === 0 || isLykosChild ? parentWriter : childWriter)?.append(
        {
          kind: "usage",
          call_id: callId,
          hop,
          ...(call.source !== undefined ? { source: call.source } : {}),
          provider: ref.provider,
          model: ref.model,
          input: call.input ?? 0,
          output: call.output ?? 0,
          cache_read: call.cacheRead ?? 0,
          cache_write: call.cacheWrite ?? 0,
          ...(call.tool !== undefined ? { tool_name: call.tool } : {}),
          ...(call.source === "compaction" ? { phase: "compact" } : {}),
        },
        callTimestamp,
      );
    }
  } else {
    const ttl = cacheTtlSeconds(usage.cacheWrite ?? 0, usage.cacheWrite1h);
    const fallbackAccounting = resolveCallAccounting(fallback.provider, fallback.model, providers);
    const aggregateHop = isLykosChild ? 1 : 0;
    const directCallId = ledger.recordCall({
      sessionId: snap.sessionId,
      hop: aggregateHop,
      ts,
      agent: isLykosChild ? agentRole : "worker",
      provider: fallback.provider,
      model: fallback.model,
      authMode: fallbackAccounting.authMode,
      priceBasis: fallbackAccounting.priceBasis,
      tokens: {
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        cacheRead: usage.cacheRead ?? 0,
        cacheWrite: usage.cacheWrite ?? 0,
        reasoning: usage.reasoning ?? 0,
      },
      ...(ttl !== undefined ? { cacheTtlSeconds: ttl } : {}),
      // A Lykos child is hop 1 but still records its own tool surface — without
      // this the aggregate path writes NULL tool_count and tool_names for every
      // child, which is exactly the evidence the live acceptance leg asserts on.
      ...hop0ToolNames(snap, aggregateHop, isLykosChild),
    });
    parentWriter?.append(
      {
        kind: "usage",
        call_id: directCallId,
        hop: aggregateHop,
        provider: fallback.provider,
        model: fallback.model,
        input: usage.input ?? 0,
        output: usage.output ?? 0,
        cache_read: usage.cacheRead ?? 0,
        cache_write: usage.cacheWrite ?? 0,
      },
      ts,
    );
    if (!isLykosChild && usage.nestedBasis === "reported_usage") {
      const nestedCallId = ledger.recordCall({
        sessionId: hop1Session("subagent", fallback.model),
        hop: 1,
        ts,
        agent: "subagent",
        provider: fallback.provider,
        model: fallback.model,
        authMode: fallbackAccounting.authMode,
        priceBasis: fallbackAccounting.priceBasis,
        tokens: {
          input: usage.nestedInput ?? 0,
          output: usage.nestedOutput ?? 0,
          cacheRead: usage.nestedCacheRead ?? 0,
          cacheWrite: usage.nestedCacheWrite ?? 0,
        },
      });
      childWriter?.append(
        {
          kind: "usage",
          call_id: nestedCallId,
          hop: 1,
          provider: fallback.provider,
          model: fallback.model,
          input: usage.nestedInput ?? 0,
          output: usage.nestedOutput ?? 0,
          cache_read: usage.nestedCacheRead ?? 0,
          cache_write: usage.nestedCacheWrite ?? 0,
        },
        ts,
      );
    } else if (usage.nestedBasis === "tool_details_cost") {
      notes.push(
        `unpriced nested spend (nestedBasis=tool_details_cost, nestedCostUsd=${usage.nestedCostUsd ?? "?"}); no token counts to re-price`,
      );
    }
  }

  // T6.2 (docs/03-telemetry.md §4.1): one delegation-accounting row per
  // snapshot, once real hop-1 spend actually exists AND the trace actually
  // contains a `get_subagent_result` call to estimate the returned summary
  // from. Without that second condition, "summary tokens" would silently
  // read as 0 -- overstating avoided savings, which is the wrong direction
  // to err (unlike §4.3's SKIPPED case) -- so a snapshot whose toolCalls
  // don't carry it gets NO delegation row at all rather than an inflated
  // one: a missing row is the honest "not computed" per AGENTS.md rule 4.
  // Filed in the CHILD session (the same session_id the real hop=1 calls
  // above used) so v_delegation_by_hop's GROUP BY hop sees it alongside
  // them. Its own tokens are all zero -- it represents the delegation
  // BOUNDARY itself, not model usage of its own, and priceCall(0, 0, ...)
  // correctly prices that at exactly $0 while still resolving the rates
  // this needs.
  const hasSubagentResultCall = (snap.toolCalls ?? []).some((c) => c.name === "get_subagent_result");
  const fallbackAccounting = resolveCallAccounting(fallback.provider, fallback.model, providers);
  // An unpriced parent has no verified rate to model a counterfactual from
  // (T36.2). A missing delegation row is the honest "not computed".
  if (childSessionId !== undefined && hasSubagentResultCall && fallbackAccounting.priceBasis !== "unpriced") {
    const childTotals = ledger.callTotals(childSessionId);
    const summaryTokens = estimatedToolTextTokens(snap.toolCalls, "get_subagent_result", "result");
    const briefingTokens = estimatedToolTextTokens(snap.toolCalls, "agent", "args");
    const parentRates = priceCall({
      provider: fallback.provider,
      model: fallback.model,
      tokens: { input: 0, output: 0 },
      ts,
    }).rates;
    const childInputTokens = childTotals.input + childTotals.cacheRead;
    // "Charge the briefing tokens to the delegation" (§4.1): subtracted from
    // the token-savings side, not added to child cost, since briefing is
    // extra work the parent did in its OWN context that a non-delegated
    // path would never have paid for.
    const avoidedTokens = childInputTokens - summaryTokens - briefingTokens;
    const avoidedUsd = (avoidedTokens / 1e6) * parentRates.inputPerMtok - (childTotals.costUsd ?? 0);

    const delegationCallId = ledger.recordCall({
      sessionId: childSessionId,
      hop: 1,
      ts,
      agent: "subagent",
      phase: "delegate_summary",
      provider: fallback.provider,
      model: fallback.model,
      authMode: fallbackAccounting.authMode,
      priceBasis: fallbackAccounting.priceBasis,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      childInputTokens,
      summaryTokens,
      briefingTokens,
      handoffLoss: 0,
      avoidedUsd,
      avoidedBasis: DELEGATION_AVOIDED_BASIS,
    });
    childWriter?.append(
      {
        kind: "usage",
        call_id: delegationCallId,
        hop: 1,
        phase: "delegate_summary",
        provider: fallback.provider,
        model: fallback.model,
        input: 0,
        output: 0,
        cache_read: 0,
        cache_write: 0,
      },
      ts,
    );
  }

  const compactionCount = Array.isArray(calls)
    ? calls.filter((c) => c.source === "compaction").length
    : 0;
  // T63: one pass over the trace produces the count, both byte totals and the
  // per-kind breakdown. The version travels with them so the row can never be
  // mistaken for a v1 row (docs/20-phase9-tasks.md §2).
  const exploration = summarizeExploration(snap.toolCalls);
  // T64: hit quality against the session's own answer key — the files it
  // actually edited. Same trace, same pass, no new capture.
  const hq = computeHitQuality(snap.toolCalls);
  // T111.3: same trace again, third consumer.
  const substrate = summarizeToolSubstrate(snap.toolCalls);
  const end: {
    id: string;
    turns: number;
    toolCalls: number;
    exploreToolCalls: number;
    exploreMetricVersion: number;
    exploreResultBytes: number;
    toolResultBytes: number;
    exploreBreakdown: string;
    editedFiles: string;
    editedFileCount: number;
    blindEdits: number;
    firstTouchRank: number | null;
    hitQuality: number | null;
    hitQualityVersion: number;
    editToolCalls: number;
    editErrorCount: number;
    editRetryCount: number;
    hooksRegistered?: number;
    hookDenials?: number;
    hookNotes?: number;
    checkpointsWritten?: number;
    askCalls?: number;
    askAnswered?: number;
    askUnanswered?: number;
    skillsAvailable?: number;
    skillsInvoked?: string;
    skillReads?: number;
    skillsHeadTokens?: number;
    postEditCommand?: string;
    postEditRuns?: number;
    postEditFailures?: number;
    postEditPasses?: number;
    postEditMs?: number;
    postEditDisabledReason?: string;
    taskListCalls?: number;
    taskListCreated?: number;
    taskListCompleted?: number;
    taskListOpen?: number;
    taskListReminders?: number;
    taskGateRefusals?: number;
    taskItemsVerified?: number;
    stagnationTrips?: number;
    stagnationKey?: string;
    artifactBytes?: number;
    approvalsRequested?: number;
    approvalsDenied?: number;
    approvalsAutoDenied?: number;
    approvalsByTier?: string;
    approvalsByMode?: string;
    toolCallCounts?: string;
    actualToolCallCounts?: string;
    toolErrorCounts?: string;
    toolAdjacentPairs?: number;
    toolSwitchSameTarget?: number;
    toolLoaderEnabled?: boolean;
    toolLoaderPath?: string;
    toolLoaderDeferred?: string;
    toolLoaderActivated?: string;
    toolLoaderActivations?: number;
    toolLoaderTokens?: number;
    toolLoaderDeferredTokens?: number;
    modelFallbacks?: string;
    retryStarts?: number;
    retriesRecovered?: number;
    retriesExhausted?: number;
    retryMaxAttempt?: number;
    retryLastError?: string;
    compactions?: number;
    humanInterventions?: number;
    notes?: string;
    outcome?: "fail" | "abandoned";
  } = {
    id: snap.sessionId,
    turns: snap.turns ?? 0,
    toolCalls: Array.isArray(snap.toolCalls) ? snap.toolCalls.length : 0,
    exploreToolCalls: exploration.exploreToolCalls,
    exploreMetricVersion: exploration.metricVersion,
    exploreResultBytes: exploration.exploreResultBytes,
    toolResultBytes: exploration.toolResultBytes,
    exploreBreakdown: serializeBreakdown(exploration),
    editedFiles: serializeEditedFiles(hq),
    editedFileCount: hq.editedFileCount,
    blindEdits: hq.blindEdits,
    firstTouchRank: hq.firstTouchRank,
    hitQuality: hq.hitQuality,
    hitQualityVersion: hq.version,
    // T24.3: edit-retry-rate baseline, from the same trace.
    editToolCalls: countEditToolCalls(snap.toolCalls),
    editErrorCount: countEditErrors(snap.toolCalls),
    editRetryCount: countEditRetries(snap.toolCalls),
    // T111.3: the tool-selection substrate, off the same trace and the same
    // pass as exploration and hit quality above — no new capture. Written
    // unconditionally for the same reason those two are: it is derived from
    // the trace this function already has, so "computed and empty" is a
    // real measurement rather than an assumption.
    toolCallCounts: serializeCounts(substrate.callCounts),
    actualToolCallCounts: serializeCounts(substrate.actualCallCounts),
    toolErrorCounts: serializeCounts(substrate.errorCounts),
    toolAdjacentPairs: substrate.adjacentPairs,
    toolSwitchSameTarget: substrate.switchSameTarget,
    // T111.1: written only when something observed the spill.
    ...(snap.artifactBytes !== undefined ? { artifactBytes: snap.artifactBytes } : {}),
    // T111.2: written only when a gate observed the session. A snapshot
    // with no approval block leaves every column NULL — an MCP worker has
    // no human to ask, which is not a gate that never asked.
    ...(snap.approvals !== undefined
      ? {
          approvalsRequested: snap.approvals.requested ?? 0,
          approvalsDenied: snap.approvals.denied ?? 0,
          approvalsAutoDenied: snap.approvals.autoDenied ?? 0,
          ...(snap.approvals.byTier !== undefined ? { approvalsByTier: snap.approvals.byTier } : {}),
          ...(snap.approvals.byMode !== undefined ? { approvalsByMode: snap.approvals.byMode } : {}),
        }
      : {}),
    // T132: written only when the session actually had a loader surface.
    ...(snap.toolLoader !== undefined
      ? {
          toolLoaderEnabled: snap.toolLoader.enabled === true,
          toolLoaderActivations: snap.toolLoader.activations ?? 0,
          toolLoaderActivated: JSON.stringify(snap.toolLoader.activated ?? []),
          toolLoaderDeferred: JSON.stringify(snap.toolLoader.deferred ?? []),
          ...(snap.toolLoader.path !== undefined ? { toolLoaderPath: snap.toolLoader.path } : {}),
          ...(snap.toolLoader.loaderTokens !== undefined ? { toolLoaderTokens: snap.toolLoader.loaderTokens } : {}),
          ...(snap.toolLoader.deferredTokens !== undefined
            ? { toolLoaderDeferredTokens: snap.toolLoader.deferredTokens }
            : {}),
        }
      : {}),
    ...(snap.modelFallbacks !== undefined ? { modelFallbacks: snap.modelFallbacks } : {}),
    // T105: written only when the snapshot carried a hook block.
    ...(snap.hooks !== undefined
      ? {
          hooksRegistered: snap.hooks.registered ?? 0,
          hookDenials: snap.hooks.denials ?? 0,
          hookNotes: snap.hooks.notes ?? 0,
        }
      : {}),
    // T104: written only when the snapshot carried a checkpoint block AND
    // checkpointing was actually in force — a session outside a git
    // repository records NULL, not 0, because it had no undo rather than an
    // unused one.
    ...(snap.checkpoints !== undefined && snap.checkpoints.enabled === true
      ? { checkpointsWritten: snap.checkpoints.written ?? 0 }
      : {}),
    // T103: written only when the snapshot carried a channel.
    ...(snap.ask !== undefined
      ? {
          askCalls: snap.ask.asked ?? 0,
          askAnswered: snap.ask.answered ?? 0,
          askUnanswered: snap.ask.unanswered ?? 0,
        }
      : {}),
    // T102: written only when the snapshot carried a skills block.
    ...(snap.skills !== undefined
      ? {
          skillsAvailable: snap.skills.available ?? 0,
          skillsInvoked: JSON.stringify(snap.skills.invoked ?? []),
          skillReads: snap.skills.reads ?? 0,
          skillsHeadTokens: snap.skills.headTokens ?? 0,
        }
      : {}),
    // T99: written only when the snapshot carried a post-edit block. The
    // COMMAND is recorded because "runs: 0" means two different things
    // depending on whether there was a command to run at all.
    ...(snap.postEdit !== undefined
      ? {
          ...(snap.postEdit.command ? { postEditCommand: snap.postEdit.command } : {}),
          postEditRuns: snap.postEdit.runs ?? 0,
          postEditFailures: snap.postEdit.failures ?? 0,
          postEditPasses: snap.postEdit.passes ?? 0,
          postEditMs: snap.postEdit.totalMs ?? 0,
          ...(snap.postEdit.disabledReason !== undefined
            ? { postEditDisabledReason: snap.postEdit.disabledReason }
            : {}),
        }
      : {}),
    // T98/T100: written only when the snapshot carried a list at all.
    ...(snap.taskList !== undefined
      ? {
          taskListCalls: snap.taskList.calls ?? 0,
          taskListCreated: snap.taskList.created ?? 0,
          taskListCompleted: snap.taskList.completed ?? 0,
          taskListOpen: snap.taskList.open ?? 0,
          taskListReminders: snap.taskList.reminders ?? 0,
          taskGateRefusals: snap.taskList.gateRefusals ?? 0,
          taskItemsVerified: snap.taskList.verified ?? 0,
        }
      : {}),
    ...(snap.stagnation !== undefined
      ? {
          stagnationTrips: snap.stagnation.trips ?? 0,
          ...(snap.stagnation.key !== undefined ? { stagnationKey: snap.stagnation.key } : {}),
        }
      : {}),
    // T83: only written when the snapshot carried an observation at all.
    // A pre-T83 snapshot leaves these NULL rather than claiming zero.
    ...(snap.retry !== undefined
      ? {
          retryStarts: snap.retry.starts ?? 0,
          retriesRecovered: snap.retry.recovered ?? 0,
          retriesExhausted: snap.retry.exhausted ?? 0,
          retryMaxAttempt: snap.retry.maxAttempt ?? 0,
          ...(snap.retry.lastError !== undefined ? { retryLastError: snap.retry.lastError } : {}),
        }
      : {}),
    ...(compactionCount > 0 ? { compactions: compactionCount } : {}),
    // T34.3: the first writer human_interventions has ever had.
    ...(snap.humanInterventions !== undefined ? { humanInterventions: snap.humanInterventions } : {}),
  };
  if (notes.length > 0 || snap.error) {
    end.notes = [snap.error, ...notes].filter(Boolean).join("; ");
  }
  if (snap.state === "aborted") end.outcome = "abandoned";
  else if (snap.state === "error" || snap.state === "failed") end.outcome = "fail";

  if (parentWriter) {
    // Under live capture every turn's reply is already on the file, in the
    // order it happened; re-appending the snapshot's copy of the last one
    // would duplicate it and make the final turn look like two.
    if (snap.lastText && !liveRecorder) {
      parentWriter.append({ kind: "assistant_message", text: snap.lastText, final: true }, ts);
    }
    if (snap.error) parentWriter.append({ kind: "error", message: snap.error }, ts);
    parentWriter.append(
      {
        kind: "outcome",
        ...(snap.state !== undefined ? { state: snap.state } : {}),
        turns: end.turns,
        tool_calls: end.toolCalls,
        ...(end.outcome !== undefined ? { outcome: end.outcome } : {}),
      },
      ts,
    );
  }
  const parentTranscript = parentWriter?.finalize();
  ledger.endSession({
    ...end,
    // The run's real end (snap.finishedAt, falling back to "now" — same as
    // `ts` above), not ingestion time: see StartSessionInput.startedUtc.
    endedUtc: ts.toISOString(),
    ...(parentTranscript !== undefined
      ? {
          transcriptPath: parentTranscript.path,
          transcriptSha256: parentTranscript.sha256,
          transcriptBytes: parentTranscript.bytes,
        }
      : {}),
  });

  // T5.1: printed at the end of every run (stderr, from the caller — stdout is
  // the MCP transport, docs/03-telemetry.md §1.2) and stored verbatim beside
  // the transcript. Session-only, not per-call, so this runs once here rather
  // than inside the transaction above.
  if (ledger.path !== ":memory:") {
    const summary = loadSessionSummary(ledger, snap.sessionId);
    if (summary) {
      writeFileSync(join(transcriptDir(ledger.path, snap.sessionId), "summary.txt"), formatSessionSummary(summary), "utf8");
    }
  }

  if (childSessionId !== undefined) {
    childWriter?.append(
      { kind: "outcome", ...(end.outcome !== undefined ? { outcome: end.outcome } : {}) },
      ts,
    );
    const childTranscript = childWriter?.finalize();
    ledger.endSession({
      id: childSessionId,
      ...(end.outcome !== undefined ? { outcome: end.outcome } : {}),
      endedUtc: ts.toISOString(),
      notes: "hop-1 aggregate — see parent session (parent_session_id) for the rest of this run",
      ...(childTranscript !== undefined
        ? {
            transcriptPath: childTranscript.path,
            transcriptSha256: childTranscript.sha256,
            transcriptBytes: childTranscript.bytes,
          }
        : {}),
    });
  }
}

function toToolCallEvent(call: DelegateToolCall): ToolCallEvent {
  return {
    kind: "tool_call",
    name: call.name,
    state: call.state ?? "unknown",
    ...(call.ms !== undefined ? { ms: call.ms } : {}),
    ...(call.args !== undefined ? { args: call.args } : {}),
    ...(call.result !== undefined ? { result: call.result } : {}),
  };
}

function snapshotsFromParsed(parsed: unknown): DelegateSnapshot[] {
  if (isSnapshot(parsed)) return [parsed];
  if (Array.isArray(parsed)) return parsed.filter(isSnapshot);
  if (parsed !== null && typeof parsed === "object" && "sessions" in parsed) {
    const sessions = (parsed as { sessions: unknown }).sessions;
    if (Array.isArray(sessions)) return sessions.filter(isSnapshot);
  }
  return [];
}

export function snapshotsFromMcpResult(result: unknown): DelegateSnapshot[] {
  if (result === null || typeof result !== "object") return [];
  const r = result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  if (r.isError) return [];
  const text = r.content?.[0]?.text;
  if (typeof text !== "string") return [];
  try {
    return snapshotsFromParsed(JSON.parse(text) as unknown);
  } catch {
    return [];
  }
}

// No live caller since the delegate server was deleted (T185). Kept, with tryIngestMcpJsonRpcLine
// below, to re-ingest a recorded delegate-snapshot line: ingest.test.ts drives it, and those
// snapshots are how older sessions were captured.
export function ingestMcpJsonRpcLine(
  line: string,
  opts: { workspace: string; ledgerPath?: string; registryPath?: string },
): string[] {
  const trimmed = line.replace(/\r$/, "").trim();
  if (!trimmed.startsWith("{")) return [];
  let msg: { result?: unknown };
  try {
    msg = JSON.parse(trimmed) as { result?: unknown };
  } catch {
    return [];
  }
  if (msg.result === undefined) return [];
  const snaps = snapshotsFromMcpResult(msg.result);
  if (snaps.length === 0) return [];
  const ledger = openWorkspaceLedger(opts.workspace, opts.ledgerPath);
  const written: string[] = [];
  for (const snap of snaps) {
    const id = ingestDelegateSnapshot(ledger, snap, {
      workspace: opts.workspace,
      ...(opts.registryPath !== undefined ? { registryPath: opts.registryPath } : {}),
    });
    if (id) written.push(id);
  }
  return written;
}

/**
 * Same work as `tryIngestMcpJsonRpcLine`, but returns the top-level (parent)
 * session ids actually written — never a hop-1 child's — so a caller that
 * needs to act on a freshly-ingested session (T7's post-ingest run-cap check) doesn't have to re-parse the line itself.
 */
export function ingestMcpJsonRpcLineWithSummary(
  line: string,
  opts: { workspace: string; ledgerPath?: string; registryPath?: string },
): string[] {
  try {
    const written = ingestMcpJsonRpcLine(line, opts);
    // T5.1: "printed at the end of every run" (docs/03-telemetry.md §1.2).
    // stderr only: stdout is the MCP transport and must carry nothing but the
    // pass-through JSON-RPC stream (CLAUDE.md, "stdout belongs to the
    // transport in MCP mode").
    if (written.length > 0) {
      const ledger = openWorkspaceLedger(opts.workspace, opts.ledgerPath);
      for (const id of written) {
        const summary = loadSessionSummary(ledger, id);
        if (summary) process.stderr.write(`\n${formatSessionSummary(summary)}\n`);
      }
    }
    return written;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`lykos ledger: ${message}\n`);
    return [];
  }
}

export function tryIngestMcpJsonRpcLine(
  line: string,
  opts: { workspace: string; ledgerPath?: string; registryPath?: string },
): void {
  ingestMcpJsonRpcLineWithSummary(line, opts);
}

/** Independent re-price of a snapshot, for the T3 acceptance check. */
export function pricedSnapshotTotal(snap: DelegateSnapshot, ts: Date): number {
  const usage = snap.usage;
  if (!usage) return 0;
  const ref = parseProviderModel(snap.model);
  const ttl = cacheTtlSeconds(usage.cacheWrite ?? 0, usage.cacheWrite1h);
  const base = {
    provider: ref.provider,
    model: ref.model,
    ts,
    ...(ttl !== undefined ? { cacheTtlSeconds: ttl } : {}),
  };
  let total = priceCall({
    ...base,
    tokens: {
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
    },
  }).costUsd;
  if (usage.nestedBasis === "reported_usage") {
    total += priceCall({
      ...base,
      tokens: {
        input: usage.nestedInput ?? 0,
        output: usage.nestedOutput ?? 0,
        cacheRead: usage.nestedCacheRead ?? 0,
        cacheWrite: usage.nestedCacheWrite ?? 0,
      },
    }).costUsd;
  }
  return total;
}

