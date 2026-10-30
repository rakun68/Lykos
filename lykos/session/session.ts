// The loop, owned: one-shot, in-process, same result by a different path.
// D3.1's first half: `runStandaloneTask()` runs a task through
// `createAgentSession` in Lykos's own process instead of through the retired
// delegate container. This is the one engine now (ADR-0036); `lykos run` and
// `lykos mcp` both start it.
//
// T30's finding (docs/16-standalone-execution-shape.md, outcome 1) is what
// makes this file possible: `createAgentSession` exposes the identical
// `appendSystemPromptOverride`/`agentsFilesOverride` hooks, plus cache-split
// usage and richer tool-call events. This module calls the SDK directly and reads `AgentSessionEvent`s off
// `session.subscribe()`.
//
// Session assembly lives in `session/boot.ts` behind `boot(config)`. This
// file holds the session: usage accounting, the snapshot, live capture's
// caller, and the one-shot driver. The interactive loop is
// `session/interactive.ts`. Both call `boot`; neither reads feature flags.
//
// T34 (docs/15-phase3-tasks.md) added the approval gate: every write, edit,
// and bash command from a session booted here goes through
// `tools/`'s `buildGatedTools()`, never Pi's raw local
// implementations. `boot()`/`subscribeStandaloneUsage()`/
// `buildStandaloneSnapshot()` are the shared boot-and-accounting
// pieces `runStandaloneTask` (one-shot) and `session/interactive.ts`
// (T34.1's multi-turn loop) both build on, so the two paths cannot drift on
// how a session is booted or how its usage is turned into a ledger row.
//
// Deliberately out of scope when this file was written (T33): T19's
// snip→prune compaction reordering and T21.2's live tool-result byte cap,
// both container-only at the time.
//
// T84 (Phase 15) closed the second half: the live tool-result cap now runs
// on this path too, through `loop/harness-extension.ts` registered by boot
// as an inline `extensionFactories` entry on the resource loader. It adds
// no tool schema and no package. T19's compaction reordering stays
// container-only; its unwired host copy was deleted in P4 T150 (backlog X1),
// and the host's answer to a full context is the context strategy
// (`loop/context-strategy.ts`).

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { computeHitQuality, type HitQualityToolCall } from "./hit-quality.js";
import { type ModelRuntime, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createLykosModelRuntime, forwardRotationsToSink, RotationRelay, type Provider } from "./model-runtime.js";
import { formatAuthenticationFailure } from "../credentials/auth-failure.js";
import { servedCredentialFor } from "../credentials/rotate.js";
import {
  hasOpenItems,
  readTaskListFile,
  resumeTaskListState,
  type PeerMailbox,
} from "../tools.js";
import { ensureParentSessionForSpawn } from "../tools/spawn.js";
import { isFileChangingCall } from "../tools/tool-call.js";
import {
  renderGateOutcome,
  resolveGatePolicy,
  runSessionGate,
  verdictEventOf,
  type GateOutcome,
} from "../gate/verify-gate.js";
import { sessionChangedPaths, sessionDiffSummary } from "../loop/diff-summary.js";
import { renderTaskList } from "../tools/task-list.js";
import type { GitState } from "../git/host-git.js";
import type { ProjectExecutor } from "../tools/executor.js";
import { startContainment, type Containment, type ContainmentRecord } from "../containment/containment.js";
import { modeWrites, type InteractionMode } from "../gate/modes.js";
import { resolveContainmentRequest, type ContainmentFloor } from "../containment/request.js";
import type { ContainerRuntimeDriver } from "../containment/runtime.js";
import { loadConfig } from "../config/load.js";
import {
  projectPiPackages,
  skippedLabel,
  withoutUntrustedProjectCommands,
  withoutUntrustedProjectContainmentLowering,
  withoutUntrustedProjectExtensions,
  withoutUntrustedProjectGateDiscovery,
  withoutUntrustedProjectHostCommands,
} from "../config/project-extensions.js";
import { isStoreTrusted, isWorkspaceTrusted } from "../gate/trust.js";
import { collectPathRules } from "../gate/path-rules.js";
import type { ResolvedConfig } from "../config/types.js";
import {
  builtinProviderDecls,
  cacheModelsPath,
  generateProviderConfig,
  specialistModelSpec,
  resolveBootModel,
  validateDelegateModel,
  ENV_SOURCE,
  PROVIDER_ENV_VARS,
  type ProvidersConfig,
  type SessionModelSource,
} from "../config/providers.js";
import { assertHostProviderUsable, assertSpecialistProviderUsable } from "../config/specialist-credentials.js";
import { DEFAULT_SPECIALIST } from "../config/specialists.js";
import { defaultLedgerPath, openLedger } from "../ledger/use.js";
import { gitStatus, resolveProject } from "./identity.js";
import { guardToolCall, recordBudgetTrip, type BudgetVerdict } from "../ledger/budget.js";
import {
  ingestDelegateSnapshot,
  parseProviderModel,
  type DelegateSnapshot,
  type DelegateToolCall,
  type DelegateUsageCall,
} from "../ledger/ingest.js";
import { AutoApproveGate, DenyAllGate, projectIdForCwd, ReadOnlyGate, resolvePathRulesAndContext, unwrapGate, type ApprovalGate } from "../gate/approval.js";
import { canSealAllowanceEverAllow, createSealTestCommandAllowance, DelegatedGate, getAllowedPatterns, getGateVerifyCommand, SubagentGate, wrapApprovalGateWithSealAllowance, type DeniedAction } from "../gate/delegated.js";
import { loadPermissions } from "../gate/permissions.js";
import type { ApprovalMetrics } from "../gate/approval-metrics.js";
import type { Coordinator } from "../tools/coordinator.js";
import type { BootArtifacts } from "./head-contract.js";
import { contextFileMeta, toolResultMaxBytesFromEnv } from "../loop/prompt-diet.js";
import {
  endedOnExhaustedRetry,
  newRetryObservation,
  observeRetryEvent,
  type RetryEventLike,
  type RetryObservation,
} from "../loop/retry-observer.js";
import {
  decideFallback,
  newFallbackState,
  recordSwitch,
  resolveFallbackPolicy,
  serializeFallbacks,
} from "../loop/fallback.js";
import { HANDOFF_USAGE_ENTRY_TYPE } from "../loop/self-compact.js";
import { CompactionLatencyTracker, LatencyTracker } from "../loop/latency.js";
import { stderrWrite } from "../tui/io-mode.js";
import { extensionFailureNotice, renderSessionEndReports, type ChildSessionResult, type SessionEndEvent } from "../extensions/api.js";
import { readSessionMeta, transcriptDir, writeSessionMeta } from "./transcript.js";
import { buildContinuationPrompt, decideContinuation, type ContinuationPlan } from "../loop/continuation.js";
import { listCheckpoints } from "../loop/checkpoint.js";
import {
  boot,
  startLiveCapture,
  type BootDeps,
  type BootedStandaloneSession,
} from "../session.js";
import type { SpecialistContext, SpecialistFields } from "./specialist-apply.js";
import type { ResumePlan } from "./interactive.js";

export {
  boot,
  startLiveCapture,
  buildAppendSystemPromptOverride,
  contextWindowOf,
  type BootedStandaloneSession,
} from "../session.js";

