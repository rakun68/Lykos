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
  /** How `/connect` signs in: a browser login, or an API key. */
  login: "oauth" | "api_key";
  configured: boolean;
  /** What made it configured, or how to configure it. Never a key or a fragment of one. */
  reason: string;
}

const OAUTH: ReadonlySet<string> = new Set(BUILTIN_LOGIN_PROVIDERS);

export function providerCatalog(input: { providers: ProvidersConfig; env: NodeJS.ProcessEnv; poolSizes: Map<string, number> }): ProviderEntry[] {
  const names = new Set([...Object.keys(BUILTIN_PROVIDERS), ...PI_NATIVE_PROVIDERS, ...Object.keys(input.providers), ...input.poolSizes.keys()]);
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const decl = input.providers[name];
      const oauth = OAUTH.has(name) || decl?.auth === "oauth_subscription";
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
              : oauth
                ? "sign in with a browser"
                : "add an API key";
      return { name, login: oauth ? "oauth" : "api_key", configured: pool > 0 || setEnv !== undefined || decl?.source !== undefined, reason };
    });
}
