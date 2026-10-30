// The half of the `lsp` ticket that talks to a language server: finding one,
// starting it, keeping it, asking it something, and killing it.
//
// **Two dependencies and no daemon (D1).** `vscode-jsonrpc` does the framing
// and `vscode-languageserver-protocol` supplies the types; both are MIT. There is no broker, no shared
// per-project daemon and no linter adapter. A broker is a second lifecycle
// owner and a second thing that can leak a process; one server per language
// per session, started lazily and killed at session end, is the whole design.
//
// **Spawning on Windows is not the obvious thing (D2, verified on this
// machine before the plan was written).** `node_modules/.bin/<name>.cmd`
// cannot be handed to `spawn` — Node refuses a `.cmd` with `EINVAL` unless a
// shell is involved, and that refusal is a security fix, not a bug to work
// around. So a command that resolves inside the repository's own
// `node_modules` is spawned as `process.execPath` plus the package's own `bin`
// entry, which is a plain `.mjs` file and starts identically on every
// platform. This is the maintainer's platform; it is not an edge case.
//
// **The Node entry point is `vscode-jsonrpc/node`, without a `.js` suffix**
// (D2). The package's `exports` map has no `./node.js`, so the suffixed
// spelling every other import in this codebase uses fails here with
// `ERR_PACKAGE_PATH_NOT_EXPORTED`. That is a package-exports fact, not a
// module-resolution style choice, and it is why this one import looks
// different from its neighbours.
//
// **A position is a line and a symbol, never a column (D3).** Models are
// reliable about "the word `foo` on line 42" and unreliable about column
// numbers, so the schema takes a substring and this module resolves the
// column. The conversion to the protocol's 0-indexed line and UTF-16
// character offset happens here and nowhere else. `String.prototype.indexOf`
// already counts UTF-16 code units, which is exactly what the protocol counts
// — so a line containing an astral character (one code point, two code units)
// must produce the larger number, and `lsp-client.test.ts` pins that. Anything
// that iterated the line by code point (`[...line]`, `Array.from`) would be
// off by one per surrogate pair and would be wrong only on the files nobody
// tests with.
//
// **A document the server has never seen answers nothing (D8).** A position
// request against an unopened file comes back empty, which reads as "no
// definition" and is a lie. Every request against a file sends
// `textDocument/didOpen` first, once, and the open set is tracked so it
// happens once.
//
// **The server never writes a file.** `workspace/applyEdit` is answered
// `{ applied: false }` on purpose: a rename reaches the disk through the
// approval gate in `lsp.ts` or it does not reach the disk at all, and a server
// that could edit behind the gate would be a second write path nobody
// reviewed.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isInsideWorkspace } from "./workspace-confine.js";
import { delimiter, dirname, extname, isAbsolute, join, parse as parsePath, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CancellationTokenSource,
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import type { Diagnostic } from "vscode-languageserver-protocol";
import { SHIPPED_DEFAULTS } from "../config/defaults.js";
import type { LspServerDecl } from "../config/types.js";

// ---------------------------------------------------------------------------
// The server table (D4)
// ---------------------------------------------------------------------------

export type { LspServerDecl };

/**
 * D4's shipped default, read off `SHIPPED_DEFAULTS` rather than written here
 * a second time.
 *
 * The table IS configuration (`config/types.ts`'s `LspConfig`), and the
 * shipped entry is the bottom layer of it. A copy kept here for the
 * convenience of tests would be a second answer to "which server serves
 * `.ts`", and the one that drifted would be the one nobody read.
 */
export const DEFAULT_LSP_SERVERS: Readonly<Record<string, LspServerDecl>> = SHIPPED_DEFAULTS.lsp.servers;

/** The configuration key a message names when a language has no server. */
export const LSP_CONFIG_KEY = "lsp.servers";

/**
 * The protocol's `languageId` for a path. Not the same thing as the server
 * key: one server owns several language ids, and `didOpen` has to carry the
 * right one or a `.tsx` file is parsed without JSX.
 */
export function languageIdForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "typescriptreact";
    case ".jsx":
      return "javascriptreact";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    default:
      return "plaintext";
  }
}

