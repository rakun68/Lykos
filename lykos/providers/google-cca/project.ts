// Cloud Code Assist project discovery: the after-exchange / after-refresh hooks
// of the two Google login rules.
//
// Not ported: the Antigravity version discovery against the update manifest
// (a network call at startup). The pinned fallback version is used instead.

import type { FetchLike, GoogleCcaProviderId, OAuthCredentials } from "./types.js";

/** Control-plane hosts. */
export const ANTIGRAVITY_CONTROL_PLANE = "https://daily-cloudcode-pa.googleapis.com";
export const GEMINI_CLI_CONTROL_PLANE = "https://cloudcode-pa.googleapis.com";

export const OAUTH_REQUEST_TIMEOUT_MS = 30_000;

export const ANTIGRAVITY_VERSION = "2.8.0";
const ANTIGRAVITY_CL = "963137146";
const GEMINI_CLI_VERSION = "0.46.0";

/** `antigravity/hub/<version> (aidev_client; os_type=darwin; arch=arm64; cl=…)`, pinned. */
export function antigravityUserAgent(): string {
  return `antigravity/hub/${ANTIGRAVITY_VERSION} (aidev_client; os_type=darwin; arch=arm64; cl=${ANTIGRAVITY_CL})`;
}

/** Gemini CLI's User-Agent and Client-Metadata headers. */
export function geminiCliHeaders(modelId = "gemini-3.1-pro-preview"): Record<string, string> {
  const platform = process.platform;
  const arch = process.arch;
  return {
    "User-Agent": `GeminiCLI/${GEMINI_CLI_VERSION}/${modelId} (${platform}; ${arch}; terminal)`,
    "Client-Metadata": "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
  };
}

export class GoogleOAuthError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GoogleOAuthError";
    this.status = status;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new GoogleOAuthError(`OAuth login cancelled: ${String(signal.reason)}`);
}

/** The caller's signal composed with a per-request timeout. */
export async function timedFetch(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  timeoutMs = OAUTH_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await fetchImpl(url, { ...init, signal: requestSignal });
  } catch (err) {
    throwIfCancelled(signal);
    if (timeout.aborted) throw new GoogleOAuthError(`Timed out after ${timeoutMs}ms waiting for ${url}`);
    throw err;
  }
}

/** The `validation_url` of a `VALIDATION_REQUIRED` error body, if any. */
export function extractGoogleValidationUrl(errorBody: string): string | undefined {
  if (!errorBody.includes("VALIDATION_REQUIRED")) return undefined;
  const start = errorBody.indexOf("{");
  if (start === -1) return undefined;
  try {
    const parsed = JSON.parse(errorBody.slice(start)) as {
      error?: { details?: Array<{ reason?: string; metadata?: { validation_url?: string } }> };
    };
    const detail = parsed.error?.details?.find(
      (d) => d.reason === "VALIDATION_REQUIRED" && typeof d.metadata?.validation_url === "string",
    );
    return detail?.metadata?.validation_url;
  } catch {
    return undefined;
  }
}

export function formatGoogleValidationRequiredMessage(validationUrl: string, nextAction: string, email?: string): string {
  const account = email ? ` for ${email}` : "";
  return `Account verification required${account}. Visit ${validationUrl} to continue, then ${nextAction}.`;
}

