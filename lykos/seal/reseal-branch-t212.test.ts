// T212 ACCEPTANCE: a reseal on a branch of its own supersedes the seal it was made from.
//
// The delegated P3 demonstration (2026-10-23) upheld a dispute the way the
// orchestrator resolver does: a test-writer run on a new branch from the
// disputed one, which fixed the test and sealed. The new branch then held two
// seal files, the old one still active, so every later implementer run was
// reported `tampered` against the test the dispute had corrected. The spec
// (#21) says one seal per branch, and a reseal replaces the branch's seal.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { activeSeals } from "./active.js";
import { sealCreate } from "./create.js";
import { sealKeyInit } from "./keys.js";
import { verifySeals } from "./verify.js";

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

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, env: env(), encoding: "utf8" }).trim();
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

const addTest = (expected: number): string =>
  'import { it } from "node:test";\nimport assert from "node:assert/strict";\n' +
  `import { add } from "../src/add.mjs";\nit("adds", () => assert.equal(add(2, 2), ${expected}));\n`;

const subTest =
  'import { it } from "node:test";\nimport assert from "node:assert/strict";\n' +
  'import { sub } from "../src/add.mjs";\nit("subtracts", () => assert.equal(sub(3, 1), 2));\n';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lykos-t212-"));
  home = join(root, "home");
  repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: env() });
  write(".lykos/config.yaml", 'seal:\n  base: main\n  test_command: "node --test {files}"\n');
  write(".gitignore", ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
  write("src/add.mjs", "export function add(a, b) {\n  return 0;\n}\nexport function sub(a, b) {\n  return 0;\n}\n");
  commitAll("base");
  sealKeyInit(repo, home, env());
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The disputed seal on `writer-a`, then the upheld correction sealed on `writer-b` made from it. */
async function upheldOnABranchOfItsOwn(): Promise<Awaited<ReturnType<typeof sealCreate>>> {
  git("checkout", "-q", "-b", "writer-a");
  write("test/add.test.mjs", addTest(5));
  write("test/sub.test.mjs", subTest);
  commitAll("red: add and sub (add's expectation is wrong)");
  const first = await sealCreate({ cwd: repo, homeDir: home, env: env() });
  assert.ok(first.ok, first.errors?.join("; "));

  git("checkout", "-q", "-b", "writer-b");
  write("test/add.test.mjs", addTest(4));
  commitAll("uphold: add(2, 2) is 4, not 5");
  const second = await sealCreate({ cwd: repo, homeDir: home, env: env() });
  assert.ok(second.ok, second.errors?.join("; "));
  return second;
}

describe("T212 ACCEPTANCE: a reseal on its own branch supersedes the seal it was made from", () => {
  it("leaves one active seal, the new one, and it verifies", async () => {
    const created = await upheldOnABranchOfItsOwn();
    assert.ok(created.pruned?.includes(".lykos/seals/writer-a.json"), `pruned: ${JSON.stringify(created.pruned)}`);

    const active = activeSeals({ cwd: repo, env: env() });
    assert.deepEqual(active.map((s) => s.relPath), [".lykos/seals/writer-b.json"]);

    const res = await verifySeals({ cwd: repo, env: env(), record: false });
    assert.equal(res.code, 0, res.output);
  });

  it("keeps every test the old seal held sealed, including ones the reseal did not touch", async () => {
    const created = await upheldOnABranchOfItsOwn();
    assert.ok(created.seal!.sealed_paths.includes("test/add.test.mjs"));
    assert.ok(created.seal!.sealed_paths.includes("test/sub.test.mjs"), "an untouched test of the old seal stays sealed");
    assert.ok(!created.seal!.sealed_paths.includes(".lykos/seals/writer-a.json"), "the old seal's file is not a path of the new seal");
  });

  it("an implementer on the resealed branch verifies when it changes only source", async () => {
    await upheldOnABranchOfItsOwn();
    git("checkout", "-q", "-b", "impl");
    write("src/add.mjs", "export function add(a, b) {\n  return a + b;\n}\nexport function sub(a, b) {\n  return a - b;\n}\n");
    commitAll("implement add and sub");

    const res = await verifySeals({ cwd: repo, env: env(), record: false });
    assert.equal(res.code, 0, res.output);
  });

  it("an implementer on the resealed branch that changes the corrected test is tampered", async () => {
    await upheldOnABranchOfItsOwn();
    git("checkout", "-q", "-b", "impl");
    write("test/add.test.mjs", addTest(0));
    commitAll("weaken add");

    const res = await verifySeals({ cwd: repo, env: env(), record: false });
    assert.equal(res.code, 1, res.output);
    assert.match(res.output, /changed sealed paths: test\/add\.test\.mjs/);
  });

  it("an implementer on the resealed branch that changes a test the reseal did not touch is tampered", async () => {
    await upheldOnABranchOfItsOwn();
    git("checkout", "-q", "-b", "impl");
    write("test/sub.test.mjs", 'import { it } from "node:test";\nit("subtracts", () => {});\n');
    commitAll("weaken sub");

    const res = await verifySeals({ cwd: repo, env: env(), record: false });
    assert.equal(res.code, 1, res.output);
    assert.match(res.output, /test\/sub\.test\.mjs/);
  });

  it("a seal on an unrelated branch is not pruned by a reseal elsewhere", async () => {
    git("checkout", "-q", "-b", "other");
    write("test/sub.test.mjs", subTest);
    commitAll("red: sub on another branch");
    const other = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(other.ok, other.errors?.join("; "));

    git("checkout", "-q", "main");
    await upheldOnABranchOfItsOwn();
    git("checkout", "-q", "other");
    const active = activeSeals({ cwd: repo, env: env() });
    assert.deepEqual(active.map((s) => s.relPath), [".lykos/seals/other.json"]);
    const res = await verifySeals({ cwd: repo, env: env(), record: false });
    assert.equal(res.code, 0, res.output);
  });

  it("a three-seal chain verifies intact", async () => {
    await upheldOnABranchOfItsOwn();
    git("checkout", "-q", "-b", "writer-c");
    write(
      "test/sub.test.mjs",
      'import { it } from "node:test";\nimport assert from "node:assert/strict";\n' +
        'import { sub } from "../src/add.mjs";\nit("subtracts", () => assert.equal(sub(4, 1), 3));\n',
    );
    commitAll("uphold: sub(4, 1) is 3");
    const third = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(third.ok, third.errors?.join("; "));

    const active = activeSeals({ cwd: repo, env: env() });
    assert.deepEqual(active.map((s) => s.relPath), [".lykos/seals/writer-c.json"]);

    const res = await verifySeals({ cwd: repo, env: env(), record: false });
    assert.equal(res.code, 0, res.output);
  });

  it("a seal deleted by a commit that adds no valid signed seal is tampered", async () => {
    await upheldOnABranchOfItsOwn();
    git("checkout", "-q", "-b", "tampered-del");
    git("rm", ".lykos/seals/writer-b.json");
    commitAll("unauthorized deletion of seal");

    const res = await verifySeals({ cwd: repo, env: env(), record: false });
    assert.equal(res.code, 1, res.output);
    assert.equal(res.ok, false);
    assert.equal(res.seals[0]?.valid, false);
    assert.match(res.output, /seal file deleted/);
  });

  it("a seal deleted by a commit that replays an old signed seal from history is tampered", async () => {
    git("checkout", "-q", "-b", "prior-feat");
    write("test/prior.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("prior", () => assert.equal(1, 2));\n');
    commitAll("red: prior test");
    const priorSeal = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(priorSeal.ok, priorSeal.errors?.join("; "));
    git("checkout", "-q", "main");
    git("merge", "-q", "--no-ff", "-m", "merge prior", "prior-feat");

    git("checkout", "-q", "-b", "writer-a");
    write("test/add.test.mjs", addTest(5));
    commitAll("red: add");
    const writerSeal = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(writerSeal.ok);

    git("checkout", "-q", "-b", "attacker");
    git("rm", ".lykos/seals/writer-a.json");
    git("checkout", "main", "--", ".lykos/seals/prior-feat.json");
    write("test/add.test.mjs", addTest(0));
    commitAll("tamper: delete writer-a seal and restore prior-feat seal");

    const res = await verifySeals({ cwd: repo, env: env(), record: false });
    assert.equal(res.code, 1, res.output);
    assert.equal(res.ok, false);
    assert.match(res.output, /seal file deleted/);
  });
});
