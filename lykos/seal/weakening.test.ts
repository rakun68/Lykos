// Unit tests for weakening scan diff parsing and scanning logic (T202).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDiffWeakening, type WeakeningMatch } from "./weakening.js";
import { DEFAULT_SEAL_WEAKENING_PATTERNS } from "../config/defaults.js";

describe("weakening scan parseDiffWeakening", () => {
  it("detects default patterns on added lines with correct line numbers", () => {
    const diff = [
      "diff --git a/test/sub.test.mjs b/test/sub.test.mjs",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/test/sub.test.mjs",
      "@@ -0,0 +1,5 @@",
      '+import { it } from "node:test";',
      '+it.skip("test 1", () => {});',
      '+it.only("test 2", () => {});',
      '+xit("test 3", () => {});',
      "+export const x = 1;",
    ].join("\n");

    const matches: WeakeningMatch[] = [];
    parseDiffWeakening(
      diff,
      "feat",
      DEFAULT_SEAL_WEAKENING_PATTERNS,
      () => false,
      (m) => matches.push(m),
    );

    assert.equal(matches.length, 3);
    assert.deepEqual(matches[0], {
      branch: "feat",
      file: "test/sub.test.mjs",
      line: 2,
      pattern: ".skip(",
    });
    assert.deepEqual(matches[1], {
      branch: "feat",
      file: "test/sub.test.mjs",
      line: 3,
      pattern: ".only(",
    });
    assert.deepEqual(matches[2], {
      branch: "feat",
      file: "test/sub.test.mjs",
      line: 4,
      pattern: "xit(",
    });
  });

  it("detects all NODE_ENV test check forms", () => {
    const diff = [
      "--- a/src/env.mjs",
      "+++ b/src/env.mjs",
      "@@ -10,1 +10,4 @@",
      '-export const a = 0;',
      '+const a = NODE_ENV === "test";',
      "+const b = NODE_ENV === 'test';",
      '+const c = NODE_ENV == "test";',
      "+const d = NODE_ENV == 'test';",
    ].join("\n");

    const matches: WeakeningMatch[] = [];
    parseDiffWeakening(
      diff,
      "feat",
      DEFAULT_SEAL_WEAKENING_PATTERNS,
      () => false,
      (m) => matches.push(m),
    );

    assert.equal(matches.length, 4);
    assert.equal(matches[0]!.line, 10);
    assert.equal(matches[0]!.pattern, 'NODE_ENV === "test"');
    assert.equal(matches[1]!.line, 11);
    assert.equal(matches[1]!.pattern, "NODE_ENV === 'test'");
    assert.equal(matches[2]!.line, 12);
    assert.equal(matches[2]!.pattern, 'NODE_ENV == "test"');
    assert.equal(matches[3]!.line, 13);
    assert.equal(matches[3]!.pattern, "NODE_ENV == 'test'");
  });

  it("ignores deleted lines and context lines containing patterns", () => {
    const diff = [
      "--- a/src/safe.mjs",
      "+++ b/src/safe.mjs",
      "@@ -5,3 +5,1 @@",
      '-it.skip("deleted old test", () => {});',
      '-xit("deleted old xit", () => {});',
      '+const active = true;',
    ].join("\n");

    const matches: WeakeningMatch[] = [];
    parseDiffWeakening(
      diff,
      "feat",
      DEFAULT_SEAL_WEAKENING_PATTERNS,
      () => false,
      (m) => matches.push(m),
    );

    assert.equal(matches.length, 0);
  });

  it("skips excluded files such as .lykos and sealed files", () => {
    const diff = [
      "--- /dev/null",
      "+++ b/.lykos/internal.mjs",
      "@@ -0,0 +1,1 @@",
      '+it.skip("internal", () => {});',
      "--- /dev/null",
      "+++ b/test/sealed.test.mjs",
      "@@ -0,0 +1,1 @@",
      '+it.skip("sealed", () => {});',
    ].join("\n");

    const matches: WeakeningMatch[] = [];
    parseDiffWeakening(
      diff,
      "feat",
      DEFAULT_SEAL_WEAKENING_PATTERNS,
      (f) => f.startsWith(".lykos/") || f === "test/sealed.test.mjs",
      (m) => matches.push(m),
    );

    assert.equal(matches.length, 0);
  });

  it("handles added lines starting with ++ without skipping or shifting line numbers", () => {
    const diff = [
      "diff --git a/src/counter.mjs b/src/counter.mjs",
      "--- a/src/counter.mjs",
      "+++ b/src/counter.mjs",
      "@@ -1,2 +1,4 @@",
      " const x = 0;",
      "+++count;",
      "+it.skip('weak', () => {});",
      " export { x };",
    ].join("\n");

    const matches: WeakeningMatch[] = [];
    parseDiffWeakening(
      diff,
      "feat",
      DEFAULT_SEAL_WEAKENING_PATTERNS,
      () => false,
      (m) => matches.push(m),
    );

    assert.equal(matches.length, 1);
    assert.deepEqual(matches[0], {
      branch: "feat",
      file: "src/counter.mjs",
      line: 3,
      pattern: ".skip(",
    });
  });
});
