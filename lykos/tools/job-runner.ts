// Background jobs, and the one kill in this codebase that kills a tree.
//
// **The kill is the whole ticket.** A kill that reports success and leaves the
// real process running is worse than no backgrounding at all: the model is
// told the dev server is stopped, the port is still held, and the next thing
// that fails does so for a reason nothing in the transcript explains. So the
// kill is platform-split and the split is not a detail (D3):
//
//   - POSIX: the child is spawned with `detached: true` so it LEADS ITS OWN
//     PROCESS GROUP, and `process.kill(-pid, signal)` signals the group. The
//     shell, the script it ran and the runtime that script started are all in
//     that group, so one call reaches all three.
//   - Windows: the child is spawned with `detached: false` — detaching opens
//     a console window, which is not something a coding agent may do to
//     somebody's desktop — and the tree is reaped by the operating system's
//     own tree kill, `taskkill /PID <pid> /T /F`, run as a child process.
//
// **The tree is NEVER enumerated from this process.** Walking the descendants
// and killing them one at a time is the obvious implementation and it is a
// known failure mode: a process that spawns between the enumeration and the
// kill is not in the list, survives, and the tool reports success anyway.
// `/T` and the process group both push that race into the kernel, which is
// the only place it can be won.
//
// **No dependency.** The package usually reached for here was last released in
// 2019 and does, in its Windows branch, exactly the `taskkill` call below.
// AGENTS.md rule 3: adopt what installs, reimplement what does not — and a
// fifteen-line kill that this project must own outright (it is the difference
// between a stopped process and a lie about one) is not a dependency.
//
// **WHY THE REGISTRY IS PASSED IN, NOT A MODULE SINGLETON (D2).** Two sessions
// can share one process — every MCP worker, every test file — and a
// module-level map is what lets one of them stop the other's jobs and inherit
// the other's orphans. `JobRegistry` is created per session in `loadTools()`,
// carried on the booted session, and emptied by `stopAll()` at teardown, so
// "who kills these processes" has exactly one answer. That is `LspServerPool`'s
// shape and it is deliberately the same shape.
//
// **Output streams to a file (D5).** `.lykos/jobs/<job-id>.log`, opened on
// start and written from both stdout and stderr as they arrive, so `logs` can
// read a running job. Runtime state lives in `.lykos/`, never `.pi/`
// (AGENTS.md rule 8). A hard byte cap kills the tree and the job's reason says
// the cap is why it died — a truncated log and a mystery is the outcome that
// costs a debugging session.
//
// **D9: the two other callers.** The same failure showed up in the post-edit
// runner and the verification runner: both spawn through a shell and kill the
// direct child, which on Windows is the command
// interpreter, leaving the type-checker or the test runner alive. Both now
// call `killProcessTree` here. One kill, one implementation — a second one
// would be a second thing to get wrong, and the wrong one would be the one
// nobody reads.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, openSync, readSync, closeSync, statSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { localExecutor, type ExecChild, type ProjectExecutor } from "./executor.js";

// ---------------------------------------------------------------------------
// The kill (D3)
// ---------------------------------------------------------------------------

/**
 * The spawn options a process must be started with for `killProcessTree` to be
 * able to do its job.
 *
 * Exported and shared rather than spelled out at each of the three call sites,
 * because the spawn and the kill are two halves of one decision: `detached`
 * on POSIX is precisely what makes `kill(-pid)` mean "the group", and a caller
 * that forgets it gets a kill that silently reaches one process. On Windows
 * `detached: true` would open a console window and `/T` does not need it.
 */
export const TREE_KILL_SPAWN_OPTIONS: { detached: boolean } = {
  detached: process.platform !== "win32",
};

/** How long `taskkill` is given before it is treated as having failed. It normally returns in tens of milliseconds. */
export const TREE_KILL_TIMEOUT_MS = 20_000;

