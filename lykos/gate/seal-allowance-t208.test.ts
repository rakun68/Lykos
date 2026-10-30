// T208 ACCEPTANCE: what the P3 delegated demonstration (T207) found blocked.
//
// In a delegated session in auto mode, (1) a test writer could not run its own
// red tests before any seal existed, (2) no test command was allowed on a
// Windows host, where every shell request is `powershell`, and (3) dispute_test,
// an extension tool, was refused as a hard write, so a delegated implementer
// could never file a dispute.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createSealTestCommandAllowance, wrapApprovalGateWithSealAllowance } from "./delegated.js";
import { DenyAllGate, type ApprovalRequest } from "./approval.js";
import { loadConfig } from "../config/load.js";
import { generateEd25519KeyPair, signPayload } from "../seal/crypto.js";
import type { SealFile } from "../seal/types.js";

const shell = (command: string, which: "bash" | "powershell"): ApprovalRequest => ({
  kind: "bash",
  summary: command,
  detail: command,
  shell: which,
});

const extensionCall = (tool: string, extension: string): ApprovalRequest => ({
  kind: "extension",
  summary: `run the extension tool ${tool}`,
  detail: `${tool} (extension ${extension})`,
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.quotepath=false", ...args], { cwd, encoding: "utf-8" });
}

/** A repository on master with the seal extension and a test command, and optionally a sealed branch `feat`. */
function workspace(sealed: boolean): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lykos-t208-"));
  git(dir, "init", "-q", "-b", "master");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  const kp = generateEd25519KeyPair();
  mkdirSync(join(dir, ".lykos/seals/keys"), { recursive: true });
  writeFileSync(join(dir, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);
  writeFileSync(
    join(dir, ".lykos/config.yaml"),
    [
      "lykos_extensions:",
      "  - name: lykos-seal",
      "seal:",
      "  base: master",
      '  writers: ["test-writer"]',
      '  enforce_for: ["implementer"]',
      '  test_command: "node --test {files}"',
      '  test_globs: ["test/**", "**/*.test.*"]',
      "",
    ].join("\n"),
  );
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "src/add.js"), "module.exports = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", "feat");
  writeFileSync(join(dir, "test/add.test.js"), "require('assert').equal(1, 2);\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "red: add");
  if (sealed) {
    const body: Omit<SealFile, "signature"> = {
      version: 1,
      branch: "feat",
      writer_commit: git(dir, "rev-parse", "HEAD").trim(),
      creator: "test",
      specialist: "test-writer",
      sealed_paths: ["test/add.test.js"],
      test_command: "node --test {files}",
      adapter: "node:test",
      red: [],
      created_at: new Date().toISOString(),
      key_id: kp.keyId,
    };
    const seal: SealFile = { ...body, signature: signPayload(body as unknown as Record<string, unknown>, kp.privateKeyPem) };
    writeFileSync(join(dir, ".lykos/seals/feat.json"), JSON.stringify(seal, null, 2));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "seal: feat");
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function allowanceFor(dir: string, specialist: string) {
  const { resolved: config } = loadConfig({ cwd: dir });
  return createSealTestCommandAllowance({ cwd: dir, config, specialist });
}

describe("T208 ACCEPTANCE: the test writer runs its own red tests before any seal exists", () => {
  it("a writer with no active seal may run the configured test command on test files, and nothing else", () => {
    const { dir, cleanup } = workspace(false);
    try {
      const allow = allowanceFor(dir, "test-writer");
      assert.equal(allow(shell("node --test test/add.test.js", "bash")), true, "the configured template, filled with a test file");
      assert.equal(allow(shell("node --test src/add.js", "bash")), false, "a non-test file");
      assert.equal(allow(shell("node --test test/add.test.js; rm -rf src", "bash")), false, "a compound line");
      // Before a seal exists only a writer gets the allowance: an implementer has nothing sealed to run.
      assert.equal(allowanceFor(dir, "implementer")(shell("node --test test/add.test.js", "bash")), false);
    } finally {
      cleanup();
    }
  });
});

describe("T208 ACCEPTANCE: the allowance covers powershell", () => {
  it("the same single command is allowed through powershell, and a compound or piped one is not", () => {
    const { dir, cleanup } = workspace(true);
    try {
      const allow = allowanceFor(dir, "implementer");
      assert.equal(allow(shell("node --test test/add.test.js", "powershell")), true);
      assert.equal(allow(shell("node --test 'test/add.test.js'", "powershell")), true);
      assert.equal(allow(shell("node --test test/add.test.js; Remove-Item -Recurse src", "powershell")), false);
      assert.equal(allow(shell("node --test test/add.test.js | Select-Object -Last 20", "powershell")), false);
      assert.equal(allow(shell("node --test $(Get-ChildItem)", "powershell")), false);
      assert.equal(allow(shell("node --test test/add.test.js > out.txt", "powershell")), false);
    } finally {
      cleanup();
    }
  });
});

describe("T208 ACCEPTANCE: dispute_test is allowed for an enforced specialist", () => {
  it("lykos-seal's dispute_test passes a deny-all gate for the implementer; any other extension tool does not", async () => {
    const { dir, cleanup } = workspace(true);
    try {
      const gate = wrapApprovalGateWithSealAllowance(new DenyAllGate(), allowanceFor(dir, "implementer"));
      assert.equal(await gate.request(extensionCall("dispute_test", "lykos-seal")), "allow");
      assert.notEqual(await gate.request(extensionCall("dispute_test", "some-other-extension")), "allow");
      assert.notEqual(await gate.request(extensionCall("rewrite_tests", "lykos-seal")), "allow");
    } finally {
      cleanup();
    }
  });
});
