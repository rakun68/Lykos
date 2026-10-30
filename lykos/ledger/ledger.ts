// Append-only cost ledger. Corrections are new rows, never UPDATEs to call
// rows. endSession() is the one allowed UPDATE: it fills fields that did not
// exist at start (ended_utc, outcome, totals), which is completing a row,
// not rewriting history. See DECISIONS.md T3.

import { hostGit } from "../git/host-git.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { CACHE_AVOIDED_BASIS, cacheAvoidedUsd, currentPriceTable, priceCall, type PriceCallTokens } from "./prices.js";
import { redactSecrets } from "./redact.js";
import { measureToolset, type ToolSchemaMeasurement } from "./tool-schema.js";
import type { RiskTier } from "../tools.js";
import {
  LiveWriteThrottle,
  writeLiveSnapshot,
  writeTodayRollup,
  type LiveSnapshot,
  type TodayRollup,
} from "./live.js";

export type Outcome = "success" | "fail" | "abandoned";
export type OutcomeSource = "verification_command" | "human" | "agent_claim";
export type ModelSource = "role_default" | "caller_override" | "budget_downgrade";
/** T25.1 (docs/13-model-access.md §5.1): how a call was authenticated. */
export type AuthMode =
  | "api_key"
  | "oauth_subscription"
  | "vendor_cli"
  | "cloud_provider"
  | "gateway"
  | "unknown";
/** T25.2 (docs/13-model-access.md §5.2): what the dollar figure means.
 * 'unpriced' rows carry tokens and a NULL cost_usd — never an invented one. */
export type PriceBasis = "api_list" | "plan_credit" | "unpriced";
/** T31.1 (docs/15-phase3-tasks.md): which of Lykos's own execution paths
 * produced this session. Unenforced by SQLite on a migrated ledger (ALTER
 * TABLE cannot add a CHECK constraint) — enforced here instead. */
export type ExecutionShape = "mcp_worker" | "cli_delegate" | "standalone" | "subagent";
/** T31.2: where the session ran. Not the same axis as ExecutionShape --
 * Phase 3's outcome-3 case is a standalone session that still runs
 * `container`, which is exactly why the two are separate columns. */
export type Runtime = "container" | "host";
/**
 * T53 (docs/19-phase4-tasks.md): where a session's transcript came from.
 * `stream` is written live off the agent's own `AgentSessionEvent`s and
 * contains the human side of the conversation, so it can be replayed;
 * `snapshot` is the historical terminal-snapshot subset, which has no user
 * messages in it at all and therefore cannot honestly be resumed as a
 * conversation (T56 refuses it and offers the transcript as a brief).
 * NULL means "ran before this column existed" and is never backfilled.
 */
export type CaptureMode = "stream" | "snapshot";
/**
 * T35.3: who chose the model this session booted against.
 * `config_default` | `caller_override` | `specialist`. Distinct from
 * `calls.model_source` (`role_default` | `caller_override` | `budget_downgrade`),
 * which is the future router's per-call training data (Phase 7).
 */
export type SessionModelSource = "config_default" | "caller_override" | "specialist";
export type TrustSource = "stored" | "flag" | "prompt";

export interface SessionFlags {
  retrieval?: boolean;
  proactiveCompaction?: boolean;
  routing?: boolean;
  draftVerify?: boolean;
  delegation?: boolean;
  cacheStableHead?: boolean;
  /** T20: hop-0 allowlist was the documented D2.3 surface. */
  trimmedToolSurface?: boolean;
  /** T21: prompt diet (lean head + AGENTS.md + live tool-result cap) was in force. */
  promptDiet?: boolean;
  /** T23: the YAGNI/one-liner output rule was in the frozen head. Distinct from
   * promptDiet — that is a format rule true for every specialist, this is a
   * behavioural rule scoped to budget/cheap-worker presets. */
  outputDiet?: boolean;
  /** T65: a memory block was frozen into this session's head. The on/off side
   * of problems/09's Experiment H, recorded so the comparison is possible. */
  memoryInject?: boolean;
}

export interface StartSessionInput {
  id?: string;
  taskId?: string;
  brief?: string;
  difficultyEstimate?: number;
  harnessCommit?: string;
  flags?: SessionFlags;
  /** T19: compaction share in force (0.65–0.85). Recorded, never guessed. */
  compactionThreshold?: number;
  /** T21.3: JSON of context files frozen into the head. */
  contextFiles?: string;
  /** T65: which memory entries were frozen into the head, and what they cost.
   * problems/09 mitigation 1: without the ids, a memory-caused failure is
   * unattributable and the whole problem is undiagnosable. */
  memoryInjectedIds?: string;
  memoryInjectTokens?: number;
  memoryEntriesAvailable?: number;
  memoryEntriesSkipped?: number;
  /** T69: the repo map frozen into the head, and what it cost. */
  repoMapTokens?: number;
  repoMapFiles?: number;
  repoMapDropped?: number;
  repoMapTracked?: number;
  /** T70: coverage of the map against what the session actually did. */
  mapEditedCovered?: number;
  mapEditedMissed?: number;
  mapMissedPaths?: string;
  mapExploreCovered?: number;
  mapExploreUncovered?: number;
  /** T29.4: JSON array of {name, version} in declaration order. Omit when nothing was declared. */
  extensions?: string;
  /** T29.4: extensionSetKey() handle for the set in force. Always recorded ("none" for empty). */
  extensionSet?: string;
  /** T29.3: schema-tax delta beyond Pi's own built-ins. Omit — never guess — when measureToolset()
   * hit a tool name the catalog doesn't know. */
  extensionSchemaTokens?: number;
  extensionSchemaShare?: number;
  notes?: string;
  /** Directory used to resolve `git rev-parse HEAD` when harnessCommit is omitted. */
  workspace?: string;
  /**
   * Defaults to "now". A post-hoc ingest (the only capture path today — see
   * DECISIONS.md T9) calls startSession() and endSession() back-to-back once
   * a run has ALREADY finished, so "now" for both would make every session's
   * wall time read ~0s regardless of how long the real run took. Callers with
   * a real historical start (the snapshot's own `startedAt`) should pass it.
   */
  startedUtc?: string;

  /** T8 identity (docs/08-sessions-and-archive.md §1). */
  projectId?: string;
  /** Set when this session IS a subagent spawned by another session. */
  parentSessionId?: string;
  /** Set when this session continues an earlier one (`lykos resume`). */
  resumedFrom?: string;
  /** T109: boundaries crossed by this task; NULL on pre-T109 rows. */
  continuationsUsed?: number;
  /** The PROJECT's working-tree commit at session start (not harnessCommit). */
  gitCommit?: string;
  gitDirty?: boolean;
  agentRole?: string;
  model?: string;
  /** T119: the model selected at boot, before any session-only switch. */
  modelSwitches?: number;
  modelPath?: string;
  /** Specialists ticket 04: mid-session `/specialist <name>` switches, same shape as modelSwitches/modelPath. */
  specialistSwitches?: number;
  specialistPath?: string;
  /** T117: how this run crossed the workspace trust boundary. */
  trustSource?: TrustSource;
  /**
   * T35.3: who chose `model`. Omit — leave NULL — when unknown (every
   * session before this column). Never guess `config_default` for a
   * historical row: a guessed backfill is indistinguishable from data.
   */
  modelSource?: SessionModelSource;
  /** T23.3: which capability specialist this session ran under. NULL until
   * specialists land (Phase 8) rather than a guessed value. */
  specialist?: string;
  /**
   * Note: `archive_state` is NOT settable here. It is written by exactly two
   * places — `'live'` at insert, `'recent'` in `endSession()` — and moved to
   * `'archived'` only by `lykos archive`, which is the one thing in the
   * product that ever rewrites a transcript file (T55).
   */
  /** T53: `stream` or `snapshot`. Omit only when genuinely unknown — a NULL here is "predates the column", not "unrecorded by accident". */
  captureMode?: CaptureMode;
  /** Defaults to true; set false for a session Lykos cannot resume and say why. */
  resumable?: boolean;
  notResumableReason?: string;
  /** T31.1: which execution path produced this session. Omit only for a
   * caller that predates T31 — every caller written since must supply it. */
  executionShape?: ExecutionShape;
  /** T31.2: where the session ran. */
  runtime?: Runtime;
  /** T173: what the session asked for and got. Absent only for a caller that predates it. */
  containment?: {
    requested: string;
    used: string;
    runtime?: string;
    runtimeVersion?: string;
    image?: string;
    network?: string;
    mount?: string;
  };
  /** T128/T129: session lifecycle and browser instrumentation. */
  closedUtc?: string;
  deletedUtc?: string;
  browserFanoutMs?: number;
  browserProjectsScanned?: number;
  browserRowsReturned?: number;
}

export interface StartTaskInput {
  id?: string;
  projectId: string;
  brief: string;
  difficultyEstimate?: number;
  state?: "open" | "done" | "abandoned";
}

export interface ProjectMirrorInput {
  id: string;
  rootPath: string;
  gitRemote?: string | null;
  firstCommit?: string | null;
  name?: string | null;
  createdUtc: string;
  lastSeenUtc?: string | null;
}

/** T80: a human recording that they re-derived something. */
export interface RecordRediscoveryInput {
  lesson: string;
  sessionId?: string;
  sourceSessionId?: string;
  wouldHaveHelped?: boolean;
  callsSpent?: number;
  /** Must be "human". Present so the refusal below is explicit rather than implied. */
  author: string;
  tsUtc?: string;
}

/** T76 (docs/23-phase10-tasks.md): one memory entry's fate in one session. */
export interface MemoryEligibilityInput {
  entryId: string;
  scope: string;
  file: string;
  /** injected | skipped_cap. The CHECK constraint is the real enforcement. */
  state: string;
  position: number;
  tokens: number;
}

export const SEAL_EVENT_KINDS = [
  "created",
  "verified",
  "tampered",
  "vetoed",
  "bash-warned",
  "rejected",
  "failed",
  "not collected",
  "disputed",
  "weakened",
  "tamper_attempted",
  "dispute filed",
  "dispute escalated",
  "dispute upheld",
  "dispute rejected",
] as const;

export type SealEventKind = (typeof SEAL_EVENT_KINDS)[number];

/** T195: sealed TDD ledger event input. */
export interface SealEventInput {
  ts?: string;
  sessionId?: string | null;
  creator?: string;
  specialist?: string | null;
  branch: string;
  kind: SealEventKind;
  paths: readonly string[] | string;
  detail?: string | Record<string, unknown> | null;
}

/** T195: sealed TDD ledger event row. */
export interface SealEventRow {
  id: number;
  ts: string;
  session_id: string | null;
  creator: string;
  specialist: string | null;
  branch: string;
  kind: string;
  paths: string;
  detail: string | null;
}

export interface RecordCallInput {
  sessionId: string;
  parentCallId?: string;
  hop?: number;
  ts?: Date;
  agent: string;
  phase?: string;
  provider: string;
  model: string;
  modelVersion?: string;
  tokens: PriceCallTokens & { reasoning?: number };
  cacheTtlSeconds?: number;
  latencyMs?: number;
  ttftMs?: number;
  turnIndex?: number;
  retries?: number;
  error?: string;
  toolName?: string;
  wireToolName?: string;
  /**
   * P14.6 ticket 06: the non-secret label of the Lykos credential that served
   * this call (an email, `key#2`). Never a key or token. Omitted = NULL.
   */
  credentialLabel?: string;
  /**
   * T107.5: the risk tier this call's tool carries. Omit it whenever the
   * tier is not knowable for this row — it is written straight through, so
   * an omission lands as NULL rather than as a guess.
   */
  riskTier?: RiskTier;
  toolResultBytes?: number;
  toolResultTruncated?: boolean;
  contextBefore?: number;
  contextAfter?: number;
  compactionTriggered?: boolean;
  /** T19: tokens snip removed before the summariser saw this history. */
  snipTokensRemoved?: number;
  /** T19: tokens prune removed after snip, before the summariser. */
  pruneTokensRemoved?: number;
  modelSource?: ModelSource;
  /** T119: true on the first call after a user-selected model switch. */
  modelSwitched?: boolean;
  /** Specialists ticket 04: true on the first call after a `/specialist <name>` switch. */
  specialistSwitched?: boolean;
  childInputTokens?: number;
  summaryTokens?: number;
  briefingTokens?: number;
  handoffLoss?: number;
  /**
   * Overrides the T6.1 cache-avoided figure recordCall() computes automatically
   * from this call's own cache tokens. Pass this for a mechanism with a more
   * specific claim about the same row (e.g. T6.2 delegation, once wired) —
   * omit it to get the cache figure, which is what almost every call wants.
   */
  avoidedUsd?: number;
  avoidedBasis?: string;
  /**
   * Active tool names in API order. Looked up in the T4.1 catalog.
   * Omit when unknown — tokens stay NULL rather than a silent 0.
   */
  toolNames?: string[];
  /**
   * T16.2: SHA-256 of the REAL observed request head (system prompt + active
   * tool names), computed host-side by the session engine from
   * live session state. Distinct from tool_schema_hash above, which
   * is a catalog reconstruction of the tools half only. Omit when unavailable
   * — never guess one from the catalog.
   */
  prefixFingerprint?: string;
  /** Defaults to 'pi_delegate_mcp_worker_host_state' — the only source today. */
  prefixFingerprintSource?: string;
  /** T25.1: defaults to 'api_key' for callers that skip ingest. Ingest
   *  (T36.1) always passes the value from resolveCallAccounting() — never
   *  this default — so an undeclared provider cannot inherit a guessed key. */
  authMode?: AuthMode;
  /**
   * T25.2: defaults to 'api_list'. Pass 'unpriced' for a reachable provider
   * whose rates or cache semantics are not yet verified from primary docs —
   * priceCall() is skipped entirely and cost_usd/price_version/rate_window
   * are recorded NULL rather than invented (AGENTS.md rule 4). Tokens are
   * still recorded in full.
   */
  priceBasis?: PriceBasis;
}

