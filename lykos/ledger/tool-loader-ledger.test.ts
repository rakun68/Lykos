// T132 — what the session records about the loader, end to end.
//
// The instrumentation is in the same commit as the mechanism on purpose:
// splitting them would land a capability with no way to tell whether it
// ever fired, which is the single discipline this phase substitutes for a
// ledger number.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ingestDelegateSnapshot, type DelegateSnapshot } from "./ingest.js";
import { Ledger } from "./ledger.js";

const TS = new Date("2026-09-08T12:00:00Z");

interface Row {
  tool_loader_enabled: number | null;
  tool_loader_path: string | null;
  tool_loader_deferred: string | null;
  tool_loader_activated: string | null;
  tool_loader_activations: number | null;
  tool_loader_tokens: number | null;
  tool_loader_deferred_tokens: number | null;
}

function snapshot(id: string, extra: Partial<DelegateSnapshot> = {}): DelegateSnapshot {
  return {
    sessionId: id,
    state: "done",
    model: "deepseek/deepseek-v4-flash",
    turns: 1,
    finishedAt: TS.toISOString(),
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
      `SELECT tool_loader_enabled, tool_loader_path, tool_loader_deferred, tool_loader_activated,
              tool_loader_activations, tool_loader_tokens, tool_loader_deferred_tokens
       FROM sessions WHERE id = ?`,
    )
    .get(id) as Row;
}

describe("T132 the session records which path it took", () => {
  it("records the fallback path, the deferred set, and what was activated", () => {
    const ledger = Ledger.open(":memory:");
    ingestDelegateSnapshot(
      ledger,
      snapshot("loader-1", {
        toolLoader: {
          enabled: true,
          path: "fallback",
          deferred: ["agent", "get_subagent_result", "steer_subagent"],
          activated: ["agent"],
          activations: 1,
          loaderTokens: 201,
          deferredTokens: 2140,
        },
      }),
    );
    const row = rowFor(ledger, "loader-1");
    assert.equal(row.tool_loader_enabled, 1);
    assert.equal(row.tool_loader_path, "fallback");
    assert.deepEqual(JSON.parse(row.tool_loader_deferred as string), [
      "agent",
      "get_subagent_result",
      "steer_subagent",
    ]);
    assert.deepEqual(JSON.parse(row.tool_loader_activated as string), ["agent"]);
    assert.equal(row.tool_loader_activations, 1);
    ledger.close();
  });

  it("records the loader's own tax beside what it deferred, so the ratio is computable", () => {
    const ledger = Ledger.open(":memory:");
    ingestDelegateSnapshot(
      ledger,
      snapshot("loader-tax", {
        toolLoader: { enabled: true, path: "fallback", loaderTokens: 201, deferredTokens: 2140, activations: 0 },
      }),
    );
    const row = rowFor(ledger, "loader-tax");
    assert.equal(row.tool_loader_tokens, 201);
    assert.equal(row.tool_loader_deferred_tokens, 2140);
    assert.ok(
      (row.tool_loader_deferred_tokens as number) > (row.tool_loader_tokens as number),
      "a loader costing more than it defers must be visible as arithmetic, not intuition",
    );
    ledger.close();
  });

  it("records enabled with zero activations — the answer the kill criterion reads", () => {
    const ledger = Ledger.open(":memory:");
    ingestDelegateSnapshot(
      ledger,
      snapshot("loader-unused", {
        toolLoader: { enabled: true, path: "fallback", deferred: ["agent"], activated: [], activations: 0 },
      }),
    );
    const row = rowFor(ledger, "loader-unused");
    assert.equal(row.tool_loader_enabled, 1);
    assert.equal(row.tool_loader_activations, 0, "0 means the mechanism was there and nothing used it");
    assert.equal(row.tool_loader_activated, "[]");
    ledger.close();
  });

  it("records enabled = 0 for a session that had the surface and left it off", () => {
    const ledger = Ledger.open(":memory:");
    ingestDelegateSnapshot(ledger, snapshot("loader-off", { toolLoader: { enabled: false, activations: 0 } }));
    assert.equal(rowFor(ledger, "loader-off").tool_loader_enabled, 0);
    ledger.close();
  });

  it("leaves every loader column NULL for a session that had no loader at all", () => {
    const ledger = Ledger.open(":memory:");
    ingestDelegateSnapshot(ledger, snapshot("loader-null"));
    const row = rowFor(ledger, "loader-null");
    assert.equal(row.tool_loader_enabled, null, "NULL is 'no such mechanism', which 0 is not");
    assert.equal(row.tool_loader_path, null);
    assert.equal(row.tool_loader_activations, null);
    ledger.close();
  });
});

describe("T132 no defaults, nothing backfilled", () => {
  it("declares no DEFAULT on any loader column", () => {
    const ledger = Ledger.open(":memory:");
    const cols = ledger.db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    for (const name of [
      "tool_loader_enabled",
      "tool_loader_path",
      "tool_loader_deferred",
      "tool_loader_activated",
      "tool_loader_activations",
      "tool_loader_tokens",
      "tool_loader_deferred_tokens",
    ]) {
      const col = cols.find((c) => c.name === name);
      assert.ok(col !== undefined, `${name} is missing`);
      assert.equal(col.dflt_value, null, `${name} must have no DEFAULT`);
    }
    ledger.close();
  });
});
