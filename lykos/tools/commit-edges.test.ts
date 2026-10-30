// T179 round 4 — the edges of `commit` against real git: case-insensitive
// protected directories, a force-added ignored file, an unreadable HEAD after a
// good commit, an unborn HEAD, a deleted named path, and the scratch index
// being cleaned up. (Index preservation is commit-index.test.ts.)

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from "../gate/approval.js";
import { hostGit } from "../git/host-git.js";
import { CommitLog, buildCommitTool, type CommitGit } from "./commit.js";

class AllowGate implements ApprovalGate {
  async request(_req: ApprovalRequest): Promise<ApprovalDecision> {
    return "allow";
  }
}

const real: CommitGit = (args, cwd, env, options) =>
  hostGit(args, cwd, { ...(env !== undefined ? { env } : {}), ...(options?.raw === true ? { raw: true } : {}) });

function repo(opts: { commit?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lykos-commit-edges-"));
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  sh("init", "-q", "-b", "main");
  sh("config", "user.email", "t@lykos.test");
  sh("config", "user.name", "T");
  sh("config", "commit.gpgsign", "false");
  sh("config", "core.autocrlf", "false");
  sh("config", "core.ignorecase", "true");
  if (opts.commit !== false) {
    writeFileSync(join(root, "kept.txt"), "one\n");
    writeFileSync(join(root, "gone.txt"), "one\n");
    sh("add", "-A");
    sh("commit", "-q", "-m", "fixture");
  }
  return { root, sh };
}

async function commitIn(cwd: string, params: Record<string, unknown>, git: CommitGit = real, log = new CommitLog()) {
  const tool = buildCommitTool({ cwd, gate: new AllowGate(), log, git });
  try {
    const out = (await tool.execute("id", params as never, undefined, undefined, undefined as never)) as { content: Array<{ text: string }> };
    return { isError: false, text: out.content[0]!.text, log };
  } catch (err) {
    return { isError: true, text: (err as Error).message, log };
  }
}

describe("commit: protected directories in any case, 'every change' (T179)", () => {
  it("never commits .Lykos or .PI, however they are spelled", async () => {
    const { root, sh } = repo();
    mkdirSync(join(root, ".Lykos"), { recursive: true });
    mkdirSync(join(root, ".PI"), { recursive: true });
    writeFileSync(join(root, ".Lykos", "x"), "state\n");
    writeFileSync(join(root, ".PI", "y"), "tool config\n");
    writeFileSync(join(root, "kept.txt"), "two\n");
    const out = await commitIn(root, { message: "Work" });
    assert.equal(out.isError, false, out.text);
    assert.equal(sh("show", "--name-only", "--format=", "HEAD"), "kept.txt");
    const left = sh("status", "--porcelain", "--untracked-files=all");
    assert.match(left, /\.Lykos\/x/);
    assert.match(left, /\.PI\/y/);
  });
});

describe("commit: what the person force-added (T179)", () => {
  it("includes a staged file .gitignore excludes, and does not unstage it unseen", async () => {
    const { root, sh } = repo();
    writeFileSync(join(root, ".gitignore"), "forced.txt\n");
    sh("add", ".gitignore");
    sh("commit", "-q", "-m", "ignore");
    writeFileSync(join(root, "forced.txt"), "mine\n");
    sh("add", "-f", "forced.txt");
    writeFileSync(join(root, "kept.txt"), "two\n");
    const out = await commitIn(root, { message: "With the forced file" });
    assert.equal(out.isError, false, out.text);
    assert.equal(sh("show", "--name-only", "--format=", "HEAD").split("\n").sort().join(","), "forced.txt,kept.txt");
    assert.equal(sh("status", "--porcelain"), "");
  });
});

describe("commit: the id cannot be read after a good commit (T179)", () => {
  it("still records the commit, with the short id git printed", async () => {
    const { root, sh } = repo();
    writeFileSync(join(root, "kept.txt"), "two\n");
    const blind: CommitGit = (args, cwd, env, options) =>
      args[0] === "rev-parse" && args[1] === "HEAD" ? { ok: false, stdout: "", stderr: "no head" } : real(args, cwd, env, options);
    const out = await commitIn(root, { message: "Blind" }, blind);
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, /only its abbreviated id could be read/);
    assert.equal(out.log.records.length, 1, "the commit is recorded");
    const full = sh("rev-parse", "HEAD");
    assert.ok(full.startsWith(out.log.records[0]!.sha), "the recorded id is the real commit's");
    assert.equal(out.log.records[0]!.filesChanged, 1);
  });
});

describe("commit: unborn HEAD, deleted paths, scratch index (T179)", () => {
  it("makes the first commit in an empty repository", async () => {
    const { root, sh } = repo({ commit: false });
    writeFileSync(join(root, "first.txt"), "hello\n");
    const out = await commitIn(root, { message: "First" });
    assert.equal(out.isError, false, out.text);
    assert.equal(sh("rev-list", "--count", "HEAD"), "1");
    assert.equal(sh("show", "--name-only", "--format=", "HEAD"), "first.txt");
    assert.equal(sh("status", "--porcelain"), "");
  });

  it("commits the deletion of a named path", async () => {
    const { root, sh } = repo();
    rmSync(join(root, "gone.txt"));
    const out = await commitIn(root, { message: "Remove it", paths: ["gone.txt"] });
    assert.equal(out.isError, false, out.text);
    assert.equal(sh("show", "--name-status", "--format=", "HEAD"), "D\tgone.txt");
    assert.equal(sh("status", "--porcelain"), "");
  });

  it("removes its scratch index after a success and after a failure", async () => {
    const { root } = repo();
    const seen = new Set<string>();
    const spy: CommitGit = (args, cwd, env, options) => {
      if (env?.GIT_INDEX_FILE !== undefined) seen.add(dirname(env.GIT_INDEX_FILE));
      return real(args, cwd, env, options);
    };
    writeFileSync(join(root, "kept.txt"), "two\n");
    assert.equal((await commitIn(root, { message: "Ok" }, spy)).isError, false);
    const failing: CommitGit = (args, cwd, env, options) =>
      args.includes("commit") && args.includes("-m") ? { ok: false, stdout: "", stderr: "refused" } : spy(args, cwd, env, options);
    writeFileSync(join(root, "kept.txt"), "three\n");
    assert.equal((await commitIn(root, { message: "Bad" }, failing)).isError, true);
    assert.equal(seen.size, 2, "one scratch directory per call");
    for (const dir of seen) assert.equal(existsSync(dir), false, `${dir} was left behind`);
  });
});
