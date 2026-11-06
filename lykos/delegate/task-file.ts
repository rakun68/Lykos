// The task file a coordinator hands Lykos (T231, spec decision 9): Boxie's format, unchanged. Markdown
// with optional YAML frontmatter:
//
//   files:  [paths the task is about]
//   areas:  [context-map areas]          (Boxie's; kept, not used by Lykos yet)
//   sealed: [test files the session may not edit]
//   test:   "the exact verification command"
//   scope:  [more globs the session may change]
//   red:    false                         (skip the check that sealed tests fail on the base)
//   steps:  N                             (step cap)
//   issue:  N | owner/repo#N | [..]       (fetched with its spec, see issue-fetch.ts)
//
// The body is the brief. Nothing here runs a command.

import { parse as parseYaml } from "yaml";
import type { DelegationConfig } from "../config/types.js";
import { isTestFileName } from "./result-flags.js";

export interface TaskFile {
  /** The task text without its frontmatter. */
  body: string;
  files: string[];
  areas: string[];
  sealed: string[];
  scope: string[];
  /** The verification command the task names. */
  test?: string;
  /** False skips the red check on the base. Default true. */
  red: boolean;
  /** The step cap. */
  steps?: number;
  /** Issue references: `N`, `#N` or `owner/repo#N`. */
  issue: string[];
  /** Frontmatter keys Lykos does not know, ignored as Boxie ignores them. */
  warnings: string[];
}

const KNOWN_KEYS = new Set(["files", "areas", "sealed", "test", "scope", "red", "steps", "issue"]);

export class TaskFileError extends Error {}

function asList(value: unknown, key: string): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  throw new TaskFileError(`task file: ${key} must be a list or a single value`);
}

/** Parses a task file. A malformed frontmatter or a wrongly typed key is an error, never a silent default. */
export function parseTaskFile(text: string): TaskFile {
  const raw = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  let front: Record<string, unknown> = {};
  let body = raw;
  if (fm) {
    let parsed: unknown;
    try {
      parsed = parseYaml(fm[1]!);
    } catch (err) {
      throw new TaskFileError(`task file: frontmatter is not YAML: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (parsed !== null && parsed !== undefined) {
      if (typeof parsed !== "object" || Array.isArray(parsed)) throw new TaskFileError("task file: frontmatter must be a mapping");
      front = parsed as Record<string, unknown>;
    }
    body = raw.slice(fm[0].length);
  }

  const warnings = Object.keys(front)
    .filter((k) => !KNOWN_KEYS.has(k))
    .map((k) => `task file: unknown frontmatter key "${k}" ignored`);

  let test: string | undefined;
  if (front.test !== undefined && front.test !== null) {
    if (typeof front.test !== "string") throw new TaskFileError("task file: test must be a string");
    if (front.test.trim() !== "") test = front.test.trim();
  }

  let red = true;
  if (front.red !== undefined && front.red !== null) {
    if (typeof front.red !== "boolean") throw new TaskFileError("task file: red must be true or false");
    red = front.red;
  }

  let steps: number | undefined;
  if (front.steps !== undefined && front.steps !== null) {
    if (typeof front.steps !== "number" || !Number.isInteger(front.steps) || front.steps < 1) {
      throw new TaskFileError("task file: steps must be a positive integer");
    }
    steps = front.steps;
  }

  return {
    body,
    files: asList(front.files, "files"),
    areas: asList(front.areas, "areas"),
    sealed: asList(front.sealed, "sealed"),
    scope: asList(front.scope, "scope"),
    ...(test !== undefined ? { test } : {}),
    red,
    ...(steps !== undefined ? { steps } : {}),
    issue: asList(front.issue, "issue"),
    warnings,
  };
}

/** Fills a test command template: `{files}` the files, `{tests}` Gradle filters of the Java tests, `{dirs}` their directories. */
export function fillTestCommand(template: string, files: readonly string[]): string {
  const norm = files.map((f) => f.replace(/\\/g, "/"));
  const tests = norm
    .filter((f) => /^src\/test\/java\/.*\.java$/.test(f))
    .map((t) => `--tests ${t.replace(/^src\/test\/java\//, "").replace(/\.java$/, "").replace(/\//g, ".")}`)
    .join(" ");
  const dirs = [...new Set(norm.map((f) => (f.includes("/") ? `./${f.slice(0, f.lastIndexOf("/"))}` : ".")))].join(" ");
  return template.replaceAll("{files}", norm.join(" ")).replaceAll("{tests}", tests).replaceAll("{dirs}", dirs);
}

export interface ResolvedTestCommand {
  command: string;
  /** Where it came from: the task's `test:`, or the project's `delegation.test_command`. */
  source: "task" | "delegation.test_command";
}

/**
 * The exact verification command a session may run (R10): the task's `test:`, else the project's
 * `delegation.test_command` filled with the task's test files (its sealed files and the test files among
 * `files`). Neither: undefined. A command is never derived from file names or the project's layout.
 */
export function resolveTestCommand(task: Pick<TaskFile, "test" | "sealed" | "files">, config: { delegation: Pick<Required<DelegationConfig>, "test_command"> }): ResolvedTestCommand | undefined {
  if (task.test !== undefined) return { command: task.test, source: "task" };
  const template = config.delegation.test_command.trim();
  if (template === "") return undefined;
  const testFiles = [...new Set([...task.sealed, ...task.files.filter(isTestFileName)])];
  return { command: fillTestCommand(template, testFiles), source: "delegation.test_command" };
}

/** The line a session's brief gets about its verification command: it may run exactly this. */
export function testCommandBrief(resolved: ResolvedTestCommand | undefined): string {
  if (resolved === undefined) return "No verification command is set for this task; do not guess one. Say what you ran and why.";
  return `Verification command (run exactly this to check your work; do not substitute another): ${resolved.command}`;
}
