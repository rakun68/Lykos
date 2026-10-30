// The Cursor Agent `streamSimple` for api `cursor-agent`.
//
// Pi 0.84.3 has no implementation of this protocol; Lykos registers this one
// through `ModelRuntime.registerProvider` and never patches Pi (rule 7).
//
// The transport is one HTTP/2 POST to `/agent.v1.AgentService/Run` carrying
// Connect frames (a flag byte, a big-endian length, a protobuf body). The client
// writes the run request, then heartbeats every 5 s and its answers to what the
// server asks (blob reads and writes, exec requests, interaction queries); the
// server streams interaction updates until `turnEnded` and a clean HTTP/2 end.
//
// Kept: text and thinking deltas, MCP tool calls (surfaced to Pi as tool calls),
// output-token usage, Connect end-stream and gRPC-trailer errors, HTTP/2 errors,
// the conversation checkpoint cache and the blob store, heartbeats, the request
// context handshake, and the conversation history (root prompt JSON blobs and turn
// structures) rebuilt from Pi's context on every call.
//
// Plan D4, every tool goes through Lykos's gate: no exec handler exists here.
// Each native exec request (read, ls, grep, write, delete, shell, diagnostics,
// fetch, the Pi-shaped frames, ...) gets the frame's rejected or error result
// with reason "Tool not available". No tool-call block is synthesized for a native exec frame, because Pi's agent loop would
// execute any tool-call block it is given. MCP calls are the one kind surfaced:
// the exec `mcpArgs` frame is answered with the external handoff text and
// Pi's agent loop runs the call through Lykos's gate, sending the result back in
// the next request's history. Hosted tools gated by an interaction query (web
// search, web fetch, Exa) are rejected for the same reason. Nothing in this module executes a tool, touches the filesystem
// or spawns a process.
//
// Dropped, and why:
// - Debug logging, request dumps and proxy support (plan D4).
// - The normalized/discovered wire-model split and its retry: it needs a
//   model taxonomy. The model id goes out
//   as the table names it, except the
//   `composer-2.5` Standard-tier pin, which needs no taxonomy.
// - Conversation-id rotation on a bare `resource_exhausted` (#8345): ticket 05's
//   rotation decides what a usage failure means.
// - Kimi-K3 thinking replay (needs the taxonomy); thinking is never replayed.
// - Todo, connect-SCM, web-fetch and edit tool-call blocks: they are server-side
//   or exec-owned calls, and a block would make Pi run a tool of that name.
// - Partial-JSON repair of streamed MCP arguments: the buffer is parsed with
//   `JSON.parse` when the call completes, merged with the completion frame's
//   decoded arguments as `mergeCursorMcpToolCallArgs` does.
// - A schema upgrade: the tool's parameters go out as a JSON clone. Every tool is
//   advertised, because Lykos serves none of them natively (D4).
// - Cost: zero (rule 5). Cursor's wire carries output tokens (`tokenDelta`) and
//   the context size (`ConversationTokenDetails.usedTokens`), not input or cache
//   tokens, so input and cache stay 0: unmeasured, not estimated (rule 4).
//
// Errors: a Connect end-stream error reads `Connect error <code>: <message>`.
// A non-200 HTTP response reads `Cursor API error: <status> <body>`. For ticket
// 05's classifier
// the two auth codes also carry an HTTP status: `unauthenticated` is 401 and
// `permission_denied` 403, the Connect protocol's own code-to-HTTP mapping. That
// mapping has not been observed from Cursor.

import { createHash, randomUUID } from "node:crypto";
import http2 from "node:http2";
import { create, decodeJsonValue, encodeJsonValue, fromBinary, type JsonValue, toBinary } from "../protobuf/codec.js";
import { CcaEventStream } from "../google-cca/stream.js";
import type {
  AssistantMessage,
  PiContext,
  PiEventStream,
  PiMessage,
  PiModel,
  PiSimpleStreamOptions,
  PiTool,
  StreamSimpleFn,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "../google-cca/types.js";
import {
  AgentClientMessageSchema,
  AgentConversationTurnStructureSchema,
  AgentRunRequestSchema,
  type AgentServerMessage,
  AgentServerMessageSchema,
  AgentStoreConflictErrorSchema,
  AgentStoreConflictResultSchema,
  AskQuestionInteractionResponseSchema,
  AskQuestionRejectedSchema,
  AskQuestionResultSchema,
  AssistantMessageSchema,
  BackgroundShellSpawnResultSchema,
  BeforeSubmitPromptRequestResponseSchema,
  AfterAgentResponseRequestResponseSchema,
  AfterAgentThoughtRequestResponseSchema,
  CanvasDiagnosticsErrorSchema,
  CanvasDiagnosticsResultSchema,
  ClientHeartbeatSchema,
  ComputerUseErrorSchema,
  ComputerUseResultSchema,
  ConversationActionSchema,
  ConversationSearchErrorSchema,
  ConversationSearchResultSchema,
  type ConversationStateStructure,
  ConversationStateStructureSchema,
  type ConversationStep,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  CreatePlanErrorSchema,
  CreatePlanRequestResponseSchema,
  CreatePlanResultSchema,
  type CursorRule,
  CursorRuleSchema,
  CursorRuleSource,
  CursorRuleTypeGlobalSchema,
  CursorRuleTypeSchema,
  DeleteRejectedSchema,
  DeleteResultSchema,
  DiagnosticsRejectedSchema,
  DiagnosticsResultSchema,
  ExaFetchRequestResponse_RejectedSchema,
  ExaFetchRequestResponseSchema,
  ExaSearchRequestResponse_RejectedSchema,
  ExaSearchRequestResponseSchema,
  ExecClientControlMessageSchema,
  type ExecClientMessage,
  ExecClientMessageSchema,
  ExecClientStreamCloseSchema,
  ExecClientThrowSchema,
  type ExecServerMessage,
  type ExecuteHookRequest,
  type ExecuteHookResponse,
  ExecuteHookResponseSchema,
  type ExecuteHookResult,
  ExecuteHookResultSchema,
  FetchErrorSchema,
  FetchResultSchema,
  ForceBackgroundShellResultSchema,
  ForceBackgroundShellStatus,
  ForceBackgroundSubagentResultSchema,
  ForceBackgroundSubagentStatus,
  GetBlobResultSchema,
  GrepErrorSchema,
  GrepResultSchema,
  type InteractionQuery,
  type InteractionResponse,
  InteractionResponseSchema,
  KvClientMessageSchema,
  type KvServerMessage,
  ListMcpResourcesExecResultSchema,
  ListMcpResourcesSuccessSchema,
  LsRejectedSchema,
  LsResultSchema,
  McpAllowlistPrecheckResultSchema,
  McpArgsSchema,
  type McpArgs,
  McpImageContentSchema,
  McpRejectedSchema,
  McpResultSchema,
  type McpStateExecResult,
  McpStateExecResultSchema,
  McpStateServerSchema,
  McpStateSuccessSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolCallSchema,
  type McpToolDefinition,
  McpToolDefinitionSchema,
  McpToolErrorSchema,
  McpToolResultContentItemSchema,
  McpToolResultSchema,
  ModelDetailsSchema,
  PiBashExecErrorSchema,
  PiBashExecResultSchema,
  PiEditExecRejectedSchema,
  PiEditExecResultSchema,
  PiFindExecErrorSchema,
  PiFindExecResultSchema,
  PiGrepExecErrorSchema,
  PiGrepExecResultSchema,
  PiLsExecErrorSchema,
  PiLsExecResultSchema,
  PiReadExecErrorSchema,
  PiReadExecResultSchema,
  PiWriteExecRejectedSchema,
  PiWriteExecResultSchema,
  PostToolUseFailureRequestResponseSchema,
  PostToolUseRequestResponseSchema,
  PreCompactRequestResponseSchema,
  PreToolUseRequestResponseSchema,
  ReadErrorSchema,
  ReadMcpResourceExecResultSchema,
  ReadMcpResourceNotFoundSchema,
  ReadRejectedSchema,
  ReadResultSchema,
  RecordScreenFailureSchema,
  RecordScreenResultSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  RequestedModel_ModelParameterbytesSchema,
  RequestedModelSchema,
  ResumeActionSchema,
  SelectedContextSchema,
  SelectedImageSchema,
  SetBlobResultSchema,
  ShellAllowlistPrecheckResultSchema,
  type ShellArgs,
  ShellRejectedSchema,
  type ShellResult,
  ShellResultSchema,
  type ShellStream,
  ShellStreamExitSchema,
  ShellStreamSchema,
  ShellStreamStartSchema,
  SmartModeClassifierErrorSchema,
  SmartModeClassifierResultSchema,
  StopRequestResponseSchema,
  SubagentAwaitNotFoundSchema,
  SubagentAwaitResultSchema,
  SubagentErrorSchema,
  SubagentResultSchema,
  SubagentStartRequestResponseSchema,
  SubagentStopRequestResponseSchema,
  SwitchModeRequestResponse_RejectedSchema,
  SwitchModeRequestResponseSchema,
  type ToolCall as ProtoToolCall,
  ToolCallSchema,
  UserMessageActionSchema,
  UserMessageSchema,
  WebFetchAllowlistPrecheckResultSchema,
  WebFetchRequestResponse_RejectedSchema,
  WebFetchRequestResponseSchema,
  WebSearchRequestResponse_RejectedSchema,
  WebSearchRequestResponseSchema,
  WriteRejectedSchema,
  WriteResultSchema,
  WriteShellStdinErrorSchema,
  WriteShellStdinResultSchema,
} from "./proto.js";

export const CURSOR_API_URL = "https://api2.cursor.sh";
export const CURSOR_CLIENT_VERSION = "cli-2026.07.23-e383d2b";
export const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run";
export const CONNECT_END_STREAM_FLAG = 0b00000010;
const HEARTBEAT_INTERVAL_MS = 5000;
const NOT_IMPLEMENTED_SUFFIX = "not implemented by this client";
const NOT_IMPLEMENTED = `Not implemented by this client`;
const TOOL_NOT_AVAILABLE = "Tool not available";

/** The answer to an exec `mcpArgs` frame: the call is handed back to the client. */
export const MCP_EXTERNAL_HANDOFF_MESSAGE =
  "Tool call received and handed off to the external client for execution. Do not retry or call it again; end the turn. The result will be provided in the next request.";

/** Lykos's reason for refusing a hosted tool behind an interaction query (plan D4). */
const HOSTED_TOOL_REJECTED = "Hosted tools are disabled by this client; use the client's own tools";

/** HTTP/2 connection-specific headers and the ones the request sets itself. */
const HTTP2_FORBIDDEN_HEADERS = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "http2-settings"]);
const CURSOR_RESERVED_HEADERS = new Set([
  "content-type",
  "connect-protocol-version",
  "te",
  "authorization",
  "x-ghost-mode",
  "x-cursor-client-version",
  "x-cursor-client-type",
  "x-request-id",
  "host",
  "content-length",
]);

