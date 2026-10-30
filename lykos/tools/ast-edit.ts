// Structural rewrite: the half of this ticket that writes.
//
// **The gate IS the apply (D3).** There is no staged proposal the model
// applies later, because Lykos already has exactly one place where a human sees what is
// about to happen and decides: the approval gate. A second apply protocol
// would be a second thing that can be forgotten, a second thing a specialist
// restriction has to know about, and a second place a denial could fail to be
// recorded. So this tool computes the whole rewrite, renders it as a unified
// diff, and hands that diff to `authorizeEditBody()` — the same `authorize()`
// every gated write in this codebase goes through. Approval writes; refusal
// writes nothing.
//
// **All-or-nothing across the FILE SET (D6), which is ticket 10's rule with a
// wider blast radius.** `edit.ts` validates every hunk before it writes a
// byte, because a half-applied edit is the one outcome a model cannot reason
// about — it has to re-read to discover what landed. A multi-file rewrite has
// the same problem N times over, so every file in scope is read, parsed,
// matched, substituted and overlap-checked BEFORE the first approval is asked
// for, and the approvals for every file are collected before the first file
// is written. A parse failure anywhere, an overlap anywhere, or a human
// declining any file leaves the working tree exactly as it was.
//
// That last clause is a deliberate reading of D3's "approval is the apply".
// Asking per file and writing as each answer arrives would be simpler and
// would leave files 1 to 3 rewritten when the human says no to file 4 —
// precisely the half-applied state the rest of this paragraph exists to
// prevent. Declining any file therefore discards the whole rewrite, and the
// refusal message says so rather than leaving the model to infer it.
//
// **What is NOT atomic, stated rather than implied.** Once every file has
// been approved they are written one at a time, and no filesystem this runs
// on offers a transaction across several files. A disk error on file 3 leaves
// 1 and 2 written. What this tool guarantees is that nothing is written until
// everything has been computed, parsed, checked and approved — which is the
// failure mode that actually happens, rather than the one that needs the disk
// to fill up mid-call.
//
// **Substitution is ours (D2).** `@ast-grep/napi`'s `node.replace(text)` does
// not substitute metavariables; it is a raw replacement. `ast.ts` reads the
// captures and builds the replacement text, and it reads a `$$$NAME` capture
// as a slice of the source rather than as joined node text, so the separators
// the source had survive. The diff the human approves is produced from those
// same bytes, so what is shown and what is written cannot differ.
//
// **THE SCHEMA TAX, RECORDED AT THE MOMENT THE TOOL IS ADDED (AGENTS.md rule
// 3): this tool rides NO request.** Mounted with `hidden` prompt presence
// (D8), reached through `tool_call`. Measured 2026-09-21 on
// `SCHEMA_TOKENS_BASIS`: `measureToolset(["ast_edit"])` is **356 tokens /
// 1426 bytes**, and the resident surface is **1423 tokens both before and
// after this ticket** because nothing here joined it. `ast-edit.test.ts`
// asserts both.

import { writeFile } from "node:fs/promises";
import { Type } from "typebox";
import {
  defineTool,
  generateDiffString,
  generateUnifiedPatch,
  type EditToolDetails,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ApprovalDeniedError, authorizeEditBody, type ApprovalGate, type DenialLog } from "../gate/approval.js";
import {
  AST_SUPPORTED_EXTENSIONS,
  AstPatternError,
  applyEdits,
  displayPath,
  hasParseError,
  languageForPath,
  overlapProblems,
  piWalk,
  readForAst,
  renderSkipped,
  rewriteProblems,
  scanFiles,
  searchSource,
  substitute,
  type AstWalk,
  type PlannedEdit,
} from "./ast.js";
import { detectLineEnding } from "./edit-match.js";

export const AST_EDIT_TOOL_NAME = "ast_edit";

/**
 * The model-facing contract. Exported so `ledger/tool-catalog.ts` can be
 * asserted equal to it rather than re-typed beside it.
 */
export const AST_EDIT_DESCRIPTION =
  "Rewrite code by syntax tree across many files in one operation. Each rule is a `pattern` and the " +
  "`replacement` that takes the matched node's place; metavariables captured by the pattern substitute into " +
  "the replacement ($NAME, $$$NAME), and an empty replacement deletes the match. Pattern grammar and language " +
  "inference are ast_grep's (extensions: " +
  AST_SUPPORTED_EXTENSIONS.join(" ") +
  "); any other file is skipped and named. The whole rewrite is computed first and shown as a diff for a human " +
  "to approve — approval is what writes. It is all-or-nothing: matching nothing, failing to parse any file, " +
  "two rules overlapping, or a human declining any file all write nothing anywhere.";

export const AST_EDIT_PARAMETERS = Type.Object({
  rules: Type.Array(
    Type.Object({
      pattern: Type.String({ description: "An ast-grep pattern, e.g. 'openLedger($$$ARGS)'." }),
      replacement: Type.String({
        description: "What replaces each match, with the pattern's metavariables substituted. Empty deletes the match.",
      }),
    }),
    { description: "One or more rewrite rules, all applied in the same pass over the same files." },
  ),
  paths: Type.Array(Type.String({ description: "A file, a directory or a glob." }), {
    description: "Where to rewrite. Respects .gitignore.",
  }),
});

