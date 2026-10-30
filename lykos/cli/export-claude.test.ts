// T225 follow-ups beside the sealed test: the shim names the tool `lykos mcp`
// serves (T222's name rule), and a specialist file discovery could not read
// gets no shim.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runExportClaude } from "./export-claude.js";

function project(specs: Record<string, string>): { cwd: string; home: string; shipped: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "lykos-export-claude-unit-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  const shipped = join(root, "shipped");
  mkdirSync(join(cwd, ".lykos", "specialists"), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(shipped, { recursive: true });
  for (const [name, body] of Object.entries(specs)) writeFileSync(join(cwd, ".lykos", "specialists", `${name}.yaml`), body);
  return { cwd, home, shipped, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("lykos export claude follows `lykos mcp`'s tool list", () => {
  it("names the sanitised tool for a specialist whose name has characters outside the tool alphabet", () => {
    const p = project({ "my spec": "description: spaced\nrole: subagent\n" });
    try {
      assert.equal(runExportClaude(p.cwd, { homeDir: p.home, globalDir: join(p.home, ".lykos"), shippedDir: p.shipped }), 0);
      const file = join(p.cwd, ".claude", "agents", "lykos-my_spec.md");
      assert.ok(existsSync(file));
      const text = readFileSync(file, "utf8");
      assert.match(text, /^tools: mcp__lykos__lykos_my_spec$/m);
      assert.match(text, /^name: lykos-my_spec$/m);
    } finally {
      p.cleanup();
    }
  });

  it("writes no shim for an unreadable specialist and still writes the others", () => {
    const p = project({ good: "description: fine\n", bad: "role: nonsense\n" });
    try {
      runExportClaude(p.cwd, { homeDir: p.home, globalDir: join(p.home, ".lykos"), shippedDir: p.shipped });
      assert.ok(existsSync(join(p.cwd, ".claude", "agents", "lykos-good.md")));
      assert.ok(!existsSync(join(p.cwd, ".claude", "agents", "lykos-bad.md")));
    } finally {
      p.cleanup();
    }
  });
});
