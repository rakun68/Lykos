// Prices Lykos ever reports come from here, and nowhere else. An unknown
// model or a missing price field throws — a ledger row that silently costs
// $0.00 is worse than a missing row (AGENTS.md rule 4, DECISIONS.md 2026-08-28).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const moduleDir = dirname(fileURLToPath(import.meta.url));

export interface PriceCallTokens {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface PriceCallInput {
  provider: string;
  model: string;
  tokens: PriceCallTokens;
  ts: Date;
  /** Anthropic only: which cache TTL the write used. Ignored by other providers. */
  cacheTtlSeconds?: number;
}

export type RateWindow = "peak" | "off_peak" | null;

export interface PriceCallResult {
  costUsd: number;
  priceVersion: string;
  rateWindow: RateWindow;
  breakdown: {
    freshInputUsd: number;
    cacheReadUsd: number;
    cacheWriteUsd: number;
    outputUsd: number;
  };
  /**
   * The per-mtok rates actually resolved for this call (post peak/off-peak
   * selection for DeepSeek, post TTL-bucket selection for Anthropic). T6.1's
   * cache-avoided formula (docs/03-telemetry.md §4.2) needs exactly these —
   * re-deriving them from scratch would duplicate the rate-window and TTL
   * logic above instead of reusing what this call already resolved.
   */
  rates: {
    inputPerMtok: number;
    cacheReadPerMtok: number;
    cacheWritePerMtok: number;
    outputPerMtok: number;
    /** Whether a cache write costs MORE than plain input for this provider
     *  (`cache_semantics.write_is_premium`). Anthropic: true. DeepSeek: false. */
    writeIsPremium: boolean;
  };
}

export interface PeakWindow {
  days: string[];
  ranges: string[];
}

interface PricesFile {
  version: string;
  source_checked: string;
  providers: Record<string, any>;
}

let cachedPrices: PricesFile | undefined;

/** The version stamp T3.4 writes onto every call row. */
export function currentPriceTable(): { version: string; sourceChecked: string } {
  const prices = loadPrices();
  return { version: prices.version, sourceChecked: prices.source_checked };
}

// The delegate-gauge lookup used to live here as `contextTokens()`. It now
// lives in ./context-tokens.ts instead, and deliberately does not re-export
// from here: this module imports the `yaml` package at the top level for
// priceCall()/currentPriceTable(), and re-exporting would mean importing
// prices.ts at all — even just for that one binding — pays for `yaml`
// regardless of which export a caller actually wanted. Import contextTokens
// from "./context-tokens.js" directly.

function loadPrices(): PricesFile {
  if (!cachedPrices) {
    const raw = readFileSync(join(moduleDir, "prices.yaml"), "utf8");
    cachedPrices = parseYaml(raw) as PricesFile;
  }
  return cachedPrices;
}

const UTC_DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function rangeToMinutes(range: string): [number, number] {
  const parts = range.split("-");
  const start = parts[0];
  const end = parts[1];
  if (!start || !end) {
    throw new Error(`priceCall: malformed peak-window range "${range}" in prices.yaml`);
  }
  const toMinutes = (hm: string): number => {
    const hmParts = hm.split(":");
    const h = Number(hmParts[0]);
    const m = Number(hmParts[1]);
    return h * 60 + m;
  };
  const startMinutes = toMinutes(start);
  const endMinutes = toMinutes(end);
  // "00:00-00:00" (and any start == end) is malformed rather than 24 hours or
  // zero: it is a typo either way, and a silently unsatisfiable window prices
  // every call in it off-peak, which falsifies the ledger (AGENTS.md rule 4).
  if (startMinutes === endMinutes) {
    throw new Error(`priceCall: malformed peak-window range "${range}" in prices.yaml — start equals end`);
  }
  return [startMinutes, endMinutes];
}

/**
 * A window that crosses midnight belongs to the day it STARTS on. A Monday
 * "22:00-02:00" covers Monday 23:00 and Tuesday 01:00, and does not cover
 * Tuesday 23:00 unless Tuesday is also listed. Start > end is the wrap, and
 * start == end throws in `rangeToMinutes` above.
 *
 * Exported for tests, which supply windows the real table deliberately has
 * none of: prices.yaml declares no wrapping window.
 */
export function isPeak(ts: Date, peakWindows: PeakWindow[]): boolean {
  const dayIndex = ts.getUTCDay();
  const day = UTC_DAY_NAMES[dayIndex] as string;
  const previousDay = UTC_DAY_NAMES[(dayIndex + 6) % 7] as string;
  const minutes = ts.getUTCHours() * 60 + ts.getUTCMinutes();
  for (const window of peakWindows) {
    const startsToday = window.days.includes(day);
    const startedYesterday = window.days.includes(previousDay);
    if (!startsToday && !startedYesterday) continue;
    for (const range of window.ranges) {
      const [start, end] = rangeToMinutes(range);
      if (start < end) {
        if (startsToday && minutes >= start && minutes < end) return true;
        continue;
      }
      if (startsToday && minutes >= start) return true;
      if (startedYesterday && minutes < end) return true;
    }
  }
  return false;
}

function requirePrice(value: unknown, provider: string, model: string, field: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`priceCall: missing or null price field "${field}" for ${provider}/${model}`);
  }
  return value;
}

