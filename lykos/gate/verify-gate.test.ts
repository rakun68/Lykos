import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildRerunHook,
  buildTaskVerifier,
  discoverGateCommand,
  renderGateOutcome,
  renderGateStart,
  resolveGatePolicy,
  runSessionGate,
  verdictEventOf,
  type GateOutcome,
  type GatePolicy,
} from "./verify-gate.js";
import type { CommandRunner } from "../loop/post-edit.js";
import { Ledger } from "../ledger/ledger.js";
import type { VerificationRun } from "../session/verify-outcome.js";
import { LykosExtensionHost } from "../extensions/api.js";

function tempProject(pkg: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-gate-"));
  if (pkg !== undefined) writeFileSync(join(dir, "package.json"), JSON.stringify(pkg), "utf8");
  return dir;
}

const policy = (over: Partial<GatePolicy> = {}): GatePolicy => ({
  enabled: true,
  command: "npm test",
  timeoutMs: 900_000,
  gateReadOnlySessions: false,
  rerunFailures: true,
  rerunCommand: undefined,
  cwd: "/repo",
  ...over,
});

const runner =
  (result: { exitCode: number | null; output?: string; problem?: string }): CommandRunner =>
  async () => ({
    exitCode: result.exitCode,
    output: result.output ?? "",
    ms: 5,
    ...(result.problem !== undefined ? { problem: result.problem } : {}),
  });

