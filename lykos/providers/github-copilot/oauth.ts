// GitHub Copilot login and refresh.
//
// Every wire value (client id, device-flow headers, URLs, the
// `copilot_internal/v2/token` exchange, `availableModelIds`) is Pi 0.84.3's
// (`pi-ai/dist/auth/oauth/github-copilot.js`), the flow that produced every
// Copilot row stored today. Pi's `toAuth` stays in charge and reads the Copilot
// token's `proxy-ep` for the base URL (plans D1 and D2). The enterprise-domain
// prompt comes first, then the domain-dependent device flow and polling.
//
// Credential shape (plan D2), Pi 0.84.3's: `type`, `refresh` (the GitHub OAuth token),
// `access` (the Copilot token), `expires` (`expires_at` less 5 minutes), `enterpriseUrl`
// (the enterprise domain, absent for github.com), `availableModelIds`.

import { type FetchLike, type LoginInteraction, type OAuthCredential, OAuthLoginError } from "../builtin-logins/code-flow.js";

// Pi 0.84.3 github-copilot.js: `CLIENT_ID = decode("SXYxLmI1MDdhMDhjODdlY2ZlOTg=")`, stored base64 as there.
export const COPILOT_CLIENT_ID = Buffer.from("SXYxLmI1MDdhMDhjODdlY2ZlOTg=", "base64").toString("utf8");
/** Pi 0.84.3 github-copilot.js `COPILOT_HEADERS`. */
export const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
} as const;
/** Pi 0.84.3 github-copilot.js `COPILOT_API_VERSION`. */
export const COPILOT_API_VERSION = "2026-06-01";
/** Pi 0.84.3 github-copilot.js device-flow `scope`. */
export const COPILOT_OAUTH_SCOPE = "read:user";
/** Pi's `getGitHubCopilotBaseUrl` fallback for github.com. */
export const COPILOT_INDIVIDUAL_BASE_URL = "https://api.individual.githubcopilot.com";
/** Pi 0.84.3: `expires: expiresAt * 1000 - 5 * 60 * 1000`. */
export const COPILOT_EXPIRY_SKEW_MS = 5 * 60 * 1000;
/** The prompt, as Pi asks it. */
export const COPILOT_DOMAIN_PROMPT = "GitHub Enterprise URL/domain (blank for github.com)";

export interface CopilotOAuthUrls {
  /** Override the device-code URL (default `https://{domain}/login/device/code`). */
  deviceCodeUrl?: string;
  /** Override the access-token URL (default `https://{domain}/login/oauth/access_token`). */
  accessTokenUrl?: string;
  /** Override the Copilot token URL (default `https://api.{domain}/copilot_internal/v2/token`). */
  copilotTokenUrl?: string;
  /** Override the Copilot API base for the model list and model-policy calls. */
  apiBaseUrl?: string;
}

export interface CopilotOAuthDeps {
  fetch?: FetchLike;
  /** Opens the verification URI. The interaction's `device_code` event is always sent too. */
  openBrowser?: (url: string) => void;
  /** Poll sleep; tests pass one that resolves at once. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  urls?: CopilotOAuthUrls;
  /** The ids Pi's catalog knows for github-copilot (Pi's `GITHUB_COPILOT_MODELS` keys). */
  knownModelIds?: () => readonly string[];
}

/** The hostname of a URL or bare domain, or null. */
export function normalizeDomain(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname;
  } catch {
    return null;
  }
}

function urlsFor(domain: string, urls: CopilotOAuthUrls | undefined): Required<Omit<CopilotOAuthUrls, "apiBaseUrl">> {
  return {
    deviceCodeUrl: urls?.deviceCodeUrl ?? `https://${domain}/login/device/code`,
    accessTokenUrl: urls?.accessTokenUrl ?? `https://${domain}/login/oauth/access_token`,
    copilotTokenUrl: urls?.copilotTokenUrl ?? `https://api.${domain}/copilot_internal/v2/token`,
  };
}

/** Pi's `getGitHubCopilotBaseUrl`: the token's `proxy-ep` with `proxy.` made `api.`, else the enterprise or individual base. */
export function copilotBaseUrl(token: string | undefined, enterpriseDomain: string | undefined): string {
  const match = token?.match(/proxy-ep=([^;]+)/);
  if (match) return `https://${match[1]!.replace(/^proxy\./, "api.")}`;
  if (enterpriseDomain) return `https://copilot-api.${enterpriseDomain}`;
  return COPILOT_INDIVIDUAL_BASE_URL;
}

