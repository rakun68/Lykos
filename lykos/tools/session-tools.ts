// The tools module's external seam: which names a session carries, and the
// custom definitions it registers. Callers (session assembly, the delegate
// path, the CLI reporters, the schema-tax catalog) come through here rather
// than reading the registry.

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ApprovalGate, DenialLog } from "../gate/approval.js";
import type { InteractionMode } from "../gate/modes.js";
import type { LykosEventSink } from "../extensions/api.js";
import type { LspServerDecl } from "../config/types.js";
import { ASK_TOOL_NAME, buildAskTool, type AskHuman, type AskState } from "./ask.js";
import { buildEditTool, EDIT_TOOL_NAME } from "./edit.js";
import { buildGatedTools } from "./gated.js";
import type { ProjectExecutor } from "./executor.js";
import { buildReadTool } from "./read.js";
import { FileReadRecord } from "./read-record.js";
import { buildAstEditTool } from "./ast-edit.js";
import { buildCommitTool, COMMIT_TOOL_NAME, CommitLog, type CommitRecord } from "./commit.js";
import { buildAstGrepTool } from "./ast-grep.js";
import {
  buildCheckpointTools,
  newCheckpointProposalState,
  type CheckpointProposalState,
} from "./checkpoint-tools.js";
import { buildContextTools, newSessionScratch, type SessionScratch } from "./context-tools.js";
import { buildNewContextTool } from "./new-context.js";
import { buildSkillTools } from "./skill-tools.js";
import { buildYieldTool, newYieldState, type YieldState } from "./yield-tool.js";
import { buildEvalTool } from "./eval.js";
import { EvalRuntimePool } from "./eval-runtime.js";
import { buildGithubTool } from "./github.js";
import { buildHubTool } from "./hub.js";
import { JobRegistry } from "./job-runner.js";
import { newPeerFamily, type PeerMailbox } from "./mailbox.js";
import { LspServerPool } from "./lsp-client.js";
import { buildLspTool } from "./lsp.js";
import { buildMemoryTools } from "./memory-tools.js";
import { buildFindTool, buildGlobTool, buildLsTool, buildGrepTool } from "./search.js";
import { buildSecurityScanTool } from "./security-scan.js";
import { confineToWorkspace } from "./workspace-confine.js";
import { buildWebFetchTool } from "./web-fetch.js";
import { buildWebSearchTool, type SearchBackendKeys } from "./web-search.js";
import { EXIT_PLAN_TOOL_NAME, buildExitPlanTool, type PlanState } from "./plan-tool.js";
import { buildAgentTool, type SpawnContext } from "./spawn.js";
import {
  buildTaskListTool,
  TASK_LIST_TOOL_NAME,
  type TaskItemVerifier,
  type TaskListState,
} from "./task-list.js";
import {
  type Coordinator,
  buildCoordinatorAskTool,
  buildCoordinatorGiveUpTool,
  COORDINATOR_ASK_TOOL_NAME,
  COORDINATOR_GIVE_UP_TOOL_NAME,
} from "./coordinator.js";
import { TOOL_CALL_TOOL_NAME, buildToolCallTool } from "./tool-call.js";
import { TOOL_SEARCH_TOOL_NAME, buildToolSearchTool } from "./tool-search.js";
import {
  AGENT_TOOL_NAME,
  DEFAULT_RESIDENT_TOOLS,
  TOOL_REGISTRY,
  canonicalToolName,
  resolveSessionTools as resolveWorkerAllowlist,
  type ResolveSessionToolsOpts,
} from "./tool-surface.js";

export type { ResolveSessionToolsOpts };

/** Tools that run a command rather than act on a named file. */
const HOST_COMMAND_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);

const STANDALONE_HOST_TOOLS = [
  TASK_LIST_TOOL_NAME,
  ASK_TOOL_NAME,
  EXIT_PLAN_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  TOOL_CALL_TOOL_NAME,
] as const;

