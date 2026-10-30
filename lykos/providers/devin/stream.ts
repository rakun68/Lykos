// The Devin (Codeium Cascade) `streamSimple` for api `devin-agent`.
//
// Pi 0.84.3 has no implementation of this protocol; Lykos registers this one through
// `ModelRuntime.registerProvider` and never patches Pi (rule 7).
//
// The turn: `GetUserJwt` (unary Connect, protobuf body, the session token in `Metadata.apiKey`),
// then `AssignModel` for a router model only (`compat.modelRouter`; neither model in
// the table is one), then `GetChatMessage` as a Connect stream over `fetch`: one gzipped request
// frame, then frames of `GetChatMessageResponse` (flag 0x01 = gzip) until an end-stream frame
// (flag 0x02) whose JSON trailer may carry `{ error: { code, message, details } }`. A frame
// length over 16 MiB fails the turn before its payload is buffered.
//
// Plan D4, every tool goes through Lykos's gate: streamed tool calls are surfaced to Pi as
// tool-call blocks and nothing else. This module executes nothing, reads no file and spawns
// nothing; Pi's agent loop runs the call and the result returns in the next request's history.
//
// Choices, and why:
// - Errors: Pi reads only `errorMessage`. HTTP failures read
//   `Devin API error: <status> <statusText>: <body>` (and `Devin auth error: ...`,
//   `Devin AssignModel error: ...`). The colon after "error" is Lykos's: without it ticket 05's
//   classifier cannot read the status, so a 401 would not classify as auth. Bodies are cut at
//   500 characters.
// - The large-history `invalid_argument` recovery: Pi detects overflow from the message text,
//   so Lykos appends
//   `(context_length_exceeded: <n>-byte history)`, which Pi's overflow patterns match.
// - `usage.credits` and `upstreamModel`: Pi's message has no credits field; the model the server
//   ran on goes to Pi's `responseModel`. `calculateCost` is not run: cost stays zero (rule 5).
// - History replay, as ticket 04's Google stream does: failed or aborted assistant turns are not replayed and an unanswered tool call
//   gets a synthetic error result.
// - A tool's parameters go out as a JSON clone. Pi has no `topP` or `stopSequences` options, so
//   the server's defaults always apply.
// - Mid-stream tool arguments are closed by a small completer below and parsed with
//   `JSON.parse`; unparseable text yields `{}`.

import { createHash, randomUUID } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
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
import { create, fromBinary, type MessageCodec, type ProtoMessage, toBinary } from "../protobuf/codec.js";
import {
  AssignModelRequestSchema,
  AssignModelResponseSchema,
  CacheControlType,
  type ChatMessagePrompt,
  ChatMessagePromptSchema,
  ChatMessageRequestType,
  ChatMessageSource,
  type ChatToolCall,
  ChatToolCallSchema,
  ChatToolChoiceSchema,
  ChatToolDefinitionSchema,
  CompletionConfigurationSchema,
  ConversationalPlannerMode,
  type GetChatMessageRequest,
  GetChatMessageRequestSchema,
  GetChatMessageResponseSchema,
  GetUserJwtRequestSchema,
  GetUserJwtResponseSchema,
  type ImageData,
  ImageDataSchema,
  MetadataSchema,
  type ModelAssignment,
  PromptCacheOptionsSchema,
  StopReason,
} from "./proto.js";

// ---------------------------------------------------------------------------
// wire/devin.ts (verbatim)
// ---------------------------------------------------------------------------

/** Base host for Codeium/Windsurf's Cascade API (Connect protocol over HTTP/1.1). */
export const DEVIN_DEFAULT_BASE_URL = "https://server.codeium.com";

const DEVIN_SESSION_TOKEN_PREFIX = "devin-session-token$";

/** `Metadata.os` vocabulary; `process.platform` is fixed for the process lifetime. */
const DEVIN_OS = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
const DEVIN_LOCALE = "en";

/**
 * Released Devin CLI request identity. The backend gates behavior on this
 * tuple: `ideType: "chisel"` is what unlocks router assignment (`AssignModel`)
 * and the CLI model surface, which the older Windsurf identity does not reach.
 */
const DEVIN_CLI_METADATA = {
  ideName: "devin-cli",
  ideType: "chisel",
  ideVersion: "3000.6.2",
  extensionName: "chisel",
  extensionVersion: "3000.6.2",
  locale: DEVIN_LOCALE,
  os: DEVIN_OS,
} as const;

