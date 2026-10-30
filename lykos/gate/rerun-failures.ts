// The pure half of the session gate's rerun (ADR-0030).
//
// A flaky test turned correct work into `fail` (P4 demonstration run 2,
// session 01a10b29: backlog D22's Windows EPERM race in `lsp.test.ts`). The
// gate now reruns the failed test FILES once. Two questions need answering
// before it can, and neither needs a process or a ledger:
//
//   1. Which files failed?       `parseFailedTests(output)`
//   2. What command runs them?   `deriveRerunCommand(script, files)` / `renderRerunCommand`
//
// Both are conservative in one direction. An output this module cannot read,
// or a script it cannot safely rewrite, answers "nothing" — and the caller
// treats nothing as "no rerun, the first verdict stands". A rerun built on a
// guess could turn a real failure into a pass, which is the one thing the
// outcome column must never do.

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface FailedTest {
  /** Relative to the project (`cwd`), forward slashes. */
  file: string;
  /** As the reporter printed it. A file that failed as a whole (a crash on load) is named by its path. */
  name: string;
}

// ---------------------------------------------------------------------------
// 1. Parsing the failed tests out of node:test's output
// ---------------------------------------------------------------------------

/** Escape sequences a reporter may colour its output with. */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** `✖ name (12.3ms)` — the reporter's failing-test line; the duration is not part of the name. */
const SPEC_FAIL_LINE = /^[✖✗x]\s+(.*?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/;

/** `test at lykos\tools\lsp.test.ts:464:3`, or an absolute path, with either separator. */
const SPEC_LOCATION = /^test at (.+):(\d+):(\d+)\s*$/;

/**
 * The tests that failed, from the output of a `node --test` / `tsx --test`
 * run. Two reporters are read, because Node's default depends on its version
 * and on whether stdout is a terminal:
 *
 *  - **spec** (what `npm test` prints when piped, Node 24, checked 2026-10-05).
 *    The closing "failing tests:" section lists every failed LEAF test (a
 *    suite whose subtest failed is not listed; its subtest is):
 *
 *        test at lykos\tools\lsp.test.ts:464:3
 *        ✖ rename across files (12.3ms)
 *          Error: ...
 *
 *    A file that crashed before running a test is listed the same way with the
 *    file's own path as its name.
 *  - **tap** (`--test-reporter=tap`, and the default of Node 20–22 off a
 *    terminal). A failed test is `not ok N - name`, and its diagnostic block
 *    carries `location: '<absolute path>:line:col'` and `failureType`; a
 *    parent failing only because a subtest did (`subtestsFailed`) is skipped.
 *
 * Paths are made relative to `cwd` when absolute, and always use `/`.
 * Output in any other shape (`dot`, `junit`, a custom reporter) yields `[]`.
 * Duplicates are dropped.
 */
export function parseFailedTests(output: string, cwd?: string): FailedTest[] {
  const lines = output.replace(ANSI, "").split(/\r?\n/);
  const found: FailedTest[] = [];
  const seen = new Set<string>();
  const add = (rawPath: string, name: string): void => {
    const file = relativePath(rawPath, cwd);
    const key = `${file}\u0000${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ file, name });
  };

  // spec
  for (let i = 0; i < lines.length; i++) {
    const loc = SPEC_LOCATION.exec(lines[i]!);
    if (loc === null) continue;
    const next = lines[i + 1]?.match(SPEC_FAIL_LINE);
    if (next === null || next === undefined) continue;
    add(loc[1]!, next[1]!);
  }
  if (found.length > 0) return found;

  // tap
  for (let i = 0; i < lines.length; i++) {
    const head = /^\s*not ok \d+ - (.*?)\s*$/.exec(lines[i]!);
    if (head === null) continue;
    let location: string | undefined;
    let failureType: string | undefined;
    for (let j = i + 1; j < lines.length && j < i + 40; j++) {
      const line = lines[j]!;
      if (/^\s*(not )?ok \d+ /.test(line) || /^\s*# Subtest/.test(line)) break;
      const l = /^\s+location: '(.*)'\s*$/.exec(line);
      if (l !== null) location = l[1]!.replace(/\\\\/g, "\\");
      const f = /^\s+failureType: '(.*)'\s*$/.exec(line);
      if (f !== null) failureType = f[1]!;
      if (/^\s+\.\.\.\s*$/.test(line)) break;
    }
    if (location === undefined || failureType === "subtestsFailed") continue;
    const loc = /^(.+):(\d+):(\d+)$/.exec(location);
    if (loc === null) continue;
    add(loc[1]!.startsWith("file://") ? fileURLToPath(loc[1]!) : loc[1]!, head[1]!);
  }
  return found;
}

function relativePath(raw: string, cwd: string | undefined): string {
  let path = raw.trim();
  if (cwd !== undefined && isAbsolute(path)) {
    const rel = relative(cwd, path);
    if (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)) path = rel;
  }
  path = path.replace(/\\/g, "/");
  while (path.startsWith("./")) path = path.slice(2);
  return path;
}

export interface TestSummary {
  tests: number;
  pass: number;
  fail: number;
  cancelled: number;
}

/**
 * The reporter's own closing counts — spec prints `ℹ tests 8`, tap prints
 * `# tests 8` — or `undefined` when they cannot be read with certainty: a
 * count missing, or more than one summary in the output (two test runs in one
 * command, so no single set of counts describes it).
 */
export function parseTestSummary(output: string): TestSummary | undefined {
  const text = output.replace(ANSI, "");
  const all = (name: string): number[] =>
    [...text.matchAll(new RegExp(`^(?:ℹ|#) ${name} (\\d+)\\s*$`, "gm"))].map((m) => Number(m[1]));
  const tests = all("tests");
  const pass = all("pass");
  const fail = all("fail");
  const cancelled = all("cancelled");
  if ([tests, pass, fail, cancelled].some((v) => v.length !== 1)) return undefined;
  return { tests: tests[0]!, pass: pass[0]!, fail: fail[0]!, cancelled: cancelled[0]! };
}

/**
 * Do the parsed failures account for every failure the reporter counted?
 *
 * The parser reads the "failing tests" section; a failure it misses (a crash
 * with no `test at` line, a reporter quirk) would let a rerun of the OTHER
 * files pass and record `success` over a failure nobody reran. So a rerun is
 * allowed only when the summary is readable and the parsed failures are at
 * least as many as `fail` + `cancelled`.
 *
 * Checked against real node:test output (Node 24.11, 2026-10-05):
 *  - a failing test in a `describe` suite: the suite is listed in the section
 *    but NOT counted in `fail` (parsed 1, `fail 1` for the leaf) — fine;
 *  - a suite whose `after` hook threw: listed, `fail 0` — parsed exceeds the count, fine;
 *  - a cancelled test (timeout): listed, `cancelled 1`, `fail 0` — fine;
 *  - a file that crashed on load: listed by its path, counted in `fail` — fine;
 *  - a TEST (not a suite) that failed only because a subtest did (`t.test`):
 *    counted in `fail` but NOT listed, so the counts disagree. That is refused
 *    rather than guessed at: the spec reporter cannot tell such a parent from
 *    a failed suite.
 *
 * `>=` and not `==` because a listed suite can offset nothing it should not;
 * the residual hole is a missed failure hidden by an equally-sized extra
 * listing (a suite hook failure beside a missed test failure), which needs two
 * independent anomalies in one run.
 */
export function failuresAccountedFor(failed: readonly FailedTest[], summary: TestSummary | undefined): boolean {
  return summary !== undefined && failed.length >= summary.fail + summary.cancelled;
}

/**
 * Does a rerun's output show the failed tests passing? Exit 0 alone does not:
 * a run that executed nothing exits 0 too (a nested `node --test` that
 * inherited `NODE_TEST_CONTEXT` did exactly that). It must have a readable
 * summary with at least one test, no failure, no cancellation, and at least as
 * many passes as there are tests it is vouching for.
 */
export function rerunShowsPass(summary: TestSummary | undefined, named: number): boolean {
  return summary !== undefined && summary.tests >= 1 && summary.fail === 0 && summary.cancelled === 0 && summary.pass >= named;
}

/**
 * The files to rerun, or `undefined` when the rerun must not happen: nothing
 * parsed, or any failed test sits in a file that is not in the project (a
 * `node:internal` frame, a path outside `cwd`). A rerun of only SOME of the
 * failures that passes would record `success` over a failure it never reran.
 */
export function failedFilesToRerun(
  failed: readonly FailedTest[],
  cwd: string,
  exists: (path: string) => boolean = existsSync,
): string[] | undefined {
  if (failed.length === 0) return undefined;
  const files: string[] = [];
  for (const f of failed) {
    if (f.file.startsWith("../") || isAbsolute(f.file) || !exists(resolve(cwd, f.file))) return undefined;
    if (!files.includes(f.file)) files.push(f.file);
  }
  return files;
}

// ---------------------------------------------------------------------------
// 2. The rerun command
// ---------------------------------------------------------------------------

/** The placeholder `gate.rerun_command` carries. */
export const RERUN_FILES_PLACEHOLDER = "{files}";

const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./\\*?\[\]-]+$/;

/** A shell word for a path or flag: bare when it is plain, double-quoted when it is not, `undefined` when it cannot be quoted safely. */
function shellWord(token: string): string | undefined {
  if (SAFE_TOKEN.test(token)) return token;
  if (/["`$%^!\n\r]/.test(token)) return undefined;
  return `"${token}"`;
}

/**
 * Splits a command the way a shell would, for the one purpose of rewriting it.
 * Returns `undefined` for anything that is not one plain command: a pipe, a
 * `&&`, a redirect, a substitution, an unterminated quote.
 */
export function tokenizeCommand(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | undefined;
  for (const ch of command) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) tokens.push(current);
      current = "";
      started = false;
    } else if ("&|;<>`$(){}".includes(ch)) {
      return undefined;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote !== undefined) return undefined;
  if (started) tokens.push(current);
  return tokens;
}

/** Flags of `node` / `tsx` that take a value as the NEXT token when not written `--flag=value`. */
const VALUE_FLAGS = new Set([
  "--import",
  "--require",
  "-r",
  "--loader",
  "--experimental-loader",
  "--conditions",
  "-C",
  "--env-file",
  "--tsconfig",
  "--test-reporter",
  "--test-reporter-destination",
  "--test-name-pattern",
  "--test-skip-pattern",
  "--test-concurrency",
  "--test-timeout",
  "--test-shard",
  "--test-isolation",
]);

/** Flags that make a script something other than a one-shot test run, or that name code instead of files. */
const REFUSED_FLAGS = new Set(["--watch", "--watch-path", "--eval", "-e", "--print", "-p", "--check", "-c", "--inspect", "--inspect-brk"]);

/**
 * The command that reruns `files` — derived from a test script ONLY when that
 * script is one plain `node --test` or `tsx --test` invocation (optionally
 * `npx tsx --test`). Otherwise `undefined`, and the gate does not rerun.
 *
 * The rule: keep the runner and every flag, with its value, in order; drop
 * every other argument (those are the script's file globs or directories);
 * append `files`. So
 *
 *     tsx --test "lykos/**\/*.test.ts"     →  npx --no-install tsx --test lykos/tools/lsp.test.ts
 *     node --import tsx --test-concurrency=4 --test  →  node --import tsx --test-concurrency=4 --test lykos/a.test.ts
 *     node --test                          →  node --test lykos/a.test.ts      (no globs: node's own discovery is replaced)
 *
 * `tsx` is not on the shell's PATH the way it is inside `npm test`, so a bare
 * `tsx` is run as `npx --no-install tsx`, which resolves the project's own copy
 * and never downloads one.
 *
 * Refused (`undefined`): more than one command (`&&`, `;`, `|`), redirects,
 * environment prefixes (`FOO=1 node --test`), `--watch`, `--eval`, a runner
 * other than node/tsx, and a script with no `--test` flag. A person with such a
 * script sets `gate.rerun_command` instead.
 */
export function deriveRerunCommand(script: string, files: readonly string[]): string | undefined {
  if (files.length === 0) return undefined;
  const tokens = tokenizeCommand(script.trim());
  if (tokens === undefined || tokens.length === 0) return undefined;

  let runner: string[];
  let rest: string[];
  if (tokens[0] === "node") {
    runner = ["node"];
    rest = tokens.slice(1);
  } else if (tokens[0] === "tsx") {
    runner = ["npx", "--no-install", "tsx"];
    rest = tokens.slice(1);
  } else if (tokens[0] === "npx" && tokens[1] === "tsx") {
    runner = ["npx", "--no-install", "tsx"];
    rest = tokens.slice(2);
  } else if (tokens[0] === "npx" && tokens[1] === "--no-install" && tokens[2] === "tsx") {
    runner = ["npx", "--no-install", "tsx"];
    rest = tokens.slice(3);
  } else {
    return undefined;
  }

  const kept: string[] = [];
  let sawTest = false;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (!token.startsWith("-")) continue; // a glob, a directory or a file: replaced by `files`
    const name = token.split("=")[0]!;
    if (REFUSED_FLAGS.has(name)) return undefined;
    if (token === "--test") sawTest = true;
    kept.push(token);
    if (VALUE_FLAGS.has(token)) {
      const value = rest[i + 1];
      if (value === undefined) return undefined;
      kept.push(value);
      i += 1;
    }
  }
  if (!sawTest) return undefined;
  return finish([...runner, ...kept], files);
}

/**
 * `gate.rerun_command` with `{files}` replaced by the failed files, each as a
 * shell word. `undefined` when the template has no placeholder or a file
 * cannot be quoted.
 */
export function renderRerunCommand(template: string, files: readonly string[]): string | undefined {
  if (!template.includes(RERUN_FILES_PLACEHOLDER) || files.length === 0) return undefined;
  const words = files.map(shellWord);
  if (words.some((w) => w === undefined)) return undefined;
  return template.split(RERUN_FILES_PLACEHOLDER).join(words.join(" "));
}

function finish(prefix: readonly string[], files: readonly string[]): string | undefined {
  const words = [...prefix, ...files].map(shellWord);
  if (words.some((w) => w === undefined)) return undefined;
  return words.join(" ");
}

/**
 * The script a gate command stands for: `npm test` (and `npm run test`,
 * `npm t`) mean the project's `test` script; anything else is its own script.
 */
export function scriptOfGateCommand(command: string, testScript: string | undefined): string | undefined {
  const trimmed = command.trim();
  if (/^npm\s+(?:run\s+)?(?:test|t)$/.test(trimmed)) return testScript;
  return trimmed;
}

/**
 * Why a `gate.rerun_command` value is unusable, or `undefined` when it is
 * fine. Empty means "derive one". A command without `{files}` would rerun
 * whatever it names, not the failed files, so it is refused up front rather
 * than quietly never rerunning.
 */
export function gateRerunCommandProblem(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined; // an empty YAML value is unset
  if (typeof value !== "string") return "gate.rerun_command must be a string";
  if (value.trim().length > 0 && !value.includes(RERUN_FILES_PLACEHOLDER)) {
    return `gate.rerun_command must contain ${RERUN_FILES_PLACEHOLDER}, where the failed test files go`;
  }
  return undefined;
}
