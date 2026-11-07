// Claims (T234, ADR-0059, ADR-0061, spec decision 12): what a delegated session says is true of its work, with a
// check the harness runs. The session records a claim with the `claim` tool; the harness decides the verdict
// (`claim-checks.ts`). Nothing the model writes in prose is a claim, and nothing in a verdict comes from the model:
// a verdict says what a tool saw (R15, R24).
//
// A check is one of four shapes:
//   - `line`: the file at `path`, line `line`, contains `text`. Read by the harness, no shell.
//   - `search`: the lines matching the regular expression `pattern` (in the files under `paths`, or all of them)
//     number `matches`. Read by the harness, no shell.
//   - `command`: `command` exits with `exit`.
//   - `reproduction`: the test file `file` with `content`, run through `seal.test_command`, fails in exactly the
//     tests named in `fails`.

import { isAbsolute, posix } from "node:path";
import type { Ledger } from "../ledger/use.js";

export const CLAIM_CHECK_KINDS = ["line", "search", "command", "reproduction"] as const;
export type ClaimCheckKind = (typeof CLAIM_CHECK_KINDS)[number];

export type ClaimCheck =
  | { kind: "line"; path: string; line: number; text: string }
  | { kind: "search"; pattern: string; matches: number; paths?: string[] }
  | { kind: "command"; command: string; exit: number }
  | { kind: "reproduction"; file: string; content: string; fails: string[] };

/** The largest reproduction file, in characters. A reproduction is a small test, not a repository. */
export const MAX_REPRODUCTION_CHARS = 256 * 1024;

/** The shapes, as the tool's refusal shows them. */
export const CLAIM_CHECK_SHAPES = [
  '{ "kind": "line", "path": "src/a.ts", "line": 12, "text": "what line 12 contains" }',
  '{ "kind": "search", "pattern": "regular expression", "matches": 2, "paths": ["src"] }  (matches: how many lines match; paths optional)',
  '{ "kind": "command", "command": "npm test", "exit": 0 }',
  '{ "kind": "reproduction", "file": "tests/repro.test.ts", "content": "the test file", "fails": ["name of a test that must fail"] }',
].join("\n");

export type ParsedCheck = { ok: true; check: ClaimCheck } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A repository-relative path with forward slashes, or why it is not one. `.git` is never a path a check may name. */
export function repoPath(value: unknown, label: string): { ok: true; path: string } | { ok: false; message: string } {
  if (typeof value !== "string" || value.trim() === "") return { ok: false, message: `${label} must be a non-empty path` };
  const normal = posix.normalize(value.replace(/\\/g, "/"));
  if (isAbsolute(value) || normal.startsWith("/") || /^[A-Za-z]:/.test(normal)) return { ok: false, message: `${label} must be relative to the repository root: ${value}` };
  if (normal === ".." || normal.startsWith("../") || normal === ".") return { ok: false, message: `${label} must stay inside the repository: ${value}` };
  if (normal.split("/").some((part) => part.toLowerCase() === ".git")) return { ok: false, message: `${label} must not name .git: ${value}` };
  return { ok: true, path: normal };
}

function integer(value: unknown, label: string, min: number, max?: number): { ok: true; value: number } | { ok: false; message: string } {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
    return { ok: false, message: `${label} must be an integer${max !== undefined ? ` from ${min} to ${max}` : ` of at least ${min}`}` };
  }
  return { ok: true, value };
}

/** Validates a check as the model wrote it. Nothing is guessed: a check that is not one of the shapes is refused. */
export function parseClaimCheck(value: unknown): ParsedCheck {
  if (!isRecord(value)) return { ok: false, message: "check must be an object" };
  const kind = value["kind"];
  if (kind === "line") {
    const path = repoPath(value["path"], "check.path");
    if (!path.ok) return path;
    const line = integer(value["line"], "check.line", 1);
    if (!line.ok) return line;
    const text = value["text"];
    if (typeof text !== "string" || text === "") return { ok: false, message: "check.text must be non-empty text the line contains" };
    return { ok: true, check: { kind, path: path.path, line: line.value, text } };
  }
  if (kind === "search") {
    const pattern = value["pattern"];
    if (typeof pattern !== "string" || pattern === "") return { ok: false, message: "check.pattern must be a non-empty regular expression" };
    try {
      new RegExp(pattern);
    } catch (err) {
      return { ok: false, message: `check.pattern is not a regular expression: ${err instanceof Error ? err.message : String(err)}` };
    }
    const matches = integer(value["matches"], "check.matches", 0);
    if (!matches.ok) return matches;
    let paths: string[] | undefined;
    if (value["paths"] !== undefined) {
      if (!Array.isArray(value["paths"]) || value["paths"].length === 0) return { ok: false, message: "check.paths must be a non-empty list of paths when given" };
      paths = [];
      for (const raw of value["paths"]) {
        const p = repoPath(raw, "check.paths entry");
        if (!p.ok) return p;
        paths.push(p.path);
      }
    }
    return { ok: true, check: { kind, pattern, matches: matches.value, ...(paths !== undefined ? { paths } : {}) } };
  }
  if (kind === "command") {
    const command = value["command"];
    if (typeof command !== "string" || command.trim() === "") return { ok: false, message: "check.command must be a non-empty command" };
    const exit = integer(value["exit"], "check.exit", 0, 255);
    if (!exit.ok) return exit;
    return { ok: true, check: { kind, command, exit: exit.value } };
  }
  if (kind === "reproduction") {
    const file = repoPath(value["file"], "check.file");
    if (!file.ok) return file;
    const content = value["content"];
    if (typeof content !== "string" || content.trim() === "") return { ok: false, message: "check.content must be the test file's text" };
    if (content.length > MAX_REPRODUCTION_CHARS) return { ok: false, message: `check.content is over ${MAX_REPRODUCTION_CHARS} characters` };
    const fails = value["fails"];
    if (!Array.isArray(fails) || fails.length === 0 || !fails.every((n) => typeof n === "string" && n.trim() !== "")) {
      return { ok: false, message: "check.fails must name, as a non-empty list, the tests that must fail" };
    }
    return { ok: true, check: { kind, file: file.path, content, fails: fails.map((n: string) => n.trim()) } };
  }
  return { ok: false, message: `check.kind must be one of ${CLAIM_CHECK_KINDS.join(", ")}` };
}

