// The context pack (T248, spec decision 9; Boxie lessons F3 and W8): what a delegated session is told before its
// first turn, derived from the task's `files`: the project's rules and traps, the glossary terms the task uses, the
// docs that govern the files, their recent history, their related tests and the verification command.
//
// Two rules make it trustworthy:
//   - F3: everything quoted is read from the base commit, never the working tree. A glossary a coordinator is editing
//     in the tree the session was started from is not what the session's branch starts from.
//   - W8: every path in the pack is absolute, rooted where the session's files are (its worktree), so a tool call
//     that uses a path as written never fails on a relative one.
//
// Nothing here runs a command but `git show`, `git grep`, `git log` and `git ls-tree`. The pack is recorded in the
// project ledger (`context_packs`) when the session starts and shown by `lykos status`.

import { isAbsolute, posix, relative, resolve } from "node:path";
import { hostGit } from "../git/host-git.js";
import type { Ledger } from "../ledger/use.js";
import { isTestFileName } from "./result-flags.js";

export type PackEntryKind = "rules" | "traps" | "glossary" | "doc" | "history" | "file" | "test" | "verification";

export interface PackEntry {
  kind: PackEntryKind;
  /** Absolute path of the file the entry is about, when it is about one. */
  path?: string;
  /** What the pack says: a quotation from the base commit, or a listing line. */
  text: string;
}

export interface ContextPack {
  /** The base commit everything was read from. */
  base: string;
  /** Where the session's files are: the root every path is under. */
  root: string;
  entries: PackEntry[];
  /** The pack as the session reads it. */
  text: string;
}

export interface ContextPackInput {
  /** Absolute: the session's tree (its worktree), the root of every path in the pack. */
  root: string;
  /** Any tree of the project: where git reads the base commit from. */
  repo: string;
  /** The base commit, or a ref that names it. */
  base: string;
  /** The task's `files`, relative to the project or absolute. */
  files: readonly string[];
  /** The task's brief, for matching glossary terms. */
  task?: string;
  /** The verification command the session may run. */
  test?: string;
}

export interface ContextPackSummary {
  base: string;
  root: string;
  bytes: number;
  recorded_at: string;
  /** One line per entry: its kind and, when it has one, its absolute path. */
  entries: Array<{ kind: PackEntryKind; path?: string }>;
}

/** The files a project keeps its rules in, in the order they are quoted. */
const RULE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

const QUOTE_CAP = 3000;
const PACK_CAP = 24000;
const LIST_CAP = 8;
const FILE_CAP = 200_000;

function atBase(input: { repo: string; base: string }, rel: string): string | undefined {
  const run = hostGit(["show", `${input.base}:${rel}`], input.repo, { raw: true, maxBuffer: FILE_CAP * 8 });
  return run.ok ? run.stdout : undefined;
}

function clip(text: string, cap = QUOTE_CAP): string {
  const t = text.trim();
  return t.length <= cap ? t : `${t.slice(0, cap).trimEnd()}\n[... cut at ${cap} characters]`;
}

/** `## Heading` sections of a markdown document, by heading text. */
function sectionsOf(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = markdown.replace(/\r\n/g, "\n").split(/^## /m);
  for (const part of parts.slice(1)) {
    const nl = part.indexOf("\n");
    out.set(part.slice(0, nl < 0 ? part.length : nl).trim(), nl < 0 ? "" : part.slice(nl + 1));
  }
  return out;
}

interface GlossaryEntry {
  term: string;
  text: string;
}

/** The entries of a glossary: `**Term**:` starts one, the next such line or heading ends it. */
function glossaryEntries(markdown: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  let current: { term: string; lines: string[] } | undefined;
  const flush = (): void => {
    if (current !== undefined) entries.push({ term: current.term, text: current.lines.join("\n").trim() });
    current = undefined;
  };
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const head = /^\*\*(.+?)\*\*:\s*(.*)$/.exec(line);
    if (head) {
      flush();
      current = { term: head[1]!, lines: [line] };
    } else if (/^#{1,6} /.test(line)) {
      flush();
    } else if (current !== undefined) {
      current.lines.push(line);
    }
  }
  flush();
  return entries;
}

