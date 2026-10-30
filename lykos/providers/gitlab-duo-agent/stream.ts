// The GitLab Duo Agent `streamSimple` for api `gitlab-duo-agent`.
//
// Pi 0.84.3 has no implementation of this protocol; Lykos registers this one through
// `ModelRuntime.registerProvider` and never patches Pi (rule 7).
//
// The run: REST setup against the GitLab instance (namespace discovery, the best-effort
// namespace settings PUT, project discovery, `direct_access`, workflow create, the available
// models query), each fetch on its own 30 s deadline; then one WebSocket to
// `/api/v4/ai/duo_workflows/ws` that sends `{ startRequest }` and reads checkpoints until a
// terminal status. A `runMCPTool` action ends the Pi turn with a tool call and keeps the socket
// open; the next `streamSimple` call for the same session finds the tool result in the context
// (paired by `requestID` == `toolCallId`) and sends it back as `{ actionResponse }` on that
// same socket. Bounded restarts on a FRESH workflow: idle socket (1), step limit (4), the
// generic processing failure (1), a stalled workflow (2). An oversized goal is reported as a
// context overflow (`prompt is too long: ...`).
//
// Plan D3, every tool goes through Lykos's gate: only `runMCPTool` / `run_mcp_tool` is surfaced
// to Pi as a tool call. Any other action is answered at once with an `actionResponse` whose
// `plainTextResponse.error` says it is unsupported. Nothing in
// this module executes a tool, reads a file for a tool, or spawns a process. Lykos's tools are
// advertised as MCP tool definitions.
//
// Choices, and why:
// - No tracing to a file (plan D2).
// - No pause/replay path: a `pause_turn` stop has no field in Pi's AssistantMessage, and a
//   plain `stop` would end Pi's agent loop mid-workflow. A server-side boundary inside a
//   checkpoint closes the open text/thinking block and the stream carries on.
// - A tool's parameters go out as a JSON clone.
// - Pi has no provider session state option, so the resumable sessions live in a module map
//   keyed by base URL, model and session id.
//
// Against the plan's wording: plan D2 says an idle socket reconnects "on the same workflow".
// Lykos stops the dead workflow and creates a fresh one, because a same-id reconnect is
// rejected server-side for inline flows.
//
// Usage: the protocol reports no billed tokens. Each checkpoint may carry
// `agent_context_usage[<agent>] = { total_tokens, max_tokens }`, GitLab's server-side estimate
// of the agent's history size;, `total_tokens` becomes `usage.input`. Output,
// cache and cost stay 0: unmeasured, not estimated (rule 4, rule 5).
//
// Errors: REST failures read `GitLab Duo Workflow <call> failed with HTTP <status>[: <message>]`,
// so ticket 05's classifier reads the status (a 401 is auth). A FAILED/STOPPED workflow status
// surfaces the server's message.

import { createHash } from "node:crypto";
import { CcaEventStream } from "../google-cca/stream.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  PiContext,
  PiEventStream,
  PiMessage,
  PiModel,
  PiSimpleStreamOptions,
  PiTool,
  StreamSimpleFn,
  ToolCall,
} from "../google-cca/types.js";
import {
  discoverGitLabDuoWorkflowRuntimeNamespace,
  type GitLabDuoWorkflowNamespaceSelection,
  normalizeGitLabBaseUrl,
} from "./discovery.js";

// ---------------------------------------------------------------------------
// Constants (gitlab-duo-workflow.ts)
// ---------------------------------------------------------------------------

export const GITLAB_DUO_WORKFLOW_API = "gitlab-duo-agent";
export const GITLAB_DUO_WORKFLOW_DEFINITION = "ambient";
const DEFAULT_GITLAB_BASE_URL = "https://gitlab.com";
const GITLAB_DUO_WORKFLOW_CLIENT_TYPE = "node-websocket";
export const GITLAB_DUO_WORKFLOW_IDLE_TIMEOUT_MS = 90_000;
export const GITLAB_DUO_WORKFLOW_REST_TIMEOUT_MS = 30_000;
export const GITLAB_DUO_WORKFLOW_MAX_STEP_LIMIT_RESTARTS = 4;
export const GITLAB_DUO_WORKFLOW_MAX_GENERIC_ERROR_RETRIES = 1;
export const GITLAB_DUO_WORKFLOW_MAX_STALL_RESTARTS = 2;
const GITLAB_DUO_WORKFLOW_STALL_ERROR_MESSAGE =
  "GitLab Duo Agent stopped making progress (the workflow's visible history did not advance after multiple restarts).";
export const GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES = 1_048_576;
export const GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES = 2_000_000;
const GITLAB_DUO_WORKFLOW_LANGUAGE_SERVER_VERSION = "8.104.0";
const GITLAB_DUO_WORKFLOW_AVAILABLE_MODELS_QUERY = `query lykos_gitlabDuoWorkflowAvailableModels($rootNamespaceId: GroupID!) {
  aiChatAvailableModels(rootNamespaceId: $rootNamespaceId) {
    defaultModel { name ref }
    selectableModels { name ref }
    pinnedModel { name ref }
  }
}`;
export const GITLAB_DUO_WORKFLOW_CLIENT_CAPABILITIES = [
  "incremental_streaming",
  "read_file_chunked",
  "shell_command",
  "command_timeout",
  "tool_call_approval",
] as const;
const GITLAB_DUO_WORKFLOW_INLINE_AGENT_NAME = "lykos_agent";
const GITLAB_DUO_WORKFLOW_INLINE_PROMPT_ID = "lykos_inline_prompt";
const GITLAB_DUO_WORKFLOW_INLINE_UI_LOG_EVENTS = [
  "on_agent_reasoning",
  "on_agent_final_answer",
  "on_tool_execution_success",
  "on_tool_execution_failed",
] as const;
const GITLAB_DUO_WORKFLOW_ACTION_NAMES = ["runMCPTool", "run_mcp_tool"] as const;
const GITLAB_DUO_WORKFLOW_CONTEXT_AGENT_PRIORITY = ["Chat Agent", "context_builder"];
const GITLAB_DUO_WORKFLOW_CHATML_START = "<|im_start|>";
const GITLAB_DUO_WORKFLOW_CHATML_END = "<|im_end|>";
/** Prefixed to a replayed history so the model does not imitate its markers. */
const GITLAB_DUO_WORKFLOW_CHATML_HISTORY_NOTE =
  "The task below is a transcript of the conversation so far, written as a plain-text log. Turn boundaries (`<|im_start|>role` … `<|im_end|>`) and any `<ran NAME>{…}</ran>` / `<ran:result>` entries inside it are a RECORD of what already happened — past tool calls and their results. They are not a syntax for you to emit. To call a tool, use your normal structured tool-calling channel; never write `<ran …>`, `<tool_call>`, `<|im_start|>`, or similar markers as your own output.";

/**
 * The MCP `serverName` Lykos advertises its tools under. Lykos strips an `mcp__lykos__`
 * prefix from action tool names. The server matches on the bare `name`, not this.
 */
export const GITLAB_DUO_AGENT_MCP_SERVER_NAME = "lykos";

/** Lykos's text for an action other than `runMCPTool` (plan D3). */
export const UNSUPPORTED_ACTION_MESSAGE = (name: string): string =>
  `Action "${name}" is not supported by this client; only MCP tools (runMCPTool) are available.`;

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