/** Session token as the wire format carries it: the scheme prefix is required. */
export function normalizeDevinSessionToken(apiKey: string | undefined): string {
  if (!apiKey) return "";
  return apiKey.startsWith(DEVIN_SESSION_TOKEN_PREFIX) ? apiKey : `${DEVIN_SESSION_TOKEN_PREFIX}${apiKey}`;
}

/**
 * Fields for `Metadata` on released-CLI calls (`GetUserJwt`, `AssignModel`,
 * `GetChatMessage`, `GetUserStatus`). `userJwt` stays empty for the calls the
 * CLI makes with the session token alone (auth, model assignment, usage).
 */
export function devinCliMetadata(apiKey: string | undefined, userJwt = "") {
  return {
    apiKey: normalizeDevinSessionToken(apiKey),
    userJwt,
    ...DEVIN_CLI_METADATA,
  };
}

// ---------------------------------------------------------------------------
// wire/devin-proto.ts (verbatim)
// ---------------------------------------------------------------------------

/**
 * Decode a unary Devin Connect response. Edges variously return bare protobuf
 * or a gzipped protobuf body; Bun's `fetch` normally decompresses first, so the
 * direct decode is attempted before the gzip fallback. Returns `null` when
 * neither representation decodes against `schema`.
 */
export function decodeDevinUnaryMessage<TMessage extends ProtoMessage>(
  schema: MessageCodec<TMessage>,
  payload: Uint8Array,
): TMessage | null {
  try {
    return fromBinary(schema, payload);
  } catch {
    try {
      return fromBinary(schema, gunzipSync(payload));
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// providers/devin.ts constants
// ---------------------------------------------------------------------------

/** Base host for Codeium/Windsurf's Cascade chat API (Connect protocol over HTTP/1.1). */
export const DEVIN_API_URL = DEVIN_DEFAULT_BASE_URL;

export const CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
export const DEVIN_ASSIGN_MODEL_PATH = "/exa.api_server_pb.ApiServerService/AssignModel";
export const DEVIN_AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
export const DEVIN_DEFAULT_STOP_PATTERNS = ["<|user|>", "<|bot|>", "<|context_request|>", "<|endoftext|>", "<|end_of_turn|>"];

/** Connect streaming framing: flag byte bit 0x01 = gzip payload, 0x02 = end-of-stream JSON trailers. */
export const CONNECT_COMPRESSED_FLAG = 0x01;
export const CONNECT_END_STREAM_FLAG = 0x02;
/**
 * Hard upper bound on a single Connect frame payload. The 4-byte length prefix
 * is otherwise attacker-controlled (up to `2**32 - 1`), so a malicious or buggy
 * peer could force the reader to buffer gigabytes via `Buffer.concat`. Well
 * above any legitimate Cascade response but tight enough that a corrupt length
 * prefix fails fast instead of consuming memory.
 */
export const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;
/**
 * Recovery heuristic for opaque Devin `invalid_argument` trailers. This is not
 * asserted to be the backend's hard limit: small requests can hit the same
 * intermittent error, while compactable message history this large is likely
 * to benefit from the existing context-overflow maintenance path.
 */
export const LARGE_HISTORY_RECOVERY_BYTES = 512 * 1024;

export interface DevinCompat {
  modelRouter?: boolean;
  supportsParallelToolCalls?: boolean;
}

/**
 * The `compat` of the table's two models. Pi's model type has no `compat` for this api, so it
 * is looked up by id; an unknown id gets `{}`, a model with no features.
 */
export const DEVIN_MODEL_COMPAT: Readonly<Record<string, DevinCompat>> = {
  "swe-1-6": { modelRouter: false, supportsParallelToolCalls: true },
  "swe-1-6-fast": { modelRouter: false, supportsParallelToolCalls: true },
};

export interface DevinStreamDeps {
  fetch?: typeof fetch;
  /** The model's compat. Defaults to {@link DEVIN_MODEL_COMPAT}; tests inject a router. */
  compat?: (modelId: string) => DevinCompat | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The leading 128 bits of SHA-256 in the 8-4-4-4-12 layout. */
function deterministicUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function normalizeSystemPrompts(systemPrompt: string | undefined): string[] {
  if (systemPrompt === undefined) return [];
  return [systemPrompt].filter((prompt) => prompt.trim().length > 0);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Close a truncated JSON prefix so `JSON.parse` can read it: drop a dangling key, colon or
 * comma, close an open string, then close every open array and object. Returns `undefined` when the text still does not parse.
 */
export function completePartialJson(text: string): unknown {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let head = text;
  if (inString) head += escaped ? '\\"' : '"';
  const closers = stack
    .reverse()
    .map((open) => (open === "{" ? "}" : "]"))
    .join("");
  const candidates = [head, head.replace(/,\s*$/, ""), head.replace(/,?\s*"(?:[^"\\]|\\.)*"\s*:?\s*$/, ""), head.replace(/[,:]\s*$/, "")];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate + closers) as unknown;
    } catch {
      // try the next repair
    }
  }
  return undefined;
}

/** Streaming tool arguments: whole JSON, else a repaired prefix, else `{}`. */
export function parseStreamingJson(partialJson: string | undefined): Record<string, unknown> {
  const trimmed = partialJson?.trimStart();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const repaired = completePartialJson(trimmed);
    return repaired !== null && typeof repaired === "object" && !Array.isArray(repaired) ? (repaired as Record<string, unknown>) : {};
  }
}

const STREAMING_JSON_PARSE_MIN_GROWTH = 256;

function parseStreamingJsonThrottled(
  partialJson: string | undefined,
  lastParsedLen: number,
  minGrowthBytes: number = STREAMING_JSON_PARSE_MIN_GROWTH,
): { value: Record<string, unknown>; parsedLen: number } | null {
  const len = partialJson?.length ?? 0;
  if (len === 0) return null;
  const growth = Math.max(minGrowthBytes, len >> 5);
  if (lastParsedLen > 0 && len - lastParsedLen < growth) return null;
  return { value: parseStreamingJson(partialJson), parsedLen: len };
}

/**
 * What a replay needs from history: failed or aborted
 * assistant turns are not replayed, and a tool call that never got a result
 * receives a synthetic error result (ticket 04's subset).
 */
function transformMessages(messages: readonly PiMessage[]): PiMessage[] {
  const out: PiMessage[] = [];
  let pending: ToolCall[] = [];
  const flushPending = (): void => {
    for (const call of pending) {
      out.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: "No result provided" }],
        isError: true,
        timestamp: Date.now(),
      });
    }
    pending = [];
  };
  for (const message of messages) {
    if (message.role === "assistant") {
      flushPending();
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      out.push(message);
      pending = message.content.filter((b): b is ToolCall => b.type === "toolCall");
    } else if (message.role === "toolResult") {
      pending = pending.filter((c) => c.id !== message.toolCallId);
      out.push(message);
    } else {
      flushPending();
      out.push(message);
    }
  }
  flushPending();
  return out;
}

