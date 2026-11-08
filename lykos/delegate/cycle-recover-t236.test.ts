// T236 (G10): a `lykos cycle` whose process dies is listed with `next recover`, and `lykos recover <cycle>` continues it from
// its last written step. Real processes: the cycle owner runs in a process of its own (cycle.fixture.ts) and is killed with
// SIGKILL while its fixer runs; the recover is a second process's (this one). The sessions are stand-ins; the real
// session child, with a real job, is cycle-kill-t236.test.ts.
//
// What must hold: nothing is taken over while the owner lives; the dead cycle shows in `status` as crashed with `next
// recover`, whether asked for by id or with --all; recover continues the step that was running, finding its session by the
// request id, so no second fixer is started; the fixer's session is the one that is recovered (a standard turn, a crash
// counted); the cycle then goes on to its proof, its recheck and approve; a second recover racing the first loses.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { defaultLedgerPath, withLedgerSync } from "../ledger/use.js";
import { TranscriptWriter } from "../session/transcript.js";
import { openLedgerSync } from "../ledger/use.js";
import { cycleViews, recoverCycle, runCycle } from "./cycle.js";
import type { ClaimCheck } from "./claims.js";
import { recordFinding } from "./findings.js";
import { runDelegated } from "./mcp-server.js";
import { ownerRow } from "./ownership.js";
import { INTERRUPTED_TURN, recoverSession } from "./recover.js";
import type { SessionOutcome, SessionRequest, SessionRunner } from "./session-protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "..", "fixtures", "demo");
const tsx = import.meta.resolve("tsx");
const cli = resolve("lykos", "cli.ts");

