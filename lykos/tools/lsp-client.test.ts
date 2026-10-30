// The LSP client.
//
// **Every test that starts a server kills it in a `finally`, and points it at
// a temporary directory.** A leaked language server is a process the user has
// to find and kill by hand, and a server pointed at this repository would
// index thousands of files to answer a question about four lines.
//
// The position tests are the ones worth reading twice. D3's whole claim is
// that a line and a substring are a better interface than a column, and that
// claim is only true if the substring resolves to the number the protocol
// means — UTF-16 code units, not code points, not bytes.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_LSP_SERVERS,
  LspClient,
  LspPositionError,
  LspServerPool,
  LspTimeoutError,
  applyLspTextEdits,
  documentLines,
  displayPosition,
  languageIdForPath,
  offsetOf,
  parseSymbolSelector,
  pathForUri,
  positionFor,
  resolveServerCommand,
  resolveSymbolColumn,
  serverKeyForPath,
  uriFor,
} from "./lsp-client.js";
import { processGone, shutdownAndAssertGone, removeWorkspace } from "./lsp-test-workspace.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * A workspace with two files, so `references` and `rename` have somewhere to
 * cross.
 *
 * The `package.json` is not decoration: under `moduleResolution: NodeNext` a
 * directory with no `"type": "module"` resolves `./a.js` differently, and
 * without it `textDocument/definition` on the import answers with the import
 * statement itself rather than with the declaration in the other file — which
 * is a passing-looking test that proves nothing about cross-file navigation.
 */
function writeWorkspace(dir: string): { a: string; b: string } {
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      { compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true } },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "lykos-lsp-fixture", type: "module" }), "utf8");
  const a = join(dir, "a.ts");
  const b = join(dir, "b.ts");
  writeFileSync(a, "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n", "utf8");
  writeFileSync(b, 'import { greet } from "./a.js";\n\nexport const line = greet("world");\n', "utf8");
  return { a, b };
}

describe("P10.4 D3: a position is a line and a symbol, never a column", () => {
  it("resolves the column from a substring on a 1-indexed line", () => {
    const text = "const alpha = 1;\nconst beta = alpha + 1;\n";
    assert.deepEqual(positionFor(text, 2, "alpha"), { line: 1, character: 13 });
    assert.deepEqual(displayPosition({ line: 1, character: 13 }), { line: 2, column: 14 });
  });

  it("supports the name#N occurrence selector for a line naming the same identifier twice", () => {
    const text = "const x = foo(foo(1));\n";
    assert.deepEqual(parseSymbolSelector("foo#2"), { name: "foo", occurrence: 2 });
    assert.deepEqual(parseSymbolSelector("foo"), { name: "foo", occurrence: 1 });
    assert.equal(resolveSymbolColumn("const x = foo(foo(1));", "foo"), 10);
    assert.equal(resolveSymbolColumn("const x = foo(foo(1));", "foo#2"), 14);
    assert.equal(resolveSymbolColumn("const x = foo(foo(1));", "foo#3"), undefined);
    assert.deepEqual(positionFor(text, 1, "foo#2"), { line: 0, character: 14 });
  });

  // The test D3 asks for by name. `𝔽` is ONE code point and TWO UTF-16 code
  // units; the protocol counts code units, and `indexOf` does too. A resolver
  // that iterated code points (`[...line]`, `Array.from`) would answer 15 here
  // and splice the rename one character short on every file containing an
  // emoji, a mathematical letter, or any other astral character.
  it("counts UTF-16 code units, so an astral character above the symbol moves the column by two", () => {
    const astral = 'const s = "𝔽"; const target = 1;\n';
    assert.deepEqual(positionFor(astral, 1, "target"), { line: 0, character: 22 });
    // The same prefix is 21 CODE POINTS long. The protocol wants 22, and the
    // one-character difference is the whole bug this test exists to catch.
    assert.equal([...astral.slice(0, 22)].length, 21);
    // A non-ASCII character that IS one code unit moves it by one, and that
    // is the case a naive implementation accidentally gets right.
    const latin1 = 'const s = "é"; const target = 1;\n';
    assert.deepEqual(positionFor(latin1, 1, "target"), { line: 0, character: 21 });
    assert.equal([...latin1.slice(0, 21)].length, 21);
  });

  it("falls back to the first non-whitespace column when no symbol is given", () => {
    assert.deepEqual(positionFor("  const x = 1;\n", 1, undefined), { line: 0, character: 2 });
    assert.deepEqual(positionFor("  const x = 1;\n", 1, ""), { line: 0, character: 2 });
  });

  it("says which line and which symbol when it cannot resolve one", () => {
    const text = "const a = 1;\n";
    assert.throws(() => positionFor(text, 9, "a"), (err: unknown) => {
      assert.ok(err instanceof LspPositionError);
      assert.match(err.message, /line 9 is outside this file, which has 2 lines/);
      return true;
    });
    assert.throws(() => positionFor(text, 1, "zzz#2"), (err: unknown) => {
      assert.ok(err instanceof LspPositionError);
      assert.match(err.message, /"zzz" \(occurrence 2\) is not on line 1/);
      return true;
    });
  });

  it("matches case-insensitively when the exact spelling is not there", () => {
    assert.equal(resolveSymbolColumn("const Foo = 1;", "foo"), 6);
  });

  it("splits CRLF, CR and LF the same way the protocol does", () => {
    assert.deepEqual(documentLines("a\r\nb\rc\nd"), ["a", "b", "c", "d"]);
    assert.deepEqual(positionFor("a\r\nconst z = 1;\r\n", 2, "z"), { line: 1, character: 6 });
    // Offsets walk the same terminators, so a CRLF file resolves to the byte
    // the symbol is actually at rather than one short per line above it.
    assert.equal(offsetOf("a\r\nconst z = 1;\r\n", { line: 1, character: 6 }), 9);
  });
});

