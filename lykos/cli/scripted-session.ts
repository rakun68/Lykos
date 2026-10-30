// The scripted-model session — the one test seam the strength phase adds, and
// the one every later P4 ticket extends rather than copying.
//
// A fake model, scripted turn by turn, drives a REAL standalone session —
// `runStandaloneTask`, the same boot, gate, post-edit loop, checkpoints and
// ingest a person gets from `lykos run` — inside a
// temporary git repository, at no model cost. The fake model is Pi's own
// faux provider (`@earendil-works/pi-ai` `providers/faux`), registered as a
// native provider on the session's model runtime through
// `RunStandaloneTaskInput.nativeProviders`. Lykos does not write a fake of
// its own: Pi ships one (AGENTS.md rule 2).
//
// A scenario is a script of model turns plus assertions on what a person
// could read afterwards: the ledger, `lykos show`, and the files on disk.
//
//   const run = await runScriptedSession({
//     files: { "a.txt": "one\n" },
//     script: [
//       reply(call("write", { path: "a.txt", content: "two\n" })),
//       reply(say("done")),
//     ],
//   });
//   assert.equal(run.session().edited_file_count, 1);
//   assert.match(run.show(), /tool_result  write  state=ok/);
//
// Each entry of `script` answers ONE model request. A step may be a function
// of the context the model was sent, so a later step can read an earlier
// tool result (an anchor, a job id) the way a real model would. A script
// that is too short ends the session in error ("No more faux responses
// queued"); one that is too long is reported in `unusedSteps`. Both are
// failures of the scenario, not of the session under test. A step that
// throws — an assertion on what the model was sent — fails the scenario with
// that error rather than surfacing as a provider error.
//
// It lives in cli/ because it stands where a person stands: it runs a session
// the way `lykos run` does and reads it back the way
// `lykos show` does (a domain module may not import cli/).
//
// Isolation: the first call points HOME/USERPROFILE, the Pi host dir (and so
// Pi's agent dir) and the credential db at a throwaway directory for the rest of
// this process. `node --test` runs each test file in its own process, so
// this touches only the file that imports this module — and never the real
// home. Import it only from a test file.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adoptPiHost, PI_HOST_DIR_ENV } from "../config/pi-host.js";
import { openLedgerSync } from "../ledger/use.js";
import type { Provider } from "../session/model-runtime.js";
import { runStandaloneTask, type RunStandaloneTaskInput, type RunStandaloneTaskResult } from "../session/session.js";
import { runRewindCli, type RewindOptions } from "./rewind.js";
import { runResume } from "./resume.js";
import { runShow } from "./show.js";

// ---------------------------------------------------------------------------
// The faux provider, reached where Pi installs it
// ---------------------------------------------------------------------------

/** The slice of Pi's faux module this seam uses (pi-ai `dist/providers/faux.d.ts`). */
interface FauxContent {
  type: string;
  [k: string]: unknown;
}
interface FauxAssistantMessage {
  role: "assistant";
  content: FauxContent[];
  stopReason: string;
  [k: string]: unknown;
}
/** What the model was sent on one request: Pi's `Context`. */
export interface ModelContext {
  systemPrompt?: string;
  messages: Array<{ role: string; content: unknown; toolName?: string; isError?: boolean; [k: string]: unknown }>;
  tools?: Array<{ name: string; [k: string]: unknown }>;
  /** T190: the `sessionId` the request carried -- the provider's prompt-cache key. Absent when it carried none. */
  sessionId?: string;
  /** T190: the request's tool choice and transport, when it set them. */
  toolChoice?: string;
  transport?: string;
}
interface FauxHandle {
  provider: Provider;
  getModel(): { provider: string; id: string };
  setResponses(steps: unknown[]): void;
  getPendingResponseCount(): number;
  state: { callCount: number };
}
interface FauxModule {
  fauxProvider(options?: {
    provider?: string;
    api?: string;
    models?: Array<{ id: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean }>;
  }): FauxHandle;
  fauxText(text: string): FauxContent;
  fauxToolCall(name: string, args: Record<string, unknown>, options?: { id?: string }): FauxContent;
  fauxAssistantMessage(content: FauxContent[], options?: { stopReason?: string; errorMessage?: string }): FauxAssistantMessage;
}

let fauxModule: Promise<FauxModule> | undefined;

