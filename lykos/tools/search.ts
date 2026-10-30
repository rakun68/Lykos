// The four search-and-navigation tools, all four of them Pi's.
//
// **Nothing here is a search engine.** Pi ships a ripgrep-backed `grep`, an
// fd-backed `find` and an `ls`, each with streaming, .gitignore handling,
// match and byte limits, line truncation, context blocks and a details
// payload the interface renders. This module registers those definitions and
// adds one thing: a name (`glob`). It once added a second, a `[path#TAG]`
// header on `grep` results; T168 (ADR-0031) removed it with the editor that
// read it. Writing a glob walker or a regex searcher here would be the sixth
// mechanism this project rebuilt that Pi already ships (AGENTS.md rule 2).
//
// **`glob` IS `find`, deliberately (D1).** `createFindToolDefinition` takes a
// `pattern`, an optional `path` and an optional `limit` and returns matching
// files — that is a glob tool, whatever it is called. The registry declares
// both names because a specialist can already ask for either, and every other
// coding agent calls it `glob`. They share one implementation because two
// independent glob walkers that disagree about what `**` matches is a defect
// waiting to happen, and the one that is wrong would be the one nobody reads.
// The only divergence is the description, which is written for the name the
// model sees.
//
// **The one visible wart of sharing an implementation**, recorded rather than
// papered over: Pi's `renderCall` for `find` prints the literal word "find",
// so a `glob` call draws a line reading `find <pattern>` in the terminal.
// Rewriting that renderer to fix a label would mean owning a renderer, which
// is a worse trade than a cosmetic mismatch in one line of tool output.
//
// **What is NOT gated here.** All four are `read`-tier. Lykos has never gated
// a read — Pi's own `read` is ungated (`gate/approval.ts`'s module doc says
// so and says why), the numbered `read` wrapper from T168 keeps it that way,
// and the interaction-mode policy auto-allows the `read` tier in every mode
// but Manual. So these four carry no `authorize()` call, and they carry no
// scope clamp either: `grep` can read outside the project root exactly as far
// as `read` already can. That is a real hole and it is `read`'s hole, not a
// new one this ticket opened; closing it means clamping every read tool at
// once, which is its own ticket.

import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

export const GREP_TOOL_NAME = "grep";
export const GLOB_TOOL_NAME = "glob";
export const FIND_TOOL_NAME = "find";
export const LS_TOOL_NAME = "ls";

/**
 * `glob`'s model-facing contract. Exported so `ledger/tool-catalog.ts` can be
 * asserted equal to it rather than re-typed beside it — a catalog entry that
 * drifts from the tool mis-prices the tax for every session that carries it,
 * silently.
 *
 * It says the same things Pi's `find` description says, because it is the
 * same tool answering the same way; it says them about a pattern rather than
 * about a search, because that is what the name promises.
 */
export const GLOB_DESCRIPTION =
  "Find files whose path matches a glob pattern, e.g. '*.ts', '**/*.json' or 'src/**/*.spec.ts'. " +
  "Returns matching file paths relative to the search directory. Respects .gitignore. Output is " +
  "truncated to 1000 results or 50KB (whichever is hit first). This searches file NAMES; to search " +
  "file CONTENTS use grep.";

/**
 * Pi's `grep`, unchanged. Until T168 (ADR-0031) it also put a `[path#TAG]`
 * header above each file's matches for the anchored editor to quote; with that
 * editor gone there is nothing to tag, and a search result is Pi's output.
 */
export function buildGrepTool(cwd: string): ToolDefinition {
  return createGrepToolDefinition(cwd) as unknown as ToolDefinition;
}

/** P10.4 D1: Pi's `find`, under the name the registry and every other coding agent use. */
export function buildGlobTool(cwd: string): ToolDefinition {
  const base = createFindToolDefinition(cwd) as unknown as ToolDefinition;
  const inner = base.execute.bind(base);
  return {
    ...base,
    name: GLOB_TOOL_NAME,
    label: GLOB_TOOL_NAME,
    description: GLOB_DESCRIPTION,
    promptSnippet: "Find files by glob pattern (respects .gitignore)",
    execute: inner,
  } as ToolDefinition;
}

/** Pi's `find`, mounted rather than resident — the same implementation `glob` carries, under Pi's own name and description. */
export function buildFindTool(cwd: string): ToolDefinition {
  return createFindToolDefinition(cwd) as unknown as ToolDefinition;
}

/** Pi's `ls`, mounted. Reachable through `tool_call`; not on the wire. */
export function buildLsTool(cwd: string): ToolDefinition {
  return createLsToolDefinition(cwd) as unknown as ToolDefinition;
}
