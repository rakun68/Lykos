// Failure classifier for rotation.
//
// Decides whether a failure moves the session to the next credential: auth
// errors, usage limits, account policy denials, rate-limit reasons and retry
// hints, each read from the provider's error text.
//
// Pi hands the wrapper only an error *message*, so every decision here reads
// text. Two message shapes were observed against a local server (rule 1):
// Pi's Anthropic/OpenAI SDK path reports `429 {"type":"error",...}` (status
// first), and Lykos's Cloud Code Assist stream reports
// `Cloud Code Assist API error: 429 {...}`. A failed OAuth refresh surfaces as
// Pi's `ModelsError` text `OAuth refresh failed for <provider>: ...`.

export type FailureKind =
  | "auth_401"
  | "forbidden"
  | "usage_limit"
  | "policy"
  | "invalidated"
  | "refresh_failed"
  | "none";

export interface FailureInput {
  status?: number;
  message?: string;
  refreshFailed?: boolean;
  /** Response headers, when a caller has them (Pi's stream error does not carry them). */
  headers?: Headers | Record<string, string>;
  /** The provider and model the request named; only the Codex and Cursor plan-policy texts depend on them. */
  provider?: string;
  modelId?: string;
  /** Defaults to `Date.now()`; the base for a relative reset hint. */
  now?: number;
}

export interface FailureClass {
  kind: FailureKind;
  /** Absolute reset time the provider stated, when it stated one. */
  resetAtMs?: number;
  /** The HTTP status the classifier used (structured, or read from the message). */
  status?: number;
}

// ---------------------------------------------------------------------------
// rate-limit.ts
// ---------------------------------------------------------------------------

type RateLimitReason =
  | "QUOTA_EXHAUSTED"
  | "INSUFFICIENT_G1_CREDITS_BALANCE"
  | "RATE_LIMIT_EXCEEDED"
  | "CONCURRENT_LIMIT"
  | "MODEL_CAPACITY_EXHAUSTED"
  | "SERVER_ERROR"
  | "UNKNOWN";