/** The WebSocket surface the run needs. Node 24's global `WebSocket` satisfies it. */
export interface GitLabDuoWorkflowWebSocketLike {
  readyState?: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type GitLabDuoWorkflowWebSocketFactory = (
  url: string,
  options: { headers: Record<string, string> },
) => GitLabDuoWorkflowWebSocketLike;

interface GitLabDirectAccessResponse {
  token?: string;
  access_token?: string;
  jwt?: string;
  workflow_token?: string;
  duo_workflow_access_token?: string;
  duo_workflow_service?: { token?: string; base_url?: string; headers?: Record<string, string> };
  gitlab_rails?: { token?: string };
  [key: string]: unknown;
}

interface DirectAccessConnection {
  token: string;
  baseUrl?: string;
  headers: Record<string, string>;
  serviceEndpoint: boolean;
}

export interface GitLabMcpToolDefinition {
  name: string;
  originalToolName: string;
  serverName: string;
  description: string;
  inputSchema: string;
  isApproved: boolean;
}

interface InlineFlowConfig {
  version: "v1";
  environment: "ambient";
  flow: { entry_point: string };
  components: {
    name: string;
    type: "AgentComponent";
    prompt_id: string;
    toolset: string[];
    inputs: { from: string; as: string }[];
    ui_log_events: string[];
  }[];
  routers: { from: string; to: string }[];
  prompts: {
    name: string;
    prompt_id: string;
    unit_primitives: string[];
    prompt_template: { system: string; user: string; placeholder: string };
  }[];
}

export interface GitLabDuoWorkflowStartRequest {
  workflowID: string;
  clientVersion: "1.0";
  workflowDefinition: string;
  goal: string;
  workflowMetadata: string;
  additional_context: readonly unknown[];
  approval?: { approval?: Record<string, never>; rejection?: { message?: string } };
  clientCapabilities: readonly string[];
  mcpTools: GitLabMcpToolDefinition[];
  preapproved_tools: string[];
  flowConfigSchemaVersion?: "v1";
  flowConfig?: InlineFlowConfig;
}

interface PlainTextResponse {
  response?: string;
  error?: string;
}

interface ActionResponse {
  actionResponse: { requestID: string; plainTextResponse?: PlainTextResponse };
}

interface ActionDescriptor {
  requestID: string;
  name: string;
  args: unknown;
}

interface AvailableModel {
  name?: string | null;
  ref?: string | null;
}

interface AvailableModelsPayload {
  pinnedModel?: AvailableModel | null;
  selectedModel?: AvailableModel | null;
  defaultModel?: AvailableModel | null;
  selectableModels?: AvailableModel[] | undefined;
}

type SocketResult = "closed" | "terminal" | "approval" | "action" | "timeout" | "step_limit" | "retryable_error" | "stalled";
type MessageResult = "continue" | "terminal" | "approval" | "action" | "step_limit" | "retryable_error" | "stalled";

interface ActiveSession {
  workflowId: string;
  startPayload: GitLabDuoWorkflowStartRequest;
  ws: GitLabDuoWorkflowWebSocketLike;
  stop?: () => void;
  pendingActions?: ActionDescriptor[] | undefined;
  checkpointAgentContentByKey?: Record<string, string>;
  checkpointAgentContentSignatures?: Record<string, true>;
  lastToolBoundaryContentLength?: number;
}

interface SessionState {
  active?: ActiveSession | undefined;
}

/** A CcaEventStream that remembers whether a terminal event went out. */
class DuoEventStream extends CcaEventStream {
  finished = false;
  override push(event: AssistantMessageEvent): void {
    if (event.type === "done" || event.type === "error") this.finished = true;
    super.push(event);
  }
}

interface StreamState {
  stream: DuoEventStream;
  output: AssistantMessage;
  activeTextIndex?: number | undefined;
  activeThinkingIndex?: number | undefined;
  activeCheckpointMessageKey?: string;
  checkpointAgentContentByKey?: Record<string, string> | undefined;
  checkpointAgentContentSignatures?: Record<string, true> | undefined;
  stepLimitRequested?: boolean;
  retryableErrorRequested?: boolean;
  lastCheckpointContentLength?: number;
  stalledRequested?: boolean;
  session?: SessionState;
  lastApprovalStatus?: string | undefined;
  goalOverflowMessage?: string;
  /** Set when no GitLab project resolved and the run went out namespace-only (plan D4). */
  noProject?: boolean;
}

const NO_PROJECT_NOTE =
  " (no GitLab project resolved for this workspace; the workflow ran namespace-only. Set GITLAB_DUO_PROJECT_PATH to scope it.)";

/** The error text a failed run surfaces: the overflow label when the goal was oversized, else the message plus the plan D4 note. */
function failureText(state: StreamState, message: string): string {
  if (state.goalOverflowMessage) return state.goalOverflowMessage;
  return state.noProject && !message.endsWith(NO_PROJECT_NOTE) ? `${message}${NO_PROJECT_NOTE}` : message;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!isRecordValue(value)) return undefined;
  const nested = value[key];
  return nested && typeof nested === "object" ? (nested as Record<string, unknown>) : undefined;
}

function getRecordString(value: unknown, key: string): string | undefined {
  if (!isRecordValue(value)) return undefined;
  const nested = value[key];
  return typeof nested === "string" || typeof nested === "number" ? String(nested) : undefined;
}

function getNestedRecordString(value: unknown, parentKey: string, key: string): string | undefined {
  return getRecordString(getRecord(value, parentKey), key);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gitLabApiUrl(baseUrl: string, path: string): URL {
  const normalized = normalizeGitLabBaseUrl(baseUrl);
  return new URL(`${normalized}${path.startsWith("/") ? path : `/${path}`}`);
}

function normalizeServiceBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  const absolute = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return normalizeGitLabBaseUrl(absolute);
}

function toGitLabGraphQLNamespaceId(rootNamespaceId: string): string {
  if (/^\d+$/.test(rootNamespaceId)) return `gid://gitlab/Group/${rootNamespaceId}`;
  return rootNamespaceId;
}

function toGitLabRestNamespaceId(rootNamespaceId: string): string {
  const match = rootNamespaceId.match(/^gid:\/\/gitlab\/(?:Group|Namespace)\/(\d+)$/);
  return match?.[1] ?? rootNamespaceId;
}

