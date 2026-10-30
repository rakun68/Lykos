import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// T200 (#55) ACCEPTANCE: `lykos seal hook install` blocks a push of tampered
// sealed files, and a new seal prunes merged branches' seal files. Real CLI,
// real temporary repository, a real bare remote.

const cliPath = join(import.meta.dirname, "..", "cli.ts");
const tsxImport = import.meta.resolve("tsx");

let root: string;
let home: string;
let repo: string;
let remote: string;

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    LYKOS_TRUST_WORKSPACE: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    NODE_TEST_CONTEXT: undefined,
  };
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: env(), encoding: "utf8" }).trim();
}

function gitTry(...args: string[]): { status: number | null; out: string } {
  const res = spawnSync("git", args, { cwd: repo, env: env(), encoding: "utf8", timeout: 180_000 });
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

function lykos(...args: string[]): { status: number | null; out: string } {
  const res = spawnSync(process.execPath, ["--import", tsxImport, cliPath, ...args], {
    cwd: repo,
    env: env(),
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

function write(rel: string, text: string): void {
  const p = join(repo, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

function commitAll(msg: string): string {
  git("add", "-A");
  git("commit", "-q", "-m", msg);
  return git("rev-parse", "HEAD");
}

function redTest(mod: string): string {
  return (
    'import { describe, it } from "node:test";\n' +
    'import assert from "node:assert/strict";\n' +
    `import { ${mod} } from "../src/${mod}.mjs";\n` +
    `describe("${mod}", () => { it("works", () => { assert.equal(${mod}(1, 2), 3); }); });\n`
  );
}

function sealBranch(branch: string, from: string, mod: string): void {
  git("checkout", "-q", "-b", branch, from);
  write(`src/${mod}.mjs`, `export function ${mod}(a, b) { return 0; }\n`);
  write(`test/${mod}.test.mjs`, redTest(mod));
  commitAll(`red: ${mod}`);
  const res = lykos("seal", "create");
  assert.equal(res.status, 0, `seal create on ${branch}:\n${res.out}`);
}

function seedBase(): void {
  write(".lykos/config.yaml", 'seal:\n  base: master\n  test_command: "node --test {files}"\n');
  write(".gitignore", ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
  write("README.md", "x\n");
  commitAll("base");
  const init = lykos("seal", "key", "init");
  assert.equal(init.status, 0, init.out);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lykos-seal-t200-"));
  home = join(root, "home");
  repo = join(root, "repo");
  remote = join(root, "remote.git");
  mkdirSync(home);
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "--bare", remote], { env: env() });
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo, env: env() });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo, env: env() });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("T200 ACCEPTANCE: lykos seal hook install", () => {
  it("installs a pre-push hook that blocks a tampered sealed branch and lets a clean one through", () => {
    seedBase();
    const inst = lykos("seal", "hook", "install");
    assert.equal(inst.status, 0, inst.out);
    assert.ok(existsSync(join(repo, ".git", "hooks", "pre-push")), "a pre-push hook exists");

    assert.equal(gitTry("push", "-q", "origin", "master").status, 0, "a branch without a seal pushes");

    sealBranch("feat", "master", "add");
    write("src/add.mjs", "export function add(a, b) { return a + b; }\n");
    commitAll("green");
    const clean = gitTry("push", "-q", "origin", "feat");
    assert.equal(clean.status, 0, `a clean sealed push is blocked:\n${clean.out}`);

    write("test/add.test.mjs", 'import { it } from "node:test";\nit("works", () => {});\n');
    commitAll("weaken the sealed test");
    const tampered = gitTry("push", "-q", "origin", "feat");
    assert.notEqual(tampered.status, 0, `a tampered push went through:\n${tampered.out}`);
    assert.match(tampered.out, /test\/add\.test\.mjs/, "the hook names the changed sealed path");
    const remoteHead = execFileSync("git", ["--git-dir", remote, "rev-parse", "feat"], { encoding: "utf8" }).trim();
    assert.notEqual(remoteHead, git("rev-parse", "HEAD"), "the tampered commit never reached the remote");
  });

  it("keeps an existing pre-push hook's behaviour rather than overwriting it silently", () => {
    seedBase();
    const hook = join(repo, ".git", "hooks", "pre-push");
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\necho custom-hook-ran\nexit 0\n", { mode: 0o755 });
    const inst = lykos("seal", "hook", "install");
    if (inst.status !== 0) {
      assert.match(inst.out, /pre-push|exist/i, "a refusal says why");
      return;
    }
    const push = gitTry("push", "origin", "master");
    assert.equal(push.status, 0, push.out);
    assert.match(push.out, /custom-hook-ran/, "the user's own hook still runs");
  });
});

describe("T200 ACCEPTANCE: pruning merged seals", () => {
  it("a new seal deletes the seal file of a branch merged into the base and keeps unmerged ones; verify still passes", () => {
    seedBase();
    sealBranch("feat", "master", "add");
    write("src/add.mjs", "export function add(a, b) { return a + b; }\n");
    commitAll("green");
    git("checkout", "-q", "master");
    git("merge", "-q", "--no-ff", "-m", "merge feat", "feat");
    assert.ok(existsSync(join(repo, ".lykos", "seals", "feat.json")), "a merged seal file stays as the record");

    sealBranch("stack", "master", "mul");
    // stack's own seal file was just made; feat's merged one is pruned by it.
    assert.equal(existsSync(join(repo, ".lykos", "seals", "feat.json")), false, "the merged branch's seal file is pruned");
    assert.ok(existsSync(join(repo, ".lykos", "seals", "stack.json")));

    sealBranch("next", "stack", "sub");
    assert.ok(existsSync(join(repo, ".lykos", "seals", "stack.json")), "an unmerged seal file is kept");
    assert.ok(existsSync(join(repo, ".lykos", "seals", "next.json")));

    const v = lykos("seal", "verify");
    assert.equal(v.status, 0, `a seal file pruned by a signed seal commit is not tampering:\n${v.out}`);
    // The prune is part of the seal commit, not a separate unsigned one.
    assert.match(git("log", "-1", "--format=%s", "master..stack", "--", ".lykos/seals/feat.json"), /^seal/);
  });
});
