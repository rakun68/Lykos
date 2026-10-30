import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { globalImageApart, loadConfig } from "./load.js";
import { SHIPPED_DEFAULTS } from "./defaults.js";
import { globalSpecialistsDir, SpecialistNotFoundError, SpecialistValidationError, projectSpecialistsDir } from "./specialists.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "lykos-config-"));
}

/** Specialists ticket 05: writes a real skill under `<cwd>/.lykos/skills/`. */
function writeSkill(cwd: string, filename: string, frontmatter: string): void {
  mkdirSync(join(cwd, ".lykos", "skills"), { recursive: true });
  writeFileSync(join(cwd, ".lykos", "skills", filename), frontmatter, "utf8");
}

describe("loadConfig", () => {
  it("falls back to shipped defaults with no files present", () => {
    const cwd = tmp();
    const globalDir = tmp();
    const { resolved, layers } = loadConfig({ cwd, globalDir, env: {} });
    assert.deepEqual(resolved, SHIPPED_DEFAULTS);
    assert.equal(layers.find((l) => l.name === "global")!.present, false);
    assert.equal(layers.find((l) => l.name === "project")!.present, false);
  });

  it("project config.yaml overrides global, which overrides defaults", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeFileSync(join(globalDir, "config.yaml"), "budget:\n  per_run_usd: 1.00\n  per_day_usd: 5.00\n");
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(join(cwd, ".lykos", "config.yaml"), "budget:\n  per_run_usd: 0.10\n");

    const { resolved } = loadConfig({ cwd, globalDir, env: {} });
    // Project wins on the key it sets...
    assert.equal(resolved.budget.per_run_usd, 0.1);
    // ...but per_day_usd falls through to the global layer, not back to
    // shipped defaults, because the merge is per-key within a section.
    assert.equal(resolved.budget.per_day_usd, 5.0);
    // Untouched sections still come from shipped defaults.
    assert.equal(resolved.models.default, SHIPPED_DEFAULTS.models.default);
  });

  it("shipped default for models.delegate is 'specialist' and project config can override it", () => {
    assert.equal(SHIPPED_DEFAULTS.models.delegate, "specialist");
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(join(cwd, ".lykos", "config.yaml"), ["models:", "  delegate: parent", ""].join("\n"));
    const { resolved } = loadConfig({ cwd, globalDir, env: {} });
    assert.equal(resolved.models.delegate, "parent");
  });

  it("T168: edit.mode is gone — a layer that still sets it fails to load, naming the key, the ADR and the file", () => {
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    const path = join(cwd, ".lykos", "config.yaml");
    writeFileSync(path, "edit:\n  mode: anchored\n");
    assert.throws(
      () => loadConfig({ cwd, globalDir, env: {} }),
      (err: Error) => {
        assert.match(err.message, /^lykos config: edit\.mode was removed \(ADR-0031\)/);
        assert.match(err.message, /there is one editor now/);
        assert.ok(err.message.includes(path), err.message);
        return true;
      },
    );
  });

  it("T168: the same refusal for the global layer and for the other old value", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeFileSync(join(globalDir, "config.yaml"), "edit:\n  mode: replace\n");
    assert.throws(() => loadConfig({ cwd, globalDir, env: {} }), /edit\.mode was removed \(ADR-0031\)/);
  });

  it("T209: mode in config.yaml fails to load, naming /permissions", () => {
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    const path = join(cwd, ".lykos", "config.yaml");
    writeFileSync(path, "mode: auto\n");
    assert.throws(
      () => loadConfig({ cwd, globalDir, env: {} }),
      (err: Error) => {
        assert.match(err.message, /lykos config: mode is not supported in config\.yaml/);
        assert.match(err.message, /\/permissions/);
        assert.ok(err.message.includes(path), err.message);
        return true;
      },
    );
  });

  it("T209: permissions.mode in global config.yaml fails to load, naming /permissions", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeFileSync(join(globalDir, "config.yaml"), "permissions:\n  mode: manual\n");
    assert.throws(
      () => loadConfig({ cwd, globalDir, env: {} }),
      (err: Error) => {
        assert.match(err.message, /lykos config: permissions\.mode is not supported in config\.yaml/);
        assert.match(err.message, /\/permissions/);
        return true;
      },
    );
  });

  it("T168 part B: edit.require_read ships off, a project layer turns it on, and a layer that is silent inherits it", () => {
    const cwd = tmp();
    const globalDir = tmp();
    assert.equal(SHIPPED_DEFAULTS.edit.require_read, false);
    assert.equal(loadConfig({ cwd, globalDir, env: {} }).resolved.edit.require_read, false);

    writeFileSync(join(globalDir, "config.yaml"), "edit:\n  require_read: true\n");
    assert.equal(loadConfig({ cwd, globalDir, env: {} }).resolved.edit.require_read, true);

    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(join(cwd, ".lykos", "config.yaml"), "budget:\n  per_run_usd: 0.10\n");
    assert.equal(loadConfig({ cwd, globalDir, env: {} }).resolved.edit.require_read, true, "a layer that says nothing inherits");

    writeFileSync(join(cwd, ".lykos", "config.yaml"), "edit:\n  require_read: false\n");
    assert.equal(loadConfig({ cwd, globalDir, env: {} }).resolved.edit.require_read, false, "a project can turn it back off");
  });

  it("T168 part B: a non-boolean edit.require_read is a load error", () => {
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    for (const bad of ['"yes"', "1", "null", "[true]"]) {
      writeFileSync(join(cwd, ".lykos", "config.yaml"), `edit:\n  require_read: ${bad}\n`);
      assert.throws(() => loadConfig({ cwd, globalDir, env: {} }), /edit\.require_read must be true or false/, bad);
    }
  });

  it("T168 part B: edit.mode still fails to load when it sits beside require_read", () => {
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(join(cwd, ".lykos", "config.yaml"), "edit:\n  mode: replace\n  require_read: true\n");
    assert.throws(() => loadConfig({ cwd, globalDir, env: {} }), /edit\.mode was removed \(ADR-0031\)/);
  });

  it("T168: an edit: section that does not set mode is not an error", () => {
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(join(cwd, ".lykos", "config.yaml"), "edit: {}\n");
    assert.doesNotThrow(() => loadConfig({ cwd, globalDir, env: {} }));
  });

  it("T19: compaction threshold defaults to 0.80 and project config can override it", () => {
    const cwd = tmp();
    const globalDir = tmp();
    const { resolved: shipped } = loadConfig({ cwd, globalDir, env: {} });
    assert.equal(shipped.compaction.threshold, 0.8);
    assert.equal("snip_after_turns" in shipped.compaction, false, "the container's snip knobs are gone (T185)");
    assert.equal("snip_max_bytes" in shipped.compaction, false);

    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(join(cwd, ".lykos", "config.yaml"), "compaction:\n  threshold: 0.75\n");
    const { resolved } = loadConfig({ cwd, globalDir, env: {} });
    assert.equal(resolved.compaction.threshold, 0.75);
    assert.equal(resolved.compaction.supersede_reads, true);
  });

  it("T19: LYKOS_COMPACTION_THRESHOLD overrides project config.yaml", () => {
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(join(cwd, ".lykos", "config.yaml"), "compaction:\n  threshold: 0.70\n");
    const { resolved } = loadConfig({
      cwd,
      globalDir,
      env: { LYKOS_COMPACTION_THRESHOLD: "0.85" },
    });
    assert.equal(resolved.compaction.threshold, 0.85);
  });

  it("T150: the context strategy is self-compact by default and project config can choose continue", () => {
    const cwd = tmp();
    const globalDir = tmp();
    const shipped = loadConfig({ cwd, globalDir, env: {} }).resolved;
    assert.equal(shipped.context_strategy, "self-compact");
    assert.equal(shipped.continuation.max, 1);
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(
      join(cwd, ".lykos", "config.yaml"),
      "context_strategy: continue\ncontinuation:\n  max: 2\n",
    );
    const { resolved } = loadConfig({ cwd, globalDir, env: {} });
    assert.equal(resolved.context_strategy, "continue");
    assert.equal(resolved.continuation.max, 2);
  });

  it("T151: self_compact ships the spec's table; a layer's tiers replace it and its overrides merge by key", () => {
    const cwd = tmp();
    const globalDir = tmp();
    const shipped = loadConfig({ cwd, globalDir, env: {} }).resolved.self_compact;
    assert.equal(shipped.tiers.length, 8);
    assert.deepEqual(shipped.models, {});
    writeFileSync(join(globalDir, "config.yaml"), "self_compact:\n  models:\n    a/b: { notice: 1k, warning: 2k, cutoff: 3k }\n");
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(
      join(cwd, ".lykos", "config.yaml"),
      "self_compact:\n  tiers:\n    - { window: 64k, notice: 10k, warning: 20k, cutoff: 30k }\n  specialists:\n    minimal: { notice: 1k, warning: 2k, cutoff: 3k }\n",
    );
    const { resolved } = loadConfig({ cwd, globalDir, env: {} });
    assert.equal(resolved.self_compact.tiers.length, 1);
    assert.deepEqual(Object.keys(resolved.self_compact.models), ["a/b"], "the global layer's override survives");
    assert.deepEqual(Object.keys(resolved.self_compact.specialists), ["minimal"]);
  });

  it("T110: reviewer is disabled by default and project config can enable and configure model", () => {
    const cwd = tmp();
    const globalDir = tmp();
    const defaultConfig = loadConfig({ cwd, globalDir, env: {} }).resolved.reviewer;
    assert.equal(defaultConfig.enabled, false);
    assert.equal(defaultConfig.model, "");

    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(
      join(cwd, ".lykos", "config.yaml"),
      "reviewer:\n  enabled: true\n  model: anthropic/claude-3-5-sonnet-20241022\n",
    );
    const { resolved } = loadConfig({ cwd, globalDir, env: {} });
    assert.equal(resolved.reviewer.enabled, true);
    assert.equal(resolved.reviewer.model, "anthropic/claude-3-5-sonnet-20241022");
  });

  it("env overrides project config.yaml", () => {
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(join(cwd, ".lykos", "config.yaml"), "budget:\n  per_run_usd: 0.10\n");

    const { resolved } = loadConfig({
      cwd,
      globalDir,
      env: { LYKOS_BUDGET_PER_RUN_USD: "9.99" },
    });
    assert.equal(resolved.budget.per_run_usd, 9.99);
  });

  it("caller flags win over everything, including env", () => {
    const cwd = tmp();
    const globalDir = tmp();
    const { resolved } = loadConfig({
      cwd,
      globalDir,
      env: { LYKOS_BUDGET_PER_RUN_USD: "9.99" },
      flags: { budget: { per_run_usd: 42 } },
    });
    assert.equal(resolved.budget.per_run_usd, 42);
  });

  it("throws on a config.yaml that does not parse to an object", () => {
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(join(cwd, ".lykos", "config.yaml"), "- just\n- a\n- list\n");
    assert.throws(() => loadConfig({ cwd, globalDir, env: {} }));
  });

  it("T35.1: providers merge by key — a project adding anthropic keeps shipped deepseek", () => {
    const cwd = tmp();
    const globalDir = tmp();
    const { resolved: shipped } = loadConfig({ cwd, globalDir, env: {} });
    assert.equal(shipped.providers.deepseek?.auth, "api_key");
    assert.equal(shipped.providers.deepseek?.priced, true);

    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(
      join(cwd, ".lykos", "config.yaml"),
      "providers:\n  anthropic:\n    auth: api_key\n    priced: true\n",
    );
    const { resolved } = loadConfig({ cwd, globalDir, env: {} });
    assert.equal(resolved.providers.deepseek?.auth, "api_key");
    assert.equal(resolved.providers.anthropic?.auth, "api_key");
  });

  it("T35.1: a project re-declaration of deepseek replaces that entry, not the whole map", () => {
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(
      join(cwd, ".lykos", "config.yaml"),
      "providers:\n  deepseek:\n    auth: api_key\n    priced: false\n    source: $MY_DEEPSEEK_KEY\n",
    );
    const { resolved } = loadConfig({ cwd, globalDir, env: {} });
    assert.equal(resolved.providers.deepseek?.priced, false);
    assert.equal(resolved.providers.deepseek?.source, "$MY_DEEPSEEK_KEY");
  });

  it("T210: parses path_rules per layer and keeps global and project rules apart", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeFileSync(
      join(globalDir, "config.yaml"),
      "path_rules:\n  read:\n    'secrets/**': deny\n",
    );
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(
      join(cwd, ".lykos", "config.yaml"),
      "path_rules:\n  write:\n    'dist/**': deny\n",
    );
    const { resolved } = loadConfig({ cwd, globalDir, env: {} });
    assert.deepEqual(resolved.path_rules.global, { read: { "secrets/**": "deny" } });
    assert.deepEqual(resolved.path_rules.project, { write: { "dist/**": "deny" } });
  });

  it("T210: rejects an invalid path_rules decision naming the key", () => {
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(
      join(cwd, ".lykos", "config.yaml"),
      "path_rules:\n  read:\n    'docs/**': invalid_decision\n",
    );
    assert.throws(
      () => loadConfig({ cwd, globalDir, env: {} }),
      /invalid decision "invalid_decision" for path_rules\.read\.docs\/\*\*/,
    );
  });

  // P10.7 (ticket 12, D2), ticket 24 D1: the search provider declaration.
  it("ships web.search as the keyless `auto` chain — no endpoint or key variable of its own, no key", () => {
    const cwd = tmp();
    const globalDir = tmp();
    const { resolved } = loadConfig({ cwd, globalDir, env: { BRAVE_SEARCH_API_KEY: "a key nobody asked for" } });
    assert.equal(resolved.web.search.provider, "auto");
    assert.equal(resolved.web.search.endpoint, "");
    assert.equal(resolved.web.search.key_env, "");
    // The KEY is not part of the resolved configuration and must never be:
    // the environment variable is named here and read at session boot.
    assert.equal(JSON.stringify(resolved.web).includes("a key nobody asked for"), false);
  });

  it("ticket 24 D1: a project that already says `provider: brave` gets exactly Brave's declaration back", () => {
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(join(cwd, ".lykos", "config.yaml"), "web:\n  search:\n    provider: brave\n");
    const { resolved } = loadConfig({ cwd, globalDir, env: {} });
    assert.deepEqual(resolved.web.search, {
      provider: "brave",
      endpoint: "https://api.search.brave.com/res/v1/web/search",
      key_env: "BRAVE_SEARCH_API_KEY",
    });
  });

  it("ticket 24 D1: naming a keyless backend brings its own endpoint and key variable", () => {
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(join(cwd, ".lykos", "config.yaml"), "web:\n  search:\n    provider: exa\n");
    assert.deepEqual(loadConfig({ cwd, globalDir, env: {} }).resolved.web.search, {
      provider: "exa",
      endpoint: "https://mcp.exa.ai/mcp",
      key_env: "EXA_API_KEY",
    });
    writeFileSync(join(cwd, ".lykos", "config.yaml"), "web:\n  search:\n    provider: duckduckgo\n");
    assert.deepEqual(loadConfig({ cwd, globalDir, env: {} }).resolved.web.search, {
      provider: "duckduckgo",
      endpoint: "https://html.duckduckgo.com/html/",
      key_env: "",
    });
  });

  it("merges web.search one key at a time, so setting key_env keeps the provider's endpoint", () => {
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(join(cwd, ".lykos", "config.yaml"), "web:\n  search:\n    provider: brave\n    key_env: MY_SEARCH_KEY\n");
    const { resolved } = loadConfig({ cwd, globalDir, env: {} });
    assert.equal(resolved.web.search.key_env, "MY_SEARCH_KEY");
    assert.equal(resolved.web.search.endpoint, "https://api.search.brave.com/res/v1/web/search");
    assert.equal(resolved.web.search.provider, "brave");
  });

  it("lets a project point at its own endpoint without changing anything else", () => {
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(
      join(cwd, ".lykos", "config.yaml"),
      "web:\n  search:\n    provider: brave\n    endpoint: https://search.internal.example/v1/web/search\n",
    );
    const { resolved } = loadConfig({ cwd, globalDir, env: {} });
    assert.equal(resolved.web.search.endpoint, "https://search.internal.example/v1/web/search");
    assert.equal(resolved.web.search.key_env, "BRAVE_SEARCH_API_KEY");
  });

  describe("specialists ticket 01: the sixth layer", () => {
    function writeSpecialist(dir: string, name: string, yaml: string): void {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${name}.yaml`), yaml, "utf8");
    }

    it("no specialistName means no specialist layer, and instructions default to empty", () => {
      const cwd = tmp();
      const globalDir = tmp();
      const { resolved, layers } = loadConfig({ cwd, globalDir, env: {} });
      assert.equal(resolved.instructions, "");
      assert.equal(layers.find((l) => l.name === "specialist")!.present, false);
    });

    it("selecting a specialist by name resolves its instructions through a layer named 'specialist'", () => {
      const cwd = tmp();
      const globalDir = tmp();
      writeSpecialist(globalSpecialistsDir(globalDir), "deliberate", "instructions: Weigh alternatives before committing.\n");

      const { resolved, layers } = loadConfig({ cwd, globalDir, env: {}, specialistName: "deliberate" });
      assert.equal(resolved.instructions, "Weigh alternatives before committing.");
      const specialistLayer = layers.find((l) => l.name === "specialist");
      assert.equal(specialistLayer?.present, true);
      assert.equal(specialistLayer?.value.instructions, "Weigh alternatives before committing.");
    });

    it("a specialist beats project configuration", () => {
      const cwd = tmp();
      const globalDir = tmp();
      mkdirSync(join(cwd, ".lykos"), { recursive: true });
      writeFileSync(join(cwd, ".lykos", "config.yaml"), "instructions: from project config.yaml\n");
      writeSpecialist(projectSpecialistsDir(cwd), "deliberate", "instructions: from the specialist\n");

      const { resolved } = loadConfig({ cwd, globalDir, env: {}, specialistName: "deliberate" });
      assert.equal(resolved.instructions, "from the specialist");
    });

    it("a flag beats a specialist", () => {
      const cwd = tmp();
      const globalDir = tmp();
      writeSpecialist(globalSpecialistsDir(globalDir), "deliberate", "instructions: from the specialist\n");

      const { resolved } = loadConfig({
        cwd,
        globalDir,
        env: {},
        specialistName: "deliberate",
        flags: { instructions: "from the flag" },
      });
      assert.equal(resolved.instructions, "from the flag");
    });

    it("an absent field on a partially specified specialist falls through to the layer below", () => {
      const cwd = tmp();
      const globalDir = tmp();
      mkdirSync(join(cwd, ".lykos"), { recursive: true });
      writeFileSync(join(cwd, ".lykos", "config.yaml"), "budget:\n  per_run_usd: 0.25\n");
      // A specialist that only sets instructions must not disturb budget, which
      // it never mentions — spec story 20.
      writeSpecialist(projectSpecialistsDir(cwd), "minimal", "instructions: Do the smallest thing that works.\n");

      const { resolved } = loadConfig({ cwd, globalDir, env: {}, specialistName: "minimal" });
      assert.equal(resolved.instructions, "Do the smallest thing that works.");
      assert.equal(resolved.budget.per_run_usd, 0.25);
    });

    it("selecting a specialist that does not exist throws, listing the specialists that do", () => {
      const cwd = tmp();
      const globalDir = tmp();
      writeSpecialist(globalSpecialistsDir(globalDir), "minimal", "instructions: a\n");

      assert.throws(
        () => loadConfig({ cwd, globalDir, env: {}, specialistName: "typo" }),
        (err: unknown) => {
          assert.ok(err instanceof SpecialistNotFoundError);
          assert.match((err as Error).message, /minimal/);
          return true;
        },
      );
    });

    it("a specialist with volatile instructions throws at load", () => {
      const cwd = tmp();
      const globalDir = tmp();
      writeSpecialist(globalSpecialistsDir(globalDir), "bad", 'instructions: "run git status first"\n');

      assert.throws(
        () => loadConfig({ cwd, globalDir, env: {}, specialistName: "bad" }),
        (err: unknown) => {
          assert.ok(err instanceof SpecialistValidationError);
          return true;
        },
      );
    });
  });

  describe("specialists ticket 02: the remaining fourteen fields, through loadConfig", () => {
    function writeSpecialist(dir: string, name: string, yaml: string): void {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${name}.yaml`), yaml, "utf8");
    }

    it("model/provider/thinkingLevel/read_only/description resolve into ResolvedConfig", () => {
      const cwd = tmp();
      const globalDir = tmp();
      writeSpecialist(
        globalSpecialistsDir(globalDir),
        "deliberate",
        ["provider: anthropic", "model: claude-sonnet-5", "thinkingLevel: high", "read_only: false", "description: deliberate work"].join("\n") + "\n",
      );

      const { resolved } = loadConfig({ cwd, globalDir, env: {}, specialistName: "deliberate" });
      assert.equal(resolved.provider, "anthropic");
      assert.equal(resolved.model, "claude-sonnet-5");
      assert.equal(resolved.thinkingLevel, "high");
      assert.equal(resolved.readOnly, false);
      assert.equal(resolved.description, "deliberate work");
    });

    it("tools_add and tools_remove resolve alongside a replacing tools list", () => {
      const cwd = tmp();
      const globalDir = tmp();
      writeSpecialist(projectSpecialistsDir(cwd), "plan", "tools: [read, grep, ls]\ntools_add: [bash]\ntools_remove: [ls]\n");

      const { resolved } = loadConfig({ cwd, globalDir, env: {}, specialistName: "plan" });
      assert.deepEqual(resolved.tools, ["read", "grep", "ls"]);
      assert.deepEqual(resolved.tools_add, ["bash"]);
      assert.deepEqual(resolved.tools_remove, ["ls"]);
    });

    it("skills resolves onto the existing skills.roster, without disturbing skills.max", () => {
      const cwd = tmp();
      const globalDir = tmp();
      mkdirSync(join(cwd, ".lykos"), { recursive: true });
      writeFileSync(join(cwd, ".lykos", "config.yaml"), "skills:\n  max: 5\n");
      // ticket 05: a roster entry must exist on disk to resolve.
      writeSkill(cwd, "reviewer.md", "---\nname: reviewer\ndescription: review only\n---\n# review\n");
      writeSpecialist(projectSpecialistsDir(cwd), "review", "skills: [reviewer]\n");

      const { resolved } = loadConfig({ cwd, globalDir, env: {}, specialistName: "review" });
      assert.deepEqual(resolved.skills.roster, ["reviewer"]);
      assert.equal(resolved.skills.max, 5);
    });

    it("feedback and gate resolve through the specialist layer onto their existing sections", () => {
      const cwd = tmp();
      const globalDir = tmp();
      writeSpecialist(projectSpecialistsDir(cwd), "explore", "feedback: { enabled: false }\ngate: { enabled: false }\n");

      const { resolved } = loadConfig({ cwd, globalDir, env: {}, specialistName: "explore" });
      assert.equal(resolved.feedback.enabled, false);
      assert.equal(resolved.gate.enabled, false);
      // Untouched fields of the same sections still come from shipped defaults.
      assert.equal(resolved.feedback.timeout_seconds, SHIPPED_DEFAULTS.feedback.timeout_seconds);
    });

    it("a flag beats a specialist for the new fields, the same as it does for instructions", () => {
      const cwd = tmp();
      const globalDir = tmp();
      writeSpecialist(globalSpecialistsDir(globalDir), "deliberate", "model: claude-sonnet-5\nread_only: true\n");

      const { resolved } = loadConfig({
        cwd,
        globalDir,
        env: {},
        specialistName: "deliberate",
        flags: { model: "deepseek-v4-flash", readOnly: false },
      });
      assert.equal(resolved.model, "deepseek-v4-flash");
      assert.equal(resolved.readOnly, false);
    });

    it("a specialist declaring only instructions leaves every ticket 02 field undefined", () => {
      const cwd = tmp();
      const globalDir = tmp();
      writeSpecialist(projectSpecialistsDir(cwd), "prose", "instructions: Write plainly.\n");

      const { resolved } = loadConfig({ cwd, globalDir, env: {}, specialistName: "prose" });
      assert.equal(resolved.provider, undefined);
      assert.equal(resolved.model, undefined);
      assert.equal(resolved.thinkingLevel, undefined);
      assert.equal(resolved.tools, undefined);
      assert.equal(resolved.tools_add, undefined);
      assert.equal(resolved.tools_remove, undefined);
      assert.equal(resolved.mode, undefined);
      assert.equal(resolved.description, undefined);
    });

    it("the specialist layer carries notices for the two inert fields, reachable from loadConfig's layers", () => {
      const cwd = tmp();
      const globalDir = tmp();
      writeSpecialist(projectSpecialistsDir(cwd), "future", "rules: [one]\nmemory: local\n");

      const { layers } = loadConfig({ cwd, globalDir, env: {}, specialistName: "future" });
      const specialistLayer = layers.find((l) => l.name === "specialist");
      assert.ok(specialistLayer?.notices?.some((n) => n.includes("rules")));
      assert.ok(specialistLayer?.notices?.some((n) => n.includes("memory")));
    });

    it("delegate no longer warns, because band 2 ticket 04 made it mean something", () => {
      // It was inert and said so. A specialist declaring `delegate: false` is now
      // refused as a subagent, so a notice claiming the field does nothing would
      // be the false statement rather than the true one.
      const cwd = tmp();
      const globalDir = tmp();
      writeSpecialist(projectSpecialistsDir(cwd), "delegable", "delegate: true\n");

      const { layers } = loadConfig({ cwd, globalDir, env: {}, specialistName: "delegable" });
      const specialistLayer = layers.find((l) => l.name === "specialist");
      assert.equal(specialistLayer?.notices?.some((n) => n.includes("delegate")) ?? false, false);
    });

    it("a specialist naming a field outside the eighteen is rejected at selection time, naming the field", () => {
      const cwd = tmp();
      const globalDir = tmp();
      writeSpecialist(projectSpecialistsDir(cwd), "typo", "toolz: [read]\n");

      assert.throws(
        () => loadConfig({ cwd, globalDir, env: {}, specialistName: "typo" }),
        (err: unknown) => {
          assert.ok(err instanceof SpecialistValidationError);
          assert.match((err as Error).message, /toolz/);
          return true;
        },
      );
    });

    it("Plan 17 D3: web.search.provider perplexity defaults endpoint to Perplexity endpoint and key_env to PERPLEXITY_API_KEY", () => {
      const cwd = tmp();
      const globalDir = tmp();
      mkdirSync(join(cwd, ".lykos"), { recursive: true });
      writeFileSync(join(cwd, ".lykos", "config.yaml"), "web:\n  search:\n    provider: perplexity\n");

      const { resolved } = loadConfig({ cwd, globalDir, env: {} });
      assert.equal(resolved.web.search.provider, "perplexity");
      assert.equal(resolved.web.search.endpoint, "https://api.perplexity.ai/search");
      assert.equal(resolved.web.search.key_env, "PERPLEXITY_API_KEY");
    });

    it("Plan 17 D3: web.search.endpoint explicit override is preserved with perplexity provider", () => {
      const cwd = tmp();
      const globalDir = tmp();
      mkdirSync(join(cwd, ".lykos"), { recursive: true });
      writeFileSync(
        join(cwd, ".lykos", "config.yaml"),
        "web:\n  search:\n    provider: perplexity\n    endpoint: https://custom.search.internal/api\n",
      );

      const { resolved } = loadConfig({ cwd, globalDir, env: {} });
      assert.equal(resolved.web.search.provider, "perplexity");
      assert.equal(resolved.web.search.endpoint, "https://custom.search.internal/api");
      assert.equal(resolved.web.search.key_env, "PERPLEXITY_API_KEY");
    });
  });
});

