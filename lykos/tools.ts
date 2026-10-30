// `tools/` — the agent's tools, in one module.
//
// A fresh reader answers "what tools does this session have, and why?"
// here. Session assembly, the delegate path, the CLI reporters and the
// schema-tax catalog are callers. ADR-0009's default/available relabel is
// P10's edit to this module, not a parallel structure.

export {
  resolveSessionTools,
  resolveStandaloneTools,
  sessionWantsAgent,
  loadTools,
  applyToolDeltas,
  type SessionToolSpecialist,
  type LoadToolsDeps,
  type LoadedTools,
} from "./tools/session-tools.js";

export {
  AGENT_TOOL_NAME,
  DEFAULT_RESIDENT_TOOLS,
  canonicalToolName,
  MOUNTED_SUBAGENT_TOOLS,
  MOUNTED_TOOLS,
  PI_DELEGATE_OMIT_TOOLS,
  REGISTRY_TOOL_RISKS,
  RUNTIME_AVAILABLE_TOOLS,
  SUBAGENT_WORKFLOW_TOOL,
  TOOL_REGISTRY,
  fullSubagentsMeasurement,
  matchesDocumentedSurface,
  omitToolsMeasurement,
  resolveResidentTools,
  workerPlusHostMeasurement,
  workerSurfaceMeasurement,
  workflowOnlyMeasurement,
  type PromptPresence,
  type ResolveResidentToolsOpts,
  type ToolRegistryEntry,
  type ToolResidency,
} from "./tools/tool-surface.js";

export {
  RISK_TIERS,
  DEFAULT_RISK_TIER,
  RISK_TIER_LABEL,
  LYKOS_TOOL_RISKS,
  TOOL_RISKS,
  readOnlyHint,
  destructiveHint,
  isRiskTier,
  riskForTool,
  tierForTool,
  tierForCommandRisk,
  type RiskTier,
  type ToolRisk,
} from "./tools/tool-risk.js";

export { buildGatedTools, POWERSHELL_TOOL_NAME } from "./tools/gated.js";

// P10.4: search and navigation. All four are Pi's implementations — `glob` is
// `find` renamed (D1) and `grep` is `grep`. (It carried a snapshot tag until T168 removed the anchored editor.)
export {
  FIND_TOOL_NAME,
  GLOB_DESCRIPTION,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  LS_TOOL_NAME,
  buildFindTool,
  buildGlobTool,
  buildLsTool,
  buildGrepTool,
} from "./tools/search.js";

// P10.4: structural search and rewrite, over `@ast-grep/napi`. Both mounted
// (D8), so their schemas ride no request and `tool_call` is the way in.
export {
  AST_GREP_TOOL_NAME,
  AST_GREP_DESCRIPTION,
  AST_GREP_PARAMETERS,
  AST_GREP_DEFAULT_LIMIT,
  buildAstGrepTool,
  renderAstGrepResult,
  type AstGrepOpts,
} from "./tools/ast-grep.js";

export {
  AST_EDIT_TOOL_NAME,
  AST_EDIT_DESCRIPTION,
  AST_EDIT_PARAMETERS,
  AST_EDIT_NO_CHANGE,
  AST_EDIT_NO_MATCH,
  buildAstEditTool,
  planFile,
  type AstEditOpts,
  type AstEditRule,
} from "./tools/ast-edit.js";

// P10.4 (ticket 15): the language-server client. Mounted (D9), so its schema
// rides no request and `tool_call` is the way in. The POOL is the session's,
// not the tool's — `loadTools()` returns it and the session kills it.
export {
  LSP_TOOL_NAME,
  LSP_ACTIONS,
  LSP_DESCRIPTION,
  LSP_PARAMETERS,
  buildLspTool,
  collectWorkspaceEdits,
  extractHoverText,
  normalizeLocations,
  renderDiagnostics,
  type LspToolOpts,
} from "./tools/lsp.js";

export {
  DEFAULT_LSP_SERVERS,
  LSP_REQUEST_TIMEOUT_SECONDS,
  LspClient,
  LspPositionError,
  LspServerPool,
  LspNotReadyError,
  LspTimeoutError,
  applyLspTextEdits,
  positionFor,
  resolveServerCommand,
  resolveSymbolColumn,
  serverKeyForPath,
  type LspServerStatus,
} from "./tools/lsp-client.js";

