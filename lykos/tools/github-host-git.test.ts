// T170: the github tool's `pr_push` runs host git, so a planted pre-push hook
// must not run. Positive control: plain git pushing from the same repository does.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, it } from "node:test";
import { LOCAL_GH_RUNNER } from "./github.js";

const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe("github tool host git (T170)", () => {
  it("a git push through the real runner does not run a planted pre-push hook", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-ghhook-"));
    try {
      const remote = join(root, "remote.git");
      const work = join(root, "work");
      mkdirSync(work);
      run(root, "init", "-q", "--bare", remote);
      run(work, "init", "-q");
      run(work, "config", "user.email", "t@t");
      run(work, "config", "user.name", "t");
      run(work, "config", "commit.gpgsign", "false");
      writeFileSync(join(work, "a.txt"), "x\n");
      run(work, "add", "-A");
      run(work, "commit", "-q", "-m", "one");
      run(work, "remote", "add", "origin", remote);
      const marker = join(root, "pre-push-ran");
      mkdirSync(join(work, ".git", "hooks"), { recursive: true });
      writeFileSync(join(work, ".git", "hooks", "pre-push"), `#!/bin/sh\necho ran > "${marker.replaceAll(sep, "/")}"\n`, { mode: 0o755 });

      run(work, "push", "-q", "origin", "HEAD:refs/heads/control");
      assert.ok(existsSync(marker), "control: plain git runs the planted pre-push hook");
      rmSync(marker);

      const result = await LOCAL_GH_RUNNER.run("git", ["push", "-q", "origin", "HEAD:refs/heads/protected"], { cwd: work });
      assert.equal(result.status, "ok");
      assert.equal(result.code, 0, result.stderr);
      assert.equal(existsSync(marker), false, "the pre-push hook must not run");
      assert.match(run(remote, "branch", "--list", "protected"), /protected/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
