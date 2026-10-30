// Subagent resumption, honestly split.
//
// Most of this task is making an existing distinction visible and PROVING
// the degraded path refuses cleanly, because T9.1 already answered the hard
// question and T39 already changed the answer for one of the two cases:
//
//   * Lykos-spawned children are ordinary sessions with ordinary
//     transcripts. They resume through T57 unchanged. The only new work is
//     that a child's resume inherits the CHILD's tool surface — never the
//     parent's `Agent` tool.
//   * MCP hop-1 sessions stay `resumable = 0`, and the reason recorded at
//     ingest is shown verbatim rather than softened into a generic error.
//
// And the third clause, which is the same class of error T61 exists to
// prevent and is cheaper to catch here: a subagent's cost belongs to the
// PARENT's task.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Ledger } from "../ledger/ledger.js";
import { TranscriptWriter, writeSessionMeta } from "./transcript.js";
import { preflightResume } from "./resume-preflight.js";
import { inheritedTools, planFromPreflight, runResume, type LaunchInput } from "../cli/resume.js";
import { resolveStandaloneTools } from "../tools.js";

const OFF_PEAK = new Date("2026-08-29T12:00:00Z");

function realLedger(): { ledger: Ledger; ledgerPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "lykos-t60-"));
  const ledgerPath = join(dir, "ledger.db");
  return { ledger: Ledger.open(ledgerPath), ledgerPath, dir };
}

function seed(
  ledger: Ledger,
  ledgerPath: string,
  id: string,
  opts: {
    parent?: string;
    shape?: "standalone" | "subagent" | "mcp_worker";
    tools?: string[];
    resumable?: boolean;
    reason?: string;
    taskId?: string;
    v1Meta?: boolean;
  } = {},
): void {
  const writer = new TranscriptWriter(ledgerPath, id);
  writer.append({ kind: "user_message", text: `work in ${id}` });
  writer.append({ kind: "assistant_message", text: "done", final: false });
  const fin = writer.finalize();
  if (opts.taskId) {
    ledger.ensureProject({ id: "proj", rootPath: "/w", createdUtc: "2026-09-01T00:00:00.000Z" });
    ledger.startTask({ id: opts.taskId, projectId: "proj", brief: "the parent task" });
  }
  ledger.startSession({
    id,
    brief: id,
    model: "deepseek/deepseek-v4-flash",
    captureMode: "stream",
    startedUtc: "2026-09-01T00:00:00.000Z",
    ...(opts.parent ? { parentSessionId: opts.parent } : {}),
    ...(opts.shape ? { executionShape: opts.shape } : {}),
    ...(opts.taskId ? { taskId: opts.taskId, projectId: "proj" } : {}),
    ...(opts.resumable === false ? { resumable: false, notResumableReason: opts.reason ?? "not resumable" } : {}),
  });
  ledger.endSession({
    id,
    endedUtc: "2026-09-01T01:00:00.000Z",
    transcriptPath: fin.path,
    transcriptSha256: fin.sha256,
    transcriptBytes: fin.bytes,
  });
  writeSessionMeta(ledgerPath, {
    schemaVersion: opts.v1Meta ? 1 : 2,
    sessionId: id,
    taskId: opts.taskId ?? null,
    projectId: opts.taskId ? "proj" : null,
    parentSessionId: opts.parent ?? null,
    resumedFrom: null,
    agentRole: opts.parent ? "subagent" : "worker",
    model: "deepseek/deepseek-v4-flash",
    cwd: "/w",
    startedUtc: "2026-09-01T00:00:00.000Z",
    captureMode: "stream",
    ...(opts.v1Meta ? {} : { tools: { active: opts.tools ?? ["read", "bash", "edit", "write"], extensions: [] } }),
  });
}

describe("T60 a child never regains the Agent tool", () => {
  it("is denied it at boot in the first place", () => {
    // The rule this test is guarding is `resolveStandaloneTools`'s, restated
    // here so a change to it fails in T60's own suite too.
    assert.ok(!resolveStandaloneTools({ subagents: true, isChild: true }).includes("agent"));
    assert.ok(!resolveStandaloneTools({ subagents: true }).includes("agent"));
  });

  it("is denied it on resume, even when the recorded surface somehow contains it", () => {
    // Unconditional, because the recorded list is DATA and this is an
    // invariant: a subagent that could spawn subagents through a resume
    // would be a hop-topology change nobody chose.
    assert.deepEqual(inheritedTools(["read", "bash", "agent"], true), ["read", "bash"]);
    assert.deepEqual(inheritedTools(["read", "bash", "agent"], false), ["read", "bash", "agent"]);
  });

  it("hands the launcher the child's own surface, not the parent's", async () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seed(ledger, ledgerPath, "parent00", { tools: ["read", "bash", "edit", "write", "agent"] });
    seed(ledger, ledgerPath, "child000", {
      parent: "parent00",
      shape: "subagent",
      tools: ["read", "bash", "edit", "write"],
    });
    ledger.close();

    let seen: LaunchInput | undefined;
    await runResume(dir, ledgerPath, "child000", {
      yes: true,
      now: OFF_PEAK,
      launch: async (input) => {
        seen = input;
        return { status: "ok" as const };
      },
    });
    assert.deepEqual(seen?.resume.tools, ["read", "bash", "edit", "write"]);
    assert.ok(!(seen?.resume.tools ?? []).includes("agent"));
  });

  it("inherits a parent's Agent tool when the parent itself is resumed", () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seed(ledger, ledgerPath, "parent00", { tools: ["read", "bash", "edit", "write", "agent"] });
    const pre = preflightResume({ ledger, sessionId: "parent00", workspace: dir, now: OFF_PEAK });
    const plan = planFromPreflight(pre, { promptDiet: true, outputDiet: true, overridden: false }, {
      taskId: null,
      projectId: null,
      isChild: false,
    });
    assert.ok(plan.tools?.includes("agent"));
    ledger.close();
  });
});

