import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LykosExtensionHost } from "../api.js";
import { register, sealExtension } from "./lykos-seal.js";
import { generateEd25519KeyPair, signPayload } from "../../seal/crypto.js";
import { openLedgerSync } from "../../ledger/use.js";
import type { SealFile } from "../../seal/types.js";
import { bindExtensionChildSessions } from "../../session/session.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.quotepath=false", ...args], { cwd, encoding: "utf8" }).trim();
}

describe("lykos-seal default extension (T199)", () => {
  it("records veto in project ledger when cwd is a worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-wt-"));
    const project = join(root, "project");
    const worktree = join(root, "wt");
    mkdirSync(project, { recursive: true });
    try {
      git(project, "init", "-q", "-b", "master");
      git(project, "config", "user.name", "T");
      git(project, "config", "user.email", "t@example.com");

      const kp = generateEd25519KeyPair();
      mkdirSync(join(project, ".lykos/seals/keys"), { recursive: true });
      writeFileSync(join(project, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      writeFileSync(join(project, ".lykos/config.yaml"), "seal:\n  base: master\n  enforce_for: [implementer]\n");
      mkdirSync(join(project, "test"), { recursive: true });
      writeFileSync(join(project, "test/add.test.js"), "assert.ok(1);\n");
      git(project, "add", "-A");
      git(project, "commit", "-q", "-m", "base");

      git(project, "checkout", "-q", "-b", "feat");
      writeFileSync(join(project, "test/add.test.js"), "assert.ok(2);\n");
      git(project, "add", "-A");
      git(project, "commit", "-q", "-m", "red test");
      const writer = git(project, "rev-parse", "HEAD");

      const sealObj: Omit<SealFile, "signature"> = {
        version: 1,
        branch: "feat",
        writer_commit: writer,
        creator: "test",
        specialist: "test-writer",
        sealed_paths: ["test/add.test.js"],
        test_command: "node --test {files}",
        adapter: "node:test",
        red: [],
        created_at: new Date().toISOString(),
        key_id: kp.keyId,
      };
      writeFileSync(
        join(project, ".lykos/seals/feat.json"),
        JSON.stringify({ ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2),
      );
      git(project, "add", "-A");
      git(project, "commit", "-q", "-m", "seal");

      git(project, "checkout", "-q", "master");
      git(project, "worktree", "add", "-q", worktree, "feat");

      const sessionId = "sess-wt";
      const projectLedgerPath = join(project, ".lykos", "ledger.db");
      openLedgerSync(projectLedgerPath).close();

      const host = new LykosExtensionHost({ cwd: worktree, gate: { request: async () => "deny" } });
      host.install(sealExtension);
      host.setSessionId(sessionId);
      host.setSpecialist("implementer");

      const veto = await host.runToolCallVeto("write", { path: "test/add.test.js" });
      assert.equal((veto as any)?.block, true, "the sealed write should be vetoed");

      const warn = await host.runToolCallVeto("bash", { command: "cat test/add.test.js" });
      assert.equal((warn as any)?.block, false);
      assert.match((warn as any)?.warning, /references sealed path/);

      const ledger = openLedgerSync(projectLedgerPath);
      const rows = ledger.db.prepare("SELECT kind FROM seal_events WHERE session_id = ? ORDER BY ts ASC").all(sessionId) as Array<{ kind: string }>;
      ledger.close();

      assert.deepEqual(rows, [{ kind: "vetoed" }, { kind: "bash-warned" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("commit tool call triggers refresh on subsequent tool call so newly committed seals are vetoed", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-refresh-"));
    mkdirSync(root, { recursive: true });
    try {
      git(root, "init", "-q", "-b", "master");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");

      const kp = generateEd25519KeyPair();
      mkdirSync(join(root, ".lykos/seals/keys"), { recursive: true });
      writeFileSync(join(root, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      writeFileSync(join(root, ".lykos/config.yaml"), "seal:\n  base: master\n  enforce_for: [implementer]\n");
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test/foo.test.js"), "assert.ok(1);\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");

      git(root, "checkout", "-q", "-b", "feat");

      const host = new LykosExtensionHost({ cwd: root, gate: { request: async () => "deny" } });
      host.install(sealExtension);
      host.setSessionId("sess-refresh");
      host.setSpecialist("implementer");

      // Before seal is added, write to test/foo.test.js is NOT vetoed
      const preVeto = await host.runToolCallVeto("write", { path: "test/foo.test.js" });
      assert.equal(preVeto, undefined);

      // Now create and commit a seal
      const writer = git(root, "rev-parse", "HEAD");
      const sealObj: Omit<SealFile, "signature"> = {
        version: 1,
        branch: "feat",
        writer_commit: writer,
        creator: "test",
        specialist: "test-writer",
        sealed_paths: ["test/foo.test.js"],
        test_command: "node --test {files}",
        adapter: "node:test",
        red: [],
        created_at: new Date().toISOString(),
        key_id: kp.keyId,
      };
      writeFileSync(
        join(root, ".lykos/seals/feat.json"),
        JSON.stringify({ ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2),
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seal: add feat seal");

      // Model calls commit tool
      await host.runToolCallVeto("commit", { message: "seal: add feat seal" });

      // The subsequent tool call MUST see the refreshed seals and veto!
      const postVeto = await host.runToolCallVeto("write", { path: "test/foo.test.js" });
      assert.equal((postVeto as any)?.block, true, "post-commit tool call must see new seal and veto");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("vetoes for default specialist 'build' when enforce_for includes build", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-build-"));
    mkdirSync(root, { recursive: true });
    try {
      git(root, "init", "-q", "-b", "master");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");

      const kp = generateEd25519KeyPair();
      mkdirSync(join(root, ".lykos/seals/keys"), { recursive: true });
      writeFileSync(join(root, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      writeFileSync(join(root, ".lykos/config.yaml"), "seal:\n  base: master\n  enforce_for: [build]\n");
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test/foo.test.js"), "assert.ok(1);\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");

      git(root, "checkout", "-q", "-b", "feat");
      const writer = git(root, "rev-parse", "HEAD");
      const sealObj: Omit<SealFile, "signature"> = {
        version: 1,
        branch: "feat",
        writer_commit: writer,
        creator: "test",
        specialist: "test-writer",
        sealed_paths: ["test/foo.test.js"],
        test_command: "node --test {files}",
        adapter: "node:test",
        red: [],
        created_at: new Date().toISOString(),
        key_id: kp.keyId,
      };
      writeFileSync(
        join(root, ".lykos/seals/feat.json"),
        JSON.stringify({ ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2),
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seal");

      // No specialist explicitly set on host -> defaults to "build"
      const host = new LykosExtensionHost({ cwd: root, gate: { request: async () => "deny" } });
      host.install(sealExtension);
      host.setSessionId("sess-build");

      const veto = await host.runToolCallVeto("write", { path: "test/foo.test.js" });
      assert.equal((veto as any)?.block, true, "default specialist 'build' should be vetoed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ast_edit with ['.'], a directory, and a glob covering a sealed file are refused; a glob or directory not covering one is allowed; edit on a non-sealed file still allowed", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-ast-edit-"));
    mkdirSync(root, { recursive: true });
    try {
      git(root, "init", "-q", "-b", "master");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");

      const kp = generateEd25519KeyPair();
      mkdirSync(join(root, ".lykos/seals/keys"), { recursive: true });
      writeFileSync(join(root, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      writeFileSync(join(root, ".lykos/config.yaml"), "seal:\n  base: master\n  enforce_for: [implementer]\n");
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/bar.js"), "export function bar() { return 1; }\n");
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test/foo.test.js"), "assert.ok(1);\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");

      git(root, "checkout", "-q", "-b", "feat");
      const writer = git(root, "rev-parse", "HEAD");
      const sealObj: Omit<SealFile, "signature"> = {
        version: 1,
        branch: "feat",
        writer_commit: writer,
        creator: "test",
        specialist: "test-writer",
        sealed_paths: ["test/foo.test.js"],
        test_command: "node --test {files}",
        adapter: "node:test",
        red: [],
        created_at: new Date().toISOString(),
        key_id: kp.keyId,
      };
      writeFileSync(
        join(root, ".lykos/seals/feat.json"),
        JSON.stringify({ ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2),
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seal");

      const host = new LykosExtensionHost({ cwd: root, gate: { request: async () => "deny" } });
      host.install(sealExtension);
      host.setSessionId("sess-ast-edit");
      host.setSpecialist("implementer");

      // 1. ast_edit with ["."] covering sealed file is refused
      const vetoDot = await host.runToolCallVeto("ast_edit", { paths: ["."] });
      assert.equal((vetoDot as any)?.block, true, "ast_edit with ['.'] should be vetoed");
      assert.match((vetoDot as any)?.reason, /test\/foo\.test\.js/, "veto reason must name the sealed file");
      assert.match((vetoDot as any)?.reason, /exclude the sealed files/, "veto reason must tell agent to pass explicit paths that exclude sealed files");

      // 2. ast_edit with directory covering sealed file is refused
      const vetoDir = await host.runToolCallVeto("ast_edit", { paths: ["test"] });
      assert.equal((vetoDir as any)?.block, true, "ast_edit with ['test'] should be vetoed");
      assert.match((vetoDir as any)?.reason, /test\/foo\.test\.js/);
      assert.match((vetoDir as any)?.reason, /exclude the sealed files/);

      // 3. ast_edit with glob covering sealed file is refused
      const vetoGlob = await host.runToolCallVeto("ast_edit", { paths: ["test/*.test.js"] });
      assert.equal((vetoGlob as any)?.block, true, "ast_edit with ['test/*.test.js'] should be vetoed");
      assert.match((vetoGlob as any)?.reason, /test\/foo\.test\.js/);
      assert.match((vetoGlob as any)?.reason, /exclude the sealed files/);

      // 4. ast_edit covering sealed file through tool_call is refused
      const vetoToolCall = await host.runToolCallVeto("tool_call", { name: "ast_edit", arguments: { paths: ["."] } });
      assert.equal((vetoToolCall as any)?.block, true, "ast_edit via tool_call with ['.'] should be vetoed");
      assert.match((vetoToolCall as any)?.reason, /test\/foo\.test\.js/);
      assert.match((vetoToolCall as any)?.reason, /exclude the sealed files/);

      // 5. ast_edit with directory not covering sealed file is allowed
      const allowDir = await host.runToolCallVeto("ast_edit", { paths: ["src"] });
      assert.equal(allowDir, undefined, "ast_edit with ['src'] should be allowed");

      // 6. ast_edit with glob not covering sealed file is allowed
      const allowGlob = await host.runToolCallVeto("ast_edit", { paths: ["src/*.js"] });
      assert.equal(allowGlob, undefined, "ast_edit with ['src/*.js'] should be allowed");

      // 7. edit on a non-sealed file is still allowed
      const allowEdit = await host.runToolCallVeto("edit", { path: "src/bar.js" });
      assert.equal(allowEdit, undefined, "edit on non-sealed file should be allowed");

      // 8. edit on a sealed file is refused with exact-file refusal message
      const vetoEdit = await host.runToolCallVeto("edit", { path: "test/foo.test.js" });
      assert.equal((vetoEdit as any)?.block, true, "edit on sealed file should be vetoed");
      assert.match((vetoEdit as any)?.reason, /cannot modify sealed file "test\/foo\.test\.js"/);
      assert.doesNotMatch((vetoEdit as any)?.reason, /exclude the sealed files/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a bash command 'ls .' with a sealed file produces no warning and no seal event", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-bash-ls-"));
    mkdirSync(root, { recursive: true });
    try {
      git(root, "init", "-q", "-b", "master");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");

      const kp = generateEd25519KeyPair();
      mkdirSync(join(root, ".lykos/seals/keys"), { recursive: true });
      writeFileSync(join(root, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      writeFileSync(join(root, ".lykos/config.yaml"), "seal:\n  base: master\n  enforce_for: [implementer]\n");
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test/foo.test.js"), "assert.ok(1);\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");

      git(root, "checkout", "-q", "-b", "feat");
      const writer = git(root, "rev-parse", "HEAD");
      const sealObj: Omit<SealFile, "signature"> = {
        version: 1,
        branch: "feat",
        writer_commit: writer,
        creator: "test",
        specialist: "test-writer",
        sealed_paths: ["test/foo.test.js"],
        test_command: "node --test {files}",
        adapter: "node:test",
        red: [],
        created_at: new Date().toISOString(),
        key_id: kp.keyId,
      };
      writeFileSync(
        join(root, ".lykos/seals/feat.json"),
        JSON.stringify({ ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2),
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seal");

      const host = new LykosExtensionHost({ cwd: root, gate: { request: async () => "deny" } });
      host.install(sealExtension);
      const sessionId = "sess-bash-ls-test";
      host.setSessionId(sessionId);
      host.setSpecialist("implementer");

      const res = await host.runToolCallVeto("bash", { command: "ls ." });
      assert.equal(res, undefined, "bash command 'ls .' should produce no veto or warning");

      const ledger = openLedgerSync(join(root, ".lykos/ledger.db"));
      const rows = ledger.db.prepare("SELECT kind, detail FROM seal_events WHERE session_id = ?").all(sessionId) as Array<{ kind: string; detail: string }>;
      ledger.close();

      assert.equal(rows.length, 0, "bash command 'ls .' should produce no seal event");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("appends uncommitted changes notice to block reason and seal_events detail when green run fails with dirty working tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-uncommitted-"));
    mkdirSync(root, { recursive: true });
    try {
      git(root, "init", "-q", "-b", "master");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");

      const kp = generateEd25519KeyPair();
      mkdirSync(join(root, ".lykos/seals/keys"), { recursive: true });
      writeFileSync(join(root, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      writeFileSync(join(root, ".lykos/config.yaml"), "seal:\n  base: master\n  test_command: \"node --test {files}\"\n  enforce_for: [build]\n");
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/add.js"), "module.exports = { add: () => 0 };\n");
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test/add.test.js"), "const assert = require('node:assert/strict'); const { test } = require('node:test'); const { add } = require('../src/add.js'); test('adds', () => { assert.equal(add(1, 2), 3); });\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");

      git(root, "checkout", "-q", "-b", "feat");
      const writer = git(root, "rev-parse", "HEAD");

      const sealObj: Omit<SealFile, "signature"> = {
        version: 1,
        branch: "feat",
        writer_commit: writer,
        creator: "test",
        specialist: "test-writer",
        sealed_paths: ["test/add.test.js"],
        test_command: "node --test {files}",
        adapter: "node:test",
        red: [{ file: "test/add.test.js", name: "adds", describe: [], failure: "assertion" }],
        created_at: new Date().toISOString(),
        key_id: kp.keyId,
      };
      writeFileSync(
        join(root, ".lykos/seals/feat.json"),
        JSON.stringify({ ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2),
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seal");
      const sealCommit = git(root, "rev-parse", "HEAD");

      // Leave uncommitted implementation in working tree (outside sealed paths)
      writeFileSync(join(root, "src/add.js"), "module.exports = { add: (a, b) => a + b };\n");

      const sessionId = "sess-uncommitted";
      const ledgerPath = join(root, ".lykos/ledger.db");
      const ledger = openLedgerSync(ledgerPath);
      ledger.startSession({ brief: "t", harnessCommit: "abc" });
      ledger.close();

      const host = new LykosExtensionHost({ cwd: root, gate: { request: async () => "deny" } });
      host.install(sealExtension);
      host.setSessionId(sessionId);
      host.setSpecialist("build");

      const checkRes = await host.runGateChecks({
        sessionId,
        cwd: root,
        ledgerPath,
        startCommit: sealCommit,
        specialist: "build",
      });

      assert.equal(checkRes.pass, false);
      assert.match(checkRes.blockReason!, /uncommitted changes are not part of the green run; commit them/);

      const verifyLedger = openLedgerSync(ledgerPath);
      const rows = verifyLedger.db.prepare("SELECT kind, detail FROM seal_events WHERE session_id = ?").all(sessionId) as Array<{ kind: string; detail: string }>;
      verifyLedger.close();

      const failedEvent = rows.find((r) => r.kind === "failed");
      assert.ok(failedEvent, `expected failed seal_event, found: ${JSON.stringify(rows)}`);
      assert.match(failedEvent.detail, /uncommitted changes are not part of the green run; commit them/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("green run passes only files matching seal.run_globs, ignoring non-test sealed paths like fixtures and config files", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-globs-"));
    mkdirSync(root, { recursive: true });
    try {
      git(root, "init", "-q", "-b", "master");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");

      const kp = generateEd25519KeyPair();
      mkdirSync(join(root, ".lykos/seals/keys"), { recursive: true });
      writeFileSync(join(root, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      writeFileSync(join(root, ".lykos/config.yaml"), "seal:\n  base: master\n  test_command: \"node --test {files}\"\n  enforce_for: [build]\n");
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/add.js"), "module.exports = { add: () => 3 };\n");
      mkdirSync(join(root, "test/helpers"), { recursive: true });
      mkdirSync(join(root, "test/fixtures"), { recursive: true });
      writeFileSync(join(root, "test/helpers/fixture.js"), "module.exports = { helper: 42 };\n");
      writeFileSync(join(root, "test/fixtures/data.json"), '{"key": "value"}\n');
      writeFileSync(join(root, "test/add.test.js"), "const assert = require('node:assert/strict'); const { test } = require('node:test'); const { add } = require('../src/add.js'); test('adds', () => { assert.equal(add(), 3); });\n");
      writeFileSync(join(root, "vitest.config.js"), "// non-test config file\nmodule.exports = {};\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");

      git(root, "checkout", "-q", "-b", "feat");
      const writer = git(root, "rev-parse", "HEAD");

      const sealObj: Omit<SealFile, "signature"> = {
        version: 1,
        branch: "feat",
        writer_commit: writer,
        creator: "test",
        specialist: "test-writer",
        sealed_paths: ["test/add.test.js", "test/helpers/fixture.js", "test/fixtures/data.json", "vitest.config.js"],
        test_command: "node --test {files}",
        adapter: "node:test",
        red: [{ file: "test/add.test.js", name: "adds", describe: [], failure: "assertion" }],
        created_at: new Date().toISOString(),
        key_id: kp.keyId,
      };
      writeFileSync(
        join(root, ".lykos/seals/feat.json"),
        JSON.stringify({ ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2),
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seal");
      const sealCommit = git(root, "rev-parse", "HEAD");

      const sessionId = "sess-globs";
      const ledgerPath = join(root, ".lykos/ledger.db");
      const ledger = openLedgerSync(ledgerPath);
      ledger.startSession({ brief: "t", harnessCommit: "abc" });
      ledger.close();

      const host = new LykosExtensionHost({ cwd: root, gate: { request: async () => "deny" } });
      host.install(sealExtension);
      host.setSessionId(sessionId);
      host.setSpecialist("build");

      const checkRes = await host.runGateChecks({
        sessionId,
        cwd: root,
        ledgerPath,
        startCommit: sealCommit,
        specialist: "build",
      });

      // The green run should pass because vitest.config.js and test/helpers/fixture.js are filtered out of {files}
      assert.equal(checkRes.pass, true, `expected pass, got block: ${checkRes.blockReason}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gate check blocks and reports tampered when a sealed file is deleted", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-deleted-"));
    mkdirSync(root, { recursive: true });
    try {
      git(root, "init", "-q", "-b", "master");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");

      const kp = generateEd25519KeyPair();
      mkdirSync(join(root, ".lykos/seals/keys"), { recursive: true });
      writeFileSync(join(root, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      writeFileSync(join(root, ".lykos/config.yaml"), "seal:\n  base: master\n  test_command: \"node --test {files}\"\n  enforce_for: [build]\n");
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test/a.test.js"), "const { test } = require('node:test'); test('a', () => {});\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");

      git(root, "checkout", "-q", "-b", "feat");
      const writer = git(root, "rev-parse", "HEAD");

      const sealObj: Omit<SealFile, "signature"> = {
        version: 1,
        branch: "feat",
        writer_commit: writer,
        creator: "test",
        specialist: "test-writer",
        sealed_paths: ["test/a.test.js"],
        test_command: "node --test {files}",
        adapter: "node:test",
        red: [{ file: "test/a.test.js", name: "a", describe: [], failure: "assertion" }],
        created_at: new Date().toISOString(),
        key_id: kp.keyId,
      };
      writeFileSync(
        join(root, ".lykos/seals/feat.json"),
        JSON.stringify({ ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2),
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seal");
      const sealCommit = git(root, "rev-parse", "HEAD");

      // Implementer deletes test/a.test.js
      rmSync(join(root, "test/a.test.js"));
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "delete sealed test");

      const sessionId = "sess-del";
      const ledgerPath = join(root, ".lykos/ledger.db");
      const ledger = openLedgerSync(ledgerPath);
      ledger.startSession({ brief: "t", harnessCommit: "abc" });
      ledger.close();

      const host = new LykosExtensionHost({ cwd: root, gate: { request: async () => "deny" } });
      host.install(sealExtension);
      host.setSessionId(sessionId);
      host.setSpecialist("build");

      const checkRes = await host.runGateChecks({
        sessionId,
        cwd: root,
        ledgerPath,
        startCommit: sealCommit,
        specialist: "build",
      });

      assert.equal(checkRes.pass, false);
      assert.match(checkRes.blockReason!, /Sealed file\(s\) modified or deleted: test\/a\.test\.js/);

      const l2 = openLedgerSync(ledgerPath);
      const events = l2.db.prepare("SELECT * FROM seal_events").all() as any[];
      l2.close();
      assert.ok(events.some((e) => e.kind === "tampered" && e.detail.includes("deleted sealed paths: test/a.test.js")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an implementer's own failing test fails the gate", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-impl-fail-"));
    mkdirSync(root, { recursive: true });
    try {
      git(root, "init", "-q", "-b", "master");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");

      const kp = generateEd25519KeyPair();
      mkdirSync(join(root, ".lykos/seals/keys"), { recursive: true });
      writeFileSync(join(root, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      writeFileSync(
        join(root, ".lykos/config.yaml"),
        "seal:\n  base: master\n  test_command: \"node --test {files}\"\n  enforce_for: [build]\n",
      );
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/add.js"), "module.exports = { add: () => 3 };\n");
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(
        join(root, "test/add.test.js"),
        "const assert = require('node:assert/strict'); const { test } = require('node:test'); const { add } = require('../src/add.js'); test('adds', () => { assert.equal(add(), 3); });\n",
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");

      git(root, "checkout", "-q", "-b", "feat");
      const writer = git(root, "rev-parse", "HEAD");

      const sealObj: Omit<SealFile, "signature"> = {
        version: 1,
        branch: "feat",
        writer_commit: writer,
        creator: "test",
        specialist: "test-writer",
        sealed_paths: ["test/add.test.js"],
        test_command: "node --test {files}",
        adapter: "node:test",
        red: [{ file: "test/add.test.js", name: "adds", describe: [], failure: "assertion" }],
        created_at: new Date().toISOString(),
        key_id: kp.keyId,
      };
      writeFileSync(
        join(root, ".lykos/seals/feat.json"),
        JSON.stringify({ ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2),
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seal");
      const sealCommit = git(root, "rev-parse", "HEAD");

      // Implementer adds their own test file which fails, and commits it
      writeFileSync(
        join(root, "test/impl.test.js"),
        "const assert = require('node:assert/strict'); const { test } = require('node:test'); test('impl extra', () => { assert.equal(1, 2); });\n",
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "implementer test");

      const sessionId = "sess-impl-fail";
      const ledgerPath = join(root, ".lykos/ledger.db");
      const ledger = openLedgerSync(ledgerPath);
      ledger.startSession({ brief: "t", harnessCommit: "abc" });
      ledger.close();

      const host = new LykosExtensionHost({ cwd: root, gate: { request: async () => "deny" } });
      host.install(sealExtension);
      host.setSessionId(sessionId);
      host.setSpecialist("build");

      const checkRes = await host.runGateChecks({
        sessionId,
        cwd: root,
        ledgerPath,
        startCommit: sealCommit,
        specialist: "build",
      });

      assert.equal(checkRes.pass, false, "gate must block on failing implementer test");
      assert.match(checkRes.blockReason!, /impl\.test\.js/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports runner errors rather than 'not collected' when green run collects 0 tests with errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-runner-err-"));
    mkdirSync(root, { recursive: true });
    try {
      git(root, "init", "-q", "-b", "master");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");

      const kp = generateEd25519KeyPair();
      mkdirSync(join(root, ".lykos/seals/keys"), { recursive: true });
      writeFileSync(join(root, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      // test_command has an invalid node flag so node crashes before running reporter
      writeFileSync(
        join(root, ".lykos/config.yaml"),
        "seal:\n  base: master\n  test_command: \"node --bad-flag-crash --test {files}\"\n  enforce_for: [build]\n",
      );
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/add.js"), "module.exports = { add: () => 3 };\n");
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(
        join(root, "test/add.test.js"),
        "const assert = require('node:assert/strict'); const { test } = require('node:test'); const { add } = require('../src/add.js'); test('adds', () => { assert.equal(add(), 3); });\n",
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");

      git(root, "checkout", "-q", "-b", "feat");
      const writer = git(root, "rev-parse", "HEAD");

      const sealObj: Omit<SealFile, "signature"> = {
        version: 1,
        branch: "feat",
        writer_commit: writer,
        creator: "test",
        specialist: "test-writer",
        sealed_paths: ["test/add.test.js"],
        test_command: "node --bad-flag-crash --test {files}",
        adapter: "node:test",
        red: [{ file: "test/add.test.js", name: "adds", describe: [], failure: "assertion" }],
        created_at: new Date().toISOString(),
        key_id: kp.keyId,
      };
      writeFileSync(
        join(root, ".lykos/seals/feat.json"),
        JSON.stringify({ ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2),
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seal");
      const sealCommit = git(root, "rev-parse", "HEAD");

      const sessionId = "sess-runner-err-1";
      const ledgerPath = join(root, ".lykos/ledger.db");
      const ledger = openLedgerSync(ledgerPath);
      ledger.startSession({ brief: "t", harnessCommit: "abc" });
      ledger.close();

      const host = new LykosExtensionHost({ cwd: root, gate: { request: async () => "deny" } });
      host.install(sealExtension);
      host.setSessionId(sessionId);
      host.setSpecialist("build");

      const checkRes = await host.runGateChecks({
        sessionId,
        cwd: root,
        ledgerPath,
        startCommit: sealCommit,
        specialist: "build",
      });

      assert.equal(checkRes.pass, false);
      assert.match(checkRes.blockReason!, /failed to produce reporter output|bad-flag-crash/);
      assert.doesNotMatch(checkRes.blockReason!, /not collected/);

      const verifyLedger = openLedgerSync(ledgerPath);
      const rows = verifyLedger.db.prepare("SELECT kind, detail FROM seal_events WHERE session_id = ?").all(sessionId) as Array<{ kind: string; detail: string }>;
      verifyLedger.close();

      const failedEvent = rows.find((r) => r.kind === "failed");
      assert.ok(failedEvent, `expected failed seal_event, found: ${JSON.stringify(rows)}`);
      assert.match(failedEvent.detail, /failed to produce reporter output|bad-flag-crash/);
      assert.doesNotMatch(failedEvent.detail, /not collected/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("gate check blocks on test weakening added outside sealed files and records weakened event", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-weakening-"));
    mkdirSync(root, { recursive: true });
    try {
      git(root, "init", "-q", "-b", "master");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");

      const kp = generateEd25519KeyPair();
      mkdirSync(join(root, ".lykos/seals/keys"), { recursive: true });
      writeFileSync(join(root, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      writeFileSync(join(root, ".lykos/config.yaml"), "seal:\n  base: master\n  test_command: \"node --test {files}\"\n  enforce_for: [build]\n");
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/add.js"), "module.exports = { add: () => 3 };\n");
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test/add.test.js"), "const assert = require('node:assert/strict'); const { test } = require('node:test'); const { add } = require('../src/add.js'); test('adds', () => { assert.equal(add(), 3); });\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");

      git(root, "checkout", "-q", "-b", "feat");
      const writer = git(root, "rev-parse", "HEAD");

      const sealObj: Omit<SealFile, "signature"> = {
        version: 1,
        branch: "feat",
        writer_commit: writer,
        creator: "test",
        specialist: "test-writer",
        sealed_paths: ["test/add.test.js"],
        test_command: "node --test {files}",
        adapter: "node:test",
        red: [{ file: "test/add.test.js", name: "adds", describe: [], failure: "assertion" }],
        created_at: new Date().toISOString(),
        key_id: kp.keyId,
      };
      writeFileSync(
        join(root, ".lykos/seals/feat.json"),
        JSON.stringify({ ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2),
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seal");
      const sealCommit = git(root, "rev-parse", "HEAD");

      // Add a non-sealed file containing test weakening
      writeFileSync(join(root, "test/unsealed.test.js"), 'const { test } = require("node:test");\ntest.skip("weak", () => {});\n');
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "add unsealed weakening");

      const sessionId = "sess-weakening";
      const ledgerPath = join(root, ".lykos/ledger.db");
      const ledger = openLedgerSync(ledgerPath);
      ledger.startSession({ brief: "t", harnessCommit: "abc" });
      ledger.close();

      const host = new LykosExtensionHost({ cwd: root, gate: { request: async () => "deny" } });
      host.install(sealExtension);
      host.setSessionId(sessionId);
      host.setSpecialist("build");

      const checkRes = await host.runGateChecks({
        sessionId,
        cwd: root,
        ledgerPath,
        startCommit: sealCommit,
        specialist: "build",
      });

      assert.equal(checkRes.pass, false);
      assert.match(checkRes.blockReason!, /Test weakening detected/);
      assert.match(checkRes.blockReason!, /test\/unsealed\.test\.js:2: \.skip/);

      const checkLedger = openLedgerSync(ledgerPath);
      const events = checkLedger.db
        .prepare("SELECT kind, detail FROM seal_events WHERE session_id = ? AND kind = 'weakened'")
        .all(sessionId) as Array<{ kind: string; detail: string }>;
      checkLedger.close();

      assert.equal(events.length, 1);
      assert.equal(events[0]!.kind, "weakened");
      assert.equal(events[0]!.detail, "test/unsealed.test.js:2: .skip(");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a mid-session config edit must not disable the weakening scan", async () => {
    const root = mkdtempSync(join(tmpdir(), "t202-bypass-"));
    try {
      git(root, "init", "-q", "-b", "master");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");
      mkdirSync(join(root, ".lykos/seals"), { recursive: true });
      writeFileSync(join(root, ".lykos/config.yaml"), "seal:\n  base: master\n  enforce_for: [build]\n");
      const seal = { version: 1, branch: "feat", writer_commit: "x", specialist: "test-writer", sealed_paths: [], test_command: "true", adapter: "node:test", red: [], created_at: new Date().toISOString(), key_id: "k", signature: "sig" };
      git(root, "add", "-A"); git(root, "commit", "-q", "-m", "base");
      // The seal lives on the feature branch, after the base (ADR-0034).
      git(root, "checkout", "-q", "-b", "feat");
      writeFileSync(join(root, ".lykos/seals/feat.json"), JSON.stringify(seal));
      git(root, "add", "-A"); git(root, "commit", "-q", "-m", "seal");
      const sealCommit = git(root, "rev-parse", "HEAD");
      writeFileSync(join(root, "src.mjs"), "it.skip('weak', () => {});\n");
      git(root, "add", "-A"); git(root, "commit", "-q", "-m", "add unsealed weakening");

      const checks: Array<(ctx: any) => Promise<any>> = [];
      const api = { cwd: root, specialist: "build", on: () => {}, registerTool: () => {}, registerGateCheck: (c: any) => checks.push(c) } as any;
      register(api); // boots with enforce_for: [build]

      // The implementer rewrites the project config during the session to remove itself.
      writeFileSync(join(root, ".lykos/config.yaml"), "seal:\n  base: master\n  enforce_for: []\n");

      const res = await checks[1]!({ cwd: root, startCommit: sealCommit, specialist: "build" });
      assert.equal(res.pass, false, `the weakening must still block; got pass=${res.pass}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a dispute row from another session does not park the test", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-dispute-sess-"));
    mkdirSync(root, { recursive: true });
    try {
      git(root, "init", "-q", "-b", "master");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");

      const kp = generateEd25519KeyPair();
      mkdirSync(join(root, ".lykos/seals/keys"), { recursive: true });
      writeFileSync(join(root, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      writeFileSync(join(root, ".lykos/config.yaml"), "seal:\n  base: master\n  test_command: \"node --test {files}\"\n  enforce_for: [build]\n");
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test/add.test.js"), "const assert = require('node:assert/strict'); const { test } = require('node:test'); test('adds', () => { assert.equal(1, 2); });\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");

      git(root, "checkout", "-q", "-b", "feat");
      const writer = git(root, "rev-parse", "HEAD");

      const sealObj: Omit<SealFile, "signature"> = {
        version: 1,
        branch: "feat",
        writer_commit: writer,
        creator: "test",
        specialist: "test-writer",
        sealed_paths: ["test/add.test.js"],
        test_command: "node --test {files}",
        adapter: "node:test",
        red: [{ file: "test/add.test.js", name: "adds", describe: [], failure: "assertion" }],
        created_at: new Date().toISOString(),
        key_id: kp.keyId,
      };
      writeFileSync(
        join(root, ".lykos/seals/feat.json"),
        JSON.stringify({ ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2),
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seal");
      const sealCommit = git(root, "rev-parse", "HEAD");

      const ledgerPath = join(root, ".lykos/ledger.db");
      const ledger = openLedgerSync(ledgerPath);
      ledger.startSession({ brief: "t", harnessCommit: "abc" });
      // Record a dispute filed by an earlier/other session
      ledger.db.prepare(
        "INSERT INTO seal_events (session_id, ts, branch, kind, paths, creator, specialist, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "other-session",
        new Date().toISOString(),
        "feat",
        "dispute filed",
        JSON.stringify(["test/add.test.js"]),
        "other-session",
        "implementer",
        JSON.stringify({
          file: "test/add.test.js",
          describe: [],
          name: "adds",
          reason: "broken",
          evidence: "none",
        }),
      );
      ledger.close();

      const sessionId = "current-session";
      const host = new LykosExtensionHost({ cwd: root, gate: { request: async () => "deny" } });
      host.install(sealExtension);
      host.setSessionId(sessionId);
      host.setSpecialist("build");

      const checkRes = await host.runGateChecks({
        sessionId,
        cwd: root,
        ledgerPath,
        startCommit: sealCommit,
        specialist: "build",
      });

      assert.equal(checkRes.pass, false);
      assert.match(checkRes.blockReason!, /Green run failed/);
      assert.doesNotMatch(checkRes.blockReason!, /disputed/);

      const verifyLedger = openLedgerSync(ledgerPath);
      const rows = verifyLedger.db.prepare("SELECT kind, detail FROM seal_events WHERE session_id = ?").all(sessionId) as Array<{ kind: string; detail: string }>;
      verifyLedger.close();

      assert.ok(rows.some((r) => r.kind === "failed"), `expected kind 'failed', got: ${JSON.stringify(rows)}`);
      assert.ok(!rows.some((r) => r.kind === "disputed"), `did not expect kind 'disputed', got: ${JSON.stringify(rows)}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a dispute filed by a child session is recognised by the parent gate check and parks the test", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-child-dispute-"));
    mkdirSync(root, { recursive: true });
    try {
      git(root, "init", "-q", "-b", "master");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");

      const kp = generateEd25519KeyPair();
      mkdirSync(join(root, ".lykos/seals/keys"), { recursive: true });
      writeFileSync(join(root, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      writeFileSync(join(root, ".lykos/config.yaml"), "seal:\n  base: master\n  test_command: \"node --test {files}\"\n  enforce_for: [build]\n");
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test/add.test.js"), "const assert = require('node:assert/strict'); const { test } = require('node:test'); test('adds', () => { assert.equal(1, 2); });\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");

      git(root, "checkout", "-q", "-b", "feat");
      const writer = git(root, "rev-parse", "HEAD");

      const sealObj: Omit<SealFile, "signature"> = {
        version: 1,
        branch: "feat",
        writer_commit: writer,
        creator: "test",
        specialist: "test-writer",
        sealed_paths: ["test/add.test.js"],
        test_command: "node --test {files}",
        adapter: "node:test",
        red: [{ file: "test/add.test.js", name: "adds", describe: [], failure: "assertion" }],
        created_at: new Date().toISOString(),
        key_id: kp.keyId,
      };
      writeFileSync(
        join(root, ".lykos/seals/feat.json"),
        JSON.stringify({ ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2),
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seal");
      const sealCommit = git(root, "rev-parse", "HEAD");

      const ledgerPath = join(root, ".lykos/ledger.db");
      const ledger = openLedgerSync(ledgerPath);
      ledger.ensureProject({ id: "test-proj", rootPath: root, createdUtc: new Date().toISOString() });
      const taskId = "task-child-dispute";
      ledger.startTask({ id: taskId, projectId: "test-proj", brief: "shared task" });
      const parentSessionId = "parent-sess";
      ledger.startSession({ id: parentSessionId, taskId, projectId: "test-proj", brief: "parent", harnessCommit: "abc" });
      const childSessionId = "child-sess";
      ledger.startSession({ id: childSessionId, taskId, projectId: "test-proj", parentSessionId, brief: "child", harnessCommit: "abc" });

      // Record a dispute filed by the child session
      ledger.db.prepare(
        "INSERT INTO seal_events (session_id, ts, branch, kind, paths, creator, specialist, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        childSessionId,
        new Date().toISOString(),
        "feat",
        "dispute filed",
        JSON.stringify(["test/add.test.js"]),
        childSessionId,
        "build",
        JSON.stringify({
          file: "test/add.test.js",
          describe: [],
          name: "adds",
          reason: "broken spec",
          evidence: "arithmetic",
        }),
      );
      ledger.close();

      const host = new LykosExtensionHost({ cwd: root, gate: { request: async () => "deny" } });
      host.install(sealExtension);
      host.setSessionId(parentSessionId);
      host.setSpecialist("build");

      const checkRes = await host.runGateChecks({
        sessionId: parentSessionId,
        cwd: root,
        ledgerPath,
        startCommit: sealCommit,
        specialist: "build",
      });

      assert.equal(checkRes.pass, false);
      assert.match(checkRes.blockReason!, /disputed/);

      const verifyLedger = openLedgerSync(ledgerPath);
      const rows = verifyLedger.db.prepare("SELECT kind, detail FROM seal_events WHERE session_id = ?").all(parentSessionId) as Array<{ kind: string; detail: string }>;
      const taskRow = verifyLedger.db.prepare("SELECT state FROM tasks WHERE id = ?").get(taskId) as { state: string };
      verifyLedger.close();

      assert.ok(rows.some((r) => r.kind === "disputed"), `expected kind 'disputed' on parent, got: ${JSON.stringify(rows)}`);
      assert.equal(taskRow.state, "disputed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses dispute if test file already differs from seal commit in HEAD or working tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-differs-"));
    mkdirSync(root, { recursive: true });
    try {
      git(root, "init", "-q", "-b", "master");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");

      const kp = generateEd25519KeyPair();
      mkdirSync(join(root, ".lykos/seals/keys"), { recursive: true });
      writeFileSync(join(root, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      writeFileSync(join(root, ".lykos/config.yaml"), "seal:\n  base: master\n  test_command: \"node --test {files}\"\n  enforce_for: [build]\n");
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test/add.test.js"), "const assert = require('node:assert/strict');\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");

      git(root, "checkout", "-q", "-b", "feat");
      const writer = git(root, "rev-parse", "HEAD");

      const sealObj: Omit<SealFile, "signature"> = {
        version: 1,
        branch: "feat",
        writer_commit: writer,
        creator: "test",
        specialist: "build",
        sealed_paths: ["test/add.test.js"],
        test_command: "node --test {files}",
        adapter: "node:test",
        red: [{ file: "test/add.test.js", name: "adds", describe: [], failure: "assertion" }],
        created_at: new Date().toISOString(),
        key_id: kp.keyId,
      };
      writeFileSync(
        join(root, ".lykos/seals/feat.json"),
        JSON.stringify({ ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2),
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seal");

      // Implementer modifies test file in working tree before disputing
      writeFileSync(join(root, "test/add.test.js"), "// modified\n");

      let childRan = false;
      const host = new LykosExtensionHost({
        cwd: root,
        gate: { request: async () => "allow" },
      });
      host.bindSession({
        runChild: async () => {
          childRan = true;
          return { status: "ok", sessionId: "child-1", model: "m", text: "child ran" };
        },
      });
      host.install(sealExtension);

      const tool = host.toolDefinitions().find((t) => t.name === "dispute_test");
      assert.ok(tool);
      const res = (await (tool.execute as any)("call-1", {
        file: "test/add.test.js",
        describe: [],
        name: "test",
        reason: "wrong",
        evidence: "proof",
      })) as { content?: Array<{ text?: string }>; isError?: boolean };

      assert.equal(childRan, false, "child session must not run");
      assert.match(res.content?.[0]?.text ?? "", /already differs from seal commit/);
      assert.equal(res.isError, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts exactly the seal commit created by upheld dispute and rejects in-session seal created by implementer", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-bypass-"));
    mkdirSync(root, { recursive: true });
    try {
      git(root, "init", "-q", "-b", "master");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");

      const kp = generateEd25519KeyPair();
      mkdirSync(join(root, ".lykos/seals/keys"), { recursive: true });
      writeFileSync(join(root, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      writeFileSync(join(root, ".lykos/config.yaml"), "seal:\n  base: master\n  test_command: \"node --test {files}\"\n  enforce_for: [build]\n");
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test/add.test.js"), "const assert = require('node:assert/strict'); const { test } = require('node:test'); test('adds', () => assert.equal(1, 1));\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");

      git(root, "checkout", "-q", "-b", "feat");
      const startCommit = git(root, "rev-parse", "HEAD");

      const sealObj: Omit<SealFile, "signature"> = {
        version: 1,
        branch: "feat",
        writer_commit: startCommit,
        creator: "test",
        specialist: "build",
        created_at: new Date().toISOString(),
        key_id: kp.keyId,
        sealed_paths: ["test/add.test.js"],
        test_command: "node --test {files}",
        adapter: "node:test",
        red: [{ file: "test/add.test.js", name: "adds", describe: [], failure: "assertion" }],
      };
      writeFileSync(
        join(root, ".lykos/seals/feat.json"),
        JSON.stringify({ ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2),
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seal");

      const sessionId = "sess-bypass";
      const ledgerPath = join(root, ".lykos/ledger.db");
      const ledger = openLedgerSync(ledgerPath);
      ledger.startSession({ id: sessionId, brief: "test", harnessCommit: "abc" });

      // An upheld dispute occurred and resealed at commit A
      writeFileSync(
        join(root, "test/add.test.js"),
        "const assert = require('node:assert/strict'); const { test } = require('node:test'); test('adds', () => assert.equal(1, 1));\n",
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "upheld code rewrite");
      const writerCommitA = git(root, "rev-parse", "HEAD");
      const sealObjA: Omit<SealFile, "signature"> = {
        version: 1,
        branch: "feat",
        writer_commit: writerCommitA,
        creator: "test-writer",
        specialist: "build",
        created_at: new Date().toISOString(),
        key_id: kp.keyId,
        sealed_paths: ["test/add.test.js"],
        test_command: "node --test {files}",
        adapter: "node:test",
        red: [{ file: "test/add.test.js", name: "adds", describe: [], failure: "assertion" }],
      };
      writeFileSync(
        join(root, ".lykos/seals/feat.json"),
        JSON.stringify({ ...sealObjA, signature: signPayload(sealObjA as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2),
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "upheld seal commit A");
      const upheldSealCommitA = git(root, "rev-parse", "HEAD");

      ledger.db.prepare(
        "INSERT INTO seal_events (session_id, ts, branch, kind, paths, creator, specialist, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        sessionId,
        new Date().toISOString(),
        "feat",
        "dispute upheld",
        JSON.stringify(["test/add.test.js"]),
        sessionId,
        "test-writer",
        JSON.stringify({
          file: "test/add.test.js",
          describe: [],
          name: "adds",
          reason: "r",
          evidence: "e",
          sealCommit: upheldSealCommitA,
        }),
      );
      ledger.close();

      const hostA = new LykosExtensionHost({ cwd: root, gate: { request: async () => "deny" } });
      hostA.install(sealExtension);
      hostA.setSessionId(sessionId);
      hostA.setSpecialist("build");

      const checkResA = await hostA.runGateChecks({
        sessionId,
        cwd: root,
        ledgerPath,
        startCommit,
        specialist: "build",
      });
      assert.equal(checkResA.pass, true, `expected exact seal commit to be accepted: ${checkResA.blockReason}`);

      // Now the implementer creates a seal in-session (bypass attempt with different commit B)
      const sealObjB: Omit<SealFile, "signature"> = {
        ...sealObjA,
        created_at: new Date(Date.now() + 1000).toISOString(),
      };
      writeFileSync(
        join(root, ".lykos/seals/feat.json"),
        JSON.stringify({ ...sealObjB, signature: signPayload(sealObjB as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2),
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "implementer seal create bypass B");

      const hostB = new LykosExtensionHost({ cwd: root, gate: { request: async () => "deny" } });
      hostB.install(sealExtension);
      hostB.setSessionId(sessionId);
      hostB.setSpecialist("build");

      const checkResB = await hostB.runGateChecks({
        sessionId,
        cwd: root,
        ledgerPath,
        startCommit,
        specialist: "build",
      });

      assert.equal(checkResB.pass, false);
      assert.match(checkResB.blockReason!, /created in-session/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bindExtensionChildSessions refuses writable child session with unavailable when parent gate is undefined", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-child-gate-"));
    mkdirSync(root, { recursive: true });
    try {
      const host = new LykosExtensionHost({
        cwd: root,
        gate: { request: async () => "deny" },
      });
      bindExtensionChildSessions(
        { extensionHost: host },
        {
          cwd: root,
          ledgerPath: join(root, "ledger.db"),
          sessionId: "sess-1",
        },
      );
      let got: unknown;
      host.install({
        name: "test-ext",
        register: (api) => {
          void api.runChildSession({ prompt: "p", writable: true }).then((r) => {
            got = r;
          });
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(got, {
        status: "unavailable",
        model: "",
        message: "Writable child sessions require a parent approval gate.",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("spawned implementer escalates dispute to parent session without invoking child session", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-spawned-"));
    mkdirSync(root, { recursive: true });
    try {
      git(root, "init", "-q", "-b", "master");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");

      const kp = generateEd25519KeyPair();
      mkdirSync(join(root, ".lykos/seals/keys"), { recursive: true });
      writeFileSync(join(root, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      writeFileSync(join(root, ".lykos/config.yaml"), "seal:\n  base: master\n  test_command: \"node --test {files}\"\n  enforce_for: [build]\n");
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test/add.test.js"), "const assert = require('node:assert/strict'); const { test } = require('node:test'); test('adds', () => assert.equal(1, 1));\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");

      git(root, "checkout", "-q", "-b", "feat");
      const startCommit = git(root, "rev-parse", "HEAD");

      const sealObj: Omit<SealFile, "signature"> = {
        version: 1,
        branch: "feat",
        writer_commit: startCommit,
        creator: "test",
        specialist: "build",
        created_at: new Date().toISOString(),
        key_id: kp.keyId,
        sealed_paths: ["test/add.test.js"],
        test_command: "node --test {files}",
        adapter: "node:test",
        red: [{ file: "test/add.test.js", name: "adds", describe: [], failure: "assertion" }],
      };
      writeFileSync(
        join(root, ".lykos/seals/feat.json"),
        JSON.stringify({ ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2),
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seal");

      const parentSessionId = "sess-parent";
      const childSessionId = "sess-child";
      const ledgerPath = join(root, ".lykos/ledger.db");
      const ledger = openLedgerSync(ledgerPath);
      ledger.startSession({ id: parentSessionId, brief: "parent", harnessCommit: "abc" });
      ledger.startSession({ id: childSessionId, brief: "child", harnessCommit: "abc", parentSessionId });
      ledger.close();

      let childRan = false;
      const host = new LykosExtensionHost({ cwd: root, gate: { request: async () => "allow" } });
      host.bindSession({
        runChild: async () => {
          childRan = true;
          return { status: "ok", sessionId: "grandchild", model: "m", text: "ran" };
        },
      });
      host.install(sealExtension);
      host.setSessionId(childSessionId);
      host.setSpecialist("build");

      const tool = host.toolDefinitions().find((t) => t.name === "dispute_test");
      assert.ok(tool);
      const res = (await (tool.execute as any)("call-1", {
        file: "test/add.test.js",
        describe: [],
        name: "adds",
        reason: "wrong",
        evidence: "proof",
      })) as { content?: Array<{ text?: string }>; isError?: boolean };

      assert.equal(childRan, false, "runChildSession should not be called for spawned implementer");
      const text = res.content?.[0]?.text ?? "";
      assert.match(text, /Escalated to parent session\./);

      const checkLedger = openLedgerSync(ledgerPath);
      try {
        const events = checkLedger.db
          .prepare("SELECT kind, detail FROM seal_events WHERE session_id = ?")
          .all(childSessionId) as Array<{ kind: string; detail: string }>;
        assert.equal(events.length, 1);
        assert.equal(events[0]?.kind, "dispute filed");
      } finally {
        checkLedger.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not start a writable child when there is no seal to dispute", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-noseal-"));
    try {
      git(root, "init", "-q", "-b", "main");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");
      mkdirSync(join(root, ".lykos"), { recursive: true });
      writeFileSync(join(root, ".lykos/config.yaml"), "seal:\n  base: main\n  test_command: \"node --test {files}\"\n  enforce_for: [build]\n");
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test/add.test.js"), "// red\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");

      let childRan = false;
      const host = new LykosExtensionHost({ cwd: root, gate: { request: async () => "allow" } });
      host.bindSession({
        runChild: async () => {
          childRan = true;
          return { status: "ok", sessionId: "child-1", model: "m", text: "child ran" };
        },
      });
      host.install(sealExtension);

      const tool = host.toolDefinitions().find((t) => t.name === "dispute_test");
      assert.ok(tool);
      const res = (await (tool.execute as any)("call-1", {
        file: "test/add.test.js",
        describe: [],
        name: "adds",
        reason: "wrong",
        evidence: "proof",
      })) as { content?: Array<{ text?: string }>; isError?: boolean };

      assert.equal(childRan, false, "dispute_test started a writable child with no active seal");
      assert.equal(res.isError, true);
      assert.match(res.content?.[0]?.text ?? "", /not covered by any active seal/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not return a successful upheld ruling when no reseal was created", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-reseal-fail-"));
    const home = mkdtempSync(join(tmpdir(), "lykos-seal-home-"));
    const savedHome = process.env.HOME;
    try {
      process.env.HOME = home; // no ~/.lykos/seal-keys: sealCreate cannot sign a reseal
      git(root, "init", "-q", "-b", "main");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");
      const kp = generateEd25519KeyPair();
      mkdirSync(join(root, ".lykos/seals/keys"), { recursive: true });
      writeFileSync(join(root, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      writeFileSync(join(root, ".lykos/config.yaml"), "seal:\n  base: main\n  test_command: \"node --test {files}\"\n  enforce_for: [build]\n");
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test/add.test.js"), "// red\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");
      git(root, "checkout", "-q", "-b", "feat");
      const start = git(root, "rev-parse", "HEAD");
      const sealObj: Omit<SealFile, "signature"> = {
        version: 1, branch: "feat", writer_commit: start, creator: "test", specialist: "build",
        created_at: new Date().toISOString(), key_id: kp.keyId,
        sealed_paths: ["test/add.test.js"], test_command: "node --test {files}",
        adapter: "node:test", red: [{ file: "test/add.test.js", name: "adds", describe: [], failure: "assertion" }],
      };
      writeFileSync(join(root, ".lykos/seals/feat.json"), JSON.stringify({ ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2));
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seal");

      const host = new LykosExtensionHost({ cwd: root, gate: { request: async () => "allow" } });
      host.bindSession({
        runChild: async () => {
          writeFileSync(join(root, "test/add.test.js"), "// rewritten by the test writer\n");
          git(root, "add", "-A");
          git(root, "commit", "-q", "-m", "test writer commit");
          return { status: "ok", sessionId: "child-1", model: "m", text: "UPHELD: the test was wrong" };
        },
      });
      host.install(sealExtension);
      const tool = host.toolDefinitions().find((t) => t.name === "dispute_test");
      assert.ok(tool);
      const res = (await (tool.execute as any)("call-1", {
        file: "test/add.test.js", describe: [], name: "adds", reason: "wrong", evidence: "proof",
      })) as { content?: Array<{ text?: string }>; isError?: boolean };
      const text = res.content?.[0]?.text ?? "";
      assert.equal(res.isError, true, `the tool reported a plain upheld ruling with no reseal: ${text}`);
      assert.match(text, /reseal/i);
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("escalates second dispute of same test when session is resumed (count preserved across hosts)", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-resume-"));
    try {
      git(root, "init", "-q", "-b", "main");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");
      mkdirSync(join(root, ".lykos"), { recursive: true });
      writeFileSync(
        join(root, ".lykos/config.yaml"),
        "seal:\n  base: main\n  test_command: \"node --test {files}\"\n  enforce_for: [build]\n  escalate_after: 1\n",
      );
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test/add.test.js"), "// red\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");
      git(root, "checkout", "-q", "-b", "feat");
      const start = git(root, "rev-parse", "HEAD");

      const kp = generateEd25519KeyPair();
      mkdirSync(join(root, ".lykos/seals/keys"), { recursive: true });
      writeFileSync(join(root, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      const sealObj: Omit<SealFile, "signature"> = {
        version: 1, branch: "feat", writer_commit: start, creator: "test", specialist: "build",
        created_at: new Date().toISOString(), key_id: kp.keyId,
        sealed_paths: ["test/add.test.js"], test_command: "node --test {files}",
        adapter: "node:test", red: [{ file: "test/add.test.js", name: "adds", describe: [], failure: "assertion" }],
      };
      writeFileSync(join(root, ".lykos/seals/feat.json"), JSON.stringify({ ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2));
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seal");

      const sessionId = "sess-resume-count";
      const ledgerPath = join(root, ".lykos/ledger.db");
      const ledger = openLedgerSync(ledgerPath);
      ledger.startSession({ id: sessionId, brief: "test", harnessCommit: "abc" });

      ledger.db.prepare(
        "INSERT INTO seal_events (session_id, ts, branch, kind, paths, creator, specialist, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        sessionId,
        new Date().toISOString(),
        "feat",
        "dispute rejected",
        JSON.stringify(["test/add.test.js"]),
        sessionId,
        "test-writer",
        JSON.stringify({
          file: "test/add.test.js",
          describe: [],
          name: "adds",
          reason: "wrong",
          evidence: "proof",
          ruling: "REJECTED: correct",
        }),
      );
      ledger.close();

      let childRan = false;
      const host = new LykosExtensionHost({ cwd: root, gate: { request: async () => "allow" } });
      host.bindSession({
        runChild: async () => {
          childRan = true;
          return { status: "ok", sessionId: "child-2", model: "m", text: "child ran" };
        },
      });
      host.install(sealExtension);
      host.setSessionId(sessionId);
      host.setSpecialist("build");

      const tool = host.toolDefinitions().find((t) => t.name === "dispute_test");
      assert.ok(tool);
      const res = (await (tool.execute as any)("call-1", {
        file: "test/add.test.js",
        describe: [],
        name: "adds",
        reason: "wrong again",
        evidence: "more proof",
      })) as { content?: Array<{ text?: string }>; isError?: boolean };

      assert.equal(childRan, false, "the resumed session should have escalated instead of running test-writer child");
      const text = res.content?.[0]?.text ?? "";
      assert.match(text, /Dispute escalated/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("in a delegated run with no seal.resolver configured, dispute_test parks test and does not spawn child session", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-delegated-default-"));
    try {
      git(root, "init", "-q", "-b", "main");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");
      mkdirSync(join(root, ".lykos"), { recursive: true });
      writeFileSync(
        join(root, ".lykos/config.yaml"),
        "seal:\n  base: main\n  test_command: \"node --test {files}\"\n  enforce_for: [build]\n",
      );
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test/add.test.js"), "// red\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");
      git(root, "checkout", "-q", "-b", "feat");
      const start = git(root, "rev-parse", "HEAD");

      const kp = generateEd25519KeyPair();
      mkdirSync(join(root, ".lykos/seals/keys"), { recursive: true });
      writeFileSync(join(root, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      const sealObj: Omit<SealFile, "signature"> = {
        version: 1, branch: "feat", writer_commit: start, creator: "test", specialist: "build",
        created_at: new Date().toISOString(), key_id: kp.keyId,
        sealed_paths: ["test/add.test.js"], test_command: "node --test {files}",
        adapter: "node:test", red: [{ file: "test/add.test.js", name: "adds", describe: [], failure: "assertion" }],
      };
      writeFileSync(join(root, ".lykos/seals/feat.json"), JSON.stringify({ ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2));
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seal");

      const sessionId = "sess-delegated-test";
      const ledgerPath = join(root, ".lykos/ledger.db");
      const ledger = openLedgerSync(ledgerPath);
      ledger.startSession({ id: sessionId, brief: "test", harnessCommit: "abc" });
      ledger.close();

      let childRan = false;
      const host = new LykosExtensionHost({ cwd: root, gate: { request: async () => "allow" }, delegated: true });
      host.bindSession({
        runChild: async () => {
          childRan = true;
          return { status: "ok", sessionId: "child-1", model: "m", text: "child ran" };
        },
      });
      host.install(sealExtension);
      host.setSessionId(sessionId);
      host.setSpecialist("build");

      const tool = host.toolDefinitions().find((t) => t.name === "dispute_test");
      assert.ok(tool);
      const res = (await (tool.execute as any)("call-1", {
        file: "test/add.test.js",
        describe: [],
        name: "adds",
        reason: "wrong spec",
        evidence: "proof",
      })) as { content?: Array<{ text?: string }>; isError?: boolean };

      assert.equal(childRan, false, "child session should not run in delegated mode when resolver is unset");
      const text = res.content?.[0]?.text ?? "";
      assert.match(text, /Test parked\./);
      assert.doesNotMatch(text, /Escalated to parent session\./);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("in a delegated run with explicit seal.resolver: test-writer, dispute_test spawns test-writer child session", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-delegated-writer-"));
    try {
      git(root, "init", "-q", "-b", "main");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");
      mkdirSync(join(root, ".lykos"), { recursive: true });
      writeFileSync(
        join(root, ".lykos/config.yaml"),
        "seal:\n  base: main\n  test_command: \"node --test {files}\"\n  enforce_for: [build]\n  resolver: test-writer\n",
      );
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test/add.test.js"), "// red\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");
      git(root, "checkout", "-q", "-b", "feat");
      const start = git(root, "rev-parse", "HEAD");

      const kp = generateEd25519KeyPair();
      mkdirSync(join(root, ".lykos/seals/keys"), { recursive: true });
      writeFileSync(join(root, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      const sealObj: Omit<SealFile, "signature"> = {
        version: 1, branch: "feat", writer_commit: start, creator: "test", specialist: "build",
        created_at: new Date().toISOString(), key_id: kp.keyId,
        sealed_paths: ["test/add.test.js"], test_command: "node --test {files}",
        adapter: "node:test", red: [{ file: "test/add.test.js", name: "adds", describe: [], failure: "assertion" }],
      };
      writeFileSync(join(root, ".lykos/seals/feat.json"), JSON.stringify({ ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2));
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seal");

      const sessionId = "sess-delegated-writer";
      const ledgerPath = join(root, ".lykos/ledger.db");
      const ledger = openLedgerSync(ledgerPath);
      ledger.startSession({ id: sessionId, brief: "test", harnessCommit: "abc" });
      ledger.close();

      let childRan = false;
      const host = new LykosExtensionHost({ cwd: root, gate: { request: async () => "allow" }, delegated: true });
      host.bindSession({
        runChild: async () => {
          childRan = true;
          return { status: "ok", sessionId: "child-1", model: "m", text: "child ran" };
        },
      });
      host.install(sealExtension);
      host.setSessionId(sessionId);
      host.setSpecialist("build");

      const tool = host.toolDefinitions().find((t) => t.name === "dispute_test");
      assert.ok(tool);
      await (tool.execute as any)("call-1", {
        file: "test/add.test.js",
        describe: [],
        name: "adds",
        reason: "wrong spec",
        evidence: "proof",
      });

      assert.equal(childRan, true, "child session should run in delegated mode when resolver is explicitly test-writer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("in a standalone run with no seal.resolver configured, dispute_test defaults to test-writer and spawns child session", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-standalone-default-"));
    try {
      git(root, "init", "-q", "-b", "main");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");
      mkdirSync(join(root, ".lykos"), { recursive: true });
      writeFileSync(
        join(root, ".lykos/config.yaml"),
        "seal:\n  base: main\n  test_command: \"node --test {files}\"\n  enforce_for: [build]\n",
      );
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(join(root, "test/add.test.js"), "// red\n");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");
      git(root, "checkout", "-q", "-b", "feat");
      const start = git(root, "rev-parse", "HEAD");

      const kp = generateEd25519KeyPair();
      mkdirSync(join(root, ".lykos/seals/keys"), { recursive: true });
      writeFileSync(join(root, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      const sealObj: Omit<SealFile, "signature"> = {
        version: 1, branch: "feat", writer_commit: start, creator: "test", specialist: "build",
        created_at: new Date().toISOString(), key_id: kp.keyId,
        sealed_paths: ["test/add.test.js"], test_command: "node --test {files}",
        adapter: "node:test", red: [{ file: "test/add.test.js", name: "adds", describe: [], failure: "assertion" }],
      };
      writeFileSync(join(root, ".lykos/seals/feat.json"), JSON.stringify({ ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) }, null, 2));
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seal");

      const sessionId = "sess-standalone-default";
      const ledgerPath = join(root, ".lykos/ledger.db");
      const ledger = openLedgerSync(ledgerPath);
      ledger.startSession({ id: sessionId, brief: "test", harnessCommit: "abc" });
      ledger.close();

      let childRan = false;
      const host = new LykosExtensionHost({ cwd: root, gate: { request: async () => "allow" } });
      host.bindSession({
        runChild: async () => {
          childRan = true;
          return { status: "ok", sessionId: "child-1", model: "m", text: "child ran" };
        },
      });
      host.install(sealExtension);
      host.setSessionId(sessionId);
      host.setSpecialist("build");

      const tool = host.toolDefinitions().find((t) => t.name === "dispute_test");
      assert.ok(tool);
      await (tool.execute as any)("call-1", {
        file: "test/add.test.js",
        describe: [],
        name: "adds",
        reason: "wrong spec",
        evidence: "proof",
      });

      assert.equal(childRan, true, "child session should run in standalone mode with default resolver");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an upheld dispute on a branch of its own writes that branch's seal and prunes the parent seal", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-seal-branch-"));
    const home = mkdtempSync(join(tmpdir(), "lykos-seal-home-"));
    const savedHome = process.env.HOME;
    try {
      process.env.HOME = home;
      mkdirSync(join(home, ".lykos", "seal-keys"), { recursive: true });
      git(root, "init", "-q", "-b", "main");
      git(root, "config", "user.name", "T");
      git(root, "config", "user.email", "t@example.com");

      const kp = generateEd25519KeyPair();
      writeFileSync(join(home, ".lykos", "seal-keys", `${kp.keyId}.pem`), kp.privateKeyPem);
      mkdirSync(join(root, ".lykos", "seals", "keys"), { recursive: true });
      writeFileSync(join(root, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
      writeFileSync(
        join(root, ".lykos/config.yaml"),
        "seal:\n  base: main\n  test_command: \"node --test {files}\"\n  enforce_for: [build]\n",
      );
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/math.mjs"), "export function add(a, b) { return 0; }\n");
      mkdirSync(join(root, "test"), { recursive: true });
      writeFileSync(
        join(root, "test/math.test.mjs"),
        'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/math.mjs";\ntest("adds", () => { assert.equal(add(1, 2), 4); });\n',
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "init");

      git(root, "checkout", "-q", "-b", "feat");
      const start = git(root, "rev-parse", "HEAD");
      const sealObj: Omit<SealFile, "signature"> = {
        version: 1,
        branch: "feat",
        writer_commit: start,
        creator: "test",
        specialist: "build",
        created_at: new Date().toISOString(),
        key_id: kp.keyId,
        sealed_paths: ["test/math.test.mjs"],
        test_command: "node --test {files}",
        adapter: "node:test",
        red: [{ file: "test/math.test.mjs", name: "adds", describe: [], failure: "assertion" }],
      };
      writeFileSync(
        join(root, ".lykos/seals/feat.json"),
        JSON.stringify(
          { ...sealObj, signature: signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem) },
          null,
          2,
        ),
      );
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seal on feat");

      // Branch feat-2 from feat
      git(root, "checkout", "-q", "-b", "feat-2");

      const host = new LykosExtensionHost({ cwd: root, gate: { request: async () => "allow" } });
      host.bindSession({
        runChild: async () => {
          // Test writer fixes expectation to 3 (which still fails assertion since src/math.mjs returns 0)
          writeFileSync(
            join(root, "test/math.test.mjs"),
            'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/math.mjs";\ntest("adds", () => { assert.equal(add(1, 2), 3); });\n',
          );
          git(root, "add", "-A");
          git(root, "commit", "-q", "-m", "fix expectation to 3");
          return { status: "ok", sessionId: "child-1", model: "m", text: "UPHELD: the expectation was wrong" };
        },
      });
      host.install(sealExtension);

      const tool = host.toolDefinitions().find((t) => t.name === "dispute_test");
      assert.ok(tool);
      const res = (await (tool.execute as any)("call-1", {
        file: "test/math.test.mjs",
        describe: [],
        name: "adds",
        reason: "1 + 2 is 3, expected 4",
        evidence: "basic arithmetic",
      })) as { content?: Array<{ text?: string }>; isError?: boolean };

      assert.equal(res.isError ?? false, false, `dispute failed: ${res.content?.[0]?.text}`);
      assert.match(res.content?.[0]?.text ?? "", /Dispute upheld/);

      assert.ok(existsSync(join(root, ".lykos/seals/feat-2.json")), "feat-2.json was created");
      assert.equal(existsSync(join(root, ".lykos/seals/feat.json")), false, "feat.json was pruned");
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
