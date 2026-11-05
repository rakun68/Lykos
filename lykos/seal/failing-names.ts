// Failing test names for runners with no structured reporter (T251, spec decisions 10 and 14).
//
// cargo: libtest prints one `test <path> ... ok|FAILED|ignored` line per test and a `---- <path> stdout ----`
// section per failure. Each test binary is announced on stderr as `Running <target> (<binary>)`, so the
// caller passes stdout and stderr merged in arrival order to attribute tests to a target.
//
// Any other runner: the failure is identified by its exit code plus a hash of its normalised output, so two
// runs of the same failure compare equal and a different failure does not.

import { createHash } from "node:crypto";
import type { SealedTestResult } from "./runner.js";

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** `cargo test` or `cargo +toolchain test`, with any flags in between. */
export function isCargoTestCommand(template: string): boolean {
  return /\bcargo(?:\s+\+\S+)?\s+(?:[^\s]+\s+)*?test\b/.test(template);
}

/**
 * The tests libtest reported, in the order it reported them. `file` is the target cargo named in its `Running`
 * line (`src/lib.rs`, `tests/api.rs`), or `doc-tests` for doc tests. `describe` is the module path and `name` the
 * test function. A failure whose panic message starts with `assertion` (assert!, assert_eq!, assert_ne!) is an
 * assertion; any other panic is an error.
 */
export function parseCargoTestOutput(output: string): SealedTestResult[] {
  const lines = output.replace(ANSI, "").replace(/\r\n?/g, "\n").split("\n");
  const results: SealedTestResult[] = [];
  const panics = new Map<string, string>();
  let target = "";
  let inFailure: string | undefined;
  let failureLines: string[] = [];

  const closeFailure = (): void => {
    if (inFailure !== undefined) panics.set(`${target}\u0000${inFailure}`, failureLines.join("\n").trim());
    inFailure = undefined;
    failureLines = [];
  };

  for (const line of lines) {
    const running = /^\s*Running (?:unittests )?(\S+)(?: \(.*\))?\s*$/.exec(line);
    if (running) {
      closeFailure();
      target = running[1]!.replace(/\\/g, "/");
      continue;
    }
    if (/^\s*Doc-tests \S+\s*$/.test(line)) {
      closeFailure();
      target = "doc-tests";
      continue;
    }
    const section = /^---- (.+?) stdout ----$/.exec(line);
    if (section) {
      closeFailure();
      inFailure = section[1]!;
      continue;
    }
    if (inFailure !== undefined) {
      if (/^(failures:|test result:)/.test(line)) closeFailure();
      else {
        failureLines.push(line);
        continue;
      }
    }
    const test = /^test (.+?) \.\.\. (ok|FAILED|ignored(?:, .*)?)$/.exec(line);
    if (!test) continue;
    const path = test[1]!.trim();
    const verdict = test[2]!;
    const parts = path.split("::");
    results.push({
      file: target,
      describe: parts.slice(0, -1),
      name: parts[parts.length - 1]!,
      status: verdict === "ok" ? "pass" : verdict === "FAILED" ? "assertion" : "skip",
    });
  }
  closeFailure();

  for (const r of results) {
    if (r.status !== "assertion") continue;
    const path = [...r.describe, r.name].join("::");
    const message = panics.get(`${r.file}\u0000${path}`) ?? "";
    const panicked = /panicked at [^\n]*:\n([^\n]*)/.exec(message)?.[1]?.trim() ?? "";
    const didNotPanic = /test did not panic as expected/.test(message);
    if (!didNotPanic && panicked !== "" && !/^assertion\b/.test(panicked)) {
      r.status = "error";
      r.errorDetail = panicked;
    } else if (panicked !== "") {
      r.errorDetail = panicked;
    }
  }
  return results;
}

export interface FailureSignature {
  exit: number | null;
  /** sha256 of the normalised output, hex. */
  hash: string;
}

/**
 * The output with what changes between runs of the same failure taken out: colour codes, line endings, path
 * separators, the run's own directory, temporary directories, durations, timestamps, hex ids and thread ids.
 * Lines are trimmed, blank ones dropped, and the rest sorted, since parallel runners print in completion order.
 */
export function normaliseFailingOutput(output: string, dirs: readonly string[] = []): string {
  let text = output.replace(ANSI, "").replace(/\r\n?/g, "\n").replace(/\\/g, "/");
  for (const dir of dirs) {
    const d = dir.replace(/\\/g, "/").replace(/\/+$/, "");
    if (d !== "") text = text.split(d).join("<dir>");
  }
  text = text
    .replace(/\b[A-Za-z]:\/(?:[^\s/]+\/)*?(?:Temp|tmp)\/[^\s)'"]*/gi, "<tmp>")
    .replace(/(?<![\w.])\/(?:tmp|var\/folders)\/[^\s)'"]*/g, "<tmp>")
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<ts>")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ns|µs|us|ms|s|sec|secs|seconds|m|min)\b/g, "<t>")
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/gi, "<hex>")
    .replace(/'([^'\n]*)' \(\d+\)/g, "'$1' (<n>)");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .sort()
    .join("\n");
}

export function failureSignature(exit: number | null, output: string, dirs: readonly string[] = []): FailureSignature {
  return { exit, hash: createHash("sha256").update(normaliseFailingOutput(output, dirs)).digest("hex") };
}
