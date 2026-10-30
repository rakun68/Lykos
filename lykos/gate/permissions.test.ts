import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPermissions, rememberAllow, rememberMode, forgetAllow, clearAllow, rememberExtraDir, rememberOutside } from "./permissions.js";

function tempStore(): string {
  return join(mkdtempSync(join(tmpdir(), "lykos-perm-")), "permissions.json");
}

describe("loadPermissions", () => {
  it("is empty for a project nobody has approved anything in", () => {
    const p = loadPermissions("proj-a", { permissionsPath: tempStore() });
    assert.equal(p.allow.size, 0);
    assert.equal(p.mode, undefined);
  });

  it("survives a corrupt store rather than throwing", () => {
    const path = tempStore();
    writeFileSync(path, "{ not json", "utf8");
    const p = loadPermissions("proj-a", { permissionsPath: path });
    assert.equal(p.allow.size, 0);
  });
});

describe("rememberAllow", () => {
  it("round-trips through the file", () => {
    const path = tempStore();
    rememberAllow("proj-a", ["npm test"], { permissionsPath: path });
    assert.deepEqual([...loadPermissions("proj-a", { permissionsPath: path }).allow], ["npm test"]);
  });

  it("accumulates without duplicating", () => {
    const path = tempStore();
    rememberAllow("proj-a", ["npm test"], { permissionsPath: path });
    rememberAllow("proj-a", ["npm test", "tsc"], { permissionsPath: path });
    assert.deepEqual([...loadPermissions("proj-a", { permissionsPath: path }).allow].sort(), ["npm test", "tsc"]);
  });

  it("keeps projects apart — approving here never approves there", () => {
    const path = tempStore();
    rememberAllow("proj-a", ["npm test"], { permissionsPath: path });
    assert.equal(loadPermissions("proj-b", { permissionsPath: path }).allow.size, 0);
  });

  it("writes nothing for an empty pattern list", () => {
    const path = tempStore();
    rememberAllow("proj-a", [], { permissionsPath: path });
    assert.equal(loadPermissions("proj-a", { permissionsPath: path }).allow.size, 0);
  });
});

describe("forgetAllow", () => {
  it("removes one pattern and leaves the rest", () => {
    const path = tempStore();
    rememberAllow("proj-a", ["npm test", "tsc"], { permissionsPath: path });
    forgetAllow("proj-a", "npm test", { permissionsPath: path });
    assert.deepEqual([...loadPermissions("proj-a", { permissionsPath: path }).allow], ["tsc"]);
  });

  it("clearAllow removes all patterns for the project", () => {
    const path = tempStore();
    rememberAllow("proj-a", ["npm test", "tsc"], { permissionsPath: path });
    clearAllow("proj-a", { permissionsPath: path });
    assert.deepEqual([...loadPermissions("proj-a", { permissionsPath: path }).allow], []);
  });
});

describe("rememberMode", () => {
  it("round-trips, and does not disturb the allowlist", () => {
    const path = tempStore();
    rememberAllow("proj-a", ["npm test"], { permissionsPath: path });
    rememberMode("proj-a", "auto", { permissionsPath: path });
    const p = loadPermissions("proj-a", { permissionsPath: path });
    assert.equal(p.mode, "auto");
    assert.deepEqual([...p.allow], ["npm test"]);
  });

  it("ignores a stored mode that is no longer a real mode", () => {
    // The vocabulary changed once already: a store written before the rename
    // could hold "auto-edit", which must not resolve to anything.
    const path = tempStore();
    writeFileSync(
      path,
      JSON.stringify({ version: 1, projects: { "proj-a": { allow: ["tsc"], mode: "auto-edit" } } }),
      "utf8",
    );
    const p = loadPermissions("proj-a", { permissionsPath: path });
    assert.equal(p.mode, undefined, "an unrecognised mode is dropped, never mapped");
    assert.deepEqual([...p.allow], ["tsc"], "the allowlist beside it still loads");
  });

  it("T208: stored plan or ask is rejected on stderr and ignored, naming read_only replacement", () => {
    for (const old of ["plan", "ask"]) {
      const path = tempStore();
      writeFileSync(
        path,
        JSON.stringify({ version: 1, projects: { "proj-a": { allow: ["tsc"], mode: old } } }),
        "utf8",
      );
      let stderr = "";
      const origWrite = process.stderr.write;
      process.stderr.write = ((chunk: unknown) => {
        stderr += String(chunk);
        return true;
      }) as typeof process.stderr.write;
      try {
        const p = loadPermissions("proj-a", { permissionsPath: path });
        assert.equal(p.mode, undefined);
        assert.match(stderr, /read_only/);
      } finally {
        process.stderr.write = origWrite;
      }
    }
  });
});

describe("rememberExtraDir", () => {
  it("accumulates extra dirs without duplicates", () => {
    const path = tempStore();
    rememberExtraDir("proj-a", "/data/shared", { permissionsPath: path });
    rememberExtraDir("proj-a", "/data/shared", { permissionsPath: path });
    rememberExtraDir("proj-a", "/data/other", { permissionsPath: path });
    const p = loadPermissions("proj-a", { permissionsPath: path });
    assert.deepEqual(p.extraDirs, ["/data/other", "/data/shared"]);
  });
});

describe("rememberOutside", () => {
  it("records outside read and write decisions", () => {
    const path = tempStore();
    rememberOutside("proj-a", "read", "allow", { permissionsPath: path });
    rememberOutside("proj-a", "write", "deny", { permissionsPath: path });
    const p = loadPermissions("proj-a", { permissionsPath: path });
    assert.deepEqual(p.outside, { read: "allow", write: "deny" });
  });
});

describe("the file on disk", () => {
  it("is readable, sorted JSON a human can edit", () => {
    const path = tempStore();
    rememberAllow("proj-a", ["tsc", "npm test"], { permissionsPath: path });
    const raw = readFileSync(path, "utf8");
    assert.ok(raw.includes("\n  "), "pretty-printed");
    assert.ok(raw.endsWith("\n"), "newline-terminated");
    const parsed = JSON.parse(raw) as { projects: Record<string, { allow: string[] }> };
    assert.deepEqual(parsed.projects["proj-a"]?.allow, ["npm test", "tsc"], "sorted, so diffs stay small");
  });
});
