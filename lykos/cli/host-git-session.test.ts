// A whole standalone session against a scripted model, proving that host git
// ignores a planted hook and fsmonitor command, and that a session without a
// repository or without git says so once and says which.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, it } from "node:test";
import { call, reply, runScriptedSession, say } from "./scripted-session.js";

const fwd = (p: string) => p.replaceAll(sep, "/");

describe("host git in a session (T170)", () => {
  it("a checkpointing session never runs a planted hook or core.fsmonitor command", async () => {
    const markers = mkdtempSync(join(tmpdir(), "lykos-markers-"));
    const hookMarker = join(markers, "hook");
    const fsmonitorMarker = join(markers, "fsmonitor");
    let workspace = "";
    const run = await runScriptedSession({
      files: { "a.txt": "one\n" },
      script: [reply(call("write", { path: "a.txt", content: "two\n" })), reply(say("done"))],
      setup: (ws) => {
        workspace = ws;
        const hooks = join(ws, ".git", "hooks");
        mkdirSync(hooks, { recursive: true });
        for (const name of ["post-checkout", "pre-commit"]) {
          writeFileSync(join(hooks, name), `#!/bin/sh\necho ran > "${fwd(hookMarker)}"\n`, { mode: 0o755 });
        }
        const script = join(ws, ".git", "fsm.mjs");
        writeFileSync(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(fsmonitorMarker)}, "ran");\n`);
        execFileSync("git", ["config", "core.fsmonitor", `node "${fwd(script)}"`], { cwd: ws });
      },
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.ok((run.session().checkpoints_written as number) >= 1, "the session did checkpoint");
    assert.equal(existsSync(hookMarker), false, "no hook ran");
    assert.equal(existsSync(fsmonitorMarker), false, "no fsmonitor command ran");
    // Positive control: plain git in the same repository runs the plant.
    execFileSync("git", ["status"], { cwd: workspace, stdio: "ignore" });
    assert.ok(existsSync(fsmonitorMarker), "control: plain git runs the planted fsmonitor command");
  });

  it("a session in a folder without a repository completes and shows one 'not a git repository' notice", async () => {
    const run = await runScriptedSession({
      repo: false,
      files: { "a.txt": "one\n" },
      script: [reply(call("write", { path: "a.txt", content: "two\n" })), reply(say("done"))],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.file("a.txt"), "two\n");
    assert.equal(run.stderr.match(/not a git repository/g)?.length, 1, run.stderr);
    assert.doesNotMatch(run.stderr, /git is not installed/);
    assert.equal(run.session().checkpoints_written, null);
    assert.match(String(run.session().notes), /git: not-a-repo/);
  });

  it("a machine without git says 'git is not installed' once, and the ledger tells it apart from no repository", async () => {
    const empty = mkdtempSync(join(tmpdir(), "lykos-nopath-"));
    const run = await runScriptedSession({
      script: [reply(call("write", { path: "a.txt", content: "two\n" })), reply(say("done"))],
      files: { "a.txt": "one\n" },
      env: { PATH: empty },
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.stderr.match(/git is not installed/g)?.length, 1, run.stderr);
    assert.doesNotMatch(run.stderr, /not a git repository/);
    assert.match(String(run.session().notes), /git: git-missing/);
    assert.doesNotMatch(String(run.session().notes), /not-a-repo/);
  });
});
