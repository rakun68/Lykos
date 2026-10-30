// The persistent evaluation cell's runtime: a child process, its protocol, and
// its death.
//
// **THE CHILD PROCESS IS THE WHOLE POINT (D5).** `eval` runs arbitrary code.
// The obvious implementation is `node:vm` in the agent's own process — it is
// shorter, it is faster, and it is wrong, because a `vm` context in this
// process is one `require.cache` walk, one `process.mainModule`, one
// `module.parent` away from the session object, the ledger handle and the
// approval gate. A context is not a sandbox and V8 has never claimed it is;
// Node's own documentation says so. So the cell runs in a SEPARATE OPERATING
// SYSTEM PROCESS, whose heap contains none of those objects at all, and
// `eval-runtime.test.ts` proves it by having a cell go looking and come back
// empty while the same probe read in-process comes back full.
//
// `node:vm` IS used, but inside the child, and for a different job: it is how
// one cell's `const` survives into the next one. A context's global lexical
// environment persists across `runInContext` calls, which is exactly D7's
// requirement, and the isolation is the process boundary rather than the
// context. Those two statements have to be read together — a reviewer who sees
// `vm` here and stops reading will think D5 was ignored.
//
// **THE CHILD IS `node -e`, NOT A FILE ON DISK.** A separate worker script
// would have to be copied into `dist/` by the build, be found from both the
// `tsx` path and the compiled path, and be a fourth thing that can go missing
// at runtime. The bootstrap below is a string in this module, base64-encoded
// on the way to the command line so that no quoting rule on any platform can
// touch it — the argv then contains nothing but `[A-Za-z0-9+/=]`.
//
// **STDOUT CARRIES FRAMES; THE CELL'S OWN OUTPUT IS CAPTURED (D9).** The child
// replaces `process.stdout.write` and `process.stderr.write` while a cell runs
// and appends to a capped buffer, so a cell that prints a hundred megabytes
// stops at the cap and SAYS it stopped rather than silently returning a
// prefix. Result frames are written with `fs.writeSync(1, ...)`, which the
// replacement does not intercept, and every frame carries a sentinel prefix so
// that a cell writing to fd 1 behind the runtime's back produces stray text
// this module ignores rather than a forged result.
//
// **A HUNG CELL KILLS THE CHILD, AND THE RUNTIME SURVIVES (D8).** A cell
// spinning in a synchronous loop never reads its stdin again, so there is no
// polite way to end it: the parent's deadline fires, the process tree dies,
// and the next call starts a fresh one. The result says the runtime was
// restarted and the variables are gone, because a model that believes its
// state survived a timeout will write the next cell against variables that no
// longer exist.
//
// **THE KILL IS `killProcessTree`, NOT A SECOND IMPLEMENTATION.** A cell is
// allowed to spawn things; killing the direct child on Windows would leave
// them. `job-runner.ts` owns the one kill in this codebase and this module
// uses it, spawn options included — `TREE_KILL_SPAWN_OPTIONS` and
// `killProcessTree` are two halves of one decision.
//
// **THE POOL IS THE SESSION'S, NOT THIS MODULE'S.** `EvalRuntimePool` is
// created per `loadTools()` call and torn down beside `LspServerPool` and
// `JobRegistry`, so there is exactly one answer to "who kills these
// processes". A module-level singleton would let two sessions in one process —
// every MCP worker, every test file — share one runtime and inherit each
// other's variables and each other's orphans.

import { localExecutor, type ExecChild, type ProjectExecutor } from "./executor.js";
import { TREE_KILL_SPAWN_OPTIONS, killExecChild } from "./job-runner.js";

/** D6: the two the schema accepts. Only `js` has a runtime; `py` is declared and unconfigured. */
export const EVAL_LANGUAGES = ["js", "py"] as const;
export type EvalLanguage = (typeof EVAL_LANGUAGES)[number];

/** D8's named default. Thirty seconds is the reference's number and it is the right order of magnitude: long enough for a real computation, short enough that a mistake is noticed in one turn. */
export const EVAL_DEFAULT_TIMEOUT_SECONDS = 30;

