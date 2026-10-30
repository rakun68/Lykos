// T210 acceptance (sealed): path rules, allow | ask | deny per path, deny wins (ADR-0042).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectPathRules, decidePath, type PathContext, type PathRule } from "./path-rules.js";
import { loadPermissions, rememberExtraDir } from "./permissions.js";

const BS = String.fromCharCode(92);
const win = (p: string): string => p.split("/").join(BS);
const POSIX: PathContext = { cwd: "/work/proj", home: "/home/u", extraDirs: [], outside: { read: "ask", write: "ask" } };
const WIN: PathContext = { cwd: win("C:/work/proj"), home: win("C:/Users/u"), extraDirs: [], outside: { read: "ask", write: "ask" } };
const rule = (pattern: string, decision: PathRule["decision"], access: PathRule["access"] = "read", source = "global"): PathRule =>
  ({ pattern, decision, access, source });

describe("T210: precedence is deny, then ask, then allow", () => {
  it("inside the directory with no rule, a read is allowed", () => {
    assert.equal(decidePath("/work/proj/src/a.ts", "read", [], POSIX).decision, "allow");
  });

  it("deny beats allow and ask, whatever the order", () => {
    const rules = [rule("secrets/**", "allow"), rule("secrets/**", "ask"), rule("secrets/**", "deny")];
    for (const order of [rules, [...rules].reverse()]) {
      assert.equal(decidePath("/work/proj/secrets/k.txt", "read", order, POSIX).decision, "deny");
    }
  });

  it("ask beats allow", () => {
    const rules = [rule("docs/**", "allow"), rule("docs/**", "ask")];
    assert.equal(decidePath("/work/proj/docs/a.md", "read", rules, POSIX).decision, "ask");
  });

  it("a rule applies only to its access", () => {
    const rules = [rule("dist/**", "deny", "write")];
    assert.equal(decidePath("/work/proj/dist/a.js", "read", rules, POSIX).decision, "allow");
    assert.equal(decidePath("/work/proj/dist/a.js", "write", rules, POSIX).decision, "deny");
  });

  it("a ! negation cancels a rule from the same source only", () => {
    const same = [rule("*.env*", "deny", "read", "global"), rule("!*.env.example", "deny", "read", "global")];
    assert.equal(decidePath("/work/proj/.env.example", "read", same, POSIX).decision, "allow");
    assert.equal(decidePath("/work/proj/.env", "read", same, POSIX).decision, "deny");
    const other = [rule("*.env*", "deny", "read", "global"), rule("!*.env.example", "deny", "read", "project")];
    assert.equal(decidePath("/work/proj/.env.example", "read", other, POSIX).decision, "deny");
  });

  it("a deny names the rule that denied it", () => {
    const v = decidePath("/home/u/.ssh/id_ed25519", "read", [rule("~/.ssh/**", "deny")], POSIX);
    assert.equal(v.decision, "deny");
    assert.match(v.reason ?? "", /~\/\.ssh\/\*\*/);
  });
});

describe("T210: outside the directory", () => {
  it("reads and writes outside ask by default", () => {
    assert.equal(decidePath("/etc/hosts", "read", [], POSIX).decision, "ask");
    assert.equal(decidePath("/tmp/x", "write", [], POSIX).decision, "ask");
  });

  it("an extra directory is treated as inside", () => {
    const ctx = { ...POSIX, extraDirs: ["/data/shared"] };
    assert.equal(decidePath("/data/shared/a.csv", "read", [], ctx).decision, "allow");
    assert.equal(decidePath("/data/other/a.csv", "read", [], ctx).decision, "ask");
  });

  it("a deny still applies inside an extra directory", () => {
    const ctx = { ...POSIX, extraDirs: ["/home/u"] };
    assert.equal(decidePath("/home/u/.ssh/config", "read", [rule("~/.ssh/**", "deny")], ctx).decision, "deny");
  });

  it("'allow this folder' is remembered per project and stops the next ask", () => {
    const store = join(mkdtempSync(join(tmpdir(), "lykos-t210-")), "permissions.json");
    rememberExtraDir("proj-a", "/data/shared", { permissionsPath: store });
    const a = loadPermissions("proj-a", { permissionsPath: store });
    assert.deepEqual(a.extraDirs, ["/data/shared"]);
    assert.deepEqual(loadPermissions("proj-b", { permissionsPath: store }).extraDirs, []);
    const ctx = { ...POSIX, extraDirs: a.extraDirs };
    assert.equal(decidePath("/data/shared/x.csv", "read", [], ctx).decision, "allow");
  });
});

describe("T210: Windows and POSIX paths", () => {
  it("matches Windows paths case-insensitively with either separator", () => {
    const rules = [rule("secrets/**", "deny")];
    assert.equal(decidePath(win("C:/work/proj/secrets/k.txt"), "read", rules, WIN).decision, "deny");
    assert.equal(decidePath("c:/Work/Proj/Secrets/k.txt", "read", rules, WIN).decision, "deny");
    assert.equal(decidePath(win("C:/work/proj/src/a.ts"), "read", rules, WIN).decision, "allow");
    assert.equal(decidePath(win("D:/elsewhere/a.ts"), "read", rules, WIN).decision, "ask");
  });

  it("expands ~ against the Windows home", () => {
    const v = decidePath(win("C:/Users/u/.ssh/id_rsa"), "read", [rule("~/.ssh/**", "deny")], WIN);
    assert.equal(v.decision, "deny");
  });
});

describe("T210: trust", () => {
  it("an untrusted project's allow rules are ignored, its deny and ask rules apply", () => {
    const layers = {
      global: { read: { "notes/**": "ask" } },
      project: { read: { "notes/**": "allow", "private/**": "deny" }, write: { "build/**": "ask" } },
    } as const;
    const untrusted = collectPathRules(layers, false);
    assert.equal(decidePath("/work/proj/notes/a.md", "read", untrusted, POSIX).decision, "ask");
    assert.equal(decidePath("/work/proj/private/a.md", "read", untrusted, POSIX).decision, "deny");
    assert.equal(decidePath("/work/proj/build/a.js", "write", untrusted, POSIX).decision, "ask");
    assert.ok(!untrusted.some((r) => r.source === "project" && r.decision === "allow"));
    const trusted = collectPathRules(layers, true);
    assert.ok(trusted.some((r) => r.source === "project" && r.decision === "allow"));
  });
});

describe("T210: symlinks", () => {
  it("a symlink inside the project pointing at a denied path is denied", (t) => {
    const root = mkdtempSync(join(tmpdir(), "lykos-t210-link-"));
    const proj = join(root, "proj");
    const vault = join(root, "vault");
    mkdirSync(proj);
    mkdirSync(vault);
    writeFileSync(join(vault, "key.txt"), "secret");
    try {
      symlinkSync(vault, join(proj, "innocent"), "junction");
    } catch {
      t.skip("cannot create a symlink here");
      return;
    }
    const ctx: PathContext = { cwd: proj, home: join(root, "home"), extraDirs: [vault], outside: { read: "ask", write: "ask" } };
    const rules = [rule(`${vault.split(BS).join("/")}/**`, "deny")];
    assert.equal(decidePath(join(proj, "innocent", "key.txt"), "read", rules, ctx).decision, "deny");
  });
});
