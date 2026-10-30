// GitLab Duo Agent login and refresh.
//
// The callback is manual, with redirect `vscode://gitlab.gitlab-workflow/authentication`
// (GitLab's VS Code OAuth application), which no loopback server can receive. So the flow
// prints and opens the authorize URL, then asks the user to paste the full `vscode://...`
// callback URL, or the bare code. No URL-scheme handler is registered (plan D1).
//
// PKCE and the form token POST are ticket 11's (`../gitlab-duo/oauth.ts`), reused here.
//
// A pasted callback whose `state` differs is refused with an error; the login surface asks once.

import { randomBytes } from "node:crypto";
import { generatePkce, postGitLabTokenForm } from "../gitlab-duo/oauth.js";

// GitLab's VS Code OAuth application. Expiry is `created_at + expires_in`, less a 5 min skew.
export const GITLAB_DUO_AGENT_CLIENT_ID = "36f2a70cddeb5a0889d4fd8295c241b7e9848e89cf9e599d0eed2d8e5350fbf5";
export const GITLAB_DUO_AGENT_AUTHORIZE_URL = "https://gitlab.com/oauth/authorize";
export const GITLAB_DUO_AGENT_TOKEN_URL = "https://gitlab.com/oauth/token";
export const GITLAB_DUO_AGENT_REDIRECT_URI = "vscode://gitlab.gitlab-workflow/authentication";
export const GITLAB_DUO_AGENT_SCOPE = "api";
export const GITLAB_DUO_AGENT_EXPIRES_SKEW_MS = 300_000;

/** Shown before the browser opens. */
export const GITLAB_DUO_AGENT_INSTRUCTIONS =
  "Complete GitLab login in your browser. This uses GitLab's official VS Code OAuth application. If the redirect opens VS Code instead of returning to Lykos, copy the full vscode://gitlab.gitlab-workflow/authentication?... callback URL from VS Code/browser and paste it back into Lykos.";

const PASTE_PROMPT = "Paste the full vscode://gitlab.gitlab-workflow/authentication?... callback URL (or the bare code)";

export interface GitLabDuoAgentOAuthUrls {
  authorizeUrl?: string;
  tokenUrl?: string;
}

export interface GitLabDuoAgentOAuthDeps {
  fetch?: typeof fetch;
  /** Opens the authorize URL. Lykos's login surface already opens it from `onAuth`; this is for direct callers. */
  openBrowser?: (url: string) => void;
  now?: () => number;
  urls?: GitLabDuoAgentOAuthUrls;
}

export interface GitLabDuoAgentCredentials {
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
}

