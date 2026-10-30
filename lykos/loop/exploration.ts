// T63 — the exploration metric, repaired (`docs/20-phase9-tasks.md` §2, §5).
//
// The finding this exists to close (2026-09-03, opening Phase 9):
// `prompt-diet.ts`'s `EXPLORATION_TOOL_NAMES` is `read|grep|find|ls`, and
// **T20 dropped `grep`, `find` and `ls` from the hop-0 surface to `bash`**
// (formerly tool-surface.ts's rationale that bash covered search).
// So every search, listing and `git log` since Phase 2 has been invisible to
// the one counter Phase 9's trigger reads. Measured over the archive the day
// the phase opened: 41 tool calls, 28 of them `bash`, 25 of those 28
// read-only exploration — and the counter saw 7. An undercount of ~4.6x,
// whose direction is exactly the set of calls T20 moved.
//
// Phase 2 optimised the tool surface and, as an unrecorded side effect,
// blinded the metric Phase 9 exists to read. T67 reads the number this
// module produces and decides whether the rest of the phase gets built, so a
// classifier that is wrong in either direction produces a confident wrong
// decision about three weeks of work. Two consequences for the design:
//
//   1. **It is deliberately conservative.** A chained command counts as
//      exploration only when *every* non-neutral segment is a read-only
//      explorer. `grep -rn foo && npm test` is not exploration, because the
//      chain did something else as well. This undercounts mixed chains, and
//      undercounting is the safe direction: it makes the case for building
//      retrieval harder to reach, not easier.
//   2. **It records a breakdown, not one number.** File search, file read,
//      VCS history and machine inspection are all "exploration" in the
//      ordinary sense, but only the first two are what a repo map could
//      replace. `git log` is orienting, not file-finding. T67 must be able
//      to apply either definition, so both are recorded and neither is
//      chosen here.
//
// Nothing is backfilled. Pre-T63 sessions keep the `explore_tool_calls` they
// have, and `explore_metric_version` distinguishes them: NULL/1 is the v1
// definition below, 3 is this one. This is the same rule that left
// `capture_mode` NULL on every pre-T53 session.
//
// Computed host-side from the snapshot's existing tool-call trace — the same
// trace `edit-retry.ts` reads. No new hook, no patch to Pi
// (AGENTS.md rules 3 and 6), and no new tool schema (rule 3's per-turn tax).

/** The v1 definition, kept so `explore_metric_version = 1` means something specific. Not used to count new rows. */
import { isFileChangingCall, resolveActualToolArgs, resolveActualToolName } from "../tools/tool-call.js";

export const EXPLORATION_TOOL_NAMES_V1 = ["read", "grep", "find", "ls"] as const;

/** Bumped whenever the classification below changes in a way that makes rows incomparable. */
export const EXPLORE_METRIC_VERSION = 3;

export type ExploreKind =
  /** Locating files or symbols: grep, rg, find, fd, ls, tree. What a repo map could replace. */
  | "search"
  /** Reading file content: the `read` tool, cat, head, tail, sed -n. */
  | "read"
  /** Orienting in VCS history: git log/status/show/diff/blame. Exploration, but not file-finding. */
  | "history"
  /** Inspecting the machine or the shape of things: wc, stat, file, env, which. */
  | "inspect";

export type CallClass =
  | { kind: "explore"; explore: ExploreKind }
  | { kind: "edit" }
  | { kind: "other" };

/**
 * Read-only shell commands, by the kind of exploration they perform.
 *
 * `sed` and `awk` are here because in practice they are used to print ranges
 * (`sed -n '10,40p'`), but both can write — `sed -i` and any redirect are
 * caught by the mutation checks in `classifyShellSegment` below.
 */
