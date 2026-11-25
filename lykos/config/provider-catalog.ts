// Every provider a person can connect, for `/connect` before and inside a session (`providers.list`): the built-in
// table, Pi's own providers, every declared one and every one with a credential in the pool. `configured` says the
// provider has something to sign in with already: a credential in the pool, its environment variable, or a
// declaration with a source.

import { BUILTIN_LOGIN_PROVIDERS } from "../providers/builtin-logins/register.js";
import { envNamesFor } from "./providers.js";
import { BUILTIN_PROVIDERS, PI_NATIVE_PROVIDERS } from "./provider-table.js";
import type { ProvidersConfig } from "./types.js";

export interface ProviderEntry {
  name: string;
  /** How `/connect` signs in first: a browser login when the provider has one, else an API key. */
  login: "oauth" | "api_key";
  /** The provider has a browser login. */
  oauth: boolean;
  /** The provider takes an API key. */
  apiKey: boolean;
  configured: boolean;
  /** What made it configured, or how to configure it. Never a key or a fragment of one. */
  reason: string;
}

/** How a provider takes a credential, as the model runtime knows it (`session/provider-models.ts`'s `loginKinds`). */
export interface LoginKind {
  oauth: boolean;
  apiKey: boolean;
}

const OAUTH: ReadonlySet<string> = new Set(BUILTIN_LOGIN_PROVIDERS);

/**
 * `kinds` is what the model runtime says of each provider it knows; one it does not know (a declared endpoint, or a
 * name with only a pool credential) takes an API key, unless its declaration says it signs in with a subscription.
 */
export function providerCatalog(input: {
  providers: ProvidersConfig;
  env: NodeJS.ProcessEnv;
  poolSizes: Map<string, number>;
  kinds?: ReadonlyMap<string, LoginKind>;
}): ProviderEntry[] {
  const names = new Set([
    ...Object.keys(BUILTIN_PROVIDERS),
    ...PI_NATIVE_PROVIDERS,
    ...Object.keys(input.providers),
    ...input.poolSizes.keys(),
    ...(input.kinds?.keys() ?? []),
  ]);
  // A provider the runtime does not know and no declaration gives a base URL has no endpoint to call: it is left out.
  const reachable = (name: string): boolean => input.kinds === undefined || input.kinds.has(name) || input.providers[name]?.baseUrl !== undefined;
  return [...names]
    .filter(reachable)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const decl = input.providers[name];
      const known = input.kinds?.get(name);
      const oauth = known?.oauth === true || (known === undefined && OAUTH.has(name)) || decl?.auth === "oauth_subscription";
      const apiKey = known === undefined ? decl?.auth !== "oauth_subscription" : known.apiKey;
      const pool = input.poolSizes.get(name) ?? 0;
      const envs = envNamesFor(name, decl ?? { auth: "api_key" });
      const setEnv = envs.find((v) => Boolean(input.env[v]));
      const reason =
        pool > 0
          ? `${pool} credential${pool === 1 ? "" : "s"} in the pool`
          : setEnv !== undefined
            ? `$${setEnv} is set`
            : decl?.source !== undefined
              ? "declared with a source"
              : oauth && apiKey
                ? "sign in with a browser or add an API key"
                : oauth
                  ? "sign in with a browser"
                  : "add an API key";
      return {
        name,
        login: oauth ? "oauth" : "api_key",
        oauth,
        apiKey: apiKey || !oauth,
        configured: pool > 0 || setEnv !== undefined || decl?.source !== undefined,
        reason,
      };
    });
}
