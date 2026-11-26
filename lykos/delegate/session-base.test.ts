import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openLedgerSync } from "../ledger/use.js";
import { recordSessionBase, sessionModelPath } from "./session-base.js";

test("a session that switched models resumes on the model it ended on, never on the switch history", () => {
  const dir = mkdtempSync(join(tmpdir(), "lykos-base-"));
  const ledger = openLedgerSync(join(dir, "ledger.db"));
  try {
    const id = ledger.startSession({ brief: "x" });
    // `sessions.model_path` records the switches, `from>to`, as the session made them.
    ledger.db.prepare("UPDATE sessions SET model_path = ? WHERE id = ?").run("deepseek/deepseek-v4-flash>google-antigravity/gemini-3.8-flash", id);
    assert.equal(sessionModelPath(ledger, id), "google-antigravity/gemini-3.8-flash");
    // The model a delegated session was asked for wins, as before.
    recordSessionBase(ledger, id, "abc", "deepseek/deepseek-v4-pro");
    assert.equal(sessionModelPath(ledger, id), "deepseek/deepseek-v4-pro");
  } finally {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