/**
 * Prices a single call against lykos/ledger/prices.yaml.
 * Throws on an unknown provider, unknown model, or a null/missing price
 * field. Never returns 0 for missing data.
 */
export function priceCall(input: PriceCallInput): PriceCallResult {
  const prices = loadPrices();
  const provider = prices.providers[input.provider];
  if (!provider) {
    throw new Error(`priceCall: unknown provider "${input.provider}"`);
  }
  const model = provider.models?.[input.model];
  if (!model) {
    throw new Error(`priceCall: unknown model "${input.model}" for provider "${input.provider}"`);
  }

  const cacheRead = input.tokens.cacheRead ?? 0;
  const cacheWrite = input.tokens.cacheWrite ?? 0;

  let rateWindow: RateWindow = null;
  let inputPerMtok: number;
  let outputPerMtok: number;
  let cacheReadPerMtok: number;
  let cacheWritePerMtok: number;

  if (input.provider === "deepseek") {
    const peak = isPeak(input.ts, provider.peak_windows_utc);
    rateWindow = peak ? "peak" : "off_peak";
    const bucket = peak ? model.peak : model.off_peak;
    if (!bucket) {
      throw new Error(`priceCall: missing ${rateWindow} pricing for deepseek/${input.model}`);
    }
    inputPerMtok = requirePrice(bucket.input_per_mtok, input.provider, input.model, `${rateWindow}.input_per_mtok`);
    outputPerMtok = requirePrice(bucket.output_per_mtok, input.provider, input.model, `${rateWindow}.output_per_mtok`);
    cacheReadPerMtok = requirePrice(
      bucket.cache_read_per_mtok,
      input.provider,
      input.model,
      `${rateWindow}.cache_read_per_mtok`,
    );
    cacheWritePerMtok = requirePrice(model.cache_write_per_mtok, input.provider, input.model, "cache_write_per_mtok");
  } else if (input.provider === "anthropic") {
    inputPerMtok = requirePrice(model.input_per_mtok, input.provider, input.model, "input_per_mtok");
    outputPerMtok = requirePrice(model.output_per_mtok, input.provider, input.model, "output_per_mtok");
    cacheReadPerMtok = requirePrice(model.cache_read_per_mtok, input.provider, input.model, "cache_read_per_mtok");
    const ttl = input.cacheTtlSeconds ?? provider.cache_semantics.ttl_default_seconds;
    const writeField = ttl > provider.cache_semantics.ttl_default_seconds
      ? "cache_write_1h_per_mtok"
      : "cache_write_5m_per_mtok";
    cacheWritePerMtok = requirePrice(model[writeField], input.provider, input.model, writeField);
  } else {
    inputPerMtok = requirePrice(model.input_per_mtok, input.provider, input.model, "input_per_mtok");
    outputPerMtok = requirePrice(model.output_per_mtok, input.provider, input.model, "output_per_mtok");
    cacheReadPerMtok = requirePrice(model.cache_read_per_mtok, input.provider, input.model, "cache_read_per_mtok");
    cacheWritePerMtok = requirePrice(model.cache_write_per_mtok, input.provider, input.model, "cache_write_per_mtok");
  }

  const cacheSemantics = provider.cache_semantics?.cache_tokens_inside_input_total;
  if (typeof cacheSemantics !== "boolean") {
    throw new Error(
      `priceCall: cache_tokens_inside_input_total is not resolved (empirically verify per T2.2) for provider "${input.provider}"`,
    );
  }
  const freshInput = cacheSemantics ? input.tokens.input - cacheRead - cacheWrite : input.tokens.input;
  if (freshInput < 0) {
    throw new Error(
      `priceCall: negative fresh input for ${input.provider}/${input.model} — cache tokens exceed input_tokens`,
    );
  }

  const freshInputUsd = (freshInput / 1e6) * inputPerMtok;
  const cacheReadUsd = (cacheRead / 1e6) * cacheReadPerMtok;
  const cacheWriteUsd = (cacheWrite / 1e6) * cacheWritePerMtok;
  const outputUsd = (input.tokens.output / 1e6) * outputPerMtok;

  // T6.1: whether a cache write costs MORE than plain input (CLAUDE.md: "the
  // cache penalty term applies to Anthropic only"). This is a distinct fact
  // from cacheWritePerMtok's BILLING value above: DeepSeek's is 0.0 so the
  // newly-cached tokens (already counted in freshInput) are not double-billed
  // — that says nothing about whether writing has a premium worth penalizing
  // in the avoided-cost model, so it is read from its own explicit flag
  // rather than inferred by comparing rates.
  const writeIsPremium = provider.cache_semantics?.write_is_premium;
  if (typeof writeIsPremium !== "boolean") {
    throw new Error(
      `priceCall: cache_semantics.write_is_premium is not resolved for provider "${input.provider}"`,
    );
  }

  return {
    costUsd: freshInputUsd + cacheReadUsd + cacheWriteUsd + outputUsd,
    priceVersion: prices.version,
    rateWindow,
    breakdown: { freshInputUsd, cacheReadUsd, cacheWriteUsd, outputUsd },
    rates: {
      inputPerMtok,
      cacheReadPerMtok,
      cacheWritePerMtok,
      outputPerMtok,
      writeIsPremium,
    },
  };
}

