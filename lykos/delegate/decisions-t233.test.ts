// T233: accept, reject, merged, discard. The commands run through the real CLI against a real project ledger; the
// crashed session is one whose owner process was really killed (R6). No arguments prints usage and the causes (R12).

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { defaultLedgerPath, openLedgerSync } from "../ledger/use.js";
import { CAUSES, DECISIONS, recordFindingDecision } from "./decisions.js";
import { ledgerViews } from "./mcp-server.js";

const saved: Record<string, string | undefined> = {};
before(() => {
  const home = mkdtempSync(join(tmpdir(), "lykos-t233-home-"));
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
const fixture = resolve("lykos", "delegate", "delegation-core.fixture.ts");
const lykos = (cwd: string, ...args: string[]) => spawnSync(process.execPath, ["--import", tsx, cli, ...args], { cwd, encoding: "utf8", windowsHide: true, input: "" });

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "lykos-t233-"));
}

/** A session that ran to its end in a process of its own: its row is `done`. */
function endedSession(ws: string): string {
  const release = join(ws, "release");
  writeFileSync(release, "");
  const ran = spawnSync(process.execPath, ["--import", tsx, fixture, ws, release], { encoding: "utf8", windowsHide: true });
  assert.equal(ran.status, 0, ran.stderr);
  const view = ledgerViews(ws)[0]!;
  assert.equal(view.state, "done");
  return view.session_id;
}

/** A session whose owner process is really killed while it runs. */
async function crashedSession(ws: string): Promise<string> {
  const child: ChildProcess = spawn(process.execPath, ["--import", tsx, fixture, ws, join(ws, "never")], { stdio: "ignore", windowsHide: true });
  const until = Date.now() + 30_000;
  let id: string | undefined;
  while ((id = ledgerViews(ws)[0]?.session_id) === undefined) {
    if (Date.now() > until) throw new Error("the owner never admitted its session");
    await sleep(50);
  }
  child.kill("SIGKILL");
  if (child.exitCode === null && child.signalCode === null) await new Promise<void>((r) => child.once("exit", () => r()));
  assert.equal(ledgerViews(ws, [id])[0]!.state, "crashed");
  return id;
}

function treeLocks(ws: string, id: string): number {
  const l = openLedgerSync(defaultLedgerPath(ws));
  try {
    return (l.db.prepare("SELECT COUNT(*) AS n FROM tree_locks WHERE session_id = ?").get(id) as { n: number }).n;
  } finally {
    l.close();
  }
}

