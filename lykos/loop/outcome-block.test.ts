// T52.1's end-to-end flow: the session-end block, driven against a real
// on-disk ledger and a scripted `LineSource`, with no terminal and no agent.
//
// Kept out of `interactive.test.ts` because that file is about the turn/steer/
// abort state machine — this is about one question asked after it stops.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Ledger } from "../ledger/ledger.js";
import { askSessionOutcome, suggestedVerificationCommand, type LineSource } from "../session/interactive.js";

let dir: string;
let ledgerPath: string;

/** A `LineSource` that hands out a fixed script and then EOF. */
function scripted(lines: string[]): LineSource & { consumed: number } {
  let i = 0;
  const source = {
    next: async () => (i < lines.length ? lines[i++]! : null),
    close: () => undefined,
    get consumed() {
      return i;
    },
  };
  return source as LineSource & { consumed: number };
}

function seedEndedSession(): string {
  const ledger = Ledger.open(ledgerPath);
  try {
    const id = ledger.startSession({ brief: "a real task", harnessCommit: "test", executionShape: "standalone" });
    ledger.endSession({ id });
    return id;
  } finally {
    ledger.close();
  }
}

function outcomeOf(id: string): { outcome: string | null; source: string | null; cmd: string | null } {
  const ledger = Ledger.open(ledgerPath);
  try {
    const row = ledger.db
      .prepare(`SELECT outcome, outcome_source, verification_cmd FROM sessions WHERE id = ?`)
      .get(id) as { outcome: string | null; outcome_source: string | null; verification_cmd: string | null };
    return { outcome: row.outcome, source: row.outcome_source, cmd: row.verification_cmd };
  } finally {
    ledger.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lykos-outcome-"));
  ledgerPath = join(dir, "ledger.db");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("T52.1: the session-end block", () => {
  it("ACCEPTANCE: 'c' runs the suggested command and records success from its exit code", async () => {
    const id = seedEndedSession();
    const written: string[] = [];
    await askSessionOutcome({
      sessionId: id,
      workspace: dir,
      ledgerPath,
      lineSource: scripted(["c"]),
      write: (t) => void written.push(t),
      suggestedCmd: 'node -e "process.exit(0)"',
    });
    assert.deepEqual(outcomeOf(id), {
      outcome: "success",
      source: "verification_command",
      cmd: 'node -e "process.exit(0)"',
    });
    assert.ok(written.some((t) => /outcome=success/.test(t)), "the result is reported on screen");
  });

  it("ACCEPTANCE: a failing suggested command records fail, and says so", async () => {
    const id = seedEndedSession();
    const written: string[] = [];
    await askSessionOutcome({
      sessionId: id,
      workspace: dir,
      ledgerPath,
      lineSource: scripted(["c"]),
      write: (t) => void written.push(t),
      suggestedCmd: 'node -e "process.exit(1)"',
    });
    assert.equal(outcomeOf(id).outcome, "fail");
    assert.ok(written.some((t) => /outcome=fail/.test(t)));
  });

  it("ACCEPTANCE: skipping records NULL", async () => {
    const id = seedEndedSession();
    await askSessionOutcome({
      sessionId: id,
      workspace: dir,
      ledgerPath,
      lineSource: scripted(["s"]),
      write: () => {},
      suggestedCmd: "npm test",
    });
    assert.deepEqual(outcomeOf(id), { outcome: null, source: null, cmd: null });
  });

  it("EOF records NULL — a piped session is never asked and never guessed at", async () => {
    const id = seedEndedSession();
    await askSessionOutcome({
      sessionId: id,
      workspace: dir,
      ledgerPath,
      lineSource: scripted([]),
      write: () => {},
      suggestedCmd: "npm test",
    });
    assert.equal(outcomeOf(id).outcome, null);
  });

  it("a plain yes records human, with no command", async () => {
    const id = seedEndedSession();
    await askSessionOutcome({
      sessionId: id,
      workspace: dir,
      ledgerPath,
      lineSource: scripted(["y"]),
      write: () => {},
      suggestedCmd: "npm test",
    });
    assert.deepEqual(outcomeOf(id), { outcome: "success", source: "human", cmd: null });
  });

  it("re-asks up to twice on an unparseable answer, then treats it as a skip", async () => {
    const id = seedEndedSession();
    const written: string[] = [];
    const source = scripted(["what", "huh", "nope"]);
    await askSessionOutcome({
      sessionId: id,
      workspace: dir,
      ledgerPath,
      lineSource: source,
      write: (t) => void written.push(t),
      suggestedCmd: "npm test",
    });
    assert.equal(source.consumed, 3, "three reads: the first answer plus two retries");
    assert.equal(written.filter((t) => /answer c, y, n, or s/.test(t)).length, 2, "and no more than two nags");
    assert.equal(outcomeOf(id).outcome, null, "an exhausted retry budget is a skip, not a guess");
  });

  it("a retried answer still lands — the retries are not a dead end", async () => {
    const id = seedEndedSession();
    await askSessionOutcome({
      sessionId: id,
      workspace: dir,
      ledgerPath,
      lineSource: scripted(["", "y"]),
      write: () => {},
      suggestedCmd: "npm test",
    });
    assert.equal(outcomeOf(id).outcome, "success");
  });

  it("reports the error rather than throwing when the outcome is already recorded", async () => {
    const ledger = Ledger.open(ledgerPath);
    const id = ledger.startSession({ brief: "aborted work", harnessCommit: "test" });
    ledger.endSession({ id, outcome: "abandoned" });
    ledger.close();

    const written: string[] = [];
    await askSessionOutcome({
      sessionId: id,
      workspace: dir,
      ledgerPath,
      lineSource: scripted(["y"]),
      write: (t) => void written.push(t),
      suggestedCmd: "npm test",
    });
    assert.ok(written.some((t) => /could not record the outcome/.test(t)));
    assert.equal(outcomeOf(id).outcome, "abandoned");
  });
});

describe("T52.1: the suggested command is derived from the project, not configured", () => {
  it("offers npm test when package.json declares a test script", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }), "utf8");
    assert.equal(suggestedVerificationCommand(dir), "npm test");
  });

  it("offers nothing when there is no test script, and nothing when there is no package.json", () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }), "utf8");
    assert.equal(suggestedVerificationCommand(dir), undefined);
    rmSync(join(dir, "package.json"));
    assert.equal(suggestedVerificationCommand(dir), undefined);
  });

  it("survives a malformed package.json rather than failing the session end", () => {
    writeFileSync(join(dir, "package.json"), "{ not json", "utf8");
    assert.equal(suggestedVerificationCommand(dir), undefined);
  });
});