const EXPLORER_COMMANDS: ReadonlyMap<string, ExploreKind> = new Map<string, ExploreKind>([
  ["ls", "search"],
  ["tree", "search"],
  ["find", "search"],
  ["fd", "search"],
  ["fdfind", "search"],
  ["grep", "search"],
  ["egrep", "search"],
  ["fgrep", "search"],
  ["rg", "search"],
  ["ripgrep", "search"],
  ["ag", "search"],
  ["cat", "read"],
  ["head", "read"],
  ["tail", "read"],
  ["sed", "read"],
  ["awk", "read"],
  ["nl", "read"],
  ["less", "read"],
  ["more", "read"],
  ["jq", "read"],
  ["cut", "read"],
  ["strings", "read"],
  ["wc", "inspect"],
  ["stat", "inspect"],
  ["file", "inspect"],
  ["du", "inspect"],
  ["realpath", "inspect"],
  ["readlink", "inspect"],
  ["dirname", "inspect"],
  ["basename", "inspect"],
  ["which", "inspect"],
  ["whereis", "inspect"],
  ["env", "inspect"],
  ["printenv", "inspect"],
  ["diff", "inspect"],
  ["comm", "inspect"],
  ["sort", "inspect"],
  ["uniq", "inspect"],
  ["column", "inspect"],
  ["od", "inspect"],
  ["hexdump", "inspect"],
]);

/**
 * Segments that are neither exploration nor work: shell punctuation the model
 * writes to separate two real commands. They do not make a chain
 * non-exploratory, and they do not make it exploratory either.
 */
const NEUTRAL_COMMANDS: ReadonlySet<string> = new Set([
  "cd",
  "echo",
  "printf",
  "pwd",
  "true",
  "false",
  ":",
  "export",
  "set",
  "unset",
  "clear",
]);

/** Wrappers to skip past to reach the command they actually run. */
const WRAPPER_COMMANDS: ReadonlySet<string> = new Set(["sudo", "time", "nohup", "command", "nice", "stdbuf"]);

/** `git` subcommands that only read. Deliberately tight — see `gitSubcommandKind`. */
const GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "log",
  "status",
  "show",
  "diff",
  "blame",
  "grep",
  "shortlog",
  "reflog",
  "whatchanged",
  "describe",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "cat-file",
  "rev-parse",
  "rev-list",
  "merge-base",
  "name-rev",
  "for-each-ref",
  "symbolic-ref",
  "count-objects",
  "verify-pack",
]);

/** `git` subcommands that read *only* when every argument is a listing flag. `git branch -a` reads; `git branch foo` writes. */
const GIT_LISTING_SUBCOMMANDS: ReadonlySet<string> = new Set(["branch", "tag", "remote", "stash", "worktree"]);

/** Flags that turn a listing subcommand into a mutation. */
const GIT_LISTING_MUTATORS: ReadonlySet<string> = new Set([
  "-d",
  "-D",
  "-m",
  "-M",
  "-c",
  "-C",
  "-f",
  "--delete",
  "--move",
  "--copy",
  "--force",
  "--edit-description",
  "--set-upstream-to",
  "--unset-upstream",
]);

/** Redirect targets that discard rather than write a file. `2>/dev/null` must not disqualify a search. */
const HARMLESS_REDIRECT_TARGETS: ReadonlySet<string> = new Set(["/dev/null", "&1", "&2", "/dev/stderr", "/dev/stdout"]);

const GIT_GLOBAL_OPTIONS_WITH_VALUES: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--exec-path",
]);

export interface GitCommandParts {
  subcommand: string | undefined;
  subcommandIndex: number;
  rest: readonly string[];
}

/** Find a git subcommand without mistaking global option values for it. */
export function parseGitCommand(args: readonly string[]): GitCommandParts {
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (arg === "--") {
      i += 1;
      break;
    }
    if (GIT_GLOBAL_OPTIONS_WITH_VALUES.has(arg)) {
      i += 2;
      continue;
    }
    if (
      [...GIT_GLOBAL_OPTIONS_WITH_VALUES].some(
        (option) => arg.startsWith(`${option}=`) || (option.length === 2 && arg.startsWith(option) && arg.length > option.length),
      )
    ) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      i += 1;
      continue;
    }
    break;
  }
  return {
    subcommand: args[i],
    subcommandIndex: i,
    rest: args.slice(i + 1),
  };
}

export interface ExploreToolCallLike {
  // Explicit `| undefined` under exactOptionalPropertyTypes: a caller holding
  // a trace read back from a transcript has genuinely optional fields, and
  // this shape has to accept one without a cast.
  name?: string | undefined;
  state?: string | undefined;
  args?: unknown;
  result?: unknown;
}

