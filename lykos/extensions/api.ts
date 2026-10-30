// The Lykos extension API.
//
// **Why it exists.** A user cannot add a tool to Lykos. Pi extensions load and
// cover anything Pi can express, but Pi has no concept of the moments Lykos
// owns — a post-edit check coming back red, a verification gate's verdict, a
// specialist switch, a budget band crossed, a checkpoint written, a memory
// injected, an approval decided, a task list changing — and those are exactly
// the moments somebody wants to hook.
//
// **TWO SURFACES, NO MIRRORING (D1), and the reason is release coupling.**
// This module has its own event names and its own payloads. It does not
// re-export, wrap or shadow a single Pi event, and it is not on the path Pi
// extensions load by: `config/extensions.ts` is untouched and
// `config/extensions.test.ts` passes unchanged. An unknown Pi event therefore
// passes through without this module knowing what it is, so a new Pi
// capability is usable the day it ships without a Lykos release — and,
// symmetrically, a Pi event-shape change cannot break a Lykos extension. That
// is the same reason the runtime is pinned exactly, applied one layer up.
//
// **EVERY PAYLOAD IS ALREADY COMPUTED SOMEWHERE (D2).** Each event fires from
// the one place that already knows the answer: `loop/post-edit.ts` has the
// verdict, `gate/verify-gate.ts` has the outcome, `loop/checkpoint.ts` has the
// commit, and so on. Nothing here recomputes one. Where a value was not
// available at the firing site it is absent from the payload and said to be,
// rather than derived a second time from something that looked close enough.
//
// **A THROWING EXTENSION IS REPORTED AND COUNTED (D3), never swallowed and
// never fatal.** `emit()` catches, records the extension's name, the event and
// the message, increments a counter the session can report, and carries on to
// the next handler. The existing hook surface (`loop/hooks.ts`) was brought to
// this same standard in the same change, because leaving two standards is how
// the old one survives — it used to `continue` out of a throwing hook without
// even recording that the hook had run (backlog D12).
//
// **A REGISTERED TOOL IS A REGISTRY ROW AND REACHES THE GATE (D4), and the
// rule is structural rather than remembered.** An extension does not hand over
// a `ToolDefinition`; it hands over a description, a schema and a function.
// The host builds the definition, and the definition it builds calls
// `authorizeExtensionTool()` before the function runs. There is no shape an
// extension can return with that call missing, which is why the bypass test in
// `api.test.ts` is an assertion about the API's type rather than a reminder in
// a comment. `memory-tools.ts` makes the same move for the same reason: a
// capability the caller must not have is simply not a member of what it is
// handed.
//
// **A DECLARED TIER IS A DECLARATION, NOT A PROMISE (D4).** An extension may
// say its tool is `read`. Lykos records that, shows it as extension-declared
// next to the extension's name wherever the row is rendered, and gates the
// call as `{ kind: "extension" }`, which `tierForTool` has no declaration for
// and therefore answers `hard-write` to. The human sees what was claimed; the
// policy acts on what can be verified, which is nothing.
//
// **INTERFACE REGISTRATION IS DESIGNED FOR AND NOT BUILT (D6).**
// `registerInterface` exists, is documented, and refuses. It is here so that
// building it later is additive rather than a new method every existing
// extension has to learn about — and it refuses today because an extension
// that can draw interface is an extension that can break a product surface,
// and there is no version of that which is contained by asking politely.
//
// **P4 T149 ADDED THREE CAPABILITIES** so the reviewer could be written as an
// extension (spec story 35): `session_end`, the one event delivered with
// `emitAndWait` so a handler can do slow work; `runChildSession`, a read-only
// child whose read-only-ness the session enforces, not the extension; and
// `recordCounter`, an extension's own numbers in the ledger under its
// declared name. Each is open to any extension.
//
// **THE ESCAPE HATCH (D8).** Anything this API does not cover: write a Pi
// extension, and Lykos will load it. That sentence is in
// `docs/reference/extension-policy.md`, which is where an extension author
// looks.

import { Type, type TSchema } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  ApprovalDeniedError,
  authorizeExtensionTool,
  buildExtensionRequest,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
  type DenialLog,
} from "../gate/approval.js";
import { DEFAULT_RISK_TIER, isRiskTier, type RiskTier } from "../tools/tool-risk.js";
import {
  FILES_CHANGED_DETAIL,
  type PromptPresence,
  type ToolRegistryEntry,
  type ToolResidency,
} from "../tools/tool-surface.js";
import type { ProjectExecutor } from "../tools/executor.js";
import type { GateOutcome } from "../gate/verify-gate.js";
import { workingTreeFingerprint } from "../loop/checkpoint.js";
import { stderrWrite } from "../tui/io-mode.js";

// ---------------------------------------------------------------------------
// The nine events.
// ---------------------------------------------------------------------------

/**
 * The moments Pi has no concept of. Order is the ticket's order, and the list
 * is closed: an event nobody fires is an event an extension author will write
 * a handler for and never find out is dead.
 */
export const LYKOS_EVENTS = [
  "post_edit_check",
  "verification_verdict",
  "specialist_switch",
  "budget_threshold",
  "checkpoint_written",
  "memory_injected",
  "approval_decided",
  "task_list_changed",
  // P14.6 ticket 06: fired by the session's rotation callback.
  "credential_rotated",
  // P4 T149: fired once, after the gate, by the session owner (`session/session.ts`,
  // `session/interactive.ts`) — the only place that holds the verdict, the edit
  // test and the tree at once. Delivered with `emitAndWait`, so a handler may
  // run a child session before the process moves on.
  "session_end",
] as const;

export type LykosEvent = (typeof LYKOS_EVENTS)[number];

/** `loop/post-edit.ts`: the project's own check ran after a write or an edit. */
export interface PostEditCheckEvent {
  command: string;
  passed: boolean;
  /** Null when the command was killed or never started. */
  exitCode: number | null;
  ms: number;
  /** The loop switched itself off on this run — too slow, timed out, or unstartable. */
  disabled: boolean;
  /** Why it switched off. Absent when it did not. */
  disabledReason?: string;
}