/** The most a caller may ask for. An hour is `bash`'s own ceiling; past that the job belongs in `hub`. */
export const EVAL_MAX_TIMEOUT_SECONDS = 3600;

/** D9's cap on what one cell may print. 50 KiB is the reference's `DEFAULT_MAX_BYTES`, and it is already more than a model can usefully read. */
export const EVAL_MAX_OUTPUT_BYTES = 50 * 1024;

/** How long a killed child is given to actually exit before the runtime stops waiting for it. */
export const EVAL_KILL_GRACE_MS = 10_000;

/** Every result frame begins with this. See the module comment: a cell writing to fd 1 must not be able to forge one. */
const FRAME_PREFIX = "LYKOS";

// ---------------------------------------------------------------------------
// The child
// ---------------------------------------------------------------------------

/**
 * The child's whole program.
 *
 * It is a string rather than a file for the reason in the module comment. It
 * reads one JSON request per line from stdin, evaluates the cell in a
 * persistent `vm` context, and writes one framed JSON response per request.
 *
 * `__LYKOS_MAX_OUTPUT__` is substituted before the child is spawned rather
 * than passed as an argument, so the cap cannot be changed by anything the
 * cell does to `process.argv`.
 */
const CHILD_BOOTSTRAP = String.raw`
const vm = require("node:vm");
const fs = require("node:fs");
const util = require("node:util");

const MAX_OUTPUT = __LYKOS_MAX_OUTPUT__;
const PREFIX = "LYKOS";

const realStdoutWrite = process.stdout.write.bind(process.stdout);
const realStderrWrite = process.stderr.write.bind(process.stderr);

let captured = "";
let capturedBytes = 0;
let truncated = false;
let capturing = false;

function capture(chunk) {
  const s = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  const room = MAX_OUTPUT - capturedBytes;
  if (room <= 0) { truncated = true; return true; }
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes > room) {
    captured += Buffer.from(s, "utf8").subarray(0, room).toString("utf8");
    capturedBytes = MAX_OUTPUT;
    truncated = true;
    return true;
  }
  captured += s;
  capturedBytes += bytes;
  return true;
}

// Replaced for the whole life of the child rather than around each cell: a
// setTimeout scheduled by one cell can print after that cell returned, and
// that output belongs to whichever cell is running when it arrives rather
// than on the frame stream.
process.stdout.write = function (chunk, encoding, cb) {
  if (!capturing) return realStdoutWrite(chunk, encoding, cb);
  const done = capture(chunk);
  if (typeof encoding === "function") encoding();
  else if (typeof cb === "function") cb();
  return done;
};
process.stderr.write = function (chunk, encoding, cb) {
  if (!capturing) return realStderrWrite(chunk, encoding, cb);
  const done = capture(chunk);
  if (typeof encoding === "function") encoding();
  else if (typeof cb === "function") cb();
  return done;
};

// The cell's world. Only HOST globals are injected; every intrinsic (Object,
// Promise, Array) comes from the new context's own realm.
const sandbox = {
  console: console,
  process: process,
  Buffer: Buffer,
  require: require,
  module: module,
  exports: exports,
  __dirname: process.cwd(),
  URL: URL,
  URLSearchParams: URLSearchParams,
  TextEncoder: TextEncoder,
  TextDecoder: TextDecoder,
  AbortController: AbortController,
  AbortSignal: AbortSignal,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  setImmediate: setImmediate,
  clearImmediate: clearImmediate,
  queueMicrotask: queueMicrotask,
  structuredClone: structuredClone,
  fetch: typeof fetch === "function" ? fetch : undefined,
  crypto: typeof crypto !== "undefined" ? crypto : undefined,
};
let context = vm.createContext(sandbox);

function send(frame) {
  fs.writeSync(1, PREFIX + JSON.stringify(frame) + "\n");
}

function describe(value) {
  if (value === undefined) return undefined;
  try {
    return util.inspect(value, { depth: 3, maxStringLength: 4000, maxArrayLength: 200, breakLength: 100 });
  } catch (err) {
    return "[value could not be inspected: " + String(err && err.message) + "]";
  }
}

// Duck-typed rather than instanceof, for the realm reason above: an Error the
// cell threw is the vm context's Error, not this one's.
function errorText(err) {
  if (err && typeof err === "object") {
    if (typeof err.stack === "string" && err.stack !== "") {
      return err.stack.split("\n").slice(0, 6).join("\n");
    }
    if (typeof err.message === "string") {
      return String(err.name || "Error") + ": " + err.message;
    }
  }
  return "Uncaught " + String(err);
}

async function runCell(request) {
  captured = "";
  capturedBytes = 0;
  truncated = false;
  capturing = true;
  let wrapped = false;
  const frame = { id: request.id };
  try {
    let value;
    try {
      value = vm.runInContext(request.code, context, { filename: "cell.js", displayErrors: true });
    } catch (err) {
      // Top-level await, and a bare top-level return, are not valid in a
      // script -- only in a module and a function respectively. Rather than
      // refuse the two most natural ways to write an async cell, it is re-run
      // inside an async wrapper. That costs the cell its own let/const
      // persistence and makes its value come from an explicit return, so the
      // result says both rather than leaving a model to discover them on the
      // next call.
      // NOT an instanceof check. The error was thrown inside the vm context,
      // which is its own realm with its own intrinsics, so the parent realm's
      // SyntaxError is a different constructor and instanceof silently
      // answers false. The name is realm-independent; the constructor is not.
      if (
        err &&
        err.name === "SyntaxError" &&
        /(await is only valid|Illegal return statement)/i.test(String(err.message))
      ) {
        wrapped = true;
        value = vm.runInContext(
          "(async () => {\n" + request.code + "\n})()",
          context,
          { filename: "cell.js", displayErrors: true },
        );
      } else {
        throw err;
      }
    }
    if (value !== null && typeof value === "object" && typeof value.then === "function") {
      value = await value;
    }
    frame.status = "ok";
    const shown = describe(value);
    if (shown !== undefined) frame.value = shown;
  } catch (err) {
    frame.status = "error";
    frame.error = errorText(err);
  } finally {
    capturing = false;
    frame.output = captured;
    frame.truncated = truncated;
    if (wrapped) frame.wrappedForAwait = true;
  }
  send(frame);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const at = buffer.indexOf("\n");
    if (at < 0) break;
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (line.trim() === "") continue;
    let request;
    try {
      request = JSON.parse(line);
    } catch (err) {
      continue;
    }
    void runCell(request);
  }
});
// Stdin closing is the parent letting go. Nothing here can outlive that.
process.stdin.on("end", () => process.exit(0));

// A cell's unhandled rejection must not take the runtime down: the cell after
// it is still worth running, and a dead runtime looks to the model like a
// timeout it did not cause.
process.on("unhandledRejection", () => undefined);

send({ ready: true });
`;