function isUserLike(role: string): boolean {
  return role === "user" || role === "developer";
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

/** Per-turn wire state shared by `AssignModel` and `GetChatMessage`. */
interface DevinTurn {
  apiKey: string | undefined;
  userJwt: string;
  /** Cascade thread id; assignment and chat must agree on it or the JWT is rejected. */
  cascadeId: string;
  /** History already run through {@link transformMessages}, shared by both calls. */
  messages: PiMessage[];
}

type UserMessage = Extract<PiMessage, { role: "user" }>;

/** Flatten one user turn into a Cascade USER prompt with inline images. */
function buildUserPrompt(msg: UserMessage, messageId: string): ChatMessagePrompt {
  let prompt = "";
  const images: ImageData[] = [];
  if (typeof msg.content === "string") {
    prompt = msg.content;
  } else {
    for (const part of msg.content) {
      if (part.type === "text") {
        prompt += part.text;
      } else if (part.type === "image") {
        images.push(create(ImageDataSchema, { base64Data: part.data, mimeType: part.mimeType }));
      }
    }
  }
  return create(ChatMessagePromptSchema, { messageId, source: ChatMessageSource.USER, prompt, images });
}

/**
 * The prompt the router scores: the current user turn on its own. Native
 * leaves `messageId` empty here — the id for the turn is minted by the chat
 * request that follows.
 */
function buildRouterPrompt(messages: PiMessage[]): ChatMessagePrompt | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const msg = messages[index]!;
    if (msg.role === "user") return buildUserPrompt(msg, "");
  }
  return undefined;
}