/** The Connect protocol's HTTP status for the two auth codes (see the header comment). */
const CONNECT_AUTH_CODE_STATUS: Record<string, number> = { unauthenticated: 401, permission_denied: 403 };

// ---------------------------------------------------------------------------
// Pi types not re-exported by google-cca/types.ts
// ---------------------------------------------------------------------------

type UserMessage = Extract<PiMessage, { role: "user" }>;
type ToolResultMessage = Extract<PiMessage, { role: "toolResult" }>;
type UserContent = UserMessage["content"];
type ImageContent = Extract<Exclude<UserContent, string>[number], { type: "image" }>;

// ---------------------------------------------------------------------------
// Framing and errors (cursor.ts, connect-error-detail.ts)
// ---------------------------------------------------------------------------

export function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
  const frame = Buffer.alloc(5 + data.length);
  frame[0] = flags;
  frame.writeUInt32BE(data.length, 1);
  frame.set(data, 5);
  return frame;
}

/** Messages that carry no diagnostic content on their own (connect-error-detail.ts). */
const GENERIC_CONNECT_ERROR_MESSAGES = new Set(["", "error", "unknown", "unknown error", "internal", "internal error"]);
const MAX_EXTRA_DETAIL_CHARS = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function safeJson(value: unknown): string | undefined {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text || undefined;
  } catch {
    return undefined;
  }
}

function summarizeConnectErrorDetails(details: unknown): string | undefined {
  if (!Array.isArray(details) || details.length === 0) return undefined;
  const parts: string[] = [];
  for (const entry of details) {
    if (!isRecord(entry)) continue;
    const type = typeof entry.type === "string" && entry.type ? entry.type : undefined;
    const debug = entry.debug !== undefined ? safeJson(entry.debug) : undefined;
    const value = entry.value !== undefined ? safeJson(entry.value) : undefined;
    const diagnostic = debug ?? value;
    if (type && diagnostic) parts.push(`${type}: ${diagnostic}`);
    else if (type) parts.push(type);
    else if (diagnostic) parts.push(diagnostic);
  }
  if (parts.length === 0) return undefined;
  return truncate(parts.join("; "), MAX_EXTRA_DETAIL_CHARS);
}

export function formatConnectEndStreamError(error: unknown): string {
  const record = isRecord(error) ? error : {};
  const code = typeof record.code === "string" && record.code ? record.code : "unknown";
  const message = typeof record.message === "string" ? record.message : "";
  const detail = summarizeConnectErrorDetails(record.details);
  const parts: string[] = [`Connect error ${code}: ${message || "Unknown error"}`];
  if (detail) parts.push(`[details: ${detail}]`);
  else if (GENERIC_CONNECT_ERROR_MESSAGES.has(message.trim().toLowerCase())) {
    const extras: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (key === "code" || key === "message") continue;
      extras[key] = value;
    }
    const raw = Object.keys(extras).length > 0 ? safeJson(extras) : undefined;
    if (raw && raw !== "{}") parts.push(`[trailer: ${truncate(raw, MAX_EXTRA_DETAIL_CHARS)}]`);
  }
  return parts.join(" ");
}

/** An end-stream error: the text Pi shows, plus the Connect code. */
export class ConnectEndStreamError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ConnectEndStreamError";
  }
}

/** The end-stream JSON's `error`, or null when it carries none. */
export function parseConnectEndStream(data: Uint8Array): Error | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(data)) as { error?: unknown } | null;
    const error = payload?.error;
    if (error) {
      const record = isRecord(error) ? error : {};
      const code = typeof record.code === "string" ? record.code : "unknown";
      let message = formatConnectEndStreamError(error);
      const status = CONNECT_AUTH_CODE_STATUS[code];
      if (status !== undefined) message += ` (HTTP ${status})`;
      return new ConnectEndStreamError(message, code);
    }
    return null;
  } catch {
    return new Error("Failed to parse Connect end stream");
  }
}

/** Name the ALPN failure, pass anything else through. */
export function mapH2TransportError(error: unknown, baseUrl: string): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ERR_HTTP2_ERROR" && /h2 is not supported/i.test(message)) {
    return new Error(
      `Cursor run transport could not negotiate HTTP/2 with ${baseUrl}: "h2 is not supported". ` +
        "This host serves the run RPC over HTTP/2 only, and the TLS handshake did not negotiate " +
        "h2 via ALPN — typically an ALPN-stripping TLS-intercepting proxy.",
    );
  }
  return error;
}

function sanitizeCursorCallerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const field = name.toLowerCase();
    if (field.startsWith(":")) continue;
    if (HTTP2_FORBIDDEN_HEADERS.has(field)) continue;
    if (CURSOR_RESERVED_HEADERS.has(field)) continue;
    sanitized[field] = value;
  }
  return sanitized;
}

// ---------------------------------------------------------------------------
// Conversation state (module-level, keyed by conversation id)
// ---------------------------------------------------------------------------

const conversationStateCache = new Map<string, ConversationStateStructure>();
const conversationBlobStores = new Map<string, Map<string, Uint8Array>>();

/** Forget every cached conversation (tests). */
export function resetCursorConversationState(): void {
  conversationStateCache.clear();
  conversationBlobStores.clear();
}

