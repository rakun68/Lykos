// The worktree manager, proven against real repositories. A writing delegated session works
// on a worktree and a branch of its own; the worktree is gone when the call ends and the
// branch stays.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { acquireWorktree, branchOf, WorktreeError } from "./worktree.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "lykos-worktree-"));
  dirs.push(d);
  return d;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repo(): string {
  const dir = tmp();
  git(dir, "init", "-q");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

const input = (workspace: string, root: string, sessionId = "s1") => ({ workspace, projectId: "proj", sessionId, root });

describe("a writing call works on a worktree of its own (T184)", () => {
  it("is created under <root>/<project>/<session> on a lykos/ branch, holds the files of HEAD, and leaves the caller's tree alone", () => {
    const workspace = repo();
    const root = tmp();
    const lease = acquireWorktree(input(workspace, root));
    try {
      assert.equal(lease.path, join(root, "proj", "s1"));
      assert.equal(lease.branch, "lykos/s1");
      assert.equal(branchOf("s1"), "lykos/s1");
      assert.equal(readFileSync(join(lease.path, "a.txt"), "utf8"), "one\n");
      writeFileSync(join(lease.path, "a.txt"), "two\n");
      writeFileSync(join(lease.path, "new.txt"), "fresh\n");
      assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "one\n", "the caller's file is untouched");
      assert.equal(existsSync(join(workspace, "new.txt")), false);
      assert.equal(git(workspace, "status", "--porcelain"), "", "the caller's tree is clean");
    } finally {
      lease.release();
    }
  });

  it("is removed when the call ends and the branch, with its commits, stays", () => {
    const workspace = repo();
    const root = tmp();
    const head = git(workspace, "rev-parse", "HEAD");
    const lease = acquireWorktree(input(workspace, root));
    writeFileSync(join(lease.path, "a.txt"), "two\n");
    git(lease.path, "commit", "-q", "-am", "Change a");
    const made = git(lease.path, "rev-parse", "HEAD");
    assert.deepEqual(lease.commits(), [{ sha: made, subject: "Change a" }]);
    lease.release();

    assert.equal(existsSync(lease.path), false, "the worktree directory is gone");
    assert.equal(git(workspace, "worktree", "list", "--porcelain").includes("s1"), false, "git no longer lists it");
    assert.equal(git(workspace, "rev-parse", "lykos/s1"), made, "the branch remains, at the work");
    assert.equal(git(workspace, "rev-parse", "HEAD"), head, "the caller's branch did not move");
    assert.equal(readFileSync(join(workspace, "a.txt"), "utf8"), "one\n");
  });

  it("a continuation recreates the worktree from the branch and adds commits to the same branch", () => {
    const workspace = repo();
    const root = tmp();
    const first = acquireWorktree(input(workspace, root));
    writeFileSync(join(first.path, "b.txt"), "from the first call\n");
    git(first.path, "add", "-A");
    git(first.path, "commit", "-q", "-m", "First call");
    first.release();

    const second = acquireWorktree(input(workspace, root));
    try {
      assert.equal(second.branch, "lykos/s1");
      assert.equal(readFileSync(join(second.path, "b.txt"), "utf8"), "from the first call\n", "the earlier work is back");
      writeFileSync(join(second.path, "c.txt"), "from the second call\n");
      git(second.path, "add", "-A");
      git(second.path, "commit", "-q", "-m", "Second call");
      assert.deepEqual(second.commits().map((c) => c.subject), ["Second call", "First call"]);
    } finally {
      second.release();
    }
    assert.equal(git(workspace, "log", "--format=%s", "lykos/s1").split("\n").slice(0, 3).join("|"), "Second call|First call|first");
  });

  it("two calls on one session cannot hold the worktree at once, and the lock is free again after release", () => {
    const workspace = repo();
    const root = tmp();
    const held = acquireWorktree(input(workspace, root));
    assert.throws(
      () => acquireWorktree(input(workspace, root)),
      (err: unknown) => err instanceof WorktreeError && err.kind === "busy" && /already/.test(err.message),
    );
    // A different session in the same project is not blocked.
    const other = acquireWorktree(input(workspace, root, "s2"));
    other.release();
    held.release();
    acquireWorktree(input(workspace, root)).release();
  });

  it("a lock left by a process that is gone is taken over", () => {
    const workspace = repo();
    const root = tmp();
    mkdirSync(join(root, "proj"), { recursive: true });
    writeFileSync(join(root, "proj", "s1.lock"), "2147483646\n");
    acquireWorktree(input(workspace, root)).release();
  });

  it("work left uncommitted is saved on the branch, not deleted with the worktree", () => {
    const workspace = repo();
    const root = tmp();
    const lease = acquireWorktree(input(workspace, root));
    writeFileSync(join(lease.path, "unsaved.txt"), "do not lose me\n");
    const released = lease.release();
    assert.equal(released.savedUncommitted, true);
    assert.equal(existsSync(lease.path), false);
    assert.equal(git(workspace, "show", "lykos/s1:unsaved.txt"), "do not lose me");
  });

  it("refuses in a folder that is not a repository, naming why", () => {
    assert.throws(
      () => acquireWorktree(input(tmp(), tmp())),
      (err: unknown) => err instanceof WorktreeError && err.kind === "not-a-repo",
    );
  });

  it("refuses a repository with no commit to branch from", () => {
    const empty = tmp();
    git(empty, "init", "-q");
    assert.throws(
      () => acquireWorktree(input(empty, tmp())),
      (err: unknown) => err instanceof WorktreeError && /no commit/.test(err.message),
    );
  });
});

