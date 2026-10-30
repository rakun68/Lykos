// Usage report types.
//
// The normalized shape Lykos stores in the `usage` table.
// Selection, rotation and `lykos usage` read only these types; the
// provider-specific response shapes stay inside each provider module.

/** One usage window from a provider's report. */
export interface UsageWindow {
  /** Display id: `5h`, `7d`, or the provider's window id for the limit. */
  id: string;
  /**
   * Which ranking slot the window fills: ranking reads a `primary` (short) and a `secondary` (weekly) window. Unset = display only.
   */
  role?: "primary" | "secondary";
  /**
   * A model-scoped counter (`opus`, `sonnet`, a
   * Claude weekly-scoped family slug, Codex `spark`). Unset = the shared,
   * account-wide window.
   */
  tier?: string;
  /** Used fraction 0–1, clamped. */
  usedFraction: number;
  exhausted: boolean;
  /** Epoch ms when this window resets, only when the provider stated one. */
  resetAtMs?: number;
  /** Window length in ms, when known. */
  durationMs?: number;
}

/** A normalized usage report. */
export interface UsageReport {
  windows: UsageWindow[];
  /** The provider's plan type (Codex `plan_type`), when stated. */
  plan?: string;
  /** When this report was fetched (epoch ms). */
  fetchedAt: number;
}

/** What a provider's `fetchUsage` receives. */
export interface UsageFetchInput {
  /** The row's stored `data` JSON (an OAuth credential). Never logged. */
  credentialData: string;
  /** Injectable fetch; tests point it at a fake server. */
  fetch: typeof globalThis.fetch;
  /** Clock (epoch ms). Defaults to `Date.now()`. */
  now?: number;
  /** The provider's configured base URL, normalized. */
  baseUrl?: string;
  /** Aborts the request (rotation bounds it with a timeout). */
  signal?: AbortSignal;
}

/** A usage provider for one provider id. */
export interface UsageProvider {
  providerId: string;
  /** A report, or undefined on any failure. A failure is never stored. */
  fetchUsage(input: UsageFetchInput): Promise<UsageReport | undefined>;
}