export interface ProjectHookContext {
  fetch: FetchLike;
  /** Control-plane base URL. Defaults to the provider's Google host. */
  controlPlaneUrl?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Operation poll interval. Defaults: Antigravity 1 s, Gemini CLI 5 s. */
  pollIntervalMs?: number;
  /** Environment for `GOOGLE_CLOUD_PROJECT` (Gemini CLI). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Antigravity (google-antigravity.ts)
// ---------------------------------------------------------------------------

const FREE_TIER_ID = "free-tier";
const ANTIGRAVITY_ONBOARD_TIMEOUT_MS = 30_000;
const ANTIGRAVITY_POLL_INTERVAL_MS = 1_000;
const ANTIGRAVITY_METADATA = Object.freeze({ ideType: "ANTIGRAVITY" });

interface Tier {
  id?: string;
  isDefault?: boolean;
}

interface LoadCodeAssistResponse {
  currentTier?: Tier | null;
  paidTier?: Tier | null;
  allowedTiers?: Tier[];
  ineligibleTiers?: Array<{ tierId?: string; reasonMessage?: string; validationUrl?: string }>;
  cloudaicompanionProject?: string;
}

interface OnboardOperation {
  name?: string;
  done?: boolean;
  error?: { code?: number; message?: string } | null;
  response?: { cloudaicompanionProject?: unknown } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestJson(
  ctx: ProjectHookContext,
  provider: GoogleCcaProviderId,
  label: string,
  url: string,
  init: RequestInit,
  timeoutMs?: number,
): Promise<unknown> {
  throwIfCancelled(ctx.signal);
  const response = await timedFetch(ctx.fetch, url, init, ctx.signal, timeoutMs);
  if (response.status !== 200) {
    const text = await response.text();
    throw new GoogleOAuthError(`${provider} ${label} failed: ${response.status} ${response.statusText}: ${text}`, response.status);
  }
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new GoogleOAuthError(`${provider} ${label} returned a non-object body`);
  return body;
}

function extractProjectId(payload: LoadCodeAssistResponse): string | undefined {
  const id = payload.cloudaicompanionProject;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function hasField(payload: LoadCodeAssistResponse, field: "currentTier" | "paidTier"): boolean {
  return payload[field] !== undefined && payload[field] !== null;
}

function assertFreeTierEligible(payload: LoadCodeAssistResponse): void {
  if (payload.allowedTiers?.some((t) => t.id === FREE_TIER_ID) === true) return;
  const tier = payload.ineligibleTiers?.find((t) => t.tierId === FREE_TIER_ID);
  if (!tier?.reasonMessage) return;
  const validation = tier.validationUrl ? `\n${tier.validationUrl}` : "";
  throw new GoogleOAuthError(`${tier.reasonMessage}${validation}`);
}

async function antigravityLoad(ctx: ProjectHookContext, base: string, headers: Record<string, string>): Promise<LoadCodeAssistResponse> {
  const post = async (body: Record<string, unknown>): Promise<LoadCodeAssistResponse> =>
    (await requestJson(ctx, "google-antigravity", "loadCodeAssist", `${base}/v1internal:loadCodeAssist`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })) as LoadCodeAssistResponse;
  let payload = await post({ metadata: ANTIGRAVITY_METADATA });
  const projectId = extractProjectId(payload);
  if (!hasField(payload, "paidTier") && projectId) {
    payload = await post({ cloudaicompanionProject: projectId, metadata: ANTIGRAVITY_METADATA });
  }
  return payload;
}

async function antigravityOnboard(ctx: ProjectHookContext, base: string, headers: Record<string, string>): Promise<void> {
  const now = ctx.now ?? Date.now;
  const deadline = now() + ANTIGRAVITY_ONBOARD_TIMEOUT_MS;
  const remaining = (): number => {
    const left = deadline - now();
    if (left > 0) return left;
    throw new GoogleOAuthError(`onboardUser timed out after ${ANTIGRAVITY_ONBOARD_TIMEOUT_MS}ms`);
  };
  let operation = (await requestJson(
    ctx,
    "google-antigravity",
    "onboardUser",
    `${base}/v1internal:onboardUser`,
    { method: "POST", headers, body: JSON.stringify({ tierId: FREE_TIER_ID, metadata: ANTIGRAVITY_METADATA }) },
    remaining(),
  )) as OnboardOperation;

  for (;;) {
    if (operation.done === true) {
      if (operation.error !== undefined && operation.error !== null) {
        const e = operation.error;
        const detail = e.message ? (typeof e.code === "number" ? `${e.code}: ${e.message}` : e.message) : JSON.stringify(e);
        throw new GoogleOAuthError(`OnboardUser operation failed: ${detail}`);
      }
      if (operation.response === undefined || operation.response === null) {
        throw new GoogleOAuthError("failed to unmarshal OnboardUserResponse");
      }
      return;
    }
    await sleep(Math.min(ctx.pollIntervalMs ?? ANTIGRAVITY_POLL_INTERVAL_MS, remaining()), ctx.signal);
    throwIfCancelled(ctx.signal);
    const name = operation.name ?? "";
    if (name.length === 0) throw new GoogleOAuthError("onboardUser returned an operation without a name");
    operation = (await requestJson(
      ctx,
      "google-antigravity",
      "onboardUser operation",
      `${base}/v1internal/${name}`,
      { method: "GET", headers },
      remaining(),
    )) as OnboardOperation;
  }
}

/** Resolve (and if needed provision) the Antigravity project for an access token. */
export async function discoverAntigravityProject(accessToken: string, ctx: ProjectHookContext): Promise<string> {
  const base = (ctx.controlPlaneUrl ?? ANTIGRAVITY_CONTROL_PLANE).replace(/\/+$/, "");
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": antigravityUserAgent(),
  };
  ctx.onProgress?.("Checking Cloud Code Assist account status...");
  const initial = await antigravityLoad(ctx, base, headers);
  assertFreeTierEligible(initial);
  if (!hasField(initial, "currentTier")) {
    ctx.onProgress?.("Provisioning the Antigravity free tier...");
    await antigravityOnboard(ctx, base, headers);
  }
  ctx.onProgress?.("Refreshing Cloud Code Assist project...");
  const refreshed = await antigravityLoad(ctx, base, headers);
  const projectId = extractProjectId(refreshed);
  if (projectId) return projectId;
  throw new GoogleOAuthError("loadCodeAssist did not return a cloudaicompanionProject");
}

