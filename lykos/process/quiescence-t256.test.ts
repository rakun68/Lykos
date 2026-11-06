// T256: confirmed quiescence. Each case runs the real thing where the OS allows it: a session child that outlives
// its owner, a guard killed under its command, a container that counts until it is removed, a job that will not stop.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { SESSION_LABEL } from "../containment/containment.js";
import type { ListedContainer } from "../containment/runtime.js";
import { Ledger } from "../ledger/ledger.js";
import { JobRegistry } from "../tools/job-runner.js";
import type { ExecChild, ProjectExecutor } from "../tools/executor.js";
import { startGuard } from "./guard.js";
import { pidExists } from "./identity.js";
import { confirmQuiescence, type ContainerDriver } from "./quiescence.js";

function ledger(): Ledger {
  return Ledger.open(join(mkdtempSync(join(tmpdir(), "lykos-t256-")), "ledger.db"));
}

const SLEEPER = ["-e", "setInterval(() => {}, 1000)"];

function sleeper(): ChildProcess {
  return spawn(process.execPath, SLEEPER, { stdio: "ignore", windowsHide: true });
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((r) => child.once("exit", () => r()));
}

function ownerRow(l: Ledger, sessionId: string, pid: number, recordedAtMs: number): void {
  l.db
    .prepare(
      `INSERT INTO owners (session_id, request_id, owner, owner_pid, owner_recorded_at_ms, specialist, write_in_place, state, started_at, stop_requested)
       VALUES (?, NULL, 'run', ?, ?, 'general', 0, 'running', ?, 0)`,
    )
    .run(sessionId, pid, recordedAtMs, new Date().toISOString());
}

async function untilQuiet(l: Ledger, sessionId: string, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    if ((await confirmQuiescence(l, sessionId)).quiet) return;
    if (Date.now() > until) throw new Error("never quiet");
    await sleep(200);
  }
}

