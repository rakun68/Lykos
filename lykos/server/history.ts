/**
 * What `lykos-tui`'s session list, rename, archive, export and Manage workspaces read and write (P5 #42), for the
 * engine server. Every write is the ledger's own: a rename sets the brief, an archive sets `archived_utc` and the
 * session stays in `lykos session --all`, resumable. Nothing here deletes a session or its transcript.
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { defaultLedgerPath } from "../ledger/ledger.js";
import { withLedgerSync } from "../ledger/use.js";
import { hostGit } from "../git/host-git.js";
import { defaultWorktreesRoot } from "../git/worktree.js";
import { sessionMarkdown } from "../session/export-markdown.js";
import { allProjectSources, gatherSessions, type SessionSource } from "../session/sources.js";

/** One row of the TUI's session list. */
export interface HistoryRow {
  id: string;
  title: string | null;
  startedUtc: string;
  endedUtc: string | null;
  model: string | null;
  parentSessionId: string | null;
  forkedFrom: string | null;
  /** The session a resume continued: the row it nests under. */
  resumedFrom: string | null;
  depth: number;
  archived: boolean;
  resumable: boolean;
  costUsd: number | null;
  projectPath: string | null;
  projectName: string | null;
}

/** Whether `cwd` is one of Lykos's worktrees (T184, P5 #42), which keep no ledger of their own. */
function inWorktrees(cwd: string): boolean {
  const rel = relative(resolve(defaultWorktreesRoot()), resolve(cwd));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The checkout whose ledger a session in `cwd` writes. A Lykos worktree's is the main checkout's: removing the
 * worktree must not take its sessions with it, and they list with the project's.
 */
export function projectRoot(cwd: string): string {
  const dir = resolve(cwd);
  if (!inWorktrees(dir)) return dir;
  const common = hostGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir);
  return common.ok && common.stdout !== "" ? dirname(resolve(common.stdout)) : dir;
}

export function ledgerFor(cwd: string): string {
  return defaultLedgerPath(projectRoot(cwd));
}

/** The project's sessions, newest first and nested; every project's with `all`. Archived ones only with `archived`. */
export function historyRows(cwd: string, opts: { all?: boolean; archived?: boolean; registryPath?: string } = {}): HistoryRow[] {
  const root = projectRoot(cwd);
  const sources: SessionSource[] =
    opts.all === true ? allProjectSources(opts.registryPath) : [{ ledgerPath: defaultLedgerPath(root), workspace: root, projectName: null }];
  const { rows } = gatherSessions(sources);
  return rows
    .filter((r) => opts.archived === true || r.archivedUtc == null)
    .map((r) => ({
      id: r.id,
      title: r.brief ?? r.taskBrief ?? null,
      startedUtc: r.startedUtc,
      endedUtc: r.endedUtc,
      model: r.model,
      parentSessionId: r.parentSessionId,
      forkedFrom: r.forkedFrom ?? null,
      resumedFrom: r.resumedFrom,
      depth: r.depth,
      archived: r.archivedUtc != null,
      resumable: r.resumable,
      costUsd: r.costUsd,
      projectPath: r.projectPath ?? null,
      projectName: r.projectName ?? null,
    }));
}

function withProjectLedger<T>(cwd: string, fn: Parameters<typeof withLedgerSync<T>>[1]): T {
  const path = ledgerFor(cwd);
  if (!existsSync(path)) throw new Error(`no ledger at ${path}: nothing has been recorded in this project yet`);
  return withLedgerSync(path, fn);
}

/** OpenCode `session.rename`: the ledger's brief, what `lykos session` lists as the name. */
export function renameHistorySession(cwd: string, id: string, title: string): void {
  const name = title.trim();
  if (name === "") throw new Error("a session's name cannot be empty");
  if (!withProjectLedger(cwd, (l) => l.renameSession(id, name))) throw new Error(`no session ${id}`);
}

/** OpenCode `session.delete`, as an archive: the row and transcript stay; the TUI's list leaves it out. */
export function archiveHistorySession(cwd: string, id: string): void {
  if (!withProjectLedger(cwd, (l) => l.archiveSession(id))) throw new Error(`no session ${id}`);
}

/** OpenCode `session.export`: P22's Markdown, as `lykos export` writes it. Written to `file` when one is named. */
export function exportHistorySession(cwd: string, id: string, file?: string): { markdown: string; path?: string } {
  const markdown = sessionMarkdown(ledgerFor(cwd), id);
  if (file === undefined || file === "") return { markdown };
  const path = resolve(cwd, file);
  writeFileSync(path, markdown, "utf8");
  return { markdown, path };
}
