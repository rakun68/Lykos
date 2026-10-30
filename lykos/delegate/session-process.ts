// The production `SessionRunner`: one `lykos session-child` process per MCP
// call. The process is the isolation. A session that crashes, hangs or prints
// cannot take the server down, and two calls never share a process, a working
// directory or an event loop.
//
// The wire is session-protocol.ts: the request goes to the child's stdin as
// one JSON line, and progress and the result come back on its stdout as JSON
// lines. Nothing from the child is ever passed on to this process's stdout
// (which, under `lykos mcp`, belongs to the transport): stdout is parsed, and
// stderr is relayed to this process's stderr.
//
// On Windows the child is `node <entry script>`, never a `.cmd` shim. A shim
// goes through cmd.exe, which cuts an argument at its first newline and makes
// a kill reach the shell and not the process.

import { spawn, type ChildProcess } from "node:child_process";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TrustSource } from "../gate/trust.js";
import { stderrWrite } from "../tui/io-mode.js";
import {
  encodeFrame,
  FrameReader,
  type SessionOutcome,
  type SessionRunner,
  type SessionRunInput,
} from "./session-protocol.js";

/** How `node` is started on Lykos's entry script. */
export interface ChildCommand {
  /** The executable. Default: the node running this process. */
  command: string;
  /** Everything before the session-child subcommand: node flags, then the entry script. */
  args: string[];
}

/**
 * Lykos's own entry script. Built (`dist/cli.js`), it is `node dist/cli.js`;
 * in development (this module is a `.ts` file, loaded by tsx) it is the same
 * with tsx's loader, so a test and a checkout start the same child a user does.
 */
export function defaultChildCommand(): ChildCommand {
  const here = fileURLToPath(import.meta.url);
  const root = dirname(dirname(here));
  if (extname(here) === ".ts") {
    return { command: process.execPath, args: ["--import", import.meta.resolve("tsx"), join(root, "cli.ts")] };
  }
  return { command: process.execPath, args: [join(root, "cli.js")] };
}

export interface ProcessRunnerOptions {
  /** Override how the child is started; tests use it to start a crashing or a chatty one. */
  child?: ChildCommand;
  /** Extra environment for the child, over this process's. */
  env?: NodeJS.ProcessEnv;
  /** After the result arrives, how long a child that has not exited yet is given before it is killed. */
  exitGraceMs?: number;
}

const STDERR_TAIL_CHARS = 4000;

function spawnChildProcess(
  opts: ProcessRunnerOptions,
  workspace: string,
  trustSource: TrustSource,
): ChildProcess {
  const command = opts.child ?? defaultChildCommand();
  return spawn(command.command, [...command.args, "session-child"], {
    cwd: workspace,
    // How the parent established trust travels as a claim; the child checks it against the store itself.
    env: { ...process.env, ...opts.env, LYKOS_TRUST_SOURCE: trustSource },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
}

interface PreAttachedChildState {
  stderrTail?: string | undefined;
  strayTail?: string | undefined;
  spawnError?: Error | undefined;
  reader?: FrameReader | undefined;
}

function runChildProcessSession(
  child: ChildProcess,
  { request, onProgress, signal, onSteerable, onQuestion }: SessionRunInput,
  opts: ProcessRunnerOptions = {},
  initial?: PreAttachedChildState,
): Promise<SessionOutcome> {
  return new Promise<SessionOutcome>((resolve) => {
    let result: SessionOutcome | undefined;
    let spawnError: Error | undefined = initial?.spawnError;
    let stderrTail = initial?.stderrTail ?? "";
    let strayTail = initial?.strayTail ?? "";
    let cancelled = false;
    let stdinEnded = false;
    const reader = initial?.reader ?? new FrameReader();

    const steerFn = (message: string): void => {
      if (stdinEnded || child.stdin!.destroyed || !child.stdin!.writable) return;
      try {
        child.stdin!.write(JSON.stringify({ type: "steer", message }) + "\n");
      } catch {}
    };

    const take = (parsed: ReturnType<FrameReader["push"]>): void => {
      for (const frame of parsed.frames) {
        if (frame.type === "progress") onProgress(frame.message);
        else if (frame.type === "question") onQuestion?.(frame.question);
        else if (result === undefined) result = frame.result;
      }
      for (const line of parsed.stray) strayTail = `${strayTail}${line}\n`.slice(-STDERR_TAIL_CHARS);
    };

    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => take(reader.push(chunk)));
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS);
      stderrWrite(chunk);
    });
    child.stdin!.on("error", () => {
      // The child exited before reading its request; the exit handler reports it.
    });
    child.on("error", (err) => {
      spawnError = err;
    });

    const kill = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    };
    const onAbort = (): void => {
      cancelled = true;
      kill();
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });

    let graceTimer: NodeJS.Timeout | undefined;
    const finishWhenResult = setInterval(() => {
      if (result === undefined || graceTimer !== undefined) return;
      stdinEnded = true;
      // The child has said everything it will. Closing its stdin lets it exit; a child that lingers is killed.
      child.stdin!.end();
      graceTimer = setTimeout(kill, opts.exitGraceMs ?? 5000);
      graceTimer.unref();
    }, 20);
    finishWhenResult.unref();

    child.on("close", (code, sig) => {
      stdinEnded = true;
      clearInterval(finishWhenResult);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      signal.removeEventListener("abort", onAbort);
      take(reader.end());
      if (result !== undefined) {
        resolve(result);
        return;
      }
      if (cancelled) {
        resolve({ outcome: "error", message: "the call was cancelled; the session process was stopped" });
        return;
      }
      const how = spawnError !== undefined ? `could not be started: ${spawnError.message}` : sig !== null ? `was killed by ${sig}` : `exited with code ${code}`;
      const said = stderrTail.trim() || strayTail.trim();
      resolve({
        outcome: "error",
        message: `the session process ${how} before reporting a result${said ? `\n${said}` : ""}`,
        ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      });
    });

    child.stdin!.write(encodeFrame(request));
    onSteerable?.(steerFn);
  });
}