interface ResponseFrame {
  id?: number;
  ready?: boolean;
  /** Set by this module, never by the child: the child died before it answered. A field rather than a magic error string, so a cell that throws cannot fake one. */
  crashed?: boolean;
  status?: "ok" | "error";
  value?: string;
  output?: string;
  truncated?: boolean;
  error?: string;
  wrappedForAwait?: boolean;
}

// ---------------------------------------------------------------------------
// The parent
// ---------------------------------------------------------------------------

export interface EvalOutcome {
  /**
   * `ok` and `error` both mean the cell ran; `error` is the cell throwing,
   * which is a normal thing for code to do. `timeout` means the cell was
   * abandoned and the runtime restarted (D8). `crashed` means the child died
   * on its own, which is the same loss of state by a different route.
   */
  status: "ok" | "error" | "timeout" | "crashed";
  /** `util.inspect` of the completion value. Absent when the cell evaluated to `undefined`. */
  value?: string;
  /** Everything the cell printed, capped (D9). */
  output: string;
  /** Set when the cap cut the output. The result says so rather than returning a silent prefix. */
  truncated: boolean;
  /** The thrown error, with the head of its stack. */
  error?: string;
  /** Set when the cell's state was lost: a timeout, a crash, or an explicit reset. */
  restarted?: boolean;
  /** Set when the cell used top-level `await` or a bare `return` and therefore ran inside an async wrapper. */
  wrappedForAwait?: boolean;
  durationMs: number;
}

