// A deterministic static scan over a scope, and the other half of the subphase
// whose bash danger rows landed as ticket 11.
//
// **DETERMINISTIC, LOCAL, AND WITHOUT A SECOND OPINION (D1).** This walks
// files, matches a fixed rule set against them, and reports what matched with
// a rule id, a severity, a path and a line. It opens no socket, holds no
// credential, and never asks a model whether something is a problem. There
// is no model review session: it would be a model asked "is this code safe", which is a
// second reviewer standing next to `lykos-reviewer` and next to the gate,
// and this phase exists to build deterministic tools rather than more
// opinions.
//
// **THE RULES ARE THE ONES LYKOS ALREADY OWNS (D2), AND EACH CLOSES A GAP
// SOMETHING SHIPPED CANNOT SEE.**
//
//   `secret.*` comes from `loop/hooks.ts`'s `SECRET_PATTERNS`. That table is
//   already wired into `secretsHook()`, which is a `pre_tool` hook on
//   `write`, `edit`, `multi_edit` and `apply_patch` — so it sees a credential
//   LYKOS IS ABOUT TO WRITE and nothing else. A key a human pasted in, a
//   `bash` heredoc wrote, or a `git clone` brought along is invisible to it,
//   and those are the ones that sit in a repository for a year. The table is
//   imported rather than restated so there is one answer in this codebase to
//   "what is a credential shape". `detectSecrets` is not reused because it
//   answers over a whole text and a finding needs a position; this is the
//   same table read per line, not a second table.
//
//   `critical-command.*` comes from `gate/critical-commands.ts`. The gate
//   classifies the command line THE MODEL IS ABOUT TO RUN. `bash
//   ./scripts/clean.sh` classifies as ordinary — correctly, its head is
//   `bash` — and nothing in this codebase has ever read what is inside that
//   file. A committed `rm --no-preserve-root /` is therefore one
//   approved-looking call away from the host. Ticket 11 gave Lykos the rows;
//   this gives them a second thing to guard, which is the difference between
//   a guard and a decorative one.
//
//   `credential-file.*` is the one rule that is not a content match, and it
//   is here for a reason neither of the others can reach: **the walk is Pi's
//   `find`, which honours `.gitignore`**, so a file this scan is handed is a
//   file that is one `git add -A` from a commit. No regex over contents can
//   establish that. It also catches the DER or encrypted key whose bytes
//   carry no `-----BEGIN` line for the first rule to match.
//
// **`classifyCommandRisk` IS DELIBERATELY NOT RUN OVER FILE CONTENTS (D3).**
// It calls `rm -rf build` destructive, which is correct, and which is in half
// the build scripts ever written. A scan that reports it teaches its reader
// to skip the report, and a report nobody reads is worth less than no report.
// Only the critical rows cross over — the nine that
// `critical-commands.ts` describes as shapes "virtually never legitimate in
// automation".
//
// **A SECRET'S VALUE IS NEVER PRINTED AND NEVER PERSISTED (D4).** A
// `secret.*` finding's excerpt is the line with the matched span replaced by
// its length, in the tool result AND in the record written under `.lykos/`. A
// scan that files the credential it found into a JSON document has made a
// second copy of the leak, in a file `secretsHook` will never be shown. The
// test that pins this scans a real-shaped key and asserts its text appears
// nowhere in the result, nowhere in the details, and nowhere in the bytes on
// disk.
//
// **A FINDING IS IDENTIFIED BY A FINGERPRINT, NOT BY WHERE IT SITS (D5).**
// Rule id, display path and the trimmed matched text — never the line number,
// so an unchanged finding that moved down a file is the same finding. That is
// what makes "which of these did my edit introduce" answerable, which on a
// repository that already has findings is the only question worth asking.
//
// **NOTHING IS PRUNED (D6).** One JSON record per scan under
// `.lykos/security/`, read back by `list` and `show`. CLAUDE.md's "nothing it
// runs is ever deleted" is not only about tasks.
//
// **EVERY FILE NOT READ IS COUNTED AND NAMED (D7).** `ast_grep`'s footer
// rule, for `ast_grep`'s reason: "no findings" is only as wide as the scope
// the scan actually opened, and a scan that will not say what it skipped is a
// scan that can be mistaken for proof.
//
// **NO GATE (D9).** It reads files inside the project and writes one record
// under `.lykos/`. `ast_grep` reaches no gate for a read and `retain` reaches
// none for its write under `.lykos/`; this is both of those and nothing more.
// The registry row is corrected from its placeholder in the same change — it
// said `read` and `idempotent: true` for a tool that writes a record, and a
// second scan writes a second record.
//
// **THE SCHEMA TAX, RECORDED AT THE MOMENT THE TOOL IS ADDED (AGENTS.md rule
// 3): this tool rides NO request.** Mounted with `hidden` prompt presence
// (D10), reached through `tool_call`. The measured numbers are asserted in
// `security-scan.test.ts`, so a description that doubles the bill fails a
// test rather than passing silently.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { CRITICAL_COMMAND_PATTERNS } from "../gate/critical-commands.js";
import { SECRET_PATTERNS } from "../loop/hooks.js";
import {
  AST_MAX_FILES,
  displayPath,
  piWalk,
  resolveScope,
  toLF,
  type AstWalk,
} from "./ast.js";

