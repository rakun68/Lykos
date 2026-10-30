// T179 round 5 — what the ledger is told: only ids git really gave, a file count
// only when it could be taken (NULL, "unmeasured", otherwise), and "every change"
// when the person has staged deletions and renames. Real git.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { formatCommitLine } from "../cli/show.js";
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from "../gate/approval.js";
import { hostGit } from "../git/host-git.js";
import { Ledger } from "../ledger/ledger.js";
import { CommitLog, buildCommitTool, type CommitGit } from "./commit.js";

class AllowGate implements ApprovalGate {
  async request(_req: ApprovalRequest): Promise<ApprovalDecision> {
    return "allow";
  }
}

const real: CommitGit = (args, cwd, env, options) =>
  hostGit(args, cwd, { ...(env !== undefined ? { env } : {}), ...(options?.raw === true ? { raw: true } : {}) });

function repo() {
  const root = mkdtempSync(join(tmpdir(), "lykos-commit-id-"));
  const sh = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  sh("init", "-q", "-b", "main");
  sh("config", "user.email", "t@lykos.test");
  sh("config", "user.name", "T");
  sh("config", "commit.gpgsign", "false");
  sh("config", "core.autocrlf", "false");
  for (const f of ["a.txt", "b.txt", "kept.txt"]) writeFileSync(join(root, f), `${f} has some content to be recognised as a rename\n`);
  sh("add", "-A");
  sh("commit", "-q", "-m", "fixture");
  return { root, sh };
}

async function commitIn(cwd: string, params: Record<string, unknown>, git: CommitGit = real) {
  const log = new CommitLog();
  const tool = buildCommitTool({ cwd, gate: new AllowGate(), log, git });
  try {
    const out = (await tool.execute("id", params as never, undefined, undefined, undefined as never)) as { content: Array<{ text: string }> };
    return { isError: false, text: out.content[0]!.text, log };
  } catch (err) {
    return { isError: true, text: (err as Error).message, log };
  }
}

const noHead = (inner: CommitGit): CommitGit => (args, cwd, env, options) =>
  args[0] === "rev-parse" && args[1] === "HEAD" ? { ok: false, stdout: "", stderr: "no head" } : inner(args, cwd, env, options);

describe("commit: staged deletions and renames (T179)", () => {
  it("'every change' carries a deletion and a rename the person staged", async () => {
    const { root, sh } = repo();
    sh("rm", "-q", "b.txt");
    sh("mv", "a.txt", "d.txt");
    writeFileSync(join(root, "kept.txt"), "changed\n");
    const out = await commitIn(root, { message: "Tidy" });
    assert.equal(out.isError, false, out.text);
    const status = sh("show", "--name-status", "-M", "--format=", "HEAD").split("\n").sort();
    assert.deepEqual(status, ["D\tb.txt", "M\tkept.txt", "R100\ta.txt\td.txt"]);
    assert.equal(sh("status", "--porcelain"), "");
  });
});

describe("commit: only real ids reach the ledger (T179, AGENTS.md rule 4)", () => {
  it("an id that cannot be read in full is recorded as the abbreviated one git printed, as is", async () => {
    const { root, sh } = repo();
    writeFileSync(join(root, "kept.txt"), "two\n");
    const out = await commitIn(root, { message: "Short id" }, noHead(real));
    assert.equal(out.isError, false, out.text);
    const [record] = out.log.records;
    assert.match(record!.sha, /^[0-9a-f]{7,39}$/);
    assert.ok(sh("rev-parse", "HEAD").startsWith(record!.sha));
    assert.equal(record!.filesChanged, 1, "counted from the id we have");
  });

  it("with no id at all there is no ledger row, and the result and stderr say so", async () => {
    const { root, sh } = repo();
    writeFileSync(join(root, "kept.txt"), "two\n");
    const blind: CommitGit = (args, cwd, env, options) => {
      const out = noHead(real)(args, cwd, env, options);
      // git printed nothing parseable either
      return args.includes("commit") && args.includes("-m") ? { ...out, stdout: "" } : out;
    };
    const out = await commitIn(root, { message: "No id" }, blind);
    assert.equal(out.isError, false, out.text);
    assert.match(out.text, /its id could not be read, so it is not recorded/);
    assert.deepEqual(out.log.records, [], "nothing invented, nothing recorded");
    assert.equal(sh("log", "-1", "--format=%s"), "No id", "the commit itself exists");
    assert.doesNotMatch(out.text, /unknown/);
  });

  it("a file count that cannot be taken is null, and the result says 'unmeasured'", async () => {
    const { root } = repo();
    writeFileSync(join(root, "kept.txt"), "two\n");
    const noShow: CommitGit = (args, cwd, env, options) =>
      args[0] === "show" ? { ok: false, stdout: "", stderr: "cannot show" } : real(args, cwd, env, options);
    const out = await commitIn(root, { message: "Uncounted" }, noShow);
    assert.equal(out.isError, false, out.text);
    assert.equal(out.log.records[0]!.filesChanged, null);
    assert.match(out.text, /files unmeasured/);
  });

  it("the ledger takes a NULL count and `lykos show` prints it as unmeasured, never 0", () => {
    const ledger = Ledger.open(":memory:");
    ledger.recordCommits("s1", [
      { sha: "1a2b3c4", tsUtc: "2026-10-10T00:00:00.000Z", subject: "Uncounted", message: "Uncounted", filesChanged: null, scope: "all" },
      { sha: "f".repeat(40), tsUtc: "2026-10-10T00:00:01.000Z", subject: "Counted", message: "Counted", filesChanged: 0, scope: "paths" },
    ]);
    const [uncounted, counted] = ledger.commits("s1");
    assert.equal(uncounted!.files_changed, null);
    assert.equal(counted!.files_changed, 0);
    assert.match(formatCommitLine(uncounted!), /1a2b3c4\s+Uncounted\s+\(files unmeasured\)/);
    assert.match(formatCommitLine(counted!), /\(0 files\)/);
    ledger.close();
  });
});