const ACCOUNT_RATE_LIMIT_PATTERN =
  /\baccount(?:'s)?\b[^\n]{0,80}\brate.?limit\b|\brate.?limit\b[^\n]{0,80}\baccount\b/i;
const INSUFFICIENT_BALANCE_PATTERN = /insufficient.?balance/i;
const CREDITS_EXHAUSTED_PATTERN =
  /\b(?:exceed\w*|insufficient|not enough)\b[^\n]{0,40}\bcredits?\b|\bcredits?\b[^\n]{0,40}\b(?:exhausted|depleted)\b/i;
const SPEND_LIMIT_PATTERN = /spend.?limit/i;
const SUBSCRIPTION_CAP_PATTERN =
  /\b(?:subscription|plan|membership)\b[^\n]{0,80}\b(?:rate.?limits?|quota|cap)\b|\b(?:rate.?limits?|quota|cap)\b[^\n]{0,80}\b(?:subscription|plan|membership)\b/i;
const TRANSIENT_INTERVAL_RATE_LIMIT_PATTERN = /\bper\s+(?:second|minute)\b/i;

function matchesSubscriptionCapText(errorMessage: string): boolean {
  return SUBSCRIPTION_CAP_PATTERN.test(errorMessage) && !TRANSIENT_INTERVAL_RATE_LIMIT_PATTERN.test(errorMessage);
}
const OPENROUTER_DAILY_FREE_LIMIT_PATTERN = /\bfree[-_ ]models[-_ ]per[-_ ]day\b/i;
const CLINE_PASS_QUOTA_PATTERN = /clinepass limit|free limit reached on model/i;
const RESOURCE_EXHAUSTED_PATTERN = /resource.?exhausted/gi;
const CONCURRENT_LIMIT_PATTERN =
  /\btoo many\s+concurren\w*\s+(?:requests?|invocations?)\b|\bconcurren\w*\b[^\n]{0,60}\b(?:limit|quota|exceed\w*|reach\w*)\b|\b(?:limit|quota|exceed\w*|reach\w*)\b[^\n]{0,60}\bconcurren\w*\b|\bconcurren[a-z]*[-_](?:[a-z]+[_-])*(?:limit|quota|exceed\w*|reach\w*)/i;
const ACCOUNT_SCOPED_403_PATTERN =
  /\b(?:overall|account|organization|team|workspace)\b[^\n]{0,40}\b(?:message |request )?rate.?limit\b|\byour\b[^\n]{0,30}\b(?:limit )?will reset\b/i;
const CN_QUOTA_EXHAUSTED_PATTERN = /使用.{0,30}?上限|(?:额度|配额)已?(?:用|耗)(?:完|尽)|限额.{0,30}重置|余额不足/;
const CN_TRANSIENT_CAP_PATTERN =
  /速率.{0,30}上限|频率.{0,30}上限|每分钟.{0,30}上限|并发.{0,30}上限|使用.{0,30}(?:速率|频率|每分钟|并发).{0,30}上限/;
const CN_THROTTLE_PATTERN = /速率(?:限制|过快)|频率(?:过高|过快)|过于频繁|稍后[重再]试/;
const DASHSCOPE_TOKEN_LIMIT_DOC_PATTERN = /error-code[^()\s]*#token-limit/i;
const DASHSCOPE_TOKEN_LIMIT_MESSAGE_PATTERN =
  /\byou exceeded your current quota, please check your plan and billing details\b/i;

function isDashScopeTokenLimitText(errorMessage: string): boolean {
  return (
    DASHSCOPE_TOKEN_LIMIT_DOC_PATTERN.test(errorMessage) && DASHSCOPE_TOKEN_LIMIT_MESSAGE_PATTERN.test(errorMessage)
  );
}

const GOOGLE_RPC_ERROR_INFO_TYPE = "type.googleapis.com/google.rpc.ErrorInfo";
const ANTIGRAVITY_MODEL_QUOTA_PATTERN = /\bexhausted your capacity on this model\b/i;
const LONG_RATE_LIMIT_DELAY_MS = 5 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJsonBody(errorMessage: string): Record<string, unknown> | undefined {
  const start = errorMessage.indexOf("{");
  const end = errorMessage.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  try {
    return asRecord(JSON.parse(errorMessage.slice(start, end + 1)));
  } catch {
    return undefined;
  }
}

function parseGoogleRpcRateLimitReason(errorMessage: string): RateLimitReason | undefined {
  const body = parseJsonBody(errorMessage);
  const error = asRecord(body?.error);
  if (typeof error?.status !== "string" || error.status.trim().toUpperCase() !== "RESOURCE_EXHAUSTED") {
    return undefined;
  }
  if (!Array.isArray(error.details)) return undefined;
  for (const value of error.details) {
    const detail = asRecord(value);
    if (detail?.["@type"] !== GOOGLE_RPC_ERROR_INFO_TYPE || typeof detail.reason !== "string") continue;
    const reason = detail.reason.trim().toUpperCase();
    switch (reason) {
      case "QUOTA_EXHAUSTED":
        return "QUOTA_EXHAUSTED";
      case "INSUFFICIENT_G1_CREDITS_BALANCE":
        return "INSUFFICIENT_G1_CREDITS_BALANCE";
      case "RATE_LIMIT_EXCEEDED": {
        if (typeof error.message === "string" && ANTIGRAVITY_MODEL_QUOTA_PATTERN.test(error.message)) {
          return "QUOTA_EXHAUSTED";
        }
        const retryDelayMs = extractRetryHint(undefined, errorMessage);
        return retryDelayMs !== undefined && retryDelayMs >= LONG_RATE_LIMIT_DELAY_MS
          ? "QUOTA_EXHAUSTED"
          : "RATE_LIMIT_EXCEEDED";
      }
    }
  }
  return undefined;
}

function isQuotaExhaustedReason(reason: RateLimitReason): boolean {
  return reason === "QUOTA_EXHAUSTED" || reason === "INSUFFICIENT_G1_CREDITS_BALANCE";
}

function parseRateLimitReason(errorMessage: string): RateLimitReason {
  const structuredReason = parseGoogleRpcRateLimitReason(errorMessage);
  if (structuredReason !== undefined) return structuredReason;
  const lowerWithStatus = errorMessage.toLowerCase();
  const lower = lowerWithStatus.replace(RESOURCE_EXHAUSTED_PATTERN, "");
  const hasResourceExhaustedStatus = lower !== lowerWithStatus;

  if (lower.includes("quota will reset") || lower.includes("exhausted your capacity")) return "QUOTA_EXHAUSTED";
  if (CN_QUOTA_EXHAUSTED_PATTERN.test(errorMessage) && !CN_TRANSIENT_CAP_PATTERN.test(errorMessage)) {
    return "QUOTA_EXHAUSTED";
  }
  if (isDashScopeTokenLimitText(errorMessage)) return "RATE_LIMIT_EXCEEDED";
  if (CONCURRENT_LIMIT_PATTERN.test(errorMessage)) return "CONCURRENT_LIMIT";
  if (lower.includes("capacity") || lower.includes("overloaded") || lower.includes("529") || lower.includes("503")) {
    return "MODEL_CAPACITY_EXHAUSTED";
  }
  if (ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage)) return "QUOTA_EXHAUSTED";
  if (SPEND_LIMIT_PATTERN.test(errorMessage)) return "QUOTA_EXHAUSTED";
  if (matchesSubscriptionCapText(errorMessage)) return "QUOTA_EXHAUSTED";
  if (OPENROUTER_DAILY_FREE_LIMIT_PATTERN.test(errorMessage)) return "QUOTA_EXHAUSTED";
  if (CLINE_PASS_QUOTA_PATTERN.test(errorMessage)) return "QUOTA_EXHAUSTED";
  if (
    lower.includes("per minute") ||
    lower.includes("rate limit") ||
    lower.includes("too many requests") ||
    lower.includes("presque")
  ) {
    return "RATE_LIMIT_EXCEEDED";
  }
  if (
    lower.includes("exhausted") ||
    lower.includes("quota") ||
    lower.includes("usage limit") ||
    lower.includes("run out of credits") ||
    lower.includes("out of credits") ||
    lower.includes("spending-limit") ||
    lower.includes("spending limit") ||
    INSUFFICIENT_BALANCE_PATTERN.test(errorMessage) ||
    CREDITS_EXHAUSTED_PATTERN.test(errorMessage)
  ) {
    return "QUOTA_EXHAUSTED";
  }
  if (lower.includes("500") || lower.includes("internal error") || lower.includes("internal server error")) {
    return "SERVER_ERROR";
  }
  if (hasResourceExhaustedStatus) return "MODEL_CAPACITY_EXHAUSTED";
  return "UNKNOWN";
}

