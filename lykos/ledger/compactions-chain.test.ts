// T190: the `compactions` table's chain columns -- the method that ran, the
// ones that fell through, and the compaction's own model call with cache read
// and cache write apart -- stored, redacted where a provider's text goes, and
// added to a ledger whose table predates them.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { NO_MODEL_CALL } from "../loop/self-compact.js";
import { Ledger, type CompactionRow } from "./ledger.js";

const ROW: CompactionRow = {
  id: "c1",
  ts: "2026-10-11T00:00:00.000Z",
  strategy: "self-compact",
  trigger: "pi-threshold",
  attempt: 1,
  model: "faux/scripted-1",
  tier: "128k",
  context_window: 128_000,
  tokens_before: 120_000,
  tokens_after: 9_000,
  result: "ok",
};

describe("Ledger: compactions chain columns (T190)", () => {
  it("stores the method, what fell through, and the call's usage with cache read and write apart", () => {
    const ledger = Ledger.open(":memory:");
    const sessionId = ledger.startSession({ harnessCommit: "chain" });
    ledger.recordCompactions(sessionId, [
      {
        ...ROW,
        method: "handoff",
        fell_through: [{ method: "note", reason: "the agent left no note" }],
        input_tokens: 400,
        output_tokens: 900,
        cache_read_tokens: 100_000,
        cache_write_tokens: 2_000,
        cache_write_1h_tokens: 1_500,
      },
      { ...ROW, id: "c2", method: "shake", ...NO_MODEL_CALL },
      { ...ROW, id: "c3" }, // a row from before the chain
    ]);
    const rows = ledger.compactions(sessionId);
    assert.deepEqual(
      rows.map((r) => [r.method, r.fell_through, r.input_tokens, r.cache_read_tokens, r.cache_write_tokens, r.cache_write_1h_tokens]),
      [
        ["handoff", '[{"method":"note","reason":"the agent left no note"}]', 400, 100_000, 2_000, 1_500],
        ["shake", null, 0, 0, 0, 0],
        [null, null, null, null, null, null],
      ],
    );
    ledger.close();
  });

  it("adds the columns to a compactions table that predates them, keeping its rows", () => {
    const path = join(mkdtempSync(join(tmpdir(), "lykos-compactions-migrate-")), "ledger.db");
    const first = Ledger.open(path);
    const sessionId = first.startSession({ harnessCommit: "old" });
    first.recordCompactions(sessionId, [ROW]);
    first.close();
    // Rebuild the table as T152 made it: no chain columns.
    const raw = new Database(path);
    raw.exec(`
      CREATE TABLE compactions_old AS SELECT id, session_id, ts_utc, strategy, trigger, handoff_id, attempt, model, tier,
        context_window, tokens_before, tokens_after, result, error FROM compactions;
      DROP TABLE compactions;
      ALTER TABLE compactions_old RENAME TO compactions;
    `);
    raw.close();
    const reopened = Ledger.open(path);
    const [row] = reopened.compactions(sessionId);
    assert.equal(row?.id, "c1");
    assert.equal(row?.method, null);
    reopened.recordCompactions(sessionId, [{ ...ROW, id: "c2", method: "summary", cache_read_tokens: 5 }]);
    assert.deepEqual(
      reopened.compactions(sessionId).map((r) => [r.id, r.method, r.cache_read_tokens]),
      [
        ["c1", null, null],
        ["c2", "summary", 5],
      ],
    );
    reopened.close();
  });
});
