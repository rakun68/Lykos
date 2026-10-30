// Is this shell command safe enough to run without asking?
//
// **This module deliberately owns no parser.** Every question about what a
// shell command *is* is answered by `exploration.ts`, which T63 built to
// classify bash calls for the exploration metric and which already solved
// the hard half: quote-aware segmentation, `$( )` substitution, wrapper and
// env-assignment skipping, redirect analysis, and the conservative chain
// rule that a chain counts as read-only only when *every* non-neutral
// segment is. A second classifier here would be a second opinion, and two
// classifiers that disagree about `ls && rm -rf x` is a safety bug rather
// than a tidiness one. So this file adds exactly two things T63 had no
// reason to have: a **destructive** tier above "not read-only", and the
// **pattern** an approval is remembered under.
//
// Three tiers, because the four interaction modes need two different bars:
//
//   - `read-only`   provably reads and nothing else. Ask mode's entire
//                   permission, and what Auto runs without a prompt.
//   - `ordinary`    does work: builds, tests, installs, single-file writes.
//                   Auto prompts once and offers to remember it.
//   - `destructive` recursive deletion, history rewriting, force pushes,
//                   piping the network into a shell, anything via `sudo`.
//                   Always prompts, and **can never be allowlisted** — see
//                   `isAllowlisted`.
//
// The destructive tier is not a blocker in the agreed Auto policy (the
// maintainer chose "safe runs, everything else asks once with an always
// option"). It exists so that "always" cannot quietly become a way to
// pre-approve `rm -rf`, and so the approval modal can say which prompts are
// worth reading. That is the narrowest form of "do not weaken the trust
// boundary" that still delivers the requested zero-friction Auto mode.

import { classifyBashCommand, classifyShellSegment, parseGitCommand, splitShellSegments, tokenizeSegment, writesThroughRedirect } from "../loop/exploration.js";
import { matchCriticalCommand } from "./critical-commands.js";

export type CommandRisk = "read-only" | "ordinary" | "destructive";

/** Wrappers `exploration.ts` steps past, plus `env`. */
const TRANSPARENT_WRAPPERS: ReadonlySet<string> = new Set(["time", "nohup", "command", "nice", "stdbuf", "env"]);

/** `/usr/bin/npm` to `npm`, on both separator styles since the host is win32. */
function basename(word: string): string {
  const idx = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"));
  return idx >= 0 ? word.slice(idx + 1) : word;
}