// P10.5 (ticket 16): the background shell. Mounted (D10), so its schema rides
// no request and `tool_call` is the way in. The REGISTRY is the session's, not
// the tool's — `loadTools()` returns it and the session kills every job on it.
export {
  HUB_TOOL_NAME,
  HUB_OPS,
  HUB_DESCRIPTION,
  HUB_PARAMETERS,
  PEER_DATA_NOTE,
  buildHubTool,
  describeJob,
  describeMessage,
  sendFailure,
  type HubOp,
  type HubToolOpts,
} from "./tools/hub.js";

// P10.5 (ticket 17): the peer mailbox. The BUS is a session family's, never
// this module's — `SpawnContext` carries it and `loadTools()` mints a family of
// one when a session did not inherit one.
export {
  DEFAULT_PEER_NAME,
  MAILBOX_CAP,
  PEER_WAIT_DEFAULT_MS,
  PEER_WAIT_MAX_MS,
  PeerBus,
  PeerMailbox,
  newPeerFamily,
  type DeliveryReceipt,
  type InboxResult,
  type PeerMessage,
  type PeerState,
  type PeerStatus,
  type SendReport,
  type WaitOutcome,
} from "./tools/mailbox.js";

// P10.6 (ticket 19): the forge tool and the evaluation cell. Both mounted
// (D10), so their schemas ride no request and `tool_call` is the way in. The
// evaluation POOL is the session's, not the tool's — `loadTools()` returns it
// and the session disposes every child on it.
export {
  GITHUB_TOOL_NAME,
  GITHUB_OPS,
  GITHUB_WRITE_OPS,
  GITHUB_DESCRIPTION,
  GITHUB_PARAMETERS,
  GH_MISSING_NOTICE,
  GH_NO_REPO_NOTICE,
  GH_UNAUTHENTICATED_NOTICE,
  LOCAL_GH_RUNNER,
  buildGithubTool,
  ghArgsFor,
  isAuthFailure,
  isGithubWriteOp,
  isNoRepoFailure,
  writeSummaryFor,
  type GhResolved,
  type GhRunner,
  type GhCommandResult,
  type GithubOp,
  type GithubToolOpts,
} from "./tools/github.js";

export {
  EVAL_TOOL_NAME,
  EVAL_DESCRIPTION,
  EVAL_PARAMETERS,
  EVAL_PYTHON_CONFIG_KEY,
  EVAL_PYTHON_UNCONFIGURED_NOTICE,
  buildEvalTool,
  cellHeadline,
  isEvalLanguage,
  renderOutcome,
  resolveEvalTimeoutMs,
  type EvalToolOpts,
} from "./tools/eval.js";

export {
  EVAL_DEFAULT_TIMEOUT_SECONDS,
  EVAL_LANGUAGES,
  EVAL_MAX_OUTPUT_BYTES,
  EVAL_MAX_TIMEOUT_SECONDS,
  EvalRuntime,
  EvalRuntimePool,
  type EvalLanguage,
  type EvalOutcome,
  type EvalRuntimeOpts,
} from "./tools/eval-runtime.js";

// P10.7 (ticket 12): the web pair. Both RESIDENT (D10) — the first tools since
// P10.4 whose schemas ride every request — and both built on two injected
// seams, a fetcher and a resolver, so no test reaches the network (D9). The
// address policy is the load-bearing part: `resolveTarget` runs before the
// first request and again on every redirect hop.
export {
  WEB_FETCH_TOOL_NAME,
  WEB_FETCH_DESCRIPTION,
  WEB_FETCH_PARAMETERS,
  WEB_FETCH_CACHE_MAX,
  WEB_FETCH_CACHE_TTL_MS,
  WEB_FETCH_MAX_BYTES,
  WEB_FETCH_MAX_REDIRECTS,
  WEB_FETCH_PAGE_CHARS,
  WEB_FETCH_TIMEOUT_MS,
  SYSTEM_HOST_RESOLVER,
  SYSTEM_WEB_FETCHER,
  blockedAddressReason,
  blockedV4Reason,
  blockedV6Reason,
  buildWebFetchTool,
  cacheLookup,
  cacheStore,
  crossHostNotice,
  extractArticle,
  extractionFailureReason,
  newFetchCache,
  paginate,
  readCapped,
  resolveTarget,
  type CachedPage,
  type FetchCache,
  type HostResolver,
  type TargetVerdict,
  type WebFetchToolOpts,
  type WebFetcher,
  type WebResponseLike,
} from "./tools/web-fetch.js";

