// T184 (review): what the work target reports when things go wrong. Real git, a real ledger path.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { describeWork, recordSavedWork, recordWork, withWorkTarget, workFields } from "./work-target.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "lykos-wt-target-"));
  dirs.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

function repo(): string {
  const dir = tmp();
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

describe("a call whose body throws still reports what it left (T184 review)", () => {
  it("returns the failure with the branch and the commits, and the worktree is gone", async () => {
    const workspace = repo();
    const root = tmp();
    const run = await withWorkTarget({ workspace, interactionMode: "auto", sessionId: "boom", worktreesRoot: root }, async (target) => {
      writeFileSync(join(target.workTree!.path, "b.txt"), "b\n");
      git(target.workTree!.path, "add", "-A");
      git(target.workTree!.path, "commit", "-q", "-m", "Before the crash");
      throw new Error("the engine fell over");
    });
    assert.equal(run.ok, false);
    if (run.ok) return;
    assert.equal(run.message, "the engine fell over");
    assert.equal(run.work?.branch, "lykos/boom");
    assert.deepEqual(run.work?.commits?.map((c) => c.subject), ["Before the crash"]);
    assert.equal(git(workspace, "worktree", "list").split("\n").length, 1);
  });
});

describe("recording the commit that saved leftover work (T184 review)", () => {
  const work = { branch: "lykos/s", saved: { sha: "a".repeat(40), subject: "saved", message: "saved", filesChanged: 1 } };

  it("says so when the ledger cannot take the row, instead of hiding it", async () => {
    const blocker = tmp();
    writeFileSync(join(blocker, "file"), "x");
    // A ledger path under a file cannot be opened.
    const failure = await recordSavedWork(join(blocker, "file", "ledger.db"), "s", work);
    assert.match(failure ?? "", /could not be recorded in the ledger/);
    assert.match(failure ?? "", /aaaaaaaaaaaa/);
  });

  it("records nothing and reports nothing when there was no save", async () => {
    assert.equal(await recordSavedWork(join(tmp(), "ledger.db"), "s", { branch: "lykos/s" }), undefined);
  });
});

describe("every outcome says where its work is (T184 review)", () => {
  it("a branch with no commits still names the branch, and the ledger failure joins the note", async () => {
    const blocker = tmp();
    writeFileSync(join(blocker, "file"), "x");
    const lines: string[] = [];
    const work = await recordWork(
      join(blocker, "file", "ledger.db"),
      "s",
      { branch: "lykos/s", note: "files saved in /x/s.ignored", saved: { sha: "b".repeat(40), subject: "saved", message: "saved", filesChanged: 1 } },
      (line) => lines.push(line),
    );
    assert.equal(lines.length, 1, "the process's own stderr is told");
    const fields = workFields(work);
    assert.equal(fields.branch, "lykos/s");
    assert.equal(fields.commits, undefined);
    assert.match(fields.note ?? "", /s\.ignored; the commit that saved/);
    const text = describeWork(work);
    assert.match(text, /^\nbranch: lykos\/s\n\nfiles saved in/);
  });

  it("says nothing when there is no work to report", () => {
    assert.equal(describeWork({}), "");
    assert.deepEqual(workFields({}), {});
  });
});
