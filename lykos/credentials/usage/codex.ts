// OpenAI Codex usage provider.
//
// Reads `${base}/wham/usage` on `https://chatgpt.com/backend-api`. Left out: the `wham/rate-limit-reset-credits` detail
// call (saved resets are not something Lykos ranks or shows).

import { Buffer } from "node:buffer";
import type { UsageFetchInput, UsageProvider, UsageReport, UsageWindow } from "./types.js";

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_USAGE_PATH = "wham/usage";
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
/** Lykos names itself instead of impersonating another client. */
const USER_AGENT = "lykos";

/** Only the canonical ChatGPT origins are honoured. */
export function normalizeCodexBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim().replace(/\/+$/, "");
  if (!trimmed) return CODEX_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return CODEX_BASE_URL;
  }
  const host = parsed.host.toLowerCase();
  if (host !== "chatgpt.com" && host !== "chat.openai.com") return CODEX_BASE_URL;
  return `${parsed.origin}/backend-api`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

interface ParsedWindow {
  usedPercent: number | undefined;
  limitWindowSeconds: number | undefined;
  resetAfterSeconds: number | undefined;
  resetAt: number | undefined;
}

function parseUsageWindow(payload: unknown): ParsedWindow | undefined {
  if (!isRecord(payload)) return undefined;
  const usedPercent = toNumber(payload.used_percent);
  const limitWindowSeconds = toNumber(payload.limit_window_seconds);
  const resetAfterSeconds = toNumber(payload.reset_after_seconds);
  const resetAt = toNumber(payload.reset_at);
  if (
    usedPercent === undefined &&
    limitWindowSeconds === undefined &&
    resetAfterSeconds === undefined &&
    resetAt === undefined
  ) {
    return undefined;
  }
  return { usedPercent, limitWindowSeconds, resetAfterSeconds, resetAt };
}

function windowId(seconds: number): string {
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d`;
  return `${Math.max(1, Math.round(seconds / 3600))}h`;
}

function resolveResetTime(window: ParsedWindow, nowMs: number): number | undefined {
  if (window.resetAt !== undefined) {
    const resetAtMs = window.resetAt > 1_000_000_000_000 ? window.resetAt : window.resetAt * 1000;
    if (Number.isFinite(resetAtMs)) return resetAtMs;
  }
  if (window.resetAfterSeconds !== undefined) return nowMs + window.resetAfterSeconds * 1000;
  return undefined;
}

/**
 * One meter as a window. A window at 100% is exhausted unless the meter says
 * it is explicitly allowed (`allowed: true, limit_reached: false`). A window with no `used_percent` has no fraction to
 * rank or show, so it is dropped.
 */
function toWindow(
  window: ParsedWindow | undefined,
  key: "primary" | "secondary",
  nowMs: number,
  explicitlyAllowed: boolean,
  tier?: string,
): UsageWindow | undefined {
  if (window?.usedPercent === undefined) return undefined;
  const usedFraction = Math.min(Math.max(window.usedPercent, 0), 100) / 100;
  const resetAtMs = resolveResetTime(window, nowMs);
  const base = window.limitWindowSeconds !== undefined ? windowId(window.limitWindowSeconds) : key;
  return {
    id: tier !== undefined ? `${tier}:${base}` : base,
    role: key,
    ...(tier !== undefined ? { tier } : {}),
    usedFraction,
    exhausted: usedFraction >= 1 && !explicitlyAllowed,
    ...(resetAtMs !== undefined ? { resetAtMs } : {}),
    ...(window.limitWindowSeconds !== undefined ? { durationMs: window.limitWindowSeconds * 1000 } : {}),
  };
}

function additionalLimitSlug(limitName: string | undefined, meteredFeature: string | undefined): string {
  const probe = `${limitName ?? ""} ${meteredFeature ?? ""}`.toLowerCase();
  if (probe.includes("spark") || probe.includes("bengalfox")) return "spark";
  const source = (meteredFeature ?? limitName ?? "extra").toLowerCase();
  return (
    source
      .replace(/^codex[-_]/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "extra"
  );
}

function meterWindows(rateLimit: Record<string, unknown>, nowMs: number, tier?: string): UsageWindow[] {
  const allowed = typeof rateLimit.allowed === "boolean" ? rateLimit.allowed : undefined;
  const limitReached = typeof rateLimit.limit_reached === "boolean" ? rateLimit.limit_reached : undefined;
  const explicitlyAllowed = allowed === true && limitReached === false;
  return [
    toWindow(parseUsageWindow(rateLimit.primary_window), "primary", nowMs, explicitlyAllowed, tier),
    toWindow(parseUsageWindow(rateLimit.secondary_window), "secondary", nowMs, explicitlyAllowed, tier),
  ].filter((w): w is UsageWindow => w !== undefined);
}

/** Parse a `wham/usage` body into windows. Exported for the fixture tests. */
export function parseCodexUsage(payload: unknown, nowMs: number): UsageReport | undefined {
  if (!isRecord(payload)) return undefined;
  const windows: UsageWindow[] = [];
  if (isRecord(payload.rate_limit)) windows.push(...meterWindows(payload.rate_limit, nowMs));
  const additional = Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [];
  for (const extra of additional) {
    if (!isRecord(extra) || !isRecord(extra.rate_limit)) continue;
    const slug = additionalLimitSlug(
      typeof extra.limit_name === "string" ? extra.limit_name : undefined,
      typeof extra.metered_feature === "string" ? extra.metered_feature : undefined,
    );
    windows.push(...meterWindows(extra.rate_limit, nowMs, slug));
  }
  if (windows.length === 0) return undefined;
  const plan = typeof payload.plan_type === "string" ? payload.plan_type : undefined;
  return { windows, ...(plan !== undefined ? { plan } : {}), fetchedAt: nowMs };
}

/** The `chatgpt_account_id` claim of the access JWT. */
function accountIdFromJwt(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    const claim = payload[JWT_AUTH_CLAIM];
    return isRecord(claim) && typeof claim.chatgpt_account_id === "string" ? claim.chatgpt_account_id : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchCodexUsage(input: UsageFetchInput): Promise<UsageReport | undefined> {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input.credentialData) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const accessToken = typeof data.access === "string" && data.access.length > 0 ? data.access : undefined;
  if (accessToken === undefined) return undefined;
  const nowMs = input.now ?? Date.now();
  // An expired token is not sent.
  if (typeof data.expires === "number" && data.expires <= nowMs) return undefined;

  const accountId = (typeof data.accountId === "string" ? data.accountId : undefined) ?? accountIdFromJwt(accessToken);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": USER_AGENT,
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;

  const base = normalizeCodexBaseUrl(input.baseUrl);
  const url = `${base.endsWith("/") ? base : `${base}/`}${CODEX_USAGE_PATH}`;
  try {
    const response = await input.fetch(url, { headers, ...(input.signal !== undefined ? { signal: input.signal } : {}) });
    if (!response.ok) return undefined;
    return parseCodexUsage((await response.json()) as unknown, nowMs);
  } catch {
    return undefined;
  }
}

export const codexUsageProvider: UsageProvider = {
  providerId: "openai-codex",
  fetchUsage: fetchCodexUsage,
};
