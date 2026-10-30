// Inline markdown for speech/thinking bodies — 2026-09-02 UI feedback,
// items 8 and 9: "**bold**" and backtick code spans/fences need their own
// visual treatment, and "1. 2. 3." / "-"/"*" list markers need a colour
// distinct from their body text. "Copy as much Pi as possible." Round
// five's own item 9 added GFM tables to the same list ("The table are not
// shown correctly... format it").
//
// Deliberately NOT a general markdown renderer: no headings, no nested
// emphasis (`**a *b* c**` is not tracked as two overlapping runs — the
// outer one wins). Emphasis (`*italic*`, `**bold**`, `***both***`),
// strikethrough (`~~text~~`) and links (`[label](url)`) were added
// 2026-09-02 round nine, item 2, after a formatting-test table showed
// exactly which markers this file didn't yet know: italic and
// strikethrough came through as literal `*`/`~~`, and `***both***`
// partially matched the bold pattern (a stray `*` either side of a bolded
// "both") for want of a dedicated bold+italic branch. Every kind is
// backed by a literal structural marker under NO_COLOR (T44.2's rule) —
// under the "none" colour capability this module changes nothing at all
// and hands the raw markdown straight to wrapPlain(), because the markers
// ARE what the reader has to see now that colour is gone; stripping them
// with no colour to replace them would make the text less legible, not
// more.
//
// A link renders as its label, styled, followed by a small `[n]` index —
// never the raw URL, which the old "renders as literal `[text](url)`" bug
// made both unreadable and (the same round's item 2) un-clickable: a
// terminal's own bare-URL auto-linkification has nothing to grab once the
// URL text itself is gone. `extractLinks()` below assigns that same
// numbering — first appearance in the text, one number per DISTINCT url —
// so `blocks.ts`'s click-region scan can recover which url a rendered
// `[n]` marker means without this file threading any hidden state through
// the wrap pipeline.
//
// Bold uses SGR 1/22 — `\x1b[22m` is "not bold," a different code from
// `style()`'s own RESET (`\x1b[0m`), so a bold span nested inside a
// `withBackground()`-wrapped line does not trip that function's
// RESET-patching and the background survives it unscathed. Since
// 2026-09-02 (round three, item 10) it also carries the `strong` colour
// token: SGR 1 alone was not a visible difference on the maintainer's
// terminal, because plenty of monospace faces have no real bold weight.

import { style, type ResolvedTheme } from "../theme/resolve.js";
import { GLYPHS } from "../theme/types.js";
import { charWidth, sliceToWidth, stringWidth } from "../width.js";
import { wrapPlain } from "./scrollback.js";

const LIST_MARKER = /^(\s*)([-*+]|\d+[.)])(\s+)/;
const FENCE = /^(\s*)(`{3,}|~{3,})/;
/**
 * Alternatives are ordered most-specific-first — `***text***` has to be
 * tried before `**text**` or `*text*`, since JS regex alternation picks
 * the FIRST branch that matches at a given position rather than the
 * longest one, and `**`/`*` are literal prefixes of `***`.
 */
const INLINE =
  /(?<html><(?<tag>u|b|i|s|em|strong|del|strike|code)>(?<htmlinner>.*?)<\/\k<tag>>)|(?<bolditalic>\*\*\*[^*\n]+\*\*\*)|(?<bold>\*\*[^*\n]+\*\*)|(?<italic>\*[^*\n]+\*)|(?<strike>~~[^~\n]+~~)|(?<code>`[^`\n]+`)|\[(?<linklabel>[^\]\n]+)\]\((?<linkurl>[^)\n]+)\)/g;

/**
 * The inline HTML tags a model actually emits inside markdown, mapped to
 * the style each one turns on — 2026-09-02 round thirteen, item 2, whose
 * screenshot has `<u>underline</u>` sitting on screen as literal angle
 * brackets. `<u>` is the one that matters and the reason this exists at
 * all: markdown has no underline syntax, so every model reaches for the
 * HTML tag, and printing it raw is the most visible "unrendered syntax"
 * of the set. The rest are here because they cost one regex alternative
 * each and a model that reaches for `<u>` will reach for `<b>` too.
 *
 * Deliberately NOT a general HTML parser: an unknown tag stays literal
 * text, exactly as it does now. Nothing about this is a licence to render
 * arbitrary markup.
 */
