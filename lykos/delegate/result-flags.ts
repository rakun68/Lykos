// Flags a result carries that need nothing but git's view of the change (T250, spec decision 16).
// Every function here is pure: the caller reads git, these decide. Each flag names the session
// that caused it.

import { posix } from "node:path";
import { LEFTOVER_SUBJECT_PREFIX, type CommitSummary } from "../git/worktree.js";
import { matchAnyGlob } from "../seal/matcher.js";
import type { SessionFlag } from "./session-protocol.js";

/** One line of `git diff --name-status --no-renames`: A, M, D, T and so on, and the repo-relative path. */
export interface ChangedPath {
  status: string;
  path: string;
}

/** Parses `git diff --name-status --no-renames` output. Paths come back with forward slashes. */
export function parseNameStatus(output: string): ChangedPath[] {
  const out: ChangedPath[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed === "") continue;
    const tab = trimmed.indexOf("\t");
    if (tab < 0) continue;
    out.push({ status: trimmed.slice(0, tab).trim(), path: trimmed.slice(tab + 1).replace(/\\/g, "/") });
  }
  return out;
}

/** The `+` lines of a unified diff, without the `+++` headers or the leading `+`. */
export function addedLines(diff: string): string[] {
  return diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1).replace(/\r$/, ""));
}

/**
 * A lockfile by its whole base name. F4: Boxie's rule matched "lock" anywhere in a name, so
 * `clock.ts` and `my-lock.ts` were sensitive. Only a `.lock`/`-lock` stem with a manifest extension,
 * or one of the known lockfile names, counts.
 */
const LOCKFILE = /^[^/]+(?:[.-]lock(?:\.(?:json|ya?ml|toml))?|\.lockb|\.lockfile)$/;

/** Base names whose change can alter a build, an install or the environment. */
const SENSITIVE_NAMES = new Set([
  "package.json",
  "npm-shrinkwrap.json",
  "pom.xml",
  "pyproject.toml",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "CMakeLists.txt",
  "meson.build",
  "Makefile",
  "gradle.properties",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
]);

/** Base-name patterns: whole names only. */
const SENSITIVE_NAME_PATTERNS: RegExp[] = [
  LOCKFILE,
  /^requirements[^/]*\.(?:txt|in)$/,
  /^Dockerfile(?:\.[^/]+)?$/,
  /^[^/]+\.Dockerfile$/,
  /^[^/]+\.cmake$/,
  /^[^/]+\.sh$/,
  /^\.env(?:\.[^/]+)?$/,
  /^tsconfig(?:\.[^/]+)?\.json$/,
];

/** Directories whose contents are sensitive wherever they sit. */
const SENSITIVE_DIRS = new Set([".github", ".gitlab", "scripts", "migrations", "migration"]);

/** True when changing `path` can alter a build, an install, CI or the environment. */
export function isSensitivePath(path: string, extra?: RegExp): boolean {
  const p = path.replace(/\\/g, "/");
  const base = posix.basename(p);
  if (SENSITIVE_NAMES.has(base)) return true;
  if (SENSITIVE_NAME_PATTERNS.some((r) => r.test(base))) return true;
  const dirs = posix.dirname(p).split("/");
  if (dirs.some((d) => SENSITIVE_DIRS.has(d))) return true;
  if (p.startsWith("gradle/wrapper/") || p.includes("/gradle/wrapper/")) return true;
  if (base === ".gitlab-ci.yml") return true;
  return extra?.test(p) === true;
}

