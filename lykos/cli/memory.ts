// `lykos memory` — CLI adapter: parse args, call the domain, print.
//
// Domain logic lives in `memory/` and is exported through `memory.ts`.

import { existsSync, readFileSync } from "node:fs";
import { openLedgerSync } from "../ledger/use.js";
import { stdoutWrite } from "../tui/io-mode.js";
import {
  appendMemoryEntry,
  invalidateMemoryEntry,
  isEntryValid,
  isMemoryFile,
  isMemoryScope,
  MEMORY_FILES,
  MEMORY_SCOPES,
  memoryFilePath,
  parseMemoryEntries,
  removeMemoryEntry,
  renderEntryMeta,
  type AppendOptions,
  type MemoryFile,
  type MemoryScope,
} from "../memory.js";

export { isMemoryFile, isMemoryScope };

export interface RunOptions {
  scope?: MemoryScope;
  file?: MemoryFile;
}

function scopesToUse(opts: RunOptions): MemoryScope[] {
  return opts.scope ? [opts.scope] : MEMORY_SCOPES;
}
function filesToUse(opts: RunOptions): MemoryFile[] {
  return opts.file ? [opts.file] : MEMORY_FILES;
}

export function runMemoryList(cwd: string, opts: RunOptions & { all?: boolean } = {}): number {
  let any = false;
  for (const scope of scopesToUse(opts)) {
    for (const file of filesToUse(opts)) {
      const path = memoryFilePath(cwd, scope, file);
      if (!existsSync(path)) continue;
      const all = parseMemoryEntries(readFileSync(path, "utf8"));
      const entries = opts.all === true ? all : all.filter(isEntryValid);
      if (entries.length === 0) continue;
      any = true;
      const hidden = all.length - entries.length;
      stdoutWrite(`${scope}/${file} (${path})${hidden > 0 ? `  [${hidden} invalidated, --all to show]` : ""}\n`);
      for (const e of entries) stdoutWrite(`  [${e.id}] ${e.text}${renderEntryMeta(e.meta)}\n`);
    }
  }
  if (!any) {
    stdoutWrite("no memory entries yet — add one with `lykos memory add \"...\"`.\n");
  }
  return 0;
}

export function runMemoryAdd(cwd: string, text: string, opts: RunOptions & AppendOptions = {}): number {
  if (!text || text.trim().length === 0) {
    process.stderr.write('lykos memory add: expected text, e.g. `lykos memory add "..."`\n');
    return 1;
  }
  const scope = opts.scope ?? "project";
  const file = opts.file ?? "gotchas";
  const path = memoryFilePath(cwd, scope, file);
  const entry = appendMemoryEntry(path, text.trim(), {
    ...(opts.src ? { src: opts.src } : {}),
    ...(opts.paths && opts.paths.length > 0 ? { paths: opts.paths } : {}),
  });
  stdoutWrite(`added [${entry.id}] to ${path}\n`);
  return 0;
}

export interface ForgetOptions extends RunOptions {
  /** Really delete the line. Off by default: T78 supersedes rather than removes. */
  purge?: boolean;
  reason?: string;
  by?: string;
}

export function runMemoryForget(cwd: string, idOrMatch: string, opts: ForgetOptions = {}): number {
  if (!idOrMatch) {
    process.stderr.write("lykos memory forget: expected an id or a text match, e.g. `lykos memory forget a1b2c3d4`\n");
    return 1;
  }
  const candidates: { scope: MemoryScope; file: MemoryFile; path: string }[] = [];
  for (const scope of scopesToUse(opts)) {
    for (const file of filesToUse(opts)) candidates.push({ scope, file, path: memoryFilePath(cwd, scope, file) });
  }

  const hits: Array<{ scope: MemoryScope; file: MemoryFile; path: string; matches: ReturnType<typeof parseMemoryEntries> }> = [];
  for (const c of candidates) {
    if (!existsSync(c.path)) continue;
    const entries = parseMemoryEntries(readFileSync(c.path, "utf8"));
    const byId = entries.filter((e) => e.id === idOrMatch);
    const matches = byId.length > 0 ? byId : entries.filter((e) => e.text.includes(idOrMatch));
    if (matches.length > 0) hits.push({ ...c, matches });
  }

  const total = hits.reduce((n, h) => n + h.matches.length, 0);
  if (total === 0) {
    process.stderr.write(`lykos memory forget: no entry matching "${idOrMatch}"\n`);
    return 1;
  }
  if (total > 1) {
    process.stderr.write(`lykos memory forget: "${idOrMatch}" matches more than one entry — be more specific, or use the id:\n`);
    for (const h of hits) for (const m of h.matches) process.stderr.write(`  ${h.scope}/${h.file}  [${m.id}] ${m.text}\n`);
    return 1;
  }

  const hit = hits[0]!;
  const id = hit.matches[0]!.id;

  if (opts.purge === true) {
    const result = removeMemoryEntry(hit.path, id);
    if (result.status !== "removed") {
      process.stderr.write(`lykos memory forget: unexpected: ${result.status}\n`);
      return 1;
    }
    stdoutWrite(`purged [${result.entry.id}] from ${hit.path} — the line is gone, not superseded\n`);
    return 0;
  }

  const result = invalidateMemoryEntry(hit.path, id, {
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.by ? { by: opts.by } : {}),
  });
  if (result.status === "already_invalid") {
    stdoutWrite(`[${id}] was already invalidated on ${result.entry.meta.invalid}; left as it is\n`);
    return 0;
  }
  if (result.status !== "invalidated") {
    process.stderr.write(`lykos memory forget: unexpected: ${result.status}\n`);
    return 1;
  }
  stdoutWrite(
    `invalidated [${result.entry.id}] in ${hit.path} — kept and no longer injected ` +
      "(`--purge` deletes the line instead)\n",
  );
  return 0;
}