export interface RunStandaloneTaskInput {
  /** The project directory this task runs against. */
  workspace: string;
  prompt: string;
  /** `provider/model`, e.g. `deepseek/deepseek-v4-flash`. Default: T20's documented default (parseProviderModel(undefined)). */
  model?: string;
  /** Caller override. Default: T20's documented hop-0 surface, same as `runTask()`. */
  tools?: string[];
  /** Shown in `sessions`/`status`; becomes the session's `brief`. */
  label?: string;
  /** Override for the ledger path — tests only; production uses the workspace default. */
  ledgerPath?: string;
  /** `--budget <usd>` — same per-invocation override `cli/run.ts` threads to the container path via LYKOS_BUDGET_PER_RUN_USD; here it goes straight into loadConfig()'s flags layer since there is no child process to pass an env var to. */
  budgetPerRunUsd?: string;
  /**
   * T34.2: `--yes` — every gated write/edit/bash call is allowed with no
   * prompt. Default false: a one-shot run with no TTY to prompt on refuses
   * every gated action rather than hanging or silently allowing it.
   */
  autoApprove?: boolean;
  /**
   * T39: include the Lykos-owned `Agent` tool (recursive `runStandaloneTask`).
   * Ignored when `tools` is set explicitly — pass `Agent` in that list instead.
   * Children never get this (see `allowSpawn` on SpawnContext).
   */
  subagents?: boolean;
  /** T39.1: when set, this run IS a Lykos-spawned child of that session. */
  parentSessionId?: string;
  /**
   * P10.5 (ticket 17, D2): the seat on the spawning family's peer bus, handed
   * over by the `Agent` call that created this run. Absent on a run nobody
   * spawned, which mints a family of one instead.
   */
  mailbox?: PeerMailbox;
  taskId?: string;
  projectId?: string;
  agentRole?: string;
  /** Defaults to `standalone`; children pass `subagent`. */
  executionShape?: "standalone" | "subagent";
  /** T117: trust source established by the CLI gate. */
  trustSource?: "stored" | "flag" | "prompt";
  /** T109: internal successor-session state; absent on the root run. */
  continuation?: ContinuationPlan;
  /**
   * P4 T152: continue an earlier session the way `lykos resume` does — same
   * id, same task, the replay appended after the head, an unfinished
   * self-compact handoff carried across — then run `prompt` as its next
   * message. `lykos resume` itself is interactive; this is the one-shot
   * shape of the same continuation, which the scripted-model seam drives
   * through `runResume`'s `launch`.
   */
  resume?: ResumePlan;
  /**
   * Specialists ticket 01: `--specialist <name>`, resolved into config's sixth
   * layer via `loadConfig()`. A name that does not exist in either location
   * returns `status: "error"` rather than throwing — same shape as a budget
   * trip or a bad model spec below.
   */
  specialist?: string | undefined;
  /** T217: `--output-style <name>`. */
  outputStyle?: string;
  /** Specialists band 2 ticket 04: resolved specialist fields for the child. */
  specialistFields?: SpecialistFields;
  /** Specialists ticket 04: explicit context for applySpecialist ('session-start' | 'subagent'). */
  specialistContext?: SpecialistContext;
  /**
   * T180, T219: this is a delegated session (`lykos run`, as opposed to `--interactive`): the same session, and containment
   * defaults to `off` when no config layer names a level.
   */
  delegated?: boolean;
  /** T180: `--containment`, the caller's choice. It is the highest layer, above the specialist and config, and under the floor. */
  containmentLevel?: "off" | "auto" | "required";
  /** T180: `--network`. */
  containmentNetwork?: "open" | "none";
  /** Explicit gate for testing or child sessions. */
  gate?: ApprovalGate;
  approvalGate?: ApprovalGate;
  /** Denied actions collection for delegated sessions. */
  denied?: DeniedAction[];
  /** Override for process.env — tests only. */
  env?: NodeJS.ProcessEnv;
  /** Override for pool sizes — tests only. */
  poolSizes?: Map<string, number>;
  /** Override dependencies (e.g. createSession) — tests only. */
  bootDeps?: BootDeps;
  /** Specialists ticket 05: model source for child or session. */
  modelSource?: SessionModelSource;
  /**
   * Native providers registered on this run's model runtime — tests only. The
   * scripted-model session (P4 T142, `cli/scripted-session.ts`) passes
   * Pi's own faux provider here so a real session runs at no model cost.
   */
  nativeProviders?: readonly Provider[];
  /**
   * P4 T149: run as a READ-ONLY child (`BootConfig.readOnly`) — what an
   * extension's `runChildSession` asks for. T181: a top-level session may be read-only too, which is how
   * an MCP `lykos_review` call runs; every layer (tool list, gate, harness, no tools_add) applies the same.
   */
  readOnly?: boolean;
  /** T224: coordinator channel for delegated sessions (ask_coordinator and give_up). */
  coordinator?: Coordinator;
  /**
   * T184: the interaction mode a delegated session was asked to run in (spec #22 story 49). It is the one input that
   * decides whether the session writes: `manual` and `auto` write, `plan` and `ask` are read-only (the read-only
   * gate and a read-only mount). `auto` approves its writes without a prompt, since a delegated session has nobody to
   * ask: the worktree and branch (or the caller's opt-in to write in place) are what bound it. Absent, the session
   * behaves as before: `autoApprove` and `readOnly` decide.
   */
  interactionMode?: InteractionMode;
  /**
   * T184: the id a new session is given, when the caller made something that carries it before the session exists
   * (the branch of its worktree). Ignored on a successor session and when resuming.
   */
  sessionId?: string;
  /**
   * T184: the worktree this session's tools and commands work in (made by the caller, who removes it after the call).
   * `workspace` stays the project's root, which is where config, the ledger and the project's identity live.
   */
  workTree?: WorkTree;
  /**
   * T172: where this session's project commands run. Absent means this
   * machine. A child session is handed its parent's, so a subagent's commands
   * run where the parent's do.
   */
  executor?: ProjectExecutor;
  /**
   * T182: what the handed `executor` asked of containment and got, for a child that shares its parent's
   * container. The child's own ledger row records it, since the child starts nothing of its own.
   */
  containmentRecord?: ContainmentRecord;
  /** T182: who passed `containmentLevel` to a child, named when the floor refuses it. Default `--containment`. */
  containmentAskedFrom?: string;
  /**
   * T173: the container runtimes to consider when `containment.level` asks for
   * one — tests only. Absent means Podman and Docker as installed on this
   * machine. Ignored when `executor` is given. A child that is given none of its own inherits its
   * parent's (T182).
   */
  containmentDrivers?: readonly ContainerRuntimeDriver[];
}

/** A worktree a session works in. `path` is where its files are; the other two let a container's git read it. */
export interface WorkTree {
  path: string;
  commonDir: string;
  gitDir: string;
}

export type RunStandaloneTaskResult =
  | { status: "ok"; sessionId: string; text: string | undefined; snapshot: DelegateSnapshot; containment?: ContainmentRecord; skippedExtensions?: string[]; denied?: DeniedAction[] }
  | { status: "blocked"; reason: string; skippedExtensions?: string[] }
  /** `sessionId` is present when the session got far enough to have a ledger row and a transcript. */
  | { status: "error"; message: string; sessionId?: string; containment?: ContainmentRecord; skippedExtensions?: string[]; denied?: DeniedAction[] };

export function isAuthenticationError(err: unknown): boolean {
  if (!err) return false;
  const status = (err as { status?: number; statusCode?: number }).status ?? (err as { statusCode?: number }).statusCode;
  const msg = err instanceof Error ? err.message : String(err);
  if (/no authentication|not configured|not available|missing (?:api|credential)|unconfigured/i.test(msg)) {
    return false;
  }
  if (status === 403 || /forbidden|access denied/i.test(msg)) {
    return false;
  }
  if (status === 401) return true;
  return /\b401\b|unauthorized|invalid[_\s-]?api[_\s-]?key|incorrect[_\s-]?api[_\s-]?key|invalid[_\s-]?token|authentication[_\s-]?(?:failed|error)|credential[_\s-]?(?:refused|rejected)/i.test(msg);
}

export { formatAuthenticationFailure } from "../credentials/auth-failure.js";

export function resolveProviderEnvVar(
  provider: string,
  providers?: ProvidersConfig,
  modelRuntime?: ModelRuntime,
): string {
  const decl = providers?.[provider];
  if (decl?.source && ENV_SOURCE.test(decl.source)) {
    return decl.source.replace(/^\$\{?/, "").replace(/\}$/, "");
  }
  if (modelRuntime && typeof modelRuntime.getProviderAuthStatus === "function") {
    try {
      const status = modelRuntime.getProviderAuthStatus(provider);
      if (status && status.configured && status.label) {
        return status.label;
      }
    } catch {
      // ignore
    }
  }
  const known = PROVIDER_ENV_VARS[provider];
  if (known && known.length > 0) {
    return known.join(" / ");
  }
  return "credential env var";
}

/**
 * Resolve a `provider/model` spec against the SDK's own model registry.
 * Never falls back to "first available" — an unresolved model is an error,
 * not a silent, possibly-unpriced substitution (CLAUDE.md's provider-pricing
 * trap).
 */
export async function resolveHostModel(spec: string | undefined, modelRuntime: ModelRuntime) {
  // `getProvider` and `getModel` read an in-memory registry. They do not reach a
  // provider, so a credential rejection cannot arrive here and this function does
  // not pretend one can: the authentication wording belongs at the first call that
  // actually reaches the provider, which is the catch around `session.prompt` in
  // `runStandaloneTask`. What this function answers is a different question —
  // whether the spec names something that exists.
  const ref = parseProviderModel(spec);
  const provider = modelRuntime.getProvider(ref.provider);
  if (!provider) {
    let available: string[] = [];
    try {
      available = modelRuntime.getProviders().map((p) => p.id).sort();
    } catch {
      // ignore
    }
    const list = available.length > 0 ? available.join(", ") : "(none)";
    throw new Error(`lykos: unknown provider "${ref.provider}" — available providers: ${list}`);
  }
  const model = modelRuntime.getModel(ref.provider, ref.model);
  if (!model) {
    let offered: string[] = [];
    try {
      offered = modelRuntime.getModels(ref.provider).map((m) => m.id).sort();
    } catch {
      // ignore
    }
    if (offered.length > 0) {
      throw new Error(
        `lykos: unknown model "${ref.model}" for provider "${ref.provider}" — available models: ${offered.join(", ")}`,
      );
    }
    throw new Error(`lykos: model "${ref.model}" is unknown to provider "${ref.provider}"`);
  }
  return model;
}

/**
 * T30.2's default gate resolution, shared by the one-shot and interactive
 * paths: `--yes` always wins (T34.2: "a flag, not a keystroke"); otherwise
 * a real TTY gets an interactive prompt and anything else is refused rather
 * than hung or silently allowed.
 */
export function resolveApprovalGate(opts: { autoApprove: boolean; interactiveGate?: ApprovalGate }): ApprovalGate {
  if (opts.autoApprove) return new AutoApproveGate();
  if (opts.interactiveGate) return opts.interactiveGate;
  return new DenyAllGate();
}

/**
 * T33.1: the budget check before the call, T7's kill switch with no special
 * case — the same `guardToolCall()` every provider call goes through. Shared so the
 * interactive loop (T34.1) can re-run it before every new top-level turn,
 * not just once at session boot.
 */
export function checkStandaloneBudget(opts: {
  prompt: string;
  ledgerPath: string;
  config: ResolvedConfig;
  modelSpec: string;
}): BudgetVerdict {
  return guardToolCall({
    toolName: "run",
    args: { prompt: opts.prompt, model: opts.modelSpec },
    ledgerPath: opts.ledgerPath,
    budget: opts.config.budget,
    defaultModel: opts.modelSpec,
    trippedSessions: new Set(),
  });
}

export async function recordStandaloneBudgetTrip(
  ledgerPath: string,
  workspace: string,
  verdict: Extract<BudgetVerdict, { tripped: true }>,
): Promise<void> {
  const ledger = await openLedger(ledgerPath);
  try {
    recordBudgetTrip(ledger, { toolName: "run", verdict, workspace });
  } finally {
    ledger.close();
  }
}

interface UsageAccumulator {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  reasoning: number;
  nestedInput: number;
  nestedOutput: number;
  nestedCacheRead: number;
  nestedCacheWrite: number;
  calls: DelegateUsageCall[];
}

function modelRef(model: { provider?: string; id?: string } | undefined): string {
  return model?.provider && model.id ? `${model.provider}/${model.id}` : "unknown";
}

function newUsage(): UsageAccumulator {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    reasoning: 0,
    nestedInput: 0,
    nestedOutput: 0,
    nestedCacheRead: 0,
    nestedCacheWrite: 0,
    calls: [],
  };
}

