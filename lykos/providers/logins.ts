// Provider configurations for Z.ai, Kilo, GitLab Duo, and Muse, Cursor, GitLab Duo Agent, and
// Devin.
//
// Exports `loginProviders(opts)` returning ProviderConfigInput for the seven providers.
// For Z.ai (a Pi builtin) only `oauth` is registered, keeping Pi's native stream and models.
// For Kilo, GitLab Duo, and Muse, the registration carries api, baseUrl, models (unpriced, rule 5),
// and oauth. GitLab Duo also carries Lykos's own `streamSimple` delegating to Anthropic.

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { BUILTIN_PROVIDERS } from "../config/provider-table.js";
import type { ProviderConfigInput } from "../session/model-runtime.js";
import { type CursorProviderOptions, cursorProvider } from "./cursor/register.js";
import { type DevinProviderOptions, devinProvider } from "./devin/register.js";
import { type GitLabDuoAgentProviderOptions, gitlabDuoAgentProvider } from "./gitlab-duo-agent/register.js";
import { type GitLabDuoOAuthDeps, loginGitLabDuo, refreshGitLabDuo } from "./gitlab-duo/oauth.js";
import { createGitLabDuoStreamSimple } from "./gitlab-duo/stream.js";
import { type KiloOAuthDeps, loginKilo } from "./kilo/oauth.js";
import { type MuseOAuthDeps, loginMuse, parseMuseCodeCredential } from "./muse/oauth.js";
import { type ZaiOAuthDeps, loginZai } from "./zai/oauth.js";

type ModelInput = NonNullable<ProviderConfigInput["models"]>[number];

/** Zero cost: Lykos takes prices only from primary provider documentation (rule 5). */
const UNPRICED: ModelInput["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function modelsFor(provider: string, baseUrlOverride?: string): ModelInput[] {
  const table = BUILTIN_PROVIDERS[provider];
  if (table === undefined) throw new Error(`the generated provider table has no ${provider}`);
  return table.models.map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    reasoning: m.reasoning ?? false,
    input: (m.input ?? ["text"]).filter((i): i is "text" | "image" => i === "text" || i === "image"),
    cost: { ...UNPRICED },
    contextWindow: m.contextWindow ?? 128_000,
    maxTokens: m.maxTokens ?? 16_384,
    baseUrl: baseUrlOverride ?? m.baseUrl ?? table.baseUrl,
  }));
}

export interface LoginProvidersOptions {
  /** Late-bound getter for the created ModelRuntime instance (needed for GitLab Duo delegation). */
  runtime?: () => ModelRuntime;
  zai?: ZaiOAuthDeps;
  kilo?: KiloOAuthDeps & { baseUrl?: string };
  gitlabDuo?: GitLabDuoOAuthDeps & {
    baseUrl?: string;
    directAccessUrl?: string;
    now?: () => number;
    fetch?: typeof fetch;
  };
  muse?: MuseOAuthDeps & { baseUrl?: string };
  /** Cursor (ticket 12): login deps, stream base URL and transport. */
  cursor?: CursorProviderOptions;
  /** GitLab Duo Agent (ticket 13): login deps, GitLab base URL, socket factory, timeouts. */
  gitlabDuoAgent?: GitLabDuoAgentProviderOptions;
  /** Devin (ticket 14): login deps (callback port, token URL), stream base URL and fetch. */
  devin?: DevinProviderOptions;
}

function makeNoRefreshHandler(providerName: string) {
  return async (credentials: any) => {
    if (typeof credentials.expires === "number" && Date.now() >= credentials.expires) {
      throw new Error(`${providerName} token has expired; run \`lykos login ${providerName}\` again`);
    }
    return credentials;
  };
}

/**
 * Returns the login providers' ProviderConfigInputs for `registerProvider`:
 * - `zai`: Pi builtin, registers only `oauth`.
 * - `kilo`: carries `api`, `baseUrl`, `models`, `oauth`.
 * - `gitlab-duo`: carries `api`, `baseUrl`, `models`, `streamSimple`, `oauth`.
 * - `muse-code`: carries `api`, `baseUrl`, `headers`, `models`, `oauth`.
 * - `cursor`: carries `api`, `baseUrl`, `models`, `streamSimple`, `oauth` (ticket 12).
 * - `gitlab-duo-agent`: carries `api`, `baseUrl`, `models`, `streamSimple`, `oauth` (ticket 13).
 * - `devin`: carries `api`, `baseUrl`, `models`, `streamSimple`, `oauth` (ticket 14).
 */
