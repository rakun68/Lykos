// Shared machinery for the Anthropic and Codex browser logins.
//
// The loopback callback with its state check and manual-paste race, PKCE (a
// 96-byte base64url verifier, S256), the token request and its field mapping,
// and the hex state with its `code#state` fragment.
//
// Deliberate choices:
// - The listener binds 127.0.0.1 only, as Pi 0.84.3's own flows do (`CALLBACK_HOST` in
//   pi-ai dist/auth/oauth/anthropic.js).
// - No `/launch` route and no native-scheme receiver: neither provider here uses one.
// - A failed token request names its status only: the body may carry a token. No thrown message here carries a token.
// - The interaction is Pi's native one (`prompt` / `notify`), which `runLoginFlow` supplies.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Pi's native provider (`registerNativeProvider`'s argument). */
export type NativeProvider = Parameters<ModelRuntime["registerNativeProvider"]>[0];
export type NativeOAuth = NonNullable<NativeProvider["auth"]["oauth"]>;
/** Pi's `ProviderAuthInteraction`: `prompt`, `notify` and a required `signal`. */
export type LoginInteraction = Parameters<NativeOAuth["login"]>[0];
/** Pi's stored `OAuthCredential` (`type: "oauth"`, `access`, `refresh`, `expires`, extras). */
export type OAuthCredential = Parameters<NativeOAuth["refresh"]>[0];
export type FetchLike = typeof globalThis.fetch;

export const CALLBACK_TIMEOUT_MS = 300_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** The listener's bind host: Pi 0.84.3's default `PI_OAUTH_CALLBACK_HOST` fallback. */
export const LOOPBACK_BIND_HOST = "127.0.0.1";
/** Pi 0.84.3's manual prompt message (anthropic.js and openai-codex.js). */
export const MANUAL_CODE_MESSAGE = "Complete login in your browser, or paste the authorization code / redirect URL here:";

export class OAuthLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthLoginError";
  }
}

/** 96 random bytes as a base64url verifier, its SHA-256 as the challenge. */
export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(96).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** 16 random bytes as hex. */
export function generateState(): string {
  return randomBytes(16).toString("hex");
}