const HTML_TAG_STYLE: Record<string, Partial<Style>> = {
  u: { underline: true },
  b: { bold: true },
  strong: { bold: true },
  i: { italic: true },
  em: { italic: true },
  s: { strike: true },
  del: { strike: true },
  strike: { strike: true },
  code: { code: true },
};
/** Just the link half of `INLINE`, for `extractLinks()` — a fresh regex rather than reusing `INLINE`'s own `lastIndex` state, which every other caller here also mutates. */
const LINK_ONLY = /\[[^\]\n]+\]\(([^)\n]+)\)/g;

const BOLD_ON = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
const ITALIC_ON = "\x1b[3m";
const ITALIC_OFF = "\x1b[23m";
const STRIKE_ON = "\x1b[9m";
const STRIKE_OFF = "\x1b[29m";
/** A persistent (not hover-triggered) underline marking a link as clickable — see `blocks.ts`'s own `underline()` for why it isn't gated by theme capability. */
const UNDERLINE_ON = "\x1b[4m";
const UNDERLINE_OFF = "\x1b[24m";

/** One wrapped output line: `plain` for width/background math (never carries escapes), `styled` for what actually gets painted. */
export interface MarkdownLine {
  plain: string;
  styled: string;
}

/**
 * A span's styling as a SET of independent flags, not one label — round
 * thirteen, item 2.
 *
 * Until this round a run carried a single `RunKind`, one of "bold",
 * "italic", "boldItalic", "strike", "code", "link" or "plain", and a span
 * could therefore only ever be one of those things. Every combination in
 * the maintainer's own formatting-test table was consequently unrendered:
 * `[**bold link**](url)` came out as the literal `**bold link**[1]`
 * because the link branch consumed the label whole and never looked
 * inside it, and `<u>**u + bold**</u>` could not have worked even if the
 * HTML tag had been understood, because there was no way to be underlined
 * AND bold at the same time. `boldItalic` existing as its own kind is the
 * shape of the problem in miniature: the one combination anyone had
 * needed, hardcoded, rather than combining.
 *
 * Flags compose, and `splitRuns()` recurses into a span's own text
 * carrying the flags already in force — so nesting works to any depth
 * without a new kind per combination. `link` is a string rather than a
 * boolean because it carries the destination `blocks.ts`'s click-region
 * scan resolves a rendered `[n]` marker back to.
 */
interface Style {
  bold?: true;
  italic?: true;
  strike?: true;
  underline?: true;
  code?: true;
  link?: string;
}

const PLAIN: Style = {};

/** Two spans merge into one styled run only if this matches — every flag plus the url, since two different links back to back must not merge. */
function styleKey(s: Style): string {
  return `${s.bold ? "b" : ""}${s.italic ? "i" : ""}${s.strike ? "s" : ""}${s.underline ? "u" : ""}${s.code ? "c" : ""}|${s.link ?? ""}`;
}

/**
 * One styled run of a line: `text` is what the reader sees (markers
 * already removed), `style` is how it is painted.
 *
 * Runs, rather than a styled string, are what makes **bold survive a wrap
 * boundary** — 2026-09-02 round six, item 2: "The bold text are not shown
 * correctly (`**...**` still exist, it should already hide `**` and make
 * the text inside bold)". Until that round the paragraph branch wrapped
 * the RAW line first (`wrapPlain(rawLine, w)`) and only then looked for
 * inline spans on each wrapped line, so any span that happened to straddle
 * a wrap boundary matched nothing and came out as literal asterisks. That
 * was documented as "rare in ordinary prose" and it is not: an assistant
 * reply is dense with bold, the wrap width is fixed, and a long paragraph
 * breaks a span roughly every few lines. The maintainer's own observation
 * names the asymmetry exactly — "somehow it is shown in Thinking but not
 * shown in actual answer" — because reasoning text is mostly unformatted
 * prose while an answer is not.
 *
 * So spans are parsed ONCE, off the unwrapped logical line, and the wrap
 * runs over the parsed runs instead of over raw text. A span split by a
 * wrap now emits styled text on both sides of the break, which is what
 * every other markdown renderer does and what was asked for.
 */
interface Run {
  text: string;
  style: Style;
}

