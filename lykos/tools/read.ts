// T168 (ADR-0031, decision 7) — the `read` wrapper that numbers every line.
//
// **Why it exists.** Pi 0.84.3's `read` returns raw text: no line numbers, only
// trailer notices (`dist/core/tools/read.js` builds `outputText` from
// `truncation.content` and appends `[Showing lines X-Y of Z. ...]` or
// `[N more lines in file. ...]`). This file's earlier header said Pi's output
// was line-numbered. It is not, and that false premise is how a model that was
// asked to name line numbers was never shown any. `read` now prints each line
// as `cat -n` does: the line number right-aligned in six columns, a TAB, then
// the line. The prefix is for locating code and for
// `offset`; it is NOT part of the file, and the tool's description and prompt
// guidelines say so, because the one way to misuse it is to copy it into
// `edit`'s `oldText`, which then matches nothing. `edit` does not strip
// prefixes — a guess at what the model meant is the failure this ticket exists
// to remove.
//
// **Wrapped, not rewritten.** Everything else about Pi's read is the part
// worth keeping and not worth rebuilding: 2000-line / 50 KB head truncation,
// offset/limit paging, image detection and auto-resizing, `~`/`@`/unicode path
// resolution, and a details payload the interface renders. `createReadToolDefinition()`
// returns a plain object, so the wrapper spreads it, keeps its `execute`, and
// rewrites only the text of a successful text-file result (AGENTS.md rule 2).
//
// **The schema is byte-identical on purpose.** `parameters` is the same
// object, so offset/limit are exactly Pi's. Only `description` and
// `promptGuidelines` grow, and `ledger/tool-catalog.ts`'s `read` row grows
// with the description (`read.test.ts` asserts the two agree).
//
// **How the numbering finds the file's lines in Pi's text.** Pi's result is
// the file's lines, optionally followed by one notice, and the notice must
// stay unnumbered and byte-for-byte Pi's. Three shapes, told apart without
// re-reading the file:
//
// - Truncated (`details.truncation.truncated`): Pi hands back the exact
//   truncated content in `details.truncation.content`, so the lines are that
//   string and the notice is whatever follows it in the text.
// - Stopped by the caller's `limit` with lines left over: the text ends in
//   `\n\n[N more lines in file. Use offset=M to continue.]`. M must equal
//   `startLine + limit + 1`, which is Pi's own arithmetic, so a file whose
//   last line merely looks like that sentence is not mistaken for one.
// - Everything else: the whole text is lines. Pi splits on `\n`, so a file that
//   ends in a newline carries one phantom empty element after the last real
//   line; it is not numbered (`cat -n` does not), and the trailing newline is
//   kept.
//
// **What gets no numbers, and fails safe.** A failed read, a directory, an
// image (its content has an image block), the first-line-exceeds-the-limit
// notice (it contains no file lines) and Pi's image-processing-failed note
// (a single text block that begins `Read image file [`) are returned exactly as
// Pi produced them. The last of those is recognised by its text, so a text file
// whose first line is literally `Read image file [` loses its numbers — and
// loses nothing else; an unnumbered read is still a correct read.
//
// Numbering starts at `offset` when one is given, with Pi's own conversion
// (`offset` is 1-indexed; zero, negative and absent mean line 1).
//
// **The read record (T168 part B, `edit.require_read`).** A successful read of
// a text file, a partial `offset`/`limit` read included, notes the hash of the
// file's bytes in the session's `FileReadRecord` (`tools/read-record.ts`). The
// hash is taken BEFORE Pi's read runs: a file that changes while it is being
// read then records the older bytes and reads as changed since, which is the
// safe direction. A read that fails records nothing, and so does one whose file
// cannot be hashed (a directory). The record is passed in `ReadToolOpts`, the
// way `edit`'s options carry the gate.

import { createReadToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { resolveEditPath } from "./edit.js";
import { hashFileNow, type FileReadRecord } from "./read-record.js";

export const READ_TOOL_NAME = "read";

export interface ReadToolOpts {
  cwd: string;
  /** This session's read record. Absent, reads are not recorded. */
  reads?: FileReadRecord;
}

/** Appended to Pi's description. Exported for the catalog row and its parity test. */
export const READ_NUMBERING_NOTE =
  " Text lines are numbered: each is shown as a right-aligned line number, a tab, then the line (for example " +
  "`     7\\tconst x = 1;`). The number and tab are not part of the file; never copy them into edit.";

/** Appended to Pi's prompt guidelines for `read`. */
export const READ_NUMBERING_GUIDELINE =
  "read shows each line as a line number, a tab and the line. The number and tab are not file content: never include them in edit's oldText or newText.";

/** One line, `cat -n` style: number right-aligned in six columns, a tab, the line. */
export function numberedLine(lineNumber: number, line: string): string {
  return `${String(lineNumber).padStart(6)}\t${line}`;
}

/** Number every `\n`-separated line of `content`, the first as `firstLine`. */
function numberLines(content: string, firstLine: number): string {
  return content
    .split("\n")
    .map((line, i) => numberedLine(firstLine + i, line))
    .join("\n");
}

const MORE_LINES_NOTICE = /\n\n\[(\d+) more lines in file\. Use offset=(\d+) to continue\.\]$/;

interface ResultLike {
  content?: Array<{ type?: string; text?: string }>;
  details?: { truncation?: { truncated?: boolean; firstLineExceedsLimit?: boolean; content?: string } } | undefined;
  isError?: boolean;
}

/**
 * Pi's read text, with its file lines numbered and its notices untouched.
 * `undefined` means "leave the result exactly as Pi produced it".
 */
export function numberReadText(
  text: string,
  params: { offset?: unknown; limit?: unknown },
  truncation: { truncated?: boolean; firstLineExceedsLimit?: boolean; content?: string } | undefined,
): string | undefined {
  const offset = typeof params.offset === "number" ? params.offset : undefined;
  const limit = typeof params.limit === "number" ? params.limit : undefined;
  // Pi: `startLine = offset ? Math.max(0, offset - 1) : 0`, and an array slice truncates a fractional index.
  const startLine = offset ? Math.max(0, offset - 1) : 0;
  const firstLine = Math.trunc(startLine) + 1;

  if (truncation !== undefined) {
    if (truncation.firstLineExceedsLimit === true) return undefined;
    if (truncation.truncated === true && typeof truncation.content === "string" && text.startsWith(truncation.content)) {
      return numberLines(truncation.content, firstLine) + text.slice(truncation.content.length);
    }
    return undefined;
  }

  const notice = MORE_LINES_NOTICE.exec(text);
  if (notice !== null && limit !== undefined && Number(notice[2]) === startLine + limit + 1) {
    return numberLines(text.slice(0, notice.index), firstLine) + text.slice(notice.index);
  }

  if (text.startsWith("Read image file [")) return undefined;

  if (text === "") return text;
  const lines = text.split("\n");
  const phantom = lines.length > 1 && lines[lines.length - 1] === "";
  if (phantom) lines.pop();
  const numbered = lines.map((line, i) => numberedLine(firstLine + i, line)).join("\n");
  return phantom ? `${numbered}\n` : numbered;
}

/** Pi's `read`, with the lines of a text file numbered. Same name, so it shadows the built-in the way `write`/`edit`/`bash` do. */
export function buildReadTool(opts: ReadToolOpts): ToolDefinition {
  const base = createReadToolDefinition(opts.cwd) as unknown as ToolDefinition;
  const inner = base.execute.bind(base);
  return {
    ...base,
    description: `${base.description}${READ_NUMBERING_NOTE}`,
    promptGuidelines: [...(base.promptGuidelines ?? []), READ_NUMBERING_GUIDELINE],
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const given = (params as { path?: unknown }).path;
      const absolute = opts.reads !== undefined && typeof given === "string" ? resolveEditPath(given, opts.cwd) : undefined;
      const hashBefore = absolute !== undefined ? await hashFileNow(absolute) : undefined;
      const result = (await inner(toolCallId, params, signal, onUpdate, ctx)) as ResultLike;
      if (result.isError === true) return result;
      if (absolute !== undefined && hashBefore !== undefined) opts.reads?.noteRead(absolute, hashBefore);
      const content = result.content ?? [];
      const only = content.length === 1 ? content[0] : undefined;
      // An image carries an image block next to its text note; a text file is exactly one text block.
      if (only === undefined || only.type !== "text" || typeof only.text !== "string") return result;
      const numbered = numberReadText(only.text, params as { offset?: unknown; limit?: unknown }, result.details?.truncation);
      if (numbered !== undefined) only.text = numbered;
      return result;
    },
  } as ToolDefinition;
}
