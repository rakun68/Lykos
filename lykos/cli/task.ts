// `lykos task`: seeing, naming and closing the thing the headline metric is
// divided by.
//
// The problem this closes, in `ingest.ts`'s own honest words: it
// **auto-creates one task per snapshot** from its brief. That guarantees
// every session belongs to a task, which is what `v_cost_per_successful_task`
// needs — but it also means a second `lykos run` on the same work creates a
// second task, so a task that took three tries looks like three cheap tasks.
// That is exactly the failure `08` §1 describes.
//
// Three commands, and each is a piece of the fix:
//
//   * `lykos task list`             — see what exists, and how many sessions
//                                     and dollars each one has actually
//                                     accumulated.
//   * `lykos task name <id> <name>` — a task nobody named is still a task
//                                     (`08` §8's answer); this is how it
//                                     stops being anonymous.
//   * `lykos task abandon <id>`     — a person's word, and the only way a
//                                     task becomes `abandoned`. An agent's
//                                     claim can never reach it.
//
// `done` is not here on purpose: it is written by `lykos verify` and only
// on a verified success, because deciding a task is finished is the same
// decision as deciding a session succeeded, and T52 already established who
// is allowed to make it.
//
// **`tasks` is identity and naming, not measurement.** Renaming a task or
// moving its state changes nothing anyone has counted — the numbers are on
// `sessions` and `calls`, which stay append-only.

import { existsSync } from "node:fs";

import { openLedgerSync, type Ledger } from "../ledger/use.js";

import { stdoutWrite } from "../tui/io-mode.js";
import { fmtUsd, pad, truncate } from "../tui/format.js";

export interface TaskRow {
  id: string;
  brief: string;
  state: string | null;
  createdUtc: string;
  sessions: number;
  successes: number;
  failures: number;
  abandoned: number;
  spentUsd: number | null;
  lastStartedUtc: string | null;
}

const TASK_SELECT = `
  SELECT t.id                             AS id,
         t.brief                          AS brief,
         t.state                          AS state,
         t.created_utc                    AS created_utc,
         COUNT(s.id)                      AS sessions,
         COALESCE(SUM(s.outcome = 'success'), 0)   AS successes,
         COALESCE(SUM(s.outcome = 'fail'), 0)      AS failures,
         COALESCE(SUM(s.outcome = 'abandoned'), 0) AS abandoned,
         SUM(s.total_cost_usd)            AS spent_usd,
         MAX(s.started_utc)               AS last_started_utc
    FROM tasks t
    LEFT JOIN sessions s ON s.task_id = t.id
   GROUP BY t.id
   ORDER BY COALESCE(MAX(s.started_utc), t.created_utc) DESC`;

export function listTasks(ledger: Ledger, limit?: number): TaskRow[] {
  const rows = ledger.db.prepare(TASK_SELECT).all() as Array<{
    id: string;
    brief: string;
    state: string | null;
    created_utc: string;
    sessions: number;
    successes: number;
    failures: number;
    abandoned: number;
    spent_usd: number | null;
    last_started_utc: string | null;
  }>;
  const mapped = rows.map((r) => ({
    id: r.id,
    brief: r.brief,
    state: r.state,
    createdUtc: r.created_utc,
    sessions: r.sessions,
    successes: r.successes,
    failures: r.failures,
    abandoned: r.abandoned,
    spentUsd: r.spent_usd,
    lastStartedUtc: r.last_started_utc,
  }));
  return limit !== undefined ? mapped.slice(0, limit) : mapped;
}

/**
 * Resolves a task id or unique prefix. A task id is a UUID nobody types in
 * full, and picking the wrong task would move the wrong work — so an
 * ambiguous prefix is an error, never a guess.
 */
export function resolveTaskId(ledger: Ledger, idOrPrefix: string): { id: string } | { error: string } {
  const exact = ledger.db.prepare(`SELECT id FROM tasks WHERE id = ?`).get(idOrPrefix) as { id: string } | undefined;
  if (exact) return { id: exact.id };
  const matches = ledger.db
    .prepare(`SELECT id, brief FROM tasks WHERE id LIKE ? ORDER BY created_utc DESC`)
    .all(`${idOrPrefix}%`) as Array<{ id: string; brief: string }>;
  if (matches.length === 1) return { id: matches[0]!.id };
  if (matches.length > 1) {
    return {
      error:
        `ambiguous task prefix "${idOrPrefix}" — ${matches.length} match:\n` +
        matches.map((m) => `  ${m.id}  ${truncate(m.brief, 60)}`).join("\n"),
    };
  }
  return { error: `no task matches "${idOrPrefix}" — \`lykos task list\` shows what exists` };
}

