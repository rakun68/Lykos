// Pi types for the Cloud Code Assist provider.
//
// `@earendil-works/pi-ai` is not resolvable from Lykos, so every Pi type this
// provider needs is derived from `ModelRuntime`'s exported signatures.

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Pi's `ProviderConfigInput` (`registerProvider`'s second argument). */
export type ProviderConfigInput = Parameters<ModelRuntime["registerProvider"]>[1];
export type ExtensionOAuthConfig = NonNullable<ProviderConfigInput["oauth"]>;
export type OAuthLoginCallbacks = Parameters<ExtensionOAuthConfig["login"]>[0];
export type OAuthCredentials = Awaited<ReturnType<ExtensionOAuthConfig["login"]>>;

export type StreamSimpleFn = NonNullable<ProviderConfigInput["streamSimple"]>;
export type PiModel = Parameters<StreamSimpleFn>[0];
export type PiContext = Parameters<StreamSimpleFn>[1];
export type PiSimpleStreamOptions = NonNullable<Parameters<StreamSimpleFn>[2]>;
export type PiEventStream = ReturnType<StreamSimpleFn>;
export type AssistantMessageEvent = PiEventStream extends AsyncIterable<infer E> ? E : never;
export type AssistantMessage = Awaited<ReturnType<PiEventStream["result"]>>;
export type PiMessage = PiContext["messages"][number];
export type PiTool = NonNullable<PiContext["tools"]>[number];
export type TextContent = Extract<AssistantMessage["content"][number], { type: "text" }>;
export type ThinkingContent = Extract<AssistantMessage["content"][number], { type: "thinking" }>;
export type ToolCall = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

export type FetchLike = typeof globalThis.fetch;

/** The two providers that speak Cloud Code Assist. */
export type GoogleCcaProviderId = "google-antigravity" | "google-gemini-cli";