export interface GitLabDuoAgentLoginCallbacks {
  onAuth?: (info: { url: string; instructions?: string }) => void;
  onPrompt?: (prompt: { message: string; placeholder?: string }) => Promise<string>;
  onManualCodeInput?: () => Promise<string>;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

/** callback-server.ts `parseCallbackInput`: a redirect URL, a query string, or a raw code (`code#state`). */
export function parseCallbackInput(input: string): { code?: string; state?: string } {
  const value = input.trim();
  if (!value) return {};

  try {
    const url = new URL(value);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    return { ...(code !== null ? { code } : {}), ...(state !== null ? { state } : {}) };
  } catch {
    // Not a URL - check for query string format
  }

  if (value.includes("code=")) {
    const params = new URLSearchParams(value.replace(/^[?#]/, ""));
    const code = params.get("code");
    const state = params.get("state");
    return { ...(code !== null ? { code } : {}), ...(state !== null ? { state } : {}) };
  }

  const [code, state] = value.split("#", 2);
  return { ...(code !== undefined ? { code } : {}), ...(state !== undefined ? { state } : {}) };
}

/** Maps a token response to the stored credential. */
function mapCredentials(body: any, now: () => number, previous?: GitLabDuoAgentCredentials): GitLabDuoAgentCredentials {
  const access = typeof body?.access_token === "string" && body.access_token.length > 0 ? body.access_token : undefined;
  if (access === undefined) throw new Error("gitlab-duo-agent token response missing access token");
  const seconds = body?.expires_in;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    throw new Error("gitlab-duo-agent token response missing expires_in");
  }
  const from = body?.created_at;
  const base = typeof from === "number" && Number.isFinite(from) ? from * 1000 : now();
  const refresh = typeof body?.refresh_token === "string" ? body.refresh_token : (previous?.refresh ?? "");
  return { access, refresh, expires: base + seconds * 1000 - GITLAB_DUO_AGENT_EXPIRES_SKEW_MS };
}

async function readPastedCallback(callbacks: GitLabDuoAgentLoginCallbacks): Promise<string | undefined> {
  if (callbacks.onPrompt) return callbacks.onPrompt({ message: PASTE_PROMPT });
  if (callbacks.onManualCodeInput) return callbacks.onManualCodeInput();
  return undefined;
}

/** Authorization code with PKCE through a pasted `vscode://` callback (plan D1). */
export async function loginGitLabDuoAgent(
  callbacks: GitLabDuoAgentLoginCallbacks,
  deps: GitLabDuoAgentOAuthDeps = {},
): Promise<GitLabDuoAgentCredentials> {
  const authorizeUrl = deps.urls?.authorizeUrl ?? GITLAB_DUO_AGENT_AUTHORIZE_URL;
  const tokenUrl = deps.urls?.tokenUrl ?? GITLAB_DUO_AGENT_TOKEN_URL;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  if (callbacks.signal?.aborted) throw new Error("OAuth login cancelled");

  // callback-server.ts `generateState`: 16 random bytes, hex.
  const state = randomBytes(16).toString("hex");
  const pkce = generatePkce();
  // oauth-code.ts `generateAuthUrl`, standard authorize params in its order.
  const params = new URLSearchParams();
  params.set("client_id", GITLAB_DUO_AGENT_CLIENT_ID);
  params.set("response_type", "code");
  params.set("redirect_uri", GITLAB_DUO_AGENT_REDIRECT_URI);
  params.set("scope", GITLAB_DUO_AGENT_SCOPE);
  params.set("code_challenge", pkce.challenge);
  params.set("code_challenge_method", "S256");
  params.set("state", state);
  const url = `${authorizeUrl}?${params.toString()}`;

  callbacks.onAuth?.({ url, instructions: GITLAB_DUO_AGENT_INSTRUCTIONS });
  deps.openBrowser?.(url);

  const pasted = await readPastedCallback(callbacks);
  if (callbacks.signal?.aborted) throw new Error("OAuth login cancelled");
  const parsed = parseCallbackInput(pasted ?? "");
  if (!parsed.code) throw new Error("No authorization code provided");
  if (parsed.state && parsed.state !== state) {
    // callback-server.ts's text for a mismatched state.
    throw new Error("State mismatch - possible CSRF attack");
  }

  callbacks.onProgress?.("Exchanging authorization code for tokens...");
  // oauth-code.ts `exchangeToken`: the standard authorization_code params, form body.
  const body = await postGitLabTokenForm(
    tokenUrl,
    {
      grant_type: "authorization_code",
      client_id: GITLAB_DUO_AGENT_CLIENT_ID,
      code: parsed.code,
      redirect_uri: GITLAB_DUO_AGENT_REDIRECT_URI,
      code_verifier: pkce.verifier,
    },
    {
      fetch: fetchImpl,
      failure: "GitLab Duo Agent token exchange failed",
      ...(callbacks.signal !== undefined ? { signal: callbacks.signal } : {}),
    },
  );
  return mapCredentials(body, now);
}

/** The refresh-token grant, sending `redirect_uri` as GitLab requires. */
export async function refreshGitLabDuoAgent(
  stored: GitLabDuoAgentCredentials,
  deps: GitLabDuoAgentOAuthDeps = {},
  signal?: AbortSignal,
): Promise<GitLabDuoAgentCredentials> {
  const tokenUrl = deps.urls?.tokenUrl ?? GITLAB_DUO_AGENT_TOKEN_URL;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  if (!stored.refresh) throw new Error("gitlab-duo-agent credentials are missing refresh; sign in again");
  const body = await postGitLabTokenForm(
    tokenUrl,
    {
      grant_type: "refresh_token",
      client_id: GITLAB_DUO_AGENT_CLIENT_ID,
      refresh_token: stored.refresh,
      redirect_uri: GITLAB_DUO_AGENT_REDIRECT_URI,
    },
    { fetch: fetchImpl, failure: "GitLab Duo Agent token refresh failed", ...(signal !== undefined ? { signal } : {}) },
  );
  return { ...stored, ...mapCredentials(body, now, stored) };
}