export interface RediscoveredOptions {
  session?: string;
  source?: string;
  helped?: boolean;
  calls?: number;
  list?: boolean;
}

export async function runMemoryRediscovered(
  ledgerPath: string,
  lesson: string,
  opts: RediscoveredOptions = {},
): Promise<number> {
  const { Ledger } = await import("../ledger/ledger.js");
  const { listRediscoveries, formatAnnotationReport } = await import("../ledger/rediscovery-annotations.js");
  const ledger = openLedgerSync(ledgerPath);
  try {
    if (opts.list === true || lesson.trim().length === 0) {
      if (opts.list !== true) {
        process.stderr.write(
          'lykos memory rediscovered: expected the lesson, e.g. `lykos memory rediscovered "DeepSeek peak ' +
            'pricing swings 2x"` — or --list to read what has been filed.\n',
        );
        return 1;
      }
      stdoutWrite(`${formatAnnotationReport(listRediscoveries(ledger))}\n`);
      return 0;
    }
    const id = ledger.recordRediscovery({
      lesson,
      author: "human",
      ...(opts.session ? { sessionId: opts.session } : {}),
      ...(opts.source ? { sourceSessionId: opts.source } : {}),
      ...(opts.helped === undefined ? {} : { wouldHaveHelped: opts.helped }),
      ...(opts.calls === undefined ? {} : { callsSpent: opts.calls }),
    });
    stdoutWrite(
      `recorded rediscovery #${id}. This is a lower bound on semantic rediscovery, never a rate — ` +
        "you can only annotate what you notice.\n",
    );
    return 0;
  } finally {
    ledger.close();
  }
}

export async function runMemoryStale(cwd: string, opts: RunOptions = {}): Promise<number> {
  const { collectMemoryEntries, partitionStale } = await import("../session/memory-head.js");
  const scopes = opts.scope ? [opts.scope] : MEMORY_SCOPES;
  const { stale } = partitionStale(cwd, collectMemoryEntries(cwd, scopes));
  if (stale.length === 0) {
    stdoutWrite("no stale entries — every memory that declares paths still has all of them.\n");
    return 0;
  }
  const plural = stale.length === 1 ? "y is" : "ies are";
  stdoutWrite(`${stale.length} entr${plural} held back (not injected, not deleted):\n`);
  for (const e of stale) {
    stdoutWrite(`  [${e.id}] ${e.scope}/${e.file}  ${e.text}\n`);
    stdoutWrite(`            missing: ${e.missingPaths.join(", ")}\n`);
  }
  stdoutWrite(
    '\nFix the paths, or `lykos memory invalidate <id> --reason "..."` if the lesson is no longer true.\n' +
      "Nothing here is evicted automatically: a moved file does not make a gotcha false.\n",
  );
  return 0;
}

export async function runMemoryStatus(ledgerPath: string): Promise<number> {
  const { Ledger } = await import("../ledger/ledger.js");
  const { eligibilityReport, formatEligibilityReport } = await import("../ledger/memory-eligibility.js");
  const ledger = openLedgerSync(ledgerPath);
  try {
    stdoutWrite(`${formatEligibilityReport(eligibilityReport(ledger))}
`);
  } finally {
    ledger.close();
  }
  return 0;
}
