// Installing a declared extension on the host.
//
// **The gap, and it is one sentence in the spec.** The declaration surface
// (`config/extensions.ts`) resolves a path per machine and reports a
// declared-but-missing package. What it cannot do is install one, because
// installation was the retired delegate image's job — it npm-installed a pinned
// set into Pi's own package prefix — and the machine a person sits at has no
// image. So on the host, `hostExtensionNotice()` has been able to say
// "DECLARED BUT NOT INSTALLED" and offer nothing to do about it.
//
// **IT MIRRORS THE IMAGE'S COMMAND, IT DOES NOT INVENT ONE.** The image
// ran `npm install --prefix "${PI_CODING_AGENT_DIR}/npm" --no-fund --no-audit
// <name>@<version>`, and so does this, against this machine's own agent
// directory instead of the container's — which, since ADR-0027, is the
// Lykos-generated `~/.lykos/pi-host/`, never `~/.pi/agent`. That is AGENTS.md rule 7 in the
// ordinary direction: the host resolves its own path from the same rule rather
// than being handed the retired container's extension root, which was a path
// inside that container and means nothing here.
//
// **THE VERSION IS THE DECLARATION'S, EXACTLY.** `resolveExtensions` has
// already refused a range, so what reaches this module is a pinned version and
// `name@version` is a complete answer. Installing "latest" would silently
// change both the head and the tool surface, which is two intake-bar
// violations with no commit anybody can point at.
//
// **IT FAILS LOUDLY.** Nothing here has a silent path. A run that could not
// start, a non-zero exit, and a package that is still absent after a
// zero exit are three different failures and each is reported as itself, with
// the command line that produced it. An install that half-worked and said
// nothing is how a session boots without the policy somebody declared.
//
// **IT IS NEVER AUTOMATIC.** `installHostExtension` is called by a person
// asking for it. A session that silently npm-installs at boot is a startup tax
// and a supply-chain hole (`problems/11`), and it is the exact thing the image
// exists to have already done.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, win32 } from "node:path";
import { piHostDir } from "../config/pi-host.js";
import {
  hostExtensionPath,
  type HostExtension,
  type HostExtensionResolution,
} from "../config/extensions.js";

/** What the image ran, minus the container's path. Kept beside the reason it is these flags. */
export const HOST_INSTALL_FLAGS = ["--no-fund", "--no-audit"] as const;

export interface HostInstallCommand {
  command: string;
  args: string[];
  /** The npm prefix — the directory that will hold `node_modules/<name>`. */
  prefix: string;
}

/** Where Pi keeps its packages on the host, and the npm prefix that writes there. */
export function hostInstallPrefix(agentDir: string): string {
  return join(agentDir.replace(/[\\/]+$/, ""), "npm");
}

/**
 * The exact command, as a value, so the caller can print what it is about to
 * run BEFORE it runs and print the same string afterwards. A report assembled
 * separately from the thing that ran is a report that can be wrong.
 */
export function hostInstallCommand(agentDir: string, ext: HostExtension): HostInstallCommand {
  const prefix = hostInstallPrefix(agentDir);
  return {
    command: "npm",
    args: ["install", "--prefix", prefix, ...HOST_INSTALL_FLAGS, `${ext.name}@${ext.version}`],
    prefix,
  };
}

/** Human-readable form of what was run. */
export function renderInstallCommand(cmd: HostInstallCommand): string {
  return `${cmd.command} ${cmd.args.join(" ")}`;
}

export interface InstallRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started at all. */
  problem?: string;
}

export type InstallRunner = (cmd: HostInstallCommand) => InstallRun;

export interface NpmSpawnContext {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
  exists: (path: string) => boolean;
}

/**
 * What actually gets spawned for `cmd`. On Windows `npm` is `npm.cmd`, a batch
 * shim that `spawnSync` cannot start without a shell (ENOENT, found
 * 2026-10-02), and a shell would re-parse a prefix with a space in it. So,
 * like lsp-client's D2 hop, this process's own Node runs npm's own script:
 * the npm that launched us when there is one, else the one bundled beside
 * Node. With neither, `npm` is left as it is and fails as itself.
 *
 * `cmd` stays the npm command line, because that is what a person reading a
 * failure would type to run it themselves.
 */
