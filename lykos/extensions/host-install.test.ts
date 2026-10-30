import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { piHostDir } from "../config/pi-host.js";
import {
  hostExtensionPath,
  resolveExtensions,
  resolveHostExtensions,
} from "../config/extensions.js";
import {
  HOST_INSTALL_FLAGS,
  hostAgentDir,
  hostInstallCommand,
  hostInstallPrefix,
  installHostExtension,
  installMissingHostExtensions,
  npmSpawnTarget,
  renderHostInstall,
  renderInstallCommand,
  type HostInstallCommand,
  type InstallRun,
} from "./host-install.js";

const AGENT_DIR = "/home/someone/.lykos/pi-host";

function declared(): ReturnType<typeof resolveHostExtensions> {
  const resolution = resolveExtensions([
    { name: "pi-cache-optimizer", version: "1.2.3" },
    { name: "pi-hashline-edit", version: "0.4.0" },
  ]);
  assert.deepEqual(resolution.errors, []);
  // Nothing exists on this imaginary machine, so both are declared-but-missing.
  return resolveHostExtensions(resolution.extensions, AGENT_DIR, () => false);
}

describe("P10.9 D7 the host install path", () => {
  it("resolves to the host's own package directory, never the container's", () => {
    const ext = { name: "pi-cache-optimizer", version: "1.2.3", path: "" };
    const cmd = hostInstallCommand(AGENT_DIR, ext);
    assert.equal(cmd.prefix, hostInstallPrefix(AGENT_DIR));
    assert.ok(!cmd.args.some((a) => a.includes("/home/node/")), "no container path anywhere");
    // And the prefix is the directory the loader's own path rule resolves
    // against, rather than a second idea of where packages live.
    assert.ok(hostExtensionPath(AGENT_DIR, ext.name).startsWith(cmd.prefix.replace(/\\/g, "/")));
  });

  it("mirrors the image's command, with the declaration's exact version", () => {
    const cmd = hostInstallCommand(AGENT_DIR, { name: "pi-hashline-edit", version: "0.4.0", path: "" });
    assert.equal(cmd.command, "npm");
    assert.deepEqual(cmd.args, [
      "install",
      "--prefix",
      hostInstallPrefix(AGENT_DIR),
      ...HOST_INSTALL_FLAGS,
      "pi-hashline-edit@0.4.0",
    ]);
    assert.match(renderInstallCommand(cmd), /npm install --prefix .* pi-hashline-edit@0\.4\.0/);
  });

  it("installs a declared-but-missing package and reports what it ran", () => {
    const resolution = declared();
    assert.equal(resolution.missing.length, 2);
    const ran: string[] = [];
    let installed = false;
    const run = (cmd: HostInstallCommand): InstallRun => {
      ran.push(renderInstallCommand(cmd));
      installed = true;
      return { exitCode: 0, stdout: "added 1 package", stderr: "" };
    };
    const result = installHostExtension(resolution.missing[0]!, AGENT_DIR, run, () => installed);
    assert.equal(result.status, "installed");
    assert.equal(ran.length, 1);
    assert.equal(result.ran, ran[0]);
    assert.match(renderHostInstall([result]), /installed — ran `npm install/);
  });

  it("runs nothing for a package that is already there", () => {
    let calls = 0;
    const result = installHostExtension(
      { name: "pi-cache-optimizer", version: "1.2.3", path: "" },
      AGENT_DIR,
      () => {
        calls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      () => true,
    );
    assert.equal(result.status, "already-present");
    assert.equal(calls, 0);
    assert.equal(result.ran, undefined);
  });

  it("fails loudly on a non-zero exit, naming the command and keeping the output", () => {
    const result = installHostExtension(
      { name: "pi-cache-optimizer", version: "1.2.3", path: "" },
      AGENT_DIR,
      () => ({ exitCode: 1, stdout: "", stderr: "E404 Not Found - GET https://registry" }),
      () => false,
    );
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 1);
    assert.match(result.problem ?? "", /npm exited 1/);
    assert.match(result.output ?? "", /E404/);
    const rendered = renderHostInstall([result]);
    assert.match(rendered, /FAILED/);
    assert.match(rendered, /ran: npm install/);
    assert.match(rendered, /E404/);
  });

  it("fails loudly when the package manager cannot be started at all", () => {
    const result = installHostExtension(
      { name: "pi-cache-optimizer", version: "1.2.3", path: "" },
      AGENT_DIR,
      () => ({ exitCode: null, stdout: "", stderr: "", problem: "spawn npm ENOENT" }),
      () => false,
    );
    assert.equal(result.status, "failed");
    assert.match(result.problem ?? "", /could not be started: spawn npm ENOENT/);
  });

  it("treats a zero exit that installed nothing as a failure, not a success", () => {
    // npm's own report of success does not count — AGENTS.md rule 4 applied to
    // a package manager. The path is what is checked.
    const result = installHostExtension(
      { name: "pi-cache-optimizer", version: "1.2.3", path: "" },
      AGENT_DIR,
      () => ({ exitCode: 0, stdout: "up to date", stderr: "" }),
      () => false,
    );
    assert.equal(result.status, "failed");
    assert.equal(result.exitCode, 0);
    assert.match(result.problem ?? "", /exited 0 but .* still does not exist/);
  });

  it("stops at the first failure rather than installing past it", () => {
    const resolution = declared();
    const results = installMissingHostExtensions(
      resolution,
      AGENT_DIR,
      () => ({ exitCode: 1, stdout: "", stderr: "nope" }),
      () => false,
    );
    assert.equal(results.length, 1, "declaration order is load order");
    assert.equal(results[0]?.status, "failed");
  });

  it("says so when there is nothing to install", () => {
    const nothingMissing = resolveHostExtensions(
      resolveExtensions([{ name: "pi-cache-optimizer", version: "1.2.3" }]).extensions,
      AGENT_DIR,
      () => true,
    );
    assert.equal(nothingMissing.missing.length, 0);
    assert.match(
      renderHostInstall(installMissingHostExtensions(nothingMissing, AGENT_DIR, () => {
        throw new Error("must not run");
      })),
      /nothing to install/,
    );
  });

  it("ADR-0027: the agent directory is the Lykos pi-host, never ~/.pi/agent, and PI_CODING_AGENT_DIR is not an override", () => {
    const override = join(tmpdir(), "lykos-pi-host-override");
    assert.equal(hostAgentDir({ LYKOS_PI_HOST_DIR: override }), override);
    assert.equal(hostAgentDir({ LYKOS_PI_HOST_DIR: override }), piHostDir({ LYKOS_PI_HOST_DIR: override }));
    const fallback = hostAgentDir({ PI_CODING_AGENT_DIR: "/custom/agent" });
    assert.equal(fallback, join(homedir(), ".lykos", "pi-host"));
    assert.ok(!fallback.endsWith(join(".pi", "agent")), fallback);
  });

  it("ADR-0027 (D6.4): host install computes --prefix <pi-host>/npm from the resolver", () => {
    const pihost = join(tmpdir(), "lykos-pi-host-prefix");
    const agentDir = hostAgentDir({ LYKOS_PI_HOST_DIR: pihost });
    const cmd = hostInstallCommand(agentDir, { name: "pi-cache-optimizer", version: "1.2.3", path: "" });
    assert.equal(cmd.prefix, join(pihost, "npm"));
    assert.deepEqual(cmd.args.slice(0, 3), ["install", "--prefix", join(pihost, "npm")]);
    // The loader looks where npm writes.
    const slash = (p: string): string => p.replace(/\\/g, "/");
    assert.equal(
      slash(hostExtensionPath(agentDir, "pi-cache-optimizer")),
      slash(join(pihost, "npm", "node_modules", "pi-cache-optimizer")),
    );
  });
});

describe("the host install starts npm on Windows", () => {
  // `npm` on Windows is `npm.cmd`, a batch shim, and `spawnSync("npm")` with
  // no shell fails with ENOENT. That is what `lykos extensions install` did on
  // the maintainer's machine on 2026-10-02. The fix is lsp-client's D2 hop:
  // this process's own Node runs npm's own script, so no shell parses the
  // arguments and a prefix with a space in it stays one argument.
  const cmd: HostInstallCommand = {
    command: "npm",
    args: ["install", "--prefix", "C:\\pi host\\npm", "x@1.0.0"],
    prefix: "C:\\pi host\\npm",
  };
  const node = "C:\\Program Files\\nodejs\\node.exe";
  const bundled = win32.join("C:\\Program Files\\nodejs", "node_modules", "npm", "bin", "npm-cli.js");

  it("runs the npm-cli.js beside this Node on win32, with the arguments untouched", () => {
    const target = npmSpawnTarget(cmd, { platform: "win32", env: {}, execPath: node, exists: (p) => p === bundled });
    assert.deepEqual(target, { command: node, args: [bundled, ...cmd.args] });
  });

  it("prefers the npm that launched this process when there is one", () => {
    const launched = "D:\\tools\\npm\\bin\\npm-cli.js";
    const target = npmSpawnTarget(cmd, {
      platform: "win32",
      env: { npm_execpath: launched },
      execPath: node,
      exists: (p) => p === launched || p === bundled,
    });
    assert.deepEqual(target, { command: node, args: [launched, ...cmd.args] });
  });

  it("leaves the command alone off Windows, and on win32 when no npm script is found", () => {
    const posix = npmSpawnTarget(cmd, { platform: "linux", env: {}, execPath: "/usr/bin/node", exists: () => true });
    assert.deepEqual(posix, { command: "npm", args: cmd.args });
    const none = npmSpawnTarget(cmd, { platform: "win32", env: {}, execPath: node, exists: () => false });
    assert.deepEqual(none, { command: "npm", args: cmd.args });
  });
});
