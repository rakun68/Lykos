// Semantic tokens, never colour names (docs/07-ui-and-hud.md §5.1). Code
// says `spend`, not "pink" — the whole reason a second palette is a data
// file rather than a patch.

export type SemanticToken =
  | "bg"
  | "panel"
  | "border"
  | "text"
  | "dim"
  | "faint"
  | "accent"
  | "spend"
  | "avoided"
  | "cache"
  | "delegate"
  | "ok"
  | "warn"
  | "danger"
  // T51.1: the full-screen surface's own tokens. "border" above predates
  // this task (already in use for the HUD panels) — the other seven are new.
  | "thinking"
  | "speech"
  | "costed"
  | "local"
  | "added"
  | "removed"
  | "modalBg"
  // T51.3 (2026-09-01 UI feedback round): background-only surfaces for
  // full-width blocks — the user prompt, the paler thinking box, and the
  // green "read" bar. Never used as a foreground colour; resolve.ts's
  // `bgPrefixFor` is the only reader.
  | "userBg"
  | "thinkingBg"
  | "readBg"
  // 2026-09-02: inline/fenced code spans in speech/thinking text.
  | "code"
  // 2026-09-02 (editor round): the composer's own selection highlight.
  // Background-only, like the three `*Bg` tokens above — `resolve.ts`'s
  // `withInlineBackground` is its only reader.
  | "selectionBg"
  // 2026-09-02 (round three, item 10): **bold** spans in speech and
  // thinking. Bold alone (SGR 1) was not enough to separate them from body
  // text on the maintainer's terminal — "make bold test a slightly
  // different color too... only slightly different, maybe brighter" — so
  // this is `text` nudged toward white rather than a new hue.
  | "strong"
  // 2026-09-02 (round three, item 4): the tab-completion popup's own
  // background, deliberately a different tint from `userBg`/`thinkingBg`
  // so the popup reads as chrome sitting over the conversation rather than
  // as another block in it. Background-only.
  | "completionBg"
  // 2026-09-02 (round three, item 7): the reasoning-effort ladder as a
  // four-step ramp, darkest at `off` and brightest at `max`. Used both to
  // colour a level's NAME wherever `/effort` prints one and to tint the
  // composer's two border rules, so the current effort is legible from the
  // input box without reading anything. Pi's ladder has seven levels and
  // this ramp has four steps; `tui/effort.ts` owns the mapping and says so.
  | "effortOff"
  | "effortLow"
  | "effortMid"
  | "effortMax"
  // 2026-09-02 (round eleven, item 2): the full-row tints behind an added
  // and a removed diff line. Background-only, and deliberately far weaker
  // than every other `*Bg` token in this list — the request set the bar
  // itself ("dont make the red and green to noticeable, just enough for
  // the words to still be easily readable while still distinguishable
  // from the background"), which is a fill the eye reads as a band rather
  // than as a highlight.
  | "addedBg"
  | "removedBg"
  // 2026-09-02 (round eleven, item 1): the tint under whatever clickable
  // thing the mouse is currently over — an approval's pills, a fold hint,
  // a link. Background-only, and stronger than the diff bands above
  // because it is transient and has to be found instantly, the same
  // reasoning `selectionBg` already carries.
  | "hoverBg";

/** Every shipped palette must define every token — see palettes.ts. */
export type PaletteHex = Record<SemanticToken, string>;

export interface Palette {
  name: string;
  source: string;
  checked: string; // ISO date the hex values were last verified against source
  tokens: PaletteHex;
}

export type ColorCapability = "truecolor" | "ansi256" | "ansi16" | "none";
export type GlyphSet = "unicode" | "ascii" | "nerdfont";

