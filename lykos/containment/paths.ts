// One path space for the model.
//
// A contained session mounts the workspace at `/work`, but the model only ever
// sees host paths: the file tools take them, and so must `bash`. This module
// is the translation at that boundary. A command's text goes in with host
// paths and reaches the container with `/work`; output comes back the other
// way. A path outside the workspace means nothing in the container and is left
// as it was.
//
// Which drive-letter forms a Windows workspace answers to is decided by the
// workspace string, not by the machine running the code. Whether a quoted string
// with a space in it is a path is told by the command around it (T174b); where
// the command does not say, the question goes to the host through `exists`.

import { existsSync } from "node:fs";

export const WORKSPACE_IN_CONTAINER = "/work";

export interface HostStream {
  /** Translates a chunk, holding back a tail that may be the start of a `/work` path until the next chunk or `end`. */
  write(chunk: string): string;
  end(): string;
}

export interface PathTranslator {
  /** Host paths inside the workspace become `/work/...`; the text is otherwise unchanged. */
  toContainer(text: string): string;
  /** `/work/...` becomes the host path; the text is otherwise unchanged. */
  toHost(text: string): string;
  /** `toHost` for output that arrives in pieces. */
  hostStream(): HostStream;
}

const WINDOWS_DRIVE = /^([A-Za-z]):[\\/]*(.*)$/s;
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** What may not come right before a path, or it is the end of a longer one. */
const NOT_BEFORE = "(?<![\\w./\\\\~-])";
/** What may not come right after a path's last segment, or it is a different name. */
const NOT_AFTER = "(?![\\w-]|\\.\\w)";
/** The rest of a path, up to whatever ends a word on a command line. `:` and `,` end it: they join paths in lists (PATH, NODE_PATH). */
const TAIL = "[^\\s\"'`<>|;&()*?:,]*";
/** How far back from the end of its text `hostStream` will hold a `/work` path waiting for it to finish; a path that began further back is let go. */
export const MAX_HELD_WORD = 1024;

/** Commands whose arguments are paths: a quoted string after one is a path, whatever letters it holds. */
const FILE_COMMANDS = new Set(["mkdir", "rmdir", "cd", "pushd", "cat", "cp", "mv", "rm", "touch", "ls", "head", "tail", "tee", "stat", "chmod", "ln", "du"]);
/** The git subcommands whose `-m` / `--message` is free text (in `git log` or `git grep` it is something else). */
const MESSAGE_SUBCOMMANDS = new Set(["commit", "tag", "merge", "stash"]);
/** Words that run the command after them and say nothing about what it is. */
const PREFIX_WORDS = new Set(["sudo", "command", "env", "time", "exec", "nohup"]);

type Context = "path" | "text" | "unknown";

/**
 * The words of the simple command that `before` ends in, with quotes read: a separator inside a quoted argument does
 * not end the command, and a quoted argument is one word. (`before` stops at the opening quote of the string asked about.)
 */
