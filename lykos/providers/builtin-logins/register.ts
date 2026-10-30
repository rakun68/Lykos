// Lykos's own logins for three Pi builtins: Anthropic, OpenAI Codex, GitHub
// Copilot.
//
// The seam keeps Pi's request auth. For each id, the provider Pi built
// (`runtime.getProvider(id)`) is wrapped with `Object.create`, so every member reaches the
// builtin through the prototype (`getModels`, `stream`, `streamSimple`, `filterModels`,
// `refreshModels`, `auth.apiKey`, `auth.oauth.toAuth`, …), and only `auth.oauth.login` and
// `auth.oauth.refresh` are Lykos's. The wrapper is registered with `registerNativeProvider`.
// A `registerProvider` overlay cannot do this: Pi's `adaptOAuth` (core/provider-composer.js)
// returns only `{ apiKey }`, which would drop Copilot's per-credential `baseUrl`.

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type AnthropicOAuthDeps, loginAnthropic, refreshAnthropic } from "../anthropic/oauth.js";
import { type CopilotOAuthDeps, loginCopilot, refreshCopilot } from "../github-copilot/oauth.js";
import { type KimiOAuthDeps, loginKimi, refreshKimi } from "../kimi-coding/oauth.js";
import { type CodexOAuthDeps, loginCodex, refreshCodex } from "../openai-codex/oauth.js";
import { type OpenRouterOAuthDeps, loginOpenRouter, refreshOpenRouter } from "../openrouter/oauth.js";
import { type XaiOAuthDeps, loginXai, refreshXai } from "../xai/oauth.js";
import type { LoginInteraction, NativeOAuth, NativeProvider, OAuthCredential } from "./code-flow.js";

export const BUILTIN_LOGIN_PROVIDERS = [
  "anthropic",
  "openai-codex",
  "github-copilot",
  "openrouter",
  "kimi-coding",
  "xai",
] as const;
export type BuiltinLoginProvider = (typeof BUILTIN_LOGIN_PROVIDERS)[number];

export interface BuiltinLoginOptions {
  anthropic?: AnthropicOAuthDeps;
  openaiCodex?: CodexOAuthDeps;
  githubCopilot?: CopilotOAuthDeps;
  openrouter?: OpenRouterOAuthDeps;
  kimiCoding?: KimiOAuthDeps;
  xai?: XaiOAuthDeps;
}

interface Flow {
  login(interaction: LoginInteraction): Promise<OAuthCredential>;
  refresh(credential: OAuthCredential, signal: AbortSignal): Promise<OAuthCredential>;
}

function flowFor(id: BuiltinLoginProvider, builtin: NativeProvider, opts: BuiltinLoginOptions): Flow {
  switch (id) {
    case "anthropic":
      return {
        login: (interaction) => loginAnthropic(interaction, opts.anthropic),
        refresh: (credential, signal) => refreshAnthropic(credential, opts.anthropic, signal),
      };
    case "openai-codex":
      return {
        login: (interaction) => loginCodex(interaction, opts.openaiCodex),
        refresh: (credential, signal) => refreshCodex(credential, opts.openaiCodex, signal),
      };
    case "github-copilot": {
      // Pi's policy step only enables ids its own catalog knows (`GITHUB_COPILOT_MODELS`);
      // the builtin's model list is that catalog.
      const deps: CopilotOAuthDeps = {
        knownModelIds: () => builtin.getModels().map((m) => m.id),
        ...opts.githubCopilot,
      };
      return {
        login: (interaction) => loginCopilot(interaction, deps),
        refresh: (credential, signal) => refreshCopilot(credential, deps, signal),
      };
    }
    case "openrouter":
      return {
        login: (interaction) => loginOpenRouter(interaction, opts.openrouter),
        refresh: (credential, signal) => refreshOpenRouter(credential, opts.openrouter, signal),
      };
    case "kimi-coding":
      return {
        login: (interaction) => loginKimi(interaction, opts.kimiCoding),
        refresh: (credential, signal) => refreshKimi(credential, opts.kimiCoding, signal),
      };
    case "xai":
      return {
        login: (interaction) => loginXai(interaction, opts.xai),
        refresh: (credential, signal) => refreshXai(credential, opts.xai, signal),
      };
  }
}

/**
 * The wrapper: `builtin` as prototype, an own `auth` whose `oauth` keeps the builtin's
 * `name`, `isSubscription`, `loginLabel` and `toAuth`, with Lykos's `login` and `refresh`.
 */
export function wrapBuiltinLogin(id: BuiltinLoginProvider, builtin: NativeProvider, opts: BuiltinLoginOptions = {}): NativeProvider {
  const oauth = builtin.auth.oauth;
  if (oauth === undefined) throw new Error(`Pi's ${id} provider has no OAuth login to replace`);
  const flow = flowFor(id, builtin, opts);
  const wrappedOAuth: NativeOAuth = {
    ...oauth,
    login: flow.login,
    refresh: flow.refresh,
    toAuth: oauth.toAuth,
  };
  return Object.create(builtin, {
    auth: { value: { ...builtin.auth, oauth: wrappedOAuth }, enumerable: true },
  }) as NativeProvider;
}

/** Replace the three builtins' login and refresh on `runtime`. A builtin Pi does not ship is skipped. */
export function registerBuiltinLogins(runtime: ModelRuntime, opts: BuiltinLoginOptions = {}): void {
  for (const id of BUILTIN_LOGIN_PROVIDERS) {
    const builtin = runtime.getProvider(id);
    if (builtin === undefined || builtin.auth.oauth === undefined) continue;
    runtime.registerNativeProvider(wrapBuiltinLogin(id, builtin, opts));
  }
}