export const SECURITY_SCAN_TOOL_NAME = "security_scan";

/** D8's three. `scan` is the default because two of the three exist to read what a scan wrote. */
export const SECURITY_OPS = ["scan", "list", "show"] as const;
export type SecurityOp = (typeof SECURITY_OPS)[number];

/** Highest first. There is no `low` and no `informational`: a deterministic rule that is not worth acting on is a rule to delete, not a severity to invent. */
export const SECURITY_SEVERITIES = ["critical", "high", "medium"] as const;
export type SecuritySeverity = (typeof SECURITY_SEVERITIES)[number];

/**
 * How many files one scan opens before it stops and says so.
 *
 * `AST_MAX_FILES` rather than a second number, because the walk IS
 * `ast.ts`'s: `piWalk` passes that limit to Pi's `find`, so inventing a
 * larger cap here would be a promise this module cannot keep.
 */
export const SECURITY_MAX_FILES = AST_MAX_FILES;

/** The most one file may weigh before it is skipped and named. A two-megabyte source file is a generated bundle, and regexing one is minutes of work for a finding nobody wrote. */
export const SECURITY_MAX_FILE_BYTES = 2 * 1024 * 1024;

/** How much of a file is inspected for a NUL byte before it is called text. */
export const SECURITY_BINARY_SNIFF_BYTES = 8192;

/** How wide one finding's excerpt is printed. */
export const SECURITY_EXCERPT_WIDTH = 200;

/** How many findings one call returns before it says it stopped. The record keeps all of them. */
export const SECURITY_DEFAULT_LIMIT = 50;

/** How many skipped paths are listed by name. The COUNT is always exact; only the list is capped. */
export const SECURITY_MAX_LISTED_SKIPS = 20;

/** How many scans `list` prints. */
export const SECURITY_LIST_LIMIT = 20;

// ---------------------------------------------------------------------------
// The rules (D2)
// ---------------------------------------------------------------------------

/**
 * A rule id's second half, derived from the imported table's own `name` or
 * `label`.
 *
 * Derived rather than hand-written so that a row added to `SECRET_PATTERNS`
 * or `CRITICAL_COMMAND_PATTERNS` becomes a rule here with no edit to this
 * file — which is the whole point of importing those tables instead of
 * restating them.
 */