/**
 * Split a shell command into segments on unquoted `&&`, `||`, `;`, `|` and
 * newlines, and step into `$( ... )` command substitutions.
 *
 * This is the half §2's throwaway scan got wrong: splitting on those
 * characters without tracking quote state puts pieces of a quoted regex
 * (`"Status\\|closed\\|Next"`) into the word histogram as if they were
 * commands. Backslash escapes and both quote styles are tracked here.
 */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let i = 0;

  const flush = (): void => {
    if (current.trim().length > 0) segments.push(current.trim());
    current = "";
  };

  while (i < command.length) {
    const ch = command[i]!;

    if (quote === "'") {
      // Single quotes take everything literally, including backslashes.
      if (ch === "'") {
        current += ch;
        quote = null;
      }
      else current += ch;
      i += 1;
      continue;
    }

    if (ch === "\\") {
      // Escaped character: consume both, keep the escape so later scans know
      // that `\>` is an argument character rather than a redirect.
      current += ch;
      current += command[i + 1] ?? "";
      i += 2;
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        current += ch;
        quote = null;
      }
      else current += ch;
      i += 1;
      continue;
    }

    if (ch === "'" || ch === '"') {
      current += ch;
      quote = ch as '"' | "'";
      i += 1;
      continue;
    }

    // `$(` opens a nested command; treat its contents as their own segment.
    if (ch === "$" && command[i + 1] === "(") {
      flush();
      i += 2;
      continue;
    }
    if (ch === "`") {
      flush();
      i += 1;
      continue;
    }
    if (ch === ")") {
      flush();
      i += 1;
      continue;
    }

    // `&` is a command separator except when it belongs to a redirect:
    // `2>&1`, `2>&2`, and bash's `&>file` forms must stay in one segment.
    if (ch === "&" && (command[i - 1] === ">" || command[i + 1] === ">")) {
      current += ch;
      i += 1;
      continue;
    }

    if (ch === "&" || ch === "|" || ch === ";" || ch === "\n") {
      flush();
      // `&&` and `||` are two characters; one extra skip is harmless either way.
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) i += 1;
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }
  flush();
  return segments;
}

/** Tokenize one segment, respecting quotes. Quotes are removed; the token text is kept. */
export function tokenizeSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  let i = 0;

  const flush = (): void => {
    if (started) tokens.push(current);
    current = "";
    started = false;
  };

  while (i < segment.length) {
    const ch = segment[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else {
        current += ch;
        started = true;
      }
      i += 1;
      continue;
    }
    if (ch === "\\") {
      current += segment[i + 1] ?? "";
      started = true;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch as '"' | "'";
      started = true;
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t") {
      flush();
      i += 1;
      continue;
    }
    current += ch;
    started = true;
    i += 1;
  }
  flush();
  return tokens;
}

/** `/usr/bin/grep` → `grep`. Windows-style separators too, since the host is win32. */
function commandBasename(word: string): string {
  const idx = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"));
  return idx >= 0 ? word.slice(idx + 1) : word;
}

/** True when an unquoted redirect in `segment` writes somewhere other than a harmless target. */
export function writesThroughRedirect(segment: string): boolean {
  let quote: '"' | "'" | null = null;
  let i = 0;

  while (i < segment.length) {
    const ch = segment[i]!;

    if (quote === "'") {
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch !== ">") {
      i += 1;
      continue;
    }

    // `>>` has the same safety meaning as `>`, but its second character is
    // part of the operator rather than the target.
    i += segment[i + 1] === ">" ? 2 : 1;
    while (i < segment.length && /\s/.test(segment[i]!)) i += 1;
    if (i >= segment.length) return true;

    let target = "";
    let quotedTarget = false;
    // A shell word may concatenate quoted and unquoted pieces:
    // `>"out"suffix` targets `outsuffix`, not the harmless `/dev/null`.
    while (i < segment.length && !/\s/.test(segment[i]!)) {
      if (segment[i] === "'" || segment[i] === '"') {
        const targetQuote = segment[i]!;
        quotedTarget = true;
        i += 1;
        while (i < segment.length && segment[i] !== targetQuote) {
          if (targetQuote === '"' && segment[i] === "\\") {
            target += segment[i + 1] ?? "";
            i += 2;
          } else {
            target += segment[i]!;
            i += 1;
          }
        }
        if (i < segment.length) i += 1;
      } else if (segment[i] === "\\") {
        target += segment[i + 1] ?? "";
        i += 2;
      } else {
        target += segment[i]!;
        i += 1;
      }
    }
    // `>&1` and `>&2` duplicate file descriptors; quoted `"&1"` and
    // `"&2"` are ordinary filenames and must remain gated.
    if (!HARMLESS_REDIRECT_TARGETS.has(target) || (quotedTarget && (target === "&1" || target === "&2"))) return true;
  }
  return false;
}

