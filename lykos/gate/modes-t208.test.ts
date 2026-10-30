// T208 acceptance (sealed): three permission modes, Manual, Accept Edits and Auto (ADR-0041).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { INTERACTION_MODES, decideForMode, isInteractionMode, parseInteractionMode } from "./modes.js";
import { modeOfTool, specialistOfTool } from "../delegate/session-protocol.js";

const NONE = new Set<string>();
const bash = (command: string) => ({ kind: "bash" as const, command });

describe("T208: the three permission modes", () => {
  it("are exactly manual, accept-edits and auto", () => {
    assert.deepEqual([...INTERACTION_MODES].sort(), ["accept-edits", "auto", "manual"]);
    for (const m of ["manual", "accept-edits", "auto"]) assert.equal(isInteractionMode(m), true, m);
  });

  it("reject plan and ask, naming the read_only replacement", () => {
    for (const old of ["plan", "ask"]) {
      assert.equal(isInteractionMode(old), false, old);
      const parsed = parseInteractionMode(old);
      assert.equal(parsed.ok, false, old);
      if (!parsed.ok) assert.match(parsed.error, /read_only/, old);
    }
    const good = parseInteractionMode("accept-edits");
    assert.deepEqual(good, { ok: true, mode: "accept-edits" });
  });

  it("Manual runs reads and asks before everything else", () => {
    assert.equal(decideForMode("manual", { kind: "read" }, NONE).verdict, "allow");
    assert.equal(decideForMode("manual", bash("git status"), NONE).verdict, "allow");
    assert.equal(decideForMode("manual", { kind: "edit" }, NONE).verdict, "ask");
    assert.equal(decideForMode("manual", { kind: "write" }, NONE).verdict, "ask");
    assert.equal(decideForMode("manual", bash("mkdir build"), NONE).verdict, "ask");
  });

  it("Accept Edits approves reads, edits, mkdir, touch, mv and cp", () => {
    for (const a of [{ kind: "read" as const }, { kind: "edit" as const }, { kind: "write" as const }]) {
      assert.equal(decideForMode("accept-edits", a, NONE).verdict, "allow", a.kind);
    }
    for (const c of ["mkdir -p build/out", "touch notes.md", "mv a.ts b.ts", "cp a.ts b.ts", "git status"]) {
      assert.equal(decideForMode("accept-edits", bash(c), NONE).verdict, "allow", c);
    }
  });

  it("Accept Edits asks before removing a file and before any other command", () => {
    for (const c of ["rm a.ts", "rm -rf build", "git clean -fd", "frobnicate --now", "npm install left-pad"]) {
      assert.equal(decideForMode("accept-edits", bash(c), NONE).verdict, "ask", c);
    }
  });

  it("Auto approves edits and asks before a destructive command", () => {
    assert.equal(decideForMode("auto", { kind: "edit" }, NONE).verdict, "allow");
    assert.equal(decideForMode("auto", bash("rm -rf build"), NONE).verdict, "ask");
  });

  it("no mode denies outright: denial belongs to read_only and path rules", () => {
    for (const m of INTERACTION_MODES) {
      assert.notEqual(decideForMode(m, { kind: "edit" }, NONE).verdict, "deny", m);
    }
  });
});

describe("T208: delegated tools", () => {
  it("every MCP tool maps to one of the three modes", () => {
    for (const t of ["lykos_implement", "lykos_refactor", "lykos_debug", "lykos_review"]) {
      assert.equal(isInteractionMode(modeOfTool(t)), true, t);
    }
  });

  it("lykos_review names its review specialist, the others name none", () => {
    assert.equal(specialistOfTool("lykos_review"), "review");
    assert.equal(specialistOfTool("lykos_implement"), undefined);
  });
});
