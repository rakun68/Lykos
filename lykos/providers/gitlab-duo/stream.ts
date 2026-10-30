// GitLab Duo streamSimple adapter.
//
// Receives the resolved GitLab token as options.apiKey, exchanges it for a direct access
// gateway token plus headers (cached 25 min), and delegates to Pi's own streamSimple.
// Defaults to runtime.getProvider("anthropic")!.streamSimple for anthropic-messages,
// or runtime.getProvider("openai")!.streamSimple for openai-responses.

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { BUILTIN_PROVIDERS } from "../../config/provider-table.js";
import { CcaEventStream } from "../google-cca/stream.js";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  PiContext,
  PiEventStream,
  PiModel,
  PiSimpleStreamOptions,
  StreamSimpleFn,
} from "../google-cca/types.js";
import { getDirectAccessToken, GITLAB_DIRECT_ACCESS_URL } from "./oauth.js";

export interface GitLabDuoStreamSimpleDeps {
  runtime: () => ModelRuntime;
  directAccessUrl?: string;
  now?: () => number;
  fetch?: typeof fetch;
}

export function createGitLabDuoStreamSimple(deps: GitLabDuoStreamSimpleDeps): StreamSimpleFn {
  return (model: PiModel, context: PiContext, options?: PiSimpleStreamOptions) => {
    const stream = new CcaEventStream();
    void run(stream, model, context, options, deps);
    return stream as unknown as PiEventStream;
  };
}

async function run(
  stream: CcaEventStream,
  model: PiModel,
  context: PiContext,
  options: PiSimpleStreamOptions | undefined,
  deps: GitLabDuoStreamSimpleDeps,
): Promise<void> {
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

  try {
    const gitlabToken = typeof options?.apiKey === "string" ? options.apiKey : "";
    if (!gitlabToken) {
      throw new Error("Missing GitLab access token");
    }
    const fetchImpl = options?.fetch ?? deps.fetch ?? globalThis.fetch;
    const directAccessUrl = deps.directAccessUrl ?? GITLAB_DIRECT_ACCESS_URL;
    const directAccess = await getDirectAccessToken(
      gitlabToken,
      fetchImpl,
      directAccessUrl,
      deps.now,
    );
    const headers = {
      ...directAccess.headers,
      ...options?.headers,
    };

    const rt = deps.runtime();
    const tableModel = BUILTIN_PROVIDERS["gitlab-duo"]?.models.find((m) => m.id === model.id);
    const api = tableModel?.api ?? model.api;

    let targetProviderId: string;
    if (api === "anthropic-messages") {
      targetProviderId = "anthropic";
    } else if (api === "openai-responses") {
      targetProviderId = "openai";
    } else {
      throw new Error(`Unsupported api "${api}" for GitLab Duo model "${model.id}"`);
    }

    const targetProvider = rt.getProvider(targetProviderId);
    if (!targetProvider?.streamSimple) {
      throw new Error(`Target provider "${targetProviderId}" not available for GitLab Duo streaming`);
    }

    const delegateStream = await targetProvider.streamSimple(
      model,
      context,
      {
        ...options,
        apiKey: directAccess.token,
        headers,
      },
    );

    for await (const event of delegateStream) {
      stream.push(event as AssistantMessageEvent);
    }

    if (typeof (delegateStream as any).result === "function") {
      try {
        const finalMsg = await (delegateStream as any).result();
        stream.end(finalMsg);
      } catch {
        stream.end();
      }
    } else {
      stream.end();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.stopReason = "error";
    output.errorMessage = message;
    stream.push({ type: "error", reason: "error", error: output });
    stream.end(output);
  }
}