export interface EvalRuntimeOpts {
  cwd: string;
  /** Overridable so a test can hit the cap without printing 50 KiB. */
  maxOutputBytes?: number;
  /** T172: where the runtime's process runs. Absent means this machine. */
  executor?: ProjectExecutor;
}

/**
 * One language's child process, for one session.
 *
 * Nothing is spawned by the constructor: a session that never calls `eval`
 * never starts a process, which is the same lazy rule `LspServerPool` follows.
 */
export class EvalRuntime {
  private child: ExecChild | undefined;
  private buffer = "";
  private seq = 0;
  private waiting: { id: number; resolve: (frame: ResponseFrame) => void } | undefined;
  private exited: Promise<void> = Promise.resolve();
  /** Cells run one at a time. Two concurrent `runInContext` calls on one context would interleave in ways nobody can reason about. */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly maxOutputBytes: number;

  constructor(private readonly opts: EvalRuntimeOpts) {
    this.maxOutputBytes = opts.maxOutputBytes ?? EVAL_MAX_OUTPUT_BYTES;
  }

  /** The child's operating-system process id, or undefined when none is running. A test asserts this pid is gone, not that a kill returned. */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return this.child !== undefined;
  }

  private start(): ExecChild {
    if (this.child !== undefined) return this.child;
    const source = CHILD_BOOTSTRAP.replace("__LYKOS_MAX_OUTPUT__", String(this.maxOutputBytes));
    // Base64 on the way to argv: the command line then contains no quote, no
    // backslash and no newline, so no platform's quoting rules apply to it.
    const encoded = Buffer.from(source, "utf8").toString("base64");
    const child = (this.opts.executor ?? localExecutor).spawn(
      process.execPath,
      ["-e", `eval(Buffer.from('${encoded}','base64').toString('utf8'))`],
      {
        cwd: this.opts.cwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        ...TREE_KILL_SPAWN_OPTIONS,
      },
    );
    this.child = child;
    this.buffer = "";
    this.exited = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.onStdout(chunk));
    // The child's own stderr — a crash in the bootstrap, not a cell's output,
    // which is captured on the other side. It is folded into the next
    // failure rather than printed, because this process's stderr belongs to
    // the transport in MCP mode (AGENTS.md rule 8).
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.childStderr = (this.childStderr + chunk).slice(-4000);
    });
    child.on("error", () => this.settleAsCrash());
    child.on("close", () => {
      this.child = undefined;
      this.settleAsCrash();
    });
    return child;
  }

  private childStderr = "";

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const at = this.buffer.indexOf("\n");
      if (at < 0) break;
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 1);
      // Anything that is not a framed line is a cell writing to fd 1 behind
      // the runtime's back. It is dropped rather than parsed, so a cell
      // cannot forge a result for a call it is not answering.
      if (!line.startsWith(FRAME_PREFIX)) continue;
      let frame: ResponseFrame;
      try {
        frame = JSON.parse(line.slice(FRAME_PREFIX.length)) as ResponseFrame;
      } catch {
        continue;
      }
      if (frame.ready === true) continue;
      const pending = this.waiting;
      if (pending !== undefined && frame.id === pending.id) {
        this.waiting = undefined;
        pending.resolve(frame);
      }
    }
  }

  private settleAsCrash(): void {
    const pending = this.waiting;
    if (pending === undefined) return;
    this.waiting = undefined;
    pending.resolve({ id: pending.id, crashed: true });
  }

  /**
   * D7: one cell, in the context the last one left behind.
   *
   * Serialized through `queue` so that two tool calls in one turn cannot run
   * two cells in one context at once — Pi runs a model's parallel tool calls
   * concurrently, and the failure mode there is two half-evaluated cells
   * sharing a global lexical scope.
   */
  async evaluate(code: string, opts: { timeoutMs?: number; reset?: boolean } = {}): Promise<EvalOutcome> {
    const run = this.queue.then(() => this.evaluateOne(code, opts));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async evaluateOne(code: string, opts: { timeoutMs?: number; reset?: boolean }): Promise<EvalOutcome> {
    const startedAt = Date.now();
    let restarted = false;
    if (opts.reset === true) {
      // D7: a reset kills the child and starts a new one BEFORE evaluating,
      // so the cell that asked for a clean slate runs on one.
      await this.dispose();
      restarted = true;
    }
    const child = this.start();
    const id = ++this.seq;
    const frame = await new Promise<ResponseFrame | undefined>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.waiting = undefined;
        resolve(undefined);
      }, opts.timeoutMs ?? EVAL_DEFAULT_TIMEOUT_SECONDS * 1000);
      const done = (f: ResponseFrame): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(f);
      };
      this.waiting = { id, resolve: done };
      try {
        child.stdin?.write(`${JSON.stringify({ id, code })}\n`);
      } catch (err) {
        done({ id, status: "error", error: `the evaluation runtime could not be written to: ${(err as Error).message}` });
      }
    });

    if (frame === undefined) {
      // D8: the cell is still running and cannot be interrupted politely, so
      // the process tree goes. The next call starts a fresh child.
      await this.dispose();
      return {
        status: "timeout",
        output: "",
        truncated: false,
        restarted: true,
        durationMs: Date.now() - startedAt,
      };
    }
    if (frame.crashed === true) {
      const said = this.childStderr.trim();
      this.childStderr = "";
      return {
        status: "crashed",
        output: "",
        truncated: false,
        restarted: true,
        ...(said !== "" ? { error: said } : {}),
        durationMs: Date.now() - startedAt,
      };
    }

    return {
      status: frame.status === "error" ? "error" : "ok",
      output: frame.output ?? "",
      truncated: frame.truncated === true,
      ...(frame.value !== undefined ? { value: frame.value } : {}),
      ...(frame.error !== undefined ? { error: frame.error } : {}),
      ...(restarted ? { restarted: true } : {}),
      ...(frame.wrappedForAwait === true ? { wrappedForAwait: true } : {}),
      durationMs: Date.now() - startedAt,
    };
  }

  /**
   * Kill the child and everything it started, then wait for it to actually
   * exit.
   *
   * The wait is the part that is easy to leave out and is why this is async:
   * returning the moment the kill was REQUESTED is how a caller ends up
   * asserting on a process that is still shutting down. `JobRegistry.stop()`
   * makes the same call for the same reason.
   */
  async dispose(): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    const exited = this.exited;
    this.child = undefined;
    await killExecChild(child);
    await settleWithin(exited, EVAL_KILL_GRACE_MS);
    this.settleAsCrash();
  }
}