/** `gate/verify-gate.ts`: the per-task gate at session end. */
export interface VerificationVerdictEvent {
  status: "recorded" | "skipped";
  /** Absent on `skipped` — nothing was recorded, and inventing one is what rule 4 forbids. */
  outcome?: "success" | "fail";
  command?: string;
  /** The gate command's exit code — the FIRST run's, when a rerun followed. */
  exitCode?: number | null;
  /**
   * T167 (ADR-0030): present when the gate reran the failed test files. The
   * first run's exit code is `exitCode` above; the rerun's is here. `flakyTests`
   * are the tests that failed and then passed on rerun, and are empty when the
   * rerun failed too. A flaky test with `editedBySession` is why `outcome`
   * can be `fail` beside a rerun that passed.
   */
  rerun?: {
    command: string;
    exitCode: number | null;
    flakyTests: ReadonlyArray<{ file: string; name: string; editedBySession: boolean }>;
  };
  reason?: string;
}

/** `session/specialist-switch.ts`: a mid-session specialist switch resolved. */
export interface SpecialistSwitchEvent {
  name: string;
  /** Exactly the fields the switch report prints, and empty when nothing differs. */
  changed: ReadonlyArray<{ field: string; from: string; to: string }>;
  toolNames: readonly string[];
  notices: readonly string[];
}

/** `loop/context-budget.ts`: a context band was crossed and the model told once. */
export interface BudgetThresholdEvent {
  /** The band, as a fraction of the window. */
  band: number;
  contextTokens: number;
  contextWindow: number;
  usedFraction: number;
  /** Token count at which compaction fires. */
  compactAt: number;
}

/** `loop/checkpoint.ts`: a turn checkpoint actually became a commit. */
export interface CheckpointWrittenEvent {
  commit: string;
  label: string;
}

/** `session/memory-head.ts`: what was frozen into this session's head. */
export interface MemoryInjectedEvent {
  ids: readonly string[];
  count: number;
  tokens: number;
  /** Eligible entries the token cap left out. */
  skipped: number;
  /** Entries held back because a path they declare no longer exists. */
  stale: number;
  available: number;
}

/** `gate/approval.ts`, through `gateWithExtensionEvents`: what the gate decided. */
export interface ApprovalDecidedEvent {
  kind: ApprovalRequest["kind"];
  decision: ApprovalDecision;
  summary: string;
  detail: string;
  shell?: "bash" | "powershell";
}

/** `tools/task-list.ts`: the list changed. */
export interface TaskListChangedEvent {
  open: number;
  total: number;
  completedIds: readonly number[];
  version: number;
}

/**
 * `credentials/rotate.ts`, through the session's rotation callback: a request
 * moved from one pooled credential to the next. Labels and the classifier's
 * verdict only — never a key or token.
 */
export interface CredentialRotatedEvent {
  provider: string;
  /** The non-secret label of the credential that failed. */
  from: string;
  /** The non-secret label of the credential the request moved to. */
  to: string;
  /** The failure classifier's kind, e.g. `usage_limit`, `auth_401`. */
  reason: string;
}

/**
 * T149: what the session's working tree changed, relative to the commit it
 * booted on. Computed once, at the firing site, from git — every extension
 * reads the same bytes.
 */
export interface SessionDiffSummary {
  /** The commit the diff is against: the session's HEAD at boot. Null outside a git repository. */
  base: string | null;
  /** One row per changed path. `added`/`removed` are null for a binary file. */
  files: ReadonlyArray<{ path: string; added: number | null; removed: number | null; untracked: boolean }>;
  /** The unified diff, untracked files included as additions, bounded (`loop/diff-summary.ts`). */
  text: string;
  /** True when `text` was cut to fit; the head and tail are kept. */
  truncated: boolean;
}

/**
 * T149 (spec story 35): the session's end, after the gate.
 *
 * Fires for a top-level session only — a child's parent covers the task, the
 * same rule the gate follows. A session that hands over to a continuation
 * fires its own, since each session row ends once.
 */
export interface SessionEndEvent {
  sessionId: string;
  /** `provider/model` the session was on when it ended. */
  model: string;
  /** How the run ended. The gate runs only on `done`. */
  state: "done" | "aborted" | "error";
  /** Whether a successful call changed a file — the gate's own test (T143's one declaration). */
  edited: boolean;
  /** The gate's verdict, in `verification_verdict`'s shape. `skipped` with a reason when it did not run. */
  verdict: VerificationVerdictEvent;
  diff: SessionDiffSummary;
  /** The task list as it stood at the end, rendered; empty when the list was never used. */
  taskList: string;
}

export interface LykosEventPayloads {
  post_edit_check: PostEditCheckEvent;
  verification_verdict: VerificationVerdictEvent;
  specialist_switch: SpecialistSwitchEvent;
  budget_threshold: BudgetThresholdEvent;
  checkpoint_written: CheckpointWrittenEvent;
  memory_injected: MemoryInjectedEvent;
  approval_decided: ApprovalDecidedEvent;
  task_list_changed: TaskListChangedEvent;
  credential_rotated: CredentialRotatedEvent;
  session_end: SessionEndEvent;
}

/**
 * What a FIRING SITE is handed, and all it is handed.
 *
 * `loop/checkpoint.ts` can announce that a checkpoint was written. It cannot
 * register a handler, register a tool, read the failure log or reach any other
 * extension — none of those is a member of this type, so none of them is a
 * mistake anybody can make there. `memory-tools.ts` took the same shape for
 * the same reason.
 */
export interface LykosEventSink {
  emit<E extends LykosEvent>(event: E, payload: LykosEventPayloads[E]): void;
}

/**
 * The sink a site gets when no extension host exists — every session before
 * this ticket, and every test that is not about events.
 *
 * It is a real object rather than an `undefined` check at each site because a
 * site that has to remember to test for undefined is a site that will one day
 * forget, and the cost of the no-op is a method call.
 */
export const NULL_EVENT_SINK: LykosEventSink = {
  emit: () => undefined,
};

// ---------------------------------------------------------------------------
// Failures: reported and counted (D3).
// ---------------------------------------------------------------------------

