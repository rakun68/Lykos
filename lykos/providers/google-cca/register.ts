// Registration of the two Cloud Code Assist providers.
//
// `googleCcaProviders()` returns what `createLykosModelRuntime` hands to
// `ModelRuntime.registerProvider`: api `google-gemini-cli`, the base URL and
// model ids from ticket 03's generated table, Lykos's own `streamSimple`, and
// the OAuth login/refresh. Pi is not patched (AGENTS.md rule 7).

import { BUILTIN_PROVIDERS } from "../../config/provider-table.js";
import { type GoogleOAuthDeps, loginGoogle, refreshGoogle, structuredApiKey } from "./oauth.js";
import { GOOGLE_OAUTH_RULES } from "./rules.js";
import { createCcaStreamSimple } from "./stream.js";
import type { GoogleCcaProviderId, ProviderConfigInput } from "./types.js";

export const GOOGLE_CCA_API = "google-gemini-cli";
export const GOOGLE_CCA_PROVIDER_IDS: readonly GoogleCcaProviderId[] = ["google-antigravity", "google-gemini-cli"];

export interface GoogleCcaOptions extends GoogleOAuthDeps {
  /** Stream base URL for both providers. Defaults to each provider's URL in the generated table. */
  baseUrl?: string;
}

type ModelInput = NonNullable<ProviderConfigInput["models"]>[number];

/** Zero cost: Lykos takes prices only from primary provider documentation (rule 5), so these calls are unpriced. */
const UNPRICED: ModelInput["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function modelsFor(provider: GoogleCcaProviderId): ModelInput[] {
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
  }));
}

/** `google-antigravity` and `google-gemini-cli`, ready for `registerProvider`. */
export function googleCcaProviders(opts: GoogleCcaOptions = {}): Record<string, ProviderConfigInput> {
  const { baseUrl, ...deps } = opts;
  const streamSimple = createCcaStreamSimple(deps.fetch !== undefined ? { fetch: deps.fetch } : {});
  const out: Record<string, ProviderConfigInput> = {};
  for (const id of GOOGLE_CCA_PROVIDER_IDS) {
    const rule = GOOGLE_OAUTH_RULES[id];
    const table = BUILTIN_PROVIDERS[id];
    if (table === undefined) throw new Error(`the generated provider table has no ${id}`);
    out[id] = {
      name: rule.name,
      api: GOOGLE_CCA_API,
      baseUrl: baseUrl ?? table.baseUrl,
      streamSimple,
      oauth: {
        name: rule.name,
        isSubscription: true,
        login: (callbacks) => loginGoogle(rule, callbacks, deps),
        refreshToken: (credentials, signal) => refreshGoogle(rule, credentials, deps, signal),
        getApiKey: (credentials) => structuredApiKey(credentials),
      },
      models: modelsFor(id),
    };
  }
  return out;
}
