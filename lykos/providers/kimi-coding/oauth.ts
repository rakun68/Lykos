// Kimi Code (subscription) login and refresh.
//
// The rule: RFC 8628 device authorization grant.
// Client id: 17e5f671-d194-4dfb-9706-5516cb48c098
// Base URL: https://auth.kimi.com (overridable by KIMI_CODE_OAUTH_HOST / KIMI_OAUTH_HOST)
// No device fingerprint headers are sent (see below).
// Refresh at the same token endpoint.
//
// Credential shape (plan D2): Pi 0.84.3's kimi-coding.js stores `type`, `access`, `refresh`,
// `expires`. The account id comes from the JWT user_id/sub claim. Both old and new rows
// resolve through Pi's toAuth ({ headers: { Authorization: `Bearer ${credential.access}` } }).

import {
  type FetchLike,
  type LoginInteraction,
  type OAuthCredential,
  OAuthLoginError,
  decodeJwtPayload,
  defaultSleep,
} from "../builtin-logins/code-flow.js";

export const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
export const KIMI_DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
export const KIMI_DEVICE_CODE_PATH = "/api/oauth/device_authorization";
export const KIMI_TOKEN_PATH = "/api/oauth/token";
export const KIMI_DEFAULT_POLL_INTERVAL_SECONDS = 5;
export const KIMI_DEVICE_CODE_TIMEOUT_SECONDS = 900;
export const KIMI_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Plan D3: Kimi accepts `X-Msh-*` device headers (host name, OS version, device model, device
 * id). Pi 0.84.3's kimi-coding.js sends none of them and its login works, so Lykos sends none either: no machine identifier leaves the machine that Pi's flow did
 * not already send.
 */
export function getKimiBaseUrl(override?: string): string {
  if (override) return override.replace(/\/+$/, "");
  const envHost = process.env.KIMI_CODE_OAUTH_HOST || process.env.KIMI_OAUTH_HOST;
  return (envHost || KIMI_DEFAULT_OAUTH_HOST).replace(/\/+$/, "");
}

export interface KimiOAuthUrls {
  base?: string;
  deviceUrl?: string;
  tokenUrl?: string;
}

export interface KimiOAuthDeps {
  fetch?: FetchLike;
  openBrowser?: (url: string) => void;
  pollIntervalSeconds?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  urls?: KimiOAuthUrls;
  headers?: Record<string, string>;
}

interface DeviceAuthResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

