// T214 acceptance (sealed): read_only and role replace mode, nineteen fields (ADR-0043).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPECIALIST_FIELD_NAMES, resolveSpecialist, specialistRole } from "./specialists.js";
import { INTERACTION_MODES, decideForMode } from "../gate/modes.js";
import { specialistOfTool } from "../delegate/session-protocol.js";

const NONE = new Set<string>();
const bash = (command: string) => ({ kind: "bash" as const, command });

function project(yaml: string, name = "probe"): { cwd: string; globalDir: string; shipped: string } {
  const root = mkdtempSync(join(tmpdir(), "lykos-t214-"));
  const cwd = join(root, "proj");
  const globalDir = join(root, "global");
  const shipped = join(root, "shipped");
  mkdirSync(join(cwd, ".lykos", "specialists"), { recursive: true });
  mkdirSync(globalDir);
  mkdirSync(shipped);
  writeFileSync(join(cwd, ".lykos", "specialists", `${name}.yaml`), yaml);
  return { cwd, globalDir, shipped };
}

describe("T214: the vocabulary", () => {
  it("is nineteen fields: mode gone, read_only and role in", () => {
    assert.equal(SPECIALIST_FIELD_NAMES.length, 19);
    const names = SPECIALIST_FIELD_NAMES as readonly string[];
    assert.ok(names.includes("read_only"));
    assert.ok(names.includes("role"));
    assert.ok(!names.includes("mode"));
  });

  it("a file setting mode fails naming read_only", () => {
    for (const m of ["plan", "ask", "auto", "manual"]) {
      const p = project(`mode: ${m}\n`);
      assert.throws(() => resolveSpecialist("probe", p.cwd, p.globalDir, p.shipped), /read_only/, m);
    }
  });

  it("read_only must be a boolean", () => {
    const p = project("read_only: yes please\n");
    assert.throws(() => resolveSpecialist("probe", p.cwd, p.globalDir, p.shipped), /read_only/);
  });

  it("role is validated and defaults to all", () => {
    const none = project("description: x\n");
    assert.equal(specialistRole(resolveSpecialist("probe", none.cwd, none.globalDir, none.shipped).file), "all");
    for (const r of ["primary", "subagent", "all"] as const) {
      const p = project(`role: ${r}\n`);
      assert.equal(specialistRole(resolveSpecialist("probe", p.cwd, p.globalDir, p.shipped).file), r);
    }
    const bad = project("role: boss\n");
    assert.throws(() => resolveSpecialist("probe", bad.cwd, bad.globalDir, bad.shipped), /role/);
  });
});

describe("T214: read_only is a ceiling no mode lifts", () => {
  it("refuses edit, write and a writing command in every mode, Auto included", () => {
    for (const mode of INTERACTION_MODES) {
      for (const a of [{ kind: "edit" as const }, { kind: "write" as const }, bash("rm -rf build"), bash("echo x > a.txt"), bash("npm install left-pad")]) {
        const d = decideForMode(mode, a, NONE, { readOnly: true });
        assert.equal(d.verdict, "deny", `${mode} ${JSON.stringify(a)}`);
        assert.match(d.reason ?? "", /read.only/i);
      }
    }
  });

  it("still runs reads and read-only commands", () => {
    for (const mode of INTERACTION_MODES) {
      assert.equal(decideForMode(mode, bash("git status"), NONE, { readOnly: true }).verdict, "allow", mode);
      assert.equal(decideForMode(mode, { kind: "read" }, NONE, { readOnly: true }).verdict, "allow", mode);
    }
  });

  it("a remembered approval cannot lift it", () => {
    const allowed = new Set(["npm install"]);
    assert.equal(decideForMode("auto", bash("npm install left-pad"), allowed, { readOnly: true }).verdict, "deny");
  });
});

describe("T214: lykos_review is read-only through its specialist", () => {
  it("names a shipped specialist that is read_only", () => {
    const name = specialistOfTool("lykos_review");
    assert.equal(typeof name, "string");
    const root = mkdtempSync(join(tmpdir(), "lykos-t214-review-"));
    const r = resolveSpecialist(name!, root, join(root, "global"));
    assert.equal(r.file.read_only, true);
  });
});
