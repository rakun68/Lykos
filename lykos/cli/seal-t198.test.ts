import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// T198 (#53) ACCEPTANCE: the vitest reporter adapter and the exit-code
// fallback. Real `lykos seal create` against a real temporary repository; the
// vitest is the one installed in Lykos's own node_modules.

const cliPath = join(import.meta.dirname, "..", "cli.ts");
const tsxImport = import.meta.resolve("tsx");

function vitestBin(): string {
  const req = createRequire(join(import.meta.dirname, "..", "..", "package.json"));
  return join(dirname(req.resolve("vitest/package.json")), "vitest.mjs").replace(/\\/g, "/");
}

let root: string;
let home: string;
let repo: string;

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
    VITEST: undefined,
  };
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: env(), encoding: "utf8" }).trim();
}

function lykos(...args: string[]): { status: number | null; out: string } {
  const res = spawnSync(process.execPath, ["--import", tsxImport, cliPath, ...args], {
    cwd: repo,
    env: env(),
    encoding: "utf8",
    timeout: 180_000,
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

function sealFile(branch: string): Record<string, any> {
  return JSON.parse(readFileSync(join(repo, ".lykos", "seals", `${branch}.json`), "utf8"));
}

function base(testCommand: string): void {
  write(".lykos/config.yaml", `seal:\n  base: master\n  test_command: ${JSON.stringify(testCommand)}\n`);
  write(".gitignore", ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\nnode_modules/\n");
  write("README.md", "x\n");
  commitAll("base");
  const init = lykos("seal", "key", "init");
  assert.equal(init.status, 0, init.out);
  git("checkout", "-q", "-b", "feat");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lykos-seal-t198-"));
  home = join(root, "home");
  repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo, env: env() });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("T198 ACCEPTANCE: the vitest adapter", () => {
  const template = () => `node ${vitestBin()} run --globals --reporter=json {files}`;

  it("tells failed, errored, skipped and uncollected tests apart, and refuses all but the failed one", () => {
    base(template());
    write("src/add.mjs", "export function add(a, b) { return 0; }\n");
    write(
      "test/failed.test.mjs",
      'import { add } from "../src/add.mjs";\ndescribe("math", () => { it("adds", () => { expect(add(1, 2)).toBe(3); }); });\n',
    );
    write(
      "test/errored.test.mjs",
      'import { nope } from "../src/missing.mjs";\ndescribe("broken", () => { it("never runs", () => { expect(nope()).toBe(1); }); });\n',
    );
    write("test/skipped.test.mjs", 'describe("later", () => { it.skip("skipped", () => { expect(1).toBe(2); }); });\n');
    write("test/empty.test.mjs", 'describe("nothing here", () => {});\n');
    commitAll("red?");
    const res = lykos("seal", "create");
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /errored\.test\.mjs[^\n]*error/i);
    assert.match(res.out, /skipped\.test\.mjs[^\n]*(skip|not collected)/i);
    assert.match(res.out, /empty\.test\.mjs[^\n]*(not collected|no test)/i);
    assert.doesNotMatch(res.out, /failed\.test\.mjs[^\n]*(error|skip|not collected|pass)/i, "the red test is no offender");
    assert.equal(existsSync(join(repo, ".lykos", "seals", "feat.json")), false);
  });

  it("seals a red vitest commit with per-test evidence by file and full describe path", () => {
    base(template());
    write("src/add.mjs", "export function add(a, b) { return 0; }\n");
    write(
      "test/add.test.mjs",
      'import { add } from "../src/add.mjs";\n' +
        'describe("math", () => { describe("add", () => { it("adds small numbers", () => { expect(add(1, 2)).toBe(3); }); }); });\n',
    );
    commitAll("red: add");
    const res = lykos("seal", "create");
    assert.equal(res.status, 0, res.out);
    const seal = sealFile("feat");
    assert.equal(seal.adapter, "vitest");
    assert.equal(seal.test_command, template());
    assert.equal(seal.red.length, 1);
    assert.equal(seal.red[0].file, "test/add.test.mjs");
    assert.deepEqual(seal.red[0].describe, ["math", "add"]);
    assert.equal(seal.red[0].name, "adds small numbers");
  });

  it("refuses a vitest test that already passes", () => {
    base(template());
    write("test/green.test.mjs", 'describe("ok", () => { it("passes", () => { expect(1).toBe(1); }); });\n');
    commitAll("green");
    const res = lykos("seal", "create");
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /green\.test\.mjs[^\n]*pass/i);
  });
});

describe("T198 ACCEPTANCE: the exit-code fallback", () => {
  // A runner Lykos has no adapter for: it runs each file and exits non-zero if any failed.
  const RUNNER =
    'import { spawnSync } from "node:child_process";\n' +
    "let bad = 0;\n" +
    'for (const f of process.argv.slice(2)) { if (spawnSync(process.execPath, [f], { stdio: "inherit" }).status !== 0) bad++; }\n' +
    "process.exit(bad ? 1 : 0);\n";

  it("seals in exit-code mode on a non-zero exit, warns, and the seal file says so", () => {
    base("node run-tests.mjs {files}");
    write("run-tests.mjs", RUNNER);
    write("test/add.test.mjs", 'import assert from "node:assert/strict";\nassert.equal(1 + 1, 3);\n');
    commitAll("red, unknown runner");
    const res = lykos("seal", "create");
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /exit.?code/i, "the weaker mode is stated");
    assert.match(res.out, /warn|weaker/i);
    const seal = sealFile("feat");
    assert.equal(seal.adapter, "exit");
  });

  it("refuses in exit-code mode when the command exits 0", () => {
    base("node run-tests.mjs {files}");
    write("run-tests.mjs", RUNNER);
    write("test/add.test.mjs", 'import assert from "node:assert/strict";\nassert.equal(1 + 1, 2);\n');
    commitAll("green, unknown runner");
    const res = lykos("seal", "create");
    assert.notEqual(res.status, 0, res.out);
    assert.equal(existsSync(join(repo, ".lykos", "seals", "feat.json")), false);
  });
});
