// P4 T143 (spec user stories 1-6): whatever tool changes a file, the loop
// sees it. Scripted sessions that edit ONLY through `ast_edit` or an `lsp`
// rename — both mounted, so reached through `tool_call` — and one that loads
// a skill through the `skill` tool. Every assertion reads the ledger or
// `lykos show`, never an internal.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { mounted, reply, runScriptedSession, say } from "./scripted-session.js";

/** Exits 0 when a.ts says `salute`, 1 (with a message) otherwise. The post-edit check and the gate both run it. */
const CHECK_JS = `
const text = require("node:fs").readFileSync("a.ts", "utf8");
if (!text.includes("salute")) { console.log("check: a.ts still says greet"); process.exit(1); }
console.log("check: ok");
`;

const A_TS = 'export function greet(name: string): string {\n  return "hi " + name;\n}\n';
const B_TS = 'import { greet } from "./a.js";\n\nexport const line = greet("world");\n';

const CHECKED = `feedback:\n  command: node check.cjs\ngate:\n  command: node check.cjs\n`;

/** The language server this repository installs, run by this Node — the scripted repo has no node_modules. */
function lspConfig(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("typescript-language-server/package.json");
  const cli = join(dirname(pkg), "lib", "cli.mjs");
  const server = { command: process.execPath, args: [cli, "--stdio"], extensions: [".ts"] };
  return `lsp:\n  servers:\n    typescript: ${JSON.stringify(server)}\n`;
}

function postEdit(run: { session(): Record<string, unknown> }): { runs: unknown; failures: unknown; passes: unknown } {
  const row = run.session();
  return { runs: row.post_edit_runs, failures: row.post_edit_failures, passes: row.post_edit_passes };
}

describe("T143: every file-changing tool counts", () => {
  it("a session that edits only with ast_edit triggers the post-edit loop, is counted as an edit, and is verified by the gate", async () => {
    const run = await runScriptedSession({
      files: { "a.ts": A_TS, "check.cjs": CHECK_JS },
      config: CHECKED,
      prompt: "Rename the greeting call shape.",
      script: [
        reply(mounted("ast_edit", { rules: [{ pattern: '"hi " + $N', replacement: '"salute " + $N' }], paths: ["a.ts"] })),
        reply(say("done")),
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);

    const row = run.session();
    // The loop ran after the ast_edit, and the check passed.
    assert.deepEqual(postEdit(run), { runs: 1, failures: 0, passes: 1 });
    // The counters: a.ts is an edited file.
    assert.match(String(row.edited_files), /"path":"a\.ts"/);
    // The gate graded the session from its command.
    assert.equal(row.verification_cmd, "node check.cjs");
    assert.equal(row.outcome, "success");
    assert.equal(row.outcome_source, "verification_command");

    const shown = run.show();
    assert.match(shown, /tool_result\s+tool_call\s+state=ok/);
    assert.match(shown, /"name":"ast_edit"/);
  });

  it("an lsp rename through tool_call triggers the post-edit loop, whose failure is recorded, and is graded by the gate", async () => {
    // The check wants `salute`; the rename produces `welcome`, so both the loop and the gate fail.
    const run = await runScriptedSession({
      files: {
        "a.ts": A_TS,
        "b.ts": B_TS,
        "check.cjs": CHECK_JS,
        "tsconfig.json": JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true } }),
        "package.json": JSON.stringify({ name: "lykos-t143-fixture", type: "module" }),
      },
      config: CHECKED + lspConfig(),
      prompt: "Rename greet to welcome everywhere.",
      script: [
        reply(mounted("lsp", { action: "rename", file: "a.ts", line: 1, symbol: "greet", new_name: "welcome" })),
        reply(say("renamed")),
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);

    assert.deepEqual(postEdit(run), { runs: 1, failures: 1, passes: 0 });
    const row = run.session();
    assert.match(String(row.edited_files), /"path":"a\.ts"/);
    // Edited, so graded — and the check fails on `welcome`.
    assert.equal(row.verification_cmd, "node check.cjs");
    assert.equal(row.outcome, "fail");

    const shown = run.show();
    assert.match(shown, /"name":"lsp"/);
  });

  it("an lsp read action is not an edit: no post-edit run, and the gate does not grade the session", async () => {
    const run = await runScriptedSession({
      files: { "a.ts": A_TS, "check.cjs": CHECK_JS, "tsconfig.json": "{}" },
      config: CHECKED + lspConfig(),
      script: [reply(mounted("lsp", { action: "symbols", file: "a.ts" })), reply(say("looked"))],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    const row = run.session();
    assert.equal(row.post_edit_runs ?? 0, 0);
    assert.equal(row.edited_file_count, 0);
    assert.equal(row.verification_cmd, null);
  });

  it("a skill tool call is counted as skill use", async () => {
    const run = await runScriptedSession({
      files: {
        ".lykos/skills/release-checklist/SKILL.md":
          "---\nname: release-checklist\ndescription: What to check before a release.\n---\n\n1. Run the tests.\n",
      },
      script: [
        reply(mounted("skill", { name: "Release-Checklist" })),
        reply(mounted("skill", { name: "no-such-skill" })),
        reply(say("followed it")),
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    const row = run.session();
    assert.equal(row.skills_available, 1);
    assert.deepEqual(JSON.parse(String(row.skills_invoked)), ["release-checklist"]);
    assert.equal(row.skill_reads, 1, "the refused call loaded nothing and is not a use");
  });
});