function createBlobId(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

function storeCursorBlob(blobStore: Map<string, Uint8Array>, data: Uint8Array): Uint8Array {
  const blobId = createBlobId(data);
  blobStore.set(Buffer.from(blobId).toString("hex"), data);
  return blobId;
}

/** The leading 128 bits of SHA-256 in the 8-4-4-4-12 layout. */
function deterministicUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function normalizeToolCallId(id: string): string {
  const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
}

// ---------------------------------------------------------------------------
// Request building (cursor.ts buildGrpcRequestForWireMode and helpers)
// ---------------------------------------------------------------------------

function normalizeSystemPrompts(systemPrompt: string | undefined): string[] {
  if (systemPrompt === undefined) return [];
  return [systemPrompt].filter((prompt) => prompt.trim().length > 0);
}

/** Each system prompt becomes an always-apply rule. */
export function buildCursorRequestContextRules(systemPrompt: string | undefined): CursorRule[] {
  return normalizeSystemPrompts(systemPrompt).map((content, index) =>
    create(CursorRuleSchema, {
      fullPath: `/lykos/system-prompt/${index}.mdc`,
      content,
      source: CursorRuleSource.USER,
      type: create(CursorRuleTypeSchema, {
        type: { case: "global", value: create(CursorRuleTypeGlobalSchema, {}) },
      }),
    }),
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  for (const key in value) {
    if (!isJsonValue(value[key])) return false;
  }
  return true;
}

function plainSchema(tool: PiTool): unknown {
  try {
    return JSON.parse(JSON.stringify(tool.parameters ?? { type: "object", properties: {} })) as unknown;
  } catch {
    return undefined;
  }
}

export function buildMcpToolDefinitions(tools: readonly PiTool[] | undefined): McpToolDefinition[] {
  if (!tools || tools.length === 0) return [];
  return tools.map((tool) => {
    const jsonSchema = plainSchema(tool);
    const schemaValue: JsonValue =
      jsonSchema !== null && jsonSchema !== undefined && !Array.isArray(jsonSchema) && isJsonValue(jsonSchema)
        ? jsonSchema
        : { type: "object", properties: {}, required: [] };
    return create(McpToolDefinitionSchema, {
      name: tool.name,
      description: tool.description || "",
      providerIdentifier: "pi-agent",
      toolName: tool.name,
      inputSchema: encodeJsonValue(schemaValue),
    });
  });
}

function extractUserMessageText(msg: PiMessage): string {
  if (msg.role !== "user") return "";
  const content = msg.content;
  if (typeof content === "string") return content.trim();
  return content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

function hasUserMessageImages(msg: PiMessage): boolean {
  return msg.role === "user" && Array.isArray(msg.content) && msg.content.some((item) => item.type === "image");
}

type CursorRootPromptContentPart = { type: "text"; text: string } | { type: "image"; image: string; mediaType: string };

function buildCursorRootPromptContent(content: UserContent): CursorRootPromptContentPart[] {
  if (typeof content === "string") {
    const text = content.trim();
    return text ? [{ type: "text", text }] : [];
  }
  const parts: CursorRootPromptContentPart[] = [];
  for (const item of content) {
    if (item.type === "text") {
      const text = item.text.trim();
      if (text) parts.push({ type: "text", text });
    } else {
      parts.push({ type: "image", image: `data:${item.mimeType};base64,${item.data}`, mediaType: item.mimeType });
    }
  }
  return parts;
}

function cursorUserContentKey(content: UserContent): string {
  if (typeof content === "string") return content.trim();
  const hash = createHash("sha256");
  for (const item of content) {
    hash.update(item.type);
    if (item.type === "text") {
      hash.update(item.text);
    } else {
      hash.update(item.mimeType);
      hash.update(item.data);
    }
  }
  return hash.digest("hex");
}

type CursorRootPromptAssistantContentPart =
  | { type: "text"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: Record<string, unknown> };

function buildCursorAssistantContent(msg: AssistantMessage): CursorRootPromptAssistantContentPart[] {
  const content: CursorRootPromptAssistantContentPart[] = [];
  for (const item of msg.content) {
    if (item.type === "text") {
      if (item.text) content.push({ type: "text", text: item.text });
    } else if (item.type === "toolCall") {
      content.push({
        type: "tool-call",
        toolCallId: normalizeToolCallId(item.id),
        toolName: item.name,
        args: normalizeCursorMcpArguments(item.arguments),
      });
    }
    // Thinking is never replayed.
  }
  return content;
}

function findLastUserMessageIndex(messages: readonly PiMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "user") return i;
  }
  return -1;
}

export function buildCursorSystemPromptJsons(systemPrompt: string | undefined): string[] {
  const systemPrompts = normalizeSystemPrompts(systemPrompt);
  if (systemPrompts.length === 0) {
    return [JSON.stringify({ role: "system", content: "You are a helpful assistant." })];
  }
  return systemPrompts.map((content) => JSON.stringify({ role: "system", content }));
}

function collectCursorToolHistory(messages: readonly PiMessage[], historyEnd: number) {
  const toolResults = new Map<string, ToolResultMessage>();
  const pairedToolCallIds = new Set<string>();
  for (let index = 0; index < historyEnd; index++) {
    const message = messages[index]!;
    if (message.role === "toolResult") {
      toolResults.set(message.toolCallId, message);
    } else if (message.role === "assistant") {
      for (const item of message.content) {
        if (item.type === "toolCall") pairedToolCallIds.add(item.id);
      }
    }
  }
  return { toolResults, pairedToolCallIds };
}

function toolResultToText(toolResult: ToolResultMessage): string {
  return toolResult.content.map((item) => (item.type === "text" ? item.text : `[${item.mimeType} image]`)).join("\n");
}

function cursorOrphanToolResultText(result: ToolResultMessage): string {
  const prefix = result.isError ? "[Tool Error]" : "[Tool Result]";
  return `${prefix}\n${toolResultToText(result) || "(empty result)"}`;
}

/** System prompt blobs, then history as Vercel-AI-SDK-shaped JSON blobs. */
function buildRootPromptMessagesJson(
  messages: readonly PiMessage[],
  systemPromptIds: Uint8Array[],
  blobStore: Map<string, Uint8Array>,
  activeUserMessageIndex: number,
): Uint8Array[] {
  const historyEnd = activeUserMessageIndex >= 0 ? activeUserMessageIndex : messages.length;
  const { pairedToolCallIds } = collectCursorToolHistory(messages, historyEnd);
  const entries: Uint8Array[] = [...systemPromptIds];
  const pushJson = (obj: unknown): void => {
    entries.push(storeCursorBlob(blobStore, new TextEncoder().encode(JSON.stringify(obj))));
  };

  for (let i = 0; i < messages.length; i++) {
    if (i === activeUserMessageIndex) break;
    const msg = messages[i]!;
    if (msg.role === "user") {
      const content = buildCursorRootPromptContent(msg.content);
      if (content.length === 0) continue;
      pushJson({ role: "user", content });
    } else if (msg.role === "assistant") {
      const content = buildCursorAssistantContent(msg);
      if (content.length === 0) continue;
      pushJson({ role: "assistant", content });
    } else {
      if (!pairedToolCallIds.has(msg.toolCallId)) {
        pushJson({ role: "assistant", content: [{ type: "text", text: cursorOrphanToolResultText(msg) }] });
        continue;
      }
      const toolCallId = normalizeToolCallId(msg.toolCallId);
      pushJson({
        role: "tool",
        id: toolCallId,
        content: [
          {
            type: "tool-result",
            toolName: msg.toolName,
            toolCallId,
            result: toolResultToText(msg),
            ...(msg.isError ? { isError: true } : {}),
          },
        ],
      });
    }
  }
  return entries;
}

function normalizeCursorMcpArgument(value: unknown, seen: Set<object>): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => normalizeCursorMcpArgument(item, seen) ?? null);
    if (!isRecord(value)) return undefined;
    const normalized: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      const item = normalizeCursorMcpArgument(value[key], seen);
      if (item !== undefined) normalized[key] = item;
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

function normalizeCursorMcpArguments(args: Record<string, unknown>): Record<string, JsonValue> {
  const normalized: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  const seen = new Set<object>();
  for (const name in args) {
    if (!Object.hasOwn(args, name)) continue;
    const value = normalizeCursorMcpArgument(args[name], seen);
    if (value !== undefined) normalized[name] = value;
  }
  return normalized;
}

function encodeCursorMcpArguments(toolCall: ToolCall): Record<string, Uint8Array> {
  const encoded: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  const normalized = normalizeCursorMcpArguments(toolCall.arguments);
  for (const name in normalized) encoded[name] = encodeJsonValue(normalized[name]!);
  return encoded;
}

function createCursorMcpResult(result: ToolResultMessage) {
  if (result.isError) {
    return create(McpToolResultSchema, {
      result: { case: "error", value: create(McpToolErrorSchema, { error: toolResultToText(result) }) },
    });
  }
  return create(McpToolResultSchema, {
    result: {
      case: "success",
      value: create(McpSuccessSchema, {
        content: result.content.map((item) =>
          item.type === "text"
            ? create(McpToolResultContentItemSchema, {
                content: { case: "text", value: create(McpTextContentSchema, { text: item.text }) },
              })
            : create(McpToolResultContentItemSchema, {
                content: {
                  case: "image",
                  value: create(McpImageContentSchema, {
                    data: Uint8Array.from(Buffer.from(item.data, "base64")),
                    mimeType: item.mimeType,
                  }),
                },
              }),
        ),
      }),
    },
  });
}

function createCursorToolCallStep(toolCall: ToolCall, result: ToolResultMessage | undefined): ConversationStep {
  const toolCallId = normalizeToolCallId(toolCall.id);
  const mcpCall = create(McpToolCallSchema, {
    args: create(McpArgsSchema, {
      name: toolCall.name,
      args: encodeCursorMcpArguments(toolCall),
      toolCallId,
      providerIdentifier: "pi-agent",
      toolName: toolCall.name,
    }),
    ...(result ? { result: createCursorMcpResult(result) } : {}),
  });
  return create(ConversationStepSchema, {
    message: {
      case: "toolCall",
      value: create(ToolCallSchema, { tool: { case: "mcpToolCall", value: mcpCall }, toolCallId }),
    },
  });
}

function extractImages(content: Exclude<UserContent, string>) {
  return content
    .filter((item): item is ImageContent => item.type === "image")
    .map((image) =>
      create(SelectedImageSchema, {
        uuid: randomUUID(),
        mimeType: image.mimeType,
        dataOrBlobId: { case: "data", value: Uint8Array.from(Buffer.from(image.data, "base64")) },
      }),
    );
}

function createCursorUserMessage(content: UserContent, text: string, messageId: string = randomUUID()) {
  const images = typeof content === "string" ? [] : extractImages(content);
  return create(UserMessageSchema, {
    text,
    messageId,
    ...(images.length > 0 ? { selectedContext: create(SelectedContextSchema, { selectedImages: images }) } : {}),
  });
}

