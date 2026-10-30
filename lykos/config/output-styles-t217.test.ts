// T217 acceptance (sealed): output styles (ADR-0045).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverOutputStyles, outputStyleSwitchNotice, resolveOutputStyle } from "./output-styles.js";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "lykos-t217-"));
  const cwd = join(root, "proj");
  const globalDir = join(root, "global");
  mkdirSync(cwd);
  mkdirSync(globalDir);
  return { cwd, globalDir };
}

describe("T217: output styles", () => {
  it("ships default and minimal, listed and resolvable with zero config", () => {
    const { cwd, globalDir } = sandbox();
    const names = discoverOutputStyles(cwd, globalDir).map((s) => s.name);
    assert.ok(names.includes("default"), names.join(","));
    assert.ok(names.includes("minimal"), names.join(","));
    const minimal = resolveOutputStyle("minimal", cwd, globalDir);
    assert.equal(minimal.name, "minimal");
    assert.equal(minimal.source, "shipped");
    assert.ok(minimal.text.trim().length > 0);
  });

  it("precedence is shipped < global < project", () => {
    const { cwd, globalDir } = sandbox();
    mkdirSync(join(globalDir, "output-styles"), { recursive: true });
    writeFileSync(join(globalDir, "output-styles", "minimal.md"), "GLOBAL MINIMAL\n");
    assert.equal(resolveOutputStyle("minimal", cwd, globalDir).source, "global");
    assert.match(resolveOutputStyle("minimal", cwd, globalDir).text, /GLOBAL MINIMAL/);
    mkdirSync(join(cwd, ".lykos", "output-styles"), { recursive: true });
    writeFileSync(join(cwd, ".lykos", "output-styles", "minimal.md"), "PROJECT MINIMAL\n");
    const r = resolveOutputStyle("minimal", cwd, globalDir);
    assert.equal(r.source, "project");
    assert.match(r.text, /PROJECT MINIMAL/);
  });

  it("discovers a user's own style", () => {
    const { cwd, globalDir } = sandbox();
    mkdirSync(join(cwd, ".lykos", "output-styles"), { recursive: true });
    writeFileSync(join(cwd, ".lykos", "output-styles", "terse.md"), "One line.\n");
    assert.ok(discoverOutputStyles(cwd, globalDir).some((s) => s.name === "terse"));
  });

  it("an unknown name throws naming what exists", () => {
    const { cwd, globalDir } = sandbox();
    assert.throws(() => resolveOutputStyle("nope", cwd, globalDir), /minimal/);
  });

  it("the switch notice names the style", () => {
    assert.match(outputStyleSwitchNotice("minimal"), /minimal/);
  });
});