function countWord(haystack: string, term: string): number {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (haystack.match(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "gi")) ?? []).length;
}

/** A task file as a path relative to the project, forward slashes, or undefined when it is outside it. */
function relativeTo(repoRoot: string, file: string): string | undefined {
  const rel = isAbsolute(file) ? relative(repoRoot, file) : file;
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return norm === "" || norm.startsWith("../") || isAbsolute(norm) ? undefined : norm;
}

/**
 * Builds the pack. `base` is read as a commit, so a file that is new, edited or gone in the working tree is what the
 * base says it is. A file the base does not have is listed as new, never quoted from the tree.
 */
export function buildContextPack(input: ContextPackInput): ContextPack {
  const root = resolve(input.root);
  const abs = (rel: string): string => resolve(root, rel);
  const resolved = hostGit(["rev-parse", "--verify", `${input.base}^{commit}`], input.repo);
  const base = resolved.ok ? resolved.stdout : input.base;
  const at = (rel: string): string | undefined => atBase({ repo: input.repo, base }, rel);
  const entries: PackEntry[] = [];

  // Rules and traps: the project's rule files at the base. The sections this project of Lykos titles "The rules",
  // "Code quality" and "Traps" are quoted alone; a file with none of them is another project's convention and is taken
  // whole, within the same cap. A project with no rule file is told so rather than left to look unruled.
  let ruleFiles = 0;
  for (const file of RULE_FILES) {
    const text = at(file);
    if (text === undefined || text.trim() === "") continue;
    ruleFiles += 1;
    const sections = sectionsOf(text);
    let quoted = 0;
    for (const [kind, heading] of [["rules", "The rules"], ["rules", "Code quality"], ["traps", "Traps"]] as const) {
      const body = sections.get(heading);
      if (body !== undefined && body.trim() !== "") {
        entries.push({ kind, path: abs(file), text: `## ${heading}\n${clip(body)}` });
        quoted += 1;
      }
    }
    if (quoted === 0) entries.push({ kind: "rules", path: abs(file), text: clip(text) });
  }
  if (ruleFiles === 0) entries.push({ kind: "rules", text: `No ${RULE_FILES.join(" or ")} at the base commit: the project states no rules in a file Lykos reads.` });

  // The task's files, as the base has them.
  const rels: string[] = [];
  for (const file of input.files) {
    const rel = relativeTo(input.repo, file) ?? relativeTo(root, file);
    if (rel === undefined) {
      entries.push({ kind: "file", path: abs(file), text: "outside the project" });
      continue;
    }
    if (!rels.includes(rel)) rels.push(rel);
  }
  const contents = new Map<string, string>();
  for (const rel of rels) {
    const text = at(rel);
    if (text === undefined) {
      entries.push({ kind: "file", path: abs(rel), text: "new: the base commit does not have it" });
    } else {
      contents.set(rel, text);
      // A final newline ends the last line; it does not start another.
      const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      entries.push({ kind: "file", path: abs(rel), text: `${lines} line${lines === 1 ? "" : "s"} at the base` });
    }
  }

  // Glossary terms the task and its files use, quoted from GLOSSARY.md at the base.
  const glossary = at("GLOSSARY.md");
  if (glossary !== undefined) {
    const haystack = [input.task ?? "", ...rels, ...[...contents.values()].map((c) => c.slice(0, FILE_CAP))].join("\n");
    const matched = glossaryEntries(glossary)
      .map((e) => ({ e, n: countWord(haystack, e.term) }))
      .filter((m) => m.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, 12);
    for (const { e } of matched) entries.push({ kind: "glossary", path: abs("GLOSSARY.md"), text: clip(e.text, 1200) });
  }

  // Docs that name a task file, and each file's recent history.
  for (const rel of rels) {
    const grep = hostGit(["grep", "-l", "-F", "-e", rel, base, "--", "docs"], input.repo);
    const prefix = `${base}:`;
    const docs = (grep.ok ? grep.stdout.split("\n") : [])
      .map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l).trim())
      .filter((l) => l !== "")
      .sort()
      .slice(0, LIST_CAP);
    for (const doc of docs) entries.push({ kind: "doc", path: abs(doc), text: `names ${abs(rel)}` });
    const log = hostGit(["log", "-n", "3", "--format=%h %s", base, "--", rel], input.repo);
    if (log.ok && log.stdout !== "") entries.push({ kind: "history", path: abs(rel), text: log.stdout });
  }

  // Related tests: test files in a task file's directory that carry its name, and the task's own test files.
  const tree = hostGit(["ls-tree", "-r", "--name-only", base], input.repo, { maxBuffer: 64 * 1024 * 1024 });
  const tracked = tree.ok ? tree.stdout.split("\n").filter((l) => l !== "") : [];
  const tests = new Set<string>();
  for (const rel of rels) {
    if (isTestFileName(rel)) {
      tests.add(rel);
      continue;
    }
    const dir = posix.dirname(rel);
    const stem = posix.basename(rel).replace(/\.[^.]+$/, "");
    for (const candidate of tracked) {
      if (posix.dirname(candidate) === dir && isTestFileName(candidate) && posix.basename(candidate).startsWith(stem)) tests.add(candidate);
    }
  }
  for (const rel of [...tests].sort().slice(0, LIST_CAP)) entries.push({ kind: "test", path: abs(rel), text: tracked.includes(rel) ? "at the base" : "new" });

  if (input.test !== undefined) entries.push({ kind: "verification", text: input.test });

  return { base, root, entries, text: renderPack(base, root, entries) };
}

