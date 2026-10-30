// `commit`: record the session's work as a git commit, on the HOST.
//
// **Why it is a tool.** In a contained session `.git` is mounted read-only
// (T173), so the model's `bash` cannot commit and must not be able to: a
// writable `.git/hooks` or `.git/config` is how a container would reach the
// host. A commit is therefore made here, by the host, through the one protected
// git helper (T170, `git/host-git.ts`) that switches hooks and fsmonitor off.
// Committing is not a way back to the host.
//
// **Gated like `edit`.** It asks the gate with the `edit` kind, so the
// interaction mode decides whether it needs approval and a refusal reads the
// way an edit's does (`authorizeCommit`). It is `soft-write` in the registry,
// and it is resident when the session can write: a read-only child has the
// four read tools and nothing else, and a folder with no repository, or no git,
// does not get the tool at all (`loadTools`).
//
// **The person's index is theirs.** The commit is built in a SCRATCH index
// (`GIT_INDEX_FILE`) that starts as HEAD, not as a copy of theirs: the workspace
// (or the named files) is added to it, the protected directories are put back to
// HEAD in it, and `git commit` runs on it with no pathspec, so what the person
// staged elsewhere is not in the commit. (`git commit -- <paths>` is no
// alternative: it writes the real index too.) The real index is not touched
// until the commit exists, and then only to reset the committed paths to the new
// HEAD; any earlier failure leaves it exactly as it was. What the real index has
// staged inside the workspace, even a file `.gitignore` excludes, is carried into
// the commit so that reset cannot drop it.
//
// **One place where commits happen.** Each commit is appended to the session's
// `CommitLog`, which writes it to the ledger's `commits` table at once (P3's
// seal reads the same place).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { authorizeCommit, type ApprovalGate, type DenialLog } from "../gate/approval.js";
import { hostGit, type GitRun } from "../git/host-git.js";
import { stderrWrite } from "../tui/io-mode.js";
import { resolveEditPath } from "./edit.js";
import { isInsideWorkspace } from "./workspace-confine.js";

export const COMMIT_TOOL_NAME = "commit";

/**
 * The model-facing contract. Exported so `ledger/tool-catalog.ts` can be
 * asserted equal to it rather than re-typed beside it.
 */
export const COMMIT_DESCRIPTION =
  "Commit your work to git; returns the new commit's id. `paths` stages and commits only those files, otherwise " +
  "every change is committed. Asks a human first wherever an edit asks. Repository hooks do not run. Use this " +
  "rather than git commit in a shell: a contained session cannot write the repository.";

export const COMMIT_PARAMETERS = Type.Object({
  message: Type.String({ description: "Commit message: subject line, optionally a blank line and a body." }),
  paths: Type.Optional(
    Type.Array(Type.String(), { description: "Files to commit. Omit for every change." }),
  ),
});

export interface CommitParams {
  message: string;
  paths?: string[];
}

/** One commit a session made, as the ledger records it. */
export interface CommitRecord {
  sha: string;
  tsUtc: string;
  /** The first line of the message. */
  subject: string;
  /** The whole message. */
  message: string;
  /** `null` when it could not be computed: unmeasured, never a guess. */
  filesChanged: number | null;
  /** `paths` when the call named files, `all` when it committed every change. */
  scope: "paths" | "all";
}

/** The commits a session made, in order. Per session by construction: `loadTools` makes one. */
export class CommitLog {
  readonly records: CommitRecord[] = [];
  /**
   * `onCommit` is called the moment a commit is made, so a record is durable
   * before the session can die (the ledger has no `sessions` row for a session
   * that never reached its end, so waiting for the end loses the commit).
   */
  constructor(private readonly onCommit?: (record: CommitRecord) => void | Promise<void>) {}

  /**
   * Keeps the record and offers it to the sink. A sink that throws does not undo
   * the commit, which already exists in git: the failure is said on stderr and
   * returned, so the tool can tell the model.
   */
  async add(record: CommitRecord): Promise<string | undefined> {
    this.records.push(record);
    try {
      await this.onCommit?.(record);
      return undefined;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      stderrWrite(`lykos: could not record commit ${record.sha}: ${reason}\n`);
      return reason;
    }
  }
}

/**
 * Runtime state and tool config that "commit" never stages, whatever .gitignore says.
 * Note: Staging exclusions here remain [".lykos", ".pi"] (independent of container/host path protection
 * in path-rules.ts, as git commits should strictly exclude agent/tool runtime state rather than repo code).
 */
const PROTECTED_DIRS = [".lykos", ".pi"] as const;

/** Pathspec magic that matches the protected directories in any case, as git does under `core.ignorecase`. */
const PROTECTED_SPECS = PROTECTED_DIRS.map((d) => `:(icase)${d}`);
const PROTECTED_EXCLUDES = PROTECTED_DIRS.map((d) => `:(exclude,icase)${d}`);

