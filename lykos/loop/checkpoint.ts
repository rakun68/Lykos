// T104 — checkpoint and rewind (`docs/24-strength-and-tooling-audit.md` §2.8,
// `docs/27-phase12-tasks.md`).
//
// WHAT IS MISSING, and the premise holds exactly. There is no undo. If the
// agent makes a mess across six files, recovery is a `git checkout` typed by
// the human, assuming there was a commit to return to — and on this project
// there very often is not, because "commit every change" is a rule for
// finished work, not for the middle of a turn.
//
// §2.8's cheapest form, followed: an auto-commit to a **scratch ref, never
// the branch**, before each turn, plus `lykos rewind`. Pure local git — no
// tokens, no tool schema, and **the agent never calls it. The human does.**
// That last clause is not a detail: an agent that can rewind its own work is
// an agent that can erase the evidence of what it did, and this project's
// first rule about its own archive is that nothing it runs is ever deleted.
//
// FOUR THINGS IT MUST NOT TOUCH, and the plumbing is chosen entirely to
// satisfy them. It must not move HEAD, must not touch the current branch,
// must not disturb the user's index (a half-staged change mid-review is a
// real state and destroying it would be unforgivable), and must not create
// anything a normal `git log` or `git status` shows.
//
// So: `git add -A` runs against a SEPARATE index file (`GIT_INDEX_FILE`
// pointed inside `.git/`), `write-tree` turns it into a tree,
// `commit-tree` makes a commit with no branch, and `update-ref` moves
// `refs/lykos/checkpoints` alone. Verified against a real repository: after
// a checkpoint, `git status` is byte-identical to before it.
//
// A RESTORE NEVER DELETES. `read-tree` + `checkout-index -a -f` writes every
// file the checkpoint held back over the working tree. A file created AFTER
// the checkpoint is left where it is and **reported**, with the command to
// remove it if that is what the human wants. Automatically deleting a file
// the human might have written by hand, in the name of undo, is a much worse
// failure than an incomplete undo — and it would contradict the rule above.
//
// A RESTORE APPLIES THE REPOSITORY'S OWN CHECKOUT RULES, because it is a
// checkout: on a machine with `core.autocrlf=true`, restored files come back
// with the line endings that repository would normally check out. That is
// git behaving as configured rather than a bug here, but it is worth knowing
// before wondering why a restored file's bytes are not identical.
//
// A RESTORE IS ITSELF CHECKPOINTED first, so a rewind can be un-rewound.
// `.gitignore` is respected throughout, because `add -A` respects it: a
// checkpoint never contains `node_modules` or `.lykos/ledger.db`.

import { join } from "node:path";
import type { LykosEventSink } from "../extensions/api.js";
import { spawnGit, type GitRun, type GitRunner } from "../git/host-git.js";

export const CHECKPOINT_REF = "refs/lykos/checkpoints";
const CHECKPOINT_INDEX = "lykos-checkpoint-index";
const RESTORE_INDEX = "lykos-restore-index";

// T170: the host git helper owns the runner, so hooks and fsmonitor stay off.
export { spawnGit, type GitRun, type GitRunner };

export interface CheckpointDeps {
  cwd: string;
  git?: GitRunner;
  /**
   * P10.9 (ticket 21, D2): where `checkpoint_written` fires from.
   *
   * It is on the deps rather than a parameter because every caller already
   * threads this object, and because the sink is the session's: the type it
   * carries (`LykosEventSink`) can emit and nothing else, so this module
   * cannot register a handler or reach another extension by holding it.
   */
  events?: LykosEventSink;
  /**
   * P4 T146: the session this checkpoint belongs to, read at the moment the
   * checkpoint is written. A function because the session's id does not
   * exist until Pi creates the session, which is after the harness that
   * takes the checkpoints was built. Absent, or returning undefined, writes
   * a checkpoint with no session — which is what `lykos rewind --now` and a
   * rewind's own safety checkpoint are.
   */
  session?: () => string | undefined;
}

/**
 * P4 T146: what a checkpoint records about where it came from, beyond its
 * label. Stored IN the checkpoint's own commit message as git trailers
 * (`Lykos-Session:`, `Lykos-Turn:`), so a checkpoint ties back to its
 * session without a second index that could drift from the ref.
 */