describe("P10.4: applying a server's text edits", () => {
  it("applies every edit against the original document, not against the shifted one", () => {
    const text = "const a = 1;\nconst b = a + a;\n";
    // Two edits on one line and one on another, given in ascending order —
    // applying them forwards would shift the second and third.
    const out = applyLspTextEdits(text, [
      { range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } }, newText: "alpha" },
      { range: { start: { line: 1, character: 10 }, end: { line: 1, character: 11 } }, newText: "alpha" },
      { range: { start: { line: 1, character: 14 }, end: { line: 1, character: 15 } }, newText: "alpha" },
    ]);
    assert.equal(out, "const alpha = 1;\nconst b = alpha + alpha;\n");
  });

  it("keeps CRLF line endings, because a rename is not also a whitespace commit", () => {
    const text = "const a = 1;\r\nconst b = a;\r\n";
    const out = applyLspTextEdits(text, [
      { range: { start: { line: 1, character: 10 }, end: { line: 1, character: 11 } }, newText: "zz" },
    ]);
    assert.equal(out, "const a = 1;\r\nconst b = zz;\r\n");
  });
});

describe("P10.4 D4: which server owns a file", () => {
  it("routes by extension and says nothing owns an unknown one", () => {
    assert.equal(serverKeyForPath(DEFAULT_LSP_SERVERS, "/x/a.ts"), "typescript");
    assert.equal(serverKeyForPath(DEFAULT_LSP_SERVERS, "/x/a.MTS"), "typescript");
    assert.equal(serverKeyForPath(DEFAULT_LSP_SERVERS, "/x/a.rs"), undefined);
  });

  it("gives .tsx its own languageId, so JSX is parsed as JSX", () => {
    assert.equal(languageIdForPath("/x/a.ts"), "typescript");
    assert.equal(languageIdForPath("/x/a.tsx"), "typescriptreact");
    assert.equal(languageIdForPath("/x/a.jsx"), "javascriptreact");
    assert.equal(languageIdForPath("/x/a.mjs"), "javascript");
  });
});

describe("P10.4 D2: resolving the executable", () => {
  // D2's Windows fact, asserted rather than recalled: the `.cmd` shim in
  // `node_modules/.bin` cannot be spawned, so what is spawned is this
  // process's own Node plus the package's declared `bin` entry.
  it("finds the server in the repository's node_modules and spawns it through Node", () => {
    const resolved = resolveServerCommand(process.cwd(), DEFAULT_LSP_SERVERS.typescript!);
    assert.ok(resolved, "typescript-language-server is a dev dependency of this repository");
    assert.equal(resolved.source, "node_modules");
    assert.equal(resolved.exec, process.execPath);
    assert.match(resolved.found.replace(/\\/g, "/"), /typescript-language-server\/lib\/cli\.mjs$/);
    assert.equal(resolved.args[resolved.args.length - 1], "--stdio");
    assert.equal(resolved.shell, false);
  });

  // The same file reached by the other route. `npm`/`npx` put a repository's
  // own `node_modules/.bin` on PATH for the duration of a script, so a
  // session whose cwd is somewhere else entirely still finds the shim there —
  // and on Windows that shim is the `.cmd` that cannot be spawned.
  it("takes the Node hop for a node_modules/.bin shim found on PATH, not a shell", () => {
    const binDir = join(process.cwd(), "node_modules", ".bin");
    const resolved = resolveServerCommand(tmpdir(), DEFAULT_LSP_SERVERS.typescript!, { PATH: binDir });
    assert.ok(resolved);
    assert.equal(resolved.source, "path");
    assert.equal(resolved.exec, process.execPath);
    assert.equal(resolved.shell, false, "spawning a .cmd through a shell is the branch this avoids");
    assert.match(resolved.found.replace(/\\/g, "/"), /typescript-language-server\/lib\/cli\.mjs$/);
  });

  it("returns undefined for a command that is nowhere, rather than throwing", () => {
    const resolved = resolveServerCommand(process.cwd(), {
      command: "lykos-no-such-language-server",
      extensions: [".zz"],
    });
    assert.equal(resolved, undefined);
  });
});

