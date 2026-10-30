// Secrets in an append-only ledger are permanent. Redact before write
// (docs/03-telemetry.md §1.3, T3.3). This is a pattern list, not a
// guarantee — unknown key formats will slip through until someone adds them.

const PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9\-_]+/g,
  /sk-[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /ghp_[A-Za-z0-9]{36}/g,
  /gho_[A-Za-z0-9]{36}/g,
  /ghu_[A-Za-z0-9]{36}/g,
  /ghs_[A-Za-z0-9]{36}/g,
  /ghr_[A-Za-z0-9]{36}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /\b(?:api[_-]?key|secret|password|passwd|token|authorization)\b["']?\s*[:=]\s*["']?[^\s"',;]+/gi,
];

const REPLACEMENT = "[REDACTED]";

export function redactSecrets(value: string): string {
  let out = value;
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, REPLACEMENT);
  }
  return out;
}

export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v);
    return out;
  }
  return value;
}
