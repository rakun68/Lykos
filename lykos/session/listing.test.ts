// The picker's data.
//
// The four-level identity model has been in the schema since T8 and has
// never been visible anywhere. These tests are what pins the shape it
// becomes visible in, so a later change cannot quietly flatten it.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Ledger } from "../ledger/ledger.js";
import { filterSessions, loadSessions, nestSessions, type SessionListRow } from "./listing.js";

function ledger(): Ledger {
  return Ledger.open(join(mkdtempSync(join(tmpdir(), "lykos-t58-")), "ledger.db"));
}

function row(id: string, over: Partial<SessionListRow> = {}): SessionListRow {
  return {
    id,
    taskId: null,
    taskBrief: null,
    brief: id,
    startedUtc: "2026-09-01T00:00:00.000Z",
    endedUtc: null,
    model: null,
    executionShape: null,
    outcome: null,
    outcomeSource: null,
    archiveState: null,
    captureMode: null,
    resumable: true,
    notResumableReason: null,
    parentSessionId: null,
    resumedFrom: null,
    costUsd: null,
    durationSeconds: null,
    depth: 0,
    edge: null,
    ...over,
  };
}

describe("T58 loadSessions", () => {
  it("reads the columns the picker shows, newest first, with the task's brief joined in", () => {
    const led = ledger();
    led.ensureProject({ id: "p", rootPath: "/w", createdUtc: "2026-09-01T00:00:00.000Z" });
    led.startTask({ id: "t", projectId: "p", brief: "the parser rename" });
    led.startSession({
      id: "older",
      brief: "first go",
      taskId: "t",
      projectId: "p",
      model: "deepseek/deepseek-v4-flash",
      captureMode: "stream",
      startedUtc: "2026-09-01T00:00:00.000Z",
    });
    led.endSession({ id: "older", endedUtc: "2026-09-01T00:30:00.000Z" });
    led.startSession({ id: "newer", brief: "second go", startedUtc: "2026-09-02T00:00:00.000Z" });

    const rows = loadSessions(led);
    assert.deepEqual(
      rows.map((r) => r.id),
      ["newer", "older"],
    );
    const older = rows.find((r) => r.id === "older")!;
    assert.equal(older.taskBrief, "the parser rename");
    assert.equal(older.captureMode, "stream");
    assert.equal(older.durationSeconds, 1800);
    // The column defaults to 1; only an explicit 0 means "not resumable".
    assert.equal(older.resumable, true);
    led.close();
  });

  it("reports a session ingest marked resumable = 0 as not resumable, with its reason", () => {
    const led = ledger();
    led.startSession({
      id: "hop1",
      brief: "mcp worker",
      startedUtc: "2026-09-01T00:00:00.000Z",
      resumable: false,
      notResumableReason: "MCP hop-1 sessions have no local transcript to replay",
    });
    const [only] = loadSessions(led);
    assert.equal(only!.resumable, false);
    assert.match(only!.notResumableReason!, /hop-1/);
    led.close();
  });
});

describe("T58 nestSessions — the identity model, made visible", () => {
  it("nests a subagent under its spawner and a resume under its original", () => {
    const rows = [
      row("parent", { startedUtc: "2026-09-01T00:00:00.000Z" }),
      row("child", { parentSessionId: "parent", startedUtc: "2026-09-01T00:10:00.000Z" }),
      row("continued", { resumedFrom: "parent", startedUtc: "2026-09-01T02:00:00.000Z" }),
    ];
    const nested = nestSessions(rows);
    assert.deepEqual(
      nested.map((r) => [r.id, r.depth, r.edge]),
      [
        ["parent", 0, null],
        ["child", 1, "subagent"],
        ["continued", 1, "resumed"],
      ],
    );
  });

  it("chains a resume of a resume, oldest first, so the continuation reads forwards", () => {
    const rows = [
      row("a", { startedUtc: "2026-09-01T00:00:00.000Z" }),
      row("b", { resumedFrom: "a", startedUtc: "2026-09-01T01:00:00.000Z" }),
      row("c", { resumedFrom: "b", startedUtc: "2026-09-01T02:00:00.000Z" }),
    ];
    assert.deepEqual(
      nestSessions(rows).map((r) => [r.id, r.depth]),
      [
        ["a", 0],
        ["b", 1],
        ["c", 2],
      ],
    );
  });

  it("keeps a row whose relative is not in the list rather than dropping it", () => {
    // The project does not delete. A subagent whose spawner was filtered out
    // is still a session that ran, and losing it would be a deletion.
    const nested = nestSessions([row("orphan", { parentSessionId: "gone" })]);
    assert.deepEqual(
      nested.map((r) => [r.id, r.depth]),
      [["orphan", 0]],
    );
  });

  it("prefers the spawner over the original when a resumed subagent has both edges", () => {
    const rows = [
      row("spawner", { startedUtc: "2026-09-01T00:00:00.000Z" }),
      row("first-child", { parentSessionId: "spawner", startedUtc: "2026-09-01T00:05:00.000Z" }),
      row("child-again", {
        parentSessionId: "spawner",
        resumedFrom: "first-child",
        startedUtc: "2026-09-01T00:20:00.000Z",
      }),
    ];
    const nested = nestSessions(rows);
    const again = nested.find((r) => r.id === "child-again")!;
    assert.equal(again.depth, 1);
    assert.equal(again.edge, "subagent");
  });

  it("terminates on a cycle rather than hanging, and still shows every row", () => {
    const rows = [row("x", { resumedFrom: "y" }), row("y", { resumedFrom: "x" })];
    const nested = nestSessions(rows);
    assert.equal(nested.length, 2);
  });
});

describe("T58 filterSessions", () => {
  const rows = nestSessions([
    row("parent", { brief: "rewrite the ledger", startedUtc: "2026-09-01T00:00:00.000Z" }),
    row("child", { brief: "grep for callers", parentSessionId: "parent", startedUtc: "2026-09-01T00:05:00.000Z" }),
    row("other", { brief: "fix the footer", startedUtc: "2026-09-01T01:00:00.000Z" }),
  ]);

  it("is a plain, case-insensitive substring across everything the row shows", () => {
    assert.deepEqual(
      filterSessions(rows, "FOOTER").map((r) => r.id),
      ["other"],
    );
  });

  it("keeps a match's ancestors so a nested row is never orphaned under a missing heading", () => {
    assert.deepEqual(
      filterSessions(rows, "grep").map((r) => r.id),
      ["parent", "child"],
    );
  });

  it("returns everything for an empty filter", () => {
    assert.equal(filterSessions(rows, "   ").length, 3);
  });
});
