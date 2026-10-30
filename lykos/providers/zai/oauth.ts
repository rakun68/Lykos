// Z.ai / GLM Coding Plan OAuth flow.
//
// Authorization-code flow (no PKCE) using ZCode desktop scheme redirect (zcode://zai-auth/callback).
// Loopback servers cannot receive this scheme without registering OS URL handlers, so login
// displays the URL and asks the user to paste either the final redirect URL or the bare code.
// The short-lived OAuth access token is exchanged for a business token, and provisions/reuses
// a durable id.secret API key named "lykos" (plan D2).

import { randomBytes } from "node:crypto";

// The provider's OAuth client and endpoints.
export const ZAI_CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
export const ZAI_AUTHORIZE_URL = "https://chat.z.ai/api/oauth/authorize";
export const ZAI_TOKEN_URL = "https://zcode.z.ai/api/v1/oauth/token";
export const ZAI_REDIRECT_URI = "zcode://zai-auth/callback";
export const ZAI_BUSINESS_LOGIN_URL = "https://api.z.ai/api/auth/z/login";
export const ZAI_BIZ_BASE = "https://api.z.ai";
export const ZAI_KEY_NAME = "lykos"; // Plan D2: the minted key's name
export const NEVER_EXPIRES = 8.64e15;

export interface ZaiOAuthUrls {
  authorizeUrl?: string;
  tokenUrl?: string;
  businessLoginUrl?: string;
  bizBase?: string;
  redirectUri?: string;
  clientId?: string;
}

export interface ZaiOAuthDeps {
  fetch?: typeof fetch;
  openBrowser?: (url: string) => void;
  now?: () => number;
  urls?: ZaiOAuthUrls;
  env?: NodeJS.ProcessEnv;
}

export interface ZaiOAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  accountId?: string;
  [key: string]: unknown;
}

export interface ZaiLoginCallbacks {
  onAuth?: (info: { url: string; instructions?: string }) => void;
  onPrompt?: (prompt: { message: string }) => Promise<string>;
  onManualCodeInput?: () => Promise<string>;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

function redactTokens(text: string): string {
  return text
    .replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[redacted]")
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "[redacted]");
}

function isSuccessCode(code: unknown): boolean {
  if (code == null) return true;
  if (typeof code === "number") return code === 0 || code === 200;
  if (typeof code === "string") return code === "0" || code === "200";
  return false;
}

function unwrapEnvelope(body: unknown, operation: string): unknown {
  if (body && typeof body === "object" && ("code" in body || "success" in body)) {
    const envelope = body as { code?: unknown; msg?: string; data?: unknown; success?: unknown };
    if (envelope.success === false || !isSuccessCode(envelope.code)) {
      const msg = envelope.msg ?? `code ${String(envelope.code)}`;
      throw new Error(`Z.ai ${operation} failed: ${redactTokens(msg)}`);
    }
    return "data" in envelope && envelope.data !== undefined ? envelope.data : envelope;
  }
  return body;
}

