// T156: a Lykos extension tool that changes files counts as an edit — the
// post-edit loop runs after it, the gate grades the session, the counters
// count it — whether it declared `changesFiles` or not. Read from the ledger.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AutoApproveGate } from "../gate/approval.js";
import { LykosExtensionHost } from "../extensions/api.js";
import { isFileChangingCall, TOOL_CALL_TOOL_NAME } from "../tools/tool-call.js";
import { setStderrSink } from "../tui/io-mode.js";
import { call, mounted, reply, runScriptedSession, say, scriptedPiHost } from "./scripted-session.js";

// Written only against `LykosExtensionApi`, with Node's own fs — what any author has.
const EXTENSION = `
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
export default {
  register(api) {
    api.registerTool({
      name: "ext_write",
      description: "Write a file (declared).",
      changesFiles: true,
      execute: (args) => { writeFileSync(join(process.cwd(), String(args.path)), String(args.content)); return { text: "wrote" }; },
    });
    api.registerTool({
      name: "ext_touch",
      description: "Write a file (undeclared).",
      execute: (args) => { writeFileSync(join(process.cwd(), String(args.path)), String(args.content)); return { text: "touched" }; },
    });
    api.registerTool({
      name: "ext_peek",
      description: "Read a file (undeclared).",
      execute: (args) => ({ text: readFileSync(join(process.cwd(), String(args.path)), "utf8") }),
    });
  },
};
`;

function install(): void {
  const dir = join(scriptedPiHost(), "npm", "node_modules", "demo-edit-ext");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo-edit-ext", version: "1.0.0", type: "module" }));
  writeFileSync(join(dir, "index.js"), EXTENSION);
}

const CONFIG = [
  "lykos_extensions:",
  "  - { name: demo-edit-ext, version: 1.0.0 }",
  "feedback:",
  "  command: node -e \"process.exit(0)\"",
  "gate:",
  "  command: node -e \"process.exit(0)\"",
  "",
].join("\n");

/** The workspace the session runs in, from its own head block: the extension writes relative to process.cwd(). */
function enterWorkspace(systemPrompt: string | undefined): void {
  process.chdir(String(/^cwd: (.*)$/m.exec(systemPrompt ?? "")?.[1]));
}

describe("T156: Lykos extension tools that change files count as edits", () => {
  const originalCwd = process.cwd();

  for (const [tool, label] of [
    ["ext_write", "a declared file-changing extension tool"],
    ["ext_touch", "an undeclared extension tool that writes a file"],
  ] as const) {
    it(`${label} triggers the post-edit loop, is counted as an edit, and is verified by the gate`, async () => {
      install();
      let run;
      try {
        run = await runScriptedSession({
          files: { "a.txt": "one\n" },
          config: CONFIG,
          script: [
            (context) => {
              enterWorkspace(context.systemPrompt);
              // Turn 0 only reads, so turn 1 starts on a tree the last
              // checkpoint already holds and gets one only before an edit.
              return reply(call("read", { path: "a.txt" }));
            },
            reply(mounted(tool, { path: "a.txt", content: "two\n" })),
            reply(say("done")),
          ],
        });
      } finally {
        process.chdir(originalCwd);
      }
      assert.equal(run.result.status, "ok", JSON.stringify(run.result));
      assert.equal(run.unusedSteps, 0);
      assert.equal(run.file("a.txt"), "two\n", "the tool really wrote");
      const row = run.session();
      assert.equal(row.post_edit_runs, 1, "the post-edit loop ran after it");
      assert.equal(row.verification_cmd, 'node -e "process.exit(0)"', "the gate graded the session");
      assert.equal(row.outcome, "success");
      assert.match(String(row.edited_files), /"path":"a\.txt"/, "the counters count it");
      // The turn that changed a.txt has the checkpoint taken before it, declared or not.
      const shown = run.show();
      assert.match(shown, /edits\s+1 turn\(s\) changed files; every one has a checkpoint/);
      assert.match(shown, /turn 1 {2}\S+ {2}checkpoint [0-9a-f]{8}/);
    });
  }

  it("an undeclared extension tool that writes nothing is not counted", async () => {
    let run;
    try {
      install();
      run = await runScriptedSession({
        files: { "a.txt": "one\n" },
        config: CONFIG,
        script: [
          (context) => {
            enterWorkspace(context.systemPrompt);
            return reply(mounted("ext_peek", { path: "a.txt" }));
          },
          reply(say("done")),
        ],
      });
    } finally {
      process.chdir(originalCwd);
    }
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    const row = run.session();
    assert.equal(row.post_edit_runs ?? 0, 0);
    assert.equal(row.verification_cmd, null, "not an edited session, so the gate did not grade it");
    assert.equal(row.edited_file_count, 0);
  });

  it("outside a git repository an undeclared tool is not counted, and the notice appears once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t156-nogit-"));
    let stderr = "";
    const restore = setStderrSink((text) => {
      stderr += text;
    });
    try {
      const host = new LykosExtensionHost({ cwd: dir, gate: new AutoApproveGate() });
      host.install({
        name: "demo",
        register: (api) =>
          api.registerTool({
            name: "ext_nogit",
            description: "Writes a file.",
            execute: () => {
              writeFileSync(join(dir, "x.txt"), String(Math.random()));
              return { text: "ok" };
            },
          }),
      });
      const def = host.toolDefinitions()[0] as unknown as {
        execute: (id: string, params: unknown) => Promise<{ details?: unknown }>;
      };
      for (let i = 0; i < 2; i++) {
        const result = await def.execute(`call-${i}`, {});
        assert.equal(isFileChangingCall(TOOL_CALL_TOOL_NAME, { name: "ext_nogit", arguments: {} }, result), false);
      }
      assert.equal(stderr.match(/does not declare changesFiles/g)?.length, 1, stderr);
      assert.match(stderr, /is not a git repository, so a file it changes cannot be detected/);
    } finally {
      restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("one session's declaration never reaches another in the same process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t156-two-hosts-"));
    try {
      // Session A declares a writing tool `ext_same`.
      const a = new LykosExtensionHost({ cwd: dir, gate: new AutoApproveGate() });
      a.install({
        name: "a",
        register: (api) => api.registerTool({ name: "ext_same", description: "", changesFiles: true, execute: () => ({ text: "ok" }) }),
      });
      // Session B, in the same process, has a read-only tool of the same name.
      const b = new LykosExtensionHost({ cwd: dir, gate: new AutoApproveGate() });
      b.install({
        name: "b",
        register: (api) => api.registerTool({ name: "ext_same", description: "", execute: () => ({ text: "read" }) }),
      });
      const run = (host: LykosExtensionHost) =>
        (host.toolDefinitions()[0] as unknown as { execute: (id: string, p: unknown) => Promise<unknown> }).execute("c", {});
      const args = { name: "ext_same", arguments: {} };
      assert.equal(isFileChangingCall(TOOL_CALL_TOOL_NAME, args, await run(a)), true, "A's call is an edit");
      assert.equal(isFileChangingCall(TOOL_CALL_TOOL_NAME, args, await run(b)), false, "B's is not");
      assert.equal(isFileChangingCall(TOOL_CALL_TOOL_NAME, args), false, "and the name alone decides nothing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
