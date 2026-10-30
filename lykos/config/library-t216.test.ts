// T216 acceptance (sealed): the shipped library is Plan, Build, Explore, General, Review (ADR-0043).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SPECIALIST, discoverSpecialists, primarySpecialists, resolveSpecialist, specialistRole } from "./specialists.js";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "lykos-t216-"));
  const cwd = join(root, "proj");
  const globalDir = join(root, "global");
  mkdirSync(cwd);
  mkdirSync(globalDir);
  return { cwd, globalDir };
}

describe("T216: the shipped library", () => {
  it("is exactly plan, build, explore, general, implementer, review and test-writer", () => {
    const { cwd, globalDir } = sandbox();
    const shipped = discoverSpecialists(cwd, globalDir).filter((s) => s.shippedPath !== undefined).map((s) => s.name).sort();
    assert.deepEqual(shipped, ["build", "explore", "general", "implementer", "plan", "review", "test-writer"]);
  });

  it("each validates with its role and read_only", () => {
    const { cwd, globalDir } = sandbox();
    const want: Record<string, { role: string; readOnly: boolean }> = {
      plan: { role: "primary", readOnly: true },
      build: { role: "primary", readOnly: false },
      explore: { role: "subagent", readOnly: true },
      general: { role: "subagent", readOnly: false },
      review: { role: "subagent", readOnly: true },
      implementer: { role: "subagent", readOnly: false },
      "test-writer": { role: "subagent", readOnly: false },
    };
    for (const [name, w] of Object.entries(want)) {
      const r = resolveSpecialist(name, cwd, globalDir);
      assert.equal(specialistRole(r.file), w.role, name);
      assert.equal(r.file.read_only === true, w.readOnly, name);
    }
  });

  it("build carries the minimal specialist's settings: low thinking, feedback and gate on", () => {
    const { cwd, globalDir } = sandbox();
    const b = resolveSpecialist("build", cwd, globalDir).file;
    assert.equal(b.thinkingLevel, "low");
    assert.equal(b.feedback?.enabled, true);
    assert.equal(b.gate?.enabled, true);
  });

  it("the three deleted names fail naming their replacement", () => {
    const { cwd, globalDir } = sandbox();
    assert.throws(() => resolveSpecialist("minimal", cwd, globalDir), /build/);
    assert.throws(() => resolveSpecialist("deliberate", cwd, globalDir), /build/);
    assert.throws(() => resolveSpecialist("scout", cwd, globalDir), /explore/);
  });

  it("a user's own file with a deleted name still resolves", () => {
    const { cwd, globalDir } = sandbox();
    mkdirSync(join(cwd, ".lykos", "specialists"), { recursive: true });
    writeFileSync(join(cwd, ".lykos", "specialists", "scout.yaml"), "description: mine\n");
    assert.equal(resolveSpecialist("scout", cwd, globalDir).file.description, "mine");
  });

  it("the default specialist is build", () => {
    assert.equal(DEFAULT_SPECIALIST, "build");
  });
});

describe("T216: Shift+Tab cycles the primary specialists", () => {
  it("lists plan and build and skips explore, general, implementer, review and test-writer", () => {
    const { cwd, globalDir } = sandbox();
    const names = primarySpecialists(cwd, globalDir);
    assert.ok(names.includes("plan"));
    assert.ok(names.includes("build"));
    for (const n of ["explore", "general", "implementer", "review", "test-writer"]) assert.ok(!names.includes(n), n);
  });

  it("includes a user's role: all specialist and excludes their subagent one", () => {
    const { cwd, globalDir } = sandbox();
    mkdirSync(join(cwd, ".lykos", "specialists"), { recursive: true });
    writeFileSync(join(cwd, ".lykos", "specialists", "mine.yaml"), "description: m\n");
    writeFileSync(join(cwd, ".lykos", "specialists", "helper.yaml"), "description: h\nrole: subagent\n");
    const names = primarySpecialists(cwd, globalDir);
    assert.ok(names.includes("mine"));
    assert.ok(!names.includes("helper"));
  });
});
