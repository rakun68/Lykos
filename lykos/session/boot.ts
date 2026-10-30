// Boot: configuration becomes a running session.
//
// Everything that turns ResolvedConfig into a live AgentSession — tool
// surface assembly (as a caller of `tools/`), ledger wiring, the head-block
// contract, the resume contract, `customTools` composition — sits behind
// `boot(config)`. Feature flags are read here, once. The one-shot driver
// (`session/session.ts`) holds the session; the interactive loop
// (`session/interactive.ts`) drives it; neither assembles it.

import type { WorkTree } from "./session.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { isStoreTrusted, type TrustSource } from "../gate/trust.js";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  TASK_LIST_TOOL_NAME,
  applyToolDeltas,
  loadTools,
  newAskState,
  newPeerFamily,
  newPlanState,
  newTaskListState,
  readTaskListFile,
  canonicalToolName,
  resolveStandaloneTools,
  resumeTaskListState,
  writeTaskListFile,
  type AskHuman,
  type AskState,
  type EvalRuntimePool,
  type JobRegistry,
  type LspServerPool,
  type PeerMailbox,
  type PlanState,
  type SpawnContext,
  type TaskItemVerifier,
  type TaskListState,
} from "../tools.js";
import {
  appendPostEditRun,
  createCommandRunner,
  newPostEditState,
  resolvePostEditPolicy,
  type PostEditPolicy,
  type PostEditState,
} from "../loop/post-edit.js";
import { buildTaskVerifier } from "../gate/verify-gate.js";
import { gitStateNotice, probeGit, type GitState } from "../git/host-git.js";
import { localExecutor, type ProjectExecutor } from "../tools/executor.js";
import type { CommitLog } from "../tools/commit.js";
import type { ContainmentRecord } from "../containment/containment.js";
import type { ContainerRuntimeDriver } from "../containment/runtime.js";
import {
  builtinHooks,
  createHookCommandRunner,
  HookRegistry,
  hookRejectionNotice,
  resolveHookDecls,
  type HookDecl,
} from "../loop/hooks.js";
import type { InteractionMode } from "../gate/modes.js";
import {
  type Coordinator,
  COORDINATOR_ASK_TOOL_NAME,
  COORDINATOR_GIVE_UP_TOOL_NAME,
} from "../tools/coordinator.js";
import {
  capSkills,
  filterSkillsByRoster,
  newSkillInvocationState,
  resolveLoadedSkills,
  resolveSkillsPolicy,
  skillsCapNotice,
  skillsHeadCost,
  type SkillInvocationState,
  type SkillLike,
} from "./skills.js";
import { formatPlanAgainstSkillBlock, isLeanHead, shouldDropPlanAgainstSkill, type LeanHeadPredicateOpts } from "./plan-against-skill.js";
export { isLeanHead, shouldDropPlanAgainstSkill, type LeanHeadPredicateOpts };
import type {
  FeedbackConfig,
  LspServerDecl,
  ProvidersConfig,
  ResolvedConfig,
  SkillsConfig,
  ThinkingLevel,
} from "../config/types.js";
import { parseProviderModel } from "../ledger/ingest.js";
import { recordSessionCommits, recordSessionPrunes } from "../ledger/use.js";
import { resolveCallAccounting } from "../config/providers.js";
import { AutoApproveGate, DenialLog, ReadOnlyGate, unwrapGate, type ApprovalGate, type ReadOnlyPosture } from "../gate/approval.js";
import { SubagentGate } from "../gate/delegated.js";
import { LykosExtensionHost, gateWithExtensionEvents } from "../extensions/api.js";
import { loadLykosExtensions } from "../extensions/load.js";
import { encodeReviewerPolicyEnv, REVIEWER_POLICY_ENV, type ReviewerPolicy } from "../extensions/defaults/reviewer-policy.js";
import { assembleBootHead, assembleIdentityHead, HeadContract, type BootArtifacts } from "./head-contract.js";
import {
  assembleDietHead,
  assembleOutputDietHead,
  contextFileMeta,
  dietEnabledFromEnv,
  ingestContextFiles,
  outputDietEnabledFromEnv,
  toolResultMaxBytesFromEnv,
  toAgentsFiles,
  type ContextFile,
} from "../loop/prompt-diet.js";
import {
  createHarnessExtension,
  newHarnessObservation,
  type HarnessObservation,
} from "../loop/harness-extension.js";
import { encodePrunePolicyEnv, PRUNE_ENTRY_TYPE, PRUNE_POLICY_ENV, pruneNotice, pruneRowFromEntry } from "../loop/tool-result-prune.js";
import {
  CONTINUATION_POLICY_ENV,
  continuationFromEntries,
  DEFAULT_COMPACTION_THRESHOLD,
  encodeContinuationPolicyEnv,
} from "../loop/continuation.js";
import { COMPACTION_METHODS, parseMethodOrder } from "../loop/compaction-chain.js";
import { resolveContextStrategy, type ResolvedContextStrategy } from "../loop/context-strategy.js";
import {
  encodeSelfCompactPolicyEnv,
  formatTokens,
  resolveSelfCompact,
  parseSelfCompactRecords,
  SELF_COMPACT_ENTRY_TYPE,
  SELF_COMPACT_POLICY_ENV,
  SELF_COMPACT_RECORD_FILE,
  SelfCompactConfigError,
  selfCompactRecordsFromEntries,
  unfinishedHandoff,
  validateSelfCompactConfig,
  type SelfCompactPolicy,
  type SelfCompactRecord,
} from "../loop/self-compact.js";
import {
  withoutHashlineEdit,
  hostExtensionNotice,
  LYKOS_EXTENSIONS_KEY,
  resolveExtensions,
  resolveHostExtensions,
  type HostExtensionResolution,
  type ResolvedExtension,
  encodeSpecialistOffLimitsEnv,
  encodeRegistryOffToolsEnv,
  REGISTRY_OFF_TOOLS_ENV,
  DEFAULT_REGISTRY_OFF_TOOLS,
} from "../config/extensions.js";
import { piHostDir } from "../config/pi-host.js";
import { gitHeadOnce } from "./head-view.js";
import { buildMemoryHead, resolveMemoryPolicy, type MemoryHead, type MemoryHeadPolicy } from "./memory-head.js";
import { assemblePonytailHead, resolvePonytailAndSpecialistHeads, resolveSpecialistOverrideHeads } from "./ponytail-head.js";
import { specialistStreamMessage } from "./specialist-stream.js";
import { isInteractionMode, MODE_INFO } from "../gate/modes.js";
import { applySpecialist, type SpecialistApplication, type SpecialistContext, type SpecialistFields } from "./specialist-apply.js";
import { assembleMountedCatalogHead } from "./mounted-catalog-head.js";
import { DEFAULT_SPECIALIST } from "../config/specialists.js";
import {
  SPECIALIST_NAME_ENV,
  SPECIALIST_OFF_LIMITS_ENV,
  SPECIALIST_ALLOWED_ENV,
  setGuardDenialLog,
} from "../tools/specialist-guard-extension.js";
import {
  encodeRepoMapPolicyEnv,
  REPO_MAP_POLICY_ENV,
  repoMapFromEntries,
  resolveRepoMapPolicy,
  type RepoMap,
  type RepoMapPolicy,
} from "../context/repo-map.js";
import { stderrWrite } from "../tui/io-mode.js";
import { LiveTranscriptRecorder } from "./live-capture.js";
import { readSessionMeta, transcriptDir, type SessionResumeContract } from "./transcript.js";
import { currentGitCommit, gitStatus, isGitDirty } from "./identity.js";
import { currentPriceTable } from "../ledger/prices.js";
import { AUTO_SEARCH_PROVIDER, resolveAutoSearchKeys, resolveSearchApiKey, type SearchBackendKeys } from "../tools/web-search.js";
import { assembleOutputStyleHead, resolveOutputStyle } from "../config/output-styles.js";
import { homedir } from "node:os";

/**
 * T86: the model's context window, if the registry knows it. Never guesses:
 * an unknown window disables the budget notice rather than inventing a size.
 */
export function contextWindowOf(model: unknown): number {
  const m = model as { contextWindow?: unknown; context_window?: unknown; limits?: { context?: unknown } };
  for (const candidate of [m?.contextWindow, m?.context_window, m?.limits?.context]) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return Math.floor(candidate);
    }
  }
  return 0;
}

/**
 * T33.3: the injection site, built from the single-source head functions.
 * Exported so the parity test can
 * assert the override is built FROM those functions without spawning a
 * real session.
 */
