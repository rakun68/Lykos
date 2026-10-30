// Prompt history.
//
// Persisted per project in `.lykos/history.json`, NOT the ledger — a
// prompt a person typed and then abandoned is not evidence of anything,
// and the ledger is the record CLAUDE.md says every real call must
// appear in truthfully. History is a convenience file, capped, and
// rewritten whole on every append (interactive typing is nowhere near a
// hot enough path for that to matter).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_HISTORY_CAP = 500;

export function historyPath(workspace: string): string {
  return join(workspace, ".lykos", "history.json");
}

/** Oldest-first. Corrupt or missing history is empty history, never a crash — losing recall is not losing work. */
export function loadHistory(workspace: string, cap = DEFAULT_HISTORY_CAP): string[] {
  const path = historyPath(workspace);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(raw)) return [];
    const entries = raw.filter((v): v is string => typeof v === "string");
    return entries.slice(-cap);
  } catch {
    return [];
  }
}

/** Appends one entry and rewrites the file, capped from the front (oldest dropped first). Silently no-ops on a write failure — a full or read-only disk should not crash the session over prompt recall. */
export function appendHistory(workspace: string, entry: string, cap = DEFAULT_HISTORY_CAP): void {
  if (entry.trim().length === 0) return;
  const path = historyPath(workspace);
  const existing = loadHistory(workspace, cap);
  const next = [...existing, entry].slice(-cap);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(next), "utf8");
  } catch {
    // Prompt recall is a convenience, not a guarantee — see this file's module doc.
  }
}

/**
 * T46.3: "prefix-filtered history is the version worth having." Newest
 * match first — a Ctrl-R search starts from what was typed most recently.
 */
export function searchHistoryByPrefix(history: readonly string[], prefix: string): string[] {
  if (prefix.length === 0) return [...history].reverse();
  return [...history].reverse().filter((h) => h.startsWith(prefix));
}
