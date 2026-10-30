import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { renderClaudeAgentFile, runExportClaude } from "./export-claude.js";

function fixture(specs: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "lykos-p7-export-review-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  const shipped = join(root, "shipped");
  const agents = join(cwd, ".claude", "agents");
  mkdirSync(join(cwd, ".lykos", "specialists"), { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(shipped, { recursive: true });
  for (const [name, description] of Object.entries(specs)) {
    writeFileSync(join(cwd, ".lykos", "specialists", `${name}.yaml`), `role: subagent\ndescription: ${JSON.stringify(description)}\n`);
  }
  return {
    cwd, agents,
    run: () => runExportClaude(cwd, { homeDir: home, globalDir: join(home, ".lykos"), shippedDir: shipped }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("P7 review: Claude export matches specialist tool selection", () => {
  it("keeps the exact tool-name match when a later specialist sanitizes to the same name", () => {
    const f = fixture({ foo_bar: "exact winner", "foo~bar": "collision loser" });
    try {
      assert.equal(f.run(), 0);
      const text = readFileSync(join(f.agents, "lykos-foo_bar.md"), "utf8");
      assert.match(text, /^description: "exact winner"$/m);
      assert.doesNotMatch(text, /collision loser/);
    } finally { f.cleanup(); }
  });

  it("uses alphabetical precedence when no colliding specialist exactly matches the tool name", () => {
    const f = fixture({ "foo bar": "alphabetical winner", "foo~bar": "later loser" });
    try {
      assert.equal(f.run(), 0);
      assert.match(readFileSync(join(f.agents, "lykos-foo_bar.md"), "utf8"), /^description: "alphabetical winner"$/m);
    } finally { f.cleanup(); }
  });

  for (const name of ["start", "status", "steer", "stop"]) {
    it(`omits the reserved ${name} tool and removes a stale generated shim`, () => {
      const f = fixture({ [name]: "reserved collision", helper: "valid specialist" });
      try {
        mkdirSync(f.agents, { recursive: true });
        const stale = join(f.agents, `lykos-${name}.md`);
        writeFileSync(stale, renderClaudeAgentFile(name, "old generated shim"));
        assert.equal(f.run(), 0);
        assert.ok(!existsSync(stale), "reserved async tools must have no specialist shim");
        assert.ok(existsSync(join(f.agents, "lykos-helper.md")), "unrelated specialists remain exported");
      } finally { f.cleanup(); }
    });
  }
});