/** `git <sub> ...` → the exploration kind, or undefined when the subcommand writes or is unrecognised. */
function gitSubcommandKind(args: readonly string[]): ExploreKind | undefined {
  const { subcommand: sub, rest } = parseGitCommand(args);
  if (sub === undefined) return "history"; // bare `git` prints usage; harmless and read-only.
  if (GIT_READ_SUBCOMMANDS.has(sub)) return sub === "grep" ? "search" : "history";
  if (GIT_LISTING_SUBCOMMANDS.has(sub)) {
    if (sub === "stash" || sub === "worktree") {
      return rest[0] === "list" || rest[0] === "show" ? "history" : undefined;
    }
    // A listing only: every remaining token is a non-mutating flag.
    for (const tok of rest) {
      if (!tok.startsWith("-")) return undefined;
      if (GIT_LISTING_MUTATORS.has(tok)) return undefined;
    }
    return "history";
  }
  return undefined;
}

export type SegmentClass =
  | { kind: "explore"; explore: ExploreKind }
  | { kind: "neutral" }
  | { kind: "other" };

/** Classify one shell segment. Exported for the table-driven tests. */
export function classifyShellSegment(segment: string): SegmentClass {
  const tokens = tokenizeSegment(segment);
  let i = 0;
  // Step past `FOO=bar` assignments and wrappers like `sudo` / `time`.
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
      i += 1;
      continue;
    }
    if (WRAPPER_COMMANDS.has(commandBasename(tok))) {
      i += 1;
      continue;
    }
    break;
  }
  const head = tokens[i];
  if (head === undefined) return { kind: "neutral" };
  const word = commandBasename(head);
  const args = tokens.slice(i + 1);

  if (NEUTRAL_COMMANDS.has(word)) return { kind: "neutral" };

  if (word === "git") {
    const kind = gitSubcommandKind(args);
    return kind === undefined ? { kind: "other" } : { kind: "explore", explore: kind };
  }

  const explore = EXPLORER_COMMANDS.get(word);
  if (explore === undefined) return { kind: "other" };

  // `sed -i` edits in place; so does `sort -o`. Either disqualifies the segment.
  if (word === "sed" && args.some((a) => a === "-i" || a.startsWith("-i.") || a === "--in-place")) {
    return { kind: "other" };
  }
  if (word === "sort" && args.some((a) => a === "-o" || a === "--output")) return { kind: "other" };
  if (writesThroughRedirect(segment)) return { kind: "other" };

  return { kind: "explore", explore };
}

/**
 * Classify a whole `bash` command.
 *
 * **The conservative rule, stated once:** the command is exploration only if
 * at least one segment explores and *no* segment does anything else. A chain
 * that greps and then runs the tests is not exploration. When several kinds
 * are present the most specific wins, in the order search > read > history >
 * inspect — a chain that greps and then heads the result is a search.
 */
export function classifyBashCommand(command: string): CallClass {
  const segments = splitShellSegments(command);
  let best: ExploreKind | undefined;
  const rank: Record<ExploreKind, number> = { search: 0, read: 1, history: 2, inspect: 3 };
  for (const seg of segments) {
    const cls = classifyShellSegment(seg);
    if (cls.kind === "other") return { kind: "other" };
    if (cls.kind === "neutral") continue;
    if (best === undefined || rank[cls.explore] < rank[best]) best = cls.explore;
  }
  return best === undefined ? { kind: "other" } : { kind: "explore", explore: best };
}

function bashCommandFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const rec = args as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    const v = rec[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** Classify one tool call from the snapshot trace. */
export function classifyToolCall(call: ExploreToolCallLike): CallClass {
  const wireName = typeof call.name === "string" ? call.name : "";
  const name = resolveActualToolName(wireName, call.args) ?? "";
  const args = resolveActualToolArgs(wireName, call.args);
  if (name === "read") return { kind: "explore", explore: "read" };
  if (name === "grep" || name === "find" || name === "ls") return { kind: "explore", explore: "search" };
  // P4 T143: an edit is whatever the registry declares file-changing.
  if (isFileChangingCall(wireName, call.args, call.result)) return { kind: "edit" };
  if (name === "bash") {
    const command = bashCommandFromArgs(args);
    // A `bash` call whose command was not captured is unclassifiable. It
    // counts toward the denominator and never toward exploration — the same
    // choice `edit-retry.ts` makes for an edit with no recoverable path.
    if (command === undefined) return { kind: "other" };
    return classifyBashCommand(command);
  }
  return { kind: "other" };
}

/**
 * Byte size of a tool call's result as it entered the context.
 *
 * Exported for T75 (`docs/23-phase10-tasks.md`), which prices the *actually
 * repeated* calls rather than multiplying a repeat count by an archive-wide
 * mean. Sharing this function is the point: a second byte-counter that did
 * not hydrate T9.4's spilled-artifact stub would reintroduce the exact bug
 * `22-memory-and-retrieval-source-review.md` §3.3 documents.
 */
export function toolResultBytes(result: unknown): number {
  if (result === undefined || result === null) return 0;
  if (typeof result === "string") return Buffer.byteLength(result, "utf8");
  // The live-capture path replaces a large result with `{truncated, bytes, artifact}`;
  // that recorded byte count is the honest size, not the size of the stub.
  if (typeof result === "object" && !Array.isArray(result)) {
    const rec = result as Record<string, unknown>;
    if (typeof rec.bytes === "number" && Number.isFinite(rec.bytes)) return Math.max(0, Math.trunc(rec.bytes));
  }
  try {
    return Buffer.byteLength(JSON.stringify(result), "utf8");
  } catch {
    return Buffer.byteLength(String(result), "utf8");
  }
}

export interface ExplorationSummary {
  /** Current exploration calls: every kind, the number `explore_tool_calls` now holds. */
  exploreToolCalls: number;
  /** Result bytes returned by those calls — the token proxy a bare count hides. */
  exploreResultBytes: number;
  /** Result bytes across every tool call, exploration or not. The share's denominator. */
  toolResultBytes: number;
  /** Per-kind counts and bytes, so T67 can apply either definition of "exploration". */
  byKind: Record<ExploreKind, { calls: number; bytes: number }>;
  /** The definition these numbers were produced by. Written to the session row. */
  metricVersion: number;
}

export function emptyExplorationSummary(): ExplorationSummary {
  return {
    exploreToolCalls: 0,
    exploreResultBytes: 0,
    toolResultBytes: 0,
    byKind: {
      search: { calls: 0, bytes: 0 },
      read: { calls: 0, bytes: 0 },
      history: { calls: 0, bytes: 0 },
      inspect: { calls: 0, bytes: 0 },
    },
    metricVersion: EXPLORE_METRIC_VERSION,
  };
}

/** The one entry point ingest uses. Pure; reads only the snapshot's existing trace. */
export function summarizeExploration(
  toolCalls: ReadonlyArray<ExploreToolCallLike> | undefined,
): ExplorationSummary {
  const out = emptyExplorationSummary();
  if (!toolCalls) return out;
  for (const call of toolCalls) {
    const bytes = toolResultBytes(call.result);
    out.toolResultBytes += bytes;
    const cls = classifyToolCall(call);
    if (cls.kind !== "explore") continue;
    out.exploreToolCalls += 1;
    out.exploreResultBytes += bytes;
    out.byKind[cls.explore].calls += 1;
    out.byKind[cls.explore].bytes += bytes;
  }
  return out;
}

/**
 * The share T67 reads. NULL — not zero — when the session made no tool call
 * at all: a session that ran no tools has no exploration share, and calling
 * that 0% would drag the average toward a claim the data does not support.
 */
export function exploreShare(summary: {
  exploreResultBytes: number;
  toolResultBytes: number;
}): number | null {
  if (summary.toolResultBytes <= 0) return null;
  return summary.exploreResultBytes / summary.toolResultBytes;
}

/** Compact JSON for the `explore_breakdown` column. */
export function serializeBreakdown(summary: ExplorationSummary): string {
  return JSON.stringify(summary.byKind);
}
