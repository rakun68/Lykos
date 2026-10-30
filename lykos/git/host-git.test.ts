// T170: the host git helper, proven against real repositories with a planted
// hook and a planted `core.fsmonitor` command. Each protection has a positive
// control: the same git, run plainly, DOES execute the plant, so a test that
// passes is not passing because the plant never worked.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, it } from "node:test";
import { gitStateNotice, hostGit, probeGit } from "./host-git.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "lykos-hostgit-"));
  dirs.push(d);
  return d;
}

function plainGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A repository whose `pre-commit` hook and `core.fsmonitor` command each write a marker. */
function plantedRepo(): { dir: string; hookMarker: string; fsmonitorMarker: string } {
  const dir = tmp();
  plainGit(dir, "init", "-q");
  plainGit(dir, "config", "user.email", "t@t");
  plainGit(dir, "config", "user.name", "t");
  plainGit(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "one\n");
  const hookMarker = join(dir, "hook-ran");
  const fsmonitorMarker = join(dir, "fsmonitor-ran");
  const hook = join(dir, ".git", "hooks", "pre-commit");
  mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
  writeFileSync(hook, `#!/bin/sh\necho ran > "${hookMarker.replaceAll(sep, "/")}"\n`, { mode: 0o755 });
  const script = join(dir, ".git", "fsm.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(fsmonitorMarker)}, "ran");\n`);
  plainGit(dir, "config", "core.fsmonitor", `node "${script.replaceAll(sep, "/")}"`);
  return { dir, hookMarker, fsmonitorMarker };
}

describe("probeGit (T170)", () => {
  it("reports repo with the git directory and work tree", () => {
    const dir = tmp();
    plainGit(dir, "init", "-q");
    const probe = probeGit(dir);
    assert.equal(probe.state, "repo");
    assert.ok(probe.gitDir?.replaceAll(sep, "/").endsWith("/.git"), probe.gitDir);
    assert.ok(probe.workTree !== undefined);
  });

  it("reports not-a-repo for a folder without one", () => {
    assert.equal(probeGit(tmp()).state, "not-a-repo");
  });

  it("reports git-missing, distinct from not-a-repo, when git is not on PATH", () => {
    const dir = tmp();
    plainGit(dir, "init", "-q");
    const empty = tmp();
    const saved = process.env.PATH;
    process.env.PATH = empty;
    try {
      // A fresh folder: a repository found earlier is remembered, which is the
      // point, and would hide the missing binary.
      assert.equal(probeGit(tmp()).state, "git-missing");
      assert.equal(hostGit(["status"], tmp()).state, "git-missing");
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe("hostGit ignores what the repository configured to run (T170)", () => {
  it("does not run a pre-commit hook (positive control: plain git does)", () => {
    const { dir, hookMarker } = plantedRepo();
    plainGit(dir, "add", "-A");
    plainGit(dir, "commit", "-q", "-m", "control");
    assert.ok(existsSync(hookMarker), "control: plain git runs the planted hook");
    rmSync(hookMarker);

    writeFileSync(join(dir, "a.txt"), "two\n");
    const added = hostGit(["add", "-A"], dir);
    assert.equal(added.ok, true, added.stderr);
    const committed = hostGit(["commit", "-q", "-m", "protected"], dir);
    assert.equal(committed.ok, true, committed.stderr);
    assert.equal(existsSync(hookMarker), false, "the hook must not run under hostGit");
  });

  it("does not run core.fsmonitor (positive control: plain git does)", () => {
    const { dir, fsmonitorMarker } = plantedRepo();
    plainGit(dir, "add", "-A");
    plainGit(dir, "status");
    assert.ok(existsSync(fsmonitorMarker), "control: plain git runs the planted fsmonitor");
    rmSync(fsmonitorMarker);

    const status = hostGit(["status", "--porcelain"], dir);
    assert.equal(status.ok, true, status.stderr);
    assert.equal(existsSync(fsmonitorMarker), false, "fsmonitor must not run under hostGit");
  });

  it("still works from a subdirectory, listing the whole repository from its root view", () => {
    const dir = tmp();
    plainGit(dir, "init", "-q");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "b.txt"), "x");
    plainGit(dir, "add", "-A");
    const out = hostGit(["ls-files"], join(dir, "sub"));
    assert.equal(out.ok, true, out.stderr);
    assert.equal(out.stdout, "b.txt");
  });

  it("outside a repository runs nothing and says not-a-repo", () => {
    const run = hostGit(["status"], tmp());
    assert.equal(run.ok, false);
    assert.equal(run.state, "not-a-repo");
  });
});

describe("gitStateNotice (T170)", () => {
  it("has no notice for a repository and distinct words for the two failures", () => {
    assert.equal(gitStateNotice("repo"), undefined);
    assert.match(gitStateNotice("not-a-repo")!, /not a git repository/);
    assert.match(gitStateNotice("git-missing")!, /git is not installed/);
    assert.doesNotMatch(gitStateNotice("git-missing")!, /not a git repository/);
  });
});
