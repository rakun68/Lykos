import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { exportPiPresets, piPresetsPath, toPiPreset, writePiPresetsFile } from "./pi-preset-export.js";
import { globalSpecialistsDir, projectSpecialistsDir } from "./specialists.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "lykos-pi-preset-"));
}

function writeSpecialist(dir: string, name: string, yaml: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), yaml, "utf8");
}

describe("toPiPreset (specialists ticket 02: the five Pi-compatible fields)", () => {
  it("keeps only provider/model/thinkingLevel/tools/instructions", () => {
    const preset = toPiPreset({
      provider: "anthropic",
      model: "claude-sonnet-5",
      thinkingLevel: "high",
      tools: ["read", "grep"],
      instructions: "Deliberate fully.",
    });
    assert.deepEqual(preset, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      thinkingLevel: "high",
      tools: ["read", "grep"],
      instructions: "Deliberate fully.",
    });
  });

  it("carries only the fields that were actually set", () => {
    assert.deepEqual(toPiPreset({ model: "claude-sonnet-5" }), { model: "claude-sonnet-5" });
    assert.deepEqual(toPiPreset({}), {});
  });
});

describe("exportPiPresets (specialists ticket 02)", () => {
  it("exports every discoverable specialist, reduced to the five shared fields", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(
      projectSpecialistsDir(cwd),
      "deliberate",
      ["provider: anthropic", "model: claude-sonnet-5", "thinkingLevel: high", "instructions: Weigh alternatives.", "read_only: false", "description: full deliberation"].join(
        "\n",
      ) + "\n",
    );
    writeSpecialist(globalSpecialistsDir(globalDir), "plan", "tools: [read, grep, ls]\n");

    const { presets, errors } = exportPiPresets(cwd, globalDir);
    assert.deepEqual(errors, []);
    assert.deepEqual(presets.deliberate, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      thinkingLevel: "high",
      instructions: "Weigh alternatives.",
    });
    // Lykos-owned fields (read_only, description) are gone — this is what makes
    // the output unambiguously valid `Preset` input, not merely harmless
    // extra keys.
    assert.equal((presets.deliberate as unknown as Record<string, unknown>).read_only, undefined);
    assert.equal((presets.deliberate as unknown as Record<string, unknown>).description, undefined);
    assert.deepEqual(presets.plan, { tools: ["read", "grep", "ls"] });
  });

  it("skips a specialist that fails to resolve, naming it in errors, without failing the whole export", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "good", "instructions: fine\n");
    writeSpecialist(projectSpecialistsDir(cwd), "bad", "toolz: [read]\n");

    const { presets, errors } = exportPiPresets(cwd, globalDir);
    assert.deepEqual(presets.good, { instructions: "fine" });
    assert.equal(presets.bad, undefined);
    assert.ok(errors.some((e) => e.startsWith("bad:") && e.includes("toolz")));
  });
});

describe("writePiPresetsFile (specialists ticket 02: valid input to Pi's preset extension)", () => {
  it("writes <cwd>/.pi/presets.json — Pi's own preset extension's fixed project-local path", () => {
    const cwd = tmp();
    const globalDir = tmp();
    // Ticket 07: isolate the shipped library so this test stays about the
    // project/global roster only.
    const shipped = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "plan", "provider: anthropic\nmodel: claude-sonnet-5\ntools: [read, grep, ls]\n");

    const result = writePiPresetsFile(cwd, globalDir, shipped);
    assert.equal(result.path, piPresetsPath(cwd));
    assert.equal(result.path, join(cwd, ".pi", "presets.json"));
    assert.ok(existsSync(result.path));
    assert.deepEqual(result.written, ["plan"]);
    assert.deepEqual(result.errors, []);

    // Round-trip through JSON exactly as `loadPresets()` in preset.ts does
    // (`JSON.parse(readFileSync(path, "utf-8"))`), and check the shape is
    // exactly what its `PresetsConfig` (`{ [name: string]: Preset }`) reads:
    // a map whose values carry only Pi's five known keys.
    const parsed = JSON.parse(readFileSync(result.path, "utf8")) as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(parsed), ["plan"]);
    assert.deepEqual(parsed.plan, { provider: "anthropic", model: "claude-sonnet-5", tools: ["read", "grep", "ls"] });
    for (const key of Object.keys(parsed.plan!)) {
      assert.ok(["provider", "model", "thinkingLevel", "tools", "instructions"].includes(key));
    }
  });

  it("creates the .pi directory if it does not exist yet", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "minimal", "instructions: keep it small\n");

    assert.equal(existsSync(join(cwd, ".pi")), false);
    writePiPresetsFile(cwd, globalDir);
    assert.equal(existsSync(join(cwd, ".pi")), true);
  });
});
