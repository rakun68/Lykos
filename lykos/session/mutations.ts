// T129: the human-only session lifecycle boundary.
//
// Deleting a conversation never deletes accounting.  The ledger row and its
// calls remain; only the readable conversation payload is removed.

import { rmSync } from "node:fs";

import { openLedgerSync } from "../ledger/use.js";

import { transcriptDir } from "./transcript.js";

export const DELETED_SESSION_REASON = "session conversation deleted by a human";

export function deleteSessionConversation(
  ledgerPath: string,
  sessionId: string,
  reason = DELETED_SESSION_REASON,
): void {
  const ledger = openLedgerSync(ledgerPath);
  try {
    ledger.markSessionDeleted(sessionId, reason);
  } finally {
    ledger.close();
  }
  // This is the only deletion in the product's conversation surface. It is
  // intentionally after the durable ledger mark: a crash leaves an
  // unresumable, explicitly marked row rather than a resumable row with
  // missing bytes.
  rmSync(transcriptDir(ledgerPath, sessionId), { recursive: true, force: true });
}
