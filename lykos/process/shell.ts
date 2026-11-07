// One shell, guarded (T247, ADR-0060, spec decision 19).
//
// Every host shell Lykos runs resolves the bash Pi resolves: an explicit shell path, else Git Bash in its known
// places on Windows, else bash on PATH (`getShellConfig`, Pi's own resolver, not a copy of it). A harness command
// (`shell: true`: verification, red checks, hooks, the post-edit check, jobs) runs as `<bash> -c <line>`, so it
// never lands in cmd.exe on Windows.
//
// A delegated session's executor runs every host process behind a spawn guard (lykos/process/guard.ts), recorded
// in `process_records` before its command starts: the `bash` and `powershell` tools through a `BashOperations`
// backend of Lykos's own (Pi's pluggable interface, no patch), and every other process the executor starts. Pi's
// local backend spawns directly, so no spawn wrapper could see it.
//
// Stated limit: host git, `gh`, the commit tool and language servers run directly from the session child, bounded
// by their own timeouts; the session child's confirmed death covers them (ADR-0060, "Limits, stated").

import { EventEmitter } from "node:events";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { Readable, Writable } from "node:stream";
import { getPowerShellConfig, getShellConfig, type BashOperations } from "@earendil-works/pi-coding-agent";
import { startGuard, type StartedGuard } from "./guard.js";
import { killProcessTree } from "../tools/job-runner.js";
import { bashCommandLine, noBashMessage, resolveHostBash, type ResolvedShell } from "./host-bash.js";
import type { ExecChild, ExecSpawnOptions, ProjectExecutor } from "../tools/executor.js";

/** Writes a guard's process record. Synchronous or not; a throw means the command never runs. */
export type RecordGuard = (guardPid: number, command: string) => void | Promise<void>;

/**
 * A process behind a guard, as the executor's callers see a child process. `pid` is the guard's: a tree kill on it
 * reaches the command (the guard's process group on POSIX, its tree on Windows). `kill` lets go of the guard, which
 * kills its command's tree. A record that fails is an `error`, and the close code is 127.
 */
class GuardedChild extends EventEmitter implements ExecChild {
  readonly pid: number | undefined;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly stdin: Writable | null;
  private failed: Error | undefined;

  constructor(private readonly g: StartedGuard) {
    super();
    this.pid = g.guard.pid;
    this.stdout = g.guard.stdout;
    this.stderr = g.guard.stderr;
    this.stdin = g.guard.stdin;
    g.started.catch((err: unknown) => {
      this.failed = err instanceof Error ? err : new Error(String(err));
      this.emit("error", this.failed);
    });
    g.guard.on("error", (err) => {
      if (this.failed === undefined) this.emit("error", err);
    });
    g.guard.on("close", (code, signal) => {
      this.emit("close", this.failed !== undefined && code === 0 ? 127 : code, signal);
    });
  }

  kill(): boolean {
    this.g.release();
    return true;
  }
}

/** Starts `command` behind a guard and returns it as an `ExecChild`. */
export function guardedChild(command: string, args: readonly string[], options: ExecSpawnOptions, record: RecordGuard): ExecChild {
  const stdin = Array.isArray(options.stdio) ? options.stdio[0] : "pipe";
  const label = [command, ...args].join(" ");
  const g = startGuard(command, args, {
    cwd: options.cwd ?? process.cwd(),
    ...(options.env !== undefined ? { env: options.env } : {}),
    stdin,
    output: "pipe",
    record: (guardPid) => record(guardPid, label),
  });
  return new GuardedChild(g);
}

const MAX_TIMEOUT_MS = 2_147_483_647;

/** Pi's timeout rule, unchanged: seconds, finite, positive, at most what a timer holds. */
function timeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
  const ms = timeout * 1000;
  if (ms > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
  return ms;
}

/** How long output may keep arriving after the command exits before the pipes are let go (Pi's grace). */
const EXIT_STDIO_GRACE_MS = 100;

/**
 * Pi's local shell backend, run through a guard: the same shell resolution, environment, timeout, abort and exit
 * semantics (`aborted`, `timeout:<s>`, `{ exitCode }`), with the guard recorded before the command starts.
 */
