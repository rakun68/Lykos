// `lykos login` and `lykos logout` (ADR-0025).
//
// Login puts a credential into the provider's pool in the Lykos credential db:
// an API key source read from stdin (`--api-key`), or the result of Pi's own
// OAuth flow, run against an in-memory capture store so Pi cannot write it
// anywhere else. Logout soft-disables rows. Output names labels only: no key,
// token, or resolved key source reaches stdout, stderr, or a thrown message.

import { defaultCredentialDbPath, openCredentialDb } from "../credentials/db.js";
import { type LoginRuntime, openAuthUrl, redactTokens, runLoginFlow } from "../credentials/login-flow.js";
import { disableCredential, listEnabled } from "../credentials/pool.js";
import { createLykosModelRuntime, type LykosModelRuntimeOptions } from "../session/model-runtime.js";

export { type LoginRuntime, redactTokens };

export interface LoginIO {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env: NodeJS.ProcessEnv;
  /** Credential db. Defaults to `defaultCredentialDbPath(env)`. */
  dbPath?: string;
  /** Builds the runtime whose OAuth flow runs. Defaults to `createLykosModelRuntime`. */
  createRuntime?: (opts: LykosModelRuntimeOptions) => Promise<LoginRuntime>;
  /** Opens an auth URL. Defaults to the platform browser. */
  openBrowser?: (url: string) => void;
}

function withDefaults(io: Partial<LoginIO>): LoginIO {
  return {
    stdin: io.stdin ?? process.stdin,
    stdout: io.stdout ?? process.stdout,
    stderr: io.stderr ?? process.stderr,
    env: io.env ?? process.env,
    ...(io.dbPath !== undefined ? { dbPath: io.dbPath } : {}),
    ...(io.createRuntime !== undefined ? { createRuntime: io.createRuntime } : {}),
    ...(io.openBrowser !== undefined ? { openBrowser: io.openBrowser } : {}),
  };
}

/**
 * Line input over stdin that keeps what it has buffered between prompts (an
 * OAuth flow may ask more than once). On a TTY it reads in raw mode so a
 * secret is not echoed.
 */
class LineReader {
  private buffer = "";
  private ended = false;
  private attached = false;
  private waiter: { resolve: (line: string | undefined) => void } | undefined;

  constructor(private readonly io: LoginIO) {}