const USAGE_LIMIT_PATTERN =
  /usage.?limit|usage_limit_reached|usage_not_included|limit_reached|quota.?(?:exceeded|reached|insufficient)|额度不足|额度耗尽|resource.?exhausted|exhausted your capacity|quota will reset|insufficient.?(?:balance|quota)|balance.?exhausted|run out of credits|out of credits|spending[- _]?limit|personal-team-blocked|clinepass limit|free limit reached on model/i;

function isUsageLimitStatus(status: number | undefined): boolean {
  return status === 429 || status === 402;
}

const STATUS_402_QUOTA_PATTERN =
  /\b(?:payment(?:\s+is)?[-_.\s]*required|deactivated_workspace|insufficient.?balance)\b/i;

function is402BillingCapBody(message: string | undefined): boolean {
  if (message === undefined || isOpaqueStatusBody(message)) return true;
  if (STATUS_402_QUOTA_PATTERN.test(message)) return true;
  const reason = parseRateLimitReason(message);
  return isQuotaExhaustedReason(reason) || reason === "CONCURRENT_LIMIT";
}

/** Burn this credential and rotate to a sibling. */
function isUsageLimitOutcome(status: number | undefined, message: string | undefined): boolean {
  const structuredReason = message ? parseGoogleRpcRateLimitReason(message) : undefined;
  if (structuredReason !== undefined) return isQuotaExhaustedReason(structuredReason);
  if (isConcurrencyCapExclusion(status, message)) return false;
  if (message && matchesUsageLimitText(message)) return true;
  if ((status === 403 || status === undefined) && message && isAccountScopedCapText(message)) return true;
  if (status === 402 && is402BillingCapBody(message)) return true;
  if (!isUsageLimitStatus(status)) return false;
  if (!message || isOpaqueStatusBody(message)) return true;
  return isQuotaExhaustedReason(parseRateLimitReason(message));
}

