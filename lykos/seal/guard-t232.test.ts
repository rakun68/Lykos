// T232 (spec decision 11; lessons R22, W1): the seal guard and its verification order.
//
// Every case runs against real input: a real git repository, a real sealed file made by `sealFromSpec`, a real
// interpreter writing it (`python -c` when python is on the machine, `node -e` always), a real staged edit, a real
// background job, a real gate command. Nothing here stands in for the thing the guard guards.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { LykosExtensionHost } from "../extensions/api.js";
import { sealExtension } from "../extensions/defaults/lykos-seal.js";
import { resolveGatePolicy, runSessionGate } from "../gate/verify-gate.js";
import { Ledger } from "../ledger/ledger.js";
import { JobRegistry } from "../tools/job-runner.js";
import { activeSeals } from "./active.js";
import { enforceForDeprecation, sealEnforced } from "./enforce.js";
import { restoreSealed, sealedDrift } from "./guard.js";
import { sealKeyInit } from "./keys.js";
import { createSealOrder } from "./order.js";
import { resealAt, sealFromSpec } from "./spec.js";
import { verifySeals } from "./verify.js";

let root: string;
let repo: string;
let home: string;
let wt: string;
let ledgerPath: string;

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    NODE_TEST_CONTEXT: undefined,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: env(), encoding: "utf8" }).trim();
}

