import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProvidersConfig } from "../config/types.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHostModel } from "./session.js";
import { catalogRuntime, effortsOf, endpointModelIds, providerModels, reloadProviders } from "./provider-models.js";

/** A runtime that knows `known`'s providers and models, with `key` stored for each. */
function runtime(known: Record<string, { id: string; name: string; reasoning?: boolean; contextWindow?: number }[]>, key = "sk-test"): ModelRuntime {
  const fake = {
    getModels: (provider: string) => known[provider] ?? [],
    getProvider: (provider: string) => (provider in known ? { id: provider } : undefined),
    getAuth: async () => ({ auth: { apiKey: key, headers: { "x-extra": "1", skipped: undefined } } }),
  };
  // Only the three methods `providerModels` calls; the rest of the runtime is never reached.
  return fake as unknown as ModelRuntime;
}

const omniroute: ProvidersConfig = { omniroute: { auth: "api_key", api: "openai-completions", baseUrl: "http://localhost:20128/v1/", models: [] } } as ProvidersConfig;

test("a declared provider's endpoint lists its models after the declared ones, with the key in the header its API takes", async () => {
  const asked: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init: { headers: Record<string, string> }) => {
    asked.push({ url, headers: init.headers });
    return new Response(JSON.stringify({ data: [{ id: "auto/best-coding" }, { id: "known" }, { id: "x", display_name: "X model" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const models = await providerModels(runtime({ omniroute: [{ id: "known", name: "Known", reasoning: true, contextWindow: 128000 }] }), omniroute, "omniroute", fetchImpl);
  assert.deepEqual(asked, [{ url: "http://localhost:20128/v1/models", headers: { "x-extra": "1", authorization: "Bearer sk-test" } }]);
  assert.deepEqual(
    models.map((m) => [m.id, m.name, m.listed, m.contextWindow]),
    [
      ["known", "Known", true, 128000],
      ["auto/best-coding", "auto/best-coding", false, null],
      ["x", "X model", false, null],
    ],
  );
  // A listed model nobody declared yet offers the default efforts it would have once it is added.
  assert.deepEqual(models[1]!.efforts, ["auto", "none", "low", "medium", "high", "xhigh", "max"]);
});

test("an endpoint that cannot be asked falls back to the declared models; with none, it says why", async () => {
  const down = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
  const kept = await providerModels(runtime({ omniroute: [{ id: "known", name: "Known" }] }), omniroute, "omniroute", down);
  assert.deepEqual(kept.map((m) => m.id), ["known"]);
  await assert.rejects(providerModels(runtime({ omniroute: [] }), omniroute, "omniroute", down), /omniroute's model list: .*answered 503/);
});

test("a provider with a stored key and no declaration has no endpoint; a built-in one lists the runtime's models", async () => {
  await assert.rejects(providerModels(runtime({}), {}, "omniroute"), /omniroute has no endpoint: add it as a custom provider with its base URL/);
  const builtin = await providerModels(runtime({ deepseek: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: true }] }), {}, "deepseek");
  assert.deepEqual(builtin.map((m) => [m.id, m.listed]), [["deepseek-v4-flash", true]]);
});

test("model ids come from OpenAI's, Anthropic's and Google's list shapes; efforts follow Pi's thinking levels", () => {
  assert.deepEqual(endpointModelIds({ models: [{ name: "models/gemini-3-pro", displayName: "Gemini 3 Pro" }] }), [{ id: "gemini-3-pro", name: "Gemini 3 Pro" }]);
  assert.deepEqual(endpointModelIds({ data: [{ id: "" }, { nope: 1 }, "x"] }), []);
  assert.deepEqual(endpointModelIds(null), []);
  assert.deepEqual(effortsOf({ reasoning: false }), ["off"]);
  assert.deepEqual(effortsOf({ reasoning: true }), ["off", "minimal", "low", "medium", "high"]);
  assert.deepEqual(effortsOf({ reasoning: true, thinkingLevelMap: { minimal: null, medium: null, xhigh: "max" } }), ["off", "low", "high", "xhigh"]);
});

test("a provider added to the config after a session started is one it can switch to once the config is read again", async () => {
  const root = mkdtempSync(join(tmpdir(), "lykos-reload-"));
  const cwd = join(root, "work");
  const globalDir = join(root, "global");
  mkdirSync(cwd);
  mkdirSync(globalDir);
  const before = process.env.LYKOS_CREDENTIALS_DB;
  process.env.LYKOS_CREDENTIALS_DB = join(root, "credentials.db");
  try {
    const rt = await catalogRuntime(cwd, {});
    await assert.rejects(resolveHostModel("omniroute/auto", rt), /unknown provider "omniroute"/);
    writeFileSync(
      join(globalDir, "config.yaml"),
      ["providers:", "  omniroute:", "    auth: api_key", "    api: openai-completions", '    baseUrl: "http://localhost:20128/v1"', "    models:", '      - id: "auto"', ""].join("\n"),
    );
    await reloadProviders(rt, cwd, globalDir);
    const model = await resolveHostModel("omniroute/auto", rt);
    assert.equal(`${model.provider}/${model.id}`, "omniroute/auto");
    assert.ok(rt.getProvider("anthropic"), "the built-ins are still there");
  } finally {
    if (before === undefined) delete process.env.LYKOS_CREDENTIALS_DB;
    else process.env.LYKOS_CREDENTIALS_DB = before;
  }
});
