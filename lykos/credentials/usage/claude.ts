// Claude (Anthropic OAuth) usage provider.
//
// Reads the OAuth usage endpoint (`DEFAULT_ENDPOINT` + `/usage`). Two things
// are left out deliberately: a multi-attempt retry (the endpoint is undocumented and polling it may draw vendor
// attention, plan risk note) and the trailing `/profile` identity call (Lykos
// takes identity from the login, not from the usage report). Extra-usage spend
// is display-only, so it is not a window here.

import type { UsageFetchInput, UsageProvider, UsageReport, UsageWindow } from "./types.js";

export const CLAUDE_USAGE_DEFAULT_ENDPOINT = "https://api.anthropic.com/api/oauth";

const CLAUDE_CODE_VERSION = "2.1.257";

const CLAUDE_HEADERS = {
  accept: "application/json, text/plain, */*",
  "accept-encoding": "gzip, compress, deflate, br",
  "anthropic-beta":
    "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11",
  "content-type": "application/json",
  "user-agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
  connection: "keep-alive",
} as const;

const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;

export function normalizeClaudeBaseUrl(baseUrl?: string): string {
  if (!baseUrl?.trim()) return CLAUDE_USAGE_DEFAULT_ENDPOINT;
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.toLowerCase().endsWith("/api/oauth")) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return CLAUDE_USAGE_DEFAULT_ENDPOINT;
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (path === "/") path = "";
  if (path.toLowerCase().endsWith("/v1")) path = path.slice(0, -3);
  if (!path) return `${url.origin}/api/oauth`;
  return `${url.origin}${path}/api/oauth`;
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

function parseIsoTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface ParsedBucket {
  utilization: number | undefined;
  resetsAt: number | undefined;
}

function parseBucket(bucket: unknown): ParsedBucket | undefined {
  if (!isRecord(bucket)) return undefined;
  const utilization = toNumber(bucket.utilization);
  const resetsAt = parseIsoTimestamp(typeof bucket.resets_at === "string" ? bucket.resets_at : undefined);
  if (utilization === undefined && resetsAt === undefined) return undefined;
  return { utilization, resetsAt };
}

interface ParsedApiLimitEntry {
  kind: string;
  bucket: ParsedBucket;
  displayName?: string;
}

function parseApiLimitEntries(raw: unknown): ParsedApiLimitEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: ParsedApiLimitEntry[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.kind !== "string") continue;
    const utilization = toNumber(entry.percent);
    const resetsAt = parseIsoTimestamp(typeof entry.resets_at === "string" ? entry.resets_at : undefined);
    if (utilization === undefined && resetsAt === undefined) continue;
    let displayName: string | undefined;
    if (isRecord(entry.scope) && isRecord(entry.scope.model)) {
      const name = entry.scope.model.display_name;
      if (typeof name === "string" && name.trim()) displayName = name.trim();
    }
    entries.push({ kind: entry.kind, bucket: { utilization, resetsAt }, ...(displayName ? { displayName } : {}) });
  }
  return entries;
}

function toWindow(
  bucket: ParsedBucket | undefined,
  id: string,
  durationMs: number,
  role: "primary" | "secondary",
  tier?: string,
): UsageWindow | undefined {
  if (bucket?.utilization === undefined) return undefined;
  const usedFraction = Math.min(Math.max(bucket.utilization, 0), 100) / 100;
  return {
    id,
    role,
    ...(tier !== undefined ? { tier } : {}),
    usedFraction,
    exhausted: usedFraction >= 1,
    ...(bucket.resetsAt !== undefined ? { resetAtMs: bucket.resetsAt } : {}),
    durationMs,
  };
}

function slugify(displayName: string): string {
  return displayName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Parse a `/api/oauth/usage` body into windows. Exported for the fixture tests. */
export function parseClaudeUsage(payload: unknown, now: number): UsageReport | undefined {
  if (!isRecord(payload)) return undefined;
  const entries = parseApiLimitEntries(payload.limits);
  const fiveHour = parseBucket(payload.five_hour) ?? entries.find((e) => e.kind === "session")?.bucket;
  const sevenDay = parseBucket(payload.seven_day) ?? entries.find((e) => e.kind === "weekly_all")?.bucket;

  const windows: Array<UsageWindow | undefined> = [
    toWindow(fiveHour, "5h", 5 * HOUR_MS, "primary"),
    toWindow(sevenDay, "7d", WEEK_MS, "secondary"),
    toWindow(parseBucket(payload.seven_day_opus), "7d:opus", WEEK_MS, "secondary", "opus"),
    toWindow(parseBucket(payload.seven_day_sonnet), "7d:sonnet", WEEK_MS, "secondary", "sonnet"),
  ];
  // Named `weekly_scoped` entries, one per family slug.
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "weekly_scoped" || !entry.displayName) continue;
    const slug = slugify(entry.displayName);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    windows.push(toWindow(entry.bucket, `7d:${slug}`, WEEK_MS, "secondary", slug));
  }

  const present = windows.filter((w): w is UsageWindow => w !== undefined);
  if (present.length === 0) return undefined;
  return { windows: present, fetchedAt: now };
}

function readAccessToken(credentialData: string): string | undefined {
  try {
    const data = JSON.parse(credentialData) as Record<string, unknown>;
    return typeof data.access === "string" && data.access.length > 0 ? data.access : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchClaudeUsage(input: UsageFetchInput): Promise<UsageReport | undefined> {
  const accessToken = readAccessToken(input.credentialData);
  if (accessToken === undefined) return undefined;
  const url = `${normalizeClaudeBaseUrl(input.baseUrl)}/usage`;
  const headers: Record<string, string> = { ...CLAUDE_HEADERS, authorization: `Bearer ${accessToken}` };
  try {
    const response = await input.fetch(url, { headers, ...(input.signal !== undefined ? { signal: input.signal } : {}) });
    if (!response.ok) return undefined;
    return parseClaudeUsage((await response.json()) as unknown, input.now ?? Date.now());
  } catch {
    return undefined;
  }
}

export const claudeUsageProvider: UsageProvider = {
  providerId: "anthropic",
  fetchUsage: fetchClaudeUsage,
};