/** The sha from `git commit`'s "[branch (root-commit) 1a2b3c4] subject" line: short, but better than none. */
function shaFromCommitOutput(output: string): string | undefined {
  return /^\[.*? ([0-9a-f]{7,40})\]/m.exec(output)?.[1];
}

/**
 * Case-insensitive: git on Windows and macOS (`core.ignorecase`) matches
 * `.Lykos/` to `.lykos/`, and a check that only the exact spelling passes is
 * a check the model can spell around.
 */
function isProtected(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return PROTECTED_DIRS.some((d) => lower === d || lower.startsWith(`${d}/`));
}

/** A host git run. `raw` keeps stdout byte for byte (NUL-separated output). */
export type CommitGit = (args: string[], cwd: string, env?: NodeJS.ProcessEnv, options?: { raw?: boolean }) => GitRun;

/** Paths per `git add` when carrying the person's staging into the scratch index (command lines have a length limit). */
const FORCE_ADD_BATCH = 100;

export interface CommitToolOpts {
  cwd: string;
  gate: ApprovalGate;
  denials?: DenialLog;
  log: CommitLog;
  /** Injectable for a test; the default is the protected host helper. */
  git?: CommitGit;
}

function text(s: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text" as const, text: s }];
}

/** Pi hands a thrown message back to the model as an error result; a returned `isError` is not read. */
function failure(message: string): never {
  throw new Error(`lykos commit: ${message}`);
}

function gitFailure(what: string, run: GitRun): string {
  const detail = (run.stderr !== "" ? run.stderr : run.stdout).trim();
  return `${what} failed${detail !== "" ? `: ${detail}` : "."}`;
}