/**
 * Where a failure happened. Not only events: a registration can throw too, and
 * (T147) a declared package can fail to load at all — no entry file, an import
 * that throws, or an export that is not an extension.
 */
export type ExtensionFailureSite = LykosEvent | "install" | "command" | "load" | "child_session" | "tool_call" | "gate_check";

export interface ExtensionFailure {
  extension: string;
  site: ExtensionFailureSite;
  message: string;
}

/** How many failures are kept for the session report. Counts are exact; texts are not hoarded. */
export const EXTENSION_FAILURE_LOG_CAP = 20;

export interface ExtensionCounters {
  /** Handler invocations that returned without throwing. */
  deliveries: number;
  /** Handler invocations, installs and commands that threw. Never reset. */
  failures: number;
  /** Per extension name, so "which one is broken" is answerable without reading the log. */
  failuresByExtension: Record<string, number>;
  /** The most recent `EXTENSION_FAILURE_LOG_CAP` failures, oldest first. */
  log: ExtensionFailure[];
  /** Tools registered, and slash commands registered. */
  tools: number;
  commands: number;
  /** D6: interface registrations refused. A number worth having — it says somebody wanted it. */
  interfaceRefusals: number;
}

export function newExtensionCounters(): ExtensionCounters {
  return {
    deliveries: 0,
    failures: 0,
    failuresByExtension: {},
    log: [],
    tools: 0,
    commands: 0,
    interfaceRefusals: 0,
  };
}

/** The one line a session prints about its Lykos extensions. Undefined when there is nothing to say. */
export function extensionFailureNotice(counters: ExtensionCounters): string | undefined {
  if (counters.failures === 0) return undefined;
  const who = Object.entries(counters.failuresByExtension)
    .map(([name, n]) => `${name} (${n})`)
    .join(", ");
  const last = counters.log.at(-1);
  return (
    `lykos: ${counters.failures} extension failure(s) this session — ${who}. ` +
    (last !== undefined ? `Most recent: ${last.extension} on ${last.site}: ${last.message}` : "") +
    ` A failing extension is skipped, not fatal; its policy is NOT running.`
  );
}

// ---------------------------------------------------------------------------
// Registrations.
// ---------------------------------------------------------------------------

/**
 * D4: what an extension declares about its tool, and what that declaration is
 * worth.
 *
 * Every field is optional and every field is a claim. `tier` is displayed as
 * extension-declared and never consulted by the gate; `idempotent` and
 * `openWorld` are carried into the row so a human reading it sees what the
 * author believed, which is the same service `tool-surface.ts`'s rows perform
 * for tools this repository wrote.
 */
export interface ExtensionDeclaredRisk {
  tier?: string;
  idempotent?: boolean;
  openWorld?: boolean;
}

export interface ExtensionToolResult {
  text: string;
  isError?: boolean;
  details?: Record<string, unknown>;
}

/**
 * A tool an extension registers.
 *
 * `execute` takes the model's arguments and returns text. It is deliberately
 * NOT a `ToolDefinition`: the host builds that, and the one it builds asks the
 * gate first. See this module's header.
 */
export interface ExtensionToolRegistration {
  name: string;
  description: string;
  /** A typebox schema. Omitted means a tool with no arguments. */
  parameters?: TSchema;
  execute: (args: Record<string, unknown>) => Promise<ExtensionToolResult> | ExtensionToolResult;
  risk?: ExtensionDeclaredRisk;
  /**
   * T156: this tool changes files. Its calls are then edits exactly as a
   * built-in's are — the post-edit loop runs after them, the gate grades the
   * session, and the edit counters count them. Declare nothing and each call
   * is still checked: the git working tree is compared before and after, and a
   * change counts the call as an edit. Outside a git repository an undeclared
   * tool's call cannot be checked and is not counted; the session says so once.
   */
  changesFiles?: boolean;
  /** Default `mounted`: a new tool's schema does not join every request of every session uninvited. */
  residency?: ToolResidency;
  /** Default `hidden`, for `residency`'s reason. */
  promptPresence?: PromptPresence;
  promptSnippet?: string;
}

/** A slash command an extension registers (D5). */
export interface ExtensionCommandRegistration {
  /** Without the leading slash. */
  name: string;
  description: string;
  /** Everything typed after the command word, already trimmed. */
  run: (args: string) => Promise<string> | string;
}

/**
 * A registered tool as a registry row — `ToolRegistryEntry`'s shape, plus who
 * declared it and the fact that its tier is a claim.
 *
 * Deriving from `ToolRegistryEntry` rather than restating its fields is
 * `security-scan.ts`'s move: one answer in this codebase to what a registry
 * row is, and a row that cannot drift from the table it is meant to join.
 */
export interface ExtensionToolRow extends ToolRegistryEntry {
  source: "extension";
  declaredBy: string;
  /**
   * True on every row here, and it is a field rather than a comment because it
   * is what a renderer branches on. `risk.tier` is what the extension said;
   * the gate uses `hard-write` for all of them.
   */
  tierIsExtensionDeclared: true;
}

/** The tier the gate actually applies to every extension tool, whatever the row says. */
export const EXTENSION_GATE_TIER: RiskTier = DEFAULT_RISK_TIER;

/**
 * How an extension-declared tier is rendered — D4's "displayed as
 * extension-declared wherever tiers are shown", written once so that every
 * place showing one shows the same sentence.
 */
export function describeExtensionTier(row: ExtensionToolRow): string {
  return (
    `${row.risk.tier} (declared by the extension "${row.declaredBy}", not verified by lykos; ` +
    `the gate treats every extension tool as ${EXTENSION_GATE_TIER})`
  );
}

/** One line per row, for `lykos doctor` and anything else that lists tools. */
export function renderExtensionToolRow(row: ExtensionToolRow): string {
  return `${row.name}  ${row.residency}/${row.promptPresence}  risk ${describeExtensionTier(row)}`;
}

/**
 * The note carried on a registered tool's own description, so the MODEL is
 * told too rather than only the human reading a doctor listing.
 */
