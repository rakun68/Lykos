import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import Database from "better-sqlite3";

// T197 (#52) ACCEPTANCE: `lykos seal verify` checks every active seal, found
// through history, with git and signatures only. Every case drives the real
// CLI against a real temporary git repository; HOME is a temporary Lykos
// directory so keys never touch the user's own.

const cliPath = join(import.meta.dirname, "..", "cli.ts");
const tsxImport = import.meta.resolve("tsx");

let root: string;
let home: string;
let repo: string;

function env(h: string = home): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: h,
    USERPROFILE: h,
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

function lykosIn(cwd: string, h: string, ...args: string[]): { status: number | null; out: string } {
  const res = spawnSync(process.execPath, ["--import", tsxImport, cliPath, ...args], {
    cwd,
    env: env(h),
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

function lykos(...args: string[]) {
  return lykosIn(repo, home, ...args);
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

const CONFIG = 'seal:\n  base: master\n  test_command: "node --test {files}"\n';
const GITIGNORE = ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n";
const STUB = "export function add(a, b) { return 0; }\n";
const REAL = "export function add(a, b) { return a + b; }\n";
function redTest(name: string, mod = "add"): string {
  return (
    'import { describe, it } from "node:test";\n' +
    'import assert from "node:assert/strict";\n' +
    `import { add } from "../src/${mod}.mjs";\n` +
    `describe("math", () => { it("${name}", () => { assert.equal(add(1, 2), 3); }); });\n`
  );
}

/** master with config and a trusted key; then branch `branch` with a red test. */
function seedBase(): void {
  write(".lykos/config.yaml", CONFIG);
  write(".gitignore", GITIGNORE);
  write("README.md", "x\n");
  commitAll("base");
  const init = lykos("seal", "key", "init");
  assert.equal(init.status, 0, init.out);
}

function redBranch(branch: string, from = "master", file = "add", h = home): void {
  git("checkout", "-q", "-b", branch, from);
  write(`src/${file}.mjs`, STUB);
  write(`test/${file}.test.mjs`, redTest(`${file} works`, file));
  commitAll(`red: ${file}`);
  const res = lykosIn(repo, h, "seal", "create");
  assert.equal(res.status, 0, `seal create on ${branch}:\n${res.out}`);
}

function sealKinds(): string[] {
  const p = join(repo, ".lykos", "ledger.db");
  if (!existsSync(p)) return [];
  const db = new Database(p, { readonly: true });
  try {
    return (db.prepare("SELECT kind FROM seal_events").all() as Array<{ kind: string }>).map((r) => r.kind);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lykos-seal-t197-"));
  home = join(root, "home");
  repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo, env: env() });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("T197 ACCEPTANCE: verify passes", () => {
  it("on a clean sealed branch, including after the implementer's own commits, and records verified", () => {
    seedBase();
    redBranch("feat");
    write("src/add.mjs", REAL);
    write("test/mine.test.mjs", 'import { it } from "node:test";\nit("mine", () => {});\n');
    commitAll("green");
    const res = lykos("seal", "verify");
    assert.equal(res.status, 0, res.out);
    assert.ok(sealKinds().includes("verified"), `seal_events: ${sealKinds()}`);
  });

  it("on a branch without a seal, and says so", () => {
    seedBase();
    git("checkout", "-q", "-b", "plain");
    write("src/x.mjs", "export const x = 1;\n");
    commitAll("plain");
    const res = lykos("seal", "verify");
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /no (active )?seal/i);
  });
});

describe("T197 ACCEPTANCE: verify fails, naming the cause", () => {
  it("on a tampered sealed test, listing the path, and records tampered", () => {
    seedBase();
    redBranch("feat");
    write("test/add.test.mjs", 'import { it } from "node:test";\nit("add works", () => {});\n');
    commitAll("weaken");
    const res = lykos("seal", "verify");
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /test\/add\.test\.mjs/);
    assert.ok(sealKinds().includes("tampered"), `seal_events: ${sealKinds()}`);
  });

  it("ignores an uncommitted change: verify checks HEAD", () => {
    seedBase();
    redBranch("feat");
    write("test/add.test.mjs", "// dirty, uncommitted\n");
    const res = lykos("seal", "verify");
    assert.equal(res.status, 0, res.out);
  });

  it("on a tampered seal file", () => {
    seedBase();
    redBranch("feat");
    const p = join(repo, ".lykos", "seals", "feat.json");
    const seal = JSON.parse(readFileSync(p, "utf8"));
    seal.sealed_paths = seal.sealed_paths.filter((x: string) => x !== "test/add.test.mjs");
    writeFileSync(p, JSON.stringify(seal, null, 2) + "\n");
    commitAll("unseal the test");
    const res = lykos("seal", "verify");
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /\.lykos\/seals\/feat\.json/);
  });

  it("on a deleted seal file", () => {
    seedBase();
    redBranch("feat");
    git("rm", "-q", ".lykos/seals/feat.json");
    commitAll("delete the seal");
    const res = lykos("seal", "verify");
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /\.lykos\/seals\/feat\.json/);
  });

  it("on a seal signed by a key added on the branch itself", () => {
    seedBase();
    const rogue = join(root, "rogue-home");
    mkdirSync(rogue);
    git("checkout", "-q", "-b", "feat");
    const init = lykosIn(repo, rogue, "seal", "key", "init");
    assert.equal(init.status, 0, init.out);
    write("src/add.mjs", STUB);
    write("test/add.test.mjs", redTest("add works"));
    commitAll("red: add");
    const created = lykosIn(repo, rogue, "seal", "create");
    if (created.status !== 0) {
      // Refusing to sign with an untrusted key is also acceptable.
      assert.match(created.out, /key|trust/i, created.out);
      return;
    }
    const res = lykos("seal", "verify");
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /signature|untrusted|key/i);
  });

  it("on a seal signed by a key never committed at the base", () => {
    seedBase();
    const rogue = join(root, "rogue-home");
    const elsewhere = join(root, "elsewhere");
    mkdirSync(rogue);
    mkdirSync(elsewhere);
    execFileSync("git", ["init", "-q", "-b", "master"], { cwd: elsewhere, env: env() });
    writeFileSync(join(elsewhere, "README.md"), "y\n");
    execFileSync("git", ["add", "-A"], { cwd: elsewhere, env: env() });
    execFileSync("git", ["commit", "-q", "-m", "e"], { cwd: elsewhere, env: env() });
    assert.equal(lykosIn(elsewhere, rogue, "seal", "key", "init").status, 0);
    git("checkout", "-q", "-b", "feat");
    write("src/add.mjs", STUB);
    write("test/add.test.mjs", redTest("add works"));
    commitAll("red: add");
    const created = lykosIn(repo, rogue, "seal", "create");
    if (created.status !== 0) {
      assert.match(created.out, /key|trust/i, created.out);
      return;
    }
    const res = lykos("seal", "verify");
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /signature|untrusted|key/i);
  });

  it("on a changed test command", () => {
    seedBase();
    redBranch("feat");
    write(".lykos/config.yaml", 'seal:\n  base: master\n  test_command: "node --test test/mine.test.mjs"\n');
    commitAll("run a different command");
    const res = lykos("seal", "verify");
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /test.?command/i);
  });

  it("on a seal copied onto a history its writer commit is not part of", () => {
    seedBase();
    redBranch("feat");
    git("checkout", "-q", "-b", "rebuilt", "master");
    git("checkout", "feat", "--", ".lykos/seals/feat.json", "test/add.test.mjs", "src/add.mjs");
    commitAll("rebuilt history reusing the seal");
    const res = lykos("seal", "verify");
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /ancestor|history|writer/i);
  });
});