export function ruleSlug(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** One rule that reads a line of text. */
export interface ContentRule {
  id: string;
  /** The words the imported table uses, shown to the model so a rule id is never the only description. */
  title: string;
  severity: SecuritySeverity;
  pattern: RegExp;
  /** True for `secret.*`: the matched span is replaced by its length wherever it would be shown or stored (D4). */
  redact: boolean;
}

/**
 * Credential patterns, from `loop/hooks.ts`. Critical without exception: a
 * live key in a tracked file is the one finding whose cost does not depend on
 * what else is true.
 */
export const SECRET_RULES: readonly ContentRule[] = SECRET_PATTERNS.map((row) => ({
  id: `secret.${ruleSlug(row.name)}`,
  title: row.name,
  severity: "critical" as const,
  pattern: row.pattern,
  redact: true,
}));

/**
 * The nine catastrophic shell shapes, from `gate/critical-commands.ts`.
 *
 * NOT redacted: the point of one of these findings is that a human reads the
 * line and sees the fork bomb. The rows were chosen upstream precisely for
 * being shapes that are never legitimate, so there is no secret in them to
 * hide — and ticket 11 already records the one false positive this table has.
 */
export const COMMAND_RULES: readonly ContentRule[] = CRITICAL_COMMAND_PATTERNS.map((row) => ({
  id: `critical-command.${ruleSlug(row.label)}`,
  title: row.label,
  severity: "critical" as const,
  pattern: row.pattern,
  redact: false,
}));

export const CONTENT_RULES: readonly ContentRule[] = [...SECRET_RULES, ...COMMAND_RULES];

/** One rule that reads a file's name rather than its contents (D2's third class). */
export interface FileRule {
  id: string;
  title: string;
  severity: SecuritySeverity;
  /** Matched against the base name, lower-cased. */
  matches: (basename: string) => boolean;
  /** Why this file being visible to the walk is the finding. */
  note: string;
}

/** Key files with no extension, as ssh-keygen writes them. */
const BARE_KEY_NAMES = new Set(["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "identity"]);

/** Extensions that are a private key or a key store however the file is named. */
const KEY_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"];

/**
 * Environment files that are NOT a finding: the committed template is the
 * thing a project is supposed to have, and reporting it is the noise that
 * makes a report ignorable.
 */
const ENV_TEMPLATE_SUFFIXES = [".example", ".sample", ".template", ".dist"];

export const FILE_RULES: readonly FileRule[] = [
  {
    id: "credential-file.private-key",
    title: "private key or key store, not ignored by git",
    severity: "high",
    matches: (base) =>
      BARE_KEY_NAMES.has(base) || KEY_EXTENSIONS.some((ext) => base.endsWith(ext)),
    note: "The walk honours .gitignore, so this file is one `git add -A` from a commit.",
  },
  {
    id: "credential-file.environment-file",
    title: "environment file, not ignored by git",
    severity: "medium",
    matches: (base) =>
      (base === ".env" || base.startsWith(".env.")) &&
      !ENV_TEMPLATE_SUFFIXES.some((suffix) => base.endsWith(suffix)),
    note: "The walk honours .gitignore, so this file is one `git add -A` from a commit. A template (.env.example) is not reported.",
  },
];

// ---------------------------------------------------------------------------
// Findings (D4, D5)
// ---------------------------------------------------------------------------

export interface SecurityFinding {
  rule: string;
  title: string;
  severity: SecuritySeverity;
  /** Relative to the session's cwd with forward slashes, which is what an `edit` takes. */
  path: string;
  /** 1-indexed. Absent for a file-identity finding, where the file IS the finding and line 1 would be a claim about its contents. */
  line?: number;
  /** Redacted for `secret.*` (D4). Whitespace-flattened and capped. */
  excerpt: string;
  fingerprint: string;
  /** How many times this exact fingerprint matched in this file. */
  occurrences: number;
}

/** D4: what replaces a matched credential wherever it would otherwise be shown or written. */
export function redactSpan(length: number): string {
  return `<redacted:${length} chars>`;
}

export function flattenExcerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SECURITY_EXCERPT_WIDTH ? `${flat.slice(0, SECURITY_EXCERPT_WIDTH - 1)}…` : flat;
}

/**
 * D5: rule id, path and the matched text — and deliberately not the line
 * number, so a finding that moved down a file is still the same finding.
 */
export function fingerprintOf(rule: string, path: string, matched: string): string {
  return createHash("sha256")
    .update(`${rule} ${path} ${matched.trim()}`)
    .digest("hex")
    .slice(0, 24);
}

/**
 * Every content rule over one file's text.
 *
 * Exported and filesystem-free so the rule set is tested without a scan, and
 * so a caller can see exactly what "what does this detect" means.
 *
 * Findings are collapsed by fingerprint rather than emitted per line: the
 * same key on ten lines of one file is one credential to rotate, not ten, and
 * the count says how many places it sits in.
 */
export function scanText(path: string, text: string): SecurityFinding[] {
  const lines = toLF(text).split("\n");
  const byFingerprint = new Map<string, SecurityFinding>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.length === 0) continue;
    for (const rule of CONTENT_RULES) {
      const match = rule.pattern.exec(line);
      if (match === null) continue;
      const matched = match[0];
      const fingerprint = fingerprintOf(rule.id, path, matched);
      const existing = byFingerprint.get(fingerprint);
      if (existing !== undefined) {
        existing.occurrences += 1;
        continue;
      }
      const shown = rule.redact
        ? `${line.slice(0, match.index)}${redactSpan(matched.length)}${line.slice(match.index + matched.length)}`
        : line;
      byFingerprint.set(fingerprint, {
        rule: rule.id,
        title: rule.title,
        severity: rule.severity,
        path,
        line: index + 1,
        excerpt: flattenExcerpt(shown),
        fingerprint,
        occurrences: 1,
      });
    }
  }
  return [...byFingerprint.values()];
}

