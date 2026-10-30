import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { detectDefaultBase, loadConfig } from "./load.js";
import {
  DEFAULT_ALWAYS_SEALED,
  DEFAULT_RUN_GLOBS,
  DEFAULT_TEST_COMMAND,
  DEFAULT_TEST_GLOBS,
} from "./defaults.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "lykos-config-seal-test-"));
}

describe("seal config (T195)", () => {
  it("defaults to shipped values when seal block is omitted", () => {
    const cwd = tmp();
    const globalDir = tmp();
    const { resolved } = loadConfig({ cwd, globalDir, env: {} });

    assert.equal(resolved.seal.test_command, DEFAULT_TEST_COMMAND);
    assert.deepEqual(resolved.seal.test_globs, [...DEFAULT_TEST_GLOBS]);
    assert.deepEqual(resolved.seal.run_globs, [...DEFAULT_RUN_GLOBS]);
    assert.deepEqual(resolved.seal.always_sealed, [...DEFAULT_ALWAYS_SEALED]);
    assert.deepEqual(resolved.seal.writers, ["test-writer"]);
    assert.deepEqual(resolved.seal.enforce_for, ["implementer"]);
    assert.deepEqual(resolved.seal.weakening_patterns, []);
    assert.equal(resolved.seal.resolver, undefined);
    assert.equal(resolved.seal.escalate_after, 1);
    assert.equal(resolved.seal.base, "");
  });

  it("detectDefaultBase detects git repository default branch", () => {
    assert.ok(typeof detectDefaultBase(process.cwd()) === "string");
  });

  it("project config can override base, test_command, test_globs, run_globs, and always_sealed", () => {
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(
      join(cwd, ".lykos", "config.yaml"),
      [
        "seal:",
        "  base: main",
        '  test_command: "npx vitest run {files}"',
        '  test_globs: ["tests/**/*.spec.ts"]',
        '  run_globs: ["tests/**/*.run.ts"]',
        '  always_sealed: ["vitest.config.ts"]',
        '  weakening_patterns: ["CUSTOM_FLAG"]',
      ].join("\n") + "\n",
    );

    const { resolved } = loadConfig({ cwd, globalDir, env: {} });
    assert.equal(resolved.seal.base, "main");
    assert.equal(resolved.seal.test_command, "npx vitest run {files}");
    assert.deepEqual(resolved.seal.test_globs, ["tests/**/*.spec.ts"]);
    assert.deepEqual(resolved.seal.run_globs, ["tests/**/*.run.ts"]);
    assert.deepEqual(resolved.seal.always_sealed, ["vitest.config.ts"]);
    assert.deepEqual(resolved.seal.weakening_patterns, ["CUSTOM_FLAG"]);
  });

  it("rejects unknown sub-keys in seal:, naming the key and file", () => {
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(
      join(cwd, ".lykos", "config.yaml"),
      ["seal:", "  base: main", "  unknown_field: true"].join("\n") + "\n",
    );

    assert.throws(
      () => loadConfig({ cwd, globalDir, env: {} }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /unknown key "unknown_field" in seal/);
        assert.match(err.message, /config\.yaml/);
        return true;
      },
    );
  });

  it("rejects seal.test_command without {files}", () => {
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(
      join(cwd, ".lykos", "config.yaml"),
      ["seal:", '  test_command: "npm test"'].join("\n") + "\n",
    );

    assert.throws(
      () => loadConfig({ cwd, globalDir, env: {} }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /seal\.test_command must contain \{files\}/);
        return true;
      },
    );
  });

  it("rejects non-list weakening_patterns", () => {
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(
      join(cwd, ".lykos", "config.yaml"),
      ["seal:", '  weakening_patterns: "invalid"'].join("\n") + "\n",
    );

    assert.throws(
      () => loadConfig({ cwd, globalDir, env: {} }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /seal\.weakening_patterns must be a list of strings/);
        return true;
      },
    );
  });

  it("accepts valid resolver and escalate_after overrides", () => {
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(
      join(cwd, ".lykos", "config.yaml"),
      ["seal:", "  resolver: orchestrator", "  escalate_after: 3"].join("\n") + "\n",
    );

    const { resolved } = loadConfig({ cwd, globalDir, env: {} });
    assert.equal(resolved.seal.resolver, "orchestrator");
    assert.equal(resolved.seal.escalate_after, 3);

    writeFileSync(
      join(cwd, ".lykos", "config.yaml"),
      ["seal:", "  resolver: test-writer"].join("\n") + "\n",
    );
    const { resolved: resolvedWriter } = loadConfig({ cwd, globalDir, env: {} });
    assert.equal(resolvedWriter.seal.resolver, "test-writer");
  });

  it("rejects invalid resolver values", () => {
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(
      join(cwd, ".lykos", "config.yaml"),
      ["seal:", "  resolver: invalid"].join("\n") + "\n",
    );

    assert.throws(
      () => loadConfig({ cwd, globalDir, env: {} }),
      /seal\.resolver must be 'orchestrator' or 'test-writer'/,
    );
  });

  it("rejects invalid escalate_after values", () => {
    const cwd = tmp();
    const globalDir = tmp();
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(
      join(cwd, ".lykos", "config.yaml"),
      ["seal:", "  escalate_after: 0"].join("\n") + "\n",
    );

    assert.throws(
      () => loadConfig({ cwd, globalDir, env: {} }),
      /seal\.escalate_after must be a positive integer/,
    );
  });
});