// ---------------------------------------------------------------------------
// Gemini CLI (google-gemini-cli.ts)
// ---------------------------------------------------------------------------

const TIER_LEGACY = "legacy-tier";
const TIER_STANDARD = "standard-tier";
const GEMINI_POLL_INTERVAL_MS = 5_000;
export const GEMINI_POLL_MAX_ATTEMPTS = 24;
const PROJECT_ENV_MESSAGE =
  "This account requires setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. " +
  "See https://goo.gle/gemini-cli-auth-docs#workspace-gca";

interface LongRunningOperation {
  name?: string;
  done?: boolean;
  response?: { cloudaicompanionProject?: { id?: string } };
}

function isVpcScAffectedUser(payload: unknown): boolean {
  if (!isRecord(payload) || !isRecord(payload.error)) return false;
  const details = payload.error.details;
  return Array.isArray(details) && details.some((d) => isRecord(d) && d.reason === "SECURITY_POLICY_VIOLATED");
}

async function pollOperation(
  ctx: ProjectHookContext,
  base: string,
  name: string,
  headers: Record<string, string>,
): Promise<LongRunningOperation> {
  for (let attempt = 0; attempt < GEMINI_POLL_MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      ctx.onProgress?.(`Waiting for project provisioning (attempt ${attempt + 1}/${GEMINI_POLL_MAX_ATTEMPTS})...`);
      throwIfCancelled(ctx.signal);
      await sleep(ctx.pollIntervalMs ?? GEMINI_POLL_INTERVAL_MS, ctx.signal);
    }
    throwIfCancelled(ctx.signal);
    const response = await timedFetch(ctx.fetch, `${base}/v1internal/${name}`, { method: "GET", headers }, ctx.signal);
    if (!response.ok) {
      throw new GoogleOAuthError(`Failed to poll operation: ${response.status} ${response.statusText}`, response.status);
    }
    const data = (await response.json()) as LongRunningOperation;
    if (data.done) return data;
  }
  throw new GoogleOAuthError(`Project provisioning did not complete after ${GEMINI_POLL_MAX_ATTEMPTS} attempts`);
}

