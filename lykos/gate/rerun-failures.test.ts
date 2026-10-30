import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveRerunCommand,
  failedFilesToRerun,
  failuresAccountedFor,
  gateRerunCommandProblem,
  parseFailedTests,
  parseTestSummary,
  renderRerunCommand,
  rerunShowsPass,
  scriptOfGateCommand,
  tokenizeCommand,
} from "./rerun-failures.js";

// The failing-tests section of node:test's spec reporter, as `npm test` prints
// it off a terminal on Node 24 (captured 2026-10-05, then trimmed; the failing
// locations are the shape the P4 demonstration's EPERM flake printed).
const SPEC_OUTPUT = `✔ passes (0.5917ms)
✖ rename across files (12.3ms)
✖ suite one (3.3561ms)
ℹ tests 8
ℹ fail 3

✖ failing tests:

test at lykos\\tools\\lsp.test.ts:464:3
✖ rename across files (12.3ms)
  Error: EPERM: operation not permitted, rmdir 'C:\\Temp\\x'
      at TestContext.<anonymous> (C:\\Workspace\\Projects\\Lykos\\lykos\\tools\\lsp.test.ts:470:9)

test at lykos/gate/verify-gate.test.ts:12:1
✖ top-level fail (0.1725ms)
  Error: boom

test at lykos\\tools\\lsp.test.ts:500:5
✖ second failure in the same file (4.1ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal

test at crash.test.ts:1:1
✖ crash.test.ts (305.0141ms)
  'test failed'
`;

describe("parseFailedTests — node:test's spec reporter", () => {
  it("reads the failing-tests section: backslash and slash paths, one entry per test, the duration dropped", () => {
    assert.deepEqual(parseFailedTests(SPEC_OUTPUT), [
      { file: "lykos/tools/lsp.test.ts", name: "rename across files" },
      { file: "lykos/gate/verify-gate.test.ts", name: "top-level fail" },
      { file: "lykos/tools/lsp.test.ts", name: "second failure in the same file" },
      { file: "crash.test.ts", name: "crash.test.ts" },
    ]);
  });

  it("does not list the suite lines above the section, only the leaf failures it reports", () => {
    const names = parseFailedTests(SPEC_OUTPUT).map((t) => t.name);
    assert.ok(!names.includes("suite one"));
  });

  it("strips colour codes", () => {
    const coloured = "\u001b[31m✖ failing tests:\u001b[39m\n\ntest at a.test.ts:3:1\n\u001b[31m✖ it breaks (1.2ms)\u001b[39m\n";
    assert.deepEqual(parseFailedTests(coloured), [{ file: "a.test.ts", name: "it breaks" }]);
  });

  it("makes an absolute path relative to cwd, and leaves one outside cwd absolute", () => {
    const out = "test at C:\\repo\\lykos\\a.test.ts:3:1\n✖ inside (1ms)\n\ntest at C:\\elsewhere\\b.test.ts:1:1\n✖ outside (1ms)\n";
    const parsed = parseFailedTests(out, "C:\\repo");
    // Only meaningful where C:\ paths are absolute; on posix both stay as printed.
    if (process.platform === "win32") {
      assert.deepEqual(parsed, [
        { file: "lykos/a.test.ts", name: "inside" },
        { file: "C:/elsewhere/b.test.ts", name: "outside" },
      ]);
    } else {
      assert.equal(parsed.length, 2);
    }
  });

  it("a test name with colons, quotes and parentheses survives", () => {
    const out = "test at c.test.ts:3:1\n✖ c with 'quotes' and: colon (and parens) (4.1027ms)\n";
    assert.deepEqual(parseFailedTests(out), [{ file: "c.test.ts", name: "c with 'quotes' and: colon (and parens)" }]);
  });

  it("is empty for a passing run, for the dot reporter and for output that is not a test run at all", () => {
    assert.deepEqual(parseFailedTests("✔ passes (1ms)\nℹ tests 1\nℹ pass 1\nℹ fail 0\n"), []);
    assert.deepEqual(parseFailedTests("..F.\n1 failing\n"), []);
    assert.deepEqual(parseFailedTests("npm ERR! Missing script: \"test\"\n"), []);
    assert.deepEqual(parseFailedTests(""), []);
  });

  it("a location line not followed by a failing-test line yields nothing", () => {
    assert.deepEqual(parseFailedTests("test at a.test.ts:1:1\nsome other line\n"), []);
  });
});