function renderPack(base: string, root: string, entries: readonly PackEntry[]): string {
  const lines: string[] = [
    "# Context pack",
    `Read from the base commit ${base.slice(0, 12)}, not from any working tree. Every path below is absolute: use it as written. Your files are under ${root}.`,
  ];
  const section = (title: string, kinds: readonly PackEntryKind[], line: (e: PackEntry) => string): void => {
    const own = entries.filter((e) => kinds.includes(e.kind));
    if (own.length === 0) return;
    lines.push("", `## ${title}`, ...own.map(line));
  };
  section("Project rules", ["rules"], (e) => (e.path !== undefined ? `Source ${e.path}\n${e.text}` : e.text));
  section("Traps", ["traps"], (e) => `Source ${e.path}\n${e.text}`);
  section("Task files", ["file"], (e) => `- ${e.path}: ${e.text}`);
  section("Glossary", ["glossary"], (e) => e.text);
  section("Governing docs", ["doc"], (e) => `- ${e.path} (${e.text})`);
  section("Recent history", ["history"], (e) => `${e.path}\n${e.text}`);
  section("Related tests", ["test"], (e) => `- ${e.path} (${e.text})`);
  section("Verification command", ["verification"], (e) => e.text);
  const text = lines.join("\n");
  return text.length <= PACK_CAP ? text : `${text.slice(0, PACK_CAP).trimEnd()}\n[... pack cut at ${PACK_CAP} characters]`;
}

/** Records the pack against its session. A session has one pack; recording again replaces it. */
export function recordContextPack(ledger: Ledger, sessionId: string, pack: ContextPack): void {
  ledger.db
    .prepare(`INSERT OR REPLACE INTO context_packs (session_id, base_commit, root, recorded_at, bytes, entries_json, text) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(sessionId, pack.base, pack.root, new Date().toISOString(), Buffer.byteLength(pack.text), JSON.stringify(pack.entries), pack.text);
}

/** What the ledger holds of a session's pack, or undefined when it had none. */
export function contextPackSummary(ledger: Ledger, sessionId: string): ContextPackSummary | undefined {
  const row = ledger.db
    .prepare(`SELECT base_commit, root, recorded_at, bytes, entries_json FROM context_packs WHERE session_id = ?`)
    .get(sessionId) as { base_commit: string; root: string; recorded_at: string; bytes: number; entries_json: string } | undefined;
  if (row === undefined) return undefined;
  const entries = (JSON.parse(row.entries_json) as PackEntry[]).map((e) => ({ kind: e.kind, ...(e.path !== undefined ? { path: e.path } : {}) }));
  return { base: row.base_commit, root: row.root, bytes: row.bytes, recorded_at: row.recorded_at, entries };
}