export interface AstEditOpts {
  cwd: string;
  gate: ApprovalGate;
  denials?: DenialLog;
  /** The walk. Injectable so a test need not shell out to `fd`; the default is Pi's `find`. */
  walk?: AstWalk;
}

export interface AstEditRule {
  pattern: string;
  replacement: string;
}

/** One file's whole rewrite, computed and checked but not yet approved or written. */
export interface StagedFile {
  absolutePath: string;
  display: string;
  /** What actually goes to disk: `after` with the file's own line ending restored. */
  content: string;
  replacements: number;
  diff: string;
  patch: string;
  firstChangedLine: number | undefined;
}

/**
 * Plan one file: every rule's matches, substituted, overlap-checked.
 *
 * Returns the edits rather than the text so the caller decides what an empty
 * list means — for one file it means "this rule did not apply here", and for
 * the whole set it means "nothing was written, and here is why".
 */
export function planFile(
  lang: Parameters<typeof searchSource>[0],
  source: string,
  rules: readonly AstEditRule[],
): { edits: PlannedEdit[]; problems: string[] } {
  const edits: PlannedEdit[] = [];
  const problems: string[] = [];
  for (const [i, rule] of rules.entries()) {
    let matches;
    try {
      matches = searchSource(lang, source, rule.pattern);
    } catch (err) {
      if (!(err instanceof AstPatternError)) throw err;
      // Not a problem for this file: a rule that does not compile for this
      // language simply does not apply to it. It is a problem only when NO
      // rule compiled anywhere, which the caller checks.
      continue;
    }
    for (const match of matches) {
      edits.push({
        start: match.start,
        end: match.end,
        text: substitute(rule.replacement, match.captures),
        line: match.startLine,
        rule: i + 1,
      });
    }
  }
  problems.push(...overlapProblems(edits));
  return { edits, problems };
}

/** What `ast_edit` says when it matched nothing. The ticket has a checkbox for exactly this. */
export const AST_EDIT_NO_MATCH =
  "No rule matched anything in scope, so nothing was written. Check the pattern with ast_grep first — a " +
  "pattern that does not parse for the target language matches nothing and reports nothing.";

/**
 * The other way to change nothing, which is NOT the same answer and must not
 * be reported as one. `foo($A)` -> `foo($A)` matches everywhere and rewrites
 * each match to itself; telling the model "nothing matched" would send it off
 * to debug a pattern that is working perfectly.
 */
export const AST_EDIT_NO_CHANGE =
  "Every match rewrote to exactly what was already there, so nothing was written. The pattern is fine; the " +
  "replacement does not differ from what it replaces.";