export interface EndSessionInput {
  id: string;
  outcome?: Outcome;
  outcomeSource?: OutcomeSource;
  verificationCmd?: string;
  verificationOutput?: string;
  notes?: string;
  turns?: number;
  toolCalls?: number;
  /**
   * T21.4, redefined by T63: exploration calls from the snapshot trace.
   *
   * Pass `exploreMetricVersion` alongside it or the row is written as v1.
   * A caller that supplies a current count without the version would produce a
   * row indistinguishable from a v1 row, which is the one thing the
   * no-backfill rule exists to prevent.
   */
  exploreToolCalls?: number;
  /** T63: which definition produced `exploreToolCalls`. Omit → the row stays NULL (v1). */
  exploreMetricVersion?: number;
  /** T63: result bytes from exploration calls, and from every tool call. The share's two halves. */
  exploreResultBytes?: number;
  toolResultBytes?: number;
  /** T63: JSON per-kind breakdown, so T67 can apply either definition of exploration. */
  exploreBreakdown?: string;
  /** T64: hit quality against the session's own answer key — the files it edited. */
  editedFiles?: string;
  editedFileCount?: number;
  blindEdits?: number;
  firstTouchRank?: number | null;
  hitQuality?: number | null;
  hitQualityVersion?: number;
  /** T24.3: edit-retry-rate baseline, from the same snapshot trace. */
  editToolCalls?: number;
  editErrorCount?: number;
  editRetryCount?: number;
  /** T89: `from>to` per model switch; NULL when the session stayed put. */
  modelFallbacks?: string;
  /**
   * T111.1: bytes spilled to `artifacts/`. NULL when no transcript writer
   * observed the session; 0 when one did and nothing was oversized.
   */
  artifactBytes?: number;
  /**
   * T111.2: approval friction by tier and by mode. NULL when no gate
   * observed the session; 0 when one ran and never had to ask. `denied` is
   * a subset of `requested`; `autoDenied` is the mode refusing with nobody
   * asked, and is deliberately not folded into either.
   */
  approvalsRequested?: number;
  approvalsDenied?: number;
  approvalsAutoDenied?: number;
  approvalsByTier?: string;
  approvalsByMode?: string;
  /**
   * T111.3: the tool-selection substrate. Raw counts, never a rate, and
   * never an accuracy — see `session/tool-substrate.ts` for why that metric is
   * refused rather than unimplemented.
   */
  toolCallCounts?: string;
  /** D26: the same dispatches under the tool a transport call resolved to. Never summed with the above. */
  actualToolCallCounts?: string;
  toolErrorCounts?: string;
  toolAdjacentPairs?: number;
  toolSwitchSameTarget?: number;
  /**
   * T132: the loader surface. NULL when the session had no loader at all;
   * `toolLoaderEnabled: 1` with `toolLoaderActivations: 0` is the answer
   * the 2026-12-08 kill criterion reads.
   */
  toolLoaderEnabled?: boolean;
  toolLoaderPath?: string;
  toolLoaderDeferred?: string;
  toolLoaderActivated?: string;
  toolLoaderActivations?: number;
  toolLoaderTokens?: number;
  toolLoaderDeferredTokens?: number;
  /**
   * T110: the reviewer that did not write the code. NULL on pre-T110 rows
   * and sessions where reviewer did not run.
   */
  reviewerInvocations?: number;
  reviewerFindingsCount?: number;
  reviewerModel?: string;
  /** T105: the hook surface. NULL when the session had none. */
  hooksRegistered?: number;
  hookDenials?: number;
  hookNotes?: number;
  /** T104: turn checkpoints written. NULL when the session had no checkpointing. */
  checkpointsWritten?: number;
  /**
   * T103: clarification. NULL when the session had no human channel; 0 when
   * it had one and the model never asked.
   */
  askCalls?: number;
  askAnswered?: number;
  askUnanswered?: number;
  /**
   * T102: the skills roster and its use. NULL on every pre-T102 row; 0 with
   * an empty `skills_invoked` means the roster was offered and never read.
   */
  skillsAvailable?: number;
  skillsInvoked?: string;
  skillReads?: number;
  skillsHeadTokens?: number;
  /**
   * T99: the post-edit feedback loop. Absent means the session had no loop;
   * `postEditRuns: 0` with a command means the loop was on and nothing was
   * edited. NULL rather than 0 on every pre-T99 row.
   */
  postEditCommand?: string;
  postEditRuns?: number;
  postEditFailures?: number;
  postEditPasses?: number;
  postEditMs?: number;
  postEditDisabledReason?: string;
  /**
   * T98/T100: the task list. Absent means the session had no list mechanism
   * at all; 0 means it had one and nothing used it. NULL rather than 0 on
   * every pre-T98 row, same rule as the retry columns.
   */
  taskListCalls?: number;
  taskListCreated?: number;
  taskListCompleted?: number;
  taskListOpen?: number;
  taskListReminders?: number;
  taskGateRefusals?: number;
  taskItemsVerified?: number;
  /** T85: absent means the brake was not present; NULL rather than 0. */
  stagnationTrips?: number;
  stagnationKey?: string;
  /** T83: absent means not observed; the columns stay NULL rather than 0. */
  retryStarts?: number;
  retriesRecovered?: number;
  retriesExhausted?: number;
  retryMaxAttempt?: number;
  retryLastError?: string;
  compactions?: number;
  escalations?: number;
  humanInterventions?: number;
  /** Defaults to "now". Pass the snapshot's own `finishedAt` on a post-hoc ingest — see StartSessionInput.startedUtc. */
  endedUtc?: string;
  /** T129: an explicit human close is distinct from merely ending a turn. */
  closedUtc?: string;
  /** T9.3: the transcript pointer + integrity hash, so `doctor` can report a damaged file rather than silently believing it. */
  transcriptPath?: string;
  transcriptSha256?: string;
  transcriptBytes?: number;
}

/**
 * T52 (docs/17-phase35-terminal-ui-tasks.md). The writer `outcome` has never
 * had for anything but failure.
 *
 * The finding this exists to close (2026-09-01, review of Phase 3):
 * `ingest.ts` maps `aborted → abandoned` and `error|failed → fail` and
 * leaves everything else NULL, so `outcome = 'success'` had no writer
 * anywhere in the product except `doctor.ts`'s synthetic bench session.
 * Cost per successful task — the exit criterion of Phase 2, of Phase 3, and
 * of the whole cost thesis — was therefore not under-sampled but
 * *structurally unmeasurable*, and T40's re-open condition could never fire
 * no matter how much real work was done.
 *
 * Why this is not `endSession()`. Whether a task actually worked is not
 * knowable when the session ends: a verification command has to run, or a
 * person has to answer. By then the row is already ended (ingest ends it),
 * and `endSession()` correctly refuses a second call. So this is a separate,
 * narrower completion: it fills the outcome columns and nothing else, only
 * while `outcome` is still NULL, and it refuses to overwrite an answer the
 * ledger already holds. Still one allowed UPDATE of the kind this file's
 * header describes — completing a row with a fact that did not exist at
 * write time — not a rewrite of history.
 */
export interface RecordOutcomeInput {
  id: string;
  outcome: Outcome;
  /**
   * `agent_claim` is rejected outright — see `recordOutcome()`. It exists in
   * the schema so it can be *excluded*, and this writer is the one an
   * interactive surface reaches, which is exactly where an agent's opinion
   * would leak in.
   */
  outcomeSource: Exclude<OutcomeSource, "agent_claim">;
  verificationCmd?: string;
  verificationOutput?: string;
  /**
   * T144: the exit code the verification command returned. Only meaningful
   * with `verification_command`; when given, `outcome` must agree with it
   * (0 is `success`, anything else `fail`) or the write is refused.
   */
  verificationExitCode?: number;
  /**
   * T167 (ADR-0030): the session gate's one rerun of the failed test files,
   * when it happened. With it, `success` is accepted beside a non-zero
   * `verificationExitCode` — and only when the rerun exited 0 and named at
   * least one flaky test, none of them in a file the session edited. The
   * flaky tests are written in the same transaction as the outcome.
   */
  rerun?: {
    command: string;
    exitCode: number | null;
    flaky: FlakyTestInput[];
  };
  notes?: string;
  /** T201: a registered gate check blocked, turning success into fail. */
  gateBlocked?: boolean;
}

/** T167: one flaky test, as the gate found it. */
export interface FlakyTestInput {
  file: string;
  name: string;
  /** The session edited this test's file. */
  editedBySession: boolean;
}

/** T167: a `flaky_tests` row. */
export interface FlakyTestRow {
  session_id: string;
  ts_utc: string;
  test_file: string;
  test_name: string;
  edited_by_session: number;
  first_exit_code: number | null;
  rerun_exit_code: number | null;
  rerun_command: string;
}

/** T8's `tasks.state` domain, given a name now that T61 writes it (T203 adds 'disputed'). */
export type TaskState = "open" | "done" | "abandoned" | "disputed";

export interface CallTotals {
  n: number;
  costUsd: number | null;
  unpricedCalls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

function findTelemetryDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [here, join(here, "..", "..", "lykos", "ledger")];
  for (const dir of candidates) {
    if (existsSync(join(dir, "schema.sql"))) return dir;
  }
  throw new Error(`lykos ledger: schema.sql not found (looked in ${candidates.join(", ")})`);
}

/** T179: one commit a session made through `commit` (`tools/commit.ts` `CommitRecord`). */
export interface CommitRow {
  sha: string;
  tsUtc: string;
  subject: string;
  message: string;
  /** `null` when it could not be computed: unmeasured. */
  filesChanged: number | null;
  scope: "paths" | "all";
}

/** T179: a `commits` row as `lykos show` reads it. */
export interface CommitShown {
  sha: string;
  ts_utc: string;
  subject: string;
  message: string;
  files_changed: number | null;
  scope: "paths" | "all";
}

/** P4 T152: one compaction attempt, as `lykos-self-compact` records it (`loop/self-compact.ts` `CompactionRecord`). */
export interface CompactionRow extends CompactionUsage {
  id: string;
  ts: string;
  strategy: string;
  trigger: string;
  handoff_id?: string;
  attempt: number;
  model: string | null;
  tier: string | null;
  context_window: number | null;
  tokens_before: number | null;
  tokens_after: number | null;
  result: string;
  error?: string;
  /** T190: the chain method that ran, and the ones tried before it. */
  method?: string;
  fell_through?: ReadonlyArray<FellThrough>;
}

import type { CompactionUsage, FellThrough } from "../loop/compaction-chain.js";
import type { PruneReason } from "../loop/tool-result-prune.js";

/** T188: one prune pass, as `lykos-prune` records it (`loop/tool-result-prune.ts` `PruneRecord`). */
export interface PruneRow {
  id: string;
  ts: string;
  superseded: number;
  useless: number;
  tokens_saved: number;
  reason: PruneReason;
}

function optionalRedact(value: string | undefined): string | null {
  if (value === undefined) return null;
  return redactSecrets(value);
}

/**
 * Additive columns for existing ledgers, then views. CREATE TABLE IF NOT EXISTS
 * will not alter a table that already exists, so T4.1/T4.2 fields have to be
 * ADDed. SQLite cannot ADD COLUMN IF NOT EXISTS on older builds; we check
 * PRAGMA table_info instead.
 *
 * Tables first, then ALTER, then views: CREATE VIEW that selects those columns
 * fails if it runs before the ALTER. Split at the Views marker so an old T3
 * ledger can open after T4.1 without a rebuild.
 */
function applySchema(db: Database.Database): void {
  const sql = readFileSync(join(findTelemetryDir(), "schema.sql"), "utf8");
  const marker = "-- Views";
  const idx = sql.indexOf(marker);
  if (idx < 0) throw new Error("lykos ledger: schema.sql is missing the Views section");
  db.exec(sql.slice(0, idx));
  migrateCallsTable(db, sql);
  migrateSessionsTable(db);
  migrateTasksTable(db);
  migrateMemoryEligibility(db);
  migrateRediscoveryAnnotations(db);
  migrateCompactionsTable(db);
  migrateSealEvents(db);
  // T119: this view's grouping changed from session-only to session+model.
  // CREATE VIEW IF NOT EXISTS cannot replace the old definition on a ledger
  // that predates model switching, so refresh this derived view after all
  // additive columns exist and before the static view section is applied.
  db.exec(`DROP VIEW IF EXISTS v_cache_health`);
  // T63 follow-up: the exploration classifier is versioned, so refresh these
  // views too. Otherwise an existing ledger keeps the old v2 filter forever
  // because CREATE VIEW IF NOT EXISTS leaves its definition untouched.
  db.exec(`DROP VIEW IF EXISTS v_exploration`);
  db.exec(`DROP VIEW IF EXISTS v_exploration_summary`);
  db.exec(sql.slice(idx));
}

/**
 * Extracts one balanced `CREATE TABLE IF NOT EXISTS <name> (...);` statement
 * verbatim out of schema.sql's text. Used only by relaxCallsNotNullConstraints
 * below, so a ledger created before T25 can be rebuilt onto the CURRENT table
 * shape (ALTER TABLE cannot drop a NOT NULL constraint in SQLite — the
 * documented fix is to recreate the table). Paren-balance scanning (not a
 * regex) because CREATE TABLE calls's own column comments contain parenthesised
 * asides (e.g. "(docs/03-telemetry.md §4)") that a naive "up to the first )"
 * match would truncate on.
 */
