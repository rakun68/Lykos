// `lykos archive` — T55 (docs/19-phase4-tasks.md), D4.1,
// docs/08-sessions-and-archive.md §3.
//
// **Compression and nothing else.** Past the retention hint (default 30
// days) a finished session's `transcript.jsonl` becomes
// `transcript.jsonl.gz`. There is no summarisation, no pruning, no "keep the
// last N", no purge, and ledger rows are never touched beyond the one column
// this command owns. That is not a simplification of a richer design — it is
// the design: `08` §3's three states have no fourth, and "nothing Lykos ever
// runs is deleted" is an absolute rule precisely because compression makes it
// affordable.
//
// This is the only thing in the product that ever rewrites a transcript file,
// which is why three properties are non-negotiable and are tested as such:
//
//  1. **The hash is preserved, never recomputed.** `transcript_sha256` is the
//     hash of the UNCOMPRESSED bytes and stays that. Every reader
//     (`lykos show`, `doctor`, and everything Phase 4 adds after this) goes
//     through `readTranscriptBytes()`, which decompresses first — so
//     archiving can never turn an intact transcript into a reported fault.
//  2. **It is idempotent.** A second run is a no-op, and a directory left
//     half-compressed by a crash mid-run converges on the next run instead of
//     staying broken.
//  3. **The raw file is removed only after the gzip has been written AND
//     verified against the recorded hash.** A compression step that lost a
//     transcript would violate the one rule this whole subsystem exists for.
//
// Two other jobs ride along, because they are the same walk of the same
// directory:
//
//  - **`archive_state` moves `recent` -> `archived`.** The column has existed
//    since T8; T55 gave it its first two writers in `ledger.ts` (`live` at
//    insert, `recent` at session end) and this is the third.
//  - **Stale `live.json` files are reaped.** `Ledger` writes a live snapshot
//    per session and `removeLiveSnapshot()` had no caller anywhere in the
//    product, so every session that ever ran left one behind claiming to be
//    live. Liveness is the heartbeat timestamp (`08` §4: "a stale file with
//    an old heartbeat is obviously stale, whereas a stale lock is a support
//    problem"), so a session whose ledger row has an `ended_utc`, or whose
//    heartbeat is older than the staleness window, loses its live file.
//
// What it deliberately does not do: touch a session directory that has no
// ledger row. Those are the crashed runs T53 made recoverable, they have no
// `ended_utc` to age them against, and `archive_state` has nowhere to be
// written. They are counted and reported rather than guessed at.

import { existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";

import { openLedgerSync, type Ledger } from "../ledger/use.js";

import { readLiveSnapshot, removeLiveSnapshot, sessionsDir } from "../ledger/live.js";
import { readTranscriptBytes, transcriptFilePath, transcriptGzFilePath } from "../session/transcript.js";
import { createHash } from "node:crypto";
import { stdoutWrite } from "../tui/io-mode.js";

/** `08` §3's retention hint. A hint, not a deadline: nothing expires, it only gets smaller. */
export const DEFAULT_RETENTION_DAYS = 30;

/**
 * How old a heartbeat has to be before a `live.json` is treated as stale on
 * its own, for a session whose ledger row never got an `ended_utc` (the
 * process died). Generous on purpose — the cost of reaping a live session's
 * cache file early is a HUD that reads zero until the next heartbeat, and the
 * cost of leaving a dead one is a supervisor that believes a session is
 * running forever.
 */
export const LIVE_HEARTBEAT_STALE_MS = 60 * 60 * 1000;

export interface ArchiveOptions {
  /** Sessions that ended more than this many days ago are compressed. Default 30. */
  days?: number;
  /** Report what would change and change nothing. */
  dryRun?: boolean;
  json?: boolean;
  /** Injectable clock, so the tests do not have to wait 30 days. */
  now?: Date;
}

export interface ArchiveResult {
  scanned: number;
  compressed: string[];
  /** Directories where a previous run left both forms behind; finished this run. */
  resumedHalfCompressed: string[];
  liveFilesReaped: string[];
  /** Session directories with no ledger row — crashed runs. Counted, never touched. */
  orphans: string[];
  /** Compression refused because the bytes did not round-trip to the recorded hash. */
  refused: Array<{ sessionId: string; reason: string }>;
  bytesBefore: number;
  bytesAfter: number;
}

interface SessionRow {
  id: string;
  ended_utc: string | null;
  archive_state: string | null;
  transcript_sha256: string | null;
}

function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * The whole command as a pure-ish function over a ledger and its sessions
 * directory, so the acceptance ("a directory with mixed states converges in
 * one run and does not change on a second") is a test rather than a manual
 * exercise.
 */
export function archiveSessions(ledger: Ledger, opts?: ArchiveOptions): ArchiveResult {
  const now = opts?.now ?? new Date();
  const days = opts?.days ?? DEFAULT_RETENTION_DAYS;
  const dryRun = opts?.dryRun === true;
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const dir = sessionsDir(ledger.path);
  const result: ArchiveResult = {
    scanned: 0,
    compressed: [],
    resumedHalfCompressed: [],
    liveFilesReaped: [],
    orphans: [],
    refused: [],
    bytesBefore: 0,
    bytesAfter: 0,
  };
  if (!existsSync(dir)) return result;

  const rows = new Map<string, SessionRow>();
  for (const row of ledger.db
    .prepare(`SELECT id, ended_utc, archive_state, transcript_sha256 FROM sessions`)
    .all() as SessionRow[]) {
    rows.set(row.id, row);
  }

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    result.scanned += 1;
    const sessionId = entry.name;
    const row = rows.get(sessionId);
    if (!row) {
      result.orphans.push(sessionId);
      continue;
    }

    reapLiveFile(ledger, sessionId, row, now, dryRun, result);

    const raw = transcriptFilePath(ledger.path, sessionId);
    const gz = transcriptGzFilePath(ledger.path, sessionId);
    const hasRaw = existsSync(raw);
    const hasGz = existsSync(gz);

    // Already done. Idempotence is not an optimisation here — a second run
    // that recompressed would rewrite bytes for no reason, and this command
    // is the only writer that ever touches a finished transcript.
    if (!hasRaw && hasGz) {
      if (!dryRun && row.archive_state !== "archived") markArchived(ledger, sessionId);
      continue;
    }
    if (!hasRaw) continue;

    // A crash between "write the .gz" and "remove the .jsonl" leaves both.
    // Finish the job rather than starting over: the gz already on disk is
    // checked against the raw file's bytes before the raw one goes.
    if (hasGz) {
      const ok = readTranscriptBytes(gz).equals(readFileSync(raw));
      if (!ok) {
        result.refused.push({
          sessionId,
          reason: "a half-finished archive left a .gz that does not match the raw transcript; left both in place",
        });
        continue;
      }
      result.resumedHalfCompressed.push(sessionId);
      if (!dryRun) {
        unlinkSync(raw);
        markArchived(ledger, sessionId);
      }
      continue;
    }

    // Only a FINISHED session ages. A session with no `ended_utc` either is
    // still running or died — neither is something to compress behind its
    // back.
    if (!row.ended_utc) continue;
    if (Date.parse(row.ended_utc) > cutoff) continue;

    const bytes = readFileSync(raw);
    // The recorded hash is of these exact bytes and must keep verifying
    // afterwards. If it does not verify NOW, the file is already damaged and
    // compressing it would bury the evidence under a new file format.
    if (row.transcript_sha256 && sha256(bytes) !== row.transcript_sha256) {
      result.refused.push({
        sessionId,
        reason: "transcript no longer matches its recorded hash — refusing to rewrite a damaged file (see `lykos doctor`)",
      });
      continue;
    }
    const packed = gzipSync(bytes, { level: 9 });
    result.bytesBefore += bytes.length;
    result.bytesAfter += packed.length;
    result.compressed.push(sessionId);
    if (dryRun) continue;

    // Write, verify the round trip, and only then remove the original.
    // Verified by gunzipping explicitly rather than through
    // readTranscriptBytes(), which keys off the .gz suffix the temp file
    // deliberately does not have yet.
    const tmp = `${gz}.tmp`;
    writeFileSync(tmp, packed);
    if (!gunzipSync(readFileSync(tmp)).equals(bytes)) {
      unlinkSync(tmp);
      result.refused.push({ sessionId, reason: "gzip did not round-trip; original left untouched" });
      result.compressed.pop();
      continue;
    }
    renameSync(tmp, gz);
    unlinkSync(raw);
    markArchived(ledger, sessionId);
  }

  return result;
}

/**
 * `live.json` is a cache, and a cache that outlives its session is a lie
 * about what is running. Removed when the ledger says the session ended, or
 * when the heartbeat inside the file is old enough that nothing could still
 * be writing it.
 */
function reapLiveFile(
  ledger: Ledger,
  sessionId: string,
  row: SessionRow,
  now: Date,
  dryRun: boolean,
  result: ArchiveResult,
): void {
  const live = readLiveSnapshot(ledger.path, sessionId);
  if (!live) return;
  const heartbeat = Date.parse(live.heartbeatUtc);
  const stale =
    row.ended_utc !== null ||
    (Number.isFinite(heartbeat) && now.getTime() - heartbeat > LIVE_HEARTBEAT_STALE_MS);
  if (!stale) return;
  result.liveFilesReaped.push(sessionId);
  if (dryRun) return;
  removeLiveSnapshot(ledger.path, sessionId);
  // A row that never reached endSession() (the process died) is still `live`
  // in the ledger. Its session is demonstrably not running, so it becomes
  // `recent` — the state `08` §3 gives a finished-but-uncompressed session.
  // Nothing about the run's numbers is touched: this is the archive state,
  // not an outcome.
  if (row.archive_state !== "archived" && row.archive_state !== "recent") {
    ledger.db.prepare(`UPDATE sessions SET archive_state = 'recent' WHERE id = ?`).run(sessionId);
  }
}

function markArchived(ledger: Ledger, sessionId: string): void {
  ledger.db.prepare(`UPDATE sessions SET archive_state = 'archived' WHERE id = ?`).run(sessionId);
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function runArchive(ledgerPath: string, opts?: ArchiveOptions): number {
  if (!existsSync(ledgerPath)) {
    process.stderr.write(`lykos archive: no ledger at ${ledgerPath} — nothing has been recorded yet.\n`);
    return 1;
  }
  const ledger = openLedgerSync(ledgerPath);
  try {
    const result = archiveSessions(ledger, opts);
    if (opts?.json) {
      stdoutWrite(`${JSON.stringify(result)}\n`);
      return 0;
    }
    const days = opts?.days ?? DEFAULT_RETENTION_DAYS;
    const prefix = opts?.dryRun ? "would " : "";
    stdoutWrite(`lykos archive  retention ${days}d  ${result.scanned} session director(ies) scanned\n`);
    stdoutWrite(
      `  ${prefix}compress   ${result.compressed.length}` +
        (result.compressed.length > 0
          ? `  ${fmtBytes(result.bytesBefore)} -> ${fmtBytes(result.bytesAfter)}` +
            ` (${((1 - result.bytesAfter / Math.max(result.bytesBefore, 1)) * 100).toFixed(0)}% smaller)`
          : "") +
        "\n",
    );
    if (result.resumedHalfCompressed.length > 0) {
      stdoutWrite(`  ${prefix}finish     ${result.resumedHalfCompressed.length} half-compressed from an earlier run\n`);
    }
    stdoutWrite(`  ${prefix}reap       ${result.liveFilesReaped.length} stale live.json\n`);
    if (result.orphans.length > 0) {
      stdoutWrite(
        `  untouched  ${result.orphans.length} session director(ies) with no ledger row — crashed runs, kept as they are\n`,
      );
    }
    for (const r of result.refused) {
      process.stderr.write(`lykos archive: refused ${r.sessionId}: ${r.reason}\n`);
    }
    // Nothing is ever deleted, so the only honest failure here is a refusal.
    return result.refused.length > 0 ? 1 : 0;
  } finally {
    ledger.close();
  }
}