function write(dir: string, rel: string, text: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

/** The worktree's copy of `rel`, line endings normalized: git writes CRLF on a machine with autocrlf. */
function read(rel: string): string {
  return readFileSync(join(wt, rel), "utf8").replace(/\r\n/g, "\n");
}

const SEALED = "test/add.test.mjs";
const FAILING = 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("adds", () => assert.equal(1 + 1, 3));\n';
const CORRECTED = FAILING.replace("3", "4");

const savedHome: Record<string, string | undefined> = {};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "lykos-t232-"));
  home = join(root, "home");
  // Hermetic: the extension host reads the global config (~/.lykos/config.yaml), so a machine's own seal.writers or
  // seal.enforce_for must not decide who is guarded here.
  for (const k of ["HOME", "USERPROFILE"]) savedHome[k] = process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  repo = join(root, "repo");
  ledgerPath = join(root, "ledger.db");
  mkdirSync(home);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  write(repo, ".lykos/config.yaml", 'seal:\n  base: main\n  test_command: "node --test {files}"\n');
  write(repo, ".gitignore", ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\nnode_modules/\n");
  write(repo, "src/add.mjs", "export const add = (a, b) => 0;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  sealKeyInit(repo, home, env());
  wt = join(root, "wt");
  git(repo, "worktree", "add", "-q", "-b", "lykos/s1", wt, "main");
  write(repo, SEALED, FAILING);
  const sealed = await sealFromSpec({ workspace: repo, worktree: wt, paths: [SEALED], red: true, homeDir: home, env: env() });
  assert.equal(sealed.ok, true, sealed.message);
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedHome)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

function host(specialist: string, opts: { readOnly?: boolean } = {}): LykosExtensionHost {
  const h = new LykosExtensionHost({
    cwd: wt,
    gate: { request: async () => "deny" },
    specialist,
    ledgerPath,
    ...(opts.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
  });
  h.install(sealExtension);
  h.setSessionId("sess-1");
  return h;
}

/** A veto's detail is the command line; a restore's is JSON. */
function parseDetail(detail: string): Record<string, unknown> {
  try {
    return JSON.parse(detail) as Record<string, unknown>;
  } catch {
    return { raw: detail };
  }
}

function events(kind: string): Array<{ paths: string[]; detail: Record<string, unknown> }> {
  if (!existsSync(ledgerPath)) return [];
  const ledger = Ledger.open(ledgerPath);
  try {
    return ledger.sealEvents().filter((e) => e.kind === kind).map((e) => ({
      paths: JSON.parse(e.paths) as string[],
      detail: (e.detail ? parseDetail(e.detail) : {}) as Record<string, unknown>,
    }));
  } finally {
    ledger.close();
  }
}

/** The interpreters that really write the sealed file on this machine. `node -e` is always among them. */
interface Interpreter {
  name: string;
  /** Overwrites `rel` in `cwd` with `text`, in a process of its own. */
  overwrite(cwd: string, rel: string, text: string): void;
}

const NODE: Interpreter = {
  name: "node -e",
  overwrite: (cwd, rel, text) => {
    const r = spawnSync(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], process.argv[2])", rel, text], { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  },
};

function pythonName(): string | undefined {
  for (const name of ["python", "python3"]) {
    const r = spawnSync(name, ["-c", "print(40 + 2)"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "42") return name;
  }
  return undefined;
}

const PYTHON = pythonName();
const INTERPRETERS: Interpreter[] = [
  NODE,
  ...(PYTHON === undefined
    ? []
    : [
        {
          name: `${PYTHON} -c`,
          overwrite: (cwd: string, rel: string, text: string): void => {
            const r = spawnSync(PYTHON, ["-c", "import sys; open(sys.argv[1], 'w', newline='').write(sys.argv[2])", rel, text], { cwd, encoding: "utf8" });
            assert.equal(r.status, 0, r.stderr);
          },
        } satisfies Interpreter,
      ]),
];

describe("T232: a shell write the parser cannot see is restored after the call", () => {
  for (const interpreter of INTERPRETERS) {
    it(`${interpreter.name}: the sealed test is restored, the result says so, SEALED-EDIT is on record, and the session goes on`, async () => {
      const h = host("implementer");
      assert.deepEqual(await h.runToolResult("bash", { command: "ls" }, false), [], "nothing changed, nothing said");

      interpreter.overwrite(wt, SEALED, "// weakened\n");
      assert.equal(read(SEALED), "// weakened\n", "the interpreter really wrote it");

      const notes = await h.runToolResult("bash", { command: "python -c ..." }, false);
      assert.equal(notes.length, 1);
      assert.match(notes[0]!, /SEALED-EDIT/);
      assert.match(notes[0]!, /restored/);
      assert.match(notes[0]!, new RegExp(SEALED.replace(".", "\\.")));
      assert.match(notes[0]!, /dispute_test/);
      assert.equal(read(SEALED), FAILING, "the sealed file is back");

      const restored = events("restored");
      assert.equal(restored.length, 1);
      assert.deepEqual(restored[0]!.paths, [SEALED]);
      assert.equal(restored[0]!.detail.flag, "SEALED-EDIT");
      assert.equal(restored[0]!.detail.source, "tool_result");

      // The session continues: the next call finds nothing to say and records nothing.
      assert.deepEqual(await h.runToolResult("read", { path: SEALED }, false), []);
      assert.equal(events("restored").length, 1);
    });
  }

  it("an edit that was committed in the same command is restored in the tree too", async () => {
    const h = host("implementer");
    NODE.overwrite(wt, SEALED, "// weakened\n");
    git(wt, "commit", "-q", "-am", "weaken");
    const notes = await h.runToolResult("bash", { command: "git commit" }, false);
    assert.equal(notes.length, 1);
    assert.equal(read(SEALED), FAILING);
    // The restored tree differs from HEAD, so it is committed with the rest at the session's end; the guard commits nothing.
    assert.match(git(wt, "status", "--porcelain"), /M\s+test\/add\.test\.mjs/);
  });

  it("a deleted sealed file is put back", async () => {
    const h = host("implementer");
    rmSync(join(wt, SEALED));
    const notes = await h.runToolResult("bash", { command: "rm" }, false);
    assert.equal(notes.length, 1);
    assert.equal(read(SEALED), FAILING);
  });

  it("untracked files beside the sealed path do not count", async () => {
    const h = host("implementer");
    write(wt, "test/helper.test.mjs", "// mine\n");
    assert.deepEqual(await h.runToolResult("write", { path: "test/helper.test.mjs" }, false), []);
    assert.equal(events("restored").length, 0);
    assert.equal(readFileSync(join(wt, "test/helper.test.mjs"), "utf8"), "// mine\n");
  });
});

describe("T232: who is enforced", () => {
  it("a custom writable specialist is enforced; a seal.writers specialist and a read-only session are not", async () => {
    const custom = host("my-custom-implementer");
    NODE.overwrite(wt, SEALED, "// weakened\n");
    assert.equal((await custom.runToolResult("bash", {}, false)).length, 1, "enforced");
    assert.equal(read(SEALED), FAILING);

    const writer = host("test-writer");
    NODE.overwrite(wt, SEALED, "// the test writer's own edit\n");
    assert.deepEqual(await writer.runToolResult("bash", {}, false), [], "a seal.writers specialist writes sealed tests");
    assert.equal(read(SEALED), "// the test writer's own edit\n");

    const readOnly = host("my-custom-implementer", { readOnly: true });
    assert.deepEqual(await readOnly.runToolResult("bash", {}, false), [], "a read-only session has nothing to guard");
    assert.equal(events("restored").length, 1, "only the enforced run recorded one");
  });

  it("an edit and a write tool call on the sealed path are vetoed for a custom writable specialist", async () => {
    const custom = host("my-custom-implementer");
    for (const [tool, input] of [
      ["edit", { path: SEALED, edits: [] }],
      ["write", { path: SEALED, content: "x" }],
    ] as const) {
      const veto = await custom.runToolCallVeto(tool, input);
      assert.equal(veto?.block, true, tool);
      assert.match((veto as { reason: string }).reason, /dispute_test/);
    }
  });

  it("a shell write the parser sees is vetoed like edit and write; a read only warns", async () => {
    const h = host("my-custom-implementer");
    for (const command of [`echo x > ${SEALED}`, `echo x >> ${SEALED}`, `sed -i s/1/2/ ${SEALED}`, `tee ${SEALED}`, `Set-Content ${SEALED} x`]) {
      const veto = await h.runToolCallVeto("bash", { command });
      assert.equal(veto?.block, true, command);
      assert.match((veto as { reason: string }).reason, /SEALED-EDIT/);
      assert.match((veto as { reason: string }).reason, /dispute_test/);
    }
    const read = await h.runToolCallVeto("bash", { command: `cat ${SEALED}` });
    assert.equal(read?.block, false, "reading a sealed test is allowed");
    assert.match(read?.warning ?? "", /sealed path/);
    assert.equal(events("vetoed").length, 5);
  });

  it("seal.enforce_for is honoured as extra names, and reported once as deprecated", () => {
    assert.equal(sealEnforced({ specialist: "reviewer", readOnly: true, writers: ["test-writer"], enforceFor: ["reviewer"] }), true);
    assert.equal(sealEnforced({ specialist: "reviewer", readOnly: true, writers: ["test-writer"], enforceFor: [] }), false);
    assert.equal(sealEnforced({ specialist: "build", writers: ["test-writer"], enforceFor: [] }), true);
    assert.equal(sealEnforced({ specialist: "test-writer", writers: ["test-writer"], enforceFor: [] }), false);
    assert.equal(enforceForDeprecation([]), undefined);
    assert.match(enforceForDeprecation(["reviewer"])!, /deprecated/);

    write(wt, ".lykos/config.yaml", 'seal:\n  base: main\n  test_command: "node --test {files}"\n  enforce_for: [odd-one]\n');
    const written: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      host("implementer");
    } finally {
      process.stderr.write = real;
    }
    assert.ok(written.some((line) => /seal\.enforce_for is deprecated/.test(line) && /odd-one/.test(line)), written.join(""));
  });
});

describe("T232: a staged sealed edit is caught", () => {
  it("an edit that was staged and then written back in the working tree is restored in the index", async () => {
    const h = host("implementer");
    // One process: edit, stage the edit, put the original text back in the working tree. Only the index differs.
    const script = [
      "const fs = require('fs'); const cp = require('child_process');",
      "const original = fs.readFileSync(process.argv[1], 'utf8');",
      "fs.writeFileSync(process.argv[1], '// staged weakening\\n');",
      "cp.execFileSync('git', ['add', process.argv[1]]);",
      "fs.writeFileSync(process.argv[1], original);",
    ].join(" ");
    const r = spawnSync(process.execPath, ["-e", script, SEALED], { cwd: wt, env: env(), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(read(SEALED), FAILING, "the working tree looks untouched");
    assert.match(git(wt, "diff", "--cached", "--name-only"), /add\.test\.mjs/, "but the index holds the edit");

    const notes = await h.runToolResult("bash", { command: "node -e ..." }, false);
    assert.equal(notes.length, 1);
    assert.match(notes[0]!, /SEALED-EDIT/);
    assert.equal(git(wt, "diff", "--cached", "--name-only"), "", "the index is clean again");
    assert.deepEqual(events("restored")[0]!.detail.restored, [{ path: SEALED, where: ["index"] }]);
  });
});

describe("T232: a job that edits a sealed file is caught at job_end", () => {
  it("the end handler restores it before the job counts as done, and the next tool result says so", async () => {
    const h = host("implementer");
    const jobs = new JobRegistry({ cwd: wt, onEnd: (job) => h.emitJobEnd(job) });
    const job = jobs.start({
      command: `node -e "require('fs').writeFileSync('${SEALED}', '// edited by a job')"`,
    });
    for (let i = 0; i < 200 && jobs.get(job.id)?.status === "running"; i += 1) await sleep(50);
    assert.equal(jobs.get(job.id)?.status, "exited");
    const report = await jobs.stopAll();
    assert.deepEqual(report.notStopped, []);

    assert.equal(read(SEALED), FAILING, "restored by the time the job counted as done");
    const restored = events("restored");
    assert.equal(restored.length, 1);
    assert.equal(restored[0]!.detail.source, "job_end");
    assert.match(String(restored[0]!.detail.by), new RegExp(job.id));

    const notes = await h.runToolResult("hub", { op: "ps" }, false);
    assert.equal(notes.length, 1, "the model hears of it on its next tool result");
    assert.match(notes[0]!, /SEALED-EDIT/);
    assert.match(notes[0]!, new RegExp(job.id));
  });

  it("no job starts once the registry is closed", () => {
    const jobs = new JobRegistry({ cwd: wt });
    jobs.close();
    const refused = jobs.start({ command: "node -e 0" });
    assert.equal(refused.status, "failed");
    assert.match(refused.reason ?? "", /no new job may start/);
    assert.equal(refused.pid, undefined);
  });
});

describe("T232: a coordinator reseal raises nothing (R22)", () => {
  it("the corrected sealed file under the advanced seal is not an edit, in the running session or the next", async () => {
    const h = host("implementer");
    assert.deepEqual(await h.runToolResult("read", {}, false), []);
    const stale = activeSeals({ cwd: wt, env: env(), base: "main" });

    // The coordinator corrects the sealed test on the branch and seals it again.
    write(wt, SEALED, CORRECTED);
    git(wt, "commit", "-q", "-am", "correct the sealed test");
    const resealed = await resealAt({ worktree: wt, commit: git(wt, "rev-parse", "HEAD"), homeDir: home, env: env() });
    assert.equal(resealed.ok, true, resealed.message);

    // Against the seal it replaced, the corrected file IS different: the guard has something to guard.
    assert.deepEqual(sealedDrift(wt, stale, env()).map((d) => d.path), [SEALED]);

    assert.deepEqual(await h.runToolResult("bash", { command: "ls" }, false), [], "the running session");
    assert.deepEqual(await host("implementer").runToolResult("bash", { command: "ls" }, false), [], "the next session");
    assert.equal(events("restored").length, 0);
    assert.equal(read(SEALED), CORRECTED, "the correction stands");
  });
});

describe("T232: the verifier's working-tree comparison", () => {
  it("sees an uncommitted and a staged edit that the commit comparison cannot", async () => {
    const committedOnly = await verifySeals({ cwd: wt, env: env(), record: false });
    assert.equal(committedOnly.ok, true, committedOnly.output);

    NODE.overwrite(wt, SEALED, "// uncommitted\n");
    assert.equal((await verifySeals({ cwd: wt, env: env(), record: false })).ok, true, "commits only: blind to the tree");
    const tree = await verifySeals({ cwd: wt, env: env(), record: false, workingTree: true });
    assert.equal(tree.ok, false);
    assert.match(tree.output, /working tree/);
    assert.deepEqual(tree.changedPaths, [SEALED]);

    git(wt, "add", SEALED);
    NODE.overwrite(wt, SEALED, FAILING);
    const index = await verifySeals({ cwd: wt, env: env(), record: false, workingTree: true });
    assert.equal(index.ok, false);
    assert.match(index.output, /index/);

    restoreSealed(wt, activeSeals({ cwd: wt, env: env(), base: "main" }), env());
    assert.equal((await verifySeals({ cwd: wt, env: env(), record: false, workingTree: true })).ok, true);
  });

  it("`lykos seal verify --working-tree` exits non-zero on an uncommitted edit; without the flag it cannot see it", () => {
    NODE.overwrite(wt, SEALED, "// uncommitted\n");
    const cli = join(import.meta.dirname, "..", "cli.ts");
    const run = (...flags: string[]) =>
      spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, "seal", "verify", ...flags], { cwd: wt, env: env(), encoding: "utf8", timeout: 120_000 });
    assert.equal(run().status, 0);
    const withFlag = run("--working-tree");
    assert.equal(withFlag.status, 1, withFlag.stdout + withFlag.stderr);
    assert.match(withFlag.stderr, /working tree/);
  });
});

describe("T232: the verification order", () => {
  const script = (name: string, text: string): string => {
    const p = join(root, "scripts", name);
    write(root, `scripts/${name}`, text);
    return p.replace(/\\/g, "/");
  };

  function session(): { ledger: Ledger; sessionId: string } {
    const ledger = Ledger.open(ledgerPath);
    const sessionId = ledger.startSession({ brief: "t232", harnessCommit: "test", executionShape: "standalone" });
    ledger.endSession({ id: sessionId });
    return { ledger, sessionId };
  }

  function verdict(sessionId: string): { outcome: string | null; verification_output: string | null; verification_cmd: string | null } {
    const ledger = Ledger.open(ledgerPath);
    try {
      return ledger.db.prepare("SELECT outcome, verification_output, verification_cmd FROM sessions WHERE id = ?").get(sessionId) as {
        outcome: string | null;
        verification_output: string | null;
        verification_cmd: string | null;
      };
    } finally {
      ledger.close();
    }
  }

  function order(sessionId: string, jobs?: JobRegistry, extra: Partial<Parameters<typeof createSealOrder>[0]> = {}) {
    return createSealOrder({
      cwd: wt,
      ledgerPath,
      sessionId,
      specialist: "implementer",
      closeWriters: () => jobs?.close(),
      env: env(),
      ...extra,
    });
  }

  it("an unsealed or unenforced session has no order", () => {
    const { ledger, sessionId } = session();
    ledger.close();
    assert.equal(order(sessionId, undefined, { specialist: "test-writer" }), undefined);
    assert.equal(order(sessionId, undefined, { readOnly: true }), undefined);
    assert.ok(order(sessionId));
  });

  it("closes the writers, restores an earlier edit, validates the record, then runs the command once", async () => {
    const { ledger, sessionId } = session();
    ledger.close();
    const jobs = new JobRegistry({ cwd: wt });
    const counter = join(root, "runs.txt");
    const command = `node "${script("count.mjs", "import { appendFileSync } from 'node:fs'; appendFileSync(process.argv[2], 'run\\n');")}" "${counter.replace(/\\/g, "/")}"`;

    NODE.overwrite(wt, SEALED, "// edited before verification\n");
    const result = await runSessionGate({
      policy: resolveGatePolicy(wt, { command }),
      sessionId,
      ledgerPath,
      edited: true,
      sealOrder: order(sessionId, jobs),
    });
    assert.deepEqual(result, { status: "recorded", outcome: "success", cmd: command, exitCode: 0 });
    assert.equal(readFileSync(counter, "utf8"), "run\n", "once");
    assert.equal(read(SEALED), FAILING, "restored before the command ran");
    assert.equal(jobs.start({ command: "node -e 0" }).status, "failed", "the writers were closed");
    const restored = events("restored");
    assert.equal(restored.length, 1);
    assert.match(String(restored[0]!.detail.by), /before verification/);
  });

  it("refuses to verify while a process of the session is alive, and verifies once it is gone", async () => {
    const { ledger, sessionId } = session();
    const sleeper: ChildProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    ledger.recordProcess({ kind: "child", sessionId, pid: sleeper.pid!, command: "stray" });
    ledger.close();
    const marker = join(root, "ran.txt");
    const command = `node "${script("mark.mjs", "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'ran');")}" "${marker.replace(/\\/g, "/")}"`;
    const run = (): ReturnType<typeof runSessionGate> =>
      runSessionGate({ policy: resolveGatePolicy(wt, { command }), sessionId, ledgerPath, edited: true, sealOrder: order(sessionId) });
    try {
      const refused = await run();
      assert.equal(refused.status, "recorded");
      assert.equal((refused as { outcome: string }).outcome, "fail");
      assert.equal(existsSync(marker), false, "the command did not run");
      assert.match(verdict(sessionId).verification_output ?? "", /not confirmed stopped: child \d+ \(alive\)/);
    } finally {
      sleeper.kill("SIGKILL");
      await new Promise<void>((done) => (sleeper.exitCode !== null || sleeper.signalCode !== null ? done() : sleeper.once("exit", () => done())));
    }
    // A fresh session row: the first verdict is written once.
    const next = session();
    next.ledger.close();
    const again = await runSessionGate({ policy: resolveGatePolicy(wt, { command }), sessionId: next.sessionId, ledgerPath, edited: true, sealOrder: order(next.sessionId) });
    assert.equal((again as { outcome: string }).outcome, "success");
    assert.equal(readFileSync(marker, "utf8"), "ran");
  });

  it("refuses to verify when the seal record does not validate", async () => {
    const { ledger, sessionId } = session();
    ledger.close();
    const sealFile = join(wt, ".lykos", "seals", "lykos", "s1.json");
    const record = JSON.parse(readFileSync(sealFile, "utf8")) as Record<string, unknown>;
    writeFileSync(sealFile, JSON.stringify({ ...record, created_at: "2000-01-01T00:00:00.000Z" }, null, 2));
    git(wt, "commit", "-q", "-am", "alter the seal record");
    const marker = join(root, "ran-invalid.txt");
    const command = `node "${script("mark2.mjs", "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'ran');")}" "${marker.replace(/\\/g, "/")}"`;
    const result = await runSessionGate({ policy: resolveGatePolicy(wt, { command }), sessionId, ledgerPath, edited: true, sealOrder: order(sessionId) });
    assert.equal((result as { outcome: string }).outcome, "fail");
    assert.equal(existsSync(marker), false, "the command did not run");
    assert.match(verdict(sessionId).verification_output ?? "", /seal record does not validate/);
    assert.equal(events("tampered").length, 1);
  });

  it("a restore while the command runs fails the verdict with SEALED-EDIT after one rerun", async () => {
    const { ledger, sessionId } = session();
    ledger.close();
    const counter = join(root, "runs-edit.txt").replace(/\\/g, "/");
    // The gate's own command edits the sealed test, as a writer left running by the session would.
    const command = `node "${script(
      "edit-sealed.mjs",
      "import { appendFileSync, writeFileSync } from 'node:fs'; appendFileSync(process.argv[2], 'run\\n'); writeFileSync(process.argv[3], '// edited during verification\\n');",
    )}" "${counter}" "${join(wt, SEALED).replace(/\\/g, "/")}"`;
    const result = await runSessionGate({ policy: resolveGatePolicy(wt, { command }), sessionId, ledgerPath, edited: true, sealOrder: order(sessionId) });
    assert.equal(result.status, "recorded");
    assert.equal((result as { outcome: string }).outcome, "fail");
    assert.equal(readFileSync(counter, "utf8"), "run\nrun\n", "the command ran twice: once, and once more after the restore");
    assert.equal(read(SEALED), FAILING, "the tree ends restored");
    const row = verdict(sessionId);
    assert.equal(row.outcome, "fail");
    assert.match(row.verification_output ?? "", /SEALED-EDIT/);
    assert.match(row.verification_output ?? "", /rerun once/);
    const restored = events("restored");
    assert.equal(restored.length, 2, "the restore after the first run, and after the rerun");
    assert.ok(restored.every((e) => /during verification/.test(String(e.detail.by))));
  });  // Review round: the seal's order fails closed and survives a committed sealed edit.
  it("a sealed edit committed in the same command: restored, SEALED-EDIT raised, the command still runs, and the session-end commit leaves the seal valid", async () => {
    const { ledger, sessionId } = session();
    ledger.close();
    const h = host("implementer");
    NODE.overwrite(wt, SEALED, "// weakened\n");
    git(wt, "commit", "-q", "-am", "weaken and commit in one command");
    const notes = await h.runToolResult("bash", { command: 'python -c "..." && git commit -am x' }, false);
    assert.match(notes[0] ?? "", /SEALED-EDIT/);
    assert.equal(read(SEALED), FAILING);
    assert.equal(events("restored").length, 1, "SEALED-EDIT is on record for the coordinator");

    const counter = join(root, "runs-committed.txt");
    const command = `node "${script("count2.mjs", "import { appendFileSync } from 'node:fs'; appendFileSync(process.argv[2], 'run\\n');")}" "${counter.replace(/\\/g, "/")}"`;
    const result = await runSessionGate({ policy: resolveGatePolicy(wt, { command }), sessionId, ledgerPath, edited: true, sealOrder: order(sessionId) });
    assert.equal((result as { outcome: string }).outcome, "success", verdict(sessionId).verification_output ?? "");
    assert.equal(readFileSync(counter, "utf8"), "run\n");

    // The session's end: the restored file is committed with the rest, and the seal then validates on the commits too.
    git(wt, "add", "-A");
    git(wt, "commit", "-q", "-m", "session end");
    const after = await verifySeals({ cwd: wt, env: env() });
    assert.equal(after.ok, true, after.output);
  });

  it("a sealed edit committed and never seen by the guard is restored by the order itself, and verification runs", async () => {
    const { ledger, sessionId } = session();
    ledger.close();
    NODE.overwrite(wt, SEALED, "// weakened\n");
    git(wt, "commit", "-q", "-am", "weaken");
    const result = await runSessionGate({ policy: resolveGatePolicy(wt, { command: "node -e 0" }), sessionId, ledgerPath, edited: true, sealOrder: order(sessionId) });
    assert.equal((result as { outcome: string }).outcome, "success", verdict(sessionId).verification_output ?? "");
    assert.equal(read(SEALED), FAILING);
    assert.equal(events("restored").length, 1);
  });

  it("a committed edit the tree still carries is still refused", async () => {
    const { ledger, sessionId } = session();
    ledger.close();
    NODE.overwrite(wt, SEALED, "// weakened\n");
    git(wt, "commit", "-q", "-am", "weaken");
    // Git refuses the restore while the index is locked, so the edit stays in the tree.
    writeFileSync(resolve(wt, git(wt, "rev-parse", "--git-path", "index.lock")), "");
    const marker = join(root, "ran-locked.txt");
    const command = `node "${script("mark3.mjs", "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'ran');")}" "${marker.replace(/\\/g, "/")}"`;
    const result = await runSessionGate({ policy: resolveGatePolicy(wt, { command }), sessionId, ledgerPath, edited: true, sealOrder: order(sessionId) });
    assert.equal((result as { outcome: string }).outcome, "fail");
    assert.equal(existsSync(marker), false, "the command did not run");
    assert.match(verdict(sessionId).verification_output ?? "", /SEALED-EDIT/);
    assert.match(verdict(sessionId).verification_output ?? "", /could not be restored/);
  });

  /** A ledger that opens but refuses a seal event, as a full or locked database does. */
  function refuseSealEvents(): () => void {
    const ledger = Ledger.open(ledgerPath);
    ledger.db.exec("CREATE TRIGGER refuse_seal_events BEFORE INSERT ON seal_events BEGIN SELECT RAISE(ABORT, 'ledger refuses'); END");
    ledger.close();
    return () => {
      const l = Ledger.open(ledgerPath);
      l.db.exec("DROP TRIGGER refuse_seal_events");
      l.close();
    };
  }

  it("a restore the ledger cannot record refuses verification instead of passing silently", async () => {
    const { ledger, sessionId } = session();
    ledger.close();
    refuseSealEvents();
    NODE.overwrite(wt, SEALED, "// weakened\n");
    const marker = join(root, "ran-unrecorded.txt");
    const command = `node "${script("mark4.mjs", "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], 'ran');")}" "${marker.replace(/\\/g, "/")}"`;
    const result = await runSessionGate({ policy: resolveGatePolicy(wt, { command }), sessionId, ledgerPath, edited: true, sealOrder: order(sessionId) });
    assert.equal((result as { outcome: string }).outcome, "fail");
    assert.equal(existsSync(marker), false, "the command did not run");
    assert.match(verdict(sessionId).verification_output ?? "", /SEALED-EDIT.*could not be recorded/);
  });

  it("the guard says so to the model when a restore cannot be recorded, and records it once the ledger accepts it", async () => {
    const h = host("implementer");
    const accept = refuseSealEvents();
    NODE.overwrite(wt, SEALED, "// weakened\n");
    const notes = await h.runToolResult("bash", { command: "x" }, false);
    assert.match(notes[0] ?? "", /SEALED-EDIT/);
    assert.match(notes[0] ?? "", /could not be recorded/);
    assert.equal(events("restored").length, 0);
    accept();
    assert.deepEqual(await h.runToolResult("read", { path: SEALED }, false), []);
    assert.equal(events("restored").length, 1, "the restore reached the ledger on the next call");
  });

  it("an edit hidden from git diff with assume-unchanged (or skip-worktree) is still restored", () => {
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      git(wt, "update-index", flag, SEALED);
      writeFileSync(join(wt, SEALED), "// weakened\n");
      const outcome = restoreSealed(wt, activeSeals({ cwd: wt, env: env() }), env());
      assert.deepEqual(outcome.failed, [], flag);
      assert.deepEqual(outcome.restored.map((d) => d.path), [SEALED], flag);
      assert.equal(read(SEALED), FAILING, flag);
    }
  });

  it("a seal record whose sealed_paths is not a list fails the restore, never throws, never reads as clean", () => {
    const seals = activeSeals({ cwd: wt, env: env() }).map((s) => ({ ...s, seal: { ...s.seal, sealed_paths: null as unknown as string[] } }));
    const outcome = restoreSealed(wt, seals, env());
    assert.deepEqual(outcome.restored, []);
    assert.deepEqual(outcome.failed, seals.map((s) => s.relPath));
    assert.match(outcome.error ?? "", /no list of sealed paths/);
  });

  it("a comparison git cannot make is a failed restore of every sealed path, not a clean tree", () => {
    const seals = activeSeals({ cwd: wt, env: env() });
    const notARepo = join(root, "not-a-repo");
    mkdirSync(notARepo);
    const outcome = restoreSealed(notARepo, seals, env());
    assert.deepEqual(outcome.restored, []);
    assert.deepEqual(outcome.failed, [SEALED]);
    assert.match(outcome.error ?? "", /could not be compared/);
  });

});
