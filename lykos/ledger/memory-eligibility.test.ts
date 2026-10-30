import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Ledger, migrateMemoryEligibility } from "./ledger.js";
import { eligibilityReport, formatEligibilityReport } from "./memory-eligibility.js";
import { assembleMemoryHead, type InjectedMemory } from "../session/memory-head.js";

function ledgerWithSession(ids: string[]): Ledger {
  const ledger = Ledger.open(":memory:");
  for (const id of ids) ledger.startSession({ id, harnessCommit: "abc" });
  return ledger;
}

const entry = (id: string, text: string): InjectedMemory => ({
  id,
  scope: "project",
  file: "gotchas",
  text,
});

describe("T76 — memory eligibility", () => {
  it("records every eligible entry, not only the injected ones", () => {
    // A cap that fits the frame and exactly one entry.
    const head = assembleMemoryHead([entry("aaaaaaaa", "x".repeat(40)), entry("bbbbbbbb", "y".repeat(40))], 60);
    assert.equal(head.injected.length, 1);
    assert.equal(head.eligibility.length, 2);
    assert.deepEqual(
      head.eligibility.map((e) => [e.entryId, e.state, e.position]),
      [
        ["aaaaaaaa", "injected", 0],
        ["bbbbbbbb", "skipped_cap", 1],
      ],
    );
  });

  it("records eligibility even when the frame itself does not fit", () => {
    const head = assembleMemoryHead([entry("aaaaaaaa", "x")], 1);
    assert.equal(head.injected.length, 0);
    assert.equal(head.eligibility.length, 1);
    assert.equal(head.eligibility[0]?.state, "skipped_cap");
  });

  it("separates the unreachable half of dead weight from the genuinely dead half", () => {
    const ledger = ledgerWithSession(["s1", "s2"]);
    // b never fits in either session: unreachable, not useless.
    for (const s of ["s1", "s2"]) {
      ledger.recordMemoryEligibility(s, [
        { entryId: "aaaaaaaa", scope: "project", file: "gotchas", state: "injected", position: 0, tokens: 12 },
        { entryId: "bbbbbbbb", scope: "project", file: "gotchas", state: "skipped_cap", position: 1, tokens: 90 },
      ]);
    }
    const r = eligibilityReport(ledger);
    assert.equal(r.sessionsWithEligibility, 2);
    assert.equal(r.entries.length, 2);
    assert.equal(r.neverInjected.length, 1);
    assert.equal(r.neverInjected[0]?.entryId, "bbbbbbbb");
    assert.equal(r.unreachable.length, 1);
    assert.equal(r.reachedButUnused.length, 0);
    const text = formatEligibilityReport(r);
    assert.match(text, /unreachable/);
    assert.match(text, /not an eviction verdict/i);
    ledger.close();
  });

  it("is idempotent — a re-ingest of the same session does not double-count", () => {
    const ledger = ledgerWithSession(["s1"]);
    const rows = [
      { entryId: "aaaaaaaa", scope: "project", file: "gotchas", state: "injected", position: 0, tokens: 12 },
    ];
    ledger.recordMemoryEligibility("s1", rows);
    ledger.recordMemoryEligibility("s1", rows);
    const r = eligibilityReport(ledger);
    assert.equal(r.entries[0]?.eligibleSessions, 1);
    ledger.close();
  });

  it("reports nothing rather than something misleading when no session has measured this", () => {
    const ledger = ledgerWithSession([]);
    const r = eligibilityReport(ledger);
    assert.equal(r.entries.length, 0);
    assert.match(formatEligibilityReport(r), /nothing to report/);
    ledger.close();
  });

  it("refuses a state the schema does not define", () => {
    const ledger = ledgerWithSession(["s1"]);
    assert.throws(() =>
      ledger.recordMemoryEligibility("s1", [
        { entryId: "aaaaaaaa", scope: "project", file: "gotchas", state: "invented", position: 0, tokens: 1 },
      ]),
    );
    ledger.close();
  });
});

describe("T79 — widening memory_eligibility.state to admit 'stale'", () => {
  it("rebuilds a T76-era table without dropping a row, and then accepts 'stale'", () => {
    const ledger = Ledger.open(":memory:");
    ledger.startSession({ id: "s1", harnessCommit: "abc" });
    // Recreate the T76 constraint exactly, with a row in it.
    ledger.db.exec(`
      DROP TABLE memory_eligibility;
      CREATE TABLE memory_eligibility (
        session_id  TEXT NOT NULL REFERENCES sessions(id),
        entry_id    TEXT NOT NULL,
        scope       TEXT NOT NULL,
        file        TEXT NOT NULL,
        state       TEXT NOT NULL CHECK (state IN ('injected','skipped_cap')),
        position    INTEGER NOT NULL,
        tokens      INTEGER NOT NULL,
        PRIMARY KEY (session_id, entry_id)
      );
      INSERT INTO memory_eligibility VALUES ('s1','aaaaaaaa','project','gotchas','injected',0,12);
    `);
    assert.throws(() =>
      ledger.recordMemoryEligibility("s1", [
        { entryId: "bbbbbbbb", scope: "project", file: "gotchas", state: "stale", position: 1, tokens: 0 },
      ]),
    );

    migrateMemoryEligibility(ledger.db);

    // The pre-existing row survived the rebuild.
    const kept = ledger.db.prepare(`SELECT COUNT(*) AS n FROM memory_eligibility`).get() as { n: number };
    assert.equal(kept.n, 1);
    // And the third state is now accepted.
    ledger.recordMemoryEligibility("s1", [
      { entryId: "bbbbbbbb", scope: "project", file: "gotchas", state: "stale", position: 1, tokens: 0 },
    ]);
    const r = eligibilityReport(ledger);
    assert.equal(r.stale.length, 1);
    assert.equal(r.stale[0]?.entryId, "bbbbbbbb");
    // A stale entry is never counted as the "genuinely dead" half.
    assert.equal(r.reachedButUnused.length, 0);
    ledger.close();
  });
});
