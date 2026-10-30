import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { withLedgerSync, recordSealEvent } from "./use.js";

function tmpLedger(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-seal-events-test-"));
  return join(dir, "ledger.db");
}

describe("seal_events ledger (T195)", () => {
  it("records a created seal event from CLI with null session_id", async () => {
    const path = tmpLedger();
    await recordSealEvent(path, {
      branch: "feat-a",
      kind: "created",
      paths: ["src/a.test.ts", "src/b.test.ts"],
      specialist: "build",
      detail: { tests: 2 },
    });

    withLedgerSync(path, (ledger) => {
      const rows = ledger.sealEvents("feat-a");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.branch, "feat-a");
      assert.equal(rows[0]!.kind, "created");
      assert.equal(rows[0]!.creator, "cli");
      assert.equal(rows[0]!.session_id, null);
      assert.equal(rows[0]!.specialist, "build");
      assert.deepEqual(JSON.parse(rows[0]!.paths), ["src/a.test.ts", "src/b.test.ts"]);
      assert.deepEqual(JSON.parse(rows[0]!.detail!), { tests: 2 });
    });
  });

  it("records a seal event with explicit session_id and creator", async () => {
    const path = tmpLedger();
    await recordSealEvent(path, {
      sessionId: "sess-123",
      creator: "sess-123",
      branch: "feat-b",
      kind: "created",
      paths: ["test/c.test.ts"],
    });

    withLedgerSync(path, (ledger) => {
      const rows = ledger.sealEvents();
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.creator, "sess-123");
      assert.equal(rows[0]!.session_id, "sess-123");
      assert.equal(rows[0]!.branch, "feat-b");
    });
  });
});