/** Turn-structure blob ids for the history before the active user message. */
function buildConversationTurns(
  messages: readonly PiMessage[],
  blobStore: Map<string, Uint8Array>,
  activeUserMessageIndex: number,
): Uint8Array[] {
  const turns: Uint8Array[] = [];
  const historyEnd = activeUserMessageIndex >= 0 ? activeUserMessageIndex : messages.length;
  const { toolResults, pairedToolCallIds } = collectCursorToolHistory(messages, historyEnd);

  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;
    if (msg.role !== "user") {
      i++;
      continue;
    }
    if (i === activeUserMessageIndex) break;

    const userText = extractUserMessageText(msg);
    if (userText.length === 0 && !hasUserMessageImages(msg)) {
      i++;
      continue;
    }
    const userMessage = createCursorUserMessage(
      msg.content,
      userText,
      deterministicUuid(`u:${turns.length}:${cursorUserContentKey(msg.content)}`),
    );
    const userMessageBlobId = storeCursorBlob(blobStore, toBinary(UserMessageSchema, userMessage));
    const stepBlobIds: Uint8Array[] = [];
    i++;

    while (i < messages.length && messages[i]!.role !== "user") {
      const stepMsg = messages[i]!;
      if (stepMsg.role === "assistant") {
        for (const item of stepMsg.content) {
          let step: ConversationStep;
          if (item.type === "text") {
            if (!item.text) continue;
            step = create(ConversationStepSchema, {
              message: { case: "assistantMessage", value: create(AssistantMessageSchema, { text: item.text }) },
            });
          } else if (item.type === "toolCall") {
            step = createCursorToolCallStep(item, toolResults.get(item.id));
          } else {
            continue;
          }
          stepBlobIds.push(storeCursorBlob(blobStore, toBinary(ConversationStepSchema, step)));
        }
      } else if (stepMsg.role === "toolResult" && !pairedToolCallIds.has(stepMsg.toolCallId)) {
        const step = create(ConversationStepSchema, {
          message: {
            case: "assistantMessage",
            value: create(AssistantMessageSchema, { text: cursorOrphanToolResultText(stepMsg) }),
          },
        });
        stepBlobIds.push(storeCursorBlob(blobStore, toBinary(ConversationStepSchema, step)));
      }
      i++;
    }

    const agentTurn = create(AgentConversationTurnStructureSchema, { userMessage: userMessageBlobId, steps: stepBlobIds });
    const turn = create(ConversationTurnStructureSchema, { turn: { case: "agentConversationTurn", value: agentTurn } });
    turns.push(storeCursorBlob(blobStore, toBinary(ConversationTurnStructureSchema, turn)));
  }
  return turns;
}

function extractText(content: Exclude<UserContent, string>): string {
  return content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/** The wire model id and parameters: the table id as is, plus the `composer-2.5` Standard-tier pin. */
function resolveCursorWireModel(modelId: string) {
  if (modelId === "composer-2.5") {
    return { modelId, parameters: [create(RequestedModel_ModelParameterbytesSchema, { id: "fast", value: "false" })] };
  }
  return { modelId, parameters: [] };
}

export interface CursorRunRequest {
  requestBytes: Uint8Array;
  conversationState: ConversationStateStructure;
}

/** The `runRequest` frame body. */
export async function buildCursorRunRequest(
  model: PiModel,
  context: PiContext,
  options: PiSimpleStreamOptions | undefined,
  state: { conversationId: string; blobStore: Map<string, Uint8Array>; conversationState?: ConversationStateStructure | undefined },
): Promise<CursorRunRequest> {
  const blobStore = state.blobStore;
  const systemPromptIds = buildCursorSystemPromptJsons(context.systemPrompt).map((json) =>
    storeCursorBlob(blobStore, new TextEncoder().encode(json)),
  );

  const activeUserMessageIndex = context.messages.length - 1;
  const activeMessage = context.messages[activeUserMessageIndex];
  const activeUserMessage = activeMessage?.role === "user" ? activeMessage : undefined;
  let userContent: UserContent | undefined;
  let userText = "";
  let hasUserImages = false;
  if (activeUserMessage !== undefined) {
    userContent = activeUserMessage.content;
    if (typeof userContent === "string") {
      userText = userContent.trim();
    } else {
      userText = extractText(userContent);
      hasUserImages = userContent.some((item) => item.type === "image");
    }
  }

  const action = create(ConversationActionSchema, {
    action:
      userContent !== undefined && (userText.trim().length > 0 || hasUserImages)
        ? {
            case: "userMessageAction",
            value: create(UserMessageActionSchema, { userMessage: createCursorUserMessage(userContent, userText) }),
          }
        : { case: "resumeAction", value: create(ResumeActionSchema, {}) },
  });

  const activeIndex = activeUserMessage ? activeUserMessageIndex : -1;
  const turns = buildConversationTurns(context.messages, blobStore, activeIndex);
  const rootPromptMessagesJson = buildRootPromptMessagesJson(context.messages, systemPromptIds, blobStore, activeIndex);

  const cachedPromptHead = state.conversationState?.rootPromptMessagesJson?.slice(0, systemPromptIds.length) ?? [];
  const hasMatchingPrompt =
    cachedPromptHead.length === systemPromptIds.length &&
    systemPromptIds.every((id, idx) => Buffer.from(cachedPromptHead[idx]!).equals(id));
  const baseState =
    state.conversationState && hasMatchingPrompt
      ? state.conversationState
      : create(ConversationStateStructureSchema, {
          rootPromptMessagesJson: systemPromptIds,
          turns: [],
          todos: [],
          pendingToolCalls: [],
          previousWorkspaceUris: [],
          fileStates: {},
          fileStatesV2: {},
          summaryArchives: [],
          turnTimings: [],
          subagentStates: {},
          selfSummaryCount: 0,
          readPaths: [],
        });
  const conversationState = create(ConversationStateStructureSchema, { ...baseState, rootPromptMessagesJson, turns });

  const { modelId: wireModelId, parameters } = resolveCursorWireModel(model.id);
  const modelDetails = create(ModelDetailsSchema, { modelId: wireModelId, displayModelId: model.id, displayName: model.name });
  const requestedModel = create(RequestedModelSchema, { modelId: wireModelId, maxMode: false, parameters });

  let runRequest: unknown = create(AgentRunRequestSchema, {
    conversationState,
    action,
    modelDetails,
    requestedModel,
    conversationId: state.conversationId,
  });
  const replaced = await options?.onPayload?.(runRequest, model);
  if (replaced !== undefined) runRequest = replaced;

  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "runRequest", value: runRequest as ReturnType<typeof AgentRunRequestSchema.create> },
  });
  return { requestBytes: toBinary(AgentClientMessageSchema, clientMessage), conversationState };
}

// ---------------------------------------------------------------------------
// Answers the client writes (KV, exec, interaction queries)
// ---------------------------------------------------------------------------

/** The one method of an HTTP/2 client stream the answers need. */
export interface FrameWriter {
  write(chunk: Uint8Array): unknown;
}

function writeClientMessage(writer: FrameWriter, message: Parameters<typeof AgentClientMessageSchema.encode>[0]): void {
  writer.write(frameConnectMessage(toBinary(AgentClientMessageSchema, message)));
}

/** Serve and store blobs by their hex id. */
export function handleKvServerMessage(kvMsg: KvServerMessage, blobStore: Map<string, Uint8Array>, writer: FrameWriter): void {
  const kvCase = kvMsg.message.case;
  if (kvCase === "getBlobArgs") {
    const blobData = blobStore.get(Buffer.from(kvMsg.message.value.blobId).toString("hex"));
    const response = create(KvClientMessageSchema, {
      id: kvMsg.id,
      message: { case: "getBlobResult", value: create(GetBlobResultSchema, blobData ? { blobData } : {}) },
    });
    writeClientMessage(writer, create(AgentClientMessageSchema, { message: { case: "kvClientMessage", value: response } }));
  } else if (kvCase === "setBlobArgs") {
    const { blobId, blobData } = kvMsg.message.value;
    blobStore.set(Buffer.from(blobId).toString("hex"), blobData);
    const response = create(KvClientMessageSchema, {
      id: kvMsg.id,
      message: { case: "setBlobResult", value: create(SetBlobResultSchema, {}) },
    });
    writeClientMessage(writer, create(AgentClientMessageSchema, { message: { case: "kvClientMessage", value: response } }));
  }
}

function sendExecClientMessage<TCase extends NonNullable<ExecClientMessage["message"]["case"]>>(
  writer: FrameWriter,
  execMsg: ExecServerMessage,
  messageCase: TCase,
  value: Extract<ExecClientMessage["message"], { case: TCase }>["value"],
): void {
  const execClientMessage = create(ExecClientMessageSchema, {
    id: execMsg.id,
    execId: execMsg.execId,
    message: { case: messageCase, value } as ExecClientMessage["message"],
  });
  writeClientMessage(writer, create(AgentClientMessageSchema, { message: { case: "execClientMessage", value: execClientMessage } }));
}

function sendExecClientStreamClose(writer: FrameWriter, execMsg: ExecServerMessage): void {
  const closeMessage = create(ExecClientControlMessageSchema, {
    message: { case: "streamClose", value: create(ExecClientStreamCloseSchema, { id: execMsg.id }) },
  });
  writeClientMessage(writer, create(AgentClientMessageSchema, { message: { case: "execClientControlMessage", value: closeMessage } }));
}

