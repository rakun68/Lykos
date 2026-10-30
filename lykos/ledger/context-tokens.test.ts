// Drift guard for the derived cache scripts/generate-context-tokens.mjs
// produces (see prices.ts's contextTokens() for why it exists as a separate
// file rather than being read out of prices.yaml at runtime). If someone
// edits a context_tokens field in prices.yaml and forgets to regenerate,
// this test — not a silently stale HUD gauge months later — is what catches
// it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import { contextTokens } from "./context-tokens.js";

const moduleDir = dirname(fileURLToPath(import.meta.url));

describe("context-tokens.json", () => {
  it("matches every context_tokens field in prices.yaml exactly", () => {
    const prices = parseYaml(readFileSync(join(moduleDir, "prices.yaml"), "utf8")) as {
      providers: Record<string, { models: Record<string, { context_tokens?: number }> }>;
    };
    let checked = 0;
    for (const [providerName, provider] of Object.entries(prices.providers)) {
      for (const [modelName, model] of Object.entries(provider.models)) {
        if (typeof model.context_tokens !== "number") continue;
        checked++;
        assert.equal(
          contextTokens(providerName, modelName),
          model.context_tokens,
          `context-tokens.json is stale for ${providerName}/${modelName} — ` +
            "run: node scripts/generate-context-tokens.mjs",
        );
      }
    }
    assert.ok(checked > 0, "expected at least one context_tokens field in prices.yaml to check against");
  });

  it("returns undefined for a model with no context_tokens entry", () => {
    assert.equal(contextTokens("openrouter", "some/unknown-model"), undefined);
  });
});