/**
 * A check as a result carries it. A reproduction's file can be large and the ledger has it whole, so the result names the
 * file and the tests and counts the characters.
 */
export type ReportedCheck = Exclude<ClaimCheck, { kind: "reproduction" }> | { kind: "reproduction"; file: string; fails: string[]; content_chars: number };

export function reportedCheck(check: ClaimCheck): ReportedCheck {
  return check.kind === "reproduction" ? { kind: check.kind, file: check.file, fails: check.fails, content_chars: check.content.length } : check;
}

export type ClaimVerdict = "verified" | "failed" | "unchecked";

/** What the check found at the base commit, for a reproduction: do the named tests also fail there. */
export type BaseVerdict = "passes" | "fails" | "unknown";

/** A claim and the harness's verdict on it, as a result carries it. */
export interface ClaimResult {
  id: number;
  text: string;
  check: ReportedCheck;
  verdict: ClaimVerdict;
  /** What the tools saw. Never the model's words. */
  reason: string;
  /** The check ran on the host with containment off, on a project the user trusts (ADR-0061). */
  uncontained?: true;
  /** A reproduction only: the same tests at the base commit. */
  base?: { verdict: BaseVerdict; reason: string };
  /** A reproduction that fails on the branch and passes on the base: the change broke it. */
  regression?: true;
}

export interface StoredClaim {
  id: number;
  session_id: string;
  ts: string;
  text: string;
  check: ClaimCheck;
}

interface ClaimRow {
  id: number;
  session_id: string;
  ts: string;
  text: string;
  check_json: string;
}

/** Writes a claim the moment the tool is called. Returns its id. */
export function recordClaim(ledger: Ledger, sessionId: string, text: string, check: ClaimCheck): number {
  const info = ledger.db
    .prepare("INSERT INTO claims (session_id, ts, text, kind, check_json) VALUES (?, ?, ?, ?, ?)")
    .run(sessionId, new Date().toISOString(), text, check.kind, JSON.stringify(check));
  return Number(info.lastInsertRowid);
}

/** A session's claims, oldest first. */
export function claimsOf(ledger: Ledger, sessionId: string): StoredClaim[] {
  const rows = ledger.db.prepare("SELECT id, session_id, ts, text, check_json FROM claims WHERE session_id = ? ORDER BY id ASC").all(sessionId) as ClaimRow[];
  return rows.map((r) => ({ id: r.id, session_id: r.session_id, ts: r.ts, text: r.text, check: JSON.parse(r.check_json) as ClaimCheck }));
}

/** Stores what the harness found, with the commits it found it at. A later run replaces an earlier one. */
export function recordClaimVerdicts(ledger: Ledger, results: readonly ClaimResult[], head: string | undefined, base: string | undefined): void {
  const stmt = ledger.db.prepare(
    `UPDATE claims SET verdict = ?, reason = ?, uncontained = ?, base_verdict = ?, base_reason = ?, head_commit = ?, base_commit = ?, checked_at = ? WHERE id = ?`,
  );
  const checkedAt = new Date().toISOString();
  ledger.db.transaction(() => {
    for (const r of results) {
      stmt.run(r.verdict, r.reason, r.uncontained === true ? 1 : 0, r.base?.verdict ?? null, r.base?.reason ?? null, head ?? null, base ?? null, checkedAt, r.id);
    }
  })();
}

interface VerdictRow {
  id: number;
  text: string;
  check_json: string;
  verdict: ClaimVerdict | null;
  reason: string | null;
  uncontained: number;
  base_verdict: BaseVerdict | null;
  base_reason: string | null;
}

/** The claims of a session the harness has already judged, as a result carries them. Unjudged ones are left out. */
export function judgedClaimsOf(ledger: Ledger, sessionId: string): ClaimResult[] {
  const rows = ledger.db
    .prepare("SELECT id, text, check_json, verdict, reason, uncontained, base_verdict, base_reason FROM claims WHERE session_id = ? AND verdict IS NOT NULL ORDER BY id ASC")
    .all(sessionId) as VerdictRow[];
  return rows.map((r) => {
    const base = r.base_verdict !== null ? { verdict: r.base_verdict, reason: r.base_reason ?? "" } : undefined;
    return {
      id: r.id,
      text: r.text,
      check: reportedCheck(JSON.parse(r.check_json) as ClaimCheck),
      verdict: r.verdict!,
      reason: r.reason ?? "",
      ...(r.uncontained === 1 ? { uncontained: true as const } : {}),
      ...(base !== undefined ? { base } : {}),
      ...(r.verdict === "verified" && base?.verdict === "passes" ? { regression: true as const } : {}),
    };
  });
}
