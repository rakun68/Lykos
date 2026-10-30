// Muse Code (Subscription) OAuth flow.
//
// Device-code flow against Meta's auth.meta.com endpoints, followed by the
// muse-code-key hook that mints a Model API key authorized by the subscription.
// Both the Meta account token and minted API key are stored in `access` as JSON;
// `getApiKey` extracts the minted API key.

// The provider's OAuth client and endpoints.
export const MUSE_CLIENT_ID = "1031625952748946";
export const MUSE_DEVICE_AUTH_URL = "https://auth.meta.com/oidc/device/authorization/";
export const MUSE_DEVICE_TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
export const MUSE_KEY_URL = "https://api.meta.ai/muse-code/key";
export const MUSE_API_VERSION = "1.0.0";
export const NEVER_EXPIRES = 8.64e15;
export const MUSE_DEFAULT_POLL_INTERVAL_MS = 5000;

export interface MuseOAuthUrls {
  deviceAuthUrl?: string;
  tokenUrl?: string;
  keyUrl?: string;
  clientId?: string;
}

export interface MuseOAuthDeps {
  fetch?: typeof fetch;
  openBrowser?: (url: string) => void;
  now?: () => number;
  urls?: MuseOAuthUrls;
  pollIntervalMs?: number;
}

export interface MuseOAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  accountId?: string;
  [key: string]: unknown;
}

export interface MuseParsedCredential {
  oauthAccessToken: string;
  apiKey: string;
}

export interface MuseLoginCallbacks {
  onAuth?: (info: { url: string; instructions?: string }) => void;
  onDeviceCode?: (info: { userCode: string; verificationUri: string }) => void;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

function redactTokens(text: string): string {
  return text
    .replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[redacted]")
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "[redacted]");
}

/** Parses the stored JSON credential containing oauthAccessToken and apiKey. */
export function parseMuseCodeCredential(value: string): MuseParsedCredential {
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch (cause) {
    throw new Error(`Muse Code credential is invalid; sign in again: ${String(cause)}`);
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Muse Code credential is invalid; sign in again");
  }
  const rec = payload as Record<string, unknown>;
  const oauthAccessToken = typeof rec.oauthAccessToken === "string" ? rec.oauthAccessToken.trim() : "";
  const apiKey = typeof rec.apiKey === "string" ? rec.apiKey.trim() : "";
  if (!oauthAccessToken || !apiKey) {
    throw new Error("Muse Code credential is invalid; sign in again");
  }
  return { oauthAccessToken, apiKey };
}

export function encodeMuseCodeCredential(oauthAccessToken: string, apiKey: string): string {
  return JSON.stringify({ oauthAccessToken, apiKey });
}