/** Test markers that stand in for a real test: skips, focus, disabled tests, TODO/FIXME, a stray debugger. */
const STAND_IN =
  /\b(?:it|test|describe|suite)\.(?:skip|only|todo)\b|@Disabled\b|@Ignore\b|\bx(?:it|describe)\(|\bf(?:it|describe)\(|\bTODO\b|\bFIXME\b|\bdebugger;|\bt\.Skip(?:Now|f)?\(|#\[ignore\]|\bDISABLED_|\bGTEST_SKIP\b/;

const TEST_NAME = /(\.(test|spec)\.[cm]?[jt]sx?|Test\.java|_test\.\w+|^test_[^/]*\.py)$/;

/** A test file's subject: `foo.test.ts`, `FooTest.java`, `foo_test.go` and `test_foo.py` are about `foo`/`Foo`. */
function stem(path: string): string {
  return posix
    .basename(path)
    .replace(/\.(test|spec)(?=\.)/, "")
    .replace(/(Test)?\.[^.]+$/, "")
    .replace(/_test$/, "")
    .replace(/^test_/, "");
}

export interface FlagInput {
  /** The session the change belongs to. Every flag names it. */
  sessionId?: string;
  /** What the change touched, from `git diff --name-status --no-renames base..head`. */
  changed: ChangedPath[];
  /** The `+` lines of the change. */
  added: string[];
  /** Commits on the session's branch, to find the one that saved leftovers. */
  commits?: CommitSummary[];
  /** The task's `scope` globs. Absent or empty, OUT-OF-SCOPE is not checked. */
  scope?: string[];
  /** The task's `files`: a new file beside one of them, or a test of one, is in scope. */
  files?: string[];
  /** Lines removed per path, from `git diff --numstat`: a test file that only gains lines is in scope. */
  removedLines?: Map<string, number>;
  /** A project's extra sensitive paths, a regex over the repo-relative path. */
  sensitiveExtra?: RegExp;
}

function flag(kind: SessionFlag["flag"], detail: string, sessionId: string | undefined, files?: string[]): SessionFlag {
  return {
    flag: kind,
    detail: detail.slice(0, 300),
    ...(files !== undefined && files.length > 0 ? { files } : {}),
    ...(sessionId !== undefined ? { session: sessionId } : {}),
  };
}

/** Changed paths outside `scope`, after Boxie's allowances for new neighbours and tests of the task's files. */
export function outOfScopePaths(input: Pick<FlagInput, "changed" | "scope" | "files" | "removedLines">): string[] {
  const scope = (input.scope ?? []).filter((g) => g !== "");
  if (scope.length === 0) return [];
  const files = input.files ?? [];
  const dirs = new Set(files.map((f) => posix.dirname(f.replace(/\\/g, "/"))));
  const stems = new Set(files.map(stem));
  return input.changed
    .filter(({ status, path }) => {
      if (matchAnyGlob(path, scope)) return false;
      if (status === "A" && dirs.has(posix.dirname(path))) return false;
      if (TEST_NAME.test(posix.basename(path)) && (stems.has(stem(path)) || input.removedLines?.get(path) === 0)) return false;
      return true;
    })
    .map((c) => c.path);
}

/**
 * OUT-OF-SCOPE, SENSITIVE, STAND-IN and LEFTOVERS for a writing session's change. A read-only session's
 * change is REVIEW-EDIT's business, so the caller does not ask for these.
 */
export function changeFlags(input: FlagInput): SessionFlag[] {
  const flags: SessionFlag[] = [];
  const outside = outOfScopePaths(input);
  if (outside.length > 0) {
    flags.push(flag("OUT-OF-SCOPE", `${outside.length} changed file${outside.length === 1 ? "" : "s"} outside scope: ${outside.join(", ")}`, input.sessionId, outside));
  }
  const sensitive = input.changed.filter((c) => c.status === "D" || isSensitivePath(c.path, input.sensitiveExtra));
  if (sensitive.length > 0) {
    const named = sensitive.map((c) => (c.status === "D" ? `${c.path} (deleted)` : c.path));
    flags.push(flag("SENSITIVE", named.join(", "), input.sessionId, sensitive.map((c) => c.path)));
  }
  const standIns = input.added.filter((l) => STAND_IN.test(l)).map((l) => l.trim().slice(0, 80));
  if (standIns.length > 0) flags.push(flag("STAND-IN", standIns.slice(0, 4).join(" | "), input.sessionId));
  const saved = (input.commits ?? []).find((c) => c.subject.startsWith(LEFTOVER_SUBJECT_PREFIX));
  if (saved !== undefined) {
    flags.push(flag("LEFTOVERS", `the session left uncommitted changes; they were saved as ${saved.sha.slice(0, 12)}`, input.sessionId));
  }
  return flags;
}