const saved: Record<string, string | undefined> = {};
before(() => {
  const home = mkdtempSync(join(tmpdir(), "lykos-t236r-home-"));
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

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();
const lykos = (cwd: string, ...args: string[]) => spawnSync(process.execPath, ["--import", tsx, cli, ...args], { cwd, encoding: "utf8", windowsHide: true, input: "" });

function put(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

const REPRO: ClaimCheck = {
  kind: "reproduction",
  file: "test/cycle-repro.test.js",
  content: `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { applyDiscount } from "../src/pricing.js";\ntest("a discount above 100 percent never makes a price negative", () => assert.equal(applyDiscount(1000, 150), 0));\n`,
  fails: ["a discount above 100 percent never makes a price negative"],
};
const IMPLEMENTED = readFileSync(join(FIXTURE, "src", "pricing.js"), "utf8").replace("return 0;", "return Math.floor((cents * (100 - clampPercent(percent))) / 100 + 0.5);");
const FIXED = IMPLEMENTED.replace("Math.min(1000,", "Math.min(100,");

function endedSession(ws: string, id: string): void {
  const ledgerPath = defaultLedgerPath(ws);
  const ledger = openLedgerSync(ledgerPath);
  try {
    ledger.startSession({ id, brief: "Implement applyDiscount.", model: "omniroute/deepseek/deepseek-v4", executionShape: "mcp_worker", runtime: "host", workspace: ws, captureMode: "stream" });
    const transcript = new TranscriptWriter(ledgerPath, id);
    transcript.append({ kind: "assistant_message", text: "done", final: false });
    const file = transcript.finalize();
    ledger.endSession({ id, transcriptPath: file.path, transcriptSha256: file.sha256, transcriptBytes: file.bytes } as Parameters<typeof ledger.endSession>[0]);
  } finally {
    ledger.close();
  }
}

function commitOnBranch(ws: string, id: string, text: string, create: boolean): void {
  const dir = join(mkdtempSync(join(tmpdir(), "lykos-t236r-wt-")), "wt");
  if (create) git(ws, "worktree", "add", "-q", "-b", `lykos/${id}`, dir, "HEAD");
  else git(ws, "worktree", "add", "-q", dir, `lykos/${id}`);
  try {
    put(dir, "src/pricing.js", text);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", create ? "implement" : "fix");
  } finally {
    git(ws, "worktree", "remove", "--force", dir);
  }
}

interface World {
  ws: string;
  implementer: string;
  /** A runner for what the test itself runs: the review, and later the recovered fixer and the recheck. */
  run: SessionRunner;
  calls: SessionRequest[];
  /** What the next in-process fixer commits (nothing: it fails), and what the next reviewer records. */
  next: { fix: Array<{ fail?: string; text?: string }>; review: Array<{ findings: Array<Parameters<typeof recordFinding>[2]> }> };
}

async function world(): Promise<World> {
  const ws = mkdtempSync(join(tmpdir(), "lykos-t236r-ws-"));
  cpSync(FIXTURE, ws, { recursive: true });
  git(ws, "init", "-q", "-b", "main");
  git(ws, "config", "core.autocrlf", "false");
  put(ws, ".gitignore", ".lykos/\nnode_modules/\n");
  put(ws, ".lykos/config.yaml", "seal:\n  test_command: node --test {files}\ndelegation:\n  spec_check: false\nfeedback:\n  enabled: false\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "first");
  const calls: SessionRequest[] = [];
  const next: World["next"] = { fix: [], review: [] };
  const run: SessionRunner = async ({ request }) => {
    const req = request as SessionRequest;
    calls.push(req);
    if (req.review === true) {
      const step = next.review.shift() ?? { findings: [] };
      const id = req.sessionId ?? req.newSessionId ?? `t236r-rev-${calls.length}`;
      if (req.sessionId === undefined) endedSession(ws, id);
      const ledger = openLedgerSync(defaultLedgerPath(ws));
      try {
        for (const f of step.findings) recordFinding(ledger, id, f);
      } finally {
        ledger.close();
      }
      return { outcome: "ok", answer: "reviewed", sessionId: id } as SessionOutcome;
    }
    const step = next.fix.shift() ?? {};
    if (step.fail !== undefined) return { outcome: "error", message: step.fail, sessionId: req.sessionId } as SessionOutcome;
    if (step.text !== undefined) commitOnBranch(ws, req.sessionId!, step.text, false);
    return { outcome: "ok", answer: "fixed", sessionId: req.sessionId, branch: `lykos/${req.sessionId}` } as SessionOutcome;
  };
  const made = await runDelegated(ws, { brief: "Implement applyDiscount.", specialist: "implement" }, {
    trustSource: "flag",
    run: async ({ request }) => {
      const id = (request as SessionRequest).newSessionId!;
      commitOnBranch(ws, id, IMPLEMENTED, true);
      endedSession(ws, id);
      return { outcome: "ok", answer: "done", sessionId: id, branch: `lykos/${id}` } as SessionOutcome;
    },
  });
  return { ws, implementer: made["sessionId"] as string, run, calls, next };
}

async function waitFor<T>(read: () => T | undefined, ms = 60_000): Promise<T> {
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

type Cycle = Record<string, unknown> & { outcome?: string; stop?: string; cycle_id?: string; next?: string; message?: string; owner_pid?: number; recovered?: { from_pid: number; crashes: number } };

describe("T236 ACCEPTANCE (G10): the cycle process killed while its fixer runs", () => {
  it("is listed with next recover, recover continues it from its last written step, and no second fixer starts", async () => {
    const w = await world();
    // Round 1 runs here: the reviewer finds the planted bug, the harness reproduces it, and the first fix fails on the
    // environment, so the cycle stops with the review and the judge written and a fix to rerun.
    w.next.review.push({ findings: [{ text: "a discount above 100 percent makes the price negative", severity: "high", basis: "src/pricing.js:5", check: REPRO }] });
    w.next.fix.push({ fail: "502 Bad Gateway" });
    const first = (await runCycle(w.ws, w.implementer, { trustSource: "stored", run: w.run })) as Cycle;
    assert.equal(first.stop, "fix_environment", JSON.stringify(first));
    const cycleId = first.cycle_id!;

    // The cycle's owner, in a process of its own, resumes it: the rerun of the fix starts and never ends.
    const log = join(w.ws, "fixture.log");
    writeFileSync(log, "");
    const owner = spawn(process.execPath, ["--import", tsx, resolve("lykos", "delegate", "cycle.fixture.ts"), w.ws, cycleId, log], { stdio: "ignore", windowsHide: true });
    await waitFor(() => (readFileSync(log, "utf8").includes('"review":false') ? true : undefined));
    const ownerPid = owner.pid!;
    const fixStep = withLedgerSync(defaultLedgerPath(w.ws), (l) => l.db.prepare("SELECT step_id, request_id FROM cycle_steps WHERE cycle_id = ? AND kind = 'fix' AND state = 'started'").get(cycleId)) as { step_id: string; request_id: string };
    assert.equal(fixStep.request_id, `${cycleId}.${fixStep.step_id}`);

    // While the owner lives nothing is taken over: recover refuses, naming the pid, and changes nothing.
    const refused = lykos(w.ws, "recover", cycleId);
    assert.equal(refused.status, 1, refused.stderr);
    const refusal = JSON.parse(refused.stdout) as Cycle;
    assert.equal(refusal.owner_pid, ownerPid);
    assert.match(String(refusal.message), new RegExp(`pid ${ownerPid}`));
    assert.equal(cycleViews(w.ws, [cycleId])[0]!.owner_pid, ownerPid);
    const running = JSON.parse(lykos(w.ws, "status", cycleId).stdout) as { cycles: Array<{ state: string }>; next: string };
    assert.equal(running.cycles[0]!.state, "running");
    assert.equal(running.next, "wait");

    await killed(owner);

    // Dead: `status` lists the cycle, by id and with --all, with next recover; so is the fixer session it was running.
    const byId = JSON.parse(lykos(w.ws, "status", cycleId).stdout) as { cycles: Array<{ state: string; next: string; step?: { kind: string; state: string } }>; next: string };
    assert.equal(byId.cycles[0]!.state, "crashed");
    assert.equal(byId.cycles[0]!.next, "recover");
    assert.deepEqual(byId.cycles[0]!.step && [byId.cycles[0]!.step.kind, byId.cycles[0]!.step.state], ["fix", "started"], "the step it died in is the last written");
    assert.equal(byId.next, "recover");
    const all = JSON.parse(lykos(w.ws, "status", "--all").stdout) as { cycles: Array<{ cycle_id: string; next: string }>; sessions: Array<{ session_id: string; state: string }>; next: string };
    assert.deepEqual(all.cycles.map((c) => [c.cycle_id, c.next]), [[cycleId, "recover"]]);
    assert.equal(all.sessions.find((s) => s.session_id === w.implementer)!.state, "crashed");
    assert.equal(all.next, "recover");
    // A resume is not a recover: it is refused, pointing at recover.
    const resumed = (await runCycle(w.ws, cycleId, { trustSource: "stored", run: w.run })) as Cycle;
    assert.equal(resumed.next, "recover", JSON.stringify(resumed));
    assert.equal(w.calls.length, 2, "nothing was started by the refused resume");
    // A recover of the fixer's session alone is refused, pointing at its cycle: recovering it there would leave the
    // cycle crashed with a step whose session had ended.
    const lone = await recoverSession(w.ws, w.implementer, { trustSource: "stored", run: w.run });
    assert.equal(lone.outcome, "error", JSON.stringify(lone));
    assert.equal(lone.next, "recover");
    assert.equal(lone.cycle_id, cycleId);
    assert.equal(w.calls.length, 2, "the refused session recover started nothing");
    assert.equal(withLedgerSync(defaultLedgerPath(w.ws), (l) => ownerRow(l, w.implementer)!.crashes), 0, "and counted no crash");

    // The recover, from this process: the fixer is recovered in its own session, once; the cycle goes on and approves.
    const before = w.calls.length;
    w.next.fix.push({ text: FIXED });
    w.next.review.push({ findings: [] });
    const recovered = (await recoverCycle(w.ws, cycleId, { trustSource: "stored", run: w.run, maxSteps: 7 })) as Cycle;
    assert.equal(recovered.stop, "approve", JSON.stringify(recovered));
    assert.deepEqual(recovered.recovered, { from_pid: ownerPid, crashes: 1 });
    const fixers = w.calls.slice(before).filter((c) => c.review !== true);
    assert.equal(fixers.length, 1, "one fixer ran after the recover: the dead one's own session, continued");
    assert.equal(fixers[0]!.sessionId, w.implementer);
    assert.ok(fixers[0]!.prompt.includes(INTERRUPTED_TURN), "it continues with the standard turn");
    assert.equal(fixers[0]!.requestId, undefined, "no new request: the step's request id found the session it had started");
    assert.equal(fixers[0]!.maxSteps, 7, "--max-steps given to the recover caps the session it recovers");
    assert.ok(w.calls.slice(before).filter((c) => c.review === true).every((c) => c.maxSteps === 7), "and the recheck");
    // The ledger: the step's request id names one session; that session counted one crash; the fixer ran twice in all (the
    // 502 and the cut-off one, each its own step), and the recover added none.
    const ledger = openLedgerSync(defaultLedgerPath(w.ws));
    try {
      assert.equal((ledger.db.prepare("SELECT COUNT(*) AS n FROM owner_requests WHERE request_id = ?").get(fixStep.request_id) as { n: number }).n, 1);
      assert.equal(ownerRow(ledger, w.implementer)!.crashes, 1);
      assert.equal((ledger.db.prepare("SELECT COUNT(*) AS n FROM cycle_steps WHERE cycle_id = ? AND kind = 'fix'").get(cycleId) as { n: number }).n, 2);
    } finally {
      ledger.close();
    }
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1, "the killed owner started exactly one session");
    assert.match(git(w.ws, "show", `lykos/${w.implementer}:src/pricing.js`), /Math\.min\(100,/);
    assert.equal(cycleViews(w.ws, [cycleId])[0]!.state, "done");
  });

  it("a second recover racing the first loses and says so; a recover of a cycle that is not crashed is refused", async () => {
    const w = await world();
    w.next.review.push({ findings: [{ text: "a discount above 100 percent makes the price negative", severity: "high", basis: "src/pricing.js:5", check: REPRO }] });
    w.next.fix.push({ fail: "502" });
    const first = (await runCycle(w.ws, w.implementer, { trustSource: "stored", run: w.run })) as Cycle;
    const cycleId = first.cycle_id!;
    const notCrashed = (await recoverCycle(w.ws, cycleId, { trustSource: "stored", run: w.run })) as Cycle;
    assert.equal(notCrashed.outcome, "error");
    assert.equal(notCrashed.next, "resume");
    assert.match(String(notCrashed.message), /stopped, not crashed/);

    const log = join(w.ws, "fixture.log");
    writeFileSync(log, "");
    const owner = spawn(process.execPath, ["--import", tsx, resolve("lykos", "delegate", "cycle.fixture.ts"), w.ws, cycleId, log], { stdio: "ignore", windowsHide: true });
    await waitFor(() => (readFileSync(log, "utf8").includes('"review":false') ? true : undefined));
    await killed(owner);

    w.next.fix.push({ text: FIXED });
    w.next.review.push({ findings: [] });
    const [a, b] = await Promise.all([
      recoverCycle(w.ws, cycleId, { trustSource: "stored", run: w.run }) as Promise<Cycle>,
      recoverCycle(w.ws, cycleId, { trustSource: "stored", run: w.run }) as Promise<Cycle>,
    ]);
    const winners = [a, b].filter((r) => r.stop === "approve");
    const losers = [a, b].filter((r) => r.outcome === "error");
    assert.equal(winners.length, 1, JSON.stringify([a, b]));
    assert.equal(losers.length, 1);
    assert.match(String(losers[0]!.message), /another recover took cycle/);
    assert.equal(w.calls.filter((c) => c.sessionId === w.implementer && c.review !== true).length, 2, "the 502 fixer and the one recovered fixer; the loser started none");
  });

  it("a process a cycle's session started that is still alive refuses the recover, and nothing is taken over", async () => {
    const w = await world();
    w.next.review.push({ findings: [] });
    const first = (await runCycle(w.ws, w.implementer, { trustSource: "stored", run: w.run })) as Cycle;
    assert.equal(first.stop, "approve");
    const reviewer = withLedgerSync(defaultLedgerPath(w.ws), (l) => (l.db.prepare("SELECT session_id FROM cycle_steps WHERE cycle_id = ? AND kind = 'review'").get(first.cycle_id) as { session_id: string }).session_id);
    withLedgerSync(defaultLedgerPath(w.ws), (l) => {
      l.db.prepare("UPDATE cycles SET state = 'running', stop = NULL, owner_pid = 2147483000, owner_recorded_at_ms = 1, crashes = 0 WHERE id = ?").run(first.cycle_id);
      // The reviewer's child, still alive: this test's own process.
      l.recordProcess({ kind: "child", sessionId: reviewer, pid: process.pid, command: "session-child" });
    });
    const before = w.calls.length;
    const res = (await recoverCycle(w.ws, first.cycle_id!, { trustSource: "stored", run: w.run, livenessOf: () => "dead" })) as Cycle;
    assert.equal(res.outcome, "error", JSON.stringify(res));
    assert.match(String(res.message), new RegExp(`session ${reviewer} started is not confirmed stopped`));
    assert.equal(res.next, "fix_environment");
    assert.equal(w.calls.length, before, "nothing ran");
    const row = withLedgerSync(defaultLedgerPath(w.ws), (l) => l.db.prepare("SELECT owner_pid, crashes FROM cycles WHERE id = ?").get(first.cycle_id)) as { owner_pid: number; crashes: number };
    assert.deepEqual(row, { owner_pid: 2147483000, crashes: 0 }, "not taken over, no crash counted");
  });

  it("the sixth crash stops the cycle with the reason, and lets it go", async () => {
    const w = await world();
    w.next.review.push({ findings: [] });
    const first = (await runCycle(w.ws, w.implementer, { trustSource: "stored", run: w.run })) as Cycle;
    assert.equal(first.stop, "approve");
    // A cycle row that crashed five times already, with an owner that is gone.
    withLedgerSync(defaultLedgerPath(w.ws), (l) => {
      l.db.prepare("UPDATE cycles SET state = 'running', stop = NULL, owner_pid = 2147483000, owner_recorded_at_ms = 1, crashes = 5 WHERE id = ?").run(first.cycle_id);
    });
    const res = (await recoverCycle(w.ws, first.cycle_id!, { trustSource: "stored", run: w.run, livenessOf: () => "dead" })) as Cycle;
    assert.equal(res.outcome, "error", JSON.stringify(res));
    assert.match(String(res.message), /crashed 6 times/);
    const view = cycleViews(w.ws, [first.cycle_id!])[0]!;
    assert.equal(view.state, "stopped");
    // The result says what the stopped cycle says: never to wait on a cycle that is stopped.
    assert.equal(res.next, "fix_environment");
    assert.equal(view.next, res.next);
  });
});
