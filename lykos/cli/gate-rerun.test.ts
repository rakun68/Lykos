// The session gate reruns the failed test files once, and a test that fails and
// then passes is a flaky test rather than a failed session — unless the session
// edited its file (ADR-0030).
//
// Proven through the scripted-model session (T142), the way T144's
// gate-exit-code tests are: a scripted model edits a file so the gate runs,
// the gate runs REAL `node --test` files in the workspace, and the assertions
// read only what a person could read — the ledger's rows, `lykos show`,
// `lykos doctor`'s line, and stderr.
//
// The flaky test is genuinely flaky: it fails when its marker file is absent
// (creating it), so the first run fails and a rerun of its file passes.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkFlakyTests } from "./doctor.js";
import { call, reply, runScriptedSession, say, type ScriptedSession } from "./scripted-session.js";

/** Fails the first time it runs in a workspace, passes after. */
const FLAKY = `import { it } from "node:test";
import { existsSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
it("flaky once", () => {
  if (!existsSync(".flaky-marker")) {
    writeFileSync(".flaky-marker", "ran");
    assert.fail("fails the first time");
  }
});
`;

const STEADY = `import { it } from "node:test";
it("steady", () => {});
`;

/** Always fails. */
const BROKEN = `import { it } from "node:test";
import assert from "node:assert/strict";
it("always broken", () => { assert.equal(1, 2); });
`;

const gateConfig = (command: string, more = ""): string => `gate:\n  command: ${JSON.stringify(command)}\n${more}`;

/** One edit to `notes.txt` (so the gate grades the session), then the end of the turn. */
function run(opts: {
  files: Record<string, string>;
  config: string;
  /** Rewrite this file instead of notes.txt, making it an edited file. */
  edit?: { path: string; content: string };
}): Promise<ScriptedSession> {
  const target = opts.edit ?? { path: "notes.txt", content: "final\n" };
  return runScriptedSession({
    files: { "notes.txt": "draft\n", ...opts.files },
    config: opts.config,
    script: [reply(call("write", { path: target.path, content: target.content })), reply(say("done"))],
  });
}

const flakyRows = (s: ScriptedSession) =>
  s.query<{ test_file: string; test_name: string; edited_by_session: number; first_exit_code: number; rerun_exit_code: number }>(
    `SELECT test_file, test_name, edited_by_session, first_exit_code, rerun_exit_code FROM flaky_tests WHERE session_id = ?`,
    s.sessionId,
  );

const COMMAND = "node --test flaky.test.mjs steady.test.mjs";