describe("discoverGateCommand", () => {
  it("is the same answer T52 offers a human, so the two never disagree", () => {
    const dir = tempProject({ scripts: { test: "node --test" } });
    try {
      assert.equal(discoverGateCommand(dir), "npm test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when the project declares no test script", () => {
    const dir = tempProject({ scripts: { build: "tsc" } });
    try {
      assert.equal(discoverGateCommand(dir), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveGatePolicy", () => {
  it("lets configuration win over discovery", () => {
    const dir = tempProject({ scripts: { test: "node --test" } });
    try {
      assert.equal(resolveGatePolicy(dir, { command: "make check" }).command, "make check");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not gate read-only sessions unless asked to", () => {
    const dir = tempProject({});
    try {
      assert.equal(resolveGatePolicy(dir).gateReadOnlySessions, false);
      assert.equal(resolveGatePolicy(dir, { gate_read_only_sessions: true }).gateReadOnlySessions, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildTaskVerifier — the gate at step granularity", () => {
  const item = { id: 1, text: "make it pass", status: "in_progress" as const, verify: "npm test" };

  it("passes on exit 0 and fails on anything else", async () => {
    const pass = await buildTaskVerifier({ cwd: "/repo", run: runner({ exitCode: 0 }) })(item);
    assert.equal(pass.ok, true);
    const fail = await buildTaskVerifier({ cwd: "/repo", run: runner({ exitCode: 1, output: "2 failing" }) })(item);
    assert.equal(fail.ok, false);
    assert.match(fail.output, /2 failing/);
  });

  it("does NOT block a step when the command could not run at all", async () => {
    // Refusing `done` here would trap the model behind a broken command it
    // did not write and cannot fix — the same reason T52 records NULL rather
    // than `fail` for a verification command that never started.
    const result = await buildTaskVerifier({
      cwd: "/repo",
      run: runner({ exitCode: null, problem: "spawn ENOENT" }),
    })(item);
    assert.equal(result.ok, true);
    assert.match(result.output, /could not run/);
  });

  it("clamps a huge failure so one step cannot flood the context", async () => {
    const result = await buildTaskVerifier({
      cwd: "/repo",
      maxOutputBytes: 300,
      run: runner({ exitCode: 1, output: `HEAD${"z".repeat(40_000)}TAIL` }),
    })(item);
    assert.ok(result.output.length < 500);
    assert.match(result.output, /HEAD/);
    assert.match(result.output, /TAIL/);
  });
});

describe("runSessionGate — the gate at task granularity", () => {
  const base = { sessionId: "sess-1", ledgerPath: ":memory:", edited: true };

  it("records a success when the command passes", async () => {
    const result = await runSessionGate({
      ...base,
      policy: policy(),
      verify: async (cmd) => ({ status: "recorded", outcome: "success", cmd, exitCode: 0 }),
    });
    assert.deepEqual(result, { status: "recorded", outcome: "success", cmd: "npm test", exitCode: 0 });
  });

  it("says it is starting before a command that can take minutes, and only then", async () => {
    // P4 demo run 1 (2026-10-05): the gate ran `npm test` for minutes with
    // nothing on screen, and the process was gone before the verdict.
    const order: string[] = [];
    await runSessionGate({
      ...base,
      policy: policy(),
      onStart: (cmd) => order.push(`start ${cmd}`),
      verify: async (cmd) => {
        order.push(`verify ${cmd}`);
        return { status: "recorded", outcome: "success", cmd, exitCode: 0 };
      },
    });
    assert.deepEqual(order, ["start npm test", "verify npm test"]);
    let started = false;
    await runSessionGate({ ...base, edited: false, policy: policy(), onStart: () => (started = true) });
    assert.equal(started, false, "a gate that will not run does not announce itself");
  });

  it("names the command, the time limit, and that the terminal must stay open", () => {
    const line = renderGateStart("npm test", 900_000);
    assert.match(line, /`npm test`/);
    assert.match(line, /15 min/);
    assert.match(line, /keep this terminal open/);
  });

  it("does not run for a session that edited nothing", async () => {
    let ran = false;
    const result = await runSessionGate({
      ...base,
      edited: false,
      policy: policy(),
      verify: async (cmd) => {
        ran = true;
        return { status: "recorded", outcome: "success", cmd, exitCode: 0 };
      },
    });
    assert.equal(ran, false, "grading a read-only conversation says something about the repo, not the session");
    assert.equal(result.status, "skipped");
    assert.match((result as { reason: string }).reason, /edited no files/);
  });

  it("gates a read-only session when the project asks it to", async () => {
    let ran = false;
    await runSessionGate({
      ...base,
      edited: false,
      policy: policy({ gateReadOnlySessions: true }),
      verify: async (cmd) => {
        ran = true;
        return { status: "recorded", outcome: "success", cmd, exitCode: 0 };
      },
    });
    assert.equal(ran, true);
  });

  it("skips, and says why, when there is no command to run", async () => {
    const result = await runSessionGate({ ...base, policy: policy({ command: undefined }) });
    assert.equal(result.status, "skipped");
    assert.match((result as { reason: string }).reason, /no verification command/);
  });

  it("skips entirely when the gate is off", async () => {
    const result = await runSessionGate({ ...base, policy: policy({ enabled: false }) });
    assert.equal(result.status, "skipped");
    assert.match((result as { reason: string }).reason, /off in config/);
  });

  it("runs registered gate checks even when the gate is off", async () => {
    const dir = tempProject(undefined);
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const sessionId = ledger.startSession({ brief: "test task", harnessCommit: "abc" });
    ledger.close();

    const host = new LykosExtensionHost({ cwd: dir, gate: { request: async () => "deny" } });
    host.install({
      name: "blocking-check",
      register: (api) => {
        api.registerGateCheck(async () => ({ block: true, reason: "custom policy blocked" }));
      },
    });

    const result = await runSessionGate({
      ...base,
      sessionId,
      ledgerPath,
      extensionHost: host,
      policy: policy({ enabled: false, cwd: dir }),
    });

    assert.equal(result.status, "recorded");
    assert.equal(result.outcome, "fail");
    assert.equal(result.cmd, "(gate check)");

    const readLedger = Ledger.open(ledgerPath);
    const sessionRow = readLedger.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as {
      outcome: string;
      verification_output: string;
    };
    readLedger.close();
    assert.equal(sessionRow?.outcome, "fail");
    assert.match(sessionRow?.verification_output ?? "", /custom policy blocked/);

    rmSync(dir, { recursive: true, force: true });
  });

  it("stays skipped when gate is off and registered gate check passes", async () => {
    const dir = tempProject(undefined);
    const host = new LykosExtensionHost({ cwd: dir, gate: { request: async () => "deny" } });
    host.install({
      name: "passing-check",
      register: (api) => {
        api.registerGateCheck(async () => ({ pass: true }));
      },
    });

    const result = await runSessionGate({
      ...base,
      extensionHost: host,
      policy: policy({ enabled: false, cwd: dir }),
    });

    assert.equal(result.status, "skipped");
    assert.match((result as { reason: string }).reason, /off in config/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs registered gate checks even when the verification command exits non-zero, recording the block reason", async () => {
    const dir = tempProject(undefined);
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const sessionId = ledger.startSession({ brief: "test task", harnessCommit: "abc" });
    ledger.close();

    const host = new LykosExtensionHost({ cwd: dir, gate: { request: async () => "deny" } });
    host.install({
      name: "seal-check",
      register: (api) => {
        api.registerGateCheck(async () => ({ block: true, reason: "tampered test/add.test.mjs" }));
      },
    });

    const result = await runSessionGate({
      ...base,
      sessionId,
      ledgerPath,
      extensionHost: host,
      policy: policy({ enabled: true, command: 'node -e "process.exit(1)"', cwd: dir }),
    });

    assert.equal(result.status, "recorded");
    assert.equal(result.outcome, "fail");

    const readLedger = Ledger.open(ledgerPath);
    const sessionRow = readLedger.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as {
      outcome: string;
      verification_output: string;
    };
    readLedger.close();
    assert.equal(sessionRow?.outcome, "fail");
    assert.match(sessionRow?.verification_output ?? "", /tampered test\/add\.test\.mjs/);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("renderGateOutcome", () => {
  it("names the command, because a verdict nobody can attribute gets ignored", () => {
    const passed: GateOutcome = { status: "recorded", outcome: "success", cmd: "npm test", exitCode: 0 };
    assert.match(renderGateOutcome(passed), /`npm test` PASSED \(exit 0\)/);
    assert.match(renderGateOutcome(passed), /source=verification_command/);
  });

  it("reports a skip as a skip rather than as a failure", () => {
    assert.match(renderGateOutcome({ status: "skipped", reason: "the session edited no files" }), /not run/);
  });
});

describe("runSessionGate — the configured timeout reaches the command (D9)", () => {
  it("stops a command at gate.timeout_seconds rather than the built-in fifteen minutes", async () => {
    const dir = tempProject(undefined);
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const sessionId = ledger.startSession({ brief: "t", harnessCommit: "test", executionShape: "standalone" });
    ledger.endSession({ id: sessionId });
    ledger.close();
    try {
      const started = Date.now();
      const result = await runSessionGate({
        sessionId,
        ledgerPath,
        edited: true,
        policy: { ...resolveGatePolicy(dir, { command: `node -e "setTimeout(() => {}, 60000)"`, timeout_seconds: 1 }) },
      });
      assert.ok(Date.now() - started < 30_000, "the one-second setting must bound the run");
      assert.equal(result.status, "recorded");
      assert.equal((result as { outcome: string }).outcome, "fail", "a run the timeout stopped did not pass");
      assert.equal((result as { signal?: string }).signal, "SIGTERM");
      assert.match(renderGateOutcome(result), /FAILED \(timed out after 1s \(SIGTERM\)\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// T167 (ADR-0030): the rerun of failed test files
// ---------------------------------------------------------------------------

describe("resolveGatePolicy — the rerun settings (T167)", () => {
  it("reruns by default, with no override", () => {
    const p = resolveGatePolicy("/repo", {});
    assert.equal(p.rerunFailures, true);
    assert.equal(p.rerunCommand, undefined);
  });

  it("gate.rerun_failures: false switches it off; an empty rerun_command means derive", () => {
    assert.equal(resolveGatePolicy("/repo", { rerun_failures: false }).rerunFailures, false);
    assert.equal(resolveGatePolicy("/repo", { rerun_command: "  " }).rerunCommand, undefined);
    assert.equal(resolveGatePolicy("/repo", { rerun_command: "run {files}" }).rerunCommand, "run {files}");
  });
});

describe("buildRerunHook — what the gate reruns, and when it does not (T167)", () => {
  const SUMMARY = (tests: number, pass: number, fail: number, cancelled = 0): string =>
    [`ℹ tests ${tests}`, "ℹ suites 0", `ℹ pass ${pass}`, `ℹ fail ${fail}`, `ℹ cancelled ${cancelled}`, "ℹ skipped 0"].join("\n");
  const FAILING = [
    SUMMARY(5, 3, 2),
    "",
    "✖ failing tests:",
    "",
    "test at lykos\\tools\\lsp.test.ts:464:3",
    "✖ rename across files (12.3ms)",
    "  Error: EPERM",
    "",
    "test at lykos/gate/a.test.ts:9:1",
    "✖ another (1.0ms)",
  ].join("\n");
  const first = (output: string): VerificationRun => ({ cmd: "npm test", exitCode: 1, output });
  const present = (_path: string): boolean => true;

  /** A runner that records what it was asked to run. */
  function fakeRun(exitCode: number | null, output = SUMMARY(2, 2, 0), spawnError?: string) {
    const calls: Array<{ cmd: string; cwd: string; timeoutMs: number }> = [];
    const run = async (cmd: string, cwd: string, timeoutMs: number): Promise<VerificationRun> => {
      calls.push({ cmd, cwd, timeoutMs });
      return { cmd, exitCode, output, ...(spawnError !== undefined ? { spawnError } : {}) };
    };
    return { run, calls };
  }

  function projectWithScript(script: string): string {
    return tempProject({ scripts: { test: script } });
  }

  it("reruns only the failed files, derived from the test script, and names every failed test as flaky when the rerun passes", async () => {
    const dir = projectWithScript(`tsx --test "lykos/**/*.test.ts"`);
    try {
      const { run, calls } = fakeRun(0);
      const hook = buildRerunHook({ policy: policy({ cwd: dir, timeoutMs: 5000 }), editedFiles: [], run, exists: present });
      const report = await hook(first(FAILING));
      assert.deepEqual(calls, [
        { cmd: "npx --no-install tsx --test lykos/tools/lsp.test.ts lykos/gate/a.test.ts", cwd: dir, timeoutMs: 5000 },
      ]);
      assert.equal(report?.exitCode, 0);
      assert.deepEqual(report?.files, ["lykos/tools/lsp.test.ts", "lykos/gate/a.test.ts"]);
      assert.deepEqual(report?.flaky, [
        { file: "lykos/tools/lsp.test.ts", name: "rename across files", editedBySession: false },
        { file: "lykos/gate/a.test.ts", name: "another", editedBySession: false },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks a flaky test whose file the session edited — by exact path, with either separator, or under an edited directory", async () => {
    const dir = projectWithScript("node --test");
    try {
      const { run } = fakeRun(0);
      const hook = buildRerunHook({
        policy: policy({ cwd: dir }),
        editedFiles: ["lykos\\tools\\lsp.test.ts", "lykos/gate"],
        run,
        exists: present,
      });
      const report = await hook(first(FAILING));
      assert.deepEqual(
        report?.flaky.map((f) => [f.file, f.editedBySession]),
        [
          ["lykos/tools/lsp.test.ts", true],
          ["lykos/gate/a.test.ts", true],
        ],
      );
      const other = buildRerunHook({ policy: policy({ cwd: dir }), editedFiles: ["lykos/gates/x.ts"], run, exists: present });
      assert.ok(
        (await other(first(FAILING)))?.flaky.every((f) => !f.editedBySession),
        "a sibling directory with a shared prefix is not an edited directory",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a rerun that fails again names no flaky test", async () => {
    const dir = projectWithScript("node --test");
    try {
      const { run } = fakeRun(1);
      const report = await buildRerunHook({ policy: policy({ cwd: dir }), editedFiles: [], run, exists: present })(first(FAILING));
      assert.equal(report?.exitCode, 1);
      assert.deepEqual(report?.flaky, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a rerun that could not start is reported as such, with no flaky tests", async () => {
    const dir = projectWithScript("node --test");
    try {
      const { run } = fakeRun(null, "", "spawn ENOENT");
      const report = await buildRerunHook({ policy: policy({ cwd: dir }), editedFiles: [], run, exists: present })(first(FAILING));
      assert.equal(report?.spawnError, "spawn ENOENT");
      assert.deepEqual(report?.flaky, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not rerun: unparseable output, rerun_failures off, a missing file, or no derivable command and no override", async () => {
    const dir = projectWithScript("node --test");
    const typecheckFirst = projectWithScript("npm run typecheck && tsx --test");
    const noScript = tempProject({});
    try {
      const { run, calls } = fakeRun(0);
      const hook = (over: Partial<GatePolicy>, exists = present) =>
        buildRerunHook({ policy: policy({ cwd: dir, ...over }), editedFiles: [], run, exists });
      assert.equal(await hook({})(first("1 failing\n")), undefined, "unparseable output");
      assert.equal(await hook({ rerunFailures: false })(first(FAILING)), undefined, "switched off");
      assert.equal(await hook({}, (p) => !p.includes("a.test.ts"))(first(FAILING)), undefined, "a failed file that is not in the project");
      assert.equal(await hook({ cwd: typecheckFirst })(first(FAILING)), undefined, "a script that is not one plain test run");
      assert.equal(await hook({ cwd: noScript })(first(FAILING)), undefined, "no test script at all");
      assert.deepEqual(calls, [], "none of these ran anything");
    } finally {
      for (const d of [dir, typecheckFirst, noScript]) rmSync(d, { recursive: true, force: true });
    }
  });

  it("does not rerun when the summary counts more failures than were parsed, or cannot be read", async () => {
    const dir = projectWithScript("node --test");
    try {
      const { run, calls } = fakeRun(0);
      const hook = buildRerunHook({ policy: policy({ cwd: dir }), editedFiles: [], run, exists: present });
      const listing = FAILING.slice(FAILING.indexOf("✖ failing tests:"));
      // Two parsed, three counted: one failure the parser did not see.
      assert.equal(await hook(first(SUMMARY(5, 2, 3) + "\n\n" + listing)), undefined, "a failure the parser missed");
      assert.equal(await hook(first(SUMMARY(5, 3, 1, 2) + "\n\n" + listing)), undefined, "cancelled tests count too");
      assert.equal(await hook(first(listing)), undefined, "no summary at all");
      assert.equal(await hook(first(SUMMARY(5, 3, 2) + "\n" + SUMMARY(5, 3, 2) + "\n\n" + listing)), undefined, "two summaries are ambiguous");
      assert.deepEqual(calls, [], "none of these ran anything");
      // Listed suites beyond the count (an after-hook failure: fail 0) are fine: the parsed set covers the count.
      assert.ok(await hook(first(SUMMARY(5, 5, 0) + "\n\n" + listing)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a rerun that exits 0 but ran nothing, or shows no passing tests, names no flaky test", async () => {
    const dir = projectWithScript("node --test");
    try {
      const outputs = [
        ["tests 0", SUMMARY(0, 0, 0)],
        ["no summary", "all good\n"],
        ["fewer passes than failed tests", SUMMARY(1, 1, 0)],
        ["a failure inside", SUMMARY(2, 1, 1)],
        ["a cancellation inside", SUMMARY(2, 1, 0, 1)],
      ] as const;
      for (const [label, output] of outputs) {
        const { run } = fakeRun(0, output);
        const report = await buildRerunHook({ policy: policy({ cwd: dir }), editedFiles: [], run, exists: present })(first(FAILING));
        assert.equal(report?.exitCode, 0, label);
        assert.deepEqual(report?.flaky, [], label);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a configured rerun_command wins, even where nothing could be derived", async () => {
    const dir = projectWithScript("npm run typecheck && tsx --test");
    try {
      const { run, calls } = fakeRun(0);
      const hook = buildRerunHook({
        policy: policy({ cwd: dir, rerunCommand: "npx vitest run {files}" }),
        editedFiles: [],
        run,
        exists: present,
      });
      await hook(first(FAILING));
      assert.equal(calls[0]?.cmd, "npx vitest run lykos/tools/lsp.test.ts lykos/gate/a.test.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runSessionGate — a rerun reaches the event, the ledger and the screen (T167)", () => {
  /** A project with one genuinely flaky node:test file; the marker makes its first run fail. */
  function flakyProject(): string {
    const dir = tempProject({ scripts: { test: "node --test flaky.test.mjs" } });
    writeFileSync(
      join(dir, "flaky.test.mjs"),
      [
        `import { it } from "node:test";`,
        `import { existsSync, writeFileSync } from "node:fs";`,
        `import assert from "node:assert/strict";`,
        `it("flaky once", () => {`,
        `  if (!existsSync(".marker")) { writeFileSync(".marker", "x"); assert.fail("first run"); }`,
        `});`,
        ``,
      ].join("\n"),
    );
    return dir;
  }

  it("verification_verdict carries the flaky tests and both exit codes", async () => {
    const dir = flakyProject();
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const sessionId = ledger.startSession({ brief: "t", harnessCommit: "test", executionShape: "standalone" });
    ledger.endSession({ id: sessionId });
    ledger.close();
    const seen: Array<{ event: string; payload: unknown }> = [];
    try {
      const result = await runSessionGate({
        sessionId,
        ledgerPath,
        edited: true,
        editedFiles: ["notes.txt"],
        policy: resolveGatePolicy(dir, {}),
        events: { emit: (event, payload) => void seen.push({ event, payload }) },
      });
      assert.equal(result.status, "recorded");
      assert.deepEqual(seen, [
        {
          event: "verification_verdict",
          payload: {
            status: "recorded",
            outcome: "success",
            command: "npm test",
            exitCode: 1,
            rerun: {
              command: "node --test flaky.test.mjs",
              exitCode: 0,
              flakyTests: [{ file: "flaky.test.mjs", name: "flaky once", editedBySession: false }],
            },
          },
        },
      ]);
      const line = renderGateOutcome(result);
      assert.match(line, /FAILED \(exit 1\); rerun of 1 failed test file PASSED \(exit 0\) — flaky: flaky\.test\.mjs: flaky once/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a rerun that exits 0 with no tests recorded is a fail, with no flaky rows", async () => {
    const dir = flakyProject();
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const sessionId = ledger.startSession({ brief: "t", harnessCommit: "test", executionShape: "standalone" });
    ledger.endSession({ id: sessionId });
    ledger.close();
    try {
      // The rerun is a command that exits 0 and runs no tests at all.
      const result = await runSessionGate({
        sessionId,
        ledgerPath,
        edited: true,
        policy: resolveGatePolicy(dir, { rerun_command: `node -e "process.exit(0)" {files}` }),
      });
      assert.equal(result.status, "recorded");
      assert.equal((result as { outcome: string }).outcome, "fail");
      assert.match(renderGateOutcome(result), /exited 0 but its summary did not show the failed tests passing/);
      const check = Ledger.open(ledgerPath);
      try {
        assert.equal(check.flakyTests(sessionId).length, 0);
        const row = check.db.prepare(`SELECT outcome, verification_output FROM sessions WHERE id = ?`).get(sessionId) as {
          outcome: string;
          verification_output: string;
        };
        assert.equal(row.outcome, "fail");
        assert.match(row.verification_output, /exit 0, but its summary does not show the failed tests passing/);
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a verdict with no rerun carries none, so a listener can tell the two apart", () => {
    const plain = verdictEventOf({ status: "recorded", outcome: "fail", cmd: "npm test", exitCode: 1 });
    assert.equal("rerun" in plain, false);
  });
});

describe("the ledger accepts success beside a non-zero exit code only for a cleared rerun (T167)", () => {
  function fresh() {
    const dir = tempProject(undefined);
    const ledger = Ledger.open(join(dir, "ledger.db"));
    const id = ledger.startSession({ brief: "t", harnessCommit: "test", executionShape: "standalone" });
    return { dir, ledger, id };
  }
  const flaky = (editedBySession: boolean) => [{ file: "a.test.ts", name: "x", editedBySession }];

  it("accepts it, and writes the flaky rows in the same step", () => {
    const { dir, ledger, id } = fresh();
    try {
      ledger.recordOutcome({
        id,
        outcome: "success",
        outcomeSource: "verification_command",
        verificationExitCode: 1,
        rerun: { command: "node --test a.test.ts", exitCode: 0, flaky: flaky(false) },
      });
      assert.equal(ledger.flakyTests(id).length, 1);
      assert.deepEqual(ledger.flakyTestCount(), { tests: 1, sessions: 1 });
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses it for a rerun that failed, one with no flaky test, one in an edited file, or none at all — and writes nothing", () => {
    const cases = [
      { exitCode: 1, flaky: flaky(false) },
      { exitCode: 0, flaky: [] },
      { exitCode: 0, flaky: flaky(true) },
    ];
    for (const c of cases) {
      const { dir, ledger, id } = fresh();
      try {
        assert.throws(
          () =>
            ledger.recordOutcome({
              id,
              outcome: "success",
              outcomeSource: "verification_command",
              verificationExitCode: 1,
              rerun: { command: "x", ...c },
            }),
          /refuses exit code 1/,
        );
        assert.equal(ledger.flakyTests(id).length, 0);
        const row = ledger.db.prepare(`SELECT outcome FROM sessions WHERE id = ?`).get(id) as { outcome: string | null };
        assert.equal(row.outcome, null);
      } finally {
        ledger.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const { dir, ledger, id } = fresh();
    try {
      assert.throws(
        () => ledger.recordOutcome({ id, outcome: "success", outcomeSource: "verification_command", verificationExitCode: 1 }),
        /refuses exit code 1/,
      );
    } finally {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an older ledger gains the table when opened, empty — nothing is backfilled", () => {
    const { dir, ledger } = fresh();
    const path = join(dir, "ledger.db");
    ledger.db.exec(`DROP TABLE flaky_tests`);
    ledger.close();
    const reopened = Ledger.open(path);
    try {
      assert.deepEqual(reopened.flakyTestCount(), { tests: 0, sessions: 0 });
    } finally {
      reopened.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