class HttpError extends OAuthLoginError {
  constructor(
    readonly status: number,
    what: string,
  ) {
    super(`${what} failed: ${status}`);
  }
}

async function fetchJson(fetchImpl: FetchLike, url: string, init: RequestInit, what: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (err) {
    if (init.signal?.aborted) throw new OAuthLoginError("Login cancelled");
    throw new OAuthLoginError(`github-copilot request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(response.status, what);
  }
  return response.json() as Promise<unknown>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new OAuthLoginError("Login cancelled"));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new OAuthLoginError("Login cancelled"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number | undefined;
  expires_in: number;
}

/** Pi's `startDeviceFlow` (with Pi's URI scheme check). */
async function startDeviceFlow(domain: string, deps: CopilotOAuthDeps, signal: AbortSignal): Promise<DeviceCode> {
  const data = await fetchJson(
    deps.fetch ?? globalThis.fetch,
    urlsFor(domain, deps.urls).deviceCodeUrl,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": COPILOT_HEADERS["User-Agent"],
      },
      body: new URLSearchParams({ client_id: COPILOT_CLIENT_ID, scope: COPILOT_OAUTH_SCOPE }),
      signal,
    },
    "GitHub device code request",
  );
  const d = (data ?? {}) as Record<string, unknown>;
  if (
    typeof d.device_code !== "string" ||
    typeof d.user_code !== "string" ||
    typeof d.verification_uri !== "string" ||
    (d.interval !== undefined && typeof d.interval !== "number") ||
    typeof d.expires_in !== "number"
  ) {
    throw new OAuthLoginError("Invalid device code response fields");
  }
  let uri: URL;
  try {
    uri = new URL(d.verification_uri);
  } catch {
    throw new OAuthLoginError("Untrusted verification_uri in device code response");
  }
  if (uri.protocol !== "https:" && uri.protocol !== "http:") {
    throw new OAuthLoginError("Untrusted verification_uri in device code response");
  }
  return {
    device_code: d.device_code,
    user_code: d.user_code,
    verification_uri: uri.href,
    interval: d.interval as number | undefined,
    expires_in: d.expires_in,
  };
}

/**
 * Pi's `pollForGitHubAccessToken` over `pollOAuthDeviceCodeFlow` (device-code.js): wait one
 * interval first, `authorization_pending` keeps polling, `slow_down` takes GitHub's interval
 * (or adds 5 s), any other error fails. The 1-second floor is Pi's `MINIMUM_INTERVAL_MS`.
 */
async function pollForGitHubToken(domain: string, device: DeviceCode, deps: CopilotOAuthDeps, signal: AbortSignal): Promise<string> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const deadline = now() + device.expires_in * 1000;
  let intervalMs = Math.max(1000, Math.floor((device.interval ?? 5) * 1000));
  let slowDowns = 0;
  await sleep(Math.min(intervalMs, Math.max(0, deadline - now())), signal);
  while (now() < deadline) {
    if (signal.aborted) throw new OAuthLoginError("Login cancelled");
    const raw = (await fetchJson(
      deps.fetch ?? globalThis.fetch,
      urlsFor(domain, deps.urls).accessTokenUrl,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": COPILOT_HEADERS["User-Agent"],
        },
        body: new URLSearchParams({
          client_id: COPILOT_CLIENT_ID,
          device_code: device.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
        signal,
      },
      "GitHub device token poll",
    )) as Record<string, unknown> | null;
    if (raw && typeof raw.access_token === "string") return raw.access_token;
    if (raw && typeof raw.error === "string") {
      if (raw.error === "authorization_pending") {
        // Keep polling.
      } else if (raw.error === "slow_down") {
        slowDowns += 1;
        intervalMs =
          typeof raw.interval === "number" && Number.isFinite(raw.interval) && raw.interval > 0
            ? Math.max(1000, Math.floor(raw.interval * 1000))
            : Math.max(1000, intervalMs + 5000);
      } else {
        const description = typeof raw.error_description === "string" ? `: ${raw.error_description}` : "";
        throw new OAuthLoginError(`Device flow failed: ${raw.error}${description}`);
      }
    } else {
      throw new OAuthLoginError("Invalid device token response");
    }
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(intervalMs, remaining), signal);
  }
  throw new OAuthLoginError(
    slowDowns > 0
      ? "Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again."
      : "Device flow timed out",
  );
}

/** Pi's `refreshGitHubCopilotAccessToken`: exchange the GitHub token for a Copilot token. */
async function exchangeForCopilotToken(
  githubToken: string,
  enterpriseDomain: string | undefined,
  deps: CopilotOAuthDeps,
  signal: AbortSignal | undefined,
): Promise<OAuthCredential> {
  const raw = (await fetchJson(
    deps.fetch ?? globalThis.fetch,
    urlsFor(enterpriseDomain || "github.com", deps.urls).copilotTokenUrl,
    {
      headers: { Accept: "application/json", Authorization: `Bearer ${githubToken}`, ...COPILOT_HEADERS },
      ...(signal !== undefined ? { signal } : {}),
    },
    "Copilot token exchange",
  )) as Record<string, unknown> | null;
  const token = raw?.token;
  const expiresAt = raw?.expires_at;
  if (typeof token !== "string" || typeof expiresAt !== "number") {
    throw new OAuthLoginError("Invalid Copilot token response fields");
  }
  const credential: OAuthCredential = {
    type: "oauth",
    refresh: githubToken,
    access: token,
    expires: expiresAt * 1000 - COPILOT_EXPIRY_SKEW_MS,
  };
  if (enterpriseDomain) credential.enterpriseUrl = enterpriseDomain;
  return credential;
}

/** Pi's `fetchWithRateLimitRetry`: retry 429 per `retry-after` within a budget. */
async function fetchWithRateLimitRetry(
  url: string,
  init: RequestInit,
  deps: CopilotOAuthDeps,
  signal: AbortSignal | undefined,
  policy: { maxRetries: number; maxElapsedMs: number },
): Promise<Response> {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const deadline = policy.maxRetries > 0 && policy.maxElapsedMs > 0 ? now() + policy.maxElapsedMs : undefined;
  const base = signal ?? new AbortController().signal;
  for (let retry = 0; ; retry++) {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, signal: AbortSignal.any([base, AbortSignal.timeout(5000)]) });
    } catch (err) {
      if (base.aborted) throw new OAuthLoginError("Login cancelled");
      throw new OAuthLoginError(`github-copilot request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (response.status !== 429 || retry === policy.maxRetries) return response;
    const retryAfter = response.headers.get("retry-after");
    let delayMs = 500 * 2 ** retry;
    if (retryAfter) {
      const seconds = Number.parseFloat(retryAfter);
      delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - now() : seconds * 1000;
      if (!Number.isFinite(delayMs)) return response;
    }
    delayMs = Math.max(0, delayMs);
    if (deadline !== undefined && delayMs >= deadline - now()) return response;
    await response.body?.cancel();
    await sleep(delayMs, base);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** Pi's `fetchGitHubCopilotModels` with `parseGitHubCopilotModelCatalog`. */
async function fetchCopilotModels(
  copilotToken: string,
  enterpriseDomain: string | undefined,
  deps: CopilotOAuthDeps,
  signal: AbortSignal | undefined,
  policy: { maxRetries: number; maxElapsedMs: number },
): Promise<{ availableModelIds: string[]; policyModelIds: string[] }> {
  const baseUrl = deps.urls?.apiBaseUrl ?? copilotBaseUrl(copilotToken, enterpriseDomain);
  // Pi limits the policy fallback to the individual endpoint (github-copilot.js).
  const allowPolicyFallback = copilotBaseUrl(copilotToken, enterpriseDomain) === COPILOT_INDIVIDUAL_BASE_URL;
  const response = await fetchWithRateLimitRetry(
    `${baseUrl}/models`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${copilotToken}`,
        ...COPILOT_HEADERS,
        "X-GitHub-Api-Version": COPILOT_API_VERSION,
      },
    },
    deps,
    signal,
    policy,
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new OAuthLoginError(`Copilot model list failed: ${response.status}`);
  }
  const data = asRecord(await response.json())?.data;
  if (!Array.isArray(data)) throw new OAuthLoginError("Invalid Copilot models response");
  const known = new Set(deps.knownModelIds?.() ?? []);
  const accountModels = data.flatMap((rawItem) => {
    const item = asRecord(rawItem);
    const id = item?.id;
    if (!item || typeof id !== "string") return [];
    const supports = asRecord(asRecord(item.capabilities)?.supports);
    if (supports?.tool_calls === false) return [];
    return [{ id, pickerEnabled: item.model_picker_enabled === true, policyState: asRecord(item.policy)?.state }];
  });
  const pickerModelIds = accountModels.filter((m) => m.pickerEnabled && m.policyState !== "disabled").map((m) => m.id);
  const usePolicyFallback = allowPolicyFallback && pickerModelIds.length === 0;
  const availableModelIds =
    pickerModelIds.length > 0 || !allowPolicyFallback
      ? pickerModelIds
      : accountModels.filter((m) => m.policyState === "enabled").map((m) => m.id);
  const policyModelIds = accountModels
    .filter((m) => m.policyState === "unconfigured" && known.has(m.id) && (m.pickerEnabled || usePolicyFallback))
    .map((m) => m.id);
  return { availableModelIds, policyModelIds };
}

/** Pi's `enableGitHubCopilotModels`: best effort, one POST per model; an exhausted 429 stops the batch. */
async function enableCopilotModels(
  copilotToken: string,
  modelIds: readonly string[],
  enterpriseDomain: string | undefined,
  deps: CopilotOAuthDeps,
  signal: AbortSignal,
): Promise<string[]> {
  const baseUrl = deps.urls?.apiBaseUrl ?? copilotBaseUrl(copilotToken, enterpriseDomain);
  const enabled: string[] = [];
  for (const modelId of modelIds) {
    let response: Response;
    try {
      response = await fetchWithRateLimitRetry(
        `${baseUrl}/models/${modelId}/policy`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${copilotToken}`,
            ...COPILOT_HEADERS,
            "openai-intent": "chat-policy",
            "x-interaction-type": "chat-policy",
          },
          body: JSON.stringify({ state: "enabled" }),
        },
        deps,
        signal,
        { maxRetries: 2, maxElapsedMs: 5000 },
      );
    } catch (err) {
      if (signal.aborted) throw err;
      continue;
    }
    await response.body?.cancel();
    if (response.status === 429) break;
    if (response.ok) enabled.push(modelId);
  }
  return enabled;
}