function extractCreateTableSql(schemaSql: string, tableName: string): string {
  const marker = `CREATE TABLE IF NOT EXISTS ${tableName} (`;
  const start = schemaSql.indexOf(marker);
  if (start < 0) throw new Error(`lykos ledger: schema.sql has no CREATE TABLE for "${tableName}"`);
  let depth = 0;
  let i = start + marker.length - 1; // positioned at the opening '('
  for (; i < schemaSql.length; i++) {
    if (schemaSql[i] === "(") depth++;
    else if (schemaSql[i] === ")") {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  const semi = schemaSql.indexOf(";", i);
  if (semi < 0) throw new Error(`lykos ledger: schema.sql's CREATE TABLE ${tableName} has no terminating ";"`);
  return schemaSql.slice(start, semi + 1);
}

/**
 * T25.2: `cost_usd` and `price_version` were NOT NULL from T3 onward — right
 * for every row until now, wrong for an 'unpriced' one (docs/13-model-access.md
 * §5.2: "tokens recorded, dollars not invented"). SQLite has no ALTER TABLE
 * that drops a column constraint, so a ledger created before this migration
 * is rebuilt onto the current table shape: rename the old table aside,
 * recreate `calls` from schema.sql's own (now-nullable) definition, copy
 * every existing column across by name, drop the old table. A ledger created
 * fresh after T25 already has the relaxed constraint from CREATE TABLE IF NOT
 * EXISTS and this is a same-transaction no-op check.
 */
function relaxCallsNotNullConstraints(db: Database.Database, schemaSql: string): void {
  const info = db.prepare(`PRAGMA table_info(calls)`).all() as Array<{ name: string; notnull: number }>;
  if (info.length === 0) return; // table does not exist yet; CREATE TABLE IF NOT EXISTS above handles it
  const costCol = info.find((c) => c.name === "cost_usd");
  const priceCol = info.find((c) => c.name === "price_version");
  const needsRebuild = (costCol?.notnull ?? 0) === 1 || (priceCol?.notnull ?? 0) === 1;
  if (!needsRebuild) return;

  const oldColumns = info.map((c) => c.name);
  const createSql = extractCreateTableSql(schemaSql, "calls");
  // A real ledger this old already has T4.2/T16.2/etc.'s views in
  // sqlite_master, every one of them `SELECT ... FROM calls`. SQLite's
  // default ALTER TABLE RENAME rewrites views (and the self-referential
  // parent_call_id FK) to follow the new name automatically -- which would
  // leave those views pointing at "calls_pre_t25" the moment it is dropped
  // below, silently breaking every view `CREATE VIEW IF NOT EXISTS` in
  // schema.sql's own Views section then refuses to fix, because a view by
  // that name already (technically) exists. `legacy_alter_table` disables
  // that auto-rewrite for the duration of the rename, so the views keep
  // saying "FROM calls" verbatim and resolve correctly again the moment a
  // table named `calls` exists once more.
  db.pragma("legacy_alter_table = ON");
  try {
    const rebuild = db.transaction(() => {
      db.exec(`ALTER TABLE calls RENAME TO calls_pre_t25`);
      db.exec(createSql);
      db.exec(`INSERT INTO calls (${oldColumns.join(", ")}) SELECT ${oldColumns.join(", ")} FROM calls_pre_t25`);
      db.exec(`DROP TABLE calls_pre_t25`);
    });
    rebuild();
  } finally {
    db.pragma("legacy_alter_table = OFF");
  }
}

/**
 * T8 identity columns on `sessions`, same ADD-if-missing pattern as
 * migrateCallsTable. Indexes on these columns are created here rather than
 * in schema.sql's static section: on an old ledger the static section runs
 * BEFORE this migration, so an index on a column that migration hasn't
 * added yet would fail. Safe either way once run from here.
 */
/**
 * T76: create `memory_eligibility` on a ledger that predates it. A pre-T76
 * ledger simply has no rows, which is the honest answer -- those sessions
 * did not measure this. Nothing is backfilled from `memory_injected_ids`,
 * because that column cannot say what was skipped.
 */
/**
 * T190: the chain's columns on a `compactions` table that predates them.
 * Nothing is backfilled: an earlier row ran no chain and reported no usage.
 */
function migrateCompactionsTable(db: Database.Database): void {
  const cols = new Set((db.prepare(`PRAGMA table_info(compactions)`).all() as Array<{ name: string }>).map((c) => c.name));
  if (cols.size === 0) return; // CREATE TABLE IF NOT EXISTS has just made it, with the columns
  const add: Array<[string, string]> = [
    ["method", "TEXT CHECK (method IS NULL OR method IN ('note','handoff','shake','summary'))"],
    ["fell_through", "TEXT"],
    ["input_tokens", "INTEGER"],
    ["output_tokens", "INTEGER"],
    ["cache_read_tokens", "INTEGER"],
    ["cache_write_tokens", "INTEGER"],
    ["cache_write_1h_tokens", "INTEGER"],
  ];
  for (const [name, sqlType] of add) {
    if (!cols.has(name)) db.exec(`ALTER TABLE compactions ADD COLUMN ${name} ${sqlType}`);
  }
}

/** T80: create `rediscovery_annotations` on a ledger that predates it. */
function migrateRediscoveryAnnotations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rediscovery_annotations (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      ts_utc            TEXT NOT NULL,
      session_id        TEXT REFERENCES sessions(id),
      source_session_id TEXT REFERENCES sessions(id),
      lesson            TEXT NOT NULL,
      would_have_helped INTEGER,
      calls_spent       INTEGER,
      author            TEXT NOT NULL CHECK (author IN ('human'))
    )
  `);
}

/** T195: create `seal_events` on a ledger that predates it. */
function migrateSealEvents(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS seal_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT NOT NULL,
      session_id  TEXT,
      creator     TEXT NOT NULL,
      specialist  TEXT,
      branch      TEXT NOT NULL,
      kind        TEXT NOT NULL,
      paths       TEXT NOT NULL,
      detail      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_seal_events_branch ON seal_events(branch);
    CREATE INDEX IF NOT EXISTS idx_seal_events_session ON seal_events(session_id);
  `);
}

/**
 * T203: widens `tasks.state` CHECK constraint to include 'disputed'.
 * Rebuilds the table when existing schema lacks 'disputed', copying all rows.
 */
export function migrateTasksTable(db: Database.Database): void {
  const existing = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`)
    .get() as { sql: string } | undefined;
  if (existing !== undefined && !existing.sql.includes("'disputed'")) {
    const prevFk = db.pragma("foreign_keys", { simple: true });
    db.pragma("foreign_keys = OFF");
    db.pragma("legacy_alter_table = ON");
    try {
      const rebuild = db.transaction(() => {
        db.exec(`
          CREATE TABLE tasks_new (
            id                    TEXT PRIMARY KEY,
            project_id            TEXT NOT NULL REFERENCES projects(id),
            brief                 TEXT NOT NULL,
            created_utc           TEXT NOT NULL,
            state                 TEXT CHECK (state IN ('open','done','abandoned','disputed')),
            difficulty_estimate   INTEGER
          );
          INSERT INTO tasks_new (id, project_id, brief, created_utc, state, difficulty_estimate)
            SELECT id, project_id, brief, created_utc, state, difficulty_estimate FROM tasks;
          DROP TABLE tasks;
          ALTER TABLE tasks_new RENAME TO tasks;
        `);
      });
      rebuild();
    } finally {
      db.pragma("legacy_alter_table = OFF");
      if (prevFk) db.pragma("foreign_keys = ON");
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)`);
}

