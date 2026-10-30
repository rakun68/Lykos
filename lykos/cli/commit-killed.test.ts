// Every commit a session makes is recorded, including the commits of a session
// that dies. A session's `sessions` row is written by ingest at its end, so a
// killed session has none; the `commits` row is written when the commit is made
// and does not depend on one.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { openLedgerSync } from "../ledger/use.js";

describe("commit in a session that dies (T179)", () => {
  it("a session killed right after `commit` still has its commit in the ledger", () => {
    const child = spawnSync(process.execPath, ["--import", "tsx", resolve("lykos", "cli", "commit-killed.fixture.ts")], {
      encoding: "utf8",
      timeout: 170_000,
      windowsHide: true,
    });
    const workspace = /^WS=(.+)$/m.exec(child.stdout ?? "")?.[1]?.trim();
    assert.ok(workspace, `the child reported no workspace: ${child.stderr}`);
    assert.notEqual(child.status, 0, "control: the child did die (it did not finish normally)");

    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8", windowsHide: true }).trim();
    assert.equal(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: workspace, encoding: "utf8", windowsHide: true }).trim(), "Made before the kill");

    const ledger = openLedgerSync(join(workspace, ".lykos", "ledger.db"));
    try {
      const rows = ledger.db.prepare("SELECT session_id, sha, subject, scope FROM commits").all() as Array<Record<string, unknown>>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.sha, head);
      assert.equal(rows[0]!.subject, "Made before the kill");
      assert.equal(ledger.commits(rows[0]!.session_id as string).length, 1, "and it is listed against the session");
      // Why the row cannot lean on `sessions`: the killed session never got one.
      assert.equal((ledger.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(rows[0]!.session_id) as { n: number }).n, 0);
    } finally {
      ledger.close();
    }
  });
});