/** Mutated in place by `subscribeStandaloneUsage()`'s event listener; read by both callers at any point, not just at the end. */
export interface StandaloneSessionState {
  usage: UsageAccumulator;
  toolCalls: DelegateToolCall[];
  turns: number;
  lastText: string;
  humanInterventions: number;
  /** T119/T120: user-selected model path and the pending cold-cache marker. */
  initialModel?: string;
  currentModel?: string;
  modelSwitches?: number;
  modelPath?: string;
  modelSwitchedPending?: boolean;
  /** Specialists ticket 04: mid-session `/specialist <name>` switches, same shape as the model fields above. Set directly by the surface that applies a switch (`tui/interactive-surface.ts`), not observed off the event stream — unlike a model switch, a specialist switch is never inferred from a message. */
  specialistSwitches?: number;
  specialistPath?: string;
  specialistSwitchedPending?: boolean;
  /** T115: one browser-open fan-out measurement, when the human used it. */
  browserFanout?: { elapsedMs: number; projectsScanned: number; rowsReturned: number };
  /**
   * T83: what Pi's own transient-failure retry did this session. Pi retries
   * 429s and 5xx by default (verified: enabled, 3 attempts, 2000ms base) and
   * Lykos recorded none of it, so a session that survived three rate limits
   * looked exactly like one that never hit any. See `loop/retry-observer.ts`.
   */
  retry: RetryObservation;
}

/**
 * Subscribes the shared usage/tool-call/latency accounting to a booted
 * session's event stream, mutating the returned `state` in place. One-shot
 * (`runStandaloneTask`) reads it once at the end; the interactive loop
 * (T34.1) reads it after every turn, and increments `humanInterventions`
 * itself on `steer()` — this function owns model-call accounting only.
 */
export function subscribeStandaloneUsage(
  booted: BootedStandaloneSession,
): { state: StandaloneSessionState; unsubscribe: () => void } {
  const { session, headContract } = booted;
  const state: StandaloneSessionState = {
    usage: newUsage(),
    toolCalls: [],
    turns: 0,
    lastText: "",
    humanInterventions: 0,
    initialModel: modelRef(booted.session.model),
    currentModel: modelRef(booted.session.model),
    modelSwitches: 0,
    modelSwitchedPending: false,
    specialistSwitches: 0,
    specialistSwitchedPending: false,
    retry: newRetryObservation(),
  };
  const openCalls = new Map<string, DelegateToolCall>();
  const latency = new LatencyTracker();
  const compactionLatency = new CompactionLatencyTracker();

  type CompactionCallUsage = {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cacheWrite1h?: number;
    reasoning?: number;
    cost?: { total?: number };
  };
  /** One model call a compaction made: the totals, and a `calls` row of source `compaction`. */
  const addCompactionCall = (u: CompactionCallUsage | undefined, latencyMs: number | undefined): void => {
    if (!u) return;
    state.usage.input += u.input ?? 0;
    state.usage.output += u.output ?? 0;
    state.usage.cacheRead += u.cacheRead ?? 0;
    state.usage.cacheWrite += u.cacheWrite ?? 0;
    state.usage.cacheWrite1h += u.cacheWrite1h ?? 0;
    state.usage.reasoning += u.reasoning ?? 0;
    state.usage.calls.push({
      hop: "direct",
      source: "compaction",
      input: u.input ?? 0,
      output: u.output ?? 0,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
      cacheWrite1h: u.cacheWrite1h ?? 0,
      reasoning: u.reasoning ?? 0,
      // No price from the provider means no figure: never a zero-dollar default (findings 2.4).
      ...(u.cost?.total !== undefined ? { costUsd: u.cost.total } : {}),
      ts: Date.now(),
      ...(latencyMs !== undefined ? { latencyMs } : {}),
    });
  };

  const unsubscribe = session.subscribe((ev: AgentSessionEvent) => {
    // T83: fold retry events before the switch rather than adding two cases
    // to it — `observeRetryEvent` ignores everything else, so this is one
    // call and no second subscription.
    observeRetryEvent(state.retry, ev as RetryEventLike);
    switch (ev.type) {
      case "turn_start":
        state.turns += 1;
        break;
      case "tool_execution_start": {
        const call: DelegateToolCall = {
          seq: state.toolCalls.length + 1,
          id: ev.toolCallId,
          name: ev.toolName,
          args: ev.args,
          state: "running",
        };
        state.toolCalls.push(call);
        if (ev.toolCallId) openCalls.set(ev.toolCallId, call);
        break;
      }
      case "tool_execution_end": {
        const call =
          (ev.toolCallId ? openCalls.get(ev.toolCallId) : undefined) ??
          [...state.toolCalls].reverse().find((c) => c.state === "running" && c.name === ev.toolName);
        if (call) {
          call.state = ev.isError ? "error" : "ok";
          call.result = ev.result;
          if (ev.toolCallId) openCalls.delete(ev.toolCallId);
        }
        break;
      }
      case "message_start":
        latency.onMessageStart();
        break;
      case "message_update":
        latency.onMessageUpdate();
        if (ev.assistantMessageEvent?.type === "text_end") {
          state.lastText = (ev.assistantMessageEvent as { content?: string }).content ?? state.lastText;
        }
        break;
      case "compaction_start":
        compactionLatency.onStart();
        break;
      case "message_end": {
        const timing = latency.onMessageEnd();
        const msg = ev.message as {
          role?: string;
          usage?: {
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
            cacheWrite1h?: number;
            reasoning?: number;
            cost?: { total?: number };
          };
          provider?: string;
          model?: string;
          timestamp?: number | string;
        };
        const u = msg.usage;
        if (!u) break;
        if (msg.role === "assistant") {
          const observedModel = msg.provider && msg.model ? `${msg.provider}/${msg.model}` : undefined;
          if (observedModel !== undefined && observedModel !== (state.currentModel ?? state.initialModel)) {
            state.modelSwitches = (state.modelSwitches ?? 0) + 1;
            state.modelPath = state.modelPath
              ? `${state.modelPath}>${observedModel}`
              : `${state.initialModel ?? "unknown"}>${observedModel}`;
            state.currentModel = observedModel;
            state.modelSwitchedPending = true;
          }
          // T86: the context size the model just paid for — this call's
          // uncached input plus what came from cache. Assigned, not summed:
          // it is a level, not a total, and summing it across turns would
          // report a number many times the window.
          booted.harnessObservation.contextTokens = (u.input ?? 0) + (u.cacheRead ?? 0);
          state.usage.input += u.input ?? 0;
          state.usage.output += u.output ?? 0;
          state.usage.cacheRead += u.cacheRead ?? 0;
          state.usage.cacheWrite += u.cacheWrite ?? 0;
          state.usage.cacheWrite1h += u.cacheWrite1h ?? 0;
          state.usage.reasoning += u.reasoning ?? 0;
          const observed = headContract.observe(session.systemPrompt, session.getActiveToolNames());
          if (observed.driftedFields.length > 0) {
            stderrWrite(
              `lykos head-drift (standalone): changed field(s): ${observed.driftedFields.join(", ")}\n`,
            );
          }
          // P14.6 ticket 06 (plan D2): the Lykos credential that served THIS
          // call, keyed by the message object the rotation wrapper returned.
          // Absent when no pool row served it (an ambient env key).
          const servedBy = servedCredentialFor(ev.message);
          state.usage.calls.push({
            hop: "direct",
            source: "assistant_message",
            ...(servedBy !== undefined ? { credentialLabel: servedBy.label, credentialType: servedBy.type } : {}),
            ...(msg.provider !== undefined ? { provider: msg.provider } : {}),
            ...(msg.model !== undefined ? { model: msg.model } : {}),
            input: u.input ?? 0,
            output: u.output ?? 0,
            cacheRead: u.cacheRead ?? 0,
            cacheWrite: u.cacheWrite ?? 0,
            cacheWrite1h: u.cacheWrite1h ?? 0,
            reasoning: u.reasoning ?? 0,
            costUsd: u.cost?.total ?? 0,
            ...(msg.timestamp !== undefined ? { ts: msg.timestamp } : {}),
            modelSwitched: state.modelSwitchedPending === true,
            specialistSwitched: state.specialistSwitchedPending === true,
            headFingerprint: observed.fingerprint,
            ...(timing.latencyMs !== undefined ? { latencyMs: timing.latencyMs } : {}),
            ...(timing.ttftMs !== undefined ? { ttftMs: timing.ttftMs } : {}),
          });
          state.modelSwitchedPending = false;
          state.specialistSwitchedPending = false;
        } else if (msg.role === "toolResult") {
          state.usage.nestedInput += u.input ?? 0;
          state.usage.nestedOutput += u.output ?? 0;
          state.usage.nestedCacheRead += u.cacheRead ?? 0;
          state.usage.nestedCacheWrite += u.cacheWrite ?? 0;
        }
        break;
      }
      case "compaction_end": {
        const timing = compactionLatency.onEnd();
        addCompactionCall(ev.aborted ? undefined : ev.result?.usage, timing.latencyMs);
        break;
      }
      default:
        // T190: a handoff side call that failed or wrote nothing is no compaction's result, but it was
        // paid for: the extension appends its usage as an entry, and it becomes a `compaction` call here.
        if ((ev as { type?: string }).type === "entry_appended") {
          const entry = (ev as { entry?: { customType?: string; data?: unknown } }).entry;
          if (entry?.customType === HANDOFF_USAGE_ENTRY_TYPE && entry.data !== null && typeof entry.data === "object") {
            addCompactionCall(entry.data as CompactionCallUsage, undefined);
          }
        }
        break;
    }
  });

  return { state, unsubscribe };
}