describe("parseFailedTests — node:test's tap reporter", () => {
  const TAP = `TAP version 13
# Subtest: parent
    # Subtest: child fails
    not ok 1 - child fails
      ---
      duration_ms: 0.5328
      type: 'test'
      location: 'C:\\\\repo\\\\lykos\\\\subt.test.ts:2:37'
      failureType: 'testCodeFailure'
      error: 'c'
      code: 'ERR_TEST_FAILURE'
      ...
    1..1
not ok 1 - parent
  ---
  duration_ms: 1.4536
  type: 'test'
  location: 'C:\\\\repo\\\\lykos\\\\subt.test.ts:2:1'
  failureType: 'subtestsFailed'
  error: '1 subtest failed'
  code: 'ERR_TEST_FAILURE'
  ...
ok 2 - fine
  ---
  location: 'C:\\\\repo\\\\lykos\\\\fine.test.ts:1:1'
  ...
1..2
`;

  it("names the failed leaf, not the parent that failed only because of it", () => {
    const parsed = parseFailedTests(TAP, process.platform === "win32" ? "C:\\repo" : undefined);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.name, "child fails");
    assert.match(parsed[0]!.file, /lykos\/subt\.test\.ts$/);
  });
});

describe("failedFilesToRerun", () => {
  const exists = (path: string): boolean => !path.includes("missing");

  it("lists each failed file once, in order", () => {
    assert.deepEqual(
      failedFilesToRerun(
        [
          { file: "a.test.ts", name: "one" },
          { file: "b/c.test.ts", name: "two" },
          { file: "a.test.ts", name: "three" },
        ],
        "/repo",
        exists,
      ),
      ["a.test.ts", "b/c.test.ts"],
    );
  });

  it("refuses when nothing parsed, so the first verdict stands", () => {
    assert.equal(failedFilesToRerun([], "/repo", exists), undefined);
  });

  it("refuses when ANY failure is in a file that is not in the project — a partial rerun would hide it", () => {
    assert.equal(
      failedFilesToRerun(
        [
          { file: "a.test.ts", name: "one" },
          { file: "missing.test.ts", name: "two" },
        ],
        "/repo",
        exists,
      ),
      undefined,
    );
    assert.equal(failedFilesToRerun([{ file: "../outside.test.ts", name: "x" }], "/repo", exists), undefined);
  });
});

describe("tokenizeCommand", () => {
  it("splits on whitespace and honours quotes", () => {
    assert.deepEqual(tokenizeCommand(`tsx --test "lykos/**/*.test.ts" 'a b'`), ["tsx", "--test", "lykos/**/*.test.ts", "a b"]);
  });

  it("refuses anything that is more than one plain command", () => {
    for (const bad of ["a && b", "a; b", "a | b", "a > out", "a `b`", "a $(b)", "a 'unterminated"]) {
      assert.equal(tokenizeCommand(bad), undefined, bad);
    }
  });
});

describe("deriveRerunCommand — only from a plain node --test / tsx --test script", () => {
  const files = ["lykos/tools/lsp.test.ts", "lykos/gate/a b.test.ts"];

  it("this repo's script: tsx --test with a quoted glob becomes the project's tsx on the failed files", () => {
    assert.equal(
      deriveRerunCommand(`tsx --test "lykos/**/*.test.ts"`, files),
      `npx --no-install tsx --test lykos/tools/lsp.test.ts "lykos/gate/a b.test.ts"`,
    );
  });

  it("keeps every flag and its value, in order, and drops the globs", () => {
    assert.equal(
      deriveRerunCommand(`node --import tsx --test-concurrency=4 --test --test-reporter spec "src/**/*.test.js"`, ["src/a.test.js"]),
      "node --import tsx --test-concurrency=4 --test --test-reporter spec src/a.test.js",
    );
  });

  it("node --test with no globs gets the files appended", () => {
    assert.equal(deriveRerunCommand("node --test", ["a.test.js"]), "node --test a.test.js");
  });

  it("accepts npx tsx, with or without --no-install", () => {
    assert.equal(deriveRerunCommand("npx tsx --test src/", ["a.test.ts"]), "npx --no-install tsx --test a.test.ts");
    assert.equal(deriveRerunCommand("npx --no-install tsx --test src/", ["a.test.ts"]), "npx --no-install tsx --test a.test.ts");
  });

  it("refuses scripts that are not one plain test run", () => {
    for (const script of [
      "npm run typecheck && tsx --test src/",
      "FOO=1 node --test",
      "node --test | tee out",
      "node --test --watch",
      "node --eval 1 --test",
      "vitest run",
      "jest",
      "node script.js", // no --test
      "tsx src/run.ts",
      "node --import", // a value flag with no value
    ]) {
      assert.equal(deriveRerunCommand(script, files), undefined, script);
    }
  });

  it("derives nothing for no files", () => {
    assert.equal(deriveRerunCommand("node --test", []), undefined);
  });
});

describe("renderRerunCommand — gate.rerun_command", () => {
  it("substitutes the failed files for {files}", () => {
    assert.equal(renderRerunCommand("npx vitest run {files}", ["a.test.ts", "b c.test.ts"]), `npx vitest run a.test.ts "b c.test.ts"`);
  });

  it("is undefined without a placeholder, and for a file that cannot be quoted", () => {
    assert.equal(renderRerunCommand("npx vitest run", ["a.test.ts"]), undefined);
    assert.equal(renderRerunCommand("run {files}", ['we"ird.test.ts']), undefined);
  });
});