/** Resolve (and if needed provision) the Gemini CLI project for an access token. */
export async function discoverGeminiCliProject(accessToken: string, ctx: ProjectHookContext): Promise<string> {
  const base = (ctx.controlPlaneUrl ?? GEMINI_CLI_CONTROL_PLANE).replace(/\/+$/, "");
  const env = ctx.env ?? process.env;
  const envProjectId = env.GOOGLE_CLOUD_PROJECT || env.GOOGLE_CLOUD_PROJECT_ID || undefined;
  const headers = { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...geminiCliHeaders() };

  ctx.onProgress?.("Checking for existing Cloud Code Assist project...");
  const loadResponse = await timedFetch(
    ctx.fetch,
    `${base}/v1internal:loadCodeAssist`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        cloudaicompanionProject: envProjectId,
        metadata: {
          ideType: "IDE_UNSPECIFIED",
          platform: "PLATFORM_UNSPECIFIED",
          pluginType: "GEMINI",
          duetProject: envProjectId,
        },
      }),
    },
    ctx.signal,
  );

  let data: LoadCodeAssistResponse;
  if (!loadResponse.ok) {
    const text = await loadResponse.text();
    let errorPayload: unknown;
    try {
      errorPayload = JSON.parse(text);
    } catch {
      errorPayload = undefined;
    }
    if (!isVpcScAffectedUser(errorPayload)) {
      throw new GoogleOAuthError(
        `google-gemini-cli loadCodeAssist failed: ${loadResponse.status} ${loadResponse.statusText}: ${text}`,
        loadResponse.status,
      );
    }
    data = { currentTier: { id: TIER_STANDARD } };
  } else {
    data = (await loadResponse.json()) as LoadCodeAssistResponse;
  }

  if (data.currentTier) {
    if (data.cloudaicompanionProject) return data.cloudaicompanionProject;
    if (envProjectId) return envProjectId;
    throw new GoogleOAuthError(PROJECT_ENV_MESSAGE);
  }

  const allowed = data.allowedTiers ?? [];
  const tierId = (allowed.find((t) => t.isDefault) ?? { id: TIER_LEGACY }).id ?? FREE_TIER_ID;
  if (tierId !== FREE_TIER_ID && !envProjectId) throw new GoogleOAuthError(PROJECT_ENV_MESSAGE);

  ctx.onProgress?.("Provisioning Cloud Code Assist project (this may take a moment)...");
  const metadata: Record<string, unknown> = {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
  };
  const onboardBody: Record<string, unknown> = { tierId, metadata };
  if (tierId !== FREE_TIER_ID && envProjectId) {
    onboardBody.cloudaicompanionProject = envProjectId;
    metadata.duetProject = envProjectId;
  }
  const onboardResponse = await timedFetch(
    ctx.fetch,
    `${base}/v1internal:onboardUser`,
    { method: "POST", headers, body: JSON.stringify(onboardBody) },
    ctx.signal,
  );
  if (!onboardResponse.ok) {
    const text = await onboardResponse.text();
    throw new GoogleOAuthError(
      `google-gemini-cli onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}: ${text}`,
      onboardResponse.status,
    );
  }
  let lro = (await onboardResponse.json()) as LongRunningOperation;
  if (!lro.done && lro.name) lro = await pollOperation(ctx, base, lro.name, headers);

  const projectId = lro.response?.cloudaicompanionProject?.id;
  if (projectId) return projectId;
  if (envProjectId) return envProjectId;
  throw new GoogleOAuthError(
    "Could not discover or provision a Google Cloud project. " +
      "Try setting the GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable. " +
      "See https://goo.gle/gemini-cli-auth-docs#workspace-gca",
  );
}

// ---------------------------------------------------------------------------
// The hooks themselves (googleAntigravityProjectHook / googleGeminiCliProjectHook)
// ---------------------------------------------------------------------------

export interface ProjectHookInput extends ProjectHookContext {
  provider: GoogleCcaProviderId;
  phase: "login" | "refresh";
  /** The raw token-endpoint body. */
  raw: unknown;
  /** The stored credential (refresh phase). */
  stored?: OAuthCredentials;
}

/**
 * After login: require a refresh token, then discover the project. After a
 * refresh: carry the stored `projectId` forward (no control-plane call).
 */
export async function applyProjectHook(credentials: OAuthCredentials, input: ProjectHookInput): Promise<OAuthCredentials> {
  if (input.phase === "refresh") {
    const stored = input.stored?.projectId;
    return typeof stored === "string" && stored.length > 0 ? { ...credentials, projectId: stored } : credentials;
  }
  const raw = input.raw;
  if (!isRecord(raw) || typeof raw.refresh_token !== "string" || raw.refresh_token === "") {
    throw new GoogleOAuthError("No refresh token received. Please try again.");
  }
  const discover = input.provider === "google-antigravity" ? discoverAntigravityProject : discoverGeminiCliProject;
  let projectId: string;
  try {
    projectId = await discover(credentials.access, input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const validationUrl = extractGoogleValidationUrl(message);
    if (!validationUrl) throw error;
    const email = typeof credentials.email === "string" ? credentials.email : undefined;
    throw new GoogleOAuthError(formatGoogleValidationRequiredMessage(validationUrl, "sign in again", email));
  }
  return { ...credentials, projectId };
}