describe("containment.global_image (T177)", () => {
  it("globalImageApart moves the image out of the project-level key and leaves the rest of containment alone", () => {
    assert.deepEqual(globalImageApart({ containment: { level: "auto" as const, image: "a:1" } }), { containment: { level: "auto", global_image: "a:1" } });
    const untouched = { containment: { level: "auto" as const } };
    assert.equal(globalImageApart(untouched), untouched);
    const noContainment = { budget: {} };
    assert.equal(globalImageApart(noContainment), noContainment);
  });

  it("the global file's image lands in global_image, not image", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeFileSync(join(globalDir, "config.yaml"), "containment:\n  image: a:1\n");
    const { containment } = loadConfig({ cwd, globalDir, env: {} }).resolved;
    assert.equal(containment.global_image, "a:1");
    assert.equal(containment.image, "");
  });

  for (const where of ["project", "global"] as const) {
    it(`a ${where} config file that sets global_image is rejected, naming the key and the file`, () => {
      const cwd = tmp();
      const globalDir = tmp();
      const dir = where === "project" ? join(cwd, ".lykos") : globalDir;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "config.yaml"), "containment:\n  global_image: sneaky:1\n");
      assert.throws(
        () => loadConfig({ cwd, globalDir, env: {} }),
        (err: unknown) => {
          assert.match((err as Error).message, /^lykos config: containment\.global_image is not a config key/);
          assert.match((err as Error).message, /config\.yaml/);
          return true;
        },
      );
    });
  }
});

