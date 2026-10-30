import { existsSync } from "node:fs";
import { join } from "node:path";

import { openLedgerSync, type Ledger } from "../ledger/use.js";

import { loadSessions, nestSessions, type SessionListRow } from "./listing.js";
import { listProjects } from "./identity.js";

/** One ledger, and the working tree the sessions in it belong to. `--all` produces several. */
export interface SessionSource {
  ledgerPath: string;
  workspace: string;
  projectName: string | null;
}

export interface GatherOpts {
  /** Restrict this ledger's rows to one project id. */
  projectId?: string | null;
  limit?: number;
}

/**
 * Reads every source and returns the nested rows plus a map from session id
 * back to the source it came from.
 */
export function gatherSessions(
  sources: readonly SessionSource[],
  opts: GatherOpts = {},
): { rows: SessionListRow[]; sourceOf: Map<string, SessionSource> } {
  const all: SessionListRow[] = [];
  const sourceOf = new Map<string, SessionSource>();
  for (const source of sources) {
    if (!existsSync(source.ledgerPath)) continue;
    const ledger = openLedgerSync(source.ledgerPath);
    try {
      const rows = loadSessions(ledger, {
        ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      });
      for (const row of rows) {
        all.push({
          ...row,
          projectName: source.projectName,
          projectPath: source.workspace,
          ledgerPath: source.ledgerPath,
        });
        sourceOf.set(row.id, source);
      }
    } finally {
      ledger.close();
    }
  }
  all.sort((a, b) => b.startedUtc.localeCompare(a.startedUtc));
  return { rows: nestSessions(all), sourceOf };
}

/** The sources `--all` means: every project in `~/.lykos/projects.json` that still has a ledger. */
export function allProjectSources(registryPath?: string): SessionSource[] {
  return listProjects(registryPath ? { registryPath } : {}).map((p) => ({
    ledgerPath: join(p.root_path, ".lykos", "ledger.db"),
    workspace: p.root_path,
    projectName: p.name,
  }));
}
