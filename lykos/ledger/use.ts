// The only production module that calls `Ledger.open` / `openLedgerWithRetry`.
// Every other caller imports `openLedger` / `openLedgerSync` from here so the
// dependency scan's ledger rule stays structural.

import {
  Ledger,
  openLedgerWithRetry,
  type CommitRow,
  type PruneRow,
  type SealEventInput,
  type SealEventKind,
  type SealEventRow,
  SEAL_EVENT_KINDS,
} from "./ledger.js";

export type { Ledger, SealEventInput, SealEventKind, SealEventRow } from "./ledger.js";
export { defaultLedgerPath, SEAL_EVENT_KINDS } from "./ledger.js";

/** Async open with lock retry — prefer `withLedger` when the handle is short-lived. */
export async function openLedger(path: string): Promise<Ledger> {
  return openLedgerWithRetry(path);
}

/** Sync open — prefer `withLedgerSync` when the handle is short-lived. */
export function openLedgerSync(path: string): Ledger {
  return Ledger.open(path);
}

export async function withLedger<T>(path: string, fn: (ledger: Ledger) => Promise<T>): Promise<T> {
  const ledger = await openLedgerWithRetry(path);
  try {
    return await fn(ledger);
  } finally {
    ledger.close();
  }
}

export function withLedgerSync<T>(path: string, fn: (ledger: Ledger) => T): T {
  const ledger = Ledger.open(path);
  try {
    return fn(ledger);
  } finally {
    ledger.close();
  }
}

/**
 * T188: write a prune's row the moment the prune is made, on the same terms as
 * `recordSessionCommits`: a short-lived handle with the lock retry.
 */
export async function recordSessionPrunes(path: string, sessionId: string, rows: ReadonlyArray<PruneRow>): Promise<void> {
  await withLedger(path, async (ledger) => {
    ledger.recordPrunes(sessionId, rows);
  });
}

/**
 * T179: write commits against a session the moment they are made. A short-lived
 * handle with the lock retry (the session's own ledger writer may hold the
 * database), so a busy ledger delays the row instead of losing it.
 */
export async function recordSessionCommits(path: string, sessionId: string, rows: ReadonlyArray<CommitRow>): Promise<void> {
  await withLedger(path, async (ledger) => {
    ledger.recordCommits(sessionId, rows);
  });
}

/**
 * T195: record a seal event in the ledger.
 */
export async function recordSealEvent(path: string, event: SealEventInput): Promise<void> {
  await withLedger(path, async (ledger) => {
    ledger.recordSealEvent(event);
  });
}