/** Builds the same `DelegateSnapshot` shape the one-shot and interactive paths both feed to `ingestDelegateSnapshot()`. */
export function buildStandaloneSnapshot(opts: {
  booted: BootedStandaloneSession;
  state: StandaloneSessionState;
  sessionId: string;
  label: string | undefined;
  runState: "done" | "aborted" | "error";
  sawError: string | undefined;
  modelRef: string;
  activeTools: string[];
  /** T89: `from>to` per switch. Undefined when nothing switched — the column stays NULL. */
  modelFallbacks?: string | undefined;
  /**
   * T111.2: approval friction, from the gate that ran this session.
   * Undefined on every shape with no gate (a one-shot `--yes` run, an MCP
   * worker, a subagent) — those record NULL, which is not "never asked".
   */
  approvals?: ApprovalMetrics | undefined;
  /**
   * T111.1: bytes spilled to `artifacts/`, from the transcript writer that
   * observed the session. Undefined when nothing observed it.
   */
  artifactBytes?: number | undefined;
}): DelegateSnapshot {
  const { booted, state, sessionId, label, runState, sawError, modelRef, activeTools } = opts;
  return {
    sessionId,
    ...(label !== undefined ? { label } : {}),
    state: runState,
    // `sessions.model` is the boot model; the per-call rows carry the
    // switched model. Keeping this value stable is what makes a mixed
    // session readable in the ledger.
    model: state.initialModel && state.initialModel !== "unknown" ? state.initialModel : modelRef,
    cwd: booted.bootArtifacts.cwd,
    activeTools,
    turns: state.turns,
    toolCalls: state.toolCalls,
    ...(state.lastText ? { lastText: state.lastText } : {}),
    ...(sawError !== undefined ? { error: sawError } : {}),
    ...(opts.modelFallbacks !== undefined ? { modelFallbacks: opts.modelFallbacks } : {}),
    ...(state.modelSwitches && state.modelSwitches > 0
      ? { modelSwitches: state.modelSwitches, modelPath: state.modelPath }
      : {}),
    // Specialists ticket 04: same shape as the model-switch pair above.
    ...(state.specialistSwitches && state.specialistSwitches > 0
      ? { specialistSwitches: state.specialistSwitches, specialistPath: state.specialistPath }
      : {}),
    ...(state.browserFanout !== undefined ? { browserFanout: state.browserFanout } : {}),
    startedAt: booted.startedAt,
    finishedAt: new Date().toISOString(),
    // Specialists ticket 01: absent (NULL) when no specialist was selected.
    ...(booted.specialistName !== undefined ? { specialist: booted.specialistName } : {}),
    // T173: absent for a child, which runs where its parent's commands do.
    ...(booted.containment !== undefined ? { containment: booted.containment } : {}),
    usage: {
      input: state.usage.input,
      output: state.usage.output,
      cacheRead: state.usage.cacheRead,
      cacheWrite: state.usage.cacheWrite,
      cacheWrite1h: state.usage.cacheWrite1h,
      reasoning: state.usage.reasoning,
      nestedInput: state.usage.nestedInput,
      nestedOutput: state.usage.nestedOutput,
      nestedCacheRead: state.usage.nestedCacheRead,
      nestedCacheWrite: state.usage.nestedCacheWrite,
      ...(state.usage.nestedInput > 0 ? { nestedBasis: "reported_usage" } : {}),
      calls: state.usage.calls,
    },
    headContract: { enabled: true },
    // T111.2: approval friction, present only when a gate actually ran.
    // Unlike the always-present blocks below, this one is conditional on
    // purpose: a `--yes` one-shot has no gate to count, and zeros there
    // would claim a mechanism the session never had.
    ...(opts.approvals !== undefined
      ? {
          approvals: {
            requested: opts.approvals.totals.requested,
            denied: opts.approvals.totals.denied,
            autoDenied: opts.approvals.totals.autoDenied,
            byTier: opts.approvals.serializeByTier(),
            byMode: opts.approvals.serializeByMode(),
          },
        }
      : {}),
    // T111.1: bytes spilled to artifacts/, from the writer that saw them.
    ...(opts.artifactBytes !== undefined ? { artifactBytes: opts.artifactBytes } : {}),
    // T105: what the hook surface refused and what it said. A registry with
    // hooks and zero denials is the healthy case and is worth recording as 0
    // rather than as an absence.
    hooks: {
      registered: booted.hooks.list().length,
      denials: booted.harnessObservation.hookDenials,
      notes: booted.harnessObservation.hookNotes,
    },
    // T104: turn checkpoints actually written. 0 with checkpointing on means
    // "nothing changed all session", which is a real and common answer for a
    // read-only conversation.
    checkpoints: {
      enabled: checkpointsEnabledFor(booted),
      written: booted.harnessObservation.checkpoints,
    },
    // T170: why git was unusable, if it was.
    git: { state: booted.gitState },
    // T103: clarification. Always present on this path — zeroes mean "the
    // channel existed and the model never used it", which is the reading
    // §2.10's cost argument needs, and is not the same as a NULL row from a
    // session that had no channel at all.
    ask: {
      asked: booted.askState.asked,
      answered: booted.askState.answered,
      unanswered: booted.askState.unanswered,
    },
    // T102: the skills roster and what the session actually did with it.
    // `available` with `invoked: []` is the store-pressure reading §2.5 asks
    // for — the same shape T76 used for memory entries, and the reason the
    // denominator travels with the numerator.
    skills: {
      available: booted.skills.roster.length,
      invoked: booted.skills.invocation.invoked,
      reads: booted.skills.invocation.reads,
      headTokens: booted.skills.headTokens,
    },
    // T99: the post-edit feedback loop. Always present on this path, so a
    // session that discovered no command is `enabled: true, command: null,
    // runs: 0` — which reads as "there was nothing to run here", not as
    // "nobody built the loop".
    postEdit: {
      enabled: booted.postEditPolicy.enabled,
      command: booted.postEditPolicy.command ?? null,
      runs: booted.postEditState.runs,
      failures: booted.postEditState.failures,
      passes: booted.postEditState.passes,
      totalMs: booted.postEditState.totalMs,
      disabled: booted.postEditState.disabled,
      ...(booted.postEditState.disabledReason !== undefined
        ? { disabledReason: booted.postEditState.disabledReason }
        : {}),
    },
    // T98: the task list, always present on this path. Zeros mean "the tool
    // was there and nothing used it", which is the answer Phase 12 §0 wants
    // to be able to give — distinct from a NULL row that never had the tool.
    taskList: {
      calls: booted.taskList.calls,
      created: booted.taskList.created,
      completed: booted.taskList.completed,
      open: booted.taskList.items.filter((i) => i.status === "pending" || i.status === "in_progress").length,
      reminders: booted.taskList.reminders,
      gateRefusals: booted.taskList.gateRefusals,
      verified: booted.taskList.items.filter((i) => i.verified?.ok === true).length,
    },
    // T85: the stagnation brake. Always present on this path, so 0 means
    // "measured, nothing stalled" rather than "not measured".
    stagnation: {
      trips: booted.harnessObservation.stagnationTrips,
      stopped: booted.harnessObservation.stagnationStopped,
      ...(booted.harnessObservation.stagnationKey !== undefined
        ? { key: booted.harnessObservation.stagnationKey }
        : {}),
    },
    // T83: Pi's transient-failure retry, observed. Always present, including
    // the all-zero case — "this session retried nothing" and "this session
    // was never measured" are different answers, and only rows written from
    // here can tell them apart.
    retry: {
      starts: state.retry.retryStarts,
      recovered: state.retry.retriesRecovered,
      exhausted: state.retry.retriesExhausted,
      maxAttempt: state.retry.maxAttempt,
      ...(state.retry.lastError !== undefined ? { lastError: state.retry.lastError } : {}),
    },
    promptDiet: {
      enabled: booted.promptDietEnabled,
      toolResultMaxBytes: toolResultMaxBytesFromEnv(),
      // T84: the clamp is live on this path now, so these stop being the
      // container's numbers only.
      truncatedResults: booted.harnessObservation.clampedResults,
      unchangedStubs: booted.harnessObservation.unchangedStubs,
      bytesElided: booted.harnessObservation.bytesElided,
      contextFiles: contextFileMeta(booted.frozenContextFiles),
    },
    outputDiet: { enabled: booted.outputDietEnabled },
    // T65: what memory this session froze into its head, and what it cost.
    // problems/09 mitigation 1 — logged with the feature, not after it.
    // T69: flag_retrieval finally gets a writer. It has existed since T8 and
    // nothing has ever set it — the same shape as outcome='success' before T52.
    repoMap: {
      enabled: booted.repoMap.enabled,
      // T70 scores the map against the session's own trace at ingest, so the
      // text has to travel with the snapshot. It is not stored on the row —
      // the map is reproducible from `.lykos/cache/repo-map.json` and its
      // source hash, and a copy per session would be pure duplication.
      text: booted.repoMap.text,
      tokens: booted.repoMap.tokens,
      files: booted.repoMap.files,
      dropped: booted.repoMap.dropped,
      tracked: booted.repoMap.tracked,
    },
    memory: {
      enabled: booted.memoryHead.enabled,
      injectedIds: booted.memoryHead.ids,
      injectTokens: booted.memoryHead.tokens,
      available: booted.memoryHead.available,
      skipped: booted.memoryHead.skipped,
      // T76: per-entry, so "never injected" can be told apart from "never
      // reached the cap boundary". Carried on the snapshot rather than
      // written here, because the session process may not own the ledger.
      eligibility: booted.memoryHead.eligibility,
    },
    // T34.3: human_interventions finally gets a writer — steering is what it
    // counts. T87.4 adds refusals: a declined write is the human redirecting
    // the agent mid-task, which is the same thing this column has always
    // meant, and counting it as a tool failure instead would inflate the
    // error rates T85's brake and T24's edit-retry metric both read.
    ...(state.humanInterventions + booted.denials.total > 0
      ? { humanInterventions: state.humanInterventions + booted.denials.total }
      : {}),
  };
}

/**
 * T100: did this session actually change a file?
 *
 * Read off the same trace `countEditToolCalls()` reads, and deliberately
 * counting only calls that SUCCEEDED: a session whose every edit failed
 * changed nothing on disk, and grading it with the project's test suite
 * would record a verdict about the repository rather than about the session.
 */
/**
 * T104: was checkpointing in force for this session? Derived from the boot
 * artifacts rather than stored, so it cannot disagree with what the extension
 * was actually given.
 */
export function checkpointsEnabledFor(booted: { gitState: GitState }): boolean {
  return booted.gitState === "repo";
}

/**
 * P4 T149: bind a top-level session's extension host to a runner for
 * child sessions. T204: supports writable child sessions when request.writable is true.
 * The child is a real session — its own ledger row,
 * `parent_session_id` this one, `agent_role` `specialist ?? extension:<name>`.
 */