describe("T197 ACCEPTANCE: which seals are checked", () => {
  it("a detached HEAD finds the active seal", () => {
    seedBase();
    redBranch("feat");
    git("checkout", "-q", "--detach");
    assert.equal(lykos("seal", "verify").status, 0);
    write("test/add.test.mjs", "// gone\n");
    commitAll("tamper while detached");
    const res = lykos("seal", "verify");
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /test\/add\.test\.mjs/);
  });

  it("--branch narrows the check to one seal", () => {
    seedBase();
    redBranch("feat");
    redBranch("child", "feat", "mul");
    write("test/mul.test.mjs", "// gone\n");
    commitAll("tamper child's test");
    const all = lykos("seal", "verify");
    assert.notEqual(all.status, 0, all.out);
    const featOnly = lykos("seal", "verify", "--branch", "feat");
    assert.equal(featOnly.status, 0, featOnly.out);
    const childOnly = lykos("seal", "verify", "--branch", "child");
    assert.notEqual(childOnly.status, 0, childOnly.out);
  });

  it("a renamed branch and a new branch made from a sealed one are still checked", () => {
    seedBase();
    redBranch("feat");
    git("branch", "-m", "feat", "renamed");
    git("checkout", "-q", "-b", "offshoot");
    write("test/add.test.mjs", "// gone\n");
    commitAll("tamper on a new branch");
    const res = lykos("seal", "verify");
    assert.notEqual(res.status, 0, res.out);
    assert.match(res.out, /test\/add\.test\.mjs/);
  });

  it("a seal whose branch merged into the base is no longer active, and a new seal after it verifies", () => {
    seedBase();
    redBranch("feat");
    write("src/add.mjs", REAL);
    commitAll("green");
    git("checkout", "-q", "master");
    git("merge", "-q", "--no-ff", "-m", "merge feat", "feat");
    redBranch("next", "master", "mul");
    const res = lykos("seal", "verify");
    assert.equal(res.status, 0, res.out);
  });

  it("never runs project code", () => {
    seedBase();
    // A sealed test that leaves a marker whenever anything executes it.
    const marker = join(root, "ran.txt").replace(/\\/g, "/");
    git("checkout", "-q", "-b", "feat");
    write("src/add.mjs", STUB);
    write(
      "test/add.test.mjs",
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "x");\n` + redTest("add works"),
    );
    commitAll("red: add, with a marker");
    assert.equal(lykos("seal", "create").status, 0);
    assert.equal(existsSync(marker), true, "the red run executed the test");
    rmSync(marker);
    const res = lykos("seal", "verify");
    assert.equal(res.status, 0, res.out);
    assert.equal(existsSync(marker), false, "verify executed project code");
  });
});