export function createGuardedShellOperations(shellName: "bash" | "powershell", resolveShell: () => ResolvedShell, record: RecordGuard): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const ms = timeoutMs(timeout);
      if (signal?.aborted) throw new Error("aborted");
      const shell = resolveShell();
      try {
        await access(cwd, constants.F_OK);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
      }
      const fromStdin = shell.commandTransport === "stdin";
      const g = startGuard(shell.shell, fromStdin ? shell.args : [...shell.args, command], {
        cwd,
        env: env ?? process.env,
        stdin: fromStdin ? "pipe" : "ignore",
        output: "pipe",
        record: (guardPid) => record(guardPid, command),
      });
      if (fromStdin) {
        g.guard.stdin?.on("error", () => {});
        g.guard.stdin?.end(command);
      }
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      const stop = (): void => {
        g.release();
        // A guard that does not answer its pipe is killed with its tree.
        void killProcessTree(g.guard.pid);
      };
      const onAbort = (): void => stop();
      g.guard.stdout?.on("data", onData);
      g.guard.stderr?.on("data", onData);
      try {
        if (ms !== undefined) {
          timer = setTimeout(() => {
            timedOut = true;
            stop();
          }, ms);
        }
        if (signal !== undefined) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
        await g.started.catch((err: unknown) => {
          if (signal?.aborted || timedOut) return;
          throw err;
        });
        const exit = await g.exited;
        await drain(g);
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode: exit.code };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** Waits for the guard's pipes to end, or to fall idle for the grace period after exit. */
function drain(g: StartedGuard): Promise<void> {
  const streams = [g.guard.stdout, g.guard.stderr].filter((s): s is Readable => s !== null && !s.readableEnded);
  if (streams.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    let open = streams.length;
    let timer: NodeJS.Timeout = setTimeout(done, EXIT_STDIO_GRACE_MS);
    function done(): void {
      clearTimeout(timer);
      for (const s of streams) {
        s.off("end", onEnd);
        s.off("data", onChunk);
        s.destroy();
      }
      resolve();
    }
    function onEnd(): void {
      open -= 1;
      if (open === 0) done();
    }
    function onChunk(): void {
      clearTimeout(timer);
      timer = setTimeout(done, EXIT_STDIO_GRACE_MS);
    }
    for (const s of streams) {
      s.on("end", onEnd);
      s.on("data", onChunk);
    }
  });
}

/** Pi's PowerShell prefix (`core/tools/powershell.js`, not exported): UTF-8 output. */
const UTF8_OUTPUT_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";

function powerShellOperations(ops: BashOperations): BashOperations {
  return { exec: (command, cwd, options) => ops.exec(`${UTF8_OUTPUT_PREFIX}${command}`, cwd, options) };
}

export interface GuardedExecutorOptions {
  /** `delegation.shell_path`: the bash to use before Pi's search order. Empty: Pi's order. */
  shellPath?: string;
  record: RecordGuard;
}

/**
 * A delegated session's executor: every process it starts runs behind a recorded guard, and a shell line runs in
 * the resolved bash.
 */
export function createGuardedExecutor(opts: GuardedExecutorOptions): ProjectExecutor {
  const shellPath = opts.shellPath !== undefined && opts.shellPath.trim() !== "" ? opts.shellPath : undefined;
  return {
    name: "local",
    spawn: (command, args, options) => {
      if (options.shell === true) {
        const line = [command, ...args].join(" ");
        const bash = bashCommandLine(line, shellPath);
        if (bash === undefined) {
          const resolution = resolveHostBash(shellPath);
          throw new Error(noBashMessage(resolution.ok ? { message: "a bash resolved, then none did" } : resolution));
        }
        return guardedChild(bash.command, bash.args, options, opts.record);
      }
      return guardedChild(command, args, options, opts.record);
    },
    shellOperations: (shell) =>
      shell === "bash"
        ? createGuardedShellOperations("bash", () => getShellConfig(shellPath), opts.record)
        : powerShellOperations(createGuardedShellOperations("powershell", () => getPowerShellConfig(), opts.record)),
  };
}
