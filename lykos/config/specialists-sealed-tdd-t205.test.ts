// T205 (#60) ACCEPTANCE: sealed TDD works on the day Lykos is installed.
// The shipped library gains `test-writer` and `implementer`, and `lykos init`
// scaffolds a `sealed-tdd` skill. All three are plain files a project overrides.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSpecialists, resolveSpecialist, shippedSpecialistsDir } from "./specialists.js";
import { scaffoldLykosDir } from "./scaffold.js";
import { SHIPPED_DEFAULTS } from "./defaults.js";

function freshProject(): { cwd: string; globalDir: string } {
  const root = mkdtempSync(join(tmpdir(), "lykos-t205-"));
  const cwd = join(root, "proj");
  const globalDir = join(root, "global");
  mkdirSync(cwd);
  mkdirSync(globalDir);
  return { cwd, globalDir };
}

const lf = (s: string) => s.replace(/\r\n/g, "\n");
const sha = (path: string) => createHash("sha256").update(lf(readFileSync(path, "utf8"))).digest("hex");

describe("T205 ACCEPTANCE: the shipped sealed-TDD library", () => {
  it("a fresh install lists test-writer and implementer beside the five shipped specialists", () => {
    const p = freshProject();
    const names = discoverSpecialists(p.cwd, p.globalDir).map((s) => s.name);
    for (const n of ["test-writer", "implementer", "build", "explore", "general", "plan", "review"]) {
      assert.ok(names.includes(n), `${n} is listed: ${names.join(", ")}`);
    }
  });

  it("both resolve from the shipped library, can write, and have a description", () => {
    const p = freshProject();
    for (const n of ["test-writer", "implementer"]) {
      const r = resolveSpecialist(n, p.cwd, p.globalDir);
      assert.ok(r.path.startsWith(shippedSpecialistsDir()), `${n} comes from the shipped library: ${r.path}`);
      assert.notEqual(r.file.read_only, true, `${n} must be able to write`);
      assert.ok((r.file.description ?? "").length > 0, `${n} has a description`);
      assert.ok((r.file.instructions ?? "").length > 0, `${n} has instructions`);
    }
  });

  it("the implementer is told to dispute a wrong test rather than work around it", () => {
    const p = freshProject();
    const r = resolveSpecialist("implementer", p.cwd, p.globalDir);
    assert.match(r.file.instructions ?? "", /dispute_test/);
  });

  it("the test writer is told to write failing tests and commit them", () => {
    const p = freshProject();
    const r = resolveSpecialist("test-writer", p.cwd, p.globalDir);
    assert.match(r.file.instructions ?? "", /fail/i);
    assert.match(r.file.instructions ?? "", /commit/i);
  });

  it("lykos-seal's default writers and enforce_for match the shipped names", () => {
    const p = freshProject();
    const names = new Set(discoverSpecialists(p.cwd, p.globalDir).map((s) => s.name));
    assert.deepEqual(SHIPPED_DEFAULTS.seal.writers, ["test-writer"]);
    assert.deepEqual(SHIPPED_DEFAULTS.seal.enforce_for, ["implementer"]);
    for (const n of [...SHIPPED_DEFAULTS.seal.writers, ...SHIPPED_DEFAULTS.seal.enforce_for]) {
      assert.ok(names.has(n), `${n} is a shipped specialist`);
    }
  });

  it("a project file of the same name overrides each specialist", () => {
    const p = freshProject();
    mkdirSync(join(p.cwd, ".lykos", "specialists"), { recursive: true });
    for (const n of ["test-writer", "implementer"]) {
      writeFileSync(join(p.cwd, ".lykos", "specialists", `${n}.yaml`), `description: project ${n}\ninstructions: mine\n`);
      const r = resolveSpecialist(n, p.cwd, p.globalDir);
      assert.equal(r.file.description, `project ${n}`);
      assert.equal(r.file.instructions, "mine");
    }
  });

  it("build and the other shipped specialists are unchanged", () => {
    const dir = shippedSpecialistsDir();
    const expected: Record<string, string> = {
      "build.yaml": "49b0e88c4514501ae63d7b69d62b412410b5ac3553be4a77b8553e8518460809",
      "explore.yaml": "991b1788518c511424ff91662e9295e2316926f16415f52d3f184e5bb2e5a6ef",
      "general.yaml": "fd47d51fbb4dc88329029cba67fa34f3f5b0616a75f5dd2df4e1b069d7ceb318",
      "plan.yaml": "79d6c42b41fbaf8331f63702f773fb8837ba4a36ff1deeeb7340fae8a6ed273e",
      "review.yaml": "39d12340966c03f3ce018932ba93d81ba704bb350f36514b52f42b6a58d7dead",
    };
    for (const [file, hash] of Object.entries(expected)) {
      assert.equal(sha(join(dir, file)), hash, `${file} changed`);
    }
  });
});

describe("T205 ACCEPTANCE: the sealed-tdd skill", () => {
  it("lykos init scaffolds a sealed-tdd skill describing the loop", () => {
    const p = freshProject();
    scaffoldLykosDir(p.cwd);
    const skills = readdirSync(join(p.cwd, ".lykos", "skills"), { recursive: true }).map(String);
    const skill = skills.find((f) => /sealed-tdd/.test(f) && /\.md$/.test(f));
    assert.ok(skill, `a sealed-tdd skill is scaffolded: ${skills.join(", ")}`);
    const text = readFileSync(join(p.cwd, ".lykos", "skills", skill), "utf8");
    for (const word of [/test-writer/, /implementer/, /dispute_test/, /seal/]) {
      assert.match(text, word);
    }
  });

  it("a project's own sealed-tdd skill is kept, not overwritten", () => {
    const p = freshProject();
    scaffoldLykosDir(p.cwd);
    const skills = readdirSync(join(p.cwd, ".lykos", "skills"), { recursive: true }).map(String);
    const skill = skills.find((f) => /sealed-tdd/.test(f) && /\.md$/.test(f));
    assert.ok(skill);
    const path = join(p.cwd, ".lykos", "skills", skill);
    writeFileSync(path, "my own loop\n");
    scaffoldLykosDir(p.cwd);
    assert.equal(readFileSync(path, "utf8"), "my own loop\n");
  });
});
