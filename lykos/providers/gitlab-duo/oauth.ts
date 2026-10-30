// GitLab Duo Non-Agentic OAuth flow and direct access exchange.
//
// Authorization code flow with PKCE and loopback callback (localhost:8080/callback).
// Form token exchange and refresh. The flow clears the direct-access cache on login
// and refresh (the gitlab-duo-clear-cache hook). Direct-access token exchange caches
// tokens for 25 minutes.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { LOOPBACK_BIND_HOST } from "../builtin-logins/code-flow.js";

// GitLab's OAuth application and endpoints.
export const GITLAB_CLIENT_ID = "da4edff2e6ebd2bc3208611e2768bc1c1dd7be791dc5ff26ca34ca9ee44f7d4b";
export const GITLAB_AUTHORIZE_URL = "https://gitlab.com/oauth/authorize";
export const GITLAB_TOKEN_URL = "https://gitlab.com/oauth/token";
export const GITLAB_DIRECT_ACCESS_URL = "https://gitlab.com/api/v4/ai/third_party_agents/direct_access";
export const GITLAB_AI_GATEWAY_URL = "https://cloud.gitlab.com";
export const GITLAB_ANTHROPIC_PROXY_URL = "https://cloud.gitlab.com/ai/v1/proxy/anthropic/";
export const GITLAB_OPENAI_PROXY_URL = "https://cloud.gitlab.com/ai/v1/proxy/openai/v1";
export const DIRECT_ACCESS_TTL_MS = 25 * 60 * 1000;
export const GITLAB_CALLBACK_TIMEOUT_MS = 300_000;
export const GITLAB_EXPIRES_SKEW_MS = 300_000; // 5 min skew

export interface GitLabDuoOAuthUrls {
  authorizeUrl?: string;
  tokenUrl?: string;
  directAccessUrl?: string;
  clientId?: string;
}

export interface GitLabDuoOAuthDeps {
  fetch?: typeof fetch;
  openBrowser?: (url: string) => void;
  callbackHost?: string;
  callbackPort?: number;
  redirectUri?: string;
  now?: () => number;
  urls?: GitLabDuoOAuthUrls;
  env?: NodeJS.ProcessEnv;
  callbackTimeoutMs?: number;
}

export interface GitLabDuoOAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
}

