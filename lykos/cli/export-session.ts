// `lykos export <session> [file]` — T267. The session's conversation as
// Markdown (session/export-markdown.ts), printed to stdout or written to
// `file`. It reads the transcript the ledger row names, so a session that has
// ended exports the same as one still running. The session is found the way
// `lykos resume` finds it: an exact id, then a unique id prefix.

import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { openLedgerSync } from "../ledger/use.js";
import { sessionMarkdown } from "../session/export-markdown.js";
import { resolveTranscriptFile, transcriptFilePath } from "../session/transcript.js";
import { stderrWrite, stdoutWrite } from "../io-mode.js";
import { resolveSessionId } from "./resume.js";

export function runExportSession(cwd: string, ledgerPath: string, idOrPrefix: string, file?: string): number {
  if (!existsSync(ledgerPath)) {
    stderrWrite(`lykos export: no ledger at ${ledgerPath} — nothing has been recorded yet.\n`);
    return 1;
  }
  const ledger = openLedgerSync(ledgerPath);
  let sessionId: string | null;
  let recorded: string;
  try {
    sessionId = resolveSessionId(ledger, idOrPrefix, (message) => stderrWrite(message), "export");
    if (!sessionId) return 1;
    const row = ledger.db.prepare("SELECT transcript_path FROM sessions WHERE id = ?").get(sessionId) as
      | { transcript_path: string | null }
      | undefined;
    recorded = row?.transcript_path ?? transcriptFilePath(ledgerPath, sessionId);
  } finally {
    ledger.close();
  }
  if (!resolveTranscriptFile(recorded)) {
    stderrWrite(`lykos export: transcript file missing for session ${sessionId}: ${recorded}\n`);
    return 1;
  }

  let markdown: string;
  try {
    markdown = sessionMarkdown(ledgerPath, sessionId, recorded);
  } catch (err) {
    stderrWrite(`lykos export: cannot read session ${sessionId}: ${(err as Error).message}\n`);
    return 1;
  }
  if (file === undefined) {
    stdoutWrite(markdown);
    return 0;
  }
  const path = resolve(cwd, file);
  writeFileSync(path, markdown, "utf8");
  stderrWrite(`lykos export: wrote session ${sessionId} to ${path}\n`);
  return 0;
}
