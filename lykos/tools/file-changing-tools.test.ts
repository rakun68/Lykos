// P4 T143: the set of file-changing tools is declared once, on the tool
// registry (`ToolRegistryEntry.changesFiles`), and the post-edit loop, the
// gate's edit test and the edit counters all read it. These are the direct
// tests of that pure rule, and the two nets that make a new edit tool fail a
// test until somebody declares it.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { isMutatingTool } from "../loop/post-edit.js";
import { classifyToolCall } from "../loop/exploration.js";
import { sessionEditedFiles } from "../session/session.js";
import { isFileChangingCall } from "./tool-call.js";
import { PACKAGE_FILE_CHANGING_TOOLS, TOOL_REGISTRY, fileChangingToolNames, toolChangesFiles } from "./tool-surface.js";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Write-tier rows that do NOT change a file in the working tree, each with the
 * reason. A new `soft-write` row that is neither declared file-changing nor
 * listed here fails the first net below — the decision has to be made, once.
 */
const WRITES_BUT_NOT_THE_TREE: Readonly<Record<string, string>> = {
  manage_skill: "writes .lykos/skills/, runtime state no check or test suite reads",
  security_scan: "writes its own record under .lykos/security/",
  retain: "writes the memory proposal queue under .lykos/",
  memory_edit: "rewrites a memory file, not project source",
  learn: "writes the memory proposal queue under .lykos/",
  todo: "session task list, not a project file",
  commit: "records a git commit and the files already on disk are untouched",
};

/**
 * Modules under lykos/tools/ that ask the gate to approve a file write or
 * edit, and the registry tools they build. A new module that asks the gate for
 * a write fails the second net until it is entered here — and every tool
 * entered here must be declared file-changing, unless it is in the list above.
 */
const GATED_WRITERS: Readonly<Record<string, readonly string[]>> = {
  "ast-edit.ts": ["ast_edit"],
  "edit.ts": ["edit"],
  "gated.ts": ["write", "edit"],
  "lsp.ts": ["lsp"],
  "skill-tools.ts": ["manage_skill"],
};

describe("T143: the file-changing tool set is declared once", () => {
  it("is exactly the declared rows plus the Pi-package edit tools", () => {
    const declared = TOOL_REGISTRY.filter((e) => e.changesFiles !== undefined).map((e) => e.name);
    assert.deepEqual(declared.sort(), ["ast_edit", "edit", "lsp", "write"]);
    assert.deepEqual(fileChangingToolNames().sort(), [...declared, ...PACKAGE_FILE_CHANGING_TOOLS].sort());
  });

  it("lsp changes files only when it renames", () => {
    assert.equal(toolChangesFiles("lsp", { action: "rename", file: "a.ts" }), true);
    for (const action of ["definition", "references", "hover", "symbols", "diagnostics", "status"]) {
      assert.equal(toolChangesFiles("lsp", { action }), false, action);
    }
    assert.equal(toolChangesFiles("lsp", undefined), false);
  });

  it("unwraps the tool_call transport, and the loop, the gate and the counters agree on every call", () => {
    const calls: Array<{ name: string; args: unknown; expected: boolean }> = [
      { name: "write", args: { path: "a" }, expected: true },
      { name: "multi_edit", args: { path: "a" }, expected: true },
      { name: "tool_call", args: { name: "ast_edit", arguments: { rules: [], paths: ["a.ts"] } }, expected: true },
      { name: "tool_call", args: { name: "lsp", arguments: { action: "rename", file: "a.ts" } }, expected: true },
      { name: "tool_call", args: { name: "lsp", arguments: { action: "hover", file: "a.ts" } }, expected: false },
      { name: "tool_call", args: { name: "ls", arguments: { path: "." } }, expected: false },
      { name: "bash", args: { command: "sed -i s/a/b/ x" }, expected: false },
      { name: "read", args: { path: "a" }, expected: false },
    ];
    for (const c of calls) {
      const label = `${c.name} ${JSON.stringify(c.args)}`;
      assert.equal(isFileChangingCall(c.name, c.args), c.expected, label);
      assert.equal(isMutatingTool(c.name, c.args), c.expected, `post-edit loop: ${label}`);
      assert.equal(sessionEditedFiles([{ name: c.name, args: c.args, state: "ok" }]), c.expected, `gate: ${label}`);
      assert.equal(classifyToolCall({ name: c.name, args: c.args }).kind === "edit", c.expected, `counters: ${label}`);
    }
  });

  it("net 1: every write-tier registry row is classified as file-changing or not", () => {
    for (const entry of TOOL_REGISTRY) {
      if (entry.risk.tier !== "soft-write") continue;
      const declared = entry.changesFiles !== undefined;
      const excused = entry.name in WRITES_BUT_NOT_THE_TREE;
      assert.ok(
        declared !== excused,
        `${entry.name} is a soft-write tool: declare \`changesFiles\` on its registry row, or add it to ` +
          `WRITES_BUT_NOT_THE_TREE with the reason it changes no file in the working tree`,
      );
    }
  });

  it("net 2: every tool module that asks the gate to approve a write is a declared file-changing tool", () => {
    const writers = readdirSync(TOOLS_DIR)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter((f) =>
        /authorizeEditBody|buildWriteOperations|buildEditOperations|kind: "(?:edit|write)"/.test(
          readFileSync(join(TOOLS_DIR, f), "utf8"),
        ),
      )
      .sort();
    assert.deepEqual(
      writers,
      Object.keys(GATED_WRITERS).sort(),
      "a module under lykos/tools/ asks the gate to approve a file write: enter it in GATED_WRITERS and " +
        "declare its tool's `changesFiles` on the registry",
    );
    for (const [file, tools] of Object.entries(GATED_WRITERS)) {
      for (const tool of tools) {
        if (tool in WRITES_BUT_NOT_THE_TREE) continue;
        assert.ok(fileChangingToolNames().includes(tool), `${tool} (built in ${file}) is not declared file-changing`);
      }
    }
  });
});
