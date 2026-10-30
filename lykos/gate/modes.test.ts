import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { INTERACTION_MODES, MODE_INFO, decideForMode, isInteractionMode, nextMode } from "./modes.js";

const NO_ALLOWLIST = new Set<string>();

describe("the mode roster", () => {
  it("cycles Manual -> Accept Edits -> Auto -> Manual", () => {
    assert.deepEqual([...INTERACTION_MODES], ["manual", "accept-edits", "auto"]);
    assert.equal(nextMode("manual"), "accept-edits");
    assert.equal(nextMode("accept-edits"), "auto");
    assert.equal(nextMode("auto"), "manual");
  });

  it("gives every mode a label and a one-line description", () => {
    for (const mode of INTERACTION_MODES) {
      const info = MODE_INFO[mode];
      assert.ok(info.label.length > 0, mode);
      assert.ok(info.description.length > 0, mode);
    }
  });

  it("recognises exactly the three names", () => {
    for (const mode of INTERACTION_MODES) assert.equal(isInteractionMode(mode), true);
    // The old vocabulary must NOT silently resolve: "auto-edit", "plan", and "ask" are gone.
    assert.equal(isInteractionMode("auto-edit"), false);
    assert.equal(isInteractionMode("acceptEdits"), false);
    assert.equal(isInteractionMode("plan"), false);
    assert.equal(isInteractionMode("ask"), false);
    assert.equal(isInteractionMode(""), false);
  });
});

describe("Manual", () => {
  it("asks before a write or an edit", () => {
    assert.equal(decideForMode("manual", { kind: "write" }, NO_ALLOWLIST).verdict, "ask");
    assert.equal(decideForMode("manual", { kind: "edit" }, NO_ALLOWLIST).verdict, "ask");
  });

  it("allows read-only commands without asking", () => {
    assert.equal(decideForMode("manual", { kind: "bash", command: "git status" }, NO_ALLOWLIST).verdict, "allow");
  });

  it("ignores the allowlist entirely", () => {
    const allow = new Set(["npm test"]);
    assert.equal(decideForMode("manual", { kind: "bash", command: "npm test" }, allow).verdict, "ask");
  });
});

describe("Accept Edits", () => {
  it("approves reads, edits, and writes outright", () => {
    assert.equal(decideForMode("accept-edits", { kind: "read" }, NO_ALLOWLIST).verdict, "allow");
    assert.equal(decideForMode("accept-edits", { kind: "edit" }, NO_ALLOWLIST).verdict, "allow");
    assert.equal(decideForMode("accept-edits", { kind: "write" }, NO_ALLOWLIST).verdict, "allow");
  });

  it("approves mkdir, touch, mv, cp commands and read-only commands", () => {
    assert.equal(decideForMode("accept-edits", { kind: "bash", command: "mkdir src/new" }, NO_ALLOWLIST).verdict, "allow");
    assert.equal(decideForMode("accept-edits", { kind: "bash", command: "touch file.txt" }, NO_ALLOWLIST).verdict, "allow");
    assert.equal(decideForMode("accept-edits", { kind: "bash", command: "mv a b" }, NO_ALLOWLIST).verdict, "allow");
    assert.equal(decideForMode("accept-edits", { kind: "bash", command: "cp a b" }, NO_ALLOWLIST).verdict, "allow");
    assert.equal(decideForMode("accept-edits", { kind: "bash", command: "git status" }, NO_ALLOWLIST).verdict, "allow");
  });

  it("asks before file removals (rm, git clean) and other commands", () => {
    assert.equal(decideForMode("accept-edits", { kind: "bash", command: "rm file.txt" }, NO_ALLOWLIST).verdict, "ask");
    assert.equal(decideForMode("accept-edits", { kind: "bash", command: "git clean -fd" }, NO_ALLOWLIST).verdict, "ask");
    assert.equal(decideForMode("accept-edits", { kind: "bash", command: "npm test" }, NO_ALLOWLIST).verdict, "ask");
  });
});

describe("Auto", () => {
  it("approves writes and edits outright", () => {
    assert.equal(decideForMode("auto", { kind: "write" }, NO_ALLOWLIST).verdict, "allow");
    assert.equal(decideForMode("auto", { kind: "edit" }, NO_ALLOWLIST).verdict, "allow");
  });

  it("runs read-only commands without asking", () => {
    assert.equal(decideForMode("auto", { kind: "bash", command: "git status" }, NO_ALLOWLIST).verdict, "allow");
  });

  it("asks once for ordinary work, and offers to remember it", () => {
    const d = decideForMode("auto", { kind: "bash", command: "npm test" }, NO_ALLOWLIST);
    assert.equal(d.verdict, "ask");
    assert.equal(d.offerAlways, true);
    assert.deepEqual(d.patterns, ["npm test"]);
  });

  it("stops asking once the pattern is remembered", () => {
    const allow = new Set(["npm test"]);
    assert.equal(decideForMode("auto", { kind: "bash", command: "npm test" }, allow).verdict, "allow");
    assert.equal(decideForMode("auto", { kind: "bash", command: "npm test -- --watch" }, allow).verdict, "allow");
  });

  it("still asks before a destructive command, and refuses to remember it", () => {
    const allow = new Set(["rm", "rm -rf", "git push"]);
    const d = decideForMode("auto", { kind: "bash", command: "rm -rf node_modules" }, allow);
    assert.equal(d.verdict, "ask", "an allowlist entry must never silence rm -rf");
    assert.equal(d.offerAlways, false);
    assert.equal(d.risk, "destructive");
  });
});

describe("permission modes prompt or allow, never deny outright", () => {
  it("returns allow or ask for every mode and action", () => {
    for (const mode of INTERACTION_MODES) {
      for (const action of [
        { kind: "write" } as const,
        { kind: "edit" } as const,
        { kind: "bash", command: "npm test" } as const,
        { kind: "bash", command: "rm -rf x" } as const,
      ]) {
        const d = decideForMode(mode, action, NO_ALLOWLIST);
        assert.notEqual(d.verdict, "deny");
        assert.ok(d.verdict === "allow" || d.verdict === "ask");
      }
    }
  });
});
