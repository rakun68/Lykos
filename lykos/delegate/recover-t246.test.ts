// T246: `lykos recover`. A `lykos run` killed mid-run is listed with `next recover` and finished by a recover from
// another process, with never a second writer; a live or unknown owner is refused by pid; two recovers racing:
// one wins; the sixth crash stops the session.

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { defaultLedgerPath, openLedgerSync } from "../ledger/use.js";
import { ledgerViews } from "./mcp-server.js";
import { admit, ownerRow, takeOver } from "./ownership.js";
import { REVIEW_ROLE } from "./review.js";
import { INTERRUPTED_TURN, recoverSession } from "./recover.js";
import type { SessionRunner } from "./session-protocol.js";

const saved: Record<string, string | undefined> = {};
before(() => {
  const home = mkdtempSync(join(tmpdir(), "lykos-t246-home-"));
  for (const k of ["HOME", "USERPROFILE", "LYKOS_TRUST_WORKSPACE", "NODE_TEST_CONTEXT"]) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LYKOS_TRUST_WORKSPACE = "1";
  delete process.env.NODE_TEST_CONTEXT;
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const tsx = import.meta.resolve("tsx");
const cli = resolve("lykos", "cli.ts");
const lykos = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, ["--import", tsx, cli, ...args], { cwd, encoding: "utf8", windowsHide: true, input: "" });

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "lykos-t246-"));
}

/** A `lykos run` owner in a process of its own whose session never ends by itself. */
function owner(ws: string): ChildProcess {
  return spawn(process.execPath, ["--import", tsx, resolve("lykos", "delegate", "delegation-core.fixture.ts"), ws, join(ws, "never")], {
    stdio: "ignore",
    windowsHide: true,
  });
}

async function waitFor<T>(read: () => T | undefined, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error("timed out");
    await sleep(50);
  }
}

async function killed(child: ChildProcess): Promise<void> {
  child.kill("SIGKILL");
  if (child.exitCode === null && child.signalCode === null) await new Promise<void>((r) => child.once("exit", () => r()));
}

function withLedger<T>(ws: string, fn: (l: ReturnType<typeof openLedgerSync>) => T): T {
  const l = openLedgerSync(defaultLedgerPath(ws));
  try {
    return fn(l);
  } finally {
    l.close();
  }
}