/** Step past transparent wrappers and env assignments for pattern matching / allowlisting. */
function transparentTokens(segment: string): string[] {
  let tokens = tokenizeSegment(segment);
  let iterations = 0;
  while (iterations < 10) {
    iterations += 1;
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) {
      i += 1;
    }
    if (i >= tokens.length) return tokens.slice(i);
    const head = basename(tokens[i]!);
    if (!TRANSPARENT_WRAPPERS.has(head)) {
      return tokens.slice(i).map((t, n) => (n === 0 ? basename(t) : t));
    }
    if (head === "env") {
      i += 1;
      while (i < tokens.length) {
        const tok = tokens[i]!;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
          i += 1;
          continue;
        }
        if (tok === "-u" || tok === "--unset" || tok === "-C" || tok === "--chdir") {
          i += 2;
          continue;
        }
        if (tok === "-S" || tok === "--split-string") {
          const next = tokens[i + 1];
          if (next !== undefined) {
            tokens = tokenizeSegment(next);
            i = 0;
            break;
          }
          i += 2;
          continue;
        }
        if (tok.startsWith("--unset=") || tok.startsWith("--chdir=")) {
          i += 1;
          continue;
        }
        if (tok.startsWith("-")) {
          i += 1;
          continue;
        }
        break;
      }
      if (i < tokens.length) {
        tokens = tokens.slice(i);
        continue;
      }
      return ["env"];
    }
    if (head === "nice") {
      i += 1;
      while (i < tokens.length) {
        const tok = tokens[i]!;
        if (tok === "-n" || tok === "--adjustment") {
          i += 2;
          continue;
        }
        if (/^-\d+$/.test(tok) || tok.startsWith("--adjustment=")) {
          i += 1;
          continue;
        }
        break;
      }
      if (i < tokens.length) {
        tokens = tokens.slice(i);
        continue;
      }
      return ["nice"];
    }
    if (head === "nohup") {
      i += 1;
      if (i < tokens.length) {
        tokens = tokens.slice(i);
        continue;
      }
      return ["nohup"];
    }
    if (head === "time") {
      i += 1;
      while (i < tokens.length && tokens[i]!.startsWith("-")) {
        i += 1;
      }
      if (i < tokens.length) {
        tokens = tokens.slice(i);
        continue;
      }
      return ["time"];
    }
    if (head === "stdbuf") {
      i += 1;
      while (i < tokens.length) {
        const tok = tokens[i]!;
        if (tok === "-i" || tok === "-o" || tok === "-e") {
          i += 2;
          continue;
        }
        if (tok.startsWith("-i") || tok.startsWith("-o") || tok.startsWith("-e")) {
          i += 1;
          continue;
        }
        break;
      }
      if (i < tokens.length) {
        tokens = tokens.slice(i);
        continue;
      }
      return ["stdbuf"];
    }
    if (head === "command") {
      i += 1;
      while (i < tokens.length && tokens[i]! === "-p") {
        i += 1;
      }
      if (tokens[i] === "-v" || tokens[i] === "-V") {
        return ["command", ...tokens.slice(i)];
      }
      if (i < tokens.length) {
        tokens = tokens.slice(i);
        continue;
      }
      return ["command"];
    }
    break;
  }
  return tokens.map((t, n) => (n === 0 ? basename(t) : t));
}

