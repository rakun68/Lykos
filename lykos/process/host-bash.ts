// The one bash resolver for every host shell Lykos runs (T247, spec decision 19). Pi's own `getShellConfig`: an
// explicit shell path, else Git Bash in its known places on Windows, else bash on PATH (`sh` on POSIX last). Kept
// free of other Lykos imports: `tools/executor.ts` reads it.

import { getShellConfig } from "@earendil-works/pi-coding-agent";

export interface ResolvedShell {
  shell: string;
  args: string[];
  /** Pi's: a legacy WSL bash reads the command from stdin. */
  commandTransport?: "stdin";
}

export type ShellResolution = { ok: true; resolved: ResolvedShell } | { ok: false; message: string };

/** The bash Pi resolves, with `shellPath` first when set. Never throws. */
export function resolveHostBash(shellPath?: string): ShellResolution {
  try {
    const config = getShellConfig(shellPath !== undefined && shellPath.trim() !== "" ? shellPath : undefined) as ResolvedShell;
    return { ok: true, resolved: config };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** The refusal `lykos run` prints when no bash resolves. */
export function noBashMessage(resolution: { message: string }): string {
  return (
    `no bash resolves for delegated commands (spec decision 19): ${resolution.message.split("\n")[0]}\n` +
    "fix: install Git for Windows, put a bash on PATH, or set delegation.shell_path to a bash executable"
  );
}

/** The program and arguments a shell line runs as: the resolved bash with `-c`, or undefined when none resolves. */
export function bashCommandLine(line: string, shellPath?: string): { command: string; args: string[] } | undefined {
  const resolution = resolveHostBash(shellPath);
  if (!resolution.ok) return undefined;
  // A legacy WSL bash takes `-s` and stdin; every bash takes `-c`, which is what a harness command needs.
  const args = resolution.resolved.commandTransport === "stdin" ? ["-c"] : resolution.resolved.args;
  return { command: resolution.resolved.shell, args: [...args, line] };
}