/** Map Pi history onto Cascade `ChatMessagePrompt`s (USER / SYSTEM / TOOL channels). */
function buildChatMessagePrompts(messages: PiMessage[], cascadeId: string, model: PiModel): ChatMessagePrompt[] {
  const prompts: ChatMessagePrompt[] = [];
  // messageId seeds are `cascadeId\0index\0role[...]` — prompt text is excluded
  // so ids stay stable across content edits / history rebuilds.
  for (const [index, msg] of messages.entries()) {
    if (msg.role === "user") {
      prompts.push(buildUserPrompt(msg, deterministicUuid(`${cascadeId}\0${index}\0${msg.role}`)));
    } else if (msg.role === "assistant") {
      const isNativeDevinMessage = msg.api === model.api && msg.provider === model.provider && msg.model === model.id;
      let promptText = "";
      let thinkingText = "";
      let signature = "";
      const toolCalls: ChatToolCall[] = [];
      for (const part of msg.content) {
        if (part.type === "text") {
          promptText += part.text;
        } else if (part.type === "thinking") {
          thinkingText += part.thinking;
          if (isNativeDevinMessage && !signature && part.thinkingSignature) signature = part.thinkingSignature;
        } else if (part.type === "toolCall") {
          toolCalls.push(
            create(ChatToolCallSchema, {
              id: part.id,
              name: part.name,
              argumentsJson: JSON.stringify(part.arguments),
            }),
          );
        }
      }
      if (!promptText && !thinkingText && !signature && toolCalls.length === 0) continue;
      prompts.push(
        create(ChatMessagePromptSchema, {
          messageId:
            isNativeDevinMessage && msg.responseId ? msg.responseId : `bot-${deterministicUuid(`${cascadeId}\0${index}\0assistant`)}`,
          source: ChatMessageSource.SYSTEM,
          prompt: promptText,
          thinking: thinkingText,
          signature,
          signatureType: "",
          toolCalls,
        }),
      );
    } else {
      let resultText = "";
      const images: ImageData[] = [];
      for (const part of msg.content) {
        if (part.type === "text") {
          resultText += part.text;
        } else if (part.type === "image") {
          images.push(create(ImageDataSchema, { base64Data: part.data, mimeType: part.mimeType }));
        }
      }
      prompts.push(
        create(ChatMessagePromptSchema, {
          messageId: deterministicUuid(`${cascadeId}\0${index}\0tool\0${msg.toolCallId}`),
          source: ChatMessageSource.TOOL,
          toolCallId: msg.toolCallId,
          toolResultIsError: msg.isError,
          prompt: resultText,
          images,
        }),
      );
    }
  }
  return prompts;
}

/** A tool's parameters as a plain JSON clone. */
function plainSchema(tool: PiTool): unknown {
  return JSON.parse(JSON.stringify(tool.parameters ?? { type: "object", properties: {} })) as unknown;
}

/**
 * Build a `GetChatMessageRequest` for one Cascade turn. Auth rides inside
 * `Metadata.apiKey`; the system prompt is the flattened `prompt` string and the
 * conversation history maps to `chatMessagePrompts`. `assignment` is present only
 * for router models and supplies both the resolved uid and its JWT.
 */
export function buildDevinChatRequest(
  model: PiModel,
  context: PiContext,
  options: PiSimpleStreamOptions | undefined,
  turn: DevinTurn,
  assignment: ModelAssignment | undefined,
  compat: DevinCompat,
): GetChatMessageRequest {
  const stopPatterns = DEVIN_DEFAULT_STOP_PATTERNS;
  return create(GetChatMessageRequestSchema, {
    metadata: create(MetadataSchema, devinCliMetadata(turn.apiKey, turn.userJwt)),
    prompt: normalizeSystemPrompts(context.systemPrompt).join("\n\n"),
    chatMessagePrompts: buildChatMessagePrompts(turn.messages, turn.cascadeId, model),
    chatModelUid: assignment?.modelUid ?? model.id,
    ...(assignment ? { modelAssignmentJwt: assignment.assignmentJwt } : undefined),
    requestType: ChatMessageRequestType.CASCADE,
    plannerMode: ConversationalPlannerMode.DEFAULT,
    toolChoice: create(ChatToolChoiceSchema, { choice: { case: "optionName", value: "auto" } }),
    systemPromptCacheOptions: create(PromptCacheOptionsSchema, { type: CacheControlType.EPHEMERAL }),
    disableParallelToolCalls: !compat.supportsParallelToolCalls,
    cascadeId: turn.cascadeId,
    executionId: randomUUID(),
    configuration: create(CompletionConfigurationSchema, {
      numCompletions: 1n,
      maxTokens: BigInt(options?.maxTokens ?? model.maxTokens ?? 64000),
      maxNewlines: 200n,
      temperature: options?.temperature ?? 0.4,
      firstTemperature: options?.temperature ?? 0.4,
      topK: 50n,
      topP: 1,
      stopPatterns: [...stopPatterns],
      fimEotProbThreshold: 1,
    }),
    tools: (context.tools ?? []).map((tool: PiTool) =>
      create(ChatToolDefinitionSchema, {
        name: tool.name,
        description: tool.description,
        jsonSchemaString: JSON.stringify(plainSchema(tool)),
        strict: false,
      }),
    ),
  });
}

