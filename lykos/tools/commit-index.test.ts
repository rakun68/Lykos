// T179 round 3 — the person's index is theirs: a failed commit leaves it exactly
// as it was, a successful one brings only the committed paths up to date, and
// what they staged under .lykos/ or .pi/ survives either way. Plus the ledger
// failure message and the protected-directory check's case handling.
// Real git throughout, no .gitignore.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from "../gate/approval.js";
import { hostGit } from "../git/host-git.js";
import { CommitLog, buildCommitTool, type CommitGit } from "./commit.js";

class AllowGate implements ApprovalGate {
  async request(_req: ApprovalRequest): Promise<ApprovalDecision> {
    return "allow";
  }
}

/** sub/kept.txt, outside.txt and .lykos/config.yaml committed; then the person's own working state laid on top. */
function repoWithStaging() {
  const root = mkdtempSync(join(tmpdir(), "lykos-commit-index-"));
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  sh("init", "-q", "-b", "main");
  sh("config", "user.email", "t@lykos.test");
  sh("config", "user.name", "T");
  sh("config", "commit.gpgsign", "false");
  sh("config", "core.autocrlf", "false");
  mkdirSync(join(root, "sub"), { recursive: true });
  mkdirSync(join(root, ".lykos"), { recursive: true });
  writeFileSync(join(root, "sub", "kept.txt"), "one\n");
  writeFileSync(join(root, "sub", "other.txt"), "one\n");
  writeFileSync(join(root, "outside.txt"), "one\n");
  writeFileSync(join(root, ".lykos", "config.yaml"), "a: 1\n");
  sh("add", "-A", "-f");
  sh("commit", "-q", "-m", "fixture");
  // The person's state: one change staged outside the workspace, one staged under .lykos, and the
  // session's own work (a modified file, a new file) deliberately NOT staged.
  writeFileSync(join(root, "outside.txt"), "staged elsewhere\n");
  sh("add", "outside.txt");
  writeFileSync(join(root, ".lykos", "config.yaml"), "a: 2\n");
  sh("add", "-f", ".lykos/config.yaml");
  writeFileSync(join(root, "sub", "kept.txt"), "two\n");
  writeFileSync(join(root, "sub", "new.txt"), "new\n");
  return { root, sh };
}

const indexState = (sh: (...a: string[]) => string) => ({
  status: sh("status", "--porcelain", "--untracked-files=all"),
  staged: sh("diff", "--cached"),
});

async function commitIn(cwd: string, params: Record<string, unknown>, git?: CommitGit, log = new CommitLog()) {
  const tool = buildCommitTool({ cwd, gate: new AllowGate(), log, git: git ?? ((a, c, env) => hostGit(a, c, env !== undefined ? { env } : {})) });
  try {
    const out = (await tool.execute("id", params as never, undefined, undefined, undefined as never)) as { content: Array<{ text: string }> };
    return { isError: false, text: out.content[0]!.text };
  } catch (err) {
    return { isError: true, text: (err as Error).message };
  }
}

describe("commit leaves the person's index alone (T179, real git)", () => {
  it("a git commit that fails leaves the index exactly as it was", async () => {
    const { root, sh } = repoWithStaging();
    const before = indexState(sh);
    const failingCommit: CommitGit = (args, cwd, env) =>
      args.includes("commit") && args.includes("-m") ? { ok: false, stdout: "", stderr: "Author identity unknown" } : hostGit(args, cwd, env !== undefined ? { env } : {});
    const out = await commitIn(join(root, "sub"), { message: "Will fail" }, failingCommit);
    assert.equal(out.isError, true);
    assert.match(out.text, /Author identity unknown/);
    assert.deepEqual(indexState(sh), before);
  });

  it("'nothing to commit' leaves the index exactly as it was", async () => {
    const { root, sh } = repoWithStaging();
    sh("checkout", "--", "sub/kept.txt");
    sh("clean", "-fq", "sub");
    const before = indexState(sh);
    const out = await commitIn(join(root, "sub"), { message: "Empty" });
    assert.equal(out.isError, true);
    assert.match(out.text, /nothing to commit/i);
    assert.deepEqual(indexState(sh), before);
  });

  it("a failed read of the new commit's id still leaves the person's staging alone", async () => {
    const { root, sh } = repoWithStaging();
    const blindHead: CommitGit = (args, cwd, env) =>
      args[0] === "rev-parse" && args[1] === "HEAD" ? { ok: false, stdout: "", stderr: "no head" } : hostGit(args, cwd, env !== undefined ? { env } : {});
    // The commit itself succeeded here, so HEAD moved: the index must have been brought up to date regardless.
    const out = await commitIn(join(root, "sub"), { message: "Blind" }, blindHead);
    assert.equal(out.isError, false, "the commit was made, so it is reported (see commit-edges.test.ts)");
    const after = indexState(sh);
    assert.doesNotMatch(after.status, /sub\//, "the committed paths match the new HEAD");
    assert.match(after.status, /M\s+outside\.txt/, "the change staged outside the workspace is still staged");
    assert.match(after.status, /M\s+\.lykos\/config\.yaml/, "and so is the one under .lykos");
  });

  it("a successful commit brings only the committed paths up to date and keeps the person's staging elsewhere", async () => {
    const { root, sh } = repoWithStaging();
    const out = await commitIn(join(root, "sub"), { message: "Session work" });
    assert.equal(out.isError, false, out.text);
    assert.equal(sh("show", "--name-only", "--format=", "HEAD").split("\n").sort().join(","), "sub/kept.txt,sub/new.txt");
    const status = sh("status", "--porcelain", "--untracked-files=all");
    assert.match(status, /^M\s+outside\.txt$/m, "staged outside the workspace: still staged, not committed");
    assert.match(status, /^M\s+\.lykos\/config\.yaml$/m, "staged under .lykos: still staged, not committed");
    assert.doesNotMatch(status, /sub\//, "the committed paths match HEAD in the index and the working tree");
  });
});

describe("commit: protected directories are matched the way git matches them (T179)", () => {
  it("refuses .Lykos and .PI in any case", async () => {
    const { root } = repoWithStaging();
    for (const path of [".Lykos/config.yaml", ".LYKOS/x", ".Pi/agents/a.md"]) {
      const out = await commitIn(root, { message: "Sneak", paths: [path] });
      assert.equal(out.isError, true, path);
      assert.match(out.text, /never committed/, path);
    }
  });
});

describe("commit: a ledger that cannot take the record (T179)", () => {
  it("keeps the commit and says in the result that the record failed", async () => {
    const { root, sh } = repoWithStaging();
    const log = new CommitLog(() => {
      throw new Error("database is locked");
    });
    const out = await commitIn(join(root, "sub"), { message: "Unrecorded" }, undefined, log);
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, /^Committed [0-9a-f]{40}/);
    assert.match(out.text, /recording it in the ledger failed: database is locked/);
    assert.equal(sh("log", "-1", "--format=%s"), "Unrecorded");
    assert.equal(log.records.length, 1);
  });
});

describe("commit: diagnostics go through the IO mode (T179, AGENTS.md rule 8)", () => {
  it("writes no raw stderr", () => {
    const source = readFileSync(new URL("./commit.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /process\.stderr/);
    assert.match(source, /stderrWrite\(/);
  });
});