/** One code point plus the run it came from — the unit the wrapper moves around. */
interface Atom {
  ch: string;
  style: Style;
}

/**
 * `[label](url)` occurrences in `text`, one entry per DISTINCT url, in the
 * order each first appears — a link's `[n]` marker (`splitRuns()` below)
 * is this array's index of that url, 1-based. Exported so `blocks.ts` can
 * recompute the SAME numbering independently when scanning a block's
 * already-rendered lines for a clicked `[n]`, without this file having to
 * thread the mapping through `renderScreenBlock()`'s `string[]` contract.
 * The two stay in sync because both are a left-to-right scan of the same
 * text with the same "first appearance wins" rule — not by one calling
 * the other.
 */
export function extractLinks(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  LINK_ONLY.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = LINK_ONLY.exec(text))) {
    const url = m[1]!;
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

function buildLinkIndex(text: string): Map<string, number> {
  return new Map(extractLinks(text).map((url, i) => [url, i + 1]));
}

/**
 * Splits a logical line into runs, with every marker (`**`/`*`/`~~`/
 * backtick/`[]()`/`<u>`) removed and each run carrying the full set of
 * styles in force where it sits.
 *
 * Recursive since round thirteen: a span's own text is re-parsed with the
 * enclosing style added, so `[**bold link**](url)` is a bold, underlined,
 * accent-coloured label followed by its `[n]`, and `<u>**u + bold**</u>`
 * is both underlined and bold. A code span is the one thing NOT recursed
 * into — inside backticks, markup is literal text, which is what
 * CommonMark says and what makes it possible to show markup at all.
 *
 * `inherited` is what the caller was already inside; every branch passes
 * `{ ...inherited, <its own flag> }` down. Regex state (`INLINE.lastIndex`)
 * is per-frame because each frame runs its own `while (exec)` loop over its
 * own string, and the outer frame's `last`/`lastIndex` are read only after
 * the inner call has returned.
 */
function splitRuns(line: string, linkIndex: ReadonlyMap<string, number>, inherited: Style = PLAIN): Run[] {
  const runs: Run[] = [];
  let last = 0;
  let searchFrom = 0;
  for (;;) {
    INLINE.lastIndex = searchFrom;
    const m = INLINE.exec(line);
    if (!m) break;
    // Captured BEFORE any recursion: an inner `splitRuns()` frame runs its
    // own `exec` loop on the shared `INLINE` object and leaves
    // `lastIndex` pointing into ITS string, so reading `INLINE.lastIndex`
    // after the recursive call returns is reading someone else's cursor.
    // (It was, briefly, and every styled span came out doubled — the
    // styled inner text followed by the raw source of the same span.)
    const end = m.index + m[0]!.length;
    if (m.index > last) runs.push({ text: line.slice(last, m.index), style: inherited });
    const g = m.groups!;
    if (g.html !== undefined && g.tag !== undefined && g.htmlinner !== undefined) {
      const added = HTML_TAG_STYLE[g.tag]!;
      const style: Style = { ...inherited, ...added };
      // `<code>` is literal inside, exactly like a backtick span.
      if (added.code) runs.push({ text: g.htmlinner, style });
      else runs.push(...splitRuns(g.htmlinner, linkIndex, style));
    } else if (g.bolditalic !== undefined) {
      runs.push(...splitRuns(g.bolditalic.slice(3, -3), linkIndex, { ...inherited, bold: true, italic: true }));
    } else if (g.bold !== undefined) {
      runs.push(...splitRuns(g.bold.slice(2, -2), linkIndex, { ...inherited, bold: true }));
    } else if (g.italic !== undefined) {
      runs.push(...splitRuns(g.italic.slice(1, -1), linkIndex, { ...inherited, italic: true }));
    } else if (g.strike !== undefined) {
      runs.push(...splitRuns(g.strike.slice(2, -2), linkIndex, { ...inherited, strike: true }));
    } else if (g.code !== undefined) {
      // CommonMark strips exactly one leading and one trailing space from
      // a code span's content, so `` ` x ` `` and `` `x` `` render the
      // same — the spaces exist to let the content itself start or end
      // with a backtick, not to be shown.
      runs.push({ text: stripOneSpace(g.code.slice(1, -1)), style: { ...inherited, code: true } });
    } else if (g.linklabel !== undefined && g.linkurl !== undefined) {
      const n = linkIndex.get(g.linkurl);
      const style: Style = { ...inherited, underline: true, link: g.linkurl };
      // The label is parsed as markdown in its own right; the `[n]` marker
      // is appended as a run in the SAME style, so it reads (and merges)
      // as part of the link rather than as a stray bracket after it. A
      // link with no assigned number — only possible if `linkIndex` came
      // from different text than `line` did, which no caller here does —
      // still shows its label, just with nothing clickable to scan for.
      runs.push(...splitRuns(g.linklabel, linkIndex, style));
      if (n !== undefined) runs.push({ text: `[${n}]`, style });
    }
    last = end;
    // Always forward, even for a zero-width match (`<u></u>` is not one,
    // but nothing here should depend on that).
    searchFrom = Math.max(end, m.index + 1);
  }
  if (last < line.length) runs.push({ text: line.slice(last), style: inherited });
  return runs;
}

/** CommonMark's code-span rule: one leading and one trailing space are stripped, and only if BOTH are present and the content is not all spaces. */
function stripOneSpace(text: string): string {
  if (text.length > 1 && text.startsWith(" ") && text.endsWith(" ") && text.trim().length > 0) return text.slice(1, -1);
  return text;
}

function toAtoms(runs: readonly Run[]): Atom[] {
  const atoms: Atom[] = [];
  for (const run of runs) for (const ch of run.text) atoms.push({ ch, style: run.style });
  return atoms;
}

/** The style a re-inserted word gap should carry: the shared one when both neighbours agree, plain otherwise. */
function spaceBetween(prev: Atom | undefined, next: Atom | undefined): Atom {
  if (prev && next && styleKey(prev.style) === styleKey(next.style)) return { ch: " ", style: prev.style };
  return { ch: " ", style: PLAIN };
}

function atomsWidth(atoms: readonly Atom[]): number {
  let n = 0;
  for (const a of atoms) n += charWidth(a.ch.codePointAt(0)!);
  return n;
}

/** The longest prefix of `atoms` that fits `width` columns, never splitting a code point. */
function sliceAtoms(atoms: readonly Atom[], width: number): Atom[] {
  const out: Atom[] = [];
  let col = 0;
  for (const a of atoms) {
    const cw = charWidth(a.ch.codePointAt(0)!);
    if (col + cw > width) break;
    out.push(a);
    col += cw;
  }
  return out;
}

/**
 * Greedy word wrap over atoms — deliberately the same policy, in the same
 * order, as `scrollback.ts`'s `wrapPlain()`: break at the last space that
 * fits, hard-break a word wider than the whole line, and never exceed
 * `width` columns. The only difference is that each character carries its
 * run kind through the break, which is the entire point.
 */
function wrapAtoms(atoms: readonly Atom[], width: number): Atom[][] {
  const w = Math.max(1, Math.floor(width));
  const words: Atom[][] = [];
  let word: Atom[] = [];
  for (const a of atoms) {
    if (a.ch === " ") {
      words.push(word);
      word = [];
      continue;
    }
    word.push(a);
  }
  words.push(word);

  const out: Atom[][] = [];
  let line: Atom[] = [];
  for (const wordAtoms of words) {
    const joined = line.length === 0 ? atomsWidth(wordAtoms) : atomsWidth(line) + 1 + atomsWidth(wordAtoms);
    if (joined <= w) {
      // The space BETWEEN two words of the same span belongs to that span
      // (round thirteen, item 2). It used to be re-inserted as a plain
      // atom, which broke a multi-word link's underline into one segment
      // per word with visible gaps — the same for `<u>` text, and the
      // reason a rendered link looked like several links. A space between
      // differently-styled words stays plain, which is what it is.
      if (line.length > 0) line.push(spaceBetween(line[line.length - 1], wordAtoms[0]));
      line.push(...wordAtoms);
      continue;
    }
    if (line.length > 0) out.push(line);
    let rest: Atom[] = wordAtoms;
    while (atomsWidth(rest) > w) {
      const head = sliceAtoms(rest, w);
      if (head.length === 0) break; // a single glyph wider than the line — emitted whole below rather than looping forever
      out.push(head);
      rest = rest.slice(head.length);
    }
    line = rest;
  }
  out.push(line);
  return out;
}

/**
 * Collapses one wrapped row's atoms back into as few styled spans as their
 * kinds allow. Two adjacent atoms merge into one span only when BOTH their
 * `kind` and `url` match — the `url` half matters only for two different
 * links sitting back to back with no space between them (`[a](x)[b](y)`),
 * which without it would merge into one run carrying just the first
 * link's url.
 */
function styleAtoms(atoms: readonly Atom[], theme: ResolvedTheme, baseToken: Parameters<typeof style>[1]): MarkdownLine {
  let plain = "";
  let styled = "";
  let i = 0;
  while (i < atoms.length) {
    const span = atoms[i]!.style;
    const key = styleKey(span);
    let text = "";
    while (i < atoms.length && styleKey(atoms[i]!.style) === key) {
      text += atoms[i]!.ch;
      i += 1;
    }
    plain += text;
    // Every flag contributes its own SGR pair, so a span can be several
    // things at once (round thirteen, item 2). Colour is the one thing
    // that cannot stack — a glyph has one foreground — so it is resolved
    // by precedence: code wins, then a link's accent, then bold's
    // `strong`, then whatever the caller asked for.
    //
    // Bold's colour is deliberate: SGR 1 alone was not a visible
    // difference on the maintainer's terminal (2026-09-02 round three,
    // item 10 — "make bold test a slightly different color too"), because
    // plenty of monospace faces have no real bold weight.
    const token = span.code ? "code" : span.link !== undefined ? "accent" : span.bold ? "strong" : baseToken;
    let open = "";
    let close = "";
    if (span.bold) {
      open += BOLD_ON;
      close = BOLD_OFF + close;
    }
    if (span.italic) {
      open += ITALIC_ON;
      close = ITALIC_OFF + close;
    }
    if (span.strike) {
      open += STRIKE_ON;
      close = STRIKE_OFF + close;
    }
    // A link is underlined because round nine made it a genuine click
    // target and round ten made that visible; `<u>` is underlined because
    // that is what it means. Same SGR either way, so one flag covers both.
    if (span.underline || span.link !== undefined) {
      open += UNDERLINE_ON;
      close = UNDERLINE_OFF + close;
    }
    styled += `${open}${style(text, token, theme)}${close}`;
  }
  return { plain, styled };
}

/** Inline spans of a single line that is already known to fit — table cells, which are padded rather than wrapped. */
function renderInline(line: string, theme: ResolvedTheme, baseToken: Parameters<typeof style>[1], linkIndex: ReadonlyMap<string, number>): string {
  return styleAtoms(toAtoms(splitRuns(line, linkIndex)), theme, baseToken).styled;
}

/**
 * Every marker removed, no styling — the PLAIN text a table cell's
 * column-width math is computed from. A link keeps its `[n]` suffix (per
 * `linkIndex`) rather than dropping to a bare label, because that suffix
 * IS part of what actually gets painted (`splitRuns()` builds the same
 * text) — measuring width without it would under-pad every column a link
 * appears in.
 */
function stripInlineMarkers(text: string, linkIndex: ReadonlyMap<string, number>): string {
  // The same parse `renderInline()` paints from, with the styling thrown
  // away — rather than a second, parallel `replace()` over the same regex.
  // Keeping two implementations in step is what made a nested span measure
  // one width and paint another; round thirteen collapsed them into one.
  return splitRuns(text, linkIndex)
    .map((run) => run.text)
    .join("");
}

// --- GFM tables (2026-09-02 round five, item 9) ---
//
// A table used to fall straight through to the plain word-wrap branch at
// the bottom of `renderMarkdownLines()` — which is exactly why bold inside
// one came out as literal asterisks rather than styled text: a table row
// is typically WIDE (many cells), gets word-wrapped by `wrapPlain()`, and
// this file's own documented limitation is that a `**bold**` span split
// across a wrap boundary shows its literal markers rather than styling —
// "rare" for ordinary prose, routine for a table row. Detecting and
// rendering the table as its own block, unwrapped, sidesteps that
// entirely: each cell is measured and padded on its own, never reflowed
// by the paragraph wrapper.

type Align = "left" | "right" | "center";

const TABLE_SEP_CELL = /^:?-+:?$/;

/** Splits one `| a | b |` row into trimmed cells, honouring a `\|` escape and tolerating missing outer pipes (both are valid GFM). */
function parseTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i += 1;
      continue;
    }
    if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
      continue;
    }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function isSeparatorRow(line: string): boolean {
  if (!line.includes("-")) return false;
  const cells = parseTableRow(line);
  return cells.length > 0 && cells.every((c) => TABLE_SEP_CELL.test(c));
}

