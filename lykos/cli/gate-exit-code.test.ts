// The gate records the exit code its verification command returned beside the
// outcome it derived, and `lykos show` prints both.
//
// Proven through the scripted-model session (T142): a scripted model edits a
// file so the gate runs, and the test reads only the ledger and `lykos show`.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openLedgerSync } from "../ledger/use.js";
import { call, reply, runScriptedSession, say } from "./scripted-session.js";

/** One edit, so the gate grades the session, then the end of the turn. */
function editThenStop(config: string | undefined) {
  return runScriptedSession({
    files: { "notes.txt": "draft\n" },
    ...(config !== undefined ? { config } : {}),
    script: [reply(call("write", { path: "notes.txt", content: "final\n" })), reply(say("done"))],
  });
}

const gateConfig = (command: string): string => `gate:\n  command: ${JSON.stringify(command)}\n`;

describe("the gate's exit code (T144)", () => {
  it("a passing verification stores exit code 0 beside outcome=success, and `lykos show` prints both", async () => {
    const run = await editThenStop(gateConfig(`node -e "console.log('all green'); process.exit(0)"`));
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));

    const row = run.session();
    assert.equal(row.outcome, "success");
    assert.equal(row.outcome_source, "verification_command");
    assert.equal(row.verification_exit_code, 0);

    const shown = run.show();
    assert.match(shown, /gate\s+`node -e "console\.log\('all green'\); process\.exit\(0\)"`/);
    assert.match(shown, /verdict\s+success \(source=verification_command\)/);
    assert.match(shown, /exit code\s+0\n/);
    assert.match(shown, /\| all green/);
  });

  it("a failing verification stores its non-zero exit code beside outcome=fail, with a bounded excerpt", async () => {
    // Far more output than `lykos show` prints: the excerpt must be bounded.
    const run = await editThenStop(
      gateConfig(`node -e "console.log('first line'); console.log('x'.repeat(6000)); console.log('last line'); process.exit(3)"`),
    );
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));

    const row = run.session();
    assert.equal(row.outcome, "fail");
    assert.equal(row.verification_exit_code, 3);

    const shown = run.show();
    assert.match(shown, /verdict\s+fail \(source=verification_command\)/);
    assert.match(shown, /exit code\s+3\n/);
    assert.match(shown, /\| first line/);
    assert.match(shown, /\| last line/);
    assert.match(shown, /bytes elided/);
    const excerpt = shown.split("\n").filter((l) => l.startsWith("    | ")).join("\n");
    assert.ok(excerpt.length < 1500, `excerpt is bounded, got ${excerpt.length} characters`);
  });

  it("a session no command verified shows no exit code, never zero", async () => {
    // No `test` script and no configured command: the gate has nothing to run.
    const run = await editThenStop(undefined);
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));

    const row = run.session();
    assert.equal(row.outcome, null);
    assert.equal(row.verification_exit_code, null);

    const shown = run.show();
    assert.match(shown, /gate\s+did not run/);
    assert.match(shown, /exit code\s+\(none\)/);
    assert.doesNotMatch(shown, /exit code\s+0/);
  });

  it("the ledger refuses an outcome that disagrees with its exit code", () => {
    const ledgerPath = join(mkdtempSync(join(tmpdir(), "lykos-t144-")), "ledger.db");
    const ledger = openLedgerSync(ledgerPath);
    try {
      ledger.startSession({ id: "s1", brief: "t144" });
      for (const [outcome, code] of [
        ["success", 1],
        ["fail", 0],
      ] as const) {
        assert.throws(
          () => ledger.recordOutcome({ id: "s1", outcome, outcomeSource: "verification_command", verificationExitCode: code }),
          /refuses exit code/,
        );
      }
      assert.throws(
        () => ledger.recordOutcome({ id: "s1", outcome: "success", outcomeSource: "human", verificationExitCode: 0 }),
        /refuses exit code/,
      );
      const row = ledger.db.prepare(`SELECT outcome, verification_exit_code FROM sessions WHERE id = 's1'`).get();
      assert.deepEqual({ ...(row as object) }, { outcome: null, verification_exit_code: null });
    } finally {
      ledger.close();
    }
  });

  it("an older ledger without the column gains it when next opened, and its rows stay NULL", () => {
    const ledgerPath = join(mkdtempSync(join(tmpdir(), "lykos-t144-")), "ledger.db");
    const first = openLedgerSync(ledgerPath);
    first.startSession({ id: "old", brief: "before T144" });
    // Make it the older ledger: the column did not exist when this row was written.
    first.db.exec(`ALTER TABLE sessions DROP COLUMN verification_exit_code`);
    const hasColumn = (l: typeof first): boolean =>
      (l.db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).some(
        (c) => c.name === "verification_exit_code",
      );
    assert.equal(hasColumn(first), false);
    first.close();

    const reopened = openLedgerSync(ledgerPath);
    try {
      assert.equal(hasColumn(reopened), true);
      const row = reopened.db.prepare(`SELECT verification_exit_code FROM sessions WHERE id = 'old'`).get() as {
        verification_exit_code: number | null;
      };
      assert.equal(row.verification_exit_code, null, "nothing is backfilled");
    } finally {
      reopened.close();
    }
  });
});
