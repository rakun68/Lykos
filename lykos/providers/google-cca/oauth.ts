// The Google loopback authorization-code login and refresh.
//
// Authorize URL, token exchange, refresh-token grant, userinfo, the loopback callback with a
// state check, and S256 PKCE: exactly what the two Google rules use.
//
// Everything external is injectable: fetch, the browser opener, the callback
// host and port, the clock and every Google URL, so tests run against a local
// fake with port 0 and nothing reaches Google.
//
// Choices, each deliberate:
// - PKCE is sent (see rules.ts).
// - A callback that carries a code with the wrong `state` fails the login at
//   once. The foreign code is never exchanged.
// - No manual-paste race: the flow waits for the loopback callback only. Pi's
//   adapter always offers `onManualCodeInput`, which would read the CLI's stdin
//   while the browser flow runs.
// - Refresh merges the stored credential under the refreshed one, so `email`
//   survives a refresh and ticket 02's identity key stays stable.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { applyProjectHook, GoogleOAuthError, type ProjectHookContext, timedFetch } from "./project.js";
import { decodeRuleValue, type GoogleOAuthRule } from "./rules.js";
import type { FetchLike, OAuthCredentials, OAuthLoginCallbacks } from "./types.js";

export const CALLBACK_TIMEOUT_MS = 300_000;

export interface GoogleOAuthEndpoints {
  authorizeUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  /** Cloud Code Assist control plane (loadCodeAssist, onboardUser, operations). */
  controlPlaneUrl?: string;
}

export interface GoogleOAuthDeps {
  fetch?: FetchLike;
  /**
   * Opens the authorize URL. Pi's `onAuth` callback is always notified too;
   * under `lykos login` that notification is what opens the browser, so
   * production leaves this unset.
   */
  openBrowser?: (url: string) => void;
  /** Loopback bind host. Defaults to the rule's `127.0.0.1`. */
  callbackHost?: string;
  /** Loopback port. Defaults to the rule's fixed port; `0` binds an ephemeral one. */
  callbackPort?: number;
  now?: () => number;
  endpoints?: GoogleOAuthEndpoints;
  /** Control-plane operation poll interval (tests shorten it). */
  pollIntervalMs?: number;
  env?: NodeJS.ProcessEnv;
  callbackTimeoutMs?: number;
}

function resolved(rule: GoogleOAuthRule, deps: GoogleOAuthDeps) {
  return {
    fetch: deps.fetch ?? globalThis.fetch,
    now: deps.now ?? Date.now,
    authorizeUrl: deps.endpoints?.authorizeUrl ?? rule.authorizeUrl,
    tokenUrl: deps.endpoints?.tokenUrl ?? rule.tokenUrl,
    userinfoUrl: deps.endpoints?.userinfoUrl ?? rule.userinfoUrl,
    clientId: decodeRuleValue(rule.clientIdBase64),
    clientSecret: decodeRuleValue(rule.clientSecretBase64),
  };
}

