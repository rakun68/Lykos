import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Ledger } from "../ledger/ledger.js";
import { standInExecutor } from "./scripted-executor.js";
import { killProcessTree } from "../tools/job-runner.js";
import { osProcessAlive, waitForOsProcess } from "../tools/process-probe.js";
import {
  clampVerificationOutput,
  parseVerifyAnswer,
  resolveSessionId,
  runVerificationCommand,
  runVerify,
} from "./verify.js";

let dir: string;
let ledgerPath: string;

/** A real on-disk ledger with one ended session, as `lykos run` leaves it. */
function seedSession(opts: { outcome?: "success" | "fail" | "abandoned" } = {}): string {
  const ledger = Ledger.open(ledgerPath);
  try {
    const id = ledger.startSession({ brief: "a real task", harnessCommit: "test", executionShape: "standalone" });
    ledger.recordCall({
      sessionId: id,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 1000, output: 100, cacheRead: 500, cacheWrite: 0 },
      ts: new Date(),
    });
    ledger.endSession({ id, ...(opts.outcome !== undefined ? { outcome: opts.outcome } : {}) });
    return id;
  } finally {
    ledger.close();
  }
}

function readSession(id: string) {
  const ledger = Ledger.open(ledgerPath);
  try {
    return ledger.db
      .prepare(`SELECT outcome, outcome_source, verification_cmd, verification_output, verification_exit_code FROM sessions WHERE id = ?`)
      .get(id) as {
      outcome: string | null;
      outcome_source: string | null;
      verification_cmd: string | null;
      verification_output: string | null;
      verification_exit_code: number | null;
    };
  } finally {
    ledger.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lykos-verify-"));
  ledgerPath = join(dir, "ledger.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("T52.2 ACCEPTANCE: a session closes as success via a verification command", () => {
  it("a passing command records success with outcome_source=verification_command, and the command itself", async () => {
    const id = seedSession();
    const result = await runVerify(id, {
      ledgerPath,
      cwd: dir,
      answer: { kind: "command", cmd: "node -e \"process.exit(0)\"" },
    });
    assert.equal(result.status, "recorded");
    assert.equal(result.status === "recorded" && result.outcome, "success");
    assert.equal(result.status === "recorded" && result.outcomeSource, "verification_command");
    const row = readSession(id);
    assert.equal(row.outcome, "success");
    assert.equal(row.outcome_source, "verification_command");
    assert.match(row.verification_cmd!, /process\.exit\(0\)/);
  });

  it("ACCEPTANCE: a FAILING verification command records fail, not success", async () => {
    const id = seedSession();
    const result = await runVerify(id, {
      ledgerPath,
      cwd: dir,
      answer: { kind: "command", cmd: "node -e \"console.log('nope'); process.exit(3)\"" },
    });
    assert.equal(result.status === "recorded" && result.outcome, "fail");
    assert.equal(result.status === "recorded" && result.run?.exitCode, 3);
    const row = readSession(id);
    assert.equal(row.outcome, "fail");
    assert.equal(row.outcome_source, "verification_command");
    assert.match(row.verification_output!, /nope/);
  });

  it("T176: a command that a signal killed records fail, not NULL, and the ledger says which signal", async () => {
    const id = seedSession();
    const { executor } = standInExecutor(() => ({ exitCode: null, signal: "SIGKILL", stdout: "1..40\nok 1\n" }));
    const result = await runVerify(id, { ledgerPath, cwd: dir, answer: { kind: "command", cmd: "npm test" }, executor });
    assert.equal(result.status === "recorded" && result.outcome, "fail");
    const row = readSession(id);
    assert.equal(row.outcome, "fail");
    assert.match(row.verification_output!, /killed by SIGKILL/);
    assert.equal(row.verification_exit_code, 137, "128 + SIGKILL, never NULL for a command that ran");
  });

  it("T176: a rerun cannot clear a run a signal killed", async () => {
    const id = seedSession();
    const { executor } = standInExecutor(() => ({ exitCode: null, signal: "SIGKILL" }));
    let asked = 0;
    const result = await runVerify(id, {
      ledgerPath,
      cwd: dir,
      answer: { kind: "command", cmd: "npm test" },
      executor,
      rerunFailures: async () => {
        asked += 1;
        return { cmd: "npm test x", files: ["a.test.ts"], exitCode: 0, output: "", flaky: [{ file: "a.test.ts", name: "t", editedBySession: false }] };
      },
    });
    assert.equal(asked, 0, "a killed run is not rerun");
    assert.equal(result.status === "recorded" && result.outcome, "fail");
    assert.equal(readSession(id).outcome, "fail");
  });

  it("a command that cannot RUN records nothing — a missing command is not a failing task", async () => {
    const id = seedSession();
    const result = await runVerify(id, {
      ledgerPath,
      cwd: dir,
      // Exits non-zero on every shell, but through the shell's own
      // "command not found" rather than the task's verdict.
      answer: { kind: "command", cmd: "lykos-no-such-command-exists-anywhere --please" },
    });
    // Either the shell reports not-found as a non-zero exit (recorded as a
    // fail, which is the shell's honest answer) or spawn itself failed
    // (recorded as nothing). What must never happen is `success`.
    assert.notEqual(result.status === "recorded" && result.outcome, "success");
    assert.notEqual(readSession(id).outcome, "success");
  });

  it("ACCEPTANCE: declining records NULL", async () => {
    const id = seedSession();
    const result = await runVerify(id, { ledgerPath, cwd: dir, answer: { kind: "skip" } });
    assert.equal(result.status, "skipped");
    const row = readSession(id);
    assert.equal(row.outcome, null);
    assert.equal(row.outcome_source, null);
  });

  it("a person's yes/no records human, with no verification command", async () => {
    const yes = seedSession();
    await runVerify(yes, { ledgerPath, cwd: dir, answer: { kind: "human", worked: true } });
    assert.deepEqual(
      { o: readSession(yes).outcome, s: readSession(yes).outcome_source, c: readSession(yes).verification_cmd },
      { o: "success", s: "human", c: null },
    );

    const no = seedSession();
    await runVerify(no, { ledgerPath, cwd: dir, answer: { kind: "human", worked: false } });
    assert.equal(readSession(no).outcome, "fail");
    assert.equal(readSession(no).outcome_source, "human");
  });

  it("refuses to overwrite an outcome ingest already recorded from a real abort", async () => {
    const id = seedSession({ outcome: "abandoned" });
    const result = await runVerify(id, { ledgerPath, cwd: dir, answer: { kind: "human", worked: true } });
    assert.equal(result.status, "error");
    assert.match(result.status === "error" ? result.message : "", /already recorded outcome='abandoned'/);
    assert.equal(readSession(id).outcome, "abandoned", "the ledger's own record survives");
  });

  it("an unknown session is an error, not a silent no-op", async () => {
    seedSession();
    const result = await runVerify("definitely-not-a-session", { ledgerPath, cwd: dir, answer: { kind: "skip" } });
    assert.equal(result.status, "error");
    assert.match(result.status === "error" ? result.message : "", /no session matches/);
  });
});

describe("T52: the ledger writer refuses agent_claim", () => {
  it("recordOutcome throws rather than recording an agent's self-report", () => {
    const id = seedSession();
    const ledger = Ledger.open(ledgerPath);
    try {
      assert.throws(
        () =>
          ledger.recordOutcome({
            id,
            outcome: "success",
            // The cast is the point: a caller that gets past TypeScript still
            // cannot get past the writer, which is what makes the exclusion
            // mechanical rather than remembered.
            outcomeSource: "agent_claim" as "human",
          }),
        /agent_claim/,
      );
      assert.equal(readSession(id).outcome, null);
    } finally {
      ledger.close();
    }
  });
});

describe("resolveSessionId", () => {
  it("accepts a full id and an unambiguous prefix", () => {
    const id = seedSession();
    const ledger = Ledger.open(ledgerPath);
    try {
      assert.deepEqual(resolveSessionId(ledger, id), { id });
      assert.deepEqual(resolveSessionId(ledger, id.slice(0, 8)), { id });
    } finally {
      ledger.close();
    }
  });

  it("refuses an ambiguous prefix rather than picking the most recent", () => {
    // Two sessions with ids under a shared prefix, forced by passing ids in.
    const ledger = Ledger.open(ledgerPath);
    try {
      for (const suffix of ["aaa", "bbb"]) {
        const sid = ledger.startSession({ id: `shared-${suffix}`, brief: "x", harnessCommit: "t" });
        ledger.endSession({ id: sid });
      }
      const result = resolveSessionId(ledger, "shared-");
      assert.ok("error" in result);
      assert.match(result.error, /ambiguous session prefix/);
    } finally {
      ledger.close();
    }
  });
});

describe("runVerificationCommand", () => {
  it("captures stdout and stderr together, and the exit code", async () => {
    const run = await runVerificationCommand(
      "node -e \"console.log('out'); console.error('err'); process.exit(7)\"",
      dir,
    );
    assert.equal(run.exitCode, 7);
    assert.match(run.output, /out/);
    assert.match(run.output, /err/);
    assert.equal(run.spawnError, undefined);
  });

  it("runs a node:test command as a top-level run even inside a test runner: its own summary and its own exit code", async () => {
    // This file runs under `tsx --test`, so NODE_TEST_CONTEXT is set here, and
    // a nested `node --test` that inherited it would print no summary.
    assert.ok(process.env.NODE_TEST_CONTEXT !== undefined, "precondition: this test runs inside a node:test runner");
    writeFileSync(
      join(dir, "broken.test.mjs"),
      "import { it } from 'node:test';\nimport assert from 'node:assert/strict';\nit('broken', () => { assert.equal(1, 2); });\n",
      "utf8",
    );
    const run = await runVerificationCommand("node --test broken.test.mjs", dir);
    assert.equal(run.exitCode, 1);
    assert.match(run.output, /^ℹ tests 1$/m);
    assert.match(run.output, /^ℹ fail 1$/m);
  });

  it("runs in the given cwd, not the process's", async () => {
    writeFileSync(join(dir, "marker.txt"), "here", "utf8");
    const run = await runVerificationCommand(
      "node -e \"process.exit(require('fs').existsSync('marker.txt') ? 0 : 1)\"",
      dir,
    );
    assert.equal(run.exitCode, 0);
  });

  // P10.5 (ticket 16, D9) — defect D11, the verification-runner half.
  //
  // This used `spawnSync`'s own `timeout`, which signals the direct child; on
  // Windows that child is the command interpreter and the test runner beneath
  // it survived, detached, while `lykos verify` wrote "could not run" into the
  // ledger. The assertion below is the operating system's answer about the
  // process two levels down, not the runner's report about itself — a kill's
  // return code is a self-report (AGENTS.md rule 4).
  it("D11: a grandchild of a timed-out verification command is gone", async () => {
    const grandPidFile = join(dir, "verify-grand.pid");
    writeFileSync(
      join(dir, "verify-grandchild.js"),
      `require('fs').writeFileSync(${JSON.stringify(grandPidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);`,
      "utf8",
    );
    writeFileSync(
      join(dir, "verify-child.js"),
      `require('child_process').spawn(process.execPath, [${JSON.stringify(join(dir, "verify-grandchild.js"))}], { stdio: 'ignore' });\nsetInterval(() => {}, 1000);`,
      "utf8",
    );

    const readPid = (): number | undefined => {
      try {
        const n = Number(readFileSync(grandPidFile, "utf8").trim());
        return Number.isInteger(n) && n > 0 ? n : undefined;
      } catch {
        return undefined;
      }
    };

    const pending = runVerificationCommand(`node ${JSON.stringify(join(dir, "verify-child.js"))}`, dir, 3000);
    let grandPid: number | undefined;
    const deadline = Date.now() + 20_000;
    while (grandPid === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      grandPid = readPid();
    }
    assert.ok(grandPid !== undefined, "the grandchild started");
    // The positive control: without it, the assertion after the timeout
    // proves nothing about the probe.
    assert.equal(await osProcessAlive(grandPid), true, "grandchild is alive before the timeout");

    try {
      const run = await pending;
      assert.equal(run.spawnError, undefined);
      assert.equal(run.signal, "SIGTERM");
      assert.equal(run.exitCode, 143);
      assert.match(run.output, /timed out after 3s \(SIGTERM\)/);
      assert.equal(
        await waitForOsProcess(grandPid, false),
        false,
        "the verification command timed out and left its grandchild running",
      );
    } finally {
      await killProcessTree(grandPid);
    }
  });
});

describe("clampVerificationOutput", () => {
  it("leaves short output alone", () => {
    assert.equal(clampVerificationOutput("all good", 100), "all good");
  });

  it("keeps head AND tail — the failing assertion is usually at the end", () => {
    const text = `START${"x".repeat(5000)}END`;
    const clamped = clampVerificationOutput(text, 400);
    assert.ok(clamped.startsWith("START"));
    assert.ok(clamped.endsWith("END"));
    assert.match(clamped, /bytes elided/);
    assert.ok(clamped.length < text.length);
  });
});

describe("parseVerifyAnswer", () => {
  it("requires an explicit answer rather than defaulting to one", () => {
    const result = parseVerifyAnswer({});
    assert.ok("error" in result);
    assert.match(result.error, /--cmd/);
  });

  it("refuses two answers at once — one outcome has one source", () => {
    const result = parseVerifyAnswer({ yes: true, no: true });
    assert.ok("error" in result);
    assert.match(result.error, /mutually exclusive/);
  });

  it("maps the flags to answers", () => {
    assert.deepEqual(parseVerifyAnswer({ cmd: " npm test " }), { answer: { kind: "command", cmd: "npm test" } });
    assert.deepEqual(parseVerifyAnswer({ yes: true }), { answer: { kind: "human", worked: true } });
    assert.deepEqual(parseVerifyAnswer({ no: true }), { answer: { kind: "human", worked: false } });
  });

  it("rejects an empty --cmd", () => {
    const result = parseVerifyAnswer({ cmd: "   " });
    assert.ok("error" in result);
  });
});