// ---------------------------------------------------------------------------
// Unary calls
// ---------------------------------------------------------------------------

async function fetchDevinAuthMetadata(
  apiKey: string | undefined,
  baseUrl: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<{ userJwt: string; baseUrl?: string }> {
  const request = create(GetUserJwtRequestSchema, { metadata: create(MetadataSchema, devinCliMetadata(apiKey)) });
  const response = await fetchImpl(`${baseUrl}${DEVIN_AUTH_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/proto",
      "connect-protocol-version": "1",
      accept: "*/*",
    },
    body: toBinary(GetUserJwtRequestSchema, request),
    ...(signal !== undefined ? { signal } : {}),
  });
  const payload = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(
      `Devin auth error: ${response.status} ${response.statusText}: ${truncate(new TextDecoder().decode(payload), 500)}`,
    );
  }
  const decoded = decodeDevinUnaryMessage(GetUserJwtResponseSchema, payload);
  if (!decoded?.userJwt) {
    throw new Error("Devin auth error: GetUserJwt returned an empty user JWT");
  }
  const customBaseUrl = decoded.customApiServerUrl.trim();
  return { userJwt: decoded.userJwt, ...(customBaseUrl ? { baseUrl: customBaseUrl.replace(/\/+$/, "") } : undefined) };
}

/**
 * Resolve a server-side router (`adaptive`) into the concrete model uid plus the
 * assignment JWT that authorizes it. The router uid is never a legal
 * `chatModelUid`, so a failed assignment must fail the turn rather than fall
 * back to sending the router id to `GetChatMessage`.
 */
async function assignDevinModel(
  model: PiModel,
  turn: DevinTurn,
  baseUrl: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<ModelAssignment> {
  const routerPrompt = buildRouterPrompt(turn.messages);
  const request = create(AssignModelRequestSchema, {
    metadata: create(MetadataSchema, devinCliMetadata(turn.apiKey)),
    modelRouterUid: model.id,
    cascadeId: turn.cascadeId,
    ...(routerPrompt !== undefined ? { chatMessagePrompt: routerPrompt } : {}),
  });
  const response = await fetchImpl(`${baseUrl}${DEVIN_ASSIGN_MODEL_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/proto",
      "connect-protocol-version": "1",
      accept: "*/*",
    },
    body: toBinary(AssignModelRequestSchema, request),
    ...(signal !== undefined ? { signal } : {}),
  });
  const payload = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(
      `Devin AssignModel error: ${response.status} ${response.statusText}: ${truncate(new TextDecoder().decode(payload), 500)}`,
    );
  }
  const assignment = decodeDevinUnaryMessage(AssignModelResponseSchema, payload)?.assignment;
  if (!assignment?.assignmentJwt || !assignment.modelUid) {
    throw new Error("Devin AssignModel error: response carried no assignment JWT and model uid");
  }
  return assignment;
}

// ---------------------------------------------------------------------------
// Connect trailers
// ---------------------------------------------------------------------------

interface ConnectTrailerError {
  code: string;
  message: string;
  formatted: string;
  /** Summarized Connect error details entries, when the trailer carried any. */
  detail?: string;
}

/** Upper bound on retained raw-trailer evidence so messages stay bounded. */
const MAX_TRAILER_EVIDENCE_CHARS = 2000;

function truncateTrailerEvidence(text: string): string {
  return text.length > MAX_TRAILER_EVIDENCE_CHARS ? `${text.slice(0, MAX_TRAILER_EVIDENCE_CHARS)}…` : text;
}