function projectContext(
  deps: GoogleOAuthDeps,
  fetchImpl: FetchLike,
  signal: AbortSignal | undefined,
  onProgress?: (message: string) => void,
): ProjectHookContext {
  return {
    fetch: fetchImpl,
    ...(deps.endpoints?.controlPlaneUrl !== undefined ? { controlPlaneUrl: deps.endpoints.controlPlaneUrl } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(onProgress !== undefined ? { onProgress } : {}),
    ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };
}

/** 96 random bytes as the verifier, SHA-256 base64url as the challenge. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(96).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** 16 random bytes as hex. */
function generateState(): string {
  return randomBytes(16).toString("hex");
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(ok: boolean, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Lykos sign-in</title></head><body><p>${escapeHtml(
    ok ? "Signed in. You can close this tab and return to Lykos." : message,
  )}</p></body></html>`;
}

interface CallbackServer {
  redirectUri: string;
  /** Resolves with the authorization code, or rejects. */
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

async function startCallbackServer(
  rule: GoogleOAuthRule,
  deps: GoogleOAuthDeps,
  expectedState: string,
  signal: AbortSignal | undefined,
): Promise<CallbackServer> {
  const host = deps.callbackHost ?? rule.callback.hostname;
  const path = rule.callback.path;
  let settle: { resolve: (code: string) => void; reject: (err: Error) => void } | undefined;
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  code.catch(() => {});

  const server = createServer((req, res) => {
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
      // Only a denial carrying our state nonce is genuine; others can be forged by any local process.
      outcome = { ok: false, message: `Authorization failed: ${description}`, fatal: state === expectedState };
    } else if (!got) {
      outcome = { ok: false, message: "Missing authorization code", fatal: false };
    } else if (state !== expectedState) {
      outcome = { ok: false, message: "State mismatch - possible CSRF attack", fatal: true };
    } else {
      outcome = { ok: true, code: got };
    }
    res.writeHead(outcome.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
    res.end(page(outcome.ok, outcome.ok ? "" : outcome.message));
    if (outcome.ok) settle?.resolve(outcome.code);
    else if (outcome.fatal) settle?.reject(new GoogleOAuthError(`${rule.provider} OAuth callback: ${outcome.message}`));
  });

  const port = deps.callbackPort ?? rule.callback.port;
  try {
    await listen(server, host, port);
  } catch (err) {
    const busy = (err as NodeJS.ErrnoException).code === "EADDRINUSE";
    if (!busy || !rule.callback.portFallback || port === 0) throw err;
    // `portFallback #true`: the rule's port is taken, so bind any free one.
    await listen(server, host, 0);
  }
  const actual = (server.address() as AddressInfo).port;

  const timeoutMs = deps.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS;
  const timer = setTimeout(
    () => settle?.reject(new GoogleOAuthError(`${rule.provider} OAuth callback timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  timer.unref();
  const onAbort = (): void => settle?.reject(new GoogleOAuthError(`OAuth login cancelled: ${String(signal?.reason)}`));
  signal?.addEventListener("abort", onAbort, { once: true });

  return {
    redirectUri: `http://${host}:${actual}${path}`,
    code,
    close: async () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      // A browser may hold a keep-alive socket open; drop it once the page has had time to flush.
      const force = setTimeout(() => server.closeAllConnections(), 1_000);
      force.unref();
      await closed;
      clearTimeout(force);
    },
  };
}

interface TokenResponse {
  body: unknown;
}

/** How many times a token request is tried when the connection itself fails. */
const CONNECT_ATTEMPTS = 3;

/** Errors raised before a connection opened (Node's fetch puts the code on `cause`). */
const CONNECT_FAILURE_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

function connectFailureCode(err: unknown): string | undefined {
  const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : undefined;
  return code !== undefined && CONNECT_FAILURE_CODES.has(code) ? code : undefined;
}

async function postToken(
  fetchImpl: FetchLike,
  url: string,
  params: Record<string, string>,
  provider: string,
  kind: "token exchange" | "token refresh",
  signal: AbortSignal | undefined,
): Promise<TokenResponse> {
  let response: Response | undefined;
  for (let attempt = 1; response === undefined; attempt++) {
    try {
      response = await timedFetch(
        fetchImpl,
        url,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(params).toString(),
        },
        signal,
      );
    } catch (err) {
      if (err instanceof GoogleOAuthError) throw err;
      const code = connectFailureCode(err);
      // The connection never opened, so Google never saw the request and a
      // one-time authorization code is still unused: retrying is safe. Seen
      // live on 2026-09-24: a fresh process's first connect timed out (10 s)
      // on 5 of 6 logins, while the next connect answered in ~60 ms.
      if (code !== undefined && attempt < CONNECT_ATTEMPTS && signal?.aborted !== true) continue;
      const detail = err instanceof Error ? err.message : String(err);
      throw new GoogleOAuthError(`${provider} request to ${url} failed: ${detail}${code !== undefined ? ` (${code}, ${attempt} attempt(s))` : ""}`);
    }
  }
  const text = await response.text();
  let body: unknown;
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    throw new GoogleOAuthError(`${provider} ${kind} failed: ${response.status} ${text.slice(0, 500)}`, response.status);
  }
  return { body: body ?? text };
}

function jsonPath(body: unknown, path: string): unknown {
  let current: unknown = body;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function mapCredentials(
  rule: GoogleOAuthRule,
  body: unknown,
  now: () => number,
  previous?: OAuthCredentials,
): OAuthCredentials {
  const access = scalarString(jsonPath(body, "access_token"));
  if (!access) {
    const excerpt = typeof body === "string" ? body : JSON.stringify(body);
    throw new GoogleOAuthError(`${rule.provider} token response missing access token: ${(excerpt ?? "").slice(0, 500)}`);
  }
  const seconds = jsonPath(body, rule.expiresPath);
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    throw new GoogleOAuthError(`${rule.provider} token response missing ${rule.expiresPath}`);
  }
  return {
    access,
    refresh: scalarString(jsonPath(body, "refresh_token")) ?? previous?.refresh ?? "",
    expires: now() + seconds * 1000 - rule.expiresSkewMs,
  };
}

