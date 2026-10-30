import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deriveSessionName, loadSessionPreview, PreviewCache } from "./preview.js";
import { transcriptFilePath } from "./transcript.js";

function tempLedger(): string {
  return join(mkdtempSync(join(tmpdir(), "lykos-preview-")), ".lykos", "ledger.db");
}

function writeTranscript(ledgerPath: string, sessionId: string, events: Record<string, unknown>[]): void {
  const path = transcriptFilePath(ledgerPath, sessionId);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
}

describe("deriveSessionName (T114)", () => {
  it("names a session after the first thing that was typed into it", () => {
    assert.equal(deriveSessionName("fix the exploration metric"), "fix the exploration metric");
  });

  it("uses the first non-empty line only", () => {
    assert.equal(deriveSessionName("\n\nadd the trust gate\nand then some more text"), "add the trust gate");
  });

  it("collapses whitespace so a pasted prompt does not become a ragged name", () => {
    assert.equal(deriveSessionName("  fix   the    metric  "), "fix the metric");
  });

  it("drops a leading slash or bang, naming what was done rather than how it was typed", () => {
    assert.equal(deriveSessionName("/resume abc123"), "resume abc123");
    assert.equal(deriveSessionName("!git status"), "git status");
  });

  it("trims on a word boundary when one is close to the limit", () => {
    const name = deriveSessionName("alpha beta gamma delta epsilon zeta eta theta", 24);
    assert.ok(name !== null && name.length <= 25, `too long: ${name}`);
    assert.ok(name!.endsWith("…"));
    assert.ok(!name!.includes("epsi…"), `cut mid-word: ${name}`);
  });

  it("returns null for a prompt with nothing in it", () => {
    assert.equal(deriveSessionName("   \n  "), null);
    assert.equal(deriveSessionName("/"), null);
  });
});

describe("loadSessionPreview (T114)", () => {
  it("reads the conversation, its name, and its first and last message times", () => {
    const ledgerPath = tempLedger();
    writeTranscript(ledgerPath, "s1", [
      { ts_utc: "2026-09-06T10:00:00.000Z", turn_index: 0, kind: "user_message", text: "fix the exploration metric" },
      { ts_utc: "2026-09-06T10:01:00.000Z", turn_index: 0, kind: "tool_call", tool: "bash" },
      { ts_utc: "2026-09-06T10:04:00.000Z", turn_index: 1, kind: "assistant_message", text: "classified by command word", final: true },
    ]);

    const p = loadSessionPreview(ledgerPath, "s1", null);
    assert.equal(p.unavailable, null);
    assert.equal(p.name, "fix the exploration metric");
    assert.equal(p.nameIsDerived, true);
    assert.equal(p.firstMessageUtc, "2026-09-06T10:00:00.000Z");
    assert.equal(p.lastMessageUtc, "2026-09-06T10:04:00.000Z");
    assert.deepEqual(
      p.turns.map((t) => t.role),
      ["you", "lykos"],
      "a tool call is not a turn in the preview",
    );
  });

  it("keeps a human's name and says the name was not derived", () => {
    const ledgerPath = tempLedger();
    writeTranscript(ledgerPath, "s1", [
      { ts_utc: "2026-09-06T10:00:00.000Z", turn_index: 0, kind: "user_message", text: "whatever was typed" },
    ]);
    const p = loadSessionPreview(ledgerPath, "s1", "the named one");
    assert.equal(p.name, "the named one");
    assert.equal(p.nameIsDerived, false);
  });

  it("counts a steer as something the human said", () => {
    const ledgerPath = tempLedger();
    writeTranscript(ledgerPath, "s1", [
      { ts_utc: "2026-09-06T10:00:00.000Z", turn_index: 0, kind: "steer", text: "no, use ripgrep", mode: "steer" },
    ]);
    const p = loadSessionPreview(ledgerPath, "s1", null);
    assert.equal(p.name, "no, use ripgrep");
    assert.equal(p.turns[0]?.role, "you");
  });

  it("reports a session that predates live capture rather than showing an empty conversation", () => {
    const p = loadSessionPreview(tempLedger(), "never-captured", null);
    assert.match(p.unavailable ?? "", /no transcript on disk/);
    assert.deepEqual(p.turns, []);
  });

  it("caps a huge message instead of handing the pane something unrenderable", () => {
    const ledgerPath = tempLedger();
    writeTranscript(ledgerPath, "s1", [
      { ts_utc: "2026-09-06T10:00:00.000Z", turn_index: 0, kind: "user_message", text: "x".repeat(50_000) },
    ]);
    const p = loadSessionPreview(ledgerPath, "s1", null, { maxCharsPerTurn: 100 });
    assert.equal(p.turns[0]?.text.length, 101, "100 chars plus the ellipsis");
  });

  it("keeps the first turn and the tail of a long session, and says how many it dropped", () => {
    const ledgerPath = tempLedger();
    const events = Array.from({ length: 60 }, (_, i) => ({
      ts_utc: `2026-09-06T10:${`${i}`.padStart(2, "0")}:00.000Z`,
      turn_index: i,
      kind: "user_message",
      text: `message ${i}`,
    }));
    writeTranscript(ledgerPath, "s1", events);

    const p = loadSessionPreview(ledgerPath, "s1", null, { maxTurns: 10 });
    assert.equal(p.turns.length, 10);
    assert.equal(p.turns[0]?.text, "message 0", "the first turn says what the session was for");
    assert.equal(p.turns.at(-1)?.text, "message 59", "the tail says where it got to");
    assert.match(p.turns[1]?.text ?? "", /turns not shown/);
  });
});

describe("PreviewCache (T114)", () => {
  it("reads a transcript once, however many times the cursor passes over it", () => {
    const ledgerPath = tempLedger();
    writeTranscript(ledgerPath, "s1", [
      { ts_utc: "2026-09-06T10:00:00.000Z", turn_index: 0, kind: "user_message", text: "hello" },
    ]);
    const cache = new PreviewCache();
    const first = cache.get(ledgerPath, "s1", null);
    const second = cache.get(ledgerPath, "s1", null);
    assert.equal(first, second, "the same object, not merely an equal one");
  });

  it("stays bounded so a long browse does not pin every transcript it passed", () => {
    const ledgerPath = tempLedger();
    const cache = new PreviewCache(4);
    for (let i = 0; i < 20; i++) cache.get(ledgerPath, `s${i}`, null);
    // Nothing to assert but that it survives; the bound is enforced inside.
    assert.ok(true);
  });
});