function buildGoalOverflowMessage(goalBytes: number): string {
  return `prompt is too long: ${goalBytes} bytes exceeds the GitLab Duo Agent goal byte budget (soft ${GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES}, hard ${GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES})`;
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

export function buildDirectAccessBody(rootNamespaceId: string, projectId?: string, workflowDefinition = GITLAB_DUO_WORKFLOW_DEFINITION): Record<string, string> {
  return {
    workflow_definition: workflowDefinition,
    root_namespace_id: toGitLabGraphQLNamespaceId(rootNamespaceId),
    ...(projectId ? { project_id: projectId } : {}),
  };
}

export function buildCreateBody(
  namespaceId: string | undefined,
  options: { projectId?: string | undefined; goal?: string; workflowDefinition?: string } = {},
): Record<string, string | boolean | number[]> {
  return {
    workflow_definition: options.workflowDefinition ?? GITLAB_DUO_WORKFLOW_DEFINITION,
    environment: "ide",
    allow_agent_to_request_user: false,
    agent_privileges: [6],
    pre_approved_agent_privileges: [6],
    requires_duo_cli_enabled: false,
    ...(namespaceId && !options.projectId ? { namespace_id: namespaceId } : {}),
    ...(options.projectId ? { project_id: options.projectId } : {}),
    goal: options.goal ?? "",
  };
}

export function buildWebSocketUrl(
  baseUrl: string,
  options: {
    projectId?: string | undefined;
    namespaceId?: string | undefined;
    rootNamespaceId?: string | undefined;
    selectedModelIdentifier?: string | undefined;
    workflowDefinition?: string | undefined;
    serviceEndpoint?: boolean | undefined;
  } = {},
): string {
  const wsUrl = options.serviceEndpoint
    ? new URL("/", normalizeGitLabBaseUrl(baseUrl))
    : gitLabApiUrl(baseUrl, "/api/v4/ai/duo_workflows/ws");
  wsUrl.protocol = wsUrl.protocol === "http:" ? "ws:" : "wss:";
  if (options.projectId) wsUrl.searchParams.set("project_id", options.projectId);
  if (options.namespaceId && !options.serviceEndpoint) wsUrl.searchParams.set("namespace_id", toGitLabRestNamespaceId(options.namespaceId));
  if (options.rootNamespaceId) wsUrl.searchParams.set("root_namespace_id", toGitLabRestNamespaceId(options.rootNamespaceId));
  if (options.selectedModelIdentifier) wsUrl.searchParams.set("user_selected_model_identifier", options.selectedModelIdentifier);
  if (options.workflowDefinition) wsUrl.searchParams.set("workflow_definition", options.workflowDefinition);
  return wsUrl.toString();
}

export function buildWebSocketHeaders(options: {
  token: string;
  baseUrl?: string;
  projectId?: string | undefined;
  namespaceId?: string | undefined;
  rootNamespaceId?: string | undefined;
  extraHeaders?: Record<string, string>;
}): Record<string, string> {
  const base = new URL(normalizeGitLabBaseUrl(options.baseUrl ?? DEFAULT_GITLAB_BASE_URL));
  return {
    ...options.extraHeaders,
    authorization: `Bearer ${options.token}`,
    "x-gitlab-client-type": GITLAB_DUO_WORKFLOW_CLIENT_TYPE,
    "x-gitlab-language-server-version": GITLAB_DUO_WORKFLOW_LANGUAGE_SERVER_VERSION,
    "user-agent": `unknown/unknown unknown/unknown gitlab-language-server/${GITLAB_DUO_WORKFLOW_LANGUAGE_SERVER_VERSION}`,
    origin: base.origin,
    ...(options.projectId ? { "x-gitlab-project-id": options.projectId } : {}),
    ...(options.namespaceId ? { "x-gitlab-namespace-id": toGitLabRestNamespaceId(options.namespaceId) } : {}),
    ...(options.rootNamespaceId ? { "x-gitlab-root-namespace-id": toGitLabRestNamespaceId(options.rootNamespaceId) } : {}),
  };
}

function buildInlineFlowConfig(systemPrompt: string): InlineFlowConfig {
  return {
    version: "v1",
    environment: "ambient",
    flow: { entry_point: GITLAB_DUO_WORKFLOW_INLINE_AGENT_NAME },
    components: [
      {
        name: GITLAB_DUO_WORKFLOW_INLINE_AGENT_NAME,
        type: "AgentComponent",
        prompt_id: GITLAB_DUO_WORKFLOW_INLINE_PROMPT_ID,
        toolset: [],
        inputs: [{ from: "context:goal", as: "goal" }],
        ui_log_events: [...GITLAB_DUO_WORKFLOW_INLINE_UI_LOG_EVENTS],
      },
    ],
    routers: [{ from: GITLAB_DUO_WORKFLOW_INLINE_AGENT_NAME, to: "end" }],
    prompts: [
      {
        name: GITLAB_DUO_WORKFLOW_INLINE_PROMPT_ID,
        prompt_id: GITLAB_DUO_WORKFLOW_INLINE_PROMPT_ID,
        unit_primitives: ["duo_agent_platform"],
        prompt_template: { system: systemPrompt, user: "{{goal}}", placeholder: "history" },
      },
    ],
  };
}

function buildMcpToolDefinition(tool: PiTool): GitLabMcpToolDefinition {
  let schema: unknown;
  try {
    schema = JSON.parse(JSON.stringify(tool.parameters ?? null)) as unknown;
  } catch {
    schema = undefined;
  }
  return {
    name: tool.name,
    originalToolName: tool.name,
    serverName: GITLAB_DUO_AGENT_MCP_SERVER_NAME,
    description: tool.description || "",
    inputSchema: JSON.stringify(schema && typeof schema === "object" ? schema : { type: "object", properties: {}, required: [] }),
    isApproved: true,
  };
}

export function buildMcpTools(tools: readonly PiTool[] | undefined): GitLabMcpToolDefinition[] {
  return tools?.map(buildMcpToolDefinition) ?? [];
}

function selectModelRef(selectedModel: string, availableModels?: AvailableModelsPayload | null): string {
  const pinned = availableModels?.pinnedModel?.ref;
  if (pinned) return pinned;
  return selectedModel;
}

export function buildStartRequest(
  workflowId: string,
  model: PiModel,
  context: PiContext,
  tools: readonly PiTool[] | undefined,
  availableModels: AvailableModelsPayload | null | undefined,
  meta: { projectId?: string | undefined; namespaceId?: string; rootNamespaceId?: string; workflowDefinition?: string },
): GitLabDuoWorkflowStartRequest {
  const workflowMetadata: Record<string, string> = {
    environment: "ide",
    client_type: GITLAB_DUO_WORKFLOW_CLIENT_TYPE,
    ...(meta.projectId ? { projectId: meta.projectId } : {}),
    ...(meta.namespaceId ? { namespaceId: toGitLabRestNamespaceId(meta.namespaceId) } : {}),
    ...(meta.rootNamespaceId ? { rootNamespaceId: toGitLabRestNamespaceId(meta.rootNamespaceId) } : {}),
    selectedModelIdentifier: selectModelRef(model.id, availableModels),
  };
  const mcpTools = buildMcpTools(tools);
  return {
    workflowID: workflowId,
    clientVersion: "1.0",
    workflowDefinition: meta.workflowDefinition ?? GITLAB_DUO_WORKFLOW_DEFINITION,
    goal: buildGoal(context),
    workflowMetadata: JSON.stringify(workflowMetadata),
    additional_context: [],
    clientCapabilities: GITLAB_DUO_WORKFLOW_CLIENT_CAPABILITIES,
    mcpTools,
    preapproved_tools: mcpTools.map((tool) => tool.name),
    flowConfigSchemaVersion: "v1",
    flowConfig: buildInlineFlowConfig(buildSystemPrompt(context)),
  };
}

function buildApprovalStartRequest(startPayload: GitLabDuoWorkflowStartRequest): GitLabDuoWorkflowStartRequest {
  return { ...startPayload, goal: "", additional_context: [], approval: { approval: {} } };
}

function buildActionResponse(requestID: string, response: PlainTextResponse): ActionResponse {
  return { actionResponse: { requestID, plainTextResponse: response } };
}

// ---------------------------------------------------------------------------
// The goal: the conversation as a ChatML transcript
// ---------------------------------------------------------------------------

type ToolResultMessage = Extract<PiMessage, { role: "toolResult" }>;
type UserMessage = Extract<PiMessage, { role: "user" }>;

interface ReplayToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface ReplayMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ReplayToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

function contentToText(content: UserMessage["content"] | ToolResultMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((item) => (item.type === "text" ? item.text : `[${item.mimeType} image]`)).join("\n");
}

function assistantText(message: AssistantMessage): string {
  return message.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}

function buildReplayMessage(message: PiMessage | undefined): ReplayMessage | undefined {
  if (!message) return undefined;
  if (message.role === "toolResult") {
    return {
      role: "tool",
      content: contentToText(message.content),
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
    };
  }
  if (message.role === "assistant") {
    const content = assistantText(message);
    const toolCalls = message.content
      .filter((item): item is ToolCall => item.type === "toolCall")
      .map((item) => ({ id: item.id, name: item.name, arguments: item.arguments }));
    if (content.length === 0 && toolCalls.length === 0) return undefined;
    return toolCalls.length > 0 ? { role: "assistant", content, toolCalls } : { role: "assistant", content };
  }
  const content = contentToText(message.content);
  if (content.length === 0) return undefined;
  return { role: "user", content };
}

function buildConversationHistory(messages: readonly PiMessage[]): ReplayMessage[] {
  const history: ReplayMessage[] = [];
  for (const message of messages) {
    const replay = buildReplayMessage(message);
    if (replay) history.push(replay);
  }
  return history;
}

function renderChatMlTurn(message: ReplayMessage): string {
  let body: string;
  if (message.role === "tool") {
    const header = message.toolName || message.toolCallId ? `<ran:result${message.isError ? " status=error" : ""}>` : undefined;
    body = header ? `${header}\n${message.content}\n` : `${message.content}\n`;
  } else {
    const parts: string[] = [];
    if (message.content.length > 0) parts.push(message.content);
    if (message.role === "assistant" && message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        parts.push(`<ran ${toolCall.name}>${JSON.stringify(toolCall.arguments) ?? "null"}</ran>`);
      }
    }
    body = `${parts.join("\n")}\n`;
  }
  return `${GITLAB_DUO_WORKFLOW_CHATML_START}${message.role}\n${body}${GITLAB_DUO_WORKFLOW_CHATML_END}`;
}

function extractLatestUserPrompt(messages: readonly PiMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user") return contentToText(message.content);
  }
  return "";
}

/** A lone turn goes out as bare text; a real multi-turn session as a flat ChatML transcript. */
export function buildGoal(context: PiContext): string {
  const conversation = buildConversationHistory(context.messages);
  if (conversation.length <= 1) return extractLatestUserPrompt(context.messages);
  return conversation.map(renderChatMlTurn).join("\n");
}

function buildSystemPrompt(context: PiContext): string {
  const base = context.systemPrompt?.trim() ? context.systemPrompt : "";
  if (buildConversationHistory(context.messages).length <= 1) return base;
  return base ? `${base}\n\n${GITLAB_DUO_WORKFLOW_CHATML_HISTORY_NOTE}` : GITLAB_DUO_WORKFLOW_CHATML_HISTORY_NOTE;
}

// ---------------------------------------------------------------------------
// Checkpoints -> Pi events
// ---------------------------------------------------------------------------

interface CheckpointAgentEntry {
  kind: "text" | "thinking";
  messageKey: string;
  content: string;
}

type CheckpointEntry = CheckpointAgentEntry | { kind: "boundary" };