export interface CheckpointMeta {
  /** 0-based, counted across the whole session (Pi's own `turnIndex` restarts at every prompt). */
  turn?: number;
  /**
   * Commit this tree rather than the working tree. Used when a turn started
   * on a tree identical to the last checkpoint (`unchanged`, so no commit
   * then) and later changed a file: the turn still gets a checkpoint of its
   * own, holding exactly the tree it started from.
   */
  tree?: string;
}

const SESSION_TRAILER = "Lykos-Session";
const TURN_TRAILER = "Lykos-Turn";

/** Is this a git repository at all? Everything here is a no-op if not. */
export function isGitRepo(deps: CheckpointDeps): boolean {
  const git = deps.git ?? spawnGit;
  return git(["rev-parse", "--git-dir"], deps.cwd).ok;
}

function gitDir(deps: CheckpointDeps): string | undefined {
  const git = deps.git ?? spawnGit;
  const result = git(["rev-parse", "--absolute-git-dir"], deps.cwd);
  return result.ok ? result.stdout : undefined;
}

/**
 * T156: the working tree as one tree hash — tracked and untracked-but-not-
 * ignored files, what `add -A` captures — or undefined outside a git
 * repository. Written through the checkpoint's scratch index, never the
 * user's. Two equal fingerprints mean nothing
 * git would see changed; it writes blobs to the object store and nothing else.
 */
export function workingTreeFingerprint(deps: CheckpointDeps): string | undefined {
  const git = deps.git ?? spawnGit;
  const dir = gitDir(deps);
  if (dir === undefined) return undefined;
  // The checkpoint's own scratch index: both do `add -A` + `write-tree`, so
  // sharing it keeps git's stat cache warm for each. A fresh index made the
  // first fingerprint in a session hash every file (measured: 2063 ms on a
  // 2164-file repository, against 16-25 ms warm).
  const indexEnv = { GIT_INDEX_FILE: join(dir, CHECKPOINT_INDEX) };
  if (!git(["add", "-A"], deps.cwd, indexEnv).ok) return undefined;
  const written = git(["write-tree"], deps.cwd, indexEnv);
  return written.ok ? written.stdout : undefined;
}

export type CheckpointResult =
  | { status: "created"; commit: string; label: string }
  /** Nothing changed since the last checkpoint, so no commit was made. `tree` is the tree that was found. */
  | { status: "unchanged"; tree: string }
  | { status: "skipped"; reason: string };

/**
 * Takes a checkpoint of the working tree.
 *
 * Returns `unchanged` when the tree is byte-identical to the last
 * checkpoint's — which is the common case at the start of a turn where the
 * model only read things, and is why this can run on every turn without
 * filling the object store with duplicates.
 */