export interface GitLabDuoLoginCallbacks {
  onAuth?: (info: { url: string; instructions?: string }) => void;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export interface DirectAccessToken {
  token: string;
  headers: Record<string, string>;
  expiresAt: number;
}

const directAccessCache = new Map<string, DirectAccessToken>();

export function clearGitLabDuoDirectAccessCache(): void {
  directAccessCache.clear();
}

export function getCachedDirectAccessToken(gitlabAccessToken: string): DirectAccessToken | undefined {
  return directAccessCache.get(gitlabAccessToken);
}

export function redactTokens(text: string): string {
  return text
    .replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[redacted]")
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "[redacted]");
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(96).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * One form-encoded POST to a GitLab OAuth token endpoint, shared by the GitLab Duo and GitLab Duo Agent
 * logins (ticket 13 reuses it). Returns the parsed JSON body. A non-2xx
 * response throws `<failure>: <status> <body>` with anything token-shaped in
 * the body redacted; a transport failure names the URL, never a parameter.
 */
export async function postGitLabTokenForm(
  tokenUrl: string,
  params: Record<string, string>,
  opts: { fetch: typeof fetch; failure: string; signal?: AbortSignal },
): Promise<any> {
  let tokenRes: Response;
  try {
    tokenRes = await opts.fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  } catch (err) {
    throw new Error(`GitLab request to ${tokenUrl} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const tokenText = await tokenRes.text();
  let tokenBody: any;
  try {
    tokenBody = tokenText.length > 0 ? JSON.parse(tokenText) : undefined;
  } catch {
    tokenBody = undefined;
  }

  if (!tokenRes.ok) {
    throw new Error(`${opts.failure}: ${tokenRes.status} ${redactTokens(tokenText.slice(0, 500))}`);
  }
  return tokenBody;
}

interface CallbackServer {
  redirectUri: string;
  code: Promise<string>;
  close(): Promise<void>;
}

async function listen(server: Server, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function closeListener(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  const force = setTimeout(() => server.closeAllConnections(), 1000);
  force.unref();
  await closed;
  clearTimeout(force);
}

async function startCallbackServer(
  deps: GitLabDuoOAuthDeps,
  expectedState: string,
  signal: AbortSignal | undefined,
): Promise<CallbackServer> {
  // The redirect URI keeps GitLab's registered `localhost`. `localhost` may resolve to either
  // loopback family, so by default the callback answers on both, on one shared port. An explicit
  // `callbackHost` opts back into a single listener on that host.
  const explicitHost = deps.callbackHost;
  const host = explicitHost ?? "localhost";
  const path = "/callback";
  let settle: { resolve: (code: string) => void; reject: (err: Error) => void } | undefined;
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  code.catch(() => {});

  const handleRequest: RequestListener = (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname !== path) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found");
      return;
    }
    const got = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? "";
    const error = url.searchParams.get("error") ?? "";
    const description = url.searchParams.get("error_description") || error;

    let outcome: { ok: true; code: string } | { ok: false; message: string; fatal: boolean };
    if (error) {
      outcome = { ok: false, message: `Authorization failed: ${description}`, fatal: state === expectedState };
    } else if (!got) {
      outcome = { ok: false, message: "Missing authorization code", fatal: false };
    } else if (state !== expectedState) {
      outcome = { ok: false, message: "State mismatch - possible CSRF attack", fatal: true };
    } else {
      outcome = { ok: true, code: got };
    }

    res.writeHead(outcome.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
    res.end(
      outcome.ok
        ? "<!doctype html><html><body><p>Signed in. You can close this tab and return to Lykos.</p></body></html>"
        : `<!doctype html><html><body><p>${outcome.message}</p></body></html>`,
    );

    if (outcome.ok) settle?.resolve(outcome.code);
    else if (outcome.fatal) settle?.reject(new Error(`GitLab Duo OAuth callback: ${outcome.message}`));
  };

  const preferredPort = deps.callbackPort ?? 8080;
  const servers: Server[] = [];

  // IPv4 (or the explicit host) first: its port is the shared one, including the ephemeral fallback.
  const primary = createServer(handleRequest);
  const primaryHost = explicitHost ?? LOOPBACK_BIND_HOST;
  try {
    await listen(primary, primaryHost, preferredPort);
  } catch (err) {
    const busy = (err as NodeJS.ErrnoException).code === "EADDRINUSE";
    if (!busy || preferredPort === 0) throw err;
    await listen(primary, primaryHost, 0);
  }
  servers.push(primary);
  const actualPort = (primary.address() as AddressInfo).port;

  // With no explicit host, also answer on IPv6 loopback on the same port. A host without IPv6
  // loopback, or one where that port is already taken, carries on with IPv4 alone.
  if (explicitHost === undefined) {
    const secondary = createServer(handleRequest);
    try {
      await listen(secondary, "::1", actualPort);
      servers.push(secondary);
    } catch {
      // No IPv6 loopback (EADDRNOTAVAIL/EAFNOSUPPORT) or the port is taken (EADDRINUSE): IPv4 only.
    }
  }

  const timeoutMs = deps.callbackTimeoutMs ?? GITLAB_CALLBACK_TIMEOUT_MS;
  const timer = setTimeout(
    () => settle?.reject(new Error(`GitLab Duo OAuth callback timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  timer.unref();

  const onAbort = (): void => settle?.reject(new Error(`OAuth login cancelled: ${String(signal?.reason)}`));
  signal?.addEventListener("abort", onAbort, { once: true });

  const redirectUri = deps.redirectUri ?? `http://${host}:${actualPort}${path}`;

  return {
    redirectUri,
    code,
    close: async () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      await Promise.all(servers.map(closeListener));
    },
  };
}

export async function loginGitLabDuo(
  callbacks: GitLabDuoLoginCallbacks,
  deps: GitLabDuoOAuthDeps = {},
): Promise<GitLabDuoOAuthCredentials> {
  const env = deps.env ?? process.env;
  const clientId = deps.urls?.clientId ?? env.GITLAB_CLIENT_ID ?? GITLAB_CLIENT_ID;
  const authorizeUrl = deps.urls?.authorizeUrl ?? GITLAB_AUTHORIZE_URL;
  const tokenUrl = deps.urls?.tokenUrl ?? GITLAB_TOKEN_URL;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;

  if (callbacks.signal?.aborted) {
    throw new Error("OAuth login cancelled");
  }

  const state = randomBytes(16).toString("hex");
  const pkce = generatePkce();

  const server = await startCallbackServer(deps, state, callbacks.signal);
  let code: string;
  try {
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: server.redirectUri,
      scope: "api",
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    });
    const fullAuthUrl = `${authorizeUrl}?${params.toString()}`;
    const instructions =
      'Complete GitLab login in browser. If GitLab responds with "The redirect URI included is not valid", register your own GitLab OAuth application and set GITLAB_CLIENT_ID + GITLAB_REDIRECT_URI, or use a Personal Access Token via GITLAB_TOKEN.';

    callbacks.onAuth?.({ url: fullAuthUrl, instructions });
    deps.openBrowser?.(fullAuthUrl);
    callbacks.onProgress?.("Waiting for browser authentication...");
    code = await server.code;
  } finally {
    await server.close();
  }

