import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { localExecutor } from "../tools/executor.js";
import { activeSeals } from "./active.js";
import { sealCreate } from "./create.js";
import { generateEd25519KeyPair, signPayload, verifySignature } from "./crypto.js";
import { createTemporaryWorktree } from "./git.js";
import { sealKeyInit } from "./keys.js";
import { runSealedTests } from "./runner.js";
import { sealStatus } from "./status.js";
import { verifySeals } from "./verify.js";
import { installSealHook } from "./hook.js";

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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lykos-seal-unit-"));
  home = join(root, "home");
  repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "master"], { cwd: repo, env: env() });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("pure seal unit tests", () => {
  it("verifies and detects tampered signature", () => {
    const { publicKeyPem, privateKeyPem } = generateEd25519KeyPair();
    const payload = { branch: "feat", value: 42, text: "abc" };
    const sig = signPayload(payload, privateKeyPem);

    assert.ok(verifySignature(payload, sig, publicKeyPem));

    // Tampered payload
    assert.equal(verifySignature({ ...payload, value: 43 }, sig, publicKeyPem), false);

    // Tampered signature
    const badSig = (sig.startsWith("0") ? "1" : "0") + sig.slice(1);
    assert.equal(verifySignature(payload, badSig, publicKeyPem), false);
  });

  it("detects tampered seal file in status", async () => {
    write(".lykos/config.yaml", "seal:\n  base: master\n  test_command: \"node --test {files}\"\n");
    write("README.md", "x\n");
    commitAll("base");
    sealKeyInit(repo, home, env());

    git("checkout", "-q", "-b", "feat");
    write("test/fail.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("f", () => assert.equal(1, 2));\n');
    commitAll("red");

    const created = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(created.ok);

    // Tamper with the seal file on disk and commit
    const sealPath = join(repo, ".lykos", "seals", "feat.json");
    const seal = JSON.parse(readFileSync(sealPath, "utf8"));
    seal.red[0].name = "tampered-name";
    writeFileSync(sealPath, JSON.stringify(seal, null, 2) + "\n");
    commitAll("tamper seal");

    const statusRes = sealStatus({ cwd: repo, env: env() });
    assert.equal(statusRes.code, 1);
    assert.equal(statusRes.seals.length, 1);
    assert.equal(statusRes.seals[0]!.verdict, "tampered");
  });

  it("detects stale seal when sealed file is modified after writer commit", async () => {
    write(".lykos/config.yaml", "seal:\n  base: master\n  test_command: \"node --test {files}\"\n");
    write("README.md", "x\n");
    commitAll("base");
    sealKeyInit(repo, home, env());

    git("checkout", "-q", "-b", "feat");
    write("test/fail.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("f", () => assert.equal(1, 2));\n');
    commitAll("red");

    const created = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(created.ok);

    // Modify the sealed test file after writer commit
    write("test/fail.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("f", () => assert.equal(2, 3));\n');
    commitAll("change test after seal");

    const statusRes = sealStatus({ cwd: repo, env: env() });
    assert.equal(statusRes.code, 1);
    assert.equal(statusRes.seals.length, 1);
    assert.equal(statusRes.seals[0]!.verdict, "stale");
    assert.match(statusRes.seals[0]!.reason!, /sealed paths modified/);
  });

  it("supports JSON output format in status", async () => {
    write(".lykos/config.yaml", "seal:\n  base: master\n  test_command: \"node --test {files}\"\n");
    write("README.md", "x\n");
    commitAll("base");
    sealKeyInit(repo, home, env());

    git("checkout", "-q", "-b", "feat");
    write("test/fail.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("f", () => assert.equal(1, 2));\n');
    commitAll("red");

    const created = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(created.ok);

    const statusRes = sealStatus({ cwd: repo, env: env(), json: true });
    assert.equal(statusRes.code, 0);
    const parsed = JSON.parse(statusRes.output);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].branch, "feat");
    assert.equal(parsed[0].verdict, "valid");
  });

  // Fix 1 & 1.both.11: createTemporaryWorktree cleanup unlinks junction and preserves source files (node_modules untracked)
  it("preserves source node_modules files after createTemporaryWorktree cleanup", () => {
    write(".gitignore", "node_modules/\n");
    write("README.md", "init\n");
    commitAll("init");

    // Write untracked node_modules on host so junction/symlink branch is exercised
    write("node_modules/fake-pkg/index.js", "module.exports = 42;\n");

    const { dir, cleanup } = createTemporaryWorktree(repo, "HEAD", env());
    const tempPkgFile = join(dir, "node_modules", "fake-pkg", "index.js");
    assert.ok(existsSync(tempPkgFile), "junction provides fake-pkg in temp worktree");

    cleanup();

    const srcPkgFile = join(repo, "node_modules", "fake-pkg", "index.js");
    assert.ok(existsSync(srcPkgFile), "source node_modules file must not be deleted");
    assert.equal(readFileSync(srcPkgFile, "utf8"), "module.exports = 42;\n");
  });

  // Fix 2: activeSeals discovers seal from history when deleted at HEAD
  it("discovers seal deleted at HEAD from history and status reports tampered", async () => {
    write(".lykos/config.yaml", "seal:\n  base: master\n  test_command: \"node --test {files}\"\n");
    write("README.md", "x\n");
    commitAll("base");
    sealKeyInit(repo, home, env());

    git("checkout", "-q", "-b", "feat");
    write("test/fail.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("f", () => assert.equal(1, 2));\n');
    commitAll("red");

    const created = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(created.ok);

    // Delete seal file at HEAD
    git("rm", ".lykos/seals/feat.json");
    commitAll("delete seal file");

    const seals = activeSeals({ cwd: repo, env: env() });
    assert.equal(seals.length, 1, "activeSeals finds seal from history");
    assert.equal(seals[0]!.missingAtHead, true);

    const statusRes = sealStatus({ cwd: repo, env: env() });
    assert.equal(statusRes.code, 1);
    assert.equal(statusRes.seals.length, 1);
    assert.equal(statusRes.seals[0]!.verdict, "tampered");
    assert.match(statusRes.seals[0]!.reason!, /missing at HEAD/);
  });

  // Fix 3: merged check uses isAncestor on seal commit and base, never looks up branch ref
  it("excludes merged seals via merge-base is-ancestor check without branch ref lookup", async () => {
    write(".lykos/config.yaml", "seal:\n  base: master\n  test_command: \"node --test {files}\"\n");
    write("README.md", "x\n");
    commitAll("base");
    sealKeyInit(repo, home, env());

    git("checkout", "-q", "-b", "feat");
    write("test/fail.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("f", () => assert.equal(1, 2));\n');
    commitAll("red");

    const created = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(created.ok);

    // Merge feat into master
    git("checkout", "master");
    git("merge", "--no-ff", "-m", "merge feat", "feat");

    // On master, seal commit is merged into master, so activeSeals must return 0
    const sealsOnMaster = activeSeals({ cwd: repo, env: env() });
    assert.equal(sealsOnMaster.length, 0, "merged seal is not active on base");

    // Delete local branch ref 'feat' to ensure we never rely on branch ref lookup
    git("branch", "-D", "feat");
    const statusRes = sealStatus({ cwd: repo, env: env() });
    assert.equal(statusRes.code, 0);
  });

  // Fix 4: sealed paths are writer commit vs first parent, reseal unions previous sealed paths
  it("seals only writer commit tests vs parent and reseal unions previous sealed paths", async () => {
    write(".lykos/config.yaml", "seal:\n  base: master\n  test_command: \"node --test {files}\"\n");
    write("README.md", "x\n");
    commitAll("base");
    sealKeyInit(repo, home, env());

    git("checkout", "-q", "-b", "feat");
    // Implementer adds test earlier on branch
    write("test/unsealed.test.mjs", 'import { it } from "node:test";\nit("unsealed", () => {});\n');
    commitAll("implementer test");

    // Test writer commits red test
    write("test/red1.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("r1", () => assert.equal(1, 2));\n');
    commitAll("red 1");

    const created1 = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(created1.ok);
    assert.ok(created1.seal!.sealed_paths.includes("test/red1.test.mjs"));
    assert.ok(!created1.seal!.sealed_paths.includes("test/unsealed.test.mjs"), "implementer test stays unsealed");

    // Reseal: writer adds red 2
    write("test/red2.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("r2", () => assert.equal(3, 4));\n');
    commitAll("red 2");

    const created2 = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(created2.ok);
    assert.ok(created2.seal!.sealed_paths.includes("test/red1.test.mjs"), "previous sealed test retained");
    assert.ok(created2.seal!.sealed_paths.includes("test/red2.test.mjs"), "new sealed test included");
    assert.ok(!created2.seal!.sealed_paths.includes("test/unsealed.test.mjs"), "implementer test still unsealed");
  });

  // Fix 5 & 6: runSealedTests routes through ProjectExecutor and strips NODE_TEST_CONTEXT and VITEST
  it("runs sealed tests through ProjectExecutor and strips test context env", async () => {
    write(
      "test/sample.test.mjs",
      'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("sample", () => assert.equal(1, 2));\n',
    );

    const res = await runSealedTests({
      executor: localExecutor,
      dir: repo,
      files: ["test/sample.test.mjs"],
      template: "node --test {files}",
      mode: "red",
      env: {
        ...env(),
        NODE_TEST_CONTEXT: "inherited_context",
        VITEST: "1",
      },
    });

    assert.ok(res.ok, "runSealedTests succeeded despite inherited NODE_TEST_CONTEXT");
    assert.equal(res.tests.length, 1);
    assert.equal(res.tests[0]!.status, "assertion");
    assert.equal(res.tests[0]!.name, "sample");
  });

  // A passing test keeps its describe path, as a failing one does: the green run matches the red list by it.
  it("a passing test in the green run keeps its describe path", async () => {
    write(
      "test/nested.test.mjs",
      'import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\ndescribe("math", () => { describe("ints", () => { it("adds", () => assert.equal(1 + 2, 3)); }); });\n',
    );
    const res = await runSealedTests({
      executor: localExecutor,
      dir: repo,
      files: ["test/nested.test.mjs"],
      template: "node --test {files}",
      mode: "green",
      env: env(),
    });
    assert.ok(res.ok, res.errors.join("; "));
    assert.deepEqual(res.tests.map((t) => ({ name: t.name, describe: t.describe, status: t.status })), [
      { name: "adds", describe: ["math", "ints"], status: "pass" },
    ]);
  });

  // Fix 7: detached HEAD refused without --branch
  it("refuses create on detached HEAD unless --branch is specified", async () => {
    write(".lykos/config.yaml", "seal:\n  base: master\n  test_command: \"node --test {files}\"\n");
    write("README.md", "x\n");
    commitAll("base");
    sealKeyInit(repo, home, env());

    git("checkout", "-q", "-b", "feat");
    write("test/fail.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("f", () => assert.equal(1, 2));\n');
    commitAll("red");

    // Detach HEAD
    git("checkout", "--detach", "HEAD");

    const failRes = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.equal(failRes.ok, false);
    assert.match(failRes.errors![0]!, /detached HEAD/);

    const okRes = await sealCreate({ cwd: repo, homeDir: home, env: env(), branch: "my-branch" });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.seal!.branch, "my-branch");
    assert.ok(existsSync(join(repo, ".lykos", "seals", "my-branch.json")));
    assert.ok(!existsSync(join(repo, ".lykos", "seals", "HEAD.json")));
  });

  // Fix: non-ASCII test file name with core.quotepath=false
  it("handles non-ASCII test file names with quotepath disabled", async () => {
    write(".lykos/config.yaml", "seal:\n  base: master\n  test_command: \"node --test {files}\"\n");
    write("README.md", "x\n");
    commitAll("base");
    sealKeyInit(repo, home, env());

    git("checkout", "-q", "-b", "feat");
    write("test/привет.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("p", () => assert.equal(1, 2));\n');
    commitAll("red non-ascii");

    const created = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(created.ok);
    assert.ok(created.seal!.sealed_paths.some((p) => p.includes("привет")));

    const statusRes = sealStatus({ cwd: repo, env: env() });
    assert.equal(statusRes.code, 0);
    assert.equal(statusRes.seals.length, 1);
    assert.equal(statusRes.seals[0]!.verdict, "valid");
  });

  // Fix 1.both.10: refuses create if target commit does not resolve to HEAD
  it("refuses create if target commit does not resolve to HEAD", async () => {
    write(".lykos/config.yaml", "seal:\n  base: master\n  test_command: \"node --test {files}\"\n");
    write("README.md", "x\n");
    commitAll("base");
    sealKeyInit(repo, home, env());

    git("checkout", "-q", "-b", "feat");
    write("test/fail.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("f", () => assert.equal(1, 2));\n');
    commitAll("red");

    write("extra.txt", "more\n");
    commitAll("extra");

    const res = await sealCreate({ cwd: repo, homeDir: home, env: env(), targetCommit: "HEAD~1" });
    assert.equal(res.ok, false);
    assert.match(res.errors![0]!, /does not resolve to HEAD/);
  });

  // Fix 1.both.2: does not union sealed_paths from untrusted or invalid seal on reseal
  it("does not union sealed_paths from an untrusted or invalid seal on reseal", async () => {
    write(".lykos/config.yaml", "seal:\n  base: master\n  test_command: \"node --test {files}\"\n");
    write("README.md", "x\n");
    commitAll("base");
    sealKeyInit(repo, home, env());

    git("checkout", "-q", "-b", "feat");

    // Fake seal committed with a bogus key_id injecting malicious path
    const fakeSeal = {
      version: 1,
      branch: "feat",
      writer_commit: git("rev-parse", "HEAD"),
      creator: "cli",
      specialist: null,
      sealed_paths: ["injected/secret.txt"],
      test_command: "node --test {files}",
      adapter: "node:test",
      red: [],
      created_at: new Date().toISOString(),
      key_id: "deadbeef00000000",
      signature: "0000",
    };
    write(".lykos/seals/feat.json", JSON.stringify(fakeSeal));
    commitAll("fake seal");

    // Writer commits red test
    write("test/real.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("r", () => assert.equal(1, 2));\n');
    commitAll("red real");

    const created = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(created.ok);
    assert.ok(!created.seal!.sealed_paths.includes("injected/secret.txt"), "untrusted paths not injected into new seal");
    assert.ok(created.seal!.sealed_paths.includes("test/real.test.mjs"));
  });

  it("fails on a tampered sealed test even when the branch commits seal.base at itself", async () => {
    write(".lykos/config.yaml", 'seal:\n  base: master\n  test_command: "node --test {files}"\n');
    write(".gitignore", ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    write("README.md", "x\n");
    commitAll("base");
    sealKeyInit(repo, home, env());
    git("checkout", "-q", "-b", "feat");
    write("test/a.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("x", () => assert.equal(1,2));\n');
    commitAll("red");
    assert.ok((await sealCreate({ cwd: repo, homeDir: home, env: env() })).ok);

    write("test/a.test.mjs", 'import { it } from "node:test";\nit("x", () => {});\n');
    commitAll("tamper");
    write(".lykos/config.yaml", 'seal:\n  base: feat\n  test_command: "node --test {files}"\n');
    commitAll("hide the seal by changing seal.base");

    const res = await verifySeals({ cwd: repo, env: env(), record: false });
    assert.equal(res.code, 1, `verify passed on a tampered sealed test: ${res.output}`);
  });

  it("fails on a sealed test tampered in a commit that re-adds the seal file", async () => {
    write(".lykos/config.yaml", 'seal:\n  base: master\n  test_command: "node --test {files}"\n');
    write(".gitignore", ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    write("README.md", "x\n");
    commitAll("base");
    sealKeyInit(repo, home, env());
    git("checkout", "-q", "-b", "feat");
    write("test/a.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("x", () => assert.equal(1,2));\n');
    commitAll("red");
    assert.ok((await sealCreate({ cwd: repo, homeDir: home, env: env() })).ok);
    const sealText = readFileSync(join(repo, ".lykos", "seals", "feat.json"), "utf8");

    git("rm", "-q", ".lykos/seals/feat.json");
    commitAll("delete seal");
    write("test/a.test.mjs", 'import { it } from "node:test";\nit("x", () => {});\n');
    write(".lykos/seals/feat.json", sealText);
    commitAll("re-add seal and tamper test");

    const res = await verifySeals({ cwd: repo, env: env(), record: false });
    assert.equal(res.code, 1, `verify passed on a tampered sealed test: ${res.output}`);
  });

  it("accepts a seal file pruned by a later signed seal commit", async () => {
    write(".lykos/config.yaml", 'seal:\n  base: master\n  test_command: "node --test {files}"\n');
    write(".gitignore", ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    write("README.md", "x\n");
    commitAll("base");
    sealKeyInit(repo, home, env());

    git("checkout", "-q", "-b", "feat1");
    write("test/feat1.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("x", () => assert.equal(1, 2));\n');
    commitAll("red 1");
    assert.ok((await sealCreate({ cwd: repo, homeDir: home, env: env() })).ok);

    git("checkout", "-q", "-b", "feat2");
    // feat2 changes feat1's test so it supersedes feat1 and seals feat1's test path too
    write("test/feat1.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("x", () => assert.equal(1, 3));\n');
    commitAll("red 2");
    assert.ok((await sealCreate({ cwd: repo, homeDir: home, env: env() })).ok);

    const res = await verifySeals({ cwd: repo, env: env(), record: false });
    assert.equal(res.code, 0, `expected pruning accepted, got:\n${res.output}`);
  });

  it("a seal deleted by a later seal commit that does not cover its paths is tampered", async () => {
    write(".lykos/config.yaml", 'seal:\n  base: master\n  test_command: "node --test {files}"\n');
    write(".gitignore", ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    write("README.md", "x\n");
    commitAll("base");
    sealKeyInit(repo, home, env());

    git("checkout", "-q", "-b", "feat1");
    write("test/feat1.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("x", () => assert.equal(1, 2));\n');
    commitAll("red 1");
    assert.ok((await sealCreate({ cwd: repo, homeDir: home, env: env() })).ok);

    git("checkout", "-q", "-b", "feat2");
    write("test/feat2.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("x", () => assert.equal(1, 2));\n');
    commitAll("red 2");
    assert.ok((await sealCreate({ cwd: repo, homeDir: home, env: env() })).ok);

    git("rm", "-q", ".lykos/seals/feat1.json");
    git("commit", "--amend", "-q", "-C", "HEAD");

    const res = await verifySeals({ cwd: repo, env: env(), record: false });
    assert.equal(res.code, 1, `expected tampering, got:\n${res.output}`);
    assert.match(res.output, /seal file deleted/);
  });

  it("create refuses a self base from the working tree and from HEAD's config", async () => {
    // HEAD config deliberately omits seal.base (valid; defaults to master).
    write(".lykos/config.yaml", 'seal:\n  test_command: "node --test {files}"\n');
    write(".gitignore", ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    write("README.md", "x\n");
    commitAll("base");
    sealKeyInit(repo, home, env());
    git("checkout", "-q", "-b", "feat");
    write("test/a.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("x", () => assert.equal(1,2));\n');
    commitAll("red");

    // Uncommitted config points base at the branch being sealed: create does not sign working-tree base, falls back to master
    write(".lykos/config.yaml", 'seal:\n  base: feat\n  test_command: "node --test {files}"\n');
    const created = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(created.ok, `create failed: ${created.errors?.join("; ")}`);
    assert.equal(created.seal?.base, "master");

    // Committed config at HEAD points base at the branch being sealed: create refuses
    write(".lykos/config.yaml", 'seal:\n  base: feat\n  test_command: "node --test {files}"\n');
    commitAll("self base at HEAD");
    write("test/a.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("x", () => assert.equal(1,3));\n');
    commitAll("red 2");
    const refused = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.equal(refused.ok, false);
    assert.ok(refused.errors?.some((e) => e.includes("seal.base must be a branch this one was made from")));
  });

  it("a reseal with a different base and a branch-only key makes verify fail", async () => {
    write(".lykos/config.yaml", 'seal:\n  base: master\n  test_command: "node --test {files}"\n');
    write(".gitignore", ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    write("README.md", "x\n");
    commitAll("base");
    sealKeyInit(repo, home, env());

    git("checkout", "-q", "-b", "feat");
    write("test/a.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("x", () => assert.equal(1,2));\n');
    commitAll("red");

    const created1 = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(created1.ok, `create failed: ${created1.errors?.join("; ")}`);

    // Add a branch-only key in repo
    const home2 = join(root, "home2");
    mkdirSync(home2);
    sealKeyInit(repo, home2, env());

    // Change committed base in HEAD config to another branch, and reseal with the branch-only key
    git("checkout", "master");
    git("checkout", "-b", "other");
    git("checkout", "feat");
    write(".lykos/config.yaml", 'seal:\n  base: other\n  test_command: "node --test {files}"\n');
    commitAll("change base to other");

    write("test/a.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("x", () => assert.equal(1,4));\n');
    commitAll("red 2");

    const env2 = { ...env(), HOME: home2, USERPROFILE: home2 };
    const created2 = await sealCreate({ cwd: repo, homeDir: home2, env: env2 });
    assert.ok(created2.ok, `reseal failed: ${created2.errors?.join("; ")}`);

    const res = await verifySeals({ cwd: repo, env: env(), record: false });
    assert.equal(res.code, 1, `verify should fail on base change / branch-only key: ${res.output}`);
    assert.ok(res.output.includes("seal base changed") || res.output.includes("untrusted key"));
  });

  it("installSealHook sets up pre-push hook and updates idempotent blocks", () => {
    const res1 = installSealHook(repo, env());
    assert.ok(res1.ok);
    assert.equal(res1.action, "installed");
    const res2 = installSealHook(repo, env());
    assert.ok(res2.ok);
    assert.equal(res2.action, "updated");
  });

  it("verifySeals with commit verifies that commit instead of HEAD", async () => {
    write(".lykos/config.yaml", 'seal:\n  base: main\n  test_command: "node --test {files}"\n');
    write(".gitignore", ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    write("README.md", "hello\n");
    git("branch", "-M", "main");
    commitAll("base");
    sealKeyInit(repo, home, env());

    git("checkout", "-b", "feat");
    write("test/add.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("x", () => assert.equal(1,2));\n');
    commitAll("red");
    const created = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(created.ok);
    const cleanCommit = created.sealCommit!;

    write("test/add.test.mjs", 'import { it } from "node:test";\nit("x", () => {});\n');
    const tamperedCommit = commitAll("tamper");

    git("checkout", "main");

    const cleanRes = await verifySeals({ cwd: repo, env: env(), commit: cleanCommit, record: false });
    assert.equal(cleanRes.code, 0, cleanRes.output);

    const tamperedRes = await verifySeals({ cwd: repo, env: env(), commit: tamperedCommit, record: false });
    assert.equal(tamperedRes.code, 1, tamperedRes.output);
    assert.match(tamperedRes.output, /changed sealed paths/);
  });

  it("pre-push hook blocks pushing a tampered feat branch while on main", async () => {
    const remote = join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote], { env: env() });
    git("remote", "add", "origin", remote);

    write(".lykos/config.yaml", 'seal:\n  base: main\n  test_command: "node --test {files}"\n');
    write(".gitignore", ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    write("README.md", "hello\n");
    git("branch", "-M", "main");
    commitAll("base");
    sealKeyInit(repo, home, env());

    installSealHook(repo, env());

    git("checkout", "-b", "feat");
    write("test/add.test.mjs", 'import { it } from "node:test";\nimport assert from "node:assert/strict";\nit("x", () => assert.equal(1,2));\n');
    commitAll("red");
    const created = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(created.ok, `seal create failed: ${created.errors?.join("; ")}`);

    write("test/add.test.mjs", 'import { it } from "node:test";\nit("x", () => {});\n');
    commitAll("tamper");

    git("checkout", "main");

    let pushFailed = false;
    let pushOut = "";
    try {
      execFileSync("git", ["push", "origin", "feat"], {
        cwd: repo,
        env: env(),
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: any) {
      pushFailed = true;
      pushOut = `${err.stdout ?? ""} ${err.stderr ?? ""}`;
    }

    assert.ok(pushFailed, "pushing tampered feat from main must be blocked by pre-push hook");
    assert.match(pushOut, /Seal verification failed|changed sealed paths/);
  });

  it("an existing non-shell pre-push hook keeps working after lykos seal hook install", () => {
    const remote = join(root, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", remote], { env: env() });
    git("remote", "add", "origin", remote);
    write("README.md", "x\n");
    git("branch", "-M", "master");
    commitAll("base");

    const hook = join(repo, ".git", "hooks", "pre-push");
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    writeFileSync(hook, '#!/usr/bin/env node\nconsole.log("custom-hook-ran");\nprocess.exit(0);\n', { mode: 0o755 });

    const inst = installSealHook(repo, env());
    assert.ok(inst.ok);

    const pushOut = execFileSync("git", ["push", "origin", "master"], {
      cwd: repo,
      env: env(),
      encoding: "utf8",
    });
    assert.match(pushOut, /custom-hook-ran/, "the user's own hook still ran");
  });

  // Windows has no execute bit; Git for Windows runs a hook whatever its mode.
  it("lykos seal hook install leaves an existing non-executable pre-push hook executable", { skip: process.platform === "win32" }, () => {
    const hook = join(repo, ".git", "hooks", "pre-push");
    mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\nexit 0\n", { mode: 0o644 });

    const inst = installSealHook(repo, env());
    assert.ok(inst.ok);
    const mode = statSync(hook).mode;
    assert.ok((mode & 0o111) !== 0, `installed hook is not executable (mode ${(mode & 0o777).toString(8)}); git skips it`);
  });

  it("detects seal rollback and deleted sealed file as tampering (F1)", async () => {
    write(".lykos/config.yaml", 'seal:\n  base: master\n  test_command: "node --test {files}"\n');
    write("README.md", "# test");
    commitAll("initial");

    const initRes = sealKeyInit(repo, home, env());
    assert.ok(initRes.keyId);

    git("checkout", "-b", "feat");
    write("test/a.test.mjs", 'import { it } from "node:test"; import assert from "node:assert/strict"; it("fails a", () => { assert.fail("red"); });\n');
    commitAll("red: a");

    const res1 = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(res1.ok, res1.errors?.join("; "));
    const s1Content = readFileSync(join(repo, ".lykos/seals/feat.json"), "utf8");

    // Reseal adding test/b.test.mjs
    write("test/b.test.mjs", 'import { it } from "node:test"; import assert from "node:assert/strict"; it("fails b", () => { assert.fail("red"); });\n');
    commitAll("red: b");
    const res2 = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(res2.ok, res2.errors?.join("; "));
    const s2Commit = git("rev-parse", "HEAD");

    // Implementer rolls back seal file to S1 and deletes test/b
    writeFileSync(join(repo, ".lykos/seals/feat.json"), s1Content);
    rmSync(join(repo, "test/b.test.mjs"));
    commitAll("rollback to S1 and delete b");

    const active = activeSeals({ cwd: repo, env: env() });
    assert.equal(active.length, 1);
    assert.equal(active[0]!.sealCommit, s2Commit, "active seal must be latest signed seal commit");
    assert.equal(active[0]!.rolledBackAtHead, true, "rollback must be flagged");

    const st = sealStatus({ cwd: repo, env: env() });
    assert.equal(st.seals[0]!.verdict, "tampered");

    const ver = await verifySeals({ cwd: repo, env: env(), record: false });
    assert.equal(ver.ok, false);
    assert.equal(ver.code, 1);
    assert.ok(ver.seals[0]!.causes.some((c) => c.includes("rolled back") || c.includes("deleted sealed paths")));
  });

  it("reseal scopes red check to tests added or changed by the writer commit (F2)", async () => {
    write(".lykos/config.yaml", 'seal:\n  base: master\n  test_command: "node --test {files}"\n');
    write("README.md", "# test");
    write("src/math.mjs", "export function fnA() { return false; }\nexport function fnB() { return false; }\n");
    commitAll("initial");

    const initRes = sealKeyInit(repo, home, env());
    assert.ok(initRes.keyId);

    git("checkout", "-b", "feat");
    write("test/a.test.mjs", 'import { it } from "node:test"; import assert from "node:assert/strict"; import { fnA } from "../src/math.mjs"; it("fnA", () => { assert.equal(fnA(), true); });\n');
    write("test/b.test.mjs", 'import { it } from "node:test"; import assert from "node:assert/strict"; import { fnB } from "../src/math.mjs"; it("fnB", () => { assert.equal(fnB(), true); });\n');
    commitAll("red: a and b");

    const res1 = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(res1.ok, res1.errors?.join("; "));

    // Implementer implements fnA in source so test/a now passes
    write("src/math.mjs", "export function fnA() { return true; }\nexport function fnB() { return false; }\n");
    commitAll("impl fnA (test/a now passing)");

    // Writer updates test/b (corrected, still red)
    write("test/b.test.mjs", 'import { it } from "node:test"; import assert from "node:assert/strict"; import { fnB } from "../src/math.mjs"; it("fnB", () => { assert.equal(fnB(), "expected_val"); });\n');
    commitAll("writer: correct test b");

    // Reseal must succeed even though test/a is now passing, because writer only touched test/b
    const res2 = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(res2.ok, res2.errors?.join("; "));

    const sealContent = JSON.parse(readFileSync(join(repo, ".lykos/seals/feat.json"), "utf8"));
    assert.deepEqual(sealContent.sealed_paths, [
      ".lykos/seals/feat.json",
      "test/a.test.mjs",
      "test/b.test.mjs",
    ]);
    // Red evidence covers only the writer's changed test
    assert.equal(sealContent.red.length, 1);
    assert.equal(sealContent.red[0].file, "test/b.test.mjs");

    // Implementer implements fnB in source so both tests pass
    write("src/math.mjs", "export function fnA() { return true; }\nexport function fnB() { return \"expected_val\"; }\n");
    commitAll("impl fnB (both tests now passing)");

    const ver = await verifySeals({ cwd: repo, env: env(), record: false });
    assert.equal(ver.ok, true, ver.output);
  });

  it("writer commit adding helpers/fixtures beside red test seals all and executes only the test (F3)", async () => {
    write(".lykos/config.yaml", 'seal:\n  base: master\n  test_command: "node --test {files}"\n');
    write("README.md", "# test");
    write("src/math.mjs", "export function compute(helper, data) { return 0; }\n");
    commitAll("initial");

    const initRes = sealKeyInit(repo, home, env());
    assert.ok(initRes.keyId);

    git("checkout", "-b", "feat");
    write("test/helpers/fixture.mjs", "export const data = 42;\n");
    write("test/fixtures/data.json", '{"key": "value"}\n');
    write("test/math.test.mjs", `import { it } from "node:test";
import assert from "node:assert/strict";
import { compute } from "../src/math.mjs";
import { data } from "./helpers/fixture.mjs";
it("math test", () => {
  assert.equal(compute(data, 1), 43);
});
`);
    commitAll("red with helpers and fixtures");

    const res = await sealCreate({ cwd: repo, homeDir: home, env: env() });
    assert.ok(res.ok, res.errors?.join("; "));

    const sealContent = JSON.parse(readFileSync(join(repo, ".lykos/seals/feat.json"), "utf8"));
    assert.ok(sealContent.sealed_paths.includes("test/helpers/fixture.mjs"));
    assert.ok(sealContent.sealed_paths.includes("test/fixtures/data.json"));
    assert.ok(sealContent.sealed_paths.includes("test/math.test.mjs"));
    // Red check executed only math.test.mjs
    assert.equal(sealContent.red.length, 1);
    assert.equal(sealContent.red[0].file, "test/math.test.mjs");

    // Implement test so it passes
    write("src/math.mjs", "export function compute(helper, data) { return helper + data; }\n");
    commitAll("implement compute");

    const ver = await verifySeals({ cwd: repo, env: env(), record: false });
    assert.equal(ver.ok, true, ver.output);

    // Tampering with helper fixture is detected
    write("test/helpers/fixture.mjs", "export const data = 100;\n");
    commitAll("tamper helper");

    const verTampered = await verifySeals({ cwd: repo, env: env(), record: false });
    assert.equal(verTampered.ok, false);
    assert.ok(verTampered.seals[0]!.causes.some((c) => c.includes("test/helpers/fixture.mjs")));
  });
});
