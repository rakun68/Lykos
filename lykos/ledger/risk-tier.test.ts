// T107.5 — the tier a call records, end to end into the ledger.
//
// Separate from `ingest.test.ts` deliberately: this ticket's rule is that
// every existing approval and ingest test passes UNCHANGED, so the proof
// that a new column is written lives in a new file rather than as edits
// inside one that already proves something else.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ingestDelegateSnapshot } from "./ingest.js";
import { Ledger } from "./ledger.js";

const TS = new Date("2026-09-08T12:00:00Z");

function freshLedger(): { ledger: Ledger; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "lykos-risk-tier-"));
  return { ledger: Ledger.open(join(dir, "ledger.db")), dir };
}

function tierRows(ledger: Ledger): Array<{ tool_name: string | null; risk_tier: string | null }> {
  return ledger.db
    .prepare(`SELECT tool_name, risk_tier FROM calls ORDER BY rowid`)
    .all() as Array<{ tool_name: string | null; risk_tier: string | null }>;
}

function snapshotWithToolCalls(tools: Array<string | undefined>): Parameters<typeof ingestDelegateSnapshot>[1] {
  return {
    sessionId: `risk-tier-${tools.join("-")}`,
    state: "done",
    model: "deepseek/deepseek-v4-flash",
    turns: 1,
    finishedAt: TS.toISOString(),
    usage: {
      calls: tools.map((tool) => ({
        hop: "direct",
        source: "assistant_message",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        ts: TS.toISOString(),
        ...(tool !== undefined ? { tool } : {}),
      })),
    },
  };
}

describe("T107.5 calls.risk_tier", () => {
  it("records the declared tier for a tool whose tier does not depend on arguments", () => {
    const { ledger } = freshLedger();
    ingestDelegateSnapshot(ledger, snapshotWithToolCalls(["read", "write", "edit", "agent"]));
    assert.deepEqual(tierRows(ledger), [
      { tool_name: "read", risk_tier: "read" },
      { tool_name: "write", risk_tier: "soft-write" },
      { tool_name: "edit", risk_tier: "soft-write" },
      { tool_name: "agent", risk_tier: "hard-write" },
    ]);
    ledger.close();
  });

  it("leaves a bash row NULL rather than recording the declared fallback as though it were measured", () => {
    // The usage row carries a tool name and no arguments, and nothing ties
    // it to the `toolCalls` entry that has them. `hard-write` here would
    // read as a measurement of a command nobody classified.
    const { ledger } = freshLedger();
    ingestDelegateSnapshot(ledger, snapshotWithToolCalls(["bash"]));
    assert.deepEqual(tierRows(ledger), [{ tool_name: "bash", risk_tier: null }]);
    ledger.close();
  });

  it("leaves a non-tool call and an undeclared tool NULL — the default is a policy, not a record", () => {
    const { ledger } = freshLedger();
    ingestDelegateSnapshot(ledger, snapshotWithToolCalls([undefined, "some_tool_nobody_declared"]));
    assert.deepEqual(tierRows(ledger), [
      { tool_name: null, risk_tier: null },
      { tool_name: "some_tool_nobody_declared", risk_tier: null },
    ]);
    ledger.close();
  });

  it("takes no DEFAULT, so a pre-T107 row stays distinguishable from a tierless one", () => {
    const { ledger } = freshLedger();
    const cols = ledger.db.prepare(`PRAGMA table_info(calls)`).all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    const col = cols.find((c) => c.name === "risk_tier");
    assert.ok(col !== undefined, "calls.risk_tier is missing");
    assert.equal(col.dflt_value, null, "risk_tier must have no DEFAULT");
    ledger.close();
  });

  it("adds the column to an existing ledger by migration, and backfills nothing", () => {
    const { ledger, dir } = freshLedger();
    ingestDelegateSnapshot(ledger, snapshotWithToolCalls(["read"]));
    // Simulate a pre-T107 ledger: the column exists but the row predates
    // anything that classified a tier.
    ledger.db.prepare(`UPDATE calls SET risk_tier = NULL`).run();
    ledger.close();

    const reopened = Ledger.open(join(dir, "ledger.db"));
    assert.deepEqual(tierRows(reopened), [{ tool_name: "read", risk_tier: null }]);
    reopened.close();
  });
});