/**
 * What a caller says about a session's tool surface. `standalone` is the
 * host-path extras (`todo`/`ask`/`exit_plan` and the transport pair);
 * omitted, this is the worker/delegate allowlist.
 */
export interface SessionToolSpecialist {
  /**
   * Caller override. Wins entirely — extras, SubagentWorkflow, a read-only
   * subset, an empty list. The documented surface is the default, not a
   * ceiling the caller cannot raise (DECISIONS.md caller-override).
   */
  tools?: readonly string[];
  /** When `tools` is unset, include the subagent-host tools. */
  subagents?: boolean;
  /**
   * Host-path extras: `todo`, and (unless this is a child) `ask` and
   * `exit_plan`. The worker/delegate path leaves this unset.
   */
  standalone?: boolean;
  /** Children never receive Agent even if the caller asked for subagents. */
  isChild?: boolean;
}

export function resolveStandaloneTools(opts: {
  tools?: readonly string[];
  subagents?: boolean;
  isChild?: boolean;
}): string[] {
  if (opts.tools !== undefined) {
    const names = opts.tools.map(canonicalToolName);
    return opts.isChild ? names.filter((t) => t !== AGENT_TOOL_NAME) : names;
  }
  // T103: `ask` is on the DEFAULT surface but registers only when a human
  // channel exists, so a one-shot run names it and never carries its schema.
  // Naming it here rather than only in the interactive path keeps one
  // documented surface instead of two that drift.
  //
  // Agent is mounted: opted-in host sessions register it as a custom tool
  // so `tool_call` can dispatch it, but it does not ride the boot allowlist.
  if (opts.subagents && !opts.isChild) {
    return [...DEFAULT_RESIDENT_TOOLS, ...STANDALONE_HOST_TOOLS];
  }
  // A child never asks: there is no human on the other end of a subagent, and
  // a specialist that stops to ask questions is a specialist that blocks its
  // parent for nothing.
  //
  // D23: the child does get the transport pair. `hub` is mounted, and without
  // `tool_search` and `tool_call` the mailbox built for a spawned child has
  // no caller. `agent` stays off this list so a child cannot spawn another.
  if (opts.isChild) {
    return [...resolveWorkerAllowlist({}), TASK_LIST_TOOL_NAME, TOOL_SEARCH_TOOL_NAME, TOOL_CALL_TOOL_NAME];
  }
  return [...resolveWorkerAllowlist({}), ...STANDALONE_HOST_TOOLS];
}

/**
 * Which tool names this session carries. Worker/delegate by default;
 * `standalone: true` is the host path (today's `resolveStandaloneTools`).
 */
export function resolveSessionTools(specialist: SessionToolSpecialist = {}): string[] {
  if (specialist.standalone === true) {
    return resolveStandaloneTools({
      ...(specialist.tools !== undefined ? { tools: specialist.tools } : {}),
      ...(specialist.subagents !== undefined ? { subagents: specialist.subagents } : {}),
      ...(specialist.isChild !== undefined ? { isChild: specialist.isChild } : {}),
    });
  }
  return resolveWorkerAllowlist({
    ...(specialist.tools !== undefined ? { tools: specialist.tools } : {}),
    ...(specialist.subagents !== undefined ? { subagents: specialist.subagents } : {}),
  });
}

/**
 * Specialists ticket 02: `tools_add`/`tools_remove` move a tool between
 * resident and mounted rather than between present and absent, so trimming
 * the prompt with `tools_remove` is meant to never remove capability once
 * P10's transport exists. Today `tools_remove` still drops a name from the
 * resident set — `config/specialists.ts` emits a notice saying so at
 * selection time.
 */