export function extractCodeFromInput(raw: string): string {
  const trimmed = raw.trim();
  // Case 1: Full URL or contains ?code= or &code=
  try {
    const url = new URL(trimmed);
    const codeParam = url.searchParams.get("code");
    if (codeParam) {
      return codeParam.split("#")[0]!;
    }
  } catch {
    // Not a full standard URL, test query string
    const match = trimmed.match(/[?&]code=([^&#\s]+)/);
    if (match && match[1]) {
      return match[1];
    }
  }
  // Case 2: code#state
  const hashIdx = trimmed.indexOf("#");
  if (hashIdx >= 0) {
    return trimmed.slice(0, hashIdx);
  }
  // Case 3: Bare authorization code
  return trimmed;
}

export async function loginZai(
  callbacks: ZaiLoginCallbacks,
  deps: ZaiOAuthDeps = {},
): Promise<ZaiOAuthCredentials> {
  const env = deps.env ?? process.env;
  const authorizeUrl = deps.urls?.authorizeUrl ?? env.ZAI_OAUTH_AUTHORIZE_URL ?? ZAI_AUTHORIZE_URL;
  const tokenUrl = deps.urls?.tokenUrl ?? env.ZAI_OAUTH_TOKEN_URL ?? ZAI_TOKEN_URL;
  const businessLoginUrl = deps.urls?.businessLoginUrl ?? env.ZAI_BUSINESS_LOGIN_URL ?? ZAI_BUSINESS_LOGIN_URL;
  const bizBase = deps.urls?.bizBase ?? env.ZAI_BIZ_BASE ?? ZAI_BIZ_BASE;
  const redirectUri = deps.urls?.redirectUri ?? env.ZAI_OAUTH_REDIRECT_URI ?? ZAI_REDIRECT_URI;
  const clientId = deps.urls?.clientId ?? env.ZAI_OAUTH_CLIENT_ID ?? ZAI_CLIENT_ID;
  const fetchImpl = deps.fetch ?? globalThis.fetch;

  if (callbacks.signal?.aborted) {
    throw new Error("OAuth login cancelled");
  }

  const state = randomBytes(16).toString("hex");
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    state,
  });
  const authUrl = `${authorizeUrl}?${params.toString()}`;
  const instructions =
    "Complete Z.ai login in your browser. You can also paste the final redirect URL or authorization code when prompted.";

  callbacks.onAuth?.({ url: authUrl, instructions });
  deps.openBrowser?.(authUrl);
  callbacks.onProgress?.("Waiting for authorization code...");

  let rawCode: string | undefined;
  if (callbacks.onManualCodeInput) {
    rawCode = await callbacks.onManualCodeInput();
  } else if (callbacks.onPrompt) {
    rawCode = await callbacks.onPrompt({ message: "Paste the final redirect URL or authorization code" });
  }

  if (!rawCode || !rawCode.trim()) {
    throw new Error("No authorization code provided");
  }

  if (callbacks.signal?.aborted) {
    throw new Error("OAuth login cancelled");
  }

  const code = extractCodeFromInput(rawCode);

  callbacks.onProgress?.("Exchanging authorization code...");
  let tokenRes: Response;
  try {
    tokenRes = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "zai",
        code,
        redirect_uri: redirectUri,
        state,
      }),
      ...(callbacks.signal !== undefined ? { signal: callbacks.signal } : {}),
    });
  } catch (err) {
    throw new Error(`Z.ai request to ${tokenUrl} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const tokenText = await tokenRes.text();
  let tokenBody: unknown;
  try {
    tokenBody = tokenText.length > 0 ? JSON.parse(tokenText) : undefined;
  } catch {
    tokenBody = undefined;
  }

  if (!tokenRes.ok) {
    throw new Error(`Z.ai token exchange failed: ${tokenRes.status} ${redactTokens(tokenText.slice(0, 500))}`);
  }

  const unwrappedToken = unwrapEnvelope(tokenBody, "token exchange") as
    | { zai?: { access_token?: string }; user?: { email?: string; id?: string | number } }
    | undefined;

  const oauthAccessToken = unwrappedToken?.zai?.access_token;
  if (!oauthAccessToken) {
    throw new Error("Z.ai token response missing access token");
  }
  const email = unwrappedToken?.user?.email;
  const accountId = unwrappedToken?.user?.id !== undefined ? String(unwrappedToken.user.id) : undefined;

  callbacks.onProgress?.("Minting durable API key...");

  // 1. Business login
  let bizRes: Response;
  try {
    bizRes = await fetchImpl(businessLoginUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: oauthAccessToken }),
      ...(callbacks.signal !== undefined ? { signal: callbacks.signal } : {}),
    });
  } catch (err) {
    throw new Error(`Z.ai request to ${businessLoginUrl} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const bizText = await bizRes.text();
  let bizBody: unknown;
  try {
    bizBody = bizText.length > 0 ? JSON.parse(bizText) : undefined;
  } catch {
    bizBody = undefined;
  }

  if (!bizRes.ok) {
    throw new Error(`Z.ai business login failed: ${bizRes.status} ${redactTokens(bizText.slice(0, 500))}`);
  }

  const unwrappedBiz = unwrapEnvelope(bizBody, "business login") as
    | { access_token?: string; accessToken?: string }
    | undefined;
  const bizToken = unwrappedBiz?.access_token ?? unwrappedBiz?.accessToken;
  if (!bizToken) {
    throw new Error("Z.ai business login returned no access token");
  }

  const authHeaders = { Authorization: `Bearer ${bizToken}` };

  // 2. Resolve default org/project from getCustomerInfo
  const custUrl = `${bizBase}/api/biz/customer/getCustomerInfo`;
  let custRes: Response;
  try {
    custRes = await fetchImpl(custUrl, {
      method: "GET",
      headers: authHeaders,
      ...(callbacks.signal !== undefined ? { signal: callbacks.signal } : {}),
    });
  } catch (err) {
    throw new Error(`Z.ai request to ${custUrl} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const custText = await custRes.text();
  let custBody: unknown;
  try {
    custBody = custText.length > 0 ? JSON.parse(custText) : undefined;
  } catch {
    custBody = undefined;
  }

  if (!custRes.ok) {
    throw new Error(`Z.ai customer lookup failed: ${custRes.status} ${redactTokens(custText.slice(0, 500))}`);
  }

  interface ZaiProject {
    projectId?: string;
    isDefault?: boolean;
  }
  interface ZaiOrg {
    organizationId?: string;
    isDefault?: boolean;
    projects?: ZaiProject[];
  }

  const unwrappedCust = unwrapEnvelope(custBody, "customer lookup") as { organizations?: ZaiOrg[] } | undefined;
  const orgs = Array.isArray(unwrappedCust?.organizations) ? unwrappedCust.organizations : [];
  const org = orgs.find((o) => o?.isDefault) ?? orgs[0];
  const projects = Array.isArray(org?.projects) ? org.projects : [];
  const project = projects.find((p) => p?.isDefault) ?? projects[0];
  const organizationId = org?.organizationId;
  const projectId = project?.projectId;

  if (!organizationId || !projectId) {
    throw new Error("Z.ai key provisioning failed: no organization/project on account");
  }

  // 3. Find or create API key named "lykos"
  const keysUrl = `${bizBase}/api/biz/v1/organization/${organizationId}/projects/${projectId}/api_keys`;
  let listRes: Response;
  try {
    listRes = await fetchImpl(keysUrl, {
      method: "GET",
      headers: authHeaders,
      ...(callbacks.signal !== undefined ? { signal: callbacks.signal } : {}),
    });
  } catch (err) {
    throw new Error(`Z.ai request to ${keysUrl} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const listText = await listRes.text();
  let listBody: unknown;
  try {
    listBody = listText.length > 0 ? JSON.parse(listText) : undefined;
  } catch {
    listBody = undefined;
  }

  if (!listRes.ok) {
    throw new Error(`Z.ai api key list failed: ${listRes.status} ${redactTokens(listText.slice(0, 500))}`);
  }

  const unwrappedList = unwrapEnvelope(listBody, "api key list");
  let keysArray: Array<{ name?: string; apiKey?: string }> = [];
  if (Array.isArray(unwrappedList)) {
    keysArray = unwrappedList;
  } else if (unwrappedList && typeof unwrappedList === "object") {
    const rec = unwrappedList as Record<string, unknown>;
    for (const f of ["list", "keys", "apiKeys", "records"]) {
      if (Array.isArray(rec[f])) {
        keysArray = rec[f] as Array<{ name?: string; apiKey?: string }>;
        break;
      }
    }
  }

  const existing = keysArray.find((k) => k?.name === ZAI_KEY_NAME);
  let apiKey = existing?.apiKey;

  if (!apiKey) {
    let createRes: Response;
    try {
      createRes = await fetchImpl(keysUrl, {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ name: ZAI_KEY_NAME }),
        ...(callbacks.signal !== undefined ? { signal: callbacks.signal } : {}),
      });
    } catch (err) {
      throw new Error(`Z.ai request to ${keysUrl} failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const createText = await createRes.text();
    let createBody: unknown;
    try {
      createBody = createText.length > 0 ? JSON.parse(createText) : undefined;
    } catch {
      createBody = undefined;
    }

    if (!createRes.ok) {
      throw new Error(`Z.ai api key create failed: ${createRes.status} ${redactTokens(createText.slice(0, 500))}`);
    }

    const unwrappedCreate = unwrapEnvelope(createBody, "api key create") as { apiKey?: string } | undefined;
    apiKey = unwrappedCreate?.apiKey;
    if (!apiKey) {
      throw new Error("Z.ai key provisioning returned no apiKey");
    }
  }

  // 4. Always fetch secretKey via copy endpoint
  const copyUrl = `${keysUrl}/copy/${encodeURIComponent(apiKey)}`;
  let copyRes: Response;
  try {
    copyRes = await fetchImpl(copyUrl, {
      method: "GET",
      headers: authHeaders,
      ...(callbacks.signal !== undefined ? { signal: callbacks.signal } : {}),
    });
  } catch (err) {
    throw new Error(`Z.ai request to ${copyUrl} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const copyText = await copyRes.text();
  let copyBody: unknown;
  try {
    copyBody = copyText.length > 0 ? JSON.parse(copyText) : undefined;
  } catch {
    copyBody = undefined;
  }

  if (!copyRes.ok) {
    throw new Error(`Z.ai api key copy failed: ${copyRes.status} ${redactTokens(copyText.slice(0, 500))}`);
  }

  const unwrappedCopy = unwrapEnvelope(copyBody, "api key copy") as { secretKey?: string } | undefined;
  const secretKey = unwrappedCopy?.secretKey;
  if (!secretKey) {
    throw new Error("Z.ai key provisioning returned no secretKey");
  }

  const durableKey = `${apiKey}.${secretKey}`;

  return {
    access: durableKey,
    refresh: "",
    expires: NEVER_EXPIRES,
    ...(email ? { email } : {}),
    ...(accountId ? { accountId } : {}),
  };
}
