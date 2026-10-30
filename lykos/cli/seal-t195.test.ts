import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

// T195 (#50) ACCEPTANCE: a test writer's red commit becomes a signed seal.
// Every case drives the real `lykos seal` command against a real temporary
// git repository, with HOME pointing at a temporary Lykos directory so the
// private key and the project registry never touch the user's own.

const cliPath = join(import.meta.dirname, "..", "cli.ts");
const tsxImport = import.meta.resolve("tsx");

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

function sealFile(branch: string): Record<string, any> {
  return JSON.parse(readFileSync(join(repo, ".lykos", "seals", `${branch}.json`), "utf8"));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const STUB = "export function add(a, b) { return 0; }\n";
const REAL = "export function add(a, b) { return a + b; }\n";
const RED_TEST =
  'import { describe, it } from "node:test";\n' +
  'import assert from "node:assert/strict";\n' +
  'import { add } from "../src/add.mjs";\n' +
  'describe("math", () => { it("adds", () => { assert.equal(add(1, 2), 3); }); });\n';

/** master: config + fixture; key init; branch feat with a red test and its stub. */
function seedRedBranch(): string {
  write(".lykos/config.yaml", "seal:\n  base: master\n  test_command: \"node --test {files}\"\n");
  write("fixtures/sample.json", "{}\n");
  write("README.md", "x\n");
  commitAll("base");
  const init = lykos("seal", "key", "init");
  assert.equal(init.status, 0, init.out);
  git("checkout", "-q", "-b", "feat");
  write("src/add.mjs", STUB);
  write("test/add.test.mjs", RED_TEST);
  return commitAll("red: add");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lykos-seal-t195-"));
  home = join(root, "home");
  repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo, env: env() });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("T195 ACCEPTANCE: lykos seal key init", () => {
  it("creates a pair, commits only the public half under .lykos/seals/keys/, and keeps the private key out of the repo", () => {
    write("README.md", "x\n");
    commitAll("base");
    const before = git("rev-parse", "HEAD");
    const res = lykos("seal", "key", "init");
    assert.equal(res.status, 0, res.out);
    assert.notEqual(git("rev-parse", "HEAD"), before, "key init commits the public key");
    const tracked = git("ls-files", ".lykos/seals/keys").split("\n").filter(Boolean);
    assert.ok(tracked.length >= 1, "a public key is tracked under .lykos/seals/keys/");
    for (const f of walk(repo)) {
      assert.doesNotMatch(readFileSync(f, "utf8"), /PRIVATE KEY/, `private key material in the repo: ${f}`);
    }
    const homeFiles = walk(join(home, ".lykos"));
    assert.ok(
      homeFiles.some((f) => /PRIVATE KEY/.test(readFileSync(f, "utf8"))),
      "the private key lives in the user's Lykos directory",
    );
  });
});