export function applyToolDeltas(
  names: readonly string[],
  add?: readonly string[],
  remove?: readonly string[],
): string[] {
  let result = [...names];
  if (add && add.length > 0) {
    for (const raw of add) {
      const t = canonicalToolName(raw);
      const entry = TOOL_REGISTRY.find((e) => e.name === t);
      if (entry && entry.residency === "off") {
        continue;
      }
      if (!result.includes(t)) result.push(t);
    }
  }
  if (remove && remove.length > 0) {
    const dropped = new Set(remove.map(canonicalToolName));
    result = result.filter((t) => !dropped.has(canonicalToolName(t)));
  }
  return result;
}

/** A named Agent is still wanted even when it is mounted, not resident. */
export function sessionWantsAgent(names: readonly string[]): boolean {
  return names.some((name) => canonicalToolName(name) === AGENT_TOOL_NAME);
}

export interface LoadToolsDeps {
  cwd: string;
  /**
   * T184: where the project's own `.lykos/` state lives (memory, proposals, jobs, scan records) when `cwd` is a
   * worktree. Absent, it is `cwd`. A worktree is removed with the call, so state written there would be lost.
   */
  stateRoot?: string;

  /** T172: where `bash`, `powershell`, `eval` and background jobs run their processes. Absent means this machine. */
  executor?: ProjectExecutor;
  gate: ApprovalGate;
  denials?: DenialLog;
  modelProvider: string;
  modelId: string;
  /**
   * P10.4 (ticket 15, D4): the resolved `lsp.servers` table. Omitted, the
   * shipped default applies — so a caller that predates the knob gets the one
   * entry Lykos ships rather than no language server at all.
   */
  lspServers?: Record<string, LspServerDecl>;
  /** T171: the project is trusted, so a language server binary inside it may start. Absent means not. */
  workspaceTrusted?: boolean;
  /**
   * P10.5 (ticket 17, D2): this session's seat on its family's peer bus, when
   * it was spawned into a family. Omitted, `loadTools()` mints a family of one
   * — which is the right answer for a session nothing spawned, and is what
   * makes two unrelated sessions in one process unable to reach each other by
   * construction rather than by a check somebody has to remember to write.
   */
  mailbox?: PeerMailbox;
  /**
   * P10.6 (ticket 18, D7): this session's id, stamped as `src=` on any memory
   * it proposes. Provenance is what makes a bad memory traceable to the
   * session that proposed it, which is the only way the human accepting one
   * can tell a considered lesson from a confused turn. Optional, because a
   * caller with no id is better served by a proposal with no `src` than by a
   * made-up one.
   */
  sessionId?: string;
  /**
   * P10.6 (ticket 19, D6): the configured Python interpreter, from
   * `eval.python`. Omitted — which is the shipped default — is what makes
   * `eval` with `language: "py"` report itself unconfigured by naming the key
   * rather than by failing.
   */
  evalPython?: string;
  /**
   * T168 part B (ADR-0031, decision 11): the resolved `edit.require_read`.
   * Omitted means off, which is the shipped default and changes nothing about
   * either tool, including its description.
   */
  editRequireRead?: boolean;
  /**
   * P10.7 (ticket 12, D2/D3): the resolved `web.search` declaration plus the
   * key already read out of the environment by the caller.
   *
   * The KEY is passed in rather than read here for the reason
   * `specialist-credentials.ts` reads an injected `env` rather than
   * `process.env`: a tool that reaches into the process environment itself is
   * a tool no test can put in a known state, and one whose behaviour depends
   * on something no caller can see. Omitted — the shipped state — is what
   * makes `web_search` answer by naming the setting rather than by failing.
   */
  webSearch?: {
    provider?: string;
    endpoint?: string;
    keyEnv?: string;
    apiKey?: string;
    /** Ticket 24 D1: the keys the `auto` chain consults, resolved by the caller on the same terms as `apiKey`. */
    keys?: SearchBackendKeys;
  };
  /**
   * P10.6 (ticket 20, D5): the output schema a caller asked this session's
   * final result to match. Omitted — the shipped default — means `yield`
   * accepts a text answer as written. Set, and a yield that does not match it
   * is handed back to the model with the schema rather than repaired
   * downstream.
   */
  yieldSchema?: unknown;
  /**
   * T179: the session can commit — the folder is a git repository and git runs.
   * Omitted or false, `commit` is not built, so the model is never offered a
   * tool that can only fail; `session/boot.ts` decides it from the one git probe.
   */
  commitEnabled?: boolean;
  /** T179: called the moment `commit` makes a commit — where it is made durable. */
  onCommit?: (record: CommitRecord) => void | Promise<void>;
  spawnContext?: SpawnContext;
  taskList?: {
    state: TaskListState;
    onChange: (state: TaskListState) => void;
    verifier?: TaskItemVerifier;
    /** P10.9 (ticket 21, D2): where `task_list_changed` fires into. */
    events?: LykosEventSink;
  };
  ask?: {
    state: AskState;
    askHuman: AskHuman;
    record?: (question: string, answer: string) => void;
  };
  exitPlan?: {
    state: PlanState;
    currentMode: () => InteractionMode;
    isPlanning?: () => boolean;
    requestExit: (plan: string) => Promise<InteractionMode | null>;
  };
  coordinator?: Coordinator;
}

