// Task identity that survives resumption.
//
// The blast radius here is the project's headline number, so these tests are
// written against the thing that number is computed from
// (`v_cost_per_successful_task`) rather than against the command output.
// The acceptance the task list names in full: *a task run, failed, resumed,
// and verified appears once, with the summed cost of every session.*

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Ledger } from "../ledger/ledger.js";
import { listTasks, resolveTaskForRun, resolveTaskId, runTaskAbandon, runTaskList, runTaskName } from "./task.js";

function realLedger(): { ledger: Ledger; ledgerPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "lykos-t61-"));
  const ledgerPath = join(dir, "ledger.db");
  const ledger = Ledger.open(ledgerPath);
  ledger.ensureProject({ id: "proj", rootPath: dir, createdUtc: "2026-09-01T00:00:00.000Z" });
  return { ledger, ledgerPath, dir };
}

function session(ledger: Ledger, id: string, taskId: string, cost: number, startedUtc: string): void {
  ledger.startSession({ id, brief: id, taskId, projectId: "proj", startedUtc });
  ledger.endSession({ id, endedUtc: startedUtc });
  // `total_cost_usd` is summed from `calls` at ingest; these tests are about
  // task identity, not pricing, so the figure is set directly rather than
  // fabricating priced calls to produce it.
  ledger.db.prepare(`UPDATE sessions SET total_cost_usd = ? WHERE id = ?`).run(cost, id);
}