async function requestDeviceAuthorization(
  deviceUrl: string,
  deps: KimiOAuthDeps,
  signal?: AbortSignal,
): Promise<DeviceAuthResponse> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(KIMI_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(deviceUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        ...deps.headers,
      },
      body: new URLSearchParams({ client_id: KIMI_CLIENT_ID }).toString(),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw new OAuthLoginError("kimi-coding login cancelled");
    throw new OAuthLoginError(`kimi-coding request to ${deviceUrl} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await response.text();
  if (!response.ok) throw new OAuthLoginError(`kimi-coding device authorization failed: ${response.status}`);
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new OAuthLoginError("kimi-coding device authorization returned invalid JSON");
  }

  const deviceCode = json.device_code;
  const userCode = json.user_code;
  const verificationUri = json.verification_uri;
  const verificationUriComplete = json.verification_uri_complete;
  if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string") {
    throw new OAuthLoginError("kimi-coding device authorization response missing required fields");
  }

  const interval = json.interval;
  const expiresIn = json.expires_in;
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(typeof verificationUriComplete === "string" ? { verificationUriComplete } : {}),
    intervalSeconds:
      deps.pollIntervalSeconds ??
      (typeof interval === "number" && Number.isFinite(interval) && interval > 0 ? interval : KIMI_DEFAULT_POLL_INTERVAL_SECONDS),
    expiresInSeconds:
      typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : KIMI_DEVICE_CODE_TIMEOUT_SECONDS,
  };
}

function extractJwtAccountId(accessToken: string): string | undefined {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return undefined;
  const userId = payload.user_id ?? payload.sub;
  return typeof userId === "string" && userId.length > 0 ? userId : undefined;
}

/** Run Kimi Code's device authorization flow. */
export async function loginKimi(
  interaction: LoginInteraction,
  deps: KimiOAuthDeps = {},
): Promise<OAuthCredential> {
  const signal = interaction.signal;
  if (signal.aborted) throw new OAuthLoginError("kimi-coding login cancelled");
  const sleepImpl = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;

  const base = getKimiBaseUrl(deps.urls?.base);
  const deviceUrl = deps.urls?.deviceUrl ?? `${base}${KIMI_DEVICE_CODE_PATH}`;
  const tokenUrl = deps.urls?.tokenUrl ?? `${base}${KIMI_TOKEN_PATH}`;

  const device = await requestDeviceAuthorization(deviceUrl, deps, signal);
  const verificationUri = device.verificationUriComplete ?? device.verificationUri;
  interaction.notify({
    type: "device_code",
    userCode: device.userCode,
    verificationUri,
    intervalSeconds: device.intervalSeconds,
    expiresInSeconds: device.expiresInSeconds,
  });
  deps.openBrowser?.(verificationUri);

  const deadline = now() + device.expiresInSeconds * 1000;
  let intervalMs = Math.max(1000, Math.floor(device.intervalSeconds * 1000));
  const fetchImpl = deps.fetch ?? globalThis.fetch;

  while (now() < deadline) {
    if (signal.aborted) throw new OAuthLoginError("kimi-coding login cancelled");
    await sleepImpl(intervalMs, signal);
    if (signal.aborted) throw new OAuthLoginError("kimi-coding login cancelled");

    const timeout = AbortSignal.timeout(KIMI_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
            ...deps.headers,
        },
        body: new URLSearchParams({
          client_id: KIMI_CLIENT_ID,
          device_code: device.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString(),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (signal.aborted) throw new OAuthLoginError("kimi-coding login cancelled");
      throw new OAuthLoginError(`kimi-coding request to ${tokenUrl} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = (JSON.parse(text) as Record<string, unknown>) ?? {};
    } catch {
      // Non-JSON response handled below.
    }

    if (response.ok && typeof json.access_token === "string" && typeof json.refresh_token === "string") {
      const expiresIn = typeof json.expires_in === "number" && Number.isFinite(json.expires_in) ? json.expires_in : 3600;
      const accountId = extractJwtAccountId(json.access_token);
      return {
        type: "oauth",
        access: json.access_token,
        refresh: json.refresh_token,
        expires: now() + expiresIn * 1000,
        ...(accountId !== undefined ? { accountId } : {}),
      };
    }

    const error = json.error;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      const slowInterval = typeof json.interval === "number" && json.interval > 0 ? json.interval * 1000 : intervalMs + 5000;
      intervalMs = Math.max(1000, slowInterval);
      continue;
    }
    if (error === "access_denied") throw new OAuthLoginError("Kimi Code login was denied");
    if (error === "expired_token") throw new OAuthLoginError("Kimi Code device authorization expired. Please restart login.");

    throw new OAuthLoginError(`kimi-coding token exchange failed: ${response.status}`);
  }

  throw new OAuthLoginError("kimi-coding device authorization timed out");
}

/** Refresh a Kimi Code OAuth credential. */
export async function refreshKimi(
  credential: OAuthCredential,
  deps: KimiOAuthDeps = {},
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const base = getKimiBaseUrl(deps.urls?.base);
  const tokenUrl = deps.urls?.tokenUrl ?? `${base}${KIMI_TOKEN_PATH}`;
  const timeout = AbortSignal.timeout(KIMI_REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        ...deps.headers,
      },
      body: new URLSearchParams({
        client_id: KIMI_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: credential.refresh,
      }).toString(),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw new OAuthLoginError("kimi-coding login cancelled");
    throw new OAuthLoginError(`kimi-coding request to ${tokenUrl} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = (JSON.parse(text) as Record<string, unknown>) ?? {};
  } catch {
    // Non-JSON response handled below.
  }

  if (!response.ok) {
    throw new OAuthLoginError(`kimi-coding token refresh failed: ${response.status}`);
  }

  const access = json.access_token;
  if (typeof access !== "string" || access.length === 0) {
    throw new OAuthLoginError("kimi-coding token refresh response missing access token");
  }
  const refresh = typeof json.refresh_token === "string" && json.refresh_token.length > 0 ? json.refresh_token : credential.refresh;
  const expiresIn = typeof json.expires_in === "number" && Number.isFinite(json.expires_in) ? json.expires_in : 3600;
  const accountId = extractJwtAccountId(access) ?? (credential.accountId as string | undefined);

  return {
    ...credential,
    type: "oauth",
    access,
    refresh,
    expires: now() + expiresIn * 1000,
    ...(accountId !== undefined ? { accountId } : {}),
  };
}
