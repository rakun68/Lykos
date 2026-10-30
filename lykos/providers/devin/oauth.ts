// Devin login.
//
// The rule: authorization code with PKCE and a `uuid` state; authorize at
// `https://app.devin.ai/auth/cli/continue` with the standard parameters (the rule has no
// client id) plus `prompt=select_account`; loopback callback on 127.0.0.1:59653/callback;
// token exchange as JSON (`standard=#false`, so only `code` and `code_verifier`) at
// `https://api.devin.ai/auth/cli/token` with `Accept: application/json`; credential
// `access` = `refresh` = the response's `token`, expiry from the JWT `exp` less the
// compiled 5-minute skew, else one year; `apiEndpoint` and `enterpriseUrl` literals;
// refresh "none".
//
// Deliberate choices:
// - Plan D1: the port is fixed. When 59653 is taken, Lykos reports the busy port plainly.
//   random port when 59653 is taken; Lykos reports the busy port plainly instead. Tests
//   inject the port (0 binds an ephemeral one).
// - A callback that carries a code with the wrong `state` fails the login at once (as in
//   ticket 04's Google login). The code is never exchanged.
// - No manual-paste race and no `/launch` route: the flow waits for the loopback callback only.
// - No thrown message carries a token or a response body: a failed exchange names its status.
// - No refresh: an expired credential asks for `lykos login devin` again.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthCredentials, OAuthLoginCallbacks } from "../google-cca/types.js";

// Devin's CLI login endpoints.
export const DEVIN_AUTHORIZE_URL = "https://app.devin.ai/auth/cli/continue";
export const DEVIN_TOKEN_URL = "https://api.devin.ai/auth/cli/token";
export const DEVIN_CALLBACK_HOST = "127.0.0.1";
export const DEVIN_CALLBACK_PORT = 59653;
export const DEVIN_CALLBACK_PATH = "/callback";
export const DEVIN_API_ENDPOINT = "https://api.devin.ai";
export const DEVIN_ENTERPRISE_URL = "https://app.devin.ai";
export const DEVIN_INSTRUCTIONS = "Sign in to Devin in your browser.";
/** `expires "jwt"`: the compiled `skewMs`. */
export const DEVIN_JWT_SKEW_MS = 300_000;
/** `expires "jwt" fallback-ms=31536000000` (one year). */
export const DEVIN_EXPIRY_FALLBACK_MS = 31_536_000_000;
export const CALLBACK_TIMEOUT_MS = 300_000;
export const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

export interface DevinOAuthUrls {
  authorizeUrl?: string;
  tokenUrl?: string;
}

export interface DevinOAuthDeps {
  fetch?: typeof fetch;
  /** Opens the authorize URL. Pi's `onAuth` callback is always notified too. */
  openBrowser?: (url: string) => void;
  /** Loopback bind host. Defaults to the rule's `127.0.0.1`. */
  callbackHost?: string;
  /** Loopback port. Defaults to the rule's fixed 59653; tests pass 0. */
  callbackPort?: number;
  callbackTimeoutMs?: number;
  now?: () => number;
  urls?: DevinOAuthUrls;
}

export class DevinOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevinOAuthError";
  }
}

/** 96 random bytes as a base64url verifier, its SHA-256 as the challenge. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(96).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Unverified, `null` when malformed. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    return decoded !== null && typeof decoded === "object" ? (decoded as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The token's expiry: the `exp` claim less the skew, else now plus the fallback. */
export function devinTokenExpiry(token: string, now: () => number = Date.now): number {
  const exp = decodeJwtPayload(token)?.exp;
  if (typeof exp === "number" && Number.isFinite(exp)) return exp * 1000 - DEVIN_JWT_SKEW_MS;
  return now() + DEVIN_EXPIRY_FALLBACK_MS;
}

