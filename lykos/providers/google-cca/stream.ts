// The Cloud Code Assist `streamSimple` for google-antigravity and
// google-gemini-cli. Pi 0.84.3 has no implementation of this wire protocol;
// Lykos registers this one through `ModelRuntime.registerProvider` and never
// patches Pi.
//
// Kept: request building (both envelopes), SSE parsing, text, thinking (with
// thought signatures), tool calls, usage, finish reasons, in-band and HTTP
// errors, VALIDATION_REQUIRED messages.
//
// Dropped, and why:
// - Retries of every kind (fetchWithRetry on 429/5xx, the Antigravity
//   daily -> sandbox endpoint failover, the empty-stream retries). A failure
//   surfaces at once so Pi's own retry and ticket 05's rotation decide.
// - First-event and idle watchdog timers; the caller's AbortSignal is honoured.
// - Stream markup healing and the Flash planning-leak buffer (plan D1).
// - Image generation, raw request dumps, telemetry and provider session state.
//   The Antigravity request envelope is stateless
//   (fresh agent/trajectory ids, session id hashed from the first user text).
// - The forced-tool directive: Pi's `toolChoice` is only "auto" | "none".
// - A full JSON-schema normaliser. `sanitizeToolSchema` below strips the
//   keywords Google rejects and collapses unions.
// - Cost: every model is registered at zero cost (AGENTS.md rule 5).
//
// Errors carry the HTTP status and body as `Cloud Code Assist API error: <status> <body>`
// so ticket 05's classifier can read them from the error event's message.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { antigravityUserAgent, extractGoogleValidationUrl, formatGoogleValidationRequiredMessage, geminiCliHeaders } from "./project.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  FetchLike,
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
} from "./types.js";
import { ANTIGRAVITY_MODEL_WIRE_PROFILES, type Effort, type WireModel, wireModel } from "./wire-models.js";

const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const ANTIGRAVITY_DAILY_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com";
const CLAUDE_THINKING_BETA_HEADER = "interleaved-thinking-2025-05-14";
const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

const GOOGLE_THINKING: Record<Effort, number> = {
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 24575,
  max: 32768,
};
const EFFORT_ORDER: readonly Effort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const MIN_OUTPUT_TOKENS = 1024;
const OUTPUT_CAP_WHEN_UNKNOWN = 64_000;

// ---------------------------------------------------------------------------
// Event stream: the async-iterable + `result()` surface Pi consumes. Pi's own
// class lives in `@earendil-works/pi-ai`, which Lykos cannot resolve; Pi's
// `lazyStream` only iterates the stream and awaits `result()`.
// ---------------------------------------------------------------------------

export class CcaEventStream implements AsyncIterable<AssistantMessageEvent> {
  private readonly queue: AssistantMessageEvent[] = [];
  private readonly waiting: Array<(r: IteratorResult<AssistantMessageEvent>) => void> = [];
  private done = false;
  private resolveResult!: (m: AssistantMessage) => void;
  private readonly finalResult = new Promise<AssistantMessage>((resolve) => {
    this.resolveResult = resolve;
  });