/** The body says nothing beyond its status. */
function isOpaqueStatusBody(message: string): boolean {
  const cleaned = message
    .replace(/\b(?:429|402)\b/g, "")
    .replace(/\b(?:http|https|status|error|code|response|message)\b/gi, "")
    .replace(/\(?\bno body\b\)?/gi, "");
  return (
    !/[a-z\d]{3,}/i.test(cleaned) &&
    !CN_QUOTA_EXHAUSTED_PATTERN.test(cleaned) &&
    !CN_TRANSIENT_CAP_PATTERN.test(cleaned) &&
    !CN_THROTTLE_PATTERN.test(cleaned)
  );
}

function matchesUsageLimitText(errorMessage: string): boolean {
  const structuredReason = parseGoogleRpcRateLimitReason(errorMessage);
  if (structuredReason !== undefined) return isQuotaExhaustedReason(structuredReason);
  if (isDashScopeTokenLimitText(errorMessage)) return false;
  return (
    USAGE_LIMIT_PATTERN.test(errorMessage) ||
    CREDITS_EXHAUSTED_PATTERN.test(errorMessage) ||
    (CN_QUOTA_EXHAUSTED_PATTERN.test(errorMessage) && !CN_TRANSIENT_CAP_PATTERN.test(errorMessage)) ||
    SPEND_LIMIT_PATTERN.test(errorMessage) ||
    ACCOUNT_RATE_LIMIT_PATTERN.test(errorMessage) ||
    matchesSubscriptionCapText(errorMessage) ||
    OPENROUTER_DAILY_FREE_LIMIT_PATTERN.test(errorMessage)
  );
}

function isAccountScopedCapText(message: string): boolean {
  return ACCOUNT_SCOPED_403_PATTERN.test(message);
}

/** A concurrency cap sheds and backs off; only a 402 rotates. */
function isConcurrencyCapExclusion(status: number | undefined, message: string | undefined): boolean {
  return message !== undefined && parseRateLimitReason(message) === "CONCURRENT_LIMIT" && status !== 402;
}

/** Whether the text reports a usage limit. */
function usageLimitFlag(message: string, status: number | undefined): boolean {
  const reason = parseRateLimitReason(message);
  if (reason === "CONCURRENT_LIMIT" && status !== 402) return false;
  return (
    (status === 402 && is402BillingCapBody(message)) ||
    matchesUsageLimitText(message) ||
    ((status === 403 || status === undefined) && isAccountScopedCapText(message)) ||
    (isUsageLimitStatus(status) && (isOpaqueStatusBody(message) || reason === "QUOTA_EXHAUSTED"))
  );
}

// ---------------------------------------------------------------------------
// flags.ts / auth-classify.ts
// ---------------------------------------------------------------------------

const ACCOUNT_POLICY_PATTERN = /\bcyber_policy\b|trusted access for cyber/i;
const CODEX_CHATGPT_ACCOUNT_MODEL_POLICY_PATTERN =
  /\bThe ['"]([^'"\r\n]+)['"] model is not supported when using Codex with a ChatGPT account\./i;
const CODEX_CHATGPT_ACCOUNT_MODEL_MAX_LENGTH = 256;
const CURSOR_PLAN_POLICY_MARKER_PATTERN = /\bERROR_RATE_LIMITED_CHANGEABLE\b/i;
const CURSOR_PLAN_POLICY_PATTERN = /\bNamed models unavailable\b|\bModel unavailable on\b|\bFree plans can only use\b/i;
const CLINE_PASS_SURFACE_GATE_PATTERN = /only available via cline product surfaces/i;
const INVALIDATED_OAUTH_TOKEN_PATTERN = /\binvalidated oauth token\b/i;

function normalizeCodexModel(modelId: string | undefined): string | undefined {
  if (typeof modelId !== "string") return undefined;
  const separator = modelId.lastIndexOf("/");
  const bare = (separator === -1 ? modelId : modelId.slice(separator + 1)).trim().toLowerCase();
  if (!bare || bare.length > CODEX_CHATGPT_ACCOUNT_MODEL_MAX_LENGTH || bare.includes("\0")) return undefined;
  return bare;
}