/** A failed lookup leaves `email` unset rather than failing login. */
async function applyUserinfo(
  rule: GoogleOAuthRule,
  url: string,
  credentials: OAuthCredentials,
  fetchImpl: FetchLike,
  signal: AbortSignal | undefined,
): Promise<OAuthCredentials> {
  try {
    const response = await timedFetch(fetchImpl, url, { headers: { Authorization: `Bearer ${credentials.access}` } }, signal);
    if (!response.ok) return credentials;
    const email = scalarString(jsonPath(await response.json(), rule.userinfoEmail));
    return email !== undefined ? { ...credentials, email } : credentials;
  } catch {
    if (signal?.aborted) throw new GoogleOAuthError("OAuth login cancelled");
    return credentials;
  }
}

/** The authorize URL for one rule (standard parameters, then the rule's extras). */
export function buildAuthorizeUrl(
  rule: GoogleOAuthRule,
  authorizeUrl: string,
  clientId: string,
  redirectUri: string,
  state: string,
  challenge: string | undefined,
): string {
  const params = new URLSearchParams();
  params.set("client_id", clientId);
  params.set("response_type", "code");
  params.set("redirect_uri", redirectUri);
  if (rule.scopes.length > 0) params.set("scope", rule.scopes.join(" "));
  if (challenge !== undefined) {
    params.set("code_challenge", challenge);
    params.set("code_challenge_method", "S256");
  }
  params.set("state", state);
  for (const [key, value] of Object.entries(rule.authorizeParams)) params.set(key, value);
  return `${authorizeUrl}?${params.toString()}`;
}

/** Run one rule's loopback authorization-code login. The result carries `email` and `projectId`. */
export async function loginGoogle(
  rule: GoogleOAuthRule,
  callbacks: Pick<OAuthLoginCallbacks, "onAuth" | "onProgress" | "signal">,
  deps: GoogleOAuthDeps = {},
): Promise<OAuthCredentials> {
  const r = resolved(rule, deps);
  const signal = callbacks.signal;
  const onProgress = callbacks.onProgress?.bind(callbacks);
  const state = generateState();
  const pkce = rule.pkce ? generatePkce() : undefined;

  const server = await startCallbackServer(rule, deps, state, signal);
  let code: string;
  try {
    const url = buildAuthorizeUrl(rule, r.authorizeUrl, r.clientId, server.redirectUri, state, pkce?.challenge);
    callbacks.onAuth({ url, instructions: rule.instructions });
    deps.openBrowser?.(url);
    onProgress?.("Waiting for browser authentication...");
    code = await server.code;
  } finally {
    await server.close();
  }

  onProgress?.("Exchanging authorization code for tokens...");
  // Providers may echo `code#state`; the fragment is not part of the code.
  const hash = code.indexOf("#");
  const exchangeCode = hash >= 0 ? code.slice(0, hash) : code;
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    client_id: r.clientId,
    client_secret: r.clientSecret,
    code: exchangeCode,
    redirect_uri: server.redirectUri,
  };
  if (pkce !== undefined) params.code_verifier = pkce.verifier;
  const { body } = await postToken(r.fetch, r.tokenUrl, params, rule.provider, "token exchange", signal);

  let credentials = mapCredentials(rule, body, r.now);
  credentials = await applyUserinfo(rule, r.userinfoUrl, credentials, r.fetch, signal);
  return applyProjectHook(credentials, {
    ...projectContext(deps, r.fetch, signal, onProgress),
    provider: rule.provider,
    phase: "login",
    raw: body,
  });
}

/** Refresh one rule's credential. Requires `projectId`; keeps every stored field the response does not replace. */
export async function refreshGoogle(
  rule: GoogleOAuthRule,
  stored: OAuthCredentials,
  deps: GoogleOAuthDeps = {},
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  for (const field of rule.refreshRequire) {
    if (!stored[field]) throw new GoogleOAuthError(`${rule.provider} credentials are missing ${field}; sign in again`);
  }
  const r = resolved(rule, deps);
  const { body } = await postToken(
    r.fetch,
    r.tokenUrl,
    {
      grant_type: "refresh_token",
      client_id: r.clientId,
      client_secret: r.clientSecret,
      refresh_token: stored.refresh,
    },
    rule.provider,
    "token refresh",
    signal,
  );
  const refreshed = await applyProjectHook(mapCredentials(rule, body, r.now, stored), {
    ...projectContext(deps, r.fetch, signal),
    provider: rule.provider,
    phase: "refresh",
    raw: body,
    stored,
  });
  const { type: _type, ...rest } = stored as OAuthCredentials & { type?: unknown };
  return { ...rest, ...refreshed };
}

/** The structured api key the stream reads: `{ token, projectId }`. */
export function structuredApiKey(credentials: OAuthCredentials): string {
  const projectId = typeof credentials.projectId === "string" ? credentials.projectId : undefined;
  return JSON.stringify({ token: credentials.access, projectId });
}