export interface KillTreeOutcome {
  /** Which mechanism ran. Recorded because "which kill did we actually use" is the first question when one does not work. */
  method: "taskkill" | "process-group" | "direct" | "none";
  /** `taskkill`'s exit code, when that is what ran. 128 means the pid was already gone, which is a success. */
  code?: number | null;
  /** Set when the mechanism itself failed. Never a reason to believe the process is dead. */
  error?: string;
}

function taskkill(pid: number): Promise<KillTreeOutcome> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (outcome: KillTreeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(outcome);
    };
    // `/T` is the tree, `/F` is forceful. Both are required: without `/T` this
    // is the same single-process kill the defect is about, and without `/F`
    // `taskkill` asks politely, which a console-less child never answers.
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Killing the killer is best-effort; the outcome below is the answer.
      }
      finish({ method: "taskkill", error: `taskkill did not return within ${TREE_KILL_TIMEOUT_MS}ms` });
    }, TREE_KILL_TIMEOUT_MS);
    child.on("error", (err) => finish({ method: "taskkill", error: (err as Error).message }));
    child.on("close", (code) => finish({ method: "taskkill", code }));
  });
}

/**
 * Kill `pid` and everything it started.
 *
 * The signal argument is POSIX-only and is ignored on Windows, which has no
 * signals — `taskkill /F` is a terminate, full stop. That asymmetry is real
 * and is left visible rather than papered over with a fake `SIGTERM` branch.
 *
 * On POSIX the group kill is tried first and a direct kill is the fallback,
 * for the one case where it is right: a caller that spawned without
 * `TREE_KILL_SPAWN_OPTIONS` has no group to signal, and `kill(-pid)` answers
 * ESRCH. Falling back means such a caller still kills its direct child instead
 * of nothing at all — it does not mean the tree is gone, which is why the
 * outcome says which branch ran.
 */
export async function killProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals = "SIGKILL",
): Promise<KillTreeOutcome> {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
    return { method: "none", error: "no pid" };
  }
  if (process.platform === "win32") return await taskkill(pid);
  try {
    process.kill(-pid, signal);
    return { method: "process-group" };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ESRCH" && code !== "EPERM") {
      return { method: "process-group", error: (err as Error).message };
    }
    try {
      process.kill(pid, signal);
      return { method: "direct" };
    } catch (innerErr) {
      const innerCode = (innerErr as { code?: string }).code;
      // ESRCH here means there is nothing left to kill, which is the outcome
      // the caller wanted.
      if (innerCode === "ESRCH") return { method: "direct" };
      return { method: "direct", error: (innerErr as Error).message };
    }
  }
}

/** How long a kill of a process with no pid of ours waits for it to close before reporting. */
const EXEC_KILL_WAIT_MS = 5_000;

/**
 * `killProcessTree` for a child of the session's executor. A process on this
 * machine has a pid and is killed as before. A command in a container has none
 * (its pid, if it had one, would be the exec client's), so it is stopped through
 * the child's own `kill`, which reaches inside the container, and this waits
 * for it to close. Without this a timed-out test run in a container kept running.
 */
export async function killExecChild(child: ExecChild, signal: NodeJS.Signals = "SIGKILL"): Promise<KillTreeOutcome> {
  if (child.pid !== undefined) return killProcessTree(child.pid, signal);
  const closed = new Promise<void>((done) => child.once("close", () => done()));
  if (!child.kill(signal)) return { method: "none", error: "already closed" };
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([closed, new Promise<void>((done) => (timer = setTimeout(done, EXEC_KILL_WAIT_MS)))]);
  clearTimeout(timer);
  return { method: "direct" };
}

// ---------------------------------------------------------------------------
// The registry (D2)
// ---------------------------------------------------------------------------

/** Where a job's output goes. `.lykos/`, never `.pi/` (AGENTS.md rule 8). */
export function jobsDirectory(cwd: string): string {
  return join(cwd, ".lykos", "jobs");
}