function isCodexChatGPTAccountPolicyText(text: string, provider?: string, modelId?: string): boolean {
  if (provider !== "openai-codex") return false;
  const denied = normalizeCodexModel(CODEX_CHATGPT_ACCOUNT_MODEL_POLICY_PATTERN.exec(text)?.[1]?.trim());
  const requested = normalizeCodexModel(modelId);
  return denied !== undefined && denied === requested;
}

function isAccountPolicyText(text: string, provider?: string, modelId?: string): boolean {
  return (
    ACCOUNT_POLICY_PATTERN.test(text) ||
    isCodexChatGPTAccountPolicyText(text, provider, modelId) ||
    (provider === "cursor" &&
      CURSOR_PLAN_POLICY_MARKER_PATTERN.test(text) &&
      CURSOR_PLAN_POLICY_PATTERN.test(text))
  );
}

// Definitive OAuth refresh failure (flags.ts `isOAuthExpiry`). Exposed for a
// later ticket that disables a dead grant; rotation only cools the row (plan D4).
const OAUTH_DEFINITIVE_FAILURE_PATTERN =
  /invalid_grant|invalid_token|unauthorized_client|\brevoked\b|refresh[\s_]?token.*expired/i;
const OAUTH_TRANSIENT_FAILURE_PATTERN =
  /timeout|network|fetch failed|ECONN(?:REFUSED|RESET)|ETIMEDOUT|EAI_AGAIN|socket hang up|\b(?:408|425|429|5\d{2})\b|rate.?limit|too many requests|temporar|unavailable|forbidden|permission_denied|cloudflare|captcha/i;
const OAUTH_HTTP_AUTH_PATTERN = /\b401\b/;

export function isDefinitiveOAuthFailure(errorMessage: string): boolean {
  if (OAUTH_DEFINITIVE_FAILURE_PATTERN.test(errorMessage)) return true;
  return OAUTH_HTTP_AUTH_PATTERN.test(errorMessage) && !OAUTH_TRANSIENT_FAILURE_PATTERN.test(errorMessage);
}

/** Pi's `ModelsError` text when `oauth.refresh` throws (`pi-ai/dist/auth/resolve.js`). */
const PI_REFRESH_FAILED_PATTERN = /^OAuth refresh failed for /;

// ---------------------------------------------------------------------------
// fetch-retry.ts
// ---------------------------------------------------------------------------

/**
 * Lykos addition: the Anthropic and OpenAI SDKs Pi uses format an HTTP error
 * as `<status> <body>` (observed: `429 {"type":"error",...}`). Tried first,
 * because a leading status is unambiguous and a JSON body can carry other
 * three-digit numbers.
 */
const LEADING_STATUS_PATTERN = /^\s*(\d{3})\s/;
const STATUS_MESSAGE_PATTERNS = [
  /\berror\s*[:=]\s*(\d{3})\b/i,
  /error\s*\((\d{3})\)/i,
  /status\s*[:=]?\s*(\d{3})/i,
  /\bhttp\s*(\d{3})\b/i,
  /\b(\d{3})\s*(?:status|error)\b/i,
] as const;

export function extractHttpStatus(message: string): number | undefined {
  for (const pattern of [LEADING_STATUS_PATTERN, ...STATUS_MESSAGE_PATTERNS]) {
    const match = pattern.exec(message);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value >= 100 && value <= 599) return value;
  }
  return undefined;
}

const QUOTA_RESET_PATTERN = /reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i;
const PLEASE_RETRY_PATTERN = /Please retry in ([0-9.]+)(ms|s)/i;
const RETRY_DELAY_FIELD_PATTERN = /"retryDelay":\s*"([0-9.]+)(ms|s)"/i;
const TRY_AGAIN_PATTERN = /try again in\s+~?\s*([0-9.]+)\s*(ms|sec|s|minutes?|mins?|m|hours?|hrs?|h)\b/i;
const WILL_RESET_IN_PATTERN = /(?:will\s+)?reset in\s+~?\s*([0-9.]+)\s*(ms|sec|s|minutes?|mins?|m|hours?|hrs?|h)\b/i;
const WILL_RESET_AT_PATTERN =
  /(?:will\s+)?reset at\s+([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)/i;
const CN_RESET_AT_PATTERN = /将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})\s*重置/;
const RETRY_AFTER_MS_BODY_PATTERN = /\bretry-after-ms\s*[:=]\s*([0-9]+)\b/i;

