import { openLedgerWithRetry } from "../ledger/ledger.js";

export async function open() {
  return openLedgerWithRetry("/tmp/ledger.db");
}