export function extensionToolDescriptionNote(extension: string, declaredTier: RiskTier): string {
  return (
    ` (Registered by the lykos extension "${extension}". Its author declares this a ${declaredTier} tool; ` +
    `lykos does not verify that, and asks for approval as for any ${EXTENSION_GATE_TIER}.)`
  );
}

export class ExtensionRegistrationError extends Error {}

/**
 * D6: the registration point that exists and refuses.
 *
 * The message is the whole feature. It names what was attempted, says the
 * surface is designed for rather than built, and gives the reason — so an
 * author hits a sentence that tells them where the boundary is instead of a
 * missing method that tells them nothing.
 */
export const INTERFACE_REGISTRATION_REFUSAL =
  "lykos: registering an interface surface is not supported. The registration point exists so that " +
  "adding it later is additive rather than a new method every extension has to learn, and it refuses " +
  "today because an extension that can draw interface is an extension that can break a product surface. " +
  "Register a tool or a slash command instead; for anything this API does not cover, write a Pi " +
  "extension and lykos will load it.";

// ---------------------------------------------------------------------------
// T149: read-only child sessions and extension counters.
// ---------------------------------------------------------------------------

/** What an extension asks for when it runs a child session. */
export interface ChildSessionRequest {
  /** The whole of the child's input. It never sees the parent's transcript. */
  prompt: string;
  /** `provider/model`. Optional: if omitted, defaults to parent session's model. */
  model?: string;
  /** Shown in `lykos sessions` as the child's brief. */
  label?: string;
  /** T204: whether the child can write (e.g. test writer resolving a dispute). Defaults to false (read-only). */
  writable?: boolean;
  /** T204: specialist to run as (e.g. "test-writer"). */
  specialist?: string;
}

/**
 * What came back. `unavailable` means this session cannot run one — a child
 * session itself, or a surface that bound no runner — and is never an error
 * the extension caused.
 */
export type ChildSessionResult =
  | { status: "ok"; sessionId: string; model?: string | undefined; text: string }
  | { status: "blocked" | "error" | "unavailable"; model?: string | undefined; message: string };

/**
 * What the session owner hands the host once the session exists. A runner is
 * bound rather than passed at construction because the parent's session id —
 * which the child's ledger row points at — does not exist until boot returns.
 */
export interface ExtensionSessionBinding {
  /**
   * Run a child session for `extension`. Defaults to a read-only child
   * session (`BootConfig.readOnly`): no file-changing tool on the surface, a
   * gate that refuses every non-read action, and a block on any file-changing
   * call that still arrives. When `request.writable` is true, runs a writable
   * child gated as a spawned specialist under `request.specialist` (defaulting
   * to `test-writer`), inheriting the parent's read-only posture.
   */
  runChild(extension: string, request: ChildSessionRequest): Promise<ChildSessionResult>;
}

/** One counter an extension recorded, as the ledger's `extension_counters` stores it. */
export interface ExtensionCounterRow {
  extension: string;
  name: string;
  value: number;
}

/** A counter name: short, and safe to print as one `name=value` token. */
const COUNTER_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export const CHILD_SESSION_UNAVAILABLE =
  "lykos: this session cannot run a child session — it is itself a child, or its surface bound no runner";

/** T199: return value from a `tool_call` veto handler. */
export type ToolCallVetoResult =
  | { block: true; reason: string }
  | { block?: false; reason?: string; warning?: string }
  | void
  | undefined;

/** T199: payload presented to a `tool_call` veto handler. */
export interface ToolCallVetoEvent {
  toolName: string;
  input: Record<string, unknown>;
  readonly name?: string;
  readonly args?: Record<string, unknown>;
}

/** T199: handler function for `tool_call` veto. */
export type ToolCallVetoHandler = (
  event: ToolCallVetoEvent,
) => ToolCallVetoResult | Promise<ToolCallVetoResult>;

/** T201: return value from a gate check handler. */
export type GateCheckResult =
  | { pass: true; reason?: string }
  | { block: true; reason: string; paths?: string[]; detail?: string | Record<string, unknown> }
  | { pass?: false; reason: string }
  | void
  | undefined;

/** T201: context passed to a gate check handler. */
export interface GateCheckContext {
  sessionId: string;
  cwd: string;
  ledgerPath: string;
  commandOutcome?: GateOutcome | undefined;
  executor?: ProjectExecutor | undefined;
  edited?: boolean | undefined;
  editedFiles?: readonly string[] | undefined;
  startCommit?: string | undefined;
  specialist?: string | undefined;
}

/** T201: gate check handler function. */
export type GateCheckHandler = (
  ctx: GateCheckContext,
) => GateCheckResult | Promise<GateCheckResult>;

/** T201: gate check registration options. */
export interface ExtensionGateCheckRegistration {
  name?: string;
  check: GateCheckHandler;
}

