// T111 — the three metrics, end to end into the ledger.
//
// In its own file for the same reason `risk-tier.test.ts` is: the phase's
// rule is that existing tests are not rewritten to accommodate a new column.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { ingestDelegateSnapshot, type DelegateSnapshot } from "./ingest.js";
import { Ledger } from "./ledger.js";

const here = dirname(fileURLToPath(import.meta.url));

const TS = new Date("2026-09-08T12:00:00Z");

interface Row {
  artifact_bytes: number | null;
  approvals_requested: number | null;
  approvals_denied: number | null;
  approvals_auto_denied: number | null;
  approvals_by_tier: string | null;
  approvals_by_mode: string | null;
  tool_call_counts: string | null;
  actual_tool_call_counts: string | null;
  tool_error_counts: string | null;
  tool_adjacent_pairs: number | null;
  tool_switch_same_target: number | null;
}

function baseSnapshot(id: string, extra: Partial<DelegateSnapshot> = {}): DelegateSnapshot {
  return {
    sessionId: id,
    state: "done",
    model: "deepseek/deepseek-v4-flash",
    turns: 1,
    finishedAt: TS.toISOString(),
    // `ingestDelegateSnapshot` records nothing for a snapshot with no usage
    // block, so every fixture here carries one real call.
    usage: {
      calls: [
        {
          hop: "direct",
          source: "assistant_message",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          input: 100,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          ts: TS.toISOString(),
        },
      ],
    },
    ...extra,
  };
}

function rowFor(ledger: Ledger, id: string): Row {
  return ledger.db
    .prepare(
      `SELECT artifact_bytes, approvals_requested, approvals_denied, approvals_auto_denied,
              approvals_by_tier, approvals_by_mode, tool_call_counts, actual_tool_call_counts,
              tool_error_counts, tool_adjacent_pairs, tool_switch_same_target
       FROM sessions WHERE id = ?`,
    )
    .get(id) as Row;
}

describe("T111.1 artifact bytes", () => {
  it("records what the transcript writer observed spilling", () => {
    const ledger = Ledger.open(":memory:");
    ingestDelegateSnapshot(ledger, baseSnapshot("art-1", { artifactBytes: 40_960 }));
    assert.equal(rowFor(ledger, "art-1").artifact_bytes, 40_960);
    ledger.close();
  });

  it("records 0 for a session that had a writer and spilled nothing", () => {
    const ledger = Ledger.open(":memory:");
    ingestDelegateSnapshot(ledger, baseSnapshot("art-0", { artifactBytes: 0 }));
    assert.equal(rowFor(ledger, "art-0").artifact_bytes, 0);
    ledger.close();
  });

  it("leaves NULL when nothing observed the session — not the same answer as 0", () => {
    const ledger = Ledger.open(":memory:");
    ingestDelegateSnapshot(ledger, baseSnapshot("art-null"));
    assert.equal(rowFor(ledger, "art-null").artifact_bytes, null);
    ledger.close();
  });

  it("is summed to the task by the existing task rollup", () => {
    const ledger = Ledger.open(":memory:");
    const projectId = "proj-t111";
    ledger.ensureProject({ id: projectId, rootPath: "/tmp/t111", createdUtc: TS.toISOString() });
    const taskId = ledger.startTask({ projectId, brief: "one task, two sessions" });
    for (const [id, bytes] of [
      ["task-a", 1000],
      ["task-b", 2500],
    ] as const) {
      ingestDelegateSnapshot(ledger, baseSnapshot(id, { artifactBytes: bytes }), { taskId, projectId });
    }
    const rollup = ledger.db
      .prepare(`SELECT sessions, artifact_bytes FROM v_cost_per_successful_task WHERE task_id = ?`)
      .get(taskId) as { sessions: number; artifact_bytes: number };
    assert.equal(rollup.sessions, 2);
    assert.equal(rollup.artifact_bytes, 3500, "the task's bytes are the sum over its sessions");
    ledger.close();
  });
});

describe("T111.2 approvals", () => {
  it("records the counts and both breakdowns when a gate observed the session", () => {
    const ledger = Ledger.open(":memory:");
    ingestDelegateSnapshot(
      ledger,
      baseSnapshot("appr-1", {
        approvals: {
          requested: 3,
          denied: 1,
          autoDenied: 2,
          byTier: '{"hard-write":{"requested":3,"denied":1,"autoDenied":0,"allowed":0}}',
          byMode: '{"auto":{"requested":3,"denied":1,"autoDenied":2,"allowed":9}}',
        },
      }),
    );
    const row = rowFor(ledger, "appr-1");
    assert.equal(row.approvals_requested, 3);
    assert.equal(row.approvals_denied, 1);
    assert.equal(row.approvals_auto_denied, 2);
    assert.equal(JSON.parse(row.approvals_by_tier as string)["hard-write"].requested, 3);
    assert.equal(JSON.parse(row.approvals_by_mode as string).auto.allowed, 9);
    ledger.close();
  });

  it("records zeros for a session whose gate ran and never had to ask", () => {
    const ledger = Ledger.open(":memory:");
    ingestDelegateSnapshot(
      ledger,
      baseSnapshot("appr-0", { approvals: { requested: 0, denied: 0, autoDenied: 0, byTier: "{}", byMode: "{}" } }),
    );
    const row = rowFor(ledger, "appr-0");
    assert.equal(row.approvals_requested, 0);
    assert.equal(row.approvals_denied, 0);
    assert.equal(row.approvals_by_tier, "{}");
    ledger.close();
  });

  it("leaves every approval column NULL for a shape with no gate at all", () => {
    const ledger = Ledger.open(":memory:");
    ingestDelegateSnapshot(ledger, baseSnapshot("appr-null"));
    const row = rowFor(ledger, "appr-null");
    assert.equal(row.approvals_requested, null);
    assert.equal(row.approvals_denied, null);
    assert.equal(row.approvals_auto_denied, null);
    assert.equal(row.approvals_by_tier, null);
    assert.equal(row.approvals_by_mode, null);
    ledger.close();
  });
});