describe("P10.4 D5/D8: a real server starts, answers, and is killed", () => {
  it("initializes, opens a document, answers a position request, and leaves no process behind", async () => {
    const dir = tmp("lykos-p104-lspclient-real-");
    const { a, b } = writeWorkspace(dir);
    const pool = new LspServerPool({ cwd: dir });
    let pid: number | undefined;
    try {
      const got = await pool.clientFor(a);
      assert.equal(got.ok, true);
      if (!got.ok) return;
      pid = got.client.pid;
      assert.ok(pid !== undefined && pid > 0);

      // D8: the server is told about the file before it is asked about it. A
      // request against a document it has never seen comes back empty, which
      // reads as "no definition" and is a lie.
      const text = 'import { greet } from "./a.js";\n\nexport const line = greet("world");\n';
      got.client.ensureOpen(a, "export function greet(name: string): string {\n  return `hi ${name}`;\n}\n");
      const uri = got.client.ensureOpen(b, text);
      assert.equal(uri, uriFor(b));
      assert.equal(got.client.isOpen(b), true);
      // Opening twice sends one didOpen; the set is what makes that true.
      got.client.ensureOpen(b, text);

      const position = positionFor(text, 3, "greet");
      const definition = await got.client.request<unknown>("textDocument/definition", {
        textDocument: { uri },
        position,
      });
      const locations = Array.isArray(definition) ? definition : [definition];
      assert.equal(locations.length, 1);
      const first = locations[0] as { uri?: string; targetUri?: string };
      // Compared as PATHS, never as URI strings. Node spells a Windows drive
      // `file:///C:/…` and tsserver spells the same file `file:///c%3a/…`;
      // both decode to one path, and every comparison in this tool therefore
      // goes through `pathForUri` rather than through string equality.
      assert.equal(
        pathForUri(first.uri ?? first.targetUri ?? "").toLowerCase(),
        a.toLowerCase(),
      );
    } finally {
      // Proves the process is gone by asking the OS, not the shutdown path's own account of itself.
      await shutdownAndAssertGone(pool, dir);
    }
  });

  it("status names every configured server and whether it is running", async () => {
    const dir = tmp("lykos-p104-lspclient-status-");
    const pool = new LspServerPool({ cwd: dir });
    try {
      const before = pool.status();
      assert.equal(before.length, 1);
      assert.equal(before[0]!.key, "typescript");
      assert.equal(before[0]!.running, false);
      assert.equal(before[0]!.pid, undefined);
    } finally {
      await shutdownAndAssertGone(pool, dir);
    }
  });

  it("a language with no configured server is an answer, not a throw", async () => {
    const dir = tmp("lykos-p104-lspclient-unconfigured-");
    const pool = new LspServerPool({ cwd: dir });
    try {
      const got = await pool.clientFor(join(dir, "main.rs"));
      assert.equal(got.ok, false);
      if (got.ok) return;
      assert.match(got.reason, /No language server is configured for \.rs files/);
      assert.match(got.reason, /lsp\.servers/);
      assert.deepEqual(pool.pids(), [], "nothing was spawned");
    } finally {
      await shutdownAndAssertGone(pool, dir);
    }
  });

  it("a configured server whose executable is missing names the executable, and does not throw", async () => {
    const dir = tmp("lykos-p104-lspclient-missing-");
    const pool = new LspServerPool({
      cwd: dir,
      servers: { ghost: { command: "lykos-no-such-language-server", extensions: [".ts"] } },
    });
    try {
      const got = await pool.clientFor(join(dir, "a.ts"));
      assert.equal(got.ok, false);
      if (got.ok) return;
      assert.match(got.reason, /lykos-no-such-language-server/);
      assert.match(got.reason, /not on PATH/);
      // Asked twice, answered twice — and still nothing spawned.
      assert.equal((await pool.clientFor(join(dir, "a.ts"))).ok, false);
      assert.deepEqual(pool.pids(), []);
    } finally {
      await shutdownAndAssertGone(pool, dir);
    }
  });
});

