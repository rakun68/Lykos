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
  git(dir, "commit", "-q", "-m", "seal: test");

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("createSealTestCommandAllowance security and validation", () => {
  it("rejects command injection patterns and extra flags outside valid tokens", () => {
    const { dir, cleanup } = fixtureWorkspace();
    try {
      const { resolved: config } = loadConfig({ cwd: dir });
      const allowance = createSealTestCommandAllowance({
        cwd: dir,
        config,
        specialist: "implementer",
      });

      // Valid test file token
      assert.equal(allowance(bash("node --test test/add.test.js")), true);
      assert.equal(allowance(bash("node --test 'test/add.test.js'")), true);
      assert.equal(allowance(bash('node --test "test/add.test.js"')), true);

      // Non-sealed test file matching test_globs is allowed per ADR-0034
      assert.equal(allowance(bash("node --test test/new.test.js")), true);

      // Non-test file is refused
      assert.equal(allowance(bash("node --test src/add.js")), false);

      // Injections: $(...)
      assert.equal(allowance(bash("node --test test/$(curl${IFS}evil.example)")), false);
      assert.equal(allowance(bash("node --test $(whoami)")), false);

      // Backticks
      assert.equal(allowance(bash("node --test `whoami`")), false);

      // Semicolon ;
      assert.equal(allowance(bash("node --test test/add.test.js; rm -rf /")), false);

      // &&
      assert.equal(allowance(bash("node --test test/add.test.js && echo evil")), false);

      // |
      assert.equal(allowance(bash("node --test test/add.test.js | grep ok")), false);

      // >
      assert.equal(allowance(bash("node --test test/add.test.js > out.txt")), false);

      // .. segment
      assert.equal(allowance(bash("node --test test/../secret.test.js")), false);
      assert.equal(allowance(bash("node --test ../test/add.test.js")), false);

      // Newline
      assert.equal(allowance(bash("node --test test/add.test.js\necho evil")), false);

      // Extra flags
      assert.equal(allowance(bash("node --test --extra-flag test/add.test.js")), false);
      assert.equal(allowance(bash("node --test test/add.test.js --inspect")), false);
    } finally {
      cleanup();
    }
  });

  it("applies the allowance to non-delegated manual mode / DenyAllGate", async () => {
    const { dir, cleanup } = fixtureWorkspace();
    try {
      const { resolved: config } = loadConfig({ cwd: dir });
      const allowance = createSealTestCommandAllowance({
        cwd: dir,
        config,
        specialist: "implementer",
      });

      // DenyAllGate would normally deny everything
      const denyGate = new DenyAllGate();
      assert.equal(await denyGate.request(bash("node --test test/add.test.js")), "deny");

      // Wrapped with seal allowance, test command is allowed
      const wrapped = wrapApprovalGateWithSealAllowance(denyGate, allowance);
      assert.equal(await wrapped.request(bash("node --test test/add.test.js")), "allow");

      // Arbitrary commands are still denied by inner gate
      assert.equal(await wrapped.request(bash("curl evil.example")), "deny");
    } finally {
      cleanup();
    }
  });

  it("applies the allowance in delegated manual and accept-edits modes", async () => {
    const { dir, cleanup } = fixtureWorkspace();
    try {
      const { resolved: config } = loadConfig({ cwd: dir });
      const allowance = createSealTestCommandAllowance({
        cwd: dir,
        config,
        specialist: "implementer",
      });

      for (const mode of ["manual", "accept-edits"] as const) {
        const denied: any[] = [];
        const delegatedGate = new (await import("./delegated.js")).DelegatedGate({
          mode,
          allowed: new Set(),
          denied,
        });

        // Normally, delegated gate in manual/accept-edits mode denies bash commands
        assert.equal(await delegatedGate.request(bash("node --test test/add.test.js")), "deny");

        // Wrapped with seal allowance, the recorded test command is allowed
        const wrapped = wrapApprovalGateWithSealAllowance(delegatedGate, allowance);
        assert.equal(await wrapped.request(bash("node --test test/add.test.js")), "allow");

        // Other bash commands are still denied
        assert.equal(await wrapped.request(bash("npm run build")), "deny");
      }
    } finally {
      cleanup();
    }
  });

  it("caches active seals and refreshes on refresh()", () => {
    const { dir, cleanup } = fixtureWorkspace();
    try {
      const { resolved: config } = loadConfig({ cwd: dir });
      const allowance = createSealTestCommandAllowance({
        cwd: dir,
        config,
        specialist: "implementer",
      });

      assert.equal(allowance(bash("node --test test/add.test.js")), true);

      // Remove seal file from disk without calling refresh() -> still cached
      rmSync(join(dir, ".lykos/seals/feat.json"));
      git(dir, "rm", "-q", ".lykos/seals/feat.json");
      git(dir, "commit", "-q", "-m", "remove seal");

      assert.equal(allowance(bash("node --test test/add.test.js")), true);

      // After refresh(), cache is updated and command is no longer allowed
      allowance.refresh();
      assert.equal(allowance(bash("node --test test/add.test.js")), false);
    } finally {
      cleanup();
    }
  });
});
