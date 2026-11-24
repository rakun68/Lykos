import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { addProviderToConfig, runProviderAdd, type ProviderAddQuestion } from "./provider-add.js";
import { validateProviders } from "./providers.js";
import type { ProvidersConfig } from "./types.js";

const local = { id: "local", api: "openai-completions", baseUrl: "http://localhost:11434/v1", models: ["qwen3:8b", "llama4"] };

test("a provider joins the end of the providers block and leaves the rest of the file as it was", () => {
  const raw = "# mine\nproviders:\n  deepseek:\n    auth: api_key   # keep\n\nbudget:\n  per_run_usd: 0.50\n";
  const out = addProviderToConfig(raw, local);
  assert.ok(out.startsWith("# mine\nproviders:\n  deepseek:\n    auth: api_key   # keep\n  local:\n"));
  assert.ok(out.endsWith("\nbudget:\n  per_run_usd: 0.50\n"));
  const providers = (parse(out) as { providers: ProvidersConfig }).providers;
  assert.deepEqual(providers.local, { auth: "api_key", api: "openai-completions", baseUrl: "http://localhost:11434/v1", models: [{ id: "qwen3:8b" }, { id: "llama4" }] });
  assert.deepEqual(validateProviders(providers).errors, []);
});

test("a file with no providers block, or an empty one, gets one; a name already declared is refused", () => {
  assert.equal(addProviderToConfig("", local).split("\n")[0], "providers:");
  assert.ok((parse(addProviderToConfig("budget:\n  per_run_usd: 1\n", local)) as { providers: ProvidersConfig }).providers.local);
  assert.ok((parse(addProviderToConfig("providers: {}\n", local)) as { providers: ProvidersConfig }).providers.local);
  assert.throws(() => addProviderToConfig("providers:\n  local:\n    auth: api_key\n", local), /already declared/);
});

test("runProviderAdd asks each question and writes the chosen file; a bad answer is named and nothing is written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lykos-provider-add-"));
  try {
    const target = { globalPath: join(dir, "g", "config.yaml"), projectPath: join(dir, "p", ".lykos", "config.yaml"), taken: ["openai"] };
    const run = async (answers: string[]) => {
      const asked: ProviderAddQuestion[] = [];
      const said: string[] = [];
      const result = await runProviderAdd({ ask: async (q) => (asked.push(q), answers.shift() ?? null), say: (l) => said.push(l) }, target);
      return { result, asked, said };
    };
    const ok = await run(["local", "openai-completions", "http://localhost:11434/v1", "qwen3:8b, llama4", "project"]);
    assert.deepEqual(ok.asked.map((q) => q.title), ["Provider name", "API", "Base URL", "Models", "Save to"]);
    assert.equal(ok.result?.path, target.projectPath);
    assert.match(readFileSync(target.projectPath, "utf8"), /^providers:\n {2}local:\n/);

    const taken = await run(["openai"]);
    assert.equal(taken.result, null);
    assert.match(taken.said[0]!, /already exists/);
    const badUrl = await run(["x", "openai-completions", "localhost:11434"]);
    assert.match(badUrl.said[0]!, /not an http or https URL/);
    assert.equal(badUrl.result, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
