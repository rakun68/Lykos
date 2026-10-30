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

import { existsSync } from "node:fs";

import { openLedgerSync, type Ledger } from "../ledger/use.js";

import {
  filterSessions,
  type SessionListRow,
} from "../session/listing.js";
import {
  allProjectSources,
  gatherSessions,
  type GatherOpts,
  type SessionSource,
} from "../session/sources.js";

export { allProjectSources, gatherSessions, type GatherOpts, type SessionSource };
import { preflightResume } from "../session/resume-preflight.js";
import {
  initialPickerState,
  pickerKey,
  pickerPageSize,
  renderPicker,
  renderPickerFallback,
  visibleRows,
  type PickerState,
  type RowVerdict,
} from "../tui/session-picker.js";
import { stdoutWrite } from "../tui/io-mode.js";
import {
  createSessionPickerIo,
  sessionPickerIsFullscreen,
  type KeyEvent,
} from "../tui/session-picker-surface.js";

/**
 * T56's verdict for one row, condensed to the line the picker shows.
 *
 * Computed lazily, one row at a time, and cached by the caller: the
 * preflight reads a transcript off disk and prices it, which is fine for
 * the highlighted row and would be absurd for a thousand of them.
 */
export function verdictForRow(row: SessionListRow, source: SessionSource | undefined, now?: Date): RowVerdict {
  if (!source || !existsSync(source.ledgerPath)) {
    return { overall: "refuse", summary: "no ledger for this session" };
  }
  const ledger = openLedgerSync(source.ledgerPath);
  try {
    const pre = preflightResume({
      ledger,
      sessionId: row.id,
      workspace: source.workspace,
      ...(now !== undefined ? { now } : {}),
    });
    // The worst check is what a person needs to see; `checks` is already
    // sorted worst-first by the preflight itself.
    const worst = pre.checks[0];
    const cost = pre.cost;
    const summary =
      pre.overall === "proceed" && cost
        ? `replays ${cost.tokens} tokens${cost.usd === null ? " (unpriced)" : ` ≈ $${cost.usd.toFixed(4)}`}`
        : (worst?.message ?? "no checks ran");
    return {
      overall: pre.overall,
      summary,
      ...(cost ? { estimateTokens: cost.tokens, estimateUsd: cost.usd } : {}),
    };
  } finally {
    ledger.close();
  }
}

// ---------------------------------------------------------------------------
// The interactive picker
// ---------------------------------------------------------------------------

/** Everything the picker needs from a terminal, so it can be driven by a test that has none. */
export interface PickerIo {
  size(): { columns: number; rows: number };
  paint(lines: readonly string[]): void;
  /** Resolves with the next decoded key, or `null` when the stream ends. */
  nextKey(): Promise<KeyEvent | null>;
  close(): void;
}

export interface PickSessionOpts {
  sources: readonly SessionSource[];
  projectId?: string | null;
  now?: Date;
  io?: PickerIo;
  title?: string;
  /** Injected by tests. Production computes it from T56. */
  verdictFor?: (row: SessionListRow) => RowVerdict;
}

/**
 * Runs the picker and returns the chosen session id, or `null` when the
 * person cancelled. Nothing is spent either way.
 */
export async function pickSessionInteractive(opts: PickSessionOpts): Promise<string | null> {
  const { rows, sourceOf } = gatherSessions(opts.sources, {
    ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
  });
  const io = opts.io ?? (await createSessionPickerIo());
  const cache = new Map<string, RowVerdict>();
  const verdictFor = (row: SessionListRow): RowVerdict => {
    const hit = cache.get(row.id);
    if (hit) return hit;
    const computed =
      opts.verdictFor?.(row) ??
      verdictForRow(row, sourceOf.get(row.id), ...(opts.now !== undefined ? ([opts.now] as const) : ([] as const)));
    cache.set(row.id, computed);
    return computed;
  };

  let state: PickerState = initialPickerState(rows);
  let notice: string | null = null;
  try {
    for (;;) {
      const size = io.size();
      io.paint(
        renderPicker(state, {
          width: size.columns,
          height: size.rows,
          ...(opts.now !== undefined ? { now: opts.now } : {}),
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          verdictFor,
          notice,
        }),
      );
      const key = await io.nextKey();
      if (key === null) return null;
      notice = null;
      const next = pickerKey(state, key, pickerPageSize(size.rows));
      state = next.state;
      if (next.action.kind === "cancel") return null;
      if (next.action.kind === "select") return next.action.row.id;
      if (next.action.kind === "refused") notice = `not resumable — ${next.action.reason}`;
    }
  } finally {
    io.close();
  }
}

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

/** Exposed for `lykos resume` with no id, and for `/resume`. Chooses the surface the fallback ladder allows. */
export async function pickSession(opts: {
  sources: readonly SessionSource[];
  projectId?: string | null;
  now?: Date;
  read?: () => Promise<string | null>;
  noFullscreen?: boolean;
}): Promise<string | null> {
  if (await sessionPickerIsFullscreen(opts)) {
    return pickSessionInteractive({
      sources: opts.sources,
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
  }
  return pickSessionFallback(opts);
}

export { visibleRows };
