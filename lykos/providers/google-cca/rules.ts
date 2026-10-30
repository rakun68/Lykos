// The two Google login rules as data.
//
// Defaults: `state "hex"`, the standard authorize parameters, port fallback, and scopes
// separated by a space.
//
// Client id and secret stay base64 in source, as the rules keep them, and are
// decoded when a flow runs.
//
// Lykos sends PKCE (S256) as plan D3 requires. Google's authorization server accepts PKCE
// on installed-app clients; it only adds a check, it removes none.

import type { GoogleCcaProviderId } from "./types.js";

export interface GoogleOAuthRule {
  provider: GoogleCcaProviderId;
  /** Display name from the rule's `name`. */
  name: string;
  clientIdBase64: string;
  clientSecretBase64: string;
  authorizeUrl: string;
  scopes: readonly string[];
  /** Extra authorize parameters after the standard ones. */
  authorizeParams: Readonly<Record<string, string>>;
  instructions: string;
  callback: { hostname: string; port: number; path: string; portFallback: boolean };
  tokenUrl: string;
  userinfoUrl: string;
  /** JSON path of the email in the userinfo body. */
  userinfoEmail: string;
  /** `expires "seconds" path="expires_in" skew-ms=300000`. */
  expiresPath: string;
  expiresSkewMs: number;
  pkce: boolean;
  /** `refresh { require … }`: fields a stored credential needs before a refresh is attempted. */
  refreshRequire: readonly string[];
}

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";

export const GOOGLE_ANTIGRAVITY_RULE: GoogleOAuthRule = {
  provider: "google-antigravity",
  name: "Antigravity (Gemini 3, Claude, GPT-OSS)",
  clientIdBase64:
    "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
  clientSecretBase64: "R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=",
  authorizeUrl: GOOGLE_AUTHORIZE_URL,
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
  ],
  authorizeParams: { access_type: "offline", prompt: "consent" },
  instructions: "Complete the sign-in in your browser.",
  callback: { hostname: "127.0.0.1", port: 51121, path: "/oauth-callback", portFallback: true },
  tokenUrl: GOOGLE_TOKEN_URL,
  userinfoUrl: GOOGLE_USERINFO_URL,
  userinfoEmail: "email",
  expiresPath: "expires_in",
  expiresSkewMs: 300_000,
  pkce: true,
  refreshRequire: ["projectId"],
};

export const GOOGLE_GEMINI_CLI_RULE: GoogleOAuthRule = {
  provider: "google-gemini-cli",
  name: "Google Cloud Code Assist (Gemini CLI)",
  clientIdBase64:
    "NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t",
  clientSecretBase64: "R09DU1BYLTR1SGdNUG0tMW83U2stZ2VWNkN1NWNsWEZzeGw=",
  authorizeUrl: GOOGLE_AUTHORIZE_URL,
  scopes: [
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ],
  authorizeParams: { access_type: "offline", prompt: "consent" },
  instructions: "Complete the sign-in in your browser.",
  callback: { hostname: "127.0.0.1", port: 8085, path: "/oauth2callback", portFallback: true },
  tokenUrl: GOOGLE_TOKEN_URL,
  userinfoUrl: GOOGLE_USERINFO_URL,
  userinfoEmail: "email",
  expiresPath: "expires_in",
  expiresSkewMs: 300_000,
  pkce: true,
  refreshRequire: ["projectId"],
};

export const GOOGLE_OAUTH_RULES: Readonly<Record<GoogleCcaProviderId, GoogleOAuthRule>> = {
  "google-antigravity": GOOGLE_ANTIGRAVITY_RULE,
  "google-gemini-cli": GOOGLE_GEMINI_CLI_RULE,
};

/** `encoding="base64"` values are decoded when a flow runs. */
export function decodeRuleValue(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf8");
}
