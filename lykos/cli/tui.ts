/**
 * `lykos` with no arguments (P5 #52): the Rust TUI, `lykos-tui`, prebuilt per platform. `lykos --old-tui` is the
 * TypeScript one in `lykos/tui/`.
 *
 * The binary is, in order: `LYKOS_TUI_BIN`; a source build at `target/release/`; the one `scripts/tui/install.mjs`
 * fetched into `vendor/tui/` at `npm install`. The TUI starts its engine server with this same Node and entry
 * point, so it needs no `lykos` on `PATH`.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureWorkspaceTrust, trustedAtPath, WorkspaceTrustError } from "../gate/trust.js";
import { stderrWrite } from "../tui/io-mode.js";

/** The package's root: two levels above `lykos/cli/` and `dist/cli/` alike. */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const exe = (platform: NodeJS.Platform): string => (platform === "win32" ? "lykos-tui.exe" : "lykos-tui");

/** Where `install.mjs` puts the prebuilt binary for a platform. */
export function vendoredTui(root: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return join(root, "vendor", "tui", `${platform}-${arch}`, exe(platform));
}

/** The TUI binary this install runs, or undefined when there is none. */
export function findTui(env: NodeJS.ProcessEnv = process.env, root: string = ROOT, platform: NodeJS.Platform = process.platform): string | undefined {
  const named = env.LYKOS_TUI_BIN;
  if (named !== undefined && named !== "") return named;
  return [join(root, "target", "release", exe(platform)), vendoredTui(root, platform)].find((p) => existsSync(p));
}

export interface TuiLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** How to start the TUI in `cwd`: its arguments, and the server command it starts when none runs. */
export function tuiLaunch(binary: string, cwd: string, trustOnce: boolean, env: NodeJS.ProcessEnv = process.env): TuiLaunch {
  const serve = env.LYKOS_SERVE_CMD || JSON.stringify([process.execPath, ...process.execArgv, process.argv[1] ?? join(ROOT, "dist", "cli.js"), "serve"]);
  return { command: binary, args: ["--cwd", cwd, ...(trustOnce ? ["--trust-workspace"] : [])], env: { ...env, LYKOS_SERVE_CMD: serve } };
}

export async function runTui(cwd: string): Promise<number> {
  const binary = findTui();
  if (binary === undefined) {
    stderrWrite(
      `lykos: the TUI binary for ${process.platform}-${process.arch} is not installed.\n` +
        `  npm install fetches it; cargo build --release -p lykos-tui builds it; LYKOS_TUI_BIN names one.\n` +
        `  lykos --old-tui runs the old TUI.\n`,
    );
    return 1;
  }
  // The trust question is asked here, on the terminal, as the old TUI asks it: the TUI has no trust dialog.
  let trustOnce = false;
  // A trusted project at this path starts at once: resolving its identity costs two git processes, and the
  // server checks it anyway when the first session starts.
  if (!trustedAtPath(cwd)) {
    try {
      // Trust not read from the store holds for this run: the flag, or a yes in a workspace with no git identity,
      // which `resolveProject` cannot find again in the server's process.
      trustOnce = (await ensureWorkspaceTrust({ workspace: cwd, interactive: Boolean(process.stdin.isTTY) })).source !== "stored";
    } catch (err) {
      stderrWrite(`lykos: refused — ${err instanceof WorkspaceTrustError ? err.message : String(err)}
`);
      return 1;
    } finally {
      // The prompt left stdin reading: the TUI owns the terminal now.
      process.stdin.pause();
    }
  }
  const launch = tuiLaunch(binary, cwd, trustOnce);
  return new Promise((resolve) => {
    // Keys reach the TUI raw; a signal the terminal still sends goes to both, and the TUI decides.
    const ignore = (): void => {};
    process.on("SIGINT", ignore);
    const child = spawn(launch.command, launch.args, { stdio: "inherit", env: launch.env, cwd });
    child.on("error", (err) => {
      process.off("SIGINT", ignore);
      stderrWrite(`lykos: could not start ${binary}: ${err.message}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      process.off("SIGINT", ignore);
      resolve(code ?? (signal !== null ? 1 : 0));
    });
  });
}