describe("P10.4 D5: a server that never answers times out and is still killed", () => {
  it("rejects with a timeout rather than hanging the turn", async () => {
    const dir = tmp("lykos-p104-lspclient-hang-");
    // A process that reads stdin forever and never writes a frame. This is
    // the hung server the ticket has a checkbox for, and it is a stub rather
    // than a real server because a real one cannot be made to hang on demand.
    const client = new LspClient({
      cwd: dir,
      name: "stub",
      command: {
        exec: process.execPath,
        args: ["-e", "process.stdin.resume()"],
        shell: false,
        found: process.execPath,
        source: "path",
      },
      timeoutMs: 400,
    });
    let pid: number | undefined;
    try {
      await assert.rejects(
        () => client.start(),
        (err: unknown) => {
          assert.ok(err instanceof LspTimeoutError, `expected a timeout, got ${String(err)}`);
          assert.match(err.message, /did not answer initialize within/);
          assert.match(err.message, /still\s+running/);
          return true;
        },
      );
      pid = client.pid;
      assert.ok(pid !== undefined);
      // The timeout left it alive on purpose: one slow answer is not a reason
      // to throw away an index that took seconds to build.
      assert.equal(processGone(pid), false);
    } finally {
      try {
        await client.shutdown();
        assert.ok(pid !== undefined);
        // It ignores `shutdown` and `exit`, so the grace period expires and it is
        // killed. Every branch of shutdown ends with the process dead.
        assert.equal(processGone(pid), true, `stub server ${pid} survived shutdown`);
      } finally {
        removeWorkspace(dir);
      }
    }
  });
});

// T171 (P15, old issue 24; spec story 18): a server binary that lives
// inside the workspace is the workspace's code, not the machine's. Whoever can
// write the workspace (a contained command, a cloned repository) can put a
// program under `node_modules/<server>` and have the HOST execute it the first
// time `lsp` is used. So an untrusted workspace's own binary is refused, by
// name, and a trusted one starts.
describe("T171: a workspace-local language server needs a trusted workspace", () => {
  const STUB = readFileSync(join(import.meta.dirname, "lsp-stub-server.fixture.cjs"), "utf8");

  function workspaceWithLocalServer(): { dir: string; script: string } {
    const dir = tmp("lykos-t171-lsp-");
    const pkg = join(dir, "node_modules", "lykos-stub-ls");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "lykos-stub-ls", bin: { "lykos-stub-ls": "cli.js" } }));
    writeFileSync(join(pkg, "cli.js"), STUB);
    return { dir, script: join(pkg, "cli.js") };
  }
  const servers = { stub: { command: "lykos-stub-ls", extensions: [".zz"] } };

  it("an untrusted workspace's own server binary is refused, named, and never spawned", async () => {
    const { dir, script } = workspaceWithLocalServer();
    const pool = new LspServerPool({ cwd: dir, servers });
    try {
      const got = await pool.clientFor(join(dir, "a.zz"));
      assert.equal(got.ok, false);
      if (got.ok) return;
      assert.ok(got.reason.includes(script), `names the binary: ${got.reason}`);
      assert.match(got.reason, /not trusted/);
      assert.deepEqual(pool.pids(), [], "nothing was spawned");
    } finally {
      await shutdownAndAssertGone(pool, dir);
    }
  });

  it("a trusted workspace's own server binary starts", async () => {
    const { dir } = workspaceWithLocalServer();
    const pool = new LspServerPool({ cwd: dir, servers, workspaceTrusted: true });
    try {
      const got = await pool.clientFor(join(dir, "a.zz"));
      assert.equal(got.ok, true, got.ok ? "" : got.reason);
      assert.equal(pool.pids().length, 1);
    } finally {
      await shutdownAndAssertGone(pool, dir);
    }
  });

  it("a workspace file named by an --opt=path argument is refused when untrusted", async () => {
    const { dir } = workspaceWithLocalServer();
    const pool = new LspServerPool({ cwd: dir, servers: { stub: { command: process.execPath, args: ["--require=node_modules/lykos-stub-ls/cli.js"], extensions: [".zz"] } } });
    try {
      const got = await pool.clientFor(join(dir, "a.zz"));
      assert.equal(got.ok, false);
      if (!got.ok) assert.match(got.reason, /not trusted/);
      assert.deepEqual(pool.pids(), []);
    } finally {
      await shutdownAndAssertGone(pool, dir);
    }
  });

  it("a server outside the workspace starts whether or not the workspace is trusted", async () => {
    const dir = tmp("lykos-t171-lsp-outside-");
    const elsewhere = tmp("lykos-t171-lsp-elsewhere-");
    const script = join(elsewhere, "cli.js");
    writeFileSync(script, STUB);
    const pool = new LspServerPool({ cwd: dir, servers: { stub: { command: process.execPath, args: [script], extensions: [".zz"] } } });
    try {
      const got = await pool.clientFor(join(dir, "a.zz"));
      assert.equal(got.ok, true, got.ok ? "" : got.reason);
    } finally {
      await shutdownAndAssertGone(pool, dir, elsewhere);
    }
  });
});
