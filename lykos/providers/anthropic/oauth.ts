// Anthropic (Claude Pro/Max) login and refresh.
//
// The rule: authorization code with PKCE and a hex state; authorize at
// `https://claude.ai/oauth/authorize` with the standard parameters plus `code=true`; loopback
// callback `localhost:54545/callback` with port fallback; a pasted redirect URL or code also
// works. JSON token exchange at `https://api.anthropic.com/v1/oauth/token` with the standard
// parameters plus `state`; refresh at the same URL with `anthropic-beta` and a User-Agent.
//
// Credential shape (plan D2): Pi 0.84.3's anthropic.js stores `type`, `refresh`, `access`,
// `expires` (5-minute skew). Lykos adds `accountId`, `email`, `orgId`, `orgName`;
// nothing is renamed. Pi's `toAuth` (`{ apiKey: access }`) is untouched (D1).
//
// Second endpoint (plan D3): the `anthropic-identity` hook calls
// `https://api.anthropic.com/api/claude_cli/bootstrap` when the token response omits identity.
// It is kept; a failure there leaves identity unset and never fails the login.

import {
  type FetchLike,
  type LoginInteraction,
  type OAuthCredential,
  generatePkce,
  generateState,
  mapTokenResponse,
  postTokenRequest,
  runCodeFlow,
} from "../builtin-logins/code-flow.js";

// The client id, stored base64.
export const ANTHROPIC_CLIENT_ID = Buffer.from("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl", "base64").toString("utf8");
export const ANTHROPIC_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const ANTHROPIC_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
export const ANTHROPIC_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
] as const;
export const ANTHROPIC_CALLBACK_PORT = 54545;
export const ANTHROPIC_CALLBACK_PATH = "/callback";
/** The compiled rule's callback `hostname`. */
export const ANTHROPIC_CALLBACK_HOST = "localhost";
export const ANTHROPIC_INSTRUCTIONS =
  "Complete login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.";
/** Expiry is `expires_in` seconds, less this skew. */
export const ANTHROPIC_EXPIRY_SKEW_MS = 300_000;
/** The client version the OAuth endpoints expect. */
export const CLAUDE_CODE_VERSION = "2.1.257";
/** The SDK version in the refresh User-Agent. */
export const CLAUDE_CODE_SDK_VERSION = "0.112.1";
/** Refresh headers. */
export const ANTHROPIC_REFRESH_HEADERS = {
  "anthropic-beta": "oauth-2025-04-20",
  "User-Agent": `anthropic-sdk-typescript/${CLAUDE_CODE_SDK_VERSION} userOAuthProvider`,
} as const;
/** The bootstrap endpoint and model. */
export const ANTHROPIC_BOOTSTRAP_URL = "https://api.anthropic.com/api/claude_cli/bootstrap";
export const ANTHROPIC_BOOTSTRAP_MODEL = "claude-opus-4-8";

export interface AnthropicOAuthUrls {
  authorizeUrl?: string;
  tokenUrl?: string;
  bootstrapUrl?: string;
}

export interface AnthropicOAuthDeps {
  fetch?: FetchLike;
  /** Opens the authorize URL. The interaction's `auth_url` event is always sent too. */
  openBrowser?: (url: string) => void;
  /** Loopback port. Defaults to the rule's 54545; tests pass 0. */
  callbackPort?: number;
  onListening?: (port: number) => void;
  callbackTimeoutMs?: number;
  now?: () => number;
  urls?: AnthropicOAuthUrls;
}

const LOGIN_MAP = {
  skewMs: ANTHROPIC_EXPIRY_SKEW_MS,
  optional: {
    accountId: "account.uuid",
    email: "account.email_address",
    orgId: "organization.uuid",
    orgName: "organization.name",
  },
} as const;

// The refresh rule deliberately does not remap org fields: the org is fixed at login.
const REFRESH_MAP = {
  skewMs: ANTHROPIC_EXPIRY_SKEW_MS,
  optional: { accountId: "account.uuid", email: "account.email_address" },
} as const;

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** oauth/anthropic.ts `fetchAnthropicBootstrapIdentity`. Throws on failure; the hook swallows it. */
async function fetchBootstrapIdentity(
  access: string,
  deps: AnthropicOAuthDeps,
): Promise<{ accountId?: string; email?: string; orgId?: string; orgName?: string }> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const base = deps.urls?.bootstrapUrl ?? ANTHROPIC_BOOTSTRAP_URL;
  const url = `${base}?entrypoint=cli&model=${encodeURIComponent(ANTHROPIC_BOOTSTRAP_MODEL)}`;
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/json, text/plain, */*",
      Authorization: `Bearer ${access}`,
      "Content-Type": "application/json",
      "User-Agent": `claude-code/${CLAUDE_CODE_VERSION}`,
      "anthropic-beta": "oauth-2025-04-20",
    },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`bootstrap ${response.status}`);
  const data = JSON.parse(text) as {
    oauth_account?: { account_uuid?: string; account_email?: string; organization_uuid?: string; organization_name?: string };
  };
  const out: { accountId?: string; email?: string; orgId?: string; orgName?: string } = {};
  const accountId = nonEmpty(data.oauth_account?.account_uuid);
  const email = nonEmpty(data.oauth_account?.account_email);
  const orgId = nonEmpty(data.oauth_account?.organization_uuid);
  const orgName = nonEmpty(data.oauth_account?.organization_name);
  if (accountId !== undefined) out.accountId = accountId;
  if (email !== undefined) out.email = email;
  if (orgId !== undefined) out.orgId = orgId;
  if (orgName !== undefined) out.orgName = orgName;
  return out;
}

/**
 * oauth/anthropic.ts `anthropicIdentityHook`: fills account (and, at login only,
 * organization) identity from the bootstrap endpoint when the token response left it unset.
 */
