// T235 ACCEPTANCE (ADR-0059, ADR-0061, spec decision 13): `lykos review` runs one reviewer and returns its findings as
// claims the harness has checked.
//
// Seams:
//   - `runReview`, the core `lykos review` and the MCP tool are front ends over, on real git repositories. The session
//     runner is a stand-in (as claim-result-t234.test.ts): an implementer that commits on its `lykos/<id>` branch and writes
//     its ledger row, and a reviewer that records findings through `recordFinding`, the writer the `finding` tool uses. The
//     checks then run for real, in temporary worktrees of the repository, with `node --test`.
//   - One review through the real session child on Pi's scripted model: the reviewer calls the `finding` tool, and the
//     harness checks what it recorded.
//   - `runReview` the command (`lykos/cli/delegation.ts`): its usage and its refusals.
//
// Lessons held here: R14 (an unavailable reviewer stops the review with its error), R16 (the diff uses the stored base when
// the host's HEAD moved), R23 (a flag on the change names the session that made it, never the read-only reviewer), W2 (the
// reviewer is told to look for special-casing, and to judge the criteria and the tests), W7 and `review_false_positive`
// (a low finding needs a reproduction to block; a medium one without goes to triage).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { after, before, describe, it } from "node:test";
import { runReview as runReviewCommand, REVIEW_USAGE, delegatedExitCode } from "../cli/delegation.js";
import { runSessionChild } from "../cli/session-child.js";
import { call, reply, say, SCRIPTED_MODEL, scriptedProvider } from "../cli/scripted-session.js";
import { SHIPPED_DEFAULTS } from "../config/defaults.js";
import { defaultLedgerPath, openLedgerSync, withLedgerSync } from "../ledger/use.js";
import { runStandaloneTask } from "../session/session.js";
import { TranscriptWriter } from "../session/transcript.js";
import type { ClaimCheck } from "./claims.js";
import { findingDecisionsOf } from "./decisions.js";
import { findingsOf, recordFinding, type FindingInput } from "./findings.js";
import { createMcpServer, runDelegated, ledgerViews } from "./mcp-server.js";
import { changeOf, MAX_BRIEF_DIFF_CHARS, resolveReviewTarget, reviewBrief, runReview } from "./review.js";
import { sessionBaseOf } from "./session-base.js";
import { encodeFrame, PROTOCOL_VERSION, type SessionOutcome, type SessionRequest, type SessionRunner } from "./session-protocol.js";

const saved: Record<string, string | undefined> = {};
let home: string;
before(() => {
  home = mkdtempSync(join(tmpdir(), "lykos-t235-home-"));
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

const CONFIG = "seal:\n  test_command: node --test {files}\ndelegation:\n  spec_check: false\nfeedback:\n  enabled: false\n";

/** A repository whose base adds correctly (or, with `addBody`, however the test needs). */
function repo(opts: { addBody?: string; config?: string } = {}): string {
  const ws = mkdtempSync(join(tmpdir(), "lykos-t235-ws-"));
  git(ws, "init", "-q", "-b", "main");
  git(ws, "config", "core.autocrlf", "false");
  put(ws, ".gitignore", ".lykos/\nnode_modules/\n");
  put(ws, "src/math.mjs", `export const add = (a, b) => ${opts.addBody ?? "a + b"};\n`);
  put(ws, "README.md", "# project\n");
  put(ws, ".lykos/config.yaml", opts.config ?? CONFIG);
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "first");
  return ws;
}

const REPRO_TEST = `
import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/math.mjs";
test("adds two numbers", () => assert.equal(add(1, 2), 3));
`;
const REPRO: ClaimCheck = { kind: "reproduction", file: "tests/repro.test.mjs", content: REPRO_TEST, fails: ["adds two numbers"] };
const SUBTRACT = { "src/math.mjs": "export const add = (a, b) => a - b;\n" };

// ---------------------------------------------------------------------------
// The session runners

let n = 0;

/** An implementer: commits `files` on its `lykos/<id>` branch and leaves a ledger row with the model it ran on. */
function implementer(ws: string, files: Record<string, string>, model = "omniroute/deepseek/deepseek-v4", brief = "Make add subtract.\n\nAcceptance: add(1, 2) is -1."): SessionRunner {
  return async ({ request }) => {
    const id = (request as SessionRequest).newSessionId ?? `t235-impl-${++n}-${Date.now()}`;
    const branch = `lykos/${id}`;
    const dir = join(mkdtempSync(join(tmpdir(), "lykos-t235-wt-")), "wt");
    git(ws, "worktree", "add", "-q", "-b", branch, dir, (request as SessionRequest).base ?? "HEAD");
    try {
      for (const [rel, text] of Object.entries(files)) put(dir, rel, text);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "change");
    } finally {
      git(ws, "worktree", "remove", "--force", dir);
    }
    endedSession(ws, id, brief, model);
    return { outcome: "ok", answer: "done", sessionId: id, branch } as SessionOutcome;
  };
}

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