/**
 * `@earendil-works/pi-ai` is Pi's dependency, not Lykos's: npm installs it
 * under `pi-coding-agent/node_modules` (Pi ships a shrinkwrap). Try the hoisted
 * name first in case a future install flattens it, then the nested path
 * beside the resolved coding-agent entry.
 */
function loadFaux(): Promise<FauxModule> {
  fauxModule ??= (async () => {
    try {
      return (await import("@earendil-works/pi-ai/providers/faux" as string)) as FauxModule;
    } catch {
      const agentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
      // <pkg>/dist/index.js -> <pkg>/node_modules/@earendil-works/pi-ai/dist/providers/faux.js
      const pkg = dirname(dirname(agentEntry));
      const nested = join(pkg, "node_modules", "@earendil-works", "pi-ai", "dist", "providers", "faux.js");
      if (!existsSync(nested)) {
        throw new Error(`scripted-session: Pi's faux provider not found (looked for ${nested})`);
      }
      return (await import(pathToFileURL(nested).href)) as FauxModule;
    }
  })();
  return fauxModule;
}

// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------

/** One content block of a scripted model reply. */
export type ScriptedBlock =
  | { kind: "text"; text: string }
  | { kind: "call"; tool: string; args: Record<string, unknown>; id?: string };

/** One model response: text and/or tool calls. Tool calls make Pi run the tools and ask again; text alone ends the turn. */
export interface ScriptedReply {
  blocks: ScriptedBlock[];
  /** T152: set, the response is a provider error with this message (`stopReason: "error"`). */
  error?: string;
}

/** A response, or a function of what the model was sent that returns one. */
export type ScriptStep = ScriptedReply | ((context: ModelContext) => ScriptedReply);

/** Call any registered tool by its wire name. */
export function call(tool: string, args: Record<string, unknown>, id?: string): ScriptedBlock {
  return { kind: "call", tool, args, ...(id !== undefined ? { id } : {}) };
}

/** Call a MOUNTED tool the way a model must: through the `tool_call` transport. */
export function mounted(tool: string, args: Record<string, unknown>, id?: string): ScriptedBlock {
  return call("tool_call", { name: tool, arguments: args }, id);
}

/** Assistant text. A reply whose blocks are all text ends the turn. */
export function say(text: string): ScriptedBlock {
  return { kind: "text", text };
}

/** One model response made of these blocks. */
export function reply(...blocks: ScriptedBlock[]): ScriptedReply {
  return { blocks };
}

/** T152: a model response that is a provider error — e.g. a compaction summary that fails. */
export function fail(message: string): ScriptedReply {
  return { blocks: [], error: message };
}

/** The text of every tool result the model has been sent so far, oldest first. */
export function toolResults(context: ModelContext): Array<{ tool: string; text: string; isError: boolean }> {
  const out: Array<{ tool: string; text: string; isError: boolean }> = [];
  for (const m of context.messages) {
    if (m.role !== "toolResult") continue;
    const blocks = Array.isArray(m.content) ? (m.content as Array<{ type?: string; text?: string }>) : [];
    let tool = m.toolName ?? "?";
    if (tool === "tool_call") {
      const callId = m.toolCallId as string | undefined;
      if (callId) {
        for (const prev of context.messages) {
          if (prev.role === "assistant" && Array.isArray(prev.content)) {
            for (const b of prev.content as Array<{ type?: string; id?: string; args?: { name?: string }; arguments?: { name?: string } }>) {
              if (b.type === "toolCall" && b.id === callId) {
                const targetName = b.args?.name ?? b.arguments?.name;
                if (typeof targetName === "string") {
                  tool = targetName;
                }
                break;
              }
            }
          }
        }
      }
    }
    out.push({
      tool,
      text: blocks.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("\n"),
      isError: m.isError === true,
    });
  }
  return out;
}

/** The last tool result the model was sent. Throws if there is none — a script that asks for one expects one. */
export function lastToolResult(context: ModelContext): { tool: string; text: string; isError: boolean } {
  const all = toolResults(context);
  const last = all[all.length - 1];
  if (!last) throw new Error("scripted-session: the model has not been sent a tool result yet");
  return last;
}

function toFaux(faux: FauxModule, r: ScriptedReply): FauxAssistantMessage {
  if (r.error !== undefined) return faux.fauxAssistantMessage([], { stopReason: "error", errorMessage: r.error });
  const content = r.blocks.map((b) =>
    b.kind === "text"
      ? faux.fauxText(b.text)
      : faux.fauxToolCall(b.tool, b.args, b.id !== undefined ? { id: b.id } : {}),
  );
  const hasCall = r.blocks.some((b) => b.kind === "call");
  return faux.fauxAssistantMessage(content, { stopReason: hasCall ? "toolUse" : "stop" });
}