export function buildCommitTool(opts: CommitToolOpts): ToolDefinition {
  const git: CommitGit =
    opts.git ?? ((args, cwd, env, options) => hostGit(args, cwd, { ...(env !== undefined ? { env } : {}), ...(options?.raw === true ? { raw: true } : {}) }));
  return defineTool({
    name: COMMIT_TOOL_NAME,
    label: "Commit",
    description: COMMIT_DESCRIPTION,
    promptSnippet: "Commit your work to git on the host",
    promptGuidelines: ["Commit when a coherent piece of work is finished and verified, with a message that says why."],
    parameters: COMMIT_PARAMETERS,
    async execute(_toolCallId, params) {
      const raw = params as CommitParams;
      const message = typeof raw.message === "string" ? raw.message.trim() : "";
      if (message === "") failure("a commit needs a `message`.");
      const given = Array.isArray(raw.paths) ? raw.paths.filter((p) => typeof p === "string" && p !== "") : [];
      for (const path of given) {
        if (!isInsideWorkspace(opts.cwd, resolveEditPath(path, opts.cwd))) {
          failure(`${path} is outside the workspace (${opts.cwd}). Name a path inside the workspace.`);
        }
      }
      // Pathspecs relative to the project, with forward slashes: git reads them that way on every platform.
      const paths = given.map((p) => relative(opts.cwd, resolveEditPath(p, opts.cwd)).split("\\").join("/"));
      for (const path of paths) {
        if (isProtected(path)) failure(`${path} is Lykos runtime state or tool config and is never committed.`);
      }
      const scope: CommitRecord["scope"] = paths.length > 0 ? "paths" : "all";
      // Named files are literal, so a file called `*.ts` or `:(top)x` is that file and not a pattern.
      // "Every change" is the WORKSPACE (hostGit's work tree is the repository top, which may be above it)
      // minus the protected directories, by exclude magic, so literal handling is off for it.
      const only = paths.length > 0 ? ["--literal-pathspecs"] : [];
      const confine = ["--", ...(paths.length > 0 ? paths : [".", ...PROTECTED_EXCLUDES])];

      await authorizeCommit(
        opts.cwd,
        opts.gate,
        `commit: ${message.split("\n")[0]}`,
        paths.length > 0 ? paths.join(", ") : "every change in the workspace",
        message,
        opts.denials,
      );

      const scratch = mkdtempSync(join(tmpdir(), "lykos-commit-"));
      const next = { GIT_INDEX_FILE: join(scratch, "index") };
      let sha: string | undefined;
      let files: string[] | undefined;
      let notes = "";
      try {
        // The commit is built in a scratch index that starts as HEAD, not as a copy of the person's index:
        // what they have staged elsewhere is not part of this commit, and `git commit -- <paths>` (--only)
        // would write the real index as well. Nothing below touches the real one until the commit exists.
        const born = git(["rev-parse", "--verify", "-q", "HEAD"], opts.cwd).ok;
        const seeded = git(["read-tree", ...(born ? ["HEAD"] : ["--empty"])], opts.cwd, next);
        if (!seeded.ok) failure(gitFailure("preparing the commit", seeded));

        const staged = git([...only, "add", "-A", "--", ...(paths.length > 0 ? paths : ["."])], opts.cwd, next);
        if (!staged.ok) failure(gitFailure("staging", staged));
        if (paths.length === 0) {
          // What the person has staged inside the workspace is part of "every change" even when .gitignore keeps
          // `add -A` from seeing it (a file they `git add -f`ed): without it the sync below would unstage it unseen.
          const theirs = git(["-c", "core.quotePath=false", "diff", "--cached", "--name-only", "--relative", "-z", "--no-renames", "--diff-filter=d", ...confine], opts.cwd, undefined, { raw: true });
          if (!theirs.ok) failure(gitFailure("reading what you have staged", theirs));
          const names = theirs.stdout.split(String.fromCharCode(0)).filter((n) => n !== "");
          for (let i = 0; i < names.length; i += FORCE_ADD_BATCH) {
            const forced = git(["--literal-pathspecs", "add", "-f", "-A", "--", ...names.slice(i, i + FORCE_ADD_BATCH)], opts.cwd, next);
            if (!forced.ok) failure(gitFailure("staging what you had staged", forced));
          }
        }
        if (paths.length === 0) {
          // `git add` given an exclude pathspec for a directory .gitignore also ignores exits 1 on git 2.30, so
          // the workspace is added whole and the protected directories are put back to HEAD, in the scratch index.
          const unstaged = git(["reset", "-q", "--", ...PROTECTED_SPECS], opts.cwd, next);
          if (!unstaged.ok) failure(gitFailure("leaving Lykos's own directories out", unstaged));
        }
        // Exit 0 means the scratch index equals HEAD: there is nothing to record.
        const pending = git(["diff", "--cached", "--quiet"], opts.cwd, next);
        if (pending.ok) failure("nothing to commit — no change in " + (paths.length > 0 ? paths.join(", ") : "the workspace") + ".");

        // Signing is configuration the repository controls (`gpg.program` is a program to run), so it is off.
        const made = git(["-c", "commit.gpgsign=false", "commit", "-m", message], opts.cwd, next);
        if (!made.ok) failure(gitFailure("git commit", made));

        // Only now bring the REAL index up to date for the committed paths: they are, by construction, what HEAD
        // now has. Whatever the person staged elsewhere, or under `.lykos/` and `.pi/`, is not matched.
        const synced = git([...only, "reset", "-q", ...confine], opts.cwd);
        if (!synced.ok) notes += `\nlykos: the commit was made, but your index could not be brought up to date: ${synced.stderr}`;

        // The commit exists. Its id is the full one from rev-parse (asked twice) or the abbreviated one `git commit`
        // itself printed; both are real, and `git show` resolves either. If neither can be read nothing is made up.
        let head = git(["rev-parse", "HEAD"], opts.cwd);
        if (!head.ok || head.stdout === "") head = git(["rev-parse", "HEAD"], opts.cwd);
        const printed = shaFromCommitOutput(made.stdout);
        if (head.ok && head.stdout !== "") sha = head.stdout;
        else if (printed !== undefined) {
          sha = printed;
          notes += "\nlykos: the commit was made, but only its abbreviated id could be read.";
        }
        if (sha !== undefined) {
          const changed = git(["show", "--name-only", "--no-renames", "--format=", sha], opts.cwd);
          if (changed.ok) files = changed.stdout.split(/\r?\n/).filter((l) => l !== "");
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }

      const subject = message.split("\n")[0]!;
      if (sha === undefined) {
        // Not recorded rather than recorded with an invented id (AGENTS.md rule 4).
        stderrWrite("lykos: a commit was made but its id could not be read, so it is not recorded in the ledger\n");
        return {
          content: text(`Committed: ${subject}\nlykos: the commit was made, but its id could not be read, so it is not recorded; check ${"`"}git log${"`"}.${notes}`),
          details: { subject, sha: null, files: null } as Record<string, unknown>,
        };
      }
      const ledgerFailure = await opts.log.add({
        sha,
        tsUtc: new Date().toISOString(),
        subject,
        message,
        filesChanged: files?.length ?? null,
        scope,
      });
      const counted = files === undefined ? "files unmeasured" : `${files.length} ${files.length === 1 ? "file" : "files"}`;
      const ledgerNote =
        ledgerFailure !== undefined ? `\nlykos: the commit was made, but recording it in the ledger failed: ${ledgerFailure}` : "";
      return {
        content: text(`Committed ${sha}: ${subject} (${counted})${notes}${ledgerNote}`),
        details: { sha, subject, files: files ?? null } as Record<string, unknown>,
      };
    },
  });
}
