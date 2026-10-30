// T27.1/T27.2 (docs/10-phase2-tasks.md, docs/14-performance.md row 5): the
// MCP SDK and `yaml` are the two measured-expensive imports on the CLI's
// startup path (881ms and ~266ms respectively). `cli.ts` dynamically
// imports every command's implementation so nothing statically pulls in a
// command it isn't running -- this scans the actual source tree to prove
// that invariant holds rather than trusting the comment at the top of
// cli.ts to stay true as the codebase changes.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const lykosDir = join(fileURLToPath(import.meta.url), "..", "..");

function allSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts")) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    // entry.parentPath is set when `recursive: true` is used (Node 20.12+).
    const parent = (entry as unknown as { parentPath?: string; path?: string }).parentPath ??
      (entry as unknown as { path?: string }).path ??
      dir;
    out.push(join(parent, entry.name));
  }
  return out;
}

/** A static, module-scope `import ... from "<pkg>"` line — not `await import(...)`. */
function hasStaticImportOf(source: string, pkg: string): boolean {
  const re = new RegExp(`^\\s*import\\s[^;]*from\\s+["']${pkg.replace(/[/.]/g, "\\$&")}`, "m");
  return re.test(source);
}

describe("CLI hot path — module-scope imports of expensive packages", () => {
  const files = allSourceFiles(lykosDir);
  assert.ok(files.length > 20, "sanity check: the source scan found suspiciously few files");

  it("T27.1: only the mcp-command subtree imports @modelcontextprotocol/sdk at module scope", () => {
    // Files whose whole job is talking to the MCP SDK: cli/mcp.ts (the
    // dynamically-imported command implementation), delegate/mcp-server.ts
    // (what it wraps).
    const allowed = new Set(
      ["cli/mcp.ts", "delegate/mcp-server.ts"].map((p) => join(lykosDir, p)),
    );
    const offenders: string[] = [];
    for (const file of files) {
      if (allowed.has(file)) continue;
      const source = readFileSync(file, "utf8");
      if (hasStaticImportOf(source, "@modelcontextprotocol/sdk")) {
        offenders.push(relative(lykosDir, file));
      }
    }
    assert.deepEqual(offenders, [], "unexpected static @modelcontextprotocol/sdk import(s)");
  });

  it("cli.ts imports every command implementation dynamically, never statically", () => {
    const source = readFileSync(join(lykosDir, "cli.ts"), "utf8");
    for (const cmd of ["init", "doctor", "cost", "run", "mcp", "prompt", "show", "budget", "memory", "agents", "hud"]) {
      const re = new RegExp(`^\\s*import\\s[^;]*from\\s+["']\\./cli/${cmd}\\.js["']`, "m");
      assert.equal(re.test(source), false, `cli.ts must not statically import ./cli/${cmd}.js`);
    }
  });

  it("T27.2: config/load.ts has no static top-level import of yaml", () => {
    const source = readFileSync(join(lykosDir, "config", "load.ts"), "utf8");
    assert.equal(hasStaticImportOf(source, "yaml"), false);
    // Specialists ticket 01 split the actual parsing out into
    // config/yaml-file.ts, shared with config/specialists.ts's sixth layer so
    // it does not duplicate the lazy-require wiring or re-pay the import
    // cost. The lazy path this test protects — a require() reached only
    // from inside a function, never at module scope — now lives there.
    const yamlFileSource = readFileSync(join(lykosDir, "config", "yaml-file.ts"), "utf8");
    assert.equal(hasStaticImportOf(yamlFileSource, "yaml"), false);
    assert.match(yamlFileSource, /createRequire/);
  });
});
