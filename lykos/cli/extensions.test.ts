// T164: `lykos extensions install` and `lykos extensions list`, driven through
// the CLI entry against a real project config and a real (temporary) Pi host
// directory. npm is never run: the injected runner does what a successful
// install does to the tree, which is all `installHostExtension` checks.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { hostExtensionNotice, hostExtensionPath, resolveExtensions, resolveHostExtensions } from "../config/extensions.js";
import { PI_HOST_DIR_ENV } from "../config/pi-host.js";
import { defaultExtensionVersion } from "../extensions/defaults/index.js";
import type { HostInstallCommand } from "../extensions/host-install.js";
import { reconcileHostExtensions, reconcileHostLykosExtensions } from "./doctor.js";
import { EXTENSIONS_INSTALL_COMMAND, runExtensionsCli } from "./extensions.js";

function capture(fn: () => number): { code: number; stdout: string; stderr: string } {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((c: string | Uint8Array) => ((stdout += String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => ((stderr += String(c)), true)) as typeof process.stderr.write;
  try {
    return { code: fn(), stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

function project(config: string) {
  const root = mkdtempSync(join(tmpdir(), "lykos-ext-cli-"));
  const cwd = join(root, "repo");
  const host = join(root, "pi-host");
  const globalDir = join(root, "global");
  mkdirSync(join(cwd, ".lykos"), { recursive: true });
  mkdirSync(globalDir);
  writeFileSync(join(cwd, ".lykos", "config.yaml"), config);
  const runs: HostInstallCommand[] = [];
  const deps = {
    env: { [PI_HOST_DIR_ENV]: host },
    globalDir,
    // What a successful `npm install --prefix <p> name@v` leaves behind.
    run: (cmd: HostInstallCommand) => {
      runs.push(cmd);
      const spec = cmd.args[cmd.args.length - 1]!;
      const name = spec.slice(0, spec.lastIndexOf("@"));
      mkdirSync(join(cmd.prefix, "node_modules", name), { recursive: true });
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { root, cwd, host, deps, runs, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const V = defaultExtensionVersion();
const CONFIG = [
  "extensions:",
  "  - { name: pi-fake-one, version: 1.2.3 }",
  `  - { name: lykos-continuation, version: ${V} }`,
  "lykos_extensions:",
  "  - { name: lykos-ext-fake, version: 0.1.0 }",
  `  - { name: lykos-reviewer, version: ${V} }`,
  "",
].join("\n");

describe("lykos extensions (T164)", () => {
  it("install fetches every declared-but-missing extension from both lists, and a second install does nothing", () => {
    const p = project(CONFIG);
    try {
      const first = capture(() => runExtensionsCli(p.cwd, "install", p.deps));
      assert.equal(first.code, 0, first.stderr);
      assert.deepEqual(
        p.runs.map((r) => r.args[r.args.length - 1]),
        ["pi-fake-one@1.2.3", "lykos-ext-fake@0.1.0"],
        "only the two third-party packages; the defaults are never installed",
      );
      assert.match(first.stdout, /pi-fake-one@1\.2\.3: installed — ran `npm install --prefix /);
      assert.match(first.stdout, /lykos-ext-fake@0\.1\.0: installed/);
      assert.ok(existsSync(hostExtensionPath(p.host, "pi-fake-one")));

      const second = capture(() => runExtensionsCli(p.cwd, "install", p.deps));
      assert.equal(second.code, 0);
      assert.equal(p.runs.length, 2, "nothing was run the second time");
      assert.match(second.stdout, /nothing to install/);
    } finally {
      p.cleanup();
    }
  });

  it("list shows each declared extension, its list, whether it is installed, and which are defaults", () => {
    const p = project(CONFIG);
    try {
      const before = capture(() => runExtensionsCli(p.cwd, "list", p.deps));
      assert.equal(before.code, 0, before.stderr);
      assert.match(before.stdout, /4 declared/);
      assert.match(before.stdout, /pi-fake-one@1\.2\.3\s+extensions\s+MISSING$/m);
      assert.match(before.stdout, /lykos-ext-fake@0\.1\.0\s+lykos_extensions\s+MISSING$/m);
      assert.match(before.stdout, new RegExp(`lykos-continuation@${V.replace(/\./g, "\\.")}\\s+extensions\\s+installed\\s+\\(default, ships with Lykos\\)`));
      assert.match(before.stdout, new RegExp(`lykos-reviewer@${V.replace(/\./g, "\\.")}\\s+lykos_extensions\\s+installed\\s+\\(default, ships with Lykos\\)`));
      assert.match(before.stdout, new RegExp(`2 missing — install with \`${EXTENSIONS_INSTALL_COMMAND}\``));

      capture(() => runExtensionsCli(p.cwd, "install", p.deps));
      const after = capture(() => runExtensionsCli(p.cwd, undefined, p.deps));
      assert.match(after.stdout, /pi-fake-one@1\.2\.3\s+extensions\s+installed$/m);
      assert.match(after.stdout, /lykos-ext-fake@0\.1\.0\s+lykos_extensions\s+installed$/m);
      assert.doesNotMatch(after.stdout, /missing —/);
    } finally {
      p.cleanup();
    }
  });

  it("a default extension pinned at another version is an ordinary package and installs like one", () => {
    const p = project(["extensions:", "  - { name: lykos-repo-map, version: 9.9.9 }", ""].join("\n"));
    try {
      assert.match(capture(() => runExtensionsCli(p.cwd, "list", p.deps)).stdout, /lykos-repo-map@9\.9\.9\s+extensions\s+MISSING$/m);
      assert.equal(capture(() => runExtensionsCli(p.cwd, "install", p.deps)).code, 0);
      assert.deepEqual(p.runs.map((r) => r.args[r.args.length - 1]), ["lykos-repo-map@9.9.9"]);
    } finally {
      p.cleanup();
    }
  });

  it("refuses an unknown subcommand", () => {
    const p = project(CONFIG);
    try {
      const r = capture(() => runExtensionsCli(p.cwd, "remove", p.deps));
      assert.equal(r.code, 1);
      assert.match(r.stderr, /unknown subcommand "remove"/);
    } finally {
      p.cleanup();
    }
  });

  it("the session-start notice and both doctor rows name the install command", () => {
    const missing = resolveExtensions([{ name: "pi-fake-one", version: "1.2.3" }]);
    const host = resolveHostExtensions(missing.extensions, "/nowhere", () => false);
    assert.match(hostExtensionNotice(host) ?? "", /Install them with `lykos extensions install`/);
    const piRow = reconcileHostExtensions(missing, "/nowhere", () => false).find((c) => c.status === "warn");
    assert.match(piRow?.label ?? "", /`lykos extensions install`/);
    const lykosRow = reconcileHostLykosExtensions(
      resolveExtensions([{ name: "lykos-ext-fake", version: "0.1.0" }], "lykos_extensions"),
      "/nowhere",
      () => false,
    ).find((c) => c.status === "warn");
    assert.match(lykosRow?.label ?? "", /`lykos extensions install`/);
  });
});