interface CheckpointContent {
  entries: CheckpointEntry[];
  contentLength: number;
  contextUsage?: { used: number; window: number } | undefined;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseSocketData(data: unknown): Record<string, unknown> | null {
  if (typeof data === "string") return parseJsonRecord(data);
  if (data instanceof ArrayBuffer) return parseJsonRecord(new TextDecoder().decode(data));
  if (data instanceof Uint8Array) return parseJsonRecord(new TextDecoder().decode(data));
  if (data && typeof data === "object") return data as Record<string, unknown>;
  return null;
}

function readAgentUsage(value: unknown): { used: number; window: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const used = numberField(record, "total_tokens");
  const window = numberField(record, "max_tokens");
  if (used === undefined || window === undefined || window <= 0) return undefined;
  return { used, window };
}

function extractContextUsage(...sources: (Record<string, unknown> | undefined)[]): { used: number; window: number } | undefined {
  for (const source of sources) {
    const usageMap = getRecord(source, "agent_context_usage");
    if (!usageMap) continue;
    for (const preferred of GITLAB_DUO_WORKFLOW_CONTEXT_AGENT_PRIORITY) {
      const usage = readAgentUsage(usageMap[preferred]);
      if (usage) return usage;
    }
    for (const value of Object.values(usageMap)) {
      const usage = readAgentUsage(value);
      if (usage) return usage;
    }
  }
  return undefined;
}

function extractCheckpointEntries(checkpointJson: string): CheckpointContent | undefined {
  const checkpoint = parseJsonRecord(checkpointJson);
  const chatLog = getRecord(checkpoint, "channel_values")?.ui_chat_log;
  if (!Array.isArray(chatLog)) return undefined;
  const entries: CheckpointEntry[] = [];
  for (let index = 0; index < chatLog.length; index++) {
    const entry = chatLog[index] as unknown;
    if (!entry || typeof entry !== "object") continue;
    const messageType = getRecordString(entry, "message_type");
    if (messageType === "agent") {
      const content = getRecordString(entry, "content");
      if (!content) continue;
      const messageId = getRecordString(entry, "message_id");
      const isReasoning = getRecordString(entry, "message_sub_type") === "reasoning";
      const fallbackKey = isReasoning ? `reasoning:${index}` : `agent:${index}`;
      entries.push({ kind: isReasoning ? "thinking" : "text", messageKey: messageId ? `agent:${messageId}` : fallbackKey, content });
      continue;
    }
    if (messageType === "request" || messageType === "tool") entries.push({ kind: "boundary" });
  }
  return { entries, contentLength: checkpointJson.length };
}

function extractCheckpoint(event: Record<string, unknown>): CheckpointContent | undefined {
  const action = getRecord(event, "action");
  const checkpoint = getRecord(action, "newCheckpoint") ?? getRecord(event, "newCheckpoint") ?? getRecord(event, "checkpoint");
  if (!checkpoint) return undefined;
  const directText =
    getRecordString(checkpoint, "message") ??
    getRecordString(checkpoint, "text") ??
    getRecordString(checkpoint, "content") ??
    getNestedRecordString(checkpoint, "checkpoint", "message") ??
    getNestedRecordString(checkpoint, "checkpoint", "text");
  const contextUsage = extractContextUsage(event, action, checkpoint);
  if (directText) {
    return {
      entries: [{ kind: "text", messageKey: "direct:text", content: directText }],
      contentLength: directText.length,
      contextUsage,
    };
  }
  const checkpointJson = getRecordString(checkpoint, "checkpoint");
  const content = checkpointJson ? extractCheckpointEntries(checkpointJson) : undefined;
  if (content) {
    if (contextUsage) content.contextUsage = contextUsage;
    return content;
  }
  if (contextUsage) return { entries: [], contentLength: 0, contextUsage };
  return undefined;
}

function endText(state: StreamState): void {
  if (state.activeTextIndex === undefined) return;
  const block = state.output.content[state.activeTextIndex];
  if (block?.type === "text") {
    state.stream.push({ type: "text_end", contentIndex: state.activeTextIndex, content: block.text, partial: state.output });
  }
  state.activeTextIndex = undefined;
}

function endThinking(state: StreamState): void {
  if (state.activeThinkingIndex === undefined) return;
  const block = state.output.content[state.activeThinkingIndex];
  if (block?.type === "thinking") {
    state.stream.push({ type: "thinking_end", contentIndex: state.activeThinkingIndex, content: block.thinking, partial: state.output });
  }
  state.activeThinkingIndex = undefined;
}

function emitText(state: StreamState, text: string): void {
  if (!text) return;
  endThinking(state);
  let index = state.activeTextIndex;
  if (index === undefined) {
    state.output.content.push({ type: "text", text: "" });
    index = state.output.content.length - 1;
    state.activeTextIndex = index;
    state.stream.push({ type: "text_start", contentIndex: index, partial: state.output });
  }
  const block = state.output.content[index];
  if (block?.type !== "text") return;
  block.text += text;
  state.stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: state.output });
}

function emitThinking(state: StreamState, thinking: string): void {
  if (!thinking) return;
  endText(state);
  let index = state.activeThinkingIndex;
  if (index === undefined) {
    state.output.content.push({ type: "thinking", thinking: "" });
    index = state.output.content.length - 1;
    state.activeThinkingIndex = index;
    state.stream.push({ type: "thinking_start", contentIndex: index, partial: state.output });
  }
  const block = state.output.content[index];
  if (block?.type !== "thinking") return;
  block.thinking += thinking;
  state.stream.push({ type: "thinking_delta", contentIndex: index, delta: thinking, partial: state.output });
}

function finishStream(state: StreamState, reason: "stop" | "length" | "toolUse"): void {
  endText(state);
  endThinking(state);
  state.output.stopReason = reason;
  state.stream.push({ type: "done", reason, message: state.output });
}

function syncCheckpointState(state: StreamState): void {
  const active = state.session?.active;
  if (!active) return;
  if (state.checkpointAgentContentByKey !== undefined) active.checkpointAgentContentByKey = state.checkpointAgentContentByKey;
  if (state.checkpointAgentContentSignatures !== undefined) active.checkpointAgentContentSignatures = state.checkpointAgentContentSignatures;
}

/**
 * Checkpoints are full `ui_chat_log` snapshots: each agent entry's delta is the part not
 * already emitted for its key; a replayed entry at the same turn position is suppressed.
 */