function sendExecClientThrow(writer: FrameWriter, execMsg: ExecServerMessage, error: string, errorCode: string): void {
  const controlMessage = create(ExecClientControlMessageSchema, {
    message: { case: "throw", value: create(ExecClientThrowSchema, { id: execMsg.id, error, errorCode }) },
  });
  writeClientMessage(writer, create(AgentClientMessageSchema, { message: { case: "execClientControlMessage", value: controlMessage } }));
  sendExecClientStreamClose(writer, execMsg);
}

function sendShellStreamEvent(writer: FrameWriter, execMsg: ExecServerMessage, event: ShellStream["event"]): void {
  sendExecClientMessage(writer, execMsg, "shellStream", create(ShellStreamSchema, { event }));
}

function buildShellRejectedResult(command: string, workingDirectory: string, reason: string): ShellResult {
  return create(ShellResultSchema, {
    result: {
      case: "rejected",
      value: create(ShellRejectedSchema, { command, workingDirectory, reason, isReadonly: false }),
    },
  });
}

function buildMcpStateResult(tools: McpToolDefinition[], serverIdentifiers: readonly string[]): McpStateExecResult {
  const byProvider = new Map<string, McpToolDefinition[]>();
  for (const tool of tools) {
    const existing = byProvider.get(tool.providerIdentifier);
    if (existing) existing.push(tool);
    else byProvider.set(tool.providerIdentifier, [tool]);
  }
  const wanted = serverIdentifiers.length > 0 ? new Set(serverIdentifiers) : undefined;
  const servers = [];
  for (const [identifier, serverTools] of byProvider) {
    if (wanted && !wanted.has(identifier)) continue;
    servers.push(
      create(McpStateServerSchema, { serverName: identifier, serverIdentifier: identifier, tools: serverTools, status: "connected" }),
    );
  }
  return create(McpStateExecResultSchema, { result: { case: "success", value: create(McpStateSuccessSchema, { servers }) } });
}

/** The matching response case, every field unset. */
function buildNeutralHookResult(request: ExecuteHookRequest | undefined): ExecuteHookResult | null {
  let response: ExecuteHookResponse;
  switch (request?.request.case) {
    case "preCompact":
      response = create(ExecuteHookResponseSchema, { response: { case: "preCompact", value: create(PreCompactRequestResponseSchema, {}) } });
      break;
    case "subagentStart":
      response = create(ExecuteHookResponseSchema, { response: { case: "subagentStart", value: create(SubagentStartRequestResponseSchema, {}) } });
      break;
    case "subagentStop":
      response = create(ExecuteHookResponseSchema, { response: { case: "subagentStop", value: create(SubagentStopRequestResponseSchema, {}) } });
      break;
    case "preToolUse":
      response = create(ExecuteHookResponseSchema, { response: { case: "preToolUse", value: create(PreToolUseRequestResponseSchema, {}) } });
      break;
    case "postToolUse":
      response = create(ExecuteHookResponseSchema, { response: { case: "postToolUse", value: create(PostToolUseRequestResponseSchema, {}) } });
      break;
    case "postToolUseFailure":
      response = create(ExecuteHookResponseSchema, {
        response: { case: "postToolUseFailure", value: create(PostToolUseFailureRequestResponseSchema, {}) },
      });
      break;
    case "beforeSubmitPrompt":
      response = create(ExecuteHookResponseSchema, {
        response: { case: "beforeSubmitPrompt", value: create(BeforeSubmitPromptRequestResponseSchema, {}) },
      });
      break;
    case "afterAgentResponse":
      response = create(ExecuteHookResponseSchema, {
        response: { case: "afterAgentResponse", value: create(AfterAgentResponseRequestResponseSchema, {}) },
      });
      break;
    case "afterAgentThought":
      response = create(ExecuteHookResponseSchema, {
        response: { case: "afterAgentThought", value: create(AfterAgentThoughtRequestResponseSchema, {}) },
      });
      break;
    case "stop":
      response = create(ExecuteHookResponseSchema, { response: { case: "stop", value: create(StopRequestResponseSchema, {}) } });
      break;
    default:
      return null;
  }
  return create(ExecuteHookResultSchema, { response });
}

function decodeMcpArgValue(value: Uint8Array): unknown {
  try {
    const jsonValue = decodeJsonValue(value);
    if (typeof jsonValue === "string") {
      const first = jsonValue.trimStart()[0];
      return first === "{" || first === "[" || first === '"' ? parseToolArgsJson(jsonValue) : jsonValue;
    }
    return jsonValue;
  } catch {
    // Not a google.protobuf.Value; fall through to text.
  }
  return parseToolArgsJson(new TextDecoder().decode(value));
}

function parseToolArgsJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return text;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return text;
  }
}

function decodeMcpArgsMap(args: Record<string, Uint8Array> | undefined): Record<string, unknown> | undefined {
  if (!args) return undefined;
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) decoded[key] = decodeMcpArgValue(value);
  return decoded;
}

/** Completion wins, except a string that downgraded a streamed structure. */
export function mergeCursorMcpToolCallArgs(
  streamed: Record<string, unknown> | undefined,
  completion: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...streamed };
  if (!completion) return merged;
  for (const [key, completionValue] of Object.entries(completion)) {
    const streamedValue = merged[key];
    if (typeof completionValue === "string" && streamedValue !== null && typeof streamedValue === "object") continue;
    merged[key] = completionValue;
  }
  return merged;
}

function buildMcpExternalHandoffResult() {
  return create(McpResultSchema, {
    result: {
      case: "success",
      value: create(McpSuccessSchema, {
        content: [
          create(McpToolResultContentItemSchema, {
            content: { case: "text", value: create(McpTextContentSchema, { text: MCP_EXTERNAL_HANDOFF_MESSAGE }) },
          }),
        ],
        isError: false,
      }),
    },
  });
}

// ---------------------------------------------------------------------------
// Stream state
// ---------------------------------------------------------------------------

interface OpenToolCall {
  block: ToolCall;
  envelopeId: string | undefined;
  argsText: string;
}

export interface CursorTurnState {
  output: AssistantMessage;
  stream: CcaEventStream;
  started: boolean;
  text: TextContent | null;
  thinking: ThinkingContent | null;
  /** Open MCP blocks keyed by the interaction envelope's `call_id`. */
  openToolCalls: Map<string, OpenToolCall>;
  /** The fallback for frames without a `call_id`. */
  current: OpenToolCall | null;
  /** MCP ids surfaced from an exec frame before (or without) their streamed block. */
  resolvedMcpToolCallIds: Set<string>;
}

function ensureStarted(state: CursorTurnState): void {
  if (state.started) return;
  state.started = true;
  state.stream.push({ type: "start", partial: state.output });
}

function endCurrentTextBlock(state: CursorTurnState): void {
  const block = state.text;
  if (!block) return;
  state.stream.push({ type: "text_end", contentIndex: state.output.content.indexOf(block), content: block.text, partial: state.output });
  state.text = null;
}

function endCurrentThinkingBlock(state: CursorTurnState): void {
  const block = state.thinking;
  if (!block) return;
  state.stream.push({
    type: "thinking_end",
    contentIndex: state.output.content.indexOf(block),
    content: block.thinking,
    partial: state.output,
  });
  state.thinking = null;
}

