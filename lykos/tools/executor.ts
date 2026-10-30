// The session's executor: the one place a project command is started from.
//
// Every tool that runs code the project or the model chose — `bash`,
// `powershell`, `eval`'s runtimes, background jobs, the post-edit check, the
// gate's test command and its rerun, shell hooks — starts its process here
// rather than calling `child_process` itself. That is what lets a session run
// them somewhere else (a container, ADR-0036) by handing it a different
// executor, with nothing about the tools changing.
//
// What does NOT go through here: the file tools, checkpoints, `lsp`, `gh`, the
// repo map and project identity. Those stay on the host by design (ADR-0036),
// and an executor that was ever handed them would be a way of pretending they
// are contained.
//
// The executor sits BENEATH the gate. `gate/approval.ts` still asks for
// approval and applies the risk tier, and only then calls the executor, so
// which executor a session has cannot change what it is asked to approve.

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import type { Readable, Writable } from "node:stream";
import {
  createLocalBashOperations,
  createLocalPowerShellOperations,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";

/** What a shell reports for a command a signal ended: 128 plus the signal's number. 128 when the signal is not known, so it is still not 0. */
export function exitCodeOfSignal(signal: NodeJS.Signals | null): number {
  const n = signal === null ? undefined : osConstants.signals[signal];
  return 128 + (n ?? 0);
}

/** The part of a child process the session's tools use. A `ChildProcess` is one. */
export interface ExecChild {
  readonly pid?: number | undefined;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly stdin: Writable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (err: Error) => void): this;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface ExecSpawnOptions {
  cwd?: string;
  /** `true` runs `command` as a shell line (`args` is then empty); absent runs it as a program with `args`. */
  shell?: boolean;
  windowsHide?: boolean;
  detached?: boolean;
  env?: NodeJS.ProcessEnv;
  stdio?: "pipe" | ["pipe" | "ignore", "pipe", "pipe"];
  /** `true` returns stdout and stderr as the command wrote them, with `/work` paths untranslated; set only by a caller that parses the output and never shows it to the model. */
  containerPaths?: boolean;
}

export interface ProjectExecutor {
  /** Names the executor in a record: `local`, or what a contained one calls itself. */
  readonly name: string;
  /** Start a process. The caller owns its lifetime: it listens for `close` and kills it. */
  spawn(command: string, args: readonly string[], options: ExecSpawnOptions): ExecChild;
  /** What the `bash` and `powershell` tools run their commands with. The gate wraps these. */
  shellOperations(shell: "bash" | "powershell"): BashOperations;
}

/** Runs commands on this machine, as every session did before the executor existed. */
export const localExecutor: ProjectExecutor = {
  name: "local",
  spawn: (command, args, options) => {
    const { containerPaths: _containerPaths, ...childOptions } = options;
    return spawn(command, [...args], childOptions);
  },
  shellOperations: (shell) => (shell === "bash" ? createLocalBashOperations() : createLocalPowerShellOperations()),
};