  private get tty(): boolean {
    return this.io.stdin.isTTY === true && typeof this.io.stdin.setRawMode === "function";
  }

  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += chunk.toString();
    this.drain();
  };

  private readonly onEnd = (): void => {
    this.ended = true;
    this.drain();
  };

  private drain(): void {
    if (this.waiter === undefined) return;
    const nl = this.buffer.indexOf("\n");
    let line: string | undefined;
    if (nl !== -1) {
      line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
    } else if (this.ended) {
      line = this.buffer.length > 0 ? this.buffer : undefined;
      this.buffer = "";
    } else {
      return;
    }
    const { resolve } = this.waiter;
    this.waiter = undefined;
    this.io.stdin.pause();
    resolve(line);
  }

  /** The next line, or undefined at end of input. Rejects when `signal` aborts. */
  async line(opts: { echo: boolean; signal?: AbortSignal }): Promise<string | undefined> {
    opts.signal?.throwIfAborted();
    if (this.tty) return this.rawLine(opts);
    if (!this.attached) {
      this.attached = true;
      this.io.stdin.on("data", this.onData);
      this.io.stdin.on("end", this.onEnd);
    }
    return new Promise<string | undefined>((resolve, reject) => {
      const onAbort = (): void => {
        this.waiter = undefined;
        this.io.stdin.pause();
        reject(opts.signal!.reason);
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.waiter = {
        resolve: (line) => {
          opts.signal?.removeEventListener("abort", onAbort);
          resolve(line);
        },
      };
      this.drain();
      if (this.waiter !== undefined) this.io.stdin.resume();
    });
  }

  private rawLine(opts: { echo: boolean; signal?: AbortSignal }): Promise<string | undefined> {
    const { stdin, stderr } = this.io;
    return new Promise<string | undefined>((resolve, reject) => {
      let value = "";
      const finish = (): void => {
        stdin.removeListener("data", onKey);
        opts.signal?.removeEventListener("abort", onAbort);
        stdin.setRawMode!(false);
        stdin.pause();
        stderr.write("\n");
      };
      const onAbort = (): void => {
        finish();
        reject(opts.signal!.reason);
      };
      const onKey = (chunk: Buffer | string): void => {
        for (const ch of chunk.toString()) {
          if (ch === "\r" || ch === "\n") {
            finish();
            resolve(value);
            return;
          }
          if (ch === "\u0003" || ch === "\u0004") {
            finish();
            reject(new Error("cancelled"));
            return;
          }
          if (ch === "\u007f" || ch === "\b") {
            if (value.length > 0) {
              value = value.slice(0, -1);
              if (opts.echo) stderr.write("\b \b");
            }
            continue;
          }
          value += ch;
          if (opts.echo) stderr.write(ch);
        }
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      stdin.setRawMode!(true);
      stdin.on("data", onKey);
      stdin.resume();
    });
  }

  close(): void {
    if (this.attached) {
      this.io.stdin.removeListener("data", this.onData);
      this.io.stdin.removeListener("end", this.onEnd);
      this.attached = false;
    }
    this.io.stdin.pause();
  }
}

function splitArgs(args: string[]): { positionals: string[]; flags: string[] } {
  return {
    positionals: args.filter((a) => !a.startsWith("--")),
    flags: args.filter((a) => a.startsWith("--")),
  };
}

/** `lykos login <provider> [--api-key]`: the shared login flow over stdin, stdout and stderr. */
export async function runLogin(args: string[], ioIn: Partial<LoginIO> = {}): Promise<number> {
  const io = withDefaults(ioIn);
  const { positionals, flags } = splitArgs(args);
  const unknown = flags.filter((f) => f !== "--api-key");
  if (positionals.length !== 1 || unknown.length > 0) {
    io.stderr.write("usage: lykos login <provider> [--api-key]\n");
    return 1;
  }
  const provider = positionals[0]!;
  const reader = new LineReader(io);
  try {
    return await runLoginFlow(provider, flags.includes("--api-key"), {
      dbPath: io.dbPath ?? defaultCredentialDbPath(io.env),
      out: (line) => io.stdout.write(`${line}\n`),
      err: (line) => io.stderr.write(`${line}\n`),
      ask: async (q) => {
        // A piped API key is read without asking for it; everything else is asked.
        if (!q.optionalPrompt || io.stdin.isTTY === true) io.stderr.write(`${q.prompt}: `);
        return reader.line({ echo: !q.secret, ...(q.signal !== undefined ? { signal: q.signal } : {}) });
      },
      openBrowser: io.openBrowser ?? openAuthUrl,
      createRuntime: io.createRuntime ?? createLykosModelRuntime,
    });
  } finally {
    reader.close();
  }
}

/** `lykos logout <provider> [label]`: soft-disable one row by label, or every enabled row of the provider. */
export async function runLogout(args: string[], ioIn: Partial<LoginIO> = {}): Promise<number> {
  const io = withDefaults(ioIn);
  const { positionals, flags } = splitArgs(args);
  if (positionals.length < 1 || positionals.length > 2 || flags.length > 0) {
    io.stderr.write("usage: lykos logout <provider> [label]\n");
    return 1;
  }
  const [provider, label] = positionals as [string, string | undefined];
  const dbPath = io.dbPath ?? defaultCredentialDbPath(io.env);
  const db = openCredentialDb(dbPath, { create: false });
  if (db === undefined) {
    io.stderr.write(`lykos logout: no credentials stored for ${provider}\n`);
    return 1;
  }
  try {
    const rows = listEnabled(db, provider);
    if (rows.length === 0) {
      io.stderr.write(`lykos logout: no credentials stored for ${provider}\n`);
      return 1;
    }
    const targets = label === undefined ? rows : rows.filter((r) => r.label === label);
    if (targets.length === 0) {
      io.stderr.write(
        `lykos logout: ${provider} has no credential labelled "${label}"; its labels are ${rows.map((r) => r.label).join(", ")}\n`,
      );
      return 1;
    }
    for (const row of targets) {
      if (disableCredential(db, row.id, "logout")) io.stdout.write(`logged out ${row.label}\n`);
    }
    return 0;
  } finally {
    db.close();
  }
}
