#!/usr/bin/env node
// Derives lykos/ledger/context-tokens.json from prices.yaml's
// `context_tokens` fields — a flat "provider/model" -> tokens map with no
// other pricing data in it.
//
// Why this exists as a separate, committed, checked-in artifact rather than
// being read straight out of prices.yaml at runtime: `telemetry/prices.ts`'s
// contextTokens() feeds the delegate context gauge on `lykos hud`'s S1
// status-line path, which is budgeted at p95 < 50ms *including node start*
// (docs/07-ui-and-hud.md §8). Measured on the dev machine (DECISIONS.md
// 2026-08-29): importing the `yaml` package alone costs ~120ms — by itself
// already several times the entire budget, before any Lykos code runs.
// contextTokens() therefore reads this small pre-derived JSON file with a
// plain `JSON.parse`, never the `yaml` package, while priceCall() (the
// ledger's write path, not the HUD's read path) keeps parsing the full
// prices.yaml as before — that cost is fine off the hot path.
//
// Run this whenever prices.yaml's context_tokens fields change.
// context-tokens.test.ts fails the build if the two drift apart.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pricesPath = join(repoRoot, "lykos", "telemetry", "prices.yaml");
const outPath = join(repoRoot, "lykos", "telemetry", "context-tokens.json");

const prices = parseYaml(readFileSync(pricesPath, "utf8"));
/** @type {Record<string, number>} */
const out = {};
for (const [providerName, provider] of Object.entries(prices.providers ?? {})) {
  for (const [modelName, model] of Object.entries(provider.models ?? {})) {
    if (typeof model.context_tokens === "number") {
      out[`${providerName}/${modelName}`] = model.context_tokens;
    }
  }
}

writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");
process.stdout.write(`wrote ${Object.keys(out).length} entries -> lykos/ledger/context-tokens.json\n`);