/** What an extension's `register` is handed. Narrow on purpose: it can register, and nothing else. */
export interface LykosExtensionApi {
  readonly cwd?: string;
  readonly specialist?: string | undefined;
  /** Session ledger path, if known. */
  readonly ledgerPath?: string | undefined;
  /** T199: get current session ID if available. */
  getSessionId?(): string | undefined;
  /** Spec story 47: whether the session was started as delegated. */
  readonly delegated?: boolean | undefined;
  /** T199: register a block-only veto handler for tool_call. */
  on(event: "tool_call", handler: ToolCallVetoHandler): void;
  /**
   * T201: register a block-only gate check contribution.
   * Runs after the session gate's command. Returning a block turns success
   * into failure and records the reason in the ledger. A gate check can
   * never produce success.
   */
  registerGateCheck(check: ExtensionGateCheckRegistration | GateCheckHandler): void;
  /**
   * A handler may return a promise. `session_end` waits for it (a child
   * session takes time); every other event is fire-and-forget, and a
   * rejected promise is counted as a failure exactly like a throw.
   */
  on<E extends LykosEvent>(event: E, handler: (payload: LykosEventPayloads[E]) => unknown): void;
  registerTool(tool: ExtensionToolRegistration): void;
  registerCommand(command: ExtensionCommandRegistration): void;
  /** D6. Always throws `ExtensionRegistrationError`; see `INTERFACE_REGISTRATION_REFUSAL`. */
  registerInterface(surface: unknown): never;
  /**
   * T149/T204: run a child session with the given model and prompt, and get
   * its final text back. Defaults to read-only (it cannot change a file). When
   * `request.writable` is true, runs a writable child gated as a spawned
   * specialist under `request.specialist` (defaulting to `test-writer`),
   * inheriting the parent's read-only posture. The child is a real session with
   * its own ledger row (`parent_session_id` this session, `agent_role`
   * `specialist ?? extension:<name>`). Never throws; a failure is a result.
   */
  runChildSession(request: ChildSessionRequest): Promise<ChildSessionResult>;
  /**
   * T149: add `by` (default 1, a non-negative integer) to this extension's
   * counter `name` (lower_snake_case) for this session. Written to the
   * ledger's `extension_counters` under the extension's declared name when
   * the session ends, and printed by `lykos show`. A counter never recorded is
   * absent, never zero. Throws on a bad name or amount.
   */
  recordCounter(name: string, by?: number): void;
  /**
   * T162: a short report for the person at the end of this session, printed
   * right after the gate's verdict — in the terminal UI and in a standalone
   * run alike — under this extension's declared name. Reports print in the
   * order made; a session that ends with none prints nothing for this
   * extension. Keep it to a few lines: the full text belongs in the ledger or
   * the transcript, where `lykos show` reads it. Throws on empty text.
   */
  reportAtSessionEnd(text: string): void;
}

/** T162: one `reportAtSessionEnd` report, under the extension's declared name. */
export interface ExtensionSessionEndReport {
  extension: string;
  text: string;
}

/** T162: the lines a session prints for its extensions' reports, after the gate's verdict. */
export function renderSessionEndReports(reports: readonly ExtensionSessionEndReport[]): string | undefined {
  if (reports.length === 0) return undefined;
  return reports
    .map((r) => {
      const [first = "", ...rest] = r.text.replace(/\s+$/, "").split("\n");
      return [`${r.extension}: ${first}`, ...rest.map((l) => `  ${l}`)].join("\n");
    })
    .join("\n");
}

export interface LykosExtension {
  name: string;
  register: (api: LykosExtensionApi) => void;
}

// ---------------------------------------------------------------------------
// The host.
// ---------------------------------------------------------------------------

export interface LykosExtensionHostOpts {
  /** The project root, for the gate's sake. */
  cwd: string;
  /**
   * The session's gate. REQUIRED, and required at construction rather than at
   * the moment a tool is called: a host with no gate would be a host that
   * could build an ungated tool definition, and the point of D4 is that no
   * such definition can exist.
   */
  gate: ApprovalGate;
  denials?: DenialLog;
  specialist?: string | undefined;
  ledgerPath?: string | undefined;
  delegated?: boolean | undefined;
}

/**
 * The event bus, the registration surface and the failure ledger, one object
 * per session.
 *
 * Not module-level state. A second session in one process would otherwise
 * inherit the first one's handlers, and the counters would describe neither —
 * the same argument `tui/commands.ts` makes for the one piece of module state
 * this codebase does keep, read in the other direction.
 */
export class LykosExtensionHost {
  readonly counters: ExtensionCounters = newExtensionCounters();

  private readonly handlers = new Map<LykosEvent, Array<{ extension: string; run: (payload: never) => void }>>();
  private readonly toolCallVetoHandlers: Array<{ extension: string; run: ToolCallVetoHandler }> = [];
  private readonly gateCheckHandlers: Array<{ extension: string; name?: string; run: GateCheckHandler }> = [];
  private sessionIdValue: string | (() => string | undefined) | undefined;
  private readonly toolRows: ExtensionToolRow[] = [];
  private readonly toolDefs: ToolDefinition[] = [];
  private readonly commandList: Array<ExtensionCommandRegistration & { extension: string }> = [];
  /** T149: `extension -> name -> value`, in the order first recorded. */
  private readonly counterValues = new Map<string, Map<string, number>>();
  private binding: ExtensionSessionBinding | undefined;
  /** T162: `reportAtSessionEnd` reports, in the order made. */
  private readonly endReports: ExtensionSessionEndReport[] = [];

  private specialistValue: string | (() => string | undefined) | undefined;

  constructor(private readonly opts: LykosExtensionHostOpts) {}

  setSessionId(id: string | (() => string | undefined)): void {
    this.sessionIdValue = id;
  }

  getSessionId(): string | undefined {
    const val = typeof this.sessionIdValue === "function" ? this.sessionIdValue() : this.sessionIdValue;
    return val && val.length > 0 ? val : undefined;
  }

  setSpecialist(specialist: string | (() => string | undefined)): void {
    this.specialistValue = specialist;
  }

  getSpecialist(): string | undefined {
    return (
      (typeof this.specialistValue === "function" ? this.specialistValue() : this.specialistValue) ??
      this.opts.specialist
    );
  }

  /**
   * T199: run tool_call veto handlers in registration order.
   * A handler can return `{ block: true, reason }` to refuse the call,
   * or `{ block: false, warning }` to attach a warning to the result.
   */
  async runToolCallVeto(
    toolName: string,
    input: unknown,
  ): Promise<{ block: true; reason: string; warning?: string } | { block?: false; warning?: string } | undefined> {
    if (this.toolCallVetoHandlers.length === 0) return undefined;
    const inputObj =
      input !== null && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const event: ToolCallVetoEvent = {
      toolName,
      input: inputObj,
      get name() {
        return toolName;
      },
      get args() {
        return inputObj;
      },
    };
    let combinedWarning: string | undefined;
    for (const entry of this.toolCallVetoHandlers) {
      try {
        const result = await entry.run(event);
        this.counters.deliveries += 1;
        if (result && result.block === true) {
          return { block: true, reason: result.reason ?? "Blocked by extension" };
        }
        if (result && result.warning) {
          combinedWarning = combinedWarning ? `${combinedWarning}\n${result.warning}` : result.warning;
        }
      } catch (err) {
        this.recordFailure(entry.extension, "tool_call", err);
      }
    }
    return combinedWarning ? { block: false, warning: combinedWarning } : undefined;
  }

