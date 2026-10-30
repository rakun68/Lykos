// Written from the wire format; not recorded against a live account.
//
// Relative reset times are built from `now`. Nothing here was captured from
// Anthropic.

/** "does not invent reset timestamps when Claude omits them". */
export function claudeNoResetBody(): Record<string, unknown> {
  return {
    five_hour: { utilization: 42 },
  };
}

/** "sends aligned anthropic fingerprint and bearer auth headers". */
export function claudeHeadersBody(now: number): Record<string, unknown> {
  return {
    five_hour: {
      utilization: 42,
      resets_at: new Date(now + 10 * 60 * 1000).toISOString(),
    },
  };
}

/** "surfaces the Fable weekly scoped limit from the limits array as a tiered UsageLimit". */
export function claudeFableScopedBody(now: number): Record<string, unknown> {
  const fiveHourReset = new Date(now + 5 * 60 * 60 * 1000).toISOString();
  const sevenDayReset = new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString();
  const fableReset = new Date(now + 4 * 24 * 60 * 60 * 1000).toISOString();
  return {
    five_hour: { utilization: 16, resets_at: fiveHourReset },
    seven_day: { utilization: 18, resets_at: sevenDayReset },
    seven_day_opus: null,
    seven_day_sonnet: null,
    limits: [
      {
        kind: "session",
        group: "session",
        percent: 16,
        severity: "normal",
        resets_at: fiveHourReset,
        scope: null,
        is_active: true,
      },
      {
        kind: "weekly_all",
        group: "weekly",
        percent: 18,
        severity: "normal",
        resets_at: sevenDayReset,
        scope: null,
        is_active: true,
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 28,
        severity: "normal",
        resets_at: fableReset,
        scope: { model: { display_name: "Fable", id: null }, surface: null },
        is_active: true,
      },
    ],
  };
}

/** "surfaces inactive scoped limits and skips unnamed ones". */
export function claudeInactiveScopedBody(now: number): Record<string, unknown> {
  const futureReset = new Date(now + 4 * 24 * 60 * 60 * 1000).toISOString();
  return {
    five_hour: { utilization: 16, resets_at: new Date(now + 5 * 60 * 60 * 1000).toISOString() },
    limits: [
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 5,
        severity: "normal",
        resets_at: futureReset,
        scope: { model: { display_name: "Fable", id: null }, surface: null },
        is_active: false,
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 40,
        resets_at: futureReset,
        scope: { model: null, surface: null },
        is_active: true,
      },
    ],
  };
}

/** "falls back to session and weekly_all entries when legacy buckets are absent". */
export function claudeLimitsOnlyBody(now: number): Record<string, unknown> {
  const fiveHourReset = new Date(now + 5 * 60 * 60 * 1000).toISOString();
  const sevenDayReset = new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString();
  return {
    limits: [
      {
        kind: "session",
        group: "session",
        percent: 16,
        severity: "normal",
        resets_at: fiveHourReset,
        scope: null,
        is_active: true,
      },
      {
        kind: "weekly_all",
        group: "weekly",
        percent: 18,
        severity: "normal",
        resets_at: sevenDayReset,
        scope: null,
        is_active: true,
      },
    ],
  };
}