async function applyIdentityHook(
  credential: OAuthCredential,
  phase: "login" | "refresh",
  deps: AnthropicOAuthDeps,
): Promise<OAuthCredential> {
  const includeOrg = phase === "login";
  const orgSatisfied = !includeOrg || credential.orgId !== undefined;
  if (credential.accountId && credential.email && orgSatisfied) return credential;
  try {
    const identity = await fetchBootstrapIdentity(credential.access, deps);
    const next: OAuthCredential = { ...credential };
    const accountId = credential.accountId ?? identity.accountId;
    const email = credential.email ?? identity.email;
    if (accountId !== undefined) next.accountId = accountId;
    if (email !== undefined) next.email = email;
    if (includeOrg) {
      const orgId = credential.orgId ?? identity.orgId;
      const orgName = credential.orgName ?? identity.orgName;
      if (orgId !== undefined) next.orgId = orgId;
      if (orgName !== undefined) next.orgName = orgName;
    }
    return next;
  } catch {
    return credential;
  }
}

/** Build the authorize URL: the standard parameters, then `code=true`. */
export function buildAnthropicAuthorizeUrl(
  authorizeUrl: string,
  redirectUri: string,
  state: string,
  challenge: string,
): string {
  const params = new URLSearchParams();
  params.set("client_id", ANTHROPIC_CLIENT_ID);
  params.set("response_type", "code");
  params.set("redirect_uri", redirectUri);
  params.set("scope", ANTHROPIC_SCOPES.join(" "));
  params.set("code_challenge", challenge);
  params.set("code_challenge_method", "S256");
  params.set("state", state);
  params.set("code", "true");
  return `${authorizeUrl}?${params.toString()}`;
}

/** Run Anthropic's authorization-code login through Pi's native interaction. */
export async function loginAnthropic(interaction: LoginInteraction, deps: AnthropicOAuthDeps = {}): Promise<OAuthCredential> {
  const now = deps.now ?? Date.now;
  const state = generateState();
  const pkce = generatePkce();
  const flow = await runCodeFlow({
    provider: "anthropic",
    interaction,
    port: deps.callbackPort ?? ANTHROPIC_CALLBACK_PORT,
    path: ANTHROPIC_CALLBACK_PATH,
    portFallback: true,
    redirectHost: ANTHROPIC_CALLBACK_HOST,
    state,
    instructions: ANTHROPIC_INSTRUCTIONS,
    buildAuthUrl: (redirectUri) =>
      buildAnthropicAuthorizeUrl(deps.urls?.authorizeUrl ?? ANTHROPIC_AUTHORIZE_URL, redirectUri, state, pkce.challenge),
    ...(deps.openBrowser !== undefined ? { openBrowser: deps.openBrowser } : {}),
    ...(deps.onListening !== undefined ? { onListening: deps.onListening } : {}),
    ...(deps.callbackTimeoutMs !== undefined ? { timeoutMs: deps.callbackTimeoutMs } : {}),
    loginCommand: "lykos login anthropic",
  });

  interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
  const body = await postTokenRequest(
    {
      provider: "anthropic",
      url: deps.urls?.tokenUrl ?? ANTHROPIC_TOKEN_URL,
      body: "json",
      params: {
        grant_type: "authorization_code",
        client_id: ANTHROPIC_CLIENT_ID,
        code: flow.code,
        redirect_uri: flow.redirectUri,
        code_verifier: pkce.verifier,
        state: flow.state,
      },
      kind: "token exchange",
    },
    deps.fetch ?? globalThis.fetch,
    interaction.signal,
  );
  const credential = mapTokenResponse("anthropic", body, LOGIN_MAP, now);
  return applyIdentityHook(credential, "login", deps);
}

/**
 * Refresh an Anthropic credential, written by Pi's flow or Lykos's. Every stored field
 * is kept (plan D2): the org the credential is scoped to is fixed at login.
 */
export async function refreshAnthropic(
  credential: OAuthCredential,
  deps: AnthropicOAuthDeps = {},
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  const now = deps.now ?? Date.now;
  const body = await postTokenRequest(
    {
      provider: "anthropic",
      url: deps.urls?.tokenUrl ?? ANTHROPIC_TOKEN_URL,
      body: "json",
      params: { grant_type: "refresh_token", client_id: ANTHROPIC_CLIENT_ID, refresh_token: credential.refresh },
      headers: { ...ANTHROPIC_REFRESH_HEADERS },
      kind: "token refresh",
    },
    deps.fetch ?? globalThis.fetch,
    signal,
  );
  const refreshed = await applyIdentityHook(mapTokenResponse("anthropic", body, REFRESH_MAP, now, credential.refresh), "refresh", deps);
  return { ...credential, ...refreshed, type: "oauth" };
}
