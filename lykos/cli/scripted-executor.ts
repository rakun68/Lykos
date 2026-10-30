// A stand-in executor for the scripted-model seam.
//
// It starts nothing. Each command a session hands its executor is recorded and
// answered from a script, so a test can say which commands reached the executor
// and what they were, and can make a command fail or print without a real
// process behind it. The same seam is where a stand-in container runtime plugs
// in once containment exists.

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { ExecChild, ExecSpawnOptions, ProjectExecutor } from "../tools/executor.js";

/** One command the session started through the executor. */
export interface RecordedOperation {
  /** `shell` is the `bash`/`powershell` tools' operations; `spawn` is every other tool's process. */
  via: "shell" | "spawn";
  /** For `shell`: which tool. */
  shell?: "bash" | "powershell";
  command: string;
  args: string[];
  cwd: string | undefined;
}

/** What a scripted command does. All fields default to "exit 0 with no output". */
export interface ScriptedProcess {
  stdout?: string;
  stderr?: string;
  /** `null` is a command killed by a signal; `signal` says which (otherwise none is reported). */
  exitCode?: number | null;
  signal?: NodeJS.Signals;
  /** The command never finishes on its own; only a `kill` ends it (as a timeout or an abort would). */
  hang?: boolean;
}

export type ScriptedProcessResponder = (op: RecordedOperation) => ScriptedProcess | undefined;

export interface StandInExecutor {
  executor: ProjectExecutor;
  /** Every command started, in order. */
  operations: RecordedOperation[];
}

export class FakeChild extends EventEmitter implements ExecChild {
  readonly pid: number | undefined = undefined;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  private closed = false;

  constructor(private readonly scripted: ScriptedProcess) {
    super();
    if (this.scripted.hang === true) return;
    setImmediate(() => {
      if (this.scripted.stdout) this.stdout.write(this.scripted.stdout);
      if (this.scripted.stderr) this.stderr.write(this.scripted.stderr);
      this.finish(this.scripted.exitCode === undefined ? 0 : this.scripted.exitCode, this.scripted.signal ?? null);
    });
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", code, signal));
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.finish(null, typeof signal === "string" ? signal : "SIGTERM");
    return true;
  }
}

export function standInExecutor(respond: ScriptedProcessResponder = () => undefined): StandInExecutor {
  const operations: RecordedOperation[] = [];
  const answer = (op: RecordedOperation): ScriptedProcess => {
    operations.push(op);
    return respond(op) ?? {};
  };
  const executor: ProjectExecutor = {
    name: "stand-in",
    spawn: (command, args, options: ExecSpawnOptions) =>
      new FakeChild(answer({ via: "spawn", command, args: [...args], cwd: options.cwd })),
    shellOperations: (shell): BashOperations => ({
      async exec(command, cwd, options) {
        const scripted = answer({ via: "shell", shell, command, args: [], cwd });
        if (scripted.stdout) options.onData(Buffer.from(scripted.stdout, "utf8"));
        if (scripted.stderr) options.onData(Buffer.from(scripted.stderr, "utf8"));
        return { exitCode: scripted.exitCode === undefined ? 0 : scripted.exitCode };
      },
    }),
  };
  return { executor, operations };
}