export function buildAstEditTool(opts: AstEditOpts): ToolDefinition {
  const walk = opts.walk ?? piWalk(opts.cwd);
  return defineTool({
    name: AST_EDIT_TOOL_NAME,
    label: "AST edit",
    description: AST_EDIT_DESCRIPTION,
    promptSnippet: "Rewrite a code shape across files, shown as a diff before it is written",
    promptGuidelines: [
      "Run the pattern through ast_grep first. A pattern that matches nothing here matched nothing there, and the rewrite you get back will say so after the human has already been asked.",
      "Narrow `paths` to the directory you mean. A rewrite over a whole repository is one approval per changed file and one parse failure away from writing nothing at all.",
    ],
    parameters: AST_EDIT_PARAMETERS,
    async execute(_toolCallId, params) {
      const rules = params.rules as AstEditRule[];
      const paths = params.paths as string[];

      // ---- Everything that can be checked without touching a file ----
      const problems: string[] = [];
      if (rules.length === 0) problems.push("rules is empty — a rewrite with no rules is a mistake, not a no-op.");
      if (paths.length === 0) problems.push("paths is empty — say which file, directory or glob to rewrite.");
      const seen = new Set<string>();
      for (const [i, rule] of rules.entries()) {
        problems.push(...rewriteProblems(rule.pattern, rule.replacement, `rule ${i + 1}`));
        if (seen.has(rule.pattern)) {
          problems.push(`rule ${i + 1}: pattern ${JSON.stringify(rule.pattern)} is given twice. Two rewrites of one shape cannot both win.`);
        }
        seen.add(rule.pattern);
      }
      if (problems.length > 0) throw refusal(problems, "nothing was read and nothing was written");

      // ---- Read, parse, match, substitute and check EVERY file (D6) ----
      const scan = await scanFiles(opts.cwd, paths, walk);
      const staged: StagedFile[] = [];
      const unparsed: string[] = [];
      const failures: string[] = [];
      let matchedSomething = false;
      for (const absolutePath of scan.files) {
        const lang = languageForPath(absolutePath)!;
        let raw: string;
        let source: string;
        try {
          ({ raw, source } = await readForAst(absolutePath));
        } catch (err) {
          failures.push(
            `${displayPath(opts.cwd, absolutePath)}: cannot be read (${err instanceof Error ? err.message : String(err)}).`,
          );
          continue;
        }
        // D6: a file the grammar did not understand is a file whose rewrite
        // cannot be trusted, and one untrustworthy diff is enough to stop the
        // whole set. `ast_grep` searches such a file anyway; a partial search
        // is evidence and a partial rewrite is damage.
        if (hasParseError(lang, source)) {
          unparsed.push(displayPath(opts.cwd, absolutePath));
          continue;
        }
        const plan = planFile(lang, source, rules);
        if (plan.problems.length > 0) {
          failures.push(...plan.problems.map((p) => `${displayPath(opts.cwd, absolutePath)}: ${p}`));
          continue;
        }
        if (plan.edits.length === 0) continue;
        matchedSomething = true;
        const after = applyEdits(source, plan.edits);
        if (after === source) continue;
        const display = displayPath(opts.cwd, absolutePath);
        const { diff, firstChangedLine } = generateDiffString(source, after);
        // Whatever line ending the file already had is restored, so a rewrite
        // is never also a whitespace commit — the rule `edit.ts` follows.
        const content = detectLineEnding(raw) === "\r\n" ? after.replace(/\n/g, "\r\n") : after;
        staged.push({
          absolutePath,
          display,
          content,
          replacements: plan.edits.length,
          diff,
          patch: generateUnifiedPatch(display, source, after),
          firstChangedLine,
        });
      }

      if (unparsed.length > 0) {
        failures.push(
          `${unparsed.length} file${unparsed.length === 1 ? "" : "s"} in scope did not parse: ${unparsed.join(", ")}. ` +
            `A rewrite computed against a tree the grammar did not understand cannot be trusted, so the whole ` +
            `set is refused. Narrow paths to exclude them, or fix them first.`,
        );
      }
      if (failures.length > 0) throw refusal(failures, "nothing was written anywhere");

      if (staged.length === 0) {
        const text = matchedSomething ? AST_EDIT_NO_CHANGE : AST_EDIT_NO_MATCH;
        return {
          content: [
            { type: "text" as const, text: [text, ...renderSkipped(opts.cwd, scan.skipped)].join("\n") },
          ],
          details: {
            applied: false,
            totalReplacements: 0,
            filesTouched: 0,
            filesSearched: scan.files.length,
            matchedSomething,
            changedFiles: [],
          },
        };
      }

      // ---- The gate is the apply (D3): one authorize() per file, all of
      // them before any write, so a single refusal leaves the tree untouched.
      const summary = `apply ast_edit (${rules.length} rule${rules.length === 1 ? "" : "s"}, ${staged.length} file${staged.length === 1 ? "" : "s"})`;
      for (const file of staged) {
        try {
          await authorizeEditBody(opts.cwd, opts.gate, file.absolutePath, summary, file.patch, opts.denials);
        } catch (err) {
          if (err instanceof ApprovalDeniedError) {
            throw new ApprovalDeniedError(
              `${err.message} This rewrite is all-or-nothing across ${staged.length} file` +
                `${staged.length === 1 ? "" : "s"}, so nothing was written anywhere, including the ` +
                `${staged.length - 1} other file${staged.length === 2 ? "" : "s"} in the set.`,
            );
          }
          throw err;
        }
      }

      // ---- Only now does anything reach the disk ----
      const lines: string[] = [];
      let total = 0;
      for (const file of staged) {
        await writeFile(file.absolutePath, file.content, "utf8");
        total += file.replacements;
        lines.push(`${file.replacements} replacement${file.replacements === 1 ? "" : "s"} in ${file.display}`);
      }
      lines.unshift(
        `Applied ${total} replacement${total === 1 ? "" : "s"} across ${staged.length} file${staged.length === 1 ? "" : "s"}.`,
      );
      lines.push(...renderSkipped(opts.cwd, scan.skipped));
      if (scan.capped) lines.push("Stopped at the file cap; this scope was not rewritten to the end.");

      // One file's diff is renderable; several are not, and the interface
      // shows one payload per tool result. The multi-file case therefore
      // reports counts and leaves the diffs to the approvals the human has
      // already seen.
      const only = staged.length === 1 ? staged[0]! : undefined;
      // T159: every file this rewrite wrote, as displayed (relative, `/`),
      // so the ledger's `edited_files` records files and never the glob.
      const changedFiles = staged.map((f) => f.display);
      const details: (EditToolDetails & { changedFiles: string[] }) | Record<string, unknown> =
        only === undefined
          ? { applied: true, totalReplacements: total, filesTouched: staged.length, changedFiles }
          : {
              diff: only.diff,
              patch: only.patch,
              ...(only.firstChangedLine !== undefined ? { firstChangedLine: only.firstChangedLine } : {}),
              changedFiles,
            };
      return { content: [{ type: "text" as const, text: lines.join("\n") }], details };
    },
  }) as ToolDefinition;
}

/** Every problem in one message, the way `edit.ts` reports a bad call: one round trip, not N. */
function refusal(problems: readonly string[], consequence: string): Error {
  return new Error(
    `lykos ast_edit: ${problems.length} problem${problems.length === 1 ? "" : "s"} in this call, so ${consequence}.\n` +
      problems.map((p) => `  - ${p}`).join("\n"),
  );
}