/**
 * One session's evaluation runtimes, one per language.
 *
 * The session owns it, exactly as it owns `LspServerPool` and `JobRegistry`:
 * created per `loadTools()` call, carried on the booted session, and disposed
 * beside `session.dispose()`. An evaluation runtime that outlived its session
 * would be a Node process holding the user's variables that nobody knows the
 * pid of.
 */
export class EvalRuntimePool {
  private readonly runtimes = new Map<EvalLanguage, EvalRuntime>();

  constructor(private readonly opts: EvalRuntimeOpts) {}

  /** Get-or-create. Nothing is spawned until a cell is actually evaluated. */
  runtimeFor(language: EvalLanguage): EvalRuntime {
    const existing = this.runtimes.get(language);
    if (existing !== undefined) return existing;
    const created = new EvalRuntime(this.opts);
    this.runtimes.set(language, created);
    return created;
  }

  /** Every started child's pid, for a test that has to prove they are gone. */
  pids(): number[] {
    return [...this.runtimes.values()].map((r) => r.pid).filter((p): p is number => p !== undefined);
  }

  /** Session teardown. Every runtime, every time, even when one refuses to die. */
  async disposeAll(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      try {
        await runtime.dispose();
      } catch {
        // One runtime that will not die must not stop the others being killed.
      }
    }
    this.runtimes.clear();
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