export function createCheckpoint(deps: CheckpointDeps, label: string, meta: CheckpointMeta = {}): CheckpointResult {
  const git = deps.git ?? spawnGit;
  const dir = gitDir(deps);
  if (dir === undefined) return { status: "skipped", reason: "not a git repository" };

  let tree: string;
  if (meta.tree !== undefined) {
    tree = meta.tree;
  } else {
    const indexEnv = { GIT_INDEX_FILE: join(dir, CHECKPOINT_INDEX) };
    // `add -A` against a scratch index: the user's own index is never read and
    // never written, so a half-staged change survives untouched.
    const added = git(["add", "-A"], deps.cwd, indexEnv);
    if (!added.ok) return { status: "skipped", reason: `git add failed: ${added.stderr}` };

    const written = git(["write-tree"], deps.cwd, indexEnv);
    if (!written.ok) return { status: "skipped", reason: `git write-tree failed: ${written.stderr}` };
    tree = written.stdout;
  }

  const parent = git(["rev-parse", "--verify", "--quiet", CHECKPOINT_REF], deps.cwd);
  if (meta.tree === undefined && parent.ok && parent.stdout.length > 0) {
    const parentTree = git(["rev-parse", `${CHECKPOINT_REF}^{tree}`], deps.cwd);
    if (parentTree.ok && parentTree.stdout === tree) return { status: "unchanged", tree };
  }

  // T146: the session and turn ride in the commit message as trailers — the
  // checkpoint's own record. A checkpoint with neither is written exactly as
  // before, so `lykos rewind --now` and pre-T146 checkpoints look alike.
  const session = deps.session?.();
  const trailers = [
    ...(session !== undefined ? [`${SESSION_TRAILER}: ${session}`] : []),
    ...(meta.turn !== undefined ? [`${TURN_TRAILER}: ${meta.turn}`] : []),
  ];
  const message = trailers.length > 0 ? `${label}\n\n${trailers.join("\n")}` : label;
  const args = ["commit-tree", tree, "-m", message];
  if (parent.ok && parent.stdout.length > 0) args.push("-p", parent.stdout);
  // An identity is supplied rather than borrowed: a checkpoint is not the
  // user's commit and must never be attributed to them, and a repo with no
  // configured user.email would otherwise fail here for no reason.
  const commit = git(args, deps.cwd, {
    GIT_AUTHOR_NAME: "lykos",
    GIT_AUTHOR_EMAIL: "lykos@localhost",
    GIT_COMMITTER_NAME: "lykos",
    GIT_COMMITTER_EMAIL: "lykos@localhost",
  });
  if (!commit.ok) return { status: "skipped", reason: `git commit-tree failed: ${commit.stderr}` };

  const updated = git(["update-ref", CHECKPOINT_REF, commit.stdout], deps.cwd);
  if (!updated.ok) return { status: "skipped", reason: `git update-ref failed: ${updated.stderr}` };
  // D2: fired here and only here — after the ref actually moved. An
  // `unchanged` turn wrote no commit and a `skipped` one wrote nothing at all,
  // and an event on either would be announcing a checkpoint that does not
  // exist. Both values in the payload are the ones this function just
  // computed; nothing is derived a second time.
  deps.events?.emit("checkpoint_written", { commit: commit.stdout, label });
  return { status: "created", commit: commit.stdout, label };
}

export interface CheckpointEntry {
  commit: string;
  label: string;
  /** ISO 8601, from the commit's own author date. */
  at: string;
  /** 0 is the most recent. What `lykos rewind <n>` takes; it shifts as checkpoints are written, the hash does not. */
  index: number;
  /** T146: the session that wrote it. Absent on a manual checkpoint and on every checkpoint written before T146. */
  session?: string;
  /** T146: the session-wide turn it was taken before. Absent on a manual checkpoint and before T146. */
  turn?: number;
}

/** Record and field separators in the `git log` format; neither occurs in a message Lykos writes. */
const RS = "\x1e";
const FS = "\x1f";
const LOG_FORMAT = `--format=%H${FS}%aI${FS}%B${RS}`;
const SESSION_LINE = new RegExp(`^${SESSION_TRAILER}: *(\\S+) *$`, "m");
const TURN_LINE = new RegExp(`^${TURN_TRAILER}: *(\\d+) *$`, "m");

/** Parses `LOG_FORMAT` output. A message with no trailers — every pre-T146 checkpoint — parses to label only. */
function parseEntries(stdout: string): CheckpointEntry[] {
  return stdout
    .split(RS)
    .map((record) => record.replace(/^\s+/, ""))
    .filter((record) => record.length > 0)
    .map((record, index) => {
      const [commit = "", at = "", body = ""] = record.split(FS);
      const label = (body.split("\n")[0] ?? "").trim();
      const session = SESSION_LINE.exec(body)?.[1];
      const turn = TURN_LINE.exec(body)?.[1];
      return {
        commit,
        at,
        label,
        index,
        ...(session !== undefined ? { session } : {}),
        ...(turn !== undefined ? { turn: Number(turn) } : {}),
      };
    });
}

export function listCheckpoints(deps: CheckpointDeps, limit = 50): CheckpointEntry[] {
  const git = deps.git ?? spawnGit;
  const log = git(["log", `--max-count=${limit}`, LOG_FORMAT, CHECKPOINT_REF], deps.cwd);
  if (!log.ok || log.stdout.length === 0) return [];
  return parseEntries(log.stdout);
}

/**
 * T146: every checkpoint one session wrote, newest first, each with the
 * index `lykos rewind <n>` takes for it. Reads the whole ref, because a
 * session's checkpoints can sit behind any number of later ones, and matches
 * on the checkpoint's own session trailer, never on its label.
 */