export function migrateMemoryEligibility(db: Database.Database): void {
  const create = `
    CREATE TABLE IF NOT EXISTS memory_eligibility (
      session_id  TEXT NOT NULL REFERENCES sessions(id),
      entry_id    TEXT NOT NULL,
      scope       TEXT NOT NULL,
      file        TEXT NOT NULL,
      state       TEXT NOT NULL CHECK (state IN ('injected','skipped_cap','stale')),
      position    INTEGER NOT NULL,
      tokens      INTEGER NOT NULL,
      PRIMARY KEY (session_id, entry_id)
    )`;
  db.exec(create);

  // T79 widened the CHECK to admit 'stale'. SQLite cannot ALTER a
  // constraint, so a ledger created by T76 needs the table rebuilt --
  // copying every row, never dropping one. Gated on the constraint text so
  // it runs exactly once and is a no-op on a fresh ledger.
  const existing = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_eligibility'`)
    .get() as { sql: string } | undefined;
  if (existing !== undefined && !existing.sql.includes("'stale'")) {
    db.exec(`
      CREATE TABLE memory_eligibility_new (
        session_id  TEXT NOT NULL REFERENCES sessions(id),
        entry_id    TEXT NOT NULL,
        scope       TEXT NOT NULL,
        file        TEXT NOT NULL,
        state       TEXT NOT NULL CHECK (state IN ('injected','skipped_cap','stale')),
        position    INTEGER NOT NULL,
        tokens      INTEGER NOT NULL,
        PRIMARY KEY (session_id, entry_id)
      );
      INSERT INTO memory_eligibility_new
        SELECT session_id, entry_id, scope, file, state, position, tokens FROM memory_eligibility;
      DROP TABLE memory_eligibility;
      ALTER TABLE memory_eligibility_new RENAME TO memory_eligibility;
    `);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_eligibility_entry ON memory_eligibility(entry_id)`);
}

function migrateSessionsTable(db: Database.Database): void {
  const cols = new Set(
    (db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  const add: Array<[string, string]> = [
    ["project_id", "TEXT REFERENCES projects(id)"],
    ["parent_session_id", "TEXT REFERENCES sessions(id)"],
    ["resumed_from", "TEXT REFERENCES sessions(id)"],
    // T109: no DEFAULT and no backfill. NULL means the session predates
    // continuation measurement; 1, 2, ... identify successor boundaries.
    ["continuations_used", "INTEGER"],
    ["git_commit", "TEXT"],
    ["git_dirty", "INTEGER DEFAULT 0"],
    ["agent_role", "TEXT"],
    ["model", "TEXT"],
    ["model_switches", "INTEGER"],
    ["model_path", "TEXT"],
    ["specialist_switches", "INTEGER"],
    ["specialist_path", "TEXT"],
    ["trust_source", "TEXT"],
    ["closed_utc", "TEXT"],
    ["deleted_utc", "TEXT"],
    ["browser_fanout_ms", "INTEGER"],
    ["browser_projects_scanned", "INTEGER"],
    ["browser_rows_returned", "INTEGER"],
    ["transcript_path", "TEXT"],
    ["transcript_sha256", "TEXT"],
    ["transcript_bytes", "INTEGER"],
    ["archive_state", "TEXT"],
    ["capture_mode", "TEXT"],
    ["resumable", "INTEGER DEFAULT 1"],
    ["not_resumable_reason", "TEXT"],
    ["flag_cache_stable_head", "INTEGER DEFAULT 0"],
    ["flag_trimmed_tool_surface", "INTEGER DEFAULT 0"],
    ["flag_prompt_diet", "INTEGER DEFAULT 0"],
    ["flag_output_diet", "INTEGER DEFAULT 0"],
    ["compaction_threshold", "REAL"],
    ["explore_tool_calls", "INTEGER DEFAULT 0"],
    // T63: no DEFAULT on any of these four. An existing row must come out of
    // the migration as NULL — "written under a definition that did not
    // measure this" — and a DEFAULT 0 would silently backfill every pre-T63
    // session with a claim that it explored nothing. Same rule as capture_mode.
    ["explore_metric_version", "INTEGER"],
    ["explore_result_bytes", "INTEGER"],
    ["tool_result_bytes", "INTEGER"],
    ["explore_breakdown", "TEXT"],
    // T64: same no-DEFAULT rule as T63's four. A pre-T64 row is NULL —
    // "not measured" — never 0, which would read as "edited nothing".
    ["edited_files", "TEXT"],
    ["edited_file_count", "INTEGER"],
    ["blind_edits", "INTEGER"],
    ["first_touch_rank", "REAL"],
    ["hit_quality", "REAL"],
    ["hit_quality_version", "INTEGER"],
    // T65 (problems/09 mitigation 1). flag_memory_inject gets a DEFAULT
    // because it is a boolean fact about the session that is knowably false
    // for every session before it existed: none of them injected memory.
    // The counts do NOT, for the usual reason — 0 injected tokens and
    // "never measured" are different answers.
    ["flag_memory_inject", "INTEGER DEFAULT 0"],
    ["memory_injected_ids", "TEXT"],
    ["memory_inject_tokens", "INTEGER"],
    ["memory_entries_available", "INTEGER"],
    ["memory_entries_skipped", "INTEGER"],
    // T69: no DEFAULT. A pre-T69 session did not measure a repo map, which is
    // a different answer from "had a map of 0 tokens".
    ["repo_map_tokens", "INTEGER"],
    ["repo_map_files", "INTEGER"],
    ["repo_map_dropped", "INTEGER"],
    ["repo_map_tracked", "INTEGER"],
    // T70: did the map surface what the session needed? No DEFAULT — a
    // session with no map has no coverage, which is not the same answer as
    // a map that covered nothing.
    ["map_edited_covered", "INTEGER"],
    ["map_edited_missed", "INTEGER"],
    ["map_missed_paths", "TEXT"],
    ["map_explore_covered", "INTEGER"],
    ["map_explore_uncovered", "INTEGER"],
    ["edit_tool_calls", "INTEGER DEFAULT 0"],
    ["edit_error_count", "INTEGER DEFAULT 0"],
    ["edit_retry_count", "INTEGER DEFAULT 0"],
    // T83: Pi's transient-failure retry, observed. NO DEFAULT, deliberately.
    // Every pre-T83 session ran with the same retry active and recorded none
    // of it, so 0 would be a claim ("nothing retried") the row cannot
    // support. NULL is the honest value and `nothing is backfilled` covers
    // it, the same way explore_metric_version distinguishes pre-v3 from current rows.
    // T85: the stagnation brake. No DEFAULT, same reason as the retry
    // columns — a pre-T85 session had no brake at all, which is a different
    // answer from "the brake ran and never fired".
    // T89: `from>to` per switch, NULL when nothing switched.
    ["model_fallbacks", "TEXT"],
    ["hooks_registered", "INTEGER"],
    ["hook_denials", "INTEGER"],
    ["hook_notes", "INTEGER"],
    ["checkpoints_written", "INTEGER"],
    // T103: no DEFAULT — a session with no human channel is not a session
    // whose model chose not to ask.
    ["ask_calls", "INTEGER"],
    ["ask_answered", "INTEGER"],
    ["ask_unanswered", "INTEGER"],
    // T102: no DEFAULT, same rule — a pre-T102 session had no roster.
    ["skills_available", "INTEGER"],
    ["skills_invoked", "TEXT"],
    ["skill_reads", "INTEGER"],
    ["skills_head_tokens", "INTEGER"],
    // T99: no DEFAULT, same rule — a pre-T99 session had no post-edit loop,
    // which is not the same answer as a loop that ran zero times.
    ["post_edit_command", "TEXT"],
    ["post_edit_runs", "INTEGER"],
    ["post_edit_failures", "INTEGER"],
    ["post_edit_passes", "INTEGER"],
    ["post_edit_ms", "INTEGER"],
    ["post_edit_disabled_reason", "TEXT"],
    // T98/T100: no DEFAULT, for the reason stated in schema.sql — a pre-T98
    // session had no list, and 0 would claim it had one and ignored it.
    ["task_list_calls", "INTEGER"],
    ["task_list_created", "INTEGER"],
    ["task_list_completed", "INTEGER"],
    ["task_list_open", "INTEGER"],
    ["task_list_reminders", "INTEGER"],
    ["task_gate_refusals", "INTEGER"],
    ["task_items_verified", "INTEGER"],
    ["stagnation_trips", "INTEGER"],
    ["stagnation_key", "TEXT"],
    ["retry_starts", "INTEGER"],
    ["retries_recovered", "INTEGER"],
    ["retries_exhausted", "INTEGER"],
    ["retry_max_attempt", "INTEGER"],
    ["retry_last_error", "TEXT"],
    ["context_files", "TEXT"],
    ["specialist", "TEXT"],
    ["extensions", "TEXT"],
    ["extension_set", "TEXT"],
    ["extension_schema_tokens", "INTEGER"],
    ["extension_schema_share", "REAL"],
    // T31.1/T31.2: no CHECK constraint here -- SQLite's ALTER TABLE ADD
    // COLUMN cannot add one, and the static schema.sql CHECK only binds a
    // freshly created table. A migrated ledger's constraint is therefore
    // enforced at the application layer (the ExecutionShape/Runtime types
    // below), same as every other migrated CHECK column in this file.
    ["execution_shape", "TEXT"],
    ["runtime", "TEXT"],
    ["model_source", "TEXT"],
    // T111. No backfill for any of them: a pre-T111 session had no counter,
    // which is not the same answer as a counter that stayed at zero.
    ["artifact_bytes", "INTEGER"],
    ["approvals_requested", "INTEGER"],
    ["approvals_denied", "INTEGER"],
    ["approvals_auto_denied", "INTEGER"],
    ["approvals_by_tier", "TEXT"],
    ["approvals_by_mode", "TEXT"],
    ["tool_call_counts", "TEXT"],
    ["tool_error_counts", "TEXT"],
    ["tool_adjacent_pairs", "INTEGER"],
    ["tool_switch_same_target", "INTEGER"],
    // D26. No backfill: a session before this column resolved no actual
    // identity, and NULL says so.
    ["actual_tool_call_counts", "TEXT"],
    // T132. Same rule: no backfill. A pre-T132 session deferred nothing
    // because there was nothing to defer with.
    ["tool_loader_enabled", "INTEGER"],
    ["tool_loader_path", "TEXT"],
    ["tool_loader_deferred", "TEXT"],
    ["tool_loader_activated", "TEXT"],
    ["tool_loader_activations", "INTEGER"],
    ["tool_loader_tokens", "INTEGER"],
    ["tool_loader_deferred_tokens", "INTEGER"],
    // T110: the reviewer that did not write the code. No DEFAULT and no
    // backfill: NULL means the session ran before T110 or without a reviewer;
    // 0 findings with invocations=1 means the reviewer ran and found nothing.
    ["reviewer_invocations", "INTEGER"],
    ["reviewer_findings_count", "INTEGER"],
    ["reviewer_model", "TEXT"],
    // T144: the gate's exit code. No DEFAULT and no backfill — a session
    // verified before this column kept no code, and 0 would claim it passed.
    ["verification_exit_code", "INTEGER"],
    // T173: containment. `containment_requested` and `containment_used` are
    // written for every session from here on (`off`/`off` is a real answer);
    // the container columns are NULL for a session whose commands ran on the
    // host. No backfill: a session before T173 recorded nothing, and NULL says so.
    ["containment_requested", "TEXT"],
    ["containment_used", "TEXT"],
    ["container_runtime", "TEXT"],
    ["container_runtime_version", "TEXT"],
    ["container_image", "TEXT"],
    ["container_network", "TEXT"],
    ["container_mount", "TEXT"],
    // L3 (issue #93 item 3): count of unpriced calls for this session.
    // NULL on rows written before L3 (never backfilled).
    ["unpriced_calls", "INTEGER"],
  ];
  // T31.1: unlike T25's auth_mode/price_basis (which recordCall() ALWAYS
  // supplies going forward, so an unconditional backfill can never touch a
  // row written after the migration), startSession()'s executionShape and
  // runtime are optional and some real callers (recordBudgetTrip's blocked-
  // session row, doctor.ts's synthetic benchmark sessions) deliberately
  // leave them unset. A backfill that ran on every open() -- as T25's does
  // -- would silently overwrite those legitimate future NULLs with a guess
  // the next time the ledger opens. So this one runs exactly once, gated on
  // the column not existing yet, in the same statement that adds it.
  const backfillExecutionShape = !cols.has("execution_shape");
  const backfillRuntime = !cols.has("runtime");
  for (const [name, sqlType] of add) {
    if (!cols.has(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${sqlType}`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_parent  ON sessions(parent_session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_task    ON sessions(task_id)`);

  // T31.1 backfill: derivable only, and only for rows that predate this
  // migration (see above). Every one of them ran through one of the two
  // paths that have existed since Phase 1. A subagent is identified by
  // parent_session_id being set, regardless of anything else on the row. A
  // top-level MCP session is identified by its brief: mcp-server.ts's four
  // tools each pass `label: def.name` (one of the four "lykos_*" tool
  // names) into startSession(), which ingest.ts writes straight through as
  // `brief` (`brief = snap.label ?? "(delegate)"`); `lykos run` never sets
  // a label, so its brief is always literally "(delegate)" or the caller's
  // own text. Everything else that predates this migration is the CLI
  // delegate path, the only other one that has ever existed -- CLAUDE.md's
  // own Phase 3 opening line is "every session Lykos has ever run has been
  // a container session" run through one of exactly these two paths. Leave
  // anything that fits neither NULL rather than guess.
  if (backfillExecutionShape) {
    db.exec(`
      UPDATE sessions SET execution_shape = 'subagent'
      WHERE execution_shape IS NULL AND parent_session_id IS NOT NULL
    `);
    db.exec(`
      UPDATE sessions SET execution_shape = 'mcp_worker'
      WHERE execution_shape IS NULL AND parent_session_id IS NULL AND brief IN
        ('lykos_implement', 'lykos_refactor', 'lykos_debug', 'lykos_review')
    `);
    db.exec(`
      UPDATE sessions SET execution_shape = 'cli_delegate'
      WHERE execution_shape IS NULL AND parent_session_id IS NULL
    `);
  }
  if (backfillRuntime) {
    db.exec(`UPDATE sessions SET runtime = 'container' WHERE runtime IS NULL`);
  }
}

function migrateCallsTable(db: Database.Database, schemaSql: string): void {
  // T25.2: must run BEFORE the ALTER loop below — it may rebuild the whole
  // table, and a rebuilt table already carries every column schema.sql
  // declares (including auth_mode/price_basis), which the cols check next
  // needs to see fresh.
  relaxCallsNotNullConstraints(db, schemaSql);

  const cols = new Set(
    (db.prepare(`PRAGMA table_info(calls)`).all() as Array<{ name: string }>).map((c) => c.name),
  );
  const add: Array<[string, string]> = [
    ["tool_schema_tokens", "INTEGER"],
    ["tool_schema_bytes", "INTEGER"],
    ["tool_count", "INTEGER"],
    ["tool_schema_hash", "TEXT"],
    ["tool_schema_basis", "TEXT"],
    ["tool_names", "TEXT"],
    ["prefix_changed", "INTEGER"],
    ["prefix_fingerprint", "TEXT"],
    ["prefix_fingerprint_source", "TEXT"],
    ["prefix_fingerprint_changed", "INTEGER"],
    ["snip_tokens_removed", "INTEGER"],
    ["prune_tokens_removed", "INTEGER"],
    ["auth_mode", "TEXT"],
    ["price_basis", "TEXT"],
    // T107.5. Deliberately NOT followed by a backfill, unlike auth_mode and
    // price_basis below: those two record a fact that was true of every
    // pre-T25 row (one route, published rates). A pre-T107 row has no such
    // fact — nothing classified its tier when it was written — so it stays
    // NULL, and NULL keeps meaning "no such mechanism" the way every
    // Phase 12 and Phase 17 column does.
    ["risk_tier", "TEXT"],
    // Specialists ticket 04. Added to the migration list unlike model_switched
    // above (a static-schema-only column since T119) — a ledger opened
    // before this ticket needs the ALTER, or recordCall() would fail
    // against a table that never gained the column.
    ["specialist_switched", "INTEGER"],
    ["wire_tool_name", "TEXT"],
    // P14.6 ticket 06. Deliberately NOT backfilled (CLAUDE.md: nothing is
    // backfilled): no row written before this ticket knows which credential
    // served it, so it stays NULL. It holds a non-secret label only.
    ["credential_label", "TEXT"],
  ];
  for (const [name, sqlType] of add) {
    if (!cols.has(name)) db.exec(`ALTER TABLE calls ADD COLUMN ${name} ${sqlType}`);
  }

  // T25.4: backfill rows written before these columns existed. Every one of
  // them was authenticated with a metered key at published rates -- the only
  // route Lykos had before Phase 3's provider layer -- so this is an honest
  // fact, not a guess. A row inserted after this migration always supplies
  // both fields itself (recordCall() defaults them), so this UPDATE only
  // ever touches pre-T25 history and is a no-op on every later open().
  db.exec(`UPDATE calls SET auth_mode = 'api_key' WHERE auth_mode IS NULL`);
  db.exec(`UPDATE calls SET price_basis = 'api_list' WHERE price_basis IS NULL`);
}

function previousSchemaHash(db: Database.Database, sessionId: string): string | null {
  const row = db
    .prepare(
      `SELECT tool_schema_hash FROM calls WHERE session_id = ? AND tool_schema_hash IS NOT NULL
       ORDER BY ts_utc DESC, rowid DESC LIMIT 1`,
    )
    .get(sessionId) as { tool_schema_hash: string } | undefined;
  return row?.tool_schema_hash ?? null;
}

function previousPrefixFingerprint(db: Database.Database, sessionId: string): string | null {
  const row = db
    .prepare(
      `SELECT prefix_fingerprint FROM calls WHERE session_id = ? AND prefix_fingerprint IS NOT NULL
       ORDER BY ts_utc DESC, rowid DESC LIMIT 1`,
    )
    .get(sessionId) as { prefix_fingerprint: string } | undefined;
  return row?.prefix_fingerprint ?? null;
}

/**
 * T16.2: the REAL fingerprint (see schema.sql's comment on the column) is
 * computed host-side by the session engine --
 * this only decides prefix_fingerprint_changed, the same "differs from the
 * previous call in this session" comparison schemaFields() already does for
 * the T4.1 catalog hash, against its own independent history.
 */
function prefixFingerprintFields(
  input: RecordCallInput,
  db: Database.Database,
): { fingerprint: string | null; source: string | null; changed: number | null } {
  if (input.prefixFingerprint === undefined) {
    return { fingerprint: null, source: null, changed: null };
  }
  const prev = previousPrefixFingerprint(db, input.sessionId);
  return {
    fingerprint: input.prefixFingerprint,
    source: input.prefixFingerprintSource ?? "pi_delegate_mcp_worker_host_state",
    changed: prev === null ? 0 : prev === input.prefixFingerprint ? 0 : 1,
  };
}

function schemaFields(
  input: RecordCallInput,
  db: Database.Database,
): {
  tokens: number | null;
  bytes: number | null;
  count: number | null;
  hash: string | null;
  basis: string | null;
  names: string | null;
  prefixChanged: number | null;
} {
  if (input.toolNames === undefined) {
    return {
      tokens: null,
      bytes: null,
      count: null,
      hash: null,
      basis: null,
      names: null,
      prefixChanged: null,
    };
  }
  const measured: ToolSchemaMeasurement = measureToolset(input.toolNames);
  const namesJson = JSON.stringify(measured.names);
  let prefixChanged: number | null = null;
  if (measured.hash !== null) {
    const prev = previousSchemaHash(db, input.sessionId);
    prefixChanged = prev === null ? 0 : prev === measured.hash ? 0 : 1;
  }
  return {
    tokens: measured.tokens,
    bytes: measured.bytes,
    count: measured.count,
    hash: measured.hash,
    basis: measured.basis,
    names: namesJson,
    prefixChanged,
  };
}

function gitHead(workspace: string | undefined): string {
  // T170: through the host git helper (hooks and fsmonitor off). A non-git
  // workspace or a repo with no commits yet is an expected failure: "unknown".
  const run = hostGit(["rev-parse", "HEAD"], workspace ?? process.cwd());
  return run.ok ? run.stdout : "unknown";
}

export class Ledger {
  readonly path: string;
  readonly db: Database.Database;
  private readonly liveThrottle = new LiveWriteThrottle();
  /** Legacy sessions reopened in this process must not accept current-metric totals. */
  private readonly legacyMetricReopened = new Set<string>();

  private constructor(path: string, db: Database.Database) {
    this.path = path;
    this.db = db;
  }

  static open(path: string): Ledger {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    // Set BEFORE journal_mode: without a busy timeout, SQLite throws
    // "database is locked" immediately on any transient contention instead
    // of waiting for the other connection to finish -- including on the
    // very first pragma call below, which is exactly where T7's kill-switch
    // acceptance script first hit this (two Ledger.open() calls, one in
    // the session engine recording the trip, one in the acceptance
    // script reading it back, both against the same WAL-mode file within
    // milliseconds of each other). 5s covers that and any ordinary
    // multi-process contention (a live HUD read overlapping an ingest
    // write) without masking a genuinely stuck lock.
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    applySchema(db);

    const prices = currentPriceTable();
    db.prepare(
      `INSERT OR IGNORE INTO price_versions (version, applied_utc, source_checked, note)
       VALUES (@version, @applied_utc, @source_checked, @note)`,
    ).run({
      version: prices.version,
      applied_utc: new Date().toISOString(),
      source_checked: prices.sourceChecked,
      note: "loaded from lykos/ledger/prices.yaml",
    });

    return new Ledger(path, db);
  }

  startSession(input: StartSessionInput): string {
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO sessions (
           id, task_id, started_utc, harness_commit, brief, difficulty_estimate, notes,
           flag_retrieval, flag_proactive_compaction, flag_routing,
           flag_draft_verify, flag_delegation, flag_cache_stable_head,
           flag_trimmed_tool_surface, flag_prompt_diet, flag_output_diet,
           flag_memory_inject, memory_injected_ids, memory_inject_tokens,
           memory_entries_available, memory_entries_skipped,
           repo_map_tokens, repo_map_files, repo_map_dropped, repo_map_tracked,
           map_edited_covered, map_edited_missed, map_missed_paths,
           map_explore_covered, map_explore_uncovered,
           compaction_threshold, context_files,
           extensions, extension_set, extension_schema_tokens, extension_schema_share,
           project_id, parent_session_id, resumed_from, continuations_used, git_commit, git_dirty,
           agent_role, model, model_switches, model_path, specialist_switches, specialist_path, trust_source, model_source, specialist, resumable, not_resumable_reason,
           closed_utc, deleted_utc, browser_fanout_ms, browser_projects_scanned, browser_rows_returned,
           execution_shape, runtime, capture_mode, archive_state,
           containment_requested, containment_used, container_runtime, container_runtime_version,
           container_image, container_network, container_mount
         ) VALUES (
           @id, @task_id, @started_utc, @harness_commit, @brief, @difficulty_estimate, @notes,
           @flag_retrieval, @flag_proactive_compaction, @flag_routing,
           @flag_draft_verify, @flag_delegation, @flag_cache_stable_head,
           @flag_trimmed_tool_surface, @flag_prompt_diet, @flag_output_diet,
           @flag_memory_inject, @memory_injected_ids, @memory_inject_tokens,
           @memory_entries_available, @memory_entries_skipped,
           @repo_map_tokens, @repo_map_files, @repo_map_dropped, @repo_map_tracked,
           @map_edited_covered, @map_edited_missed, @map_missed_paths,
           @map_explore_covered, @map_explore_uncovered,
           @compaction_threshold, @context_files,
           @extensions, @extension_set, @extension_schema_tokens, @extension_schema_share,
           @project_id, @parent_session_id, @resumed_from, @continuations_used, @git_commit, @git_dirty,
           @agent_role, @model, @model_switches, @model_path, @specialist_switches, @specialist_path, @trust_source, @model_source, @specialist, @resumable, @not_resumable_reason,
           @closed_utc, @deleted_utc, @browser_fanout_ms, @browser_projects_scanned, @browser_rows_returned,
           @execution_shape, @runtime, @capture_mode, 'live',
           @containment_requested, @containment_used, @container_runtime, @container_runtime_version,
           @container_image, @container_network, @container_mount
         )`,
      )
      .run({
        id,
        task_id: input.taskId ?? null,
        started_utc: input.startedUtc ?? new Date().toISOString(),
        harness_commit: input.harnessCommit ?? gitHead(input.workspace),
        brief: optionalRedact(input.brief),
        difficulty_estimate: input.difficultyEstimate ?? null,
        notes: optionalRedact(input.notes),
        flag_retrieval: input.flags?.retrieval ? 1 : 0,
        flag_proactive_compaction: input.flags?.proactiveCompaction ? 1 : 0,
        flag_routing: input.flags?.routing ? 1 : 0,
        flag_draft_verify: input.flags?.draftVerify ? 1 : 0,
        flag_delegation: input.flags?.delegation ? 1 : 0,
        flag_cache_stable_head: input.flags?.cacheStableHead ? 1 : 0,
        flag_trimmed_tool_surface: input.flags?.trimmedToolSurface ? 1 : 0,
        flag_prompt_diet: input.flags?.promptDiet ? 1 : 0,
        flag_output_diet: input.flags?.outputDiet ? 1 : 0,
        flag_memory_inject: input.flags?.memoryInject ? 1 : 0,
        compaction_threshold: input.compactionThreshold ?? null,
        context_files: input.contextFiles ?? null,
        memory_injected_ids: input.memoryInjectedIds ?? null,
        memory_inject_tokens: input.memoryInjectTokens ?? null,
        memory_entries_available: input.memoryEntriesAvailable ?? null,
        memory_entries_skipped: input.memoryEntriesSkipped ?? null,
        repo_map_tokens: input.repoMapTokens ?? null,
        repo_map_files: input.repoMapFiles ?? null,
        repo_map_dropped: input.repoMapDropped ?? null,
        repo_map_tracked: input.repoMapTracked ?? null,
        map_edited_covered: input.mapEditedCovered ?? null,
        map_edited_missed: input.mapEditedMissed ?? null,
        map_missed_paths: input.mapMissedPaths ?? null,
        map_explore_covered: input.mapExploreCovered ?? null,
        map_explore_uncovered: input.mapExploreUncovered ?? null,
        extensions: input.extensions ?? null,
        // Always recorded, never omitted -- "none" is a real, comparable
        // configuration (the control group for T29.4's --compare), not an
        // absence of data. A caller that never passes it leaves this NULL,
        // which distinguishes "recorded as empty" from "predates T29".
        extension_set: input.extensionSet ?? null,
        extension_schema_tokens: input.extensionSchemaTokens ?? null,
        extension_schema_share: input.extensionSchemaShare ?? null,
        project_id: input.projectId ?? null,
        parent_session_id: input.parentSessionId ?? null,
        resumed_from: input.resumedFrom ?? null,
        continuations_used: input.continuationsUsed ?? null,
        git_commit: input.gitCommit ?? null,
        git_dirty: input.gitDirty ? 1 : 0,
        agent_role: input.agentRole ?? null,
        model: input.model ?? null,
        model_switches: input.modelSwitches ?? null,
        model_path: input.modelPath ?? null,
        specialist_switches: input.specialistSwitches ?? null,
        specialist_path: input.specialistPath ?? null,
        trust_source: input.trustSource ?? null,
        model_source: input.modelSource ?? null,
        specialist: input.specialist ?? null,
        resumable: input.resumable === false ? 0 : 1,
        not_resumable_reason: optionalRedact(input.notResumableReason),
        execution_shape: input.executionShape ?? null,
        runtime: input.runtime ?? null,
        containment_requested: input.containment?.requested ?? null,
        containment_used: input.containment?.used ?? null,
        container_runtime: input.containment?.runtime ?? null,
        container_runtime_version: input.containment?.runtimeVersion ?? null,
        container_image: input.containment?.image ?? null,
        container_network: input.containment?.network ?? null,
        container_mount: input.containment?.mount ?? null,
        capture_mode: input.captureMode ?? null,
        closed_utc: input.closedUtc ?? null,
        deleted_utc: input.deletedUtc ?? null,
        browser_fanout_ms: input.browserFanoutMs ?? null,
        browser_projects_scanned: input.browserProjectsScanned ?? null,
        browser_rows_returned: input.browserRowsReturned ?? null,
      });
    this.refreshLiveCache(id, true);
    return id;
  }

  /**
   * Find-or-create a task. Callers that want a resumed run to count against
   * the same task (T8 acceptance: "a task with two sessions") pass the same
   * `id` twice — INSERT OR IGNORE makes the second call a no-op rather than
   * a duplicate-key error.
   */
  startTask(input: StartTaskInput): string {
    const id = input.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO tasks (id, project_id, brief, created_utc, state, difficulty_estimate)
         VALUES (@id, @project_id, @brief, @created_utc, @state, @difficulty_estimate)`,
      )
      .run({
        id,
        project_id: input.projectId,
        brief: optionalRedact(input.brief) ?? "(no brief)",
        created_utc: new Date().toISOString(),
        state: input.state ?? "open",
        difficulty_estimate: input.difficultyEstimate ?? null,
      });
    return id;
  }

  /**
   * Mirrors one row of the cross-project registry (~/.lykos/projects.json,
   * lykos/session/identity.ts) into this ledger's own `projects` table, so
   * `sessions.project_id` has a local FK target. Upsert: last_seen_utc and a
   * repaired root_path both need to win on every call, not just the first.
   */
  ensureProject(input: ProjectMirrorInput): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, root_path, git_remote, first_commit, name, created_utc, last_seen_utc)
         VALUES (@id, @root_path, @git_remote, @first_commit, @name, @created_utc, @last_seen_utc)
         ON CONFLICT(id) DO UPDATE SET
           root_path = excluded.root_path,
           git_remote = excluded.git_remote,
           first_commit = excluded.first_commit,
           name = excluded.name,
           last_seen_utc = excluded.last_seen_utc`,
      )
      .run({
        id: input.id,
        root_path: input.rootPath,
        git_remote: input.gitRemote ?? null,
        first_commit: input.firstCommit ?? null,
        name: input.name ?? null,
        created_utc: input.createdUtc,
        last_seen_utc: input.lastSeenUtc ?? input.createdUtc,
      });
  }

  recordCall(input: RecordCallInput): string {
    const id = randomUUID();
    const ts = input.ts ?? new Date();
    const authMode = input.authMode ?? "api_key";
    const priceBasis = input.priceBasis ?? "api_list";

    // T25.2: an 'unpriced' row never calls priceCall() at all -- there is no
    // verified rate to resolve, so cost_usd/price_version/rate_window stay
    // NULL rather than a value priceCall() would have thrown on anyway.
    // Every other basis is priced exactly as before T25.
    const priced =
      priceBasis === "unpriced"
        ? null
        : priceCall({
            provider: input.provider,
            model: input.model,
            tokens: {
              input: input.tokens.input,
              output: input.tokens.output,
              cacheRead: input.tokens.cacheRead ?? 0,
              cacheWrite: input.tokens.cacheWrite ?? 0,
            },
            ts,
            ...(input.cacheTtlSeconds !== undefined ? { cacheTtlSeconds: input.cacheTtlSeconds } : {}),
          });

    const schema = schemaFields(input, this.db);
    const prefixFp = prefixFingerprintFields(input, this.db);

    // T6.1: cache avoided cost is exact and computable from this call's own
    // tokens plus the rates priceCall() just resolved for it, so it is filled
    // in automatically rather than requiring every caller to compute it.
    // A caller-supplied avoidedUsd (T6.2 delegation, once wired) wins instead
    // of being silently overwritten -- a call can only report one avoided
    // figure per row (docs/03-telemetry.md §4), and delegation's per-hop
    // figure is the more specific claim about that row when both apply.
    // An unpriced row has no resolved rates to model a counterfactual from,
    // so avoided_usd stays NULL unless the caller supplies one explicitly.
    const avoidedUsd =
      input.avoidedUsd ??
      (priced ? cacheAvoidedUsd(input.tokens.cacheRead ?? 0, input.tokens.cacheWrite ?? 0, priced.rates) : null);
    const avoidedBasis = input.avoidedUsd !== undefined || priced ? (input.avoidedBasis ?? CACHE_AVOIDED_BASIS) : null;

    this.db
      .prepare(
        `INSERT INTO calls (
           id, session_id, parent_call_id, hop, ts_utc,
           agent, phase, provider, model, model_version,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens,
           auth_mode, credential_label, price_basis, price_version, rate_window, cost_usd, recosted,
           latency_ms, ttft_ms, turn_index, retries, error,
           tool_name, wire_tool_name, risk_tier, tool_result_bytes, tool_result_truncated,
           context_before, context_after, compaction_triggered,
           snip_tokens_removed, prune_tokens_removed,
           model_source, model_switched, specialist_switched, avoided_usd, avoided_basis,
           child_input_tokens, summary_tokens, briefing_tokens, handoff_loss,
           tool_schema_tokens, tool_schema_bytes, tool_count, tool_schema_hash,
           tool_schema_basis, tool_names, prefix_changed,
           prefix_fingerprint, prefix_fingerprint_source, prefix_fingerprint_changed
         ) VALUES (
           @id, @session_id, @parent_call_id, @hop, @ts_utc,
           @agent, @phase, @provider, @model, @model_version,
           @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens, @reasoning_tokens,
           @auth_mode, @credential_label, @price_basis, @price_version, @rate_window, @cost_usd, 0,
           @latency_ms, @ttft_ms, @turn_index, @retries, @error,
           @tool_name, @wire_tool_name, @risk_tier, @tool_result_bytes, @tool_result_truncated,
           @context_before, @context_after, @compaction_triggered,
           @snip_tokens_removed, @prune_tokens_removed,
           @model_source, @model_switched, @specialist_switched, @avoided_usd, @avoided_basis,
           @child_input_tokens, @summary_tokens, @briefing_tokens, @handoff_loss,
           @tool_schema_tokens, @tool_schema_bytes, @tool_count, @tool_schema_hash,
           @tool_schema_basis, @tool_names, @prefix_changed,
           @prefix_fingerprint, @prefix_fingerprint_source, @prefix_fingerprint_changed
         )`,
      )
      .run({
        id,
        session_id: input.sessionId,
        parent_call_id: input.parentCallId ?? null,
        hop: input.hop ?? 0,
        ts_utc: ts.toISOString(),
        agent: input.agent,
        phase: input.phase ?? null,
        provider: input.provider,
        model: input.model,
        model_version: input.modelVersion ?? null,
        input_tokens: input.tokens.input,
        output_tokens: input.tokens.output,
        cache_read_tokens: input.tokens.cacheRead ?? 0,
        cache_write_tokens: input.tokens.cacheWrite ?? 0,
        reasoning_tokens: input.tokens.reasoning ?? 0,
        auth_mode: authMode,
        credential_label: input.credentialLabel ?? null,
        price_basis: priceBasis,
        price_version: priced?.priceVersion ?? null,
        rate_window: priced?.rateWindow ?? null,
        cost_usd: priced?.costUsd ?? null,
        latency_ms: input.latencyMs ?? null,
        ttft_ms: input.ttftMs ?? null,
        turn_index: input.turnIndex ?? null,
        retries: input.retries ?? 0,
        error: optionalRedact(input.error),
        tool_name: input.toolName ?? null,
        wire_tool_name: input.wireToolName ?? null,
        risk_tier: input.riskTier ?? null,
        tool_result_bytes: input.toolResultBytes ?? null,
        tool_result_truncated: input.toolResultTruncated ? 1 : 0,
        context_before: input.contextBefore ?? null,
        context_after: input.contextAfter ?? null,
        compaction_triggered: input.compactionTriggered ? 1 : 0,
        snip_tokens_removed: input.snipTokensRemoved ?? null,
        prune_tokens_removed: input.pruneTokensRemoved ?? null,
        model_source: input.modelSource ?? null,
        model_switched: input.modelSwitched ? 1 : 0,
        specialist_switched: input.specialistSwitched ? 1 : 0,
        avoided_usd: avoidedUsd,
        avoided_basis: avoidedBasis,
        child_input_tokens: input.childInputTokens ?? null,
        summary_tokens: input.summaryTokens ?? null,
        briefing_tokens: input.briefingTokens ?? null,
        handoff_loss: input.handoffLoss ?? 0,
        tool_schema_tokens: schema.tokens,
        tool_schema_bytes: schema.bytes,
        tool_count: schema.count,
        tool_schema_hash: schema.hash,
        tool_schema_basis: schema.basis,
        tool_names: schema.names,
        prefix_changed: schema.prefixChanged,
        prefix_fingerprint: prefixFp.fingerprint,
        prefix_fingerprint_source: prefixFp.source,
        prefix_fingerprint_changed: prefixFp.changed,
      });
    this.refreshLiveCache(input.sessionId, false);
    return id;
  }

  endSession(input: EndSessionInput): void {
    const existing = this.db
      .prepare(
        `SELECT ended_utc, outcome, outcome_source, explore_metric_version, explore_tool_calls,
                explore_result_bytes, tool_result_bytes
         FROM sessions WHERE id = ?`,
      )
      .get(input.id) as
      | {
          ended_utc: string | null;
          outcome: Outcome | null;
          outcome_source: OutcomeSource | null;
          explore_metric_version: number | null;
          explore_tool_calls: number;
          explore_result_bytes: number | null;
          tool_result_bytes: number | null;
        }
      | undefined;
    if (!existing) throw new Error(`lykos ledger: endSession: unknown session ${input.id}`);
    if (existing.ended_utc) {
      throw new Error(`lykos ledger: endSession: session ${input.id} already ended (append-only; corrections are new rows)`);
    }
    const hasPriorExploration =
      this.legacyMetricReopened.has(input.id) ||
      existing.explore_metric_version !== null ||
      existing.explore_tool_calls !== 0 ||
      existing.explore_result_bytes !== null ||
      existing.tool_result_bytes !== null;
    const explorationCompatible =
      !hasPriorExploration ||
      (input.exploreMetricVersion !== undefined && existing.explore_metric_version === input.exploreMetricVersion);
    const conflictingOutcome =
      existing.outcome !== null && input.outcome !== undefined && existing.outcome !== input.outcome
        ? `later run verdict '${input.outcome}' was not applied; existing outcome '${existing.outcome}' ` +
          `(source=${existing.outcome_source ?? "unspecified"}) remains authoritative`
        : undefined;
    const endNotes = [input.notes, conflictingOutcome].filter((note): note is string => note !== undefined).join("; ");

    const totals = this.callTotals(input.id);
    // T6.1: sum calls.avoided_usd the same way loadSessionSummary() does, but
    // persist it onto the session row -- SUM() over zero/all-NULL rows is
    // SQL NULL, which is exactly right here (no calls, or T6 not yet run on
    // any of them, both correctly read as "not computed" rather than $0).
    const avoidedTotal = this.db
      .prepare(`SELECT SUM(avoided_usd) AS sum FROM calls WHERE session_id = ?`)
      .get(input.id) as { sum: number | null };
    this.db
      .prepare(
        `UPDATE sessions SET
           ended_utc = @ended_utc,
           outcome = COALESCE(outcome, @outcome),
           outcome_source = COALESCE(outcome_source, @outcome_source),
           verification_cmd = COALESCE(@verification_cmd, verification_cmd),
           verification_output = COALESCE(@verification_output, verification_output),
           notes = CASE
             WHEN @notes IS NULL THEN notes
             WHEN notes IS NULL OR notes = '' THEN @notes
             ELSE notes || '; ' || @notes
           END,
            total_cost_usd = @total_cost_usd,
            unpriced_calls = @unpriced_calls,
            total_avoided_usd = @total_avoided_usd,
           -- 2026-09-07 (UI feedback item 1): these count EVENTS INSIDE A
           -- RUN, and a session can now have more than one run — a resume
           -- continues the session it names rather than forking a new row.
           -- A plain assignment would have made a session resumed after
           -- five turns and continued for two report two, which is a number
           -- that was never true of anything. The arithmetic is unchanged
           -- for a session that ends once: startSession() leaves these
           -- NULL, so COALESCE(NULL, 0) + n is n.
           --
           -- The COALESCE(param, column) columns further down are deliberately NOT
           -- in this list. They are Phase 12's mechanism counters, whose
           -- NULL ("no such mechanism") / 0 ("the mechanism was there and
           -- nothing used it") distinction is the whole point of them; they
           -- describe the most recent run and say so.
           turns = COALESCE(turns, 0) + @turns,
           tool_calls = COALESCE(tool_calls, 0) + @tool_calls,
           -- A resumed session must not add v3 measurements to a v1/v2 row.
           -- The transcript re-reader can measure that mixed session later;
           -- this row cannot honestly carry two metric definitions.
           explore_tool_calls = CASE WHEN @explore_compatible = 1
             THEN COALESCE(explore_tool_calls, 0) + @explore_tool_calls
             ELSE explore_tool_calls END,
           explore_metric_version = CASE WHEN @explore_compatible = 1
             THEN @explore_metric_version ELSE explore_metric_version END,
           explore_result_bytes = CASE WHEN @explore_compatible = 1
             THEN COALESCE(explore_result_bytes, 0) + @explore_result_bytes
             ELSE explore_result_bytes END,
           tool_result_bytes = CASE WHEN @explore_compatible = 1
             THEN COALESCE(tool_result_bytes, 0) + @tool_result_bytes
             ELSE tool_result_bytes END,
           explore_breakdown = CASE WHEN @explore_compatible = 1
             THEN @explore_breakdown ELSE explore_breakdown END,
           edited_files = @edited_files,
           edited_file_count = COALESCE(edited_file_count, 0) + @edited_file_count,
           blind_edits = COALESCE(blind_edits, 0) + @blind_edits,
           first_touch_rank = @first_touch_rank,
           hit_quality = @hit_quality,
           hit_quality_version = @hit_quality_version,
           edit_tool_calls = COALESCE(edit_tool_calls, 0) + @edit_tool_calls,
           edit_error_count = COALESCE(edit_error_count, 0) + @edit_error_count,
           edit_retry_count = COALESCE(edit_retry_count, 0) + @edit_retry_count,
           -- T83: COALESCE so a caller that observed nothing cannot blank a
           -- reading an earlier write already made for this session.
           model_fallbacks = COALESCE(@model_fallbacks, model_fallbacks),
           artifact_bytes = COALESCE(@artifact_bytes, artifact_bytes),
           approvals_requested = COALESCE(@approvals_requested, approvals_requested),
           approvals_denied = COALESCE(@approvals_denied, approvals_denied),
           approvals_auto_denied = COALESCE(@approvals_auto_denied, approvals_auto_denied),
           approvals_by_tier = COALESCE(@approvals_by_tier, approvals_by_tier),
           approvals_by_mode = COALESCE(@approvals_by_mode, approvals_by_mode),
           tool_call_counts = COALESCE(@tool_call_counts, tool_call_counts),
           actual_tool_call_counts = COALESCE(@actual_tool_call_counts, actual_tool_call_counts),
           tool_error_counts = COALESCE(@tool_error_counts, tool_error_counts),
           tool_adjacent_pairs = COALESCE(@tool_adjacent_pairs, tool_adjacent_pairs),
           tool_switch_same_target = COALESCE(@tool_switch_same_target, tool_switch_same_target),
           reviewer_invocations = COALESCE(@reviewer_invocations, reviewer_invocations),
           reviewer_findings_count = COALESCE(@reviewer_findings_count, reviewer_findings_count),
           reviewer_model = COALESCE(@reviewer_model, reviewer_model),
           tool_loader_enabled = COALESCE(@tool_loader_enabled, tool_loader_enabled),
           tool_loader_path = COALESCE(@tool_loader_path, tool_loader_path),
           tool_loader_deferred = COALESCE(@tool_loader_deferred, tool_loader_deferred),
           tool_loader_activated = COALESCE(@tool_loader_activated, tool_loader_activated),
           tool_loader_activations = COALESCE(@tool_loader_activations, tool_loader_activations),
           tool_loader_tokens = COALESCE(@tool_loader_tokens, tool_loader_tokens),
           tool_loader_deferred_tokens = COALESCE(@tool_loader_deferred_tokens, tool_loader_deferred_tokens),
           hooks_registered = COALESCE(@hooks_registered, hooks_registered),
           hook_denials = COALESCE(@hook_denials, hook_denials),
           hook_notes = COALESCE(@hook_notes, hook_notes),
           checkpoints_written = COALESCE(@checkpoints_written, checkpoints_written),
           ask_calls = COALESCE(@ask_calls, ask_calls),
           ask_answered = COALESCE(@ask_answered, ask_answered),
           ask_unanswered = COALESCE(@ask_unanswered, ask_unanswered),
           skills_available = COALESCE(@skills_available, skills_available),
           skills_invoked = COALESCE(@skills_invoked, skills_invoked),
           skill_reads = COALESCE(@skill_reads, skill_reads),
           skills_head_tokens = COALESCE(@skills_head_tokens, skills_head_tokens),
           post_edit_command = COALESCE(@post_edit_command, post_edit_command),
           post_edit_runs = COALESCE(@post_edit_runs, post_edit_runs),
           post_edit_failures = COALESCE(@post_edit_failures, post_edit_failures),
           post_edit_passes = COALESCE(@post_edit_passes, post_edit_passes),
           post_edit_ms = COALESCE(@post_edit_ms, post_edit_ms),
           post_edit_disabled_reason = COALESCE(@post_edit_disabled_reason, post_edit_disabled_reason),
           task_list_calls = COALESCE(@task_list_calls, task_list_calls),
           task_list_created = COALESCE(@task_list_created, task_list_created),
           task_list_completed = COALESCE(@task_list_completed, task_list_completed),
           task_list_open = COALESCE(@task_list_open, task_list_open),
           task_list_reminders = COALESCE(@task_list_reminders, task_list_reminders),
           task_gate_refusals = COALESCE(@task_gate_refusals, task_gate_refusals),
           task_items_verified = COALESCE(@task_items_verified, task_items_verified),
           stagnation_trips = COALESCE(@stagnation_trips, stagnation_trips),
           stagnation_key = COALESCE(@stagnation_key, stagnation_key),
           retry_starts = COALESCE(@retry_starts, retry_starts),
           retries_recovered = COALESCE(@retries_recovered, retries_recovered),
           retries_exhausted = COALESCE(@retries_exhausted, retries_exhausted),
           retry_max_attempt = COALESCE(@retry_max_attempt, retry_max_attempt),
           retry_last_error = COALESCE(@retry_last_error, retry_last_error),
           compactions = COALESCE(compactions, 0) + @compactions,
           escalations = COALESCE(escalations, 0) + @escalations,
           human_interventions = COALESCE(human_interventions, 0) + @human_interventions,
           -- T55: archive_state's first writer, in the one place a session
           -- stops being live. 'archived' is never walked back here: a
           -- session whose transcript has already been compressed stays
           -- archived even if this row is completed afterwards.
           archive_state = CASE WHEN archive_state = 'archived' THEN archive_state ELSE 'recent' END,
           closed_utc = COALESCE(@closed_utc, closed_utc),
           transcript_path = COALESCE(@transcript_path, transcript_path),
           transcript_sha256 = COALESCE(@transcript_sha256, transcript_sha256),
           transcript_bytes = COALESCE(@transcript_bytes, transcript_bytes)
         WHERE id = @id`,
      )
      .run({
        id: input.id,
        ended_utc: input.endedUtc ?? new Date().toISOString(),
        closed_utc: input.closedUtc ?? null,
        outcome: input.outcome ?? null,
        outcome_source: input.outcomeSource ?? null,
        verification_cmd: optionalRedact(input.verificationCmd),
        verification_output: optionalRedact(input.verificationOutput),
        notes: optionalRedact(endNotes),
        total_cost_usd: totals.costUsd,
        unpriced_calls: totals.unpricedCalls,
        total_avoided_usd: avoidedTotal.sum,
        turns: input.turns ?? 0,
        tool_calls: input.toolCalls ?? 0,
        explore_tool_calls: input.exploreToolCalls ?? 0,
        // T63: NULL, never 0, when the caller did not measure. `?? null` on
        // all four — the count above keeps its historical `?? 0` because a
        // v1 row genuinely recorded zero under the v1 definition.
        explore_metric_version: input.exploreMetricVersion ?? null,
        explore_result_bytes: input.exploreResultBytes ?? null,
        tool_result_bytes: input.toolResultBytes ?? null,
        explore_breakdown: input.exploreBreakdown ?? null,
        explore_compatible: explorationCompatible ? 1 : 0,
        // T64: `?? null` throughout. first_touch_rank and hit_quality are
        // legitimately null even on a measured session — one that edited
        // nothing has no hit quality, and one whose every edit was blind has
        // no rank. Null there means "no answer key", not "not measured";
        // hit_quality_version is what distinguishes the two.
        edited_files: input.editedFiles ?? null,
        edited_file_count: input.editedFileCount ?? null,
        blind_edits: input.blindEdits ?? null,
        first_touch_rank: input.firstTouchRank ?? null,
        hit_quality: input.hitQuality ?? null,
        hit_quality_version: input.hitQualityVersion ?? null,
        edit_tool_calls: input.editToolCalls ?? 0,
        edit_error_count: input.editErrorCount ?? 0,
        edit_retry_count: input.editRetryCount ?? 0,
        model_fallbacks: optionalRedact(input.modelFallbacks),
        artifact_bytes: input.artifactBytes ?? null,
        approvals_requested: input.approvalsRequested ?? null,
        approvals_denied: input.approvalsDenied ?? null,
        approvals_auto_denied: input.approvalsAutoDenied ?? null,
        approvals_by_tier: input.approvalsByTier ?? null,
        approvals_by_mode: input.approvalsByMode ?? null,
        tool_call_counts: input.toolCallCounts ?? null,
        actual_tool_call_counts: input.actualToolCallCounts ?? null,
        tool_error_counts: input.toolErrorCounts ?? null,
        tool_adjacent_pairs: input.toolAdjacentPairs ?? null,
        tool_switch_same_target: input.toolSwitchSameTarget ?? null,
        reviewer_invocations: input.reviewerInvocations ?? null,
        reviewer_findings_count: input.reviewerFindingsCount ?? null,
        reviewer_model: input.reviewerModel ?? null,
        tool_loader_enabled: input.toolLoaderEnabled === undefined ? null : input.toolLoaderEnabled ? 1 : 0,
        tool_loader_path: input.toolLoaderPath ?? null,
        tool_loader_deferred: input.toolLoaderDeferred ?? null,
        tool_loader_activated: input.toolLoaderActivated ?? null,
        tool_loader_activations: input.toolLoaderActivations ?? null,
        tool_loader_tokens: input.toolLoaderTokens ?? null,
        tool_loader_deferred_tokens: input.toolLoaderDeferredTokens ?? null,
        hooks_registered: input.hooksRegistered ?? null,
        hook_denials: input.hookDenials ?? null,
        hook_notes: input.hookNotes ?? null,
        checkpoints_written: input.checkpointsWritten ?? null,
        ask_calls: input.askCalls ?? null,
        ask_answered: input.askAnswered ?? null,
        ask_unanswered: input.askUnanswered ?? null,
        skills_available: input.skillsAvailable ?? null,
        skills_invoked: input.skillsInvoked ?? null,
        skill_reads: input.skillReads ?? null,
        skills_head_tokens: input.skillsHeadTokens ?? null,
        post_edit_command: optionalRedact(input.postEditCommand),
        post_edit_runs: input.postEditRuns ?? null,
        post_edit_failures: input.postEditFailures ?? null,
        post_edit_passes: input.postEditPasses ?? null,
        post_edit_ms: input.postEditMs ?? null,
        post_edit_disabled_reason: optionalRedact(input.postEditDisabledReason),
        task_list_calls: input.taskListCalls ?? null,
        task_list_created: input.taskListCreated ?? null,
        task_list_completed: input.taskListCompleted ?? null,
        task_list_open: input.taskListOpen ?? null,
        task_list_reminders: input.taskListReminders ?? null,
        task_gate_refusals: input.taskGateRefusals ?? null,
        task_items_verified: input.taskItemsVerified ?? null,
        stagnation_trips: input.stagnationTrips ?? null,
        stagnation_key: optionalRedact(input.stagnationKey),
        retry_starts: input.retryStarts ?? null,
        retries_recovered: input.retriesRecovered ?? null,
        retries_exhausted: input.retriesExhausted ?? null,
        retry_max_attempt: input.retryMaxAttempt ?? null,
        retry_last_error: optionalRedact(input.retryLastError),
        compactions: input.compactions ?? 0,
        escalations: input.escalations ?? 0,
        human_interventions: input.humanInterventions ?? 0,
        transcript_path: input.transcriptPath ?? null,
        transcript_sha256: input.transcriptSha256 ?? null,
        transcript_bytes: input.transcriptBytes ?? null,
      });
    this.legacyMetricReopened.delete(input.id);
    this.refreshLiveCache(input.id, true);
  }

  /** T115: record the fan-out cost on the session that opened the browser. */
  recordBrowserFanout(input: {
    sessionId: string;
    elapsedMs: number;
    projectsScanned: number;
    rowsReturned: number;
  }): void {
    this.db
      .prepare(
        `UPDATE sessions
            SET browser_fanout_ms = @elapsed_ms,
                browser_projects_scanned = @projects_scanned,
                browser_rows_returned = @rows_returned
          WHERE id = @session_id`,
      )
      .run({
        session_id: input.sessionId,
        elapsed_ms: Math.max(0, Math.round(input.elapsedMs)),
        projects_scanned: Math.max(0, Math.floor(input.projectsScanned)),
        rows_returned: Math.max(0, Math.floor(input.rowsReturned)),
      });
  }

  /**
   * 2026-09-07 (UI feedback item 10): a human closes a session from the
   * browser. `Closed` is the durable "done, resume to reopen" fact, and it
   * is written here rather than by `endSession()` because the session being
   * closed usually belongs to a process that is no longer running — there
   * is nobody left to end it.
   *
   * `ended_utc` is filled in only when it is missing: a crashed session has
   * no end time, and closing it is the first honest one it can be given.
   * A session that already ended keeps the time it actually ended at.
   */
  closeSession(id: string, atUtc = new Date().toISOString()): void {
    const result = this.db
      .prepare(
        `UPDATE sessions
            SET closed_utc = COALESCE(closed_utc, @at),
                ended_utc  = COALESCE(ended_utc, @at)
          WHERE id = @id`,
      )
      .run({ id, at: atUtc });
    if (result.changes === 0) throw new Error(`lykos ledger: cannot close unknown session ${id}`);
  }

  /**
   * 2026-09-07 (UI feedback item 1): resuming a session CONTINUES it rather
   * than minting a rival row that links back with `resumed_from`. The
   * maintainer's reason is the plain one — a chain of near-identical rows
   * is a messier workspace with no benefit a reader could name.
   *
   * This is the narrowest possible reopen. It clears exactly the three
   * fields that say "this run is over" and touches nothing else:
   *
   *  * Every `calls` row stays where it is, so the session's cost is still
   *    the sum of its calls and `endSession()` recomputes the same total
   *    over a strictly larger set. The headline metric cannot be improved by
   *    resuming, which was the whole point of the old `resumed_from` rule.
   *  * `outcome` is cleared **only when it was recorded by the agent-facing
   *    paths that describe a run rather than a task** — an `abandoned` or a
   *    `fail` written by ingest from the run that just stopped. A `success`
   *    from `verification_command` or a `human` is a fact about work that
   *    was verified and is left exactly as it stands; `recordOutcome()`'s
   *    refusal to overwrite it is not bypassed here.
   *  * `archive_state` returns to `recent`, because the transcript is about
   *    to be appended to again.
   */
  reopenSession(id: string): void {
    const row = this.db
      .prepare(`SELECT outcome, outcome_source FROM sessions WHERE id = ?`)
      .get(id) as { outcome: string | null; outcome_source: string | null } | undefined;
    if (!row) throw new Error(`lykos ledger: cannot reopen unknown session ${id}`);
    const verified = row.outcome_source === "verification_command" || row.outcome_source === "human";
    this.db
      .prepare(
        `UPDATE sessions
            SET ended_utc = NULL,
                closed_utc = NULL,
                archive_state = CASE WHEN archive_state = 'archived' THEN archive_state ELSE 'recent' END,
                outcome = CASE WHEN @keep_outcome = 1 THEN outcome ELSE NULL END,
                outcome_source = CASE WHEN @keep_outcome = 1 THEN outcome_source ELSE NULL END
          WHERE id = @id`,
      )
      .run({ id, keep_outcome: verified ? 1 : 0 });
    const version = this.db
      .prepare(`SELECT explore_metric_version FROM sessions WHERE id = ?`)
      .get(id) as { explore_metric_version: number | null };
    if (version.explore_metric_version === null) this.legacyMetricReopened.add(id);
  }

  /**
   * 2026-09-07 (UI feedback item 2): give a session a name a person chose.
   *
   * `brief` is the column, because it is already the field every listing
   * surface reads and a second one would immediately disagree with it. A
   * human name outranks a derived one everywhere (`session/preview.ts`),
   * which is the same precedence `lykos task name` established.
   */
  renameSession(id: string, brief: string): boolean {
    const trimmed = brief.trim();
    if (trimmed.length === 0) throw new Error("lykos ledger: a session name cannot be empty");
    const result = this.db
      .prepare(`UPDATE sessions SET brief = @brief WHERE id = @id`)
      .run({ id, brief: optionalRedact(trimmed) ?? trimmed });
    return result.changes > 0;
  }

  /**
   * T129: hide the conversation while preserving every call and its cost.
   * The transcript/artifacts are removed by the session mutation boundary;
   * this row is the permanent accounting record and remains queryable.
   */
  markSessionDeleted(id: string, reason = "session conversation deleted by a human"): void {
    const result = this.db
      .prepare(
        `UPDATE sessions
            SET deleted_utc = COALESCE(deleted_utc, @deleted_utc),
                resumable = 0,
                not_resumable_reason = @reason
          WHERE id = @id`,
      )
      .run({ id, deleted_utc: new Date().toISOString(), reason: optionalRedact(reason) });
    if (result.changes === 0) throw new Error(`lykos ledger: cannot delete unknown session ${id}`);
  }

  /**
   * P4 T149: a Lykos extension's counters for a session, added to whatever
   * the session already holds under the same extension and name (a session
   * that ends twice — a resumed one — adds rather than overwrites). Refuses a
   * negative value, which the table's CHECK would refuse anyway.
   */
  recordExtensionCounters(
    sessionId: string,
    rows: ReadonlyArray<{ extension: string; name: string; value: number }>,
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO extension_counters (session_id, extension, name, value)
       VALUES (@session_id, @extension, @name, @value)
       ON CONFLICT (session_id, extension, name) DO UPDATE SET value = value + excluded.value`,
    );
    this.db.transaction(() => {
      for (const r of rows) {
        if (!Number.isInteger(r.value) || r.value < 0) {
          throw new Error(`lykos ledger: extension counter ${r.extension}.${r.name} must be a non-negative integer`);
        }
        insert.run({ session_id: sessionId, extension: r.extension, name: r.name, value: r.value });
      }
    })();
  }

  /**
   * P4 T152: a session's compaction attempts under self-compact. Keyed by the
   * record's own id, so a record already written is skipped rather than
   * doubled when a session is ingested again (a resumed one).
   */
  recordCompactions(sessionId: string, rows: ReadonlyArray<CompactionRow>): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO compactions
         (id, session_id, ts_utc, strategy, trigger, handoff_id, attempt, model, tier, context_window,
          tokens_before, tokens_after, result, error,
          method, fell_through, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_1h_tokens)
       VALUES (@id, @session_id, @ts_utc, @strategy, @trigger, @handoff_id, @attempt, @model, @tier, @context_window,
          @tokens_before, @tokens_after, @result, @error,
          @method, @fell_through, @input_tokens, @output_tokens, @cache_read_tokens, @cache_write_tokens, @cache_write_1h_tokens)`,
    );
    this.db.transaction(() => {
      for (const r of rows) {
        insert.run({
          id: r.id,
          session_id: sessionId,
          ts_utc: r.ts,
          strategy: r.strategy,
          trigger: r.trigger,
          handoff_id: r.handoff_id ?? null,
          attempt: r.attempt,
          model: r.model,
          tier: r.tier,
          context_window: r.context_window,
          tokens_before: r.tokens_before,
          tokens_after: r.tokens_after,
          result: r.result,
          error: optionalRedact(r.error),
          method: r.method ?? null,
          // The reasons are error text from a provider: redacted like `error`.
          fell_through:
            r.fell_through === undefined ? null : JSON.stringify(r.fell_through.map((f) => ({ ...f, reason: redactSecrets(f.reason) }))),
          input_tokens: r.input_tokens ?? null,
          output_tokens: r.output_tokens ?? null,
          cache_read_tokens: r.cache_read_tokens ?? null,
          cache_write_tokens: r.cache_write_tokens ?? null,
          cache_write_1h_tokens: r.cache_write_1h_tokens ?? null,
        });
      }
    })();
  }

  /**
   * T188: a session's prune passes. Keyed by the record's own id, so a record
   * already written is skipped rather than doubled when a session is reached
   * twice (a resumed one).
   */
  recordPrunes(sessionId: string, rows: ReadonlyArray<PruneRow>): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO prunes (id, session_id, ts_utc, superseded, useless, tokens_saved, reason)
       VALUES (@id, @session_id, @ts_utc, @superseded, @useless, @tokens_saved, @reason)`,
    );
    this.db.transaction(() => {
      for (const r of rows) {
        insert.run({
          id: r.id,
          session_id: sessionId,
          ts_utc: r.ts,
          superseded: r.superseded,
          useless: r.useless,
          tokens_saved: r.tokens_saved,
          reason: r.reason,
        });
      }
    })();
  }

  /** T188: a session's prune passes, oldest first. */
  prunes(sessionId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(`SELECT * FROM prunes WHERE session_id = ? ORDER BY ts_utc, rowid`)
      .all(sessionId) as Array<Record<string, unknown>>;
  }

  /**
   * T179: the commits a session made through `commit`. Keyed by (session, sha),
   * so a log already written is skipped rather than doubled when the session's
   * end is reached twice (a resumed one).
   */
  recordCommits(sessionId: string, rows: ReadonlyArray<CommitRow>): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO commits (session_id, sha, ts_utc, subject, message, files_changed, scope)
       VALUES (@session_id, @sha, @ts_utc, @subject, @message, @files_changed, @scope)`,
    );
    this.db.transaction(() => {
      for (const r of rows) {
        insert.run({
          session_id: sessionId,
          sha: r.sha,
          ts_utc: r.tsUtc,
          subject: redactSecrets(r.subject),
          message: redactSecrets(r.message),
          files_changed: r.filesChanged,
          scope: r.scope,
        });
      }
    })();
  }

  /** T179: a session's commits, in the order they were made. */
  commits(sessionId: string): CommitShown[] {
    return this.db
      .prepare(`SELECT sha, ts_utc, subject, message, files_changed, scope FROM commits WHERE session_id = ? ORDER BY ts_utc, rowid`)
      .all(sessionId) as CommitShown[];
  }

  /** P4 T152: a session's compaction attempts, oldest first. */
  compactions(sessionId: string): Array<Record<string, unknown>> {
    return this.db
      .prepare(`SELECT * FROM compactions WHERE session_id = ? ORDER BY ts_utc, rowid`)
      .all(sessionId) as Array<Record<string, unknown>>;
  }

  /** T167: a session's flaky tests, in the order the gate named them. */
  flakyTests(sessionId: string): FlakyTestRow[] {
    return this.db
      .prepare(`SELECT session_id, ts_utc, test_file, test_name, edited_by_session, first_exit_code, rerun_exit_code, rerun_command
                  FROM flaky_tests WHERE session_id = ? ORDER BY id`)
      .all(sessionId) as FlakyTestRow[];
  }

  /** T167: how many flaky tests the ledger holds, and across how many sessions. What `lykos doctor` reports. */
  flakyTestCount(): { tests: number; sessions: number } {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS tests, COUNT(DISTINCT session_id) AS sessions FROM flaky_tests`)
      .get() as { tests: number; sessions: number };
    return { tests: row.tests, sessions: row.sessions };
  }

  /** P4 T149: a session's extension counters, oldest extension first. */
  extensionCounters(sessionId: string): Array<{ extension: string; name: string; value: number }> {
    return this.db
      .prepare(
        `SELECT extension, name, value FROM extension_counters WHERE session_id = ? ORDER BY rowid`,
      )
      .all(sessionId) as Array<{ extension: string; name: string; value: number }>;
  }

  /** T195: record a seal event (created, verified, etc.) */
  recordSealEvent(event: SealEventInput): void {
    const creator = event.creator ?? (event.sessionId ? event.sessionId : "cli");
    const sessionId = event.sessionId !== undefined ? event.sessionId : (creator !== "cli" ? creator : null);
    const ts = event.ts ?? new Date().toISOString();
    const paths = typeof event.paths === "string" ? event.paths : JSON.stringify(event.paths);
    const detail =
      typeof event.detail === "object" && event.detail !== null
        ? JSON.stringify(event.detail)
        : event.detail ?? null;

    this.db
      .prepare(
        `INSERT INTO seal_events (ts, session_id, creator, specialist, branch, kind, paths, detail)
         VALUES (@ts, @session_id, @creator, @specialist, @branch, @kind, @paths, @detail)`,
      )
      .run({
        ts,
        session_id: sessionId,
        creator,
        specialist: event.specialist ?? null,
        branch: event.branch,
        kind: event.kind,
        paths,
        detail,
      });
  }

  /** T195: retrieve seal events, optionally filtered by branch. */
  sealEvents(branch?: string): SealEventRow[] {
    if (branch !== undefined) {
      return this.db
        .prepare(
          `SELECT id, ts, session_id, creator, specialist, branch, kind, paths, detail
           FROM seal_events WHERE branch = ? ORDER BY id ASC`,
        )
        .all(branch) as SealEventRow[];
    }
    return this.db
      .prepare(
        `SELECT id, ts, session_id, creator, specialist, branch, kind, paths, detail
         FROM seal_events ORDER BY id ASC`,
      )
      .all() as SealEventRow[];
  }

  /**
   * T52: record whether the task actually worked. See `RecordOutcomeInput`
   * for why this is not part of `endSession()`.
   *
   * Refuses in three cases, each for a reason the ledger cannot afford to
   * get wrong:
   *
   *  - **Unknown session.** A typo'd id must not silently record nothing.
   *  - **An outcome is already recorded.** Overwriting it would be a rewrite
   *    of history rather than a completion of a row, which is the one thing
   *    this file's header forbids. `abandoned` and `fail` written by
   *    `ingest.ts` from a real abort or error are answers, not gaps.
   *  - **`outcome_source = 'agent_claim'`.** The value exists in the schema
   *    so `lykos cost` can *exclude* it; nothing in the product may produce
   *    one through this writer. A future path that genuinely needs to record
   *    an agent's self-report must add its own explicit method, so that the
   *    exclusion can never be bypassed by a caller passing a string.
   */
  /**
   * T76: record what happened to every eligible memory entry this session.
   *
   * Written once, at ingest, in one transaction. A duplicate (session,
   * entry) pair is a no-op, because ingest is re-runnable by design and a
   * second row would double-count an entry's eligibility -- but an invalid
   * `state` still raises rather than vanishing.
   */
  recordMemoryEligibility(sessionId: string, records: ReadonlyArray<MemoryEligibilityInput>): void {
    if (records.length === 0) return;
    // ON CONFLICT DO NOTHING, deliberately NOT `INSERT OR IGNORE`: the
    // latter also swallows CHECK violations, so an invalid `state` would be
    // dropped in silence instead of raising. Idempotence is wanted only for
    // the duplicate-row case.
    const stmt = this.db.prepare(
      `INSERT INTO memory_eligibility
         (session_id, entry_id, scope, file, state, position, tokens)
       VALUES (@session_id, @entry_id, @scope, @file, @state, @position, @tokens)
       ON CONFLICT(session_id, entry_id) DO NOTHING`,
    );
    const all = this.db.transaction((rows: ReadonlyArray<MemoryEligibilityInput>) => {
      for (const r of rows) {
        stmt.run({
          session_id: sessionId,
          entry_id: r.entryId,
          scope: r.scope,
          file: r.file,
          state: r.state,
          position: r.position,
          tokens: r.tokens,
        });
      }
    });
    all(records);
  }

  /**
   * T80: record one human-authored rediscovery annotation.
   *
   * Refuses any author but `human`, for exactly the reason `recordOutcome`
   * refuses `agent_claim`: this table is the evidence for whether memory has
   * anything to buy, and an agent allowed to write it could manufacture that
   * evidence. The CHECK constraint is the second line of defence; this is
   * the first, and it is the one with a message.
   */
  recordRediscovery(input: RecordRediscoveryInput): number {
    if (input.author !== "human") {
      throw new Error(
        `lykos ledger: recordRediscovery refuses author='${input.author}' -- a rediscovery annotation is ` +
          "ground truth for whether memory pays, and an agent's self-report may never create it " +
          "(CLAUDE.md; the outcome_source rule, applied to memory).",
      );
    }
    const lesson = input.lesson.trim();
    if (lesson.length === 0) {
      throw new Error("lykos ledger: recordRediscovery: the lesson is empty -- there is nothing to record.");
    }
    const info = this.db
      .prepare(
        `INSERT INTO rediscovery_annotations
           (ts_utc, session_id, source_session_id, lesson, would_have_helped, calls_spent, author)
         VALUES (@ts_utc, @session_id, @source_session_id, @lesson, @would_have_helped, @calls_spent, 'human')`,
      )
      .run({
        ts_utc: input.tsUtc ?? new Date().toISOString(),
        session_id: input.sessionId ?? null,
        source_session_id: input.sourceSessionId ?? null,
        lesson: redactSecrets(lesson),
        would_have_helped: input.wouldHaveHelped === undefined ? null : input.wouldHaveHelped ? 1 : 0,
        calls_spent: input.callsSpent ?? null,
      });
    return Number(info.lastInsertRowid);
  }

  recordOutcome(input: RecordOutcomeInput): void {
    if ((input.outcomeSource as OutcomeSource) === "agent_claim") {
      throw new Error(
        "lykos ledger: recordOutcome refuses outcome_source='agent_claim' -- an agent's self-report is " +
          "never counted as success. Use a verification command or a human answer.",
      );
    }
    if (input.verificationExitCode !== undefined) {
      // T144: the stored outcome and the stored exit code must never disagree
      // — a success beside a non-zero code is a record nobody could trust.
      const derived: Outcome = input.verificationExitCode === 0 ? "success" : "fail";
      // T167: the one way `success` may sit beside a non-zero exit code — a
      // rerun of the failed files exited 0, named the tests that flaked, and
      // none of them is in a file the session edited.
      const clearedByRerun =
        input.outcome === "success" &&
        input.rerun !== undefined &&
        input.rerun.exitCode === 0 &&
        input.rerun.flaky.length > 0 &&
        input.rerun.flaky.every((f) => !f.editedBySession);
      // T201: a gate check can turn success into fail (block-only). It can never produce success.
      const blockedByGateCheck = input.outcome === "fail" && input.gateBlocked === true;
      if (input.outcomeSource !== "verification_command" || (input.outcome !== derived && !clearedByRerun && !blockedByGateCheck)) {
        throw new Error(
          `lykos ledger: recordOutcome refuses exit code ${input.verificationExitCode} with ` +
            `outcome='${input.outcome}' (source=${input.outcomeSource}) -- an exit code is recorded only by a ` +
            `verification command, and 0 means success, anything else fail`,
        );
      }
    }
    const existing = this.db.prepare(`SELECT outcome FROM sessions WHERE id = ?`).get(input.id) as
      | { outcome: string | null }
      | undefined;
    if (!existing) throw new Error(`lykos ledger: recordOutcome: unknown session ${input.id}`);
    if (existing.outcome) {
      throw new Error(
        `lykos ledger: recordOutcome: session ${input.id} already recorded outcome='${existing.outcome}' ` +
          "(append-only; an outcome is completed once, never rewritten)",
      );
    }
    if (input.rerun !== undefined && input.outcomeSource !== "verification_command") {
      throw new Error("lykos ledger: recordOutcome: a rerun is recorded only by a verification command");
    }
    const update = this.db.prepare(
      `UPDATE sessions SET
         outcome = @outcome,
         outcome_source = @outcome_source,
         verification_cmd = COALESCE(@verification_cmd, verification_cmd),
         verification_output = COALESCE(@verification_output, verification_output),
         verification_exit_code = @verification_exit_code,
         notes = COALESCE(@notes, notes)
       WHERE id = @id`,
    );
    const insertFlaky = this.db.prepare(
      `INSERT INTO flaky_tests
         (session_id, ts_utc, test_file, test_name, edited_by_session, first_exit_code, rerun_exit_code, rerun_command)
       VALUES (@session_id, @ts_utc, @test_file, @test_name, @edited_by_session, @first_exit_code, @rerun_exit_code, @rerun_command)`,
    );
    this.db.transaction(() => {
      update.run({
        id: input.id,
        outcome: input.outcome,
        outcome_source: input.outcomeSource,
        verification_cmd: optionalRedact(input.verificationCmd),
        verification_output: optionalRedact(input.verificationOutput),
        verification_exit_code: input.verificationExitCode ?? null,
        notes: optionalRedact(input.notes),
      });
      // T167: a flaky test is named only when the rerun passed. The rows and
      // the outcome land together or not at all.
      if (input.rerun !== undefined && input.rerun.exitCode === 0) {
        const ts = new Date().toISOString();
        for (const f of input.rerun.flaky) {
          insertFlaky.run({
            session_id: input.id,
            ts_utc: ts,
            test_file: redactSecrets(f.file),
            test_name: redactSecrets(f.name),
            edited_by_session: f.editedBySession ? 1 : 0,
            first_exit_code: input.verificationExitCode ?? null,
            rerun_exit_code: input.rerun.exitCode,
            rerun_command: redactSecrets(input.rerun.command),
          });
        }
      }
    })();
    this.refreshLiveCache(input.id, true);
    // T61 (docs/19-phase4-tasks.md): `tasks.state` has been 'open' since T8
    // and nothing ever closed it. This is its writer, and it is deliberately
    // HERE rather than in ingest: `recordOutcome` is only reachable from
    // `lykos verify` and the interactive end-of-session prompt, both of
    // which are `verification_command` or `human`. An agent's claim can
    // never move a task, because it can never reach this method at all.
    //
    // Only a success closes a task. A `fail` leaves it open, because a
    // failed attempt is a reason to resume, not a reason to declare the
    // work over — and abandonment is a person's word, taken through
    // `lykos task abandon`.
    if (input.outcome === "success") this.setTaskStateForSession(input.id, "done");
  }

  /** Moves the task a session belongs to, if it belongs to one. A task already `done` is never reopened by a later row. */
  setTaskStateForSession(sessionId: string, state: TaskState): void {
    const row = this.db.prepare(`SELECT task_id FROM sessions WHERE id = ?`).get(sessionId) as
      | { task_id: string | null }
      | undefined;
    if (!row?.task_id) return;
    this.setTaskState(row.task_id, state);
  }

  /**
   * T61: the task-state transition, as a plain writer.
   *
   * `tasks` is identity and naming, not measurement — the numbers live on
   * `sessions` and `calls`, which stay append-only. Updating a task's state
   * or its name changes nothing anyone has counted.
   */
  setTaskState(taskId: string, state: TaskState): void {
    this.db.prepare(`UPDATE tasks SET state = ? WHERE id = ?`).run(state, taskId);
  }

  /** T61: `lykos task name`. A task nobody named is still a task; this is how it stops being anonymous. */
  renameTask(taskId: string, brief: string): boolean {
    const info = this.db
      .prepare(`UPDATE tasks SET brief = ? WHERE id = ?`)
      .run(optionalRedact(brief) ?? "(no brief)", taskId);
    return info.changes > 0;
  }

  /**
   * Refreshes `.lykos/session/<id>/live.json` and `.lykos/today.json` — the
   * fast-read cache S1/S2 use instead of opening SQLite (see live.ts).
   * Best-effort: a caller here is mid-recordCall and must not fail on a
   * filesystem hiccup, and `:memory:` ledgers (all of the unit tests) have no
   * directory to write into at all.
   */
  private refreshLiveCache(sessionId: string, force: boolean): void {
    if (this.path === ":memory:") return;
    if (!this.liveThrottle.shouldWrite(sessionId, force)) return;
    try {
      const session = this.db
        .prepare(
          `SELECT task_id, brief, started_utc, ended_utc, outcome, outcome_source
           FROM sessions WHERE id = ?`,
        )
        .get(sessionId) as
        | {
            task_id: string | null;
            brief: string | null;
            started_utc: string;
            ended_utc: string | null;
            outcome: string | null;
            outcome_source: string | null;
          }
        | undefined;
      if (!session) return;

      const totals = this.callTotals(sessionId);
      const lastCallRow = this.db
        .prepare(
          `SELECT ts_utc, agent, phase, provider, model, context_before, context_after,
                  tool_schema_tokens, tool_count, prefix_changed
           FROM calls WHERE session_id = ? ORDER BY ts_utc DESC LIMIT 1`,
        )
        .get(sessionId) as
        | {
            ts_utc: string;
            agent: string;
            phase: string | null;
            provider: string;
            model: string;
            context_before: number | null;
            context_after: number | null;
            tool_schema_tokens: number | null;
            tool_count: number | null;
            prefix_changed: number | null;
          }
        | undefined;

      const now = new Date().toISOString();
      const snapshot: LiveSnapshot = {
        schemaVersion: 1,
        sessionId,
        taskId: session.task_id,
        brief: session.brief,
        startedUtc: session.started_utc,
        heartbeatUtc: now,
        endedUtc: session.ended_utc,
        outcome: session.outcome,
        outcomeSource: session.outcome_source,
        totals: {
          costUsd: totals.costUsd ?? 0,
          input: totals.input,
          output: totals.output,
          cacheRead: totals.cacheRead,
          cacheWrite: totals.cacheWrite,
          reasoning: totals.reasoning,
          calls: totals.n,
        },
        lastCall: lastCallRow
          ? {
              tsUtc: lastCallRow.ts_utc,
              agent: lastCallRow.agent,
              phase: lastCallRow.phase,
              provider: lastCallRow.provider,
              model: lastCallRow.model,
              contextBefore: lastCallRow.context_before,
              contextAfter: lastCallRow.context_after,
              toolSchemaTokens: lastCallRow.tool_schema_tokens,
              toolCount: lastCallRow.tool_count,
              prefixChanged: lastCallRow.prefix_changed === 1,
            }
          : null,
      };
      writeLiveSnapshot(this.path, snapshot);

      const today = this.db
        .prepare(
          `SELECT
             COUNT(*)                   AS sessions,
             SUM(outcome = 'success')   AS successes,
             COALESCE(SUM(total_cost_usd), 0) AS spent_usd
           FROM sessions WHERE DATE(started_utc) = DATE('now')`,
        )
        .get() as { sessions: number; successes: number | null; spent_usd: number };
      const rollup: TodayRollup = {
        schemaVersion: 1,
        date: now.slice(0, 10),
        spentUsd: today.spent_usd,
        sessions: today.sessions,
        successes: today.successes ?? 0,
        updatedUtc: now,
      };
      writeTodayRollup(this.path, rollup);
    } catch (err) {
      process.stderr.write(
        `lykos ledger: live cache refresh failed (non-fatal): ${(err as Error).message}\n`,
      );
    }
  }

  hasCalls(sessionId: string): boolean {
    const row = this.db.prepare(`SELECT 1 AS ok FROM calls WHERE session_id = ? LIMIT 1`).get(sessionId) as
      | { ok: number }
      | undefined;
    return row !== undefined;
  }

  callTotals(sessionId: string): CallTotals {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS n,
           COUNT(CASE WHEN cost_usd IS NULL THEN 1 END) AS unpricedCalls,
           CASE WHEN COUNT(*) = 0 THEN 0 ELSE SUM(cost_usd) END AS costUsd,
           COALESCE(SUM(input_tokens), 0) AS input,
           COALESCE(SUM(output_tokens), 0) AS output,
           COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
           COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
           COALESCE(SUM(reasoning_tokens), 0) AS reasoning
         FROM calls WHERE session_id = ?`,
      )
      .get(sessionId) as CallTotals;
    return row;
  }

  /**
   * T39.4: sum call cost across the task tree rooted at `sessionId`.
   * Prefer `task_id` when present (every session of the task); otherwise
   * walk `parent_session_id` to the root and include that root plus every
   * descendant. Never double-counts: each call belongs to exactly one
   * session.
   */
  taskCallTotals(sessionId: string): CallTotals {
    const row = this.db
      .prepare(`SELECT id, task_id, parent_session_id FROM sessions WHERE id = ?`)
      .get(sessionId) as { id: string; task_id: string | null; parent_session_id: string | null } | undefined;
    if (!row) {
      return { n: 0, costUsd: 0, unpricedCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    }

    let ids: string[];
    if (row.task_id) {
      ids = (
        this.db.prepare(`SELECT id FROM sessions WHERE task_id = ?`).all(row.task_id) as Array<{ id: string }>
      ).map((r) => r.id);
    } else {
      let rootId = row.id;
      let parent = row.parent_session_id;
      const seen = new Set<string>([rootId]);
      while (parent) {
        if (seen.has(parent)) break;
        seen.add(parent);
        const up = this.db
          .prepare(`SELECT id, parent_session_id FROM sessions WHERE id = ?`)
          .get(parent) as { id: string; parent_session_id: string | null } | undefined;
        if (!up) break;
        rootId = up.id;
        parent = up.parent_session_id;
      }
      ids = this.familySessionIds(rootId);
    }

    if (ids.length === 0) {
      return { n: 0, costUsd: 0, unpricedCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    }
    const placeholders = ids.map(() => "?").join(", ");
    return this.db
      .prepare(
        `SELECT
           COUNT(*) AS n,
           COUNT(CASE WHEN cost_usd IS NULL THEN 1 END) AS unpricedCalls,
           CASE WHEN COUNT(*) = 0 THEN 0 ELSE SUM(cost_usd) END AS costUsd,
           COALESCE(SUM(input_tokens), 0) AS input,
           COALESCE(SUM(output_tokens), 0) AS output,
           COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
           COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
           COALESCE(SUM(reasoning_tokens), 0) AS reasoning
         FROM calls WHERE session_id IN (${placeholders})`,
      )
      .get(...ids) as CallTotals;
  }

  /** Root session plus every descendant linked by parent_session_id (BFS). */
  familySessionIds(rootSessionId: string): string[] {
    const out: string[] = [rootSessionId];
    const queue = [rootSessionId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      const children = this.db
        .prepare(`SELECT id FROM sessions WHERE parent_session_id = ?`)
        .all(id) as Array<{ id: string }>;
      for (const child of children) {
        out.push(child.id);
        queue.push(child.id);
      }
    }
    return out;
  }

  close(): void {
    this.db.close();
  }
}

export function defaultLedgerPath(workspace: string): string {
  return join(workspace, ".lykos", "ledger.db");
}

/**
 * `Ledger.open()` retried on `SqliteError: database is locked`, opening a
 * fresh connection each attempt. `busy_timeout` (set inside `open()`) covers
 * SQLite-level lock waits, but T7's kill-switch acceptance run found a
 * narrower cross-process window on Windows that it did not fully close —
 * see `DECISIONS.md` 2026-08-29 "T7". Any caller that opens the ledger
 * shortly after a related child process may still be releasing its own
 * connection to the same file — `lykos run` right after its delegate
 * subprocess exits (T14), or a test script reading back what a sandbox
 * process just wrote — needs this instead of a bare `Ledger.open()`.
 * Ordinary CLI reads (`lykos cost`) don't: by the time they run, the
 * delegate process that did the writing is long gone.
 */
export async function openLedgerWithRetry(path: string, attempts = 10, delayMs = 200): Promise<Ledger> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return Ledger.open(path);
    } catch (err) {
      lastErr = err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}