async function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((r) => setTimeout(r, ms));
    return;
  }
  if (signal.aborted) {
    throw new Error("OAuth login cancelled");
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("OAuth login cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function loginMuse(
  callbacks: MuseLoginCallbacks,
  deps: MuseOAuthDeps = {},
): Promise<MuseOAuthCredentials> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const clientId = deps.urls?.clientId ?? MUSE_CLIENT_ID;
  const deviceAuthUrl = deps.urls?.deviceAuthUrl ?? MUSE_DEVICE_AUTH_URL;
  const tokenUrl = deps.urls?.tokenUrl ?? MUSE_DEVICE_TOKEN_URL;
  const keyUrl = deps.urls?.keyUrl ?? MUSE_KEY_URL;
  let intervalMs = deps.pollIntervalMs ?? MUSE_DEFAULT_POLL_INTERVAL_MS;

  if (callbacks.signal?.aborted) {
    throw new Error("OAuth login cancelled");
  }

  callbacks.onProgress?.("Requesting device authorization...");
  let deviceRes: Response;
  try {
    deviceRes = await fetchImpl(deviceAuthUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "x-api-version": MUSE_API_VERSION,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ client_id: clientId }).toString(),
      ...(callbacks.signal !== undefined ? { signal: callbacks.signal } : {}),
    });
  } catch (err) {
    throw new Error(`Muse device authorization request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const deviceText = await deviceRes.text();
  let deviceJson: any;
  try {
    deviceJson = deviceText.length > 0 ? JSON.parse(deviceText) : undefined;
  } catch {
    deviceJson = undefined;
  }

  if (!deviceRes.ok) {
    throw new Error(`Muse device authorization failed: ${deviceRes.status} ${redactTokens(deviceText.slice(0, 500))}`);
  }

  const userCode = typeof deviceJson?.user_code === "string" ? deviceJson.user_code : undefined;
  const deviceCode = typeof deviceJson?.device_code === "string" ? deviceJson.device_code : undefined;
  const verificationUri =
    typeof deviceJson?.verification_uri_complete === "string"
      ? deviceJson.verification_uri_complete
      : typeof deviceJson?.verification_uri === "string"
        ? deviceJson.verification_uri
        : undefined;
  const expiresInSeconds = typeof deviceJson?.expires_in === "number" ? deviceJson.expires_in : 300;
  if (typeof deviceJson?.interval === "number" && deps.pollIntervalMs === undefined) {
    intervalMs = Math.max(1000, deviceJson.interval * 1000);
  }

  if (!userCode || !deviceCode || !verificationUri) {
    throw new Error("Muse device authorization response missing required fields");
  }

  callbacks.onDeviceCode?.({
    userCode,
    verificationUri,
  });
  callbacks.onAuth?.({
    url: verificationUri,
    instructions: `Enter code: ${userCode}`,
  });
  deps.openBrowser?.(verificationUri);
  callbacks.onProgress?.("Waiting for device authorization...");

  const deadline = now() + expiresInSeconds * 1000;
  let metaAccessToken = "";

  while (now() < deadline) {
    if (callbacks.signal?.aborted) {
      throw new Error("OAuth login cancelled");
    }

    let tokenRes: Response;
    try {
      tokenRes = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "x-api-version": MUSE_API_VERSION,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: clientId,
          device_code: deviceCode,
        }).toString(),
        ...(callbacks.signal !== undefined ? { signal: callbacks.signal } : {}),
      });
    } catch (err) {
      throw new Error(`Muse device token request failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const tokenText = await tokenRes.text();
    let tokenJson: any;
    try {
      tokenJson = tokenText.length > 0 ? JSON.parse(tokenText) : undefined;
    } catch {
      tokenJson = undefined;
    }

    if (tokenRes.ok && tokenJson?.access_token) {
      metaAccessToken = tokenJson.access_token;
      break;
    }

    const error = tokenJson?.error;
    if (error === "authorization_pending") {
      await abortableSleep(intervalMs, callbacks.signal);
      continue;
    }
    if (error === "slow_down") {
      intervalMs += 5000;
      await abortableSleep(intervalMs, callbacks.signal);
      continue;
    }
    if (error === "access_denied") {
      throw new Error("Muse device authorization was denied");
    }
    if (error === "expired_token") {
      throw new Error("Muse device code expired; restart the login");
    }

    const desc = tokenJson?.error_description || error || tokenText.slice(0, 500);
    throw new Error(`Muse device token request failed: ${tokenRes.status} ${redactTokens(String(desc))}`.trim());
  }

  if (!metaAccessToken) {
    throw new Error("Authentication timed out. Please try again.");
  }

  callbacks.onProgress?.("Minting Muse Model API key...");
  let keyRes: Response;
  try {
    keyRes = await fetchImpl(keyUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${metaAccessToken}`,
        "Content-Type": "application/json",
        "x-api-version": MUSE_API_VERSION,
      },
      body: JSON.stringify({ onboard: true }),
      ...(callbacks.signal !== undefined ? { signal: callbacks.signal } : {}),
    });
  } catch (err) {
    throw new Error(`Muse key exchange failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const keyText = await keyRes.text();
  let keyJson: any;
  try {
    keyJson = keyText.length > 0 ? JSON.parse(keyText) : undefined;
  } catch {
    keyJson = undefined;
  }

  if (!keyRes.ok) {
    throw new Error(`Muse Code key exchange failed: ${keyRes.status} ${redactTokens(keyText.slice(0, 500))}`.trim());
  }

  if (keyJson?.is_subs_active === false) {
    throw new Error("invalid_grant: Muse Code subscription is inactive");
  }

  const apiKey = typeof keyJson?.api_key === "string" ? keyJson.api_key.trim() : "";
  if (!apiKey) {
    const actionUrl = keyJson?.action_url || keyJson?.require_payment_action_url;
    if (keyJson?.require_payment === true || actionUrl) {
      throw new Error(actionUrl ? `Muse Code subscription is required: ${actionUrl}` : "Muse Code subscription is required");
    }
    throw new Error("Muse Code key response is missing api_key");
  }

  const userEmail = typeof keyJson?.user_email === "string" ? keyJson.user_email.trim().toLowerCase() : undefined;
  const userId = typeof keyJson?.user_id === "string" ? keyJson.user_id.trim() : userEmail;

  return {
    access: encodeMuseCodeCredential(metaAccessToken, apiKey),
    refresh: "",
    expires: NEVER_EXPIRES,
    ...(userEmail ? { email: userEmail } : {}),
    ...(userId ? { accountId: userId } : {}),
  };
}