describe("gate.rerun_failures and gate.rerun_command (T167)", () => {
  function project(yaml: string): string {
    const cwd = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(join(cwd, ".lykos", "config.yaml"), yaml);
    return cwd;
  }

  it("rerun by default, with no override", () => {
    const { resolved } = loadConfig({ cwd: tmp(), globalDir: tmp(), env: {} });
    assert.equal(resolved.gate.rerun_failures, true);
    assert.equal(resolved.gate.rerun_command, "");
  });

  it("a project turns it off, and sets an override that keeps the shipped timeout", () => {
    const cwd = project(`gate:\n  rerun_failures: false\n  rerun_command: "npx vitest run {files}"\n`);
    const { resolved } = loadConfig({ cwd, globalDir: tmp(), env: {} });
    assert.equal(resolved.gate.rerun_failures, false);
    assert.equal(resolved.gate.rerun_command, "npx vitest run {files}");
    assert.equal(resolved.gate.timeout_seconds, 900);
  });

  it("refuses an override with no {files}, and a rerun_failures that is not a boolean, by key name", () => {
    assert.throws(
      () => loadConfig({ cwd: project(`gate:\n  rerun_command: "npm test"\n`), globalDir: tmp(), env: {} }),
      /gate\.rerun_command must contain \{files\}/,
    );
    assert.throws(
      () => loadConfig({ cwd: project(`gate:\n  rerun_failures: "yes"\n`), globalDir: tmp(), env: {} }),
      /gate\.rerun_failures must be true or false/,
    );
  });

  it("an empty YAML rerun_command is unset, not an error", () => {
    const { resolved } = loadConfig({ cwd: project(`gate:\n  rerun_command:\n`), globalDir: tmp(), env: {} });
    assert.ok(!resolved.gate.rerun_command);
  });
});

describe("containment resource caps (T185)", () => {
  it("memory and CPU caps come from config, defaulting to 4g and 2, and a project can change them", () => {
    const cwd = tmp();
    const globalDir = tmp();
    const bare = loadConfig({ cwd, globalDir, env: {} }).resolved.containment;
    assert.equal(bare.memory, "4g");
    assert.equal(bare.cpus, "2");
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(join(cwd, ".lykos", "config.yaml"), 'containment:\n  memory: 512m\n  cpus: "1"\n');
    const set = loadConfig({ cwd, globalDir, env: {} }).resolved.containment;
    assert.equal(set.memory, "512m");
    assert.equal(set.cpus, "1");
  });
});