function wordsOfLastCommand(before: string): string[] {
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | undefined;
  const endWord = (): void => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  for (let i = 0; i < before.length; i++) {
    const c = before[i]!;
    if (quote !== undefined) {
      if (c === quote) quote = undefined;
      else if (c === "\\" && quote === '"' && i + 1 < before.length) word += before[++i]!;
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === "\\" && i + 1 < before.length) {
      word += before[++i]!;
      inWord = true;
    } else if (/[;|&\n(`{]/.test(c)) {
      endWord();
      words = [];
    } else if (/\s/.test(c)) endWord();
    else {
      word += c;
      inWord = true;
    }
  }
  endWord();
  return words;
}

/** Git's own options that take their value as the next word when written without `=`. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--attr-source"]);

/** Git's subcommand: the first word that is not one of git's own options or the value of one (`-C dir`, `--git-dir /r`, `--no-pager`). */
function gitSubcommand(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (GIT_VALUE_OPTIONS.has(a)) i++;
    else if (!a.startsWith("-")) return a;
  }
  return undefined;
}

/**
 * What a quoted string is, from the command it sits in (`before` is the line up to its opening quote): the target of a
 * redirection and an argument of a file command are paths; an argument of `printf` or `echo -e`, and the message of
 * `git commit -m` or `--message`, are text; otherwise the command does not say.
 */
function contextOf(before: string): Context {
  const words = wordsOfLastCommand(before);
  if (/[<>]$/.test(words.at(-1) ?? "")) return "path";
  const at = words.findIndex((w) => !/^\w+=/.test(w) && !PREFIX_WORDS.has(w));
  const name = (words[at] ?? "").replace(/^.*[\\/]/, "").replace(/\.exe$/i, "").toLowerCase();
  const args = at < 0 ? [] : words.slice(at + 1);
  if (FILE_COMMANDS.has(name)) return "path";
  if (name === "printf") return "text";
  if (name === "echo" && args.some((a) => /^-[A-Za-z]*e[A-Za-z]*$/.test(a))) return "text";
  if (name === "git" && MESSAGE_SUBCOMMANDS.has(gitSubcommand(args) ?? "") && /^(?:-[A-Za-z]*m|--message=?)$/.test(words.at(-1) ?? "")) return "text";
  return "unknown";
}

export function pathTranslator(workspace: string, exists: (hostPath: string) => boolean = existsSync): PathTranslator {
  const windows = WINDOWS_DRIVE.exec(workspace);
  const root = workspace.replace(/[\\/]+$/, "");
  const hostRoot = windows ? root.replace(/\//g, "\\") : root;

  let prefix: string;
  if (windows) {
    const drive = escapeRegex(windows[1]!);
    const body = windows[2]!
      .split(/[\\/]+/)
      .filter((s) => s !== "")
      .map(escapeRegex)
      .join("[\\\\/]+");
    // `C:\x`, `C:/x`, `C:\\x` (an escaped backslash), and `/c/x` (Git Bash, MSYS).
    prefix = `${NOT_BEFORE}(?:${drive}:[\\\\/]+|/${drive}/)${body}${NOT_AFTER}`;
  } else {
    prefix = `${NOT_BEFORE}${escapeRegex(root)}${NOT_AFTER}`;
  }
  const flags = windows ? "gi" : "g";
  const hostPattern = new RegExp(windows ? `${prefix}((?:[\\\\/]+${TAIL})?)` : `${prefix}((?:/${TAIL})?)`, flags);
  // Inside quotes a Windows path may hold spaces and runs to the closing quote. (A POSIX workspace only has its prefix
  // replaced, so what follows needs no care.) Quoted paths without a space are left to `hostPattern`.
  // The quoted text must be that one path and nothing else: segments of name characters Windows allows (so no ':'
  // joining a second path, no quote or pipe starting a shell construct), and no trailing backslash (an escaped quote).
  const quotedPattern = windows
    ? new RegExp(`(["'])${prefix}((?:[\\\\/]+[^\\\\/"'\`$<>|:;*?\\n]+)*/?)(?=\\1)`, flags)
    : undefined;
  // Any quoted string, whatever it holds and wherever a path sits in it: what a text command may be given.
  const quotedAnyPattern = windows ? /"(?:\\.|[^"\\])*"|'[^']*'/g : undefined;
  const containerPattern = new RegExp(`${NOT_BEFORE}${escapeRegex(WORKSPACE_IN_CONTAINER)}${NOT_AFTER}((?:/${TAIL})?)`, "g");

  const separators = windows ? /[\\/]+/ : /\/+/;
  /**
   * What follows the workspace in a path, with `.` and `..` resolved; undefined when the path climbs out of the
   * workspace, which means it is not one of ours. A tail with neither is returned as it came.
   */
  const normalised = (tail: string): string | undefined => {
    const parts = tail.split(separators).filter((p) => p !== "");
    if (!parts.some((p) => p === "." || p === "..")) return tail;
    const kept: string[] = [];
    for (const part of parts) {
      if (part === ".") continue;
      if (part === "..") {
        if (kept.pop() === undefined) return undefined;
        continue;
      }
      kept.push(part);
    }
    return kept.length === 0 ? "" : `/${kept.join("/")}${/[\\/]$/.test(tail) ? "/" : ""}`;
  };
  const slashes = (tail: string): string => (windows ? tail.replace(/[\\/]+/g, "/") : tail);

  // A quoted string with a space is a path or text by the command around it (`contextOf`). Where the command does not
  // say, the string does: with no escape letter in it, `"C:\ws\new dir\sub"` is a path whether or not its folders
  // exist yet; with one, `"C:\ws\out.txt done\n"`, it is a path if some directory below the workspace root on the way
  // to it exists on the host. (The root alone proves nothing: every string that starts there has it.)
  const isHostPath = (tail: string): boolean => {
    const segments = tail.split(separators).filter((s) => s !== "");
    for (let n = segments.length; n >= 1; n--) if (exists([hostRoot, ...segments.slice(0, n)].join("\\"))) return true;
    return false;
  };

  // A segment that is one escape letter (`\n`, `\t`) is a shell escape, unless the host shows the path is real.
  const hasEscape = (tail: string): boolean => tail.split(separators).some((s) => /^[abfnrtv0]$/.test(s));

  /**
   * Text strings are set aside whole, so no later pass reads a path in them; `mark` followed by a number and `mark`
   * stands where each one goes back. `mark` is a private-use character the text does not contain, so nothing in the
   * input can be mistaken for a placeholder.
   */
  const markFor = (text: string): string => {
    for (let code = 0xe000; code < 0xf8ff; code++) if (!text.includes(String.fromCharCode(code))) return String.fromCharCode(code);
    return "\u0000";
  };
  const protect = (text: string, held: string[], mark: string): string =>
    quotedAnyPattern === undefined
      ? text
      : text.replace(quotedAnyPattern, (whole, offset: number, all: string) => {
          if (contextOf(all.slice(0, offset)) !== "text") return whole;
          held.push(whole);
          return `${mark}${held.length - 1}${mark}`;
        });

  const quoted = (text: string): string =>
    quotedPattern === undefined
      ? text
      : text.replace(quotedPattern, (whole, q: string, tail: string, offset: number, all: string) => {
          const inside = normalised(tail);
          if (!/\s/.test(tail) || inside === undefined) return whole;
          const context = contextOf(all.slice(0, offset));
          return context === "path" || (context === "unknown" && (isHostPath(inside) || !hasEscape(inside)))
            ? `${q}${WORKSPACE_IN_CONTAINER}${slashes(inside)}`
            : whole;
        });

  const pathStart = new RegExp(`${NOT_BEFORE}${escapeRegex(WORKSPACE_IN_CONTAINER)}${NOT_AFTER}`, "g");

  const toContainer = (text: string): string => {
    const held: string[] = [];
    const mark = markFor(text);
    return quoted(protect(text, held, mark))
      .replace(hostPattern, (match, tail: string) => {
        const inside = normalised(tail);
        return inside === undefined ? match : WORKSPACE_IN_CONTAINER + slashes(inside);
      })
      .replace(new RegExp(`${mark}(\\d+)${mark}`, "g"), (_m, i: string) => held[Number(i)]!);
  };
  const toHost = (text: string): string =>
    text.replace(containerPattern, (match, tail: string) =>
      normalised(tail) === undefined ? match : hostRoot + (windows ? tail.replace(/\//g, "\\") : tail),
    );

  return {
    toContainer,
    toHost,
    hostStream() {
      let held = "";
      let previous = "";
      const emit = (text: string): string => {
        if (text === "") return "";
        // The character before the text says whether `/work` starts a path; it is never part of a match.
        const out = toHost(previous + text).slice(previous.length);
        previous = text.slice(-1);
        return out;
      };
      return {
        write(chunk) {
          const text = held + chunk;
          const wordStart = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"), text.lastIndexOf("\t"), text.lastIndexOf("\r")) + 1;
          let cut = text.length;
          // A `/work` path still open at the end of the text is held from its start, so it is translated whole. That
          // is bounded: minified JSON or a progress bar has no whitespace for a whole run and must keep flowing, and
          // a `/work` this far back has long since ended.
          // Its start is the last `/work` that begins a path: one after a name character is a later segment
          // (`/work/src/workflows`), not a path.
          let open = -1;
          for (const m of text.matchAll(pathStart)) if (m.index >= wordStart) open = m.index;
          if (open >= 0 && text.length - open <= MAX_HELD_WORD) cut = open;
          else {
            for (let k = Math.min(text.length, WORKSPACE_IN_CONTAINER.length - 1); k >= 1; k--) {
              if (WORKSPACE_IN_CONTAINER.startsWith(text.slice(-k))) {
                cut = text.length - k;
                break;
              }
            }
          }
          held = text.slice(cut);
          return emit(text.slice(0, cut));
        },
        end() {
          const rest = held;
          held = "";
          return emit(rest);
        },
      };
    },
  };
}