function emitCheckpoint(state: StreamState, checkpoint: CheckpointContent): void {
  if (checkpoint.contextUsage) {
    const usage = state.output.usage;
    usage.input = checkpoint.contextUsage.used;
    usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  }
  state.lastCheckpointContentLength = checkpoint.contentLength;
  let turnIndex = 0;
  for (const entry of checkpoint.entries) {
    if (entry.kind === "boundary") {
      endText(state);
      endThinking(state);
      turnIndex += 1;
      continue;
    }
    const contentByKey = state.checkpointAgentContentByKey ?? {};
    const contentSignatures = state.checkpointAgentContentSignatures ?? {};
    const previousContent = contentByKey[entry.messageKey];
    const contentSignature = `${turnIndex}\u0000${entry.kind}\u0000${entry.content}`;
    const contentOnlySignature = `${turnIndex}\u0000content\u0000${entry.content}`;
    const duplicateContent =
      previousContent === undefined &&
      (contentSignatures[contentSignature] === true || contentSignatures[contentOnlySignature] === true);
    const rewroteExistingContent =
      previousContent !== undefined && !entry.content.startsWith(previousContent) && previousContent !== entry.content;
    const delta = duplicateContent || rewroteExistingContent
      ? ""
      : previousContent !== undefined
        ? entry.content.slice(previousContent.length)
        : entry.content;

    contentByKey[entry.messageKey] = entry.content;
    contentSignatures[contentSignature] = true;
    contentSignatures[contentOnlySignature] = true;
    state.checkpointAgentContentByKey = contentByKey;
    state.checkpointAgentContentSignatures = contentSignatures;
    syncCheckpointState(state);

    if (delta.length === 0) continue;
    if (state.activeCheckpointMessageKey && state.activeCheckpointMessageKey !== entry.messageKey && previousContent === undefined) {
      endText(state);
      endThinking(state);
    }
    if (entry.kind === "thinking") emitThinking(state, delta);
    else emitText(state, delta);
    state.activeCheckpointMessageKey = entry.messageKey;
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function requireRequestID(requestID: string | undefined, actionName: string, source: Record<string, unknown>): string {
  if (requestID) return requestID;
  throw new Error(
    `GitLab Duo Workflow action "${actionName}" missing requestID (keys: ${Object.keys(source).slice(0, 20).join(", ")})`,
  );
}

function withToolCallId(args: unknown, requestID: string): unknown {
  const record = args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  if (typeof record.toolCallId === "string" || typeof record.tool_call_id === "string") return record;
  return { ...record, toolCallId: requestID, tool_call_id: requestID };
}

function extractAction(event: Record<string, unknown>): ActionDescriptor | undefined {
  const wrappedAction = getRecord(event, "action") ?? getRecord(event, "workflowAction") ?? getRecord(event, "toolCall");
  if (wrappedAction) {
    if (getRecord(wrappedAction, "newCheckpoint")) return undefined;
    const name =
      getRecordString(wrappedAction, "name") ??
      getRecordString(wrappedAction, "action") ??
      getRecordString(wrappedAction, "type") ??
      getRecordString(event, "actionName");
    if (!name) return undefined;
    const requestID =
      getRecordString(wrappedAction, "requestID") ??
      getRecordString(wrappedAction, "requestId") ??
      getRecordString(wrappedAction, "id") ??
      getRecordString(event, "requestID") ??
      getRecordString(event, "requestId");
    const resolved = requireRequestID(requestID, name, wrappedAction);
    const args = getRecord(wrappedAction, "args") ?? getRecord(wrappedAction, "arguments") ?? wrappedAction;
    return { requestID: resolved, name, args: withToolCallId(args, resolved) };
  }
  for (const name of GITLAB_DUO_WORKFLOW_ACTION_NAMES) {
    const args = getRecord(event, name);
    if (args) {
      const requestID = getRecordString(event, "requestID") ?? getRecordString(event, "requestId");
      const resolved = requireRequestID(requestID, name, event);
      return { requestID: resolved, name, args: withToolCallId(args, resolved) };
    }
  }
  return undefined;
}

function isMcpAction(name: string): boolean {
  return (GITLAB_DUO_WORKFLOW_ACTION_NAMES as readonly string[]).includes(name);
}

function parseMcpArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stripMcpPrefix(rawName: string): string {
  for (const server of [GITLAB_DUO_AGENT_MCP_SERVER_NAME]) {
    const prefix = `mcp__${server}__`;
    if (rawName.startsWith(prefix)) return rawName.slice(prefix.length);
  }
  return rawName;
}

function buildActionToolCall(action: ActionDescriptor): ToolCall {
  const args = action.args && typeof action.args === "object" && !Array.isArray(action.args) ? (action.args as Record<string, unknown>) : {};
  const rawName = nonEmptyString(args.toolName) ?? nonEmptyString(args.tool_name) ?? nonEmptyString(args.name) ?? "";
  return {
    type: "toolCall",
    id: action.requestID,
    name: stripMcpPrefix(rawName),
    arguments: parseMcpArguments(args.args ?? args.arguments),
  };
}

function emitActionToolCall(state: StreamState, action: ActionDescriptor): void {
  endText(state);
  endThinking(state);
  const toolCall = buildActionToolCall(action);
  state.output.content.push(toolCall);
  const contentIndex = state.output.content.length - 1;
  state.stream.push({ type: "toolcall_start", contentIndex, partial: state.output });
  state.stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(toolCall.arguments), partial: state.output });
  state.stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: state.output });
  finishStream(state, "toolUse");
  if (state.session?.active) state.session.active.pendingActions = [action];
}

function detectStall(state: StreamState): boolean {
  const active = state.session?.active;
  const length = state.lastCheckpointContentLength;
  if (!active || length === undefined) return false;
  const previousLength = active.lastToolBoundaryContentLength;
  const stalled = previousLength !== undefined && length === previousLength;
  active.lastToolBoundaryContentLength = length;
  return stalled;
}

function toolResultToPlainText(toolResult: ToolResultMessage): PlainTextResponse {
  const text = contentToText(toolResult.content);
  return toolResult.isError ? { error: text } : { response: text };
}

// ---------------------------------------------------------------------------
// One socket message
// ---------------------------------------------------------------------------

function handleSocketMessage(data: unknown, state: StreamState, ws: GitLabDuoWorkflowWebSocketLike): MessageResult {
  const event = parseSocketData(data);
  if (!event) return "continue";
  const status =
    getRecordString(event, "status") ??
    getNestedRecordString(event, "workflowStatus", "status") ??
    getNestedRecordString(event, "newCheckpoint", "status");
  const checkpoint = extractCheckpoint(event);
  if (checkpoint) emitCheckpoint(state, checkpoint);
  if (status === "PLAN_APPROVAL_REQUIRED" || status === "TOOL_CALL_APPROVAL_REQUIRED") {
    state.lastApprovalStatus = status;
    return "approval";
  }
  if (status === "INPUT_REQUIRED" || status === "FINISHED") {
    finishStream(state, "stop");
    return "terminal";
  }
  if (status === "FAILED" || status === "STOPPED") {
    const message = getRecordString(event, "error") ?? getRecordString(event, "message") ?? status;
    if (status === "FAILED" && message.toLowerCase().includes("reached its maximum step limit")) {
      state.stepLimitRequested = true;
      return "step_limit";
    }
    if (status === "FAILED" && message.toLowerCase().includes("error processing your request in the duo agent platform")) {
      state.retryableErrorRequested = true;
      state.output.errorMessage = message;
      return "retryable_error";
    }
    state.output.stopReason = "error";
    state.output.errorMessage = failureText(state, message);
    state.stream.push({ type: "error", reason: "error", error: state.output });
    return "terminal";
  }
  const action = extractAction(event);
  if (!action) return "continue";
  if (!isMcpAction(action.name)) {
    // Plan D3: refused, never run and never surfaced.
    ws.send(JSON.stringify(buildActionResponse(action.requestID, { error: UNSUPPORTED_ACTION_MESSAGE(action.name) })));
    return "continue";
  }
  if (detectStall(state)) {
    state.stalledRequested = true;
    return "stalled";
  }
  emitActionToolCall(state, action);
  return "action";
}

function describeSocketEvent(event: unknown): string {
  const fields: string[] = [];
  if (event && typeof event === "object") {
    const type = getRecordString(event, "type");
    const message = getRecordString(event, "message");
    const code = getRecordString(event, "code");
    const reason = getRecordString(event, "reason");
    const rawError = (event as Record<string, unknown>).error;
    const error =
      typeof rawError === "string" || typeof rawError === "number"
        ? String(rawError)
        : rawError instanceof Error
          ? rawError.message
          : rawError && typeof rawError === "object"
            ? (getRecordString(rawError, "message") ?? getRecordString(rawError, "name"))
            : undefined;
    if (type) fields.push(`type=${type}`);
    if (message) fields.push(`message=${message}`);
    if (error) fields.push(`error=${error}`);
    if (code) fields.push(`code=${code}`);
    if (reason) fields.push(`reason=${reason}`);
  }
  return fields.length > 0 ? fields.join(", ") : String(event);
}

/** runGitLabDuoWorkflowSocket, without the pause/replay path. */
function runSocket(
  ws: GitLabDuoWorkflowWebSocketLike,
  startPayload: GitLabDuoWorkflowStartRequest,
  state: StreamState,
  opts: { signal?: AbortSignal | undefined; idleTimeoutMs: number },
  resumeResponses?: readonly ActionResponse[],
): Promise<SocketResult> {
  return new Promise<SocketResult>((resolve, reject) => {
    let settled = false;
    let idleTimer: NodeJS.Timeout | undefined;
    const clearIdleTimer = (): void => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };
    const close = (): void => {
      try {
        ws.close();
      } catch {
        // Already closed.
      }
    };
    const onAbort = (): void => {
      close();
      settle("closed", new Error("GitLab Duo Workflow request aborted"));
    };
    const settle = (result: SocketResult = "closed", error?: unknown): void => {
      if (settled) return;
      settled = true;
      clearIdleTimer();
      opts.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(result);
    };
    const resetIdleTimer = (): void => {
      clearIdleTimer();
      if (settled) return;
      idleTimer = setTimeout(() => {
        close();
        settle("timeout");
      }, opts.idleTimeoutMs);
    };
    if (opts.signal?.aborted) {
      onAbort();
      return;
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    ws.onerror = (event) => {
      settle("closed", new Error(`GitLab Duo Workflow WebSocket error: ${describeSocketEvent(event)}`));
    };
    ws.onclose = () => {
      settle(state.lastApprovalStatus ? "approval" : "closed");
    };
    ws.onmessage = (event) => {
      resetIdleTimer();
      let result: MessageResult;
      try {
        result = handleSocketMessage(event.data, state, ws);
      } catch (error) {
        settle("closed", error);
        return;
      }
      if (result === "continue") return;
      if (result === "action") {
        // The tool result comes back on this same socket: keep it open.
        settle("action");
        return;
      }
      close();
      settle(result);
    };
    if (resumeResponses && resumeResponses.length > 0) {
      ws.onopen = null;
      try {
        for (const response of resumeResponses) ws.send(JSON.stringify(response));
      } catch (error) {
        settle("closed", error);
        return;
      }
    } else {
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({ startRequest: startPayload }));
        } catch (error) {
          settle("closed", error);
        }
      };
    }
    resetIdleTimer();
  });
}

