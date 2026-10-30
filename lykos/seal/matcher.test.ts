import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchAnyGlob, matchGlob } from "./matcher.js";
import { DEFAULT_ALWAYS_SEALED, DEFAULT_TEST_GLOBS } from "../config/defaults.js";

describe("seal matcher", () => {
  it("matches test globs", () => {
    assert.ok(matchAnyGlob("test/add.test.mjs", DEFAULT_TEST_GLOBS));
    assert.ok(matchAnyGlob("src/math.test.ts", DEFAULT_TEST_GLOBS));
    assert.ok(matchAnyGlob("src/math.spec.js", DEFAULT_TEST_GLOBS));
    assert.ok(matchAnyGlob("tests/sub/a.js", DEFAULT_TEST_GLOBS));
    assert.ok(matchAnyGlob("src/__tests__/b.ts", DEFAULT_TEST_GLOBS));
    assert.ok(!matchAnyGlob("src/add.mjs", DEFAULT_TEST_GLOBS));
  });

  it("matches always_sealed globs", () => {
    assert.ok(matchAnyGlob("fixtures/sample.json", DEFAULT_ALWAYS_SEALED));
    assert.ok(matchAnyGlob("test/fixtures/sample.json", DEFAULT_ALWAYS_SEALED));
    assert.ok(matchAnyGlob("vitest.config.ts", DEFAULT_ALWAYS_SEALED));
    assert.ok(matchAnyGlob("vitest.setup.js", DEFAULT_ALWAYS_SEALED));
    assert.ok(matchAnyGlob("jest.config.json", DEFAULT_ALWAYS_SEALED));
    assert.ok(matchAnyGlob(".mocharc.yaml", DEFAULT_ALWAYS_SEALED));
    assert.ok(matchAnyGlob("__snapshots__/snap.json", DEFAULT_ALWAYS_SEALED));
    assert.ok(!matchAnyGlob("src/add.mjs", DEFAULT_ALWAYS_SEALED));
  });
});
