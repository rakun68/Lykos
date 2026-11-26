// P5 #48: a running shell call moved to the background (OpenCode's `session.background`, ctrl+b) becomes a job:
// the turn gets a notice naming it, the output keeps going to the job's log, and stopping the job kills it.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildBashOperations, type ApprovalDecision, type ApprovalGate } from "./approval.js";
import { JobRegistry } from "../tools/job-runner.js";

const allow: ApprovalGate = { request: (): Promise<ApprovalDecision> => Promise.resolve("allow") };
const node = JSON.stringify(process.execPath).replace(/\\\\/g, "/");
/** Prints a line every 50 ms for a minute. */
const ticking = `${node} -e "let n=0;setInterval(()=>console.log('tick '+(++n)),50)"`;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lykos-bg-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const until = async (test: () => boolean, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("moving a shell call to the background", () => {
  it("returns the turn with a notice, keeps logging to the job, and stop kills it", async () => {
    const jobs = new JobRegistry({ cwd: root });
    let changes = 0;
    jobs.watch(() => changes++);
    const ops = buildBashOperations(root, allow, undefined, { jobs, defaultTimeoutSeconds: 60 });
    let shown = "";
    const call = ops.exec(ticking, root, { onData: (d) => (shown += d.toString()) });
    await until(() => shown.includes("tick 2"));
    assert.equal(jobs.foregroundShells().length, 1, "the running call is listed");
    const moved = jobs.backgroundAll();
    assert.equal(moved.length, 1);
    const id = moved[0]!.id;
    const result = await call;
    assert.equal(result.exitCode, 0);
    assert.match(shown, new RegExp(`moved this command to the background as ${id}`));
    assert.equal(jobs.foregroundShells().length, 0);
    const before = jobs.logs(id, { offset: 0 })!.size;
    await until(() => jobs.logs(id, { offset: 0 })!.text.includes("tick"));
    assert.ok(jobs.logs(id, { offset: 0 })!.size > before || before > 0);
    assert.equal(jobs.get(id)!.status, "running");
    const stopped = await jobs.stop(id, "stopped by the user");
    assert.equal(stopped!.status, "stopped");
    const size = jobs.logs(id, { offset: 0 })!.size;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(jobs.logs(id, { offset: 0 })!.size, size, "nothing writes after the stop: the process is gone");
    assert.ok(changes >= 3, "begin, move and end were announced");
  });

  it("still times out a call that was never moved", async () => {
    const jobs = new JobRegistry({ cwd: root });
    const ops = buildBashOperations(root, allow, undefined, { jobs, defaultTimeoutSeconds: 1 });
    let shown = "";
    const result = await ops.exec(ticking, root, { onData: (d) => (shown += d.toString()) });
    assert.notEqual(result.exitCode, 0);
    assert.match(shown, /lykos-timeout/);
    assert.equal(jobs.list().length, 0);
  });

  it("the turn's abort kills a call that was never moved", async () => {
    const jobs = new JobRegistry({ cwd: root });
    const ops = buildBashOperations(root, allow, undefined, { jobs, defaultTimeoutSeconds: 60 });
    const abort = new AbortController();
    let shown = "";
    const call = ops.exec(ticking, root, { onData: (d) => (shown += d.toString()), signal: abort.signal });
    await until(() => shown.includes("tick 1"));
    abort.abort();
    await assert.rejects(call, /aborted/);
    assert.equal(jobs.foregroundShells().length, 0);
  });
});