// ---------------------------------------------------------------------------
// REST
// ---------------------------------------------------------------------------

interface Rest {
  fetch: typeof fetch;
  baseUrl: string;
  apiKey: string;
  restTimeoutMs: number;
  signal?: AbortSignal | undefined;
}

function restSignal(rest: Rest, callerSignal: AbortSignal | undefined = rest.signal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(rest.restTimeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
}

function restHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
}

async function readResponseErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const payload: unknown = await response.json();
    for (const field of ["message", "error"] as const) {
      const value = isRecordValue(payload) && !Array.isArray(payload) ? payload[field] : undefined;
      if (typeof value === "string" && value.trim().length > 0) return value;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** The group-settings PUT is opt-in (see its call site). */
function groupSettingsOptIn(): boolean {
  return process.env.LYKOS_GITLAB_DUO_ENABLE_GROUP_SETTINGS === "1";
}

function buildSettingsBody(): Record<string, unknown> {
  return {
    experiment_features_enabled: true,
    ai_settings_attributes: { duo_agent_platform_enabled: true, duo_workflow_mcp_enabled: true },
  };
}

/** Best-effort; true when the attempt was definitive (any response below 500). */
async function ensureSettings(rest: Rest, restNamespaceId: string): Promise<boolean> {
  try {
    const response = await rest.fetch(gitLabApiUrl(rest.baseUrl, `/api/v4/groups/${encodeURIComponent(restNamespaceId)}`), {
      method: "PUT",
      headers: restHeaders(rest.apiKey),
      body: JSON.stringify(buildSettingsBody()),
      signal: restSignal(rest),
    });
    return response.status < 500;
  } catch {
    return false;
  }
}

async function discoverProject(rest: Rest, restNamespaceId: string): Promise<{ id?: string; path: string } | undefined> {
  const query = "per_page=1&min_access_level=30&order_by=last_activity_at&sort=desc";
  const endpoints = [
    `/api/v4/groups/${encodeURIComponent(restNamespaceId)}/projects?include_subgroups=true&${query}`,
    `/api/v4/projects?membership=true&${query}`,
  ];
  for (const endpoint of endpoints) {
    try {
      const response = await rest.fetch(gitLabApiUrl(rest.baseUrl, endpoint), {
        method: "GET",
        headers: restHeaders(rest.apiKey),
        signal: restSignal(rest),
      });
      if (!response.ok) continue;
      const payload: unknown = await response.json();
      const first = Array.isArray(payload) ? payload[0] : undefined;
      const id = getRecordString(first, "id");
      const path = getRecordString(first, "path_with_namespace");
      if (id && path) return { id, path };
    } catch {
      // Next endpoint.
    }
  }
  return undefined;
}

async function resolveNumericProjectId(rest: Rest, projectPath: string): Promise<string | undefined> {
  try {
    const response = await rest.fetch(gitLabApiUrl(rest.baseUrl, `/api/v4/projects/${encodeURIComponent(projectPath)}`), {
      method: "GET",
      headers: restHeaders(rest.apiKey),
      signal: restSignal(rest),
    });
    if (!response.ok) return undefined;
    return getRecordString(await response.json(), "id");
  } catch {
    return undefined;
  }
}

function extractWorkflowToken(payload: GitLabDirectAccessResponse): string | undefined {
  return (
    payload.gitlab_rails?.token ??
    payload.duo_workflow_service?.token ??
    payload.duo_workflow_access_token ??
    payload.workflow_token ??
    payload.token ??
    payload.access_token ??
    payload.jwt
  );
}

async function requestDirectAccess(
  rest: Rest,
  rootNamespaceId: string,
  projectId: string | undefined,
  workflowDefinition: string,
): Promise<DirectAccessConnection> {
  const response = await rest.fetch(gitLabApiUrl(rest.baseUrl, "/api/v4/ai/duo_workflows/direct_access"), {
    method: "POST",
    headers: restHeaders(rest.apiKey),
    body: JSON.stringify(buildDirectAccessBody(rootNamespaceId, projectId, workflowDefinition)),
    signal: restSignal(rest),
  });
  if (!response.ok) {
    const message = await readResponseErrorMessage(response);
    throw new Error(
      message
        ? `GitLab Duo Workflow direct_access failed with HTTP ${response.status}: ${message}`
        : `GitLab Duo Workflow direct_access failed with HTTP ${response.status}`,
    );
  }
  const payload = (await response.json()) as GitLabDirectAccessResponse;
  const token = extractWorkflowToken(payload);
  if (!token) throw new Error("GitLab Duo Workflow direct_access did not return credentials");
  const serviceEndpoint = !payload.gitlab_rails?.token && Boolean(payload.duo_workflow_service?.base_url);
  return {
    token,
    ...(serviceEndpoint && payload.duo_workflow_service?.base_url
      ? { baseUrl: normalizeServiceBaseUrl(payload.duo_workflow_service.base_url) }
      : {}),
    headers: serviceEndpoint ? (payload.duo_workflow_service?.headers ?? {}) : {},
    serviceEndpoint,
  };
}

async function createWorkflow(rest: Rest, namespaceId: string, projectId: string | undefined, workflowDefinition: string): Promise<string> {
  // Every workflow definition is the inline flow, whose create goal is "" (the goal rides the startRequest).
  const body = buildCreateBody(namespaceId, { goal: "", projectId, workflowDefinition });
  const response = await rest.fetch(gitLabApiUrl(rest.baseUrl, "/api/v4/ai/duo_workflows/workflows"), {
    method: "POST",
    headers: restHeaders(rest.apiKey),
    body: JSON.stringify(body),
    signal: restSignal(rest),
  });
  if (!response.ok) {
    throw new Error(
      `GitLab Duo Workflow create failed with HTTP ${response.status}. If the Duo Agent Platform or ` +
        "MCP is off for the group, turn them on in GitLab, or set LYKOS_GITLAB_DUO_ENABLE_GROUP_SETTINGS=1 " +
        "to let Lykos turn them on",
    );
  }
  const payload = (await response.json()) as Record<string, unknown>;
  const workflowId = payload.id ?? payload.workflow_id ?? payload.workflowId;
  if (workflowId === undefined || workflowId === null) {
    throw new Error(`GitLab Duo Workflow create response missing workflow id (HTTP ${response.status})`);
  }
  return String(workflowId);
}

/** Best-effort, on a fresh deadline decoupled from the caller's signal; never throws. */
async function stopWorkflow(rest: Rest, workflowId: string): Promise<void> {
  try {
    await rest.fetch(gitLabApiUrl(rest.baseUrl, `/api/v4/ai/duo_workflows/workflows/${encodeURIComponent(workflowId)}`), {
      method: "PATCH",
      headers: restHeaders(rest.apiKey),
      body: JSON.stringify({ status_event: "stop" }),
      signal: AbortSignal.timeout(rest.restTimeoutMs),
    });
  } catch {
    // Best effort.
  }
}

function parseAvailableModel(value: unknown): AvailableModel | null {
  if (!value || typeof value !== "object") return null;
  return { name: getRecordString(value, "name") ?? null, ref: getRecordString(value, "ref") ?? null };
}

async function fetchAvailableModels(rest: Rest, rootNamespaceId: string): Promise<AvailableModelsPayload | undefined> {
  try {
    const response = await rest.fetch(gitLabApiUrl(rest.baseUrl, "/api/graphql"), {
      method: "POST",
      headers: restHeaders(rest.apiKey),
      body: JSON.stringify({
        query: GITLAB_DUO_WORKFLOW_AVAILABLE_MODELS_QUERY,
        variables: { rootNamespaceId: toGitLabGraphQLNamespaceId(rootNamespaceId) },
      }),
      signal: restSignal(rest),
    });
    if (!response.ok) return undefined;
    const models = getRecord(getRecord(await response.json(), "data"), "aiChatAvailableModels");
    if (!models) return undefined;
    const selectable = models.selectableModels;
    return {
      pinnedModel: parseAvailableModel(getRecord(models, "pinnedModel")),
      selectedModel: parseAvailableModel(getRecord(models, "selectedModel")),
      defaultModel: parseAvailableModel(getRecord(models, "defaultModel")),
      selectableModels: Array.isArray(selectable)
        ? selectable.map(parseAvailableModel).filter((m): m is AvailableModel => m !== null)
        : undefined,
    };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Session and account state
// ---------------------------------------------------------------------------

const sessions = new Map<string, SessionState>();

interface AccountState {
  namespaceSelection?: GitLabDuoWorkflowNamespaceSelection | undefined;
  settingsEnsured?: boolean;
}

const accounts = new Map<string, AccountState>();

function sessionKey(baseUrl: string, modelId: string, sessionId: string | undefined): string {
  return `gitlab-duo-agent:${baseUrl}\u0000${modelId}\u0000${sessionId ?? ""}`;
}

/** Keyed by a non-reversible fingerprint of the credential, never the token. */
function accountState(apiKey: string, baseUrl: string, cwd: string): AccountState {
  const key = `${createHash("sha256").update(apiKey).digest("hex").slice(0, 16)}\u0000${baseUrl}\u0000${cwd}`;
  let state = accounts.get(key);
  if (!state) {
    state = {};
    accounts.set(key, state);
  }
  return state;
}

/** Close every resumable socket and forget cached namespaces. Tests call it between cases. */
export function resetGitLabDuoAgentState(): void {
  for (const session of sessions.values()) {
    try {
      session.active?.ws.close();
    } catch {
      // Already closed.
    }
  }
  sessions.clear();
  accounts.clear();
}

function findToolResult(messages: readonly PiMessage[], requestID: string): ToolResultMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "toolResult" && message.toolCallId === requestID) return message;
  }
  return undefined;
}

