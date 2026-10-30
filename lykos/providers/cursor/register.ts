// Registration of the Cursor provider.
//
// `cursorProvider()` returns what `registerProvider` takes: api `cursor-agent`,
// the base URL and models from ticket 03's generated table (zero cost, rule 5),
// Lykos's own `streamSimple`, and the OAuth login and refresh. Pi is not patched.

import { BUILTIN_PROVIDERS } from "../../config/provider-table.js";
import type { ProviderConfigInput } from "../google-cca/types.js";
import { type CursorOAuthDeps, loginCursor, refreshCursor } from "./oauth.js";
import { type CursorStreamDeps, createCursorStreamSimple } from "./stream.js";

export const CURSOR_API = "cursor-agent";

export interface CursorProviderOptions extends CursorOAuthDeps, CursorStreamDeps {
  /** Stream base URL. Defaults to the generated table's (`https://api2.cursor.sh`). */
  baseUrl?: string;
}

type ModelInput = NonNullable<ProviderConfigInput["models"]>[number];

const UNPRICED: ModelInput["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** The `cursor` provider, ready for `registerProvider`. */
export function cursorProvider(opts: CursorProviderOptions = {}): ProviderConfigInput {
  const table = BUILTIN_PROVIDERS["cursor"];
  if (table === undefined) throw new Error("the generated provider table has no cursor");
  const { baseUrl: baseUrlOverride, connect, heartbeatMs, ...oauthDeps } = opts;
  const baseUrl = baseUrlOverride ?? table.baseUrl;
  return {
    name: "Cursor",
    api: CURSOR_API,
    baseUrl,
    streamSimple: createCursorStreamSimple({
      ...(connect !== undefined ? { connect } : {}),
      ...(heartbeatMs !== undefined ? { heartbeatMs } : {}),
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
      name: "Cursor (Claude, GPT, etc.)",
      isSubscription: true,
      login: (callbacks) => loginCursor(callbacks, oauthDeps),
      refreshToken: (credentials, signal) => refreshCursor(credentials, oauthDeps, signal),
      getApiKey: (credentials) => credentials.access,
    },
  };
}
