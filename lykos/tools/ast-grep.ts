// Structural search: the half of this ticket that reads.
//
// **Why it exists next to `grep`.** A regex finds `foo(` and an AST pattern
// finds a call to `foo` however its arguments wrapped onto the next line.
// That is the whole difference and it is not a small one: the call shape a
// codemod has to find is exactly the thing a repository's formatter has
// rewrapped in a dozen different ways, so a text search over it is a search
// whose recall depends on line width. `grep` stays the tool to reach for
// first — it is resident, it is faster, and most searches are for a name
// rather than for a shape — and this is the one to reach for when the answer
// has to be "every call site", not "every line mentioning it".
//
// **Headers (D7).** Each file's matches sit under a `[path]` line. They used to
// carry a `[path#TAG]` tag for the anchored editor; T168 (ADR-0031) removed the
// editor and the tag with it.
//
// **A skip is reported, always (D4).** `ast_grep` over a directory of
// Markdown and SQL with two TypeScript files in it must not answer "no
// matches" as though it had looked at everything. Every file whose extension
// names no language is counted exactly and listed (capped), every file the
// grammar could not parse is named, and a pattern that does not compile for a
// language present in the scope is said to have not compiled. All four of
// those are ways a structural search can look like proof of absence, and all
// four are the reason the result has a footer.
//
// **The tool is `read`-tier and reaches no gate**, which is the same answer
// `search.ts` records for `grep`: Lykos has never gated a read, Pi's own
// `read` is ungated, and the interaction-mode policy auto-allows the `read`
// tier everywhere but Manual.
//
// **THE SCHEMA TAX, RECORDED AT THE MOMENT THE TOOL IS ADDED (AGENTS.md rule
// 3): this tool rides NO request.** It is mounted with `hidden` prompt
// presence (D8), so its schema is off the wire entirely and it is reached
// through `tool_call`. Measured 2026-09-21 on `SCHEMA_TOKENS_BASIS`:
// `measureToolset(["ast_grep"])` is **281 tokens / 1123 bytes** (276 / 1104 since T168 dropped the tag sentence from the description), and the
// resident surface `measureToolset(DEFAULT_RESIDENT_TOOLS)` is **1423 tokens
// both before and after this ticket** — unchanged, because nothing here
// joined it. Were both tools made resident they would cost 2059 tokens for
// the nine-tool surface, +636 over today's seven. `ast-grep.test.ts` asserts
// those numbers, so a description that doubles the bill fails a test rather
// than passing silently, and a later ticket that makes either tool resident
// has the before-number already written down instead of reconstructed.

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  AST_SUPPORTED_EXTENSIONS,
  AstPatternError,
  displayPath,
  hasParseError,
  languageForPath,
  piWalk,
  readForAst,
  renderSkipped,
  scanFiles,
  searchSource,
  type AstMatch,
  type AstWalk,
} from "./ast.js";

export const AST_GREP_TOOL_NAME = "ast_grep";

/**
 * How many matches one call returns before it says it stopped: 50. A
 * structural search that returns four hundred call sites has answered a
 * question nobody can read, and the limit is raisable per call.
 */
export const AST_GREP_DEFAULT_LIMIT = 50;

/** How many lines of one match are printed before the rest is summarised. A match spanning a whole function body is a pattern that needs narrowing, not a result that needs printing. */
export const AST_GREP_MAX_MATCH_LINES = 12;

/** How wide a captured value is printed on the `meta` line. */
const META_VALUE_WIDTH = 120;

/**
 * The model-facing contract. Exported so `ledger/tool-catalog.ts` can be
 * asserted equal to it rather than re-typed beside it — a catalog entry that
 * drifts from the tool mis-prices the tax, silently.
 */
export const AST_GREP_DESCRIPTION =
  "Search code by syntax tree instead of by text: finds a call or declaration shape however its source wrapped " +
  "across lines, which a regex cannot. Pattern grammar is ast-grep's: $NAME captures one node, $_ matches one " +
  "without binding, $$$NAME captures zero or more, $$$ matches zero or more without binding. Metavariable names " +
  "must be UPPERCASE. `path` is a file, a directory or a glob and respects .gitignore. Language comes from the " +
  "file extension (" +
  AST_SUPPORTED_EXTENSIONS.join(" ") +
  "); any other file is skipped and named, never silently dropped. Results are headed by the file " +
  "path. Use grep for a name; use this for a shape.";

