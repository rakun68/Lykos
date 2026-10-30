// OpenAI Codex (ChatGPT Plus/Pro) login and refresh: the browser flow and the device-code
// flow, both stored under provider id `openai-codex`.
//
// The `originator` authorize parameter: Lykos sends `pi`, the value Pi 0.84.3 sends (`createAuthorizationFlow(originator = "pi")` in pi-ai
// dist/auth/oauth/openai-codex.js), so the vendor sees the same client it saw before.
//
// The login-method `select` prompt (ids `browser` / `device_code` and their labels) is Pi
// 0.84.3's `openaiCodexOAuth.login`, so `lykos login openai-codex` asks the same question.
//
// Credential shape (plan D2): Pi 0.84.3 stores `type`, `access`, `refresh`, `expires`
// (no skew) and `accountId` (the `chatgpt_account_id` claim). Login adds
// `email`, `orgId` (= account id) and `orgName` (plan type) at login; on refresh it keeps
// the stored org fields. Nothing is renamed. Pi's `toAuth` (`{ apiKey: access }`) is untouched.
//
// Choices, each deliberate:
// - The callback port is injectable for tests; the advertised redirect URI is always the
//   exact allowlisted `http://localhost:1455/auth/callback`, and a busy port fails plainly.
// - The device flow's sleep is injectable, and its errors name a status, never a body.

import {
  type FetchLike,
  type LoginInteraction,
  type OAuthCredential,
  OAuthLoginError,
  decodeJwtPayload,
  generatePkce,
  generateState,
  mapTokenResponse,
  postTokenRequest,
  runCodeFlow,
} from "../builtin-logins/code-flow.js";

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
export const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";
/** The requested scopes. */
export const CODEX_SCOPES = ["openid", "profile", "email", "offline_access", "api.connectors.read", "api.connectors.invoke"] as const;
export const CODEX_CALLBACK_PORT = 1455;
export const CODEX_CALLBACK_PATH = "/auth/callback";
/** OpenAI allowlists only this exact URI, so a busy port fails rather than falls back. */
export const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
/** Pi 0.84.3's originator (see the header comment). */
export const CODEX_ORIGINATOR = "pi";
export const CODEX_INSTRUCTIONS = "A browser window should open. Complete login to finish.";
/** Per-request token timeout. */
export const CODEX_TOKEN_TIMEOUT_MS = 15_000;
// Device flow constants.
export const CODEX_DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
export const CODEX_DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
export const CODEX_DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
export const CODEX_DEVICE_AUTH_URL = "https://auth.openai.com/codex/device";
export const CODEX_DEVICE_POLL_INTERVAL_MS = 5_000;
export const CODEX_DEVICE_POLL_SAFETY_MARGIN_MS = 3_000;
export const CODEX_DEVICE_MAX_POLLS = 120;
// oauth/openai-codex.ts JWT claim paths.
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const JWT_PROFILE_CLAIM = "https://api.openai.com/profile";

/** Pi 0.84.3's login-method option ids. */
export const CODEX_BROWSER_METHOD = "browser";
export const CODEX_DEVICE_METHOD = "device_code";

export interface CodexOAuthUrls {
  authorizeUrl?: string;
  tokenUrl?: string;
  deviceUserCodeUrl?: string;
  deviceTokenUrl?: string;
}