/** The file-name rules over one path. No `line`: the file is the finding. */
export function scanFileName(path: string, basename: string): SecurityFinding[] {
  const lower = basename.toLowerCase();
  const out: SecurityFinding[] = [];
  for (const rule of FILE_RULES) {
    if (!rule.matches(lower)) continue;
    out.push({
      rule: rule.id,
      title: rule.title,
      severity: rule.severity,
      path,
      excerpt: rule.note,
      fingerprint: fingerprintOf(rule.id, path, basename),
      occurrences: 1,
    });
  }
  return out;
}

const SEVERITY_ORDER: Record<SecuritySeverity, number> = { critical: 0, high: 1, medium: 2 };

export function isSecuritySeverity(value: string): value is SecuritySeverity {
  return (SECURITY_SEVERITIES as readonly string[]).includes(value);
}

/** Highest severity first, then by path, then by line, so two runs of one scan print the same order. */
export function sortFindings(findings: SecurityFinding[]): SecurityFinding[] {
  return findings.sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return (a.line ?? 0) - (b.line ?? 0);
  });
}

// ---------------------------------------------------------------------------
// The record (D6)
// ---------------------------------------------------------------------------

/** Why a file in scope was not read. Counted separately because the four mean different things to someone deciding whether to trust the result. */
export interface SecuritySkips {
  binary: string[];
  oversized: string[];
  unreadable: string[];
}

export interface SecurityScanRecord {
  id: string;
  createdAt: string;
  /** The scope as the model gave it, which is the key `scan` compares against (D5). */
  scope: string;
  filesScanned: number;
  skipped: SecuritySkips;
  /** True when `SECURITY_MAX_FILES` stopped the walk, so "no findings" does not mean "scanned everything". */
  capped: boolean;
  findings: SecurityFinding[];
}

export function securityDirectory(cwd: string): string {
  return join(cwd, ".lykos", "security");
}

/**
 * A scan id is also a file name, so its shape is checked before it is ever
 * joined onto a path — `show` takes one from the model, and a name that can
 * contain a separator is a directory traversal waiting to be written down.
 */
const SCAN_ID_PATTERN = /^scan-[0-9A-Za-z]+-[0-9a-f]+$/;

export function isScanId(value: string): boolean {
  return SCAN_ID_PATTERN.test(value);
}

export function scanIdFor(now: Date, suffix: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `scan-${stamp}-${suffix}`;
}

