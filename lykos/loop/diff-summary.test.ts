// T167 R1 (ADR-0030): `sessionChangedPaths`, the git half of what the gate's
// rerun treats as edited by the session. Against a real temporary repository,
// because the answer is git's and a stubbed runner would only test the stub.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sessionChangedPaths } from "./diff-summary.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
}

/** A repository with `a.txt`, `b.txt` and `sub/c.txt` committed, and the boot commit. */
function repo(): { dir: string; boot: string } {
  const dir = mkdtempSync(join(tmpdir(), "lykos-changed-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "a.txt"), "a\n");
  writeFileSync(join(dir, "b.txt"), "b\n");
  writeFileSync(join(dir, "sub", "c.txt"), "c\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@lykos.test");
  git(dir, "config", "user.name", "T");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "boot");
  return { dir, boot: git(dir, "rev-parse", "HEAD") };
}

describe("sessionChangedPaths (T167 R1)", () => {
  it("names modified, staged, untracked and committed-since-boot files, and leaves out .lykos/", () => {
    const { dir, boot } = repo();
    writeFileSync(join(dir, "a.txt"), "a2\n");
    writeFileSync(join(dir, "b.txt"), "b2\n");
    git(dir, "add", "b.txt");
    writeFileSync(join(dir, "new.txt"), "n\n");
    mkdirSync(join(dir, ".lykos"));
    writeFileSync(join(dir, ".lykos", "state.json"), "{}\n");
    writeFileSync(join(dir, "sub", "c.txt"), "c2\n");
    git(dir, "commit", "-q", "-m", "the session committed this", "--", "sub/c.txt");
    assert.deepEqual(sessionChangedPaths(dir, boot).sort(), ["a.txt", "b.txt", "new.txt", "sub/c.txt"]);
  });

  it("answers relative to cwd, inside a subdirectory of the repository", () => {
    const { dir, boot } = repo();
    writeFileSync(join(dir, "a.txt"), "a2\n");
    writeFileSync(join(dir, "sub", "c.txt"), "c2\n");
    writeFileSync(join(dir, "sub", "d.txt"), "d\n");
    assert.deepEqual(sessionChangedPaths(join(dir, "sub"), boot).sort(), ["c.txt", "d.txt"]);
  });

  it("an unusable boot head falls back to HEAD", () => {
    const { dir } = repo();
    writeFileSync(join(dir, "a.txt"), "a2\n");
    assert.deepEqual(sessionChangedPaths(dir, "no-git"), ["a.txt"]);
  });

  it("is empty outside a repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-nogit-"));
    writeFileSync(join(dir, "a.txt"), "a\n");
    assert.deepEqual(sessionChangedPaths(dir, undefined), []);
  });
});