/**
 * The hard byte cap (D5). Four megabytes is a lot of console output — a
 * failing test suite that prints for an hour — and it is small enough that a
 * runaway writer is stopped before it matters to a disk.
 */
export const JOB_LOG_MAX_BYTES = 4 * 1024 * 1024;

/** The default window `logs` returns when no explicit one was asked for. */
export const JOB_LOG_DEFAULT_LINES = 50;

/** The most one `logs` call returns, however many lines were asked for. */
export const JOB_LOG_MAX_READ_BYTES = 40_000;

/** How long a stopped job is given to actually exit before `stop` returns anyway. */
export const JOB_STOP_GRACE_MS = 15_000;

export type JobStatus = "running" | "exited" | "stopped" | "capped" | "failed";

export interface JobRecord {
  id: string;
  command: string;
  /** The operating-system process id of the shell this job's command runs in. Undefined only if the spawn itself failed. */
  pid: number | undefined;
  logPath: string;
  startedAt: string;
  endedAt?: string;
  status: JobStatus;
  exitCode?: number | null;
  /** Why it is no longer running, in the words the model is shown. Set for `capped` and `failed`. */
  reason?: string;
  /** Bytes written to the log so far. The cap is measured against this. */
  bytes: number;
}

interface JobEntry extends JobRecord {
  child: ExecChild | undefined;
  stream: WriteStream | undefined;
  /** Resolves when the shell process has exited, whatever ended it. */
  done: Promise<void>;
}

export interface JobRegistryOpts {
  cwd: string;
  /** T184: where the project's `.lykos/jobs` is, when `cwd` is a worktree. Absent, `cwd`. */
  stateRoot?: string;
  /** Overridable so a test can hit the cap without writing four megabytes. */
  maxLogBytes?: number;
  /** T172: where a job's command runs. Absent means this machine. */
  executor?: ProjectExecutor;
}

export interface StartJobOpts {
  command: string;
  /** Where the command runs. Defaults to the registry's cwd, the project root. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface LogWindow {
  text: string;
  /** Byte offset to pass back as `offset` to read what comes next. */
  nextOffset: number;
  /** Total bytes in the log right now. */
  size: number;
  /** True when the window ends at the end of the file. */
  atEnd: boolean;
}

function publicRecord(entry: JobEntry): JobRecord {
  return {
    id: entry.id,
    command: entry.command,
    pid: entry.pid,
    logPath: entry.logPath,
    startedAt: entry.startedAt,
    status: entry.status,
    bytes: entry.bytes,
    ...(entry.endedAt !== undefined ? { endedAt: entry.endedAt } : {}),
    ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
  };
}

/**
 * One session's background jobs.
 *
 * Created per session and handed to the `hub` tool the way `TaskListState` is
 * (D2). The session owns it; the tool only asks it things.
 */
export class JobRegistry {
  private readonly jobs = new Map<string, JobEntry>();
  private readonly maxLogBytes: number;

  constructor(private readonly opts: JobRegistryOpts) {
    this.maxLogBytes = opts.maxLogBytes ?? JOB_LOG_MAX_BYTES;
  }

  get cwd(): string {
    return this.opts.cwd;
  }

  private mintId(): string {
    for (;;) {
      const id = `job-${randomBytes(3).toString("hex")}`;
      if (!this.jobs.has(id)) return id;
    }
  }

  /**
   * Spawn, and return before the command finishes.
   *
   * `shell: true` because the model writes command LINES — pipes, redirects,
   * `&&` — exactly as it does for `bash`, and because the whole point of the
   * kill above is that a shell in the middle is survivable. stdin is `ignore`:
   * a background job has nobody to type at it, and a job that blocks on a
   * prompt forever with an inherited stdin would also be stealing the
   * interactive session's keystrokes.
   */
  start(opts: StartJobOpts): JobRecord {
    const id = this.mintId();
    const dir = jobsDirectory(this.opts.stateRoot ?? this.opts.cwd);
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, `${id}.log`);
    // Truncated SYNCHRONOUSLY before the stream opens, because `start` returns
    // this path to the model and `createWriteStream` does not open the file
    // until the event loop turns — so without this the very next thing the
    // model does with the path it was just handed can fail on a file that does
    // not exist yet.
    closeSync(openSync(logPath, "w"));
    const stream = createWriteStream(logPath, { flags: "a" });
    // A log that can no longer be written — its directory removed under it —
    // is not a reason to crash the process with an unhandled `error`. What was
    // written is still readable; the job itself is unaffected.
    stream.on("error", () => undefined);
    const startedAt = new Date().toISOString();

