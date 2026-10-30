// R6 (2026-10-06): where `lykos run`'s task comes from, besides the command line.
//
// **Why.** On Windows a task passed as an argument through a `.cmd` launcher
// (`npm run dev -- run "..."`, `npx lykos`, `lykos.cmd` from `cmd.exe` or a
// `shell: true` spawn) is cut at its first newline by `cmd.exe`, and every
// argument after it is dropped, with no error. P4 demo run 3 ran on the first
// line of its task that way. Windows PowerShell 5.1 also strips the `"` inside
// an argument it passes to a native program. Nothing a process receives can
// say its text was cut, so the fix is a way in that is not an argument.
//
// **The shape is Pi's** (`dist/cli/initial-message.js`,
// `dist/cli/file-processor.js`):
//
//  - `@path` arguments: each file's text is added as
//    `<file name="<absolute path>">\n<text>\n</file>\n`, Pi's format. An empty
//    file is skipped, as in Pi. A missing or unreadable one is an error.
//  - piped stdin: read when a lone `-` asks for it, or when stdin is not a
//    terminal and no other task was given. A `lykos run "task"` launched by a
//    harness whose stdin is an open pipe therefore never waits on it.
//  - the order is Pi's: stdin, then the files, then the task argument.
//
// Images are not attached: the standalone and delegate paths take a text brief.

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { RUN_VALUED_FLAGS } from "./args.js";

export interface RunBriefArgs {
  /** The task argument, if one was given. */
  message?: string;
  /** Paths named with `@`, in order, without the `@`. */
  files: string[];
  /** A lone `-` was given. */
  stdin: boolean;
}

/**
 * Splits `lykos run`'s arguments into the task, `@path` files and the stdin
 * marker. A flag's value is never one of them (`RUN_VALUED_FLAGS`), and after
 * `--` the next argument is the task verbatim, even if it starts with `@` or
 * is `-`, as `firstPositional` already treats it.
 */
export function parseRunBriefArgs(args: readonly string[], valued: readonly string[] = RUN_VALUED_FLAGS): RunBriefArgs {
  const consumesNext = new Set(valued.map((n) => `--${n}`));
  const out: RunBriefArgs = { files: [], stdin: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      const next = args[i + 1];
      if (out.message === undefined && next !== undefined) out.message = next;
      break;
    }
    if (arg.startsWith("--")) {
      if (!arg.includes("=") && consumesNext.has(arg)) i += 1;
      continue;
    }
    if (arg === "-") {
      out.stdin = true;
      continue;
    }
    if (arg.startsWith("@") && arg.length > 1) {
      out.files.push(stripQuotes(arg.slice(1)));
      continue;
    }
    if (out.message === undefined) out.message = arg;
  }
  return out;
}

function stripQuotes(path: string): string {
  if (path.length > 1 && ((path.startsWith('"') && path.endsWith('"')) || (path.startsWith("'") && path.endsWith("'")))) {
    return path.slice(1, -1);
  }
  return path;
}

export interface BriefSources {
  cwd: string;
  /** Whether stdin is a terminal. A terminal is never read. */
  stdinIsTTY: boolean;
  /** Reads all of stdin as UTF-8. Injected so a test needs no pipe. */
  readStdin: () => Promise<string>;
  readText?: (path: string) => Promise<string>;
  size?: (path: string) => Promise<number>;
}

export type ResolvedBrief = { brief: string; fromStdin: boolean; files: string[] } | { error: string };

/** The task `lykos run` sends, built from the argument, `@path` files and stdin. */
export async function resolveRunBrief(args: RunBriefArgs, src: BriefSources): Promise<ResolvedBrief> {
  const readText = src.readText ?? ((p: string) => readFile(p, "utf8"));
  const size = src.size ?? (async (p: string) => (await stat(p)).size);

  let fileText = "";
  const files: string[] = [];
  for (const rel of args.files) {
    const abs = resolve(src.cwd, rel);
    let bytes: number;
    let text: string;
    try {
      bytes = await size(abs);
      text = bytes === 0 ? "" : await readText(abs);
    } catch (err) {
      const why = (err as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : String((err as Error).message ?? err);
      return { error: `cannot read @${rel} (${abs}): ${why}` };
    }
    if (bytes === 0) continue;
    files.push(abs);
    fileText += `<file name="${abs}">\n${stripBom(text)}\n</file>\n`;
  }

  // Read stdin when asked, or when it is a pipe and nothing else gave a task.
  const wantStdin = args.stdin || (!src.stdinIsTTY && args.message === undefined && args.files.length === 0);
  let stdinText: string | undefined;
  if (wantStdin) {
    if (src.stdinIsTTY) {
      return { error: "`-` reads the task from piped stdin, but stdin is a terminal — pipe the task in, or pass it as @file" };
    }
    const raw = stripBom(await src.readStdin()).trim();
    if (raw.length > 0) stdinText = raw;
    else if (args.stdin) return { error: "`-` was given but stdin was empty" };
  }

  const parts: string[] = [];
  if (stdinText !== undefined) parts.push(`${stdinText}\n`);
  if (fileText.length > 0) parts.push(fileText);
  if (args.message !== undefined) parts.push(args.message);
  const brief = parts.join("").trimEnd();
  if (brief.trim().length === 0) {
    return { error: 'expected a brief, e.g. `lykos run "..."`, `lykos run @task.md` or `... | lykos run -`' };
  }
  return { brief, fromStdin: stdinText !== undefined, files };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Reads all of process.stdin as UTF-8, saying after a second what it is waiting for. */
export function readProcessStdin(): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const notice = setTimeout(() => {
      process.stderr.write("lykos run: reading the task from piped stdin (waiting for EOF; ctrl+c to abort)…\n");
    }, 1000);
    notice.unref();
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(notice);
      resolvePromise(data);
    });
    process.stdin.on("error", (err) => {
      clearTimeout(notice);
      reject(err);
    });
    process.stdin.resume();
  });
}
