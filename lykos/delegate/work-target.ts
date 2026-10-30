// Where a delegated session's work lands (ADR-0036).
//
// The interaction mode decides the target, and nothing else does (story 49):
//   - a mode that does not write (`plan`, `ask`) works in the caller's tree through a read-only
//     mount, with no worktree and no git needed, so a review runs in any folder;
//   - a writing mode (`manual`, `auto`) works on a worktree and branch of its own, so it never
//     shares git state with the caller or another session;
//   - a writing mode with `write_in_place` works in the caller's tree, on the caller's say-so;
//   - a writing mode in a folder git cannot work in refuses, unless `write_in_place` is set, which
//     then writes in place with no commits and says so. Unattended writes always have git as
//     their undo, or the caller has said they do not.
//
// `lykos run` and the MCP child both go through `withWorkTarget`, so a delegated `lykos run` and
// an MCP call start the same session (story 74).

import { existsSync } from "node:fs";
import { gitStateReason, probeGit } from "../git/host-git.js";
import { acquireWorktree, WorktreeError, type CommitSummary, type SavedCommit, type WorktreeLease } from "../git/worktree.js";
import { modeWrites, type InteractionMode } from "../gate/modes.js";
import { openLedger, recordSessionCommits } from "../ledger/use.js";
import { resolveProject } from "../session/identity.js";
import type { WorkTree } from "../session/session.js";

/** What a call says about where its work is. Every field is present only when it is true. */
export interface WorkReport {
  /** The branch the work is on, when it is not the caller's own. */
  branch?: string;
  /** The commits on that branch, newest first. */
  commits?: CommitSummary[];
  /** The session wrote in the caller's tree. */
  inPlace?: true;
  /** What the caller should know: what it gave up by writing in place, or work that was saved for it. */
  note?: string;
  /** The commit that saved changes the session left uncommitted: not made through `commit`, so not yet in the ledger. */
  saved?: SavedCommit;
}

export interface WorkTargetRequest {
  /** The caller's tree: the project's root. */
  workspace: string;
  interactionMode: InteractionMode;
  /** True when the session is read-only and gets no worktree (e.g. lykos_review or read_only specialist). */
  readOnly?: boolean;
  /** The caller opted in to writing in its own tree. */
  writeInPlace?: boolean;
  /** The session the work belongs to: its id names the worktree and the branch. */
  sessionId: string;
  /** Starting branch/ref for the worktree. */
  base?: string;
  /** Tests only: where worktrees live. */
  worktreesRoot?: string;
}

type Target =
  | { kind: "read-only" }
  | { kind: "in-place"; note: string }
  | { kind: "worktree"; lease: WorktreeLease };

export type PreparedTarget = { ok: true; target: Target } | { ok: false; message: string };

export function prepareWorkTarget(request: WorkTargetRequest): PreparedTarget {
  if (request.readOnly === true || !modeWrites(request.interactionMode)) return { ok: true, target: { kind: "read-only" } };

  const probe = probeGit(request.workspace);
  if (request.writeInPlace === true) {
    return {
      ok: true,
      target: {
        kind: "in-place",
        note:
          probe.state === "repo"
            ? "write_in_place: the session wrote in your own working tree, not on a branch of its own; there is no branch to review, and a commit it made is on your current branch"
            : `write_in_place: ${gitStateReason(probe.state as Exclude<typeof probe.state, "repo">)}, so the session wrote in your folder with no commits and nothing to undo it with`,
      },
    };
  }
  if (probe.state !== "repo") {
    return {
      ok: false,
      message:
        `lykos: a session that writes needs a git repository so its work has an undo (${gitStateReason(probe.state)}); ` +
        "run it in a repository, or set write_in_place to let it write in this folder with no commits",
    };
  }
  try {
    const projectId = resolveProject(request.workspace).id;
    const lease = acquireWorktree({
      workspace: request.workspace,
      projectId,
      sessionId: request.sessionId,
      ...(request.base !== undefined ? { base: request.base } : {}),
      ...(request.worktreesRoot !== undefined ? { root: request.worktreesRoot } : {}),
    });
    return { ok: true, target: { kind: "worktree", lease } };
  } catch (err) {
    if (err instanceof WorktreeError) return { ok: false, message: `lykos: ${err.message}` };
    throw err;
  }
}

/** What the engine needs to know about a target. */
export function workTreeOf(target: Target): WorkTree | undefined {
  return target.kind === "worktree" ? { path: target.lease.path, commonDir: target.lease.commonDir, gitDir: target.lease.gitDir } : undefined;
}

/** The directory a resume's preflight checks the session's files in: the worktree, when the work is on one. */
export function preflightWorkspaceOf(target: Target, workspace: string): string {
  return target.kind === "worktree" ? target.lease.path : workspace;
}

/** The notes that were written, as one; undefined when there are none. */
export function joinNotes(...notes: Array<string | undefined>): string | undefined {
  const written = notes.filter((n): n is string => n !== undefined && n !== "");
  return written.length > 0 ? written.join("; ") : undefined;
}