export function buildAppendSystemPromptOverride(
  bootArtifacts: BootArtifacts,
  opts: {
    promptDietEnabled: boolean;
    outputDietEnabled: boolean;
    memoryHead?: string;
    /** Specialists ticket 01: `ResolvedConfig.instructions`, already merged. */
    specialistInstructions?: string;
    /**
     * Specialists band 2 ticket 01: the resolved specialist's own fields, forwarded
     * WHOLE to `applySpecialist`. There is deliberately no `prompt_mode` option
     * beside this one: what a specialist means is decided in one place, and a
     * second spelling here would be this file deciding it again. Anything the seam
     * may need to answer with belongs inside this object, including the fields
     * later tickets read (`tools_mode`, `provider`, `model`).
     */
    specialist?: SpecialistFields;
    /**
     * Specialists band 2 ticket 02: the tool names the specialist's own resolution
     * arrived at. Only read on the fallback path below — `assembleSession` passes a
     * fully-built `app` and this is ignored there. Without it a direct caller such
     * as `lykos prompt --show` assembles a prompt with no off-limits block for a
     * specialist that does restrict tools, and so shows a head the session will
     * never produce.
     */
    specialistToolNames?: readonly string[];
    specialistName?: string;
    /** Specialists ticket 06: the plan-against-skill block, empty when no skills loaded. */
    planAgainstSkillHead?: string;
    /** Specialists ticket 02: the specialist application result, when precomputed. */
    app?: SpecialistApplication;
    /** Specialists ticket 04: the specialist context (session-start | switch | subagent). */
    specialistContext?: SpecialistContext;
    /**
     * T154: the session's final tool list, read when the head is rendered —
     * which, in a session, is while Pi's resource loader reloads, after every
     * extension has registered. Absent, the head states `bootArtifacts.toolNames`
     * (`lykos prompt --show`, which boots no session).
     */
    finalToolNames?: () => readonly string[];
    /** T217: output style instructions text. Omitted or empty adds no output style head block. */
    outputStyleText?: string;
    /** T215: neutral head for human-driven sessions. Omit specialist blocks and off-limits notices. */
    neutralHead?: boolean | undefined;
    /** T227: whether the session is delegated. */
    delegated?: boolean | undefined;
    /** T227: resolved skills configuration (including specialist roster). */
    skills?: SkillsConfig | undefined;
  },
): (base: string[]) => string[] {
  const headOf = (): string =>
    assembleBootHead(
      opts.finalToolNames !== undefined ? { ...bootArtifacts, toolNames: [...opts.finalToolNames()] } : bootArtifacts,
    );
  const identityHead = assembleIdentityHead();
  const dietHead = assembleDietHead();
  const outputDietHead = assembleOutputDietHead();
  // P10.2: the mounted catalog is registry-derived and stable for the
  // session. It sits after the diet blocks and before memory — frozen
  // content, not file-backed — so a heading with no named/full mounted
  // tools appends nothing.
  const mountedCatalogHead = assembleMountedCatalogHead();
  // T65: the memory block is a plain string computed once by the caller and
  // closed over here, exactly like every other block. It goes LAST, after the
  // rules, because it is content rather than instruction — and because a
  // block whose bytes change when the maintainer edits a file is the one
  // most likely to move, and the tail of the head is the cheapest place for
  // that. Empty string means nothing was injected and nothing is appended:
  // a heading with no entries would spend tokens to say nothing.
  const memoryHead = opts.memoryHead ?? "";
  // Specialists ticket 03 (spec: "The ponytail ruleset as the default" /
  // "Where a specialist's instructions enter the system prompt"): every session
  // gets the ponytail block, unconditionally — no LYKOS_*=0 opt-out, unlike
  // every block above. A specialist's `instructions` either appends after it
  // (default) or replaces its content entirely (the `PONYTAIL_REPLACE_MARKER`
  // convention — see `ponytail-head.ts`), decided once here so `head-view.ts`
  // cannot compute a different answer for the same config.
  const specialistInstructions = opts.specialist?.instructions ?? opts.specialistInstructions;
  const specialistName = opts.specialistName;
  const hasSpecialist =
    specialistInstructions !== undefined || opts.specialist !== undefined || specialistName !== undefined;

  // The seam gets every field, not the two this file happens to use today: a
  // partial input makes `applySpecialist` answer a question it was not shown,
  // and the answer it would get wrong first is the delegate's model.
  const app =
    opts.app ??
    applySpecialist({
    ...(specialistName !== undefined ? { name: specialistName } : {}),
    ...(hasSpecialist
      ? {
          specialist: {
            ...opts.specialist,
            ...(specialistInstructions !== undefined ? { instructions: specialistInstructions } : {}),
          },
        }
      : {}),
    context: opts.specialistContext ?? "session-start",
    defaultToolNames: [...bootArtifacts.toolNames],
    ...(opts.specialistToolNames !== undefined ? { specialistToolNames: [...opts.specialistToolNames] } : {}),
  });

  const neutralHead = opts.neutralHead === true;
  const { ponytail: ponytailHead, specialist: specialistHead } = neutralHead
    ? { ponytail: assemblePonytailHead(), specialist: "" }
    : app.replacesDefaultHead
      ? resolveSpecialistOverrideHeads(specialistInstructions)
      : resolvePonytailAndSpecialistHeads(specialistInstructions);
  // Specialists ticket 06 / T227: the plan-against-skill block sits after ponytail and
  // before the specialist block — guidance that is more specific than the
  // default ladder, but the specialist's own text stays the last word.
  // Dropped whole in a lean head unless opted in via skills.roster.
  const dropPlan = shouldDropPlanAgainstSkill({
    neutralHead,
    delegated: opts.delegated,
    specialistContext: opts.specialistContext,
    skills: opts.skills,
  });
  const planAgainstSkillHead = dropPlan ? "" : (opts.planAgainstSkillHead ?? "");
  const outputStyleHead =
    opts.outputStyleText && opts.outputStyleText.trim().length > 0
      ? assembleOutputStyleHead(opts.outputStyleText)
      : "";
  return (base: string[]) => {
    const parts = [...base, headOf(), identityHead];
    if (opts.promptDietEnabled) parts.push(dietHead);
    if (opts.outputDietEnabled) parts.push(outputDietHead);
    if (mountedCatalogHead.length > 0) parts.push(mountedCatalogHead);
    if (memoryHead.length > 0) parts.push(memoryHead);
    if (ponytailHead.length > 0) parts.push(ponytailHead);
    if (planAgainstSkillHead.length > 0) parts.push(planAgainstSkillHead);
    if (specialistHead.length > 0 && !neutralHead) parts.push(specialistHead);
    if (outputStyleHead.length > 0) parts.push(outputStyleHead);
    if (app.offLimitsPromptPart && !neutralHead) parts.push(app.offLimitsPromptPart);
    return parts;
  };
}

export interface BootedStandaloneSession {
  session: AgentSession;
  headContract: HeadContract;
  /** T84: live clamp counters, mutated by the harness extension all session. */
  harnessObservation: HarnessObservation;
  /** T87: refusals this session — declined by the human, or outside the root. */
  denials: DenialLog;
  /**
   * P10.4 (ticket 15, D5): this session's language servers.
   *
   * Carried here rather than owned by the tool because the SESSION owns the
   * lifecycle: the pool starts a server lazily on the first `lsp` call and
   * `finishStandaloneSession` / `finishInteractiveSession` call
   * `shutdownAll()` beside `session.dispose()`. A language server that
   * outlives its session is a process the user has to find and kill by hand,
   * so there is exactly one place that ends them and it is the same place
   * that ends everything else.
   */
  lsp: LspServerPool;
  /**
   * P10.5 (ticket 16, D6): this session's background jobs.
   *
   * Carried here for the reason `lsp` above it is, and killed in the same two
   * places: `finishStandaloneSession` / `finishInteractiveSession` call
   * `stopAll()` beside `session.dispose()`. A background job that outlives its
   * session is an orphan nobody will ever stop — the user does not know its
   * pid and the next session does not know it exists — so there is exactly one
   * place that ends them and it is the same place that ends everything else.
   */
  jobs: JobRegistry;
  /**
   * T172: where this session's project commands run. The post-edit check, the
   * gate's test command and its rerun, shell hooks, `bash`, `powershell`,
   * `eval` and background jobs all start their process through it; the caller
   * that runs the gate at session end reads it from here so the gate's command
   * runs in the same place the model's did.
   */
  executor: ProjectExecutor;
  /**
   * T173: what this session asked of containment and what it got, for the
   * ledger and `lykos show`. Absent for a child, whose commands run wherever
   * its parent's do.
   */
  containment?: ContainmentRecord;
  /** T219: items withheld from an untrusted project. */
  withheld?: string[];
  /**
   * P10.6 (ticket 19, D5): this session's evaluation runtimes.
   *
   * Carried here for the reason `jobs` above it is, and killed in the same two
   * places: `finishStandaloneSession` / `finishInteractiveSession` call
   * `disposeAll()` beside `session.dispose()`. A runtime that outlived its
   * session would be a Node process holding the user's variables that nobody
   * knows the pid of — and unlike a background job it was never printed, so
   * there would be nothing in the transcript to find it by.
   */
  evalRuntimes: EvalRuntimePool;
  /**
   * P10.5 (ticket 17, D2): this session's seat on its family's peer bus.
   *
   * Carried here for the reason `jobs` above it is, and given up in the same
   * two places: `finishStandaloneSession` / `finishInteractiveSession` call
   * `leave()` beside `session.dispose()`. An agent that stayed on the roster
   * after it finished is a name every later `send` fails against, and `list`
   * would be naming peers that cannot answer.
   */
  mailbox: PeerMailbox;
  /**
   * T99: the post-edit feedback loop's policy and live counters. The policy
   * says what would run; the state says what actually did, including whether
   * the loop switched itself off. Both travel to the snapshot, because "the
   * loop was on and never ran" and "the loop ran and found nothing" are
   * different answers and only these two together tell them apart.
   */
  postEditPolicy: PostEditPolicy;
  postEditState: PostEditState;
  /**
   * T102: what the head actually offers, what it cost, and what the session
   * went on to read. `available` is the denominator §2.5 asks for — a skill
   * never invoked is store pressure, and that cannot be seen without knowing
   * how many were on offer.
   */
  skills: { roster: SkillLike[]; headTokens: number; invocation: SkillInvocationState };
  /**
   * T109: set when the measured context threshold stopped this session. T150:
   * the threshold watch is the `lykos-continuation` default extension, so the
   * crossing fields READ the entry that extension recorded.
   */
  continuationState: {
    readonly requested: boolean;
    readonly tokens: number | undefined;
    readonly contextWindow: number | undefined;
    taskListVersionAtBoot: number;
    gitStatusAtBoot: string | undefined;
  };
  /** T150: the one context strategy running in this session, and why, when it is not the declared one. */
  contextStrategy: ResolvedContextStrategy;
  /** T103: questions asked, answered, and fallen back on. Zeroes on a session with no human. */
  askState: AskState;
  /** T131: plans presented, accepted, declined, and misfired. Zeroes on a session with no human. */
  planState: PlanState;
  /** T105: the hook surface in force, and what it did. */
  hooks: HookRegistry;
  /**
   * P10.9 (ticket 21): this session's Lykos extension host — the event bus the
   * nine events fire into, the tools and slash commands extensions
   * registered, and the failure ledger `extensionFailureNotice` reads.
   *
   * One per session, never module-level: a second session in one process would
   * otherwise inherit the first one's handlers and the counters would describe
   * neither.
   */
  extensionHost: LykosExtensionHost;
  /** T103/T53: filled by `startLiveCapture()` so an answered question reaches the transcript. */
  answerSink: { record?: (question: string, answer: string) => void };
  /**
   * T98: the session's own task list. Present whether or not the tool is on
   * the surface — an empty list with zero calls is the honest reading of
   * "the tool was available and never used", and is exactly the counter
   * Phase 12 §0 asks every item to ship with.
   */
  taskList: TaskListState;
  /**
   * T98: where a changed list is written. Set by `startLiveCapture()`, which
   * is the first place that knows both the ledger path and the session id —
   * the same shape as T85's abort holder, and for the same reason: the thing
   * that owns the file does not exist yet when the tool is built.
   */
  taskListSink: { write?: (state: TaskListState) => void };
  bootArtifacts: BootArtifacts;
  /** T170: whether git could be used at boot — `repo`, `not-a-repo` or `git-missing`. */
  gitState: GitState;
  promptDietEnabled: boolean;
  outputDietEnabled: boolean;
  /** T65: what memory this session froze into its head, and what it cost. */
  memoryHead: MemoryHead;
  /**
   * T69: the repo map in this session's prompt, and what it cost. T148: added
   * by the `lykos-repo-map` default extension, so this READS the entry that
   * extension recorded; an empty, disabled map when it added none.
   */
  readonly repoMap: RepoMap;
  /**
   * T152: what `lykos-self-compact` recorded in this session — each handoff's
   * phases and each compaction attempt — read from the session's entries
   * whenever asked. The compaction records become the ledger's `compactions`
   * rows at the session's end (`endExtensionSession`). Empty under any other
   * strategy. Optional so a stubbed booted session need not carry it.
   */
  readonly selfCompactRecords?: SelfCompactRecord[];
  /**
   * T179: the commits this session made through `commit`. Each is written to the
   * ledger's `commits` table when it is made (the `onCommit` sink); the session's
   * end (`endExtensionSession`) repeats the log as an idempotent backstop.
   * Optional so a stubbed booted session need not carry it.
   */
  readonly commits?: CommitLog;
  /**
   * T97.2: which declared extensions this session actually loaded on this
   * host, and which were declared but absent. The `missing` half is the one
   * that matters: it is how a session says "you asked for hashline and it is
   * not installed here" instead of running silently without it.
   */
  hostExtensions: HostExtensionResolution;
  /**
   * T147 (D25): the same answer for `lykos_extensions:` — which declared Lykos
   * extensions were present on this host (and handed to `extensionHost`), and
   * which were declared but absent. One that was present and failed to load is
   * in `extensionHost.counters`, not here.
   */
  lykosExtensions: HostExtensionResolution;
  frozenContextFiles: ContextFile[];
  startedAt: string;
  /**
   * Names of whatever `resourceLoader.getSkills()` actually found — the
   * same skill directories (project + `agentDir`, honestly whatever Pi's
   * own default discovery resolves, e.g. `<pi-host>/skills`, ADR-0027) a bare
   * `pi` session would list at startup. Surfaced for the UI's resources
   * panel — real data, not a guess, since `noSkills` is never set on this
   * session's `DefaultResourceLoader` when skills are enabled.
   */
  skillNames: string[];
  /** T131: what `setSkillCommands()` registers, so `/handoff` completes and dispatches. */
  skillRoster: SkillLike[];
  /** T39: present when this session may spawn children via Agent. */
  spawnContext?: SpawnContext;
  /**
   * T54: the boot block's own fingerprint, as `HeadContract.boot()` returned
   * it. Surfaced rather than recomputed so `meta.json` records the head this
   * session actually booted with — a second `fingerprintHead()` call is a
   * second thing that can drift.
   */
  bootFingerprint: string;
  /** Specialists ticket 01: the selected specialist's name, or undefined when none was selected. */
  specialistName?: string;
  /** T214 (ADR-0043): the read-only posture for live interactive switching. */
  readOnlyPosture?: ReadOnlyPosture;
  /** T215: stream message to send with the first user turn when neutralHead is true. */
  specialistMessage?: string;
}