  push(event: AssistantMessageEvent): void {
    if (this.done) return;
    if (event.type === "done") {
      this.done = true;
      this.resolveResult(event.message);
    } else if (event.type === "error") {
      this.done = true;
      this.resolveResult(event.error);
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  end(result?: AssistantMessage): void {
    this.done = true;
    if (result !== undefined) this.resolveResult(result);
    while (this.waiting.length > 0) this.waiting.shift()!({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    for (;;) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.done) {
        return;
      } else {
        const next = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => this.waiting.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    }
  }

  result(): Promise<AssistantMessage> {
    return this.finalResult;
  }
}

// ---------------------------------------------------------------------------
// Wire types (google-types.ts / CloudCodeAssistResponseChunk)
// ---------------------------------------------------------------------------

interface Part {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; parts?: Part[]; id?: string };
  inlineData?: { mimeType: string; data: string };
}

interface Content {
  role: "user" | "model";
  parts: Part[];
}

interface ThinkingConfig {
  includeThoughts?: boolean;
  thinkingBudget?: number;
  thinkingLevel?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
}

type FunctionCallingConfigMode = "AUTO" | "ANY" | "NONE" | "VALIDATED";

export interface CloudCodeAssistRequest {
  project: string;
  model: string;
  request: {
    contents: Content[];
    sessionId?: string;
    systemInstruction?: { role?: string; parts: { text: string }[] };
    generationConfig?: { maxOutputTokens?: number; temperature?: number; thinkingConfig?: ThinkingConfig };
    tools?: { functionDeclarations: Record<string, unknown>[] }[];
    toolConfig?: { functionCallingConfig: { mode: FunctionCallingConfigMode; allowedFunctionNames?: string[] } };
    labels?: Record<string, string>;
  };
  requestType?: string;
  userAgent?: string;
  requestId?: string;
}

interface ResponseChunk {
  response?: {
    candidates?: Array<{ content?: { role?: string; parts?: Part[] }; finishReason?: string }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
      totalTokenCount?: number;
      cachedContentTokenCount?: number;
    };
    modelVersion?: string;
    responseId?: string;
    promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
  };
  error?: { code?: number; message?: string; status?: string };
}

// ---------------------------------------------------------------------------
// Credentials (parseGeminiCliCredentials)
// ---------------------------------------------------------------------------

interface ParsedCredentials {
  accessToken: string;
  projectId: string;
  email?: string;
}

export function parseStructuredApiKey(apiKey: string, provider: string): ParsedCredentials {
  let raw: unknown;
  try {
    raw = JSON.parse(apiKey);
  } catch {
    throw new Error(`Invalid Google Cloud Code Assist credentials. Run \`lykos login ${provider}\` again.`);
  }
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  const token = str(record.token);
  const projectId = str(record.projectId) ?? str(record.project_id);
  if (token === undefined || projectId === undefined) {
    throw new Error(`Missing token or projectId in Google Cloud credentials. Run \`lykos login ${provider}\` again.`);
  }
  const email = str(record.email);
  return { accessToken: token, projectId, ...(email !== undefined ? { email } : {}) };
}

// ---------------------------------------------------------------------------
// Thinking options (stream.ts, case "google-gemini-cli")
// ---------------------------------------------------------------------------

interface ThinkingChoice {
  wireModelId: string;
  maxTokens: number | undefined;
  thinking?: ThinkingConfig;
}

function supportedEffort(meta: WireModel | undefined, requested: Effort): Effort {
  const efforts = meta?.thinking?.efforts;
  if (efforts === undefined || efforts.length === 0 || efforts.includes(requested)) return requested;
  const at = EFFORT_ORDER.indexOf(requested);
  const higher = efforts.filter((e) => EFFORT_ORDER.indexOf(e) >= at).sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  if (higher[0] !== undefined) return higher[0];
  return [...efforts].sort((a, b) => EFFORT_ORDER.indexOf(b) - EFFORT_ORDER.indexOf(a))[0]!;
}

/** `defaultSupportedEffort`: the effort whose route equals the default wire id, else the lowest supported. */
function defaultEffort(meta: WireModel | undefined): Effort | undefined {
  const t = meta?.thinking;
  if (t === undefined) return undefined;
  if (t.effortRouting !== undefined && meta?.requestModelId !== undefined) {
    for (const e of EFFORT_ORDER) if (t.efforts.includes(e) && t.effortRouting[e] === meta.requestModelId) return e;
  }
  for (const e of EFFORT_ORDER) if (t.efforts.includes(e)) return e;
  return t.efforts[0];
}

function googleLevel(effort: Effort, meta: WireModel | undefined): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" {
  if (effort === "minimal") {
    const routing = meta?.thinking?.effortRouting;
    return routing?.minimal !== undefined && routing.minimal === routing.low ? "LOW" : "MINIMAL";
  }
  if (effort === "low") return "LOW";
  if (effort === "medium") return "MEDIUM";
  return "HIGH";
}

function wireIdFor(model: PiModel, meta: WireModel | undefined, effort: Effort | undefined): string {
  return meta?.thinking?.effortRouting?.[effort ?? "off"] ?? meta?.requestModelId ?? model.id;
}