export function checkpointsForSession(deps: CheckpointDeps, sessionId: string): CheckpointEntry[] {
  const git = deps.git ?? spawnGit;
  const log = git(["log", LOG_FORMAT, CHECKPOINT_REF], deps.cwd);
  if (!log.ok || log.stdout.length === 0) return [];
  return parseEntries(log.stdout).filter((e) => e.session === sessionId);
}

/** T165: the shortest hash prefix `lykos rewind` accepts — git's own minimum abbreviation. */
export const MIN_HASH_PREFIX = 4;
/** T165: how many hex characters `lykos show` and the listing print for a checkpoint. */
export const SHORT_HASH_LENGTH = 8;

export function shortHash(commit: string): string {
  return commit.slice(0, SHORT_HASH_LENGTH);
}

/**
 * T165: finds the checkpoint a hash prefix names, among every checkpoint on
 * the ref and nothing else — an arbitrary commit that happens to share the
 * prefix is not a checkpoint and is never restored. A prefix naming none, or
 * more than one, is an error that names what it matched.
 */
export function findCheckpointByHash(
  deps: CheckpointDeps,
  prefix: string,
): { entry: CheckpointEntry } | { error: string; matched: CheckpointEntry[] } {
  const wanted = prefix.toLowerCase();
  if (!/^[0-9a-f]+$/.test(wanted) || wanted.length < MIN_HASH_PREFIX) {
    return { error: `"${prefix}" is not a checkpoint hash (at least ${MIN_HASH_PREFIX} hex characters)`, matched: [] };
  }
  const git = deps.git ?? spawnGit;
  const log = git(["log", LOG_FORMAT, CHECKPOINT_REF], deps.cwd);
  const entries = log.ok && log.stdout.length > 0 ? parseEntries(log.stdout) : [];
  const matched = entries.filter((e) => e.commit.startsWith(wanted));
  if (matched.length === 1) return { entry: matched[0]! };
  if (matched.length === 0) {
    return { error: `no checkpoint ${prefix}; \`lykos rewind\` lists them`, matched };
  }
  return {
    error:
      `"${prefix}" is ambiguous: it names ${matched.length} checkpoints ` +
      `(${matched.map((e) => shortHash(e.commit)).join(", ")}); give more of the hash`,
    matched,
  };
}

export type RestoreResult =
  | {
      status: "restored";
      commit: string;
      label: string;
      /** Files present now that the checkpoint did not have. Left alone; reported. */
      extras: string[];
      /** The checkpoint taken of the CURRENT tree before restoring, so this is undoable. */
      safetyCommit: string | undefined;
    }
  | { status: "error"; message: string };

/**
 * Restores the working tree to a checkpoint.
 *
 * Takes a checkpoint of the current state first — a rewind that cannot itself
 * be rewound is a second way to lose work, and this project does not delete
 * what it runs.
 */
export function restoreCheckpoint(deps: CheckpointDeps, index: number): RestoreResult {
  if (gitDir(deps) === undefined) return { status: "error", message: "not a git repository" };

  // D14: read exactly as far as the index asked for. The listing's default
  // page of 50 made any older checkpoint unreachable, and a short read here
  // is also the true count, so the error below states the ref's length.
  const entries = listCheckpoints(deps, index + 1);
  const target = entries[index];
  if (target === undefined) {
    return {
      status: "error",
      message:
        entries.length === 0
          ? "no checkpoints yet — they are taken at the start of each turn of a Lykos session"
          : `no checkpoint ${index}; there are ${entries.length} (0 is the most recent)`,
    };
  }
  return restoreCheckpointEntry(deps, target);
}

/**
 * T165: restores the checkpoint a hash prefix names. An unknown or ambiguous
 * prefix restores nothing, and takes no safety checkpoint either.
 */
export function restoreCheckpointByHash(deps: CheckpointDeps, prefix: string): RestoreResult {
  if (gitDir(deps) === undefined) return { status: "error", message: "not a git repository" };
  const found = findCheckpointByHash(deps, prefix);
  if ("error" in found) return { status: "error", message: found.error };
  return restoreCheckpointEntry(deps, found.entry);
}