/** Everything the scan does to the outside world, in one injected object so a test never touches the developer's tree (D11). */
export interface SecurityStore {
  write: (cwd: string, record: SecurityScanRecord) => void;
  /** Every record, newest first. A record that will not parse is skipped rather than guessed at. */
  list: (cwd: string) => SecurityScanRecord[];
  read: (cwd: string, id: string) => SecurityScanRecord | undefined;
}

function parseRecord(raw: string): SecurityScanRecord | undefined {
  try {
    const value = JSON.parse(raw) as Partial<SecurityScanRecord>;
    if (typeof value.id !== "string" || !Array.isArray(value.findings)) return undefined;
    return value as SecurityScanRecord;
  } catch {
    return undefined;
  }
}

export const LOCAL_SECURITY_STORE: SecurityStore = {
  write(cwd, record) {
    const dir = securityDirectory(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  },
  list(cwd) {
    const dir = securityDirectory(cwd);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return [];
    }
    const out: SecurityScanRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      let raw: string;
      try {
        raw = readFileSync(join(dir, name), "utf8");
      } catch {
        continue;
      }
      const record = parseRecord(raw);
      if (record !== undefined) out.push(record);
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  },
  read(cwd, id) {
    if (!isScanId(id)) return undefined;
    try {
      return parseRecord(readFileSync(join(securityDirectory(cwd), `${id}.json`), "utf8"));
    } catch {
      return undefined;
    }
  },
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function countBySeverity(findings: readonly SecurityFinding[]): string {
  const parts: string[] = [];
  for (const severity of SECURITY_SEVERITIES) {
    const n = findings.filter((f) => f.severity === severity).length;
    if (n > 0) parts.push(`${n} ${severity}`);
  }
  return parts.join(", ");
}

/** D7: the count is always exact, the list is capped, and a scan with nothing skipped says nothing. */
export function renderSkips(skipped: SecuritySkips): string[] {
  const rows: Array<[string, string[]]> = [
    ["binary", skipped.binary],
    [`over the ${SECURITY_MAX_FILE_BYTES}-byte file cap`, skipped.oversized],
    ["unreadable", skipped.unreadable],
  ];
  const out: string[] = [];
  for (const [reason, paths] of rows) {
    if (paths.length === 0) continue;
    const shown = paths.slice(0, SECURITY_MAX_LISTED_SKIPS);
    const rest = paths.length - shown.length;
    out.push(
      `Not scanned, ${reason}: ${paths.length} file${paths.length === 1 ? "" : "s"} — ` +
        `${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`,
    );
  }
  return out;
}

export interface ScanRender {
  record: SecurityScanRecord;
  /** The findings after `min_severity` and `limit`, in the order they are printed. */
  shown: readonly SecurityFinding[];
  /** How many findings passed `min_severity` before `limit` cut the list. */
  matched: number;
  limit: number;
  /**
   * `scan` has just produced this record and can say what is new in it;
   * `show` is reading one back and deliberately says neither, because
   * "nothing new since" is a claim about a comparison this call did not make.
   */
  mode: "scan" | "show";
  /** The previous scan of this scope, when there was one (D5). */
  previousId?: string;
  newFingerprints: ReadonlySet<string>;
}

export function renderScan(r: ScanRender): string {
  const body: string[] = [];
  for (const finding of r.shown) {
    const where = finding.line === undefined ? finding.path : `${finding.path}:${finding.line}`;
    const state =
      r.previousId === undefined ? "" : r.newFingerprints.has(finding.fingerprint) ? "  (new)" : "  (carried over)";
    const repeats = finding.occurrences > 1 ? `  (${finding.occurrences} places in this file)` : "";
    body.push(`[${finding.severity}] ${finding.rule}  ${where}${state}${repeats}`);
    body.push(`    ${finding.title}`);
    body.push(`    ${finding.excerpt}`);
  }

  const footer: string[] = [];
  const scanned = `${r.record.filesScanned} file${r.record.filesScanned === 1 ? "" : "s"} scanned`;
  if (r.matched === 0) {
    footer.push(
      `No findings, over ${scanned}. This is not proof the code is safe: it is the result of ` +
        `${CONTENT_RULES.length + FILE_RULES.length} fixed rules over the files named below, and nothing else was looked at.`,
    );
  } else {
    footer.push(`${r.matched} finding${r.matched === 1 ? "" : "s"} (${countBySeverity(r.shown)}) over ${scanned}.`);
  }
  if (r.shown.length < r.matched) {
    footer.push(`Stopped at the ${r.limit}-finding limit; raise limit or narrow the path. The record has all of them.`);
  }
  if (r.mode === "scan") {
    if (r.previousId !== undefined) {
      const fresh = r.shown.filter((f) => r.newFingerprints.has(f.fingerprint)).length;
      footer.push(
        fresh === 0
          ? `Nothing new since ${r.previousId}: every finding here was already in the previous scan of this scope.`
          : `${fresh} of these ${fresh === 1 ? "is" : "are"} new since ${r.previousId}.`,
      );
    } else {
      footer.push(
        "No earlier scan of this scope, so nothing is marked new. Run it again after a change to see what moved.",
      );
    }
  }
  if (r.record.capped) {
    footer.push(`Stopped at the ${SECURITY_MAX_FILES}-file cap; this scope was not scanned to the end. Narrow the path.`);
  }
  footer.push(...renderSkips(r.record.skipped));
  footer.push(
    r.mode === "scan"
      ? `Recorded as ${r.record.id}. Read it back with op=show, scan=${r.record.id}.`
      : `${r.record.id}, scanned ${r.record.createdAt} over scope ${r.record.scope}.`,
  );

  return [...body, ...(body.length > 0 ? [""] : []), ...footer].join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// The tool (D8)
// ---------------------------------------------------------------------------

export const SECURITY_SCAN_DESCRIPTION =
  "Scan files for credentials and catastrophic shell commands, deterministically. It is a fixed rule set over the " +
  "text — a credential shape (AWS, OpenAI, Anthropic, GitHub, a private key block), one of the shell shapes that is " +
  "never legitimate (`rm --no-preserve-root`, a fork bomb, a write to a raw disk device, fetch-then-execute, " +
  "`nc -e`), or a private key or `.env` file that git is not ignoring. No model reads your code and nothing is sent " +
  "anywhere. Use it before a commit that touches configuration or scripts, and after pulling someone else's branch. " +
  "`op=scan` walks `path` (a file, a directory or a glob; default the whole project) and records the result; " +
  "`op=list` shows earlier scans; `op=show` reopens one by id. A repeat scan of the same scope marks which findings " +
  "are new since the last one, which is the useful question after an edit. A matched credential is never printed " +
  "back and never written to the record. This finding a problem is evidence; it finding nothing is not evidence of " +
  "safety — read the footer, which says what it skipped.";

export const SECURITY_SCAN_PARAMETERS = Type.Object({
  op: Type.Optional(Type.String({ description: "scan (default), list or show." })),
  path: Type.Optional(
    Type.String({ description: "scan: a file, a directory or a glob (default: the whole project). Respects .gitignore." }),
  ),
  min_severity: Type.Optional(
    Type.String({ description: "Lowest severity to return: critical, high or medium (default medium, which is everything)." }),
  ),
  scan: Type.Optional(Type.String({ description: "show: the scan id, as list and a finished scan report it." })),
  limit: Type.Optional(Type.Number({ description: `Maximum findings to return (default ${SECURITY_DEFAULT_LIMIT}).` })),
});

export interface SecurityScanOpts {
  cwd: string;
  /** T184: where the project's `.lykos/security` is, when `cwd` is a worktree. Absent, `cwd`. */
  stateRoot?: string;
  /** The walk. Injectable so a test need not shell out to `fd`; the default is Pi's `find`, which honours .gitignore. */
  walk?: AstWalk;
  /** The real store. A test passes its own, or points `cwd` at a temporary directory (D11). */
  store?: SecurityStore;
  /** Injectable clock, so a test can assert an id. */
  now?: () => Date;
  /** Injectable id suffix, for the same reason. */
  suffix?: () => string;
}

function text(s: string) {
  return [{ type: "text" as const, text: s }];
}

/**
 * One result shape for every branch, `memory-tools.ts`'s reason: the four
 * branches return four different `details` objects and TypeScript, under
 * `exactOptionalPropertyTypes`, will not unify them on its own. Naming the
 * shape once is cheaper than four casts, and it keeps `isError` from being
 * forgotten on the one branch that needs it.
 */
interface SecurityToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: Record<string, unknown>;
}

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * One file, read and matched — or one of three reasons it was not.
 *
 * Reported rather than thrown, which is `github.ts`'s rule: a scan that dies
 * on the first unreadable file has told the model nothing about the other
 * nine hundred, and an unreadable file is a fact about the scope rather than
 * an error in the call.
 */
async function scanOneFile(
  cwd: string,
  absolute: string,
): Promise<{ findings: SecurityFinding[]; skip?: keyof SecuritySkips }> {
  const shown = displayPath(cwd, absolute);
  const nameFindings = scanFileName(shown, basenameOf(absolute));
  let buffer: Buffer;
  try {
    buffer = await readFile(absolute);
  } catch {
    return { findings: nameFindings, skip: "unreadable" };
  }
  if (buffer.byteLength > SECURITY_MAX_FILE_BYTES) {
    return { findings: nameFindings, skip: "oversized" };
  }
  const sniff = buffer.subarray(0, SECURITY_BINARY_SNIFF_BYTES);
  if (sniff.includes(0)) {
    return { findings: nameFindings, skip: "binary" };
  }
  return { findings: [...nameFindings, ...scanText(shown, buffer.toString("utf8"))] };
}

export function buildSecurityScanTool(opts: SecurityScanOpts): ToolDefinition {
  const walk = opts.walk ?? piWalk(opts.cwd);
  const store = opts.store ?? LOCAL_SECURITY_STORE;
  const now = opts.now ?? (() => new Date());
  const suffix = opts.suffix ?? (() => createHash("sha256").update(String(Math.random())).digest("hex").slice(0, 6));

  return defineTool({
    name: SECURITY_SCAN_TOOL_NAME,
    label: "Security scan",
    description: SECURITY_SCAN_DESCRIPTION,
    promptSnippet: "Scan files for credentials and catastrophic commands",
    promptGuidelines: [
      "A clean scan is not proof the code is safe — it is a fixed rule set over the files it names in its footer.",
      "Never echo a credential this reports. The finding gives you the file and the line; that is what to act on.",
    ],
    parameters: SECURITY_SCAN_PARAMETERS,
    async execute(_toolCallId, params): Promise<SecurityToolResult> {
      const op = (params.op ?? "scan").trim();
      if (!(SECURITY_OPS as readonly string[]).includes(op)) {
        throw new Error(
          `lykos security_scan: unknown op "${params.op}". There are three: ${SECURITY_OPS.join(", ")}.`,
        );
      }
      const minSeverity = params.min_severity?.trim() ?? "medium";
      if (!isSecuritySeverity(minSeverity)) {
        throw new Error(
          `lykos security_scan: unknown min_severity "${params.min_severity}". There are three: ${SECURITY_SEVERITIES.join(", ")}.`,
        );
      }
      const limit =
        params.limit !== undefined && params.limit > 0 ? Math.floor(params.limit) : SECURITY_DEFAULT_LIMIT;
      const keep = (f: SecurityFinding): boolean => SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER[minSeverity];

      if (op === "list") {
        const records = store.list(opts.stateRoot ?? opts.cwd).slice(0, SECURITY_LIST_LIMIT);
        if (records.length === 0) {
          return {
            content: text(
              "No scans recorded for this project. Run op=scan; the result is written under .lykos/security/ and " +
                "every later session can read it back.",
            ),
            details: { op, scans: 0 },
          };
        }
        const lines = records.map((r) => {
          const counts = r.findings.length === 0 ? "no findings" : countBySeverity(r.findings);
          return `${r.id}  ${r.createdAt}  scope=${r.scope}  ${r.findings.length} finding(s) (${counts}), ${r.filesScanned} file(s) scanned`;
        });
        return {
          content: text([...lines, "", "Reopen one with op=show, scan=<id>. Nothing here is ever pruned."].join("\n")),
          details: { op, scans: records.length, ids: records.map((r) => r.id) },
        };
      }

      if (op === "show") {
        const id = params.scan?.trim() ?? "";
        if (id === "") {
          throw new Error("lykos security_scan: show needs `scan`, a scan id. Call op=list to see them.");
        }
        const record = store.read(opts.stateRoot ?? opts.cwd, id);
        if (record === undefined) {
          return {
            content: text(
              `No recorded scan "${id}". Call op=list to see what this project has; ids look like ` +
                "scan-20260921T140000Z-a1b2c3.",
            ),
            isError: true,
            details: { op, status: "not_found", scan: id },
          };
        }
        const matched = sortFindings(record.findings.filter(keep));
        const shown = matched.slice(0, limit);
        return {
          content: text(
            renderScan({ record, shown, matched: matched.length, limit, mode: "show", newFingerprints: new Set() }),
          ),
          details: {
            op,
            scan: record.id,
            createdAt: record.createdAt,
            scope: record.scope,
            findings: record.findings.length,
            returned: shown.length,
          },
        };
      }

      // op === "scan"
      const given = params.path?.trim() ?? "";
      const scope = given === "" ? "." : given;
      const resolved = await resolveScope(opts.cwd, scope);
      const walked = await walk(resolved.base, resolved.glob);
      const unique = [...new Set(walked)].sort();
      const capped = unique.length > SECURITY_MAX_FILES;
      const files = capped ? unique.slice(0, SECURITY_MAX_FILES) : unique;

      const findings: SecurityFinding[] = [];
      const skipped: SecuritySkips = { binary: [], oversized: [], unreadable: [] };
      let filesScanned = 0;
      for (const absolute of files) {
        const result = await scanOneFile(opts.cwd, absolute);
        findings.push(...result.findings);
        if (result.skip === undefined) filesScanned += 1;
        else skipped[result.skip].push(displayPath(opts.cwd, absolute));
      }

      const previous = store.list(opts.stateRoot ?? opts.cwd).find((r) => r.scope === scope);
      const previousFingerprints = new Set(previous?.findings.map((f) => f.fingerprint) ?? []);
      const newFingerprints = new Set(
        findings.map((f) => f.fingerprint).filter((fp) => !previousFingerprints.has(fp)),
      );

      // One clock reading for both, so the id and the timestamp can never
      // disagree about when the scan happened.
      const at = now();
      const record: SecurityScanRecord = {
        id: scanIdFor(at, suffix()),
        createdAt: at.toISOString(),
        scope,
        filesScanned,
        skipped,
        capped,
        findings: sortFindings(findings),
      };
      // Written BEFORE the result is rendered, so the id the model is handed
      // is an id something can already read back. `hub` writes its log file
      // synchronously before returning a path for the same reason.
      store.write(opts.stateRoot ?? opts.cwd, record);

      const matched = record.findings.filter(keep);
      const shown = matched.slice(0, limit);
      return {
        content: text(
          renderScan({
            record,
            shown,
            matched: matched.length,
            limit,
            mode: "scan",
            ...(previous !== undefined ? { previousId: previous.id } : {}),
            newFingerprints,
          }),
        ),
        details: {
          op,
          scan: record.id,
          scope,
          filesScanned,
          filesSkipped: skipped.binary.length + skipped.oversized.length + skipped.unreadable.length,
          capped,
          findings: record.findings.length,
          returned: shown.length,
          newFindings: newFingerprints.size,
          comparedWith: previous?.id ?? null,
        },
      };
    },
  }) as ToolDefinition;
}