/** The authorize URL: the standard parameters (no client id), then `prompt`. */
export function buildDevinAuthorizeUrl(authorizeUrl: string, redirectUri: string, state: string, challenge: string): string {
  const params = new URLSearchParams();
  params.set("response_type", "code");
  params.set("redirect_uri", redirectUri);
  params.set("code_challenge", challenge);
  params.set("code_challenge_method", "S256");
  params.set("state", state);
  params.set("prompt", "select_account");
  return `${authorizeUrl}?${params.toString()}`;
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

async function startCallbackServer(deps: DevinOAuthDeps, expectedState: string, signal: AbortSignal | undefined): Promise<CallbackServer> {
  const host = deps.callbackHost ?? DEVIN_CALLBACK_HOST;
  let settle: { resolve: (code: string) => void; reject: (err: Error) => void } | undefined;
  const code = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  code.catch(() => {});

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname !== DEVIN_CALLBACK_PATH) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found");
      return;
    }
    const got = url.searchParams.get("code");
    const state = url.searchParams.get("state") ?? "";
    const error = url.searchParams.get("error") ?? "";
    const description = url.searchParams.get("error_description") || error;
    let outcome: { ok: true; code: string } | { ok: false; message: string; fatal: boolean };
    if (error) {
      // Only a denial carrying our state nonce is genuine; any local process can forge the rest.
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
    else if (outcome.fatal) settle?.reject(new DevinOAuthError(`Devin OAuth callback: ${outcome.message}`));
  });

  const port = deps.callbackPort ?? DEVIN_CALLBACK_PORT;
  try {
    await listen(server, host, port);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new DevinOAuthError(
        `Devin login needs ${host}:${port} for its callback, and that port is in use. Free port ${port} and run \`lykos login devin\` again.`,
      );
    }
    throw err;
  }
  const actual = (server.address() as AddressInfo).port;

  const timeoutMs = deps.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS;
  const timer = setTimeout(() => settle?.reject(new DevinOAuthError(`Devin OAuth callback timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref();
  const onAbort = (): void => settle?.reject(new DevinOAuthError("Devin login cancelled"));
  if (signal?.aborted) onAbort();
  signal?.addEventListener("abort", onAbort, { once: true });

  return {
    redirectUri: `http://${host}:${actual}${DEVIN_CALLBACK_PATH}`,
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

/** The declared token exchange: a JSON POST of `code` and `code_verifier` only. */
async function exchangeCode(
  deps: DevinOAuthDeps,
  code: string,
  verifier: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const url = deps.urls?.tokenUrl ?? DEVIN_TOKEN_URL;
  const timeout = AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: verifier }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw new DevinOAuthError("Devin login cancelled");
    if (timeout.aborted) throw new DevinOAuthError(`Timed out waiting for ${url}`);
    throw new DevinOAuthError(`devin request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await response.text();
  if (!response.ok) {
    // The body is not quoted: it can carry account details.
    throw new DevinOAuthError(`devin token exchange failed: ${response.status}`);
  }
  try {
    return text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

/** Run Devin's loopback authorization-code login. */
export async function loginDevin(
  callbacks: Pick<OAuthLoginCallbacks, "onAuth" | "onProgress" | "signal">,
  deps: DevinOAuthDeps = {},
): Promise<OAuthCredentials> {
  const signal = callbacks.signal;
  const now = deps.now ?? Date.now;
  const state = randomUUID();
  const pkce = generatePkce();

  const server = await startCallbackServer(deps, state, signal);
  let code: string;
  try {
    const url = buildDevinAuthorizeUrl(deps.urls?.authorizeUrl ?? DEVIN_AUTHORIZE_URL, server.redirectUri, state, pkce.challenge);
    callbacks.onAuth({ url, instructions: DEVIN_INSTRUCTIONS });
    deps.openBrowser?.(url);
    callbacks.onProgress?.("Waiting for browser authentication...");
    code = await server.code;
  } finally {
    await server.close();
  }

  callbacks.onProgress?.("Exchanging authorization code for tokens...");
  // Providers may echo `code#state`; the fragment is not part of the code.
  const hash = code.indexOf("#");
  const body = await exchangeCode(deps, hash >= 0 ? code.slice(0, hash) : code, pkce.verifier, signal);

  const token = (body as { token?: unknown } | undefined)?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new DevinOAuthError("devin token response missing access token");
  }
  return {
    access: token,
    refresh: token,
    expires: devinTokenExpiry(token, now),
    apiEndpoint: DEVIN_API_ENDPOINT,
    enterpriseUrl: DEVIN_ENTERPRISE_URL,
  };
}

/** `refresh "none"`: a live credential is kept; an expired one asks for a new login. */
export async function refreshDevin(credentials: OAuthCredentials, now: () => number = Date.now): Promise<OAuthCredentials> {
  if (typeof credentials.expires === "number" && now() >= credentials.expires) {
    throw new DevinOAuthError("Devin token has expired; run `lykos login devin` again");
  }
  return credentials;
}