  callbacks.onProgress?.("Exchanging authorization code for tokens...");
  const hash = code.indexOf("#");
  const exchangeCode = hash >= 0 ? code.slice(0, hash) : code;

  const tokenBody = await postGitLabTokenForm(
    tokenUrl,
    {
      grant_type: "authorization_code",
      client_id: clientId,
      code: exchangeCode,
      redirect_uri: server.redirectUri,
      code_verifier: pkce.verifier,
    },
    { fetch: fetchImpl, failure: "GitLab Duo token exchange failed", ...(callbacks.signal !== undefined ? { signal: callbacks.signal } : {}) },
  );

  const access = typeof tokenBody?.access_token === "string" ? tokenBody.access_token : "";
  if (!access) {
    throw new Error("GitLab Duo token response missing access token");
  }

  const refresh = typeof tokenBody?.refresh_token === "string" ? tokenBody.refresh_token : "";
  const expiresIn = typeof tokenBody?.expires_in === "number" ? tokenBody.expires_in : 7200;
  const createdAt = typeof tokenBody?.created_at === "number" ? tokenBody.created_at * 1000 : now();
  const expires = createdAt + expiresIn * 1000 - GITLAB_EXPIRES_SKEW_MS;

  // Clear direct access cache per gitlab-duo-clear-cache hook
  clearGitLabDuoDirectAccessCache();

  return {
    access,
    refresh,
    expires,
  };
}

export async function refreshGitLabDuo(
  stored: GitLabDuoOAuthCredentials,
  deps: GitLabDuoOAuthDeps = {},
  signal?: AbortSignal,
): Promise<GitLabDuoOAuthCredentials> {
  const env = deps.env ?? process.env;
  const clientId = deps.urls?.clientId ?? env.GITLAB_CLIENT_ID ?? GITLAB_CLIENT_ID;
  const tokenUrl = deps.urls?.tokenUrl ?? GITLAB_TOKEN_URL;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;

  if (!stored.refresh) {
    throw new Error("GitLab Duo credentials missing refresh token; sign in again");
  }

  const tokenBody = await postGitLabTokenForm(
    tokenUrl,
    { grant_type: "refresh_token", client_id: clientId, refresh_token: stored.refresh },
    { fetch: fetchImpl, failure: "GitLab Duo token refresh failed", ...(signal !== undefined ? { signal } : {}) },
  );

  const access = typeof tokenBody?.access_token === "string" ? tokenBody.access_token : "";
  if (!access) {
    throw new Error("GitLab Duo refresh response missing access token");
  }

  const refresh = typeof tokenBody?.refresh_token === "string" ? tokenBody.refresh_token : stored.refresh;
  const expiresIn = typeof tokenBody?.expires_in === "number" ? tokenBody.expires_in : 7200;
  const createdAt = typeof tokenBody?.created_at === "number" ? tokenBody.created_at * 1000 : now();
  const expires = createdAt + expiresIn * 1000 - GITLAB_EXPIRES_SKEW_MS;

  // Clear direct access cache per gitlab-duo-clear-cache hook
  clearGitLabDuoDirectAccessCache();

  return {
    ...stored,
    access,
    refresh,
    expires,
  };
}

export async function getDirectAccessToken(
  gitlabAccessToken: string,
  fetchImpl: typeof fetch = fetch,
  directAccessUrl: string = GITLAB_DIRECT_ACCESS_URL,
  now: () => number = Date.now,
): Promise<DirectAccessToken> {
  const cached = directAccessCache.get(gitlabAccessToken);
  if (cached && cached.expiresAt > now()) {
    return cached;
  }

  const response = await fetchImpl(directAccessUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${gitlabAccessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      feature_flags: { DuoAgentPlatformNext: true },
    }),
  });

  const detail = await response.text();
  if (!response.ok) {
    throw new Error(`GitLab Duo direct access failed: ${response.status} ${redactTokens(detail.slice(0, 500))}`);
  }

  let payload: any;
  try {
    payload = JSON.parse(detail);
  } catch {
    throw new Error("GitLab Duo direct access response missing valid JSON");
  }

  if (!payload?.token || typeof payload.token !== "string") {
    throw new Error("GitLab Duo direct access response missing token");
  }
  if (!payload?.headers || typeof payload.headers !== "object") {
    throw new Error("GitLab Duo direct access response missing headers");
  }

  const token: DirectAccessToken = {
    token: payload.token,
    headers: payload.headers,
    expiresAt: now() + DIRECT_ACCESS_TTL_MS,
  };
  directAccessCache.set(gitlabAccessToken, token);
  return token;
}