/** A reviewer that records `findings` the way the tool does, and keeps the request it was given. */
function reviewer(ws: string, findings: FindingInput[], seen: SessionRequest[] = []): SessionRunner {
  return async ({ request }) => {
    const req = request as SessionRequest;
    seen.push(req);
    const id = req.newSessionId ?? `t235-rev-${++n}-${Date.now()}`;
    endedSession(ws, id, "review", req.model ?? "unknown");
    const ledger = openLedgerSync(defaultLedgerPath(ws));
    try {
      for (const f of findings) recordFinding(ledger, id, f);
    } finally {
      ledger.close();
    }
    return { outcome: "ok", answer: "reviewed", sessionId: id } as SessionOutcome;
  };
}

async function implement(ws: string, files: Record<string, string>, model?: string, brief?: string): Promise<string> {
  const r = await runDelegated(ws, { brief: "implement it", specialist: "implement" }, { trustSource: "flag", run: implementer(ws, files, model, brief) });
  assert.equal(r["outcome"] === "ok" || r["outcome"] === "unverified", true, JSON.stringify(r));
  return r["sessionId"] as string;
}

type Result = Record<string, unknown> & {
  outcome: string;
  next?: string;
  message?: string;
  reviewer?: { session_id?: string; role: string; model?: string; swapped?: string };
  reviewed?: { session_id?: string; branch: string; head: string; base: string; base_source: string };
  findings?: Array<{ finding_id: string; severity: string; disposition: string; why: string; cause?: string; verdict?: string; regression?: boolean; base?: { verdict: string } }>;
  counts?: { blocks: number; triage: number; dropped: number };
  flags?: Array<{ flag: string; detail: string; session?: string }>;
};

async function review(ws: string, target: string, run: SessionRunner, extra: Partial<Parameters<typeof runReview>[2]> = {}): Promise<Result> {
  return (await runReview(ws, target, { trustSource: "stored", run, ...extra })) as Result;
}

const finding = (over: Partial<FindingInput> = {}): FindingInput => ({ text: "add subtracts", severity: "high", basis: "src/math.mjs:1", ...over });

// ---------------------------------------------------------------------------

describe("T235 ACCEPTANCE: a finding with no reproduction (W7)", () => {
  it("a low finding with no reproduction does not block: the review approves, and the finding is recorded as dropped", async () => {
    const ws = repo();
    const id = await implement(ws, { "src/extra.mjs": "export const x = 1;\n" });
    const r = await review(ws, id, reviewer(ws, [finding({ severity: "low", text: "x is a vague name", basis: "src/extra.mjs:1" })]));
    assert.equal(r.outcome, "ok", JSON.stringify(r));
    assert.equal(r.findings?.length, 1);
    assert.equal(r.findings?.[0]?.disposition, "dropped");
    assert.match(r.findings?.[0]?.why ?? "", /low finding needs a reproduction to block/);
    assert.deepEqual(r.counts, { blocks: 0, triage: 0, dropped: 1 });
    assert.equal(r.next, "approve");
    const decisions = withLedgerSync(defaultLedgerPath(ws), (ledger) => findingDecisionsOf(ledger, id));
    assert.deepEqual(decisions.map((d) => d.action), ["dropped"], "the drop is on the record, under the reviewed session");
    assert.equal(decisions[0]!.finding_id, r.findings?.[0]?.finding_id);
  });

  it("a medium finding with no reproduction ends with next triage, and is not dropped", async () => {
    const ws = repo();
    const id = await implement(ws, { "src/extra.mjs": "export const x = 1;\n" });
    const r = await review(ws, id, reviewer(ws, [finding({ severity: "medium", text: "the module has no error handling", basis: "src/extra.mjs:1" })]));
    assert.equal(r.outcome, "ok", JSON.stringify(r));
    assert.equal(r.findings?.[0]?.disposition, "triage");
    assert.deepEqual(r.counts, { blocks: 0, triage: 1, dropped: 0 });
    assert.equal(r.next, "triage");
    const decisions = withLedgerSync(defaultLedgerPath(ws), (ledger) => findingDecisionsOf(ledger, id));
    assert.deepEqual(decisions, [], "triage is the coordinator's: nothing is decided yet");
  });

  it("a high finding whose check could not run (an untrusted project, no containment) goes to triage, not to the fixer", async () => {
    const ws = repo();
    const id = await implement(ws, SUBTRACT);
    const r = await review(ws, id, reviewer(ws, [finding({ check: REPRO })]), { trustSource: "flag" });
    assert.equal(r.findings?.[0]?.verdict, "unchecked", JSON.stringify(r.findings));
    assert.equal(r.findings?.[0]?.disposition, "triage");
    assert.equal(r.next, "triage");
  });
});

