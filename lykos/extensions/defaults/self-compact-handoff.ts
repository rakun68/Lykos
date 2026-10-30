// P17 T190 -- the handoff side call.
//
// When the context has to be compacted and the
// agent left no note, one request writes it: the live conversation, as the
// live turn sends it, followed by the template's instruction to write the
// handoff document.
//
// **The request uses no tools: it sends the live turn's tools with tool choice
// `none`.** A provider caches a request's prefix, and the tools come first in
// it; a request that left them out would read the whole prefix cold.
//
// **The side call has its own `sessionId`; the live turn's cache key and
// session-affinity value are carried over by hand.** Pi's providers send
// `sessionId` in more places than the cache key -- Codex puts it in
// `session-id` and `x-client-request-id` headers and keys its websocket state
// by it, openai-responses sends `session_id` / `x-session-id` -- so reusing
// the live id would hand the live turn's provider session to the side call.
// Pi's options have only `sessionId`, so the key is put where each provider reads
// it: `onPayload` sets the payload's `prompt_cache_key` (OpenAI, Codex, Azure)
// or `promptCacheKey` (Mistral) to the value the live turn sent, which the
// extension observes on `before_provider_request` together with the model and
// provider it was sent to (a key from another model is never written). Anthropic's
// cache is keyed by the request's prefix, not an id; nothing is set for it.
// A model whose `compat.sendSessionAffinityHeaders` is set (anthropic-messages and
// openai-completions read it; Fireworks is one) routes by the session id in a
// header, and a side id would send the call to another replica and lose the
// cache: for those the live id goes in the same header(s) Pi would write
// (`affinityHeaders`), through the public `headers` option, which Pi merges
// last. Session state stays the side call's own; only routing matches.
//
// **Mirrored from the live request**: the model's auth and headers
// (`getApiKeyAndHeaders`), `reasoning` (the thinking level), `thinkingBudgets`
// and `transport` (the settings the live agent was built with, carried to the
// extension by the session's policy), the live system prompt, messages and
// tools, and `streamSimple` rather than `stream` so the thinking level is
// mapped by the provider as it is for the live turn. **Not mirrored**: other
// extensions' `before_provider_request` payload hooks and
// `before_provider_headers` hooks, and Pi's provider-attribution headers -- Pi
// runs those inside its own stream function and exposes no public way to call
// them -- and the live turn's retry and timeout options. A payload rewrite that
// places cache breakpoints would not be applied here; whether that changes the
// cache hit is unmeasured.
//
// **The document becomes Pi's compaction summary** (the extension returns it
// from `session_before_compact`). This file only asks for it and reports what
// the provider charged. A reply that is an error or empty is returned as a
// failure with its usage, not thrown away: the call was paid for either way.

import { convertToLlm, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SELF_COMPACT_HANDOFF_PROMPT } from "../../loop/self-compact-template.js";

type Complete = ExtensionContext["modelRegistry"]["complete"];

/** Pi's `Usage` for the call, as the provider reported it. */
export type HandoffUsage = Awaited<ReturnType<Complete>>["usage"];

/** The tools of a request, as Pi's `Context` carries them. */
export type HandoffTools = NonNullable<Parameters<Complete>[1]["tools"]>;

type Provider = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getProvider"]>>;
type SimpleStreamOptions = NonNullable<Parameters<Provider["streamSimple"]>[2]>;
type RequestModel = Parameters<Provider["streamSimple"]>[0];

/** The prompt-cache key the live turn sent, the payload field it was in, and the model it was sent to. */
export interface LiveCacheKey {
  field: "prompt_cache_key" | "promptCacheKey";
  value: string;
  provider: string;
  model: string;
}

/** What the live turn was sent with that the side call repeats. */
export interface LiveRequest {
  cacheKey?: LiveCacheKey | undefined;
  /** The live turn's session id, for routing headers (not for session state). */
  sessionId?: string | undefined;
  thinkingBudgets?: SimpleStreamOptions["thinkingBudgets"];
  transport?: SimpleStreamOptions["transport"];
}