/**
 * T6.1 (docs/03-telemetry.md §4.2) — exact, both terms observed:
 *
 *   avoided = cacheRead  * (inputPerMtok - cacheReadPerMtok)  / 1e6
 *           - cacheWrite * (cacheWritePerMtok - inputPerMtok) / 1e6
 *
 * The first term is what a cache-read call avoided by not being priced as
 * fresh input. The second is the write premium — CLAUDE.md/§4.2: "the cache
 * penalty term applies to Anthropic only" — so it is zeroed by
 * `rates.writeIsPremium` for providers without one, rather than computed
 * from cacheWritePerMtok directly: DeepSeek's cache_write_per_mtok is 0.0 to
 * avoid double-billing tokens already priced through freshInput, which is a
 * billing convention, not evidence the model has no penalty term. Omitting
 * this term entirely makes caching look better than it is, and a prefix
 * written repeatedly but read rarely correctly comes out negative on a
 * provider that does have the premium.
 */
export function cacheAvoidedUsd(
  cacheReadTokens: number,
  cacheWriteTokens: number,
  rates: PriceCallResult["rates"],
): number {
  const readAvoided = (cacheReadTokens / 1e6) * (rates.inputPerMtok - rates.cacheReadPerMtok);
  const writePremium = rates.writeIsPremium
    ? (cacheWriteTokens / 1e6) * (rates.cacheWritePerMtok - rates.inputPerMtok)
    : 0;
  return readAvoided - writePremium;
}

export const CACHE_AVOIDED_BASIS = "cache_read_vs_fresh_input (T6.1, exact)";

/**
 * T36.2 (docs/13-model-access.md §0 / §5.2): a provider/model is priced
 * only when rates AND cache semantics are verified in prices.yaml. A
 * missing provider, an empty `models:` map (OpenRouter's placeholder),
 * or unresolved `cache_semantics` all return false — the caller then
 * records `unpriced` rather than inventing a dollar figure.
 *
 * Does not throw. `priceCall()` still throws for a caller that asked it
 * to price an unverified pair; this is the gate that stops that ask.
 */
export function isPriced(provider: string, model: string): boolean {
  const prices = loadPrices();
  const p = prices.providers[provider];
  if (!p) return false;
  const m = p.models?.[model];
  if (!m || typeof m !== "object") return false;
  const semantics = p.cache_semantics;
  if (typeof semantics?.cache_tokens_inside_input_total !== "boolean") return false;
  if (typeof semantics?.write_is_premium !== "boolean") return false;
  return true;
}

/**
 * T36.4: doctor reports priced-vs-unpriced per *provider*, before a
 * specific model is chosen. True when the provider has verified cache
 * semantics and at least one named model in prices.yaml.
 */
export function providerHasVerifiedPricing(provider: string): boolean {
  const prices = loadPrices();
  const p = prices.providers[provider];
  if (!p) return false;
  const semantics = p.cache_semantics;
  if (typeof semantics?.cache_tokens_inside_input_total !== "boolean") return false;
  if (typeof semantics?.write_is_premium !== "boolean") return false;
  const models = p.models;
  if (!models || typeof models !== "object") return false;
  return Object.keys(models).length > 0;
}
