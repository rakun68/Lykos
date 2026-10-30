// T168 part B (ADR-0031, decision 11) — what this session has read, so that
// `edit.require_read` can refuse an `edit` or `write` made blind.
//
// **What it holds.** One entry per file: the sha256 of the file's bytes at the
// moment of the last successful `read` of it (a partial `offset`/`limit` read
// counts, by the maintainer's decision),
// or of the bytes Lykos's own last successful `edit` or `write` left there. It
// holds a hash and not the content, so a long session reading large files
// carries 32 bytes per file, not the files.
//
// **Per session by construction.** `loadTools()` builds one and hands the same
// object to `read`, `edit` and `write`; there is no module-level record, so two
// sessions in one process (every MCP worker, every test file) cannot satisfy
// each other's check.
//
// **The check is on bytes, not on mtime.** A tool that rewrote a file with the
// same content is not a change the model needs to re-read for, and a clock
// that did not tick between two writes must not hide one. The hash is of the
// raw bytes, so a BOM or a line-ending change is a change.
//
// **What it does not do.** It does not track the model reading a file through
// `bash`, `grep` or `lsp`: only `read` counts as having seen a file, which is
// the rule the maintainer wrote. It is not consulted by `ast_edit`, `lsp
// rename` or `bash`, which change files without a model-supplied `oldText`
// (the same boundary `loop/edit-retry.ts` draws). And when `require_read` is
// off nothing is checked, though the record is still kept: the cost is one
// hash per read, and a session never has to be restarted to turn the rule on.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/** The record's key: absolute, and case-insensitive where the filesystem is (Windows), the same folding the mutation queue's callers rely on. */
export function recordKey(absolutePath: string): string {
  const abs = resolve(absolutePath);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

export function contentHash(content: string | Uint8Array): string {
  return createHash("sha256")
    .update(typeof content === "string" ? Buffer.from(content, "utf8") : content)
    .digest("hex");
}

/** Hash of the file as it is now, or undefined when it cannot be read (missing, a directory, no permission). */
export async function hashFileNow(absolutePath: string): Promise<string | undefined> {
  try {
    return contentHash(await readFile(absolutePath));
  } catch {
    return undefined;
  }
}

/**
 * The two rejection sentences' fixed tails. Exported so the failure classifier
 * (`tools/edit-failure.ts`, read by `lykos show`) matches the very strings the
 * check throws rather than a second copy of them.
 */
export const UNREAD_TAIL = " has not been read in this session. Read it first (edit.require_read is on).";
export const STALE_TAIL = " changed since it was last read. Read it again before editing (edit.require_read is on).";

export class FileReadRecord {
  private readonly hashes = new Map<string, string>();

  constructor(
    /** `edit.require_read`. False means `check()` never throws; the record is kept regardless. */
    readonly requireRead: boolean,
  ) {}

  /** A successful `read` of the file: what its bytes hashed to when the read began. */
  noteRead(absolutePath: string, hash: string): void {
    this.hashes.set(recordKey(absolutePath), hash);
  }

  /** Lykos's own successful `edit` or `write`: the file now holds exactly `content`, which counts as seen. */
  noteWritten(absolutePath: string, content: string | Uint8Array): void {
    this.hashes.set(recordKey(absolutePath), contentHash(content));
  }

  /**
   * Throws, before anything is written or asked of the human, when
   * `require_read` is on and the file this call is about to change has not been
   * read, or has changed since. `current` is the file's bytes as the caller just
   * read them. `displayPath` is the path the model wrote, so the message names
   * what the model will recognise.
   */
  check(absolutePath: string, current: Uint8Array, displayPath: string): void {
    if (!this.requireRead) return;
    const recorded = this.hashes.get(recordKey(absolutePath));
    if (recorded === undefined) throw new Error(`\`${displayPath}\`${UNREAD_TAIL}`);
    if (recorded !== contentHash(current)) throw new Error(`\`${displayPath}\`${STALE_TAIL}`);
  }

  /** Whether the record has anything for the file. For tests and diagnostics. */
  has(absolutePath: string): boolean {
    return this.hashes.has(recordKey(absolutePath));
  }
}

/** One sentence appended to the `edit` and `write` descriptions when `edit.require_read` is on, and only then. */
export const REQUIRE_READ_SENTENCE =
  " This session requires a read first: changing an existing file you have not read this session, or that changed since you read it, is rejected.";