/** The cache key in a payload sent to `model`, if it carries a defined one. */
export function observeCacheKey(payload: unknown, model: { provider: string; id: string } | undefined): LiveCacheKey | undefined {
  if (model === undefined || payload === null || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  for (const field of ["prompt_cache_key", "promptCacheKey"] as const) {
    const value = p[field];
    if (typeof value === "string" && value.length > 0) return { field, value, provider: model.provider, model: model.id };
  }
  return undefined;
}

/** Writes the live turn's cache key into a payload for the same model, if it has a field for one; any other payload is returned as it is. */
export function withLiveCacheKey<T>(payload: T, key: LiveCacheKey | undefined, model: { provider: string; id: string }): T {
  if (key === undefined || key.provider !== model.provider || key.model !== model.id) return payload;
  if (payload === null || typeof payload !== "object") return payload;
  const p = payload as Record<string, unknown>;
  if (key.field in p) p[key.field] = key.value;
  return payload;
}

/**
 * The `@earendil-works/pi-coding-agent` version `affinityHeaders` was copied from; a test
 * fails when the installed one differs. Pi runs the pi-ai copy bundled inside that package
 * (`dist/bundle`), so its version, which package.json pins exactly, is the one that counts.
 */
export const AFFINITY_HEADERS_READ_FROM_PI = "0.84.3";

/**
 * The routing headers Pi writes from the session id for a model that sets
 * `compat.sendSessionAffinityHeaders`, with the live turn's id. **Copied from
 * pi-coding-agent 0.84.3's pi-ai** (`api/openai-completions.js` and
 * `api/anthropic-messages.js` `createClient`), because Pi exposes no function for it.
 * Empty for any other model, and for anthropic-messages on the github-copilot or
 * OAuth-token paths, which never write it. Both providers also drop the id when
 * `cacheRetention` is "none"; that is not handled because Pi only sends "none" from its own
 * compaction, never from the live agent turn this call repeats.
 */
export function affinityHeaders(
  model: { api?: string; provider?: string; baseUrl?: string; compat?: unknown },
  liveSessionId: string | undefined,
  request: { apiKey?: string | undefined } = {},
): Record<string, string> {
  const compat = (model.compat ?? {}) as { sendSessionAffinityHeaders?: boolean; sessionAffinityFormat?: string };
  if (compat.sendSessionAffinityHeaders !== true || liveSessionId === undefined || liveSessionId.length === 0) return {};
  if (model.api === "anthropic-messages") {
    if (model.provider === "github-copilot" || (request.apiKey ?? "").includes("sk-ant-oat")) return {};
    return { "x-session-affinity": liveSessionId };
  }
  if (model.api !== "openai-completions") return {};
  const format = compat.sessionAffinityFormat ?? (model.provider === "openrouter" || (model.baseUrl ?? "").includes("openrouter.ai") ? "openrouter" : "openai");
  if (format === "openrouter") return { "x-session-id": liveSessionId };
  return {
    ...(format === "openai" ? { session_id: liveSessionId } : {}),
    "x-client-request-id": liveSessionId,
    "x-session-affinity": liveSessionId,
  };
}

export interface HandoffDocument {
  /** The note, trimmed. Empty when the call failed or the model wrote nothing. */
  document: string;
  /** Why there is no document: the provider's error, or that it wrote nothing. Absent when there is one. */
  failure?: string;
  /** What the provider reported for the call, present whenever it reported any -- also on a failure. */
  usage: HandoffUsage | undefined;
}

/**
 * Asks the active model for a handoff document. `messages` are the live
 * conversation as the live turn sent it (the caller rebuilds it, with the
 * prunes and shakes recorded so far, so the prefix matches); `tools` are the
 * live turn's tools. Throws only when the request could not be made at all,
 * in which case there is no usage to report.
 *
 * `focus` is what a person typed after `/compact`; the template's instruction
 * carries it as an extra focus block.
 */
export async function requestHandoffDocument(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "sessionManager" | "getSystemPrompt" | "thinkingLevel">,
  signal: AbortSignal,
  messages: ReadonlyArray<object>,
  tools: HandoffTools,
  live: LiveRequest,
  focus?: string,
): Promise<HandoffDocument> {
  const model = ctx.model;
  if (model === undefined) throw new Error("no model is selected, so no handoff note can be written");
  const registry = ctx.modelRegistry;
  const provider = registry.getProvider(model.provider);
  if (provider === undefined) throw new Error(`no provider ${model.provider} to send the handoff request to`);
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(auth.error);
  const instruction =
    focus !== undefined && focus.trim().length > 0
      ? `${SELF_COMPACT_HANDOFF_PROMPT}\n\n<instruction>\nAdditional focus: ${focus.trim()}\n</instruction>`
      : SELF_COMPACT_HANDOFF_PROMPT;
  const context = {
    systemPrompt: ctx.getSystemPrompt(),
    messages: convertToLlm([
      ...(messages as Parameters<typeof convertToLlm>[0]),
      { role: "user" as const, content: [{ type: "text" as const, text: instruction }], timestamp: Date.now() },
    ]),
    tools,
  };
  const requestModel = auth.baseUrl !== undefined ? { ...model, baseUrl: auth.baseUrl } : model;
  const thinking = ctx.thinkingLevel;
  const options: SimpleStreamOptions = {
    ...(auth.apiKey !== undefined ? { apiKey: auth.apiKey } : {}),
    headers: { ...(auth.headers ?? {}), ...affinityHeaders(requestModel, live.sessionId, { apiKey: auth.apiKey }) },
    ...(auth.env !== undefined ? { env: auth.env } : {}),
    // Its own session id, so the live turn's provider session state is not shared; the cache key rides the payload, routing the headers.
    sessionId: `${ctx.sessionManager.getSessionId()}:handoff:${Date.now().toString(36)}`,
    toolChoice: "none",
    ...(thinking !== undefined && thinking !== "off" ? { reasoning: thinking } : {}),
    ...(live.thinkingBudgets !== undefined ? { thinkingBudgets: live.thinkingBudgets } : {}),
    ...(live.transport !== undefined ? { transport: live.transport } : {}),
    onPayload: (payload: unknown) => withLiveCacheKey(payload, live.cacheKey, model),
    signal,
  };
  const stream = provider.streamSimple(requestModel, context, options);
  const response = await stream.result();
  const usage = response.usage;
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    return { document: "", failure: response.errorMessage ?? `the handoff request ended ${response.stopReason}`, usage };
  }
  const document = response.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return document.length === 0 ? { document, failure: "the side call returned an empty note", usage } : { document, usage };
}