describe("T195 ACCEPTANCE: lykos seal create", () => {
  it("seals a red commit: signed, committed, covering only test files, the always-sealed globs and itself", () => {
    const writerCommit = seedRedBranch();
    // A dirty working tree that would turn the test green must not matter:
    // the red check runs against the commit in a clean checkout.
    write("src/add.mjs", REAL);
    const res = lykos("seal", "create");
    assert.equal(res.status, 0, res.out);

    const seal = sealFile("feat");
    const paths: string[] = seal.sealed_paths;
    assert.ok(paths.includes("test/add.test.mjs"), `sealed_paths: ${paths}`);
    assert.ok(paths.includes("fixtures/sample.json"), "always-sealed fixture directory is sealed");
    assert.ok(paths.includes(".lykos/seals/feat.json"), "the seal file seals itself");
    assert.ok(!paths.includes("src/add.mjs"), "the stub stays editable");
    assert.equal(seal.branch, "feat");
    assert.equal(seal.writer_commit, writerCommit);
    assert.equal(seal.test_command, "node --test {files}");
    assert.equal(typeof seal.signature, "string");
    assert.ok(seal.signature.length > 0);
    assert.equal(typeof seal.key_id, "string");

    const red: Array<{ file: string; describe: string[]; name: string }> = seal.red;
    assert.equal(red.length, 1);
    assert.equal(red[0]!.file, "test/add.test.mjs");
    assert.deepEqual(red[0]!.describe, ["math"]);
    assert.equal(red[0]!.name, "adds");

    // The seal commit is HEAD, adds the seal file, and the dirty stub stays uncommitted.
    assert.match(git("show", "--name-only", "--format=", "HEAD"), /\.lykos\/seals\/feat\.json/);
    assert.equal(git("rev-parse", "HEAD~1"), writerCommit);
    assert.match(git("status", "--porcelain"), /src\/add\.mjs/);
  });

  it("refuses a passing, an erroring and an uncollected test, naming each with its reason, and writes no seal", () => {
    write(".lykos/config.yaml", "seal:\n  base: master\n  test_command: \"node --test {files}\"\n");
    write("README.md", "x\n");
    commitAll("base");
    assert.equal(lykos("seal", "key", "init").status, 0);
    git("checkout", "-q", "-b", "feat");
    write(
      "test/passes.test.mjs",
      'import { it } from "node:test";\nit("already green", () => {});\n',
    );
    write(
      "test/errors.test.mjs",
      'import { it } from "node:test";\nimport { nope } from "../src/missing.mjs";\nit("never runs", () => { nope(); });\n',
    );
    write(
      "test/empty.test.mjs",
      'import { it } from "node:test";\nit.skip("skipped", () => { throw new Error("x"); });\n',
    );
    const before = git("rev-parse", "HEAD");
    commitAll("red?");
    const res = lykos("seal", "create");
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /passes\.test\.mjs[^\n]*pass/i);
    assert.match(res.out, /errors\.test\.mjs[^\n]*error/i);
    assert.match(res.out, /empty\.test\.mjs[^\n]*(not collected|uncollected|skip)/i);
    assert.equal(existsSync(join(repo, ".lykos", "seals", "feat.json")), false);
    assert.notEqual(git("rev-parse", "HEAD"), before);
    assert.equal(git("log", "-1", "--format=%s"), "red?", "no seal commit was made");
  });

  it("refuses two sealed tests with one identity (file plus full describe path)", () => {
    write(".lykos/config.yaml", "seal:\n  base: master\n  test_command: \"node --test {files}\"\n");
    write("README.md", "x\n");
    commitAll("base");
    assert.equal(lykos("seal", "key", "init").status, 0);
    git("checkout", "-q", "-b", "feat");
    write(
      "test/dup.test.mjs",
      'import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\n' +
        'describe("x", () => {\n  it("same", () => { assert.equal(1, 2); });\n  it("same", () => { assert.equal(3, 4); });\n});\n',
    );
    commitAll("dup");
    const res = lykos("seal", "create");
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /dup\.test\.mjs/);
    assert.match(res.out, /same/);
    assert.equal(existsSync(join(repo, ".lykos", "seals", "feat.json")), false);
  });
});

describe("T195 ACCEPTANCE: lykos seal status", () => {
  it("shows the seal commit, sealed paths and red evidence", () => {
    seedRedBranch();
    assert.equal(lykos("seal", "create").status, 0);
    const sealCommit = git("rev-parse", "HEAD");
    const res = lykos("seal", "status");
    assert.equal(res.status, 0, res.out);
    assert.ok(res.out.includes(sealCommit) || res.out.includes(sealCommit.slice(0, 7)), res.out);
    assert.match(res.out, /test\/add\.test\.mjs/);
    assert.match(res.out, /adds/);
  });

  it("finds the seal through history on a renamed branch and on a new branch made from the sealed one", () => {
    seedRedBranch();
    assert.equal(lykos("seal", "create").status, 0);
    const sealCommit = git("rev-parse", "HEAD");
    const short = sealCommit.slice(0, 7);

    git("branch", "-m", "feat", "renamed");
    const renamed = lykos("seal", "status");
    assert.equal(renamed.status, 0, renamed.out);
    assert.ok(renamed.out.includes(short), `renamed branch lost its seal:\n${renamed.out}`);
    assert.match(renamed.out, /test\/add\.test\.mjs/);

    git("checkout", "-q", "-b", "child");
    write("src/add.mjs", REAL);
    commitAll("green");
    const child = lykos("seal", "status");
    assert.equal(child.status, 0, child.out);
    assert.ok(child.out.includes(short), `child branch lost its seal:\n${child.out}`);
  });

  it("reports no seal on a branch without one", () => {
    write(".lykos/config.yaml", "seal:\n  base: master\n");
    write("README.md", "x\n");
    commitAll("base");
    git("checkout", "-q", "-b", "plain");
    const res = lykos("seal", "status");
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /no (active )?seal/i);
  });
});

