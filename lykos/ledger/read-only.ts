// Read-only SQLite access without running ledger migrations.

import Database from "better-sqlite3";
import { existsSync } from "node:fs";

export function openReadonlyDb(ledgerPath: string): Database.Database | null {
  if (!existsSync(ledgerPath)) return null;
  try {
    return new Database(ledgerPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}