    let resolveDone: () => void = () => undefined;
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    // `done` means the job is over AND its log is closed. `stop`/`stopAll`
    // await it, so a caller that tears the directory down afterwards never
    // races the stream's still-pending open or final write.
    const finish = (s: WriteStream | undefined): void => {
      if (s === undefined || s.closed) {
        resolveDone();
        return;
      }
      s.once("close", () => resolveDone());
      s.end();
    };

    const entry: JobEntry = {
      id,
      command: opts.command,
      pid: undefined,
      logPath,
      startedAt,
      status: "running",
      bytes: 0,
      child: undefined,
      stream,
      done,
    };
    this.jobs.set(id, entry);

    let child: ExecChild;
    try {
      child = (this.opts.executor ?? localExecutor).spawn(opts.command, [], {
        cwd: opts.cwd ?? this.opts.cwd,
        shell: true,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        ...TREE_KILL_SPAWN_OPTIONS,
        ...(opts.env !== undefined ? { env: opts.env } : {}),
      });
    } catch (err) {
      entry.status = "failed";
      entry.reason = (err as Error).message;
      entry.endedAt = new Date().toISOString();
      entry.stream = undefined;
      finish(stream);
      return publicRecord(entry);
    }

    entry.child = child;
    entry.pid = child.pid;

