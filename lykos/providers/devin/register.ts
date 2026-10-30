// Registration of the Devin provider.
//
// `devinProvider()` returns what `registerProvider` takes: api `devin-agent`, the base URL
// and models from ticket 03's generated table (zero cost, rule 5), Lykos's own
// `streamSimple`, and the OAuth login (there is no refresh, so an expired
// credential asks for a new login). Pi is not patched.

import { BUILTIN_PROVIDERS } from "../../config/provider-table.js";
import type { ProviderConfigInput } from "../google-cca/types.js";
import { type DevinOAuthDeps, loginDevin, refreshDevin } from "./oauth.js";
import { createDevinStreamSimple, type DevinStreamDeps } from "./stream.js";

export const DEVIN_API = "devin-agent";

export interface DevinProviderOptions extends DevinOAuthDeps {
  /** Stream base URL. Defaults to the generated table's (`https://server.codeium.com`). */
  baseUrl?: string;
  /** The stream's fetch. The login's is `fetch`. */
  streamFetch?: typeof fetch;
  compat?: DevinStreamDeps["compat"];
}

type ModelInput = NonNullable<ProviderConfigInput["models"]>[number];

const UNPRICED: ModelInput["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** The `devin` provider, ready for `registerProvider`. */
export function devinProvider(opts: DevinProviderOptions = {}): ProviderConfigInput {
  const table = BUILTIN_PROVIDERS["devin"];
  if (table === undefined) throw new Error("the generated provider table has no devin");
  const { baseUrl: baseUrlOverride, streamFetch, compat, ...oauthDeps } = opts;
  const baseUrl = baseUrlOverride ?? table.baseUrl;
  return {
    name: "Devin",
    api: DEVIN_API,
    baseUrl,
    streamSimple: createDevinStreamSimple({
      ...(streamFetch !== undefined ? { fetch: streamFetch } : {}),
      ...(compat !== undefined ? { compat } : {}),
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
      name: "Devin",
      isSubscription: true,
      login: (callbacks) => loginDevin(callbacks, oauthDeps),
      refreshToken: (credentials) => refreshDevin(credentials, oauthDeps.now),
      getApiKey: (credentials) => credentials.access,
    },
  };
}