export function chooseThinking(model: PiModel, meta: WireModel | undefined, options: PiSimpleStreamOptions | undefined): ThinkingChoice {
  let reasoning = options?.reasoning as Effort | undefined;
  // Mandatory-reasoning endpoints reject thinking off; clamp to the default effort.
  if (reasoning === undefined && model.reasoning && meta?.thinking?.requiresEffort && !meta.thinking.suppressWhenOff) {
    reasoning = defaultEffort(meta);
  }
  if (reasoning !== undefined && model.reasoning) {
    const effort = supportedEffort(meta, reasoning);
    if (meta?.thinking?.mode === "google-level") {
      return {
        wireModelId: wireIdFor(model, meta, effort),
        maxTokens: options?.maxTokens,
        thinking: { includeThoughts: true, thinkingLevel: googleLevel(effort, meta) },
      };
    }
    let budget = options?.thinkingBudgets?.[effort as keyof NonNullable<PiSimpleStreamOptions["thinkingBudgets"]>] ??
      meta?.thinking?.effortBudgets?.[effort] ??
      GOOGLE_THINKING[effort];
    const uncapped = options?.maxTokens === undefined ? OUTPUT_CAP_WHEN_UNKNOWN : options.maxTokens + budget;
    const maxTokens = Math.min(uncapped, model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
    if (maxTokens <= budget) budget = Math.max(0, maxTokens - MIN_OUTPUT_TOKENS);
    if (budget > 0) {
      return {
        wireModelId: wireIdFor(model, meta, effort),
        maxTokens,
        thinking: { includeThoughts: true, thinkingBudget: budget },
      };
    }
  }
  const off: ThinkingChoice = { wireModelId: wireIdFor(model, meta, undefined), maxTokens: options?.maxTokens };
  if (model.reasoning && meta?.thinking?.suppressWhenOff) {
    off.thinking =
      meta.thinking.mode === "google-level"
        ? { includeThoughts: false, thinkingLevel: "MINIMAL" }
        : { includeThoughts: false, thinkingBudget: 0 };
  }
  return off;
}

// ---------------------------------------------------------------------------
// Messages and tools (google-shared.ts convertMessages / convertTools)
// ---------------------------------------------------------------------------

const BASE64_SIGNATURE = /^[A-Za-z0-9+/]+={0,2}$/;

function validSignature(signature: string | undefined): signature is string {
  return typeof signature === "string" && signature.length > 0 && signature.length % 4 === 0 && BASE64_SIGNATURE.test(signature);
}

function normalizeToolCallId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

/**
 * What a Google request needs from history: failed or
 * aborted assistant turns are not replayed, and a tool call that never got a
 * result receives a synthetic error result, so every functionCall is answered.
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

export function convertMessages(model: PiModel, meta: WireModel | undefined, context: PiContext): Content[] {
  const contents: Content[] = [];
  const compat = meta?.compat ?? {};
  const supportsImages = model.input.includes("image");
  const isClaude = meta?.identity === "anthropic";
  const emittedNames = new Map<string, string>();
  let pendingImages: Part[] = [];
  const flushImages = (): void => {
    if (pendingImages.length === 0) return;
    contents.push({ role: "user", parts: pendingImages });
    pendingImages = [];
  };

  for (const msg of transformMessages(context.messages)) {
    if (msg.role !== "toolResult") flushImages();
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (msg.content.trim() === "") continue;
        contents.push({ role: "user", parts: [{ text: msg.content }] });
        continue;
      }
      const parts: Part[] = [];
      for (const item of msg.content) {
        if (item.type === "text") {
          if (item.text.trim().length > 0) parts.push({ text: item.text });
        } else if (supportsImages) {
          parts.push({ inlineData: { mimeType: item.mimeType, data: item.data } });
        } else {
          parts.push({ text: "(image omitted: model does not support images)" });
        }
      }
      if (parts.length > 0) contents.push({ role: "user", parts });
    } else if (msg.role === "assistant") {
      const parts: Part[] = [];
      const sameModel = msg.provider === model.provider && msg.model === model.id;
      let firstToolCall = true;
      for (const block of msg.content) {
        if (block.type === "text") {
          if (!block.text || block.text.trim() === "") continue;
          const sig = sameModel && validSignature(block.textSignature) ? block.textSignature : undefined;
          parts.push({ text: block.text, ...(sig !== undefined ? { thoughtSignature: sig } : {}) });
        } else if (block.type === "thinking") {
          if (!block.thinking || block.thinking.trim() === "") continue;
          const sig = sameModel && validSignature(block.thinkingSignature) ? block.thinkingSignature : undefined;
          if (sig !== undefined) {
            parts.push({ thought: true, text: block.thinking, thoughtSignature: sig });
          } else if (!compat.dropUnsignedThinking) {
            parts.push({ text: isClaude ? block.thinking : `<thinking>\n${block.thinking}\n</thinking>` });
          }
        } else {
          emittedNames.set(block.id, block.name);
          const sig = sameModel && validSignature(block.thoughtSignature) ? block.thoughtSignature : undefined;
          const fallback = firstToolCall && compat.requiresSkipThoughtSignatureOnFirstFunctionCall === true;
          const effective = sig ?? (fallback ? SKIP_THOUGHT_SIGNATURE : undefined);
          firstToolCall = false;
          parts.push({
            functionCall: {
              name: block.name,
              args: block.arguments ?? {},
              ...(compat.supportsFunctionPartId ? { id: normalizeToolCallId(block.id) } : {}),
            },
            ...(effective !== undefined ? { thoughtSignature: effective } : {}),
          });
        }
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
    } else {
      const text = msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const images = supportsImages ? msg.content.filter((c) => c.type === "image") : [];
      const omitted = !supportsImages && msg.content.some((c) => c.type === "image");
      const value = omitted
        ? [text, "(image omitted: model does not support images)"].filter(Boolean).join("\n")
        : text.length > 0
          ? text
          : images.length > 0
            ? "(see attached image)"
            : "";
      const imageParts: Part[] = images.map((img) =>
        img.type === "image" ? { inlineData: { mimeType: img.mimeType, data: img.data } } : {},
      );
      const multimodal = compat.multimodalFunctionResponse === true;
      const part: Part = {
        functionResponse: {
          name: emittedNames.get(msg.toolCallId) ?? msg.toolName,
          response: msg.isError ? { error: value } : { output: value },
          ...(imageParts.length > 0 && multimodal ? { parts: imageParts } : {}),
          ...(compat.supportsFunctionPartId ? { id: normalizeToolCallId(msg.toolCallId) } : {}),
        },
      };
      // Cloud Code Assist wants every function response of a turn in one user content.
      const last = contents[contents.length - 1];
      if (last?.role === "user" && last.parts.some((p) => p.functionResponse !== undefined)) last.parts.push(part);
      else contents.push({ role: "user", parts: [part] });
      if (imageParts.length > 0 && !multimodal) pendingImages.push({ text: "Tool result image:" }, ...imageParts);
    }
  }
  flushImages();
  return contents;
}

/** Schema keywords Google rejects. */
const UNSUPPORTED_SCHEMA_FIELDS = new Set([
  "$schema", "$id", "$ref", "$defs", "definitions", "$dynamicRef", "$dynamicAnchor", "$comment", "examples",
  "prefixItems", "unevaluatedProperties", "unevaluatedItems", "patternProperties", "additionalProperties",
  "propertyNames", "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum",
  "exclusiveMaximum", "multipleOf", "pattern", "format", "dependencies", "dependentSchemas", "dependentRequired",
  "x-mcp-header", "deprecated", "readOnly", "writeOnly", "not", "if", "then", "else", "const", "nullable",
]);

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function scalarType(v: unknown): string | undefined {
  if (typeof v === "string") return "string";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (typeof v === "boolean") return "boolean";
  return undefined;
}

/**
 * Drop the unsupported keywords, turn `const` and unions of literals into
 * `enum`, collapse other unions to their first non-null branch, merge `allOf`, reduce type arrays to
 * one type, and give every object a `properties` map.
 */
export function sanitizeToolSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeToolSchema);
  if (!isObject(node)) return node;
  let src: Json = { ...node };

  if (Array.isArray(src.allOf)) {
    const merged: Json = { ...src };
    delete merged.allOf;
    const props: Json = isObject(merged.properties) ? { ...merged.properties } : {};
    const required = new Set<string>(Array.isArray(merged.required) ? (merged.required as string[]) : []);
    for (const branch of src.allOf) {
      if (!isObject(branch)) continue;
      if (isObject(branch.properties)) Object.assign(props, branch.properties);
      if (Array.isArray(branch.required)) for (const r of branch.required) required.add(String(r));
      if (merged.type === undefined && branch.type !== undefined) merged.type = branch.type;
    }
    if (Object.keys(props).length > 0) merged.properties = props;
    if (required.size > 0) merged.required = [...required];
    src = merged;
  }

  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = src[key];
    if (!Array.isArray(branches)) continue;
    const live = branches.filter((b) => !(isObject(b) && b.type === "null"));
    const literals = live.map((b) =>
      isObject(b) ? (b.const !== undefined ? [b.const] : Array.isArray(b.enum) ? (b.enum as unknown[]) : undefined) : undefined,
    );
    const rest: Json = { ...src };
    delete rest.anyOf;
    delete rest.oneOf;
    if (live.length > 0 && literals.every((l) => l !== undefined)) {
      const values = literals.flat();
      const types = new Set(values.map(scalarType));
      const only = types.size === 1 ? [...types][0] : undefined;
      // One scalar type keeps its values; a mixed union becomes a string enum.
      src = only !== undefined ? { ...rest, type: only, enum: values } : { ...rest, type: "string", enum: values.map(String) };
    } else {
      const first = live.find(isObject);
      src = first !== undefined ? { ...first, ...rest } : { ...rest, type: rest.type ?? "string" };
    }
  }

  const out: Json = {};
  for (const [key, value] of Object.entries(src)) {
    if (key.startsWith("x-") || UNSUPPORTED_SCHEMA_FIELDS.has(key)) continue;
    if (key === "properties" && isObject(value)) {
      const props: Json = {};
      for (const [name, sub] of Object.entries(value)) props[name] = sanitizeToolSchema(sub);
      out.properties = props;
    } else if (key === "items") {
      out.items = sanitizeToolSchema(Array.isArray(value) ? value[0] : value);
    } else if (key === "type" && Array.isArray(value)) {
      out.type = value.find((t) => t !== "null") ?? "string";
    } else {
      out[key] = value;
    }
  }
  if (src.const !== undefined && out.enum === undefined) {
    out.enum = [src.const];
    if (out.type === undefined) {
      const t = scalarType(src.const);
      if (t !== undefined) out.type = t;
    }
  }
  if (out.type === undefined && Array.isArray(out.enum)) out.type = "string";
  if (out.type === "object" && !isObject(out.properties)) out.properties = {};
  if (Array.isArray(out.required) && isObject(out.properties)) {
    const known = out.properties;
    out.required = (out.required as unknown[]).filter((r) => typeof r === "string" && r in known);
    if ((out.required as unknown[]).length === 0) delete out.required;
  }
  return out;
}