describe("scriptOfGateCommand and gateRerunCommandProblem", () => {
  it("npm test stands for the project's test script; any other command is its own script", () => {
    assert.equal(scriptOfGateCommand("npm test", "tsx --test x"), "tsx --test x");
    assert.equal(scriptOfGateCommand("npm run test", "node --test"), "node --test");
    assert.equal(scriptOfGateCommand("npm test", undefined), undefined);
    assert.equal(scriptOfGateCommand("node --test a.js", "ignored"), "node --test a.js");
  });

  it("an override must carry {files}; empty means derive", () => {
    assert.equal(gateRerunCommandProblem(""), undefined);
    assert.equal(gateRerunCommandProblem(undefined), undefined);
    assert.equal(gateRerunCommandProblem("run {files}"), undefined);
    assert.match(gateRerunCommandProblem("run all") ?? "", /must contain \{files\}/);
    assert.match(gateRerunCommandProblem(3) ?? "", /must be a string/);
  });
});

// Summaries as node:test 24.11 printed them (2026-10-05).
const spec = (tests: number, suites: number, pass: number, fail: number, cancelled: number): string =>
  `ℹ tests ${tests}\nℹ suites ${suites}\nℹ pass ${pass}\nℹ fail ${fail}\nℹ cancelled ${cancelled}\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 3.2\n`;

describe("parseTestSummary and the two checks built on it", () => {
  it("reads spec and tap counts, and refuses what it cannot read with certainty", () => {
    assert.deepEqual(parseTestSummary(spec(8, 1, 2, 5, 0)), { tests: 8, pass: 2, fail: 5, cancelled: 0 });
    assert.deepEqual(parseTestSummary("# tests 2\n# suites 0\n# pass 0\n# fail 2\n# cancelled 0\n"), {
      tests: 2,
      pass: 0,
      fail: 2,
      cancelled: 0,
    });
    assert.equal(parseTestSummary("ℹ tests 2\nℹ pass 2\n"), undefined, "a count missing");
    assert.equal(parseTestSummary(spec(1, 0, 1, 0, 0) + spec(1, 0, 1, 0, 0)), undefined, "two summaries");
    assert.equal(parseTestSummary(""), undefined);
  });

  const one = [{ file: "a.test.ts", name: "x" }];

  it("failures are accounted for when the parsed ones cover fail + cancelled", () => {
    assert.equal(failuresAccountedFor(one, parseTestSummary(spec(2, 0, 1, 1, 0))), true);
    // A failing suite is listed but not counted (describe + leaf: parsed 2, fail 1).
    assert.equal(failuresAccountedFor([...one, { file: "a.test.ts", name: "suite" }], parseTestSummary(spec(2, 1, 1, 1, 0))), true);
    // A suite whose after hook threw is listed, and `fail` is 0.
    assert.equal(failuresAccountedFor(one, parseTestSummary(spec(2, 1, 2, 0, 0))), true);
    // A cancelled test is listed and counted as cancelled.
    assert.equal(failuresAccountedFor(one, parseTestSummary(spec(2, 0, 1, 0, 1))), true);
  });

  it("they are not when the reporter counted more, or could not be read", () => {
    assert.equal(failuresAccountedFor(one, parseTestSummary(spec(3, 0, 1, 2, 0))), false);
    // A TEST that failed because a subtest did is counted in fail and not listed: refused, not guessed.
    assert.equal(failuresAccountedFor(one, parseTestSummary(spec(4, 1, 1, 3, 0))), false);
    assert.equal(failuresAccountedFor(one, parseTestSummary(spec(2, 0, 0, 0, 2))), false);
    assert.equal(failuresAccountedFor(one, undefined), false);
  });

  it("a rerun shows a pass only with tests run, no failure or cancellation, and enough passes", () => {
    assert.equal(rerunShowsPass(parseTestSummary(spec(2, 0, 2, 0, 0)), 2), true);
    assert.equal(rerunShowsPass(parseTestSummary(spec(0, 0, 0, 0, 0)), 1), false, "tests 0");
    assert.equal(rerunShowsPass(undefined, 1), false, "no summary");
    assert.equal(rerunShowsPass(parseTestSummary(spec(2, 0, 1, 1, 0)), 1), false, "a failure");
    assert.equal(rerunShowsPass(parseTestSummary(spec(2, 0, 1, 0, 1)), 1), false, "a cancellation");
    assert.equal(rerunShowsPass(parseTestSummary(spec(1, 0, 1, 0, 0)), 2), false, "fewer passes than tests vouched for");
  });
});
