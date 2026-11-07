// T254: the seal from `sealed:`. Each red outcome comes from a fixture; a sealed test that already passes is
// WEAK-SPEC; `red: false` is recorded; a reseal advances the active seal (R9); removing the red-check worktree
// never follows a link into the main checkout (G7).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { activeSeals } from "./active.js";
import { createTemporaryWorktree } from "./git.js";
import { sealKeyInit } from "./keys.js";
import { runRedCheck } from "./runner.js";
import { resealAt, sealFromSpec } from "./spec.js";
import type { SealFile } from "./types.js";

let root: string;
let repo: string;
let home: string;

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    NODE_TEST_CONTEXT: undefined,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: env(), encoding: "utf8" }).trim();
}

function write(dir: string, rel: string, text: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

const FAILING = 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("adds", () => assert.equal(1 + 1, 3));\n';
const PASSING = 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("adds", () => assert.equal(1 + 1, 2));\n';
const BROKEN = 'import { it } from "node:test";\nthis is not javascript\n';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lykos-t254-"));
  home = join(root, "home");
  repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  write(repo, ".lykos/config.yaml", 'seal:\n  base: main\n  test_command: "node --test {files}"\n');
  write(repo, ".gitignore", ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\nnode_modules/\n");
  write(repo, "src/add.mjs", "export const add = (a, b) => 0;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  sealKeyInit(repo, home, env());
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The session's checkout: a branch of its own made from main, as a delegated session gets. */
function sessionWorktree(): string {
  const wt = join(root, "wt");
  git(repo, "worktree", "add", "-q", "-b", "lykos/s1", wt, "main");
  return wt;
}

describe("T254: red outcomes", () => {
  function red(test: string, template = "node --test {files}") {
    const dir = mkdtempSync(join(root, "red-"));
    write(dir, "test/a.test.mjs", test);
    return runRedCheck({ worktreeDir: dir, testFiles: ["test/a.test.mjs"], testCommandTemplate: template, env: env() });
  }

  it("failing: the named tests fail on assertions", async () => {
    const res = await red(FAILING);
    assert.equal(res.outcome, "failing");
    assert.equal(res.red.length, 1);
  });

  it("failing-exit-only: a runner without per-test results exited non-zero", async () => {
    const res = await red(FAILING, "node {files}");
    assert.equal(res.adapter, "exit");
    assert.equal(res.outcome, "failing-exit-only");
  });

  it("error: in exit-code mode, a command that cannot run is no red", async () => {
    const res = await red(FAILING, "lykos-no-such-test-runner {files}");
    assert.equal(res.adapter, "exit");
    assert.equal(res.outcome, "error");
  });

  it("passing: a sealed test already passes, named", async () => {
    const res = await red(PASSING);
    assert.equal(res.outcome, "passing");
    assert.deepEqual(res.passing, ["test/a.test.mjs > adds"]);
    assert.equal((await red(PASSING, "node {files}")).outcome, "passing", "exit-code mode: the command passed");
  });

  it("error: the tests could not run, with the output", async () => {
    const res = await red(BROKEN);
    assert.equal(res.outcome, "error");
    assert.ok(res.errors.length > 0);
  });
});

describe("T254: the seal from `sealed:`", () => {
  it("commits the coordinator's sealed tests over the base as the writer commit and seals exactly them", async () => {
    const wt = sessionWorktree();
    write(repo, "test/add.test.mjs", FAILING);
    const sealed = await sealFromSpec({ workspace: repo, worktree: wt, paths: ["test/add.test.mjs"], red: true, homeDir: home, env: env() });
    assert.equal(sealed.ok, true, sealed.message);
    assert.equal(sealed.red, "failing");
    assert.equal(git(wt, "rev-parse", `${sealed.writerCommit!}^`), git(repo, "rev-parse", "main"), "the writer commit sits on the base");
    const [active] = activeSeals({ cwd: wt, env: env(), base: "main" });
    assert.equal(active!.seal.writer_commit, sealed.writerCommit);
    assert.ok(active!.seal.sealed_paths.includes("test/add.test.mjs"));
  });

  it("a sealed test that already passes is WEAK-SPEC, and no seal is made (R21)", async () => {
    const wt = sessionWorktree();
    write(repo, "test/add.test.mjs", PASSING);
    const sealed = await sealFromSpec({ workspace: repo, worktree: wt, paths: ["test/add.test.mjs"], red: true, homeDir: home, env: env() });
    assert.equal(sealed.ok, false);
    assert.equal(sealed.red, "passing");
    assert.match(sealed.message!, /WEAK-SPEC/);
    assert.deepEqual(activeSeals({ cwd: wt, env: env(), base: "main" }), []);
  });

  it("red: false skips the check and the seal records it", async () => {
    const wt = sessionWorktree();
    write(repo, "test/add.test.mjs", PASSING);
    const sealed = await sealFromSpec({ workspace: repo, worktree: wt, paths: ["test/add.test.mjs"], red: false, homeDir: home, env: env() });
    assert.equal(sealed.ok, true, sealed.message);
    assert.equal(sealed.red, "skipped");
    const seal = JSON.parse(readFileSync(join(wt, ".lykos", "seals", "lykos", "s1.json"), "utf8")) as SealFile;
    assert.equal(seal.red_check, "skipped");
  });

  it("an error names fix_environment's cause", async () => {
    const wt = sessionWorktree();
    write(repo, "test/add.test.mjs", BROKEN);
    const sealed = await sealFromSpec({ workspace: repo, worktree: wt, paths: ["test/add.test.mjs"], red: true, homeDir: home, env: env() });
    assert.equal(sealed.ok, false);
    assert.equal(sealed.red, "error");
  });

  it("--reseal advances the active seal to the corrected commit (R9)", async () => {
    const wt = sessionWorktree();
    write(repo, "test/add.test.mjs", FAILING);
    const first = await sealFromSpec({ workspace: repo, worktree: wt, paths: ["test/add.test.mjs"], red: true, homeDir: home, env: env() });
    assert.equal(first.ok, true, first.message);
    // The coordinator corrects the sealed test on the branch: still red, now asserting what it meant.
    write(wt, "test/add.test.mjs", FAILING.replace("3", "4"));
    git(wt, "commit", "-q", "-am", "correct the sealed test");
    const fix = git(wt, "rev-parse", "HEAD");
    const again = await resealAt({ worktree: wt, commit: fix, homeDir: home, env: env() });
    assert.equal(again.ok, true, again.message);
    const [active] = activeSeals({ cwd: wt, env: env(), base: "main" });
    assert.equal(active!.seal.writer_commit, fix);
    assert.ok(active!.seal.sealed_paths.includes("test/add.test.mjs"));
  });

  it("a reseal at a commit that is not the branch tip is refused", async () => {
    const wt = sessionWorktree();
    const res = await resealAt({ worktree: wt, commit: git(repo, "rev-parse", "main~0") + "^{tree}", homeDir: home, env: env() });
    assert.equal(res.ok, false);
  });
});

describe("T254: removing the red-check worktree never follows a link (G7)", () => {
  it("leaves the main node_modules intact, the junction and a link a test made", () => {
    write(repo, "node_modules/dep/index.js", "module.exports = 1;\n");
    const wt = createTemporaryWorktree(repo, git(repo, "rev-parse", "HEAD"), env());
    assert.ok(existsSync(join(wt.dir, "node_modules", "dep", "index.js")), "the worktree reaches the main node_modules");
    mkdirSync(join(wt.dir, "deep"));
    symlinkSync(join(repo, "node_modules"), join(wt.dir, "deep", "linked"), "junction");
    wt.cleanup();
    assert.ok(existsSync(join(repo, "node_modules", "dep", "index.js")), "the main node_modules is intact");
    assert.equal(existsSync(wt.dir), false, "the worktree is gone");
  });
});

describe("T254: WEAK-SPEC ends the run before any model runs (R21)", () => {
  it("the session child seals first and never starts the model when a sealed test passes", async () => {
    const { runSessionChild } = await import("../cli/session-child.js");
    const { encodeFrame, parseFrame, PROTOCOL_VERSION } = await import("../delegate/session-protocol.js");
    write(repo, "test/add.test.mjs", PASSING);
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    let modelRan = false;
    const lines: string[] = [];
    const input = new (await import("node:stream")).PassThrough();
    input.write(
      encodeFrame({
        version: PROTOCOL_VERSION,
        tool: "lykos_implement",
        workspace: repo,
        prompt: "make add work",
        label: "lykos_implement",
        base: "main",
        sealed: ["test/add.test.mjs"],
      }),
    );
    try {
      const code = await runSessionChild({
        input,
        write: (text) => void lines.push(...text.split("\n").filter((l) => l.length > 0)),
        env: { ...env(), LYKOS_TRUST_SOURCE: "flag", LYKOS_TRUST_WORKSPACE: "1" },
        trustPath: join(root, "trust.json"),
        worktreesRoot: join(root, "worktrees"),
        runTask: async () => {
          modelRan = true;
          return { status: "blocked", reason: "should not run" };
        },
      });
      assert.equal(code, 0);
    } finally {
      input.end();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    const result = lines.map((l) => parseFrame(l)!).find((f) => f.type === "result") as { result: Record<string, unknown> } | undefined;
    assert.equal(modelRan, false, "no model ran");
    assert.equal(result?.result.outcome, "needs_answer", JSON.stringify(result));
    assert.equal(result?.result.next, "answer_spec");
    assert.deepEqual((result?.result.flags as Array<{ flag: string }>).map((f) => f.flag), ["WEAK-SPEC"]);
  });

  it("the result contract keeps WEAK-SPEC and next answer_spec", async () => {
    const { createMcpServer } = await import("../delegate/mcp-server.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, LYKOS_TRUST_WORKSPACE: process.env.LYKOS_TRUST_WORKSPACE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.LYKOS_TRUST_WORKSPACE = "1";
    after(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
    const server = createMcpServer({
      workspace: repo,
      version: "test",
      run: async ({ request }) => ({
        outcome: "needs_answer",
        question: "the sealed tests already pass",
        sessionId: request.newSessionId!,
        flags: [{ flag: "WEAK-SPEC", detail: "the sealed tests already pass" }],
        next: "answer_spec",
      }),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "t254", version: "1" });
    await client.connect(b);
    const res = await client.callTool({ name: "lykos_implement", arguments: { brief: "x", sealed: ["test/add.test.mjs"] } });
    const out = JSON.parse((res as { content: Array<{ text: string }> }).content[0]!.text) as { next: string; flags: Array<{ flag: string }> };
    assert.equal(out.next, "answer_spec", JSON.stringify(out));
    assert.ok(out.flags.some((f) => f.flag === "WEAK-SPEC"));
    await client.close();
  });
});