describe("T61 tasks.state finally has a writer", () => {
  it("a verified success closes the task; nothing else does", () => {
    const { ledger, ledgerPath } = realLedger();
    ledger.startTask({ id: "task-1", projectId: "proj", brief: "the work" });
    session(ledger, "s1", "task-1", 0.01, "2026-09-01T00:00:00.000Z");
    assert.equal((ledger.db.prepare(`SELECT state FROM tasks WHERE id='task-1'`).get() as { state: string }).state, "open");

    ledger.recordOutcome({ id: "s1", outcome: "success", outcomeSource: "verification_command" });
    assert.equal((ledger.db.prepare(`SELECT state FROM tasks WHERE id='task-1'`).get() as { state: string }).state, "done");
    ledger.close();
    void ledgerPath;
  });

  it("a failure leaves the task open, because a failed attempt is a reason to resume", () => {
    const { ledger } = realLedger();
    ledger.startTask({ id: "task-1", projectId: "proj", brief: "the work" });
    session(ledger, "s1", "task-1", 0.01, "2026-09-01T00:00:00.000Z");
    ledger.recordOutcome({ id: "s1", outcome: "fail", outcomeSource: "human" });
    assert.equal((ledger.db.prepare(`SELECT state FROM tasks WHERE id='task-1'`).get() as { state: string }).state, "open");
    ledger.close();
  });

  it("an agent's claim cannot move a task, because it cannot reach the writer at all", () => {
    const { ledger } = realLedger();
    ledger.startTask({ id: "task-1", projectId: "proj", brief: "the work" });
    session(ledger, "s1", "task-1", 0.01, "2026-09-01T00:00:00.000Z");
    assert.throws(
      () => ledger.recordOutcome({ id: "s1", outcome: "success", outcomeSource: "agent_claim" as never }),
      /agent_claim/,
    );
    assert.equal((ledger.db.prepare(`SELECT state FROM tasks WHERE id='task-1'`).get() as { state: string }).state, "open");
    ledger.close();
  });

  it("abandonment is a person's word, taken through `lykos task abandon`", () => {
    const { ledger, ledgerPath } = realLedger();
    ledger.startTask({ id: "task-1", projectId: "proj", brief: "the work" });
    session(ledger, "s1", "task-1", 0.02, "2026-09-01T00:00:00.000Z");
    ledger.close();
    const out: string[] = [];
    assert.equal(runTaskAbandon(ledgerPath, "task-1", { write: (t) => out.push(t) }), 0);
    const after = Ledger.open(ledgerPath);
    assert.equal((after.db.prepare(`SELECT state FROM tasks WHERE id='task-1'`).get() as { state: string }).state, "abandoned");
    // The sessions and their cost stay. Excluding them is how every cost
    // claim in this field becomes flattering fiction.
    assert.equal((after.db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE task_id='task-1'`).get() as { n: number }).n, 1);
    after.close();
    assert.match(out.join(""), /stay in the ledger/);
  });
});

describe("T61 naming a task", () => {
  it("renames it without touching anything that was counted", () => {
    const { ledger, ledgerPath } = realLedger();
    ledger.startTask({ id: "task-1", projectId: "proj", brief: "(delegate)" });
    session(ledger, "s1", "task-1", 0.02, "2026-09-01T00:00:00.000Z");
    const before = ledger.db.prepare(`SELECT * FROM sessions WHERE id='s1'`).get();
    ledger.close();

    assert.equal(runTaskName(ledgerPath, "task-1", "the parser rename", { write: () => {} }), 0);
    const after = Ledger.open(ledgerPath);
    assert.equal(
      (after.db.prepare(`SELECT brief FROM tasks WHERE id='task-1'`).get() as { brief: string }).brief,
      "the parser rename",
    );
    assert.deepEqual(after.db.prepare(`SELECT * FROM sessions WHERE id='s1'`).get(), before);
    after.close();
  });

  it("refuses an ambiguous prefix rather than renaming the wrong task", () => {
    const { ledger, ledgerPath } = realLedger();
    ledger.startTask({ id: "abc-one", projectId: "proj", brief: "one" });
    ledger.startTask({ id: "abc-two", projectId: "proj", brief: "two" });
    const resolved = resolveTaskId(ledger, "abc");
    assert.ok("error" in resolved);
    ledger.close();
    assert.equal(runTaskName(ledgerPath, "abc", "something", { write: () => {} }), 1);
  });
});

describe("T61 --task joins an existing task", () => {
  it("resolves a prefix to the task and the project it belongs to", () => {
    const { ledger, ledgerPath } = realLedger();
    ledger.startTask({ id: "task-abcdef", projectId: "proj", brief: "the work" });
    ledger.close();
    const resolved = resolveTaskForRun(ledgerPath, "task-abc");
    assert.deepEqual(resolved, { taskId: "task-abcdef", projectId: "proj" });
  });

  it("errors on an unknown id rather than silently auto-creating a rival task", () => {
    const { ledger, ledgerPath } = realLedger();
    ledger.close();
    const resolved = resolveTaskForRun(ledgerPath, "nope");
    assert.ok("error" in resolved);
  });
});

describe("T61 the headline metric counts a multi-session task once", () => {
  it("a task run, failed, resumed and verified is one task at the summed cost", () => {
    const { ledger } = realLedger();
    ledger.startTask({ id: "task-1", projectId: "proj", brief: "the work" });
    // First attempt: failed, verified as such by a person.
    session(ledger, "first", "task-1", 0.02, "2026-09-01T00:00:00.000Z");
    ledger.recordOutcome({ id: "first", outcome: "fail", outcomeSource: "human" });
    // The resume: same task, new row, `resumed_from` as the link.
    ledger.startSession({
      id: "second",
      brief: "second",
      taskId: "task-1",
      projectId: "proj",
      resumedFrom: "first",
      startedUtc: "2026-09-01T02:00:00.000Z",
    });
    ledger.endSession({ id: "second", endedUtc: "2026-09-01T03:00:00.000Z" });
    ledger.db.prepare(`UPDATE sessions SET total_cost_usd = 0.03 WHERE id = 'second'`).run();
    ledger.recordOutcome({ id: "second", outcome: "success", outcomeSource: "verification_command" });

    const rows = ledger.db
      .prepare(`SELECT task_id, sessions, successes, failures, spent_usd, cost_per_success FROM v_cost_per_successful_task`)
      .all() as Array<{ sessions: number; successes: number; failures: number; spent_usd: number; cost_per_success: number }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.sessions, 2);
    assert.equal(rows[0]!.successes, 1);
    assert.equal(rows[0]!.failures, 1);
    // The whole point: the failed attempt's cost is included. Giving up and
    // restarting can never improve the headline number.
    assert.equal(rows[0]!.spent_usd, 0.05);
    assert.equal(rows[0]!.cost_per_success, 0.05);
    // And the task itself is closed by the verified success.
    assert.equal((ledger.db.prepare(`SELECT state FROM tasks WHERE id='task-1'`).get() as { state: string }).state, "done");
    ledger.close();
  });

  it("a second attempt joined with --task does the same as a resume", () => {
    const { ledger } = realLedger();
    ledger.startTask({ id: "task-1", projectId: "proj", brief: "the work" });
    session(ledger, "attempt1", "task-1", 0.02, "2026-09-01T00:00:00.000Z");
    session(ledger, "attempt2", "task-1", 0.04, "2026-09-02T00:00:00.000Z");
    ledger.recordOutcome({ id: "attempt2", outcome: "success", outcomeSource: "verification_command" });
    const row = ledger.db
      .prepare(`SELECT sessions, spent_usd FROM v_cost_per_successful_task`)
      .get() as { sessions: number; spent_usd: number };
    assert.equal(row.sessions, 2);
    assert.equal(row.spent_usd, 0.06);
    ledger.close();
  });
});

describe("T61 lykos task list", () => {
  it("makes a task that quietly acquired several sessions visible rather than inferred", () => {
    const { ledger, ledgerPath } = realLedger();
    ledger.startTask({ id: "task-1", projectId: "proj", brief: "the busy one" });
    ledger.startTask({ id: "task-2", projectId: "proj", brief: "the quiet one" });
    session(ledger, "a", "task-1", 0.01, "2026-09-01T00:00:00.000Z");
    session(ledger, "b", "task-1", 0.02, "2026-09-01T01:00:00.000Z");
    session(ledger, "c", "task-2", 0.03, "2026-09-01T02:00:00.000Z");
    const rows = listTasks(ledger);
    assert.equal(rows.find((r) => r.id === "task-1")?.sessions, 2);
    assert.equal(rows.find((r) => r.id === "task-1")?.spentUsd, 0.03);
    ledger.close();

    const out: string[] = [];
    assert.equal(runTaskList(ledgerPath, { write: (t) => out.push(t) }), 0);
    assert.match(out.join(""), /1 with more than one session/);
  });

  it("says there are no tasks rather than printing an empty table", () => {
    const { ledger, ledgerPath } = realLedger();
    ledger.close();
    const out: string[] = [];
    runTaskList(ledgerPath, { write: (t) => out.push(t) });
    assert.match(out.join(""), /no tasks yet/);
  });
});