export interface LoadedTools {
  customTools: ToolDefinition[];
  activeToolNames: string[];
  /**
   * P10.4 (ticket 15, D5): the session's language servers.
   *
   * Surfaced here because the session has to shut it down, and because there
   * must be exactly one answer to "who kills these processes". It is created
   * per `loadTools()` call — which is once per session — rather than held in
   * a module-level map, so one session's servers cannot outlive it into the
   * next session in the same process. `session/boot.ts` carries it onto the
   * booted session and both finish paths call `shutdownAll()`.
   */
  lsp: LspServerPool;
  /**
   * P10.5 (ticket 16, D2/D6): the session's background jobs.
   *
   * Surfaced for `lsp`'s reason and on `lsp`'s terms: the SESSION owns the
   * lifecycle, so there is exactly one answer to "who kills these processes".
   * Created per `loadTools()` call — which is once per session — rather than
   * held in a module-level map, so one session's jobs cannot outlive it into
   * the next session in the same process, and one session cannot stop
   * another's. `session/boot.ts` carries it onto the booted session and both
   * finish paths call `stopAll()`.
   */
  jobs: JobRegistry;
  /**
   * P10.5 (ticket 17, D2): this session's seat on its family's peer bus —
   * either the one the caller passed in (a child, joined by the spawn that
   * created it) or the family of one minted here.
   *
   * Surfaced for the reason `jobs` is: the SESSION owns the lifecycle, and
   * `leave()` at teardown is what makes `list` omit an agent that has
   * finished. It is per `loadTools()` call, so one session's mailbox cannot be
   * read by the next session in the same process.
   */
  mailbox: PeerMailbox;
  /**
   * P10.6 (ticket 19, D5): this session's evaluation runtimes.
   *
   * Surfaced for the reason `lsp` and `jobs` are, and on the same terms: the
   * SESSION owns the lifecycle, so there is exactly one answer to "who kills
   * these processes". Created per `loadTools()` call — which is once per
   * session — rather than held in a module-level map, so one session's cells
   * cannot outlive it into the next session in the same process, and one
   * session cannot read another's variables. `session/boot.ts` carries it onto
   * the booted session and both finish paths call `disposeAll()`.
   */
  evalRuntimes: EvalRuntimePool;
  /**
   * P10.6 (ticket 20, D2/D6): this session's notes and its standing objective.
   *
   * Surfaced for the reason `mailbox` is, and on the same terms: it is created
   * per `loadTools()` call — which is once per session — rather than held in a
   * module-level map, so one session's notes cannot be read by the next
   * session in the same process. There is nothing to tear down, because there
   * is nothing on disk: when the object is dropped the notes are gone, which
   * is exactly what D2 says they are.
   */
  scratch: SessionScratch;
  /**
   * P10.6 (ticket 20, D1): the points this session named, and the returns it
   * proposed.
   *
   * Per-session for `scratch`'s reason. It holds proposals and nothing else —
   * no checkpoint was written and no tree was moved to record here, because no
   * tool can do either.
   */
  checkpointProposals: CheckpointProposalState;
  /**
   * T179: the commits this session made through `commit`, in order. Per
   * session by construction, and surfaced for the reason `jobs` is: the SESSION
   * owns the lifecycle, and its end writes these to the ledger.
   */
  commits: CommitLog;
  /** P10.6 (ticket 20, D5): what this session yielded, and how many yields were handed back for not matching the requested schema. */
  yielded: YieldState;
}

