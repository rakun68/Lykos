// Written from the wire format; not recorded against a live account.
//
// Tests derive their other cases by editing a copy of `codexUsagePayload` (a
// plan, a `used_percent`, `limit_reached`) and say so.

export function codexUsagePayload() {
  return {
    plan_type: "pro",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 4, limit_window_seconds: 17940, reset_at: 2_000_000_000 },
      secondary_window: { used_percent: 1, limit_window_seconds: 604740, reset_at: 2_000_500_000 },
    },
    additional_rate_limits: [
      {
        limit_name: "GPT-5.3-Codex-Spark",
        metered_feature: "codex_bengalfox",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: { used_percent: 17, limit_window_seconds: 18000, reset_at: 2_000_001_000 },
          secondary_window: { used_percent: 61, limit_window_seconds: 604800, reset_at: 2_000_600_000 },
        },
      },
    ],
  };
}

/** The access token fixture of the same file: a JWT carrying `chatgpt_account_id: "acct-fixture"`. */
export function codexAccessTokenFixture(): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-fixture" },
      "https://api.openai.com/profile": { email: "fixture@example.com" },
    }),
  ).toString("base64url");
  return `${header}.${body}.sig`;
}
