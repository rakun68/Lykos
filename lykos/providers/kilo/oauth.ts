// Kilo Gateway OAuth flow.
//
// Device authorization flow against Kilo's device-auth endpoints.
// Requests a device code, displays the verification URL and user code,
// then polls until the user approves or denies the authorization.

// The provider's OAuth client and endpoints.
export const KILO_DEVICE_AUTH_BASE_URL = "https://api.kilo.ai/api/device-auth";
export const KILO_DEFAULT_POLL_INTERVAL_MS = 5000;
export const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export interface KiloOAuthDeps {
  fetch?: typeof fetch;
  openBrowser?: (url: string) => void;
  now?: () => number;
  deviceAuthBaseUrl?: string;
  pollIntervalMs?: number;
}

export interface KiloOAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
}

export interface KiloLoginCallbacks {
  onAuth?: (info: { url: string; instructions?: string }) => void;
  onDeviceCode?: (info: { userCode: string; verificationUri: string }) => void;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

interface KiloDeviceAuthCodeResponse {
  code?: string;
  verificationUrl?: string;
  expiresIn?: number;
}

interface KiloDeviceAuthPollResponse {
  status?: string;
  token?: string;
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

function redactTokens(text: string): string {
  return text
    .replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[redacted]")
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "[redacted]");
}

export async function loginKilo(
  callbacks: KiloLoginCallbacks,
  deps: KiloOAuthDeps = {},
): Promise<KiloOAuthCredentials> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const baseUrl = deps.deviceAuthBaseUrl ?? KILO_DEVICE_AUTH_BASE_URL;
  const pollIntervalMs = deps.pollIntervalMs ?? KILO_DEFAULT_POLL_INTERVAL_MS;

  if (callbacks.signal?.aborted) {
    throw new Error("OAuth login cancelled");
  }

  callbacks.onProgress?.("Requesting device authorization...");
  let initiateResponse: Response;
  try {
    initiateResponse = await fetchImpl(`${baseUrl}/codes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(callbacks.signal !== undefined ? { signal: callbacks.signal } : {}),
    });
  } catch (err) {
    throw new Error(`Kilo device authorization request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!initiateResponse.ok) {
    if (initiateResponse.status === 429) {
      throw new Error("Too many pending authorization requests. Please try again later.");
    }
    const errText = await initiateResponse.text();
    throw new Error(`Failed to initiate device authorization: ${initiateResponse.status} ${redactTokens(errText.slice(0, 500))}`.trim());
  }

  const initiateData = (await initiateResponse.json()) as KiloDeviceAuthCodeResponse;
  const userCode = initiateData.code;
  const verificationUrl = initiateData.verificationUrl;
  const expiresInSeconds = initiateData.expiresIn;

  if (!userCode || !verificationUrl || typeof expiresInSeconds !== "number" || expiresInSeconds <= 0) {
    throw new Error("Kilo device authorization response missing required fields");
  }

  callbacks.onDeviceCode?.({
    userCode,
    verificationUri: verificationUrl,
  });
  callbacks.onAuth?.({
    url: verificationUrl,
    instructions: `Enter code: ${userCode}`,
  });
  deps.openBrowser?.(verificationUrl);
  callbacks.onProgress?.("Waiting for device authorization...");

  const deadline = now() + expiresInSeconds * 1000;
  while (now() < deadline) {
    if (callbacks.signal?.aborted) {
      throw new Error("OAuth login cancelled");
    }

    let pollResponse: Response;
    try {
      pollResponse = await fetchImpl(`${baseUrl}/codes/${encodeURIComponent(userCode)}`, {
        ...(callbacks.signal !== undefined ? { signal: callbacks.signal } : {}),
      });
    } catch (err) {
      throw new Error(`Kilo device authorization polling failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (pollResponse.status === 202) {
      await abortableSleep(pollIntervalMs, callbacks.signal);
      continue;
    }
    if (pollResponse.status === 403) {
      throw new Error("Authorization was denied");
    }
    if (pollResponse.status === 410) {
      throw new Error("Authorization code expired. Please try again.");
    }
    if (!pollResponse.ok) {
      const errText = await pollResponse.text();
      throw new Error(`Failed to poll device authorization: ${pollResponse.status} ${redactTokens(errText.slice(0, 500))}`.trim());
    }

    const pollData = (await pollResponse.json()) as KiloDeviceAuthPollResponse;
    if (pollData.status === "approved" && pollData.token) {
      return {
        access: pollData.token,
        refresh: "",
        expires: now() + ONE_YEAR_MS,
      };
    }
    if (pollData.status === "denied") {
      throw new Error("Authorization was denied");
    }
    if (pollData.status === "expired") {
      throw new Error("Authorization code expired. Please try again.");
    }

    await abortableSleep(pollIntervalMs, callbacks.signal);
  }

  throw new Error("Authentication timed out. Please try again.");
}
