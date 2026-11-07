// T236 ACCEPTANCE (ADR-0059, ADR-0061, spec decisions 13 and 18): `lykos cycle` reviews a session's change, has the
// session fix what the review proves, and has the same reviewer recheck.
//
// Seams:
//   - `runCycle` and `recoverCycle`, the core `lykos cycle`, `lykos recover` and the MCP tool are front ends over, on a
//     real git repository (the T253 demonstration fixture, planted bug and all). The session runner is a stand-in, as in
//     review-t235.test.ts: an implementer that commits on its `lykos/<id>` branch, a reviewer that records findings through
//     `recordFinding` (the writer the `finding` tool uses), a fixer that commits on the implementer's branch. Everything
//     the harness does is real: the checks run in temporary worktrees with `node --test`, the ledger rows are read back.
//   - `evaluate`, the rule for what comes next, and the briefs, on their inputs.
//   - `lykos cycle` the command: its usage and its refusals (a cap is not a flag).
//   - A real `lykos cycle` process killed in its fixer: cycle-kill-t236.test.ts.
//
// Lessons held here: G3, G4 (an environment or provider error stops the round before tests, and a resume reruns that step
// only), G6 (every option works at start and at resume), G11 (the caps are in config only), R8 (only the steps the cycle
// needs), R20 (a finding reaches the fixer whole), W3 (the fix and round caps, and a stall), cause `worker_careless`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { runCycleCommand, CYCLE_USAGE } from "../cli/delegation.js";
import { SHIPPED_DEFAULTS } from "../config/defaults.js";
import { loadConfig } from "../config/load.js";
import { defaultLedgerPath, openLedgerSync, withLedgerSync } from "../ledger/use.js";
import { TranscriptWriter } from "../session/transcript.js";
import { capsOf, cycleViews, evaluate, fixBrief, recheckBrief, renderItem, runCycle, stepsOf, type Item, type Step } from "./cycle.js";
import type { ClaimCheck } from "./claims.js";
import { findingDecisionsOf } from "./decisions.js";
import { recordFinding, type FindingInput } from "./findings.js";
import { createMcpServer, runDelegated, steerElsewhere } from "./mcp-server.js";
import { runReview } from "./review.js";
import type { SessionOutcome, SessionRequest, SessionRunner } from "./session-protocol.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "demo");

