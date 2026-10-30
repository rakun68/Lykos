// The host file tools refuse a path that resolves outside the workspace,
// whatever path it was reached by, and `lsp` refuses to start a server binary
// that lives inside a workspace nobody trusted.
//
// A symlink is made in `setup`, after the repository is committed, because a
// file map cannot say "link". Where the platform will not make a file symlink
// (Windows without developer mode) the file-link scenarios skip with that
// reason; directory links use a junction there, which needs no privilege.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { call, lastToolResult, mounted, reply, runScriptedSession, say } from "./scripted-session.js";

const outside = realpathSync(mkdtempSync(join(tmpdir(), "lykos-outside-")));
writeFileSync(join(outside, "secret.txt"), "TOP-SECRET\n");
mkdirSync(join(outside, "dir"));
writeFileSync(join(outside, "dir", "inner.ts"), 'export const s = "hi " + 1;\n');

function canLinkFiles(): boolean {
  try {
    const probe = mkdtempSync(join(tmpdir(), "lykos-linkprobe-"));
    writeFileSync(join(probe, "t"), "x");
    symlinkSync(join(probe, "t"), join(probe, "l"), "file");
    return true;
  } catch {
    return false;
  }
}
const FILE_LINKS = canLinkFiles();
const skipFileLinks = FILE_LINKS ? false : "this platform cannot create file symlinks";

function linkFile(workspace: string): void {
  symlinkSync(join(outside, "secret.txt"), join(workspace, "link.txt"), "file");
}
function linkDir(workspace: string): void {
  symlinkSync(join(outside, "dir"), join(workspace, "linkdir"), process.platform === "win32" ? "junction" : "dir");
}

// T210: outside the workspace now ASKS, and an auto-approving session would answer yes, so
// these scenarios pin the outside folder with deny rules: a deny is never a question, and it
// holds on the resolved path of a link. The refusal names the rule.
const OUTSIDE_FORWARD = outside.split("\\").join("/");
const DENY_OUTSIDE = `path_rules:\n  read:\n    '${OUTSIDE_FORWARD}/**': deny\n  write:\n    '${OUTSIDE_FORWARD}/**': deny\n`;

/** The model's result text for each of the calls, in order, read from what it was sent next. */
function refused(text: string): void {
  assert.match(text, /denied: secret path/);
  assert.ok(text.includes(OUTSIDE_FORWARD), `the message names the rule that covers the resolved target: ${text}`);
}

describe("T171: host file tools refuse a path that resolves outside the workspace", () => {
  it("read, write, edit and grep refuse a symlink to a file outside, and the file is untouched", { skip: skipFileLinks }, async () => {
    const seen: string[] = [];
    const run = await runScriptedSession({
      files: { "ok.txt": "fine\n" },
      config: DENY_OUTSIDE,
      setup: linkFile,
      script: [
        reply(call("read", { path: "link.txt" })),
        (c) => (seen.push(lastToolResult(c).text), reply(call("write", { path: "link.txt", content: "pwned\n" }))),
        (c) => (seen.push(lastToolResult(c).text), reply(call("edit", { path: "link.txt", edits: [{ oldText: "TOP", newText: "BOT" }] }))),
        (c) => (seen.push(lastToolResult(c).text), reply(call("grep", { pattern: "SECRET", path: "link.txt" }))),
        (c) => (seen.push(lastToolResult(c).text), reply(mounted("find", { pattern: "*.txt", path: "link.txt" }))),
        (c) => (seen.push(lastToolResult(c).text), reply(mounted("ast_edit", { rules: [{ pattern: "x", replacement: "y" }], paths: ["link.txt"] }))),
        (c) => (seen.push(lastToolResult(c).text), reply(say("done"))),
      ],
    });
    assert.equal(seen.length, 6);
    for (const text of seen) refused(text);
    assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "TOP-SECRET\n");
    assert.ok(run.result);
  });

  it("refuses a path through a symlinked directory that points outside, for reading and for creating a file", async () => {
    const seen: string[] = [];
    await runScriptedSession({
      files: { "ok.txt": "fine\n" },
      config: DENY_OUTSIDE,
      setup: linkDir,
      script: [
        reply(call("read", { path: "linkdir/inner.ts" })),
        (c) => (seen.push(lastToolResult(c).text), reply(call("write", { path: "linkdir/new.ts", content: "x\n" }))),
        (c) => (seen.push(lastToolResult(c).text), reply(call("grep", { pattern: "hi", path: "linkdir" }))),
        (c) => (seen.push(lastToolResult(c).text), reply(mounted("ast_edit", { rules: [{ pattern: '"hi " + $N', replacement: '"yo " + $N' }], paths: ["linkdir/*.ts"] }))),
        (c) => (seen.push(lastToolResult(c).text), reply(call("edit", { path: "linkdir/inner.ts", edits: [{ oldText: "hi", newText: "yo" }] }))),
        (c) => (seen.push(lastToolResult(c).text), reply(mounted("find", { pattern: "*.ts", path: "linkdir" }))),
        (c) => (seen.push(lastToolResult(c).text), reply(say("done"))),
      ],
    });
    assert.equal(seen.length, 6);
    for (const text of seen) refused(text);
    assert.equal(readFileSync(join(outside, "dir", "inner.ts"), "utf8"), 'export const s = "hi " + 1;\n');
    assert.throws(() => readFileSync(join(outside, "dir", "new.ts")));
  });

  it("still works on paths inside the workspace, including a symlink that stays inside", { skip: skipFileLinks }, async () => {
    const seen: string[] = [];
    const run = await runScriptedSession({
      files: { "real.txt": "inside\n" },
      setup: (ws) => symlinkSync(join(ws, "real.txt"), join(ws, "alias.txt"), "file"),
      script: [
        reply(call("read", { path: "alias.txt" })),
        (c) => (seen.push(lastToolResult(c).text), reply(call("write", { path: "fresh/new.txt", content: "n\n" }))),
        (c) => (seen.push(lastToolResult(c).text), reply(say("done"))),
      ],
    });
    assert.match(seen[0]!, /inside/);
    assert.equal(run.file("fresh/new.txt"), "n\n");
  });
});

