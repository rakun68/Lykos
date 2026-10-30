// Cursor login and refresh.
//
// The flow: open `https://cursor.com/loginDeepControl?challenge&uuid&mode=login&redirectTarget=cli`,
// then poll `https://api2.cursor.sh/auth/poll?uuid&verifier` (404 = not yet) with
// backoff until it returns `{ accessToken, refreshToken }`. Refresh posts `{}` to
// `auth/exchange_user_api_key` with the refresh token as a bearer. Expiry is the access JWT's
// `exp` less five minutes, else one hour from now.
//
// Lykos changes: fetch, sleep, the browser opener, the clock and every URL are injectable, and
// no thrown message carries a token (the poll URL holds the PKCE verifier, so it is never quoted).

import { createHash, randomBytes, randomUUID } from "node:crypto";

export const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
export const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
export const CURSOR_REFRESH_URL = "https://api2.cursor.sh/auth/exchange_user_api_key";

export const POLL_MAX_ATTEMPTS = 150;
export const POLL_BASE_DELAY = 1000;
export const POLL_MAX_DELAY = 10000;
export const POLL_BACKOFF_MULTIPLIER = 1.2;

export interface CursorOAuthUrls {
  loginUrl?: string;
  pollUrl?: string;
  refreshUrl?: string;
}

export interface CursorOAuthDeps {
  fetch?: typeof fetch;
  /** Waits between polls. Defaults to a timer; tests pass a no-op. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Opens the login URL. Pi's `onAuth` callback is always notified too. */
  openBrowser?: (url: string) => void;
  now?: () => number;
  urls?: CursorOAuthUrls;
}

export interface CursorOAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
}

export interface CursorLoginCallbacks {
  onAuth?: (info: { url: string; instructions?: string }) => void;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export class CursorOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorOAuthError";
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CursorOAuthError("Cursor login cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new CursorOAuthError("Cursor login cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 96 random bytes as a base64url verifier, its SHA-256 as the challenge. */
export function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(96).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export interface CursorAuthParams {
  verifier: string;
  challenge: string;
  uuid: string;
  loginUrl: string;
}

export function generateCursorAuthParams(urls: CursorOAuthUrls = {}): CursorAuthParams {
  const { verifier, challenge } = generatePKCE();
  const uuid = randomUUID();
  const params = new URLSearchParams({
    challenge,
    uuid,
    mode: "login",
    redirectTarget: "cli",
  });
  const loginUrl = `${urls.loginUrl ?? CURSOR_LOGIN_URL}?${params.toString()}`;
  return { verifier, challenge, uuid, loginUrl };
}

/**
 * A 404 means the browser step is not done: the
 * delay grows by 1.2x up to 10 s. Any other failure counts toward three in a
 * row, which ends the login; 150 attempts end it too.
 */
export async function pollCursorAuth(
  uuid: string,
  verifier: string,
  deps: CursorOAuthDeps = {},
  signal?: AbortSignal,
): Promise<{ accessToken: string; refreshToken: string }> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const pollUrl = deps.urls?.pollUrl ?? CURSOR_POLL_URL;
  let delay = POLL_BASE_DELAY;
  let consecutiveErrors = 0;

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(delay, signal);
    if (signal?.aborted) throw new CursorOAuthError("Cursor login cancelled");

    try {
      const response = await fetchImpl(`${pollUrl}?uuid=${uuid}&verifier=${verifier}`, {
        ...(signal !== undefined ? { signal } : {}),
      });

      if (response.status === 404) {
        consecutiveErrors = 0;
        delay = Math.min(delay * POLL_BACKOFF_MULTIPLIER, POLL_MAX_DELAY);
        continue;
      }

      if (response.ok) {
        const data = (await response.json()) as { accessToken?: unknown; refreshToken?: unknown };
        if (typeof data.accessToken !== "string" || typeof data.refreshToken !== "string") {
          throw new CursorOAuthError("Cursor auth poll returned no tokens");
        }
        return { accessToken: data.accessToken, refreshToken: data.refreshToken };
      }

      throw new CursorOAuthError(`Poll failed: ${response.status}`);
    } catch {
      if (signal?.aborted) throw new CursorOAuthError("Cursor login cancelled");
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        throw new CursorOAuthError("Too many consecutive errors during Cursor auth polling");
      }
    }
  }

  throw new CursorOAuthError("Cursor authentication polling timeout");
}

function decodeCursorAccessTokenPayload(token: string): unknown {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const payload = parts[1];
  if (!payload) return undefined;
  return JSON.parse(Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

/** The JWT `exp` less five minutes, else one hour from now. */
export function getTokenExpiry(token: string, now: () => number = Date.now): number {
  try {
    const decoded = decodeCursorAccessTokenPayload(token);
    if (decoded && typeof decoded === "object" && "exp" in decoded && typeof decoded.exp === "number") {
      return decoded.exp * 1000 - 5 * 60 * 1000;
    }
  } catch {
    // Ignore parsing errors
  }
  return now() + 3600 * 1000;
}

export async function loginCursor(callbacks: CursorLoginCallbacks, deps: CursorOAuthDeps = {}): Promise<CursorOAuthCredentials> {
  const { verifier, uuid, loginUrl } = generateCursorAuthParams(deps.urls);
  callbacks.onAuth?.({ url: loginUrl });
  deps.openBrowser?.(loginUrl);
  callbacks.onProgress?.("Waiting for browser authentication...");

  const { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier, deps, callbacks.signal);
  return {
    access: accessToken,
    refresh: refreshToken,
    expires: getTokenExpiry(accessToken, deps.now),
  };
}

export async function refreshCursor(
  credentials: { refresh: string },
  deps: CursorOAuthDeps = {},
  signal?: AbortSignal,
): Promise<CursorOAuthCredentials> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const apiKeyOrRefreshToken = credentials.refresh;
  const response = await fetchImpl(deps.urls?.refreshUrl ?? CURSOR_REFRESH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKeyOrRefreshToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    ...(signal !== undefined ? { signal } : {}),
  });

  if (!response.ok) {
    // The response body is not quoted, because a refresh error body may echo the bearer it was sent.
    await response.body?.cancel().catch(() => {});
    throw new CursorOAuthError(`Cursor token refresh failed: ${response.status}`);
  }

  const data = (await response.json()) as { accessToken?: unknown; refreshToken?: unknown };
  if (typeof data.accessToken !== "string") {
    throw new CursorOAuthError("Cursor token refresh returned no access token");
  }
  return {
    access: data.accessToken,
    refresh: typeof data.refreshToken === "string" && data.refreshToken ? data.refreshToken : apiKeyOrRefreshToken,
    expires: getTokenExpiry(data.accessToken, deps.now),
  };
}