/** Which configured server owns this file, by extension. Undefined means "no server configured for this language". */
export function serverKeyForPath(
  servers: Readonly<Record<string, LspServerDecl>>,
  path: string,
): string | undefined {
  const ext = extname(path).toLowerCase();
  for (const [key, decl] of Object.entries(servers)) {
    if (decl.extensions.some((e) => e.toLowerCase() === ext)) return key;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Finding the executable (D2, D4)
// ---------------------------------------------------------------------------

/** What `spawn` is actually given, and where it was found. */
export interface ResolvedServerCommand {
  /** The executable. `process.execPath` when the server is a Node bin script in `node_modules`. */
  exec: string;
  args: string[];
  /** Whether the command has to go through a shell, which is only ever true for a `.cmd`/`.bat` found on PATH. */
  shell: boolean;
  /** For the message a human reads: the file that was found. */
  found: string;
  source: "node_modules" | "path";
}

function ancestors(from: string): string[] {
  const out: string[] = [];
  let dir = resolve(from);
  for (;;) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) return out;
    dir = parent;
  }
}

/** The `bin` entry a package declares for this command name, as a path relative to the package. */
function binEntryFor(pkg: unknown, pkgName: string, command: string): string | undefined {
  if (pkg === null || typeof pkg !== "object") return undefined;
  const bin = (pkg as { bin?: unknown }).bin;
  if (typeof bin === "string") return pkgName === command ? bin : undefined;
  if (bin !== null && typeof bin === "object") {
    const entry = (bin as Record<string, unknown>)[command];
    if (typeof entry === "string") return entry;
  }
  return undefined;
}

/**
 * D2: the real script behind a `node_modules/.bin` shim.
 *
 * `<modules>/<command>/package.json`'s `bin` is the same entry the shim
 * execs, so running it under this process's own Node is exactly what the shim
 * would have done — minus the `.cmd` wrapper that `spawn` refuses on Windows.
 * Undefined when the command is not a package of that name, which is the case
 * for a shim whose bin key differs from its package's name; that one falls
 * back to the shim itself.
 */
function packageBinScript(modulesDir: string, command: string): string | undefined {
  const pkgDir = join(modulesDir, command);
  const pkgJson = join(pkgDir, "package.json");
  if (!existsSync(pkgJson)) return undefined;
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
  } catch {
    // A package.json that does not parse is not this module's problem to
    // report; the caller keeps looking.
    return undefined;
  }
  const entry = binEntryFor(pkg, command, command);
  if (entry === undefined) return undefined;
  const script = join(pkgDir, entry);
  return existsSync(script) ? script : undefined;
}

/** The `node_modules` a `.bin` directory belongs to, or undefined when this path is not a shim. */
function modulesDirOfShim(shimPath: string): string | undefined {
  const binDir = dirname(shimPath);
  if (parsePath(binDir).base !== ".bin") return undefined;
  const modules = dirname(binDir);
  return parsePath(modules).base === "node_modules" ? modules : undefined;
}

/** Every path PATH would try for `command`, honouring PATHEXT on Windows. */
function pathCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  const pathValue = env.PATH ?? env.Path ?? "";
  const dirs = pathValue.split(delimiter).filter((d) => d !== "");
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "")
      : [""];
  const out: string[] = [];
  for (const dir of dirs) {
    if (extname(command) !== "") out.push(join(dir, command));
    for (const ext of exts) out.push(join(dir, command + ext.toLowerCase()));
  }
  return out;
}

/**
 * D4's resolution order: the repository's own `node_modules` first, then PATH.
 *
 * `node_modules` first is not a preference, it is correctness — a project that
 * pins a language server version means that version, and a stray global
 * install answering instead is the kind of difference that shows up as a
 * mysterious diagnostic nobody can reproduce.
 */
