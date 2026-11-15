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
// T268 (spec #25, decision 7): an `@path` written inside the prompt attaches the file too, judged by the
// workspace's path rules as a file tool's path is. An image, mentioned or given as an argument, is image input
// (`ImageAttachment`), with Pi's `<file name="…"></file>` block naming it in the text; the session refuses it
// when its model takes no images.

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import { resolvePathRulesAndContext } from "../gate/approval.js";
import type { ImageAttachment } from "../session/session.js";
import { resolveEditPath } from "../tools/edit.js";
import { confinedPathVerdict } from "../tools/workspace-confine.js";
import { RUN_VALUED_FLAGS } from "./args.js";

export interface RunBriefArgs {
  /** The task argument, if one was given. */
  message?: string;
  /** Paths named with `@`, in order, without the `@`. */
  files: string[];
  /** A lone `-` was given. */
  stdin: boolean;
  /** T268: the task came after `--`, so it is verbatim and its `@path` mentions attach nothing. */
  verbatim?: true;
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
      if (out.message === undefined && next !== undefined) {
        out.message = next;
        out.verbatim = true;
      }
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

/**
 * T268: the `@path` mentions written inside a prompt, in order, without the `@`. A mention starts the prompt or
 * follows whitespace, so `me@example.com` is not one; `@"a b.md"` names a path with a space.
 */
export function promptMentions(message: string): string[] {
  const out: string[] = [];
  for (const m of message.matchAll(/(?:^|\s)@("[^"]+"|'[^']+'|\S+)/g)) out.push(stripQuotes(m[1]!));
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

export type ResolvedBrief = { brief: string; fromStdin: boolean; files: string[]; images: ImageAttachment[] } | { error: string };

/** The task `lykos run` sends, built from the argument, `@path` files and stdin. */
export async function resolveRunBrief(args: RunBriefArgs, src: BriefSources): Promise<ResolvedBrief> {
  const readText = src.readText ?? ((p: string) => readFile(p, "utf8"));
  const size = src.size ?? (async (p: string) => (await stat(p)).size);

  // T268: a mention is judged by the workspace's path rules, as a file tool's path is; an `@path` argument is the
  // task itself (R6) and is not.
  const mentions = args.message !== undefined && args.verbatim !== true ? promptMentions(args.message).map((m) => trimMention(m, src.cwd)) : [];
  const named = [...args.files.map((rel) => ({ rel, abs: resolve(src.cwd, rel), mention: false })), ...mentions.map((rel) => ({ rel, abs: resolveEditPath(rel, src.cwd), mention: true }))];
  const pathRules = mentions.length > 0 ? await resolvePathRulesAndContext(src.cwd) : undefined;

  let fileText = "";
  const files: string[] = [];
  const images: ImageAttachment[] = [];
  for (const { rel, abs, mention } of named) {
    if (files.includes(abs)) continue;
    if (mention && pathRules !== undefined) {
      const { target, verdict } = confinedPathVerdict(rel, src.cwd, "read", pathRules.rules, pathRules.ctx);
      if (verdict.decision === "deny") return { error: `cannot attach @${rel} (${abs}): ${verdict.reason ?? "denied by a path rule"}` };
      if (verdict.decision === "ask") return { error: `cannot attach @${rel} (${target}): it is outside the allowed folders and there is no one to ask` };
    }
    let bytes: number;
    try {
      bytes = await size(abs);
    } catch (err) {
      return { error: `cannot read @${rel} (${abs}): ${readFailure(err)}` };
    }
    if (bytes === 0) continue;
    const image = await readImage(abs);
    if (image !== undefined && "error" in image) return { error: `cannot attach @${rel} (${abs}): ${image.error}` };
    files.push(abs);
    if (image !== undefined) {
      images.push(image.image);
      fileText += `<file name="${abs}">${image.hints.join("\n")}</file>\n`;
      continue;
    }
    let text: string;
    try {
      text = await readText(abs);
    } catch (err) {
      return { error: `cannot read @${rel} (${abs}): ${readFailure(err)}` };
    }
    if (text.includes("\u0000")) return { error: `cannot attach @${rel} (${abs}): it is neither text nor an image Lykos can attach (PNG, JPEG, GIF, WebP)` };
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
  return { brief, fromStdin: stdinText !== undefined, files, images };
}

function readFailure(err: unknown): string {
  return (err as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : String((err as Error).message ?? err);
}

/** A mention's path without the punctuation a sentence puts after it (`@a.ts,`), unless that is part of a real name. */
function trimMention(mention: string, cwd: string): string {
  const trimmed = mention.replace(/[.,;:!?)\]}'"]+$/, "");
  return trimmed.length === 0 || trimmed === mention || existsSync(resolveEditPath(mention, cwd)) ? mention : trimmed;
}

/** The image formats a model takes inline, by their leading bytes: Pi's own set (`utils/mime.js`) without BMP. */
function imageMimeType(head: Uint8Array): string | undefined {
  const starts = (sig: readonly number[], at = 0): boolean => sig.every((b, i) => head[at + i] === b);
  const ascii = (text: string, at = 0): boolean => starts([...text].map((c) => c.charCodeAt(0)), at);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii("GIF8")) return "image/gif";
  if (ascii("RIFF") && ascii("WEBP", 8)) return "image/webp";
  return undefined;
}

/**
 * An image file as image input, resized to the inline limits by Pi's `resizeImage`, with Pi's dimension note when it
 * was resized. Undefined when the file is not an image.
 */
async function readImage(abs: string): Promise<{ image: ImageAttachment; hints: string[] } | { error: string } | undefined> {
  const bytes = await readFile(abs);
  const mimeType = imageMimeType(bytes.subarray(0, 16));
  if (mimeType === undefined) return undefined;
  const resized = await resizeImage(bytes, mimeType);
  if (resized === null) return { error: "the image could not be resized below the inline image size limit" };
  const note = formatDimensionNote(resized);
  return { image: { path: abs, mimeType: resized.mimeType, data: resized.data }, hints: note !== undefined ? [note] : [] };
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