function restoreCheckpointEntry(deps: CheckpointDeps, target: CheckpointEntry): RestoreResult {
  const git = deps.git ?? spawnGit;
  const dir = gitDir(deps);
  if (dir === undefined) return { status: "error", message: "not a git repository" };

  const safety = createCheckpoint(deps, `before rewind to ${target.commit.slice(0, 8)}`);
  const safetyCommit = safety.status === "created" ? safety.commit : undefined;

  const inCheckpoint = new Set(filesInTree(deps, target.commit));
  const inWorkingTree = filesInWorkingTree(deps);

  const indexEnv = { GIT_INDEX_FILE: join(dir, RESTORE_INDEX) };
  const read = git(["read-tree", target.commit], deps.cwd, indexEnv);
  if (!read.ok) return { status: "error", message: `git read-tree failed: ${read.stderr}` };
  const checkout = git(["checkout-index", "-a", "-f"], deps.cwd, indexEnv);
  if (!checkout.ok) return { status: "error", message: `git checkout-index failed: ${checkout.stderr}` };

  const extras = inWorkingTree.filter((f) => !inCheckpoint.has(f)).sort();
  return { status: "restored", commit: target.commit, label: target.label, extras, safetyCommit };
}

function filesInTree(deps: CheckpointDeps, commit: string): string[] {
  const git = deps.git ?? spawnGit;
  const result = git(["ls-tree", "-r", "--name-only", commit], deps.cwd);
  return result.ok && result.stdout.length > 0 ? result.stdout.split("\n") : [];
}

/**
 * Everything git would consider part of the project right now — tracked plus
 * untracked-but-not-ignored. The same set `add -A` would have captured, so
 * "in the working tree but not in the checkpoint" is an exact statement
 * rather than an approximation, and an ignored file can never appear as an
 * extra to delete.
 */
function filesInWorkingTree(deps: CheckpointDeps): string[] {
  const git = deps.git ?? spawnGit;
  const result = git(["ls-files", "--cached", "--others", "--exclude-standard"], deps.cwd);
  return result.ok && result.stdout.length > 0 ? result.stdout.split("\n") : [];
}

/** What `lykos rewind` prints for a restore. Rendering only — no git here. */
export function renderRestore(result: RestoreResult): string {
  if (result.status === "error") return `lykos rewind: ${result.message}`;
  const lines = [
    `lykos rewind: restored the working tree to ${result.commit.slice(0, 8)} — ${result.label}`,
  ];
  if (result.safetyCommit !== undefined) {
    lines.push(
      `  the state you had a moment ago is checkpoint ${shortHash(result.safetyCommit)} now, so this is undoable with \`lykos rewind ${shortHash(result.safetyCommit)}\``,
    );
  }
  if (result.extras.length > 0) {
    lines.push(
      "",
      `  ${result.extras.length} file(s) exist now that the checkpoint did not have. They were NOT deleted:`,
      ...result.extras.map((f) => `    ${f}`),
      "",
      "  Remove them yourself if that is what you meant — deleting a file you may have written by hand is not something a rewind should decide.",
    );
  }
  return lines.join("\n");
}

export function renderCheckpointList(entries: readonly CheckpointEntry[]): string {
  if (entries.length === 0) {
    return "lykos rewind: no checkpoints yet — they are taken at the start of each turn of a Lykos session";
  }
  const lines = [`lykos rewind: ${entries.length} checkpoint(s), newest first`];
  for (const e of entries) {
    // T146: the session a checkpoint belongs to, so it can be read back with
    // `lykos show`. One that never recorded a session says so.
    const owner =
      e.session === undefined
        ? "session (not recorded)"
        : `session ${e.session}${e.turn !== undefined ? ` turn ${e.turn}` : ""}`;
    lines.push(`  ${String(e.index).padStart(2)}  ${e.commit.slice(0, 8)}  ${e.at}  ${e.label}  [${owner}]`);
  }
  lines.push(
    "",
    "Restore one with `lykos rewind <hash>` (or its number, which shifts as new checkpoints are written). " +
      "Nothing is deleted: the current state is checkpointed first.",
  );
  return lines.join("\n");
}