function unitToMs(unit: string): number | undefined {
  switch (unit.toLowerCase()) {
    case "ms":
      return 1;
    case "s":
    case "sec":
      return 1000;
    case "m":
    case "min":
    case "mins":
    case "minute":
    case "minutes":
      return 60_000;
    case "h":
    case "hr":
    case "hrs":
    case "hour":
    case "hours":
      return 60 * 60_000;
    default:
      return undefined;
  }
}

function headerGetter(headers: Headers | Record<string, string>): (name: string) => string | null {
  if (headers instanceof Headers) return (name) => headers.get(name);
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return (name) => lower.get(name) ?? null;
}

/**
 * Milliseconds until the provider says to retry,
 * from headers first, then the body text (the longest body signal wins).
 * `undefined` when nothing is stated; `0` for an explicit "retry now".
 */
export function extractRetryHint(
  headers: Headers | Record<string, string> | undefined,
  body?: string,
  nowMs: number = Date.now(),
): number | undefined {
  if (headers) {
    const get = headerGetter(headers);
    const retryAfterMs = get("retry-after-ms");
    if (retryAfterMs) {
      const ms = Number(retryAfterMs);
      if (Number.isFinite(ms) && ms >= 0) return ms;
    }
    const retryAfter = get("retry-after");
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
      const parsedDate = Date.parse(retryAfter);
      if (!Number.isNaN(parsedDate)) return Math.max(0, parsedDate - nowMs);
    }
    const rateLimitResetMs = get("x-ratelimit-reset-ms");
    if (rateLimitResetMs) {
      const value = Number(rateLimitResetMs);
      if (Number.isFinite(value) && value > 0) {
        const targetMs = value > 1e12 ? value : value > 1e9 ? value * 1000 : undefined;
        if (targetMs === undefined) return value;
        const delta = targetMs - nowMs;
        if (delta > 0) return delta;
      }
    }
    const rateLimitReset = get("x-ratelimit-reset");
    if (rateLimitReset) {
      const resetSeconds = Number.parseInt(rateLimitReset, 10);
      if (!Number.isNaN(resetSeconds)) {
        const delta = resetSeconds * 1000 - nowMs;
        if (delta > 0) return delta;
      }
    }
    const rateLimitResetAfter = get("x-ratelimit-reset-after");
    if (rateLimitResetAfter) {
      const seconds = Number(rateLimitResetAfter);
      if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    }
  }

  if (!body) return undefined;

  let longestMs: number | undefined;
  let retryNow = false;
  const consider = (ms: number | undefined): void => {
    if (ms !== undefined && ms > 0 && (longestMs === undefined || ms > longestMs)) longestMs = ms;
  };
  const considerClamped = (ms: number | undefined): void => {
    if (ms === undefined) return;
    if (ms > 0) consider(ms);
    else retryNow = true;
  };

  const quotaMatch = QUOTA_RESET_PATTERN.exec(body);
  if (quotaMatch) {
    const hours = quotaMatch[1] ? Number.parseInt(quotaMatch[1], 10) : 0;
    const minutes = quotaMatch[2] ? Number.parseInt(quotaMatch[2], 10) : 0;
    const seconds = Number.parseFloat(quotaMatch[3]!);
    if (!Number.isNaN(seconds)) {
      const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
      consider(totalMs > 0 ? totalMs : undefined);
    }
  }
  for (const pattern of [WILL_RESET_AT_PATTERN, CN_RESET_AT_PATTERN]) {
    const match = pattern.exec(body);
    if (match?.[1]) {
      // Provider timestamps without an explicit offset are interpreted as UTC.
      const normalized = match[1].replace(" ", "T");
      const hasOffset = /(?:Z|[+-][0-9]{2}:?[0-9]{2})$/i.test(normalized);
      const parsed = Date.parse(hasOffset ? normalized : `${normalized}Z`);
      if (!Number.isNaN(parsed) && parsed > nowMs) consider(parsed - nowMs);
    }
  }
  const accountResetMatch = WILL_RESET_IN_PATTERN.exec(body);
  if (accountResetMatch?.[1]) {
    const value = Number.parseFloat(accountResetMatch[1]);
    if (Number.isFinite(value) && value > 0) {
      const unitMs = unitToMs(accountResetMatch[2]!);
      if (unitMs !== undefined) consider(value * unitMs);
    }
  }
  const retryAfterMsMatch = RETRY_AFTER_MS_BODY_PATTERN.exec(body);
  if (retryAfterMsMatch?.[1]) {
    const ms = Number(retryAfterMsMatch[1]);
    if (Number.isFinite(ms)) considerClamped(ms);
  }
  for (const pattern of [PLEASE_RETRY_PATTERN, RETRY_DELAY_FIELD_PATTERN, TRY_AGAIN_PATTERN]) {
    const match = pattern.exec(body);
    if (match?.[1]) {
      const value = Number.parseFloat(match[1]);
      if (Number.isFinite(value) && value > 0) {
        const unitMs = unitToMs(match[2]!);
        if (unitMs !== undefined) consider(value * unitMs);
      }
    }
  }
  const retryAfterMatch = /retry-after\s*[:=]\s*([^\s,;]+)/i.exec(body);
  if (retryAfterMatch) {
    const value = retryAfterMatch[1]!;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
      considerClamped(seconds * 1000);
    } else {
      const dateMs = Date.parse(value);
      if (!Number.isNaN(dateMs)) considerClamped(dateMs - nowMs);
    }
  }
  const resetMsMatch = /x-ratelimit-reset-ms\s*[:=]\s*(\d+)/i.exec(body);
  if (resetMsMatch) {
    const resetMs = Number(resetMsMatch[1]);
    if (!Number.isNaN(resetMs)) considerClamped(resetMs > 1_000_000_000_000 ? resetMs - nowMs : resetMs);
  }
  const resetMatch = /x-ratelimit-reset\s*[:=]\s*(\d+)/i.exec(body);
  if (resetMatch) {
    const resetSeconds = Number(resetMatch[1]);
    if (!Number.isNaN(resetSeconds)) {
      considerClamped(resetSeconds > 1_000_000_000 ? resetSeconds * 1000 - nowMs : resetSeconds * 1000);
    }
  }
  return longestMs ?? (retryNow ? 0 : undefined);
}