export {
  WEB_SEARCH_TOOL_NAME,
  WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_PARAMETERS,
  WEB_SEARCH_DEFAULT_COUNT,
  WEB_SEARCH_MAX_COUNT,
  WEB_SEARCH_SNIPPET_CHARS,
  WEB_SEARCH_ENDPOINT_KEY,
  WEB_SEARCH_KEY_ENV_KEY,
  WEB_SEARCH_PROVIDER_KEY,
  BRAVE_SEARCH_ENDPOINT,
  BRAVE_SEARCH_KEY_ENV,
  BRAVE_SEARCH_KEY_HEADER,
  KNOWN_SEARCH_PROVIDERS,
  SYSTEM_SEARCH_FETCHER,
  braveRequest,
  buildWebSearchTool,
  filterHits,
  hostMatchesDomain,
  isKnownSearchProvider,
  normalizeDomain,
  parseBraveResults,
  providerQueryString,
  renderHits,
  resolveSearchCount,
  searchKeyFromEnv,
  stripTags,
  unconfiguredNotice,
  unknownProviderNotice,
  type SearchFetcher,
  type SearchHit,
  type SearchQuery,
  type SearchResponseLike,
  type WebSearchToolOpts,
} from "./tools/web-search.js";

// P10.8 (ticket 23): the deterministic scanner. Mounted (D10), so its schema
// rides no request and `tool_call` is the way in. The rule set is imported from
// `loop/hooks.ts` and `gate/critical-commands.ts` rather than restated, so there
// is one answer in this codebase to what a credential shape is and one to what a
// catastrophic command shape is.
export {
  SECURITY_SCAN_TOOL_NAME,
  SECURITY_SCAN_DESCRIPTION,
  SECURITY_SCAN_PARAMETERS,
  SECURITY_OPS,
  SECURITY_SEVERITIES,
  SECURITY_DEFAULT_LIMIT,
  SECURITY_EXCERPT_WIDTH,
  SECURITY_MAX_FILES,
  SECURITY_MAX_FILE_BYTES,
  COMMAND_RULES,
  CONTENT_RULES,
  FILE_RULES,
  LOCAL_SECURITY_STORE,
  SECRET_RULES,
  buildSecurityScanTool,
  fingerprintOf,
  flattenExcerpt,
  isScanId,
  isSecuritySeverity,
  redactSpan,
  renderScan,
  renderSkips,
  ruleSlug,
  scanFileName,
  scanIdFor,
  scanText,
  securityDirectory,
  sortFindings,
  type ContentRule,
  type FileRule,
  type ScanRender,
  type SecurityFinding,
  type SecurityOp,
  type SecurityScanOpts,
  type SecurityScanRecord,
  type SecuritySeverity,
  type SecuritySkips,
  type SecurityStore,
} from "./tools/security-scan.js";

export {
  JOB_LOG_DEFAULT_LINES,
  JOB_LOG_MAX_BYTES,
  JOB_LOG_MAX_READ_BYTES,
  JOB_STOP_GRACE_MS,
  JobRegistry,
  TREE_KILL_SPAWN_OPTIONS,
  jobsDirectory,
  killProcessTree,
  type JobRecord,
  type JobStatus,
  type KillTreeOutcome,
} from "./tools/job-runner.js";

export {
  AST_MAX_FILES,
  AST_SUPPORTED_EXTENSIONS,
  applyEdits,
  languageForPath,
  metavariablesIn,
  overlapProblems,
  rewriteProblems,
  scanFiles,
  searchSource,
  substitute,
  type AstCapture,
  type AstMatch,
  type AstScan,
  type AstWalk,
} from "./tools/ast.js";

// T168 (ADR-0031): the one `edit` (exact text replacement plus `replaceAll`) and
// the `read` that numbers every line. `loadTools()` registers both.
export {
  EDIT_DESCRIPTION,
  EDIT_PARAMETERS,
  EDIT_TOOL_NAME,
  buildEditTool,
  resolveEditPath,
  type EditToolOpts,
} from "./tools/edit.js";

export {
  applyEditsToNormalizedContent,
  prepareEditArguments,
  type AppliedEdits,
  type TextEdit,
} from "./tools/edit-match.js";

export { READ_TOOL_NAME, buildReadTool, numberReadText, type ReadToolOpts } from "./tools/read.js";

export {
  ASK_TOOL_NAME,
  ASK_DEFAULT_RULE,
  buildAskTool,
  newAskState,
  parseAskAnswer,
  renderAskPrompt,
  TerminalAsk,
  type AskHuman,
  type AskState,
  type AskRequest,
} from "./tools/ask.js";