export function npmSpawnTarget(
  cmd: HostInstallCommand,
  ctx: NpmSpawnContext = { platform: process.platform, env: process.env, execPath: process.execPath, exists: existsSync },
): { command: string; args: string[] } {
  if (ctx.platform !== "win32") return { command: cmd.command, args: cmd.args };
  const launched = ctx.env.npm_execpath;
  const candidates = [
    ...(launched !== undefined && /npm-cli\.js$/i.test(launched) ? [launched] : []),
    win32.join(win32.dirname(ctx.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const script = candidates.find((c) => ctx.exists(c));
  if (script === undefined) return { command: cmd.command, args: cmd.args };
  return { command: ctx.execPath, args: [script, ...cmd.args] };
}

/**
 * The real runner. `spawnSync` rather than `spawn`: an install is a thing a
 * person typed and is waiting on, there is nothing to stream it to, and the
 * caller has nothing useful to do while it runs.
 */
export const spawnInstall: InstallRunner = (cmd) => {
  const target = npmSpawnTarget(cmd);
  const result = spawnSync(target.command, target.args, {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();
  if (result.error) return { exitCode: null, stdout, stderr, problem: result.error.message };
  return { exitCode: result.status ?? null, stdout, stderr };
};

export type HostInstallStatus = "installed" | "already-present" | "failed";

export interface HostInstallResult {
  name: string;
  version: string;
  status: HostInstallStatus;
  /** Where it now is, or was expected to be. */
  path: string;
  /** What was run, verbatim. Absent only when nothing was run. */
  ran?: string;
  exitCode?: number | null;
  /** Present on every `failed`. Never empty, and never a paraphrase of a missing error. */
  problem?: string;
  output?: string;
}

/**
 * Install one declared extension into this machine's agent directory.
 *
 * `run` and `exists` are injected for the reason `resolveHostExtensions`
 * injects `exists`: the decision is testable without an install tree and
 * without reaching the network, and no test in this repository runs npm.
 */
export function installHostExtension(
  ext: HostExtension,
  agentDir: string,
  run: InstallRunner = spawnInstall,
  exists: (path: string) => boolean = existsSync,
): HostInstallResult {
  const path = hostExtensionPath(agentDir, ext.name);
  if (exists(path)) {
    return { name: ext.name, version: ext.version, status: "already-present", path };
  }
  const cmd = hostInstallCommand(agentDir, ext);
  const ran = renderInstallCommand(cmd);
  const result = run(cmd);
  const output = [result.stdout, result.stderr].filter((s) => s.length > 0).join("\n");
  if (result.problem !== undefined) {
    return {
      name: ext.name,
      version: ext.version,
      status: "failed",
      path,
      ran,
      exitCode: null,
      problem: `the package manager could not be started: ${result.problem}`,
      ...(output.length > 0 ? { output } : {}),
    };
  }
  if (result.exitCode !== 0) {
    return {
      name: ext.name,
      version: ext.version,
      status: "failed",
      path,
      ran,
      exitCode: result.exitCode,
      problem: `npm exited ${result.exitCode ?? "?"}`,
      ...(output.length > 0 ? { output } : {}),
    };
  }
  // A zero exit is not evidence. npm can succeed at doing nothing useful —
  // a workspace it declined to touch, a prefix it could not write — and the
  // only question that matters is whether the path the loader will look at
  // now holds a package. An agent's own report of success does not count
  // (AGENTS.md rule 4), and neither does a package manager's.
  if (!exists(path)) {
    return {
      name: ext.name,
      version: ext.version,
      status: "failed",
      path,
      ran,
      exitCode: 0,
      problem: `npm exited 0 but ${path} still does not exist, so this session would still run without it`,
      ...(output.length > 0 ? { output } : {}),
    };
  }
  return { name: ext.name, version: ext.version, status: "installed", path, ran, exitCode: 0 };
}

/**
 * Every declared-but-missing extension, in declaration order — which is load
 * order, so installing in it means a failure stops at the first package the
 * ones behind it might depend on.
 */
export function installMissingHostExtensions(
  resolution: HostExtensionResolution,
  agentDir: string,
  run: InstallRunner = spawnInstall,
  exists: (path: string) => boolean = existsSync,
): HostInstallResult[] {
  const out: HostInstallResult[] = [];
  for (const ext of resolution.missing) {
    const result = installHostExtension(ext, agentDir, run, exists);
    out.push(result);
    if (result.status === "failed") break;
  }
  return out;
}

/** One line per result, and a failure names the command so the person can run it themselves. */
export function renderHostInstall(results: readonly HostInstallResult[]): string {
  if (results.length === 0) {
    return "lykos: nothing to install — every declared extension is already present on this host";
  }
  const lines: string[] = [];
  for (const r of results) {
    if (r.status === "already-present") {
      lines.push(`  ${r.name}@${r.version}: already present at ${r.path}`);
      continue;
    }
    if (r.status === "installed") {
      lines.push(`  ${r.name}@${r.version}: installed — ran \`${r.ran}\``);
      continue;
    }
    lines.push(
      `  ${r.name}@${r.version}: FAILED — ${r.problem}`,
      `    ran: ${r.ran}`,
      ...(r.output !== undefined ? [`    ${r.output.split("\n").join("\n    ")}`] : []),
    );
  }
  const failed = results.filter((r) => r.status === "failed").length;
  const header =
    failed > 0
      ? `lykos: ${failed} extension install(s) FAILED — this session would still run without them`
      : `lykos: ${results.length} declared extension(s) handled`;
  return [header, ...lines].join("\n");
}

/**
 * Where Pi keeps its agent directory on THIS machine.
 *
 * ADR-0027: that is the generated `~/.lykos/pi-host/` (`config/pi-host.ts`),
 * no longer `~/.pi/agent`. Kept as a name here so the install path and the
 * doctor row cannot come to different answers about which directory a
 * declaration resolves against; both ask the one resolver.
 */
export function hostAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  return piHostDir(env);
}