// ---------------------------------------------------------------------------
// The throwaway world
// ---------------------------------------------------------------------------

let isolatedHome: string | undefined;

/** Point everything that reads a home directory at a throwaway one, once per process. */
function isolateHome(): string {
  if (isolatedHome !== undefined) return isolatedHome;
  const home = mkdtempSync(join(tmpdir(), "lykos-scripted-home-"));
  mkdirSync(join(home, ".lykos"), { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env[PI_HOST_DIR_ENV] = join(home, ".lykos", "pi-host");
  // What `lykos/cli.ts` does before dispatch: Pi's agent dir is the Pi host.
  adoptPiHost();
  process.env.LYKOS_CREDENTIALS_DB = join(home, ".lykos", "credentials.db");
  isolatedHome = home;
  return home;
}

/**
 * T147: the throwaway Pi host directory every scripted session in this process
 * runs from — where a test lays down an installed extension package
 * (`<pi-host>/npm/node_modules/<name>`) before the session boots.
 */
export function scriptedPiHost(): string {
  isolateHome();
  return process.env[PI_HOST_DIR_ENV]!;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

/** A fresh git repository holding `files`, committed, with `.lykos/config.yaml` if given. */
function makeRepo(files: Record<string, string>, configYaml: string | undefined, initRepo = true): string {
  const workspace = mkdtempSync(join(tmpdir(), "lykos-scripted-ws-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(workspace, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  mkdirSync(join(workspace, ".lykos"), { recursive: true });
  if (configYaml !== undefined) writeFileSync(join(workspace, ".lykos", "config.yaml"), configYaml);
  // The ledger and transcripts live under .lykos/; they are runtime state, not the project's.
  writeFileSync(join(workspace, ".gitignore"), ".lykos/\n");
  if (!initRepo) return workspace;
  git(workspace, "init", "-q", "-b", "main");
  git(workspace, "config", "user.email", "scripted@lykos.test");
  git(workspace, "config", "user.name", "Scripted Session");
  git(workspace, "config", "commit.gpgsign", "false");
  git(workspace, "config", "core.autocrlf", "false");
  git(workspace, "add", "-A");
  git(workspace, "commit", "-q", "-m", "scripted-session fixture");
  return workspace;
}

// ---------------------------------------------------------------------------
// Running one scenario
// ---------------------------------------------------------------------------

export interface ScriptedSessionOptions {
  /** The model's responses, one per request. */
  script: ScriptStep[];
  /** Files in the repository before the session, committed. Paths are relative and use `/`. */
  files?: Record<string, string>;
  /** Body of `.lykos/config.yaml` in the repository. Absent means none. */
  config?: string;
  /** Runs after the repository is made and before the session starts: a symlink, a planted binary, anything a file map cannot say. */
  setup?: (workspace: string) => void;
  /** The user's prompt. */
  prompt?: string;
  /** `--yes`. Default true: a scripted session has no human to approve its writes. */
  autoApprove?: boolean;
  /** Anything else `runStandaloneTask` takes (tools, label, specialist…). Model and workspace are the seam's. */
  extra?: Omit<RunStandaloneTaskInput, "workspace" | "prompt" | "model" | "nativeProviders" | "ledgerPath" | "autoApprove">;
  /**
   * T170: `false` leaves the files in a plain folder with no repository, to
   * prove a standalone session outside one. Default true.
   */
  repo?: boolean;
  /**
   * T170: environment variables set for the session's duration and restored
   * after (`undefined` deletes one) — `PATH` with no git on it is a machine
   * without git.
   */
  env?: Record<string, string | undefined>;
  /** The faux model's context window. Default 128000, Pi's faux default. */
  contextWindow?: number;
}

export interface ScriptedSession {
  workspace: string;
  ledgerPath: string;
  /** What `runStandaloneTask` returned. */
  result: RunStandaloneTaskResult;
  /** The session id; throws with the run's error when the session did not complete. */
  sessionId: string;
  /** How many model requests the session made. */
  modelCalls: number;
  /** Script steps never reached. A passing scenario has none. */
  unusedSteps: number;
  /** Every context the model was sent, in order — "what the model was sent". */
  sent: ModelContext[];
  /** `lykos show <session>` text output, exactly as a person would read it. */
  show(opts?: { json?: boolean }): string;
  /** T146: `lykos rewind` in the workspace — lists with no options, restores with `{ index }`, takes one with `{ now: true }`. */
  rewind(opts?: RewindOptions): string;
  /** The session's row in the ledger's `sessions` table. */
  session(): Record<string, unknown>;
  /**
   * T152: `lykos resume` this session in the same workspace and ledger, with
   * a fresh script and prompt, the one-shot shape standing in for the
   * interactive one. The result reads the same (resumed) session.
   */
  resume(next: Pick<ScriptedSessionOptions, "script" | "prompt" | "contextWindow">): Promise<ScriptedSession>;
  /** Any read-only query against the ledger. */
  query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  /** A file in the workspace, as it is on disk now; undefined when absent. */
  file(rel: string): string | undefined;
  /** T162: everything the session wrote to stderr — what a person running it sees after the answer. */
  stderr: string;
}

export const SCRIPTED_MODEL = "faux/scripted-1";

/**
 * T162: the seam's pieces for a caller that drives a session some other way —
 * the terminal UI's entry, which `runScriptedSession` does not reach. A fresh
 * repository in the isolated home, and the scripted model's provider with the
 * handle that says how much of the script ran.
 */
export async function scriptedWorld(opts: Pick<ScriptedSessionOptions, "files" | "config" | "script" | "contextWindow" | "repo">) {
  isolateHome();
  const workspace = makeRepo(opts.files ?? {}, opts.config, opts.repo ?? true);
  const { handle, sent, errors } = await scriptedModel(opts.script, opts.contextWindow);
  return {
    workspace,
    ledgerPath: join(workspace, ".lykos", "ledger.db"),
    provider: handle.provider,
    sent,
    /** Throws the first failed script step, if any. */
    check: () => {
      if (errors.step !== undefined) throw errors.step;
    },
    modelCalls: () => handle.state.callCount,
    unusedSteps: () => handle.getPendingResponseCount(),
  };
}

/**
 * T184: another scripted model for a workspace that already exists, for a second call on the same project (a
 * continuation). The same pieces `scriptedWorld` hands out, without a new repository.
 */
export async function scriptedProvider(script: ScriptStep[], contextWindow?: number) {
  isolateHome();
  const { handle, sent, errors } = await scriptedModel(script, contextWindow);
  return {
    provider: handle.provider,
    sent,
    check: () => {
      if (errors.step !== undefined) throw errors.step;
    },
    unusedSteps: () => handle.getPendingResponseCount(),
  };
}

/** Runs one real standalone session in a fresh git repository against a scripted model. */
export async function runScriptedSession(opts: ScriptedSessionOptions): Promise<ScriptedSession> {
  isolateHome();
  const workspace = makeRepo(opts.files ?? {}, opts.config, opts.repo ?? true);
  opts.setup?.(workspace);
  const ledgerPath = join(workspace, ".lykos", "ledger.db");
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await runIn(workspace, ledgerPath, opts, undefined);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A scripted model, registered as Pi's faux provider, answering `script` in order. */
async function scriptedModel(script: ScriptStep[], contextWindow: number | undefined) {
  const faux = await loadFaux();
  const handle = faux.fauxProvider({
    provider: "faux",
    api: "faux",
    models: [{ id: "scripted-1", contextWindow: contextWindow ?? 128_000, maxTokens: 16_384 }],
  });
  const sent: ModelContext[] = [];
  // A step that throws (a failed assertion on what the model was sent) would
  // otherwise reach Pi as a provider error and end the session quietly; it is
  // kept and rethrown once the session is over.
  const errors: { step?: unknown } = {};
  handle.setResponses(
    script.map((step, index) => (context: ModelContext, streamOptions?: { sessionId?: string; toolChoice?: string; transport?: string }) => {
      // T190: the request's cache key, tool choice and transport ride along, so a test can say what a call asked for.
      context = {
        ...context,
        ...(streamOptions?.sessionId !== undefined ? { sessionId: streamOptions.sessionId } : {}),
        ...(streamOptions?.toolChoice !== undefined ? { toolChoice: streamOptions.toolChoice } : {}),
        ...(streamOptions?.transport !== undefined ? { transport: streamOptions.transport } : {}),
      };
      // Tools carry TypeBox symbols and functions; keep only what was sent.
      sent.push(JSON.parse(JSON.stringify(context)) as ModelContext);
      try {
        return toFaux(faux, typeof step === "function" ? step(context) : step);
      } catch (err) {
        errors.step ??= new Error(`scripted-session: script step ${index} threw: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        });
        throw err;
      }
    }),
  );
  return { handle, sent, errors };
}

async function runIn(
  workspace: string,
  ledgerPath: string,
  opts: ScriptedSessionOptions,
  resumeOf: string | undefined,
): Promise<ScriptedSession> {
  const { handle, sent, errors } = await scriptedModel(opts.script, opts.contextWindow);
  const input = (resume?: RunStandaloneTaskInput["resume"]): RunStandaloneTaskInput => ({
    ...(opts.extra ?? {}),
    workspace,
    ledgerPath,
    prompt: opts.prompt ?? "Do the scripted task.",
    model: SCRIPTED_MODEL,
    autoApprove: opts.autoApprove ?? true,
    nativeProviders: [handle.provider],
    ...(resume !== undefined ? { resume } : {}),
  });
  let result: RunStandaloneTaskResult | undefined;
  let stderr = "";
  if (resumeOf === undefined) {
    const teed = await teeStderr(() => runStandaloneTask(input()));
    result = teed.value;
    stderr = teed.stderr;
  } else {
    // `lykos resume` itself — its preflight, its plan, the row reopened — with
    // the one-shot shape launched in place of the interactive one.
    const code = await captureOutput(() =>
      runResume(workspace, ledgerPath, resumeOf, {
        yes: true,
        launch: async (launched) => {
          result = await runStandaloneTask(input(launched.resume));
          return result.status === "ok"
            ? { status: "ok", sessionId: result.sessionId }
            : { status: "error", message: result.status === "error" ? result.message : result.reason };
        },
      }),
    );
    if (result === undefined) throw new Error(`scripted-session: lykos resume ${resumeOf} started nothing (exit ${code.value}): ${code.stderr}`);
    stderr = code.stderr;
  }
  if (errors.step !== undefined) throw errors.step;
  const finished: RunStandaloneTaskResult = result;

  const query = <T,>(sql: string, ...params: unknown[]): T[] => {
    const ledger = openLedgerSync(ledgerPath);
    try {
      return ledger.db.prepare(sql).all(...params) as T[];
    } finally {
      ledger.close();
    }
  };

  const sessionId = (): string => {
    if (finished.status === "ok") return finished.sessionId;
    throw new Error(
      `scripted-session: the session did not complete — ${finished.status === "error" ? finished.message : finished.reason}`,
    );
  };

  return {
    workspace,
    ledgerPath,
    result: finished,
    get sessionId() {
      return sessionId();
    },
    modelCalls: handle.state.callCount,
    unusedSteps: handle.getPendingResponseCount(),
    sent,
    show: (showOpts) => captureStdout("lykos show", () => runShow(ledgerPath, sessionId(), showOpts ?? {})),
    rewind: (rewindOpts) => captureStdout("lykos rewind", () => runRewindCli(workspace, rewindOpts ?? {})),
    session: () => {
      const row = query<Record<string, unknown>>(`SELECT * FROM sessions WHERE id = ?`, sessionId())[0];
      if (!row) throw new Error(`scripted-session: no ledger row for session ${sessionId()}`);
      return row;
    },
    query,
    file: (rel) => {
      const abs = join(workspace, rel);
      return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
    },
    resume: (next) => runIn(workspace, ledgerPath, { ...opts, ...next }, sessionId()),
    stderr,
  };
}

/** Runs an async `fn`, recording what it writes to stderr while still passing it through. */
async function teeStderr<T>(fn: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  const err = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderr += String(chunk);
    return (err as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    return { value: await fn(), stderr };
  } finally {
    process.stderr.write = err;
  }
}

/** Runs an async `fn` with stdout and stderr captured; returns its value and what it wrote to stderr. */
async function captureOutput<T>(fn: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    return { value: await fn(), stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

/** Runs `fn`, returning what it wrote to stdout; throws on a non-zero exit with what it wrote to stderr. */
export function captureStdout(command: string, fn: () => number): string {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  let code: number;
  try {
    code = fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
  if (code !== 0) throw new Error(`${command} exited ${code}: ${stderr}`);
  return stdout;
}