describe("the session gate's rerun of failed test files (T167)", () => {
  it("a test that fails and then passes on rerun records success, and the flaky test is named in the ledger, `lykos show` and on screen", async () => {
    const s = await run({
      files: { "flaky.test.mjs": FLAKY, "steady.test.mjs": STEADY },
      config: gateConfig(COMMAND),
    });
    assert.equal(s.result.status, "ok", JSON.stringify(s.result));

    const row = s.session();
    assert.equal(row.outcome, "success");
    assert.equal(row.outcome_source, "verification_command");
    assert.equal(row.verification_exit_code, 1, "the gate command's own exit code is kept, not rewritten");
    assert.match(String(row.verification_output), /rerun of the failed test files \(exit 0\): node --test flaky\.test\.mjs/);

    assert.deepEqual(flakyRows(s), [
      { test_file: "flaky.test.mjs", test_name: "flaky once", edited_by_session: 0, first_exit_code: 1, rerun_exit_code: 0 },
    ]);

    const shown = s.show();
    assert.match(shown, /verdict\s+success \(source=verification_command\)/);
    assert.match(shown, / flaky\s+1 test failed, then passed on rerun \(exit 1 → 0\)/);
    assert.match(shown, /- flaky\.test\.mjs: flaky once\n/);
    assert.match(shown, / rerun\s+`node --test flaky\.test\.mjs`/);

    assert.match(s.stderr, /FAILED \(exit 1\); rerun of 1 failed test file PASSED \(exit 0\) — flaky: flaky\.test\.mjs: flaky once/);
    assert.match(s.stderr, /recorded as outcome=success/);

    assert.match(checkFlakyTests(s.ledgerPath).label, /^1 flaky test recorded across 1 session /);
    assert.equal(checkFlakyTests(s.ledgerPath).status, "warn");
  });

  it("a test that fails on the rerun too records fail, with no flaky test", async () => {
    const s = await run({
      files: { "broken.test.mjs": BROKEN, "steady.test.mjs": STEADY },
      config: gateConfig("node --test broken.test.mjs steady.test.mjs"),
    });
    const row = s.session();
    assert.equal(row.outcome, "fail");
    assert.equal(row.verification_exit_code, 1);
    assert.match(String(row.verification_output), /rerun of the failed test files \(exit 1\)/);
    assert.deepEqual(flakyRows(s), []);

    assert.doesNotMatch(s.show(), / flaky /);
    assert.match(s.stderr, /FAILED \(exit 1\); rerun of 1 failed test file FAILED again \(exit 1\) — recorded as outcome=fail/);
    assert.equal(checkFlakyTests(s.ledgerPath).status, "ok");
  });

  it("a flaky test in a file the session edited records fail — and is still named", async () => {
    const s = await run({
      files: { "flaky.test.mjs": "import { it } from 'node:test';\nit('flaky once', () => {});\n", "steady.test.mjs": STEADY },
      config: gateConfig(COMMAND),
      // The session rewrites the flaky test: a session must not pass by writing a test that sometimes passes.
      edit: { path: "flaky.test.mjs", content: FLAKY },
    });
    const row = s.session();
    assert.equal(row.outcome, "fail");
    assert.equal(row.verification_exit_code, 1);
    assert.deepEqual(flakyRows(s), [
      { test_file: "flaky.test.mjs", test_name: "flaky once", edited_by_session: 1, first_exit_code: 1, rerun_exit_code: 0 },
    ]);
    const shown = s.show();
    assert.match(shown, /verdict\s+fail /);
    assert.match(shown, /- flaky\.test\.mjs: flaky once {2}\[file edited this session/);
    assert.match(s.stderr, /rerun of 1 failed test file PASSED \(exit 0\), but a flaky test is in a file this session edited \(flaky\.test\.mjs\)/);
  });

  it("a flaky test in a file rewritten through `bash`, which the trace cannot see, still records fail", async () => {
    const s = await runScriptedSession({
      files: {
        "notes.txt": "draft\n",
        "flaky.test.mjs": "import { it } from 'node:test';\nit('flaky once', () => {});\n",
        "flaky.src": FLAKY,
        "steady.test.mjs": STEADY,
        "make-flaky.cjs": "require('fs').copyFileSync('flaky.src', 'flaky.test.mjs');\n",
      },
      config: gateConfig(COMMAND),
      script: [
        reply(call("bash", { command: "node make-flaky.cjs" })),
        reply(call("write", { path: "notes.txt", content: "final\n" })),
        reply(say("done")),
      ],
    });
    assert.equal(s.result.status, "ok", JSON.stringify(s.result));
    const row = s.session();
    assert.equal(row.outcome, "fail");
    assert.deepEqual(flakyRows(s), [
      { test_file: "flaky.test.mjs", test_name: "flaky once", edited_by_session: 1, first_exit_code: 1, rerun_exit_code: 0 },
    ]);
    assert.match(s.stderr, /but a flaky test is in a file this session edited \(flaky\.test\.mjs\)/);
  });

  it("output that names no failed file is not rerun: the first verdict stands", async () => {
    // Exits 1 and prints nothing a test reporter would.
    const s = await run({ files: {}, config: gateConfig(`node -e "console.error('nope'); process.exit(1)"`) });
    const row = s.session();
    assert.equal(row.outcome, "fail");
    assert.doesNotMatch(String(row.verification_output), /rerun/);
    assert.deepEqual(flakyRows(s), []);
    assert.doesNotMatch(s.stderr, /rerun/);
  });

  it("a failure the listing does not show is not rerun around: counts that do not add up leave the first verdict", async () => {
    // node:test counts a TEST that failed because its subtest did, but lists only the subtest.
    // The listing names the flaky file and the child, yet the summary counts one more failure.
    const parent = `import { it } from "node:test";
import assert from "node:assert/strict";
it("parent", async (t) => { await t.test("child", () => { assert.fail("always"); }); });
`;
    const s = await run({
      files: { "flaky.test.mjs": FLAKY, "parent.test.mjs": parent },
      config: gateConfig("node --test flaky.test.mjs parent.test.mjs"),
    });
    const row = s.session();
    assert.equal(row.outcome, "fail");
    assert.doesNotMatch(String(row.verification_output), /rerun of the failed test files/);
    assert.deepEqual(flakyRows(s), []);
    assert.doesNotMatch(s.stderr, /rerun of/);
  });

  it("gate.rerun_failures: false turns the rerun off", async () => {
    const s = await run({
      files: { "flaky.test.mjs": FLAKY, "steady.test.mjs": STEADY },
      config: gateConfig(COMMAND, "  rerun_failures: false\n"),
    });
    const row = s.session();
    assert.equal(row.outcome, "fail", "the flaky test fails the session, as it did before T167");
    assert.equal(row.verification_exit_code, 1);
    assert.deepEqual(flakyRows(s), []);
    assert.equal(s.file(".flaky-marker"), "ran", "it ran once; a rerun would have passed");
  });

  it("no derivable command and no override: no rerun", async () => {
    // A script that is not one plain `node --test`: the gate cannot rewrite it.
    const s = await run({
      files: { "flaky.test.mjs": FLAKY },
      config: gateConfig("node --test flaky.test.mjs && node -e 0"),
    });
    assert.equal(s.session().outcome, "fail");
    assert.deepEqual(flakyRows(s), []);
    assert.doesNotMatch(String(s.session().verification_output), /rerun of/);
  });

  it("gate.rerun_command with {files} overrides the derived command", async () => {
    // The gate command is not derivable (`&&`); the override supplies the rerun.
    const s = await run({
      files: { "flaky.test.mjs": FLAKY, "steady.test.mjs": STEADY },
      config: gateConfig(
        "node --test flaky.test.mjs steady.test.mjs && node -e 0",
        `  rerun_command: "node --test --test-reporter=spec {files}"\n`,
      ),
    });
    const row = s.session();
    assert.equal(row.outcome, "success");
    assert.match(String(row.verification_output), /node --test --test-reporter=spec flaky\.test\.mjs ---/);
    assert.equal(flakyRows(s).length, 1);
  });

  it("a config whose rerun_command lacks {files} is refused by name", async () => {
    const s = await run({
      files: { "steady.test.mjs": STEADY },
      config: gateConfig(COMMAND, `  rerun_command: "node --test"\n`),
    }).catch((err: unknown) => err);
    // Either the run reports the config error or the harness throws it; both say why.
    const text = s instanceof Error ? s.message : JSON.stringify((s as ScriptedSession).result);
    assert.match(text, /gate\.rerun_command must contain \{files\}/);
  });

  it("a gate that passes the first time is never rerun and records no flaky test", async () => {
    const s = await run({ files: { "steady.test.mjs": STEADY }, config: gateConfig("node --test steady.test.mjs") });
    assert.equal(s.session().outcome, "success");
    assert.equal(s.session().verification_exit_code, 0);
    assert.deepEqual(flakyRows(s), []);
    assert.doesNotMatch(s.show(), / flaky /);
    assert.match(checkFlakyTests(s.ledgerPath).label, /no flaky tests/);
  });
});