describe("T171: a link that stays inside the workspace", () => {
  it("is followed: read and write through a directory link to another workspace directory succeed", async () => {
    const seen: string[] = [];
    const run = await runScriptedSession({
      files: { "real/a.txt": "inside\n" },
      setup: (ws) => symlinkSync(join(ws, "real"), join(ws, "alias"), process.platform === "win32" ? "junction" : "dir"),
      script: [
        reply(call("read", { path: "alias/a.txt" })),
        (c) => (seen.push(lastToolResult(c).text), reply(call("write", { path: "alias/b.txt", content: "n\n" }))),
        (c) => (seen.push(lastToolResult(c).text), reply(say("done"))),
      ],
    });
    assert.match(seen[0]!, /inside/);
    assert.match(seen[1]!, /Successfully wrote/);
    assert.equal(run.file("real/b.txt"), "n\n");
  });
});

const STUB = readFileSync(join(import.meta.dirname, "..", "tools", "lsp-stub-server.fixture.cjs"), "utf8");

describe("T171: lsp and a server binary inside the workspace", () => {
  /** A stub LSP server that ships inside the workspace, as a cloned repository's `node_modules` would. */
  function plantServer(ws: string): void {
    const pkg = join(ws, "node_modules", "lykos-stub-ls");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "lykos-stub-ls", bin: { "lykos-stub-ls": "cli.js" } }));
    writeFileSync(join(pkg, "cli.js"), `require("node:fs").writeFileSync(require("node:path").join(__dirname, "RAN"), "yes");
${STUB}`);
  }
  const CONFIG = "lsp:\n  servers:\n    stub:\n      command: lykos-stub-ls\n      extensions: ['.zz']\n";

  it("a server run through an outside interpreter but pointed at a workspace script is refused untrusted, started trusted; a flag-only trust does not trust", async () => {
    const seen: string[] = [];
    const cfg = `lsp:
  servers:
    stub:
      command: ${JSON.stringify(process.execPath)}
      args: ["tools/stub.cjs"]
      extensions: [".zz"]
`;
    const plant = (ws: string): void => {
      mkdirSync(join(ws, "tools"), { recursive: true });
      writeFileSync(join(ws, "tools", "stub.cjs"), `require("node:fs").writeFileSync(require("node:path").join(__dirname, "RAN"), "yes");
${STUB}`);
    };
    const run = (extra: Record<string, unknown>) =>
      runScriptedSession({
        files: { "a.zz": "x\n" },
        config: cfg,
        setup: plant,
        extra,
        script: [reply(mounted("lsp", { action: "symbols", file: "a.zz", timeout: 1 })), (c) => (seen.push(lastToolResult(c).text), reply(say("done")))],
      });
    const none = await run({});
    const flagged = await run({ trustSource: "flag" });
    const stored = await run({ trustSource: "stored" });
    assert.match(seen[0]!, /stub.cjs/);
    assert.match(seen[0]!, /not trusted/);
    assert.match(seen[1]!, /not trusted/, "flag alone does not trust");
    assert.equal(none.file("tools/RAN"), undefined);
    assert.equal(flagged.file("tools/RAN"), undefined);
    assert.doesNotMatch(seen[2]!, /not trusted/);
    assert.equal(stored.file("tools/RAN"), "yes");
  });

  it("an untrusted workspace's server is refused by name and never runs; a trusted workspace's server is started", async () => {
    const seen: string[] = [];
    const untrusted = await runScriptedSession({
      files: { "a.zz": "x\n" },
      config: CONFIG,
      setup: plantServer,
      script: [reply(mounted("lsp", { action: "symbols", file: "a.zz" })), (c) => (seen.push(lastToolResult(c).text), reply(say("done")))],
    });
    assert.match(seen[0]!, /lykos-stub-ls/);
    assert.match(seen[0]!, /not trusted/);
    assert.equal(untrusted.file("node_modules/lykos-stub-ls/RAN"), undefined, "the host never ran the workspace's binary");

    const trusted = await runScriptedSession({
      files: { "a.zz": "x\n" },
      config: CONFIG,
      setup: plantServer,
      extra: { trustSource: "stored" },
      script: [reply(mounted("lsp", { action: "symbols", file: "a.zz", timeout: 1 })), (c) => (seen.push(lastToolResult(c).text), reply(say("done")))],
    });
    assert.doesNotMatch(seen[1]!, /not trusted/);
    assert.equal(trusted.file("node_modules/lykos-stub-ls/RAN"), "yes", "a trusted workspace's server was started");
  });
});
