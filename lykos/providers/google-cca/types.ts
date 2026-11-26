// Pi types for the Cloud Code Assist provider and the other custom stream providers.
//
// Since Pi 1.6.1 a provider receives a `TranscriptContext`: the system prompt and
// tool declarations travel as system messages in the transcript. These providers
// speak APIs with one system prompt and one tool list, so each stream entry point
// flattens the transcript once with `flattenTranscript` and works on `PiContext`.

import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import type { Message, SystemMessage, Tool } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Pi's `ProviderConfigInput` (`registerProvider`'s second argument). */
export type ProviderConfigInput = Parameters<ModelRuntime["registerProvider"]>[1];
export type ExtensionOAuthConfig = NonNullable<ProviderConfigInput["oauth"]>;
export type OAuthLoginCallbacks = Parameters<ExtensionOAuthConfig["login"]>[0];
export type OAuthCredentials = Awaited<ReturnType<ExtensionOAuthConfig["login"]>>;

export type StreamSimpleFn = NonNullable<ProviderConfigInput["streamSimple"]>;
export type PiModel = Parameters<StreamSimpleFn>[0];
/** What Pi hands a stream function: the transcript, prompt and tools inside it. */
export type PiTranscript = Parameters<StreamSimpleFn>[1];
export type PiSimpleStreamOptions = NonNullable<Parameters<StreamSimpleFn>[2]>;
export type PiEventStream = ReturnType<StreamSimpleFn>;
export type AssistantMessageEvent = PiEventStream extends AsyncIterable<infer E> ? E : never;
export type AssistantMessage = Awaited<ReturnType<PiEventStream["result"]>>;
/** A transcript message other than a system message. */
export type PiMessage = Exclude<Message, SystemMessage>;
export type PiTool = Tool;

/** The flattened request these providers build from: one prompt, one tool list, no system messages. */
export interface PiContext {
  systemPrompt?: string;
  messages: PiMessage[];
  tools?: PiTool[];
}

/** Replays the transcript's system messages into one prompt and one tool list, and drops them from the messages. */
export function flattenTranscript(transcript: PiTranscript): PiContext {
  const systemPrompt = getCurrentSystemPrompt(transcript.messages);
  const tools = getCurrentTools(transcript.messages);
  return {
    ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
    messages: transcript.messages.filter((m): m is PiMessage => m.role !== "system"),
    ...(tools.length > 0 ? { tools } : {}),
  };
}
export type TextContent = Extract<AssistantMessage["content"][number], { type: "text" }>;
export type ThinkingContent = Extract<AssistantMessage["content"][number], { type: "thinking" }>;
export type ToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

export type FetchLike = typeof globalThis.fetch;

/** The two providers that speak Cloud Code Assist. */
export type GoogleCcaProviderId = "google-antigravity" | "google-gemini-cli";