/**
 * T168 (ADR-0031): the two tools every session edits through, which are
 * Lykos's own and shadow Pi's under the same names.
 *
 * `edit` is Pi's exact text replacement plus `replaceAll` (`tools/edit.ts`),
 * gated through the same `EditOperations` Pi's gated edit used, so it takes
 * Pi's place in the gated list rather than joining it. `read` is Pi's read
 * with every text line numbered (`tools/read.ts`). There is one mode: no
 * config key picks another editor.
 *
 * The three tools that must agree about what the session has seen — `read`,
 * `edit` and `write` — share one `FileReadRecord`, built here and so once per
 * session. `edit.require_read` is a property of that record.
 */
function buildEditTools(deps: LoadToolsDeps): ToolDefinition[] {
  const reads = new FileReadRecord(deps.editRequireRead === true);
  const gated = buildGatedTools(deps.cwd, deps.gate, deps.denials, {
    reads,
    ...(deps.executor !== undefined ? { executor: deps.executor } : {}),
  });
  const edit = buildEditTool({
    cwd: deps.cwd,
    gate: deps.gate,
    reads,
    ...(deps.denials !== undefined ? { denials: deps.denials } : {}),
  });
  // Substituted in place rather than filtered and appended, so the
  // registration order a session has always had — write, edit, bash — does
  // not change as a side effect of which editor is in force.
  const tools = gated.map((t) => (t.name === EDIT_TOOL_NAME ? edit : t));
  tools.push(buildReadTool({ cwd: deps.cwd, reads }));
  return tools;
}

function isMountedName(name: string): boolean {
  return TOOL_REGISTRY.find((e) => e.name === name)?.residency === "mounted";
}

/**
 * The custom tools this session registers, and the active allowlist after
 * mounted names are stripped. `names` is the resolved surface; `deps` is
 * everything a definition needs that is not in the registry.
 */
