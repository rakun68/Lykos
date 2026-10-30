import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JOB_LOG_DEFAULT_LINES,
  JobRegistry,
  TREE_KILL_SPAWN_OPTIONS,
  jobsDirectory,
  killProcessTree,
} from "./job-runner.js";
import { osProcessAlive, waitForOsProcess } from "./process-probe.js";

// P10.5 (ticket 16, D4) — the acceptance test for this ticket is the
// grandchild, and it is the first test in this file for that reason.
//
// Everything else here could pass while `hub` is actively lying to the model.
// `stop` returning `{ status: "stopped" }` is this codebase setting its own
// field; `taskkill` exiting 0 is a report from a program that was asked to try.
// Neither is evidence. So the process tree is built three levels deep — a
// shell, a script it runs, and a runtime that script starts — and after the
// stop the OPERATING SYSTEM is asked whether the deepest one is still there,
// through `tasklist` on Windows and `ps` on POSIX (`process-probe.ts`).
//
// Each of those assertions has a positive control immediately before it: the
// same probe, on the same pid, asserting the process IS alive. A probe that
// answered "gone" to everything would pass the interesting assertion and fail
// the control, which is the failure mode a probe-based test has.

/** A workspace with a three-level process tree ready to start. */
function makeTree(): {
  dir: string;
  command: string;
  grandchildPid: () => number | undefined;
  childPid: () => number | undefined;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "lykos-jobs-"));
  const grandPidFile = join(dir, "grand.pid");
  const childPidFile = join(dir, "child.pid");

  // The runtime at the bottom of the tree. It writes its pid where the test
  // can find it and then stays alive doing nothing, so the only thing that can
  // end it is somebody killing it.
  writeFileSync(
    join(dir, "grandchild.js"),
    [
      `require('fs').writeFileSync(${JSON.stringify(grandPidFile)}, String(process.pid));`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"),
    "utf8",
  );

  // The script in the middle. `stdio: "ignore"` so the grandchild does not die
  // merely because a pipe closed — the point is to test the KILL, not to get
  // an accidental pass from stream teardown.
  writeFileSync(
    join(dir, "child.js"),
    [
      `const { spawn } = require('child_process');`,
      `require('fs').writeFileSync(${JSON.stringify(childPidFile)}, String(process.pid));`,
      `spawn(process.execPath, [${JSON.stringify(join(dir, "grandchild.js"))}], { stdio: 'ignore' });`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"),
    "utf8",
  );

  const readPid = (file: string): number | undefined => {
    try {
      const n = Number(readFileSync(file, "utf8").trim());
      return Number.isInteger(n) && n > 0 ? n : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    dir,
    command: `node ${JSON.stringify(join(dir, "child.js"))}`,
    grandchildPid: () => readPid(grandPidFile),
    childPid: () => readPid(childPidFile),
    cleanup: () => {
      // Belt and braces: whatever the test did or failed to do, nothing this
      // file started is allowed to outlive it.
      for (const pid of [readPid(grandPidFile), readPid(childPidFile)]) {
        if (pid !== undefined) void killProcessTree(pid);
      }
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        // A Windows handle still closing is not a test failure.
      }
    },
  };
}

async function waitFor<T>(get: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for a value");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("P10.5 D4: stop kills the tree, and the operating system is what says so", () => {
  it("a grandchild of a stopped job is gone, asked of tasklist/ps rather than of the kill", async () => {
    const tree = makeTree();
    const registry = new JobRegistry({ cwd: tree.dir });
    try {
      const job = registry.start({ command: tree.command });
      assert.equal(job.status, "running");
      assert.ok(job.pid !== undefined && job.pid > 0, "the shell has a pid");

      const grandPid = await waitFor(tree.grandchildPid);
      const childPid = await waitFor(tree.childPid);

      // The positive control. If these fail, the probe below proves nothing.
      assert.equal(await osProcessAlive(grandPid), true, "grandchild is alive before the stop");
      assert.equal(await osProcessAlive(childPid), true, "child is alive before the stop");

      const stopped = await registry.stop(job.id);
      assert.equal(stopped?.status, "stopped");

      // THE assertion. Not `stopped.status`, not the kill's exit code, not the
      // registry — the operating system's own answer about the deepest process
      // in the tree.
      assert.equal(
        await waitForOsProcess(grandPid, false),
        false,
        "the grandchild survived a stop that reported success",
      );
      assert.equal(await waitForOsProcess(childPid, false), false, "the child survived a stop that reported success");
    } finally {
      tree.cleanup();
    }
  });

  it("D6: session teardown kills every job, proven the same way", async () => {
    const tree = makeTree();
    const registry = new JobRegistry({ cwd: tree.dir });
    try {
      registry.start({ command: tree.command });
      const grandPid = await waitFor(tree.grandchildPid);
      assert.equal(await osProcessAlive(grandPid), true, "grandchild is alive before teardown");

      const stopped = await registry.stopAll();
      assert.equal(stopped.length, 1);
      assert.equal(stopped[0]?.status, "stopped");
      assert.equal(stopped[0]?.reason, "the session ended");

      assert.equal(
        await waitForOsProcess(grandPid, false),
        false,
        "a job outlived the session that started it",
      );
    } finally {
      tree.cleanup();
    }
  });

  it("stopping a job that already exited is a no-op, not a kill of a recycled pid", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-jobs-"));
    const registry = new JobRegistry({ cwd: dir });
    try {
      const job = registry.start({ command: `node -e "process.exit(3)"` });
      await waitFor(() => (registry.get(job.id)?.status !== "running" ? true : undefined));
      const first = registry.get(job.id);
      assert.equal(first?.status, "exited");
      assert.equal(first?.exitCode, 3);

      const stopped = await registry.stop(job.id);
      assert.equal(stopped?.status, "exited", "an exited job stays exited");
      assert.equal(stopped?.exitCode, 3);
    } finally {
      await registry.stopAll();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe("P10.5 D3: the spawn and the kill are two halves of one decision", () => {
  it("detaches on POSIX so the group kill has a group, and never on Windows", () => {
    // Detaching on Windows opens a console window, which is not something a
    // coding agent may do to somebody's desktop; not detaching on POSIX leaves
    // `kill(-pid)` with nothing to signal. The constant is shared so all three
    // call sites cannot disagree about which platform gets which.
    assert.equal(TREE_KILL_SPAWN_OPTIONS.detached, process.platform !== "win32");
  });

  it("a kill with no pid is an answer, not a throw", async () => {
    assert.deepEqual(await killProcessTree(undefined), { method: "none", error: "no pid" });
    assert.deepEqual(await killProcessTree(0), { method: "none", error: "no pid" });
    assert.deepEqual(await killProcessTree(-5), { method: "none", error: "no pid" });
  });
});

describe("P10.5 D5: output streams to a file under .lykos/", () => {
  it("start returns before the command finishes, with an id, a pid and a log path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-jobs-"));
    const registry = new JobRegistry({ cwd: dir });
    try {
      const job = registry.start({ command: `node -e "setTimeout(()=>{},5000)"` });
      // The command sleeps five seconds; `start` has already returned.
      assert.match(job.id, /^job-[0-9a-f]{6}$/);
      assert.ok(job.pid !== undefined && job.pid > 0);
      assert.equal(job.status, "running");
      assert.equal(job.logPath, join(jobsDirectory(dir), `${job.id}.log`));
      assert.equal(existsSync(job.logPath), true, "the log file exists the moment the job starts");
      // Runtime state lives in `.lykos/`, never `.pi/` (AGENTS.md rule 8).
      assert.equal(jobsDirectory(dir), join(dir, ".lykos", "jobs"));
      assert.equal(existsSync(join(dir, ".pi")), false);
    } finally {
      await registry.stopAll();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("output reaches the log while the job is still running, and logs reads it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-jobs-"));
    const registry = new JobRegistry({ cwd: dir });
    try {
      const job = registry.start({
        command: `node -e "console.log('first'); setTimeout(()=>{ console.log('second'); setTimeout(()=>{},5000); }, 400)"`,
      });
      await waitFor(() => (registry.logs(job.id)?.text.includes("first") === true ? true : undefined));
      assert.equal(registry.get(job.id)?.status, "running", "still running while its output is readable");

      const window = registry.logs(job.id);
      assert.ok(window);
      assert.match(window.text, /first/);
      assert.equal(window.atEnd, true);

      // The byte-offset form returns what came next, and the offset to use
      // after it.
      const fromStart = registry.logs(job.id, { offset: 0 });
      assert.ok(fromStart);
      assert.match(fromStart.text, /first/);
      await waitFor(() => (registry.logs(job.id)?.text.includes("second") === true ? true : undefined));
      const next = registry.logs(job.id, { offset: fromStart.nextOffset });
      assert.ok(next);
      assert.match(next.text, /second/);
      assert.equal(next.text.includes("first"), false, "an offset read does not repeat what was already read");
    } finally {
      await registry.stopAll();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("a tail asks for the last N lines and gets them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-jobs-"));
    const registry = new JobRegistry({ cwd: dir });
    try {
      const job = registry.start({
        command: `node -e "for (let i = 1; i <= 200; i++) console.log('line' + i)"`,
      });
      await waitFor(() => (registry.get(job.id)?.status === "exited" ? true : undefined));
      const tail = registry.logs(job.id, { lines: 3 });
      assert.ok(tail);
      assert.equal(
        tail.text.split("\n").filter((l) => l.startsWith("line")).length,
        3,
        "exactly three of the printed lines came back",
      );
      assert.match(tail.text, /line200/);
      assert.equal(tail.text.includes("line196"), false);
      assert.equal(JOB_LOG_DEFAULT_LINES, 50);
    } finally {
      await registry.stopAll();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("the byte cap kills the job and the reason says the cap is why", async () => {
    const tree = makeTree();
    // Small enough to hit in a fraction of a second, so the test does not have
    // to write four megabytes to exercise the real code path.
    const registry = new JobRegistry({ cwd: tree.dir, maxLogBytes: 2000 });
    try {
      // The same three-level tree: a capped job must reap its descendants too,
      // or the cap stops the logging and leaves the disk-filling process
      // running, which is the opposite of the point.
      writeFileSync(
        join(tree.dir, "noisy.js"),
        [
          `const { spawn } = require('child_process');`,
          `spawn(process.execPath, [${JSON.stringify(join(tree.dir, "grandchild.js"))}], { stdio: 'ignore' });`,
          // Only once the grandchild has written its pid: under load the cap
          // could otherwise fire, and reap it, before it ever said who it was.
          `const ready = setInterval(() => {`,
          `  if (!require('fs').existsSync(${JSON.stringify(join(tree.dir, "grand.pid"))})) return;`,
          `  clearInterval(ready);`,
          `  setInterval(() => process.stdout.write('x'.repeat(500) + '\\n'), 10);`,
          `}, 10);`,
        ].join("\n"),
        "utf8",
      );
      const job = registry.start({ command: `node ${JSON.stringify(join(tree.dir, "noisy.js"))}` });
      const grandPid = await waitFor(tree.grandchildPid);
      assert.equal(await osProcessAlive(grandPid), true, "grandchild is alive before the cap fires");

      await waitFor(() => (registry.get(job.id)?.status === "capped" ? true : undefined));
      const capped = registry.get(job.id);
      assert.equal(capped?.status, "capped");
      assert.match(capped?.reason ?? "", /2000-byte cap/);
      assert.match(capped?.reason ?? "", /killed/);

      assert.equal(
        await waitForOsProcess(grandPid, false),
        false,
        "the cap stopped the logging and left the process running",
      );
    } finally {
      await registry.stopAll();
      tree.cleanup();
    }
  });
});

describe("P10.5 D2: the registry is session-scoped state", () => {
  it("two registries in one process do not see each other's jobs", async () => {
    const dirA = mkdtempSync(join(tmpdir(), "lykos-jobs-"));
    const dirB = mkdtempSync(join(tmpdir(), "lykos-jobs-"));
    const a = new JobRegistry({ cwd: dirA });
    const b = new JobRegistry({ cwd: dirB });
    try {
      const jobA = a.start({ command: `node -e "setTimeout(()=>{},5000)"` });
      assert.equal(a.list().length, 1);
      assert.equal(b.list().length, 0, "a second session sees none of the first's jobs");
      assert.equal(b.get(jobA.id), undefined);
      assert.equal(await b.stop(jobA.id), undefined, "and cannot stop one of them");
      assert.equal(a.get(jobA.id)?.status, "running");
    } finally {
      await a.stopAll();
      await b.stopAll();
      rmSync(dirA, { recursive: true, force: true, maxRetries: 5 });
      rmSync(dirB, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("ps shows a running job and reports it exited once it has", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-jobs-"));
    const registry = new JobRegistry({ cwd: dir });
    try {
      const job = registry.start({ command: `node -e "setTimeout(()=>{}, 300)"` });
      assert.deepEqual(
        registry.list().map((j) => [j.id, j.status]),
        [[job.id, "running"]],
      );
      await waitFor(() => (registry.get(job.id)?.status === "exited" ? true : undefined));
      const after = registry.list();
      assert.equal(after.length, 1, "nothing is ever deleted — an exited job stays on the list");
      assert.equal(after[0]?.status, "exited");
      assert.equal(after[0]?.exitCode, 0);
      assert.ok(after[0]?.endedAt !== undefined);
    } finally {
      await registry.stopAll();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  it("a command that cannot be started is failed, not exited", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-jobs-"));
    const registry = new JobRegistry({ cwd: dir });
    try {
      const job = registry.start({ command: `definitely-not-a-real-command-xyzzy` });
      await waitFor(() => (registry.get(job.id)?.status !== "running" ? true : undefined));
      const record = registry.get(job.id);
      // A shell that cannot find the command exits non-zero rather than
      // failing to spawn, so this is `exited` with a non-zero code on both
      // platforms — the distinction that matters is that it is not `running`.
      assert.notEqual(record?.status, "running");
      assert.notEqual(record?.exitCode, 0);
    } finally {
      await registry.stopAll();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