function alignFor(sepCell: string): Align {
  const left = sepCell.startsWith(":");
  const right = sepCell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

/** One cell, padded to `width` columns for its alignment. Over-length content is truncated (plain, no inline styling survives a truncated cell) rather than left to overrun the column and break every row after it. */
function padCell(
  raw: string,
  width: number,
  align: Align,
  theme: ResolvedTheme,
  token: Parameters<typeof style>[1],
  linkIndex: ReadonlyMap<string, number>,
): MarkdownLine {
  const rawPlain = stripInlineMarkers(raw, linkIndex);
  let contentPlain: string;
  let styled: string;
  if (stringWidth(rawPlain) > width) {
    const sliced = sliceToWidth(rawPlain, Math.max(1, width - 1));
    contentPlain = `${sliced.text}…`;
    styled = style(contentPlain, token, theme);
  } else {
    contentPlain = rawPlain;
    styled = token === "accent" ? style(rawPlain, "accent", theme) : renderInline(raw, theme, token, linkIndex);
  }
  const gap = Math.max(0, width - stringWidth(contentPlain));
  const padL = align === "right" ? gap : align === "center" ? Math.floor(gap / 2) : 0;
  const padR = gap - padL;
  return {
    plain: `${" ".repeat(padL)}${contentPlain}${" ".repeat(padR)}`,
    styled: `${" ".repeat(padL)}${styled}${" ".repeat(padR)}`,
  };
}

/**
 * Renders one GFM table as a **ruled box** — 2026-09-02 round six, item 2:
 * "The table are not shown correctly (table look shit rn and not look like
 * a table, format it)." Round five's version aligned the columns correctly
 * but drew only a single rule under the header, which at a glance reads as
 * three paragraphs of padded text rather than as a table; the frame is
 * what makes it unmistakable, and it is what every other terminal renderer
 * (Pi's included) draws.
 *
 * Column widths are each cell's natural content width, shrunk
 * proportionally (never below 1 column) when the table doesn't fit
 * `width` — a table that genuinely cannot fit is still fully READABLE
 * (every column present, nothing dropped), just tighter, rather than
 * spilling past the frame for the writer to clip blind. The box chrome
 * (`│ ` + ` │ ` + ` │`) is counted in that budget, never added on top of
 * it: a border that pushes the table past the frame is worse than no
 * border at all.
 */
function renderTable(
  header: string[],
  aligns: Align[],
  rows: string[][],
  width: number,
  theme: ResolvedTheme,
  linkIndex: ReadonlyMap<string, number>,
): MarkdownLine[] {
  const g = GLYPHS[theme.glyphs];
  const numCols = header.length;
  const allRows = [header, ...rows];
  // Chrome per row: one leading `│`, one trailing `│`, one `│` between each
  // pair of columns, and a space either side of every cell.
  const chrome = numCols + 1 + numCols * 2;
  const naturalWidths = Array.from({ length: numCols }, (_, c) => Math.max(1, ...allRows.map((r) => stringWidth(stripInlineMarkers(r[c] ?? "", linkIndex)))));
  const naturalTotal = naturalWidths.reduce((a, b) => a + b, 0) + chrome;
  let widths = naturalWidths;
  if (naturalTotal > width && numCols > 0) {
    const availForCols = Math.max(numCols, width - chrome);
    const sumNatural = naturalWidths.reduce((a, b) => a + b, 0);
    widths = naturalWidths.map((w) => Math.max(1, Math.floor((w / sumNatural) * availForCols)));
  }

  function rule(left: string, mid: string, right: string): MarkdownLine {
    const spans = widths.map((w) => g.hbar.repeat(w + 2));
    const plain = `${left}${spans.join(mid)}${right}`;
    return { plain, styled: style(plain, "border", theme) };
  }

  function joinRow(cells: string[], isHeader: boolean): MarkdownLine {
    const padded = widths.map((w, c) => padCell(cells[c] ?? "", w, aligns[c] ?? "left", theme, isHeader ? "accent" : "text", linkIndex));
    const bar = style(g.vbar, "border", theme);
    return {
      plain: `${g.vbar} ${padded.map((p) => p.plain).join(` ${g.vbar} `)} ${g.vbar}`,
      styled: `${bar} ${padded.map((p) => p.styled).join(` ${bar} `)} ${bar}`,
    };
  }

  return [
    rule(g.boxTL, g.teeDown, g.boxTR),
    joinRow(header, true),
    rule(g.teeRight, g.cross, g.teeLeft),
    ...rows.map((row) => joinRow(row, false)),
    rule(g.boxBL, g.teeUp, g.boxBR),
  ];
}

/**
 * Wraps `text` to `width` the same way `wrapPlain()` does, but recognises
 * fenced code blocks (entered/exited on a ```/~~~ line, rendered whole in
 * the `code` token, never word-wrapped — a fence is preformatted by
 * definition), GFM tables (a `| a | b |` row immediately followed by a
 * `|---|---|` separator row — rendered as fixed-width columns, never
 * word-wrapped either, for the same "preformatted" reason), list markers
 * (coloured `accent`, continuation lines indented to match rather than
 * re-marked), and inline `**bold**`/`` `code` `` spans within ordinary
 * paragraph text.
 *
 * A span split across a wrap boundary (rare in ordinary prose — spans are
 * typically a word or short phrase) renders as literal asterisks/backticks
 * on the line where it broke rather than partial styling; accepted rather
 * than building full run-tracking through the wrap boundary for a first
 * version of this. Tables are the one place this stopped being rare (a
 * wide row wraps routinely), which is why they get their own unwrapped
 * path instead.
 */
export function renderMarkdownLines(text: string, width: number, theme: ResolvedTheme, baseToken: Parameters<typeof style>[1]): MarkdownLine[] {
  const w = Math.max(1, width);
  if (theme.capability === "none") {
    return wrapPlain(text, w).map((plain) => ({ plain, styled: plain }));
  }
  // Built ONCE over the whole block, not per line — a link's `[n]` has to
  // stay the same number wherever in the text it appears again, and
  // numbering has to be assigned before the first line that might
  // reference it is even reached.
  const linkIndex = buildLinkIndex(text);

  const out: MarkdownLine[] = [];
  const rawLines = text.split("\n");
  let inFence = false;
  let i = 0;
  while (i < rawLines.length) {
    const rawLine = rawLines[i]!;
    if (FENCE.test(rawLine)) {
      inFence = !inFence;
      out.push({ plain: rawLine, styled: style(rawLine, "code", theme) });
      i += 1;
      continue;
    }
    if (inFence) {
      out.push({ plain: rawLine, styled: style(rawLine, "code", theme) });
      i += 1;
      continue;
    }
    if (rawLine.includes("|") && i + 1 < rawLines.length && isSeparatorRow(rawLines[i + 1]!)) {
      const header = parseTableRow(rawLine);
      const aligns = parseTableRow(rawLines[i + 1]!).map(alignFor);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < rawLines.length && rawLines[j]!.includes("|") && rawLines[j]!.trim().length > 0) {
        rows.push(parseTableRow(rawLines[j]!));
        j += 1;
      }
      out.push(...renderTable(header, aligns, rows, w, theme, linkIndex));
      i = j;
      continue;
    }
    const listMatch = LIST_MARKER.exec(rawLine);
    if (listMatch) {
      const prefix = listMatch[0];
      const indent = " ".repeat(prefix.length);
      const wrapped = wrapAtoms(toAtoms(splitRuns(rawLine.slice(prefix.length), linkIndex)), Math.max(1, w - prefix.length));
      wrapped.forEach((rowAtoms, k) => {
        const body = styleAtoms(rowAtoms, theme, baseToken);
        const styledPrefix = k === 0 ? style(prefix, "accent", theme) : indent;
        out.push({ plain: `${k === 0 ? prefix : indent}${body.plain}`, styled: `${styledPrefix}${body.styled}` });
      });
      i += 1;
      continue;
    }
    for (const rowAtoms of wrapAtoms(toAtoms(splitRuns(rawLine, linkIndex)), w)) {
      out.push(styleAtoms(rowAtoms, theme, baseToken));
    }
    i += 1;
  }
  return out;
}