describe("T246: lykos recover", () => {
  it("a run killed mid-run is listed with next recover, and a recover from another process finishes it with one writer (G10)", async () => {
    const ws = workspace();
    const child = owner(ws);
    const id = await waitFor(() => ledgerViews(ws)[0]?.session_id);
    const ownerPid = child.pid!;

    // While the owner lives, nothing takes it over: recover refuses, naming the pid.
    const refused = lykos(ws, "recover", id);
    assert.equal(refused.status, 1, refused.stderr);
    const refusal = JSON.parse(refused.stdout) as { message: string; owner_pid: number; next: string };
    assert.equal(refusal.owner_pid, ownerPid);
    assert.match(refusal.message, new RegExp(`pid ${ownerPid}`));
    assert.equal(ledgerViews(ws, [id])[0]!.owner_pid, ownerPid, "a refused recover changed nothing");

    await killed(child);
    const listed = JSON.parse(lykos(ws, "status", id).stdout) as { sessions: Array<{ state: string; next: string }>; next: string };
    assert.equal(listed.sessions[0]!.state, "crashed");
    assert.equal(listed.next, "recover");

    const writers: number[] = [];
    let brief = "";
    const run: SessionRunner = async ({ request }) => {
      brief = request.prompt;
      // The one writer while the recovered session runs: this process, and only this row is live.
      withLedger(ws, (l) => {
        const live = l.db.prepare("SELECT owner_pid FROM owners WHERE state IN ('running', 'waiting')").all() as Array<{ owner_pid: number }>;
        writers.push(...live.map((r) => r.owner_pid));
      });
      return { outcome: "ok", sessionId: request.sessionId ?? id, answer: "finished", steps: 1 };
    };
    const result = await recoverSession(ws, id, { trustSource: "flag", run });
    assert.equal(result.outcome !== "error", true, JSON.stringify(result));
    assert.deepEqual(writers, [process.pid]);
    assert.ok(brief.includes(INTERRUPTED_TURN), "it continues with the standard turn");
    assert.deepEqual(result.recovered, { from_pid: ownerPid, crashes: 1 });
    const after = ledgerViews(ws, [id])[0]!;
    assert.notEqual(after.state, "crashed");
    assert.notEqual(after.state, "running");
  });

  it("an owner the OS will not report is refused, naming its pid", async () => {
    const ws = workspace();
    const child = owner(ws);
    const id = await waitFor(() => ledgerViews(ws)[0]?.session_id);
    try {
      const res = await recoverSession(ws, id, { trustSource: "flag", livenessOf: () => "unknown" });
      assert.equal(res.outcome, "error");
      assert.equal(res.owner_pid, child.pid);
      assert.equal(res.owner_liveness, "unknown");
      assert.match(String(res.message), new RegExp(`pid ${child.pid}`));
    } finally {
      await killed(child);
    }
  });

  it("what the session started is confirmed stopped first; recover never kills it", async () => {
    const ws = workspace();
    const child = owner(ws);
    const id = await waitFor(() => ledgerViews(ws)[0]?.session_id);
    await killed(child);
    withLedger(ws, (l) => l.recordProcess({ kind: "child", sessionId: id, pid: 4242, command: "session-child" }));
    const res = await recoverSession(ws, id, { trustSource: "flag", quiescence: { livenessOf: (p) => (p.pid === 4242 ? "alive" : "dead") } });
    assert.equal(res.outcome, "error");
    assert.deepEqual(res.not_stopped, [{ kind: "child", pid: 4242, liveness: "alive" }]);
    assert.equal(ledgerViews(ws, [id])[0]!.state, "crashed", "still listed for recover");
  });

  it("two recovers racing: one wins, the other says it lost", async () => {
    const ws = workspace();
    const child = owner(ws);
    const id = await waitFor(() => ledgerViews(ws)[0]?.session_id);
    await killed(child);
    const read = withLedger(ws, (l) => ownerRow(l, id)!);
    // Both read the dead owner, then both try: the conditional update lets one through.
    const first = withLedger(ws, (l) => takeOver(l, read));
    const second = withLedger(ws, (l) => takeOver(l, read));
    assert.deepEqual(first, { ok: true, crashes: 1 });
    assert.equal(second.ok, false);
    assert.match((second as { reason: string }).reason, /another recover took session .* over first/);
  });

  it("the sixth crash stops the session with a reason", async () => {
    const ws = workspace();
    const child = owner(ws);
    const id = await waitFor(() => ledgerViews(ws)[0]?.session_id);
    await killed(child);
    withLedger(ws, (l) => l.db.prepare("UPDATE owners SET crashes = 5 WHERE session_id = ?").run(id));
    const res = await recoverSession(ws, id, { trustSource: "flag" });
    assert.equal(res.outcome, "error");
    assert.match(String(res.message), /crashed 6 times; it is stopped/);
    const view = ledgerViews(ws, [id])[0]!;
    assert.equal(view.state, "error");
    assert.match(JSON.stringify(view.result), /crashed 6 times/);
    withLedger(ws, (l) => assert.equal((l.db.prepare("SELECT COUNT(*) AS n FROM tree_locks WHERE session_id = ?").get(id) as { n: number }).n, 0));
  });

  it("a recover refused at admission (the project cap is full) counts no crash and leaves the session crashed", async () => {
    const ws = workspace();
    const deadPid = 2147483000;
    withLedger(ws, (l) => {
      for (const id of ["sess-crashed", "live-1", "live-2", "live-3", "live-4"]) assert.equal(admit(l, { sessionId: id, owner: "run", specialist: "implement", projectCap: 100 }).ok, true);
      l.db.prepare("UPDATE owners SET owner_pid = ?, owner_recorded_at_ms = 1 WHERE session_id = ?").run(deadPid, "sess-crashed");
    });
    let runs = 0;
    const run: SessionRunner = async ({ request }) => {
      runs += 1;
      return { outcome: "ok", sessionId: request.sessionId!, answer: "ran", steps: 1 };
    };
    const res = await recoverSession(ws, "sess-crashed", { trustSource: "flag", run });
    assert.equal(runs, 0, "the cap refused the run");
    assert.equal(res.outcome, "blocked", JSON.stringify(res));
    assert.equal(res.recovered, undefined, "nothing was recovered");
    const row = withLedger(ws, (l) => ownerRow(l, "sess-crashed")!);
    assert.equal(row.crashes, 0, "a refused recover counted no crash");
    assert.equal(row.owner_pid, deadPid, "the row names its dead owner again");
    assert.equal(ledgerViews(ws, ["sess-crashed"])[0]!.state, "crashed", "still listed for recover");
  });

  it("a recovered reviewer is still a review: it keeps the finding tool", async () => {
    const ws = workspace();
    withLedger(ws, (l) => {
      assert.equal(admit(l, { sessionId: "sess-review", owner: "run", specialist: REVIEW_ROLE, projectCap: 100 }).ok, true);
      l.db.prepare("UPDATE owners SET owner_pid = ?, owner_recorded_at_ms = 1 WHERE session_id = ?").run(2147483000, "sess-review");
    });
    let review: boolean | undefined;
    const run: SessionRunner = async ({ request }) => {
      review = request.review;
      return { outcome: "ok", sessionId: request.sessionId!, answer: "reviewed", steps: 1 };
    };
    await recoverSession(ws, "sess-review", { trustSource: "flag", run });
    assert.equal(review, true);
  });

  it("--max-steps reaches the recovered session's run; --add is refused for a session (it is a cycle's)", async () => {
    const ws = workspace();
    withLedger(ws, (l) => {
      assert.equal(admit(l, { sessionId: "sess-cap", owner: "run", specialist: "implement", projectCap: 100 }).ok, true);
      l.db.prepare("UPDATE owners SET owner_pid = ?, owner_recorded_at_ms = 1 WHERE session_id = ?").run(2147483000, "sess-cap");
    });
    let steps: number | undefined;
    const run: SessionRunner = async ({ request }) => {
      steps = request.maxSteps;
      return { outcome: "ok", sessionId: request.sessionId!, answer: "done", steps: 1 };
    };
    await recoverSession(ws, "sess-cap", { trustSource: "flag", run, maxSteps: 7 });
    assert.equal(steps, 7);
    const r = lykos(ws, "recover", "sess-cap", "--add", "one more");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--add is an item for a review cycle/);
  });

  it("no arguments prints the usage", () => {
    const r = lykos(workspace(), "recover");
    assert.equal(r.status, 2);
    assert.match(r.stdout, /usage: lykos recover/);
  });
});
