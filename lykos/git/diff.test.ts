// P5 #46: the diff viewer's three sources, against a real repository: everything since the default branch,
// only what is committed since it, and what is not committed yet.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { defaultBranch, workspaceDiff } from "./diff.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-diff-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  writeFileSync(join(dir, "gone.txt"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

describe("the workspace's changes for the diff viewer", () => {
  it("splits branch, committed and working, untracked files included where uncommitted work is", () => {
    const dir = repo();
    assert.deepEqual(defaultBranch(dir), { name: "main", ref: "main" });
    git(dir, "checkout", "-q", "-b", "feature");
    writeFileSync(join(dir, "a.txt"), "one\nTWO\n");
    git(dir, "rm", "-q", "gone.txt");
    git(dir, "commit", "-q", "-am", "change");
    writeFileSync(join(dir, "new.txt"), "fresh\nlines\n");
    writeFileSync(join(dir, "a.txt"), "one\nTWO\nthree\n");

    const committed = workspaceDiff(dir, "committed");
    assert.equal(committed.branch, "main");
    assert.deepEqual(committed.files.map((f) => [f.file, f.status, f.additions, f.deletions]), [["a.txt", "modified", 1, 1], ["gone.txt", "deleted", 0, 1]]);
    assert.match(committed.files[0]!.patch, /^-two\n\+TWO$/m);

    const working = workspaceDiff(dir, "working");
    assert.equal(working.base, "HEAD");
    assert.deepEqual(working.files.map((f) => [f.file, f.status, f.additions, f.deletions]), [["a.txt", "modified", 1, 0], ["new.txt", "added", 2, 0]]);
    assert.match(working.files[1]!.patch, /^\+fresh\n\+lines$/m);

    const branch = workspaceDiff(dir, "branch");
    assert.deepEqual(branch.files.map((f) => [f.file, f.additions, f.deletions]), [["a.txt", 2, 1], ["gone.txt", 0, 1], ["new.txt", 2, 0]]);
  });

  it("shows only untracked files before the first commit, and says when there is no base", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-diff-"));
    dirs.push(dir);
    git(dir, "init", "-q", "-b", "trunk");
    writeFileSync(join(dir, "x.txt"), "x\n");
    assert.deepEqual(workspaceDiff(dir, "working").files.map((f) => f.file), ["x.txt"]);
    assert.deepEqual(workspaceDiff(dir, "committed").files, []);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "first");
    assert.throws(() => workspaceDiff(dir, "branch"), /No review base available/);
  });
});
