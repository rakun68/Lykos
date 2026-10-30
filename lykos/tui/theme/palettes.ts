// Shipped palettes (docs/07-ui-and-hud.md §5.2). Hex values transcribed
// verbatim from the doc, which records them as checked 2026-08-29 against
// rose-pine/neovim's palette.lua and catppuccin/palette's palette.json —
// "a value nobody can trace is a value nobody should trust," the same
// discipline as prices.yaml.

import type { Palette, PaletteHex } from "./types.js";

/**
 * Deterministic, auditable blend for a derived background tone (readBg) —
 * computed from the palette's own verified hex values rather than a
 * hand-picked magic colour, so the tint stays traceable to source the same
 * way every other token in this file is.
 */
function mix(hexA: string, hexB: string, t: number): string {
  const a = hexToRgbLocal(hexA);
  const b = hexToRgbLocal(hexB);
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bch = Math.round(a[2] + (b[2] - a[2]) * t);
  return `#${[r, g, bch].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgbLocal(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16), parseInt(clean.slice(4, 6), 16)];
}

function rosePine(role: {
  base: string;
  surface: string;
  overlay: string;
  muted: string;
  subtle: string;
  text: string;
  love: string;
  gold: string;
  pine: string;
  foam: string;
  iris: string;
  leaf: string;
}): PaletteHex {
  return {
    bg: role.base,
    panel: role.surface,
    border: role.overlay,
    text: role.text,
    dim: role.subtle,
    faint: role.muted,
    accent: role.iris,
    spend: role.gold,
    avoided: role.muted,
    cache: role.foam,
    delegate: role.pine,
    ok: role.leaf,
    warn: role.gold,
    danger: role.love,
    // T51.1
    thinking: role.subtle,
    speech: role.text,
    costed: role.gold,
    local: role.leaf,
    added: role.leaf,
    removed: role.love,
    modalBg: role.overlay,
    // T51.3, softened 2026-09-02 ("the background color for user prompt is
    // too bright"): the full-strength `overlay` chrome tone read as too
    // bright once it was painted across an entire multi-line paragraph
    // rather than used for a thin border — a highlight that reads fine as
    // an accent is not the same intensity as one that reads fine as a
    // fill. Both backgrounds are traceable blends of `base` and `overlay`
    // rather than reusing `overlay` at full strength, with userBg
    // deliberately the bolder of the two at 50% and thinkingBg the more
    // subtle at 15% (moved down from 25% in round three, see thinkingBg's
    // own comment below). readBg is a traceable blend of base and leaf
    // (green), the same discipline.
    userBg: mix(role.base, role.overlay, 0.5),
    // Moved from 0.25 to 0.15 toward `base` on 2026-09-02 (round four, item
    // 5: "make thinking background color a bit bolder (so thinking blends
    // more to the terminal)") — misattributed to "round three" in that
    // pass's own comment, corrected here. Read alongside "Thinking"
    // replacing "thinking" as a heading in the same request, this is a
    // block the maintainer wants to recede rather than assert itself —
    // closer to the terminal's own background is what "blends more" means
    // literally. Round five confirmed the direction was right and asked
    // for more of it ("Make Thinking background color be a bit darker"),
    // so this moved again, from 0.15 to 0.08.
    thinkingBg: mix(role.base, role.overlay, 0.08),
    readBg: mix(role.base, role.leaf, 0.35),
    // 2026-09-02: reuses the foam role (already `cache`'s colour) rather
    // than a new hex — the same "share a role's hex across tokens" pattern
    // `speech`/`avoided`/`costed`/`local` above already use.
    code: role.foam,
    // 2026-09-02 (editor round): the composer's selection highlight has to
    // be readable UNDER the text it covers, so it is a blend toward the
    // accent role rather than the accent itself — deliberately stronger
    // than `userBg` (50% overlay), because a selection is a transient
    // thing the eye must find instantly, unlike a block tint it lives with.
    selectionBg: mix(role.base, role.iris, 0.45),
    // 2026-09-02 (round three): a hair brighter than `text`, never a
    // different hue — "only slightly different, maybe brighter".
    strong: mix(role.text, "#ffffff", 0.45),
    // A tint of the pine role, so the popup is visibly not a user block
    // (overlay-grey) and not a read bar (leaf-green).
    completionBg: mix(role.base, role.pine, 0.4),
    // The effort ramp, on the foam role — the light blue the maintainer
    // asked for ("the color should be light blue like the theme of
    // lykos"), from a quarter strength at `off` to full foam at `max`.
    effortOff: mix(role.base, role.foam, 0.35),
    effortLow: mix(role.base, role.foam, 0.6),
    effortMid: mix(role.base, role.foam, 0.8),
    effortMax: role.foam,
    // 2026-09-02 (round eleven, item 2): a whole-row band behind every
    // added and removed diff line. 18% toward leaf/love, which is half
    // the strength of `readBg` (35%) and a third of `userBg` (50%) — the
    // request asked for the tint to be readable UNDER the line's own
    // green/red foreground rather than to compete with it, and a fill
    // that strong turns `added` text into a smear. Traceable blends of
    // the palette's own verified roles, same discipline as every other
    // derived tone in this file.
    addedBg: mix(role.base, role.leaf, 0.18),
    removedBg: mix(role.base, role.love, 0.18),
    // 2026-09-02 (round eleven, item 1): the hover tint, on the same iris
    // role as `selectionBg` but weaker (30% against 45%) — hovering is
    // not choosing, and the two must not look like the same state.
    hoverBg: mix(role.base, role.iris, 0.3),
  };
}

function catppuccin(role: {
  base: string;
  mantle: string;
  surface0: string;
  overlay0: string;
  overlay1: string;
  subtext0: string;
  text: string;
  mauve: string;
  peach: string;
  yellow: string;
  green: string;
  teal: string;
  blue: string;
  red: string;
}): PaletteHex {
  return {
    bg: role.base,
    panel: role.mantle,
    border: role.surface0,
    text: role.text,
    dim: role.subtext0,
    faint: role.overlay0,
    accent: role.mauve,
    spend: role.peach,
    avoided: role.overlay1,
    cache: role.teal,
    delegate: role.blue,
    ok: role.green,
    warn: role.yellow,
    danger: role.red,
    // T51.1
    thinking: role.subtext0,
    speech: role.text,
    costed: role.peach,
    local: role.green,
    added: role.green,
    removed: role.red,
    modalBg: role.surface0,
    // T51.3, softened 2026-09-02 — same reasoning as rosePine() above,
    // mapped onto Catppuccin's own role names: blends of base and surface0
    // rather than surface0 at full strength. thinkingBg moved to 0.15 in
    // round four, then to 0.08 in round five — same reasoning as
    // rosePine()'s own comment on that token.
    userBg: mix(role.base, role.surface0, 0.5),
    thinkingBg: mix(role.base, role.surface0, 0.08),
    readBg: mix(role.base, role.green, 0.35),
    // 2026-09-02: reuses the teal role (already `cache`'s colour).
    code: role.teal,
    // 2026-09-02 (editor round) — same reasoning as rosePine() above.
    selectionBg: mix(role.base, role.mauve, 0.45),
    // 2026-09-02 (round three) — same reasoning as rosePine() above.
    strong: mix(role.text, "#ffffff", 0.45),
    completionBg: mix(role.base, role.teal, 0.4),
    effortOff: mix(role.base, role.teal, 0.35),
    effortLow: mix(role.base, role.teal, 0.6),
    effortMid: mix(role.base, role.teal, 0.8),
    effortMax: role.teal,
    // 2026-09-02 (round eleven, item 2) — same reasoning as rosePine().
    addedBg: mix(role.base, role.green, 0.18),
    removedBg: mix(role.base, role.red, 0.18),
    // 2026-09-02 (round eleven, item 1) — same reasoning as rosePine().
    hoverBg: mix(role.base, role.mauve, 0.3),
  };
}

const CHECKED = "2026-08-29";

export const ROSE_PINE: Palette = {
  name: "rose-pine",
  source: "rose-pine/neovim lua/rose-pine/palette.lua",
  checked: CHECKED,
  tokens: rosePine({
    base: "#191724",
    surface: "#1f1d2e",
    overlay: "#26233a",
    muted: "#6e6a86",
    subtle: "#908caa",
    text: "#e0def4",
    love: "#eb6f92",
    gold: "#f6c177",
    pine: "#31748f",
    foam: "#9ccfd8",
    iris: "#c4a7e7",
    leaf: "#95b1ac",
  }),
};

export const ROSE_PINE_MOON: Palette = {
  name: "rose-pine-moon",
  source: "rose-pine/neovim lua/rose-pine/palette.lua",
  checked: CHECKED,
  tokens: rosePine({
    base: "#232136",
    surface: "#2a273f",
    overlay: "#393552",
    muted: "#6e6a86",
    subtle: "#908caa",
    text: "#e0def4",
    love: "#eb6f92",
    gold: "#f6c177",
    pine: "#3e8fb0",
    foam: "#9ccfd8",
    iris: "#c4a7e7",
    leaf: "#95b1ac",
  }),
};

export const ROSE_PINE_DAWN: Palette = {
  name: "rose-pine-dawn",
  source: "rose-pine/neovim lua/rose-pine/palette.lua",
  checked: CHECKED,
  tokens: rosePine({
    base: "#faf4ed",
    surface: "#fffaf3",
    overlay: "#f2e9e1",
    muted: "#9893a5",
    subtle: "#797593",
    text: "#464261",
    love: "#b4637a",
    gold: "#ea9d34",
    pine: "#286983",
    foam: "#56949f",
    iris: "#907aa9",
    leaf: "#6d8f89",
  }),
};

/**
 * Light-blue variant requested 2026-09-01 ("change theme color from that
 * purple to a light blue color"). Not a new set of hex values to verify —
 * every colour here is `rose-pine-moon`'s own already-checked palette
 * (`checked` date and `source` unchanged below), with `accent` (and
 * `delegate`, which shared the same purple-adjacent role) reassigned from
 * `iris` (purple) to `foam` (`#9ccfd8`, rose-pine's own light blue role)
 * instead of hand-picking an unverified new hex.
 */
export const SKY: Palette = {
  name: "sky",
  source: "rose-pine/neovim lua/rose-pine/palette.lua (moon variant, accent reassigned iris -> foam)",
  checked: CHECKED,
  tokens: {
    ...rosePine({
      base: "#232136",
      surface: "#2a273f",
      overlay: "#393552",
      muted: "#6e6a86",
      subtle: "#908caa",
      text: "#e0def4",
      love: "#eb6f92",
      gold: "#f6c177",
      pine: "#3e8fb0",
      foam: "#9ccfd8",
      iris: "#c4a7e7",
      leaf: "#95b1ac",
    }),
    accent: "#9ccfd8",
  },
};

export const CATPPUCCIN_MOCHA: Palette = {
  name: "catppuccin-mocha",
  source: "catppuccin/palette palette.json",
  checked: CHECKED,
  tokens: catppuccin({
    base: "#1e1e2e",
    mantle: "#181825",
    surface0: "#313244",
    overlay0: "#6c7086",
    overlay1: "#7f849c",
    subtext0: "#a6adc8",
    text: "#cdd6f4",
    mauve: "#cba6f7",
    peach: "#fab387",
    yellow: "#f9e2af",
    green: "#a6e3a1",
    teal: "#94e2d5",
    blue: "#89b4fa",
    red: "#f38ba8",
  }),
};

export const CATPPUCCIN_LATTE: Palette = {
  name: "catppuccin-latte",
  source: "catppuccin/palette palette.json",
  checked: CHECKED,
  tokens: catppuccin({
    base: "#eff1f5",
    mantle: "#e6e9ef",
    surface0: "#ccd0da",
    overlay0: "#9ca0b0",
    overlay1: "#8c8fa1",
    subtext0: "#6c6f85",
    text: "#4c4f69",
    mauve: "#8839ef",
    peach: "#fe640b",
    yellow: "#df8e1d",
    green: "#40a02b",
    teal: "#179299",
    blue: "#1e66f5",
    red: "#d20f39",
  }),
};

/** Portable fallback for 16-colour terminals — not a quantisation of another palette (§5.3). */
export const ANSI16: Palette = {
  name: "ansi16",
  source: "standard ANSI SGR 30-37 / 90-97",
  checked: CHECKED,
  tokens: {
    bg: "black",
    panel: "black",
    border: "white",
    text: "brightwhite",
    dim: "white",
    faint: "brightblack",
    accent: "brightmagenta",
    spend: "yellow",
    avoided: "brightblack",
    cache: "brightcyan",
    delegate: "blue",
    ok: "green",
    warn: "yellow",
    danger: "red",
    // T51.1
    thinking: "white",
    speech: "brightwhite",
    costed: "yellow",
    local: "green",
    added: "green",
    removed: "red",
    modalBg: "white",
    // T51.3, softened 2026-09-02: "white" read as harsh full-brightness
    // background across an entire paragraph ("too bright" — the same
    // report that led to detectColorCapability() gaining WT_SESSION
    // detection, since a native Windows terminal falling through to this
    // exact palette was the actual root cause). ansi16 has no blend
    // function to soften with, so this names the closest already-muted
    // standard colour instead: brightblack (dark grey), not white.
    // thinkingBg stays "black" — identical to `bg`, i.e. no visible fill
    // at all under this 16-colour fallback, which is the only way to make
    // it darker than brightblack in a 16-colour palette; the block's
    // structural marker (the "│ thinking" label and left-rule) is what
    // T44.2 relies on to keep it distinguishable when colour can't.
    userBg: "brightblack",
    thinkingBg: "black",
    readBg: "green",
    code: "cyan",
    strong: "brightwhite",
    completionBg: "blue",
    effortOff: "black",
    effortLow: "blue",
    effortMid: "cyan",
    effortMax: "brightcyan",
    // No blend function in a 16-colour palette; "blue" is the closest
    // standard colour that stays legible under `text`/`brightwhite`.
    selectionBg: "blue",
    // 2026-09-02 (round eleven, item 2). ansi16 cannot blend, and a
    // full-strength "green"/"red" fill behind a whole diff line is
    // exactly the "too noticeable" the request rules out — so the tint is
    // dropped entirely here and the `+`/`-` marker plus the foreground
    // colour carry the distinction, as they did before this round. An
    // empty hex resolves to no background prefix at all (see
    // `resolveTheme`'s ansi16 branch), which is a deliberate no-op, not a
    // missing value.
    addedBg: "",
    removedBg: "",
    // The one background this palette does keep: hover is transient and
    // has no other marker to fall back on, unlike a diff line's own
    // `+`/`-`. "blue" is the same choice `selectionBg` makes here.
    hoverBg: "blue",
  },
};

/** No colour, glyph-and-weight only (§5.3 capability "none" / NO_COLOR). */
export const MONO: Palette = {
  name: "mono",
  source: "n/a — no colour is emitted for this theme",
  checked: CHECKED,
  tokens: {
    bg: "",
    panel: "",
    border: "",
    text: "",
    dim: "",
    faint: "",
    accent: "",
    spend: "",
    avoided: "",
    cache: "",
    delegate: "",
    ok: "",
    warn: "",
    danger: "",
    // T51.1
    thinking: "",
    speech: "",
    costed: "",
    local: "",
    added: "",
    removed: "",
    modalBg: "",
    userBg: "",
    thinkingBg: "",
    readBg: "",
    code: "",
    selectionBg: "",
    strong: "",
    completionBg: "",
    effortOff: "",
    effortLow: "",
    effortMid: "",
    effortMax: "",
    addedBg: "",
    removedBg: "",
    hoverBg: "",
  },
};

export const SHIPPED_PALETTES: Record<string, Palette> = {
  "rose-pine": ROSE_PINE,
  "rose-pine-moon": ROSE_PINE_MOON,
  "rose-pine-dawn": ROSE_PINE_DAWN,
  sky: SKY,
  "catppuccin-mocha": CATPPUCCIN_MOCHA,
  "catppuccin-latte": CATPPUCCIN_LATTE,
  ansi16: ANSI16,
  mono: MONO,
};