/**
 * What `boot` needs that is not in ResolvedConfig: the workspace, the
 * already-resolved model (callers still resolve it — the loop uses the
 * runtime for mid-session switches), the gate, and the human channel.
 * Feature flags are NOT here; they come off `config`.
 */
export interface BootConfig {
  cwd: string;
  /**
   * T184: where the project's own `.lykos/` state lives (memory, proposals, jobs, scan records) when `cwd` is a
   * worktree. Absent, it is `cwd`. A worktree is removed with the call, so state written there would be lost.
   */
  stateRoot?: string;
  /** T184: the worktree `cwd` is, when it is one. Agents this session spawns work on it and keep their state at `stateRoot`. */
  workTree?: WorkTree;

  config: ResolvedConfig;
  model: NonNullable<NonNullable<Parameters<typeof createAgentSession>[0]>["model"]>;
  modelRuntime: ModelRuntime;
  gate: ApprovalGate;
  ledgerPath: string;
  modelSpec: string;
  /** Caller override. Unset → the standalone surface, with the loader flag applied. */
  tools?: readonly string[];
  subagents?: boolean;
  isChild?: boolean;
  autoApprove?: boolean;
  parentBrief?: string;
  taskId?: string;
  projectId?: string;
  /**
   * P10.5 (ticket 17, D2): the seat on an existing session family's peer bus,
   * passed by the `Agent` call that spawned this session. Absent on a session
   * nobody spawned, which then mints a family of one.
   */
  mailbox?: PeerMailbox;
  askHuman?: AskHuman;
  coordinator?: Coordinator;
  requestPlanExit?: (plan: string) => Promise<InteractionMode | null>;
  currentMode?: () => InteractionMode;
  interactionMode?: InteractionMode;
  /** Whether the read-only posture is still on; `exit_plan` only acts while it is. */
  isPlanning?: () => boolean;
  resumeTaskListFrom?: string;
  sessionIdOverride?: string;
  /**
   * T152: a resumed session's predecessor directory. An unfinished
   * self-compact handoff recorded there (`self-compact.jsonl`) is re-appended
   * to the new session's entries before its first turn, so the handoff
   * finishes instead of being repeated or lost (spec story 58).
   */
  resumeHandoffFrom?: string;
  /** T104: turn checkpoints. Default on inside a git repository. */
  checkpoints?: boolean;
  taskVerifier?: TaskItemVerifier;
  /** T172: where project commands run. Absent means this machine. */
  executor?: ProjectExecutor;
  /** T173: how `executor` came to be, recorded and shown. See `BootedStandaloneSession.containment`. */
  containment?: ContainmentRecord;
  /** T219: items withheld from an untrusted project. */
  withheld?: readonly string[];
  /** T182: the runtimes a child this session spawns may start its own container on. Tests only; absent means the machine's. */
  containmentDrivers?: readonly ContainerRuntimeDriver[];
  /** Used with `config.continuation` to decide whether the threshold fires. */
  continuationIndex?: number;
  /**
   * Specialists ticket 01: the name the caller selected with `--specialist`, for
   * the session record only (`sessions.specialist`). `config.instructions` is
   * what actually reaches the prompt — this is carried separately because a
   * specialist file's own `instructions` value is not itself an identifier, and
   * a project's `config.yaml` can set `instructions` directly with no
   * specialist selected at all.
   */
  specialistName?: string;
  /** Specialists band 2 ticket 01: the specialist's own fields, forwarded to the seam. */
  specialist?: SpecialistFields;
  /** Specialists ticket 04: explicit context for applySpecialist ('session-start' | 'subagent'). */
  specialistContext?: SpecialistContext;
  /**
   * P4 T149: a READ-ONLY child session — what an extension's
   * `runChildSession` gets. Enforced in layers, each of which alone would
   * stop a write: the tool list is cut to `READ_ONLY_CHILD_TOOLS`; the gate is
   * `ReadOnlyGate` whatever the caller passed (so `--yes` cannot widen it);
   * the harness blocks any call that changes a file or is not declared
   * `read`; and no checkpoints are taken, since nothing may change.
   */
  readOnly?: boolean;
  /**
   * T117/T171: how the CLI crossed the trust boundary. Only `stored` and `prompt`
   * (the user-level trust store) trust the project for `lsp`; `flag` or absent
   * (a library caller, a test) means `lsp` will not start a server binary that
   * lives inside the workspace.
   */
  trustSource?: TrustSource;
  /**
   * T183: false tells Pi the project is not trusted, so it reads no project `.pi/settings.json` and a `packages`
   * entry there can neither be resolved nor installed (`package-manager.js` runs `npm install` or `git clone`
   * for a listed package, even under `noExtensions`). Absent means Pi's default, trusted.
   */
  piProjectTrusted?: boolean;
  /** T217: output style text override. Absent derives from config.output_style. */
  outputStyleText?: string;
  /** T217: global directory for config / output styles. Defaults to ~/.lykos. */
  globalDir?: string;
  /** T215: neutral head for human-driven sessions. Specialist text and mode go in the stream. */
  neutralHead?: boolean;
  /** Spec story 47: whether the session is delegated. */
  delegated?: boolean;
}

/**
 * P4 T149: the whole surface of a read-only child. Pi's own read-only agent
 * (`examples/extensions/subagent/agents/planner.md`) carries exactly these
 * four; its reviewer adds `bash`, which can write, so Lykos's does not.
 */
export const READ_ONLY_CHILD_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

function readOnlyTools(names: readonly string[]): string[] {
  return names.filter((n) => READ_ONLY_CHILD_TOOLS.includes(canonicalToolName(n)));
}

/**
 * T161: TESTS ONLY. Opens one layer of a read-only child so the next layer
 * can be proven against a real call. `extraTools` joins the child's tool list
 * (e.g. `write`), and `bypass` switches one of the two call-time layers off —
 * `harness` leaves the gate to refuse, `gate` leaves the harness to. It lives
 * on `BootDeps`, which only test code constructs: no configuration key, CLI
 * flag or extension API reaches it, and it has no effect on a session that
 * is not read-only.
 */
export interface ReadOnlyChildTestOverride {
  extraTools: readonly string[];
  bypass: "gate" | "harness";
}

/**
 * T154: the tools Pi defines itself (`createAllToolDefinitions` in the
 * installed Pi, read at source for 0.84.3). Lykos shadows most of them with
 * gated definitions of the same name; any it does not shadow is still Pi's.
 */
export const PI_BASE_TOOL_NAMES: readonly string[] = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

/** T154: every tool the loaded Pi extensions registered, by name. Read after the resource loader has loaded them. */
export function piExtensionToolNames(loader: { getExtensions(): { extensions: ReadonlyArray<{ tools: ReadonlyMap<string, unknown> }> } }): string[] {
  return loader.getExtensions().extensions.flatMap((e) => [...e.tools.keys()]);
}

/** Tests substitute `createAgentSession` so boot is unit-testable with no TTY and no model call. */
export interface BootDeps {
  createSession?: typeof createAgentSession;
  /** T161: see `ReadOnlyChildTestOverride`. Tests only. */
  readOnlyChildTest?: ReadOnlyChildTestOverride;
}

interface AssembleOpts {
  cwd: string;
  /**
   * T184: where the project's own `.lykos/` state lives (memory, proposals, jobs, scan records) when `cwd` is a
   * worktree. Absent, it is `cwd`. A worktree is removed with the call, so state written there would be lost.
   */
  stateRoot?: string;