function resolveActionBatch(
  messages: readonly PiMessage[],
  actions: readonly ActionDescriptor[],
): { requestID: string; result: ToolResultMessage }[] | undefined {
  const resolved: { requestID: string; result: ToolResultMessage }[] = [];
  for (const action of actions) {
    const result = findToolResult(messages, action.requestID);
    if (!result) return undefined;
    resolved.push({ requestID: action.requestID, result });
  }
  return resolved;
}

function hasSteerAfterBatch(messages: readonly PiMessage[], batch: readonly { requestID: string }[]): boolean {
  const ids = new Set(batch.map((entry) => entry.requestID));
  let lastIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "toolResult" && ids.has(message.toolCallId)) {
      lastIndex = index;
      break;
    }
  }
  if (lastIndex < 0) return false;
  for (let index = lastIndex + 1; index < messages.length; index++) {
    if (messages[index]?.role === "user") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface GitLabDuoAgentStreamDeps {
  /** Opens the workflow WebSocket. Defaults to Node's global `WebSocket` with headers. */
  webSocketFactory?: GitLabDuoWorkflowWebSocketFactory;
  /** Idle deadline for the socket. Defaults to 90 s. */
  idleTimeoutMs?: number;
  /** Per-fetch REST deadline. Defaults to 30 s. */
  restTimeoutMs?: number;
  /** Environment for GITLAB_DUO_NAMESPACE_ID, GITLAB_DUO_PROJECT_ID, GITLAB_DUO_PROJECT_PATH, GITLAB_DUO_WORKFLOW_DEFINITION. */
  env?: NodeJS.ProcessEnv;
  /** Workspace whose `.git/config` names the GitLab project. Defaults to `process.cwd()`. */
  cwd?: string;
  fetch?: typeof fetch;
}

function defaultWebSocketFactory(url: string, options: { headers: Record<string, string> }): GitLabDuoWorkflowWebSocketLike {
  // Node 24's WebSocket (undici) accepts `{ headers }` in place of the protocols argument.
  const Ctor = (globalThis as unknown as { WebSocket: new (url: string, init: unknown) => GitLabDuoWorkflowWebSocketLike }).WebSocket;
  return new Ctor(url, { headers: options.headers });
}

interface NamespaceSetup {
  restNamespaceId: string;
  createNamespaceId: string;
  restProjectId: string | undefined;
  webSocketProjectId: string | undefined;
  startPayload: GitLabDuoWorkflowStartRequest;
  connection: DirectAccessConnection;
  workflowId: string;
  selectedModelIdentifier: string;
}

async function run(
  model: PiModel,
  context: PiContext,
  options: PiSimpleStreamOptions | undefined,
  deps: GitLabDuoAgentStreamDeps,
  state: StreamState,
): Promise<void> {
  const apiKey = options?.apiKey;
  if (!apiKey) throw new Error(`GitLab Duo Agent requires an access token. Run \`lykos login ${model.provider}\`.`);
  const baseUrl = normalizeGitLabBaseUrl(model.baseUrl || DEFAULT_GITLAB_BASE_URL);
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const signal = options?.signal;
  const idleTimeoutMs = deps.idleTimeoutMs !== undefined && deps.idleTimeoutMs > 0 ? deps.idleTimeoutMs : GITLAB_DUO_WORKFLOW_IDLE_TIMEOUT_MS;
  const rest: Rest = {
    fetch: (options?.fetch as typeof fetch | undefined) ?? deps.fetch ?? globalThis.fetch,
    baseUrl,
    apiKey,
    restTimeoutMs: deps.restTimeoutMs ?? GITLAB_DUO_WORKFLOW_REST_TIMEOUT_MS,
    signal,
  };
  const socketOpts = { signal, idleTimeoutMs };

  const key = sessionKey(baseUrl, model.id, options?.sessionId);
  let session = sessions.get(key);
  if (!session) {
    session = {};
    sessions.set(key, session);
  }
  state.session = session;

  // A pending tool call from the previous turn: answer it on the same socket.
  const pending = session.active;
  if (pending) {
    state.checkpointAgentContentByKey = pending.checkpointAgentContentByKey;
    state.checkpointAgentContentSignatures = pending.checkpointAgentContentSignatures;
  }
  const pendingActions = pending?.pendingActions;
  const batch = pending && pendingActions && pendingActions.length > 0 ? resolveActionBatch(context.messages, pendingActions) : undefined;
  const steered = Boolean(batch && hasSteerAfterBatch(context.messages, batch));
  if (pending && batch && !steered) {
    const responses = batch.map(({ requestID, result }) => buildActionResponse(requestID, toolResultToPlainText(result)));
    pending.pendingActions = undefined;
    let result: SocketResult;
    try {
      result = await runSocket(pending.ws, pending.startPayload, state, socketOpts, responses);
    } catch (error) {
      session.active = undefined;
      await stopWorkflow(rest, pending.workflowId);
      throw error;
    }
    if (result !== "stalled") {
      finalizeResult(state, session, result);
      if (result === "closed" || result === "timeout") await stopWorkflow(rest, pending.workflowId);
      return;
    }
    session.active = undefined;
    await stopWorkflow(rest, pending.workflowId);
  } else if (pending) {
    // A steer after the tool result, a tool result that never arrived, or a finished
    // session: the live workflow cannot be answered, so stop it and seed a fresh one.
    try {
      pending.ws.close();
    } catch {
      // Already closed.
    }
    session.active = undefined;
    await stopWorkflow(rest, pending.workflowId);
  }

  const workflowDefinition = nonEmptyString(env.GITLAB_DUO_WORKFLOW_DEFINITION) ?? GITLAB_DUO_WORKFLOW_DEFINITION;
  const configuredNamespace = nonEmptyString(env.GITLAB_DUO_NAMESPACE_ID);
  const configuredProjectPath = nonEmptyString(env.GITLAB_DUO_PROJECT_PATH);
  const configuredProjectId = nonEmptyString(env.GITLAB_DUO_PROJECT_ID);
  const explicitNamespace = Boolean(configuredNamespace ?? configuredProjectId ?? configuredProjectPath);
  const account = accountState(apiKey, baseUrl, cwd);

  const discoverNamespace = async (): Promise<GitLabDuoWorkflowNamespaceSelection> => {
    try {
      return await discoverGitLabDuoWorkflowRuntimeNamespace({
        apiKey,
        baseUrl,
        fetch: rest.fetch,
        ...(configuredNamespace ? { namespaceId: configuredNamespace } : {}),
        ...((configuredProjectId ?? configuredProjectPath) ? { projectId: (configuredProjectId ?? configuredProjectPath)! } : {}),
        cwd,
        signal: () => restSignal(rest),
      });
    } catch (error) {
      throw new Error(`GitLab Duo Workflow runtime namespace resolution failed: ${errorText(error)}`);
    }
  };

  const setupForNamespace = async (selection: GitLabDuoWorkflowNamespaceSelection): Promise<NamespaceSetup> => {
    const rootNamespaceId = selection.rootNamespaceId;
    const restNamespaceId = toGitLabRestNamespaceId(rootNamespaceId);
    const createNamespaceId = selection.namespacePath ?? restNamespaceId;
    // These group settings change the user's GitLab group from inside a model call, so Lykos does
    // it only when asked (LYKOS_GITLAB_DUO_ENABLE_GROUP_SETTINGS=1).
    if (!account.settingsEnsured && groupSettingsOptIn() && (await ensureSettings(rest, restNamespaceId))) {
      account.settingsEnsured = true;
    }
    const discoveredProject =
      !configuredProjectPath && !configuredProjectId
        ? selection.projectPath
          ? { path: selection.projectPath }
          : await discoverProject(rest, restNamespaceId)
        : undefined;
    const idIsPath = Boolean(configuredProjectId?.includes("/"));
    const numericConfiguredProjectId = idIsPath ? undefined : configuredProjectId;
    const pathConfiguredProjectId = idIsPath ? configuredProjectId : undefined;
    const projectPath = configuredProjectPath ?? pathConfiguredProjectId ?? discoveredProject?.path;
    const projectId = numericConfiguredProjectId ?? (discoveredProject && "id" in discoveredProject ? discoveredProject.id : undefined);
    const restProjectId = configuredProjectPath ?? configuredProjectId ?? discoveredProject?.path;
    const webSocketProjectId = projectId ?? (projectPath ? await resolveNumericProjectId(rest, projectPath) : undefined);
    const connection = await requestDirectAccess(rest, rootNamespaceId, restProjectId, workflowDefinition);
    const workflowId = await createWorkflow(rest, createNamespaceId, restProjectId, workflowDefinition);
    const availableModels = await fetchAvailableModels(rest, rootNamespaceId);
    const advertisedTools = (options as { toolChoice?: unknown } | undefined)?.toolChoice === "none" ? [] : context.tools;
    const startPayload = buildStartRequest(workflowId, model, context, advertisedTools, availableModels, {
      projectId: webSocketProjectId,
      namespaceId: restNamespaceId,
      rootNamespaceId: restNamespaceId,
      workflowDefinition,
    });
    return {
      restNamespaceId,
      createNamespaceId,
      restProjectId,
      webSocketProjectId,
      startPayload,
      connection,
      workflowId,
      selectedModelIdentifier: selectModelRef(model.id, availableModels),
    };
  };

  const cached = explicitNamespace ? undefined : account.namespaceSelection;
  let setup: NamespaceSetup;
  if (cached) {
    try {
      setup = await setupForNamespace(cached);
    } catch {
      account.namespaceSelection = undefined;
      const rediscovered = await discoverNamespace();
      setup = await setupForNamespace(rediscovered);
      account.namespaceSelection = rediscovered;
    }
  } else {
    const selection = await discoverNamespace();
    setup = await setupForNamespace(selection);
    if (!explicitNamespace) account.namespaceSelection = selection;
  }

  if (setup.webSocketProjectId === undefined && setup.restProjectId === undefined) state.noProject = true;
  let workflowId = setup.workflowId;
  let startPayload = setup.startPayload;

  const goalBytes = Buffer.byteLength(startPayload.goal, "utf8");
  if (goalBytes >= GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES) {
    state.output.stopReason = "error";
    state.output.errorMessage = buildGoalOverflowMessage(goalBytes);
    state.stream.push({ type: "error", reason: "error", error: state.output });
    session.active = undefined;
    await stopWorkflow(rest, workflowId);
    return;
  }
  if (goalBytes >= GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES) state.goalOverflowMessage = buildGoalOverflowMessage(goalBytes);

  const freshWorkflow = async (): Promise<void> => {
    await stopWorkflow(rest, workflowId);
    workflowId = await createWorkflow(rest, setup.createNamespaceId, setup.restProjectId, workflowDefinition);
    startPayload = { ...startPayload, workflowID: workflowId };
  };

  const factory = deps.webSocketFactory ?? defaultWebSocketFactory;
  let lastResult: SocketResult = "closed";
  let timeoutRestarted = false;
  let stepLimitRestarts = 0;
  let genericErrorRetries = 0;
  let stallRestarts = 0;
  let settledNormally = false;
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      const socketBase = setup.connection.baseUrl ?? baseUrl;
      const url = buildWebSocketUrl(socketBase, {
        projectId: setup.webSocketProjectId,
        namespaceId: setup.restNamespaceId,
        rootNamespaceId: setup.restNamespaceId,
        selectedModelIdentifier: setup.selectedModelIdentifier,
        workflowDefinition,
        serviceEndpoint: setup.connection.serviceEndpoint,
      });
      const headers = buildWebSocketHeaders({
        token: setup.connection.token,
        baseUrl,
        projectId: setup.webSocketProjectId,
        namespaceId: setup.restNamespaceId,
        rootNamespaceId: setup.restNamespaceId,
        extraHeaders: setup.connection.headers,
      });
      const ws = factory(url, { headers });
      const stopId = workflowId;
      session.active = {
        workflowId,
        startPayload,
        ws,
        stop: () => {
          void stopWorkflow(rest, stopId);
        },
      };
      lastResult = await runSocket(ws, startPayload, state, socketOpts);
      if (lastResult === "approval") {
        startPayload = buildApprovalStartRequest(startPayload);
        state.lastApprovalStatus = undefined;
        continue;
      }
      if (lastResult === "timeout" && !timeoutRestarted) {
        timeoutRestarted = true;
        await freshWorkflow();
        continue;
      }
      if (lastResult === "step_limit" && stepLimitRestarts < GITLAB_DUO_WORKFLOW_MAX_STEP_LIMIT_RESTARTS) {
        stepLimitRestarts++;
        state.stepLimitRequested = false;
        await freshWorkflow();
        continue;
      }
      if (lastResult === "stalled" && stallRestarts < GITLAB_DUO_WORKFLOW_MAX_STALL_RESTARTS) {
        stallRestarts++;
        state.stalledRequested = false;
        await freshWorkflow();
        continue;
      }
      if (lastResult === "retryable_error" && genericErrorRetries < GITLAB_DUO_WORKFLOW_MAX_GENERIC_ERROR_RETRIES) {
        genericErrorRetries++;
        state.retryableErrorRequested = false;
        delete state.output.errorMessage;
        await freshWorkflow();
        continue;
      }
      if (lastResult === "retryable_error" && !state.stream.finished) {
        state.output.stopReason = "error";
        state.output.errorMessage = failureText(state, state.output.errorMessage ?? "GitLab Duo Workflow failed");
        state.stream.push({ type: "error", reason: "error", error: state.output });
      }
      if (lastResult === "stalled" && !state.stream.finished) {
        state.output.stopReason = "error";
        state.output.errorMessage = failureText(state, state.output.errorMessage ?? GITLAB_DUO_WORKFLOW_STALL_ERROR_MESSAGE);
        state.stream.push({ type: "error", reason: "error", error: state.output });
      }
      break;
    }
    settledNormally = true;
    finalizeResult(state, session, lastResult);
  } finally {
    const aborted = signal?.aborted ?? false;
    if (aborted || !settledNormally || lastResult === "closed" || lastResult === "timeout" || lastResult === "stalled") {
      session.active = undefined;
      await stopWorkflow(rest, workflowId);
    }
  }
}

/** `action` keeps the session for the next call; every other result drops it and ends the stream. */
function finalizeResult(state: StreamState, session: SessionState, result: SocketResult): void {
  if (result === "action") return;
  session.active = undefined;
  if (result !== "terminal" && !state.stream.finished) finishStream(state, "stop");
}

/** The `gitlab-duo-agent` `streamSimple`: returns Pi's event stream at once and runs the workflow behind it. */
export function createGitLabDuoAgentStreamSimple(deps: GitLabDuoAgentStreamDeps = {}): StreamSimpleFn {
  return (model, context, options) => {
    const stream = new DuoEventStream();
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    stream.push({ type: "start", partial: output });
    const state: StreamState = { stream, output };
    void run(model, context, options, deps, state)
      .catch((error: unknown) => {
        if (stream.finished) return;
        const aborted = options?.signal?.aborted ?? false;
        output.stopReason = aborted ? "aborted" : "error";
        output.errorMessage = failureText(state, errorText(error));
        stream.push({ type: "error", reason: output.stopReason, error: output });
      })
      .finally(() => {
        if (!stream.finished) finishStream(state, "stop");
        stream.end(output);
      });
    return stream as unknown as PiEventStream;
  };
}