  /** T201: whether any extension registered a gate check. */
  get hasGateChecks(): boolean {
    return this.gateCheckHandlers.length > 0;
  }

  /**
   * T201: run registered gate checks.
   * Checks execute in registration order. A check returns pass or block with a reason.
   * If any check blocks or throws, the combined result has pass = false.
   */
  async runGateChecks(ctx: GateCheckContext): Promise<{
    pass: boolean;
    blockReason?: string;
    failedChecks: Array<{ extension: string; reason: string }>;
  }> {
    const failedChecks: Array<{ extension: string; reason: string }> = [];
    for (const entry of this.gateCheckHandlers) {
      try {
        const result = await entry.run(ctx);
        this.counters.deliveries += 1;
        if (result) {
          const isBlocked = "block" in result ? result.block : result.pass === false;
          if (isBlocked) {
            const reason = result.reason || "blocked by gate check";
            failedChecks.push({ extension: entry.extension, reason });
          }
        }
      } catch (err) {
        this.recordFailure(entry.extension, "gate_check", err);
        failedChecks.push({
          extension: entry.extension,
          reason: `gate check threw: ${(err as Error).message}`,
        });
      }
    }
    return {
      pass: failedChecks.length === 0,
      ...(failedChecks.length > 0 ? { blockReason: failedChecks[0]!.reason } : {}),
      failedChecks,
    };
  }

  /** T149: the session owner binds the child-session runner once the session exists. */
  bindSession(binding: ExtensionSessionBinding): void {
    this.binding = binding;
  }

  /**
   * Run one extension's `register`. A registration that throws — including
   * D6's interface refusal — is recorded and counted, and the session carries
   * on with whatever that extension managed to register first.
   */
  install(extension: LykosExtension): void {
    const api = this.apiFor(extension.name);
    try {
      extension.register(api);
    } catch (err) {
      this.recordFailure(extension.name, "install", err);
    }
  }

  private apiFor(name: string): LykosExtensionApi {
    const self = this;
    return {
      cwd: this.opts.cwd,
      ledgerPath: this.opts.ledgerPath,
      get delegated() {
        return self.opts.delegated;
      },
      get specialist() {
        return self.getSpecialist();
      },
      getSessionId: () => this.getSessionId(),
      on: ((event: string, handler: any) => {
        if (event === "tool_call") {
          this.toolCallVetoHandlers.push({
            extension: name,
            run: handler as ToolCallVetoHandler,
          });
          return;
        }
        const list = this.handlers.get(event as LykosEvent) ?? [];
        list.push({ extension: name, run: handler as (payload: never) => void });
        this.handlers.set(event as LykosEvent, list);
      }) as LykosExtensionApi["on"],
      registerGateCheck: (check) => {
        const handler = typeof check === "function" ? check : check.check;
        const checkName = typeof check === "function" ? undefined : check.name;
        this.gateCheckHandlers.push({
          extension: name,
          ...(checkName !== undefined ? { name: checkName } : {}),
          run: handler,
        });
      },
      registerTool: (tool) => this.addTool(name, tool),
      registerCommand: (command) => this.addCommand(name, command),
      registerInterface: () => {
        this.counters.interfaceRefusals += 1;
        throw new ExtensionRegistrationError(INTERFACE_REGISTRATION_REFUSAL);
      },
      runChildSession: (request) => this.runChild(name, request),
      recordCounter: (counter, by) => this.addCounter(name, counter, by),
      reportAtSessionEnd: (text) => {
        if (typeof text !== "string" || text.trim().length === 0) {
          throw new ExtensionRegistrationError("lykos: reportAtSessionEnd needs non-empty text");
        }
        this.endReports.push({ extension: name, text: text.trim() });
      },
    };
  }

  /** T162: every report made through `reportAtSessionEnd`, in order. */
  sessionEndReports(): ExtensionSessionEndReport[] {
    return [...this.endReports];
  }

