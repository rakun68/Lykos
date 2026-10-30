import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  createSealTestCommandAllowance,
  wrapApprovalGateWithSealAllowance,
} from "./delegated.js";
import { DenyAllGate, type ApprovalRequest } from "./approval.js";
import { loadConfig } from "../config/load.js";
import { generateEd25519KeyPair, signPayload } from "../seal/crypto.js";
import type { SealFile } from "../seal/types.js";

const bash = (command: string): ApprovalRequest => ({
  kind: "bash",
  summary: command,
  detail: command,
  shell: "bash",
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
    cwd,
    encoding: "utf-8",
  });
}

function fixtureWorkspace(): { dir: string; cleanup: () => void } {
  // The seal is written but not committed: it reaches HEAD only through the bash commit in the test.
  const dir = mkdtempSync(join(tmpdir(), "lykos-seal-allowance-test-"));
  git(dir, "init", "-q", "-b", "master");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");

  const kp = generateEd25519KeyPair();
  mkdirSync(join(dir, ".lykos/seals/keys"), { recursive: true });
  writeFileSync(join(dir, `.lykos/seals/keys/${kp.keyId}.pub`), kp.publicKeyPem);

  writeFileSync(
    join(dir, ".lykos/config.yaml"),
    `lykos_extensions:
  - name: lykos-seal
seal:
  base: master
  writers: ["test-writer"]
  enforce_for: ["implementer"]
  test_command: "node --test {files}"
  test_globs: ["test/**", "**/*.test.*"]
`,
  );

  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "src/add.js"), "module.exports = 1;\n");
  writeFileSync(join(dir, "test/add.test.js"), "const assert = require('assert');\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");

  // Create branch feat
  git(dir, "checkout", "-q", "-b", "feat");
  writeFileSync(join(dir, "test/add.test.js"), "assert.equal(1, 1);\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "test: add assertion");
  const writerCommit = git(dir, "rev-parse", "HEAD").trim();

  const sealObj: Omit<SealFile, "signature"> = {
    version: 1,
    branch: "feat",
    writer_commit: writerCommit,
    creator: "test",
    specialist: "test-writer",
    sealed_paths: ["test/add.test.js"],
    test_command: "node --test {files}",
    adapter: "node:test",
    red: [],
    created_at: new Date().toISOString(),
    key_id: kp.keyId,
  };
  const signature = signPayload(sealObj as unknown as Record<string, unknown>, kp.privateKeyPem);
  const seal: SealFile = { ...sealObj, signature };

  mkdirSync(join(dir, ".lykos/seals"), { recursive: true });
  writeFileSync(join(dir, ".lykos/seals/feat.json"), JSON.stringify(seal, null, 2));
  git(dir, "add", "-A");

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("SealAllowanceGate after a bash git commit", () => {
  // p3check1: the gate refreshed its cached seals when the `git commit` request was approved, before the
  // commit ran, so a seal committed through bash stayed invisible for the rest of the session.
  it("allows the sealed test command once a seal committed through bash is at HEAD", async () => {
    const { dir, cleanup } = fixtureWorkspace();
    try {
      const { resolved: config } = loadConfig({ cwd: dir });
      const allowance = createSealTestCommandAllowance({ cwd: dir, config, specialist: "implementer" });
      const wrapped = wrapApprovalGateWithSealAllowance(new DenyAllGate(), allowance);

      assert.equal(await wrapped.request(bash("node --test test/add.test.js")), "deny", "no seal at HEAD yet");

      const commit = "git commit -q -m 'seal: test'";
      await wrapped.request(bash(commit));
      git(dir, "commit", "-q", "-m", "seal: test");

      assert.equal(await wrapped.request(bash("node --test test/add.test.js")), "allow");
    } finally {
      cleanup();
    }
  });
});
