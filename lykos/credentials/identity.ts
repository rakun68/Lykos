// Credential identity rules.
//
// The identity key decides whether a login updates an existing row or adds a
// new one to the provider's pool. Identity is plain key equality.

import { createHash } from "node:crypto";

/** The OAuth fields identity reads. Pi's `OAuthCredential` satisfies it. */
export interface OAuthIdentityFields {
  access?: unknown;
  refresh?: unknown;
  accountId?: unknown;
  email?: unknown;
  projectId?: unknown;
  orgId?: unknown;
}

/** `key:` + the first 16 hex chars of sha256 of the stored key source (literal, `$VAR` or `!command`). */
export function apiKeyIdentityKey(source: string): string {
  return `key:${createHash("sha256").update(source).digest("hex").slice(0, 16)}`;
}

function normalizeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Identifiers carried in a JWT's payload claims; undefined when the token is not a three-part JWT. */
export function extractOAuthTokenIdentifiers(token: unknown): string[] | undefined {
  if (typeof token !== "string" || token.length === 0) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    if (!isRecord(payload)) return undefined;
    const identifiers = new Set<string>();
    const directEmail = normalizeEmail(payload.email);
    if (directEmail) identifiers.add(`email:${directEmail}`);
    const openAiProfile = payload["https://api.openai.com/profile"];
    if (isRecord(openAiProfile)) {
      const claimEmail = normalizeEmail(openAiProfile.email);
      if (claimEmail) identifiers.add(`email:${claimEmail}`);
    }
    const openAiAuth = payload["https://api.openai.com/auth"];
    const authClaims = isRecord(openAiAuth) ? openAiAuth : undefined;
    const accountId = normalizeId(
      typeof payload.account_id === "string"
        ? payload.account_id
        : typeof payload.accountId === "string"
          ? payload.accountId
          : typeof payload.user_id === "string"
            ? payload.user_id
            : typeof payload.sub === "string"
              ? payload.sub
              : authClaims?.chatgpt_account_id,
    );
    if (accountId) identifiers.add(`account:${accountId}`);
    return identifiers.size > 0 ? [...identifiers] : undefined;
  } catch {
    return undefined;
  }
}

/** Every identifier an OAuth credential carries: its own fields, then its access and refresh tokens' claims. */
export function extractOAuthCredentialIdentifiers(credential: OAuthIdentityFields): string[] {
  const identifiers = new Set<string>();
  const accountId = normalizeId(credential.accountId);
  if (accountId) identifiers.add(`account:${accountId}`);
  const email = normalizeEmail(credential.email);
  if (email) identifiers.add(`email:${email}`);
  const projectId = normalizeId(credential.projectId);
  if (projectId) identifiers.add(`project:${projectId}`);
  const orgId = normalizeId(credential.orgId);
  if (orgId) identifiers.add(`org:${orgId}`);
  for (const id of extractOAuthTokenIdentifiers(credential.access) ?? []) identifiers.add(id);
  for (const id of extractOAuthTokenIdentifiers(credential.refresh) ?? []) identifiers.add(id);
  return [...identifiers];
}

function resolveProviderIdentityKey(provider: string, identifiers: string[]): string | null {
  const email = identifiers.find((id) => id.startsWith("email:"));
  if (provider === "anthropic" || provider === "openai-codex") {
    // One email can hold several organisations, each its own subscription:
    // scope the identity by org so both can sit in the pool side by side.
    const base =
      email ?? identifiers.find((id) => id.startsWith("account:")) ?? identifiers.find((id) => id.startsWith("project:"));
    const org = identifiers.find((id) => id.startsWith("org:"));
    if (base) return org ? `${base}|${org}` : base;
    return org ?? null;
  }
  return (
    identifiers.find((id) => id.startsWith("account:")) ??
    email ??
    identifiers.find((id) => id.startsWith("project:")) ??
    null
  );
}

/** The pool identity of an OAuth credential, or null when none can be recovered (every such login inserts). */
export function oauthIdentityKey(provider: string, credential: OAuthIdentityFields): string | null {
  return resolveProviderIdentityKey(provider, extractOAuthCredentialIdentifiers(credential));
}

/** The account email to show as a label, if the credential carries one. Not a secret. */
export function oauthDisplayEmail(credential: OAuthIdentityFields): string | undefined {
  const email = extractOAuthCredentialIdentifiers(credential).find((id) => id.startsWith("email:"));
  return email?.slice("email:".length);
}