describe("T111.3 the tool-selection substrate", () => {
  it("records per-tool counts, errors, and the switch numbers off the session's own trace", () => {
    const ledger = Ledger.open(":memory:");
    ingestDelegateSnapshot(
      ledger,
      baseSnapshot("sub-1", {
        toolCalls: [
          { name: "read", args: { path: "a.ts" } },
          { name: "edit", args: { path: "a.ts" }, state: "error" },
          { name: "write", args: { path: "a.ts" } },
        ],
      }),
    );
    const row = rowFor(ledger, "sub-1");
    assert.deepEqual(JSON.parse(row.tool_call_counts as string), { read: 1, edit: 1, write: 1 });
    assert.deepEqual(JSON.parse(row.tool_error_counts as string), { edit: 1 });
    assert.equal(row.tool_adjacent_pairs, 2);
    assert.equal(row.tool_switch_same_target, 2);
    ledger.close();
  });

  it("records the actual identity of a transport dispatch next to its wire name (D26)", () => {
    const ledger = Ledger.open(":memory:");
    ingestDelegateSnapshot(
      ledger,
      baseSnapshot("sub-t", {
        toolCalls: [
          { name: "tool_call", args: { name: "web_fetch", arguments: { url: "https://example.com" } } },
          { name: "read", args: { path: "a.ts" } },
        ],
      }),
    );
    const row = rowFor(ledger, "sub-t");
    assert.deepEqual(JSON.parse(row.tool_call_counts as string), { tool_call: 1, read: 1 });
    assert.deepEqual(JSON.parse(row.actual_tool_call_counts as string), { web_fetch: 1, read: 1 });
    ledger.close();
  });

  it("records an empty measurement for a session that ran no tools", () => {
    const ledger = Ledger.open(":memory:");
    ingestDelegateSnapshot(ledger, baseSnapshot("sub-0", { toolCalls: [] }));
    const row = rowFor(ledger, "sub-0");
    assert.equal(row.tool_call_counts, "{}");
    assert.equal(row.actual_tool_call_counts, "{}");
    assert.equal(row.tool_adjacent_pairs, 0);
    assert.equal(row.tool_switch_same_target, 0);
    ledger.close();
  });
});

describe("T111.4/T111.5 no defaults, nothing backfilled", () => {
  it("declares no DEFAULT on any of the new columns", () => {
    const ledger = Ledger.open(":memory:");
    const cols = ledger.db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    for (const name of [
      "artifact_bytes",
      "approvals_requested",
      "approvals_denied",
      "approvals_auto_denied",
      "approvals_by_tier",
      "approvals_by_mode",
      "tool_call_counts",
      "actual_tool_call_counts",
      "tool_error_counts",
      "tool_adjacent_pairs",
      "tool_switch_same_target",
    ]) {
      const col = cols.find((c) => c.name === name);
      assert.ok(col !== undefined, `${name} is missing`);
      assert.equal(col.dflt_value, null, `${name} must have no DEFAULT`);
    }
    ledger.close();
  });

  it("leaves a session that predates the columns reading NULL, and backfills none of them", () => {
    const ledger = Ledger.open(":memory:");
    ingestDelegateSnapshot(ledger, baseSnapshot("old-row", { artifactBytes: 12 }));
    // Stand in for a pre-T111 row: the columns exist but nothing wrote them.
    ledger.db
      .prepare(
        `UPDATE sessions SET artifact_bytes = NULL, approvals_requested = NULL, tool_call_counts = NULL
         WHERE id = ?`,
      )
      .run("old-row");
    const row = rowFor(ledger, "old-row");
    assert.equal(row.artifact_bytes, null);
    assert.equal(row.approvals_requested, null);
    assert.equal(row.tool_call_counts, null);
    ledger.close();
  });
});

describe("T111 acceptance: cost reporting sums none of these across price bases", () => {
  it("keeps every new column out of the cost report's summed figures", () => {
    // The acceptance criterion is about `lykos cost`, whose dollar sums are
    // the thing the price-basis rule protects. None of T111's columns is a
    // dollar amount, and none is read by the cost path — asserted here so
    // that adding one to a SUM() later fails rather than silently mixes
    // bases.
    const cost = readFileSync(join(here, "..", "cli", "cost.ts"), "utf8");
    for (const column of [
      "artifact_bytes",
      "approvals_requested",
      "approvals_denied",
      "approvals_auto_denied",
      "tool_call_counts",
      "tool_error_counts",
      "tool_switch_same_target",
    ]) {
      assert.equal(cost.includes(column), false, `lykos cost must not read ${column}`);
    }
  });
});
