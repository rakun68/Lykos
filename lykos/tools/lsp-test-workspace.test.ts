// The guard behind the LSP tests' cleanup has to be able to fail. A check made
// through the pool after shutdown cannot (shutdownAll empties the pool's map
// first), so this gives the helper a pool that leaks a live process.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { processGone, shutdownAndAssertGone } from "./lsp-test-workspace.js";

describe("T187: shutdownAndAssertGone", () => {
  it("fails with 'survived shutdown' for a server still alive after shutdownAll, and still removes the folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t187-guard-"));
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", windowsHide: true });
    try {
      assert.ok(child.pid !== undefined);
      const pid = child.pid;
      const leaky = { pids: () => [pid], shutdownAll: async () => {} };
      await assert.rejects(
        () => shutdownAndAssertGone(leaky, dir),
        (err: unknown) => err instanceof Error && new RegExp(`language server ${pid} survived shutdown`).test(err.message),
      );
      assert.equal(existsSync(dir), false, "the folder is removed even when the check fails");
    } finally {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", () => resolve())));
    }
    assert.equal(processGone(child.pid!), true);
  });

  it("passes when every captured server is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t187-guard-"));
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });
    const pid = child.pid!;
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await shutdownAndAssertGone({ pids: () => [pid], shutdownAll: async () => {} }, dir);
    assert.equal(existsSync(dir), false);
  });
});