describe("T256: confirmed quiescence", () => {
  it("a session child that outlives its dead owner is not stopped until it is gone", async () => {
    const l = ledger();
    const owner = sleeper();
    await new Promise<void>((r) => owner.once("spawn", () => r()));
    ownerRow(l, "s1", owner.pid!, Date.now());
    owner.kill("SIGKILL");
    await exited(owner);

    const child = sleeper();
    await new Promise<void>((r) => child.once("spawn", () => r()));
    // Suspended where the OS can: a stopped process is still a process.
    if (process.platform !== "win32") process.kill(child.pid!, "SIGSTOP");
    l.recordProcess({ kind: "child", sessionId: "s1", pid: child.pid!, command: "session-child" });

    const before = await confirmQuiescence(l, "s1");
    assert.equal(before.quiet, false);
    assert.deepEqual(before.notStopped, [{ kind: "child", pid: child.pid, liveness: "alive" }], "the dead owner is gone; the child is not");

    child.kill("SIGKILL");
    await exited(child);
    await untilQuiet(l, "s1");
    assert.notEqual(l.processRecords("s1")[0]!.ended_at, null, "a record proven gone is marked ended");
    l.close();
  });

  it("an owner that is alive, or that the OS will not report, is not gone", async () => {
    const l = ledger();
    ownerRow(l, "s2", 4242, 0);
    for (const state of ["alive", "unknown"] as const) {
      const q = await confirmQuiescence(l, "s2", { livenessOf: () => state });
      assert.deepEqual(q, { quiet: false, notStopped: [{ kind: "owner", pid: 4242, liveness: state }] });
    }
    l.db.prepare("UPDATE owners SET state = 'done' WHERE session_id = 's2'").run();
    assert.equal((await confirmQuiescence(l, "s2", { livenessOf: () => "alive" })).quiet, true, "an owner that finished the session may live on");
    l.close();
  });

  it("a guard killed while its command runs is not stopped until the command is gone", async () => {
    const l = ledger();
    const started = startGuard(process.execPath, SLEEPER, {
      cwd: tmpdir(),
      output: "ignore",
      record: (guardPid) => void l.recordProcess({ kind: "guard", sessionId: "s3", pid: guardPid, command: "sleeper" }),
    });
    const { guardPid, commandPid } = await started.started;
    assert.equal((await confirmQuiescence(l, "s3")).quiet, false, "a running guard is not quiet");

    started.guard.kill("SIGKILL");
    await started.exited;
    // POSIX: the command survives in the guard's process group. Windows: it dies with the guard's job object.
    // Either way quiet never comes while the command lives.
    for (let i = 0; i < 50 && pidExists(commandPid) === true; i += 1) {
      const q = await confirmQuiescence(l, "s3");
      if (pidExists(commandPid) !== true) break;
      assert.equal(q.quiet, false, "quiet while the guard's command still runs");
      assert.ok(q.notStopped.some((n) => n.kind === "command" && n.pid === commandPid), JSON.stringify(q.notStopped));
      if (process.platform !== "win32") process.kill(-guardPid, "SIGKILL");
      await sleep(100);
    }
    await untilQuiet(l, "s3");
    assert.equal(pidExists(commandPid), false);
    l.close();
  });

  it("a guard's tree counts: a command found, or a tree the OS will not list", async () => {
    const l = ledger();
    l.recordProcess({ kind: "guard", sessionId: "s4", pid: 777, command: "x", recordedAtMs: 1 });
    const dead = () => "dead" as const;
    assert.deepEqual((await confirmQuiescence(l, "s4", { livenessOf: dead, treeOf: () => [778] })).notStopped, [{ kind: "command", pid: 778, liveness: "alive" }]);
    assert.deepEqual((await confirmQuiescence(l, "s4", { livenessOf: dead, treeOf: () => undefined })).notStopped, [{ kind: "command", liveness: "unknown" }]);
    assert.equal((await confirmQuiescence(l, "s4", { livenessOf: dead, treeOf: () => [] })).quiet, true);
    l.close();
  });

  it("a contained session's container counts until it is removed by name", async () => {
    const l = ledger();
    l.recordProcess({ kind: "container", sessionId: "s5", pid: 0, command: "docker" });
    const containers: ListedContainer[] = [
      { id: "c-mine", labels: { [SESSION_LABEL]: "s5" } },
      { id: "c-other", labels: { [SESSION_LABEL]: "someone-else" } },
    ];
    const removed: string[] = [];
    const driver: ContainerDriver = {
      listContainers: async () => containers.filter((c) => !removed.includes(c.id)),
      removeContainer: async (id) => void removed.push(id),
    };
    const report = await confirmQuiescence(l, "s5", { driverFor: () => driver });
    assert.deepEqual(report.notStopped, [{ kind: "container", container: "c-mine", liveness: "alive" }], "the exec client is not the container");
    const stopped = await confirmQuiescence(l, "s5", { driverFor: () => driver, stopContainers: true });
    assert.equal(stopped.quiet, true);
    assert.deepEqual(removed, ["c-mine"]);

    l.recordProcess({ kind: "container", sessionId: "s6", pid: 0, command: "docker" });
    const broken: ContainerDriver = {
      listContainers: async () => {
        throw new Error("daemon unreachable");
      },
      removeContainer: async () => {},
    };
    assert.deepEqual((await confirmQuiescence(l, "s6", { driverFor: () => broken })).notStopped, [{ kind: "container", liveness: "unknown" }]);
    l.close();
  });
});

describe("T256: the job runner reports what did not stop", () => {
  it("stopAll returns the job whose process would not exit", { timeout: 60_000 }, async () => {
    /** A process that ignores every kill. */
    class Stubborn extends EventEmitter {
      readonly pid = undefined;
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      readonly stdin = null;
      kill(): boolean {
        return true;
      }
    }
    const executor: ProjectExecutor = {
      name: "stubborn",
      spawn: () => new Stubborn() as unknown as ExecChild,
      shellOperations: () => {
        throw new Error("unused");
      },
    };
    const registry = new JobRegistry({ cwd: mkdtempSync(join(tmpdir(), "lykos-t256-jobs-")), executor });
    const job = registry.start({ command: "ignore-signals" });
    const report = await registry.stopAll();
    assert.deepEqual(report.stopped, []);
    assert.deepEqual(
      report.notStopped.map((j) => j.id),
      [job.id],
    );
  });
});
