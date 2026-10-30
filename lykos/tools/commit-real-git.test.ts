// T179 round 2 — what "every change" covers, against a REAL repository with no
// .gitignore: never Lykos's own directories, and never above the workspace.
// (The argv-level tests are commit.test.ts; the session ones are
// cli/commit-session.test.ts.)

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from "../gate/approval.js";
import { hostGit } from "../git/host-git.js";
import { CommitLog, buildCommitTool } from "./commit.js";

class AllowGate implements ApprovalGate {
  readonly seen: ApprovalRequest[] = [];
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.seen.push(req);
    return "allow";
  }
}

/** A repository with sub/kept.txt and outside.txt committed, and no .gitignore. */
function realRepo() {
  const root = mkdtempSync(join(tmpdir(), "lykos-commit-real-"));
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  sh("init", "-q", "-b", "main");
  sh("config", "user.email", "t@lykos.test");
  sh("config", "user.name", "T");
  sh("config", "commit.gpgsign", "false");
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "sub", "kept.txt"), "one\n");
  writeFileSync(join(root, "outside.txt"), "one\n");
  sh("add", "-A");
  sh("commit", "-q", "-m", "fixture");
  return { root, sh };
}

async function commitIn(cwd: string, params: Record<string, unknown>, gate = new AllowGate()) {
  const tool = buildCommitTool({ cwd, gate, log: new CommitLog(), git: (a, c) => hostGit(a, c) });
  try {
    await tool.execute("id", params as never, undefined, undefined, undefined as never);
    return { isError: false, text: "" };
  } catch (err) {
    return { isError: true, text: (err as Error).message };
  }
}

describe("commit: what 'every change' covers (T179, real git)", () => {
  it("never stages .lykos or .pi, in a repository with no .gitignore", async () => {
    const { root, sh } = realRepo();
    mkdirSync(join(root, ".lykos", "session", "s1"), { recursive: true });
    writeFileSync(join(root, ".lykos", "session", "s1", "transcript.jsonl"), "{}\n");
    writeFileSync(join(root, ".lykos", "ledger.db-wal"), "wal");
    writeFileSync(join(root, ".lykos", "ledger.db-shm"), "shm");
    mkdirSync(join(root, ".pi", "agents"), { recursive: true });
    writeFileSync(join(root, ".pi", "agents", "a.md"), "generated");
    writeFileSync(join(root, "sub", "kept.txt"), "two\n");
    const out = await commitIn(root, { message: "Only real work" });
    assert.equal(out.isError, false, out.text);
    assert.equal(sh("show", "--name-only", "--format=", "HEAD"), "sub/kept.txt");
    const left = sh("status", "--porcelain", "--untracked-files=all");
    assert.match(left, /\.lykos\/session\/s1\/transcript\.jsonl/, "left alone, not committed");
    assert.match(left, /\.pi\/agents\/a\.md/);
  });

  it("is not stopped by a .gitignore that ignores .lykos (git 2.30 rejects an exclude of an ignored path)", async () => {
    const { root, sh } = realRepo();
    writeFileSync(join(root, ".gitignore"), ".lykos/\n");
    sh("add", ".gitignore");
    sh("commit", "-q", "-m", "ignore");
    mkdirSync(join(root, ".lykos"), { recursive: true });
    writeFileSync(join(root, ".lykos", "ledger.db"), "db");
    writeFileSync(join(root, "sub", "kept.txt"), "two\n");
    const out = await commitIn(root, { message: "With an ignore" });
    assert.equal(out.isError, false, out.text);
    assert.equal(sh("show", "--name-only", "--format=", "HEAD"), "sub/kept.txt");
  });

  it("does not commit a tracked .lykos file the project edited", async () => {
    const { root, sh } = realRepo();
    mkdirSync(join(root, ".lykos"), { recursive: true });
    writeFileSync(join(root, ".lykos", "config.yaml"), "a: 1\n");
    sh("add", "-f", ".lykos/config.yaml");
    sh("commit", "-q", "-m", "tracked config");
    writeFileSync(join(root, ".lykos", "config.yaml"), "a: 2\n");
    writeFileSync(join(root, "sub", "kept.txt"), "two\n");
    const out = await commitIn(root, { message: "Work only" });
    assert.equal(out.isError, false, out.text);
    assert.equal(sh("show", "--name-only", "--format=", "HEAD"), "sub/kept.txt");
    assert.match(sh("status", "--porcelain"), /M \.lykos\/config\.yaml/, "still a local modification");
  });

  it("refuses a named path inside .lykos or .pi before it asks", async () => {
    const { root } = realRepo();
    mkdirSync(join(root, ".lykos"), { recursive: true });
    writeFileSync(join(root, ".lykos", "config.yaml"), "x: 1\n");
    const gate = new AllowGate();
    const out = await commitIn(root, { message: "Sneak", paths: [".lykos/config.yaml"] }, gate);
    assert.equal(out.isError, true);
    assert.match(out.text, /never committed/);
    assert.equal(gate.seen.length, 0);
  });

  it("is the workspace, not the repository: a session in a subfolder commits nothing outside it", async () => {
    const { root, sh } = realRepo();
    writeFileSync(join(root, "sub", "kept.txt"), "two\n");
    writeFileSync(join(root, "outside.txt"), "two\n");
    writeFileSync(join(root, "sub", "new.txt"), "new\n");
    const out = await commitIn(join(root, "sub"), { message: "Inside sub" });
    assert.equal(out.isError, false, out.text);
    assert.equal(sh("show", "--name-only", "--format=", "HEAD").split("\n").sort().join(","), "sub/kept.txt,sub/new.txt");
    assert.match(sh("status", "--porcelain"), /M outside\.txt/, "the change above the workspace is still uncommitted");
  });

  it("does not sweep up something already staged outside the workspace", async () => {
    const { root, sh } = realRepo();
    writeFileSync(join(root, "outside.txt"), "staged elsewhere\n");
    sh("add", "outside.txt");
    writeFileSync(join(root, "sub", "kept.txt"), "two\n");
    const out = await commitIn(join(root, "sub"), { message: "Inside sub only" });
    assert.equal(out.isError, false, out.text);
    assert.equal(sh("show", "--name-only", "--format=", "HEAD"), "sub/kept.txt");
    assert.match(sh("status", "--porcelain"), /M\s+outside\.txt/);
  });
});
