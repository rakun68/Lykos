// `lykos sessions`, and the picker behind `lykos resume` with no id.
//
// Three entry points, one implementation:
//
//   * `lykos sessions`            — a plain listing (and `--json`).
//   * `lykos resume` with no id   — the picker, handing its answer to T57.
//   * `/resume` inside a session  — the same picker, reached from the loop.
//
// The full-screen surface is used when the fallback ladder (T50.1) says it
// may be, and a numbered list is printed when it may not. That is the same
// discipline every other surface in this product follows and for the same
// reason: every non-TTY caller still has to work.
//
// **It never spends anything.** The picker is read-only up to the moment it
// returns a session id; T57 owns the confirmation and the spending, and it
// re-runs the preflight itself rather than trusting what was on screen.

import {
  filterSessions,
} from "../session/listing.js";
import {
  allProjectSources,
  gatherSessions,
  type GatherOpts,
  type SessionSource,
} from "../session/sources.js";

export { allProjectSources, gatherSessions, type GatherOpts, type SessionSource };
import { renderPickerFallback } from "../surface/session-picker.js";
import { stdoutWrite } from "../io-mode.js";

// ---------------------------------------------------------------------------
// `lykos sessions` — the plain listing
// ---------------------------------------------------------------------------

export interface RunSessionsOpts {
  sources: readonly SessionSource[];
  projectId?: string | null;
  json?: boolean;
  filter?: string;
  limit?: number;
  now?: Date;
  write?: (text: string) => void;
}

export function runSessions(opts: RunSessionsOpts): number {
  const write = opts.write ?? stdoutWrite;
  const { rows } = gatherSessions(opts.sources, {
    ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
  });
  const shown = opts.filter ? filterSessions(rows, opts.filter) : rows;
  if (opts.json) {
    write(`${JSON.stringify(shown, null, 2)}\n`);
    return 0;
  }
  if (shown.length === 0) {
    write("lykos sessions: nothing recorded yet.\n");
    return 0;
  }
  const lines = renderPickerFallback(shown, {
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  });
  write(`${lines.join("\n")}\n`);
  write("\nresume one with `lykos resume <id>` — it shows what the replay costs before spending it.\n");
  return 0;
}

/**
 * The append-only fallback for the picker: print the numbered list, read one
 * number. Same rows, no key handling, and a caller with no terminal at all
 * gets the listing and an explicit instruction rather than a hang.
 */
export async function pickSessionFallback(opts: {
  sources: readonly SessionSource[];
  projectId?: string | null;
  now?: Date;
  read?: () => Promise<string | null>;
  write?: (text: string) => void;
}): Promise<string | null> {
  const write = opts.write ?? ((t: string) => void process.stderr.write(t));
  const { rows } = gatherSessions(opts.sources, {
    ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
  });
  if (rows.length === 0) {
    write("lykos resume: nothing recorded yet — run something first.\n");
    return null;
  }
  const shown = rows.slice(0, 20);
  write(`${renderPickerFallback(shown, opts.now !== undefined ? { now: opts.now } : {}).join("\n")}\n`);
  if (!opts.read) {
    write("\nlykos resume: no terminal to pick from — name one explicitly: `lykos resume <id>`\n");
    return null;
  }
  write("\nnumber to resume (Enter to cancel): ");
  const answer = (await opts.read())?.trim() ?? "";
  if (answer.length === 0) return null;
  const index = Number(answer);
  if (!Number.isInteger(index) || index < 1 || index > shown.length) {
    write(`lykos resume: "${answer}" is not one of 1–${shown.length}.\n`);
    return null;
  }
  return shown[index - 1]!.id;
}

/** Exposed for `lykos resume` with no id: the numbered list. lykos-tui has its own session list. */
export async function pickSession(opts: {
  sources: readonly SessionSource[];
  projectId?: string | null;
  now?: Date;
  read?: () => Promise<string | null>;
}): Promise<string | null> {
  return pickSessionFallback(opts);
}