export const AST_GREP_PARAMETERS = Type.Object({
  pattern: Type.String({
    description: "One ast-grep pattern, e.g. 'openLedger($$$ARGS)' or 'export function $NAME($$$) { $$$ }'.",
  }),
  path: Type.Optional(
    Type.String({ description: "File, directory or glob to search (default: the whole project)." }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum matches to return (default: 50)." }),
  ),
});

export interface AstGrepOpts {
  cwd: string;
  /** The walk. Injectable so a test need not shell out to `fd`; the default is Pi's `find`. */
  walk?: AstWalk;
}

/** One file's contribution to a result: what matched. */
export interface AstGrepFile {
  display: string;
  /** LF-normalized source, so the printed line numbers agree with the match offsets. */
  source: string;
  matches: AstMatch[];
}

export interface AstGrepRender {
  cwd: string;
  files: readonly AstGrepFile[];
  /** Files whose extension named no language (D4). */
  skipped: readonly string[];
  /** Files the grammar could not parse; searched anyway, but named. */
  unparsed: readonly string[];
  /** Languages present in scope whose pattern did not compile, and why. */
  patternIssues: readonly string[];
  /** True when `AST_MAX_FILES` stopped the scan. */
  capped: boolean;
  /** True when `limit` stopped the match collection. */
  limitReached: boolean;
  limit: number;
}

function oneLine(value: string): string {
  const flat = value.replace(/\s*\n\s*/g, " ").trim();
  return flat.length > META_VALUE_WIDTH ? `${flat.slice(0, META_VALUE_WIDTH - 1)}…` : flat;
}

/**
 * One match, as the lines it occupies with their own numbers, plus a `meta`
 * line naming what it captured.
 *
 * The line numbers are the file's, 1-indexed, because the reader of this
 * result is a model about to call `edit` with a line range against the tag in
 * the header directly above. Printing a match-relative number would make the
 * two halves of the result disagree about what "line 12" means.
 */
function renderMatch(source: string, match: AstMatch): string[] {
  const lines = source.split("\n");
  const out: string[] = [];
  const last = Math.min(match.endLine, match.startLine + AST_GREP_MAX_MATCH_LINES - 1);
  for (let n = match.startLine; n <= last; n += 1) {
    out.push(`${n}: ${lines[n - 1] ?? ""}`);
  }
  if (last < match.endLine) out.push(`    ... ${match.endLine - last} more line(s) of this match`);
  if (match.captures.length > 0) {
    out.push(`    meta: ${match.captures.map((c) => `${c.name}=${oneLine(c.text)}`).join(", ")}`);
  }
  return out;
}

/** The whole result text. Split out from `execute` so the footer — which is the part that keeps a search honest — is tested without a filesystem. */
export function renderAstGrepResult(r: AstGrepRender): string {
  const body: string[] = [];
  let total = 0;
  for (const file of r.files) {
    if (file.matches.length === 0) continue;
    total += file.matches.length;
    body.push(`[${file.display}]`);
    for (const match of file.matches) body.push(...renderMatch(file.source, match));
    body.push("");
  }

  const footer: string[] = [];
  if (total === 0) {
    footer.push(
      "No matches found. A pattern that does not parse for this language matches nothing and reports nothing, " +
        "so check the pattern and the path before concluding the code is absent.",
    );
  } else {
    const fileCount = r.files.filter((f) => f.matches.length > 0).length;
    footer.push(
      `${total} match${total === 1 ? "" : "es"} in ${fileCount} file${fileCount === 1 ? "" : "s"}.`,
    );
  }
  if (r.limitReached) {
    footer.push(`Stopped at the ${r.limit}-match limit; narrow the path or raise limit.`);
  }
  if (r.capped) {
    footer.push("Stopped at the file cap; this scope was not searched to the end. Narrow the path.");
  }
  for (const issue of r.patternIssues) footer.push(issue);
  if (r.unparsed.length > 0) {
    footer.push(
      `${r.unparsed.length} file${r.unparsed.length === 1 ? "" : "s"} did not parse cleanly and may be ` +
        `under-reported: ${r.unparsed.slice(0, 10).map((p) => displayPath(r.cwd, p)).join(", ")}`,
    );
  }
  footer.push(...renderSkipped(r.cwd, r.skipped));

  return [...body, ...footer].join("\n").trimEnd();
}

/**
 * P10.4 D7: Pi has no structural search, so unlike the rest of ticket 13 and
 * 14 this one is Lykos's own definition rather than a wrapper. Everything it
 * could reuse, it does: the walk is Pi's `find`, the matcher is
 * `@ast-grep/napi`, and the tag is P10.3's `recordSnapshot`.
 */
export function buildAstGrepTool(opts: AstGrepOpts): ToolDefinition {
  const walk = opts.walk ?? piWalk(opts.cwd);
  return defineTool({
    name: AST_GREP_TOOL_NAME,
    label: "AST grep",
    description: AST_GREP_DESCRIPTION,
    promptSnippet: "Search code by syntax tree, not by text",
    promptGuidelines: [
      "Reach for grep first; reach for this when the answer has to be every call site of a shape, not every line mentioning a name.",
      "Read the footer: a file this tool skipped is a file it never looked at, so 'no matches' is only as wide as the scope it names.",
    ],
    parameters: AST_GREP_PARAMETERS,
    async execute(_toolCallId, params) {
      const pattern = params.pattern.trim();
      if (pattern === "") {
        throw new Error("lykos ast_grep: pattern is empty. A search with no pattern is a mistake, not a no-op.");
      }
      const limit = params.limit !== undefined && params.limit > 0 ? Math.floor(params.limit) : AST_GREP_DEFAULT_LIMIT;
      const scan = await scanFiles(opts.cwd, [params.path ?? "."], walk);

      // The pattern is compiled once per LANGUAGE rather than once per file:
      // it either roots in that grammar or it does not, and asking a thousand
      // times would be a thousand identical answers. A scope holding both
      // TypeScript and CSS with a TypeScript pattern is the normal case, and
      // it must search the TypeScript rather than fail.
      const badLanguages = new Map<string, string>();
      for (const path of scan.files) {
        const lang = languageForPath(path)!;
        if (badLanguages.has(lang)) continue;
        try {
          searchSource(lang, "", pattern);
        } catch (err) {
          if (!(err instanceof AstPatternError)) throw err;
          badLanguages.set(lang, err.message);
        }
      }

      const files: AstGrepFile[] = [];
      const unparsed: string[] = [];
      let found = 0;
      let limitReached = false;
      for (const path of scan.files) {
        if (found >= limit) {
          limitReached = true;
          break;
        }
        const lang = languageForPath(path)!;
        if (badLanguages.has(lang)) continue;
        let source: string;
        try {
          ({ source } = await readForAst(path));
        } catch {
          // Binary, vanished between the walk and the read, or not UTF-8.
          // Nothing to search and nothing honest to say about it beyond the
          // skip report, which is what `scanFiles` already produced.
          continue;
        }
        if (hasParseError(lang, source)) unparsed.push(path);
        const matches = searchSource(lang, source, pattern);
        if (matches.length === 0) continue;
        const kept = matches.slice(0, limit - found);
        if (kept.length < matches.length) limitReached = true;
        found += kept.length;
        files.push({
          display: displayPath(opts.cwd, path),
          source,
          matches: kept,
        });
      }

      const patternIssues = [...badLanguages.entries()].map(
        ([lang, message]) => `Not searched as ${lang}: ${message}`,
      );
      if (files.length === 0 && badLanguages.size > 0 && scan.files.length > 0) {
        // Every file in scope was a language the pattern could not root in.
        // That is a mis-written call, not an absence, and saying "no matches"
        // would be the exact lie D4 exists to prevent.
        throw new Error(
          `lykos ast_grep: the pattern did not compile for any language in this scope, so nothing was ` +
            `searched.\n${patternIssues.map((p) => `  - ${p}`).join("\n")}`,
        );
      }

      const text = renderAstGrepResult({
        cwd: opts.cwd,
        files,
        skipped: scan.skipped,
        unparsed,
        patternIssues,
        capped: scan.capped,
        limitReached,
        limit,
      });
      return {
        content: [{ type: "text" as const, text }],
        details: {
          matchCount: found,
          fileCount: files.length,
          filesSearched: scan.files.length,
          filesSkipped: scan.skipped.length,
          limitReached,
          capped: scan.capped,
        },
      };
    },
  }) as ToolDefinition;
}
