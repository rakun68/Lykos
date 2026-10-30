// T147 (backlog D25): a Lykos extension declared in `config.yaml` — the
// declaration, its per-machine resolution, the missing report, the host
// install path pointed at it, and the loader. The session-level proof is
// `cli/scripted-lykos-extensions.test.ts`.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  hostExtensionNotice,
  LYKOS_EXTENSIONS_KEY,
  resolveExtensions,
  resolveHostExtensions,
} from "../config/extensions.js";
import { loadConfig } from "../config/load.js";
import { SHIPPED_DEFAULTS } from "../config/defaults.js";
import { reconcileHostLykosExtensions } from "../cli/doctor.js";
import { LykosExtensionHost } from "./api.js";
import { installMissingHostExtensions, type InstallRunner } from "./host-install.js";
import { loadLykosExtensions, resolveLykosExtensionEntries } from "./load.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function newHost(): LykosExtensionHost {
  return new LykosExtensionHost({ cwd: tmp("lykos-ext-cwd-"), gate: { request: async () => "allow" as const } });
}

/** Write a package under `<agentDir>/npm/node_modules/<name>` holding `files`. */
function installPackage(agentDir: string, name: string, files: Record<string, string>): string {
  const dir = join(agentDir, "npm", "node_modules", name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
  return dir;
}

const COMMAND_EXT = `export default function register(api) {
  api.registerCommand({ name: "hello", description: "says hello", run: (args) => "hello " + args });
}
`;

describe("T147 lykos_extensions: in config.yaml", () => {
  it("is a list in the Pi list's shape, shipped with default extensions (lykos-reviewer, lykos-seal), replaced (not merged) by a layer", () => {
    // T149/T199: default extensions `lykos-reviewer` and `lykos-seal`.
    assert.deepEqual(
      SHIPPED_DEFAULTS.lykos_extensions.map((e) => e.name),
      ["lykos-reviewer", "lykos-seal"],
    );
    const cwd = tmp("lykos-ext-cfg-");
    const globalDir = tmp("lykos-ext-global-");
    writeFileSync(join(globalDir, "config.yaml"), "lykos_extensions:\n  - name: global-one\n    version: 1.0.0\n");
    mkdirSync(join(cwd, ".lykos"));
    writeFileSync(
      join(cwd, ".lykos", "config.yaml"),
      "lykos_extensions:\n  - name: my-ext\n    version: 1.2.3\n    scope: [hop0]\n",
    );
    const { resolved } = loadConfig({ cwd, globalDir, env: {} });
    assert.deepEqual(resolved.lykos_extensions, [{ name: "my-ext", version: "1.2.3", scope: ["hop0"] }]);
    // The Pi list is untouched by it.
    assert.deepEqual(resolved.extensions, SHIPPED_DEFAULTS.extensions);
  });

  it("is validated by the Pi list's rules, and a rejection names the lykos_extensions block", () => {
    const r = resolveExtensions(
      [
        { name: "ok-ext", version: "1.0.0" },
        { name: "ranged", version: "^1.0.0" },
        { name: "../escape", version: "1.0.0" },
        { name: "ok-ext", version: "1.0.0" },
      ],
      LYKOS_EXTENSIONS_KEY,
    );
    assert.deepEqual(r.extensions.map((e) => e.name), ["ok-ext"]);
    assert.equal(r.errors.length, 3);
    for (const e of r.errors) assert.match(e, /^lykos_extensions\[\d\]/);
    assert.match(resolveExtensions("nope", LYKOS_EXTENSIONS_KEY).errors[0]!, /^lykos_extensions: expected a list/);
  });

  it("is resolved per machine and a missing one is reported like a missing Pi extension", () => {
    const agentDir = tmp("lykos-ext-agent-");
    installPackage(agentDir, "here-ext", { "index.js": COMMAND_EXT });
    const { extensions } = resolveExtensions(
      [
        { name: "here-ext", version: "1.0.0" },
        { name: "gone-ext", version: "2.0.0" },
      ],
      LYKOS_EXTENSIONS_KEY,
    );
    const host = resolveHostExtensions(extensions, agentDir, existsSync);
    assert.deepEqual(host.loaded.map((e) => e.name), ["here-ext"]);
    assert.deepEqual(host.missing.map((e) => e.name), ["gone-ext"]);
    const notice = hostExtensionNotice(host, "lykos extensions");
    assert.match(notice!, /lykos extensions loaded: here-ext@1\.0\.0/);
    assert.match(notice!, /lykos extensions DECLARED BUT NOT INSTALLED on this host: gone-ext@2\.0\.0/);

    const checks = reconcileHostLykosExtensions({ extensions, errors: [] }, agentDir, existsSync);
    assert.equal(checks.find((c) => c.status === "ok")?.label.includes("here-ext@1.0.0"), true);
    const warn = checks.find((c) => c.status === "warn");
    assert.ok(warn, "doctor warns about the missing one");
    assert.match(warn.label, /gone-ext@2\.0\.0/);
    assert.match(warn.label, /npm install --prefix .* gone-ext@2\.0\.0/);
  });

  it("doctor fails a rejected lykos_extensions declaration", () => {
    const checks = reconcileHostLykosExtensions(
      resolveExtensions([{ name: "x", version: "latest" }], LYKOS_EXTENSIONS_KEY),
      tmp("lykos-ext-agent-"),
      existsSync,
    );
    assert.equal(checks[0]?.status, "fail");
    assert.match(checks[0]!.label, /lykos extension declaration rejected: lykos_extensions\[0\]/);
  });

  it("the existing host install path installs a declared-but-missing one, which then loads", async () => {
    const agentDir = tmp("lykos-ext-agent-");
    const { extensions } = resolveExtensions([{ name: "late-ext", version: "3.1.4" }], LYKOS_EXTENSIONS_KEY);
    const before = resolveHostExtensions(extensions, agentDir, existsSync);
    assert.deepEqual(before.missing.map((e) => e.name), ["late-ext"]);

    const ran: string[] = [];
    // Stands in for npm: records the command and lays down the package where npm would.
    const fakeNpm: InstallRunner = (cmd) => {
      ran.push(cmd.args.join(" "));
      installPackage(agentDir, "late-ext", { "index.js": COMMAND_EXT });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const results = installMissingHostExtensions(before, agentDir, fakeNpm, existsSync);
    assert.deepEqual(results.map((r) => r.status), ["installed"]);
    assert.match(ran[0]!, /late-ext@3\.1\.4$/);

    const after = resolveHostExtensions(extensions, agentDir, existsSync);
    assert.deepEqual(after.missing, []);
    const host = newHost();
    const report = await loadLykosExtensions(host, after.loaded);
    assert.deepEqual(report.loaded, ["late-ext"]);
    assert.equal(await host.runCommand("hello", "world"), "hello world");
  });
});

describe("T147 resolveLykosExtensionEntries mirrors Pi's entry rule", () => {
  it("prefers package.json lykos.extensions, then index.ts, then index.js", () => {
    const agentDir = tmp("lykos-ext-agent-");
    const manifest = installPackage(agentDir, "m", {
      "package.json": JSON.stringify({ name: "m", lykos: { extensions: ["./a.js", "./missing.js"] }, pi: { extensions: ["./pi.js"] } }),
      "a.js": COMMAND_EXT,
      "index.js": COMMAND_EXT,
    });
    assert.deepEqual(resolveLykosExtensionEntries(manifest), [join(manifest, "a.js")]);
    const both = installPackage(agentDir, "b", { "index.ts": "", "index.js": "" });
    assert.deepEqual(resolveLykosExtensionEntries(both), [join(both, "index.ts")]);
    const none = installPackage(agentDir, "n", { "readme.md": "" });
    assert.equal(resolveLykosExtensionEntries(none), null);
  });
});

describe("T147 a declared extension that fails to load is reported and counted, and the rest load", () => {
  it("counts a missing entry, a throwing import and a non-extension export, then loads the next one", async () => {
    const agentDir = tmp("lykos-ext-agent-");
    installPackage(agentDir, "no-entry", { "readme.md": "" });
    installPackage(agentDir, "throws", { "index.js": `throw new Error("boom at import");\n` });
    installPackage(agentDir, "not-ext", { "index.js": `export default 42;\n` });
    installPackage(agentDir, "reg-throws", { "index.js": `export default { register() { throw new Error("boom in register"); } };\n` });
    installPackage(agentDir, "good", { "index.js": COMMAND_EXT });
    const { extensions } = resolveExtensions(
      ["no-entry", "throws", "not-ext", "reg-throws", "good"].map((name) => ({ name, version: "1.0.0" })),
      LYKOS_EXTENSIONS_KEY,
    );
    const present = resolveHostExtensions(extensions, agentDir, existsSync).loaded;
    const host = newHost();
    const report = await loadLykosExtensions(host, present);

    assert.deepEqual(report.failed, ["no-entry", "throws", "not-ext", "reg-throws"]);
    assert.deepEqual(report.loaded, ["good"]);
    assert.equal(host.counters.failures, 4);
    assert.deepEqual(Object.keys(host.counters.failuresByExtension), ["no-entry", "throws", "not-ext", "reg-throws"]);
    const sites = host.counters.log.map((f) => `${f.extension}:${f.site}`);
    assert.deepEqual(sites, ["no-entry:load", "throws:load", "not-ext:load", "reg-throws:install"]);
    assert.match(host.counters.log[1]!.message, /boom at import/);
    // The one after the broken ones still works.
    assert.equal(await host.runCommand("hello", "there"), "hello there");
  });
});