    const append = (chunk: Buffer): void => {
      if (entry.stream === undefined) return;
      // Past the cap nothing more is written, though the bytes are still
      // counted so `ps` reports how far over it went. A kill is not instant —
      // the process has a moment to print more — and continuing to write
      // during it would make the cap a suggestion rather than a cap.
      if (entry.status === "capped") {
        entry.bytes += chunk.length;
        return;
      }
      entry.bytes += chunk.length;
      entry.stream.write(chunk);
      if (entry.bytes > this.maxLogBytes && entry.status === "running") {
        // D5: the cap KILLS the job and says so. Silently truncating leaves a
        // process still running and a log that stops mid-sentence, which is
        // the version of this that costs somebody an afternoon.
        entry.status = "capped";
        entry.reason =
          `output passed the ${this.maxLogBytes}-byte cap, so the job was killed. ` +
          `Re-run it writing less to stdout, or redirect its output to a file yourself.`;
        void (entry.child !== undefined ? killExecChild(entry.child) : killProcessTree(entry.pid));
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    child.on("error", (err) => {
      // A command that could not be started at all. Distinct from one that ran
      // and failed, and it must not be reported as the latter.
      if (entry.status === "running") {
        entry.status = "failed";
        entry.reason = (err as Error).message;
      }
      entry.endedAt = entry.endedAt ?? new Date().toISOString();
      entry.child = undefined;
      const s = entry.stream;
      entry.stream = undefined;
      finish(s);
    });

    child.on("close", (code) => {
      if (entry.status === "running") {
        entry.status = "exited";
        entry.exitCode = code;
      } else if (entry.exitCode === undefined) {
        entry.exitCode = code;
      }
      entry.endedAt = entry.endedAt ?? new Date().toISOString();
      entry.child = undefined;
      const s = entry.stream;
      entry.stream = undefined;
      finish(s);
    });

    return publicRecord(entry);
  }

  get(id: string): JobRecord | undefined {
    const entry = this.jobs.get(id);
    return entry === undefined ? undefined : publicRecord(entry);
  }

  list(): JobRecord[] {
    return [...this.jobs.values()].map(publicRecord);
  }

  /**
   * A window of a job's log, by tail or by byte offset.
   *
   * Reading is synchronous and re-opens the file each call rather than holding
   * a handle: the writer is a stream in this same process and a job can be
   * read long after it exited, so there is no handle worth keeping.
   */
  logs(id: string, opts: { lines?: number; offset?: number } = {}): LogWindow | undefined {
    const entry = this.jobs.get(id);
    if (entry === undefined) return undefined;
    let size: number;
    try {
      size = statSync(entry.logPath).size;
    } catch {
      return { text: "", nextOffset: 0, size: 0, atEnd: true };
    }

    if (opts.offset !== undefined) {
      const from = Math.max(0, Math.min(opts.offset, size));
      const length = Math.min(size - from, JOB_LOG_MAX_READ_BYTES);
      const text = readRange(entry.logPath, from, length);
      return { text, nextOffset: from + length, size, atEnd: from + length >= size };
    }

    const lines = Math.max(1, opts.lines ?? JOB_LOG_DEFAULT_LINES);
    const from = Math.max(0, size - JOB_LOG_MAX_READ_BYTES);
    const raw = readRange(entry.logPath, from, size - from);
    const split = raw.split("\n");
    // A window that did not start at the head may have cut the first line in
    // half; dropping it is better than showing a fragment as though it were a
    // line the command printed.
    if (from > 0 && split.length > 1) split.shift();
    // A log that ends in a newline splits to a trailing empty string. Leaving
    // it in means `lines: 3` returns two lines and a blank — the caller asked
    // for three lines of output and has to be given three.
    if (split.length > 1 && split[split.length - 1] === "") split.pop();
    const tail = split.slice(-lines);
    return { text: tail.join("\n"), nextOffset: size, size, atEnd: true };
  }

  /**
   * Kill a job and everything it started, then wait for the shell to actually
   * exit.
   *
   * The wait is the part that is easy to leave out and is the reason this is
   * async. Returning the moment the kill was REQUESTED is how a caller ends up
   * asserting on a process that is still shutting down, and it is one of the
   * two halves of the defect this ticket exists to fix.
   */
  async stop(id: string, reason?: string): Promise<JobRecord | undefined> {
    const entry = this.jobs.get(id);
    if (entry === undefined) return undefined;
    if (entry.status !== "running" && entry.status !== "capped") return publicRecord(entry);
    if (entry.status === "running") {
      entry.status = "stopped";
      if (reason !== undefined) entry.reason = reason;
    }
    await (entry.child !== undefined ? killExecChild(entry.child) : killProcessTree(entry.pid));
    await settleWithin(entry.done, JOB_STOP_GRACE_MS);
    return publicRecord(entry);
  }

  /**
   * D6: session teardown. Every running job, every time.
   *
   * A background job that outlives its session is an orphan nobody will ever
   * stop — the user does not know its pid, the next session does not know it
   * exists, and on Windows it is not even attached to a console they could
   * interrupt. So this hangs off the session lifecycle that already exists
   * rather than a new one, exactly as `LspServerPool.shutdownAll()` does.
   */
  async stopAll(): Promise<JobRecord[]> {
    const ids = [...this.jobs.keys()];
    const stopped: JobRecord[] = [];
    for (const id of ids) {
      try {
        const record = await this.stop(id, "the session ended");
        if (record !== undefined) stopped.push(record);
      } catch {
        // One job that will not die must not stop the others being killed.
      }
    }
    return stopped;
  }

  /** Every started job's pid, for a test that has to prove they are gone. */
  pids(): number[] {
    return [...this.jobs.values()].map((j) => j.pid).filter((p): p is number => p !== undefined);
  }
}

function readRange(path: string, from: number, length: number): string {
  if (length <= 0) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, from);
    return buf.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

async function settleWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