/** Unverified, `null` when malformed. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    return decoded !== null && typeof decoded === "object" ? (decoded as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A redirect URL, a query string, or `code#state`. */
export function parseCallbackInput(input: string): { code?: string | undefined; state?: string | undefined } {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return { code: url.searchParams.get("code") ?? undefined, state: url.searchParams.get("state") ?? undefined };
  } catch {
    // Not a URL.
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value.replace(/^[?#]/, ""));
    return { code: params.get("code") ?? undefined, state: params.get("state") ?? undefined };
  }
  const [code, state] = value.split("#", 2);
  return { code, ...(state !== undefined ? { state } : {}) };
}

/** Reads `a.b.c` from a parsed body. */
export function jsonPath(body: unknown, path: string): unknown {
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

/** The token-response fields a rule maps. */
export interface CredentialMap {
  /** `expires "seconds" path="expires_in" skew-ms=…`. */
  skewMs: number;
  /** Optional identity fields: credential field name → JSON path in the response. */
  optional?: Partial<Record<"accountId" | "email" | "orgId" | "orgName", string>>;
}

/**
 * Maps a token response: `access_token`, `refresh_token`, and `expires_in` seconds. A missing refresh token keeps `previousRefresh`.
 * The result is Pi's credential shape: `type`, `access`, `refresh`, `expires`, plus extras.
 */
export function mapTokenResponse(
  provider: string,
  body: unknown,
  map: CredentialMap,
  now: () => number,
  previousRefresh?: string,
): OAuthCredential {
  const access = scalarString(jsonPath(body, "access_token"));
  if (!access) throw new OAuthLoginError(`${provider} token response missing access token`);
  const seconds = jsonPath(body, "expires_in");
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    throw new OAuthLoginError(`${provider} token response missing expires_in`);
  }
  const credential: OAuthCredential = {
    type: "oauth",
    access,
    refresh: scalarString(jsonPath(body, "refresh_token")) ?? previousRefresh ?? "",
    expires: now() + seconds * 1000 - map.skewMs,
  };
  for (const [field, path] of Object.entries(map.optional ?? {})) {
    const value = scalarString(jsonPath(body, path));
    if (value !== undefined) credential[field] = value;
  }
  return credential;
}

export interface TokenRequest {
  provider: string;
  url: string;
  body: "json" | "form";
  params: Record<string, string>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  kind: "token exchange" | "token refresh";
}

/**
 * One POST, the declared headers under `Content-Type`,
 * JSON or form body, a request timeout joined to the caller's signal. A non-2xx names its
 * status only.
 */
export async function postTokenRequest(req: TokenRequest, fetchImpl: FetchLike, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(req.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(req.url, {
      method: "POST",
      headers: {
        ...req.headers,
        "Content-Type": req.body === "json" ? "application/json" : "application/x-www-form-urlencoded",
      },
      body: req.body === "json" ? JSON.stringify(req.params) : new URLSearchParams(req.params).toString(),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw new OAuthLoginError(`${req.provider} login cancelled`);
    if (timeout.aborted) throw new OAuthLoginError(`Timed out waiting for ${req.url}`);
    throw new OAuthLoginError(`${req.provider} request to ${req.url} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await response.text();
  if (!response.ok) throw new OAuthLoginError(`${req.provider} ${req.kind} failed: ${response.status}`);
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Splits a `code#state` echo: the fragment wins over the flow's state. */
export function splitCodeFragment(code: string, state: string): { code: string; state: string } {
  const hash = code.indexOf("#");
  if (hash < 0) return { code, state };
  return { code: code.slice(0, hash), state: code.slice(hash + 1) || state };
}

export interface CodeFlowOptions {
  /** Provider label for messages. */
  provider: string;
  interaction: LoginInteraction;
  /** The port to bind. Tests pass 0. */
  port: number;
  path: string;
  /** Whether a busy port may fall back to a random one (the rule's `port-fallback`). */
  portFallback: boolean;
  /** An exact redirect URI to advertise whatever port was bound (`redirect-uri=`). */
  fixedRedirectUri?: string;
  /** How the redirect URI names the loopback host when not fixed: the rule's `hostname`. */
  redirectHost: string;
  state?: string;
  instructions: string;
  /** Build the authorize URL from the redirect URI actually advertised. */
  buildAuthUrl(redirectUri: string): string;
  openBrowser?: (url: string) => void;
  /** Called with the bound port (tests use it to deliver the callback). */
  onListening?: (port: number) => void;
  timeoutMs?: number;
  /** Command for the busy-port hint. */
  loginCommand: string;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(ok: boolean, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Lykos sign-in</title></head><body><p>${escapeHtml(
    ok ? "Signed in. You can close this tab and return to Lykos." : message,
  )}</p></body></html>`;
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

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
}

/**
 * The login up to the exchange: bind the loopback callback,
 * announce the authorize URL, then race the browser callback against a pasted code or
 * redirect URL. Resolves with the code (fragment split) and the state to exchange with.
 */
export async function runCodeFlow(opts: CodeFlowOptions): Promise<{ code: string; state: string; redirectUri: string }> {
  const { interaction, provider } = opts;
  const signal = interaction.signal;
  if (signal.aborted) throw new OAuthLoginError(`${provider} login cancelled`);

  let settle: { resolve: (code: string) => void; reject: (err: Error) => void } | undefined;
  const callback = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  callback.catch(() => {});

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== opts.path) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not Found");
      return;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state") || "";
    const error = url.searchParams.get("error") || "";
    const description = url.searchParams.get("error_description") || error;
    let outcome: { ok: true; code: string } | { ok: false; message: string };
    if (error) outcome = { ok: false, message: `Authorization failed: ${description}` };
    else if (!code) outcome = { ok: false, message: "Missing authorization code" };
    else if (opts.state !== undefined && state !== opts.state) outcome = { ok: false, message: "State mismatch - possible CSRF attack" };
    else outcome = { ok: true, code };
    res.writeHead(outcome.ok ? 200 : 500, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
    res.end(page(outcome.ok, outcome.ok ? "" : outcome.message));
    if (outcome.ok) settle?.resolve(outcome.code);
    // Only a denial carrying our state nonce is genuine; any local process can forge the rest.
    else if (error && (opts.state === undefined || state === opts.state)) settle?.reject(new OAuthLoginError(`${provider} ${outcome.message}`));
  });

  let port = opts.port;
  try {
    await listen(server, LOOPBACK_BIND_HOST, port);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    if (!opts.portFallback) {
      // The provider allowlists one redirect URI, so a busy port cannot fall back.
      throw new OAuthLoginError(
        `OAuth callback port ${port} is in use. The OAuth provider validates redirect URIs against its registered callback, so falling back to a random port would be rejected. Free port ${port} and run \`${opts.loginCommand}\` again.`,
      );
    }
    await listen(server, LOOPBACK_BIND_HOST, 0);
  }
  const actual = (server.address() as AddressInfo).port;
  if (actual !== port && port !== 0) {
    interaction.notify({ type: "progress", message: `Preferred port ${port} unavailable, using port ${actual}` });
  }
  port = actual;
  opts.onListening?.(port);
  const redirectUri = opts.fixedRedirectUri ?? `http://${opts.redirectHost}:${port}${opts.path}`;

  const timeoutMs = opts.timeoutMs ?? CALLBACK_TIMEOUT_MS;
  const timer = setTimeout(() => settle?.reject(new OAuthLoginError(`${provider} OAuth callback timed out after ${timeoutMs}ms`)), timeoutMs);
  timer.unref();
  const onAbort = (): void => settle?.reject(new OAuthLoginError(`${provider} login cancelled`));
  signal.addEventListener("abort", onAbort, { once: true });
  const manualAbort = new AbortController();

  try {
    const url = opts.buildAuthUrl(redirectUri);
    interaction.notify({ type: "auth_url", url, instructions: opts.instructions });
    opts.openBrowser?.(url);
    interaction.notify({ type: "progress", message: "Waiting for browser authentication..." });

    // The manual race: a pasted redirect URL or code. One without a code, or with another
    // state, is ignored and asked again.
    const manual = (async (): Promise<string> => {
      for (;;) {
        const input = await interaction.prompt({
          type: "manual_code",
          message: MANUAL_CODE_MESSAGE,
          placeholder: redirectUri,
          signal: manualAbort.signal,
        });
        const parsed = parseCallbackInput(input);
        if (!parsed.code) continue;
        if (opts.state !== undefined && parsed.state && parsed.state !== opts.state) continue;
        return opts.state && parsed.state ? `${parsed.code}#${parsed.state}` : parsed.code;
      }
    })();
    manual.catch(() => {});

    const code = await Promise.race([callback, manual]);
    const split = splitCodeFragment(code, opts.state ?? "");
    return { ...split, redirectUri };
  } finally {
    manualAbort.abort();
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    await closeServer(server);
  }
}

/** Sleep abortable with signal for device code polling. */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OAuthLoginError("Login cancelled"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new OAuthLoginError("Login cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
