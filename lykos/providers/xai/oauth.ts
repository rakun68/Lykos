// xAI (Grok/X subscription) login and refresh.
//
// The rule: RFC 8628 device authorization grant.
// Client id: b1a00492-073a-47ea-816f-4c329264a828
// Scopes: openid profile email offline_access grok-cli:access api:access
// Endpoints: device authorization https://auth.x.ai/oauth2/device/code,
//            token endpoint via discovery from https://auth.x.ai/.well-known/openid-configuration,
//            userinfo https://auth.x.ai/oauth2/userinfo
// Refresh with userinfo to update accountId and email.
//
// Credential shape (plan D2): Pi 0.84.3's xai.js stores `type`, `access`, `refresh`, `expires`
// (5-minute skew). The account id comes from `sub` and the email from userinfo.
// Old and new rows resolve through Pi's toAuth ({ apiKey: credential.access }).

import {
  type FetchLike,
  type LoginInteraction,
  type OAuthCredential,
  OAuthLoginError,
  decodeJwtPayload,
  defaultSleep,
} from "../builtin-logins/code-flow.js";

export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
export const XAI_DEFAULT_TOKEN_URL = "https://auth.x.ai/oauth2/token";
export const XAI_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
export const XAI_USERINFO_URL = "https://auth.x.ai/oauth2/userinfo";
export const XAI_EXPIRY_SKEW_MS = 300_000;
export const XAI_DEFAULT_POLL_INTERVAL_SECONDS = 5;
export const XAI_REQUEST_TIMEOUT_MS = 30_000;

export interface XaiOAuthUrls {
  discoveryUrl?: string;
  deviceCodeUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
}

export interface XaiOAuthDeps {
  fetch?: FetchLike;
  openBrowser?: (url: string) => void;
  pollIntervalSeconds?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  urls?: XaiOAuthUrls;
}

interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

/**
 * Validate an xAI endpoint against scheme and hostname.
 * Allows test hostnames (localhost/127.0.0.1) when discoveryUrl is overridden.
 */
function validateXaiEndpoint(url: string, field: string, allowLocal: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OAuthLoginError(`Invalid xAI ${field}: ${url}`);
  }
  if (parsed.protocol !== "https:" && !(allowLocal && parsed.protocol === "http:")) {
    throw new OAuthLoginError(`Invalid xAI ${field}: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  const isXaiHost = host === "x.ai" || host.endsWith(".x.ai");
  const isLocalHost = allowLocal && (host === "localhost" || host === "127.0.0.1");
  if (!isXaiHost && !isLocalHost) {
    throw new OAuthLoginError(`Invalid xAI ${field}: ${url}`);
  }
  return url;
}

/** Discover and pin the xAI token endpoint. */
export async function getXaiTokenEndpoint(deps: XaiOAuthDeps, signal?: AbortSignal): Promise<string> {
  if (deps.urls?.tokenUrl) return deps.urls.tokenUrl;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const discoveryUrl = deps.urls?.discoveryUrl ?? XAI_DISCOVERY_URL;
  const timeout = AbortSignal.timeout(XAI_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(discoveryUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw new OAuthLoginError("xai login cancelled");
    if (!deps.urls?.discoveryUrl) return XAI_DEFAULT_TOKEN_URL;
    throw new OAuthLoginError(`xai discovery request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) {
    if (!deps.urls?.discoveryUrl) return XAI_DEFAULT_TOKEN_URL;
    throw new OAuthLoginError(`xai discovery failed: ${response.status}`);
  }
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = (JSON.parse(text) as Record<string, unknown>) ?? {};
  } catch {
    if (!deps.urls?.discoveryUrl) return XAI_DEFAULT_TOKEN_URL;
    throw new OAuthLoginError("xai discovery returned invalid JSON");
  }
  const tokenEndpoint = json.token_endpoint;
  if (typeof tokenEndpoint !== "string" || !tokenEndpoint.trim()) {
    if (!deps.urls?.discoveryUrl) return XAI_DEFAULT_TOKEN_URL;
    throw new OAuthLoginError("xai discovery missing token_endpoint");
  }
  return validateXaiEndpoint(tokenEndpoint.trim(), "token_endpoint", deps.urls?.discoveryUrl !== undefined);
}

/** Fetch optional OIDC userinfo for an xAI access token. */
export async function fetchXaiUserinfo(
  accessToken: string,
  deps: XaiOAuthDeps,
  signal?: AbortSignal,
): Promise<{ accountId?: string; email?: string } | null> {
  const token = accessToken.trim();
  if (!token) return null;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const userinfoUrl = deps.urls?.userinfoUrl ?? XAI_USERINFO_URL;
  const timeout = AbortSignal.timeout(XAI_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(userinfoUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) return null;
    const json = (await response.json()) as Record<string, unknown>;
    const sub = typeof json.sub === "string" && json.sub.trim() ? json.sub.trim() : undefined;
    const email = typeof json.email === "string" && json.email.trim() ? json.email.trim().toLowerCase() : undefined;
    if (!sub && !email) return null;
    return {
      ...(sub !== undefined ? { accountId: sub } : {}),
      ...(email !== undefined ? { email } : {}),
    };
  } catch {
    return null;
  }
}