export function loginProviders(opts: LoginProvidersOptions = {}): Record<string, ProviderConfigInput> {
  const kiloTable = BUILTIN_PROVIDERS["kilo"];
  const gitlabTable = BUILTIN_PROVIDERS["gitlab-duo"];
  const museTable = BUILTIN_PROVIDERS["muse-code"];

  const out: Record<string, ProviderConfigInput> = {
    // 1. Z.ai (Pi builtin, register only oauth)
    zai: {
      oauth: {
        name: "Z.AI (GLM Coding Plan · Sign in)",
        isSubscription: true,
        login: (callbacks) => loginZai(callbacks, opts.zai),
        refreshToken: makeNoRefreshHandler("zai"),
        getApiKey: (credentials) => credentials.access,
      },
    },

    // 2. Kilo Gateway
    kilo: {
      name: "Kilo Gateway",
      api: kiloTable?.api ?? "openai-completions",
      baseUrl: opts.kilo?.baseUrl ?? kiloTable?.baseUrl ?? "https://api.kilo.ai/api/gateway",
      models: modelsFor("kilo", opts.kilo?.baseUrl),
      oauth: {
        name: "Kilo Gateway",
        isSubscription: true,
        login: (callbacks) => loginKilo(callbacks, opts.kilo),
        refreshToken: makeNoRefreshHandler("kilo"),
        getApiKey: (credentials) => credentials.access,
      },
    },

    // 3. GitLab Duo
    "gitlab-duo": {
      name: "GitLab Duo Non-Agentic",
      api: "anthropic-messages",
      baseUrl: opts.gitlabDuo?.baseUrl ?? gitlabTable?.baseUrl ?? "https://cloud.gitlab.com/ai/v1/proxy/anthropic/",
      ...(opts.runtime !== undefined
        ? {
            streamSimple: createGitLabDuoStreamSimple({
              runtime: opts.runtime,
              ...(opts.gitlabDuo?.directAccessUrl !== undefined ? { directAccessUrl: opts.gitlabDuo.directAccessUrl } : {}),
              ...(opts.gitlabDuo?.now !== undefined ? { now: opts.gitlabDuo.now } : {}),
              ...(opts.gitlabDuo?.fetch !== undefined ? { fetch: opts.gitlabDuo.fetch } : {}),
            }),
          }
        : {}),
      models: modelsFor("gitlab-duo", opts.gitlabDuo?.baseUrl),
      oauth: {
        name: "GitLab Duo Non-Agentic",
        isSubscription: true,
        login: (callbacks) => loginGitLabDuo(callbacks, opts.gitlabDuo),
        refreshToken: (credentials, signal) => refreshGitLabDuo(credentials, opts.gitlabDuo, signal),
        getApiKey: (credentials) => credentials.access,
      },
    },

    // 4. Muse Code
    "muse-code": {
      name: "Muse Code (Subscription)",
      api: museTable?.api ?? "openai-responses",
      baseUrl: opts.muse?.baseUrl ?? museTable?.baseUrl ?? "https://api.meta.ai/v1",
      headers: { "x-api-version": "1.0.0" },
      models: modelsFor("muse-code", opts.muse?.baseUrl),
      oauth: {
        name: "Muse Code (Subscription)",
        isSubscription: true,
        login: (callbacks) => loginMuse(callbacks, opts.muse),
        refreshToken: makeNoRefreshHandler("muse-code"),
        getApiKey: (credentials) => parseMuseCodeCredential(credentials.access).apiKey,
      },
    },

    // 5. Cursor (ticket 12): Lykos's own `cursor-agent` stream and login.
    cursor: cursorProvider(opts.cursor),

    // 6. GitLab Duo Agent (ticket 13): Lykos's own `gitlab-duo-agent` stream and login.
    "gitlab-duo-agent": gitlabDuoAgentProvider(opts.gitlabDuoAgent),

    // 7. Devin (ticket 14): Lykos's own `devin-agent` stream and login.
    devin: devinProvider(opts.devin),
  };

  return out;
}
