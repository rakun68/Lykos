// Registration of the GitLab Duo Agent provider.
//
// `gitlabDuoAgentProvider()` returns what `registerProvider` takes: api `gitlab-duo-agent`,
// the base URL and models from ticket 03's generated table (zero cost, rule 5), Lykos's own
// `streamSimple`, and the pasted-callback OAuth login and refresh. Pi is not patched.

import { BUILTIN_PROVIDERS } from "../../config/provider-table.js";
import type { ProviderConfigInput } from "../google-cca/types.js";
import { type GitLabDuoAgentOAuthDeps, loginGitLabDuoAgent, refreshGitLabDuoAgent } from "./oauth.js";
import { createGitLabDuoAgentStreamSimple, GITLAB_DUO_WORKFLOW_API, type GitLabDuoAgentStreamDeps } from "./stream.js";

export interface GitLabDuoAgentProviderOptions extends GitLabDuoAgentOAuthDeps, Omit<GitLabDuoAgentStreamDeps, "fetch"> {
  /** The GitLab instance. Defaults to the generated table's (`https://gitlab.com`). */
  baseUrl?: string;
}

type ModelInput = NonNullable<ProviderConfigInput["models"]>[number];

const UNPRICED: ModelInput["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** The `gitlab-duo-agent` provider, ready for `registerProvider`. */
export function gitlabDuoAgentProvider(opts: GitLabDuoAgentProviderOptions = {}): ProviderConfigInput {
  const table = BUILTIN_PROVIDERS["gitlab-duo-agent"];
  if (table === undefined) throw new Error("the generated provider table has no gitlab-duo-agent");
  const { baseUrl: baseUrlOverride, webSocketFactory, idleTimeoutMs, restTimeoutMs, env, cwd, ...oauthDeps } = opts;
  const baseUrl = baseUrlOverride ?? table.baseUrl;
  return {
    name: "GitLab Duo Agent",
    api: GITLAB_DUO_WORKFLOW_API,
    baseUrl,
    streamSimple: createGitLabDuoAgentStreamSimple({
      ...(webSocketFactory !== undefined ? { webSocketFactory } : {}),
      ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
      ...(restTimeoutMs !== undefined ? { restTimeoutMs } : {}),
      ...(env !== undefined ? { env } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(oauthDeps.fetch !== undefined ? { fetch: oauthDeps.fetch } : {}),
    }),
    models: table.models.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      reasoning: m.reasoning ?? false,
      input: (m.input ?? ["text"]).filter((i): i is "text" | "image" => i === "text" || i === "image"),
      cost: { ...UNPRICED },
      contextWindow: m.contextWindow ?? 128_000,
      maxTokens: m.maxTokens ?? 16_384,
      baseUrl,
    })),
    oauth: {
      name: "GitLab Duo Agent",
      isSubscription: true,
      login: (callbacks) => loginGitLabDuoAgent(callbacks, oauthDeps),
      refreshToken: (credentials, signal) =>
        refreshGitLabDuoAgent(credentials as Parameters<typeof refreshGitLabDuoAgent>[0], oauthDeps, signal),
      getApiKey: (credentials) => credentials.access,
    },
  };
}
