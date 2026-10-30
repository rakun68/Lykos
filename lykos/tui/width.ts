// How many terminal columns a string actually occupies.
//
// Every renderer in this package used `String.length` for this, which is
// the count of UTF-16 code units — a different number from the count of
// columns the terminal will advance the cursor by, and the difference is
// not cosmetic. 2026-09-02 UI feedback, items 2 and 3, are both this one
// bug:
//
//  - `⚡` (U+26A1) is East Asian **Wide**: the terminal draws it in two
//    cells. Counting it as one made every `⚡ lykos: …` system line one
//    column longer than `frame.ts` believed, so a full-width line wrapped
//    onto the row below instead of being clipped. The frame writer only
//    repaints rows it computes as changed, so the wrapped remainder sat
//    there permanently — the "n every call after it…" text printed across
//    the composer's bottom rule in the report.
//  - The same undercount is what "the emoji overlap on some character"
//    describes from the other side: a glyph the terminal gives one cell
//    but the font draws wider bleeds into its neighbour.
//
// Scope, deliberately: East Asian Wide/Fullwidth get 2, combining marks
// and the variation selectors get 0, C0/C1 controls get 0, everything else
// gets 1. That is a `wcwidth`, not a full grapheme segmenter — a family
// emoji built from ZWJ sequences will still be mismeasured, and no
// terminal agrees on those anyway. Pi bundles a full
// `get-east-asian-width` table for exactly this job (read out of
// `node_modules` while chasing this bug); the ranges below are the same
// Unicode property, transcribed for the blocks that can actually appear
// in a transcript rather than pulled in as a dependency.

/** Inclusive [start, end] code point ranges that occupy two columns. */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2329, 0x232a], // angle brackets
  [0x231a, 0x231b], // watch, hourglass
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1], // ⚡ — the one that started this
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e], // CJK radicals through CJK symbols
  [0x3041, 0x33ff], // kana, Hangul compatibility jamo, CJK compatibility
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6eb, 0x1f6ec],
  [0x1f910, 0x1f9ff],
  [0x20000, 0x2fffd], // CJK Extension B+
  [0x30000, 0x3fffd],
];

/** Inclusive ranges that occupy no columns at all: combining marks, joiners, and the variation selectors. */
const ZERO_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // combining diacritical marks
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f], // zero-width space through RTL mark (ZWJ/ZWNJ included)
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x20d0, 0x20f0], // combining marks for symbols
  [0xfe00, 0xfe0f], // variation selectors 1-16 (VS15/VS16 live here)
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
  [0xe0100, 0xe01ef], // variation selectors supplement
];

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = ranges[mid]!;
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

/**
 * Columns one code point occupies: 0, 1 or 2. C0/C1 controls are 0 — they
 * move the cursor rather than painting, and a renderer that counted them
 * as columns would under-fill every line carrying one.
 */
export function charWidth(cp: number): 0 | 1 | 2 {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (inRanges(cp, ZERO_RANGES)) return 0;
  if (inRanges(cp, WIDE_RANGES)) return 2;
  return 1;
}

/** Columns a plain string occupies. The input must not contain ANSI escapes — `frame.ts`'s `visibleWidth` strips those first. */
export function stringWidth(text: string): number {
  let n = 0;
  for (const ch of text) n += charWidth(ch.codePointAt(0)!);
  return n;
}

/**
 * The longest prefix of `text` that fits in `max` columns, plus the
 * columns it actually occupies. A two-column glyph straddling the limit is
 * dropped whole rather than half-drawn — half a wide glyph is not a
 * character the terminal can render, and printing one is how a row ends up
 * one column short with a replacement box in it.
 */
export function sliceToWidth(text: string, max: number): { text: string; width: number } {
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0)!);
    if (used + w > max) break;
    out += ch;
    used += w;
  }
  return { text: out, width: used };
}