/** Ends the call: the worktree is removed (anything left uncommitted is saved on the branch first), the branch stays. */
export function finishWorkTarget(target: Target): WorkReport {
  if (target.kind === "in-place") return { inPlace: true, note: target.note };
  if (target.kind === "read-only") return {};
  const released = target.lease.release();
  // The branch outlives the worktree, so what is on it is read after the worktree is gone and includes any save.
  const commits = target.lease.commits();
  const note = joinNotes(
    released.savedUncommitted ? `the session left changes uncommitted; they were committed onto ${target.lease.branch} so nothing was lost` : undefined,
    released.note,
  );
  return {
    branch: target.lease.branch,
    ...(commits.length > 0 ? { commits } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(released.saved !== undefined ? { saved: released.saved } : {}),
  };
}

/**
 * The commit that saved a session's leftover changes goes in the ledger like any commit the session made (story 24),
 * against the session that left them. Its author is whatever git's configuration says, as for `commit`.
 */
export async function recordSavedWork(ledgerPath: string, sessionId: string, work: WorkReport): Promise<string | undefined> {
  if (work.saved === undefined) return undefined;
  try {
    await recordSessionCommits(ledgerPath, sessionId, [
      { sha: work.saved.sha, tsUtc: new Date().toISOString(), subject: work.saved.subject, message: work.saved.message, filesChanged: work.saved.filesChanged, scope: "all" },
    ]);
    return undefined;
  } catch (err) {
    // The branch holds the commit either way; the caller is told the ledger does not.
    return `the commit that saved the session's uncommitted changes (${work.saved.sha.slice(0, 12)}) is on the branch but could not be recorded in the ledger: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Records the commit that saved leftover changes, and returns the report with a ledger failure added to its note, so
 * the caller reads it whatever the outcome was. `report` also gets the failure, for the process's own stderr.
 */
export async function recordWork(ledgerPath: string, sessionId: string, work: WorkReport, report: (line: string) => void): Promise<WorkReport> {
  const failure = await recordSavedWork(ledgerPath, sessionId, work);
  if (failure === undefined) return work;
  report(failure);
  return { ...work, note: joinNotes(work.note, failure) ?? failure };
}

/**
 * Where the work is, as lines for a person: the branch with its commits, then the note. It starts with a blank line and
 * ends with a newline, and is empty when there is nothing to say, so a writer can emit it as it is.
 */
export function describeWork(work: WorkReport): string {
  const branch = work.branch !== undefined ? [`branch: ${work.branch}`, ...(work.commits ?? []).map((c) => `  ${c.sha.slice(0, 12)} ${c.subject}`)].join("\n") : undefined;
  const parts = [branch, work.note].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? `\n${parts.join("\n\n")}\n` : "";
}

/** What every outcome of a call says about its work: the branch when there is one, its commits, and the note. */
export function workFields(work: WorkReport): { branch?: string; commits?: CommitSummary[]; note?: string } {
  return {
    ...(work.branch !== undefined ? { branch: work.branch } : {}),
    ...((work.commits?.length ?? 0) > 0 ? { commits: work.commits! } : {}),
    ...(work.note !== undefined ? { note: work.note } : {}),
  };
}

/**
 * The session a call's branch is named from. A context-limit successor inside one call gets an id of its own, and the
 * result returns it; continuing with it must reach the same branch and not make a new one from HEAD, so the id is
 * followed back through `resumed_from` to the session the branch was made for.
 */
export async function rootSessionOf(ledgerPath: string, sessionId: string): Promise<string> {
  // Opening a ledger that is not there would make one.
  if (!existsSync(ledgerPath)) return sessionId;
  let ledger;
  try {
    ledger = await openLedger(ledgerPath);
  } catch {
    return sessionId;
  }
  try {
    let id = sessionId;
    for (let hops = 0; hops < 100; hops += 1) {
      const row = ledger.db.prepare(`SELECT resumed_from FROM sessions WHERE id = ?`).get(id) as { resumed_from: string | null } | undefined;
      if (row?.resumed_from === undefined || row.resumed_from === null || row.resumed_from === id) return id;
      id = row.resumed_from;
    }
    return id;
  } catch {
    return sessionId;
  } finally {
    ledger.close();
  }
}

/** `work` on a failure is what the call left on its branch, when the body threw after the worktree was made. */
export type WithWorkTarget<T> = { ok: true; value: T; work: WorkReport } | { ok: false; message: string; work?: WorkReport };

/**
 * Prepares the target, runs `body` with it, and finishes it even when `body` throws. The commits and the
 * worktree's removal are reported in `work` whatever `body` returned, because a session that failed
 * partway may still have made commits.
 */
export async function withWorkTarget<T>(
  request: WorkTargetRequest,
  body: (target: { workTree?: WorkTree; preflightWorkspace: string }) => Promise<T>,
): Promise<WithWorkTarget<T>> {
  const prepared = prepareWorkTarget(request);
  if (!prepared.ok) return prepared;
  const { target } = prepared;
  const workTree = workTreeOf(target);
  let value: T;
  try {
    value = await body({ ...(workTree !== undefined ? { workTree } : {}), preflightWorkspace: preflightWorkspaceOf(target, request.workspace) });
  } catch (err) {
    // The worktree still has to go and the branch still holds whatever was done, so the caller is told both.
    return { ok: false, message: err instanceof Error ? err.message : String(err), work: finishWorkTarget(target) };
  }
  return { ok: true, value, work: finishWorkTarget(target) };
}
