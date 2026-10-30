// The seam `ast_grep` and `ast_edit` share: which language a file is, which
// files are in scope, what a pattern matched, and what the replacement text
// becomes.
//
// **Why a seam and not two tools that each do it.** The two tools disagree
// about almost everything — one reads and one writes, one takes a pattern and
// one takes rules, one reaches the gate and one never does — but they must
// agree exactly about four things, and each of the four has a failure mode
// that is silent when the two answers drift. A file `ast_grep` searched and
// `ast_edit` skipped is a rewrite that misses a call site the search promised
// was there; a capture substituted one way in a preview and another way on
// disk is a diff that lied. So the four live here, once, with the tests that
// pin them.
//
// **The separator trap (D2), which is the whole reason this module exists.**
// `getMultipleMatches("ARGS")` on `console.log(1, 2)` returns three nodes —
// `1`, `,` and `2` — and joining their `.text()` values yields `1,2`. The
// space is gone, because the whitespace between siblings belongs to neither
// of them. Verified on this machine before it was written down. So a multi-
// node capture is read as a SLICE of the source, from the first captured
// node's start to the last one's end, and the original separators survive
// whatever they were: a space, a newline, a comment. Nothing in this module
// ever reconstructs source text by joining node text.
//
// **`node.replace(text)` does not substitute metavariables** — it is a raw
// replacement, and the `Edit` it returns carries the text verbatim. The
// substitution is `substitute()` below, and it is ours.
//
// **Offsets are UTF-16 code units, not bytes**, despite what
// `node_modules/@ast-grep/napi/types/sgnode.d.ts` says about `Pos.index`
// ("byte offset of the position"). Checked against a source containing `é`
// and `→`: `source.slice(start.index, end.index)` returns the matched text
// and a `Buffer.subarray` of the same numbers does not. This matters because
// every capture and every rewrite in this module is a `String.prototype.slice`
// on those numbers, and on a file with one non-ASCII character above the
// match a byte-offset reading would splice mid-word. The doc comment is
// wrong; the tests pin the behaviour.
//
// **Why the walk is Pi's `find` (D5).** `grep` and `glob` are Pi's
// implementations (ticket 13), and `find` is the one that already knows how
// to expand a glob, honour `.gitignore` and stop at a limit. A third
// directory walker here would be the seventh mechanism this project rebuilt
// that Pi already ships (AGENTS.md rule 2), and the one that disagreed about
// what `**` means would be the one nobody reads. It is injectable only so a
// unit test need not shell out to `fd`; the default is the real thing and
// `ast.test.ts` exercises it.
//
// **What is NOT inferred.** A file whose extension maps to no language is
// skipped and named (D4). There is no content sniffing: a search that
// silently drops files is a search whose "no matches" cannot be trusted, and
// guessing a language from the bytes turns a skip that can be reported into a
// parse failure that cannot.

import { readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { createFindToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * D5's named cap. The walk asks Pi's `find` for at most this many entries and
 * the scan keeps at most this many source files, so a pattern pointed at a
 * monorepo root stops rather than parsing every file on the disk. Hitting it
 * is reported, never silent — a truncated scan that reads like a complete one
 * is the same "proof of absence" failure D4 exists to prevent.
 *
 * 1000 is Pi's own `find` default, so the walker's limit and this one are one
 * number rather than two that can disagree.
 */
export const AST_MAX_FILES = 1000;

/**
 * How many skipped paths a result names before it summarises the rest. A
 * directory scan of a real repository skips every `.md`, `.json` and `.sql`
 * in it, and naming four hundred of them would bury the matches the model
 * asked for. The heading always carries the full COUNT, so the information
 * that matters — "this search did not look at everything" — is never the part
 * that gets truncated.
 */
export const AST_MAX_LISTED_SKIPS = 20;

/**
 * D4: extension -> language, and nothing else decides.
 *
 * The five values are every language `@ast-grep/napi` 0.45.3 ships
 * (`node_modules/@ast-grep/napi/types/lang.d.ts`); the package supports more
 * through `registerDynamicLanguage`, which needs a separately installed
 * grammar and is therefore not something a Lykos session can assume.
 * Grammars compiled into a Rust crate are not reachable from a prebuilt N-API
 * binary on plain Node.
 *
 * `.jsx` is JavaScript rather than Tsx: the JavaScript grammar parses JSX
 * (checked — `<div className='x'>hi</div>` matches under both), and a file
 * with no TypeScript in it should not be parsed by a TypeScript grammar that
 * would accept type annotations the file could never contain.
 */
export const AST_LANGUAGE_BY_EXTENSION: Readonly<Record<string, Lang>> = {
  ".ts": Lang.TypeScript,
  ".mts": Lang.TypeScript,
  ".cts": Lang.TypeScript,
  ".tsx": Lang.Tsx,
  ".js": Lang.JavaScript,
  ".mjs": Lang.JavaScript,
  ".cjs": Lang.JavaScript,
  ".jsx": Lang.JavaScript,
  ".css": Lang.Css,
  ".html": Lang.Html,
  ".htm": Lang.Html,
};

/** The extensions the description advertises, in one place so the prose and the map cannot drift. */
export const AST_SUPPORTED_EXTENSIONS: readonly string[] = Object.keys(AST_LANGUAGE_BY_EXTENSION);

/** D4: the language for a path, or undefined — which means "skipped, and said to be skipped". */
export function languageForPath(path: string): Lang | undefined {
  return AST_LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()];
}

// ---------------------------------------------------------------------------
// Metavariables
// ---------------------------------------------------------------------------

/**
 * ast-grep's metavariable spelling, as the ticket states it: `$NAME` captures
 * one node, `$_` matches one without binding, `$$$NAME` captures zero or
 * more, `$$$` matches zero or more without binding. Names are uppercase, so
 * `$path` in a replacement is literal text and not a capture nobody bound.
 *
 * The `$$$` alternative is first so it wins over `$` on `$$$ARGS`; the two
 * unnamed forms match with no capture group and are dropped, because there is
 * nothing to substitute for something that was deliberately not bound.
 */
const METAVARIABLE = /\$\$\$([A-Z][A-Z0-9_]*)?|\$([A-Z][A-Z0-9_]*|_)/g;

export interface PatternMetavariables {
  /** Names written `$NAME`. */
  single: string[];
  /** Names written `$$$NAME`. */
  multi: string[];
}

/** Every named metavariable in a pattern or a replacement, deduplicated, in first-appearance order. */
export function metavariablesIn(text: string): PatternMetavariables {
  const single: string[] = [];
  const multi: string[] = [];
  for (const m of text.matchAll(METAVARIABLE)) {
    const asMulti = m[1];
    const asSingle = m[2];
    if (asMulti !== undefined) {
      if (!multi.includes(asMulti)) multi.push(asMulti);
    } else if (asSingle !== undefined && asSingle !== "_") {
      if (!single.includes(asSingle)) single.push(asSingle);
    }
  }
  return { single, multi };
}

/** Every named metavariable, whichever arity it was written with. */
function namesIn(text: string): string[] {
  const { single, multi } = metavariablesIn(text);
  return [...new Set([...single, ...multi])];
}

/**
 * What is wrong with one `{ pattern, replacement }` rule, before any file is
 * read. Returns everything it found rather than the first thing: a model that
 * discovers three bad rules in three round trips pays three times for one
 * mistake, which is the rule `edit.ts`'s `validateHunks` already follows.
 *
 * The check that earns its place is the last one. A replacement naming a
 * metavariable the pattern never binds would otherwise substitute to nothing
 * and write a silently truncated line to disk — `foo($A)` -> `bar($B)` would
 * produce `bar()`, which compiles, looks deliberate, and is wrong.
 */
export function rewriteProblems(pattern: string, replacement: string, where: string): string[] {
  const problems: string[] = [];
  if (pattern.trim() === "") {
    problems.push(`${where}: pattern is empty. A rewrite with no pattern matches nothing and is a mistake, not a no-op.`);
    return problems;
  }
  const bound = new Set(namesIn(pattern));
  const unbound = namesIn(replacement).filter((n) => !bound.has(n));
  if (unbound.length > 0) {
    problems.push(
      `${where}: the replacement uses ${unbound.map((n) => `$${n}`).join(", ")}, which the pattern never ` +
        `captures. Every metavariable in a replacement must appear in its own pattern.`,
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

export interface AstCapture {
  name: string;
  /** True for a `$$$NAME` capture, whose text is a source slice rather than one node's text. */
  multiple: boolean;
  text: string;
}

export interface AstMatch {
  /** UTF-16 offsets into the source the match was found in. */
  start: number;
  end: number;
  /** 1-indexed, so they can be printed next to the line they name. */
  startLine: number;
  endLine: number;
  text: string;
  captures: AstCapture[];
}

/** What ast-grep says when it is handed something that is not a pattern at all. */
export class AstPatternError extends Error {}

/**
 * Every match of one pattern in one source, with its captures already read.
 *
 * **Captures are read here and nowhere else**, because this is where D2's two
 * facts have to be obeyed. A `$$$NAME` capture is the source between the
 * first and last captured node, never the concatenation of their texts.
 *
 * A pattern ast-grep cannot turn into a tree at all raises `AstPatternError`.
 * A pattern that parses into something the language allows but nothing in the
 * file matches simply returns no matches — ast-grep does not distinguish a
 * mis-written pattern from an absent one, so neither can this, and the tools
 * say so in their no-match text rather than pretending to know.
 */
export function searchSource(lang: Lang, source: string, pattern: string): AstMatch[] {
  const meta = metavariablesIn(pattern);
  let nodes;
  try {
    nodes = parse(lang, source).root().findAll(pattern);
  } catch (err) {
    throw new AstPatternError(
      `pattern ${JSON.stringify(pattern)} is not valid ${lang}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return nodes.map((node) => {
    const range = node.range();
    const captures: AstCapture[] = [];
    for (const name of meta.multi) {
      const captured = node.getMultipleMatches(name);
      const first = captured[0];
      const last = captured[captured.length - 1];
      // D2: the slice, not the join. `console.log(1, 2)` gives back `1, 2`
      // here and `1,2` from any concatenation of node texts.
      const text = first === undefined || last === undefined
        ? ""
        : source.slice(first.range().start.index, last.range().end.index);
      captures.push({ name, multiple: true, text });
    }
    for (const name of meta.single) {
      const captured = node.getMatch(name);
      if (captured !== null && captured !== undefined) {
        captures.push({ name, multiple: false, text: captured.text() });
      }
    }
    return {
      start: range.start.index,
      end: range.end.index,
      startLine: range.start.line + 1,
      endLine: range.end.line + 1,
      text: node.text(),
      captures,
    };
  });
}

/**
 * D6: whether a file's tree has an error node in it.
 *
 * `ast_edit` refuses to write anything when any file in scope fails to parse,
 * because a rewrite computed against a tree the grammar did not understand is
 * a rewrite whose diff cannot be trusted — and half a file set rewritten is
 * the one outcome the model cannot reason about. `ast_grep` searches such a
 * file anyway and names it, because a partial search is still evidence while
 * a partial rewrite is damage.
 */
export function hasParseError(lang: Lang, source: string): boolean {
  return parse(lang, source).root().findAll({ rule: { kind: "ERROR" } }).length > 0;
}

/**
 * The replacement text for one match, with its captures substituted in.
 *
 * Unknown names are left verbatim rather than blanked. They cannot reach here
 * through a tool — `rewriteProblems()` refuses a rule whose replacement names
 * something its pattern does not bind — and a function that silently deletes
 * text it did not understand is a bad function to have lying around.
 */
export function substitute(replacement: string, captures: readonly AstCapture[]): string {
  return replacement.replace(METAVARIABLE, (whole, asMulti?: string, asSingle?: string) => {
    const name = asMulti ?? asSingle;
    if (name === undefined || name === "_") return whole;
    // Resolved by name, not by arity: a pattern that binds `$$$ARGS` and a
    // replacement that writes `$ARGS` means the same thing to a reader, and
    // refusing it would be a spelling rule with no safety behind it.
    const exact = captures.find((c) => c.name === name && c.multiple === (asMulti !== undefined));
    return (exact ?? captures.find((c) => c.name === name))?.text ?? whole;
  });
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

export interface PlannedEdit {
  /** UTF-16 offsets into the source, half-open. */
  start: number;
  end: number;
  /** The substituted replacement text. */
  text: string;
  /** 1-indexed line the match starts on, for a message a human can act on. */
  line: number;
  /** Which rule produced it, 1-indexed. */
  rule: number;
}

/**
 * Two edits that cover the same characters, reported rather than resolved.
 *
 * ast-grep finds nested matches: `foo($A)` matches both `foo(foo(1))` and the
 * `foo(1)` inside it, and the package's own `commitEdits` silently drops the
 * inner one. A rewrite that quietly applies half of what it matched is worse
 * than one that refuses, because the diff the human approved would not be the
 * diff that describes what the tool decided to do. So an overlap is a problem
 * the caller reports and nothing is written.
 */
export function overlapProblems(edits: readonly PlannedEdit[]): string[] {
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  const problems: string[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    if (current.start < previous.end) {
      problems.push(
        `rule ${previous.rule} at line ${previous.line} and rule ${current.rule} at line ${current.line} ` +
          `rewrite overlapping code. Narrow one of the patterns so each match is rewritten once.`,
      );
    }
  }
  return problems;
}

/** The source with every planned edit applied. Assumes `overlapProblems()` came back empty. */
export function applyEdits(source: string, edits: readonly PlannedEdit[]): string {
  const ordered = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let cursor = 0;
  for (const edit of ordered) {
    if (edit.start > cursor) out += source.slice(cursor, edit.start);
    out += edit.text;
    cursor = Math.max(cursor, edit.end);
  }
  return out + source.slice(cursor);
}

// ---------------------------------------------------------------------------
// Scope and the walk (D5)
// ---------------------------------------------------------------------------

/** The glob metacharacters `fd` understands. Their absence is what makes a path literal. */
const GLOB_CHARS = /[*?[\]{}]/;

export interface AstScope {
  /** Absolute directory the walk starts from. */
  base: string;
  /** The glob, relative to `base`, in the spelling Pi's `find` takes. */
  glob: string;
  /** True when the scope named exactly one file, which changes nothing here but tells the caller not to say "0 files". */
  isFile: boolean;
}

/** Absolute resolution, the same one `read`, `edit` and `grep` use, so a path means one thing across the toolset. */
function toAbsolute(cwd: string, given: string): string {
  return isAbsolute(given) ? resolve(given) : resolve(cwd, given);
}

/**
 * A path, a directory or a glob, turned into the two arguments Pi's `find`
 * takes. A literal path is stat'd; a glob is split at the last separator
 * before its first metacharacter, so `lykos/tools/*.ts` walks `lykos/tools`
 * and `src/**` + `/*.ts` walks `src`.
 */
export async function resolveScope(cwd: string, given: string): Promise<AstScope> {
  const trimmed = given.trim();
  if (trimmed === "") throw new Error("lykos ast: empty path. Give a file, a directory or a glob.");
  const normalized = trimmed.split("\\").join("/");
  const globAt = normalized.search(GLOB_CHARS);
  if (globAt === -1) {
    const absolute = toAbsolute(cwd, trimmed);
    let isDirectory: boolean;
    try {
      isDirectory = (await stat(absolute)).isDirectory();
    } catch {
      throw new Error(`lykos ast: ${trimmed} does not exist. Nothing was searched.`);
    }
    if (isDirectory) return { base: absolute, glob: "**/*", isFile: false };
    return { base: dirname(absolute), glob: basenameOf(absolute), isFile: true };
  }
  const cut = normalized.lastIndexOf("/", globAt);
  const literal = cut === -1 ? "" : normalized.slice(0, cut);
  const glob = cut === -1 ? normalized : normalized.slice(cut + 1);
  return { base: literal === "" ? resolve(cwd) : toAbsolute(cwd, literal), glob, isFile: false };
}

function basenameOf(absolute: string): string {
  const parts = absolute.split(sep);
  return parts[parts.length - 1] ?? absolute;
}

/** The one thing a scan must go outside itself for, so a unit test need not shell out to `fd`. */
export interface AstWalk {
  /** Every entry under `base` matching `glob`, as absolute paths. Directories may be included; the scan drops them. */
  (base: string, glob: string): Promise<string[]>;
}

/** Pi's `find`, as a function from a scope to absolute paths. Respects `.gitignore` because `find` does. */
export function piWalk(cwd: string): AstWalk {
  const find = createFindToolDefinition(cwd) as unknown as {
    execute: (id: string, params: unknown, signal?: unknown, onUpdate?: unknown, ctx?: unknown) => Promise<{
      content?: Array<{ text?: string }>;
    }>;
  };
  return async (base, glob) => {
    const result = await find.execute("lykos-ast-walk", { pattern: glob, path: base, limit: AST_MAX_FILES });
    const text = result.content?.[0]?.text ?? "";
    if (text === "" || text.startsWith("No files found")) return [];
    const out: string[] = [];
    for (const line of text.split("\n")) {
      const entry = line.trim();
      // `fd` marks directories with a trailing slash and Pi keeps it; the
      // notices it appends are bracketed and name no file.
      if (entry === "" || entry.endsWith("/") || entry.startsWith("[")) continue;
      out.push(join(base, entry));
    }
    return out;
  };
}

export interface AstScan {
  /** Absolute paths of every file whose language could be inferred, sorted and deduplicated. */
  files: string[];
  /** Absolute paths of every file in scope whose extension names no language (D4). */
  skipped: string[];
  /** True when `AST_MAX_FILES` stopped the scan, so "no matches" does not mean "searched everything". */
  capped: boolean;
}

/**
 * Every source file the given paths cover, plus every file they cover that
 * this toolchain cannot parse.
 *
 * The skip list is the point (D4). A structural search whose result says
 * "no matches" over a scope that was 90% Markdown has told the model
 * something false unless it also says which files it never opened.
 */
export async function scanFiles(cwd: string, paths: readonly string[], walk: AstWalk): Promise<AstScan> {
  const files = new Set<string>();
  const skipped = new Set<string>();
  let capped = false;
  for (const given of paths) {
    const scope = await resolveScope(cwd, given);
    for (const path of await walk(scope.base, scope.glob)) {
      if (languageForPath(path) === undefined) skipped.add(path);
      else files.add(path);
    }
  }
  let kept = [...files].sort();
  if (kept.length > AST_MAX_FILES) {
    capped = true;
    kept = kept.slice(0, AST_MAX_FILES);
  }
  return { files: kept, skipped: [...skipped].sort(), capped };
}

// ---------------------------------------------------------------------------
// Shared rendering
// ---------------------------------------------------------------------------

/**
 * How a path is shown to the model: relative to the session's cwd with
 * forward slashes, or absolute when it falls outside.
 *
 * This is the same answer `search.ts` gives and for the same reason — the one
 * reader of these paths is the model's next `edit` call, and `edit` resolves
 * a relative path against the cwd.
 */
export function displayPath(cwd: string, absolutePath: string): string {
  const rel = relative(cwd, absolutePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return absolutePath;
  return rel.split("\\").join("/");
}

/** D4's heading: the count is always exact, the list is capped. */
export function renderSkipped(cwd: string, skipped: readonly string[]): string[] {
  if (skipped.length === 0) return [];
  const shown = skipped.slice(0, AST_MAX_LISTED_SKIPS).map((p) => displayPath(cwd, p));
  const rest = skipped.length - shown.length;
  return [
    `Skipped ${skipped.length} file${skipped.length === 1 ? "" : "s"} whose language is not inferable from the ` +
      `extension (supported: ${AST_SUPPORTED_EXTENSIONS.join(" ")}):`,
    `  ${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`,
  ];
}

/** Line endings only, keeping any trailing newline — the same helper `edit.ts` keeps for the same reason. */
export function toLF(text: string): string {
  return text.indexOf("\r") === -1 ? text : text.replace(/\r\n?/g, "\n");
}

/** Read a file for parsing: raw bytes as text, and the LF-normalized form every offset in this module refers to. */
export async function readForAst(absolutePath: string): Promise<{ raw: string; source: string }> {
  const raw = await readFile(absolutePath, "utf8");
  return { raw, source: toLF(raw) };
}
