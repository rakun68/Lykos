import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWriteOperations, type ApprovalGate, type ApprovalRequest } from "./approval.js";
import { DelegatedGate } from "./delegated.js";
import { collectPathRules } from "./path-rules.js";

describe("write operations: mkdir before a write", () => {
  it("an existing protected directory is not asked about, so the deny names the file (T218)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lykos-mkdir-"));
    mkdirSync(join(cwd, ".git"));
    const denied: { detail: string }[] = [];
    const gate = new DelegatedGate({
      mode: "auto",
      allowed: new Set(),
      denied: denied as never,
      rules: collectPathRules({}, false),
      ctx: { cwd, home: tmpdir(), extraDirs: [], outside: { read: "ask", write: "ask" } },
    });
    const ops = buildWriteOperations(cwd, gate);
    await ops.mkdir!(join(cwd, ".git"));
    assert.equal(denied.length, 0, "mkdir of an existing directory asks nothing");
    await assert.rejects(ops.writeFile(join(cwd, ".git", "config"), "x"));
    assert.equal(denied.length, 1);
    assert.match(denied[0]!.detail, /config$/);
  });

  it("a directory that does not exist yet is still decided by the path rules", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lykos-mkdir-"));
    const asked: ApprovalRequest[] = [];
    const gate: ApprovalGate = { request: async (req) => (asked.push(req), "deny") };
    const ops = buildWriteOperations(cwd, gate);
    await assert.rejects(ops.mkdir!(join(cwd, ".git")));
    assert.equal(asked.length, 1);
    assert.equal(asked[0]!.summary, "create directory");
  });
});