describe("T235 ACCEPTANCE: findings are claims the harness checks on the branch", () => {
  it("a reproduction that fails on the branch and passes at the base blocks, as a regression, and is forwarded", async () => {
    const ws = repo();
    const id = await implement(ws, SUBTRACT);
    const r = await review(ws, id, reviewer(ws, [finding({ check: REPRO })]));
    assert.equal(r.outcome, "ok", JSON.stringify(r));
    const f = r.findings![0]!;
    assert.equal(f.verdict, "verified", JSON.stringify(f));
    assert.equal(f.disposition, "blocks");
    assert.equal(f.regression, true);
    assert.equal(f.base?.verdict, "passes");
    assert.equal(r.next, "resume");
    const decisions = withLedgerSync(defaultLedgerPath(ws), (ledger) => findingDecisionsOf(ledger, id));
    assert.deepEqual(decisions.map((d) => d.action), ["forwarded"]);
    // The ledger holds what the harness decided, with the commits it decided at.
    const row = withLedgerSync(defaultLedgerPath(ws), (ledger) => ledger.db.prepare("SELECT disposition, verdict, head_commit, base_commit FROM findings").get()) as { disposition: string; verdict: string; head_commit: string; base_commit: string };
    assert.equal(row.disposition, "blocks");
    assert.equal(row.verdict, "verified");
    assert.equal(row.head_commit, r.reviewed?.head);
    assert.equal(row.base_commit, r.reviewed?.base);
  });

  it("a reproduction whose tests pass on the branch is a false positive: dropped with the cause review_false_positive", async () => {
    const ws = repo();
    const id = await implement(ws, { "src/extra.mjs": "export const x = 1;\n" });
    const r = await review(ws, id, reviewer(ws, [finding({ severity: "critical", check: REPRO })]));
    const f = r.findings![0]!;
    assert.equal(f.verdict, "failed", JSON.stringify(f));
    assert.equal(f.disposition, "dropped");
    assert.equal(f.cause, "review_false_positive");
    assert.equal(r.next, "approve", "a critical finding that did not reproduce does not hold the change");
    const decisions = withLedgerSync(defaultLedgerPath(ws), (ledger) => findingDecisionsOf(ledger, id));
    assert.deepEqual(decisions.map((d) => d.action), ["dropped"]);
    assert.match(decisions[0]!.reason, /did not hold/);
  });

  it("a reproduction that fails at the base too is the base's failure, not the change's: dropped", async () => {
    const ws = repo({ addBody: "a - b" });
    const id = await implement(ws, { "src/extra.mjs": "export const x = 1;\n" });
    const r = await review(ws, id, reviewer(ws, [finding({ check: REPRO })]));
    const f = r.findings![0]!;
    assert.equal(f.verdict, "verified");
    assert.equal(f.base?.verdict, "fails", JSON.stringify(f));
    assert.equal(f.disposition, "dropped");
    assert.match(f.why, /not this change's/);
    assert.equal(r.next, "approve");
  });

  it("the baseline of known failures drops a finding when the base verdict is unknown", async () => {
    const ws = repo();
    put(ws, "package-lock.json", '{"lockfileVersion":3}\n');
    git(ws, "add", "-A");
    git(ws, "commit", "-q", "-m", "lock");
    const id = await implement(ws, { ...SUBTRACT, "package-lock.json": '{"lockfileVersion":3,"changed":true}\n' });
    // The baseline the implementer was given says this very test already failed on the base.
    withLedgerSync(defaultLedgerPath(ws), (ledger) => {
      const info = ledger.db
        .prepare(
          `INSERT INTO baselines (base_commit, command, lockfile_hash, platform, status, adapter, kind, exit_code, failing_json, tests_total, recorded_at)
           VALUES (?, ?, ?, ?, 'measured', 'node-test', 'names', 1, ?, 3, ?)`,
        )
        .run(git(ws, "rev-parse", "HEAD"), "node --test", "none", process.platform, JSON.stringify(["tests/repro.test.mjs > adds two numbers"]), new Date().toISOString());
      ledger.db.prepare("INSERT INTO session_baselines (session_id, baseline_id, reused, recorded_at) VALUES (?, ?, 0, ?)").run(id, Number(info.lastInsertRowid), new Date().toISOString());
    });
    const r = await review(ws, id, reviewer(ws, [finding({ check: REPRO })]));
    const f = r.findings![0]!;
    assert.equal(f.verdict, "verified", JSON.stringify(f));
    assert.equal(f.base?.verdict, "unknown", "the lockfile differs, so the base says nothing");
    assert.equal(f.disposition, "dropped");
    assert.match(f.why, /baseline of known failures/);
  });

  it("a command that holds on the branch blocks even when the finding is low, and a line check alone does not", async () => {
    const ws = repo();
    const id = await implement(ws, SUBTRACT);
    const r = await review(ws, id, reviewer(ws, [
      finding({ severity: "low", text: "add subtracts", check: { kind: "command", command: "node -e \"import('./src/math.mjs').then(m => process.exit(m.add(1, 2) === 3 ? 0 : 7))\"", exit: 7 } }),
      finding({ severity: "low", text: "the line subtracts", check: { kind: "line", path: "src/math.mjs", line: 1, text: "a - b" } }),
      finding({ severity: "high", text: "the cited line is not there", check: { kind: "line", path: "src/math.mjs", line: 1, text: "a * b" } }),
    ]));
    assert.deepEqual(r.findings?.map((f) => [f.verdict, f.disposition]), [["verified", "blocks"], ["verified", "dropped"], ["failed", "dropped"]], JSON.stringify(r.findings));
    assert.equal(r.next, "resume");
  });
});

describe("T235 ACCEPTANCE: the diff uses the stored base when the host's HEAD moved (R16)", () => {
  it("the session's base is stored when it is admitted, and a review diffs against it", async () => {
    const ws = repo();
    const baseAtStart = git(ws, "rev-parse", "HEAD");
    const id = await implement(ws, { "src/feature.mjs": "export const feature = true;\n" });
    // The host moves on after the session branched.
    put(ws, "host-only.txt", "the host kept working\n");
    put(ws, "README.md", "# project, moved on\n");
    git(ws, "add", "-A");
    git(ws, "commit", "-q", "-m", "host moves on");
    assert.notEqual(git(ws, "rev-parse", "HEAD"), baseAtStart);
    assert.equal(withLedgerSync(defaultLedgerPath(ws), (ledger) => sessionBaseOf(ledger, id)), baseAtStart);

    const seen: SessionRequest[] = [];
    const r = await review(ws, id, reviewer(ws, [], seen));
    assert.equal(r.outcome, "ok", JSON.stringify(r));
    assert.equal(r.reviewed?.base, baseAtStart);
    assert.equal(r.reviewed?.base_source, "stored");
    const brief = seen[0]!.prompt;
    assert.match(brief, /src\/feature\.mjs/, "the branch's change is in the brief");
    assert.doesNotMatch(brief, /host-only\.txt/, "the host's later commit is not part of the review");
    assert.doesNotMatch(brief, /project, moved on/);
    assert.match(brief, new RegExp(baseAtStart.slice(0, 12)));
    // The reviewer's context pack is read at that base too.
    assert.equal(seen[0]!.base, baseAtStart);
  });

  it("with the old behaviour as the contrast: a diff against HEAD would have shown the host's commit reverted", async () => {
    const ws = repo();
    const baseAtStart = git(ws, "rev-parse", "HEAD");
    const id = await implement(ws, { "src/feature.mjs": "export const feature = true;\n" });
    put(ws, "host-only.txt", "the host kept working\n");
    git(ws, "add", "-A");
    git(ws, "commit", "-q", "-m", "host moves on");
    const head = git(ws, "rev-parse", "HEAD");
    assert.match(git(ws, "diff", "--name-only", `${head}..lykos/${id}`), /host-only\.txt/, "the premise: against HEAD the host's file appears");
    assert.doesNotMatch(changeOf(ws, baseAtStart, `lykos/${id}`).stat, /host-only/, "against the stored base it does not");
  });

  it("an explicit --base wins; a branch no session made falls back to the merge base with HEAD and says so", async () => {
    const ws = repo();
    const first = git(ws, "rev-parse", "HEAD");
    git(ws, "checkout", "-q", "-b", "feature/x");
    put(ws, "src/x.mjs", "export const x = 1;\n");
    git(ws, "add", "-A");
    git(ws, "commit", "-q", "-m", "x");
    git(ws, "checkout", "-q", "main");
    put(ws, "later.txt", "later\n");
    git(ws, "add", "-A");
    git(ws, "commit", "-q", "-m", "later");

    const bare = resolveReviewTarget(ws, undefined, "feature/x");
    assert.ok(bare.ok, JSON.stringify(bare));
    assert.equal(bare.target.base, first);
    assert.equal(bare.target.baseSource, "merge-base");
    assert.equal(bare.target.session, undefined);

    const given = resolveReviewTarget(ws, undefined, "feature/x", first);
    assert.ok(given.ok);
    assert.equal(given.target.baseSource, "given");

    const nothing = resolveReviewTarget(ws, undefined, "main", "main");
    assert.equal(nothing.ok, false);
    assert.equal(resolveReviewTarget(ws, undefined, "no-such-thing").ok, false);
  });

  it("a continuation's own diff is also against the stored base", async () => {
    const ws = repo();
    const id = await implement(ws, { "src/feature.mjs": "export const feature = true;\n" });
    put(ws, "host-only.txt", "the host kept working\n");
    git(ws, "add", "-A");
    git(ws, "commit", "-q", "-m", "host moves on");
    const again: SessionRunner = async ({ request }) => {
      const dir = join(mkdtempSync(join(tmpdir(), "lykos-t235-wt-")), "wt");
      git(ws, "worktree", "add", "-q", dir, `lykos/${(request as SessionRequest).sessionId}`);
      try {
        put(dir, "src/more.mjs", "export const more = 1;\n");
        git(dir, "add", "-A");
        git(dir, "commit", "-q", "-m", "more");
      } finally {
        git(ws, "worktree", "remove", "--force", dir);
      }
      return { outcome: "ok", answer: "more", sessionId: (request as SessionRequest).sessionId!, branch: `lykos/${(request as SessionRequest).sessionId}` } as SessionOutcome;
    };
    const r = await runDelegated(ws, { brief: "and more", specialist: "implement", session_id: id }, { trustSource: "flag", run: again });
    assert.deepEqual(r["diff_stat"], { files_changed: 2, insertions: 2, deletions: 0 }, JSON.stringify(r));
  });
});

describe("T235 ACCEPTANCE: an unavailable reviewer stops with its error (R14)", () => {
  it("a reviewer that ends in error gives an error result carrying its message, and no findings", async () => {
    const ws = repo();
    const id = await implement(ws, { "src/extra.mjs": "export const x = 1;\n" });
    const r = await review(ws, id, async () => ({ outcome: "error", message: "model omniroute/antigravity/claude-opus-4-6-thinking is unavailable: 503 from the gateway" }));
    assert.equal(r.outcome, "error", JSON.stringify(r));
    assert.match(r.message ?? "", /unavailable: 503 from the gateway/);
    assert.match(r.message ?? "", /did not review/);
    assert.equal(r.next, "fix_environment");
    assert.equal("findings" in r, false, "no findings is not the answer to a reviewer that did not run");
    assert.equal("counts" in r, false);
    assert.equal(delegatedExitCode(r), 1);
    const decisions = withLedgerSync(defaultLedgerPath(ws), (ledger) => findingDecisionsOf(ledger, id));
    assert.deepEqual(decisions, []);
  });

  it("a runner that throws is the same: the review stops with the error", async () => {
    const ws = repo();
    const id = await implement(ws, { "src/extra.mjs": "export const x = 1;\n" });
    const r = await review(ws, id, async () => {
      throw new Error("could not start the reviewer: spawn ENOENT");
    });
    assert.equal(r.outcome, "error", JSON.stringify(r));
    assert.match(r.message ?? "", /spawn ENOENT/);
    assert.equal("findings" in r, false);
    assert.equal(r.next, "fix_environment");
  });

  it("a reviewer that is refused admission (the project's session cap) stops the review with the refusal", async () => {
    const ws = repo({ config: CONFIG.replace("delegation:", "delegation:\n  max_sessions: 1") });
    const id = await implement(ws, { "src/extra.mjs": "export const x = 1;\n" });
    // Another session holds the project's only slot.
    withLedgerSync(defaultLedgerPath(ws), (ledger) => {
      ledger.db
        .prepare("INSERT INTO owners (session_id, owner, owner_pid, owner_recorded_at_ms, specialist, write_in_place, state, started_at) VALUES ('holder', 'run', ?, ?, 'implement', 0, 'running', ?)")
        .run(process.pid, Date.now(), new Date().toISOString());
    });
    const r = await review(ws, id, reviewer(ws, []));
    assert.equal(r.outcome, "error", JSON.stringify(r));
    assert.match(r.message ?? "", /max_sessions/);
    assert.equal("findings" in r, false);
  });
});

describe("T235 ACCEPTANCE: flags name the session that caused them (R23)", () => {
  it("a sensitive file the implementer changed is flagged against the implementer, never the read-only reviewer", async () => {
    const ws = repo();
    const id = await implement(ws, { "package.json": '{"name":"x"}\n', "src/extra.mjs": "export const x = 1;\n" });
    const r = await review(ws, id, reviewer(ws, []));
    assert.equal(r.outcome, "ok", JSON.stringify(r));
    const sensitive = r.flags?.find((f) => f.flag === "SENSITIVE");
    assert.ok(sensitive, JSON.stringify(r.flags));
    assert.equal(sensitive.session, id, "the flag names the writer");
    assert.notEqual(sensitive.session, r.reviewer?.session_id);
    assert.ok(!r.flags?.some((f) => f.session === r.reviewer?.session_id), "nothing on the change is the reviewer's");
    assert.equal(r.next, "inspect_flags");
  });

  it("a branch no session made has flags with no session at all, not the reviewer's", async () => {
    const ws = repo();
    git(ws, "checkout", "-q", "-b", "feature/y");
    put(ws, "package.json", '{"name":"y"}\n');
    git(ws, "add", "-A");
    git(ws, "commit", "-q", "-m", "y");
    git(ws, "checkout", "-q", "main");
    const r = await review(ws, "feature/y", reviewer(ws, []));
    const sensitive = r.flags?.find((f) => f.flag === "SENSITIVE");
    assert.ok(sensitive, JSON.stringify(r));
    assert.equal(sensitive.session, undefined);
  });
});

describe("T235: the reviewer", () => {
  const roles = SHIPPED_DEFAULTS.models.roles;

  it("is the review-both role on its own model when the implementer is another family", async () => {
    const ws = repo();
    const id = await implement(ws, { "src/extra.mjs": "export const x = 1;\n" }, "omniroute/antigravity/gemini-3.8-flash-high");
    const seen: SessionRequest[] = [];
    const r = await review(ws, id, reviewer(ws, [], seen));
    assert.equal(r.reviewer?.role, "review-both");
    assert.equal(r.reviewer?.model, roles["review-both"]);
    assert.equal(seen[0]!.model, roles["review-both"]);
    assert.equal(r.reviewer?.swapped, undefined);
    assert.ok(!r.flags?.some((f) => f.flag === "SAME-FAMILY"));
  });

  it("is swapped for its alternate when the role's model is the implementer's family", async () => {
    const ws = repo();
    const id = await implement(ws, { "src/extra.mjs": "export const x = 1;\n" }, "opencode/deepseek-v4.1-flash-free");
    const seen: SessionRequest[] = [];
    const r = await review(ws, id, reviewer(ws, [], seen));
    assert.equal(r.reviewer?.role, "review-both-alt");
    assert.equal(r.reviewer?.model, roles["review-both-alt"]);
    assert.equal(seen[0]!.model, roles["review-both-alt"]);
    assert.match(r.reviewer?.swapped ?? "", /implementer's family \(deepseek\)/);
    assert.ok(!r.flags?.some((f) => f.flag === "SAME-FAMILY"));
  });

  it("raises SAME-FAMILY, naming the reviewer, when no alternate differs from the implementer", async () => {
    const ws = repo({ config: `${CONFIG}models:\n  roles:\n    review-both-alt: omniroute/deepseek/deepseek-pro\n` });
    const id = await implement(ws, { "src/extra.mjs": "export const x = 1;\n" }, "opencode/deepseek-v4.1-flash-free");
    const r = await review(ws, id, reviewer(ws, []));
    const flag = r.flags?.find((f) => f.flag === "SAME-FAMILY");
    assert.ok(flag, JSON.stringify(r));
    assert.equal(flag.session, r.reviewer?.session_id);
    assert.equal(r.next, "inspect_flags");
  });

  it("is read-only, bound by the implementer's rulings, and told to look for special-casing and to judge the criteria and the tests (W2)", async () => {
    const ws = repo();
    const id = await implement(ws, { "src/extra.mjs": "export const x = 1;\n" });
    const seen: SessionRequest[] = [];
    await review(ws, id, reviewer(ws, [], seen), { note: "Pay attention to the rounding." });
    const req = seen[0]!;
    assert.equal(req.specialist, "review-both");
    assert.equal(req.review, true);
    assert.deepEqual(req.rulingsFrom, [id]);
    assert.match(req.prompt, /Special-casing/);
    assert.match(req.prompt, /acceptance criteri/i);
    assert.match(req.prompt, /tests' adequacy/);
    assert.match(req.prompt, /Make add subtract\./, "the task the implementer was given is what it is judged against");
    assert.match(req.prompt, /Pay attention to the rounding\./);
    assert.match(req.prompt, /finding\` tool/);
    assert.doesNotMatch(req.prompt, /git show/, "the reviewer cannot run git; its brief does not tell it to");
  });

  it("is given a task file's body as the task, and the tests that already fail on the base as not its to report", () => {
    const facts = changeOf(repo(), "HEAD", "HEAD");
    const brief = reviewBrief({
      target: { branch: "lykos/x", head: "a".repeat(40), base: "b".repeat(40), baseSource: "stored" },
      facts,
      task: "Add rounding.\n\nAcceptance: 0.5 rounds to 1.",
      baseline: { command: "npm test", failing: ["a.test.ts > known broken"] },
    });
    assert.match(brief, /Acceptance: 0\.5 rounds to 1\./);
    assert.match(brief, /already fail on the base/);
    assert.match(brief, /- a\.test\.ts > known broken/);
  });

  it("a diff past the cap is cut, and the brief says how to see the rest", () => {
    const ws = repo();
    git(ws, "checkout", "-q", "-b", "big");
    put(ws, "big.txt", `${"line of text\n".repeat(MAX_BRIEF_DIFF_CHARS / 10)}`);
    git(ws, "add", "-A");
    git(ws, "commit", "-q", "-m", "big");
    const resolved = resolveReviewTarget(ws, undefined, "big", "main");
    assert.ok(resolved.ok);
    const brief = reviewBrief({ target: resolved.target, facts: changeOf(ws, resolved.target.base, resolved.target.head), task: "t" });
    assert.match(brief, /The diff is cut at \d+ characters\. The rest: `git diff/);
  });
});

describe("T235: refusals", () => {
  it("an unknown session or branch is an error, and so is a change with nothing beyond its base", async () => {
    const ws = repo();
    const r = await review(ws, "no-such-session", reviewer(ws, []));
    assert.equal(r.outcome, "error");
    assert.match(r.message ?? "", /neither a session with a branch of its own nor a branch/);
    assert.equal(r.next, "fix_environment");
    const none = await review(ws, "main", reviewer(ws, []), { base: "main" });
    assert.equal(none.outcome, "error");
    assert.match(none.message ?? "", /nothing beyond its base/);
  });

  it("an unreadable task file is refused before any reviewer starts", async () => {
    const ws = repo();
    const id = await implement(ws, { "src/extra.mjs": "export const x = 1;\n" });
    let started = false;
    const r = await review(ws, id, async () => {
      started = true;
      return { outcome: "ok", sessionId: "x" } as SessionOutcome;
    }, { taskFile: join(ws, "missing.md") });
    assert.equal(r.outcome, "error");
    assert.match(r.message ?? "", /does not exist/);
    assert.equal(started, false);
  });
});

describe("T235: the command", () => {
  it("prints its usage with no arguments, refuses an unknown flag, and wants exactly one target", async () => {
    const ws = repo();
    assert.equal(await runReviewCommand(ws, []), 2);
    assert.equal(await runReviewCommand(ws, ["abc", "--bogus"]), 1);
    assert.equal(await runReviewCommand(ws, ["a", "b"]), 2);
    assert.equal(await runReviewCommand(ws, ["abc", "--max-steps", "0"]), 1);
    assert.match(REVIEW_USAGE, /lykos review <session-id\|branch>/);
  });

  it("lykos status shows the findings the review made under the reviewed session, as decisions", async () => {
    const ws = repo();
    const id = await implement(ws, SUBTRACT);
    await review(ws, id, reviewer(ws, [finding({ check: REPRO }), finding({ severity: "low", text: "naming", basis: "src/math.mjs:1" })]));
    const view = ledgerViews(ws, [id])[0] as unknown as { finding_decisions?: Array<{ action: string }> };
    assert.deepEqual(view.finding_decisions?.map((d) => d.action).sort(), ["dropped", "forwarded"]);
  });
});

describe("T235: the MCP tool is the same review (spec decision 23)", () => {
  it("lykos_review_session returns the CLI's result: findings as claims, with next", async () => {
    const ws = repo();
    const id = await implement(ws, { "src/extra.mjs": "export const x = 1;\n" });
    process.env.LYKOS_TRUST_WORKSPACE = "1";
    const server = createMcpServer({ workspace: ws, version: "0.0.1-test", run: reviewer(ws, [finding({ severity: "medium", text: "no error handling", basis: "src/extra.mjs:1" })]) });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t235", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      assert.ok(listed.tools.some((t) => t.name === "lykos_review_session"));
      const res = await client.callTool({ name: "lykos_review_session", arguments: { target: id } });
      const r = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as Result;
      assert.equal(r.outcome, "ok", JSON.stringify(r));
      assert.equal(r.findings?.[0]?.disposition, "triage");
      assert.equal(r.next, "triage");
      assert.equal(r.reviewed?.session_id, id);
      const refused = await client.callTool({ name: "lykos_review_session", arguments: { target: "nothing-here" } });
      const e = JSON.parse((refused.content as Array<{ text: string }>)[0]!.text) as Result;
      assert.equal(e.outcome, "error");
      assert.equal(e.next, "fix_environment");
    } finally {
      delete process.env.LYKOS_TRUST_WORKSPACE;
      await client.close();
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// One review through the real session child

describe("T235 ACCEPTANCE: a review through the real session child and a scripted model", () => {
  /** A runner that plays each request in the real child on Pi's scripted model. */
  function childRunner(ws: string, provider: unknown, seen: SessionRequest[]): SessionRunner {
    return async ({ request }) => {
      const req = { ...(request as SessionRequest), model: SCRIPTED_MODEL };
      seen.push(request as SessionRequest);
      const input = new PassThrough();
      const frames: Array<Record<string, unknown>> = [];
      input.write(encodeFrame({ ...req, version: PROTOCOL_VERSION }));
      await runSessionChild({
        input,
        write: (text) => {
          for (const line of text.split("\n")) {
            if (line.trim().length === 0) continue;
            try {
              frames.push(JSON.parse(line) as Record<string, unknown>);
            } catch {
              // not a frame
            }
          }
        },
        env: { LYKOS_TRUST_WORKSPACE: "1", LYKOS_TRUST_SOURCE: "flag" },
        trustPath: join(mkdtempSync(join(tmpdir(), "lykos-t235-store-")), "trust.json"),
        worktreesRoot: mkdtempSync(join(tmpdir(), "lykos-t235-wtroot-")),
        runTask: (task) => runStandaloneTask(task),
        sessionExtras: { nativeProviders: [provider as never], ledgerPath: defaultLedgerPath(ws) },
      });
      input.end();
      const last = frames.at(-1) as { type?: string; result?: SessionOutcome } | undefined;
      assert.equal(last?.type, "result", JSON.stringify(frames.slice(-3)));
      return last!.result!;
    };
  }

  it("the reviewer calls finding; the harness runs the reproduction on the branch and decides", { timeout: 240_000 }, async () => {
    const ws = repo();
    const id = await implement(ws, SUBTRACT, "opencode/deepseek-v4.1-flash-free");
    const model = await scriptedProvider([
      reply(call("finding", { text: "add now subtracts", severity: "high", basis: "src/math.mjs:1", check: REPRO })),
      reply(call("finding", { text: "the helper is poorly named", severity: "low", basis: "src/math.mjs:1" })),
      reply(call("finding", { text: "a test is needed for negative numbers", severity: "medium", basis: "src/math.mjs:1" })),
      reply(say("reviewed")),
    ]);
    const seen: SessionRequest[] = [];
    const r = await review(ws, id, childRunner(ws, model.provider, seen));
    model.check();
    assert.equal(model.unusedSteps(), 0);
    assert.equal(r.outcome, "ok", JSON.stringify(r));
    assert.deepEqual(r.findings?.map((f) => [f.severity, f.disposition]), [["high", "blocks"], ["low", "dropped"], ["medium", "triage"]], JSON.stringify(r.findings));
    assert.equal(r.findings?.[0]?.regression, true);
    assert.equal(r.next, "triage");
    assert.equal(r.reviewer?.role, "review-both-alt", "the implementer is deepseek, so the alternate reviews");
    // The reviewer saw the brief with the diff and the rulings clause, read-only: no edit tool on the wire.
    const wire = (model.sent[0]?.tools ?? []).map((t) => t.name);
    assert.ok(wire.includes("finding"), wire.join(", "));
    assert.ok(!wire.includes("edit") && !wire.includes("write"), wire.join(", "));
    const firstMessage = JSON.stringify(model.sent[0]?.messages ?? []);
    assert.match(firstMessage, /Special-casing/);
    assert.match(firstMessage, /src\/math\.mjs/);
    const stored = withLedgerSync(defaultLedgerPath(ws), (ledger) => findingsOf(ledger, r.reviewer!.session_id!));
    assert.equal(stored.length, 3);
  });
});
