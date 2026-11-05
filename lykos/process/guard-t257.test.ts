// T257: process identity, process records and the spawn guard, on real processes.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { openLedgerSync } from "../ledger/use.js";
import { killProcessTree } from "../tools/job-runner.js";
import { findGuardedProcesses, spawnGuarded } from "./guard.js";
import { liveness, pidExists, processCreatedAt } from "./identity.js";

const node = process.execPath;

async function waitFor(check: () => boolean, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}

/** A node script that starts a grandchild, writes both pids to `pidsFile`, and runs until killed. */
function treeScript(dir: string): { script: string; pidsFile: string } {
  const pidsFile = join(dir, "pids.json");
  const script = join(dir, "tree.js");
  writeFileSync(
    script,
    `const { spawn } = require("node:child_process");
const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
require("node:fs").writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ child: process.pid, grandchild: g.pid }));
setInterval(() => {}, 1000);
`,
  );
  return { script, pidsFile };
}

describe("T257: process identity", () => {
  it("a live process recorded after it started is alive", async () => {
    const child = spawn(node, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    try {
      await sleep(200);
      assert.equal(liveness({ pid: child.pid!, recordedAt: Date.now() }), "alive");
    } finally {
      child.kill();
    }
  });

  it("a reused pid, a live process created after the record, is never taken for the recorded one", async () => {
    const child = spawn(node, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
    try {
      await sleep(200);
      const created = processCreatedAt(child.pid!);
      assert.equal(typeof created, "number", `creation time readable: ${created}`);
      // The record predates this process: the pid now names a different process than the one recorded.
      assert.equal(liveness({ pid: child.pid!, recordedAt: (created as number) - 60_000 }), "dead");
    } finally {
      child.kill();
    }
  });

  it("a process that exited is dead", async () => {
    const child = spawn(node, ["-e", ""], { stdio: "ignore", windowsHide: true });
    const pid = child.pid!;
    const recordedAt = Date.now();
    await new Promise((r) => child.on("exit", r));
    assert.ok(await waitFor(() => pidExists(pid) === false), "the pid is gone");
    assert.equal(liveness({ pid, recordedAt }), "dead");
  });

  it("a process whose identity cannot be read is unknown, never dead", () => {
    assert.equal(liveness({ pid: process.pid, recordedAt: Date.now() }, { createdAt: () => undefined }), "unknown");
    assert.equal(liveness({ pid: process.pid, recordedAt: Date.now() }, { platform: "aix" }), "unknown");
    const eperm = Object.assign(new Error("odd"), { code: "EINVAL" });
    assert.equal(liveness({ pid: 1234, recordedAt: Date.now() }, { signalZero: () => { throw eperm; } }), "unknown");
    const denied = Object.assign(new Error("denied"), { code: "EPERM" });
    assert.equal(liveness({ pid: 1234, recordedAt: 10 }, { signalZero: () => { throw denied; }, createdAt: () => 5 }), "alive");
  });
});

describe("T257: process records", () => {
  it("a guard is recorded in the ledger before its command runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t257-rec-"));
    const ledger = openLedgerSync(join(dir, "ledger.db"));
    const marker = join(dir, "ran");
    let markerAtRecord: boolean | undefined;
    try {
      const g = await spawnGuarded(node, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`], {
        cwd: dir,
        record: (pid) => {
          markerAtRecord = existsSync(marker);
          ledger.recordProcess({ kind: "guard", sessionId: "s1", pid, command: "node -e ..." });
        },
      });
      await g.exited;
      assert.equal(markerAtRecord, false, "nothing ran before the record");
      assert.ok(existsSync(marker), "the command ran after go");
      const [row] = ledger.processRecords("s1");
      assert.equal(row?.pid, g.guardPid);
      assert.equal(row?.kind, "guard");
      ledger.endProcess(row!.id);
      assert.ok(ledger.processRecords("s1")[0]?.ended_at);
    } finally {
      ledger.close();
    }
  });
});

describe("T257: the spawn guard", () => {
  it("a guard whose pipe closes before go runs nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t257-nogo-"));
    const marker = join(dir, "ran");
    let guardPid = 0;
    await assert.rejects(
      spawnGuarded(node, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`], {
        cwd: dir,
        record: (pid) => {
          guardPid = pid;
          throw new Error("the ledger is locked");
        },
      }),
      /the ledger is locked/,
    );
    assert.ok(await waitFor(() => pidExists(guardPid) === false), "the guard exited");
    await sleep(300);
    assert.equal(existsSync(marker), false, "the command never ran");
  });

  it("a guard whose pipe closes after go kills its command and the command's children", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t257-kill-"));
    const { script, pidsFile } = treeScript(dir);
    const g = await spawnGuarded(node, [script], { cwd: dir, record: () => {} });
    assert.ok(await waitFor(() => existsSync(pidsFile)), "the tree started");
    const pids = JSON.parse(readFileSync(pidsFile, "utf8")) as { child: number; grandchild: number };
    assert.equal(pids.child, g.commandPid);
    assert.equal(pidExists(pids.grandchild), true);
    g.release();
    await g.exited;
    const now = Date.now();
    // liveness, not a bare signal-0 check: on POSIX a killed process nobody reaped yet is a zombie.
    assert.ok(await waitFor(() => liveness({ pid: pids.child, recordedAt: now }) === "dead"), "the command is gone");
    assert.ok(await waitFor(() => liveness({ pid: pids.grandchild, recordedAt: now }) === "dead"), "the command's child is gone");
  });

  it("a guard killed outright leaves its command findable (POSIX) or killed with it (Windows)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t257-orphan-"));
    const { script, pidsFile } = treeScript(dir);
    let recordedAt = 0;
    const g = await spawnGuarded(node, [script], {
      cwd: dir,
      record: () => {
        recordedAt = Date.now();
      },
    });
    assert.ok(await waitFor(() => existsSync(pidsFile)));
    const pids = JSON.parse(readFileSync(pidsFile, "utf8")) as { child: number; grandchild: number };
    try {
      // SIGKILL on POSIX; TerminateProcess on Windows (Node's kill there terminates outright).
      process.kill(g.guardPid, "SIGKILL");
      assert.ok(await waitFor(() => pidExists(g.guardPid) === false), "the guard is gone");
      if (process.platform === "win32") {
        // libuv runs a Node process's children in a job object killed when that process dies.
        assert.ok(await waitFor(() => pidExists(pids.child) === false), "the command died with its guard's job");
        assert.ok(await waitFor(() => pidExists(pids.grandchild) === false), "and so did its child");
      } else {
        assert.equal(pidExists(pids.child), true, "its command survived it");
        const found = findGuardedProcesses({ pid: g.guardPid, recordedAt });
        assert.ok(found, "the OS answered");
        assert.ok(found.includes(pids.child), `found ${JSON.stringify(found)}; command ${pids.child}`);
        assert.ok(found.includes(pids.grandchild), "the command's child is in the group too");
      }
    } finally {
      await killProcessTree(pids.child);
      await killProcessTree(pids.grandchild);
    }
  });

  it("a live guard's command is found by its group (POSIX) or parent pid and creation time (Windows)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t257-find-"));
    let recordedAt = 0;
    const g = await spawnGuarded(node, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: dir,
      record: () => {
        recordedAt = Date.now();
      },
    });
    try {
      const found = findGuardedProcesses({ pid: g.guardPid, recordedAt });
      assert.ok(found?.includes(g.commandPid), `found ${JSON.stringify(found)}; command ${g.commandPid}`);
      assert.deepEqual(findGuardedProcesses({ pid: g.guardPid, recordedAt: Date.now() + 60_000 })?.includes(g.commandPid) ?? false, process.platform !== "win32",
        "on Windows a child created before the record is not the guard's");
    } finally {
      g.release();
      await g.exited;
    }
  });

  it("the command's exit code comes back through the guard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t257-exit-"));
    const g = await spawnGuarded(node, ["-e", "process.exit(7)"], { cwd: dir, record: () => {} });
    assert.equal((await g.exited).code, 7);
  });

  it("a command that cannot start is an error, after the record", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t257-missing-"));
    await assert.rejects(spawnGuarded(join(dir, "no-such-binary"), [], { cwd: dir, record: () => {} }), /did not start|exited/);
  });
});
