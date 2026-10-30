// The `commit` tool in a whole standalone session against a scripted model. A
// person or a calling agent stands where these tests stand: the repository, the
// result the model is sent, the ledger, and `lykos show`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { describe, it } from "node:test";
import { standInRuntime } from "./scripted-container.js";
import { call, lastToolResult, reply, runScriptedSession, say } from "./scripted-session.js";

const QUIET = `feedback:\n  enabled: false\ngate:\n  enabled: false\n`;
const fwd = (p: string) => p.replaceAll(sep, "/");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

describe("commit in a session (T179)", () => {
  it("a scripted session commits through `commit` and the commit exists with the given message", async () => {
    let text = "";
    const run = await runScriptedSession({
      config: QUIET,
      files: { "a.txt": "one\n" },
      script: [
        reply(call("write", { path: "a.txt", content: "two\n" }), call("write", { path: "new.txt", content: "fresh\n" })),
        reply(call("commit", { message: "Change a and add new\n\nWhy: the scripted task said so." })),
        (context) => {
          text = lastToolResult(context).text;
          return reply(say("done"));
        },
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    const head = git(run.workspace, "rev-parse", "HEAD");
    assert.match(text, new RegExp(head), "the result carries the new commit's id");
    assert.equal(git(run.workspace, "log", "-1", "--format=%B").trim(), "Change a and add new\n\nWhy: the scripted task said so.");
    assert.equal(git(run.workspace, "show", "--name-only", "--format=", "HEAD").split("\n").sort().join(","), "a.txt,new.txt");
    assert.equal(git(run.workspace, "status", "--porcelain"), "", "everything was committed");
  });

  it("with a path list it stages and commits only those paths", async () => {
    const run = await runScriptedSession({
      config: QUIET,
      files: { "a.txt": "one\n", "b.txt": "one\n" },
      script: [
        reply(call("write", { path: "a.txt", content: "two\n" }), call("write", { path: "b.txt", content: "two\n" })),
        reply(call("commit", { message: "Only a", paths: ["a.txt"] })),
        reply(say("done")),
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(git(run.workspace, "show", "--name-only", "--format=", "HEAD"), "a.txt");
    assert.match(git(run.workspace, "status", "--porcelain"), /M b\.txt/, "b.txt is still an uncommitted change");
  });

  it("a path outside the workspace is refused and nothing is committed", async () => {
    let refusal: ReturnType<typeof lastToolResult> | undefined;
    const run = await runScriptedSession({
      config: QUIET,
      files: { "a.txt": "one\n" },
      script: [
        reply(call("write", { path: "a.txt", content: "two\n" })),
        reply(call("commit", { message: "Escape", paths: ["../elsewhere.txt"] })),
        (context) => {
          refusal = lastToolResult(context);
          return reply(say("done"));
        },
      ],
    });
    assert.equal(refusal?.isError, true);
    assert.match(refusal?.text ?? "", /outside the workspace/);
    assert.equal(git(run.workspace, "log", "--format=%s"), "scripted-session fixture");
  });

  it("nothing to commit is an error the model reads, not an empty commit", async () => {
    let result: ReturnType<typeof lastToolResult> | undefined;
    const run = await runScriptedSession({
      config: QUIET,
      script: [
        reply(call("commit", { message: "Nothing" })),
        (context) => {
          result = lastToolResult(context);
          return reply(say("done"));
        },
      ],
    });
    assert.equal(result?.isError, true);
    assert.match(result?.text ?? "", /nothing to commit/i);
    assert.equal(git(run.workspace, "rev-list", "--count", "HEAD"), "1");
  });

  it("a repository hook does not run on that commit", async () => {
    const markers = mkdtempSync(join(tmpdir(), "lykos-markers-"));
    const hookMarker = join(markers, "hook");
    let workspace = "";
    const run = await runScriptedSession({
      config: QUIET,
      files: { "a.txt": "one\n" },
      setup: (ws) => {
        workspace = ws;
        const hooks = join(ws, ".git", "hooks");
        mkdirSync(hooks, { recursive: true });
        for (const name of ["pre-commit", "commit-msg", "post-commit"]) {
          writeFileSync(join(hooks, name), `#!/bin/sh\necho ran >> "${fwd(hookMarker)}"\n`, { mode: 0o755 });
        }
      },
      script: [
        reply(call("write", { path: "a.txt", content: "two\n" })),
        reply(call("commit", { message: "Hooked repository" })),
        reply(say("done")),
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(git(workspace, "log", "-1", "--format=%s"), "Hooked repository", "the commit was made");
    assert.equal(existsSync(hookMarker), false, "no hook ran");
    // Positive control: plain git commit in the same repository runs the plant.
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "control"], { cwd: workspace, stdio: "ignore" });
    assert.ok(existsSync(hookMarker), "control: plain git runs the planted hook");
  });

  it("in an asking interaction mode it asks like edit does: a declined commit commits nothing", async () => {
    let declined: ReturnType<typeof lastToolResult> | undefined;
    let editDeclined: ReturnType<typeof lastToolResult> | undefined;
    const run = await runScriptedSession({
      config: QUIET,
      files: { "a.txt": "one\n" },
      autoApprove: false,
      script: [
        reply(call("edit", { path: "a.txt", edits: [{ oldText: "one", newText: "two" }] })),
        (context) => {
          editDeclined = lastToolResult(context);
          return reply(call("commit", { message: "Declined" }));
        },
        (context) => {
          declined = lastToolResult(context);
          return reply(say("done"));
        },
      ],
    });
    assert.equal(editDeclined?.isError, true);
    assert.equal(declined?.isError, true);
    assert.match(declined?.text ?? "", /the human declined this edit/, "refused by the same rule edit is");
    assert.equal(git(run.workspace, "log", "--format=%s"), "scripted-session fixture");
  });

  it("`lykos show` lists the session's commits, and the ledger holds them against the session", async () => {
    const run = await runScriptedSession({
      config: QUIET,
      files: { "a.txt": "one\n", "b.txt": "one\n" },
      script: [
        reply(call("write", { path: "a.txt", content: "two\n" })),
        reply(call("commit", { message: "First change" })),
        reply(call("write", { path: "b.txt", content: "two\n" })),
        reply(call("commit", { message: "Second change\n\nWith a body." })),
        reply(say("done")),
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    const [second, first] = git(run.workspace, "log", "-2", "--format=%H").split("\n") as [string, string];
    const shown = run.show();
    assert.match(shown, /commits\s+2 commits/);
    assert.match(shown, new RegExp(`${first.slice(0, 8)}\\s+First change\\s+\\(1 file\\)$`, "m"));
    assert.match(shown, new RegExp(`${second.slice(0, 8)}\\s+Second change\\s+\\(1 file\\)$`, "m"));
    const json = JSON.parse(run.show({ json: true })) as { commits: Array<{ sha: string; subject: string; files_changed: number }> };
    assert.deepEqual(
      json.commits.map((c) => [c.sha, c.subject, c.files_changed]),
      [
        [first, "First change", 1],
        [second, "Second change", 1],
      ],
    );
    const rows = run.query<{ session_id: string; sha: string; message: string }>("SELECT session_id, sha, message FROM commits ORDER BY ts_utc, rowid");
    assert.deepEqual(
      rows.map((r) => [r.session_id, r.sha]),
      [
        [run.sessionId, first],
        [run.sessionId, second],
      ],
    );
    assert.equal(rows[1]!.message, "Second change\n\nWith a body.");
  });

  it("a session that commits nothing shows no commits line", async () => {
    const run = await runScriptedSession({ config: QUIET, script: [reply(say("done"))] });
    assert.doesNotMatch(run.show(), /commits/);
  });

  it("outside a repository `commit` is absent and the session says why", async () => {
    const run = await runScriptedSession({ config: QUIET, repo: false, files: { "a.txt": "one\n" }, script: [reply(say("done"))] });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    const tools = (run.sent[0]!.tools ?? []).map((t) => t.name);
    assert.ok(!tools.includes("commit"), `commit is on the wire: ${tools.join(", ")}`);
    assert.match(run.stderr, /not a git repository.*commit/);
  });

  it("in a repository `commit` is on the wire", async () => {
    const run = await runScriptedSession({ config: QUIET, script: [reply(say("done"))] });
    assert.ok((run.sent[0]!.tools ?? []).some((t) => t.name === "commit"));
  });

  it("in a repository with no .gitignore it still never commits Lykos's runtime state", async () => {
    const run = await runScriptedSession({
      config: QUIET,
      files: { "a.txt": "one\n" },
      setup: (ws) => {
        // The fixture ignores .lykos/; take that away, as a repository that was never scaffolded has none.
        git(ws, "rm", "-q", ".gitignore");
        git(ws, "commit", "-q", "-m", "no gitignore");
        writeFileSync(join(ws, ".lykos", "ledger.db-wal"), "wal");
        writeFileSync(join(ws, ".env"), "TOKEN=abc\n");
      },
      script: [
        reply(call("write", { path: "a.txt", content: "two\n" })),
        reply(call("commit", { message: "Without a gitignore" })),
        reply(say("done")),
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    const committed = git(run.workspace, "show", "--name-only", "--format=", "HEAD").split("\n");
    assert.ok(committed.includes("a.txt"));
    assert.deepEqual(
      committed.filter((f) => f.startsWith(".lykos/") || f.startsWith(".pi/")),
      [],
      `runtime state was committed: ${committed.join(", ")}`,
    );
  });

  it("in a contained session it commits on the host, not in the container", async () => {
    const runtime = standInRuntime();
    const run = await runScriptedSession({
      config: `${QUIET}containment:\n  level: required\n`,
      files: { "a.txt": "one\n" },
      extra: { containmentDrivers: [runtime.driver] },
      script: [
        reply(call("write", { path: "a.txt", content: "two\n" })),
        reply(call("commit", { message: "From a contained session" })),
        reply(say("done")),
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(git(run.workspace, "log", "-1", "--format=%s"), "From a contained session");
    const execs = runtime.operations.filter((o) => o.op === "exec");
    assert.deepEqual(execs, [], "nothing reached the container");
    assert.ok(
      runtime.operations.some((o) => o.op === "start"),
      "control: the session was contained",
    );
  });
});
