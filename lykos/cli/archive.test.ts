// `lykos archive`.
//
// The acceptance, stated in the task and asserted here: a directory with
// mixed states converges in one run and does not change on a second;
// `lykos show` reads an archived session identically to a recent one; and
// `lykos doctor` reports the same integrity verdict before and after.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { archiveSessions } from "./archive.js";
import { Ledger } from "../ledger/ledger.js";
import { writeLiveSnapshot, liveSnapshotPath } from "../ledger/live.js";
import {
  TranscriptWriter,
  readTranscript,
  transcriptFilePath,
  transcriptGzFilePath,
  verifyTranscriptHash,
} from "../session/transcript.js";

const NOW = new Date("2026-09-03T00:00:00.000Z");
const LONG_AGO = "2026-06-01T00:00:00.000Z";
const RECENTLY = "2026-09-02T00:00:00.000Z";

function realLedger(): { ledger: Ledger; ledgerPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "lykos-t55-"));
  const ledgerPath = join(dir, "ledger.db");
  return { ledger: Ledger.open(ledgerPath), ledgerPath };
}

/** A session with a real transcript on disk and a ledger row that ended when we say it did. */
function seedSession(
  ledger: Ledger,
  ledgerPath: string,
  id: string,
  endedUtc: string | null,
  lines = 3,
): { sha256: string } {
  const writer = new TranscriptWriter(ledgerPath, id);
  for (let i = 0; i < lines; i++) {
    writer.append({ kind: "user_message", text: `line ${i} of session ${id}` });
  }
  const { sha256, path, bytes } = writer.finalize();
  ledger.startSession({ id, brief: id, startedUtc: "2026-05-01T00:00:00.000Z" });
  if (endedUtc) {
    ledger.endSession({ id, endedUtc, transcriptPath: path, transcriptSha256: sha256, transcriptBytes: bytes });
  } else {
    // A session that never ended: the process died. Set the pointer directly
    // rather than calling endSession, which is what would have written it.
    ledger.db
      .prepare(`UPDATE sessions SET transcript_path = ?, transcript_sha256 = ? WHERE id = ?`)
      .run(path, sha256, id);
  }
  return { sha256 };
}

function archiveStateOf(ledger: Ledger, id: string): string | null {
  return (ledger.db.prepare(`SELECT archive_state FROM sessions WHERE id = ?`).get(id) as {
    archive_state: string | null;
  }).archive_state;
}