  /**
   * T149: a child session for `extension`. Never throws: a runner that throws
   * is the child failing, counted against the extension that asked (site
   * `child_session`) and returned as an `error` result it can read.
   */
  private async runChild(extension: string, request: ChildSessionRequest): Promise<ChildSessionResult> {
    const model = request.model ?? "";
    if (this.binding === undefined) return { status: "unavailable", model, message: CHILD_SESSION_UNAVAILABLE };
    try {
      return await this.binding.runChild(extension, request);
    } catch (err) {
      this.recordFailure(extension, "child_session", err);
      return { status: "error", model, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private addCounter(extension: string, name: string, by: number = 1): void {
    if (!COUNTER_NAME.test(name)) {
      throw new ExtensionRegistrationError(
        `lykos: counter name "${name}" is not lower_snake_case (a letter, then letters, digits or _; at most 64)`,
      );
    }
    if (!Number.isInteger(by) || by < 0) {
      throw new ExtensionRegistrationError(`lykos: counter ${name} must grow by a non-negative integer, got ${String(by)}`);
    }
    const mine = this.counterValues.get(extension) ?? new Map<string, number>();
    mine.set(name, (mine.get(name) ?? 0) + by);
    this.counterValues.set(extension, mine);
  }

  /** T149: every counter an extension recorded this session, for the ledger. */
  extensionCounters(): ExtensionCounterRow[] {
    const rows: ExtensionCounterRow[] = [];
    for (const [extension, mine] of this.counterValues) {
      for (const [name, value] of mine) rows.push({ extension, name, value });
    }
    return rows;
  }

  /**
   * D3, and the half the old hook surface got wrong: the failure is recorded
   * BEFORE the loop continues, and the loop continues.
   *
   * Handlers are called in registration order and one throwing handler does
   * not stop the ones behind it — an extension's failure is its own, and
   * letting it silence the next extension's policy would make the second
   * author's bug report unanswerable.
   */
  emit<E extends LykosEvent>(event: E, payload: LykosEventPayloads[E]): void {
    const list = this.handlers.get(event);
    if (list === undefined) return;
    for (const entry of list) {
      try {
        const returned = (entry.run as (p: LykosEventPayloads[E]) => unknown)(payload);
        this.counters.deliveries += 1;
        // A handler that returned a promise is not awaited here — the firing
        // sites are synchronous — but its rejection is still this extension's
        // failure, counted rather than left as an unhandled rejection.
        if (returned instanceof Promise) {
          returned.catch((err: unknown) => this.recordFailure(entry.extension, event, err));
        }
      } catch (err) {
        this.recordFailure(entry.extension, event, err);
      }
    }
  }

  /**
   * T149: `emit`, awaiting each handler in registration order. Used for
   * `session_end`, where a handler runs a child session and the process must
   * not move on (or exit) under it. A handler that throws or rejects is
   * counted and the next one still runs.
   */
  async emitAndWait<E extends LykosEvent>(event: E, payload: LykosEventPayloads[E]): Promise<void> {
    const list = this.handlers.get(event);
    if (list === undefined) return;
    for (const entry of list) {
      try {
        await (entry.run as (p: LykosEventPayloads[E]) => unknown)(payload);
        this.counters.deliveries += 1;
      } catch (err) {
        this.recordFailure(entry.extension, event, err);
      }
    }
  }

  /** The narrow handle a firing site takes. `emit` and nothing else. */
  get sink(): LykosEventSink {
    return { emit: (event, payload) => this.emit(event, payload) };
  }

  /** Registered handler counts, for `lykos doctor` and for tests. */
  listenerCount(event: LykosEvent | "tool_call"): number {
    if (event === "tool_call") {
      return this.toolCallVetoHandlers.length;
    }
    return this.handlers.get(event)?.length ?? 0;
  }

  /**
   * T147 (D25): a declared extension that never reached `install` — its
   * package has no entry, its module threw on import, or its export is not an
   * extension. Counted and logged exactly like a throwing handler, so one
   * broken package is reported at the end of the session and the session
   * carries on without it.
   */
  recordLoadFailure(extension: string, err: unknown): void {
    this.recordFailure(extension, "load", err);
  }

  private recordFailure(extension: string, site: ExtensionFailureSite, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.counters.failures += 1;
    this.counters.failuresByExtension[extension] = (this.counters.failuresByExtension[extension] ?? 0) + 1;
    this.counters.log.push({ extension, site, message });
    if (this.counters.log.length > EXTENSION_FAILURE_LOG_CAP) this.counters.log.shift();
  }

  // -------------------------------------------------------------------------
  // D4: tools.
  // -------------------------------------------------------------------------

  private addTool(extension: string, reg: ExtensionToolRegistration): void {
    const name = reg.name.trim();
    if (name.length === 0) throw new ExtensionRegistrationError("lykos: an extension tool needs a name");
    if (this.toolRows.some((r) => r.name === name)) {
      throw new ExtensionRegistrationError(
        `lykos: a tool named "${name}" is already registered by an extension — two tools under one name is a load-order decision nobody made`,
      );
    }
    const declaredTier = reg.risk?.tier;
    const tier: RiskTier =
      declaredTier !== undefined && isRiskTier(declaredTier) ? declaredTier : DEFAULT_RISK_TIER;
    const row: ExtensionToolRow = {
      name,
      residency: reg.residency ?? "mounted",
      promptPresence: reg.promptPresence ?? "hidden",
      rationale: `Registered by the lykos extension "${extension}".`,
      risk: {
        tier,
        idempotent: reg.risk?.idempotent ?? false,
        openWorld: reg.risk?.openWorld ?? true,
      },
      source: "extension",
      declaredBy: extension,
      tierIsExtensionDeclared: true,
    };
    this.toolRows.push(row);
    this.toolDefs.push(this.buildGatedDefinition(extension, reg, tier));
    this.counters.tools += 1;
  }

  /**
   * The only place an extension's `execute` is turned into something the
   * runtime will call — and it asks the gate first, every time.
   *
   * There is no `if` here deciding whether to ask: a declared `read` tier does
   * not skip the call, because the declaration is the extension's and the
   * point of D4 is that it is not believed. A refusal comes back as an error
   * tool result, which is what every other gated tool in this codebase does,
   * so the turn survives and the model is told why.
   */
  private buildGatedDefinition(
    extension: string,
    reg: ExtensionToolRegistration,
    declaredTier: RiskTier,
  ): ToolDefinition {
    const { cwd, gate, denials } = this.opts;
    const host = this;
    return defineTool({
      name: reg.name.trim(),
      label: reg.name.trim(),
      description: `${reg.description}${extensionToolDescriptionNote(extension, declaredTier)}`,
      ...(reg.promptSnippet !== undefined ? { promptSnippet: reg.promptSnippet } : {}),
      parameters: reg.parameters ?? Type.Object({}),
      async execute(_toolCallId: string, params: unknown) {
        const args = (params ?? {}) as Record<string, unknown>;
        const req = buildExtensionRequest(reg.name, extension, JSON.stringify(args, null, 2));
        try {
          await authorizeExtensionTool(
            cwd,
            gate,
            req.summary,
            req.detail,
            req.body ?? "",
            denials,
          );
        } catch (err) {
          if (err instanceof ApprovalDeniedError) {
            return {
              content: [{ type: "text" as const, text: err.message }],
              isError: true as const,
              details: { error: err.message },
            };
          }
          throw err;
        }
        try {
          // T156: an undeclared tool is judged by what it did to the tree.
          const before = reg.changesFiles === true ? undefined : host.treeBefore(reg.name.trim(), extension);
          const result = await reg.execute(args);
          const changed =
            reg.changesFiles === true
              ? result.isError !== true
              : before !== undefined && workingTreeFingerprint({ cwd }) !== before;
          return {
            content: [{ type: "text" as const, text: result.text }],
            ...(result.isError === true ? { isError: true as const } : {}),
            details: { ...(result.details ?? {}), ...(changed ? { [FILES_CHANGED_DETAIL]: true } : {}) } as Record<string, unknown>,
          };
        } catch (err) {
          // D3 again, on the call path rather than the event path: a tool that
          // throws is the extension failing, counted like any other failure,
          // and reported to the model as a tool error rather than taken as a
          // crash of the session.
          host.recordFailure(extension, "install", err);
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [
              {
                type: "text" as const,
                text: `lykos: the extension tool ${reg.name.trim()} (from "${extension}") threw: ${message}`,
              },
            ],
            isError: true as const,
            details: { error: message },
          };
        }
      },
    }) as ToolDefinition;
  }

  /**
   * T156: the working tree before an undeclared extension tool runs, or
   * undefined when it cannot be read — outside a git repository, where the
   * call is not counted and the session is told why, once.
   */
  treeBefore(tool: string, extension: string): string | undefined {
    const fingerprint = workingTreeFingerprint({ cwd: this.opts.cwd });
    if (fingerprint === undefined && !this.noGitNoticeGiven) {
      this.noGitNoticeGiven = true;
      stderrWrite(
        `lykos: the extension tool ${tool} (from "${extension}") does not declare changesFiles, and ${this.opts.cwd} ` +
          "is not a git repository, so a file it changes cannot be detected: its calls are not counted as edits. " +
          "Declare changesFiles on the tool to count them.\n",
      );
    }
    return fingerprint;
  }

  private noGitNoticeGiven = false;

  /** T156: is `name` a tool one of this session's Lykos extensions registered? */
  hasTool(name: string): boolean {
    return this.toolRows.some((r) => r.name === name);
  }

  /** The registry rows an extension added. `TOOL_REGISTRY` is unchanged; this is the runtime half. */
  toolRegistryRows(): readonly ExtensionToolRow[] {
    return this.toolRows;
  }

  /** The gated definitions, for `loadTools()` to pass to `createAgentSession` as custom tools. */
  toolDefinitions(): readonly ToolDefinition[] {
    return this.toolDefs;
  }

  // -------------------------------------------------------------------------
  // D5: slash commands.
  // -------------------------------------------------------------------------

  private addCommand(extension: string, reg: ExtensionCommandRegistration): void {
    const name = reg.name.trim().replace(/^\//, "").toLowerCase();
    if (name.length === 0) throw new ExtensionRegistrationError("lykos: an extension command needs a name");
    if (this.commandList.some((c) => c.name === name)) {
      throw new ExtensionRegistrationError(
        `lykos: a command named "/${name}" is already registered by an extension`,
      );
    }
    this.commandList.push({ ...reg, name, extension });
    this.counters.commands += 1;
  }

  /** What the completion popup and `/help` are told. Names carry no slash; the command surface adds it. */
  commands(): ReadonlyArray<{ name: string; description: string; extension: string }> {
    return this.commandList.map((c) => ({ name: c.name, description: c.description, extension: c.extension }));
  }

  hasCommand(name: string): boolean {
    return this.commandList.some((c) => c.name === name.trim().replace(/^\//, "").toLowerCase());
  }

  /**
   * Run one. A command that throws is counted like any other failure and the
   * session is told what happened — it is a person typing a slash command, so
   * silence would leave them staring at a prompt that did nothing.
   */
  async runCommand(name: string, args: string): Promise<string> {
    const key = name.trim().replace(/^\//, "").toLowerCase();
    const command = this.commandList.find((c) => c.name === key);
    if (command === undefined) {
      const known = this.commandList.map((c) => `/${c.name}`);
      return (
        `lykos: no extension command /${key}. ` +
        (known.length === 0 ? "No extension has registered one." : `What exists: ${known.join(", ")}.`)
      );
    }
    try {
      return await command.run(args);
    } catch (err) {
      this.recordFailure(command.extension, "command", err);
      const message = err instanceof Error ? err.message : String(err);
      return `lykos: /${key} (from the extension "${command.extension}") threw: ${message}`;
    }
  }
}

// ---------------------------------------------------------------------------
// The approval event, which is the one that is wired rather than called.
// ---------------------------------------------------------------------------

/**
 * D2 for `approval_decided`, and the one firing site that is a decorator
 * rather than a line inside the function that computes the payload.
 *
 * The decision is `gate.request()`'s return value, so this wrapper IS where it
 * is computed — there is nothing recomputed here and nothing guessed. It is
 * written this way rather than as an `events` parameter threaded through
 * `authorize()` because `authorize()` is reached from nine exported wrappers
 * and every tool module that calls one of them; a sink threaded through all of
 * those would be a sink somebody forgets to pass, and a gate wrapped once at
 * boot cannot be.
 *
 * **What it does NOT see, and this is a real gap rather than a detail.** The
 * scope clamp refuses a path outside the project root BEFORE `gate.request()`
 * is called, so an out-of-root refusal fires no event. That refusal is not a
 * decision anybody made — it is a boundary — and `DenialLog` is where it is
 * already counted.
 */
export function gateWithExtensionEvents(gate: ApprovalGate, sink: LykosEventSink): ApprovalGate {
  return {
    async request(req: ApprovalRequest): Promise<ApprovalDecision> {
      const decision = await gate.request(req);
      sink.emit("approval_decided", {
        kind: req.kind,
        decision,
        summary: req.summary,
        detail: req.detail,
        ...(req.shell !== undefined ? { shell: req.shell } : {}),
      });
      return decision;
    },
    inner: gate,
    // T161: a wrapped gate keeps the reason its refusal carries.
    ...(gate.denialReason !== undefined ? { denialReason: (req: ApprovalRequest) => gate.denialReason?.(req) } : {}),
    ...(gate.refuses !== undefined ? { refuses: (req: ApprovalRequest) => gate.refuses?.(req) ?? false } : {}),
    ...(gate.pathRules !== undefined ? { pathRules: gate.pathRules } : {}),
    ...(gate.pathContext !== undefined ? { pathContext: gate.pathContext } : {}),
    ...((gate as any).mode !== undefined ? { mode: (gate as any).mode } : {}),
    ...((gate as any).denied !== undefined ? { denied: (gate as any).denied } : {}),
    ...(typeof (gate as any).refresh === "function" ? { refresh: () => (gate as any).refresh() } : {}),
  };
}