export interface GlyphMap {
  full: string;
  empty: string;
  hbar: string;
  vbar: string;
  corner: string;
  /** T51.2: box-drawing corners, so a full box (T49's approval modal) has an ascii/nerdfont equivalent instead of mixing a unicode corner into an otherwise-ascii border. */
  boxTL: string;
  boxTR: string;
  boxBL: string;
  boxBR: string;
  /** Table junctions (2026-09-02 round six, item 2) — a GFM table is drawn as a real ruled box, which needs the four tees and the cross as well as the corners. */
  teeDown: string;
  teeUp: string;
  teeLeft: string;
  teeRight: string;
  cross: string;
  up: string;
  down: string;
  diamond: string;
  /** The marker that opens an assistant reply — one dot per answer, so a reader can find where each answer starts without reading it. */
  bullet: string;
  bolt: string;
  write: string; // cache-write counter (§2.2's "✎")
  arrowUp: string;
  arrowDown: string;
  check: string;
  warnGlyph: string;
}

/**
 * VS15, the variation selector that asks for a glyph's *text* presentation
 * rather than its emoji one (2026-09-02 UI feedback, item 3: "the emoji
 * overlap on some character").
 *
 * `⚠`, `✓` and `✎` are East Asian **Ambiguous**: the terminal advances the
 * cursor one cell for them, but a font that has a colour emoji for the
 * same code point draws it two cells wide, so the glyph bleeds over
 * whatever comes next — which is exactly what `⚠exit unknown` in the
 * report is. VS15 selects the monochrome text glyph, which is drawn in the
 * one cell the terminal actually reserved. It is zero-width by definition
 * (`width.ts` counts it as 0), so no measurement changes, and a terminal
 * that ignores variation selectors renders exactly what it renders today —
 * this can only help.
 *
 * `⚡` deliberately does NOT get one. It is East Asian **Wide**: the
 * terminal reserves two cells and the font fills two cells, so there is
 * nothing to correct — the bug there was Lykos counting it as one column,
 * fixed in `width.ts` instead.
 */
const TEXT_PRESENTATION = "\uFE0E";

export const GLYPHS: Record<GlyphSet, GlyphMap> = {
  unicode: {
    full: "█",
    empty: "░",
    hbar: "─",
    vbar: "│",
    corner: "└",
    boxTL: "┌",
    boxTR: "┐",
    boxBL: "└",
    boxBR: "┘",
    teeDown: "┬",
    teeUp: "┴",
    teeLeft: "┤",
    teeRight: "├",
    cross: "┼",
    up: "▲",
    down: "▼",
    diamond: "◆",
    bullet: "●",
    bolt: "⚡",
    write: `✎${TEXT_PRESENTATION}`,
    arrowUp: "↑",
    arrowDown: "↓",
    check: `✓${TEXT_PRESENTATION}`,
    warnGlyph: `⚠${TEXT_PRESENTATION}`,
  },
  ascii: {
    full: "#",
    empty: "-",
    hbar: "-",
    vbar: "|",
    corner: "\\",
    boxTL: "+",
    boxTR: "+",
    boxBL: "+",
    boxBR: "+",
    teeDown: "+",
    teeUp: "+",
    teeLeft: "+",
    teeRight: "+",
    cross: "+",
    up: "^",
    down: "v",
    diamond: "*",
    bullet: "o",
    bolt: "!",
    write: "~",
    arrowUp: "+",
    arrowDown: "-",
    check: "v",
    warnGlyph: "!",
  },
  // Opt-in only (docs §5.4) — never selected by auto-detection.
  nerdfont: {
    full: "█",
    empty: "░",
    hbar: "─",
    vbar: "│",
    corner: "└",
    boxTL: "┌",
    boxTR: "┐",
    boxBL: "└",
    boxBR: "┘",
    teeDown: "┬",
    teeUp: "┴",
    teeLeft: "┤",
    teeRight: "├",
    cross: "┼",
    up: "▲",
    down: "▼",
    diamond: "",
    bullet: "●",
    bolt: "",
    write: "✎",
    arrowUp: "↑",
    arrowDown: "↓",
    check: "",
    warnGlyph: "",
  },
};