/** Tokens of one segment unwrapped past wrappers and command carriers, so `tokens[0]` is the actual command. */
function significantTokens(segment: string): string[] {
  let tokens = transparentTokens(segment);
  let iterations = 0;
  while (iterations < 10) {
    iterations += 1;
    if (tokens.length === 0) return tokens;
    const head = basename(tokens[0]!);

    if (head === "xargs") {
      let i = 1;
      while (i < tokens.length) {
        const tok = tokens[i]!;
        if (["-I", "-i", "-n", "-L", "-l", "-s", "-E", "-d", "-P", "-a"].includes(tok)) {
          i += 2;
          continue;
        }
        if (
          tok.startsWith("-I") ||
          tok.startsWith("-i") ||
          tok.startsWith("-n") ||
          tok.startsWith("-L") ||
          tok.startsWith("-l") ||
          tok.startsWith("-s") ||
          tok.startsWith("-E") ||
          tok.startsWith("-d") ||
          tok.startsWith("-P") ||
          tok.startsWith("-a")
        ) {
          i += 1;
          continue;
        }
        if (tok.startsWith("-")) {
          i += 1;
          continue;
        }
        break;
      }
      if (i < tokens.length) {
        tokens = transparentTokens(tokens.slice(i).join(" "));
        continue;
      }
      return ["xargs"];
    }

    if (head === "sh" || head === "bash" || head === "zsh" || head === "ksh" || head === "dash") {
      let cIdx = -1;
      for (let j = 1; j < tokens.length; j += 1) {
        const tok = tokens[j]!;
        if (tok === "-c" || (tok.startsWith("-") && tok.includes("c") && !tok.startsWith("--"))) {
          cIdx = j;
          break;
        }
      }
      if (cIdx !== -1 && cIdx + 1 < tokens.length) {
        const innerCmd = tokens[cIdx + 1]!;
        tokens = transparentTokens(innerCmd);
        continue;
      }
      break;
    }

    if (head === "awk" || head === "gawk" || head === "mawk" || head === "nawk") {
      const full = tokens.join(" ");
      const sysMatch = full.match(/system\s*\(\s*(["'])(.*?)\1\s*\)/);
      if (sysMatch && sysMatch[2]) {
        tokens = transparentTokens(sysMatch[2]);
        continue;
      }
      break;
    }

    if (head === "sed") {
      const full = tokens.join(" ");
      const eMatch = full.match(/(?:^|\s)-e\s+['"]?e\s+([^'"]+)['"]?|['"]e\s+([^'"]+)['"]/);
      const inner = eMatch ? (eMatch[1] || eMatch[2]) : undefined;
      if (inner) {
        tokens = transparentTokens(inner);
        continue;
      }
      break;
    }

    break;
  }
  return tokens.map((t, n) => (n === 0 ? basename(t) : t));
}

/** T208: returns the significant head token of a shell segment (e.g. "mkdir" for "mkdir -p out"). */
export function segmentHead(segment: string): string | undefined {
  return significantTokens(segment)[0];
}

/** True when any short-flag cluster in `args` carries one of `letters`, so `-rf` matches `r`. Long forms are matched separately by `hasLongFlag`. */
function hasShortFlag(args: readonly string[], letters: readonly string[]): boolean {
  return args.some((a) => {
    if (!a.startsWith("-") || a.startsWith("--")) return false;
    return letters.some((l) => a.slice(1).includes(l));
  });
}

function hasLongFlag(args: readonly string[], flags: readonly string[]): boolean {
  return args.some((a) => flags.includes(a));
}

/**
 * Commands that carry another command inside an argument Lykos does not
 * parse — an interpreter's `-c`, `npx`'s package, `xargs`'s child.
 *
 * `classifyCommandRisk` reads the HEAD of a segment. For `bash -c "rm -rf
 * dist"` the head is `bash` and the payload is an opaque string, so the risk
 * tier is honestly unknown. That is survivable on its own (an unknown
 * command is `ordinary`, and Auto prompts for it) — what is NOT survivable
 * is remembering it: an allowlist entry for `bash` would silence every
 * `bash -c` forever. So these get no allowlist pattern at all, and therefore
 * can never be covered by the store.
 */
const OPAQUE_COMMANDS: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "pwsh",
  "powershell",
  "cmd",
  "node",
  "deno",
  "bun",
  "python",
  "python3",
  "perl",
  "ruby",
  "php",
  "npx",
  "pnpx",
  "bunx",
  "xargs",
  "eval",
  "exec",
  "watch",
  "ssh",
]);

/** Commands whose mere presence is destructive, whatever the arguments. */
const ALWAYS_DESTRUCTIVE: ReadonlySet<string> = new Set([
  "sudo",
  "doas",
  "dd",
  "mkfs",
  "fdisk",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "shred",
  "truncate",
]);

/**
 * Is this ONE segment destructive? Conservative in the opposite direction
 * from `classifyShellSegment`: it is trying to catch things, so an
 * unrecognised command is *not* destructive. It will be `ordinary` and
 * therefore still prompts in Auto — nothing runs unasked on that path.
 */
function isDestructiveSegment(segment: string): boolean {
  const tokens = significantTokens(segment);
  const head = tokens[0];
  if (head === undefined) return false;
  const args = tokens.slice(1);

  if (ALWAYS_DESTRUCTIVE.has(head)) return true;

  // Recursive or forced removal. A plain `rm one-file.txt` is ordinary work
  // and prompts like anything else; it is the recursive/forced form that
  // deserves to be unforgettable.
  if (head === "rm" && (hasShortFlag(args, ["r", "R", "f"]) || hasLongFlag(args, ["--recursive", "--force"]))) return true;

  // Ownership and permission sweeps.
  if (
    (head === "chmod" || head === "chown" || head === "chgrp") &&
    (hasShortFlag(args, ["R"]) || hasLongFlag(args, ["--recursive"]))
  ) {
    return true;
  }

  // Anything that rewrites or discards work already committed.
  if (head === "git") {
    const { subcommand: sub, rest } = parseGitCommand(args);
    if (sub === "push" && (hasLongFlag(rest, ["--force", "--force-with-lease", "--delete"]) || hasShortFlag(rest, ["f", "d"]))) return true;
    if (sub === "reset" && hasLongFlag(rest, ["--hard"])) return true;
    if (sub === "clean" && (hasShortFlag(rest, ["f"]) || hasLongFlag(rest, ["--force"]))) return true;
    if (sub === "checkout" && (hasShortFlag(rest, ["f"]) || hasLongFlag(rest, ["--force"]))) return true;
    if (sub === "branch" && hasShortFlag(rest, ["D"])) return true;
    if (sub === "filter-branch" || sub === "filter-repo") return true;
  }

  // Publishing is outward-facing and effectively irreversible.
  if (head === "npm" && args[0] === "publish") return true;

  // **`find` is the sharp edge here.** `exploration.ts` lists it as an
  // EXPLORER_COMMAND — correctly, for its own purpose, since `find` is how
  // you locate files. But `find . -delete` and `find . -exec rm {} ;` delete
  // them, and without this branch the whole command would classify as
  // read-only: it would run unasked in Auto and be permitted outright in
  // Ask, which is supposed to be incapable of modifying anything.
  if (head === "find" && args.some((a) => a === "-delete" || a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir")) {
    return true;
  }

  return false;
}

/** True when the segment's command hides another command in an argument. See `OPAQUE_COMMANDS`. */
function isOpaqueSegment(segment: string): boolean {
  const head = transparentTokens(segment)[0];
  return head !== undefined && OPAQUE_COMMANDS.has(head);
}

/**
 * `curl https://x | sh` — the pipe makes this destructive, but
 * `splitShellSegments` has already split it into `curl https://x` and `sh`,
 * neither of which is destructive alone. So this one pattern is matched on
 * the segment SEQUENCE rather than on any single segment.
 */
function pipesNetworkIntoShell(segments: readonly string[]): boolean {
  const heads = segments.map((s) => significantTokens(s)[0]);
  const fetchers = new Set(["curl", "wget", "iwr", "fetch"]);
  const shells = new Set(["sh", "bash", "zsh", "python", "python3", "node", "perl", "ruby"]);
  for (let i = 0; i < heads.length - 1; i += 1) {
    const from = heads[i];
    const to = heads[i + 1];
    if (from !== undefined && to !== undefined && fetchers.has(from) && shells.has(to)) return true;
  }
  return false;
}

/**
 * The one entry point the approval gate asks.
 *
 * Destructive wins over everything: a chain that greps and then force-pushes
 * is destructive, not read-only and not merely ordinary.
 */
export function classifyCommandRisk(command: string): CommandRisk {
  // P10.8 ticket 11: the copied critical rows run FIRST and on the raw line.
  // Every one of them describes information that is not in a segment head —
  // a redirect target, a function definition, a process substitution, a flag
  // — so running them after segmentation would be running them on input that
  // has already thrown the evidence away.
  if (matchCriticalCommand(command) !== undefined) return "destructive";
  const segments = splitShellSegments(command);
  if (pipesNetworkIntoShell(segments)) return "destructive";
  if (segments.some(isDestructiveSegment)) return "destructive";

  // A command that explores nothing is not read-only (`echo hi`, `echo x > f`): a neutral segment may only ride along, and never through a redirect.
  let explored = false;
  for (const seg of segments) {
    if (writesThroughRedirect(seg)) return "ordinary";
    if (classifyShellSegment(seg).kind === "neutral") continue;
    explored = true;

    const tokens = significantTokens(seg);
    if (tokens.length === 0) continue;
    const innerHead = tokens[0]!;

    if (OPAQUE_COMMANDS.has(innerHead)) return "ordinary";

    const rawHead = basename(tokenizeSegment(seg)[0] ?? "");

    // Check awk / sed with command executions:
    if (
      (rawHead === "awk" || rawHead === "gawk" || rawHead === "mawk" || rawHead === "nawk") &&
      (/system\s*\(/.test(seg) || /\|\s*["']/.test(seg))
    ) {
      return "ordinary";
    }
    if (rawHead === "sed" && (/['"]\s*e\s/.test(seg) || /-e\s+['"]?e\s/.test(seg) || /\/e\b/.test(seg))) {
      return "ordinary";
    }

    // If a wrapper like env, nice, nohup, time, xargs, etc. was used:
    if (rawHead === "env" || rawHead === "nice" || rawHead === "nohup" || rawHead === "time" || rawHead === "xargs" || rawHead === "stdbuf") {
      if (rawHead === "env" && innerHead === "env") {
        if (classifyShellSegment(seg).kind !== "explore") return "ordinary";
        continue;
      }
      const unwrappedCls = classifyShellSegment(tokens.join(" "));
      if (unwrappedCls.kind !== "explore") return "ordinary";
      continue;
    }

    if (rawHead === "sh" || rawHead === "bash" || rawHead === "zsh" || rawHead === "ksh" || rawHead === "dash") {
      const unwrappedCls = classifyShellSegment(tokens.join(" "));
      if (unwrappedCls.kind !== "explore") return "ordinary";
      continue;
    }

    if (classifyShellSegment(seg).kind !== "explore") return "ordinary";
  }
  return explored ? "read-only" : "ordinary";
}

/**
 * The key an approval is remembered under: the command word, plus its first
 * argument when that argument names a subcommand rather than a file.
 *
 * `npm test` and `git commit` are the useful granularity. Remembering the
 * whole command line would mean re-approving `npm test -- --watch`;
 * remembering only `npm` would mean approving `npm publish` by having once
 * approved `npm test`. The "looks like a subcommand" test is deliberately
 * narrow — a bare word with no dot and no path separator — so filenames
 * never end up in the store.
 */
export function allowlistPattern(segment: string): string | undefined {
  const tokens = transparentTokens(segment);
  const head = tokens[0];
  if (head === undefined || head.length === 0) return undefined;
  // An interpreter or passthrough has no honest pattern: whatever it runs is
  // inside a string this module does not parse.
  if (OPAQUE_COMMANDS.has(head)) return undefined;
  if (head === "git") {
    const { subcommand } = parseGitCommand(tokens.slice(1));
    return subcommand === undefined ? head : `${head} ${subcommand}`;
  }
  const arg = tokens.slice(1).find((a) => !a.startsWith("-"));
  if (arg !== undefined && /^[A-Za-z][A-Za-z0-9:_-]*$/.test(arg)) return `${head} ${arg}`;
  return head;
}

/** Every pattern a command would need approved, in order, de-duplicated. Neutral segments (`cd`, `echo`) contribute nothing. */
export function patternsFor(command: string): string[] {
  const out: string[] = [];
  for (const seg of splitShellSegments(command)) {
    if (classifyShellSegment(seg).kind === "neutral") continue;
    const pattern = allowlistPattern(seg);
    if (pattern !== undefined && !out.includes(pattern)) out.push(pattern);
  }
  return out;
}

/**
 * Does the store already cover this command?
 *
 * Two rules, both load-bearing. **Every** non-neutral segment must be
 * covered — the same conservative chain rule `exploration.ts` uses, so
 * approving `npm test` never approves `npm test && rm -rf dist`. And a
 * destructive command is never covered, however the store was written: the
 * allowlist is a convenience for work done every day, not a mechanism for
 * making an irreversible command silent.
 */
export function isAllowlisted(command: string, allowed: ReadonlySet<string>): boolean {
  if (classifyCommandRisk(command) === "destructive") return false;
  // A chain containing an opaque segment is never covered, even if every
  // other segment is. `patternsFor` already drops the opaque segment, so
  // without this an allowlisted `npm test && bash -c "…"` would pass on the
  // strength of `npm test` alone.
  const segments = splitShellSegments(command);
  if (segments.some((seg) => classifyShellSegment(seg).kind !== "neutral" && isOpaqueSegment(seg))) return false;
  const patterns = patternsFor(command);
  if (patterns.length === 0) return false;
  return patterns.every((p) => allowed.has(p));
}
