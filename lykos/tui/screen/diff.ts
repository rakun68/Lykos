// Diffs and commands: real per-file diff rendering with fold-not-truncate, and
// bash commands as first-class blocks.
//
// T45.1 reuses conversation.ts's extractDiff()/parseUnifiedDiff() rather
// than rewriting the extraction — only the rendering changes here, and
// only for the full-screen surface. T45.2 is the reason this file exists
// at all: `parseUnifiedDiff()`'s 40-line default cap silently drops the
// rest with no marker, which is exactly the "a review misses the line
// that mattered" failure the task calls out. Parsing here asks for every
// line (`parseUnifiedDiff(path, patch, Number.MAX_SAFE_INTEGER)`) and
// folding happens at render time instead, where a marker can say how much
// is hidden and a key can expand it.

import { parseUnifiedDiff, type DiffLine, type DiffView } from "../renderers/conversation.js";
import { style, withBackground, type ResolvedTheme } from "../theme/resolve.js";
import { stringWidth } from "../width.js";
import { GLYPHS } from "../theme/types.js";

export type { DiffView, DiffLine };

/** A persistent (not hover-triggered) underline marking a fold hint as clickable — see `blocks.ts`'s own `underline()` for why capability `"none"` (`TERM=dumb`, `NO_COLOR`) emits nothing. Defined locally rather than imported: `blocks.ts` already imports FROM this file, so importing back would be circular. */
const UNDERLINE_ON = "\x1b[4m";
const UNDERLINE_OFF = "\x1b[24m";
function underline(text: string, theme: ResolvedTheme): string {
  if (theme.capability === "none") return text;
  return `${UNDERLINE_ON}${text}${UNDERLINE_OFF}`;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * T45.1/T45.4: the un-truncated counterpart of conversation.ts's
 * `extractDiff()`. Same three sources (a unified patch, `edits[]`, or a
 * fresh `write`) but nothing here caps the line count — a 2000-line diff
 * comes back whole, and `foldDiff()` decides how much of it is on screen.
 */
export function extractFullDiff(name: string, args: unknown, result: unknown): DiffView | undefined {
  const rec = asRecord(result);
  const details = rec ? asRecord(rec.details) : null;
  const patch =
    (typeof rec?.diff === "string" ? rec.diff : undefined) ??
    (typeof rec?.patch === "string" ? rec.patch : undefined) ??
    (typeof details?.diff === "string" ? details.diff : undefined) ??
    (typeof details?.patch === "string" ? details.patch : undefined);
  const arg = asRecord(args);
  const path = resolveDiffPath(name, arg, rec, details, patch);
  if (typeof patch === "string" && (patch.includes("\n+") || patch.includes("\n-") || patch.startsWith("@@"))) {
    return parseUnifiedDiff(path, patch, Number.MAX_SAFE_INTEGER);
  }
  const edits = Array.isArray(arg?.edits) ? arg.edits : null;
  if (edits && edits.length > 0) {
    const lines: DiffLine[] = [];
    for (const e of edits) {
      const ed = asRecord(e);
      if (!ed) continue;
      const oldText = typeof ed.oldText === "string" ? ed.oldText : "";
      const newText = typeof ed.newText === "string" ? ed.newText : "";
      for (const l of oldText.split("\n")) lines.push({ kind: "del", text: l });
      for (const l of newText.split("\n")) lines.push({ kind: "add", text: l });
    }
    return { path, lines };
  }
  // T45.4: a new file is an all-additions diff with its real line count —
  // never a 20-line preview that reads as a truncated edit.
  if (name === "write" && typeof arg?.content === "string") {
    const lines: DiffLine[] = arg.content.split("\n").map((text) => ({ kind: "add" as const, text }));
    return { path, lines };
  }
  return undefined;
}

/** The first string among `keys` that `rec` actually carries. */
function firstString(rec: Record<string, unknown> | null, keys: readonly string[]): string | undefined {
  if (!rec) return undefined;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** Every argument name a tool might use for "the file this touched". Pi's own tools use `path`; an extension-provided or MCP tool is under no obligation to. */
const PATH_KEYS = ["path", "file_path", "filePath", "file", "filename", "fileName", "target", "uri"] as const;

/**
 * Which file a diff belongs to — 2026-09-02 round thirteen, item 1: "edit
 * file does not show what file is edited".
 *
 * It used to be `args.path`, falling back to the TOOL'S NAME, which is how
 * a diff came to be headed "edit" instead of a path: any tool naming its
 * argument something other than `path` produced a block that said nothing
 * about what it had changed. Four sources are tried in order of how
 * directly each one names the file — the call's own arguments, the
 * result's, then the patch's own `+++`/`---` header (which every unified
 * diff carries, and which is the ONE source that cannot be wrong about
 * what was patched) — and the tool name remains the last resort rather
 * than the second.
 */
function resolveDiffPath(
  name: string,
  arg: Record<string, unknown> | null,
  result: Record<string, unknown> | null,
  details: Record<string, unknown> | null,
  patch: string | undefined,
): string {
  return (
    firstString(arg, PATH_KEYS) ??
    firstString(result, PATH_KEYS) ??
    firstString(details, PATH_KEYS) ??
    pathFromPatchHeader(patch) ??
    name
  );
}

/** `+++ b/src/x.ts` (preferred — the post-image is the file that now exists) or `--- a/src/x.ts`, with git's `a/`+`b/` prefixes and a trailing timestamp removed. */
function pathFromPatchHeader(patch: string | undefined): string | undefined {
  if (!patch) return undefined;
  for (const marker of ["+++ ", "--- "]) {
    for (const line of patch.split("\n")) {
      if (!line.startsWith(marker)) continue;
      const rest = line.slice(4).trim().split("\t")[0]!.trim();
      if (rest.length === 0 || rest === "/dev/null") continue;
      return rest.replace(/^[ab]\//, "");
    }
  }
  return undefined;
}

export interface DiffSummary {
  added: number;
  removed: number;
}

export function summarizeDiff(diff: DiffView): DiffSummary {
  let added = 0;
  let removed = 0;
  for (const line of diff.lines) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "del") removed += 1;
  }
  return { added, removed };
}

export interface FoldState {
  /** Rows of diff BODY shown before folding — the file header/summary line is separate and always shown. Default 40, matching the append-only renderer's old cap, now a fold rather than a silent drop. */
  maxVisible?: number;
  /** User has expanded this block past the fold. */
  expanded?: boolean;
}

export interface FoldedDiff {
  lines: DiffLine[];
  /** > 0 when the body was folded; the marker names this count. */
  hiddenCount: number;
}

/** T45.2: fold, never truncate-silently. Constant output size when folded, regardless of how large the source diff is — the property T45's acceptance calls "constant frame time." */
export function foldDiff(diff: DiffView, fold: FoldState = {}): FoldedDiff {
  const max = Math.max(1, fold.maxVisible ?? 40);
  if (fold.expanded || diff.lines.length <= max) {
    return { lines: diff.lines, hiddenCount: 0 };
  }
  return { lines: diff.lines.slice(0, max), hiddenCount: diff.lines.length - max };
}

export interface DiffRenderOptions {
  width: number;
  theme: ResolvedTheme;
  fold?: FoldState;
}

/**
 * T45.1: per-file header with the path and a `+N/-M` summary, hunk headers
 * dim, add/del coloured — plus T45.2's fold marker when the body was cut.
 *
 * Bracketed by a full-width opening and closing rule since 2026-09-02
 * round thirteen, item 1: "at the start and at the end of each file edit
 * there should be some seperator to make it easier to see the scope of
 * the edit." The old header was a single `└ path  +N/-M` line with
 * nothing marking where the diff STOPPED, so two consecutive edits, or an
 * edit followed by anything else, ran together into one undifferentiated
 * block of coloured rows. The opening rule carries the path and the
 * counts inline — the information stays on one row, it is the framing
 * that is new — and the closing rule is a plain horizontal run, so the
 * eye finds the end without reading it.
 */
export function renderDiffLines(diff: DiffView, opts: DiffRenderOptions): string[] {
  const { width, theme } = opts;
  const g = GLYPHS[theme.glyphs];
  const { added, removed } = summarizeDiff(diff);
  const summary = `${style(`+${added}`, "added", theme)}/${style(`-${removed}`, "removed", theme)}`;
  const path = style(diff.path, "accent", theme);
  // `┌─ <path>  +N/-M ─────…` and a matching `└────…`, both exactly `width`
  // columns. The visible width is computed from the PLAIN text (escapes
  // occupy no columns), and the filler is clamped at zero so a path longer
  // than the terminal is wide simply gets no trailing rule rather than a
  // negative repeat count.
  const headPlain = `${g.boxTL}${g.hbar} ${diff.path}  +${added}/-${removed} `;
  const filler = Math.max(0, width - stringWidth(headPlain));
  const out = [
    `${style(`${g.boxTL}${g.hbar} `, "border", theme)}${path}  ${summary} ${style(g.hbar.repeat(filler), "border", theme)}`,
  ];
  const folded = foldDiff(diff, opts.fold);
  for (const line of folded.lines) {
    if (line.kind === "hunk") {
      out.push(style(line.text.slice(0, Math.max(1, width - 2)), "faint", theme));
      continue;
    }
    const mark = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
    // T51: dedicated added/removed tokens rather than borrowing ok/danger.
    const token = line.kind === "add" ? "added" : line.kind === "del" ? "removed" : "dim";
    const text = `${mark}${line.text}`.slice(0, Math.max(1, width));
    const styled = style(text, token, theme);
    // 2026-09-02 round eleven, item 2: the whole ROW is tinted, not just
    // the text on it — "give new lines added a whole green background and
    // lines remove red background". Padded out to the block's full width
    // by `withBackground`, so a short added line still reads as a band
    // rather than as a coloured stub, and a context line is left with no
    // fill at all: the tint's job is to separate the two kinds of change
    // from everything around them, which only works if "everything
    // around them" stays plain. The tokens are deliberately weak blends —
    // see `types.ts`'s own note on `addedBg`.
    const bg = line.kind === "add" ? "addedBg" : line.kind === "del" ? "removedBg" : null;
    out.push(bg ? withBackground(styled, bg, theme, stringWidth(text), width) : styled);
  }
  const foldable = diff.lines.length > Math.max(1, opts.fold?.maxVisible ?? 40);
  if (folded.hiddenCount > 0) {
    out.push(underline(style(`… ${folded.hiddenCount} more line${folded.hiddenCount === 1 ? "" : "s"} folded — click, or /verbose, to expand`, "faint", theme), theme));
  } else if (foldable && opts.fold?.expanded) {
    out.push(underline(style("click, or /verbose, to collapse", "faint", theme), theme));
  }
  // The closing rule: where this edit ends, whatever follows it.
  out.push(style(`${g.boxBL}${g.hbar.repeat(Math.max(0, width - 1))}`, "border", theme));
  return out;
}

export interface BashBlockInfo {
  command: string;
  output: string;
  exitCode: number | undefined;
  /** `!cmd` (true) sends output to the model and costs tokens; `!!cmd` (false) keeps it local. */
  sendToModel: boolean;
}

/** Rows of command output shown before folding. `/verbose` shows the rest. */
export const BASH_OUTPUT_LINES = 20;

/**
 * T45.3: bash commands as first-class blocks — command, framed output, exit
 * code, and `!` vs `!!` distinguishable on screen without expanding
 * anything.
 *
 * Folded rather than unbounded since 2026-09-02 round three (item 12): a
 * `find` across a repo is thousands of lines, and a block that long between
 * two sentences is the same "silent truncate or swallow the screen" choice
 * T45.2 already made for diffs. Same answer here — show a bounded head,
 * name the count that is hidden, and let `/verbose` expand it.
 *
 * Blank lines inside the output are kept. They used to be dropped, which
 * quietly reflowed any command whose output has paragraphs (a `git log`, a
 * `--help`) into one wall of text.
 */
export function renderBashLines(bash: BashBlockInfo, opts: { width: number; theme: ResolvedTheme; expanded?: boolean }): string[] {
  const { theme } = opts;
  const g = GLYPHS[theme.glyphs];
  const scope = bash.sendToModel ? style("→ context", "spend", theme) : style("local only", "dim", theme);
  const out = [`${style("$", "dim", theme)} ${bash.command}  ${scope}`];
  const mark = theme.glyphs === "ascii" ? "|" : "⎿";
  const gutter = `  ${style(mark, "border", theme)} `;
  const cont = "    ";
  const all = bash.output.length > 0 ? bash.output.replace(/\n+$/, "").split("\n") : [];
  const shown = opts.expanded ? all : all.slice(0, BASH_OUTPUT_LINES);
  shown.forEach((line, i) => {
    const prefix = i === 0 ? gutter : cont;
    out.push(`${prefix}${style(line, "text", theme)}`);
  });
  const hidden = all.length - shown.length;
  const foldable = all.length > BASH_OUTPUT_LINES;
  const foldPrefix = shown.length === 0 ? gutter : cont;
  if (hidden > 0) {
    out.push(`${foldPrefix}${underline(style(`… ${hidden} more line${hidden === 1 ? "" : "s"} folded — click, or /verbose, to expand`, "faint", theme), theme)}`);
  } else if (foldable && opts.expanded) {
    out.push(`${foldPrefix}${underline(style("click, or /verbose, to collapse", "faint", theme), theme)}`);
  }
  if (all.length === 0) out.push(`${gutter}${style("(no output)", "faint", theme)}`);
  const code = bash.exitCode;
  if (code === undefined) {
    out.push(style(`${g.warnGlyph} exit unknown`, "warn", theme));
  } else if (code === 0) {
    out.push(style(`${g.check} exit 0`, "ok", theme));
  } else {
    out.push(style(`${g.warnGlyph} exit ${code}`, "danger", theme));
  }
  return out;
}