describe("T233: decisions", () => {
  it("each command with no arguments prints its usage and every cause (R12)", () => {
    for (const kind of DECISIONS) {
      const r = lykos(workspace(), kind);
      assert.equal(r.status, 2, `${kind}: ${r.stderr}`);
      assert.match(r.stdout, new RegExp(`usage: lykos ${kind} <session-id> --why <reason>`));
      for (const cause of CAUSES) assert.ok(r.stdout.includes(cause), `${kind} lists ${cause}`);
    }
  });

  it("records a decision with cause, reason and actor, and status shows the history", () => {
    const ws = workspace();
    const id = endedSession(ws);
    const rejected = lykos(ws, "reject", id, "--why", "the fix left a stand-in", "--cause", "worker_careless", "--actor", "ada");
    assert.equal(rejected.status, 0, rejected.stderr);
    const accepted = lykos(ws, "accept", id, "--why", "second attempt passes");
    assert.equal(accepted.status, 0, accepted.stderr);
    const merged = lykos(ws, "merged", id, "--why", "merged as abc123");
    assert.equal(merged.status, 0, merged.stderr);

    const status = JSON.parse(lykos(ws, "status", id).stdout) as { sessions: Array<{ decisions: Array<Record<string, unknown>> }> };
    const history = status.sessions[0]!.decisions.map(({ decision, cause, reason, actor }) => ({ decision, cause, reason, actor }));
    assert.deepEqual(history, [
      { decision: "reject", cause: "worker_careless", reason: "the fix left a stand-in", actor: "ada" },
      { decision: "accept", cause: null, reason: "second attempt passes", actor: "coordinator" },
      { decision: "merged", cause: null, reason: "merged as abc123", actor: "coordinator" },
    ]);
  });

  it("refuses an unknown cause, a missing reason and an unknown session, recording nothing", () => {
    const ws = workspace();
    const id = endedSession(ws);
    const badCause = lykos(ws, "reject", id, "--why", "x", "--cause", "bad_luck");
    assert.equal(badCause.status, 1);
    assert.match(badCause.stderr, /unknown cause "bad_luck"/);
    assert.ok(badCause.stderr.includes("spec_vague"), "it lists the causes");
    const noWhy = lykos(ws, "accept", id);
    assert.equal(noWhy.status, 1);
    assert.match(noWhy.stderr, /--why <reason> is required/);
    const unknown = lykos(ws, "accept", "nope", "--why", "x");
    assert.equal(unknown.status, 1);
    assert.match(unknown.stdout, /unknown session id: nope/);
    assert.equal((JSON.parse(lykos(ws, "status", id).stdout) as { sessions: Array<{ decisions?: unknown }> }).sessions[0]!.decisions, undefined);
  });

  it("discard records an outcome for a session whose owner process was killed (R6)", async () => {
    const ws = workspace();
    const id = await crashedSession(ws);
    assert.equal(treeLocks(ws, id), 1, "the crash left the tree lock");

    // A crashed session has no result to accept; it is recovered or discarded.
    const accept = lykos(ws, "accept", id, "--why", "x");
    assert.equal(accept.status, 1);
    assert.equal((JSON.parse(accept.stdout) as { next: string }).next, "recover");

    const discarded = lykos(ws, "discard", id, "--why", "owner died; start over", "--cause", "env");
    assert.equal(discarded.status, 0, discarded.stdout + discarded.stderr);
    const out = JSON.parse(discarded.stdout) as { decision: string; cause: string; crashed_session_ended: boolean };
    assert.equal(out.decision, "discard");
    assert.equal(out.cause, "env");
    assert.equal(out.crashed_session_ended, true);

    const view = ledgerViews(ws, [id])[0]!;
    assert.equal(view.state, "stopped", "no longer crashed, so `next recover` is gone");
    assert.notEqual(view.next, "recover");
    assert.equal(view.decisions?.[0]?.decision, "discard");
    assert.equal(treeLocks(ws, id), 0, "its tree lock is let go");
    const again = lykos(ws, "recover", id);
    assert.equal(again.status, 1, "a discarded session is not recovered");
  });

  it("discard on a crashed session waits for confirmed quiescence and never kills", async () => {
    const ws = workspace();
    const id = await crashedSession(ws);
    // A process the session started that is still alive: this test's own pid, recorded as the session's child.
    const l = openLedgerSync(defaultLedgerPath(ws));
    try {
      l.recordProcess({ kind: "child", sessionId: id, pid: process.pid, command: "session-child" });
    } finally {
      l.close();
    }
    const refused = lykos(ws, "discard", id, "--why", "x");
    assert.equal(refused.status, 1);
    assert.match((JSON.parse(refused.stdout) as { message: string }).message, /not confirmed stopped/);
    assert.equal(ledgerViews(ws, [id])[0]!.state, "crashed", "nothing changed");
  });

  it("refuses a decision on a session whose owner is alive", async () => {
    const ws = workspace();
    const child: ChildProcess = spawn(process.execPath, ["--import", tsx, fixture, ws, join(ws, "never")], { stdio: "ignore", windowsHide: true });
    try {
      const until = Date.now() + 30_000;
      let id: string | undefined;
      while ((id = ledgerViews(ws)[0]?.session_id) === undefined) {
        if (Date.now() > until) throw new Error("the owner never admitted its session");
        await sleep(50);
      }
      const r = lykos(ws, "discard", id, "--why", "x");
      assert.equal(r.status, 1);
      assert.match((JSON.parse(r.stdout) as { message: string }).message, new RegExp(`pid ${child.pid}`));
      assert.equal(ledgerViews(ws, [id])[0]!.state, "running");
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("status shows the findings the cycle forwarded, dropped or retired", () => {
    const ws = workspace();
    const id = endedSession(ws);
    const l = openLedgerSync(defaultLedgerPath(ws));
    try {
      recordFindingDecision(l, { sessionId: id, cycleId: "c1", findingId: "f1", action: "forwarded", reason: "reproduced" });
      recordFindingDecision(l, { sessionId: id, cycleId: "c1", findingId: "f2", action: "dropped", reason: "low, no reproduction" });
      recordFindingDecision(l, { sessionId: id, findingId: "f1", action: "retired", reason: "fixed in round 2" });
    } finally {
      l.close();
    }
    const view = (JSON.parse(lykos(ws, "status", id).stdout) as { sessions: Array<{ finding_decisions: Array<Record<string, unknown>> }> }).sessions[0]!;
    assert.deepEqual(
      view.finding_decisions.map(({ cycle_id, finding_id, action, reason }) => ({ cycle_id, finding_id, action, reason })),
      [
        { cycle_id: "c1", finding_id: "f1", action: "forwarded", reason: "reproduced" },
        { cycle_id: "c1", finding_id: "f2", action: "dropped", reason: "low, no reproduction" },
        { cycle_id: null, finding_id: "f1", action: "retired", reason: "fixed in round 2" },
      ],
    );
  });
});