export function createProcessRunner(opts: ProcessRunnerOptions = {}): SessionRunner {
  return (input) => {
    let child: ChildProcess;
    try {
      child = spawnChildProcess(opts, input.request.workspace, input.trustSource);
    } catch (err) {
      return Promise.resolve({
        outcome: "error",
        message: `could not start the session process: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return runChildProcessSession(child, input, opts);
  };
}

export interface WarmPool {
  run: SessionRunner;
  warm(workspace: string, trustSource: TrustSource): void;
  idlePids(workspace?: string, trustSource?: TrustSource): number[];
  shutdown(): Promise<void>;
}

interface IdleChild {
  child: ChildProcess;
  workspace: string;
  trustSource: TrustSource;
  getStderrTail(): string;
  getStrayTail(): string;
  getSpawnError(): Error | undefined;
  reader: FrameReader;
  onStderr: (chunk: string) => void;
  onData: (chunk: string) => void;
  onError: (err: Error) => void;
  onExitOrClose: () => void;
}

function canonicalWorkspace(workspace: string): string {
  return process.platform === "win32" ? resolve(workspace).toLowerCase() : resolve(workspace);
}

function poolKey(workspace: string, trustSource: TrustSource): string {
  return `${canonicalWorkspace(workspace)}::${trustSource}`;
}

export function createWarmPool(opts: ProcessRunnerOptions & { size: number }): WarmPool {
  const pool = new Map<string, IdleChild[]>();
  let isShutdown = false;
  let shutdownPromise: Promise<void> | undefined;

  const removeIdleChild = (entry: IdleChild): void => {
    const key = poolKey(entry.workspace, entry.trustSource);
    const list = pool.get(key);
    if (!list) return;
    const idx = list.indexOf(entry);
    if (idx >= 0) {
      list.splice(idx, 1);
    }
    if (list.length === 0) {
      pool.delete(key);
    }
  };

  const spawnIdle = (workspace: string, trustSource: TrustSource): IdleChild | undefined => {
    let child: ChildProcess;
    try {
      child = spawnChildProcess(opts, workspace, trustSource);
    } catch {
      return undefined;
    }

    let stderrTail = "";
    let strayTail = "";
    let spawnError: Error | undefined;
    const reader = new FrameReader();

    const onError = (err: Error): void => {
      spawnError = err;
    };
    child.on("error", onError);
    child.stdin?.on("error", () => {});

    if (child.pid === undefined) return undefined;

    child.stderr!.setEncoding("utf8");
    const onStderr = (chunk: string): void => {
      stderrTail = `${stderrTail}${chunk}`.slice(-STDERR_TAIL_CHARS);
      stderrWrite(chunk);
    };
    child.stderr!.on("data", onStderr);

    child.stdout!.setEncoding("utf8");
    const onData = (chunk: string): void => {
      const parsed = reader.push(chunk);
      for (const line of parsed.stray) {
        strayTail = `${strayTail}${line}\n`.slice(-STDERR_TAIL_CHARS);
      }
    };
    child.stdout!.on("data", onData);

    const entry: IdleChild = {
      child,
      workspace,
      trustSource,
      getStderrTail: () => stderrTail,
      getStrayTail: () => strayTail,
      getSpawnError: () => spawnError,
      reader,
      onStderr,
      onData,
      onError,
      onExitOrClose: () => {
        removeIdleChild(entry);
      },
    };

    child.once("exit", entry.onExitOrClose);
    child.once("close", entry.onExitOrClose);
    return entry;
  };

  const refillKey = (workspace: string, trustSource: TrustSource): void => {
    if (isShutdown || opts.size <= 0) return;
    const key = poolKey(workspace, trustSource);
    let list = pool.get(key);
    if (!list) {
      list = [];
      pool.set(key, list);
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i]!.child;
      if (c.exitCode !== null || c.signalCode !== null) {
        list.splice(i, 1);
      }
    }
    while (list.length < opts.size) {
      const entry = spawnIdle(workspace, trustSource);
      if (!entry) break;
      list.push(entry);
    }
    if (list.length === 0) {
      pool.delete(key);
    }
  };

  const takeIdleChild = (workspace: string, trustSource: TrustSource): IdleChild | undefined => {
    const key = poolKey(workspace, trustSource);
    const list = pool.get(key);
    if (!list) return undefined;
    while (list.length > 0) {
      const entry = list.shift()!;
      if (list.length === 0) {
        pool.delete(key);
      }
      entry.child.removeListener("exit", entry.onExitOrClose);
      entry.child.removeListener("close", entry.onExitOrClose);
      entry.child.stderr!.removeListener("data", entry.onStderr);
      entry.child.stdout!.removeListener("data", entry.onData);
      entry.child.removeListener("error", entry.onError);

      if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
        continue;
      }
      return entry;
    }
    return undefined;
  };

  const run: SessionRunner = (input) => {
    const { request, trustSource } = input;
    let entry: IdleChild | undefined;
    if (!isShutdown && opts.size > 0) {
      entry = takeIdleChild(request.workspace, trustSource);
    }

    if (entry) {
      if (!isShutdown && opts.size > 0) {
        refillKey(request.workspace, trustSource);
      }
      return runChildProcessSession(entry.child, input, opts, {
        stderrTail: entry.getStderrTail(),
        strayTail: entry.getStrayTail(),
        spawnError: entry.getSpawnError(),
        reader: entry.reader,
      });
    }

    // Cold path
    let child: ChildProcess;
    try {
      child = spawnChildProcess(opts, request.workspace, trustSource);
    } catch (err) {
      return Promise.resolve({
        outcome: "error",
        message: `could not start the session process: ${err instanceof Error ? err.message : String(err)}`,
      });
    }

    if (!isShutdown && opts.size > 0) {
      refillKey(request.workspace, trustSource);
    }

    return runChildProcessSession(child, input, opts);
  };

  const warm = (workspace: string, trustSource: TrustSource): void => {
    if (isShutdown || opts.size <= 0) return;
    refillKey(workspace, trustSource);
  };

  const idlePids = (workspace?: string, trustSource?: TrustSource): number[] => {
    if (isShutdown) return [];
    const pids: number[] = [];
    const targetWs = workspace !== undefined ? canonicalWorkspace(workspace) : undefined;
    for (const list of pool.values()) {
      for (const entry of list) {
        if (targetWs !== undefined && canonicalWorkspace(entry.workspace) !== targetWs) continue;
        if (trustSource !== undefined && entry.trustSource !== trustSource) continue;
        if (entry.child.exitCode === null && entry.child.signalCode === null && entry.child.pid !== undefined) {
          pids.push(entry.child.pid);
        }
      }
    }
    return pids;
  };

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    isShutdown = true;

    const allIdle: IdleChild[] = [];
    for (const list of pool.values()) {
      allIdle.push(...list);
    }
    pool.clear();

    if (allIdle.length === 0) {
      shutdownPromise = Promise.resolve();
      return shutdownPromise;
    }

    shutdownPromise = new Promise<void>((resolve) => {
      let remaining = allIdle.length;
      const checkDone = () => {
        remaining--;
        if (remaining <= 0) {
          resolve();
        }
      };

      for (const entry of allIdle) {
        const { child } = entry;
        entry.child.removeListener("exit", entry.onExitOrClose);
        entry.child.removeListener("close", entry.onExitOrClose);
        if (child.exitCode !== null || child.signalCode !== null) {
          checkDone();
        } else {
          child.once("close", checkDone);
          try {
            child.kill();
          } catch {
            if (child.exitCode !== null || child.signalCode !== null) {
              checkDone();
            }
          }
        }
      }
    });

    return shutdownPromise;
  };

  return { run, warm, idlePids, shutdown };
}
