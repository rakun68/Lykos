// The spawn guard (T257, ADR-0060 amended 2026-10-31). Every process a session relies on runs behind one, and
// the guard is recorded before its command starts.
//
// The guard is a small Node process with no dependencies: its source is GUARD_SOURCE below, run with
// `node -e`, so there is no file to ship or find. Over its IPC pipe it reports its pid, then waits for `go`.
// The parent sends `go` only after the record is written. The guard then runs its command:
//   - POSIX: in the guard's own process group. The parent starts the guard detached, so the guard leads a new
//     group and the command inherits it; `kill(-guardPid)` reaches the command and everything it started.
//   - Windows: as the guard's child; `taskkill /T /F` on the command reaches its tree.
// When the pipe closes (the parent died or let go), the guard kills its command's tree and exits. If the pipe
// closes before `go`, it runs nothing.
//
// A guard killed outright (SIGKILL, TerminateProcess) cannot clean up.
//   - POSIX: its command stays findable by process group (the guard's pid).
//   - Windows: libuv runs a Node process's children in a job object killed with that process, so the command
//     dies with its guard. The lookup by parent pid (the guard's) and a creation time after the guard's record
//     remains for a command that left the job.
// `findGuardedProcesses` does that lookup.

import { spawn, execFileSync, type ChildProcess, type StdioOptions } from "node:child_process";

/** The guard's whole program. CommonJS, Node built-ins only. */
export const GUARD_SOURCE = String.raw`
const { spawn, spawnSync } = require("node:child_process");
const spec = JSON.parse(process.env.LYKOS_GUARD_SPEC || "{}");
delete process.env.LYKOS_GUARD_SPEC;
let child = null;
let started = false;
function killTree() {
  if (process.platform === "win32") {
    if (child && child.pid && child.exitCode === null) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try { process.kill(-process.pid, "SIGKILL"); } catch (e) {}
  }
}
process.on("disconnect", () => {
  if (!started) process.exit(0);
  killTree();
  process.exit(137);
});
process.on("message", (m) => {
  if (!m || m.type !== "go" || started) return;
  started = true;
  try {
    child = spawn(spec.command, spec.args || [], { cwd: spec.cwd, env: process.env, shell: spec.shell === true, stdio: "inherit", windowsHide: true });
  } catch (e) {
    process.send({ type: "error", message: String(e && e.message || e) }, () => process.exit(127));
    return;
  }
  child.on("error", (e) => { process.send({ type: "error", message: String(e && e.message || e) }, () => process.exit(127)); });
  if (child.pid) process.send({ type: "started", pid: child.pid });
  child.on("exit", (code, signal) => {
    process.send({ type: "exit", code: code, signal: signal }, () => process.exit(code === null ? 1 : code));
  });
});
process.send({ type: "ready", pid: process.pid });
`;

export interface GuardedSpawnOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Run `command` through the platform shell. */
  shell?: boolean;
  /** The command's stdin. Default `ignore`. */
  stdin?: "ignore" | "pipe" | "inherit";
  /** The command's stdout and stderr, as Node's `stdio[1]` and `[2]`. Default `pipe`. */
  output?: "pipe" | "inherit" | "ignore";
  /**
   * Writes the guard's process record. `go` is sent only after it resolves; if it throws, the guard is let go
   * before `go` and runs nothing.
   */
  record: (guardPid: number) => void | Promise<void>;
}

export interface GuardedExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface GuardedProcess {
  guardPid: number;
  /** The command's pid. */
  commandPid: number;
  /** The guard process: its stdout and stderr are the command's. */
  guard: ChildProcess;
  /** Resolves when the command has exited and the guard reported it, or the guard died. */
  exited: Promise<GuardedExit>;
  /** Lets go of the guard: it kills its command's tree. */
  release(): void;
}