export interface CodexOAuthDeps {
  fetch?: FetchLike;
  openBrowser?: (url: string) => void;
  /** Loopback port to bind. Defaults to 1455; tests inject another. The advertised URI never changes. */
  callbackPort?: number;
  onListening?: (port: number) => void;
  callbackTimeoutMs?: number;
  /** Device-flow sleep; tests pass one that resolves at once. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  urls?: CodexOAuthUrls;
}

function claimString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** oauth/openai-codex.ts `getTokenProfile`: account id, email and plan type from the access and id tokens. */
export function codexTokenProfile(accessToken: string, idToken?: string): { accountId?: string; email?: string; planType?: string } {
  const payload = decodeJwtPayload(accessToken);
  const idPayload = idToken ? decodeJwtPayload(idToken) : null;
  const auth = payload?.[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
  const idAuth = idPayload?.[JWT_CLAIM_PATH] as Record<string, unknown> | undefined;
  const profile = payload?.[JWT_PROFILE_CLAIM] as Record<string, unknown> | undefined;
  const idProfile = idPayload?.[JWT_PROFILE_CLAIM] as Record<string, unknown> | undefined;
  const accountId = claimString(auth?.chatgpt_account_id) ?? claimString(idAuth?.chatgpt_account_id);
  const email = (claimString(profile?.email) ?? claimString(idProfile?.email))?.trim().toLowerCase();
  const planType = (claimString(auth?.chatgpt_plan_type) ?? claimString(idAuth?.chatgpt_plan_type))?.trim().toLowerCase();
  const out: { accountId?: string; email?: string; planType?: string } = {};
  if (accountId) out.accountId = accountId;
  if (email) out.email = email;
  if (planType) out.planType = planType;
  return out;
}

/** oauth/openai-codex.ts `openAICodexProfileHook`. */
function applyProfileHook(
  credential: OAuthCredential,
  raw: unknown,
  phase: "login" | "refresh",
  stored?: OAuthCredential,
): OAuthCredential {
  const idToken =
    raw !== null && typeof raw === "object" && typeof (raw as Record<string, unknown>).id_token === "string"
      ? ((raw as Record<string, unknown>).id_token as string)
      : undefined;
  const { accountId, email, planType } = codexTokenProfile(credential.access, idToken);
  if (phase === "login" && !accountId) throw new OAuthLoginError("Failed to extract accountId from token");
  const resolvedAccountId = accountId ?? (stored?.accountId as string | undefined);
  const next: OAuthCredential = { ...credential };
  if (resolvedAccountId) next.accountId = resolvedAccountId;
  const resolvedEmail = email ?? (stored?.email as string | undefined);
  if (resolvedEmail) next.email = resolvedEmail;
  if (phase === "login" && resolvedAccountId) next.orgId = resolvedAccountId;
  if (phase === "login" && planType) next.orgName = planType;
  if (phase === "refresh" && stored?.orgId) next.orgId = stored.orgId;
  if (phase === "refresh" && stored?.orgName) next.orgName = stored.orgName;
  return next;
}

const TOKEN_MAP = { skewMs: 0 } as const;

async function exchangeCode(
  code: string,
  verifier: string,
  redirectUri: string,
  deps: CodexOAuthDeps,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  const body = await postTokenRequest(
    {
      provider: "openai-codex",
      url: deps.urls?.tokenUrl ?? CODEX_TOKEN_URL,
      body: "form",
      params: {
        grant_type: "authorization_code",
        client_id: CODEX_CLIENT_ID,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      },
      timeoutMs: CODEX_TOKEN_TIMEOUT_MS,
      kind: "token exchange",
    },
    deps.fetch ?? globalThis.fetch,
    signal,
  );
  return applyProfileHook(mapTokenResponse("openai-codex", body, TOKEN_MAP, deps.now ?? Date.now), body, "login");
}

/** Build the authorize URL: the standard parameters, then the rule's extras with Pi's originator. */
export function buildCodexAuthorizeUrl(authorizeUrl: string, redirectUri: string, state: string, challenge: string): string {
  const params = new URLSearchParams();
  params.set("client_id", CODEX_CLIENT_ID);
  params.set("response_type", "code");
  params.set("redirect_uri", redirectUri);
  params.set("scope", CODEX_SCOPES.join(" "));
  params.set("code_challenge", challenge);
  params.set("code_challenge_method", "S256");
  params.set("state", state);
  params.set("id_token_add_organizations", "true");
  params.set("codex_cli_simplified_flow", "true");
  params.set("originator", CODEX_ORIGINATOR);
  return `${authorizeUrl}?${params.toString()}`;
}

/** The browser flow. */
export async function loginCodexBrowser(interaction: LoginInteraction, deps: CodexOAuthDeps = {}): Promise<OAuthCredential> {
  const state = generateState();
  const pkce = generatePkce();
  const flow = await runCodeFlow({
    provider: "openai-codex",
    interaction,
    port: deps.callbackPort ?? CODEX_CALLBACK_PORT,
    path: CODEX_CALLBACK_PATH,
    portFallback: false,
    fixedRedirectUri: CODEX_REDIRECT_URI,
    redirectHost: "localhost",
    state,
    instructions: CODEX_INSTRUCTIONS,
    buildAuthUrl: (redirectUri) =>
      buildCodexAuthorizeUrl(deps.urls?.authorizeUrl ?? CODEX_AUTHORIZE_URL, redirectUri, state, pkce.challenge),
    ...(deps.openBrowser !== undefined ? { openBrowser: deps.openBrowser } : {}),
    ...(deps.onListening !== undefined ? { onListening: deps.onListening } : {}),
    ...(deps.callbackTimeoutMs !== undefined ? { timeoutMs: deps.callbackTimeoutMs } : {}),
    loginCommand: "lykos login openai-codex",
  });
  interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens..." });
  return exchangeCode(flow.code, pkce.verifier, flow.redirectUri, deps, interaction.signal);
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new OAuthLoginError("Device authorization cancelled"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new OAuthLoginError("Device authorization cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function postJson(url: string, body: unknown, deps: CodexOAuthDeps, signal: AbortSignal): Promise<Response> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(CODEX_TOKEN_TIMEOUT_MS)]),
    });
  } catch (err) {
    if (signal.aborted) throw new OAuthLoginError("Device authorization cancelled");
    throw new OAuthLoginError(`openai-codex request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The device-code flow (oauth/openai-codex.ts `loginOpenAICodexDevice`). */
export async function loginCodexDevice(interaction: LoginInteraction, deps: CodexOAuthDeps = {}): Promise<OAuthCredential> {
  const signal = interaction.signal;
  const sleep = deps.sleep ?? defaultSleep;
  interaction.notify({ type: "progress", message: "Initiating device authorization…" });

  const init = await postJson(deps.urls?.deviceUserCodeUrl ?? CODEX_DEVICE_USERCODE_URL, { client_id: CODEX_CLIENT_ID }, deps, signal);
  if (!init.ok) throw new OAuthLoginError(`Device authorization initiation failed: ${init.status}`);
  const initData = (await init.json()) as { device_auth_id?: string; user_code?: string; interval?: string | number };
  if (!initData.device_auth_id || !initData.user_code) {
    throw new OAuthLoginError("Device authorization response missing required fields");
  }
  const userCode = initData.user_code;
  const intervalSeconds =
    typeof initData.interval === "number" ? initData.interval : parseInt(String(initData.interval ?? "5"), 10) || 5;
  const pollIntervalMs = intervalSeconds * 1000 + CODEX_DEVICE_POLL_SAFETY_MARGIN_MS;

  interaction.notify({ type: "device_code", userCode, verificationUri: CODEX_DEVICE_AUTH_URL, intervalSeconds });
  interaction.notify({ type: "progress", message: `Waiting for browser authorization (code: ${userCode})…` });

  for (let poll = 0; poll < CODEX_DEVICE_MAX_POLLS; poll++) {
    await sleep(poll === 0 ? Math.min(pollIntervalMs, CODEX_DEVICE_POLL_INTERVAL_MS) : pollIntervalMs, signal);
    if (signal.aborted) throw new OAuthLoginError("Device authorization cancelled");

    const response = await postJson(
      deps.urls?.deviceTokenUrl ?? CODEX_DEVICE_TOKEN_URL,
      { device_auth_id: initData.device_auth_id, user_code: userCode },
      deps,
      signal,
    );
    // 403/404 = authorization pending, keep polling.
    if (response.status === 403 || response.status === 404) {
      await response.body?.cancel();
      continue;
    }
    if (!response.ok) throw new OAuthLoginError(`Device token polling failed: ${response.status}`);
    const pollData = (await response.json()) as { authorization_code?: string; code_verifier?: string };
    if (!pollData.authorization_code || !pollData.code_verifier) {
      throw new OAuthLoginError("Device token response missing authorization_code or code_verifier");
    }
    interaction.notify({ type: "progress", message: "Exchanging authorization code for tokens…" });
    return exchangeCode(pollData.authorization_code, pollData.code_verifier, CODEX_DEVICE_REDIRECT_URI, deps, signal);
  }
  throw new OAuthLoginError("Device authorization timed out — user did not complete login in time");
}

/** `lykos login openai-codex`: Pi's `select` between the two flows; both store under `openai-codex`. */
export async function loginCodex(interaction: LoginInteraction, deps: CodexOAuthDeps = {}): Promise<OAuthCredential> {
  const method = await interaction.prompt({
    type: "select",
    message: "Select OpenAI Codex login method:",
    options: [
      { id: CODEX_BROWSER_METHOD, label: "Browser login (default)" },
      { id: CODEX_DEVICE_METHOD, label: "Device code login (headless)" },
    ],
  });
  if (method === CODEX_DEVICE_METHOD) return loginCodexDevice(interaction, deps);
  if (method !== CODEX_BROWSER_METHOD) throw new OAuthLoginError(`Unknown OpenAI Codex login method: ${method}`);
  return loginCodexBrowser(interaction, deps);
}

/**
 * Refresh a Codex credential from either flow (both rules refresh with the same three form
 * parameters at the same URL). Every stored field is kept (plan D2).
 */
export async function refreshCodex(credential: OAuthCredential, deps: CodexOAuthDeps = {}, signal?: AbortSignal): Promise<OAuthCredential> {
  const body = await postTokenRequest(
    {
      provider: "openai-codex",
      url: deps.urls?.tokenUrl ?? CODEX_TOKEN_URL,
      body: "form",
      params: { grant_type: "refresh_token", client_id: CODEX_CLIENT_ID, refresh_token: credential.refresh },
      timeoutMs: CODEX_TOKEN_TIMEOUT_MS,
      kind: "token refresh",
    },
    deps.fetch ?? globalThis.fetch,
    signal,
  );
  const mapped = mapTokenResponse("openai-codex", body, TOKEN_MAP, deps.now ?? Date.now, credential.refresh);
  const refreshed = applyProfileHook(mapped, body, "refresh", credential);
  return { ...credential, ...refreshed, type: "oauth" };
}