// ---------------------------------------------------------------------------
// The rotation decision
// ---------------------------------------------------------------------------

/**
 * Classify a failure that arrived before any output, in this order: a failed
 * refresh, an account policy denial, a usage limit (with its stated reset),
 * an invalidated token, then the exclusions that stay with Pi's own backoff
 * (a concurrency cap, the Cline surface gate), then a hard 401 or 403.
 * Everything else, including a plain 429 such as `Too many requests`, is
 * `none`: not a credential problem.
 */
export function classifyFailure(input: FailureInput): FailureClass {
  const message = input.message ?? "";
  const now = input.now ?? Date.now();
  const status = input.status ?? (message ? extractHttpStatus(message) : undefined);
  const withStatus = (c: FailureClass): FailureClass => (status !== undefined ? { ...c, status } : c);

  if (input.refreshFailed === true || PI_REFRESH_FAILED_PATTERN.test(message)) {
    return withStatus({ kind: "refresh_failed" });
  }
  if (message && isAccountPolicyText(message, input.provider, input.modelId)) {
    return withStatus({ kind: "policy" });
  }
  if ((message && usageLimitFlag(message, status)) || isUsageLimitOutcome(status, message || undefined)) {
    const hint = extractRetryHint(input.headers, message || undefined, now);
    return withStatus(hint !== undefined && hint > 0 ? { kind: "usage_limit", resetAtMs: now + hint } : { kind: "usage_limit" });
  }
  if (message && INVALIDATED_OAUTH_TOKEN_PATTERN.test(message)) return withStatus({ kind: "invalidated" });
  if (isConcurrencyCapExclusion(status, message || undefined)) return withStatus({ kind: "none" });
  if (message && CLINE_PASS_SURFACE_GATE_PATTERN.test(message)) return withStatus({ kind: "none" });
  if (status === 401) return withStatus({ kind: "auth_401" });
  if (status === 403) return withStatus({ kind: "forbidden" });
  return withStatus({ kind: "none" });
}
