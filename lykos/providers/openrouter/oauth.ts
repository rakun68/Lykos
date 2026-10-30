// OpenRouter OAuth PKCE login and refresh.
//
// The rule: authorization code with PKCE, state "none", callback port 54549 path "/callback".
// Authorize at https://openrouter.ai/auth with callback_url, code_challenge, code_challenge_method.
// JSON token exchange at https://openrouter.ai/api/v1/auth/keys with code, code_verifier, code_challenge_method.
// Refresh is none (no-op, credential returned unchanged).
//
// Credential shape (plan D2): keeps Pi 0.84.3's shape from openrouter.js:
// { type: "oauth", access: key, refresh: "", expires: Number.MAX_SAFE_INTEGER }.
// Pi's toAuth ({ apiKey: access }) is kept (D1). Old and new rows are interchangeable.

import {
  type FetchLike,
  type LoginInteraction,
  type OAuthCredential,
  OAuthLoginError,
  generatePkce,
  postTokenRequest,
  runCodeFlow,
} from "../builtin-logins/code-flow.js";

export const OPENROUTER_AUTHORIZE_URL = "https://openrouter.ai/auth";
export const OPENROUTER_TOKEN_URL = "https://openrouter.ai/api/v1/auth/keys";
export const OPENROUTER_CALLBACK_PORT = 54549;
export const OPENROUTER_CALLBACK_PATH = "/callback";
export const OPENROUTER_CALLBACK_HOST = "localhost";
export const OPENROUTER_INSTRUCTIONS =
  "Complete sign-in in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.";

export interface OpenRouterOAuthUrls {
  authorizeUrl?: string;
  tokenUrl?: string;
}

export interface OpenRouterOAuthDeps {
  fetch?: FetchLike;
  openBrowser?: (url: string) => void;
  callbackPort?: number;
  callbackPath?: string;
  onListening?: (port: number) => void;
  callbackTimeoutMs?: number;
  urls?: OpenRouterOAuthUrls;
}

/** Build the stateless authorize URL (state "none"). */
export function buildOpenRouterAuthorizeUrl(authorizeUrl: string, redirectUri: string, challenge: string): string {
  const params = new URLSearchParams();
  params.set("callback_url", redirectUri);
  params.set("code_challenge", challenge);
  params.set("code_challenge_method", "S256");
  return `${authorizeUrl}?${params.toString()}`;
}

/** Run OpenRouter's PKCE login through Pi's native interaction. */
export async function loginOpenRouter(
  interaction: LoginInteraction,
  deps: OpenRouterOAuthDeps = {},
): Promise<OAuthCredential> {
  const pkce = generatePkce();
  const flow = await runCodeFlow({
    provider: "openrouter",
    interaction,
    port: deps.callbackPort ?? OPENROUTER_CALLBACK_PORT,
    path: deps.callbackPath ?? OPENROUTER_CALLBACK_PATH,
    portFallback: true,
    redirectHost: OPENROUTER_CALLBACK_HOST,
    instructions: OPENROUTER_INSTRUCTIONS,
    buildAuthUrl: (redirectUri) =>
      buildOpenRouterAuthorizeUrl(deps.urls?.authorizeUrl ?? OPENROUTER_AUTHORIZE_URL, redirectUri, pkce.challenge),
    ...(deps.openBrowser !== undefined ? { openBrowser: deps.openBrowser } : {}),
    ...(deps.onListening !== undefined ? { onListening: deps.onListening } : {}),
    ...(deps.callbackTimeoutMs !== undefined ? { timeoutMs: deps.callbackTimeoutMs } : {}),
    loginCommand: "lykos login openrouter",
  });

  interaction.notify({ type: "progress", message: "Exchanging authorization code for an API key..." });
  const body = (await postTokenRequest(
    {
      provider: "openrouter",
      url: deps.urls?.tokenUrl ?? OPENROUTER_TOKEN_URL,
      body: "json",
      params: {
        code: flow.code,
        code_verifier: pkce.verifier,
        code_challenge_method: "S256",
      },
      kind: "token exchange",
    },
    deps.fetch ?? globalThis.fetch,
    interaction.signal,
  )) as Record<string, unknown> | undefined;

  const key = body?.key;
  if (typeof key !== "string" || key.length === 0) {
    throw new OAuthLoginError('openrouter token exchange response missing "key"');
  }

  return {
    type: "oauth",
    access: key,
    refresh: "",
    expires: Number.MAX_SAFE_INTEGER,
  };
}

/**
 * OpenRouter mints a permanent API key; refresh is a no-op returning the credential unchanged.
 */
export async function refreshOpenRouter(
  credential: OAuthCredential,
  _deps: OpenRouterOAuthDeps = {},
  _signal?: AbortSignal,
): Promise<OAuthCredential> {
  return credential;
}
