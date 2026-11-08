// T249: the baseline of known failures. Every test runs a real verification command (node's own test runner, a shell
// command that exits) against a real git repository: the key, the reuse, the new baseline on a changed lockfile,
// command or platform, the unmeasured baseline, and a new session given its baseline before the model runs.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { runSessionChild } from "../cli/session-child.js";
import { defaultLedgerPath, withLedgerSync } from "../ledger/use.js";
import type { RunStandaloneTaskInput } from "../session/session.js";
import { ensureBaseline, baselineKey, lockfileHashAt, NO_LOCKFILE, type BaselineKey } from "./baseline.js";
import { resolveHostBash, useConfiguredShellPath } from "../process/host-bash.js";
import { ledgerViews } from "./mcp-server.js";
import { admit } from "./ownership.js";
import { encodeFrame, PROTOCOL_VERSION, type SessionRequest } from "./session-protocol.js";

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const saved: Record<string, string | undefined> = {};
let home: string;
let counter: string;

before(() => {
  home = mkdtempSync(join(tmpdir(), "lykos-t249-home-"));
  counter = join(home, "runs.txt");
  for (const k of ["HOME", "USERPROFILE", "LYKOS_TRUST_WORKSPACE", "NODE_TEST_CONTEXT", "T249_RUNS"]) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LYKOS_TRUST_WORKSPACE = "1";
  process.env.T249_RUNS = counter;
  delete process.env.NODE_TEST_CONTEXT;
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();
}

function put(dir: string, rel: string, text: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

/** How many times the verification command has run: the test file appends one line to T249_RUNS each time. */
function runs(): number {
  return existsSync(counter) ? readFileSync(counter, "utf8").split("\n").filter((l) => l !== "").length : 0;
}

const TEST_FILE = `
const { test, describe } = require("node:test");
const assert = require("node:assert");
require("node:fs").appendFileSync(process.env.T249_RUNS, "run\\n");
describe("suite", () => {
  test("already broken at the base", () => assert.strictEqual(1, 2));
  test("fine", () => assert.strictEqual(1, 1));
});
`;
const COMMAND = "node --test known.test.js";

/** A repository whose base commit has one failing test and one passing one, and a lockfile. */
function project(): { repo: string; base: string; ledgerPath: string } {
  const repo = mkdtempSync(join(tmpdir(), "lykos t249 "));
  git(repo, "init", "-q", "-b", "main");
  put(repo, "known.test.js", TEST_FILE);
  put(repo, "package-lock.json", '{"lockfileVersion":3,"v":1}\n');
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  return { repo, base: git(repo, "rev-parse", "HEAD"), ledgerPath: defaultLedgerPath(repo) };
}

function keyOf(repo: string, base: string, command = COMMAND, platform?: string): BaselineKey {
  const key = baselineKey(repo, base, command, platform);
  assert.ok(key);
  return key;
}

describe("T249: the baseline records the base's verification run with its failing test names", () => {
  it("runs the command on the base commit and records the failing tests by name, not an empty list", async () => {
    const { repo, base, ledgerPath } = project();
    rmSync(counter, { force: true });
    const { baseline, reused } = await ensureBaseline(ledgerPath, { repo, key: keyOf(repo, base) });
    assert.equal(reused, false);
    assert.equal(baseline.status, "measured");
    assert.ok(baseline.status === "measured");
    assert.equal(baseline.kind, "names");
    assert.notEqual(baseline.exit_code, 0);
    assert.equal(baseline.tests_total, 2);
    assert.equal(baseline.failing.length, 1);
    assert.match(baseline.failing[0]!, /known\.test\.js > suite > already broken at the base$/);
    assert.deepEqual(baseline.key, { base, command: COMMAND, lockfileHash: lockfileHashAt(repo, base), platform: process.platform });
  });

  it("runs it on the base commit, not on a working tree that has since changed", async () => {
    const { repo, base, ledgerPath } = project();
    put(repo, "known.test.js", TEST_FILE.replace("assert.strictEqual(1, 2)", "assert.strictEqual(1, 1)"));
    git(repo, "commit", "-qam", "fixed later");
    const { baseline } = await ensureBaseline(ledgerPath, { repo, key: keyOf(repo, base) });
    assert.ok(baseline.status === "measured");
    assert.equal(baseline.failing.length, 1, "the base still has its failure");
  });

  it("a node --test run that fails outside any test is exit-only, never names with nothing failing", async () => {
    const { repo, ledgerPath } = project();
    put(repo, "pass.test.js", ['const { test } = require("node:test");', 'test("passes", () => {});', ""].join("\n"));
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "passing");
    const head = git(repo, "rev-parse", "HEAD");
    // Every test the runner reports passes, and the command still fails (a hook or a step after the tests).
    const { baseline } = await ensureBaseline(ledgerPath, { repo, key: keyOf(repo, head, 'node --test pass.test.js && node -e "process.exit(1)"') });
    assert.ok(baseline.status === "measured");
    assert.notEqual(baseline.exit_code, 0);
    assert.equal(baseline.kind, "exit-only", JSON.stringify(baseline));
    assert.match(baseline.signature ?? "", /^[0-9a-f]{64}$/);
  });

  it("a cargo test run records its failing tests by name (a cargo on PATH that prints libtest's output)", async () => {
    const { repo, base, ledgerPath } = project();
    const bin = mkdtempSync(join(tmpdir(), "lykos-t249-cargo-"));
    const fixture = join(dirname(fileURLToPath(import.meta.url)), "..", "seal", "fixtures", "cargo-test-output.txt");
    writeFileSync(join(bin, "cargo.js"), `process.stdout.write(require("fs").readFileSync(${JSON.stringify(fixture)}, "utf8")); process.exit(101);\n`);
    writeFileSync(join(bin, "cargo.cmd"), '@node "%~dp0cargo.js" %*\r\n');
    writeFileSync(join(bin, "cargo"), '#!/bin/sh\nexec node "$(dirname "$0")/cargo.js" "$@"\n', { mode: 0o755 });
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
    const { baseline } = await ensureBaseline(ledgerPath, { repo, key: keyOf(repo, base, "cargo test"), env });
    assert.ok(baseline.status === "measured", JSON.stringify(baseline));
    assert.equal(baseline.adapter, "cargo");
    assert.equal(baseline.kind, "names");
    assert.equal(baseline.exit_code, 101);
    assert.deepEqual([...baseline.failing].sort(), ["src/lib.rs > tests > adds_two", "src/lib.rs > tests > nested > deep_failure", "tests/api.rs > api_adds"]);
  });

  it("identifies a failure by exit code and output hash when the runner reports no tests", async () => {
    const { repo, base, ledgerPath } = project();
    const { baseline } = await ensureBaseline(ledgerPath, { repo, key: keyOf(repo, base, 'node -e "console.error(7); process.exit(3)"') });
    assert.ok(baseline.status === "measured");
    assert.equal(baseline.kind, "exit-only");
    assert.equal(baseline.exit_code, 3);
    assert.match(baseline.signature ?? "", /^[0-9a-f]{64}$/);
  });
});

describe("T249: a second session on the same key reuses the baseline", () => {
  it("does not run the command again, and returns the same record", async () => {
    const { repo, base, ledgerPath } = project();
    rmSync(counter, { force: true });
    const first = await ensureBaseline(ledgerPath, { repo, key: keyOf(repo, base) });
    assert.equal(runs(), 1);
    const second = await ensureBaseline(ledgerPath, { repo, key: keyOf(repo, base) });
    assert.equal(runs(), 1, "the command did not run a second time");
    assert.equal(second.reused, true);
    assert.equal(first.reused, false);
    assert.deepEqual(second.baseline, first.baseline);
  });
});

describe("T249: a changed lockfile, command or platform makes a new baseline", () => {
  it("hashes the base's lockfile content: another lockfile, another hash; none is spelled out", () => {
    const { repo, base } = project();
    const before = lockfileHashAt(repo, base);
    put(repo, "package-lock.json", '{"lockfileVersion":3,"v":2}\n');
    git(repo, "commit", "-qam", "bump a dependency");
    const after = lockfileHashAt(repo, "HEAD");
    assert.notEqual(before, after);
    put(repo, "unrelated.txt", "x\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "no lockfile change");
    assert.equal(lockfileHashAt(repo, "HEAD"), after, "a commit that leaves the lockfiles alone keeps the hash");
    git(repo, "rm", "-q", "package-lock.json");
    git(repo, "commit", "-qm", "drop the lockfile");
    assert.equal(lockfileHashAt(repo, "HEAD"), NO_LOCKFILE);
  });

  it("runs the command again for a different lockfile hash, command or platform, and keeps all four records", async () => {
    const { repo, base, ledgerPath } = project();
    rmSync(counter, { force: true });
    const key = keyOf(repo, base);
    const a = await ensureBaseline(ledgerPath, { repo, key });
    assert.equal(runs(), 1);

    const lock = await ensureBaseline(ledgerPath, { repo, key: { ...key, lockfileHash: "another-lockfile" } });
    assert.equal(lock.reused, false);
    assert.equal(runs(), 2, "a changed lockfile ran the command");

    const command = await ensureBaseline(ledgerPath, { repo, key: keyOf(repo, base, `${COMMAND} --test-name-pattern=fine`) });
    assert.equal(command.reused, false);
    assert.equal(runs(), 3, "a changed command ran");

    const platform = await ensureBaseline(ledgerPath, { repo, key: keyOf(repo, base, COMMAND, "plan9") });
    assert.equal(platform.reused, false);
    assert.equal(runs(), 4, "a changed platform ran");

    const ids = new Set([a.baseline.id, lock.baseline.id, command.baseline.id, platform.baseline.id]);
    assert.equal(ids.size, 4);
    const again = await ensureBaseline(ledgerPath, { repo, key });
    assert.equal(again.reused, true);
    assert.equal(again.baseline.id, a.baseline.id, "the first key still has its own record");
    assert.equal(runs(), 4);
  });

  it("a new commit on the base is a new key even with the lockfile unchanged", async () => {
    const { repo, base, ledgerPath } = project();
    rmSync(counter, { force: true });
    await ensureBaseline(ledgerPath, { repo, key: keyOf(repo, base) });
    put(repo, "note.txt", "later\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "later");
    const next = await ensureBaseline(ledgerPath, { repo, key: keyOf(repo, "HEAD") });
    assert.equal(next.reused, false);
    assert.equal(runs(), 2);
  });
});

describe("T249: a baseline that did not run is unmeasured, never empty", () => {
  it("records why, and the next session runs it again instead of reusing it", async () => {
    const { repo, base, ledgerPath } = project();
    const key = keyOf(repo, base, "lykos-t249-no-such-command-anywhere");
    const first = await ensureBaseline(ledgerPath, { repo, key });
    assert.equal(first.baseline.status, "unmeasured");
    assert.ok(first.baseline.status === "unmeasured");
    assert.match(first.baseline.reason, /could not run \(exit 127\)/);
    assert.equal("failing" in first.baseline, false, "an unmeasured baseline has no failure list at all");
    const second = await ensureBaseline(ledgerPath, { repo, key });
    assert.equal(second.reused, false, "unmeasured is retried");
  });

  it("an unmeasured row is replaced by the retry's measurement, which the next session then reuses", async () => {
    const { repo, base, ledgerPath } = project();
    const flag = join(home, "t249-runnable");
    rmSync(flag, { force: true });
    const key = keyOf(repo, base, `node -e "process.exit(require('fs').existsSync(process.env.T249_FLAG) ? 0 : 127)"`);
    process.env.T249_FLAG = flag;
    try {
      assert.equal((await ensureBaseline(ledgerPath, { repo, key })).baseline.status, "unmeasured");
      writeFileSync(flag, "");
      const second = await ensureBaseline(ledgerPath, { repo, key });
      assert.equal(second.reused, false);
      assert.equal(second.baseline.status, "measured", "the row now holds the measurement");
      const third = await ensureBaseline(ledgerPath, { repo, key });
      assert.equal(third.reused, true);
      assert.equal(third.baseline.status, "measured");
    } finally {
      delete process.env.T249_FLAG;
    }
  });

  it("is unmeasured when the command does not finish in time", async () => {
    const { repo, base, ledgerPath } = project();
    const key = keyOf(repo, base, 'node -e "setTimeout(() => {}, 60000)"');
    const { baseline } = await ensureBaseline(ledgerPath, { repo, key, timeoutMs: 1500 });
    assert.ok(baseline.status === "unmeasured");
    assert.match(baseline.reason, /did not finish in/);
  });

  it("has no key for a project with no base commit", () => {
    const repo = mkdtempSync(join(tmpdir(), "lykos t249 empty "));
    git(repo, "init", "-q", "-b", "main");
    assert.equal(baselineKey(repo, "HEAD", COMMAND), undefined);
  });
});

describe("T249: a new session is given its baseline before the model runs, and status shows it", () => {
  /** Per drive: whether the session's baseline was in the ledger when its model would have started. */
  const linkedAtRun: boolean[] = [];
  async function drive(workspace: string, extra: Partial<SessionRequest>): Promise<RunStandaloneTaskInput> {
    const seen: RunStandaloneTaskInput[] = [];
    const input = new PassThrough();
    const request: SessionRequest = { version: PROTOCOL_VERSION, tool: "lykos_implement", workspace, prompt: "Work", label: "lykos_implement", ...extra };
    input.write(encodeFrame(request));
    await runSessionChild({
      input,
      write: () => undefined,
      env: { LYKOS_TRUST_SOURCE: "flag", LYKOS_TRUST_WORKSPACE: "1", T249_RUNS: counter },
      trustPath: join(home, "trust.json"),
      worktreesRoot: mkdtempSync(join(tmpdir(), "lykos t249 child ")),
      runTask: async (task) => {
        seen.push(task);
        // What the ledger holds when the model would start: the baseline is recorded before it.
        linkedAtRun.push(
          withLedgerSync(defaultLedgerPath(workspace), (l) => (l.db.prepare("SELECT COUNT(*) AS n FROM session_baselines WHERE session_id = ?").get(task.sessionId ?? "") as { n: number }).n > 0),
        );
        return { status: "ok", sessionId: task.sessionId ?? "unset", text: "ok", snapshot: {} as never };
      },
      onParentGone: () => undefined,
    });
    input.end();
    // `status` lists the sessions that have an owner row.
    withLedgerSync(defaultLedgerPath(workspace), (ledger) => {
      assert.equal(admit(ledger, { sessionId: seen[0]!.sessionId!, owner: "run", specialist: "implement", projectCap: 8 }).ok, true);
    });
    return seen[0]!;
  }

  it("runs the command for the first session on a key and reuses it for the second", async () => {
    const { repo, base } = project();
    rmSync(counter, { force: true });
    const one = await drive(repo, { base, context: { files: [], test: COMMAND } });
    const two = await drive(repo, { base, context: { files: [], test: COMMAND } });
    assert.equal(runs(), 1, "the second session did not run the command");
    assert.deepEqual(linkedAtRun.slice(-2), [true, true], "each session's baseline was recorded before its model ran");
    const views = ledgerViews(repo);
    const first = views.find((v) => v.session_id === one.sessionId)?.baseline;
    const second = views.find((v) => v.session_id === two.sessionId)?.baseline;
    assert.ok(first && second, "both sessions show a baseline");
    assert.equal(first.status, "measured");
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(first.base, base);
    assert.equal(first.command, COMMAND);
    assert.equal(first.platform, process.platform);
    assert.equal(first.lockfile_hash, lockfileHashAt(repo, base));
    assert.equal(first.failing?.length, 1);
    assert.deepEqual(second.failing, first.failing);
  });

  it("shows an unmeasured baseline as unmeasured, and a task with no command has none", async () => {
    const { repo, base } = project();
    const broken = await drive(repo, { base, context: { files: [], test: "lykos-t249-no-such-command-anywhere" } });
    const bare = await drive(repo, { base });
    const views = ledgerViews(repo);
    const shown = views.find((v) => v.session_id === broken.sessionId)?.baseline;
    assert.equal(shown?.status, "unmeasured");
    assert.equal(shown?.failing, undefined);
    assert.match(shown?.reason ?? "", /exit 127/);
    assert.equal(views.find((v) => v.session_id === bare.sessionId)?.baseline, undefined);
  });
});

describe("T249 review: what could not be measured is never recorded as measured", () => {
  it("is unmeasured, not a failing run, when no bash resolves and the shell would be cmd.exe", async () => {
    const { repo, base, ledgerPath } = project();
    useConfiguredShellPath(join(home, "no-such-dir", "bash.exe"));
    try {
      assert.equal(resolveHostBash().ok, false, "the configured bash does not exist");
      const { baseline } = await ensureBaseline(ledgerPath, { repo, key: keyOf(repo, base, "lykos-t249-no-such-command-anywhere") });
      assert.equal(baseline.status, "unmeasured");
      assert.ok(baseline.status === "unmeasured");
      assert.match(baseline.reason, /no bash resolves/);
    } finally {
      useConfiguredShellPath(undefined);
    }
  });

  it("records a test file that crashes at import as a failing entry, never an empty list", async () => {
    const { repo, base, ledgerPath } = project();
    put(repo, "broken.test.js", `require("./no-such-module-t249");\nrequire("node:test").test("never reached", () => {});\n`);
    put(repo, "fine.test.js", `require("node:test").test("fine", () => {});\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "a file that cannot be loaded");
    const command = "node --test broken.test.js fine.test.js";
    const { baseline } = await ensureBaseline(ledgerPath, { repo, key: keyOf(repo, "HEAD", command) });
    assert.ok(baseline.status === "measured");
    assert.equal(baseline.kind, "names");
    assert.notEqual(baseline.exit_code, 0);
    assert.deepEqual(baseline.failing, ["broken.test.js"]);
  });

  it("kills the whole process tree on a timeout, so nothing outlives the run", async () => {
    const { repo, base, ledgerPath } = project();
    const pidFile = join(home, "grandchild.pid");
    rmSync(pidFile, { force: true });
    put(repo, "grand.js", `require("node:fs").writeFileSync(process.env.T249_PID, String(process.pid));\nsetTimeout(() => {}, 120000);\n`);
    put(repo, "hang.js", `require("node:child_process").spawn(process.execPath, ["grand.js"], { stdio: "ignore" });\nsetTimeout(() => {}, 120000);\n`);
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "a command that leaves a grandchild");
    const { baseline } = await ensureBaseline(ledgerPath, {
      repo,
      key: keyOf(repo, "HEAD", "node hang.js"),
      env: { ...process.env, T249_PID: pidFile },
      timeoutMs: 4000,
    });
    assert.ok(baseline.status === "unmeasured");
    assert.match(baseline.reason, /did not finish in/);
    assert.ok(existsSync(pidFile), "the grandchild started");
    const pid = Number(readFileSync(pidFile, "utf8"));
    const alive = (): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 20 && alive(); i += 1) await new Promise((r) => setTimeout(r, 100));
    const survived = alive();
    if (survived) process.kill(pid, "SIGKILL");
    assert.equal(survived, false, "the grandchild is gone when the baseline returns");
  });

  it("gives a ledger row with no exit code or duration no made-up number", async () => {
    const { repo, base, ledgerPath } = project();
    const key = keyOf(repo, base);
    withLedgerSync(ledgerPath, (ledger) => {
      ledger.db
        .prepare(
          `INSERT INTO baselines (base_commit, command, lockfile_hash, platform, status, adapter, kind, exit_code, failing_json, tests_total, signature, unmeasured_reason, duration_ms, recorded_at)
           VALUES (?, ?, ?, ?, 'measured', 'node:test', 'names', NULL, '[]', NULL, NULL, NULL, NULL, 'then')`,
        )
        .run(key.base, key.command, key.lockfileHash, key.platform);
    });
    const { baseline } = await ensureBaseline(ledgerPath, { repo, key });
    assert.ok(baseline.status === "measured");
    assert.equal("exit_code" in baseline, false);
    assert.equal("duration_ms" in baseline, false);
  });

  it("has no lockfile hash when git cannot say, rather than reporting none", () => {
    const { repo } = project();
    assert.equal(lockfileHashAt(repo, "0".repeat(40)), undefined);
    assert.equal(baselineKey(repo, "0".repeat(40), COMMAND), undefined);
  });
});

describe("T249 review: the key follows the install the run uses", () => {
  it("a changed node_modules install is a new key and a new run; an unchanged one is reused", async () => {
    const { repo, base, ledgerPath } = project();
    rmSync(counter, { force: true });
    put(repo, "node_modules/.package-lock.json", '{"packages":{"node_modules/a":{"version":"1.0.0"}}}\n');
    const first = await ensureBaseline(ledgerPath, { repo, key: keyOf(repo, base) });
    assert.equal(first.reused, false);
    assert.equal(runs(), 1);
    assert.equal((await ensureBaseline(ledgerPath, { repo, key: keyOf(repo, base) })).reused, true);
    assert.equal(runs(), 1);
    put(repo, "node_modules/.package-lock.json", '{"packages":{"node_modules/a":{"version":"1.0.1"}}}\n');
    const key = keyOf(repo, base);
    assert.notEqual(key.lockfileHash, first.baseline.key.lockfileHash);
    const next = await ensureBaseline(ledgerPath, { repo, key });
    assert.equal(next.reused, false);
    assert.equal(runs(), 2, "the changed install ran the command again");
  });
});