export function loadTools(names: readonly string[], deps: LoadToolsDeps): LoadedTools {
  const agentToolDef = deps.spawnContext ? buildAgentTool(deps.spawnContext) : undefined;
  const activeToolNames = names.filter((n) => !isMountedName(n));
  const editTools = buildEditTools(deps);

  // P10.4 (ticket 13, D1/D2/D4): the search-and-navigation four, registered
  // unconditionally like the gated shadows above them. `grep` and `glob` are
  // resident and ride the wire; `find` and `ls` are mounted, so
  // `isMountedName` has already stripped them from `activeToolNames` and
  // `tool_call` is the only way in. All four are registered either way,
  // because a mounted tool that is not registered is a name `tool_call`
  // reports as unknown.
  const search = [
    buildGrepTool(deps.cwd),
    buildGlobTool(deps.cwd),
    buildFindTool(deps.cwd),
    buildLsTool(deps.cwd),
  ];

  // P10.4 (ticket 14, D8): the two structural tools, registered on the same
  // terms as the mounted half of `search` above — off `activeToolNames`,
  // reachable only through `tool_call`. `ast_edit` takes the session's gate
  // because the gate IS its apply (D3).
  const ast = [
    buildAstGrepTool({ cwd: deps.cwd }),
    buildAstEditTool({
      cwd: deps.cwd,
      gate: deps.gate,
      ...(deps.denials !== undefined ? { denials: deps.denials } : {}),
    }),
  ];

  // P10.4 (ticket 15, D5/D9): the language-server client, mounted on the same
  // terms as `ast_edit` above. The POOL is created here and returned, because
  // `loadTools()` runs once per session and a per-session object is what
  // makes "one server per language, killed at session end" true by
  // construction. Nothing starts here: the first call that needs a server is
  // what spawns one, and a session that never calls `lsp` never pays for it.
  const lspPool = new LspServerPool({
    cwd: deps.cwd,
    ...(deps.lspServers !== undefined ? { servers: deps.lspServers } : {}),
    ...(deps.workspaceTrusted === true ? { workspaceTrusted: true } : {}),
  });
  const lsp = buildLspTool({
    cwd: deps.cwd,
    gate: deps.gate,
    pool: lspPool,
    ...(deps.denials !== undefined ? { denials: deps.denials } : {}),
  });

  // P10.5 (ticket 16, D2/D6/D10): the background shell, mounted on the same
  // terms as `lsp` above. The REGISTRY is created here and returned, because
  // `loadTools()` runs once per session and a per-session object is what makes
  // "every job this session started dies with it" true by construction.
  // Nothing spawns here: a session that never calls `hub` never starts a
  // process and never creates `.lykos/jobs/`.
  const stateRoot = deps.stateRoot ?? deps.cwd;
  const jobs = new JobRegistry({ cwd: deps.cwd, stateRoot, ...(deps.executor !== undefined ? { executor: deps.executor } : {}) });
  // P10.5 (ticket 17, D2): the family's bus, or a family of one. Never a
  // module-level singleton — two unrelated sessions in one process (every MCP
  // worker, every test file) must not be able to read each other's mail, and
  // the only way to be sure of that is for there to be no shared object to
  // read.
  const mailbox = deps.mailbox ?? newPeerFamily();
  const hub = buildHubTool({
    cwd: deps.cwd,
    gate: deps.gate,
    jobs,
    mailbox,
    ...(deps.denials !== undefined ? { denials: deps.denials } : {}),
  });

  // P10.6 (ticket 18, D1/D8): the five memory tools, mounted on the same terms
  // as `lsp` and `hub` above. There is no per-session object to create and
  // nothing to tear down — the store is four markdown files under `.lykos/`,
  // and a session that never calls one of these touches none of them. The
  // dependency object is the real store; what it does NOT contain is
  // `acceptProposal`, which is how "no tool activates a memory" is enforced.
  const memory = buildMemoryTools({
    cwd: stateRoot,
    ...(deps.sessionId !== undefined ? { sessionId: deps.sessionId } : {}),
  });

  // P10.6 (ticket 19, D5/D10): the forge tool and the evaluation cell, mounted
  // on the same terms as `lsp` and `hub` above. The evaluation POOL is created
  // here and returned, because `loadTools()` runs once per session and a
  // per-session object is what makes "the runtime dies with the session" true
  // by construction. Nothing spawns here: a session that never evaluates a
  // cell never starts a process, and one that never calls `github` never
  // spawns `gh`.
  const evalRuntimes = new EvalRuntimePool({ cwd: deps.cwd, ...(deps.executor !== undefined ? { executor: deps.executor } : {}) });
  const evalTool = buildEvalTool({
    cwd: deps.cwd,
    gate: deps.gate,
    runtimes: evalRuntimes,
    ...(deps.denials !== undefined ? { denials: deps.denials } : {}),
    ...(deps.evalPython !== undefined && deps.evalPython !== "" ? { python: deps.evalPython } : {}),
  });
  const github = buildGithubTool({
    cwd: deps.cwd,
    gate: deps.gate,
    ...(deps.denials !== undefined ? { denials: deps.denials } : {}),
  });

  // P10.7 (ticket 12, D7/D10): the web pair, registered unconditionally like
  // the gated shadows and the search four — and RESIDENT, so unlike everything
  // registered since P10.4 their schemas stay in `activeToolNames` and ride
  // every request. Nothing opens a socket here: a session that never calls
  // either never resolves a name and never sends a query.
  //
  // `web_fetch`'s CACHE is created inside its builder, which runs once per
  // `loadTools()` call — which is once per session — so it is per-session by
  // construction rather than by a check somebody has to remember (D7). There
  // is nothing to tear down: when the definition is dropped the pages are
  // gone, which is exactly what D7 says they are.
  const webFetch = buildWebFetchTool({
    cwd: deps.cwd,
    gate: deps.gate,
    ...(deps.denials !== undefined ? { denials: deps.denials } : {}),
  });
  const webSearch = buildWebSearchTool({
    cwd: deps.cwd,
    gate: deps.gate,
    ...(deps.denials !== undefined ? { denials: deps.denials } : {}),
    ...(deps.webSearch?.provider !== undefined ? { provider: deps.webSearch.provider } : {}),
    ...(deps.webSearch?.endpoint !== undefined ? { endpoint: deps.webSearch.endpoint } : {}),
    ...(deps.webSearch?.keyEnv !== undefined ? { keyEnv: deps.webSearch.keyEnv } : {}),
    ...(deps.webSearch?.apiKey !== undefined ? { apiKey: deps.webSearch.apiKey } : {}),
    ...(deps.webSearch?.keys !== undefined ? { keys: deps.webSearch.keys } : {}),
  });

  // P10.8 (ticket 23, D9/D10): the deterministic scanner, mounted on the same
  // terms as `lsp` and `hub` above. There is no per-session object to create
  // and nothing to tear down: the rule set is fixed in source, the store is one
  // directory under `.lykos/`, and a session that never scans anything creates
  // no directory and reads no file. It is handed no gate, because it makes no
  // gate call — it reads files inside the project and writes its own record,
  // which is `ast_grep`'s answer and `retain`'s in one tool.
  const securityScan = buildSecurityScanTool({ cwd: deps.cwd, stateRoot });

  // P10.6 (ticket 20, D1/D2/D5/D6/D9): the nine session and context tools,
  // mounted on the same terms as everything above them. The three pieces of
  // STATE are created here and returned, because `loadTools()` runs once per
  // session and a per-session object is what makes "these notes die with the
  // session" true by construction rather than by a check somebody has to
  // remember. Nothing here touches the filesystem at load time and nothing
  // spawns: a session that never calls one of these writes nothing anywhere.
  //
  // What `checkpoint` and `rewind` are handed is a read-only VIEW of the
  // checkpoint list (D1). `createCheckpoint` and `restoreCheckpoint` are not
  // passed, not imported here and not reachable from those definitions, which
  // is how T104's rule survives this phase: a tool cannot move the working
  // tree because nothing it holds can.
  const scratch = newSessionScratch();
  const checkpointProposals = newCheckpointProposalState();
  const yielded = newYieldState();
  const context = buildContextTools({ scratch });
  const checkpoints = buildCheckpointTools({ cwd: deps.cwd, state: checkpointProposals });
  const skills = buildSkillTools({
    cwd: deps.cwd,
    gate: deps.gate,
    ...(deps.denials !== undefined ? { denials: deps.denials } : {}),
  });
  const newContext = buildNewContextTool({
    ...(deps.spawnContext !== undefined ? { spawn: deps.spawnContext } : {}),
  });
  const yieldTool = buildYieldTool({
    state: yielded,
    ...(deps.yieldSchema !== undefined ? { schema: deps.yieldSchema } : {}),
  });

  // T179: `commit` runs on the host through the protected git helper, in a
  // contained session as in any other. It is built only when the session can
  // use git, and only if it is on the surface; a read-only child's surface
  // (boot.ts) never carries it either.
  // "Resident when the session can write": the surface carries `edit` or `write`
  // (a specialist that removed both has no `commit`; a read-only child never had
  // either). The interaction modes do not change the surface, they gate the call.
  const commits = new CommitLog(deps.onCommit);
  const canWrite = names.includes(EDIT_TOOL_NAME) || names.includes("write");
  const commit =
    deps.commitEnabled === true && canWrite && names.includes(COMMIT_TOOL_NAME)
      ? [
          buildCommitTool({
            cwd: deps.cwd,
            gate: deps.gate,
            log: commits,
            ...(deps.denials !== undefined ? { denials: deps.denials } : {}),
          }),
        ]
      : [];

  // T171: the host file tools act only on files that resolve inside the
  // workspace. `bash` and `powershell` stay out: a command is contained by the
  // container, not by a path check. Mapped in place, so registration order is
  // unchanged.
  const confine = (t: ToolDefinition): ToolDefinition => (HOST_COMMAND_TOOLS.has(t.name) ? t : confineToWorkspace(t, deps.cwd, deps.gate));

  const customTools: ToolDefinition[] = [
    ...[...editTools, ...search, ...ast, lsp].map(confine),
    ...commit,
    hub,
    ...memory,
    evalTool,
    github,
    webSearch,
    webFetch,
    securityScan,
    ...checkpoints,
    ...context,
    newContext,
    ...skills,
    yieldTool,
    ...(agentToolDef !== undefined ? [agentToolDef] : []),
    ...(names.includes(TASK_LIST_TOOL_NAME) && deps.taskList !== undefined
      ? [
          buildTaskListTool({
            state: deps.taskList.state,
            onChange: deps.taskList.onChange,
            ...(deps.taskList.verifier !== undefined ? { verifier: deps.taskList.verifier } : {}),
            ...(deps.taskList.events !== undefined ? { events: deps.taskList.events } : {}),
          }),
        ]
      : []),
    ...(names.includes(ASK_TOOL_NAME) && deps.ask !== undefined
      ? [
          buildAskTool({
            state: deps.ask.state,
            askHuman: deps.ask.askHuman,
            ...(deps.ask.record !== undefined ? { record: deps.ask.record } : {}),
          }),
        ]
      : []),
    ...(names.includes(EXIT_PLAN_TOOL_NAME) && deps.exitPlan !== undefined
      ? [
          buildExitPlanTool({
            state: deps.exitPlan.state,
            currentMode: deps.exitPlan.currentMode,
            ...(deps.exitPlan.isPlanning !== undefined ? { isPlanning: deps.exitPlan.isPlanning } : {}),
            requestExit: deps.exitPlan.requestExit,
          }),
        ]
      : []),
    ...(deps.coordinator !== undefined
      ? [
          buildCoordinatorAskTool(deps.coordinator),
          buildCoordinatorGiveUpTool(deps.coordinator),
        ]
      : []),
  ];
  const transportTargets = () =>
    customTools.filter((t) => t.name !== TOOL_CALL_TOOL_NAME && t.name !== TOOL_SEARCH_TOOL_NAME);
  if (names.includes(TOOL_SEARCH_TOOL_NAME)) {
    customTools.push(buildToolSearchTool({ tools: transportTargets }));
  }
  if (names.includes(TOOL_CALL_TOOL_NAME)) {
    customTools.push(
      buildToolCallTool({
        tools: transportTargets,
        gate: deps.gate,
        ...(deps.denials !== undefined ? { denials: deps.denials } : {}),
      }),
    );
  }

  if (deps.coordinator !== undefined) {
    if (!activeToolNames.includes(COORDINATOR_ASK_TOOL_NAME)) activeToolNames.push(COORDINATOR_ASK_TOOL_NAME);
    if (!activeToolNames.includes(COORDINATOR_GIVE_UP_TOOL_NAME)) activeToolNames.push(COORDINATOR_GIVE_UP_TOOL_NAME);
  }

  return {
    customTools,
    activeToolNames,
    lsp: lspPool,
    jobs,
    mailbox,
    evalRuntimes,
    scratch,
    checkpointProposals,
    yielded,
    commits,
  };
}