  /** T179: where `commit` writes each commit the moment it is made. */
  ledgerPath: string;
  model: BootConfig["model"];
  modelRuntime: ModelRuntime;
  toolNames: string[];
  gate: ApprovalGate;
  memory?: MemoryHeadPolicy;
  repoMap?: RepoMapPolicy;
  extensions?: readonly ResolvedExtension[];
  /** T147 (D25): the resolved `lykos_extensions:` block. */
  lykosExtensions?: readonly ResolvedExtension[];
  feedback?: FeedbackConfig;
  skills?: SkillsConfig;
  /** P10.4 (ticket 15): the resolved `lsp.servers` table. Absent means the shipped default. */
  lspServers?: Record<string, LspServerDecl>;
  /** T171: whether the project is trusted; gates a workspace-local language server. */
  workspaceTrusted?: boolean;
  /** T183: false makes Pi ignore the project's `.pi/settings.json`. See `BootConfig.piProjectTrusted`. */
  piProjectTrusted?: boolean;
  /** P10.6 (ticket 19, D6): the resolved `eval.python` interpreter. Absent or empty means Python is unconfigured, which is the shipped default. */
  evalPython?: string;
  /** T168 part B: the resolved `edit.require_read`. Absent means off, the shipped default. */
  editRequireRead?: boolean;
  /**
   * P10.7 (ticket 12, D2/D3): the resolved `web.search` declaration, with the
   * key already read out of the environment here rather than inside the tool.
   * Absent, or present with an empty key — which is the shipped state — is
   * what makes `web_search` answer by naming the setting.
   */
  webSearch?: { provider?: string; endpoint?: string; keyEnv?: string; apiKey?: string; keys?: SearchBackendKeys };
  checkpoints?: boolean;
  /**
   * T150: present only when the context strategy is `continue` and a successor
   * is still allowed — the policy `lykos-continuation` reads at load. Absent,
   * the extension loads inert and Pi's compaction is in charge.
   */
  continuation?: { threshold: number };
  /** T150: the resolved context strategy; its fallback note is printed once, at boot. */
  contextStrategy?: ResolvedContextStrategy;
  /** D9: `compaction.threshold`, so the context-budget notice names the same point continuation uses. */
  compactionThreshold?: number;
  /**
   * T188: `compaction.supersede_reads` and `compaction.drop_useless`, with the
   * warning for a project whose `extensions:` list leaves `lykos-prune` out.
   * Absent, nothing is pruned.
   */
  prune?: { supersedeReads: boolean; dropUseless: boolean; notice?: string };
  hooks?: readonly HookDecl[];
  askHuman?: AskHuman;
  coordinator?: Coordinator;
  requestPlanExit?: (plan: string) => Promise<InteractionMode | null>;
  currentMode?: () => InteractionMode;
  isPlanning?: () => boolean;
  resumeTaskListFrom?: string;
  taskVerifier?: TaskItemVerifier;
  /** T172: see `BootConfig.executor`. */
  executor?: ProjectExecutor;
  /** T173: see `BootConfig.containment`. */
  containment?: ContainmentRecord;
  sessionIdOverride?: string;
  /** T152: see `BootInput.resumeHandoffFrom`. */
  resumeHandoffFrom?: string;
  spawn?: Omit<SpawnContext, "parentSessionId"> & { parentSessionId?: string };
  /** P10.5 (ticket 17, D2): the seat on an existing family's bus, when a spawn handed this session one. */
  mailbox?: PeerMailbox;
  createSession?: typeof createAgentSession;
  /** Specialists ticket 01: `config.instructions`, already resolved across every layer. */
  instructions?: string;
  /** Specialists ticket 01: the selected specialist's name, for the session record. */
  specialistName?: string;
  /** Specialists ticket 02: `config.thinkingLevel`, applied to the session right after it is created. */
  thinkingLevel?: ThinkingLevel;
  /** Specialists band 2 ticket 01: the specialist's own fields, forwarded to the seam. */
  specialist?: SpecialistFields;
  /** Specialists band 2 ticket 02: the specialist's allowed tools, if restricted. */
  specialistToolNames?: string[];
  /** Specialists ticket 04: explicit context for applySpecialist ('session-start' | 'subagent'). */
  specialistContext?: SpecialistContext;
  /** P4 T149: see `BootConfig.readOnly`. */
  readOnly?: boolean;
  /** T213: when the tool list was given explicitly, resident extension tools only join if named. */
  explicitToolNames?: readonly string[];
  /** T161: tests only — see `ReadOnlyChildTestOverride`. */
  readOnlyChildTest?: ReadOnlyChildTestOverride;
  /** P4 T149: `reviewer:` from config, the setting of the `lykos-reviewer` default extension. */
  reviewer?: ReviewerPolicy;
  /**
   * T151: `lykos-self-compact`'s policy. `enabled` only when self-compact is
   * the active context strategy of a top-level session on a model whose window
   * reaches a tier; otherwise the extension loads inert and registers nothing.
   */
  selfCompact?: SelfCompactPolicy;
  /** T217: output style text. */
  outputStyleText?: string;
  /** T215: neutral head for human-driven sessions. */
  neutralHead?: boolean;
  /** T219: items withheld from an untrusted project. */
  withheld?: readonly string[];
  /** Spec story 47: whether the session is delegated. */
  delegated?: boolean;
}

export function specialistGuardExtensionPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const tsPath = join(here, "..", "tools", "specialist-guard-extension.ts");
  return existsSync(tsPath) ? tsPath : join(here, "..", "tools", "specialist-guard-extension.js");
}

/**
 * The shared boot sequence: resolve the head, the diet blocks, and the
 * approval-gated tool set, then call `createAgentSession`. Every write,
 * edit, and bash call from the resulting session goes through
 * `loadTools()` — there is no path back to Pi's raw local tools from
 * a session booted here (T34.2).
 *
 * Feature flags have already been folded in by `boot`; this is the
 * assembly those flags selected.
 */