async function requestDeviceAuthorization(
  deviceCodeUrl: string,
  deps: XaiOAuthDeps,
  signal?: AbortSignal,
): Promise<DeviceCodeResponse> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const timeout = AbortSignal.timeout(XAI_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(deviceCodeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: XAI_CLIENT_ID,
        scope: XAI_SCOPE,
      }).toString(),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw new OAuthLoginError("xai login cancelled");
    throw new OAuthLoginError(`xai request to ${deviceCodeUrl} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await response.text();
  if (!response.ok) throw new OAuthLoginError(`xai device authorization failed: ${response.status}`);
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new OAuthLoginError("xai device authorization returned invalid JSON");
  }

  const deviceCode = json.device_code;
  const userCode = json.user_code;
  const verificationUri = json.verification_uri;
  const verificationUriComplete = json.verification_uri_complete;
  if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string") {
    throw new OAuthLoginError("xai device authorization response missing required fields");
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
      (typeof interval === "number" && Number.isFinite(interval) && interval > 0 ? interval : XAI_DEFAULT_POLL_INTERVAL_SECONDS),
    expiresInSeconds:
      typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 1800,
  };
}

/** Run xAI's device-code login flow. */
export async function loginXai(
  interaction: LoginInteraction,
  deps: XaiOAuthDeps = {},
): Promise<OAuthCredential> {
  const signal = interaction.signal;
  if (signal.aborted) throw new OAuthLoginError("xai login cancelled");
  const sleepImpl = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;

  const deviceCodeUrl = deps.urls?.deviceCodeUrl ?? XAI_DEVICE_CODE_URL;
  const tokenUrl = await getXaiTokenEndpoint(deps, signal);

  const device = await requestDeviceAuthorization(deviceCodeUrl, deps, signal);
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
    if (signal.aborted) throw new OAuthLoginError("xai login cancelled");
    await sleepImpl(intervalMs, signal);
    if (signal.aborted) throw new OAuthLoginError("xai login cancelled");

    const timeout = AbortSignal.timeout(XAI_REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: XAI_CLIENT_ID,
          device_code: device.deviceCode,
        }).toString(),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (signal.aborted) throw new OAuthLoginError("xai login cancelled");
      throw new OAuthLoginError(`xai request to ${tokenUrl} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const text = await response.text();
    let json: Record<string, unknown> = {};
    try {
      json = (JSON.parse(text) as Record<string, unknown>) ?? {};
    } catch {
      // Non-JSON response handled below.
    }

    if (response.ok && typeof json.access_token === "string") {
      const access = json.access_token;
      const refresh = typeof json.refresh_token === "string" ? json.refresh_token : "";
      const expiresIn = typeof json.expires_in === "number" && Number.isFinite(json.expires_in) ? json.expires_in : 3600;
      const expires = now() + expiresIn * 1000 - XAI_EXPIRY_SKEW_MS;

      const identity = await fetchXaiUserinfo(access, deps, signal);
      const jwtSub = decodeJwtPayload(access)?.sub;
      const accountId = identity?.accountId ?? (typeof jwtSub === "string" ? jwtSub : undefined);
      const email = identity?.email;

      return {
        type: "oauth",
        access,
        refresh,
        expires,
        ...(accountId !== undefined ? { accountId } : {}),
        ...(email !== undefined ? { email } : {}),
      };
    }

    const error = json.error;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      const slowInterval = typeof json.interval === "number" && json.interval > 0 ? json.interval * 1000 : intervalMs + 5000;
      intervalMs = Math.max(1000, slowInterval);
      continue;
    }
    if (error === "access_denied" || error === "authorization_denied") {
      throw new OAuthLoginError("xAI device authorization was denied");
    }
    if (error === "expired_token") {
      throw new OAuthLoginError("xAI device code expired");
    }

    throw new OAuthLoginError(`xai device token polling failed: ${response.status}`);
  }

  throw new OAuthLoginError("xai device authorization timed out");
}

/** Refresh an xAI OAuth credential. */
export async function refreshXai(
  credential: OAuthCredential,
  deps: XaiOAuthDeps = {},
  signal?: AbortSignal,
): Promise<OAuthCredential> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const tokenUrl = await getXaiTokenEndpoint(deps, signal);
  const timeout = AbortSignal.timeout(XAI_REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: XAI_CLIENT_ID,
        refresh_token: credential.refresh,
      }).toString(),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    if (signal?.aborted) throw new OAuthLoginError("xai login cancelled");
    throw new OAuthLoginError(`xai request to ${tokenUrl} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = (JSON.parse(text) as Record<string, unknown>) ?? {};
  } catch {
    // Non-JSON response handled below.
  }

  if (!response.ok) {
    throw new OAuthLoginError(`xai token refresh failed: ${response.status}`);
  }

  const access = json.access_token;
  if (typeof access !== "string" || access.length === 0) {
    throw new OAuthLoginError("xai token refresh response missing access token");
  }
  const refresh = typeof json.refresh_token === "string" && json.refresh_token.length > 0 ? json.refresh_token : credential.refresh;
  const expiresIn = typeof json.expires_in === "number" && Number.isFinite(json.expires_in) ? json.expires_in : 3600;
  const expires = now() + expiresIn * 1000 - XAI_EXPIRY_SKEW_MS;

  const identity = await fetchXaiUserinfo(access, deps, signal);
  const jwtSub = decodeJwtPayload(access)?.sub;
  const accountId = identity?.accountId ?? (typeof jwtSub === "string" ? jwtSub : undefined) ?? (credential.accountId as string | undefined);
  const email = identity?.email ?? (credential.email as string | undefined);

  return {
    ...credential,
    type: "oauth",
    access,
    refresh,
    expires,
    ...(accountId !== undefined ? { accountId } : {}),
    ...(email !== undefined ? { email } : {}),
  };
}