/**
 * Parse a Connect end-of-stream JSON trailer and return its structured error
 * when it carries `{ error: { code, message } }`, else `null`. The trailer is
 * untrusted server output, so the shape is checked with guards rather than asserted.
 */
export function readConnectTrailerError(text: string): ConnectTrailerError | null {
  if (text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return null;
  const err = parsed.error;
  if (!err || typeof err !== "object") return null;
  const code = "code" in err && typeof err.code === "string" ? err.code : "";
  const message = "message" in err && typeof err.message === "string" ? err.message : "";
  if (!code && !message) return null;
  const trailer: ConnectTrailerError = {
    code,
    message,
    formatted: `Devin stream error${code ? ` ${code}` : ""}: ${message}`,
  };
  const detail = "details" in err ? summarizeTrailerDetails(err.details) : undefined;
  if (detail) {
    trailer.detail = detail;
    trailer.formatted += ` [details: ${detail}]`;
  }
  return trailer;
}

/** Summarize Connect error `details` entries (loosely `{ type, value, debug }` records). */
function summarizeTrailerDetails(details: unknown): string | undefined {
  if (!Array.isArray(details) || details.length === 0) return undefined;
  let summary = "";
  for (const entry of details) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const type = typeof record.type === "string" && record.type ? record.type : undefined;
    const value = typeof record.value === "string" && record.value ? record.value : undefined;
    let debug: string | undefined;
    if (record.debug !== undefined) {
      try {
        debug = typeof record.debug === "string" ? record.debug : JSON.stringify(record.debug);
      } catch {
        debug = undefined;
      }
    }
    const boundedType = type ? truncateTrailerEvidence(type) : undefined;
    const evidence = debug ?? value;
    const boundedEvidence = evidence ? truncateTrailerEvidence(evidence) : undefined;
    let part: string | undefined;
    if (boundedType && boundedEvidence) part = `${boundedType}: ${boundedEvidence}`;
    else part = boundedType ?? boundedEvidence;
    if (!part) continue;
    const next = summary ? `${summary}; ${part}` : part;
    if (next.length > MAX_TRAILER_EVIDENCE_CHARS) return truncateTrailerEvidence(next);
    summary = next;
  }
  return summary || undefined;
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

function emptyUsage(): AssistantMessage["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

async function run(
  stream: CcaEventStream,
  model: PiModel,
  context: PiContext,
  options: PiSimpleStreamOptions | undefined,
  deps: DevinStreamDeps,
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

  let currentTextBlock: TextContent | null = null;
  let currentThinkingBlock: ThinkingContent | null = null;
  // Tool-call content blocks keyed by streamed tool-call id, plus the JSON-args text
  // accumulated per id (kept out of the content object so finalized tool calls stay clean).
  const toolBlocks = new Map<string, ToolCall>();
  const toolPartialJson = new Map<string, string>();
  // Last-parsed argument-buffer length per tool-call id (bounds mid-stream parse work);
  // the authoritative final parse still runs unconditionally at the end.
  const toolLastParseLen = new Map<string, number>();
  let activeToolCallId: string | undefined;
  let latestStopReason: StopReason = StopReason.UNSPECIFIED;
  let sawOutput = false;
  const signal = options?.signal;

  const endTextBlock = (): void => {
    const block = currentTextBlock;
    if (!block) return;
    currentTextBlock = null;
    stream.push({ type: "text_end", contentIndex: output.content.indexOf(block), content: block.text, partial: output });
  };

  const endThinkingBlock = (): void => {
    const block = currentThinkingBlock;
    if (!block) return;
    currentThinkingBlock = null;
    stream.push({ type: "thinking_end", contentIndex: output.content.indexOf(block), content: block.thinking, partial: output });
  };

  try {
    const fetchImpl = deps.fetch ?? globalThis.fetch;
    const compat = (deps.compat ?? ((id: string) => DEVIN_MODEL_COMPAT[id]))(model.id) ?? {};
    const baseUrl = (model.baseUrl || DEVIN_API_URL).replace(/\/+$/, "");
    const auth = await fetchDevinAuthMetadata(options?.apiKey, baseUrl, fetchImpl, signal);
    const chatBaseUrl = auth.baseUrl ?? baseUrl;
    const turn: DevinTurn = {
      apiKey: options?.apiKey,
      userJwt: auth.userJwt,
      cascadeId: options?.sessionId ?? randomUUID(),
      messages: transformMessages(context.messages),
    };
    // Router models are not valid chat model uids: the server resolves them through
    // AssignModel and expects the returned uid plus assignment JWT on the chat request
    // that shares the cascade id.
    let assignment: ModelAssignment | undefined;
    if (compat.modelRouter) {
      assignment = await assignDevinModel(model, turn, chatBaseUrl, fetchImpl, signal);
      output.responseModel = assignment.modelUid;
    }
    const request = buildDevinChatRequest(model, context, options, turn, assignment, compat);
    const reqBytes = toBinary(GetChatMessageRequestSchema, request);
    const gz = gzipSync(reqBytes);
    const frame = Buffer.alloc(5 + gz.length);
    frame[0] = CONNECT_COMPRESSED_FLAG;
    frame.writeUInt32BE(gz.length, 1);
    frame.set(gz, 5);

    const callerHeaders = Object.fromEntries(
      Object.entries(options?.headers ?? {}).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
    const response = await fetchImpl(chatBaseUrl + CHAT_MESSAGE_PATH, {
      method: "POST",
      headers: {
        "content-type": "application/connect+proto",
        "connect-protocol-version": "1",
        "connect-content-encoding": "gzip",
        "accept-encoding": "identity",
        "user-agent": "connect-go/1.18.1 (go1.26.3)",
        "connect-accept-encoding": "gzip",
        ...callerHeaders,
      },
      body: frame,
      ...(signal !== undefined ? { signal } : {}),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Devin API error: ${response.status} ${response.statusText}: ${truncate(text, 500)}`);
    }
    if (!response.body) {
      throw new Error("Devin API error: response body is empty");
    }

    stream.push({ type: "start", partial: output });

    const reader = response.body.getReader();
    let pending: Buffer = Buffer.alloc(0);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value && value.length > 0) {
          pending =
            pending.length === 0 ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : Buffer.concat([pending, value]);
        }

        while (pending.length >= 5) {
          const flag = pending[0]!;
          const len = pending.readUInt32BE(1);
          if (len > MAX_CONNECT_FRAME_PAYLOAD) {
            throw new Error(`Devin Connect frame length ${len} exceeds ${MAX_CONNECT_FRAME_PAYLOAD}-byte cap`);
          }
          if (pending.length < 5 + len) break;
          const payload = pending.subarray(5, 5 + len);
          pending = pending.subarray(5 + len);

          if (flag & CONNECT_END_STREAM_FLAG) {
            const trailerBytes = flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload;
            const trailerError = readConnectTrailerError(trailerBytes.toString("utf8").trim());
            if (trailerError) {
              let message = trailerError.formatted;
              if (!sawOutput && trailerError.code.toLowerCase() === "invalid_argument" && /\binternal error\b/i.test(trailerError.message)) {
                // The full protobuf also contains the system prompt and tool schemas,
                // which history maintenance cannot shrink. Re-encode only the repeated
                // history field before choosing recovery.
                let activeTailCount = 0;
                const lastRole = context.messages.at(-1)?.role as string | undefined;
                if (lastRole !== undefined && isUserLike(lastRole)) {
                  activeTailCount = 1;
                  // A trailing developer message can accompany the current user prompt.
                  // Earlier user-role records may instead be flushed execution history and
                  // must remain eligible for compaction.
                  if (lastRole === "developer") {
                    for (let i = context.messages.length - 2; i >= 0; i--) {
                      if (!isUserLike(context.messages[i]!.role)) break;
                      activeTailCount++;
                    }
                  }
                }
                const shrinkablePrompts =
                  activeTailCount > 0 ? request.chatMessagePrompts.slice(0, -activeTailCount) : request.chatMessagePrompts;
                const historyBytes = toBinary(
                  GetChatMessageRequestSchema,
                  create(GetChatMessageRequestSchema, { chatMessagePrompts: shrinkablePrompts }),
                ).byteLength;
                if (historyBytes >= LARGE_HISTORY_RECOVERY_BYTES) {
                  message += ` (context_length_exceeded: ${historyBytes}-byte history)`;
                }
              }
              throw new Error(message);
            }
            continue;
          }

          const raw = flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload;
          const msg = fromBinary(GetChatMessageResponseSchema, raw);
          if (msg.messageId && !output.responseId) output.responseId = msg.messageId;
          // The router reports the concrete model it landed on; it can differ from
          // the uid AssignModel handed back (fallbacks, capacity routing).
          if (msg.actualModelUid) output.responseModel = msg.actualModelUid;

          if (msg.deltaThinking) {
            sawOutput = true;
            const block: ThinkingContent = currentThinkingBlock ?? { type: "thinking", thinking: "" };
            if (currentThinkingBlock !== block) {
              output.content.push(block);
              currentThinkingBlock = block;
              stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
            }
            block.thinking += msg.deltaThinking;
            if (msg.deltaSignature) block.thinkingSignature = msg.deltaSignature;
            stream.push({ type: "thinking_delta", contentIndex: output.content.indexOf(block), delta: msg.deltaThinking, partial: output });
          }

          if (msg.deltaText) {
            sawOutput = true;
            endThinkingBlock();
            const block: TextContent = currentTextBlock ?? { type: "text", text: "" };
            if (currentTextBlock !== block) {
              output.content.push(block);
              currentTextBlock = block;
              stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
            }
            block.text += msg.deltaText;
            stream.push({ type: "text_delta", contentIndex: output.content.indexOf(block), delta: msg.deltaText, partial: output });
          }

          if (msg.deltaToolCalls.length > 0) {
            sawOutput = true;
            endTextBlock();
            endThinkingBlock();
            for (const tc of msg.deltaToolCalls) {
              const toolCallId = tc.id || activeToolCallId;
              if (!toolCallId) continue;
              let block = toolBlocks.get(toolCallId);
              if (!block) {
                block = { type: "toolCall", id: toolCallId, name: tc.name, arguments: {} };
                output.content.push(block);
                toolBlocks.set(toolCallId, block);
                toolPartialJson.set(toolCallId, "");
                stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
              }
              if (tc.name) block.name = tc.name;
              activeToolCallId = toolCallId;
              if (!tc.argumentsJson) continue;
              const previousJson = toolPartialJson.get(toolCallId) ?? "";
              const accumulated = tc.argumentsJson.startsWith(previousJson) ? tc.argumentsJson : previousJson + tc.argumentsJson;
              const delta = accumulated.slice(previousJson.length);
              toolPartialJson.set(toolCallId, accumulated);
              const throttled = parseStreamingJsonThrottled(accumulated, toolLastParseLen.get(toolCallId) ?? 0);
              if (throttled) {
                block.arguments = throttled.value;
                toolLastParseLen.set(toolCallId, throttled.parsedLen);
              }
              stream.push({ type: "toolcall_delta", contentIndex: output.content.indexOf(block), delta, partial: output });
            }
          }

          if (msg.stopReason !== StopReason.UNSPECIFIED) {
            latestStopReason = msg.stopReason;
          }

          if (msg.usage) {
            output.usage.input = Number(msg.usage.inputTokens);
            output.usage.output = Number(msg.usage.outputTokens);
            output.usage.cacheRead = Number(msg.usage.cacheReadTokens);
            output.usage.cacheWrite = Number(msg.usage.cacheWriteTokens);
            output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          }
        }

        if (done) break;
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    endTextBlock();
    endThinkingBlock();
    for (const [id, block] of toolBlocks) {
      block.arguments = parseStreamingJson(toolPartialJson.get(id));
      stream.push({ type: "toolcall_end", contentIndex: output.content.indexOf(block), toolCall: block, partial: output });
    }

    const doneReason: "stop" | "length" | "toolUse" =
      toolBlocks.size > 0 ? "toolUse" : latestStopReason === StopReason.MAX_TOKENS ? "length" : "stop";
    output.stopReason = doneReason;
    stream.push({ type: "done", reason: doneReason, message: output });
    stream.end();
  } catch (error) {
    endTextBlock();
    endThinkingBlock();
    output.stopReason = signal?.aborted ? "aborted" : "error";
    output.errorMessage = signal?.aborted ? "Request was aborted" : error instanceof Error ? error.message : String(error);
    stream.push({ type: "error", reason: output.stopReason, error: output });
    stream.end();
  }
}

/** The `devin-agent` `streamSimple`: returns Pi's event stream at once and runs the turn behind it. */
export function createDevinStreamSimple(deps: DevinStreamDeps = {}): StreamSimpleFn {
  return (model, context, options) => {
    const stream = new CcaEventStream();
    void run(stream, model, context, options, deps);
    return stream as unknown as PiEventStream;
  };
}