type GuardMessage =
  | { type: "ready"; pid: number }
  | { type: "started"; pid: number }
  | { type: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { type: "error"; message: string };

function isGuardMessage(value: unknown): value is GuardMessage {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

/** Starts `command` behind a guard, recording the guard before the command runs. */
export async function spawnGuarded(command: string, args: readonly string[], opts: GuardedSpawnOptions): Promise<GuardedProcess> {
  const output = opts.output ?? "pipe";
  const stdio: StdioOptions = [opts.stdin ?? "ignore", output, output, "ipc"];
  const guard = spawn(process.execPath, ["-e", GUARD_SOURCE], {
    cwd: opts.cwd,
    env: { ...(opts.env ?? process.env), LYKOS_GUARD_SPEC: JSON.stringify({ command, args, cwd: opts.cwd, shell: opts.shell === true }) },
    stdio,
    // POSIX: the guard leads a new process group, which its command joins. Windows: detaching would open a console.
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  let exitInfo: GuardedExit | undefined;
  let commandError: string | undefined;
  const exited = new Promise<GuardedExit>((resolve) => {
    guard.on("message", (m: unknown) => {
      if (isGuardMessage(m) && m.type === "exit") exitInfo = { code: m.code, signal: m.signal };
    });
    guard.on("exit", (code, signal) => resolve(exitInfo ?? { code, signal }));
  });

  const nextMessage = <T extends GuardMessage["type"]>(type: T): Promise<Extract<GuardMessage, { type: T }>> =>
    new Promise((resolve, reject) => {
      const onMessage = (m: unknown): void => {
        if (!isGuardMessage(m)) return;
        if (m.type === "error") {
          commandError = m.message;
          cleanup();
          reject(new Error(`guard: the command did not start: ${m.message}`));
        } else if (m.type === type) {
          cleanup();
          resolve(m as Extract<GuardMessage, { type: T }>);
        }
      };
      const onExit = (code: number | null): void => {
        cleanup();
        reject(new Error(commandError !== undefined ? `guard: the command did not start: ${commandError}` : `guard exited (${code}) before "${type}"`));
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const cleanup = (): void => {
        guard.off("message", onMessage);
        guard.off("exit", onExit);
        guard.off("error", onError);
      };
      guard.on("message", onMessage);
      guard.on("exit", onExit);
      guard.on("error", onError);
    });

  const ready = await nextMessage("ready");
  try {
    await opts.record(ready.pid);
  } catch (err) {
    if (guard.connected) guard.disconnect();
    throw err;
  }
  const startedMessage = nextMessage("started");
  guard.send({ type: "go" });
  const started = await startedMessage;
  return {
    guardPid: ready.pid,
    commandPid: started.pid,
    guard,
    exited,
    release: () => {
      if (guard.connected) guard.disconnect();
    },
  };
}

/**
 * The live processes a guard started, found after the guard itself is gone: its process group on POSIX; on
 * Windows the processes whose parent is the guard's pid and that were created after the guard's record (a
 * later process that reused the pid as a parent was created after the guard died, so the record time alone
 * cannot exclude it; such a child is reported, never killed, by the caller that confirms quiescence).
 * `undefined` when the OS will not say.
 */
export function findGuardedProcesses(guard: { pid: number; recordedAt: number }, platform: NodeJS.Platform = process.platform): number[] | undefined {
  try {
    if (platform === "win32") {
      const script =
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${guard.pid}" -ErrorAction Stop | ` +
        `ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToUniversalTime().ToString('o'))" }`;
      const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        timeout: 15_000,
      });
      return out
        .split(/\r?\n/)
        .map((l) => l.trim().split(" "))
        .filter(([pid, created]) => pid !== undefined && pid !== "" && created !== undefined && Date.parse(created) >= guard.recordedAt)
        .map(([pid]) => Number(pid));
    }
    const out = execFileSync("ps", ["-A", "-o", "pid=,pgid="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out
      .split("\n")
      .map((l) => l.trim().split(/\s+/).map(Number))
      .filter(([pid, pgid]) => pgid === guard.pid && pid !== undefined && Number.isInteger(pid))
      .map(([pid]) => pid!);
  } catch {
    return undefined;
  }
}