describe("T55 lykos archive", () => {
  it("gives archive_state its first writers: live at insert, recent at session end", () => {
    const { ledger, ledgerPath } = realLedger();
    seedSession(ledger, ledgerPath, "still-running", null);
    assert.equal(archiveStateOf(ledger, "still-running"), "live");
    seedSession(ledger, ledgerPath, "finished", RECENTLY);
    assert.equal(archiveStateOf(ledger, "finished"), "recent");
    ledger.close();
  });

  it("compresses only what is past the retention hint, and preserves the hash of the uncompressed bytes", () => {
    const { ledger, ledgerPath } = realLedger();
    const old = seedSession(ledger, ledgerPath, "old-session", LONG_AGO);
    seedSession(ledger, ledgerPath, "new-session", RECENTLY);

    const result = archiveSessions(ledger, { now: NOW, days: 30 });
    assert.deepEqual(result.compressed, ["old-session"]);
    assert.ok(!existsSync(transcriptFilePath(ledgerPath, "old-session")));
    assert.ok(existsSync(transcriptGzFilePath(ledgerPath, "old-session")));
    assert.ok(existsSync(transcriptFilePath(ledgerPath, "new-session")));
    assert.equal(archiveStateOf(ledger, "old-session"), "archived");
    assert.equal(archiveStateOf(ledger, "new-session"), "recent");

    // The recorded hash still verifies, against the same value it always
    // had. Archiving must never turn an intact transcript into a fault.
    const row = ledger.db
      .prepare(`SELECT transcript_path, transcript_sha256 FROM sessions WHERE id = ?`)
      .get("old-session") as { transcript_path: string; transcript_sha256: string };
    assert.equal(row.transcript_sha256, old.sha256);
    assert.equal(verifyTranscriptHash(row.transcript_path, row.transcript_sha256), true);

    // And it still reads, identically.
    const { events } = readTranscript(row.transcript_path);
    assert.equal(events.length, 3);
    assert.equal(events[0]!.kind, "user_message");
    ledger.close();
  });

  it("is idempotent — a second run changes nothing", () => {
    const { ledger, ledgerPath } = realLedger();
    seedSession(ledger, ledgerPath, "a", LONG_AGO);
    seedSession(ledger, ledgerPath, "b", RECENTLY);
    archiveSessions(ledger, { now: NOW, days: 30 });
    const gzBefore = readFileSync(transcriptGzFilePath(ledgerPath, "a"));

    const second = archiveSessions(ledger, { now: NOW, days: 30 });
    assert.deepEqual(second.compressed, []);
    assert.deepEqual(second.resumedHalfCompressed, []);
    assert.deepEqual(readFileSync(transcriptGzFilePath(ledgerPath, "a")), gzBefore);
    assert.equal(archiveStateOf(ledger, "a"), "archived");
    ledger.close();
  });

  it("finishes a directory a crashed run left half-compressed", () => {
    const { ledger, ledgerPath } = realLedger();
    seedSession(ledger, ledgerPath, "half", LONG_AGO);
    // Exactly the state a kill between "write the .gz" and "remove the raw"
    // leaves behind.
    const raw = transcriptFilePath(ledgerPath, "half");
    writeFileSync(transcriptGzFilePath(ledgerPath, "half"), gzipSync(readFileSync(raw)));

    const result = archiveSessions(ledger, { now: NOW, days: 30 });
    assert.deepEqual(result.resumedHalfCompressed, ["half"]);
    assert.ok(!existsSync(raw));
    assert.equal(archiveStateOf(ledger, "half"), "archived");
    ledger.close();
  });

  it("refuses to rewrite a transcript that no longer matches its recorded hash", () => {
    const { ledger, ledgerPath } = realLedger();
    seedSession(ledger, ledgerPath, "damaged", LONG_AGO);
    const raw = transcriptFilePath(ledgerPath, "damaged");
    writeFileSync(raw, `${readFileSync(raw, "utf8")}{"kind":"tampered"}\n`, "utf8");

    const result = archiveSessions(ledger, { now: NOW, days: 30 });
    assert.deepEqual(result.compressed, []);
    assert.equal(result.refused.length, 1);
    assert.equal(result.refused[0]!.sessionId, "damaged");
    // Left exactly as found: compressing it would bury the evidence under a
    // new file format, and this command never deletes anything.
    assert.ok(existsSync(raw));
    assert.ok(!existsSync(transcriptGzFilePath(ledgerPath, "damaged")));
    ledger.close();
  });

  it("reaps a stale live.json — the file removeLiveSnapshot() had no caller for", () => {
    const { ledger, ledgerPath } = realLedger();
    seedSession(ledger, ledgerPath, "ended", RECENTLY);
    seedSession(ledger, ledgerPath, "crashed", null);
    seedSession(ledger, ledgerPath, "running", null);

    const live = (id: string, heartbeatUtc: string) => {
      writeLiveSnapshot(ledgerPath, {
        schemaVersion: 1,
        sessionId: id,
        taskId: null,
        brief: id,
        startedUtc: "2026-05-01T00:00:00.000Z",
        heartbeatUtc,
        endedUtc: null,
        outcome: null,
        outcomeSource: null,
        totals: { costUsd: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 },
        lastCall: null,
      });
    };
    live("ended", NOW.toISOString());
    live("crashed", "2026-09-01T00:00:00.000Z");
    live("running", NOW.toISOString());

    const result = archiveSessions(ledger, { now: NOW, days: 30 });
    assert.deepEqual(result.liveFilesReaped.sort(), ["crashed", "ended"]);
    // A session the ledger says ended is not live however fresh its
    // heartbeat; a session with an old heartbeat is not live however
    // incomplete its row. Liveness is the heartbeat, not a lock (`08` §4).
    assert.ok(!existsSync(liveSnapshotPath(ledgerPath, "ended")));
    assert.ok(!existsSync(liveSnapshotPath(ledgerPath, "crashed")));
    assert.ok(existsSync(liveSnapshotPath(ledgerPath, "running")));
    assert.equal(archiveStateOf(ledger, "crashed"), "recent");
    assert.equal(archiveStateOf(ledger, "running"), "live");
    ledger.close();
  });

  it("leaves a session directory with no ledger row alone, and says so", () => {
    const { ledger, ledgerPath } = realLedger();
    seedSession(ledger, ledgerPath, "known", LONG_AGO);
    // T53 made crashed runs leave a directory behind before any row exists.
    const orphan = join(ledgerPath, "..", "sessions", "orphan");
    mkdirSync(orphan, { recursive: true });
    writeFileSync(join(orphan, "transcript.jsonl"), '{"kind":"user_message","text":"hi"}\n', "utf8");

    const result = archiveSessions(ledger, { now: NOW, days: 30 });
    assert.deepEqual(result.orphans, ["orphan"]);
    assert.ok(existsSync(join(orphan, "transcript.jsonl")));
    ledger.close();
  });

  it("--dry-run reports the same set and changes nothing on disk", () => {
    const { ledger, ledgerPath } = realLedger();
    seedSession(ledger, ledgerPath, "dry", LONG_AGO);
    const dry = archiveSessions(ledger, { now: NOW, days: 30, dryRun: true });
    assert.deepEqual(dry.compressed, ["dry"]);
    assert.ok(existsSync(transcriptFilePath(ledgerPath, "dry")));
    assert.ok(!existsSync(transcriptGzFilePath(ledgerPath, "dry")));
    assert.equal(archiveStateOf(ledger, "dry"), "recent");

    const wet = archiveSessions(ledger, { now: NOW, days: 30 });
    assert.deepEqual(wet.compressed, dry.compressed);
    ledger.close();
  });
});
