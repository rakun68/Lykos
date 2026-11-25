import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effortLabel, effortLevel, thinkingLevelMapOf, withoutAutoEffort } from "./model-efforts.js";
import { generateProviderConfig } from "./providers.js";
import type { ProvidersConfig } from "./types.js";
import { effortsOf } from "../session/provider-models.js";

const ALL = thinkingLevelMapOf(["auto", "none", "low", "medium", "high", "xhigh", "max"]);

test("a model's efforts become Pi's ladder: auto is off, none is minimal, a level left out is not offered", () => {
  assert.deepEqual(ALL, { off: "auto", minimal: "none", xhigh: "xhigh", max: "max" });
  assert.deepEqual(effortsOf({ reasoning: true, thinkingLevelMap: ALL }), ["auto", "none", "low", "medium", "high", "xhigh", "max"]);
  const some = thinkingLevelMapOf(["none", "high"]);
  assert.deepEqual(effortsOf({ reasoning: true, thinkingLevelMap: some }), ["none", "high"]);
});

test("the names a person sees and Pi's levels translate both ways, and only on a model whose efforts are Lykos's", () => {
  const model = { thinkingLevelMap: ALL };
  assert.deepEqual(["off", "minimal", "high"].map((l) => effortLabel(model, l)), ["auto", "none", "high"]);
  assert.deepEqual(["auto", "none", "high"].map((l) => effortLevel(model, l)), ["off", "minimal", "high"]);
  assert.equal(effortLabel({ thinkingLevelMap: { off: "none" } }, "off"), "off");
  assert.equal(effortLabel(undefined, "minimal"), "minimal");
  assert.equal(effortLevel(undefined, "auto"), "auto");
});

test("on auto the request carries no effort, in each shape Pi sends one; any other level is left alone", () => {
  const model = { thinkingLevelMap: ALL };
  const responses = { model: "m", reasoning: { effort: "auto", summary: "auto" }, include: ["reasoning.encrypted_content"] };
  assert.deepEqual(withoutAutoEffort(responses, model, "off"), { model: "m" });
  assert.deepEqual(withoutAutoEffort({ model: "m", reasoning_effort: "auto" }, model, "off"), { model: "m" });
  assert.deepEqual(withoutAutoEffort({ model: "m", thinking: { type: "disabled" } }, model, "off"), { model: "m" });
  assert.equal(withoutAutoEffort({ model: "m", reasoning: { effort: "none" } }, model, "minimal"), undefined);
  assert.equal(withoutAutoEffort(responses, { thinkingLevelMap: { off: "none" } }, "off"), undefined, "a model whose off means off");
  assert.equal(withoutAutoEffort({ model: "m" }, model, "off"), undefined, "nothing to take out");
});

test("a declared model with no reasoning or efforts offers every effort; efforts narrow it; a built-in keeps its table", () => {
  const dir = mkdtempSync(join(tmpdir(), "lykos-efforts-"));
  const targetPath = join(dir, "models.json");
  const providers = {
    gw: {
      auth: "api_key",
      api: "openai-responses",
      baseUrl: "http://localhost:1/v1",
      models: [{ id: "plain" }, { id: "narrow", efforts: ["auto", "high"] }, { id: "flat", reasoning: false }, { id: "none", efforts: [] }],
    },
  } as ProvidersConfig;
  const builtins = { table: { auth: "api_key", api: "openai-completions", baseUrl: "http://localhost:2/v1", models: [{ id: "t" }] } } as ProvidersConfig;
  const result = generateProviderConfig({ providers, builtins, targetPath });
  assert.deepEqual(result.errors, []);
  const written = JSON.parse(readFileSync(targetPath, "utf8")) as { providers: Record<string, { models: Record<string, unknown>[] }> };
  assert.deepEqual(written.providers.gw!.models, [
    { id: "plain", reasoning: true, thinkingLevelMap: ALL },
    { id: "narrow", reasoning: true, thinkingLevelMap: { off: "auto", minimal: null, low: null, medium: null } },
    { id: "flat", reasoning: false },
    { id: "none", reasoning: false },
  ]);
  assert.deepEqual(written.providers.table!.models, [{ id: "t" }]);
});

test("an effort Lykos does not know is a config error that names the model", () => {
  const providers = { gw: { auth: "api_key", api: "openai-responses", baseUrl: "http://localhost:1/v1", models: [{ id: "m", efforts: ["high", "ultra"] }] } } as ProvidersConfig;
  const result = generateProviderConfig({ providers, targetPath: join(mkdtempSync(join(tmpdir(), "lykos-efforts-")), "models.json") });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!, /provider gw: model m: efforts must be a list of auto, none, low, medium, high, xhigh, max, got \["ultra"\]/);
});