/** The enterprise domain a stored credential names (Pi's `copilotEnterpriseDomain`). */
function storedEnterpriseDomain(credential: OAuthCredential): string | undefined {
  const value = credential.enterpriseUrl;
  if (typeof value !== "string" || !value) return undefined;
  return normalizeDomain(value) ?? undefined;
}

/** `lykos login github-copilot`: enterprise domain first, then the device flow, then the Copilot token. */
export async function loginCopilot(interaction: LoginInteraction, deps: CopilotOAuthDeps = {}): Promise<OAuthCredential> {
  const signal = interaction.signal;
  const input = await interaction.prompt({ type: "text", message: COPILOT_DOMAIN_PROMPT, placeholder: "company.ghe.com" });
  if (signal.aborted) throw new OAuthLoginError("Login cancelled");
  const trimmed = input.trim();
  const enterpriseDomain = normalizeDomain(input) ?? undefined;
  if (trimmed && !enterpriseDomain) throw new OAuthLoginError("Invalid GitHub Enterprise URL/domain");
  const domain = enterpriseDomain || "github.com";

  const device = await startDeviceFlow(domain, deps, signal);
  interaction.notify({
    type: "device_code",
    userCode: device.user_code,
    verificationUri: device.verification_uri,
    ...(device.interval !== undefined ? { intervalSeconds: device.interval } : {}),
    expiresInSeconds: device.expires_in,
  });
  deps.openBrowser?.(device.verification_uri);

  const githubToken = await pollForGitHubToken(domain, device, deps, signal);
  const credential = await exchangeForCopilotToken(githubToken, enterpriseDomain, deps, signal);
  const models = await fetchCopilotModels(credential.access, enterpriseDomain, deps, signal, { maxRetries: 2, maxElapsedMs: 5000 });
  let enabled: string[] = [];
  if (models.policyModelIds.length > 0) {
    interaction.notify({ type: "progress", message: "Enabling models..." });
    enabled = await enableCopilotModels(credential.access, models.policyModelIds, enterpriseDomain, deps, signal);
  }
  return { ...credential, availableModelIds: [...new Set([...models.availableModelIds, ...enabled])] };
}

/**
 * Refresh: re-exchange the stored GitHub token for a fresh Copilot token and re-read the
 * account's model list, as Pi's `refreshGitHubCopilotToken` does. Every stored field is kept.
 */
export async function refreshCopilot(credential: OAuthCredential, deps: CopilotOAuthDeps = {}, signal?: AbortSignal): Promise<OAuthCredential> {
  const enterpriseDomain = storedEnterpriseDomain(credential);
  const fresh = await exchangeForCopilotToken(credential.refresh, enterpriseDomain, deps, signal);
  const { availableModelIds } = await fetchCopilotModels(fresh.access, enterpriseDomain, deps, signal, { maxRetries: 0, maxElapsedMs: 0 });
  return { ...credential, ...fresh, availableModelIds, type: "oauth" };
}