async function assembleSession(opts: AssembleOpts): Promise<BootedStandaloneSession> {
  const { cwd, model, modelRuntime, toolNames, gate } = opts;
  const startedAt = new Date().toISOString();
  // P10.9 (ticket 21): the extension host is built FIRST, because its sink is
  // what the eight firing sites below are handed and the first of them (the
  // memory head) runs before anything else in this function.
  //
  // `denials` moved up here with it for the same reason — the host needs one
  // to hand `authorizeExtensionTool`, and it is the same log every other gated
  // call writes to rather than a second one for extension tools.
  const denials = new DenialLog();
  setGuardDenialLog(denials);
  // The gate the host hands its tools is the WRAPPED one, so an approval for
  // an extension's own tool fires `approval_decided` exactly as every other
  // approval does. The indirection is what breaks the cycle between the two:
  // `sessionGate` needs the host's sink, and the host needs a gate. The arrow
  // is not called until a tool runs, long after both exist.
  const extensionHost = new LykosExtensionHost({
    cwd,
    denials,
    gate: { request: (req) => sessionGate.request(req), denialReason: (req) => sessionGate.denialReason?.(req) },
    specialist: opts.specialistName,
    ledgerPath: opts.ledgerPath,
    ...(opts.delegated !== undefined ? { delegated: opts.delegated } : {}),
  });
  const sessionGate: ApprovalGate = gateWithExtensionEvents(gate, extensionHost.sink);
  const events = extensionHost.sink;
  // T147 (D25): the declared Lykos extensions load HERE, straight after the
  // host exists and before the first firing site (the memory head, below) or
  // the tool list is assembled — so their handlers see every event and their
  // tools reach `customTools`. Resolved against the same Pi host directory the
  // Pi list resolves against, and reported the same way when missing. A
  // package that fails to load is counted on the host and the session goes on.
  const lykosExtensions = resolveHostExtensions(opts.lykosExtensions ?? [], piHostDir(), existsSync, "lykos");
  const lykosExtensionNotice = hostExtensionNotice(lykosExtensions, "lykos extensions");
  if (lykosExtensionNotice !== undefined) stderrWrite(`${lykosExtensionNotice}
`);
  // P4 T149: `lykos-reviewer`'s setting crosses to it here, before it loads —
  // the repo map's move (`REPO_MAP_POLICY_ENV`, below), for a Lykos extension.
  process.env[REVIEWER_POLICY_ENV] = encodeReviewerPolicyEnv(opts.reviewer ?? { enabled: false, model: "" });
  await loadLykosExtensions(extensionHost, lykosExtensions.loaded);
  const bootArtifacts: BootArtifacts = {
    cwd,
    platform: process.platform,
    project: basename(cwd),
    gitHeadAtBoot: gitHeadOnce(cwd),
    toolNames,
  };
  const promptDietEnabled = dietEnabledFromEnv();
  const outputDietEnabled = outputDietEnabledFromEnv();
  const memoryHead = buildMemoryHead(
    opts.stateRoot ?? cwd,
    opts.memory ?? { enabled: false, scope: [], maxInjectTokens: 0 },
    events,
  );
  // T148: the repo map is the `lykos-repo-map` default extension, loaded by Pi
  // with the other declared extensions below. Its setting crosses to it here,
  // before the resource loader loads it; it reads the value once, at load.
  process.env[REPO_MAP_POLICY_ENV] = encodeRepoMapPolicyEnv(
    opts.repoMap ?? { enabled: false, maxTokens: 0, maxFilesPerDir: 0 },
  );
  // T150: `lykos-continuation`'s policy crosses the same way. Enabled only
  // when `continue` is the active strategy and a successor is still allowed;
  // otherwise the extension loads inert — exactly one strategy runs.
  const contextStrategy = opts.contextStrategy ?? resolveContextStrategy(undefined, []);
  if (contextStrategy.note !== undefined) stderrWrite(`${contextStrategy.note}
`);
  process.env[CONTINUATION_POLICY_ENV] = encodeContinuationPolicyEnv(
    opts.continuation !== undefined
      ? { enabled: true, threshold: opts.continuation.threshold }
      : { enabled: false, threshold: opts.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD },
  );
  // T188: `lykos-prune`'s rule switches cross the same way. Whether it loads at
  // all is its entry in `extensions:`.
  process.env[PRUNE_POLICY_ENV] = encodePrunePolicyEnv({
    supersedeReads: opts.prune?.supersedeReads === true,
    dropUseless: opts.prune?.dropUseless === true,
  });
  if (opts.prune?.notice !== undefined) stderrWrite(`${opts.prune.notice}
`);
  // T151: `lykos-self-compact`'s policy crosses the same way, and its tool
  // joins the allowlist below only when it is enabled — so a session under any
  // other strategy carries neither its handler nor its schema.
  const selfCompactPolicy: SelfCompactPolicy = opts.selfCompact ?? {
    enabled: false,
    table: validateSelfCompactConfig(undefined),
  };
  // Specialists ticket 06: the plan-against-skill block, computed from the SAME
  // roster the session actually loads (ticket 05's `resolveLoadedSkills` —
  // discover → roster filter → cap, the identical pipeline `skillsOverride`
  // runs), so a session with no skills yields an empty block and an unchanged
  // head. Reuses the seam rather than re-discovering skills a second time.
  const planAgainstSkillHead = formatPlanAgainstSkillBlock(resolveLoadedSkills(cwd, opts.skills));
  const specialistInstructions = opts.specialist?.instructions ?? opts.instructions;
  const specialistName = opts.specialistName;
  const hasSpecialist =
    specialistInstructions !== undefined || opts.specialist !== undefined || specialistName !== undefined;

  const app = applySpecialist({
    ...(specialistName !== undefined ? { name: specialistName } : {}),
    ...(hasSpecialist
      ? {
          specialist: {
            ...opts.specialist,
            ...(specialistInstructions !== undefined ? { instructions: specialistInstructions } : {}),
          },
        }
      : {}),
    context: opts.specialistContext ?? "session-start",
    defaultToolNames: [...bootArtifacts.toolNames],
    ...(opts.specialistToolNames !== undefined ? { specialistToolNames: opts.specialistToolNames } : {}),
  });

  process.env[REGISTRY_OFF_TOOLS_ENV] = encodeRegistryOffToolsEnv(DEFAULT_REGISTRY_OFF_TOOLS);

  if (app.offLimitToolNames.length > 0) {
    process.env[SPECIALIST_NAME_ENV] = specialistName ?? "unnamed";
    process.env[SPECIALIST_OFF_LIMITS_ENV] = encodeSpecialistOffLimitsEnv(app.offLimitToolNames);
    const residentToolNames = app.tools.filter((t) => t.disposition === "resident").map((t) => t.name);
    process.env[SPECIALIST_ALLOWED_ENV] = encodeSpecialistOffLimitsEnv(residentToolNames);
  } else {
    delete process.env[SPECIALIST_NAME_ENV];
    delete process.env[SPECIALIST_OFF_LIMITS_ENV];
    delete process.env[SPECIALIST_ALLOWED_ENV];
  }

  const neutralHead = opts.neutralHead === true;

  // `bootArtifacts.toolNames` is the set the seam was ASKED about — the resident
  // list before the specialist spoke. What the head block states and what the
  // fingerprint hashes must be the set the model actually receives, which under
  // `tools_mode: override` is smaller. Stating the unrestricted list would tell
  // the model it holds tools that are not in its request, and would hash a tool
  // set no session ever ran with, breaking T17's boot contract.
  // T215 / ADR-0044: Under neutralHead, the request's tool list is fixed for the session
  // and is NOT narrowed by the starting specialist.
  const requestArtifacts: BootArtifacts = neutralHead
    ? { ...bootArtifacts, toolNames: [...bootArtifacts.toolNames] }
    : { ...bootArtifacts, toolNames: [...app.requestToolNames] };

  const appendSystemPromptOverride = buildAppendSystemPromptOverride(requestArtifacts, {
    promptDietEnabled,
    outputDietEnabled,
    memoryHead: memoryHead.text,
    neutralHead,
    ...(opts.instructions ? { specialistInstructions: opts.instructions } : {}),
    ...(opts.specialist !== undefined ? { specialist: opts.specialist } : {}),
    ...(opts.specialistName !== undefined ? { specialistName: opts.specialistName } : {}),
    ...(planAgainstSkillHead.length > 0 ? { planAgainstSkillHead } : {}),
    ...(opts.specialistContext !== undefined ? { specialistContext: opts.specialistContext } : {}),
    ...(opts.outputStyleText ? { outputStyleText: opts.outputStyleText } : {}),
    ...(opts.delegated !== undefined ? { delegated: opts.delegated } : {}),
    ...(opts.skills !== undefined ? { skills: opts.skills } : {}),
    app,
    finalToolNames: () => finalToolNames(),
  });
  const frozenContextFiles = promptDietEnabled ? ingestContextFiles({ cwd }) : [];

  // ADR-0027 (P14 ticket 08, D2): Pi's agent directory is the Lykos-generated
  // pi-host, passed explicitly — to the resource loader, and to the session
  // through one explicit `SettingsManager` both share — rather than left to
  // Pi's own `~/.pi/agent` default. `cli.ts` also sets `PI_CODING_AGENT_DIR` to
  // the same value for the process so an extension's `getAgentDir()` agrees.
  const agentDir = piHostDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, opts.piProjectTrusted === false ? { projectTrusted: false } : {});
  // T190: the handoff side call repeats the live turn's `thinkingBudgets` and `transport`, which only the
  // settings manager holds; the extension reads the policy, so they join it here, before the extensions load.
  const thinkingBudgets = settingsManager.getThinkingBudgets();
  process.env[SELF_COMPACT_POLICY_ENV] = encodeSelfCompactPolicyEnv({
    ...selfCompactPolicy,
    ...(thinkingBudgets !== undefined ? { thinkingBudgets } : {}),
    transport: settingsManager.getTransport(),
  });
  const taskList =
    opts.resumeTaskListFrom !== undefined
      ? resumeTaskListState(readTaskListFile(opts.resumeTaskListFrom))
      : newTaskListState();
  const taskListSink: { write?: (state: TaskListState) => void } = {};
  const continuationAtBoot = { taskListVersionAtBoot: taskList.version, gitStatusAtBoot: gitStatus(cwd) };
  const postEditPolicy = resolvePostEditPolicy(cwd, opts.feedback);
  const executor = opts.executor ?? localExecutor;
  const taskVerifier = opts.taskVerifier ?? buildTaskVerifier({ cwd, executor });
  const postEditState = newPostEditState();
  // T170: one probe says whether git can be used here at all. A top-level
  // session without it says so once; a child inherits its parent's situation
  // and stays quiet.
  const gitState = probeGit(cwd).state;
  const gitNotice = gitStateNotice(gitState);
  if (gitNotice !== undefined && opts.spawn === undefined) stderrWrite(`${gitNotice}
`);
  const checkpointEnabled = (opts.checkpoints ?? true) && gitState === "repo";
  const hookRegistry = new HookRegistry();
  for (const hook of builtinHooks()) hookRegistry.register(hook);
  const declared = resolveHookDecls(opts.hooks, createHookCommandRunner(executor));
  for (const hook of declared.hooks) hookRegistry.register(hook);
  const hookNotice = hookRejectionNotice(declared);
  if (hookNotice !== undefined) stderrWrite(`${hookNotice}
`);
  const askState = newAskState();
  const planState = newPlanState();
  const answerSink: { record?: (question: string, answer: string) => void } = {};
  const skillRoster: SkillLike[] = [];
  const skillInvocation = newSkillInvocationState();
  const harnessObservation = newHarnessObservation();
  const abortHolder: { abort?: () => void } = {};
  const sessionHolder: { id?: () => string } = {};
  extensionHost.setSessionId(() => sessionHolder.id?.() ?? "");
  extensionHost.setSpecialist(() => opts.specialistName);
  const harnessExtension = createHarnessExtension({
    maxBytes: toolResultMaxBytesFromEnv(),
    observation: harnessObservation,
    compactionThreshold: opts.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
    events,
    extensionHost,
    ...(opts.readOnly === true && opts.readOnlyChildTest?.bypass !== "harness" ? { readOnly: true } : {}),
    ...((neutralHead ? bootArtifacts.toolNames : app.requestToolNames).includes(TASK_LIST_TOOL_NAME) ? { taskList } : {}),
    ...(postEditPolicy.enabled && postEditPolicy.command !== undefined
      ? { postEdit: { policy: postEditPolicy, state: postEditState, events, run: createCommandRunner(executor) } }
      : {}),
    skills: { roster: skillRoster, invocation: skillInvocation },
    // T146: the session id is read when each checkpoint is written — it does
    // not exist until `createSession` below returns, and a pinned override
    // replaces it after that.
    ...(checkpointEnabled
      ? {
          checkpoint: {
            cwd,
            events,
            session: () => sessionHolder.id?.(),
            isExtensionTool: (name: string) => extensionHost.hasTool(name),
          },
        }
      : {}),
    hooks: { registry: hookRegistry, cwd },
    onHardStop: (note) => {
      stderrWrite(`
${note}
`);
      abortHolder.abort?.();
    },
  });
  // P10.5 (ticket 17, D2): the session family's peer bus is created HERE,
  // beside the `SpawnContext`, because this is the one place a family comes
  // into existence. A session spawned into an existing family was handed its
  // seat by the `Agent` call that created it (`opts.mailbox`) and keeps that
  // bus; a session nobody spawned mints a family of one. There is no
  // module-level bus to fall back on, so two unrelated sessions in this
  // process cannot see each other's mailboxes however hard they try.
  const mailbox = opts.mailbox ?? newPeerFamily();

  const spawnContext: SpawnContext | undefined =
    opts.spawn && opts.spawn.allowSpawn
      ? {
          ...opts.spawn,
          parentSessionId: opts.spawn.parentSessionId ?? "",
          allowSpawn: true,
          bus: mailbox.bus,
        }
      : undefined;

  const { customTools, activeToolNames, lsp, jobs, evalRuntimes, commits } = loadTools(
    neutralHead ? bootArtifacts.toolNames : app.requestToolNames,
    {
    cwd,
    ...(opts.stateRoot !== undefined ? { stateRoot: opts.stateRoot } : {}),
    // T179: `commit` needs a repository and a git binary, which the one probe above already settled.
    commitEnabled: gitState === "repo",
    // T179: a commit is written to the ledger the moment it is made. A session that is killed has no
    // `sessions` row (ingest runs at the end), so waiting for the end would lose the commits of exactly
    // the sessions most worth knowing about.
    onCommit: async (record) => {
      const id = sessionHolder.id?.();
      if (id === undefined) throw new Error("the session has no id yet");
      await recordSessionCommits(opts.ledgerPath, id, [record]);
      (opts.gate as any)?.refresh?.();
    },
    gate: sessionGate,
    denials,
    mailbox,
    modelProvider: opts.model.provider ?? "",
    modelId: opts.model.id ?? "",
    executor,
    ...(opts.lspServers !== undefined ? { lspServers: opts.lspServers } : {}),
    ...(opts.workspaceTrusted === true ? { workspaceTrusted: true } : {}),
    ...(opts.evalPython !== undefined ? { evalPython: opts.evalPython } : {}),
    ...(opts.editRequireRead !== undefined ? { editRequireRead: opts.editRequireRead } : {}),
    ...(opts.webSearch !== undefined ? { webSearch: opts.webSearch } : {}),
    // P10.6 (ticket 18): provenance for a proposed memory. The real session id
    // does not exist until `createSession` returns below, so the only id
    // available at tool-load time is a caller-pinned one — which is the id the
    // session will actually carry (see the override a few lines down). A
    // caller that pinned none gets a proposal with no `src` rather than an
    // invented one, because a fabricated provenance is worse than none.
    ...(opts.sessionIdOverride !== undefined ? { sessionId: opts.sessionIdOverride } : {}),
    ...(spawnContext !== undefined ? { spawnContext } : {}),
    ...(app.requestToolNames.includes(TASK_LIST_TOOL_NAME)
      ? {
          taskList: {
            state: taskList,
            onChange: (state: TaskListState) => taskListSink.write?.(state),
            verifier: taskVerifier,
            events,
          },
        }
      : {}),
    ...(opts.askHuman !== undefined
      ? {
          ask: {
            state: askState,
            askHuman: opts.askHuman,
            record: (question: string, answer: string) => answerSink.record?.(question, answer),
          },
        }
      : {}),
    ...(opts.requestPlanExit !== undefined && opts.currentMode !== undefined
      ? {
          exitPlan: {
            state: planState,
            currentMode: opts.currentMode,
            ...(opts.isPlanning !== undefined ? { isPlanning: opts.isPlanning } : {}),
            requestExit: opts.requestPlanExit,
          },
        }
      : {}),
    ...(opts.coordinator !== undefined ? { coordinator: opts.coordinator } : {}),
  });

  // P10.9 (ticket 21, D4): an extension's tools ride the same `customTools`
  // array every Lykos tool does, because they ARE registry rows — there is
  // no second registration path for them, and each definition in the list
  // was built by the host around `authorizeExtensionTool`.
  //
  // T147 (D25): pushed INTO `customTools` rather than spread beside it, because
  // `tool_call` and `tool_search` read that array for their targets — a
  // mounted extension tool (the default) is otherwise registered and
  // unreachable. A resident one joins `activeToolNames`, fixed here at boot
  // like every other resident tool, so the tool array never changes mid-session.
  // T213 (issue #81): an explicit tool list (caller's tools, config.tools with
  // tools_mode: override, or read-only) is exact — a resident extension tool
  // joins activeToolNames only if that explicit list names it.
  customTools.push(...extensionHost.toolDefinitions());
  const explicitToolSet =
    opts.explicitToolNames !== undefined
      ? new Set(opts.explicitToolNames.map(canonicalToolName))
      : (opts.readOnly === true ? new Set(readOnlyTools(activeToolNames).map(canonicalToolName)) : undefined);
  for (const row of extensionHost.toolRegistryRows()) {
    if (row.residency === "resident") {
      const allowed = explicitToolSet === undefined || explicitToolSet.has(canonicalToolName(row.name));
      if (allowed && !activeToolNames.includes(row.name)) {
        activeToolNames.push(row.name);
      }
    }
  }
  // T154: the session's FINAL tool list — exactly what reaches the wire — is
  // decided once, here, and both the head block and the head contract's drift
  // baseline are built from it. It is computed lazily because the head block
  // is rendered while Pi's resource loader reloads, and memoized so boot hands
  // `createSession` the very list the head states.
  const finalTools: { names?: string[] } = {};
  const finalToolNames = (): string[] => {
    if (finalTools.names !== undefined) return finalTools.names;
    // Only a name something defines reaches the wire: Pi's `_refreshToolRegistry`
    // drops any allowed name its registry lacks — `ask` and `exit_plan` in a
    // session with no human channel, whose definitions were never built.
    const defined = new Set<string>([
      ...PI_BASE_TOOL_NAMES,
      ...customTools.map((t) => t.name),
      ...piExtensionToolNames(resourceLoader),
    ]);
    const names = activeToolNames.filter((n) => defined.has(n));
    // T155: declaring a Pi extension is consent for all of its tools. Pi drops
    // any tool whose name is not on `tools:`, so every tool the loaded Pi
    // extensions registered — `lykos-self-compact`'s `context_usage` and
    // `self_compact` among them — is admitted here, in load order, fixed at
    // boot like every other resident tool. An extension switched off in config
    // is not loaded and registers nothing; one loaded inert registers nothing.
    for (const name of piExtensionToolNames(resourceLoader)) {
      if (!names.includes(name)) names.push(name);
    }
    // P4 T149: whatever joined above, a read-only child boots with read tools only.
    if (opts.readOnly === true) {
      names.splice(0, names.length, ...readOnlyTools(names));
      // T161: tests only — the tool-list layer opened so the next one meets a real write.
      for (const name of opts.readOnlyChildTest?.extraTools ?? []) {
        if (!names.includes(name)) names.push(name);
      }
    }
    if (opts.coordinator !== undefined) {
      for (const name of [COORDINATOR_ASK_TOOL_NAME, COORDINATOR_GIVE_UP_TOOL_NAME]) {
        if (defined.has(name) && !names.includes(name)) {
          names.push(name);
        }
      }
    }
    finalTools.names = names;
    return names;
  };
  // T168 (ADR-0031): `pi-hashline-edit` registers its own `read` and `edit`,
  // and there is one editor now, so it is dropped here whoever declared it.
  const declaredExtensions = withoutHashlineEdit(opts.extensions ?? []);
  if (declaredExtensions.notice !== undefined) stderrWrite(`${declaredExtensions.notice}
`);
  const hostExtensions = resolveHostExtensions(declaredExtensions.extensions, agentDir, existsSync);
  const extensionNotice = hostExtensionNotice(hostExtensions);
  if (extensionNotice !== undefined) {
    stderrWrite(`${extensionNotice}
`);
  }
  const skillsPolicy = resolveSkillsPolicy(cwd, opts.skills);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [harnessExtension],
    noExtensions: true,
    additionalExtensionPaths: [...hostExtensions.paths, specialistGuardExtensionPath()],
    ...(skillsPolicy.paths.length > 0 ? { additionalSkillPaths: skillsPolicy.paths } : {}),
    ...(skillsPolicy.enabled
      ? {
          skillsOverride: (base) => {
            // Specialists ticket 02/05: the roster filters BEFORE the cap, so a
            // specialist naming three skills is never capped by a `max` sized
            // for the unrestricted default.
            const rostered = filterSkillsByRoster(base.skills, skillsPolicy.roster);
            const capped = capSkills(rostered, skillsPolicy.max);
            const notice = skillsCapNotice(capped, skillsPolicy.max);
            if (notice !== undefined) stderrWrite(`${notice}
`);
            return { skills: capped.kept, diagnostics: base.diagnostics };
          },
        }
      : { noSkills: true }),
    appendSystemPromptOverride,
    ...(promptDietEnabled
      ? { agentsFilesOverride: () => ({ agentsFiles: toAgentsFiles(frozenContextFiles) }) }
      : {}),
  });
  await resourceLoader.reload();
  // T157: how much recent context a compaction keeps. Pi reads it from its
  // settings on every `compact()`; there is no per-call option, so it is an
  // override on this session's settings manager — never a `.pi/` file. Applied
  // AFTER the loader's reload, because `SettingsManager.reload()` (which the
  // loader calls) rebuilds settings from files and drops earlier overrides.
  // Lykos never reloads a session after this, so it holds for the session.
  if (opts.selfCompact?.enabled === true) {
    settingsManager.applyOverrides({ compaction: { keepRecentTokens: opts.selfCompact.table.keepRecentTokens } });
  }
  skillRoster.push(
    ...resourceLoader.getSkills().skills.map((s) => ({
      name: s.name,
      description: s.description,
      filePath: s.filePath,
    })),
  );
  const skillNames = skillRoster.map((s) => s.name);
  skillInvocation.available = skillRoster.length;
  const skillHeadTokens = skillsHeadCost(skillRoster);

  const createSession = opts.createSession ?? createAgentSession;
  const { session } = await createSession({
    cwd,
    model,
    modelRuntime,
    sessionManager: SessionManager.inMemory(cwd),
    tools: finalToolNames(),
    customTools,
    resourceLoader,
    agentDir,
    settingsManager,
  });

  // Specialists ticket 02: applied once, right after creation — the same "frozen
  // at boot" posture the head contract already holds everything else to.
  // Mid-session switching (ticket 04) is a separate, later call to the same
  // SDK method, not a reason to delay this one.
  if (opts.thinkingLevel !== undefined) {
    try {
      (session as unknown as { setThinkingLevel?: (level: string) => void }).setThinkingLevel?.(opts.thinkingLevel);
    } catch {
      // A model that does not support thinking effort is not a boot failure.
    }
  }

  if (opts.sessionIdOverride !== undefined && opts.sessionIdOverride !== session.sessionId) {
    Object.defineProperty(session, "sessionId", {
      value: opts.sessionIdOverride,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }

  // T152 (spec story 58): a resume carries an unfinished self-compact handoff
  // across. The predecessor's records were copied to its session directory as
  // they were appended (`startLiveCapture`); the one still open is appended to
  // THIS session's entries before any turn, where the extension finds it with
  // `getEntries()` exactly as it would in a Pi session reopened from its file.
  // Only while self-compact is the active strategy: under any other the
  // extension is inert and a carried note would be read by nothing.
  if (opts.resumeHandoffFrom !== undefined && selfCompactPolicy.enabled) {
    carryUnfinishedHandoff(session, opts.resumeHandoffFrom);
  }

  if (spawnContext) {
    spawnContext.parentSessionId = session.sessionId;
  }
  sessionHolder.id = () => session.sessionId;
  abortHolder.abort = () => {
    try {
      session.abort();
    } catch {
      // A session already settling is not an error worth surfacing here.
    }
  };

  harnessObservation.contextWindow = contextWindowOf(model);

  // T154: the drift baseline is the list the session was created with — the
  // one the head block states — never the pre-boot request set.
  const finalArtifacts: BootArtifacts = { ...requestArtifacts, toolNames: [...finalToolNames()] };
  const headContract = new HeadContract();
  const { fingerprint: bootFingerprint } = headContract.boot(finalArtifacts);

  // T150: what `lykos-continuation` recorded, read back from the session's
  // entries every time it is asked — never a copy that could drift from them.
  const continuationCrossing = () => {
    const manager = (session as { sessionManager?: { getEntries?: () => Array<{ type: string }> } }).sessionManager;
    return continuationFromEntries(manager?.getEntries?.() ?? []);
  };

  const unwrappedGate = unwrapGate(gate);
  let mode: InteractionMode = "manual";
  if (opts.currentMode !== undefined) {
    mode = opts.currentMode();
  } else if (typeof (unwrappedGate as any)?.mode === "string" && isInteractionMode((unwrappedGate as any).mode)) {
    mode = (unwrappedGate as any).mode;
  } else if (unwrappedGate instanceof AutoApproveGate) {
    mode = "auto";
  }
  const modeLabel = MODE_INFO[mode]?.label ?? "Manual";

  const specialistMessage = neutralHead
    ? specialistStreamMessage({
        name: specialistName ?? "build",
        ...(specialistInstructions !== undefined ? { instructions: specialistInstructions } : {}),
        ...(app.offLimitToolNames.length > 0 ? { offLimits: app.offLimitToolNames } : {}),
        modeLabel,
        ...(app.offLimitToolNames.length > 0
          ? { tools: app.tools.filter((t) => t.disposition === "resident").map((t) => t.name) }
          : {}),
      })
    : undefined;

  return {
    session,
    headContract,
    harnessObservation,
    denials,
    lsp,
    jobs,
    executor,
    ...(opts.containment !== undefined ? { containment: opts.containment } : {}),
    ...(opts.withheld && opts.withheld.length > 0 ? { withheld: [...opts.withheld] } : {}),
    evalRuntimes,
    mailbox,
    taskList,
    taskListSink,
    postEditPolicy,
    postEditState,
    skills: { roster: skillRoster, headTokens: skillHeadTokens, invocation: skillInvocation },
    continuationState: {
      ...continuationAtBoot,
      get requested(): boolean {
        return continuationCrossing() !== undefined;
      },
      get tokens(): number | undefined {
        return continuationCrossing()?.tokens;
      },
      get contextWindow(): number | undefined {
        return continuationCrossing()?.contextWindow;
      },
    },
    contextStrategy,
    askState,
    planState,
    answerSink,
    hooks: hookRegistry,
    extensionHost,
    bootFingerprint,
    // The request's set, not the pre-specialist one: everything downstream that
    // reads this is asking what the session HAS, and the fingerprint above was
    // computed from the same artifacts.
    bootArtifacts: finalArtifacts,
    gitState,
    commits,
    promptDietEnabled,
    outputDietEnabled,
    memoryHead,
    get selfCompactRecords(): SelfCompactRecord[] {
      const manager = (session as { sessionManager?: { getEntries?: () => Array<{ type: string }> } }).sessionManager;
      return selfCompactRecordsFromEntries(manager?.getEntries?.() ?? []);
    },
    get repoMap(): RepoMap {
      const manager = (session as { sessionManager?: { getEntries?: () => Array<{ type: string }> } }).sessionManager;
      return repoMapFromEntries(manager?.getEntries?.() ?? []);
    },
    hostExtensions,
    lykosExtensions,
    frozenContextFiles,
    startedAt,
    skillNames,
    skillRoster,
    ...(spawnContext ? { spawnContext } : {}),
    ...(opts.specialistName !== undefined ? { specialistName: opts.specialistName } : {}),
    ...(specialistMessage !== undefined ? { specialistMessage } : {}),
  };
}

/**
 * Turn configuration into a running session. Feature flags are read here,
 * once: ask (human channel), plan (exit callbacks), checkpoints,
 * skills, memory, hooks — plus the other config-gated assembly
 * (extensions, feedback, repo map, continuation) that used to be copied
 * through the two god modules.
 */
export async function boot(input: BootConfig, deps?: BootDeps): Promise<BootedStandaloneSession> {
  const { cwd, config } = input;
  const specialistName = input.specialistName ?? DEFAULT_SPECIALIST;
  const isChild = input.isChild === true;
  const hasCallerTools = input.tools !== undefined;
  // P4 T149: a read-only child. Its tools, its gate and its checkpoints are
  // decided here, once, and nothing the caller passed can widen them.
  const readOnly = input.readOnly === true;
  // T161: tests only. Ignored entirely unless this is a read-only child.
  const readOnlyChildTest = readOnly ? deps?.readOnlyChildTest : undefined;
  const underlyingGate = unwrapGate(input.gate);
  const gate: ApprovalGate = underlyingGate instanceof SubagentGate
    ? input.gate
    : (readOnly
      ? readOnlyChildTest?.bypass === "gate"
        ? new AutoApproveGate()
        : new ReadOnlyGate()
      : input.gate);
  if (readOnly) {
    input = {
      ...input,
      tools: [...readOnlyTools(input.tools ?? READ_ONLY_CHILD_TOOLS), ...(readOnlyChildTest?.extraTools ?? [])],
      subagents: false,
      checkpoints: false,
    };
  }
  // Specialists ticket 02: `input.tools` (a caller override — ultimately a CLI
  // flag) beats `config.tools` (the specialist/project-resolved value), the
  // same "a flag beats a specialist" rule every other field follows. Either way,
  // `tools_add`/`tools_remove` apply on top — they are a delta on whatever
  // set the base tool list, not an alternative to it.
  const baseTools = input.tools ?? config.tools;
  const hasSpecialistTools =
    config.tools !== undefined ||
    (config.tools_add !== undefined && config.tools_add.length > 0) ||
    (config.tools_remove !== undefined && config.tools_remove.length > 0);
  const defaultToolNames = resolveStandaloneTools({
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    ...(input.subagents !== undefined ? { subagents: input.subagents } : {}),
    isChild,
  });
  const specialistToolNames = hasSpecialistTools
    ? applyToolDeltas(
        resolveStandaloneTools({
          ...(baseTools !== undefined ? { tools: baseTools } : {}),
          ...(input.subagents !== undefined ? { subagents: input.subagents } : {}),
          isChild,
        }),
        config.tools_add,
        config.tools_remove,
      )
    : undefined;
  const toolNames = defaultToolNames;
  const allowedSpecialistTools =
    specialistToolNames !== undefined && readOnly ? readOnlyTools(specialistToolNames) : specialistToolNames;

  // T213 (issue #81): an explicit tool list (caller's tools, config.tools with
  // tools_mode: override, or a read-only session's list) must be exact: a resident
  // extension tool joins activeToolNames only if that list names it.
  const hasConfigToolsOverride =
    (config.tools !== undefined || input.specialist?.tools !== undefined) &&
    (config.tools_mode === "override" || input.specialist?.tools_mode === "override");
  const isExplicitTools = hasCallerTools || readOnly || hasConfigToolsOverride;
  const explicitToolNames = isExplicitTools
    ? (allowedSpecialistTools ?? specialistToolNames ?? defaultToolNames)
    : undefined;

  const continuationIndex = input.continuationIndex ?? 0;
  // Only a top-level, writable session owns its context strategy: a child and a read-only session leave Pi's own
  // compaction in charge (a read-only one has no self_compact tool, and a successor is a session id an MCP result would not report).
  const ownsContextStrategy = !isChild && !readOnly;
  // T150: exactly one context strategy; continuation runs only when it is the
  // active one, the cap still allows a successor, and this is not a child.
  // T151: the tier table is validated here, at startup, whatever the
  // strategy — a wrong value is refused by name rather than switching the
  // mechanism off in silence (spec story 53).
  const selfCompactTable = validateSelfCompactConfig(config.self_compact);
  // T190: `compaction.method_order`. A name it does not know is ignored, and said so once.
  const methodOrder = parseMethodOrder(config.compaction.method_order);
  if (methodOrder.ignored.length > 0) {
    stderrWrite(
      `lykos: compaction.method_order: ignoring ${methodOrder.ignored.map((n) => `"${n}"`).join(", ")} ` +
        `(not a compaction method; expected ${COMPACTION_METHODS.join(", ")})\n`,
    );
  }
  let contextStrategy = resolveContextStrategy(
    config.context_strategy,
    config.extensions.map((e) => e.name),
  );
  // T151: self-compact switches itself off below the smallest tier, leaving
  // Pi's compaction in charge (story 51) — so the record says `pi`.
  let selfCompactPolicy: SelfCompactPolicy | undefined;
  if (contextStrategy.active === "self-compact") {
    const contextWindow = contextWindowOf(input.model);
    const modelId = input.model as { provider?: string; id?: string };
    const resolved = resolveSelfCompact(selfCompactTable, {
      contextWindow,
      model: { ...(modelId.provider !== undefined ? { provider: modelId.provider } : {}), ...(modelId.id !== undefined ? { id: modelId.id } : {}) },
      ...(input.specialistName !== undefined ? { specialist: input.specialistName } : {}),
    });
    if (resolved === undefined) {
      const smallest = selfCompactTable.tiers[0]!;
      contextStrategy = {
        declared: contextStrategy.declared,
        active: "pi",
        note:
          `lykos: self-compact is off for this model's ${contextWindow}-token window, below the smallest tier (${formatTokens(smallest.window)}); ` +
          "Pi's own compaction is in charge this session",
      };
    } else {
      if (resolved.thresholds.cutoff > contextWindow) {
        throw new SelfCompactConfigError(
          `the ${resolved.source} override's cutoff ${resolved.thresholds.cutoff} is above this model's ${contextWindow}-token window`,
        );
      }
      selfCompactPolicy = {
        // Off for a child and for any read-only session: the read-only cut removes self_compact, so an armed
        // gauge would tell the model to call a tool it lacks and then refuse every read. Pi's own compaction
        // is what keeps a long review within its window, as it does for a read-only child.
        enabled: ownsContextStrategy,
        table: selfCompactTable,
        ...(input.specialistName !== undefined ? { specialist: input.specialistName } : {}),
        methodOrder: methodOrder.order,
      };
    }
  }
  const pruneKnobs = { supersedeReads: config.compaction.supersede_reads, dropUseless: config.compaction.drop_useless };
  const pruneWarning = pruneNotice(pruneKnobs, config.extensions.map((e) => e.name));
  // T181b: a read-only session never continues, so the record says `pi` rather than a strategy that did not run.
  if (readOnly && !isChild && contextStrategy.active === "continue") {
    contextStrategy = {
      declared: contextStrategy.declared,
      active: "pi",
      note: "lykos: context_strategy continue is off for a read-only session, which never continues into a successor; Pi's own compaction is in charge",
    };
  }
  const continuationAvailable = contextStrategy.active === "continue" && continuationIndex < config.continuation.max;

  const spawn =
    !isChild && (input.subagents === true || (specialistToolNames ?? toolNames).some((name) => canonicalToolName(name) === "agent"))
      ? {
          workspace: input.stateRoot ?? cwd,
          ...(input.workTree !== undefined ? { workTree: input.workTree } : {}),
          ledgerPath: input.ledgerPath,
          config,
          modelSpec: input.modelSpec,
          gate,
          autoApprove: input.autoApprove === true,
          parentBrief: input.parentBrief ?? "",
          executionShape: "standalone" as const,
          allowSpawn: true,
          ...(input.currentMode !== undefined
            ? { parentMode: input.currentMode }
            : input.interactionMode !== undefined
              ? { parentMode: input.interactionMode }
              : (unwrapGate(gate) as any).mode !== undefined
                ? { parentMode: (unwrapGate(gate) as any).mode }
                : {}),
          ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
          ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
          ...(input.executor !== undefined ? { executor: input.executor } : {}),
          // T182: what a child inherits when its parent does not choose.
          ...(input.containment !== undefined ? { containment: input.containment } : {}),
          ...(input.containmentDrivers !== undefined ? { containmentDrivers: input.containmentDrivers } : {}),
        }
      : undefined;

  // Specialists band 2 ticket 01: the specialist's own fields, gathered once from
  // the resolved config and handed to the seam whole. `instructions` stays on its
  // own option because it predates this band and every caller already passes it;
  // everything else about what a specialist MEANS travels in here.
  const specialistFields: SpecialistFields | undefined =
    input.specialist ??
    (config.prompt_mode !== undefined ||
    config.tools_mode !== undefined ||
    config.provider !== undefined ||
    config.model !== undefined ||
    config.instructions !== undefined ||
    config.tools_add !== undefined ||
    config.tools_remove !== undefined
      ? {
          ...(config.instructions !== undefined ? { instructions: config.instructions } : {}),
          ...(config.prompt_mode !== undefined ? { prompt_mode: config.prompt_mode } : {}),
          ...(config.tools_mode !== undefined ? { tools_mode: config.tools_mode } : {}),
          ...(config.provider !== undefined ? { provider: config.provider } : {}),
          ...(config.model !== undefined ? { model: config.model } : {}),
          ...(config.tools_add !== undefined ? { tools_add: config.tools_add } : {}),
          ...(config.tools_remove !== undefined ? { tools_remove: config.tools_remove } : {}),
        }
      : undefined);

  const globalDir = input.globalDir ?? join(homedir(), ".lykos");
  const projectRoot = resolve(input.stateRoot ?? cwd);
  const outputStyleText =
    input.outputStyleText !== undefined
      ? input.outputStyleText
      : (() => {
          const styleName = config.output_style ?? "default";
          const resolved = resolveOutputStyle(styleName, projectRoot, globalDir);
          return resolved.text;
        })();

  return assembleSession({
    cwd,
    ...(input.stateRoot !== undefined ? { stateRoot: input.stateRoot } : {}),
    ledgerPath: input.ledgerPath,
    model: input.model,
    modelRuntime: input.modelRuntime,
    toolNames,
    gate,
    memory: resolveMemoryPolicy(config.memory),
    // T158 (ADR-0028): the extension list is the only switch. Whether the map
    // runs is whether `lykos-repo-map` was declared and so loaded; the policy
    // carries only its parameters.
    repoMap: resolveRepoMapPolicy({ enabled: true, ...config.retrieval.repo_map }),
    extensions: resolveExtensions(config.extensions).extensions,
    lykosExtensions: resolveExtensions(config.lykos_extensions, LYKOS_EXTENSIONS_KEY).extensions,
    feedback: config.feedback,
    skills: config.skills,
    // P10.4 (ticket 15, D4): the resolved server table, so a project's
    // `lsp.servers` reaches the pool through the one place that turns
    // configuration into a session.
    lspServers: config.lsp.servers,
    // #22: trusted means the user-level store, which `prompt` writes. `flag` is a
    // per-run override and does not trust a project's own binaries.
    workspaceTrusted: isStoreTrusted(input.trustSource),
    ...(input.piProjectTrusted === false ? { piProjectTrusted: false } : {}),
    // P10.6 (ticket 19, D6): the resolved interpreter, on the same terms.
    // Empty is the shipped default and is what makes `eval` name the key.
    evalPython: config.eval.python,
    // T168 part B: `edit.require_read`, read here with the rest of the config.
    editRequireRead: config.edit.require_read,
    // P10.7 (ticket 12, D2/D3, P14 ticket 17 D2): the declaration, plus the
    // key resolved HERE. `process.env` and the credential pool are read at the
    // one place that already turns configuration into a session, so the tool is
    // handed a value a test can set and never reaches into the process itself.
    webSearch: {
      provider: config.web.search.provider,
      endpoint: config.web.search.endpoint,
      keyEnv: config.web.search.key_env,
      apiKey: resolveSearchApiKey(config.web.search.provider, config.web.search.key_env, process.env),
      // Ticket 24 D1: `auto` (the shipped provider) consults Brave's,
      // Perplexity's and Exa's keys in turn, so all three are resolved here,
      // on the same terms, and only when the chain is what will run.
      ...(config.web.search.provider.trim() === AUTO_SEARCH_PROVIDER ? { keys: resolveAutoSearchKeys(process.env) } : {}),
    },
    hooks: config.hooks,
    ...(input.checkpoints !== undefined ? { checkpoints: input.checkpoints } : {}),
    ...(continuationAvailable && ownsContextStrategy ? { continuation: { threshold: config.compaction.threshold } } : {}),
    contextStrategy,
    ...(selfCompactPolicy !== undefined ? { selfCompact: selfCompactPolicy } : {}),
    compactionThreshold: config.compaction.threshold,
    prune: { ...pruneKnobs, ...(pruneWarning !== undefined ? { notice: pruneWarning } : {}) },
    ...(input.askHuman !== undefined ? { askHuman: input.askHuman } : {}),
    ...(input.coordinator !== undefined ? { coordinator: input.coordinator } : {}),
    ...(input.requestPlanExit !== undefined && input.currentMode !== undefined
      ? { requestPlanExit: input.requestPlanExit, currentMode: input.currentMode }
      : {}),
    ...(input.isPlanning !== undefined ? { isPlanning: input.isPlanning } : {}),
    ...(input.resumeTaskListFrom !== undefined ? { resumeTaskListFrom: input.resumeTaskListFrom } : {}),
    ...(input.sessionIdOverride !== undefined ? { sessionIdOverride: input.sessionIdOverride } : {}),
    ...(input.resumeHandoffFrom !== undefined ? { resumeHandoffFrom: input.resumeHandoffFrom } : {}),
    ...(input.taskVerifier !== undefined ? { taskVerifier: input.taskVerifier } : {}),
    ...(input.executor !== undefined ? { executor: input.executor } : {}),
    ...(input.containment !== undefined ? { containment: input.containment } : {}),
    ...(spawn !== undefined ? { spawn } : {}),
    ...(input.mailbox !== undefined ? { mailbox: input.mailbox } : {}),
    ...(deps?.createSession !== undefined ? { createSession: deps.createSession } : {}),
    ...(config.instructions ? { instructions: config.instructions } : {}),
    specialistName,
    ...(specialistFields !== undefined ? { specialist: specialistFields } : {}),
    ...(input.specialistContext !== undefined ? { specialistContext: input.specialistContext } : {}),
    ...(config.thinkingLevel !== undefined ? { thinkingLevel: config.thinkingLevel } : {}),
    ...(allowedSpecialistTools !== undefined ? { specialistToolNames: allowedSpecialistTools } : {}),
    ...(explicitToolNames !== undefined ? { explicitToolNames } : {}),
    ...(readOnly ? { readOnly: true } : {}),
    ...(readOnlyChildTest !== undefined ? { readOnlyChildTest } : {}),
    reviewer: { enabled: config.reviewer.enabled, model: config.reviewer.model.trim() },
    ...(outputStyleText !== undefined ? { outputStyleText } : {}),
    ...(input.neutralHead !== undefined ? { neutralHead: input.neutralHead } : {}),
    ...(input.withheld !== undefined ? { withheld: input.withheld } : {}),
    ...(input.delegated !== undefined ? { delegated: input.delegated } : {}),
  });
}

/**
 * T54: the resume-contract half of `meta.json`, assembled from values the
 * boot path has already computed.
 *
 * Nothing here is derived a second time — the head fingerprint comes off
 * `HeadContract.boot()`, the context-file list off the same
 * `contextFileMeta()` the snapshot uses, the price basis off the same
 * `resolveCallAccounting()` every call is priced through. A value the host
 * genuinely does not have is left absent rather than defaulted: absent means
 * "not recorded", and a resume can say so.
 */
function resumeContract(opts: {
  booted: BootedStandaloneSession;
  session: { getActiveToolNames?: () => string[]; thinkingLevel?: string | null };
  modelSpec: string;
  modelSource?: string;
  providers?: ProvidersConfig;
  executionShape?: string;
}): SessionResumeContract {
  const { booted } = opts;
  const ref = parseProviderModel(opts.modelSpec);
  const accounting = opts.providers ? resolveCallAccounting(ref.provider, ref.model, opts.providers) : undefined;
  const cwd = booted.bootArtifacts.cwd;
  const gitCommit = currentGitCommit(cwd);
  return {
    ...(opts.modelSource !== undefined ? { modelSource: opts.modelSource } : {}),
    ...(accounting !== undefined ? { priceBasis: accounting.priceBasis } : {}),
    priceVersion: currentPriceTable().version,
    ...(opts.session.thinkingLevel ? { effort: opts.session.thinkingLevel } : {}),
    // Specialists ticket 01: the selected specialist's name, or absent when none
    // was selected. Previously hardcoded to "budget" (T23.3's note: "the
    // only specialist that exists today"), which predates specialists existing as
    // a real mechanism — a resume now records what the session actually ran
    // under rather than a name from a preset system that was never built.
    ...(booted.specialistName !== undefined ? { specialist: booted.specialistName } : {}),
    head: {
      bootFingerprint: booted.bootFingerprint,
      contextFiles: contextFileMeta(booted.frozenContextFiles).map((f) => ({
        name: f.name ?? f.path,
        bytes: f.bytes,
        ...(f.kind !== undefined ? { kind: f.kind } : {}),
      })),
    },
    tools: {
      active: [...(opts.session.getActiveToolNames?.() ?? booted.bootArtifacts.toolNames)],
      extensions: booted.hostExtensions.loaded.map((e) => ({ name: e.name, version: e.version })),
    },
    flags: {
      headContract: true,
      promptDiet: booted.promptDietEnabled,
      outputDiet: booted.outputDietEnabled,
    },
    git: {
      ...(gitCommit !== undefined ? { commit: gitCommit } : {}),
      dirty: isGitDirty(cwd),
    },
    runtime: "host",
    ...(opts.executionShape !== undefined ? { executionShape: opts.executionShape } : {}),
    // The session runs on the host; when its commands ran in a container, that container's image is the one recorded.
    sandboxImage: booted.containment?.image ?? null,
    ...(booted.containment !== undefined ? { containment: booted.containment } : {}),
    ...(booted.withheld && booted.withheld.length > 0 ? { withheld: [...booted.withheld] } : {}),
  };
}

/**
 * T53: start live transcript capture for a booted standalone session.
 *
 * Shared by the one-shot path and both of interactive's render-mode
 * branches, so the three cannot drift on what a `stream` transcript
 * contains. Returns `undefined` for a `:memory:` ledger, which has no
 * session directory to write into.
 *
 * `meta.json` is written here, at boot, rather than at ingest: a session
 * killed mid-turn never reaches ingest, and without a meta written now it
 * would leave a transcript that nothing could identify.
 */
/** T152: the file in a session directory that holds its self-compact records. */
export function selfCompactRecordPath(dir: string): string {
  return join(dir, SELF_COMPACT_RECORD_FILE);
}

/** T152: every self-compact record a session directory holds; empty when it has none. */
export function readSelfCompactRecords(dir: string): SelfCompactRecord[] {
  try {
    return parseSelfCompactRecords(readFileSync(selfCompactRecordPath(dir), "utf8"));
  } catch {
    return [];
  }
}

/** T152: append the predecessor's unfinished handoff, if any, to a freshly booted session's entries. */
function carryUnfinishedHandoff(session: unknown, dir: string): void {
  const open = unfinishedHandoff(readSelfCompactRecords(dir));
  if (open === undefined) return;
  const manager = (session as { sessionManager?: { appendCustomEntry?: (type: string, data: unknown) => string } })
    .sessionManager;
  manager?.appendCustomEntry?.(SELF_COMPACT_ENTRY_TYPE, open);
}

export function startLiveCapture(opts: {
  ledgerPath: string;
  booted: BootedStandaloneSession;
  session: {
    sessionId: string;
    subscribe?: (listener: (ev: unknown) => void) => () => void;
    getActiveToolNames?: () => string[];
    thinkingLevel?: string | null;
  };
  modelSpec: string;
  modelSource?: string;
  providers?: ProvidersConfig;
  taskId?: string;
  projectId?: string;
  parentSessionId?: string;
  agentRole?: string;
  resumedFrom?: string;
  continuationsUsed?: number;
  executionShape?: string;
}): { recorder: LiveTranscriptRecorder | undefined; detach: () => void } {
  const recorder = LiveTranscriptRecorder.create(opts.ledgerPath, opts.session.sessionId);
  if (!recorder) return { recorder: undefined, detach: () => {} };
  const priorMeta = readSessionMeta(opts.ledgerPath, opts.session.sessionId);
  recorder.writeMeta({
    taskId: opts.taskId ?? null,
    projectId: opts.projectId ?? null,
    parentSessionId: opts.parentSessionId ?? null,
    resumedFrom: opts.resumedFrom ?? null,
    agentRole: opts.agentRole ?? null,
    model: opts.modelSpec,
    cwd: opts.booted.bootArtifacts.cwd,
    startedUtc: priorMeta?.startedUtc ?? opts.booted.startedAt,
    ...resumeContract(opts),
  });
  const subscribe = opts.session.subscribe?.bind(opts.session);
  const dir = transcriptDir(opts.ledgerPath, opts.session.sessionId);
  // T152: every self-compact record lands in `self-compact.jsonl` as it is
  // appended (Pi's `entry_appended`), so a session killed mid-handoff still
  // leaves the note on disk for `lykos resume` to finish (spec story 58).
  // It rides the recorder's one subscription rather than adding a second.
  const copyRecord = (raw: unknown): void => {
    const ev = raw as { type?: string; entry?: { customType?: string; data?: unknown } };
    // T188: a prune's `prunes` row is written now, not at the session's end: a
    // killed session has no end, and these are the sessions worth knowing about.
    // A record missing a field writes no row rather than a guessed one.
    if (ev.type === "entry_appended" && ev.entry?.customType === PRUNE_ENTRY_TYPE) {
      const row = pruneRowFromEntry(ev.entry.data);
      if (row !== undefined) {
        recordSessionPrunes(opts.ledgerPath, opts.session.sessionId, [row]).catch((err) => {
          stderrWrite(`lykos: could not record a prune for ${opts.session.sessionId}: ${err instanceof Error ? err.message : String(err)}\n`);
        });
      }
      return;
    }
    if (ev.type !== "entry_appended" || ev.entry?.customType !== SELF_COMPACT_ENTRY_TYPE) return;
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(selfCompactRecordPath(dir), `${JSON.stringify(ev.entry.data)}
`);
    } catch {
      // A record that cannot be copied is still in the session's entries and reaches the ledger.
    }
  };
  const detach = subscribe
    ? recorder.attach({
        subscribe: (fn) =>
          subscribe((ev) => {
            fn(ev);
            copyRecord(ev);
          }),
      })
    : () => {};
  opts.booted.answerSink.record = (question, answer) => {
    try {
      recorder.answer(question, answer);
    } catch {
      // A transcript write must never fail the tool call that produced it.
    }
  };
  opts.booted.taskListSink.write = (state) => {
    try {
      writeTaskListFile(dir, opts.session.sessionId, state);
    } catch {
      // A list that cannot be written is not a reason to fail the turn. The
      // list is still live in memory and still lands in the snapshot.
    }
  };
  // T145: each post-edit run lands beside `tasks.json` as it happens, with the
  // text the model was shown, so `lykos show` reads it rather than rebuilding it.
  // A booted session built without the loop's state (a stub) records nothing.
  const postEditState = opts.booted.postEditState as PostEditState | undefined;
  if (postEditState !== undefined) postEditState.record = (run) => appendPostEditRun(dir, run);
  if (opts.continuationsUsed !== undefined) {
    try {
      writeTaskListFile(dir, opts.session.sessionId, opts.booted.taskList);
    } catch {
      // The live in-memory list remains authoritative for this run; the
      // normal task-list sink will retry on the first mutation.
    }
  }
  return { recorder, detach };
}