export function bindExtensionChildSessions(
  booted: Pick<BootedStandaloneSession, "extensionHost">,
  ctx: {
    cwd: string;
    workTree?: WorkTree;
    ledgerPath: string;
    /** A function where the id can change after boot (an interactive session's `/new`). */
    sessionId: string | (() => string);
    taskId?: string;
    projectId?: string;
    nativeProviders?: readonly Provider[];
    env?: NodeJS.ProcessEnv;
    /** T161: tests only — forwarded to the child's boot, where only a read-only child reads it. */
    childBootDeps?: BootDeps;
    /** T194: the parent's trust, so a child cannot load the project config the parent withheld from itself. */
    delegated?: boolean;
    trustSource?: "stored" | "flag" | "prompt";
    model?: string;
    gate?: ApprovalGate;
    autoApprove?: boolean;
    interactionMode?: InteractionMode;
    config?: ResolvedConfig;
  },
): void {
  booted.extensionHost.bindSession({
    runChild: async (extension, request): Promise<ChildSessionResult> => {
      const isWritable = request.writable === true;
      const specialist = request.specialist ?? (isWritable ? "test-writer" : undefined);
      const childModel = request.model ?? ctx.model;

      if (isWritable && !ctx.gate) {
        return {
          status: "unavailable",
          model: childModel ?? "",
          message: "Writable child sessions require a parent approval gate.",
        };
      }

      const parentId = typeof ctx.sessionId === "function" ? ctx.sessionId() : ctx.sessionId;
      const ledger = await openLedger(ctx.ledgerPath);
      let taskId = ctx.taskId;
      let projectId = ctx.projectId;
      const config = ctx.config ?? loadConfig({ cwd: ctx.cwd }).resolved;
      try {
        const ensured = ensureParentSessionForSpawn(ledger, {
          ledgerPath: ctx.ledgerPath,
          parentSessionId: parentId,
          parentBrief: request.label ?? `${extension} child`,
          workspace: ctx.cwd,
          executionShape: "standalone",
          modelSpec: ctx.model ?? "default",
          config,
          gate: ctx.gate ?? new AutoApproveGate(),
          autoApprove: ctx.autoApprove ?? true,
          allowSpawn: false,
          ...(taskId !== undefined ? { taskId } : {}),
          ...(projectId !== undefined ? { projectId } : {}),
        });
        taskId = ensured.taskId;
        projectId = ensured.projectId;
      } finally {
        ledger.close();
      }

      const parentIsReadOnly =
        ctx.gate !== undefined &&
        (unwrapGate(ctx.gate) instanceof ReadOnlyGate ||
          ctx.gate.refuses?.({ kind: "write", detail: "", summary: "" }) === true);

      let childGate: ApprovalGate | undefined;
      if (isWritable && ctx.gate !== undefined) {
        const toolCwd = ctx.workTree?.path ?? ctx.cwd;
        const { rules: defaultRules, ctx: defaultCtx } = await resolvePathRulesAndContext(toolCwd);
        childGate = new SubagentGate({
          name: specialist ?? `extension:${extension}`,
          parentGate: ctx.gate,
          mode: ctx.interactionMode ?? (ctx.autoApprove ? "auto" : "manual"),
          rules: defaultRules,
          ctx: defaultCtx,
          allowed: getAllowedPatterns(ctx.gate),
          readOnly: parentIsReadOnly,
          verifyCommand: getGateVerifyCommand(ctx.gate),
        });
      }

      const res = await runStandaloneTask({
        workspace: ctx.cwd,
        ...(ctx.workTree !== undefined ? { workTree: ctx.workTree } : {}),
        prompt: request.prompt,
        ...(childModel !== undefined ? { model: childModel } : {}),
        ledgerPath: ctx.ledgerPath,
        label: request.label ?? (isWritable ? `${extension} (${specialist ?? "child"})` : `${extension} (read-only child)`),
        parentSessionId: parentId,
        agentRole: specialist ?? `extension:${extension}`,
        ...(specialist !== undefined ? { specialist, specialistContext: "subagent" } : {}),
        executionShape: "subagent",
        ...(request.model !== undefined ? { modelSource: "caller_override" } : {}),
        readOnly: !isWritable || parentIsReadOnly,
        ...(childGate !== undefined ? { gate: childGate } : {}),
        ...(ctx.autoApprove !== undefined ? { autoApprove: ctx.autoApprove } : {}),
        ...(ctx.interactionMode !== undefined ? { interactionMode: ctx.interactionMode } : {}),
        ...(taskId !== undefined ? { taskId } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
        ...(ctx.nativeProviders !== undefined ? { nativeProviders: ctx.nativeProviders } : {}),
        ...(ctx.env !== undefined ? { env: ctx.env } : {}),
        ...(ctx.childBootDeps !== undefined ? { bootDeps: ctx.childBootDeps } : {}),
        ...(ctx.delegated === true ? { delegated: true } : {}),
        ...(ctx.trustSource !== undefined ? { trustSource: ctx.trustSource } : {}),
      });
      if (res.status === "ok") return { status: "ok", sessionId: res.sessionId, model: childModel ?? "", text: res.text ?? "" };
      if (res.status === "blocked") return { status: "blocked", model: childModel ?? "", message: res.reason };
      return { status: "error", model: childModel ?? "", message: res.message };
    },
  });
}

/**
 * P4 T149: the end of a session, for its Lykos extensions. A top-level
 * session fires `session_end` — the gate's verdict, the edit test and the
 * diff since boot — and waits for every handler; then whatever counters the
 * extensions recorded go to the ledger's `extension_counters` under each
 * extension's name. A child fires no `session_end` (its parent's covers the
 * task, the gate's own rule) but its counters are still written.
 */
export async function endExtensionSession(
  booted: Pick<BootedStandaloneSession, "extensionHost" | "bootArtifacts" | "taskList" | "selfCompactRecords" | "commits">,
  opts: {
    cwd: string;
    ledgerPath: string;
    sessionId: string;
    isChild: boolean;
    model: string;
    state: SessionEndEvent["state"];
    edited: boolean;
    gateOutcome?: GateOutcome;
    /**
     * T162: where the extensions' end-of-session reports go — the writer the
     * gate's verdict just used, so they print right after it.
     */
    report?: (text: string) => void;
  },
): Promise<void> {
  const host = booted.extensionHost;
  if (!opts.isChild && host.listenerCount("session_end") > 0) {
    const payload: SessionEndEvent = {
      sessionId: opts.sessionId,
      model: opts.model,
      state: opts.state,
      edited: opts.edited,
      verdict:
        opts.gateOutcome !== undefined
          ? verdictEventOf(opts.gateOutcome)
          : {
              status: "skipped",
              reason: opts.state === "done" ? "the gate did not run" : `the session ended ${opts.state}, so the gate did not run`,
            },
      diff: sessionDiffSummary(opts.cwd, booted.bootArtifacts.gitHeadAtBoot),
      taskList: booted.taskList.items.length > 0 ? renderTaskList(booted.taskList) : "",
    };
    await host.emitAndWait("session_end", payload);
  }
  // T162: what the extensions asked to show the person, straight after the
  // gate's verdict and before anything is written to the ledger.
  const reports = renderSessionEndReports(host.sessionEndReports());
  if (reports !== undefined && opts.report !== undefined) opts.report(reports);
  // P4 T152 (spec story 54): each compaction attempt `lykos-self-compact`
  // recorded becomes a `compactions` row — model, tier, tokens and result.
  const compactions = (booted.selfCompactRecords ?? []).filter((r) => r.kind === "compaction");
  if (compactions.length > 0) {
    try {
      const ledger = await openLedger(opts.ledgerPath);
      try {
        ledger.recordCompactions(opts.sessionId, compactions);
      } finally {
        ledger.close();
      }
    } catch (err) {
      stderrWrite(`lykos: could not record compactions for ${opts.sessionId}: ${err instanceof Error ? err.message : String(err)}
`);
    }
  }
  // T179 (spec #22 story 24): each commit the session made through `commit`
  // becomes a `commits` row, so `lykos show` and P3's seal read one place.
  const commitRows = booted.commits?.records ?? [];
  if (commitRows.length > 0) {
    try {
      const ledger = await openLedger(opts.ledgerPath);
      try {
        ledger.recordCommits(opts.sessionId, commitRows);
      } finally {
        ledger.close();
      }
    } catch (err) {
      stderrWrite(`lykos: could not record commits for ${opts.sessionId}: ${err instanceof Error ? err.message : String(err)}
`);
    }
  }
  const rows = host.extensionCounters();
  if (rows.length === 0) return;
  try {
    const ledger = await openLedger(opts.ledgerPath);
    try {
      ledger.recordExtensionCounters(opts.sessionId, rows);
    } finally {
      ledger.close();
    }
  } catch (err) {
    // A counter that cannot be written is said out loud, never silently lost.
    stderrWrite(`lykos: could not record extension counters for ${opts.sessionId}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

export function sessionEditedFiles(toolCalls: readonly { name?: string; state?: string; args?: unknown; result?: unknown }[]): boolean {
  // P4 T143: the registry's declaration, through the `tool_call` transport,
  // so a session that edited only with `ast_edit` or an `lsp` rename is graded.
  // T156: with each call's result, so an undeclared extension tool whose call
  // changed the tree is an edit too.
  return toolCalls.some((c) => isFileChangingCall(c.name, c.args, c.result) && c.state !== "error");
}

/**
 * T167 (ADR-0030): the paths the session edited, from the same trace
 * `edited_files` is written from at ingest — `computeHitQuality`'s answer,
 * not a second one — plus `changed`, what git says changed since boot
 * (`sessionChangedPaths`). The trace cannot attribute a `bash` `sed -i` to a
 * path, and git can, so a flaky test in a file rewritten that way still keeps
 * the gate at `fail`.
 */
export function sessionEditedPaths(toolCalls: readonly HitQualityToolCall[], changed: readonly string[] = []): string[] {
  return [...new Set([...computeHitQuality(toolCalls).files.map((f) => f.path), ...changed])];
}

/**
 * Drives one prompt to completion, in-process, and builds a `DelegateSnapshot`
 * — the same shape `snapshotsFromMcpResult()` parses out of the container
 * path's MCP result — from the live `AgentSessionEvent` stream instead of a
 * terminal JSON blob (T33.2). Feeding the SAME `ingestDelegateSnapshot()` the
 * container path uses is deliberate: "one ledger, one ingest path" (Phase 3's
 * "what not to do") holds even though this is a second SOURCE of usage data.
 *
 * T39.1: when `parentSessionId` is set, this run is a Lykos-spawned child —
 * same lifecycle, `execution_shape=subagent`, resumable=1.
 */
export async function runStandaloneTask(input: RunStandaloneTaskInput): Promise<RunStandaloneTaskResult> {
  // T183: the caller is told what was skipped on every outcome, not only a finished session. A delegated session
  // always ends in a result (a throw becomes an `error`), so that does not depend on whether anything was skipped.
  const skipped: string[] = [];
  let result: RunStandaloneTaskResult;
  try {
    result = await runStandaloneTaskInner(input, skipped);
  } catch (err) {
    if (input.delegated !== true) throw err;
    result = { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
  if (skipped.length === 0 || result.status === "ok") return result;
  return { ...result, skippedExtensions: skipped };
}

async function runStandaloneTaskInner(input: RunStandaloneTaskInput, skippedSink: string[]): Promise<RunStandaloneTaskResult> {
  const cwd = input.workspace;
  // Where the files are. Config, the ledger and the project's identity stay at `cwd`, the project's root.
  const toolCwd = input.workTree?.path ?? cwd;
  // T183/T194: the one answer to "does the user-level store trust this project", asked once per session.
  const projectTrusted = isStoreTrusted(input.trustSource);
  const ledgerPath = input.ledgerPath ?? defaultLedgerPath(cwd);
  // T113: registration happens at boot, before a later ingest can possibly
  // hide a failed run from the global project browser.
  resolveProject(cwd);
  const specialist = input.specialist ?? DEFAULT_SPECIALIST;
  const budgetOverride = input.budgetPerRunUsd !== undefined ? Number(input.budgetPerRunUsd) : undefined;
  let config;
  let layers;
  try {
    ({ resolved: config, layers } = loadConfig({
      cwd,
      ...(() => {
        const flags = {
          ...(budgetOverride !== undefined && Number.isFinite(budgetOverride) ? { budget: { per_run_usd: budgetOverride } } : {}),
          ...(input.containmentLevel !== undefined || input.containmentNetwork !== undefined
            ? {
                containment: {
                  ...(input.containmentLevel !== undefined ? { level: input.containmentLevel } : {}),
                  ...(input.containmentNetwork !== undefined ? { network: input.containmentNetwork } : {}),
                },
              }
            : {}),
          ...(input.outputStyle !== undefined ? { output_style: input.outputStyle } : {}),
        };
        return Object.keys(flags).length > 0 ? { flags } : {};
      })(),
      specialistName: specialist,
      ...(input.env !== undefined ? { env: input.env } : {}),
    }));
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }

  // T183: a delegated session loads the project's own extensions only when the user-level store trusts the
  // project. `cwd` is the project's root even when the files are in a worktree, so the identity is the project's.
  let skippedExtensions: string[] = [];
  let piProjectTrusted = true;
  if (input.delegated === true) {
    const narrowed = withoutUntrustedProjectExtensions({ config, layers, cwd, trusted: projectTrusted });
    // A `!command` credential the project declares would run on the host when Pi resolves the provider's key.
    const commands = withoutUntrustedProjectCommands({ config: narrowed.config, layers, cwd, trusted: projectTrusted });
    // T194: so would the project's own command fields, and a `containment.level` below what the user's layers give.
    const hostCommands = withoutUntrustedProjectHostCommands({ config: commands.config, layers, cwd, trusted: projectTrusted, commandCwd: toolCwd });
    const containment = withoutUntrustedProjectContainmentLowering({ config: hostCommands.config, layers, cwd, trusted: projectTrusted });
    config = containment.config;
    layers = containment.layers;
    const skippedItems = [...narrowed.skipped, ...commands.skipped, ...hostCommands.skipped, ...containment.skipped];
    // Pi reads the project's own `.pi/settings.json`, and a `packages` entry there is installed on the host. An
    // untrusted project is hidden from Pi, and what it declared there is named as skipped like the rest.
    if (!projectTrusted) {
      piProjectTrusted = false;
      skippedItems.push(...projectPiPackages(cwd));
    }
    skippedExtensions = skippedItems.map(skippedLabel);
  }
  skippedSink.push(...skippedExtensions);

  // T180: where this session's commands will run, and whether the floor allows it. Before the budget guard, the
  // model runtime and boot, so a refused request costs nothing and starts nothing.
  // T182: a child owns a containment of its own only when it is handed a level and no executor; otherwise it
  // runs where its parent's commands run.
  const ownsContainment = input.executor === undefined && (input.parentSessionId === undefined || input.containmentLevel !== undefined);
  let containmentFloor: ContainmentFloor | undefined;
  if (ownsContainment) {
    const request = resolveContainmentRequest({
      config,
      layers,
      delegated: input.delegated === true,
      ...(input.containmentAskedFrom !== undefined ? { askedFrom: input.containmentAskedFrom } : {}),
    });
    if (!request.ok) return { status: "error", message: request.message };
    config = request.config;
    containmentFloor = request.floor;
  }

  if (config.models.delegate !== undefined) {
    try {
      validateDelegateModel(config.models.delegate, config.providers);
    } catch (err) {
      return { status: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  // Specialists ticket 02: `provider`+`model`, resolved through the config
  // layers same as everything else — `resolveBootModel` already had this
  // seam (`specialistModel`) reserved since T35.3; nothing consumed it before
  // now.
  const specialistModel = specialistModelSpec(config);
  const modelBoot = resolveBootModel({
    ...(input.model !== undefined ? { callerModel: input.model } : {}),
    ...(specialistModel !== undefined ? { specialistModel } : {}),
    defaultModel: config.models.default,
    ...(config.models.roles.worker !== undefined ? { roleModel: config.models.roles.worker } : {}),
  });
  const modelSpec = modelBoot.spec;

  const specialistLayer = layers.find((l) => l.name === "specialist");
  const specialistProvider = specialistLayer?.value.provider;
  if (specialist !== undefined && specialistProvider !== undefined) {
    try {
      assertSpecialistProviderUsable({
        specialistName: specialist,
        specialistProvider,
        providers: config.providers,
        env: input.env ?? process.env,
        ...(input.poolSizes !== undefined ? { poolSizes: input.poolSizes } : {}),
      });
    } catch (err) {
      return { status: "error", message: err instanceof Error ? err.message : String(err) };
    }
  } else {
    try {
      const { provider: hostProvider } = parseProviderModel(modelSpec);
      assertHostProviderUsable({
        provider: hostProvider,
        providers: config.providers,
        env: input.env ?? process.env,
        ...(input.poolSizes !== undefined ? { poolSizes: input.poolSizes } : {}),
      });
    } catch (err) {
      return { status: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }
  const isChild = input.parentSessionId !== undefined;
  const executionShape = input.executionShape ?? (isChild ? "subagent" : "standalone");

  const guardVerdict = checkStandaloneBudget({ prompt: input.prompt, ledgerPath, config, modelSpec });
  if (guardVerdict.tripped) {
    await recordStandaloneBudgetTrip(ledgerPath, cwd, guardVerdict);
    return { status: "blocked", reason: guardVerdict.reason };
  }

  const generated = generateProviderConfig({
    providers: config.providers,
    builtins: builtinProviderDecls(),
    targetPath: cacheModelsPath(cwd),
  });
  if (generated.errors.length > 0) {
    return { status: "error", message: generated.errors.join("; ") };
  }

  // Ticket 06: the runtime exists before boot() builds the event sink, so its
  // rotation callback goes through a relay the sink subscribes to after boot.
  const rotations = new RotationRelay();
  const modelRuntime = await createLykosModelRuntime({
    ...(generated.written ? { modelsPath: generated.targetPath } : {}),
    providerConfig: config.providers,
    onRotation: rotations.emit,
    ...(input.nativeProviders !== undefined ? { nativeProviders: input.nativeProviders } : {}),
  });
  const model = await resolveHostModel(modelSpec, modelRuntime);
  // T184: the interaction mode, when the caller named one, decides whether this session writes and whether it asks.
  const readOnly = input.readOnly === true || config.readOnly === true || (input.interactionMode !== undefined && !modeWrites(input.interactionMode));
  const autoApprove = input.autoApprove === true;

  // T173: a top-level session decides here where its commands run. A child is
  // handed its parent's executor and records nothing of its own.
  let containment: Containment | undefined;
  // The container is labelled with the id the session will carry, so that id exists before the session does.
  const containedSessionId = input.resume?.fromSessionId ?? (input.continuation === undefined ? input.sessionId : undefined) ?? randomUUID();
  if (ownsContainment) {
    try {
      containment = await startContainment({
        config: config.containment,
        workspace: toolCwd,
        rules: collectPathRules(config.path_rules, isWorkspaceTrusted(toolCwd)),
        sessionId: containedSessionId,
        mount: readOnly ? "ro" : "rw",
        ...(input.workTree !== undefined ? { gitWorktree: { commonDir: input.workTree.commonDir, gitDir: input.workTree.gitDir } } : {}),
        ...(containmentFloor !== undefined ? { minimum: containmentFloor } : {}),
        ...(input.containmentDrivers !== undefined ? { drivers: input.containmentDrivers } : {}),
        log: (line) => stderrWrite(`${line}
`),
      });
    } catch (err) {
      return { status: "error", message: err instanceof Error ? err.message : String(err) };
    }
    if (containment.notice !== undefined) stderrWrite(`${containment.notice}
`);
  }

  // T194: where the gate's command actually runs on the host (no container started, or `auto` fell back to the
  // host), the test script it would find in an untrusted project is the project's code, so it is withheld. A
  // contained session runs it in the container and keeps it. The decision follows the level used, not the one asked,
  // and is taken when the gate resolves, in the folder its command runs in (`toolCwd`), so a script that exists only
  // in the worktree, or was added during the session, is withheld too.
  const usedLevel = containment !== undefined ? containment.record.used : input.containmentRecord?.used;
  const withholdGateDiscovery = input.delegated === true && !projectTrusted && (usedLevel === undefined || usedLevel === "off");
  const resolveSessionGatePolicy = (): ReturnType<typeof resolveGatePolicy> => {
    if (!withholdGateDiscovery) return resolveGatePolicy(toolCwd, config.gate);
    const narrowed = withoutUntrustedProjectGateDiscovery({ config, cwd: toolCwd, trusted: false });
    if (narrowed.skipped.length > 0) {
      const labels = narrowed.skipped.map(skippedLabel).filter((l) => !skippedExtensions.includes(l));
      skippedExtensions = [...skippedExtensions, ...labels];
      skippedSink.push(...labels);
      const priorMeta = readSessionMeta(ledgerPath, sessionId);
      if (priorMeta) writeSessionMeta(ledgerPath, { ...priorMeta, withheld: skippedExtensions });
    }
    return resolveGatePolicy(toolCwd, narrowed.config.gate);
  };

  // L4: the same narrowing, without recording what it withheld: that is recorded when the gate resolves, once the
  // session row exists.
  const sessionGatePolicy = withholdGateDiscovery
    ? resolveGatePolicy(toolCwd, withoutUntrustedProjectGateDiscovery({ config, cwd: toolCwd, trusted: false }).config.gate)
    : resolveGatePolicy(toolCwd, config.gate);
  const sessionVerifyCommand = sessionGatePolicy.enabled && sessionGatePolicy.command ? sessionGatePolicy.command : undefined;

  let gate: ApprovalGate;
  let denied: DeniedAction[] | undefined = input.denied;
  if (input.gate !== undefined || input.approvalGate !== undefined) {
    gate = (input.gate ?? input.approvalGate)!;
    if ("denied" in gate && Array.isArray((gate as any).denied)) {
      denied = (gate as any).denied;
    }
    const unwrapped = unwrapGate(gate);
    if ((unwrapped instanceof DelegatedGate || unwrapped instanceof SubagentGate) && unwrapped.verifyCommand === undefined) {
      unwrapped.verifyCommand = sessionVerifyCommand;
    }
  } else if (input.delegated === true) {
    if (autoApprove) {
      gate = new AutoApproveGate();
    } else {
      denied = input.denied ?? [];
      const projectId = projectIdForCwd(cwd);
      const allowed = loadPermissions(projectId).allow;
      const { rules: defaultRules, ctx: defaultCtx } = await resolvePathRulesAndContext(toolCwd);
      gate = new DelegatedGate({
        mode: input.interactionMode ?? "auto",
        allowed,
        denied,
        rules: defaultRules,
        ctx: defaultCtx,
        verifyCommand: sessionVerifyCommand,
      });
    }
  } else {
    gate = resolveApprovalGate({ autoApprove });
  }

  if (canSealAllowanceEverAllow({ cwd: toolCwd, config, specialist })) {
    const allowance = createSealTestCommandAllowance({
      cwd: toolCwd,
      config,
      specialist,
    });
    gate = wrapApprovalGateWithSealAllowance(gate, allowance);
  }

  let booted: BootedStandaloneSession;
  try {
    booted = await boot({
    cwd: toolCwd,
    ...(input.workTree !== undefined ? { stateRoot: cwd, workTree: input.workTree } : {}),
    config,
    model,
    modelRuntime,
    gate,
    ledgerPath,
    modelSpec,
    isChild,
    autoApprove,
    ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    parentBrief: input.label ?? input.prompt.slice(0, 120),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    ...(input.subagents !== undefined ? { subagents: input.subagents } : {}),
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.mailbox !== undefined ? { mailbox: input.mailbox } : {}),
    ...(input.continuation !== undefined
      ? {
          continuationIndex: input.continuation.index,
          resumeTaskListFrom: transcriptDir(ledgerPath, input.continuation.predecessorSessionId),
        }
      : {}),
    ...(input.resume !== undefined
      ? {
          resumeTaskListFrom: transcriptDir(ledgerPath, input.resume.fromSessionId),
          resumeHandoffFrom: transcriptDir(ledgerPath, input.resume.fromSessionId),
          sessionIdOverride: input.resume.fromSessionId,
        }
      : (containment !== undefined && containment.record.used !== "off") || (input.workTree !== undefined && input.continuation === undefined)
        ? { sessionIdOverride: containedSessionId }
        : {}),
    specialistName: specialist,
    ...(input.trustSource !== undefined ? { trustSource: input.trustSource } : {}),
    ...(piProjectTrusted ? {} : { piProjectTrusted: false }),
    ...(input.specialistFields !== undefined ? { specialist: input.specialistFields } : {}),
    ...(input.specialistContext !== undefined ? { specialistContext: input.specialistContext } : {}),
    ...(readOnly ? { readOnly: true } : {}),
    ...(containment !== undefined
      ? { executor: containment.executor, containment: containment.record }
      : input.executor !== undefined
        ? { executor: input.executor, ...(input.containmentRecord !== undefined ? { containment: input.containmentRecord } : {}) }
        : {}),
    ...(input.containmentDrivers !== undefined ? { containmentDrivers: input.containmentDrivers } : {}),
    ...(input.coordinator !== undefined ? { coordinator: input.coordinator } : {}),
    ...(skippedExtensions.length > 0 ? { withheld: skippedExtensions } : {}),
    ...(input.delegated !== undefined ? { delegated: input.delegated } : {}),
  }, input.bootDeps);
  } catch (err) {
    await containment?.dispose();
    throw err;
  }
  const { session } = booted;
  // T182: the family's handle carries what a child needs to boot the way this session did.
  if (booted.spawnContext !== undefined && input.nativeProviders !== undefined) booted.spawnContext.nativeProviders = input.nativeProviders;
  // T194: a child answers to the same trust as its parent, so an untrusted delegated parent cannot hand a child back
  // the project config (and extensions) it withheld from itself.
  if (booted.spawnContext !== undefined) {
    if (input.delegated === true) booted.spawnContext.delegated = true;
    if (input.trustSource !== undefined) booted.spawnContext.trustSource = input.trustSource;
  }
  // P4 T149: a top-level session's extensions may run read-only children.
  // A child's may not: the runner is simply never bound there.
  if (!isChild) {
    const effectiveGate = booted.spawnContext?.gate ?? (readOnly ? new ReadOnlyGate() : gate);
    bindExtensionChildSessions(booted, {
      cwd,
      ...(input.workTree !== undefined ? { workTree: input.workTree } : {}),
      ledgerPath,
      sessionId: session.sessionId,
      model: modelSpec,
      config,
      ...(effectiveGate !== undefined ? { gate: effectiveGate } : {}),
      ...(autoApprove !== undefined ? { autoApprove } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input.nativeProviders !== undefined ? { nativeProviders: input.nativeProviders } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.delegated === true ? { delegated: true } : {}),
      ...(input.trustSource !== undefined ? { trustSource: input.trustSource } : {}),
      ...(input.bootDeps?.readOnlyChildTest !== undefined
        ? { childBootDeps: { readOnlyChildTest: input.bootDeps.readOnlyChildTest } }
        : {}),
    });
  }
  const stopRotationEvents = forwardRotationsToSink(rotations, booted.extensionHost.sink);
  const { state, unsubscribe } = subscribeStandaloneUsage(booted);
  // T53: capture starts BEFORE the prompt is sent, and the prompt itself is
  // the transcript's first conversational line — the one thing the snapshot
  // path could never record.
  const { recorder, detach } = startLiveCapture({
    ledgerPath,
    booted,
    session,
    modelSpec,
    modelSource: input.modelSource ?? modelBoot.source,
    providers: config.providers,
    executionShape,
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
    ...(isChild ? { agentRole: input.agentRole ?? "subagent" } : {}),
    ...(input.continuation !== undefined
      ? {
          resumedFrom: input.continuation.predecessorSessionId,
          continuationsUsed: input.continuation.index,
        }
      : {}),
  });
  if (input.resume !== undefined) {
    // T57's `injectReplay`, for this shape: the marker first, then the
    // conversation appended after the frozen head without starting a turn.
    recorder?.resumeMarker({
      from: input.resume.fromSessionId,
      events: input.resume.replayEvents,
      user_turns: input.resume.replayUserTurns,
      estimate_tokens: input.resume.estimateTokens,
      estimate_usd: input.resume.estimateUsd,
      price_version: input.resume.priceVersion,
      ...(input.resume.flags !== undefined ? { inherited_flags: input.resume.flags } : {}),
    });
    await session.sendCustomMessage(
      { customType: "lykos_resume", content: input.resume.replayText, display: false },
      { triggerTurn: false },
    );
  }
  recorder?.userMessage(input.prompt);

  let runState: "done" | "aborted" | "error" = "done";
  let sawError: string | undefined;
  // T89: off unless `models.fallback.chain` is configured. Empty chain means
  // `decideFallback` returns "none" for every input, so this costs one
  // function call on the happy path and changes nothing else.
  const fallbackPolicy = resolveFallbackPolicy(config.models.fallback);
  const fallbackState = newFallbackState(modelSpec);
  try {
    await session.prompt(input.prompt);
    await session.waitForIdle();
  } catch (err) {
    runState = "error";
    sawError = err instanceof Error ? err.message : String(err);
    if (isAuthenticationError(err)) {
      const envVar = resolveProviderEnvVar(model.provider, config.providers, modelRuntime);
      sawError = formatAuthenticationFailure(model.provider, envVar);
    }
    // T89: the ONLY case that reaches a fallback — Pi already retried this
    // three times with backoff (T83) and the provider never came back.
    // An ordinary failure (a bad edit, a failing test, a budget trip) must
    // never move the session to another model.
    const decision = decideFallback({
      policy: fallbackPolicy,
      state: fallbackState,
      current: modelSpec,
      exhaustedRetry: endedOnExhaustedRetry(state.retry, runState),
      error: state.retry.lastError ?? sawError,
    });
    if (decision.action === "switch") {
      try {
        stderrWrite(`
${decision.note}
`);
        const altModel = await resolveHostModel(decision.to, modelRuntime);
        // `persist: false` — session-only. Writing the user's global model
        // default because their provider had a bad minute would be the same
        // boundary violation T83 refused for the retry policy.
        await session.setModel(altModel, { persist: false });
        recordSwitch(fallbackState, modelSpec, decision.to, state.retry.lastError ?? sawError ?? "provider unreachable");
        // The conversation survives the switch, so this continues the task
        // rather than restarting it. The warm prefix does not survive, and
        // the note above already said so.
        await session.prompt(input.prompt);
        await session.waitForIdle();
        runState = "done";
        sawError = undefined;
      } catch (fallbackErr) {
        // A failed fallback is reported as the ORIGINAL failure plus this
        // one. Replacing the first error with the second would hide why the
        // session moved in the first place.
        const second = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        sawError = `${sawError}; fallback to ${decision.to} also failed: ${second}`;
      }
    }
  } finally {
    unsubscribe();
    detach();
    stopRotationEvents();
  }

  const activeTools = session.getActiveToolNames();
  const sessionId = session.sessionId;
  session.dispose();
  // P10.4 (ticket 15, D5): the session's language servers die with the
  // session, beside `dispose()` rather than in a lifecycle of their own. A
  // server that outlives its session is a process the user has to find and
  // kill by hand.
  await booted.lsp.shutdownAll();
  // P10.5 (ticket 16, D6): and so do its background jobs, in the same place
  // and for the same reason. A job that outlives its session is an orphan
  // nobody will ever stop.
  await booted.jobs.stopAll();
  // P10.6 (ticket 19, D5): and so do its evaluation runtimes. A retained cell
  // runtime is a Node process holding the session's variables; nothing ever
  // printed its pid, so if it is not killed here it is not killed at all.
  await booted.evalRuntimes.disposeAll();
  // P10.5 (ticket 17, D4): and this agent comes off its family's roster, so a
  // peer's `send` to it fails honestly instead of queueing for an agent that
  // has stopped reading, and a peer parked in `wait` on it is released rather
  // than left to burn its timeout.
  booted.mailbox.leave();

  const snapshot = buildStandaloneSnapshot({
    booted,
    state,
    sessionId,
    label: input.label,
    runState,
    sawError,
    modelRef: `${model.provider}/${model.id}`,
    activeTools,
    ...(serializeFallbacks(fallbackState) !== undefined
      ? { modelFallbacks: serializeFallbacks(fallbackState) }
      : {}),
  });

  // T39.2: a Lykos child must never carry nested* aggregates — its own
  // calls are the only rows. Zero them rather than trusting the event
  // stream (Agent's toolResult has no usage, but be explicit).
  if (isChild && snapshot.usage) {
    snapshot.usage.nestedInput = 0;
    snapshot.usage.nestedOutput = 0;
    snapshot.usage.nestedCacheRead = 0;
    snapshot.usage.nestedCacheWrite = 0;
    delete snapshot.usage.nestedBasis;
  }

  const ledger = await openLedger(ledgerPath);
  try {
    ingestDelegateSnapshot(ledger, snapshot, {
      workspace: cwd,
      executionShape,
      runtime: "host",
      modelSource: input.modelSource ?? modelBoot.source,
      providers: config.providers,
      ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
      ...(input.continuation !== undefined
        ? {
            resumedFrom: input.continuation.predecessorSessionId,
            continuationsUsed: input.continuation.index,
          }
        : {}),
      ...(input.trustSource !== undefined ? { trustSource: input.trustSource } : {}),
      ...(input.resume?.taskId !== undefined
        ? { taskId: input.resume.taskId }
        : input.taskId !== undefined
        ? { taskId: input.taskId }
        : booted.spawnContext?.taskId !== undefined
          ? { taskId: booted.spawnContext.taskId }
          : {}),
      ...(input.resume?.projectId !== undefined
        ? { projectId: input.resume.projectId }
        : input.projectId !== undefined
        ? { projectId: input.projectId }
        : booted.spawnContext?.projectId !== undefined
          ? { projectId: booted.spawnContext.projectId }
          : {}),
      ...(isChild ? { resumable: true, agentRole: input.agentRole ?? "subagent" } : {}),
      ...(recorder !== undefined ? { liveTranscript: recorder } : {}),
    });
  } finally {
    ledger.close();
  }

  // T100, granularity 3: the free mechanical gate, run once per session after
  // the row is closed. It costs zero tokens, and it cannot record a success
  // that no command produced — `cli/verify.ts`'s `runVerify()` remains the
  // one writer, and `outcome_source` is `verification_command` because an
  // exit code decided. A child session is not gated: its parent's gate covers
  // the task, and a subagent running the whole test suite per spawn is how a
  // pack of specialists becomes unusable.
  let gateGreen = false;
  let gateOutcome: GateOutcome | undefined;
  if (!isChild && runState === "done") {
    const changedPaths = sessionChangedPaths(toolCwd, booted.bootArtifacts.gitHeadAtBoot);
    const gate = await runSessionGate({
      policy: resolveSessionGatePolicy(),
      sessionId,
      ledgerPath,
      edited: sessionEditedFiles(state.toolCalls),
      editedFiles: sessionEditedPaths(state.toolCalls, changedPaths),
      // P10.9 (ticket 21, D2): `verification_verdict` fires inside
      // `runSessionGate`, which is where the outcome exists.
      events: booted.extensionHost.sink,
      executor: booted.executor,
      extensionHost: booted.extensionHost,
      startCommit: booted.bootArtifacts.gitHeadAtBoot,
      specialist: booted.extensionHost.getSpecialist(),
    });
    gateOutcome = gate;
    gateGreen = gate.status === "recorded" && gate.outcome === "success";
    if (gate.status === "recorded") stderrWrite(`${renderGateOutcome(gate)}\n`);
  }

  // P4 T149: `session_end`, after the gate, then the extensions' counters to
  // the ledger. The reviewer (`lykos-reviewer`) runs from here now.
  await endExtensionSession(booted, {
    cwd: toolCwd,
    ledgerPath,
    sessionId,
    isChild,
    model: `${model.provider}/${model.id}`,
    state: runState,
    edited: sessionEditedFiles(state.toolCalls),
    ...(gateOutcome !== undefined ? { gateOutcome } : {}),
    ...(!isChild ? { report: (text: string) => stderrWrite(`${text}\n`) } : {}),
  });

  // T173: the container goes last, after the gate and the extensions that ran commands in it. It used to be
  // removed before the gate, so the gate's test command ran in a container that was already gone; a stand-in
  // runtime does not notice, a real one does (T176).
  await containment?.dispose();

  if (!isChild && runState === "done" && booted.contextStrategy.active === "continue") {
    const predecessorDir = transcriptDir(ledgerPath, sessionId);
    const persistedTaskList = readTaskListFile(predecessorDir);
    const persistedTaskState = resumeTaskListState(persistedTaskList);
    const decision = decideContinuation({
      // T150: continuation is the active strategy, or this block is never reached.
      enabled: booted.contextStrategy.active === "continue",
      thresholdReached: booted.continuationState.requested,
      openItems: persistedTaskList !== null && hasOpenItems(persistedTaskState),
      gateGreen,
      continuationsUsed: input.continuation?.index ?? 0,
      cap: config.continuation.max,
      fileChanged: gitStatus(toolCwd) !== booted.continuationState.gitStatusAtBoot,
      taskListMoved: booted.taskList.version > booted.continuationState.taskListVersionAtBoot,
    });
    if (decision.action === "continue") {
      const checkpoint = listCheckpoints({ cwd: toolCwd })[0];
      const gatePolicy = resolveSessionGatePolicy();
      const next = await openLedger(ledgerPath);
      let taskId: string | undefined;
      let projectId: string | undefined;
      try {
        const identity = next.db
          .prepare(`SELECT task_id, project_id FROM sessions WHERE id = ?`)
          .get(sessionId) as { task_id: string | null; project_id: string | null } | undefined;
        taskId = identity?.task_id ?? input.taskId;
        projectId = identity?.project_id ?? input.projectId;
      } finally {
        next.close();
      }
      const continuationIndex = (input.continuation?.index ?? 0) + 1;
      const prompt = buildContinuationPrompt({
        predecessorSessionId: sessionId,
        continuationIndex,
        taskListPath: join(predecessorDir, "tasks.json"),
        taskList: persistedTaskState,
        checkpointRef: "refs/lykos/checkpoints",
        ...(checkpoint !== undefined ? { checkpointCommit: checkpoint.commit } : {}),
        ...(gatePolicy.command !== undefined ? { verificationCommand: gatePolicy.command } : {}),
        contextFiles: booted.frozenContextFiles.map((file) => ({ path: file.path, bytes: file.bytes })),
        originalPrompt: input.continuation?.originalPrompt ?? input.prompt,
      });
      stderrWrite(
        `lykos: context boundary reached; starting continuation ${continuationIndex}/${config.continuation.max} from disk\n`,
      );
      return runStandaloneTask({
        ...input,
        prompt,
        ...(taskId !== undefined ? { taskId } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
        continuation: {
          predecessorSessionId: sessionId,
          index: continuationIndex,
          prompt,
          originalPrompt: input.continuation?.originalPrompt ?? input.prompt,
        },
      });
    }
  }

  // T147 (D25): a declared extension that failed to load, register or run is
  // said out loud here too, as the interactive surface already does — the
  // standalone shape used to count and never print.
  const extensionNotice = extensionFailureNotice(booted.extensionHost.counters);
  if (extensionNotice !== undefined) stderrWrite(`${extensionNotice}
`);

  const deniedList: DeniedAction[] =
    denied ?? ((gate && "denied" in gate && Array.isArray((gate as any).denied)) ? (gate as any).denied : []);
  const deniedOut = deniedList.length > 0 ? { denied: deniedList } : {};

  if (skippedExtensions.length > 0) {
    const priorMeta = readSessionMeta(ledgerPath, sessionId);
    if (priorMeta && (!priorMeta.withheld || priorMeta.withheld.length !== skippedExtensions.length)) {
      writeSessionMeta(ledgerPath, { ...priorMeta, withheld: skippedExtensions });
    }
  }

  if (runState === "error") {
    return {
      status: "error",
      message: sawError ?? "standalone session ended in error",
      sessionId,
      ...(containment !== undefined ? { containment: containment.record } : {}),
      ...deniedOut,
    };
  }
  return {
    status: "ok",
    sessionId,
    text: state.lastText || undefined,
    snapshot,
    ...(containment !== undefined ? { containment: containment.record } : {}),
    ...(skippedExtensions.length > 0 ? { skippedExtensions } : {}),
    ...deniedOut,
  };
}