export interface TaskCliOpts {
  json?: boolean;
  limit?: number;
  write?: (text: string) => void;
}

function openLedger(ledgerPath: string): Ledger | null {
  if (!existsSync(ledgerPath)) {
    process.stderr.write(`lykos task: no ledger at ${ledgerPath} — nothing has been recorded yet.\n`);
    return null;
  }
  return openLedgerSync(ledgerPath);
}

export function runTaskList(ledgerPath: string, opts: TaskCliOpts = {}): number {
  const write = opts.write ?? stdoutWrite;
  const ledger = openLedger(ledgerPath);
  if (!ledger) return 1;
  try {
    const rows = listTasks(ledger, opts.limit);
    if (opts.json) {
      write(`${JSON.stringify(rows, null, 2)}\n`);
      return 0;
    }
    if (rows.length === 0) {
      write("lykos task: no tasks yet.\n");
      return 0;
    }
    write(`${pad("task", 10)} ${pad("state", 10)} ${pad("sessions", 9)} ${pad("spent", 10)} outcome  brief\n`);
    for (const row of rows) {
      const outcomes =
        row.successes > 0 ? `${row.successes} ok` : row.failures > 0 ? `${row.failures} fail` : row.abandoned > 0 ? `${row.abandoned} aband` : "—";
      write(
        `${pad(row.id.slice(0, 8), 10)} ${pad(row.state ?? "—", 10)} ${pad(String(row.sessions), 9)} ` +
          `${pad(fmtUsd(row.spentUsd), 10)} ${pad(outcomes, 8)} ${truncate(row.brief, 60)}\n`,
      );
    }
    // The whole point of the listing: a task that quietly acquired six
    // sessions should be visible rather than inferred.
    const multi = rows.filter((r) => r.sessions > 1).length;
    write(
      `\n${rows.length} task${rows.length === 1 ? "" : "s"}, ${multi} with more than one session.\n` +
        "join an existing one with `lykos run --task <id> \"...\"`; name one with `lykos task name <id> \"<name>\"`.\n",
    );
    return 0;
  } finally {
    ledger.close();
  }
}

export function runTaskName(ledgerPath: string, idOrPrefix: string, name: string, opts: TaskCliOpts = {}): number {
  const write = opts.write ?? stdoutWrite;
  if (!name.trim()) {
    process.stderr.write('lykos task name: expected a name, e.g. `lykos task name 1a2b3c4d "the parser rename"`\n');
    return 1;
  }
  const ledger = openLedger(ledgerPath);
  if (!ledger) return 1;
  try {
    const resolved = resolveTaskId(ledger, idOrPrefix);
    if ("error" in resolved) {
      process.stderr.write(`lykos task name: ${resolved.error}\n`);
      return 1;
    }
    ledger.renameTask(resolved.id, name.trim());
    write(`lykos task: ${resolved.id.slice(0, 8)} is now "${name.trim()}"\n`);
    return 0;
  } finally {
    ledger.close();
  }
}

export function runTaskAbandon(ledgerPath: string, idOrPrefix: string, opts: TaskCliOpts = {}): number {
  const write = opts.write ?? stdoutWrite;
  const ledger = openLedger(ledgerPath);
  if (!ledger) return 1;
  try {
    const resolved = resolveTaskId(ledger, idOrPrefix);
    if ("error" in resolved) {
      process.stderr.write(`lykos task abandon: ${resolved.error}\n`);
      return 1;
    }
    ledger.setTaskState(resolved.id, "abandoned");
    // Abandonment is recorded, never excluded. Excluding it is how every
    // cost claim in this field becomes flattering fiction.
    write(
      `lykos task: ${resolved.id.slice(0, 8)} marked abandoned. Its sessions and their cost stay in the ledger.\n`,
    );
    return 0;
  } finally {
    ledger.close();
  }
}

/**
 * `lykos run --task <id>`: resolve the task and the project it belongs to,
 * so a second attempt joins the first rather than auto-creating a rival.
 */
export function resolveTaskForRun(
  ledgerPath: string,
  idOrPrefix: string,
): { taskId: string; projectId: string | null } | { error: string } {
  if (!existsSync(ledgerPath)) return { error: `no ledger at ${ledgerPath} — nothing has been recorded yet` };
  const ledger = openLedgerSync(ledgerPath);
  try {
    const resolved = resolveTaskId(ledger, idOrPrefix);
    if ("error" in resolved) return resolved;
    const row = ledger.db.prepare(`SELECT project_id FROM tasks WHERE id = ?`).get(resolved.id) as
      | { project_id: string | null }
      | undefined;
    return { taskId: resolved.id, projectId: row?.project_id ?? null };
  } finally {
    ledger.close();
  }
}