describe("what the worktree keeps and refuses to destroy (T184 review)", () => {
  it("never deletes a directory it did not make: a session directory with files and no .git is refused", () => {
    const workspace = repo();
    const root = tmp();
    mkdirSync(join(root, "proj", "s1"), { recursive: true });
    writeFileSync(join(root, "proj", "s1", "precious.txt"), "mine\n");
    assert.throws(
      () => acquireWorktree(input(workspace, root)),
      (err: unknown) => err instanceof WorktreeError && /move it aside/.test(err.message),
    );
    assert.equal(readFileSync(join(root, "proj", "s1", "precious.txt"), "utf8"), "mine\n");
    assert.equal(existsSync(join(root, "proj", "s1.lock")), false, "the lock is not left behind");
    // An empty leftover is only ever Lykos's own: it is reused.
    rmSync(join(root, "proj", "s1", "precious.txt"));
    acquireWorktree(input(workspace, root)).release();
  });

  it("carries the project's untracked .pi and skills into the worktree, and nothing of the ledger or config", () => {
    const workspace = repo();
    const root = tmp();
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    writeFileSync(join(workspace, ".pi", "settings.json"), "{}\n");
    mkdirSync(join(workspace, ".lykos", "skills", "x"), { recursive: true });
    writeFileSync(join(workspace, ".lykos", "skills", "x", "SKILL.md"), "skill\n");
    writeFileSync(join(workspace, ".lykos", "config.yaml"), "gate:\n  enabled: false\n");
    writeFileSync(join(workspace, ".lykos", "ledger.db"), "not copied");
    const lease = acquireWorktree(input(workspace, root));
    try {
      assert.equal(readFileSync(join(lease.path, ".pi", "settings.json"), "utf8"), "{}\n");
      assert.equal(readFileSync(join(lease.path, ".lykos", "skills", "x", "SKILL.md"), "utf8"), "skill\n");
      assert.equal(existsSync(join(lease.path, ".lykos", "ledger.db")), false);
      assert.equal(existsSync(join(lease.path, ".lykos", "config.yaml")), false);
    } finally {
      const released = lease.release();
      assert.equal(released.savedUncommitted, false, "carried resources are not work to save");
    }
  });

  it("always removes the worktree, archiving the ignored files the session wrote and leaving caches out at any depth", () => {
    const workspace = repo();
    writeFileSync(join(workspace, ".gitignore"), "*.log\nnode_modules/\n*.tsbuildinfo\n.eslintcache\ndata/\nreport.txt\n");
    git(workspace, "add", "-A");
    git(workspace, "commit", "-q", "-m", "ignore things");
    const root = tmp();
    const lease = acquireWorktree(input(workspace, root));
    // Caches, top-level and nested.
    mkdirSync(join(lease.path, "node_modules", "x"), { recursive: true });
    writeFileSync(join(lease.path, "node_modules", "x", "i.js"), "cache\n");
    mkdirSync(join(lease.path, "pkg", "node_modules"), { recursive: true });
    writeFileSync(join(lease.path, "pkg", "node_modules", "n.js"), "cache\n");
    writeFileSync(join(lease.path, "pkg", "run.log"), "log\n");
    writeFileSync(join(lease.path, "tsconfig.tsbuildinfo"), "{}\n");
    writeFileSync(join(lease.path, ".eslintcache"), "{}\n");
    // Ignored files that are the session's own work: a file, and a directory holding a nested cache beside real data.
    writeFileSync(join(lease.path, "report.txt"), "findings\n");
    mkdirSync(join(lease.path, "data", "node_modules"), { recursive: true });
    writeFileSync(join(lease.path, "data", "rows.csv"), "1,2\n");
    writeFileSync(join(lease.path, "data", "node_modules", "c.js"), "cache\n");

    const released = lease.release();
    assert.equal(released.removed, true, released.note);
    assert.equal(existsSync(lease.path), false, "the worktree directory is gone");
    const archive = join(root, "proj", "s1.ignored");
    assert.match(released.note ?? "", /s1\.ignored/, "the note names where the ignored files are");
    assert.equal(readFileSync(join(archive, "report.txt"), "utf8"), "findings\n");
    assert.equal(readFileSync(join(archive, "data", "rows.csv"), "utf8"), "1,2\n");
    assert.equal(existsSync(join(archive, "data", "node_modules")), false, "a nested cache is not archived");
    for (const cache of ["node_modules", "pkg/node_modules", "tsconfig.tsbuildinfo", ".eslintcache"]) assert.equal(existsSync(join(archive, cache)), false, `${cache} is a cache`);
    assert.equal(readFileSync(join(archive, "pkg", "run.log"), "utf8"), "log\n", "a log is the session's own file, not a cache");
    assert.match(released.note ?? "", /caches left out, not saved: .*node_modules/, "the caches left out are named");

    // The next call on the session starts from nothing and, with only caches, leaves no archive and no note.
    const again = acquireWorktree(input(workspace, root));
    mkdirSync(join(again.path, "node_modules"), { recursive: true });
    writeFileSync(join(again.path, "node_modules", "z.js"), "cache\n");
    const second = again.release();
    assert.equal(second.removed, true);
    assert.doesNotMatch(second.note ?? "", /saved in/, "no archive when only caches were ignored");
    assert.match(second.note ?? "", /node_modules/, "but the cache that was dropped is named");
    assert.equal(existsSync(again.path), false);
  });

  it("archives a build-named directory that is not a package's output, and drops one that is", () => {
    const workspace = repo();
    writeFileSync(join(workspace, ".gitignore"), "build/\nreports/\n*.log\n");
    git(workspace, "add", "-A");
    git(workspace, "commit", "-q", "-m", "ignore things");
    const root = tmp();
    const lease = acquireWorktree(input(workspace, root));
    mkdirSync(join(lease.path, "build"), { recursive: true });
    writeFileSync(join(lease.path, "build", "out.js"), "x\n");
    mkdirSync(join(lease.path, "reports", "build"), { recursive: true });
    writeFileSync(join(lease.path, "reports", "build", "summary.md"), "findings\n");
    writeFileSync(join(lease.path, "run.log"), "evidence\n");
    const released = lease.release();
    const archive = join(root, "proj", "s1.ignored");
    assert.equal(released.removed, true, released.note);
    assert.equal(readFileSync(join(archive, "reports", "build", "summary.md"), "utf8"), "findings\n");
    assert.equal(readFileSync(join(archive, "run.log"), "utf8"), "evidence\n");
    assert.equal(existsSync(join(archive, "build")), false, "the root build directory is output");
    assert.match(released.note ?? "", /caches left out, not saved: build/);
  });

  it("keeps the worktree, and says so, when git cannot list the ignored files", () => {
    const workspace = repo();
    const root = tmp();
    const lease = acquireWorktree(input(workspace, root));
    rmSync(join(lease.gitDir, "HEAD"), { force: true }); // the worktree is no longer a repository: git cannot list anything
    const released = lease.release();
    assert.equal(released.removed, false);
    assert.match(released.note ?? "", /could not archive the ignored files/);
    assert.equal(existsSync(lease.path), true, "nothing was deleted");
  });

  it("describes the commit that saves leftover work so it can be recorded", () => {
    const workspace = repo();
    const root = tmp();
    const lease = acquireWorktree(input(workspace, root));
    writeFileSync(join(lease.path, "u1.txt"), "1\n");
    writeFileSync(join(lease.path, "u2.txt"), "2\n");
    const released = lease.release();
    assert.equal(released.saved?.sha, git(workspace, "rev-parse", "lykos/s1"));
    assert.equal(released.saved?.filesChanged, 2);
    assert.match(released.saved?.subject ?? "", /left uncommitted/);
  });
});
