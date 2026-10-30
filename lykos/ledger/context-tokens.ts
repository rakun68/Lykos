// The delegate context gauge's data source (docs/07-ui-and-hud.md §2.3,
// R-D3), split out from prices.ts on purpose: prices.ts imports the `yaml`
// package at the top level for priceCall()/currentPriceTable(), and
// importing a module pays for everything at its top level whether or not
// the binding you wanted is the one that needed it. contextTokens() feeds
// `lykos hud`'s S1 status-line path, budgeted at p95 < 50ms including node
// start (§8); measured on the dev machine (DECISIONS.md 2026-08-29),
// importing `yaml` alone costs ~120ms — several times the whole budget by
// itself. This module reads the small pre-derived JSON file
// scripts/generate-context-tokens.mjs produces with a plain `JSON.parse`
// instead, and depends on nothing but node:fs/node:path.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));

let cached: Record<string, number> | undefined;

/**
 * The model's context window. Returns undefined — never a guessed number —
 * when the model or its context_tokens field is unknown; the gauge omits
 * the percentage in that case rather than dividing by a made-up denominator.
 * Regenerate context-tokens.json with scripts/generate-context-tokens.mjs
 * whenever prices.yaml's context_tokens fields change —
 * context-tokens.test.ts fails if the two drift apart.
 */
export function contextTokens(provider: string, model: string): number | undefined {
  if (!cached) {
    const raw = readFileSync(join(moduleDir, "context-tokens.json"), "utf8");
    cached = JSON.parse(raw) as Record<string, number>;
  }
  return cached[`${provider}/${model}`];
}