/** JSON-clone a tool's parameters: drops TypeBox's symbol keys and anything non-serialisable. */
function plainSchema(tool: PiTool): unknown {
  try {
    return JSON.parse(JSON.stringify(tool.parameters ?? { type: "object", properties: {} })) as unknown;
  } catch {
    return { type: "object", properties: {} };
  }
}

/**
 * Antigravity (and Claude on CCA) take the legacy `parameters` field;
 * Gemini CLI takes `parametersJsonSchema`. Both get the sanitised schema.
 */
export function convertTools(tools: readonly PiTool[], meta: WireModel | undefined, isAntigravity: boolean): CloudCodeAssistRequest["request"]["tools"] {
  if (tools.length === 0) return undefined;
  const legacy = isAntigravity || meta?.compat.ccaLegacyParametersSchema === true;
  return [
    {
      functionDeclarations: tools.map((tool) => {
        const schema = sanitizeToolSchema(plainSchema(tool));
        return {
          name: tool.name,
          description: tool.description || "",
          ...(legacy ? { parameters: schema } : { parametersJsonSchema: schema }),
        };
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// Request (buildRequest / buildAntigravityRequestEnvelope)
// ---------------------------------------------------------------------------

const INT63_MASK = (1n << 63n) - 1n;
const ANTIGRAVITY_RANDOM_BOUND = 9_000_000_000_000_000_000n;

function signedDecimalFromHash(text: string): string {
  const digest = createHash("sha256").update(text).digest();
  let value = 0n;
  for (let i = 0; i < 8; i += 1) value = (value << 8n) | BigInt(digest[i] ?? 0);
  return `-${(value & INT63_MASK).toString()}`;
}

function randomSignedDecimal(): string {
  for (;;) {
    let value = 0n;
    for (const byte of randomBytes(8)) value = (value << 8n) | BigInt(byte);
    value &= INT63_MASK;
    if (value < ANTIGRAVITY_RANDOM_BOUND) return `-${value.toString()}`;
  }
}

function firstUserText(context: PiContext): string | undefined {
  for (const m of context.messages) {
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    return m.content.find((c): c is TextContent => c.type === "text")?.text;
  }
  return undefined;
}

export function buildRequest(
  model: PiModel,
  context: PiContext,
  projectId: string,
  options: PiSimpleStreamOptions | undefined,
  isAntigravity: boolean,
): CloudCodeAssistRequest {
  const meta = wireModel(model.provider, model.id);
  const choice = chooseThinking(model, meta, options);
  const contents = convertMessages(model, meta, context);
  const generationConfig: NonNullable<CloudCodeAssistRequest["request"]["generationConfig"]> = {};
  if (options?.temperature !== undefined) generationConfig.temperature = options.temperature;
  if (choice.maxTokens !== undefined) generationConfig.maxOutputTokens = choice.maxTokens;
  if (choice.thinking !== undefined) generationConfig.thinkingConfig = choice.thinking;

  const request: CloudCodeAssistRequest["request"] = { contents };
  const system = context.systemPrompt?.trim() ? context.systemPrompt : undefined;
  if (system !== undefined) {
    request.systemInstruction = { ...(isAntigravity ? { role: "user" } : {}), parts: [{ text: system }] };
  }
  const isClaude = meta?.identity === "anthropic";
  if (context.tools && context.tools.length > 0) {
    const tools = convertTools(context.tools, meta, isAntigravity);
    if (tools !== undefined) request.tools = tools;
    if (options?.toolChoice === "none") request.toolConfig = { functionCallingConfig: { mode: "NONE" } };
    // Antigravity's default tool mode is VALIDATED; an explicit choice wins.
    if (isAntigravity && request.toolConfig === undefined) {
      request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
    }
  }
  // Claude on Antigravity always forces VALIDATED, even with no tools declared.
  if (isAntigravity && isClaude && meta?.compat.antigravityClaudeToolMode) {
    request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
  }

  const wireModelId = choice.wireModelId;
  if (isAntigravity) {
    const profile = ANTIGRAVITY_MODEL_WIRE_PROFILES[wireModelId];
    if (profile !== undefined) generationConfig.maxOutputTokens = profile.maxOutputTokens;
    const agentId = randomUUID();
    const trajectoryId = randomUUID();
    const text = firstUserText(context);
    const sessionId = text !== undefined && text.trim().length > 0 ? signedDecimalFromHash(text) : randomSignedDecimal();
    const step = 2;
    const labels: Record<string, string> = { last_step_index: String(step - 1) };
    if (profile?.modelEnum !== undefined) labels.model_enum = profile.modelEnum;
    labels.trajectory_id = trajectoryId;
    const usageLabel = meta?.compat.antigravityUsageLabel ?? String(isClaude);
    labels.used_claude = usageLabel;
    labels.used_claude_conservative = usageLabel;
    request.labels = labels;
    if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;
    request.sessionId = sessionId;
    return {
      project: projectId,
      requestId: `agent/${agentId}/${Date.now()}/${trajectoryId}/${step}`,
      request,
      model: wireModelId,
      userAgent: "antigravity",
      requestType: "agent",
    };
  }
  if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;
  return { project: projectId, model: wireModelId, request };
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

/** `data:` payloads of a `text/event-stream` body, one JSON value per event. */
export async function* readSseJson(body: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const flush = function* (): Generator<unknown> {
    if (data.length === 0) return;
    const payload = data.join("\n");
    data = [];
    if (payload.trim() === "" || payload.trim() === "[DONE]") return;
    try {
      yield JSON.parse(payload) as unknown;
    } catch {
      throw new Error(`Cloud Code Assist stream: malformed event data: ${payload.slice(0, 200)}`);
    }
  };
  const take = function* (line: string): Generator<unknown> {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line === "") {
      yield* flush();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
    // `event:`, `id:`, `retry:` and `:` comments carry nothing this protocol uses.
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      yield* take(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield* take(buffer);
  yield* flush();
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

function emptyUsage(): AssistantMessage["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function mapStopReason(reason: string): AssistantMessage["stopReason"] {
  if (reason === "STOP") return "stop";
  if (reason === "MAX_TOKENS") return "length";
  return "error";
}

let toolCallCounter = 0;
function nextToolCallId(name: string): string {
  toolCallCounter += 1;
  return `${name}_${Date.now()}_${toolCallCounter}`;
}

function requestHeaders(
  model: PiModel,
  meta: WireModel | undefined,
  accessToken: string,
  isAntigravity: boolean,
  extra: PiSimpleStreamOptions["headers"],
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    ...(isAntigravity ? { "User-Agent": antigravityUserAgent() } : geminiCliHeaders(model.id)),
  };
  if (meta?.compat.claudeThinkingBetaHeader && meta.identity === "anthropic" && model.reasoning) {
    headers["anthropic-beta"] = CLAUDE_THINKING_BETA_HEADER;
  }
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === null) {
      for (const existing of Object.keys(headers)) if (existing.toLowerCase() === key.toLowerCase()) delete headers[existing];
    } else {
      headers[key] = value;
    }
  }
  return headers;
}

export interface CcaStreamDeps {
  /** Used when Pi passes no `fetch` in the stream options. Defaults to the global fetch. */
  fetch?: FetchLike;
}

async function run(
  stream: CcaEventStream,
  model: PiModel,
  context: PiContext,
  options: PiSimpleStreamOptions | undefined,
  deps: CcaStreamDeps,
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
  const signal = options?.signal;
  try {
    const apiKey = options?.apiKey;
    if (!apiKey) {
      throw new Error(`Google Cloud Code Assist requires OAuth authentication. Run \`lykos login ${model.provider}\`.`);
    }
    const isAntigravity = model.provider === "google-antigravity";
    const creds = parseStructuredApiKey(apiKey, model.provider);
    const meta = wireModel(model.provider, model.id);
    const fallback = isAntigravity ? ANTIGRAVITY_DAILY_ENDPOINT : DEFAULT_ENDPOINT;
    const endpoint = (model.baseUrl?.trim() || fallback).replace(/\/+$/, "");

    let body: unknown = buildRequest(model, context, creds.projectId, options, isAntigravity);
    const replaced = await options?.onPayload?.(body, model);
    if (replaced !== undefined) body = replaced;
    const headers = requestHeaders(model, meta, creds.accessToken, isAntigravity, options?.headers);
    const fetchImpl = options?.fetch ?? deps.fetch ?? globalThis.fetch;

    const response = await fetchImpl(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(signal !== undefined ? { signal } : {}),
    });
    await options?.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers.entries()) }, model);
    if (!response.ok) {
      const text = await response.text();
      const validationUrl = extractGoogleValidationUrl(text);
      const detail = validationUrl
        ? formatGoogleValidationRequiredMessage(validationUrl, "retry your request", creds.email)
        : text;
      throw new Error(`Cloud Code Assist API error: ${response.status} ${detail}`);
    }
    if (!response.body) throw new Error("Cloud Code Assist API returned no response body");

    let started = false;
    const ensureStarted = (): void => {
      if (started) return;
      started = true;
      stream.push({ type: "start", partial: output });
    };
    // A holder, not a `let`: the closures below reassign it, which TS narrowing cannot see.
    const open: { block: TextContent | ThinkingContent | null } = { block: null };
    const index = (): number => output.content.length - 1;
    const endCurrent = (): void => {
      const current = open.block;
      if (current === null) return;
      if (current.type === "text") stream.push({ type: "text_end", contentIndex: index(), content: current.text, partial: output });
      else stream.push({ type: "thinking_end", contentIndex: index(), content: current.thinking, partial: output });
      open.block = null;
    };
    const startBlock = (thinking: boolean): TextContent | ThinkingContent => {
      const current = open.block;
      if (current !== null && (current.type === "thinking") === thinking) return current;
      endCurrent();
      const block: TextContent | ThinkingContent = thinking ? { type: "thinking", thinking: "" } : { type: "text", text: "" };
      output.content.push(block);
      ensureStarted();
      stream.push(thinking ? { type: "thinking_start", contentIndex: index(), partial: output } : { type: "text_start", contentIndex: index(), partial: output });
      open.block = block;
      return block;
    };
    const retain = (existing: string | undefined, incoming: string | undefined): string | undefined =>
      typeof incoming === "string" && incoming.length > 0 ? incoming : existing;

    let sawFinishReason = false;
    for await (const raw of readSseJson(response.body as AsyncIterable<Uint8Array>)) {
      const chunk = raw as ResponseChunk;
      if (chunk.error) {
        const e = chunk.error;
        const parts = [e.code !== undefined ? String(e.code) : undefined, e.status, e.message].filter((p) => p !== undefined && p !== "");
        throw new Error(`Cloud Code Assist stream error: ${parts.join(" ") || "unknown error"}`);
      }
      const data = chunk.response;
      if (!data) continue;
      if (data.responseId) output.responseId = data.responseId;
      if (data.modelVersion) output.responseModel = data.modelVersion;
      if (!data.candidates?.length && data.promptFeedback?.blockReason) {
        const detail = data.promptFeedback.blockReasonMessage;
        throw new Error(`Request blocked by Google (${data.promptFeedback.blockReason})${detail ? `: ${detail}` : ""}`);
      }
      const candidate = data.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.text !== undefined && part.text !== "") {
          if (part.thought === true) {
            const block = startBlock(true) as ThinkingContent;
            block.thinking += part.text;
            const sig = retain(block.thinkingSignature, part.thoughtSignature);
            if (sig !== undefined) block.thinkingSignature = sig;
            stream.push({ type: "thinking_delta", contentIndex: index(), delta: part.text, partial: output });
          } else {
            const block = startBlock(false) as TextContent;
            block.text += part.text;
            const sig = retain(block.textSignature, part.thoughtSignature);
            if (sig !== undefined) block.textSignature = sig;
            stream.push({ type: "text_delta", contentIndex: index(), delta: part.text, partial: output });
          }
        } else if (part.text === "" && part.thoughtSignature && !part.functionCall && open.block !== null) {
          const block = open.block;
          if (block.type === "thinking") block.thinkingSignature = part.thoughtSignature;
          else block.textSignature = part.thoughtSignature;
        }
        if (part.functionCall) {
          endCurrent();
          const provided = part.functionCall.id;
          const needsNewId = !provided || output.content.some((b) => b.type === "toolCall" && b.id === provided);
          const toolCall: ToolCall = {
            type: "toolCall",
            id: needsNewId ? nextToolCallId(part.functionCall.name || "tool") : provided,
            name: part.functionCall.name || "",
            arguments: (part.functionCall.args ?? {}) as Record<string, unknown>,
            ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
          };
          output.content.push(toolCall);
          ensureStarted();
          const at = index();
          stream.push({ type: "toolcall_start", contentIndex: at, partial: output });
          stream.push({ type: "toolcall_delta", contentIndex: at, delta: JSON.stringify(toolCall.arguments), partial: output });
          stream.push({ type: "toolcall_end", contentIndex: at, toolCall, partial: output });
        }
      }

      if (candidate?.finishReason) {
        sawFinishReason = true;
        const mapped = mapStopReason(candidate.finishReason);
        // Only a benign finish is upgraded by a trailing tool call; SAFETY and the like must surface.
        if ((mapped === "stop" || mapped === "length") && output.content.some((b) => b.type === "toolCall")) {
          output.stopReason = "toolUse";
        } else {
          output.stopReason = mapped;
          if (mapped === "error") output.errorMessage = `Generation failed with finish reason: ${candidate.finishReason}`;
        }
      }

      const usage = data.usageMetadata;
      if (usage) {
        // promptTokenCount includes cachedContentTokenCount.
        const prompt = usage.promptTokenCount || 0;
        const cached = usage.cachedContentTokenCount || 0;
        const thoughts = usage.thoughtsTokenCount || 0;
        output.usage = {
          input: prompt - cached,
          output: (usage.candidatesTokenCount || 0) + thoughts,
          cacheRead: cached,
          cacheWrite: 0,
          ...(usage.thoughtsTokenCount !== undefined ? { reasoning: thoughts } : {}),
          totalTokens: usage.totalTokenCount || 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        };
      }
    }
    endCurrent();

    if (output.stopReason === "error" || output.stopReason === "aborted") {
      throw new Error(output.errorMessage ?? "An unknown error occurred");
    }
    const meaningful = output.content.some((b) => b.type === "toolCall" || (b.type === "text" && b.text.trim().length > 0));
    if (!meaningful) {
      const thoughtOnly = output.content.some((b) => b.type === "thinking" && b.thinking.trim().length > 0);
      throw new Error(
        thoughtOnly
          ? "Cloud Code Assist API returned a thought-only response without final output"
          : "Cloud Code Assist API returned an empty response",
      );
    }
    if (!sawFinishReason) {
      throw new Error("Cloud Code Assist stream ended without a finish reason (connection dropped or response truncated)");
    }
    stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
    stream.end();
  } catch (error) {
    output.stopReason = signal?.aborted ? "aborted" : "error";
    output.errorMessage = signal?.aborted ? "Request was aborted" : error instanceof Error ? error.message : String(error);
    stream.push({ type: "error", reason: output.stopReason, error: output });
    stream.end();
  }
}

/** The Cloud Code Assist `streamSimple` both Google providers register. */
export function createCcaStreamSimple(deps: CcaStreamDeps = {}): StreamSimpleFn {
  return (model, context, options) => {
    const stream = new CcaEventStream();
    void run(stream, model, context, options, deps);
    return stream as unknown as PiEventStream;
  };
}