describe("T60 the tool-surface preflight check", () => {
  const verdictOf = (pre: ReturnType<typeof preflightResume>): string =>
    pre.checks.find((c) => c.id === "tool_surface")?.verdict ?? "(absent)";

  it("passes when the surface was recorded, naming what will be inherited", () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seed(ledger, ledgerPath, "recorded", { tools: ["read", "bash"] });
    const pre = preflightResume({ ledger, sessionId: "recorded", workspace: dir, now: OFF_PEAK });
    assert.equal(verdictOf(pre), "proceed");
    assert.match(pre.checks.find((c) => c.id === "tool_surface")!.message, /read, bash/);
    ledger.close();
  });

  it("warns rather than guessing when the session predates meta.json v2", () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seed(ledger, ledgerPath, "oldmeta0", { v1Meta: true });
    const pre = preflightResume({ ledger, sessionId: "oldmeta0", workspace: dir, now: OFF_PEAK });
    assert.equal(verdictOf(pre), "warn");
    ledger.close();
  });

  it("says out loud when a child's recorded surface contradicts the invariant", () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seed(ledger, ledgerPath, "theparent");
    seed(ledger, ledgerPath, "weirdkid", { parent: "theparent", shape: "subagent", tools: ["read", "agent"] });
    const pre = preflightResume({ ledger, sessionId: "weirdkid", workspace: dir, now: OFF_PEAK });
    assert.equal(verdictOf(pre), "warn");
    assert.match(pre.checks.find((c) => c.id === "tool_surface")!.message, /dropped on resume/);
    ledger.close();
  });
});

describe("T60 MCP hop-1 refuses, verbatim", () => {
  const REASON = "MCP hop-1 sessions are driven by the orchestrator and have no Lykos-side transcript to replay";

  it("the preflight refuses and prints the recorded reason unchanged", () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seed(ledger, ledgerPath, "hop1aaaa", { shape: "mcp_worker", resumable: false, reason: REASON });
    const pre = preflightResume({ ledger, sessionId: "hop1aaaa", workspace: dir, now: OFF_PEAK });
    assert.equal(pre.overall, "refuse");
    const check = pre.checks.find((c) => c.id === "resumable")!;
    assert.equal(check.verdict, "refuse");
    // Verbatim — `08` §1.1. The reason is quoted, never paraphrased into
    // "cannot resume this session".
    assert.ok(check.message.includes(REASON));
    ledger.close();
  });

  it("`lykos resume` starts nothing and spends nothing on one", async () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seed(ledger, ledgerPath, "hop1aaaa", { shape: "mcp_worker", resumable: false, reason: REASON });
    ledger.close();
    let launched = false;
    const code = await runResume(dir, ledgerPath, "hop1aaaa", {
      yes: true,
      now: OFF_PEAK,
      launch: async () => {
        launched = true;
        return { status: "ok" as const };
      },
    });
    assert.equal(code, 1);
    assert.equal(launched, false);
  });
});

describe("T60 a subagent's cost belongs to the parent's task", () => {
  it("a child seeded with its parent's task id counts once, with both sessions summed", () => {
    const { ledger, ledgerPath } = realLedger();
    seed(ledger, ledgerPath, "parent00", { taskId: "task-one" });
    seed(ledger, ledgerPath, "child000", { parent: "parent00", shape: "subagent", taskId: "task-one" });
    ledger.db.prepare(`UPDATE sessions SET total_cost_usd = 0.02 WHERE id = 'parent00'`).run();
    ledger.db.prepare(`UPDATE sessions SET total_cost_usd = 0.01, outcome = 'success' WHERE id = 'child000'`).run();

    const rows = ledger.db
      .prepare(`SELECT task_id, sessions, spent_usd FROM v_cost_per_successful_task`)
      .all() as Array<{ task_id: string; sessions: number; spent_usd: number }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.sessions, 2);
    // The headline metric counts the pair as one task at the summed cost —
    // which is the property T39 established and T61 generalises.
    assert.equal(rows[0]!.spent_usd, 0.03);
    ledger.close();
  });

  it("a resumed child keeps carrying the parent's task, so a retry is not a second task", async () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seed(ledger, ledgerPath, "parent00", { taskId: "task-one" });
    seed(ledger, ledgerPath, "child000", { parent: "parent00", shape: "subagent", taskId: "task-one" });
    ledger.close();
    let seen: LaunchInput | undefined;
    await runResume(dir, ledgerPath, "child000", {
      yes: true,
      now: OFF_PEAK,
      launch: async (input) => {
        seen = input;
        return { status: "ok" as const };
      },
    });
    assert.equal(seen?.resume.taskId, "task-one");
  });
});