const saved: Record<string, string | undefined> = {};
let home: string;
before(() => {
  home = mkdtempSync(join(tmpdir(), "lykos-t236-home-"));
  for (const k of ["HOME", "USERPROFILE", "LYKOS_TRUST_WORKSPACE", "NODE_TEST_CONTEXT"]) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.LYKOS_TRUST_WORKSPACE;
  delete process.env.NODE_TEST_CONTEXT;
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();
}
function put(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

const BASE_CONFIG = "seal:\n  test_command: node --test {files}\ndelegation:\n  spec_check: false\nfeedback:\n  enabled: false\n";

/** The demonstration fixture as a git repository, its planted bug (`clampPercent` allows 1000) in place. */
function repo(config = BASE_CONFIG): string {
  const ws = mkdtempSync(join(tmpdir(), "lykos-t236-ws-"));
  cpSync(FIXTURE, ws, { recursive: true });
  git(ws, "init", "-q", "-b", "main");
  git(ws, "config", "core.autocrlf", "false");
  put(ws, ".gitignore", ".lykos/\nnode_modules/\n");
  put(ws, ".lykos/config.yaml", config);
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "first");
  return ws;
}

/** `applyDiscount` as the sealed test wants it, with the planted bug still in `clampPercent`. */
const IMPLEMENTED = {
  "src/pricing.js": readFileSync(join(FIXTURE, "src", "pricing.js"), "utf8").replace("return 0;", "return Math.floor((cents * (100 - clampPercent(percent))) / 100 + 0.5);"),
};
const FIXED_CLAMP = {
  "src/pricing.js": IMPLEMENTED["src/pricing.js"].replace("Math.min(1000,", "Math.min(100,"),
};

const REPRO_TEST = `
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDiscount } from "../src/pricing.js";
test("a discount above 100 percent never makes a price negative", () => assert.equal(applyDiscount(1000, 150), 0));
`;
const REPRO: ClaimCheck = { kind: "reproduction", file: "test/cycle-repro.test.js", content: REPRO_TEST, fails: ["a discount above 100 percent never makes a price negative"] };
/** A finding with the reproduction by default; `check: null` is one the reviewer could not reproduce. */
const finding = (over: Partial<Omit<FindingInput, "check">> & { check?: ClaimCheck | null } = {}): FindingInput => {
  const { check = REPRO, ...rest } = over;
  return {
    text: "applyDiscount lets a discount above 100 percent make the price negative (SPEC rule 1 and 2)",
    severity: "high",
    basis: "src/pricing.js:5",
    ...rest,
    ...(check !== null ? { check } : {}),
  };
};

// ---------------------------------------------------------------------------
// The session runners: one stand-in for every session a cycle starts

let counter = 0;

function endedSession(ws: string, id: string, brief: string, model: string): void {
  const ledgerPath = defaultLedgerPath(ws);
  const ledger = openLedgerSync(ledgerPath);
  try {
    ledger.startSession({ id, brief, model, executionShape: "mcp_worker", runtime: "host", workspace: ws, captureMode: "stream" });
    const transcript = new TranscriptWriter(ledgerPath, id);
    transcript.append({ kind: "assistant_message", text: "done", final: false });
    const file = transcript.finalize();
    ledger.endSession({ id, transcriptPath: file.path, transcriptSha256: file.sha256, transcriptBytes: file.bytes } as Parameters<typeof ledger.endSession>[0]);
  } finally {
    ledger.close();
  }
}

/** Commits `files` on the branch `lykos/<id>`, through a temporary worktree. */
function commitOnBranch(ws: string, id: string, files: Record<string, string>, message: string, newBranchFrom?: string): void {
  const dir = join(mkdtempSync(join(tmpdir(), "lykos-t236-wt-")), "wt");
  if (newBranchFrom !== undefined) git(ws, "worktree", "add", "-q", "-b", `lykos/${id}`, dir, newBranchFrom);
  else git(ws, "worktree", "add", "-q", dir, `lykos/${id}`);
  try {
    for (const [rel, text] of Object.entries(files)) put(dir, rel, text);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", message);
  } finally {
    git(ws, "worktree", "remove", "--force", dir);
  }
}

/** One reviewer invocation's script: the findings it records, or what it does instead. */
interface ReviewerStep {
  findings?: FindingInput[];
  /** Asks the coordinator, then waits for the answer before recording anything. */
  question?: string;
  /** Asks and then waits for nobody: the run ends when the owner stops it. */
  unanswered?: string;
  /** The run fails the way a provider outage does. */
  fail?: string;
}
interface FixerStep {
  files?: Record<string, string>;
  fail?: string;
  /** Resolves when the fixer may finish. */
  until?: Promise<void>;
  /** The fixer asks a question and waits for its answer. */
  question?: string;
  /** The fixer asks and waits for nobody: the run ends when the owner stops it. */
  unanswered?: string;
}

interface Script {
  reviews?: ReviewerStep[];
  fixes?: FixerStep[];
}

interface Rig {
  ws: string;
  implementer: string;
  /** Every request a session was started with, in order. */
  calls: SessionRequest[];
  run: SessionRunner;
  script: Required<Script>;
}

const MODEL = "omniroute/deepseek/deepseek-v4";

async function rig(script: Script = {}, ws = repo(), files: Record<string, string> = IMPLEMENTED): Promise<Rig> {
  const calls: SessionRequest[] = [];
  const full: Required<Script> = { reviews: [...(script.reviews ?? [])], fixes: [...(script.fixes ?? [])] };
  let implementer = "";
  const run: SessionRunner = async ({ request, onQuestion, onSteerable, signal }) => {
    const req = request as SessionRequest;
    calls.push(req);
    const asks = async (question: string, answered: boolean): Promise<void> => {
      let answer: ((m: string) => void) | undefined;
      const got = new Promise<string>((r) => (answer = r));
      onSteerable?.((m) => answer?.(m));
      onQuestion?.(question);
      if (answered) await got;
      else await new Promise<void>((r) => (signal.aborted ? r() : signal.addEventListener("abort", () => r(), { once: true })));
    };
    if (req.review === true) {
      const step = full.reviews.shift() ?? {};
      const id = req.sessionId ?? req.newSessionId ?? `t236-rev-${++counter}`;
      if (step.fail !== undefined) return { outcome: "error", message: step.fail } as SessionOutcome;
      if (req.sessionId === undefined) endedSession(ws, id, "review", req.model ?? "unknown");
      if (step.question !== undefined) await asks(step.question, true);
      if (step.unanswered !== undefined) {
        await asks(step.unanswered, false);
        return { outcome: "error", message: "stopped", sessionId: id } as SessionOutcome;
      }
      const ledger = openLedgerSync(defaultLedgerPath(ws));
      try {
        for (const f of step.findings ?? []) recordFinding(ledger, id, f);
      } finally {
        ledger.close();
      }
      return { outcome: "ok", answer: "reviewed", sessionId: id } as SessionOutcome;
    }
    // The fixer: the implementer's session, continued.
    const step = full.fixes.shift() ?? {};
    if (step.fail !== undefined) return { outcome: "error", message: step.fail, sessionId: req.sessionId } as SessionOutcome;
    if (step.question !== undefined) await asks(step.question, true);
    if (step.unanswered !== undefined) {
      await asks(step.unanswered, false);
      return { outcome: "error", message: "stopped", sessionId: req.sessionId } as SessionOutcome;
    }
    if (step.until !== undefined) await step.until;
    if (step.files !== undefined) commitOnBranch(ws, req.sessionId!, step.files, "fix");
    return { outcome: "ok", answer: "fixed", sessionId: req.sessionId, branch: `lykos/${req.sessionId}` } as SessionOutcome;
  };
  // The implementer: its change, on a branch of its own, and a ledger row with the model it ran on.
  const r = await runDelegated(
    ws,
    { brief: "Implement applyDiscount.\n\nAcceptance: SPEC.md rules 1 to 4.", specialist: "implement" },
    {
      trustSource: "flag",
      run: async ({ request }) => {
        const id = (request as SessionRequest).newSessionId ?? `t236-impl-${++counter}`;
        commitOnBranch(ws, id, files, "implement applyDiscount", (request as SessionRequest).base ?? "HEAD");
        endedSession(ws, id, "Implement applyDiscount.\n\nAcceptance: SPEC.md rules 1 to 4.", MODEL);
        return { outcome: "ok", answer: "done", sessionId: id, branch: `lykos/${id}` } as SessionOutcome;
      },
    },
  );
  assert.equal(r["outcome"] === "ok" || r["outcome"] === "unverified", true, JSON.stringify(r));
  implementer = r["sessionId"] as string;
  return { ws, implementer, calls, run, script: full };
}

type CycleResult = Record<string, unknown> & {
  outcome: string;
  stop?: string;
  next?: string;
  message?: string;
  cycle_id?: string;
  rounds?: number;
  fixes?: number;
  steps?: Array<{ step_id: string; kind: string; round: number; state: string; session_id?: string }>;
  triage?: Array<{ finding_id: string; severity: string; text: string }>;
  items?: Item[];
  question?: { session_id?: string; question: string };
  counts?: { blocks: number; triage: number; dropped: number };
  flags?: Array<{ flag: string; session?: string }>;
  recovered?: { from_pid: number; crashes: number };
  duplicate?: boolean;
};

async function cycle(r: Rig, target: string, extra: Partial<Parameters<typeof runCycle>[2]> = {}): Promise<CycleResult> {
  return (await runCycle(r.ws, target, { trustSource: "stored", run: r.run, ...extra })) as CycleResult;
}

const kinds = (res: CycleResult): string[] => (res.steps ?? []).map((s) => `${s.kind}:${s.state}`);

function ledgerRows<T>(ws: string, sql: string, ...params: unknown[]): T[] {
  return withLedgerSync(defaultLedgerPath(ws), (l) => l.db.prepare(sql).all(...params) as T[]);
}

function setConfig(ws: string, yaml: string): void {
  put(ws, ".lykos/config.yaml", yaml);
}

// ---------------------------------------------------------------------------

describe("T236 ACCEPTANCE: the planted bug is found in round 1, fixed, rechecked, and the cycle ends approve", () => {
  it("review, judge, fix, proof, recheck, judge: the proof retires the finding and the cycle approves", async () => {
    const r = await rig({ reviews: [{ findings: [finding()] }, { findings: [] }], fixes: [{ files: FIXED_CLAMP }] });
    const res = await cycle(r, r.implementer);
    assert.equal(res.outcome, "ok", JSON.stringify(res));
    assert.equal(res.stop, "approve");
    assert.equal(res.next, "approve");
    assert.deepEqual(kinds(res), ["review:done", "judge:done", "fix:done", "proof:done", "recheck:done", "judge:done"]);
    assert.equal(res.rounds, 2);
    assert.equal(res.fixes, 1);

    // The reviewer found it in round 1: the harness reproduced it on the branch, so it blocked.
    const decisions = withLedgerSync(defaultLedgerPath(r.ws), (l) => findingDecisionsOf(l, r.implementer));
    assert.deepEqual(decisions.map((d) => [d.action, d.cycle_id]), [["forwarded", res.cycle_id], ["retired", res.cycle_id]]);
    assert.match(decisions[1]!.reason, /no longer fails/);

    // The fix is on the implementer's own branch, and the clamp is what SPEC.md says.
    assert.match(git(r.ws, "show", `lykos/${r.implementer}:src/pricing.js`), /Math\.min\(100,/);

    // Three sessions: the reviewer, the implementer continued, the same reviewer continued. No others.
    const [review, fix, recheck] = r.calls;
    assert.equal(r.calls.length, 3);
    assert.equal(review!.review, true);
    assert.equal(review!.sessionId, undefined);
    assert.equal(fix!.sessionId, r.implementer);
    assert.equal(recheck!.sessionId, (res.reviewer as { session_id: string }).session_id, "the same reviewer session rechecks");
    assert.equal(recheck!.review, true);
    // The fixer got the whole finding, reproduction and all.
    assert.match(fix!.prompt, /a discount above 100 percent never makes a price negative/);
    assert.match(fix!.prompt, /test\/cycle-repro\.test\.js/);
    // The recheck was given the fix's diff.
    assert.match(recheck!.prompt, /Math\.min\(100,/);
  });

  it("every step is written before it acts, and a session step carries request_id = cycle id + step id", async () => {
    const r = await rig({ reviews: [{ findings: [finding()] }, { findings: [] }], fixes: [{ files: FIXED_CLAMP }] });
    const res = await cycle(r, r.implementer);
    const steps = withLedgerSync(defaultLedgerPath(r.ws), (l) => stepsOf(l, res.cycle_id!));
    assert.deepEqual(steps.map((s) => s.step_id), ["s1", "s2", "s3", "s4", "s5", "s6"]);
    for (const s of steps) {
      if (s.kind === "review" || s.kind === "fix" || s.kind === "recheck") assert.equal(s.request_id, `${res.cycle_id}.${s.step_id}`);
      else assert.equal(s.request_id, null);
    }
    assert.deepEqual(r.calls.map((c) => c.requestId), [`${res.cycle_id}.s1`, `${res.cycle_id}.s3`, `${res.cycle_id}.s5`]);
    // The ledger says the same requests started the three sessions.
    const owned = ledgerRows<{ request_id: string; session_id: string }>(r.ws, "SELECT request_id, session_id FROM owner_requests WHERE request_id LIKE ?", `${res.cycle_id}.%`);
    assert.equal(owned.length, 3);
  });

  it("a review with nothing to find approves at once: one session, two steps", async () => {
    const r = await rig({ reviews: [{ findings: [] }] });
    const res = await cycle(r, r.implementer);
    assert.equal(res.stop, "approve", JSON.stringify(res));
    assert.deepEqual(kinds(res), ["review:done", "judge:done"]);
    assert.equal(r.calls.length, 1);
  });

  it("the cycle row and its steps are what `status` shows", async () => {
    const r = await rig({ reviews: [{ findings: [] }] });
    const res = await cycle(r, r.implementer);
    const { cycleViews } = await import("./cycle.js");
    const [view] = cycleViews(r.ws, [res.cycle_id!]);
    assert.equal(view!.state, "done");
    assert.equal(view!.next, "approve");
    assert.equal(view!.target_session, r.implementer);
    assert.equal(view!.rounds, 1);
    assert.equal(view!.fixes, 0);
  });
});

describe("T236 ACCEPTANCE: a ruling given to the reviewer reaches the fixer", () => {
  it("a question the reviewer asks and the coordinator answers is in the fixer's brief and the recheck's", async () => {
    const r = await rig({
      reviews: [{ question: "Is a discount of exactly 100 percent allowed to make the price 0?", findings: [finding()] }, { findings: [] }],
      fixes: [{ files: FIXED_CLAMP }],
    });
    const running = cycle(r, r.implementer);
    // The coordinator, from another process's seat: waits for the question to show in the ledger, then steers.
    const asked = await waitFor(() => ledgerRows<{ session_id: string; question: string; answered_at: string | null }>(r.ws, "SELECT session_id, question, answered_at FROM questions").find((q) => q.answered_at === null));
    assert.match(asked.question, /exactly 100 percent/);
    assert.equal(steerElsewhere(r.ws, asked.session_id, "Yes: 100 percent makes the price 0, never less.")?.steered, true);
    const res = await running;
    assert.equal(res.stop, "approve", JSON.stringify(res));

    const fix = r.calls.find((c) => c.sessionId === r.implementer)!;
    assert.match(fix.prompt, /# Rulings/);
    assert.match(fix.prompt, /Is a discount of exactly 100 percent allowed to make the price 0\?/);
    assert.match(fix.prompt, /Yes: 100 percent makes the price 0, never less\./);
    const recheck = r.calls.at(-1)!;
    assert.match(recheck.prompt, /Yes: 100 percent makes the price 0, never less\./);
    const rulings = ledgerRows<{ question: string; ruling: string; cycle_id: string }>(r.ws, "SELECT cycle_id, question, ruling FROM cycle_rulings");
    assert.deepEqual(rulings.map((x) => [x.cycle_id, x.ruling]), [[res.cycle_id, "Yes: 100 percent makes the price 0, never less."]]);
  });

  it("a recheck rerun after an environment error still carries the ruling", async () => {
    const r = await rig({
      reviews: [{ question: "Is 100 percent allowed?", findings: [finding()] }, { fail: "gateway down: 502" }, { findings: [] }],
      fixes: [{ files: FIXED_CLAMP }],
    });
    const running = cycle(r, r.implementer);
    const asked = await waitFor(() => ledgerRows<{ session_id: string; answered_at: string | null }>(r.ws, "SELECT session_id, answered_at FROM questions").find((q) => q.answered_at === null));
    steerElsewhere(r.ws, asked.session_id, "Yes, 100 is allowed.");
    const first = await running;
    assert.equal(first.stop, "fix_environment", JSON.stringify(first));
    assert.deepEqual(kinds(first), ["review:done", "judge:done", "fix:done", "proof:done", "recheck:error"]);
    // The recheck failed; its retry is the same reviewer continued, and it is handed the ruling again.
    const second = await cycle(r, first.cycle_id!);
    assert.equal(second.stop, "approve", JSON.stringify(second));
    assert.match(r.calls.at(-1)!.prompt, /Yes, 100 is allowed\./);
  });
});

describe("T236 ACCEPTANCE: a provider failure mid-round stops with fix_environment, and resume reruns that step only (G3, G4)", () => {
  it("a fixer that fails stops the round before the proof suite and the recheck run; resume reruns the fix only", async () => {
    const r = await rig({
      reviews: [{ findings: [finding()] }, { findings: [] }],
      fixes: [{ fail: "provider error: 502 Bad Gateway" }, { files: FIXED_CLAMP }],
    });
    const first = await cycle(r, r.implementer);
    assert.equal(first.outcome, "error", JSON.stringify(first));
    assert.equal(first.stop, "fix_environment");
    assert.equal(first.next, "fix_environment");
    assert.match(String(first.message), /502 Bad Gateway/);
    // G4: the round stopped before tests. No proof ran, no recheck started, nothing was spent on them.
    assert.deepEqual(kinds(first), ["review:done", "judge:done", "fix:error"]);
    assert.equal(r.calls.length, 2, "the reviewer and the failed fixer; no recheck session");
    assert.equal(first.fixes, 0, "a fix that failed on the environment is not one of the fixes the cap counts (W3)");

    // G3: it is resumable, and resuming reruns that step only. The reviewer is not started again, the review not repeated.
    const second = await cycle(r, first.cycle_id!);
    assert.equal(second.outcome, "ok", JSON.stringify(second));
    assert.equal(second.stop, "approve");
    assert.deepEqual(kinds(second), ["review:done", "judge:done", "fix:error", "fix:done", "proof:done", "recheck:done", "judge:done"]);
    assert.equal(r.calls.filter((c) => c.review === true && c.sessionId === undefined).length, 1, "one reviewer was ever started");
    assert.equal(r.calls.filter((c) => c.sessionId === r.implementer).length, 2, "the fix ran twice: the failure and its rerun");
    assert.equal(second.cycle_id, first.cycle_id);
  });

  it("a reviewer that fails in round 1 stops before any finding is judged; resume starts a reviewer afresh (R14, G3)", async () => {
    const r = await rig({ reviews: [{ fail: "model unavailable: no credits" }, { findings: [] }] });
    const first = await cycle(r, r.implementer);
    assert.equal(first.stop, "fix_environment");
    assert.match(String(first.message), /no credits/);
    assert.deepEqual(kinds(first), ["review:error"]);
    assert.equal(ledgerRows(r.ws, "SELECT 1 FROM findings").length, 0);
    const second = await cycle(r, first.cycle_id!);
    assert.equal(second.stop, "approve", JSON.stringify(second));
    assert.deepEqual(kinds(second), ["review:error", "review:done", "judge:done"]);
  });
});


describe("T236 ACCEPTANCE: caps come from config only (G11, W3)", () => {
  it("the shipped defaults are the one place: 5 rounds, 3 fixes, stall after 2", () => {
    assert.deepEqual(capsOf(SHIPPED_DEFAULTS), { rounds: 5, fixes: 3, stall: 2 });
  });

  it("a fix that never fixes stalls after 2 rounds in a row: the cycle stops with decide, naming the config key", async () => {
    const r = await rig({ reviews: [{ findings: [finding()] }, { findings: [] }, { findings: [] }, { findings: [] }], fixes: [{}, {}, {}] });
    const res = await cycle(r, r.implementer);
    assert.equal(res.stop, "decide", JSON.stringify(res));
    assert.equal(res.next, "decide");
    assert.match(String(res.message), /stalled/);
    assert.match(String(res.message), /delegation\.cycle_stall_after is 2/);
    assert.equal(res.fixes, 2, "two fixes, then the stall: the third is never started");
    assert.equal(res.items?.length, 1, "the open item is in the result");
    assert.equal(res.items?.[0]?.check?.kind, "reproduction");
  });

  it("delegation.cycle_max_fixes caps the fixes", async () => {
    const ws = repo(BASE_CONFIG.replace("delegation:\n", "delegation:\n  cycle_max_fixes: 1\n  cycle_stall_after: 9\n  cycle_max_rounds: 9\n"));
    const r = await rig({ reviews: [{ findings: [finding()] }, { findings: [] }, { findings: [] }], fixes: [{}, {}] }, ws);
    const res = await cycle(r, r.implementer);
    assert.equal(res.stop, "decide", JSON.stringify(res));
    assert.match(String(res.message), /1 fixes are done/);
    assert.match(String(res.message), /delegation\.cycle_max_fixes is 1/);
    assert.equal(res.fixes, 1);
  });

  it("delegation.cycle_max_rounds caps the rounds, and raising it in config lets a resume go on", async () => {
    const ws = repo(BASE_CONFIG.replace("delegation:\n", "delegation:\n  cycle_max_rounds: 2\n  cycle_stall_after: 9\n  cycle_max_fixes: 9\n"));
    const r = await rig({ reviews: [{ findings: [finding()] }, { findings: [] }, { findings: [] }], fixes: [{}, { files: FIXED_CLAMP }] }, ws);
    const res = await cycle(r, r.implementer);
    assert.equal(res.stop, "decide", JSON.stringify(res));
    assert.match(String(res.message), /delegation\.cycle_max_rounds is 2/);
    assert.equal(res.rounds, 2);
    setConfig(ws, BASE_CONFIG);
    const resumed = await cycle(r, res.cycle_id!);
    assert.equal(resumed.stop, "approve", JSON.stringify(resumed));
    assert.equal(resumed.rounds, 3);
  });

  it("no cap is a flag or a literal anywhere else: the command refuses --max-rounds, --max-fixes and --stall-after", async () => {
    const r = await rig({ reviews: [{ findings: [] }] });
    for (const flag of ["--max-rounds", "--max-fixes", "--stall-after"]) {
      const out = await captured(() => runCycleCommand(r.ws, [r.implementer, flag, "9"]));
      assert.equal(out.code, 1, flag);
      assert.match(out.err, /unknown flag/, flag);
    }
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "cycle.ts"), "utf8");
    assert.doesNotMatch(source, /\b(MAX_ROUNDS|MAX_FIXES|STALL_AFTER)\b\s*=\s*\d/, "no second default");
    const reads = source.match(/config\.delegation\.cycle_[a-z_]+/g) ?? [];
    assert.equal(new Set(reads).size, 3, "the three caps are read from the loaded config, in one function");
  });

  it("a config that sets a cap to 0 is refused naming the key", () => {
    const ws = repo(BASE_CONFIG.replace("delegation:\n", "delegation:\n  cycle_max_fixes: 0\n"));
    assert.throws(() => loadConfig({ cwd: ws }), /delegation\.cycle_max_fixes must be a positive integer/);
  });
});

describe("T236 ACCEPTANCE: a finding reaches the fixer whole (R20)", () => {
  it("a finding whose issue text is empty reaches the fixer by its scenario: the reproduction's file, its text and the tests", async () => {
    const r = await rig({ reviews: [{ findings: [finding({ text: "" })] }, { findings: [] }], fixes: [{ files: FIXED_CLAMP }] });
    const res = await cycle(r, r.implementer);
    assert.equal(res.stop, "approve", JSON.stringify(res));
    const fix = r.calls.find((c) => c.sessionId === r.implementer)!;
    assert.match(fix.prompt, /test\/cycle-repro\.test\.js/);
    assert.match(fix.prompt, /applyDiscount\(1000, 150\), 0/, "the reproduction's own text");
    assert.match(fix.prompt, /a discount above 100 percent never makes a price negative/, "the test that must pass");
    assert.match(fix.prompt, /the reviewer gave no description; the scenario below is the finding/);
  });

  it("a long finding is not cut: the whole text and the whole reproduction are in the brief", async () => {
    const long = `${"The planted clamp lets 1000 percent through. ".repeat(40)}`.slice(0, 1980) + " END-OF-TEXT";
    const content = `${REPRO_TEST}\n${"// padding line to make the reproduction long\n".repeat(900)}// END-OF-REPRO\n`;
    const r = await rig({ reviews: [{ findings: [finding({ text: long, check: { ...REPRO, content } })] }, { findings: [] }], fixes: [{ files: FIXED_CLAMP }] });
    await cycle(r, r.implementer);
    const fix = r.calls.find((c) => c.sessionId === r.implementer)!;
    assert.ok(fix.prompt.includes(long), "the finding's whole text");
    assert.ok(fix.prompt.includes("// END-OF-REPRO"), "the reproduction to its last line");
    assert.ok(fix.prompt.length > 40_000);
  });

  it("every open item goes in one fix, none held for a later round", async () => {
    const second: FindingInput = {
      text: "the tool exits 3 where it should exit 0",
      severity: "high",
      basis: "src/pricing.js:12",
      check: { kind: "command", command: 'node -e "process.exit(3)"', exit: 3 },
    };
    const r = await rig({ reviews: [{ findings: [finding(), second] }, { findings: [] }], fixes: [{ files: FIXED_CLAMP }] });
    const res = await cycle(r, r.implementer);
    assert.equal(res.fixes, 1);
    const fix = r.calls.find((c) => c.sessionId === r.implementer)!;
    assert.match(fix.prompt, /2 items are open/);
    assert.match(fix.prompt, /### 1\./);
    assert.match(fix.prompt, /### 2\./);
    assert.match(fix.prompt, /the tool exits 3 where it should exit 0/);
  });

  it("renderItem names a check without a reproduction, and the coordinator's own item", () => {
    const base: Item = { key: "k", source: "finding", severity: "medium", text: "t", basis: "src/a.ts:1" };
    assert.match(renderItem(base, 1), /No reproduction was given/);
    assert.match(renderItem({ ...base, source: "added" }, 1), /The coordinator added this item/);
    assert.match(renderItem({ ...base, check: { kind: "command", command: "npm test", exit: 1 } }, 1), /`npm test` exits 1 today/);
  });
});

describe("T236 ACCEPTANCE: the cycle starts nothing it does not need (R8)", () => {
  it("no baseline, no second reviewer, no proof or recheck without a fix: the sessions are the steps", async () => {
    const r = await rig({ reviews: [{ findings: [finding()] }, { findings: [] }], fixes: [{ files: FIXED_CLAMP }] });
    const before = ledgerRows(r.ws, "SELECT 1 FROM baselines").length;
    await cycle(r, r.implementer);
    assert.equal(r.calls.length, 3, "one reviewer, one fixer, one recheck");
    assert.equal(ledgerRows(r.ws, "SELECT 1 FROM baselines").length, before, "the cycle measured no baseline of its own");
    for (const call of r.calls) assert.equal(call.context?.test, undefined, "no request asks for a verification baseline");
    assert.equal(r.calls.filter((c) => c.review === true && c.sessionId === undefined).length, 1, "exactly one reviewer is started");
  });

  it("without a reproduction there is no proof step; without a finding there is no fix", async () => {
    const r = await rig({ reviews: [{ findings: [finding({ severity: "medium", text: "the module has no error handling", check: null })] }, { findings: [] }], fixes: [{}] });
    const first = await cycle(r, r.implementer);
    assert.equal(first.stop, "triage", JSON.stringify(first));
    const id = first.triage![0]!.finding_id;
    const second = await cycle(r, first.cycle_id!, { forward: [id] });
    assert.equal(second.stop, "approve", JSON.stringify(second));
    assert.deepEqual(kinds(second), ["review:done", "judge:done", "triage:done", "fix:done", "recheck:done", "judge:done"], "no proof step: there is no reproduction to rerun");
    assert.equal(r.calls.length, 3);
  });

  it("a dropped finding starts nothing: the cycle approves after the first judge", async () => {
    const r = await rig({ reviews: [{ findings: [finding({ severity: "low", text: "a vague name", check: null })] }] });
    const res = await cycle(r, r.implementer);
    assert.equal(res.stop, "approve");
    assert.deepEqual(kinds(res), ["review:done", "judge:done"]);
    assert.equal(r.calls.length, 1);
  });
});

describe("T236 ACCEPTANCE: triage stops the cycle, and the coordinator decides on resume", () => {
  it("a high finding without a reproduction stops with triage; --drop sets it aside and the cycle approves", async () => {
    const r = await rig({ reviews: [{ findings: [finding({ severity: "high", text: "the error message is misleading", check: null })] }] });
    const first = await cycle(r, r.implementer);
    assert.equal(first.stop, "triage", JSON.stringify(first));
    assert.equal(first.next, "triage");
    assert.equal(first.triage?.length, 1);
    assert.match(String(first.message), /--forward <id>.*--drop <id>/);
    const id = first.triage![0]!.finding_id;
    const second = await cycle(r, first.cycle_id!, { drop: [id] });
    assert.equal(second.stop, "approve", JSON.stringify(second));
    const rows = withLedgerSync(defaultLedgerPath(r.ws), (l) => findingDecisionsOf(l, r.implementer));
    assert.deepEqual(rows.map((d) => [d.action, d.finding_id, d.cycle_id]), [["dropped", id, first.cycle_id]]);
    assert.equal(r.calls.length, 1, "nothing was fixed");
  });

  it("--forward hands the finding to the fixer, and a finding the coordinator never ruled on keeps the cycle at triage", async () => {
    const r = await rig({
      reviews: [{ findings: [finding({ severity: "high", text: "first unreproduced", check: null }), finding({ severity: "high", text: "second unreproduced", check: null })] }, { findings: [] }],
      fixes: [{ files: FIXED_CLAMP }],
    });
    const first = await cycle(r, r.implementer);
    const [a, b] = first.triage!.map((t) => t.finding_id);
    const partial = await cycle(r, first.cycle_id!, { forward: [a!] });
    assert.equal(partial.stop, "triage", "one finding is still undecided");
    assert.equal(partial.triage?.length, 1);
    assert.equal(partial.triage?.[0]?.finding_id, b);
    const done = await cycle(r, first.cycle_id!, { drop: [b!] });
    assert.equal(done.stop, "approve", JSON.stringify(done));
    const fix = r.calls.find((c) => c.sessionId === r.implementer)!;
    assert.match(fix.prompt, /first unreproduced/);
    assert.doesNotMatch(fix.prompt, /second unreproduced/);
    const actions = withLedgerSync(defaultLedgerPath(r.ws), (l) => findingDecisionsOf(l, r.implementer)).map((d) => `${d.action}:${d.finding_id === a ? "a" : "b"}`);
    assert.deepEqual(actions, ["forwarded:a", "dropped:b", "retired:a"]);
  });

  it("an id that is not left to triage is refused, and the cycle stays at the stop it was resumed from", async () => {
    const r = await rig({ reviews: [{ findings: [finding({ severity: "high", check: null })] }] });
    const first = await cycle(r, r.implementer);
    const bad = await cycle(r, first.cycle_id!, { forward: ["nope#1"] });
    assert.equal(bad.outcome, "error");
    assert.match(String(bad.message), /nope#1 is not left to triage/);
    const [view] = cycleViews(r.ws, [first.cycle_id!]);
    assert.equal(view!.state, "stopped");
    assert.equal(view!.next, "triage");
  });
});

describe("T236 ACCEPTANCE: sessions run with decide-alone off, and an unanswered question stops the cycle (spec decision 18)", () => {
  it("a question nobody answers in time stops the cycle with answer_question; -m answers it on resume and the reviewer carries on", async () => {
    const ws = repo(`${BASE_CONFIG}mcp:\n  ask_timeout: 1\n`);
    const r = await rig({ reviews: [{ unanswered: "Does 100 percent count as free?" }, { findings: [] }] }, ws);
    const first = await cycle(r, r.implementer);
    assert.equal(first.stop, "answer_question", JSON.stringify(first));
    assert.equal(first.next, "answer_question");
    assert.equal(first.question?.question, "Does 100 percent count as free?");
    // Nobody decided alone: the question is still open.
    const open = ledgerRows<{ question: string; answered_at: string | null }>(r.ws, "SELECT question, answered_at FROM questions");
    assert.deepEqual(open.map((q) => q.answered_at), [null]);
    assert.deepEqual(kinds(first), ["review:error"]);

    const second = await cycle(r, first.cycle_id!, { note: "Yes: 100 percent is free." });
    assert.equal(second.stop, "approve", JSON.stringify(second));
    // The reviewer was continued with the answer, not started again.
    const reviewers = r.calls.filter((c) => c.review === true);
    assert.equal(reviewers.length, 2);
    assert.equal(reviewers[1]!.sessionId, first.question!.session_id);
    assert.match(reviewers[1]!.prompt, /Yes: 100 percent is free\./);
    assert.deepEqual(ledgerRows<{ ruling: string }>(r.ws, "SELECT ruling FROM cycle_rulings").map((x) => x.ruling), ["Yes: 100 percent is free."]);
    assert.equal(ledgerRows<{ answered_at: string | null }>(r.ws, "SELECT answered_at FROM questions")[0]!.answered_at !== null, true, "the question is closed");
  });

  it("the fixer's unanswered question stops the cycle too, and nobody, not even the timeout, answered it", async () => {
    const ws = repo(`${BASE_CONFIG}mcp:\n  ask_timeout: 1\n`);
    const r = await rig({ reviews: [{ findings: [finding()] }, { findings: [] }], fixes: [{ unanswered: "Fix both clamp bounds?" }] }, ws);
    const res = await cycle(r, r.implementer);
    assert.equal(res.stop, "answer_question", JSON.stringify(res));
    assert.equal(res.question?.session_id, r.implementer);
    const q = ledgerRows<{ answered_by: string | null }>(r.ws, "SELECT answered_by FROM questions WHERE question LIKE 'Fix both%'")[0]!;
    assert.equal(q.answered_by, null, "nobody answered it, not the timeout either");
  });
});

describe("T236: a spec the implementer could not satisfy is the coordinator's first (answer_spec)", () => {
  it("a session that ended with WEAK-SPEC stops the cycle before any reviewer runs", async () => {
    const ws = repo();
    const weak = await runDelegated(ws, { brief: "x", specialist: "implement" }, {
      trustSource: "flag",
      run: async ({ request }) =>
        ({ outcome: "needs_answer", question: "The sealed tests already pass", sessionId: (request as SessionRequest).newSessionId ?? "weak", next: "answer_spec", flags: [{ flag: "WEAK-SPEC", detail: "test/format.test.js already passes" }] }) as SessionOutcome,
    });
    assert.equal(weak["next"], "answer_spec");
    const calls: SessionRequest[] = [];
    const res = (await runCycle(ws, weak["sessionId"] as string, {
      trustSource: "stored",
      run: async ({ request }) => (calls.push(request as SessionRequest), { outcome: "ok" } as SessionOutcome),
    })) as CycleResult;
    assert.equal(res.stop, "answer_spec", JSON.stringify(res));
    assert.equal(res.next, "answer_spec");
    assert.equal(calls.length, 0, "no reviewer was started");
  });
});

describe("T236 ACCEPTANCE: every option works at start and at resume (G6)", () => {
  it("--max-steps reaches every session, started or resumed", async () => {
    const r = await rig({ reviews: [{ findings: [finding()] }, { findings: [] }], fixes: [{ fail: "502" }, { files: FIXED_CLAMP }] });
    const first = await cycle(r, r.implementer, { maxSteps: 7 });
    assert.deepEqual(r.calls.map((c) => c.maxSteps), [7, 7]);
    const second = await cycle(r, first.cycle_id!, { maxSteps: 11 });
    assert.equal(second.stop, "approve", JSON.stringify(second));
    assert.deepEqual(r.calls.slice(2).map((c) => c.maxSteps), [11, 11], "the resumed fix and the recheck");
  });

  it("--task puts its body in the reviewer's brief and the recheck's, started or resumed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t236-task-"));
    const taskAtStart = join(dir, "start.md");
    writeFileSync(taskAtStart, "---\nfiles: [src/pricing.js]\n---\nTASK-AT-START: applyDiscount follows every rule of SPEC.md.\n");
    const r = await rig({ reviews: [{ findings: [] }] });
    await cycle(r, r.implementer, { taskFile: taskAtStart });
    assert.match(r.calls[0]!.prompt, /TASK-AT-START/);

    const taskAtResume = join(dir, "resume.md");
    writeFileSync(taskAtResume, "---\nfiles: [src/pricing.js]\n---\nTASK-AT-RESUME: applyDiscount follows every rule of SPEC.md.\n");
    const r2 = await rig({ reviews: [{ fail: "502" }, { findings: [finding()] }, { findings: [] }], fixes: [{ files: FIXED_CLAMP }] });
    const first = await cycle(r2, r2.implementer);
    assert.equal(first.stop, "fix_environment");
    const second = await cycle(r2, first.cycle_id!, { taskFile: taskAtResume });
    assert.equal(second.stop, "approve", JSON.stringify(second));
    assert.match(r2.calls[1]!.prompt, /TASK-AT-RESUME/, "the reviewer started on resume");
    assert.match(r2.calls.at(-1)!.prompt, /TASK-AT-RESUME/, "the recheck, which keeps the task in view");
  });

  it("-m is a note to the reviewer at start, and the fixer's at resume", async () => {
    const r = await rig({ reviews: [{ findings: [] }] });
    await cycle(r, r.implementer, { note: "NOTE-AT-START look hard at rounding" });
    assert.match(r.calls[0]!.prompt, /NOTE-AT-START/);

    const r2 = await rig({ reviews: [{ findings: [finding()] }, { findings: [] }], fixes: [{ fail: "502" }, { files: FIXED_CLAMP }] });
    const first = await cycle(r2, r2.implementer);
    await cycle(r2, first.cycle_id!, { note: "NOTE-AT-RESUME keep the public signature" });
    const fixes = r2.calls.filter((c) => c.sessionId === r2.implementer);
    assert.doesNotMatch(fixes[0]!.prompt, /NOTE-AT-RESUME/);
    assert.match(fixes[1]!.prompt, /NOTE-AT-RESUME/);
  });

  it("--add is one more item for the fixer, at start (even when the review finds nothing) and at resume", async () => {
    const r = await rig({ reviews: [{ findings: [] }, { findings: [] }], fixes: [{ files: { "README.md": "# docs\n" } }] });
    const res = await cycle(r, r.implementer, { add: "ADD-AT-START also document applyDiscount in README.md" });
    assert.equal(res.stop, "approve", JSON.stringify(res));
    assert.deepEqual(kinds(res), ["add:done", "review:done", "judge:done", "fix:done", "recheck:done", "judge:done"]);
    assert.match(r.calls.find((c) => c.sessionId === r.implementer)!.prompt, /ADD-AT-START/);

    const r2 = await rig({ reviews: [{ findings: [finding()] }, { findings: [] }], fixes: [{ fail: "502" }, { files: FIXED_CLAMP }] });
    const first = await cycle(r2, r2.implementer);
    const second = await cycle(r2, first.cycle_id!, { add: "ADD-AT-RESUME also keep formatCents unchanged" });
    assert.equal(second.stop, "approve", JSON.stringify(second));
    const fixes = r2.calls.filter((c) => c.sessionId === r2.implementer);
    assert.doesNotMatch(fixes[0]!.prompt, /ADD-AT-RESUME/);
    assert.match(fixes[1]!.prompt, /ADD-AT-RESUME/);
    assert.match(fixes[1]!.prompt, /a discount above 100 percent/, "the added item rides with the finding, in the same one fix");
  });

  it("--base names the commit the change is judged from, at start and at resume", async () => {
    const r = await rig({ reviews: [{ findings: [] }] });
    const firstCommit = git(r.ws, "rev-parse", "HEAD");
    await cycle(r, r.implementer, { base: firstCommit });
    assert.match(r.calls[0]!.prompt, new RegExp(firstCommit.slice(0, 12)));

    const r2 = await rig({ reviews: [{ fail: "502" }, { findings: [] }] });
    put(r2.ws, "NOTES.md", "a later base\n");
    git(r2.ws, "add", "-A");
    git(r2.ws, "commit", "-q", "-m", "a later base");
    const laterBase = git(r2.ws, "rev-parse", "HEAD");
    const first = await cycle(r2, r2.implementer);
    await cycle(r2, first.cycle_id!, { base: laterBase });
    assert.match(r2.calls[1]!.prompt, new RegExp(`It started from ${laterBase.slice(0, 12)}`));
  });

  it("--forward and --drop decide the findings left to triage; there is none to decide at a start", async () => {
    const r = await rig({ reviews: [{ findings: [finding({ check: null, severity: "high" })] }] });
    const started = await cycle(r, r.implementer, { drop: ["nothing#1"] });
    assert.equal(started.outcome, "error", "there is nothing to triage at a start");
    assert.match(String(started.message), /not left to triage/);
  });
});

describe("T236: the known gap in T235: a retried review finds its reviewer and adds no decision twice", () => {
  it("lykos review with the same --request-id twice leaves one finding_decisions row per finding", async () => {
    const r = await rig({ reviews: [{ findings: [finding(), finding({ severity: "low", text: "a vague name", check: null })] }] });
    const first = (await runReview(r.ws, r.implementer, { trustSource: "stored", run: r.run, requestId: "review-retry-1" })) as CycleResult;
    assert.equal(first.outcome, "ok", JSON.stringify(first));
    const decisions = () => withLedgerSync(defaultLedgerPath(r.ws), (l) => findingDecisionsOf(l, r.implementer));
    assert.deepEqual(decisions().map((d) => d.action).sort(), ["dropped", "forwarded"]);
    const again = (await runReview(r.ws, r.implementer, { trustSource: "stored", run: r.run, requestId: "review-retry-1" })) as CycleResult;
    assert.equal(again.outcome, "ok", JSON.stringify(again));
    assert.equal(r.calls.length, 1, "the retry found the finished reviewer; it started no second one");
    assert.deepEqual(decisions().map((d) => d.action).sort(), ["dropped", "forwarded"], "no decision was appended a second time");
  });

  it("a cycle that judges a finished reviewer's findings again appends no decision twice", async () => {
    const r = await rig({ reviews: [{ findings: [finding()] }, { findings: [] }], fixes: [{ files: FIXED_CLAMP }] });
    const res = await cycle(r, r.implementer);
    assert.equal(res.stop, "approve", JSON.stringify(res));
    // Wind the cycle back to just before its first judge, as a kill in that step leaves it, and run it again.
    withLedgerSync(defaultLedgerPath(r.ws), (l) => {
      l.db.prepare("DELETE FROM cycle_steps WHERE cycle_id = ? AND seq > 2").run(res.cycle_id);
      l.db.prepare("UPDATE cycle_steps SET state = 'started', ended_at = NULL, result_json = NULL WHERE cycle_id = ? AND seq = 2").run(res.cycle_id);
      l.db.prepare("UPDATE cycles SET state = 'stopped', stop = 'fix_environment' WHERE id = ?").run(res.cycle_id);
    });
    r.script.reviews.push({ findings: [] });
    r.script.fixes.push({ files: FIXED_CLAMP });
    // The fixer's second run changes nothing the first did not, so the branch already has the fix: the proof is retired.
    await cycle(r, res.cycle_id!);
    const after = withLedgerSync(defaultLedgerPath(r.ws), (l) => findingDecisionsOf(l, r.implementer));
    assert.equal(after.filter((d) => d.action === "forwarded").length, 1, "one forwarded row, not two");
  });
});

describe("T236: the rule for what comes next, on its inputs", () => {
  const caps = { rounds: 5, fixes: 3, stall: 2 };
  const item = (key: string): Item => ({ key, source: "finding", severity: "high", text: key, basis: "x", finding_id: `s#${key}` });
  const step = (seq: number, kind: Step["kind"], result?: Record<string, unknown>, input: Record<string, unknown> = {}): Step => ({
    cycle_id: "c", seq, step_id: `s${seq}`, kind, round: 1, state: "done", request_id: null, session_id: null, started_at: "t", ended_at: "t", input, result,
  });
  const judge = (seq: number, open: Item[], stall = 0, triage: Item[] = []): Step =>
    step(seq, "judge", { head: "h", round: 1, open, triage, counts: { blocks: open.length, triage: triage.length, dropped: 0 }, open_count: open.length, stall });

  it("nothing open approves; one open fixes; triage comes before the fix", () => {
    assert.equal(evaluate([judge(1, [])], caps).kind, "approve");
    assert.equal(evaluate([judge(1, [item("a")])], caps).kind, "fix");
    const triaged = evaluate([judge(1, [item("a")], 0, [item("t")])], caps);
    assert.equal(triaged.kind === "stop" ? triaged.token : "no", "triage");
  });

  it("the fix cap, the round cap and the stall each stop with decide", () => {
    const fix = (seq: number): Step => step(seq, "fix");
    const fixes3 = [judge(1, [item("a")]), fix(2), judge(3, [item("a")]), fix(4), judge(5, [item("a")]), fix(6), judge(7, [item("a")])];
    const byFixes = evaluate(fixes3, caps);
    assert.equal(byFixes.kind === "stop" ? byFixes.token : "no", "decide");
    assert.match(byFixes.kind === "stop" ? byFixes.message : "", /cycle_max_fixes/);
    const byRounds = evaluate([judge(1, [item("a")]), fix(2), judge(3, [item("a")])], { rounds: 2, fixes: 9, stall: 9 });
    assert.match(byRounds.kind === "stop" ? byRounds.message : "", /cycle_max_rounds/);
    const byStall = evaluate([judge(1, [item("a")]), fix(2), judge(3, [item("a")], 2)], { rounds: 9, fixes: 9, stall: 2 });
    assert.match(byStall.kind === "stop" ? byStall.message : "", /cycle_stall_after/);
  });

  it("the coordinator's added items are the fixer's once: after a fix they are not handed again", () => {
    const add = step(2, "add", {}, { item: { key: "added:x", source: "added", severity: "high", text: "x", basis: "b" } });
    assert.equal(evaluate([judge(1, []), add], caps).kind, "fix");
    assert.equal(evaluate([judge(1, []), add, step(3, "fix"), judge(4, [])], caps).kind, "approve");
  });

  it("the briefs name the rulings, the items and the fix's diff", () => {
    const brief = fixBrief([item("a")], [{ point: "Q?", ruling: "A." }], 1, "NOTE");
    assert.match(brief, /# Rulings/);
    assert.match(brief, /Point: Q\?/);
    assert.match(brief, /NOTE/);
    const re = recheckBrief({ items: [item("a")], rulings: [], from: "a".repeat(40), to: "b".repeat(40), stat: "1 file changed", diff: "+x", note: undefined });
    assert.match(re, /aaaaaaaaaaaa\.\.bbbbbbbbbbbb/);
    assert.match(re, /1 file changed/);
  });
});

describe("T236: `lykos cycle` the command", () => {
  it("no arguments prints the usage (exit 2), and the usage names every stop and the config keys", async () => {
    const r = await rig({ reviews: [{ findings: [] }] });
    const out = await captured(() => runCycleCommand(r.ws, []));
    assert.equal(out.code, 2);
    assert.equal(out.out.trim(), CYCLE_USAGE);
    for (const word of ["approve", "answer_spec", "triage", "answer_question", "decide", "fix_environment", "recover", "cycle_max_rounds", "cycle_max_fixes", "cycle_stall_after"]) {
      assert.ok(CYCLE_USAGE.includes(word), word);
    }
  });

  it("an unknown id is an error with next fix_environment", async () => {
    const r = await rig({ reviews: [{ findings: [] }] });
    const res = await cycle(r, "no-such-session");
    assert.equal(res.outcome, "error");
    assert.equal(res.next, "fix_environment");
  });

  it("a second cycle on a session whose cycle is running is refused, naming it; so is resuming it", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const r = await rig({ reviews: [{ findings: [finding()] }, { findings: [] }], fixes: [{ until: gate, files: FIXED_CLAMP }] });
    const first = cycle(r, r.implementer);
    const live = await waitFor(() => ledgerRows<{ id: string }>(r.ws, "SELECT id FROM cycles WHERE state = 'running'")[0]);
    await waitFor(() => (r.calls.some((c) => c.sessionId === r.implementer) ? true : undefined));
    const second = await cycle(r, r.implementer);
    assert.equal(second.outcome, "error", JSON.stringify(second));
    assert.match(String(second.message), new RegExp(`cycle ${live.id} is already running`));
    const resumed = await cycle(r, live.id);
    assert.equal(resumed.outcome, "error");
    assert.equal(resumed.next, "wait");
    release();
    assert.equal((await first).stop, "approve");
  });
});

describe("T236: the MCP tool is the same cycle (spec decision 23)", () => {
  it("lykos_cycle starts a cycle and resumes it by its id, with the CLI's result and its options", async () => {
    const r = await rig({ reviews: [{ findings: [finding({ severity: "high", text: "the error message is misleading", check: null })] }, { findings: [] }], fixes: [{ files: FIXED_CLAMP }] });
    process.env.LYKOS_TRUST_WORKSPACE = "1";
    const server = createMcpServer({ workspace: r.ws, version: "0.0.1-test", run: r.run });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t236", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      assert.ok(listed.tools.some((t) => t.name === "lykos_cycle"));
      const call = async (args: Record<string, unknown>): Promise<CycleResult> => JSON.parse(((await client.callTool({ name: "lykos_cycle", arguments: args })).content as Array<{ text: string }>)[0]!.text) as CycleResult;
      const first = await call({ target: r.implementer });
      assert.equal(first.stop, "triage", JSON.stringify(first));
      assert.equal(first.next, "triage");
      const resumed = await call({ target: first.cycle_id, forward: [first.triage![0]!.finding_id], note: "MCP-NOTE keep the signature" });
      assert.equal(resumed.stop, "approve", JSON.stringify(resumed));
      assert.match(r.calls.find((c) => c.sessionId === r.implementer)!.prompt, /MCP-NOTE/);
      const refused = await call({ target: "nothing-here" });
      assert.equal(refused.outcome, "error");
      assert.equal(refused.next, "fix_environment");
    } finally {
      delete process.env.LYKOS_TRUST_WORKSPACE;
      await client.close();
      await server.close();
    }
  });
});

/** Runs a command that prints with the io-mode writers, and returns what it wrote and its code. */
async function captured(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => (out.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => (err.push(String(c)), true)) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, out: out.join(""), err: err.join("") };
  } finally {
    process.stdout.write = o;
    process.stderr.write = e;
  }
}

async function waitFor<T>(read: () => T | undefined, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error("timed out");
    await sleep(25);
  }
}