function parseArgsText(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function closeToolCall(state: CursorTurnState, open: OpenToolCall): void {
  if (open.envelopeId) state.openToolCalls.delete(open.envelopeId);
  if (state.current === open) state.current = null;
  const idx = state.output.content.indexOf(open.block);
  state.stream.push({ type: "toolcall_end", contentIndex: idx, toolCall: open.block, partial: state.output });
}

function flushOpenToolCalls(state: CursorTurnState): void {
  const open = new Set<OpenToolCall>(state.openToolCalls.values());
  if (state.current) open.add(state.current);
  for (const call of open) {
    const parsed = parseArgsText(call.argsText);
    if (parsed !== undefined) call.block.arguments = parsed;
    closeToolCall(state, call);
  }
  state.openToolCalls.clear();
  state.current = null;
}

function resolveStreamedCall(state: CursorTurnState, envelopeId: string | undefined): OpenToolCall | null {
  if (!envelopeId) return state.current;
  const keyed = state.openToolCalls.get(envelopeId);
  if (keyed) return keyed;
  const current = state.current;
  return current && current.envelopeId === undefined ? current : null;
}

function mcpCallOf(toolCall: ProtoToolCall | undefined): { args?: McpArgs } | undefined {
  const oneof = toolCall?.tool;
  return oneof?.case === "mcpToolCall" ? oneof.value : undefined;
}

function openMcpBlock(state: CursorTurnState, id: string, name: string, args: Record<string, unknown>, envelopeId: string | undefined): OpenToolCall {
  endCurrentTextBlock(state);
  endCurrentThinkingBlock(state);
  const block: ToolCall = { type: "toolCall", id, name, arguments: args };
  state.output.content.push(block);
  ensureStarted(state);
  const open: OpenToolCall = { block, envelopeId, argsText: "" };
  if (envelopeId) state.openToolCalls.set(envelopeId, open);
  state.current = open;
  state.stream.push({ type: "toolcall_start", contentIndex: state.output.content.length - 1, partial: state.output });
  return open;
}

export function processInteractionUpdate(update: AgentServerMessage["message"] & { case: "interactionUpdate" }, state: CursorTurnState): void {
  const message = update.value.message;
  const { output, stream } = state;
  switch (message.case) {
    case "textDelta": {
      const delta = message.value.text || "";
      if (!state.text) {
        endCurrentThinkingBlock(state);
        const block: TextContent = { type: "text", text: "" };
        output.content.push(block);
        state.text = block;
        ensureStarted(state);
        stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
      }
      state.text!.text += delta;
      stream.push({ type: "text_delta", contentIndex: output.content.indexOf(state.text!), delta, partial: output });
      return;
    }
    case "thinkingDelta": {
      const delta = message.value.text || "";
      if (!state.thinking) {
        endCurrentTextBlock(state);
        const block: ThinkingContent = { type: "thinking", thinking: "" };
        output.content.push(block);
        state.thinking = block;
        ensureStarted(state);
        stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
      }
      state.thinking!.thinking += delta;
      stream.push({ type: "thinking_delta", contentIndex: output.content.indexOf(state.thinking!), delta, partial: output });
      return;
    }
    case "thinkingCompleted":
      endCurrentThinkingBlock(state);
      return;
    case "toolCallStarted": {
      endCurrentTextBlock(state);
      endCurrentThinkingBlock(state);
      const envelopeId = message.value.callId || undefined;
      const mcp = mcpCallOf(message.value.toolCall);
      if (!mcp) {
        // A server-side or exec-owned call (todo, connect-SCM, web fetch, edit,
        // a native exec announcement). No block: Pi would run a tool of that
        // name. The fallback slot is cleared so its completion cannot settle an
        // unrelated MCP block.
        state.current = null;
        return;
      }
      const args = mcp.args;
      const id = args?.toolCallId || randomUUID();
      if (state.resolvedMcpToolCallIds.delete(id) && output.content.some((b) => b.type === "toolCall" && b.id === id)) return;
      openMcpBlock(state, id, args?.toolName || args?.name || "", decodeMcpArgsMap(args?.args) ?? {}, envelopeId);
      return;
    }
    case "partialToolCall": {
      const target = resolveStreamedCall(state, message.value.callId || undefined);
      if (!target) return;
      // `args_text_delta` is the aggregated args text so far: strip what is already held.
      const snapshot = message.value.argsTextDelta || "";
      const chunk = snapshot.startsWith(target.argsText) ? snapshot.slice(target.argsText.length) : snapshot;
      if (chunk.length === 0) return;
      target.argsText += chunk;
      stream.push({ type: "toolcall_delta", contentIndex: output.content.indexOf(target.block), delta: chunk, partial: output });
      return;
    }
    case "toolCallCompleted": {
      const settled = resolveStreamedCall(state, message.value.callId || undefined);
      if (!settled) return;
      const streamed = parseArgsText(settled.argsText) ?? settled.block.arguments;
      settled.block.arguments = mergeCursorMcpToolCallArgs(streamed, decodeMcpArgsMap(mcpCallOf(message.value.toolCall)?.args?.args));
      closeToolCall(state, settled);
      return;
    }
    case "turnEnded":
      output.stopReason = "stop";
      return;
    case "tokenDelta":
      output.usage.output += message.value.tokens || 0;
      output.usage.totalTokens = output.usage.input + output.usage.output;
      return;
    default:
      // heartbeat, userMessageAppended, summaries, shell output, steps: nothing to show.
      return;
  }
}

export function handleInteractionQuery(query: InteractionQuery, writer: FrameWriter): void {
  const send = (result: Exclude<InteractionResponse["result"], { case: undefined }>): void => {
    const response = create(InteractionResponseSchema, { id: query.id, result });
    writeClientMessage(writer, create(AgentClientMessageSchema, { message: { case: "interactionResponse", value: response } }));
  };
  switch (query.query.case) {
    case "webSearchRequestQuery":
      send({
        case: "webSearchRequestResponse",
        value: create(WebSearchRequestResponseSchema, {
          result: { case: "rejected", value: create(WebSearchRequestResponse_RejectedSchema, { reason: HOSTED_TOOL_REJECTED }) },
        }),
      });
      return;
    case "exaSearchRequestQuery":
      send({
        case: "exaSearchRequestResponse",
        value: create(ExaSearchRequestResponseSchema, {
          result: { case: "rejected", value: create(ExaSearchRequestResponse_RejectedSchema, { reason: HOSTED_TOOL_REJECTED }) },
        }),
      });
      return;
    case "exaFetchRequestQuery":
      send({
        case: "exaFetchRequestResponse",
        value: create(ExaFetchRequestResponseSchema, {
          result: { case: "rejected", value: create(ExaFetchRequestResponse_RejectedSchema, { reason: HOSTED_TOOL_REJECTED }) },
        }),
      });
      return;
    case "webFetchRequestQuery":
      send({
        case: "webFetchRequestResponse",
        value: create(WebFetchRequestResponseSchema, {
          result: { case: "rejected", value: create(WebFetchRequestResponse_RejectedSchema, { reason: HOSTED_TOOL_REJECTED }) },
        }),
      });
      return;
    case "askQuestionInteractionQuery":
      send({
        case: "askQuestionInteractionResponse",
        value: create(AskQuestionInteractionResponseSchema, {
          result: create(AskQuestionResultSchema, {
            result: {
              case: "rejected",
              value: create(AskQuestionRejectedSchema, { reason: `Interactive questions are ${NOT_IMPLEMENTED_SUFFIX}` }),
            },
          }),
        }),
      });
      return;
    case "switchModeRequestQuery":
      send({
        case: "switchModeRequestResponse",
        value: create(SwitchModeRequestResponseSchema, {
          result: {
            case: "rejected",
            value: create(SwitchModeRequestResponse_RejectedSchema, { reason: `Mode switches are ${NOT_IMPLEMENTED_SUFFIX}` }),
          },
        }),
      });
      return;
    case "createPlanRequestQuery":
      send({
        case: "createPlanRequestResponse",
        value: create(CreatePlanRequestResponseSchema, {
          result: create(CreatePlanResultSchema, {
            result: { case: "error", value: create(CreatePlanErrorSchema, { error: `Plan files are ${NOT_IMPLEMENTED_SUFFIX}` }) },
          }),
        }),
      });
      return;
    default:
      // setupVmEnvironmentArgs has a success-only result, and an unnamed
      // variant cannot be answered without approving it: both stay unanswered,
      //.
      return;
  }
}

/**
 * Answers every exec frame with no exec handler installed (plan D4): each frame
 * gets its rejected or error result. Only `mcpArgs` reaches Pi.
 */
export function handleExecServerMessage(
  execMsg: ExecServerMessage,
  writer: FrameWriter,
  requestContextTools: McpToolDefinition[],
  requestContextRules: CursorRule[],
  state: CursorTurnState,
): void {
  const m = execMsg.message;
  switch (m.case) {
    case undefined:
      sendExecClientThrow(writer, execMsg, "Unknown exec message variant", "unknown_exec_variant");
      return;
    case "requestContextArgs": {
      const requestContext = create(RequestContextSchema, {
        rules: requestContextRules,
        repositoryInfo: [],
        tools: requestContextTools,
        gitRepos: [],
        projectLayouts: [],
        mcpInstructions: [],
        fileContents: {},
        customSubagents: [],
      });
      sendExecClientMessage(
        writer,
        execMsg,
        "requestContextResult",
        create(RequestContextResultSchema, {
          result: { case: "success", value: create(RequestContextSuccessSchema, { requestContext }) },
        }),
      );
      return;
    }
    case "readArgs":
      sendExecClientMessage(writer, execMsg, "readResult", create(ReadResultSchema, {
        result: { case: "rejected", value: create(ReadRejectedSchema, { path: m.value.path, reason: TOOL_NOT_AVAILABLE }) },
      }));
      return;
    case "lsArgs":
      sendExecClientMessage(writer, execMsg, "lsResult", create(LsResultSchema, {
        result: { case: "rejected", value: create(LsRejectedSchema, { path: m.value.path, reason: TOOL_NOT_AVAILABLE }) },
      }));
      return;
    case "grepArgs":
      // Grep has no rejected variant: an error result answers a refusal.
      sendExecClientMessage(writer, execMsg, "grepResult", create(GrepResultSchema, {
        result: { case: "error", value: create(GrepErrorSchema, { error: TOOL_NOT_AVAILABLE }) },
      }));
      return;
    case "writeArgs":
      sendExecClientMessage(writer, execMsg, "writeResult", create(WriteResultSchema, {
        result: { case: "rejected", value: create(WriteRejectedSchema, { path: m.value.path, reason: TOOL_NOT_AVAILABLE }) },
      }));
      return;
    case "deleteArgs":
      sendExecClientMessage(writer, execMsg, "deleteResult", create(DeleteResultSchema, {
        result: { case: "rejected", value: create(DeleteRejectedSchema, { path: m.value.path, reason: TOOL_NOT_AVAILABLE }) },
      }));
      return;
    case "shellArgs":
    case "miniSweAgentBashArgs": {
      const args: ShellArgs = m.value;
      const result = buildShellRejectedResult(args.command, args.workingDirectory, TOOL_NOT_AVAILABLE);
      sendExecClientMessage(writer, execMsg, m.case === "shellArgs" ? "shellResult" : "miniSweAgentBashResult", result);
      return;
    }
    case "shellStreamArgs": {
      // With no handler: start, the rejection,
      // exit 1, the structured result, then close the exec stream.
      const args = m.value;
      const result = buildShellRejectedResult(args.command, args.workingDirectory, TOOL_NOT_AVAILABLE);
      sendShellStreamEvent(writer, execMsg, { case: "start", value: create(ShellStreamStartSchema, {}) });
      if (result.result.case === "rejected") {
        sendShellStreamEvent(writer, execMsg, { case: "rejected", value: result.result.value });
      }
      sendShellStreamEvent(writer, execMsg, {
        case: "exit",
        value: create(ShellStreamExitSchema, { code: 1, cwd: args.workingDirectory, aborted: false }),
      });
      sendExecClientMessage(writer, execMsg, "shellResult", result);
      sendExecClientStreamClose(writer, execMsg);
      return;
    }
    case "backgroundShellSpawnArgs":
      sendExecClientMessage(writer, execMsg, "backgroundShellSpawnResult", create(BackgroundShellSpawnResultSchema, {
        result: {
          case: "rejected",
          value: create(ShellRejectedSchema, {
            command: m.value.command,
            workingDirectory: m.value.workingDirectory,
            reason: "Not implemented",
            isReadonly: false,
          }),
        },
      }));
      return;
    case "writeShellStdinArgs":
      sendExecClientMessage(writer, execMsg, "writeShellStdinResult", create(WriteShellStdinResultSchema, {
        result: { case: "error", value: create(WriteShellStdinErrorSchema, { error: "Not implemented" }) },
      }));
      return;
    case "fetchArgs":
      sendExecClientMessage(writer, execMsg, "fetchResult", create(FetchResultSchema, {
        result: { case: "error", value: create(FetchErrorSchema, { url: m.value.url, error: "Not implemented" }) },
      }));
      return;
    case "diagnosticsArgs":
      sendExecClientMessage(writer, execMsg, "diagnosticsResult", create(DiagnosticsResultSchema, {
        result: { case: "rejected", value: create(DiagnosticsRejectedSchema, { path: m.value.path, reason: TOOL_NOT_AVAILABLE }) },
      }));
      return;
    case "mcpArgs": {
      const args = m.value;
      if (args.smartModeApprovalOnly) {
        // An approval probe with no handler to decide it: refused, nothing surfaced.
        sendExecClientMessage(writer, execMsg, "mcpResult", create(McpResultSchema, {
          result: {
            case: "rejected",
            value: create(McpRejectedSchema, {
              reason: `Tool "${args.toolName || args.name}" is not approved to run without asking.`,
            }),
          },
        }));
        return;
      }
      // Surface the call to Pi if the interaction stream has not already.
      const id = args.toolCallId;
      if (id && !state.output.content.some((b) => b.type === "toolCall" && b.id === id)) {
        const open = openMcpBlock(state, id, args.toolName || args.name, decodeMcpArgsMap(args.args) ?? {}, undefined);
        closeToolCall(state, open);
        state.resolvedMcpToolCallIds.add(id);
      }
      sendExecClientMessage(writer, execMsg, "mcpResult", buildMcpExternalHandoffResult());
      return;
    }
    case "listMcpResourcesExecArgs":
      sendExecClientMessage(writer, execMsg, "listMcpResourcesExecResult", create(ListMcpResourcesExecResultSchema, {
        result: { case: "success", value: create(ListMcpResourcesSuccessSchema, { resources: [] }) },
      }));
      return;
    case "readMcpResourceExecArgs":
      sendExecClientMessage(writer, execMsg, "readMcpResourceExecResult", create(ReadMcpResourceExecResultSchema, {
        result: { case: "notFound", value: create(ReadMcpResourceNotFoundSchema, { uri: m.value.uri }) },
      }));
      return;
    case "recordScreenArgs":
      sendExecClientMessage(writer, execMsg, "recordScreenResult", create(RecordScreenResultSchema, {
        result: { case: "failure", value: create(RecordScreenFailureSchema, { error: NOT_IMPLEMENTED }) },
      }));
      return;
    case "computerUseArgs":
      sendExecClientMessage(writer, execMsg, "computerUseResult", create(ComputerUseResultSchema, {
        result: { case: "error", value: create(ComputerUseErrorSchema, { error: NOT_IMPLEMENTED }) },
      }));
      return;
    case "piReadArgs":
      sendExecClientMessage(writer, execMsg, "piReadResult", create(PiReadExecResultSchema, {
        result: { case: "error", value: create(PiReadExecErrorSchema, { error: TOOL_NOT_AVAILABLE }) },
      }));
      return;
    case "piBashArgs":
      sendExecClientMessage(writer, execMsg, "piBashResult", create(PiBashExecResultSchema, {
        result: { case: "error", value: create(PiBashExecErrorSchema, { error: TOOL_NOT_AVAILABLE }) },
      }));
      return;
    case "piEditArgs":
      sendExecClientMessage(writer, execMsg, "piEditResult", create(PiEditExecResultSchema, {
        result: { case: "rejected", value: create(PiEditExecRejectedSchema, { reason: TOOL_NOT_AVAILABLE }) },
      }));
      return;
    case "piWriteArgs":
      sendExecClientMessage(writer, execMsg, "piWriteResult", create(PiWriteExecResultSchema, {
        result: { case: "rejected", value: create(PiWriteExecRejectedSchema, { reason: TOOL_NOT_AVAILABLE }) },
      }));
      return;
    case "piGrepArgs":
      sendExecClientMessage(writer, execMsg, "piGrepResult", create(PiGrepExecResultSchema, {
        result: { case: "error", value: create(PiGrepExecErrorSchema, { error: TOOL_NOT_AVAILABLE }) },
      }));
      return;
    case "piFindArgs":
      sendExecClientMessage(writer, execMsg, "piFindResult", create(PiFindExecResultSchema, {
        result: { case: "error", value: create(PiFindExecErrorSchema, { error: TOOL_NOT_AVAILABLE }) },
      }));
      return;
    case "piLsArgs":
      sendExecClientMessage(writer, execMsg, "piLsResult", create(PiLsExecResultSchema, {
        result: { case: "error", value: create(PiLsExecErrorSchema, { error: TOOL_NOT_AVAILABLE }) },
      }));
      return;
    case "redactedReadArgs":
      sendExecClientMessage(writer, execMsg, "redactedReadResult", create(ReadResultSchema, {
        result: {
          case: "error",
          value: create(ReadErrorSchema, { path: m.value.path, error: "Secret redaction is not implemented by this client" }),
        },
      }));
      return;
    case "mcpStateExecArgs":
      sendExecClientMessage(writer, execMsg, "mcpStateExecResult", buildMcpStateResult(requestContextTools, m.value.serverIdentifiers));
      return;
    case "executeHookArgs": {
      const result = buildNeutralHookResult(m.value.request);
      if (!result) {
        sendExecClientThrow(writer, execMsg, `Unsupported hook request: ${m.value.request?.request.case ?? "unset"}`, "unknown_hook_request");
        return;
      }
      sendExecClientMessage(writer, execMsg, "executeHookResult", result);
      return;
    }
    case "subagentArgs":
      sendExecClientMessage(writer, execMsg, "subagentResult", create(SubagentResultSchema, {
        result: { case: "error", value: create(SubagentErrorSchema, { error: `Subagents are ${NOT_IMPLEMENTED_SUFFIX}` }) },
      }));
      return;
    case "subagentAwaitArgs":
      sendExecClientMessage(writer, execMsg, "subagentAwaitResult", create(SubagentAwaitResultSchema, {
        result: { case: "notFound", value: create(SubagentAwaitNotFoundSchema, { agentId: m.value.agentId }) },
      }));
      return;
    case "forceBackgroundShellArgs":
      sendExecClientMessage(writer, execMsg, "forceBackgroundShellResult", create(ForceBackgroundShellResultSchema, {
        status: ForceBackgroundShellStatus.NOT_FOUND,
      }));
      return;
    case "forceBackgroundSubagentArgs":
      sendExecClientMessage(writer, execMsg, "forceBackgroundSubagentResult", create(ForceBackgroundSubagentResultSchema, {
        status: ForceBackgroundSubagentStatus.NOT_FOUND,
      }));
      return;
    case "smartModeClassifierArgs":
      sendExecClientMessage(writer, execMsg, "smartModeClassifierResult", create(SmartModeClassifierResultSchema, {
        result: {
          case: "error",
          value: create(SmartModeClassifierErrorSchema, { error: `Smart-mode classification is ${NOT_IMPLEMENTED_SUFFIX}` }),
        },
      }));
      return;
    case "canvasDiagnosticsArgs":
      sendExecClientMessage(writer, execMsg, "canvasDiagnosticsResult", create(CanvasDiagnosticsResultSchema, {
        result: {
          case: "error",
          value: create(CanvasDiagnosticsErrorSchema, { path: m.value.path, error: `Canvas diagnostics are ${NOT_IMPLEMENTED_SUFFIX}` }),
        },
      }));
      return;
    case "shellAllowlistPrecheckArgs":
      sendExecClientMessage(writer, execMsg, "shellAllowlistPrecheckResult", create(ShellAllowlistPrecheckResultSchema, { allowlisted: false }));
      return;
    case "mcpAllowlistPrecheckArgs":
      sendExecClientMessage(writer, execMsg, "mcpAllowlistPrecheckResult", create(McpAllowlistPrecheckResultSchema, { allowlisted: false }));
      return;
    case "webFetchAllowlistPrecheckArgs":
      sendExecClientMessage(writer, execMsg, "webFetchAllowlistPrecheckResult", create(WebFetchAllowlistPrecheckResultSchema, { allowlisted: false }));
      return;
    case "conversationSearchArgs":
      sendExecClientMessage(writer, execMsg, "conversationSearchResult", create(ConversationSearchResultSchema, {
        result: { case: "error", value: create(ConversationSearchErrorSchema, { error: `Conversation search is ${NOT_IMPLEMENTED_SUFFIX}` }) },
      }));
      return;
    case "agentStoreConflictArgs":
      sendExecClientMessage(writer, execMsg, "agentStoreConflictResult", create(AgentStoreConflictResultSchema, {
        result: { case: "error", value: create(AgentStoreConflictErrorSchema, { error: `Agent store conflicts are ${NOT_IMPLEMENTED_SUFFIX}` }) },
      }));
      return;
    case "gitDiffRequest":
      sendExecClientThrow(writer, execMsg, `Git diff is ${NOT_IMPLEMENTED_SUFFIX}`, "exec_variant_unsupported");
      return;
    default:
      sendExecClientThrow(writer, execMsg, `No handler for exec message of type ${(m as { case: string }).case}`, "exec_variant_unsupported");
  }
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

export interface CursorStreamDeps {
  /** Opens the HTTP/2 session. Defaults to `http2.connect(baseUrl)`; tests connect over h2c. */
  connect?: (baseUrl: string) => http2.ClientHttp2Session;
  /** Heartbeat interval. */
  heartbeatMs?: number;
}

function emptyUsage(): AssistantMessage["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

async function run(
  stream: CcaEventStream,
  model: PiModel,
  context: PiContext,
  options: PiSimpleStreamOptions | undefined,
  deps: CursorStreamDeps,
): Promise<void> {
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const state: CursorTurnState = {
    output,
    stream,
    started: false,
    text: null,
    thinking: null,
    openToolCalls: new Map(),
    current: null,
    resolvedMcpToolCallIds: new Set(),
  };
  const signal = options?.signal;
  let h2Client: http2.ClientHttp2Session | null = null;
  let h2Request: http2.ClientHttp2Stream | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let onAbort: (() => void) | undefined;

  try {
    const apiKey = options?.apiKey;
    if (!apiKey) throw new Error(`Cursor requires an access token. Run \`lykos login ${model.provider}\`.`);
    if (signal?.aborted) throw new Error("Request was aborted");

    const conversationId = options?.sessionId ?? randomUUID();
    const blobStore = conversationBlobStores.get(conversationId) ?? new Map<string, Uint8Array>();
    conversationBlobStores.set(conversationId, blobStore);
    const { requestBytes, conversationState } = await buildCursorRunRequest(model, context, options, {
      conversationId,
      blobStore,
      conversationState: conversationStateCache.get(conversationId),
    });
    conversationStateCache.set(conversationId, conversationState);
    const requestContextTools = buildMcpToolDefinitions(context.tools);
    const requestContextRules = buildCursorRequestContextRules(context.systemPrompt);

    const baseUrl = (model.baseUrl?.trim() || CURSOR_API_URL).replace(/\/+$/, "");
    const requestHeaders: http2.OutgoingHttpHeaders = {
      ...sanitizeCursorCallerHeaders(
        Object.fromEntries(Object.entries(options?.headers ?? {}).filter((e): e is [string, string] => typeof e[1] === "string")),
      ),
      ":method": "POST",
      ":path": CURSOR_RUN_PATH,
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
      te: "trailers",
      authorization: `Bearer ${apiKey}`,
      "x-ghost-mode": "true",
      "x-cursor-client-version": CURSOR_CLIENT_VERSION,
      "x-cursor-client-type": "cli",
      "x-request-id": randomUUID(),
    };

    let settled = false;
    let sawTurnEnded = false;
    let endStreamError: Error | null = null;
    let httpStatus: number | undefined;
    const errorBody: Buffer[] = [];
    let resolveDone!: () => void;
    let rejectDone!: (e: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const settle = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      if (error !== undefined) return rejectDone(error);
      if (httpStatus !== undefined && httpStatus !== 200) {
        const body = Buffer.concat(errorBody).toString("utf8").trim();
        return rejectDone(new Error(`Cursor API error: ${httpStatus} ${truncate(body, 500)}`.trim()));
      }
      if (endStreamError) return rejectDone(endStreamError);
      if (!sawTurnEnded) return rejectDone(new Error("Cursor stream ended before turnEnded"));
      resolveDone();
    };

    h2Client = deps.connect ? deps.connect(baseUrl) : http2.connect(baseUrl);
    h2Client.on("error", (error) => settle(mapH2TransportError(error, baseUrl)));
    const request = h2Client.request(requestHeaders);
    h2Request = request;

    request.on("response", (headers) => {
      const status = Number(headers[":status"]);
      if (Number.isFinite(status)) httpStatus = status;
    });

    let pending: Buffer = Buffer.alloc(0);
    request.on("data", (chunk: Buffer) => {
      if (httpStatus !== undefined && httpStatus !== 200) {
        errorBody.push(chunk);
        return;
      }
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        const flags = pending[0]!;
        const length = pending.readUInt32BE(1);
        if (pending.length < 5 + length) break;
        const body = pending.subarray(5, 5 + length);
        pending = pending.subarray(5 + length);

        if (flags & CONNECT_END_STREAM_FLAG) {
          const endError = parseConnectEndStream(body);
          if (endError) {
            endStreamError = endError;
            request.close();
          }
          continue;
        }

        let message: AgentServerMessage;
        try {
          message = fromBinary(AgentServerMessageSchema, body);
        } catch {
          continue; // An undecodable frame is skipped.
        }
        const m = message.message;
        if (m.case === "interactionUpdate") {
          processInteractionUpdate(m, state);
          if (m.value.message.case === "turnEnded") sawTurnEnded = true;
        } else if (m.case === "kvServerMessage") {
          handleKvServerMessage(m.value, blobStore, request);
        } else if (m.case === "execServerMessage") {
          handleExecServerMessage(m.value, request, requestContextTools, requestContextRules, state);
        } else if (m.case === "interactionQuery") {
          handleInteractionQuery(m.value, request);
        } else if (m.case === "conversationCheckpointUpdate") {
          conversationStateCache.set(conversationId, m.value);
        }
      }
    });

    request.on("trailers", (trailers) => {
      const status = trailers["grpc-status"];
      const msg = trailers["grpc-message"];
      if (status && status !== "0" && !endStreamError) {
        endStreamError = new Error(`gRPC error ${String(status)}: ${decodeURIComponent(String(msg || ""))}`);
      }
    });
    request.on("end", () => settle());
    request.on("close", () => settle());
    request.on("error", (error) => settle(mapH2TransportError(error, baseUrl)));

    if (signal) {
      onAbort = (): void => {
        request.close();
        settle(new Error("Request was aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    request.write(frameConnectMessage(requestBytes));
    const sendHeartbeat = (): void => {
      if (request.closed || request.destroyed) return;
      const heartbeatMessage = create(AgentClientMessageSchema, {
        message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
      });
      request.write(frameConnectMessage(toBinary(AgentClientMessageSchema, heartbeatMessage)));
    };
    heartbeat = setInterval(sendHeartbeat, deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);

    await done;

    endCurrentTextBlock(state);
    endCurrentThinkingBlock(state);
    flushOpenToolCalls(state);
    // Pi's agent loop runs every tool-call block; `toolUse` says so to the caller.
    if (output.content.some((b) => b.type === "toolCall")) output.stopReason = "toolUse";
    ensureStarted(state);
    stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
    stream.end();
  } catch (error) {
    endCurrentTextBlock(state);
    endCurrentThinkingBlock(state);
    flushOpenToolCalls(state);
    output.stopReason = signal?.aborted ? "aborted" : "error";
    output.errorMessage = signal?.aborted ? "Request was aborted" : error instanceof Error ? error.message : String(error);
    stream.push({ type: "error", reason: output.stopReason, error: output });
    stream.end();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    h2Request?.close();
    h2Client?.close();
  }
}

/** The `cursor-agent` `streamSimple`: returns Pi's event stream at once and runs the turn behind it. */
export function createCursorStreamSimple(deps: CursorStreamDeps = {}): StreamSimpleFn {
  return (model, context, options) => {
    const stream = new CcaEventStream();
    void run(stream, model, context, options, deps);
    return stream as unknown as PiEventStream;
  };
}