export function resolveServerCommand(
  cwd: string,
  decl: LspServerDecl,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedServerCommand | undefined {
  const args = [...(decl.args ?? [])];
  if (isAbsolute(decl.command) && existsSync(decl.command)) {
    return { exec: decl.command, args, shell: false, found: decl.command, source: "path" };
  }
  for (const dir of ancestors(cwd)) {
    const modules = join(dir, "node_modules");
    if (!existsSync(modules)) continue;
    // D2: the package's own `bin` entry, run by this process's own Node.
    // Spawning the `.cmd` shim beside it fails with EINVAL on Windows, and
    // the shim exists to do exactly this hop anyway.
    const script = packageBinScript(modules, decl.command);
    if (script !== undefined) {
      return {
        exec: process.execPath,
        args: [script, ...args],
        shell: false,
        found: script,
        source: "node_modules",
      };
    }
    // A shim with no package of that name behind it. Runnable directly
    // everywhere except Windows, where it is the `.cmd` D2 names.
    const shim = join(modules, ".bin", decl.command);
    if (process.platform !== "win32" && existsSync(shim)) {
      return { exec: shim, args, shell: false, found: shim, source: "node_modules" };
    }
  }
  for (const candidate of pathCandidates(decl.command, env)) {
    if (!existsSync(candidate)) continue;
    // A PATH entry can itself BE a `node_modules/.bin` — npm and npx both put
    // one there for the duration of a script, which is how these tests find
    // the server at all. Take the same Node hop for it rather than the shell
    // below: it is the same file, reached by a different route.
    const modules = modulesDirOfShim(candidate);
    const script = modules === undefined ? undefined : packageBinScript(modules, decl.command);
    if (script !== undefined) {
      return { exec: process.execPath, args: [script, ...args], shell: false, found: script, source: "path" };
    }
    const ext = extname(candidate).toLowerCase();
    // A `.cmd` or `.bat` with no package behind it is the one case that needs
    // a shell. The command comes from configuration rather than from the
    // model, so the quoting is protecting a path with a space in it.
    const shell = ext === ".cmd" || ext === ".bat";
    return { exec: candidate, args, shell, found: candidate, source: "path" };
  }
  return undefined;
}

function shellQuote(value: string): string {
  return /[\s"&|<>^()]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

// ---------------------------------------------------------------------------
// Positions (D3)
// ---------------------------------------------------------------------------

/** A protocol position: 0-indexed line, UTF-16 code units into that line. */
export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

/** Every line of a document, split the way the protocol counts them. */
export function documentLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** `name#2` -> the second occurrence of `name`. `N` is 1-indexed; a bare name is `#1`. */
export function parseSymbolSelector(symbol: string): { name: string; occurrence: number } {
  const hash = symbol.lastIndexOf("#");
  if (hash <= 0) return { name: symbol, occurrence: 1 };
  const suffix = symbol.slice(hash + 1);
  if (!/^[0-9]+$/.test(suffix)) return { name: symbol, occurrence: 1 };
  const parsed = Number.parseInt(suffix, 10);
  return { name: symbol.slice(0, hash), occurrence: parsed < 1 ? 1 : parsed };
}

/**
 * The column of the Nth occurrence of `symbol` on `lineText`, in UTF-16 code
 * units, or undefined when it is not there.
 *
 * Exact match first, then case-insensitive, which is the order a human would use: a model that wrote `Foo` for
 * `foo` made a transcription slip, and refusing it buys nothing.
 */
export function resolveSymbolColumn(lineText: string, symbol: string): number | undefined {
  const { name, occurrence } = parseSymbolSelector(symbol);
  if (name === "") return undefined;
  const exact = nthIndexOf(lineText, name, occurrence);
  if (exact !== undefined) return exact;
  return nthIndexOf(lineText.toLowerCase(), name.toLowerCase(), occurrence);
}

function nthIndexOf(haystack: string, needle: string, n: number): number | undefined {
  let at = -1;
  for (let i = 0; i < n; i += 1) {
    // indexOf works in UTF-16 code units, which is what the protocol counts.
    // Do not replace this with anything that iterates code points.
    at = haystack.indexOf(needle, at + 1);
    if (at === -1) return undefined;
  }
  return at;
}

export class LspPositionError extends Error {}

/**
 * The protocol position for a 1-indexed line and a symbol on it. Throws with
 * a message the model can act on, because "which line did you mean" is a
 * question it can answer and a silent position-zero fallback is not.
 */
export function positionFor(text: string, line: number, symbol: string | undefined): LspPosition {
  const lines = documentLines(text);
  if (!Number.isInteger(line) || line < 1 || line > lines.length) {
    throw new LspPositionError(
      `line ${line} is outside this file, which has ${lines.length} line${lines.length === 1 ? "" : "s"}.`,
    );
  }
  const lineText = lines[line - 1] ?? "";
  if (symbol === undefined || symbol === "") {
    const firstNonSpace = lineText.search(/\S/);
    return { line: line - 1, character: firstNonSpace === -1 ? 0 : firstNonSpace };
  }
  const column = resolveSymbolColumn(lineText, symbol);
  if (column === undefined) {
    const { name, occurrence } = parseSymbolSelector(symbol);
    throw new LspPositionError(
      `symbol ${JSON.stringify(name)}${occurrence > 1 ? ` (occurrence ${occurrence})` : ""} is not on line ${line}. ` +
        `That line is: ${JSON.stringify(lineText.trim())}`,
    );
  }
  return { line: line - 1, character: column };
}

/** Back out: what a human and the next `read` call this position. */
export function displayPosition(position: LspPosition): { line: number; column: number } {
  return { line: position.line + 1, column: position.character + 1 };
}

/**
 * Absolute offset into `text` for a protocol position, clamped to the
 * document.
 *
 * The line walk uses the same three-way terminator split `documentLines` does,
 * so a CRLF file and an LF file resolve the same position to the same
 * character on the same line — which is the whole reason a rename can be
 * applied to the raw bytes on disk rather than to a normalized copy.
 */
export function offsetOf(text: string, position: LspPosition): number {
  let offset = 0;
  for (let line = 0; line < position.line; line += 1) {
    const match = /\r\n|\r|\n/.exec(text.slice(offset));
    if (match === null) return text.length;
    offset += match.index + match[0].length;
  }
  const rest = text.slice(offset);
  const endOfLine = /\r\n|\r|\n/.exec(rest);
  const lineLength = endOfLine === null ? rest.length : endOfLine.index;
  return offset + Math.min(Math.max(position.character, 0), lineLength);
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

/**
 * Every text edit applied to one document, in one pass.
 *
 * Applied from the END backwards so each edit's offsets still refer to the
 * text they were computed against — the protocol says a server's edits are
 * all relative to the original document, and applying them forwards would
 * shift every edit after the first.
 */
export function applyLspTextEdits(text: string, edits: readonly LspTextEdit[]): string {
  const resolved = edits
    .map((edit) => ({
      start: offsetOf(text, edit.range.start),
      end: offsetOf(text, edit.range.end),
      newText: edit.newText,
    }))
    .sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const edit of resolved) {
    out = out.slice(0, edit.start) + edit.newText + out.slice(edit.end);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The client (D5, D8)
// ---------------------------------------------------------------------------

/** D5's named default: how long one request may take before the turn gets a message instead of a hang. */
export const LSP_REQUEST_TIMEOUT_SECONDS = 20;

/**
 * How long a newly opened document waits for the server to say it has
 * actually looked at it, before the request goes out anyway.
 *
 * **This is the project-load wait, and it is not optional.** Verified here
 * against `typescript-language-server` 6.0.0: ask `textDocument/definition`
 * about an imported symbol in the first second of a session and the answer is
 * the import statement in the SAME file, because the project has not been
 * loaded and the other file does not exist yet as far as the server is
 * concerned. That answer is not an error — it is a plausible, wrong location,
 * which is the worst thing a navigation tool can return.
 *
 * The signal is the first `publishDiagnostics` for the document: a server
 * publishes for a file once it has a program that contains it, so "it has
 * told me about this file" is the same fact as "the project is loaded", and
 * it needs no `$/progress` bookkeeping. A server that publishes nothing
 * degrades to waiting this long once per document and then answering anyway.
 */
export const LSP_PROJECT_LOAD_TIMEOUT_MS = 15_000;

/**
 * What this client tells the server it can do.
 *
 * D2 recorded that `capabilities: {}` is enough for the handshake and a
 * position request, and that is true — but it is NOT enough for diagnostics.
 * Verified here: with an empty object `typescript-language-server` 6.0.0
 * pushes no `publishDiagnostics` at all (and answers `textDocument/diagnostic`
 * with "Unhandled method", so there is no pull alternative to switch to), and
 * `lsp diagnostics` reports a file with a type error as clean. Declaring the
 * two capabilities below is the smallest honest fix: they are both things
 * this client genuinely implements — it caches published diagnostics, and it
 * answers `window/workDoneProgress/create`.
 */
const CLIENT_CAPABILITIES = {
  window: { workDoneProgress: true },
  textDocument: { publishDiagnostics: { relatedInformation: false } },
} as const;

/** How long `shutdown`/`exit` get to end the process politely before it is killed. */
export const LSP_SHUTDOWN_GRACE_MS = 2000;

/** Thrown when a request outran its timeout. The server is left running: one slow answer is not a reason to lose the session's index. */
export class LspTimeoutError extends Error {}

/**
 * T160: the server has not said it looked at the document within the
 * project-load wait, so nothing was asked of it. Before T160 the request went
 * out anyway, and an answer given before the project loads is a plausible,
 * wrong one — an empty rename, a definition in the wrong file, a clean
 * diagnostics list for a broken file. The model sees this and can retry; the
 * server keeps loading in the background.
 */
export class LspNotReadyError extends Error {}

function relativeForMessage(cwd: string, path: string): string {
  const rel = relative(cwd, path);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? path : rel.split("\\").join("/");
}

/** T160: the one message a not-ready language server produces, wherever it is detected. */
export function lspNotReadyMessage(server: string, display: string, waitedMs: number): string {
  return (
    `language server not ready — ${server} has not finished loading the project for ${display} ` +
    `within ${Math.round(waitedMs / 100) / 10}s, so nothing was answered: an answer given before the ` +
    `project loads can look valid and be wrong. It keeps loading in the background; retry the same call, ` +
    `or pass a larger \`timeout\`.`
  );
}

/**
 * `promise`, or `fallback` after `ms`, with the timer always cleared.
 *
 * Written once because every use of it here is in a teardown path, and a
 * teardown that leaves a live timer behind keeps the process alive for exactly
 * as long as the timeout it was trying to enforce.
 */
function settleWithin<T>(promise: Promise<unknown>, ms: number, timedOut: T, settled: T): Promise<T> {
  return new Promise<T>((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(timedOut), ms);
    const finish = (): void => {
      clearTimeout(timer);
      resolvePromise(settled);
    };
    promise.then(finish, finish);
  });
}

export function uriFor(absolutePath: string): string {
  return pathToFileURL(absolutePath).toString();
}

/**
 * One spelling for one file, so two names for it cannot be two files.
 *
 * On Windows a drive letter's case is not significant and every producer
 * picks its own: `process.cwd()` and `path.resolve()` give `C:\`,
 * `typescript-language-server` sends `file:///c%3A/…` for a definition and
 * `file:///C:/…` for a document symbol IN THE SAME SESSION. Two of those
 * three reach this module, so without a canonical form a tag minted by
 * `lsp rename` is keyed under a path `edit` never looks up, and a diagnostics
 * wait keyed on one spelling never sees a publish sent under the other.
 * Both of those were real, and both were silent.
 */
export function normalizeFsPath(path: string): string {
  const resolved = resolve(path);
  return /^[a-z]:/.test(resolved) ? resolved[0]!.toUpperCase() + resolved.slice(1) : resolved;
}

export function pathForUri(uri: string): string {
  try {
    return normalizeFsPath(fileURLToPath(uri));
  } catch {
    return uri;
  }
}

export interface LspClientOpts {
  cwd: string;
  name: string;
  command: ResolvedServerCommand;
  /** Default per-request timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * One language server process, its JSON-RPC connection, and the set of
 * documents it has been told about.
 *
 * Deliberately NOT a singleton and deliberately not cached across sessions:
 * `LspServerPool` owns the map and the session owns the pool, so "who kills
 * this process" has exactly one answer.
 */
export class LspClient {
  readonly name: string;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private child: ChildProcess | undefined;
  private connection: MessageConnection | undefined;
  // All five are keyed by NORMALIZED PATH, never by URI string. See
  // `normalizeFsPath`: the server and Node disagree about how to spell a
  // Windows file URL, and keying on the string they disagree about is how a
  // diagnostics wait silently never fires.
  private readonly openPaths = new Set<string>();
  /** T160: open documents the server has published for — the project-loaded signal. */
  private readonly readyPaths = new Set<string>();
  private readonly diagnostics = new Map<string, Diagnostic[]>();
  private readonly publishes = new Map<string, number>();
  private readonly waiters = new Set<{ path: string; resolve: () => void }>();
  private stderr = "";
  private exited = false;
  private startedAt: string | undefined;

  constructor(private readonly opts: LspClientOpts) {
    this.name = opts.name;
    this.cwd = opts.cwd;
    this.timeoutMs = opts.timeoutMs ?? LSP_REQUEST_TIMEOUT_SECONDS * 1000;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return this.child !== undefined && !this.exited;
  }

  get startedIso(): string | undefined {
    return this.startedAt;
  }

  /** The handshake, exactly as D2 verified it: initialize, then initialized. */
  async start(): Promise<void> {
    const { exec, args, shell } = this.opts.command;
    const child = spawn(
      shell ? shellQuote(exec) : exec,
      shell ? args.map(shellQuote) : args,
      { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell },
    );
    this.child = child;
    this.startedAt = new Date().toISOString();
    child.on("exit", () => {
      this.exited = true;
      // Anything still waiting on a publish would otherwise wait out its full
      // timeout for a process that is already gone.
      for (const waiter of [...this.waiters]) waiter.resolve();
      this.waiters.clear();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-4000);
    });

    const connection = createMessageConnection(
      new StreamMessageReader(child.stdout!),
      new StreamMessageWriter(child.stdin!),
    );
    this.connection = connection;
    connection.onNotification("textDocument/publishDiagnostics", (params: unknown) => {
      const payload = params as { uri?: string; diagnostics?: Diagnostic[] } | undefined;
      if (payload?.uri === undefined) return;
      const path = pathForUri(payload.uri);
      this.diagnostics.set(path, payload.diagnostics ?? []);
      this.publishes.set(path, (this.publishes.get(path) ?? 0) + 1);
      for (const waiter of [...this.waiters]) {
        if (waiter.path === path) {
          this.waiters.delete(waiter);
          waiter.resolve();
        }
      }
    });
    // A server that asks a question nobody answers stalls. These four are the
    // ones `typescript-language-server` actually asks, and each gets the
    // smallest honest answer.
    connection.onRequest("workspace/configuration", (params: unknown) => {
      const items = (params as { items?: unknown[] } | undefined)?.items ?? [];
      return items.map(() => null);
    });
    connection.onRequest("client/registerCapability", () => null);
    connection.onRequest("window/workDoneProgress/create", () => null);
    // The server never writes a file. A rename reaches the disk through the
    // approval gate in `lsp.ts` or not at all.
    connection.onRequest("workspace/applyEdit", () => ({
      applied: false,
      failureReason: "lykos applies workspace edits through its own approval gate",
    }));
    connection.onError(() => undefined);
    connection.onClose(() => undefined);
    connection.listen();

    const rootUri = uriFor(resolve(this.cwd));
    await this.request("initialize", {
      processId: process.pid,
      rootUri,
      rootPath: resolve(this.cwd),
      workspaceFolders: [{ uri: rootUri, name: parsePath(resolve(this.cwd)).base }],
      capabilities: CLIENT_CAPABILITIES,
    });
    this.connection.sendNotification("initialized", {});
  }

  /** What the server has said on stderr, for a message a human can act on when it dies. */
  get stderrTail(): string {
    return this.stderr.trim();
  }

  /**
   * One request, with the named timeout. A timeout cancels the request and
   * leaves the server running: the session's index took seconds to build and
   * one slow answer is not a reason to throw it away (D5).
   */
  async request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    const connection = this.connection;
    if (connection === undefined) throw new Error(`lykos lsp: ${this.name} is not started.`);
    const limit = timeoutMs ?? this.timeoutMs;
    const source = new CancellationTokenSource();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await new Promise<T>((resolvePromise, rejectPromise) => {
        timer = setTimeout(() => {
          source.cancel();
          rejectPromise(
            new LspTimeoutError(
              `${this.name} did not answer ${method} within ${Math.round(limit / 100) / 10}s. The server is still ` +
                `running; retry with a larger timeout, or use grep if the file is one the server has not indexed yet.`,
            ),
          );
        }, limit);
        connection.sendRequest<T>(method, params, source.token).then(resolvePromise, rejectPromise);
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      source.dispose();
    }
  }

  notify(method: string, params: unknown): void {
    this.connection?.sendNotification(method, params);
  }

  /** D8: tell the server about a file before asking about it, once. Returns the URI a request should name. */
  ensureOpen(absolutePath: string, text: string): string {
    const path = normalizeFsPath(absolutePath);
    const uri = uriFor(path);
    if (this.openPaths.has(path)) return uri;
    this.openPaths.add(path);
    this.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: languageIdForPath(path), version: 1, text },
    });
    return uri;
  }

  /**
   * Open a document and wait until the server has actually looked at it.
   *
   * A document already open is ready by definition — the wait happened the
   * first time. See `LSP_PROJECT_LOAD_TIMEOUT_MS` for why answering before
   * this settles is worse than answering slowly.
   */
  async ensureReady(absolutePath: string, text: string, waitMs = LSP_PROJECT_LOAD_TIMEOUT_MS): Promise<string> {
    const path = normalizeFsPath(absolutePath);
    if (this.readyPaths.has(path)) return uriFor(path);
    // T160: a document left open by an earlier not-ready call counts any
    // publish since it was opened; a fresh one counts only what follows.
    const before = this.openPaths.has(path) ? 0 : this.publishCount(path);
    const uri = this.ensureOpen(path, text);
    if (!(await this.waitForPublish(path, before, waitMs))) {
      throw new LspNotReadyError(lspNotReadyMessage(this.name, relativeForMessage(this.cwd, path), waitMs));
    }
    this.readyPaths.add(path);
    return uri;
  }

  /** T160: has the server published for this document since it was opened — the project-loaded signal. */
  isReady(absolutePath: string): boolean {
    return this.readyPaths.has(normalizeFsPath(absolutePath));
  }

  /** Forget a document, so the next request re-opens it with whatever is on disk now. */
  close(absolutePath: string): void {
    const path = normalizeFsPath(absolutePath);
    if (!this.openPaths.has(path)) return;
    this.openPaths.delete(path);
    this.readyPaths.delete(path);
    this.diagnostics.delete(path);
    this.publishes.delete(path);
    this.notify("textDocument/didClose", { textDocument: { uri: uriFor(path) } });
  }

  isOpen(absolutePath: string): boolean {
    return this.openPaths.has(normalizeFsPath(absolutePath));
  }

  publishCount(absolutePath: string): number {
    return this.publishes.get(normalizeFsPath(absolutePath)) ?? 0;
  }

  diagnosticsFor(absolutePath: string): Diagnostic[] {
    return this.diagnostics.get(normalizeFsPath(absolutePath)) ?? [];
  }

  /** Resolve when a `publishDiagnostics` for this file arrives after `since`, or when the wait runs out. */
  async waitForPublish(absolutePath: string, since: number, timeoutMs: number): Promise<boolean> {
    const path = normalizeFsPath(absolutePath);
    if (this.publishCount(path) > since) return true;
    if (!this.running) return false;
    return await new Promise<boolean>((resolvePromise) => {
      const done = (): void => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolvePromise(this.publishCount(path) > since);
      };
      const waiter = { path, resolve: done };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  /**
   * D5: `shutdown`, then `exit`, then kill if it has not gone.
   *
   * Every branch ends with the process dead. A language server that survives
   * its session is a process the user has to find and kill by hand, and the
   * ticket has a checkbox for exactly this.
   */
  async shutdown(): Promise<void> {
    const child = this.child;
    const connection = this.connection;
    this.child = undefined;
    this.connection = undefined;
    this.openPaths.clear();
    this.readyPaths.clear();
    if (child === undefined) return;
    const dead = new Promise<void>((resolvePromise) => {
      if (this.exited || child.exitCode !== null || child.signalCode !== null) return resolvePromise();
      child.once("exit", () => resolvePromise());
    });
    if (connection !== undefined) {
      try {
        await settleWithin(connection.sendRequest("shutdown", null), LSP_SHUTDOWN_GRACE_MS, false, true);
        connection.sendNotification("exit");
      } catch {
        // A server that cannot be asked politely is killed below. There is no
        // outcome here where the process is allowed to stay.
      }
    }
    if (!(await settleWithin(dead, LSP_SHUTDOWN_GRACE_MS, false, true))) {
      child.kill("SIGKILL");
      await settleWithin(dead, LSP_SHUTDOWN_GRACE_MS, false, true);
    }
    try {
      connection?.dispose();
    } catch {
      // Disposing a connection whose stream is already gone throws on some
      // Node versions; the process is what matters and it is already dead.
    }
    this.exited = true;
  }
}

// ---------------------------------------------------------------------------
// The pool (D5)
// ---------------------------------------------------------------------------

/** Why a file has no client, in the words the model is shown. */
export interface LspUnavailable {
  ok: false;
  reason: string;
}

export interface LspAvailable {
  ok: true;
  client: LspClient;
  key: string;
}

export interface LspServerPoolOpts {
  cwd: string;
  servers?: Readonly<Record<string, LspServerDecl>>;
  timeoutSeconds?: number;
  env?: NodeJS.ProcessEnv;
  /**
   * T171: whether the user has trusted this project. Absent means not: a
   * server binary that lives inside an untrusted workspace is the
   * workspace's code, and the host does not run it.
   */
  workspaceTrusted?: boolean;
}

export interface LspServerStatus {
  key: string;
  command: string;
  extensions: string[];
  /** The executable that was found, or undefined when nothing resolved. */
  found: string | undefined;
  running: boolean;
  pid: number | undefined;
}

/**
 * One server process per language per session (D5).
 *
 * Held on a session-scoped object rather than in a module-level map, because
 * a module-level map leaks one session's servers into the next one in the
 * same process — which is every MCP worker and every test file — and because
 * "who shuts these down" must have exactly one answer.
 */
export class LspServerPool {
  readonly servers: Readonly<Record<string, LspServerDecl>>;
  private readonly clients = new Map<string, LspClient>();
  private readonly failures = new Map<string, string>();

  constructor(private readonly opts: LspServerPoolOpts) {
    this.servers = opts.servers ?? DEFAULT_LSP_SERVERS;
  }

  get cwd(): string {
    return this.opts.cwd;
  }

  /**
   * D4: a language with no server, or a server whose executable is not on the
   * machine, is an ORDINARY ANSWER naming what would configure it — the rule
   * `web_search` follows for a missing key. A spawn error never reaches the
   * model.
   */
  async clientFor(absolutePath: string): Promise<LspAvailable | LspUnavailable> {
    const key = serverKeyForPath(this.servers, absolutePath);
    if (key === undefined) {
      const ext = extname(absolutePath) || "(none)";
      const known = Object.entries(this.servers)
        .map(([name, decl]) => `${name} (${decl.extensions.join(" ")})`)
        .join(", ");
      return {
        ok: false,
        reason:
          `No language server is configured for ${ext} files. Configure one under \`${LSP_CONFIG_KEY}\` in ` +
          `.lykos/config.yaml, giving it a command and the extensions it owns. ` +
          (known === "" ? "No servers are configured at all." : `Configured today: ${known}.`),
      };
    }
    return await this.clientForKey(key);
  }

  async clientForKey(key: string): Promise<LspAvailable | LspUnavailable> {
    const existing = this.clients.get(key);
    if (existing !== undefined) return { ok: true, client: existing, key };
    const failed = this.failures.get(key);
    if (failed !== undefined) return { ok: false, reason: failed };

    const decl = this.servers[key];
    if (decl === undefined) {
      return { ok: false, reason: `No server named ${JSON.stringify(key)} under \`${LSP_CONFIG_KEY}\`.` };
    }
    const resolved = resolveServerCommand(this.opts.cwd, decl, this.opts.env ?? process.env);
    if (resolved === undefined) {
      const reason =
        `The server configured for ${key} is \`${decl.command}\`, and it is not on this machine: it was not ` +
        `found in this project's node_modules and not on PATH. Install it, or point \`${LSP_CONFIG_KEY}.${key}.command\` ` +
        `at an executable that exists.`;
      this.failures.set(key, reason);
      return { ok: false, reason };
    }
    // The executable AND any argument that names an existing file in the
    // workspace: `node node_modules/x/cli.js` runs workspace code although
    // `node` is outside it.
    // `--require=./x.cjs` names a file too, so the value after `=` is checked as well.
    const named = resolved.args.flatMap((a) => (a.startsWith("-") ? (a.includes("=") ? [a.slice(a.indexOf("=") + 1)] : []) : [a]));
    const local = [resolved.found, ...named.filter((a) => a !== "" && existsSync(resolve(this.opts.cwd, a)))].find(
      (p) => isInsideWorkspace(this.opts.cwd, resolve(this.opts.cwd, p)),
    );
    if (this.opts.workspaceTrusted !== true && local !== undefined) {
      const reason =
        `The ${key} language server would run ${local}, which is inside this workspace, and the workspace is not trusted. ` +
        `A project can ship its own program under a server's name, and lsp runs on the host, so Lykos will not start it. ` +
        `Trust this project (run lykos here and answer the trust prompt), or point \`${LSP_CONFIG_KEY}.${key}.command\` ` +
        `at an executable outside the project.`;
      this.failures.set(key, reason);
      return { ok: false, reason };
    }
    const client = new LspClient({
      cwd: this.opts.cwd,
      name: key,
      command: resolved,
      timeoutMs: (this.opts.timeoutSeconds ?? LSP_REQUEST_TIMEOUT_SECONDS) * 1000,
    });
    try {
      await client.start();
    } catch (err) {
      // Never let a spawn error reach the model (D4). The message names the
      // command and what the server said, which is what a human needs.
      await client.shutdown();
      const detail = err instanceof Error ? err.message : String(err);
      const tail = client.stderrTail;
      const reason =
        `The ${key} language server (\`${decl.command}\`, found at ${resolved.found}) did not start: ${detail}.` +
        (tail === "" ? "" : `\nIt said: ${tail}`);
      this.failures.set(key, reason);
      return { ok: false, reason };
    }
    this.clients.set(key, client);
    return { ok: true, client, key };
  }

  /** What `lsp status` reports: every configured server, and whether it is running. */
  status(): LspServerStatus[] {
    return Object.entries(this.servers).map(([key, decl]) => {
      const client = this.clients.get(key);
      const resolved = resolveServerCommand(this.opts.cwd, decl, this.opts.env ?? process.env);
      return {
        key,
        command: decl.command,
        extensions: [...decl.extensions],
        found: resolved?.found,
        running: client?.running ?? false,
        pid: client?.pid,
      };
    });
  }

  /** Every started server's pid, for a test that has to prove they are gone. */
  pids(): number[] {
    return [...this.clients.values()].map((c) => c.pid).filter((p): p is number => p !== undefined);
  }

  /** D5: session teardown. Every client, every time, whatever any one of them does. */
  async shutdownAll(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(
      clients.map(async (client) => {
        try {
          await client.shutdown();
        } catch {
          // Shutdown already guarantees the process is dead on every branch;
          // a throw here would only stop the OTHER servers being shut down.
        }
      }),
    );
  }
}