export {
  EXIT_PLAN_TOOL_NAME,
  NOT_PLANNING_NOTICE,
  PLAN_DECLINED_NOTICE,
  buildExitPlanTool,
  newPlanState,
  type PlanState,
  type ExitPlanToolOpts,
} from "./tools/plan-tool.js";

export {
  TOOL_CALL_TOOL_NAME,
  TOOL_CALL_DESCRIPTION,
  buildToolCallTool,
  resolveActualToolName,
  resolveActualToolArgs,
  tierForToolCall,
} from "./tools/tool-call.js";

export {
  TOOL_SEARCH_TOOL_NAME,
  TOOL_SEARCH_DESCRIPTION,
  buildToolSearchTool,
} from "./tools/tool-search.js";

export {
  TASK_LIST_TOOL_NAME,
  DEFAULT_REMINDER_INTERVAL,
  buildTaskListTool,
  newTaskListState,
  resumeTaskListState,
  readTaskListFile,
  writeTaskListFile,
  applyTaskListUpdate,
  hasOpenItems,
  renderTaskList,
  taskListReminder,
  type TaskItem,
  type TaskItemStatus,
  type TaskItemVerifier,
  type TaskListState,
  type TaskListUpdate,
} from "./tools/task-list.js";

export {
  buildAgentTool,
  ensureParentSessionForSpawn,
  runChildSession,
  type ChildRunOutcome,
  type ChildRunRequest,
  type SpawnContext,
} from "./tools/spawn.js";

// P10.6 (ticket 20): the nine session and context tools. All mounted (D9), so
// their schemas ride no request and `tool_call` is the way in. The three pieces
// of session state are the session's, not these modules' — `loadTools()`
// returns them and they die with the session.
export {
  CHECKPOINT_TOOL_NAME,
  CHECKPOINT_TOOL_NAMES,
  CHECKPOINT_DESCRIPTION,
  CHECKPOINT_PARAMETERS,
  LOCAL_CHECKPOINT_VIEW,
  NOTHING_MOVED_NOTICE,
  REWIND_TOOL_NAME,
  REWIND_DESCRIPTION,
  REWIND_PARAMETERS,
  buildCheckpointTool,
  buildCheckpointTools,
  buildRewindTool,
  newCheckpointProposalState,
  resolveRewindTarget,
  rewindCommandFor,
  type CheckpointMark,
  type CheckpointProposalState,
  type CheckpointView,
  type RewindProposal,
} from "./tools/checkpoint-tools.js";

export {
  CONTEXT_NOTES_TOOL_NAME,
  CONTEXT_NOTES_DESCRIPTION,
  CONTEXT_NOTES_PARAMETERS,
  CONTEXT_NOTES_MAX_BYTES,
  CONTEXT_NOTES_MAX_KEYS,
  CONTEXT_TOOL_NAMES,
  GOAL_TOOL_NAME,
  GOAL_DESCRIPTION,
  GOAL_PARAMETERS,
  SCRATCHPAD_NOTICE,
  THINK_TOOL_NAME,
  THINK_ACKNOWLEDGEMENT,
  THINK_DESCRIPTION,
  THINK_PARAMETERS,
  buildContextNotesTool,
  buildContextTools,
  buildGoalTool,
  buildThinkTool,
  newSessionScratch,
  type SessionScratch,
} from "./tools/context-tools.js";

export {
  MANAGE_SKILL_TOOL_NAME,
  MANAGE_SKILL_ACTIONS,
  MANAGE_SKILL_DESCRIPTION,
  MANAGE_SKILL_PARAMETERS,
  SKILL_TOOL_NAME,
  SKILL_TOOL_NAMES,
  SKILL_DESCRIPTION,
  SKILL_PARAMETERS,
  buildManageSkillTool,
  buildSkillTool,
  buildSkillTools,
  normalizeSkillName,
  renderSkillFile,
  sanitizeSkillDescription,
  stripFrontmatter,
  type SkillToolsOpts,
} from "./tools/skill-tools.js";

export {
  NEW_CONTEXT_TOOL_NAME,
  NEW_CONTEXT_DEFAULT_SPECIALIST,
  NEW_CONTEXT_DESCRIPTION,
  NEW_CONTEXT_PARAMETERS,
  NO_SUB_CONTEXT_NOTICE,
  buildNewContextTool,
  type NewContextToolOpts,
} from "./tools/new-context.js";

export {
  YIELD_TOOL_NAME,
  YIELD_DESCRIPTION,
  YIELD_PARAMETERS,
  buildYieldTool,
  checkAgainstSchema,
  newYieldState,
  type YieldRecord,
  type YieldState,
} from "./tools/yield-tool.js";
