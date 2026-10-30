// Colour degradation ladder (docs/07-ui-and-hud.md §5.3): detect once, cache
// for the process. truecolor -> exact hex; 256 -> quantised at load, not per
// render; 16 -> the ansi16 theme wholesale, never a quantised pastel; none ->
// NO_COLOR / TERM=dumb / not-a-tty renders the mono theme with zero escapes.

import { loadPalette, type ThemeLoadRoots } from "./load.js";
import { ANSI16, SHIPPED_PALETTES } from "./palettes.js";
import type { ColorCapability, GlyphSet, Palette, SemanticToken } from "./types.js";

export type { ThemeLoadRoots };

export type ColorFlag = "auto" | "always" | "never" | "16" | "256" | "truecolor";

export interface DetectColorOptions {
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  /**
   * S1's stdout is captured, not a TTY, and the doc says it "assumes colour
   * is wanted unless NO_COLOR says otherwise" — set true for that surface.
   */
  assumeColorWhenNotTty?: boolean;
  colorFlag?: ColorFlag;
}

export function detectColorCapability(opts: DetectColorOptions): ColorCapability {
  const { env, isTTY, colorFlag } = opts;

  // NO_COLOR is honoured unconditionally (§5.3), ahead of any flag.
  if (env.NO_COLOR !== undefined) return "none";

  if (colorFlag === "never") return "none";
  if (colorFlag === "always") return "truecolor";
  if (colorFlag === "truecolor") return "truecolor";
  if (colorFlag === "256") return "ansi256";
  if (colorFlag === "16") return "ansi16";

  if (env.TERM === "dumb") return "none";
  if (!isTTY && !opts.assumeColorWhenNotTty && env.CLICOLOR_FORCE === undefined) return "none";
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return "truecolor";
  if (env.TERM && /256color/.test(env.TERM)) return "ansi256";
  // Native Windows terminals fully support truecolor VT but, unlike most
  // Unix terminal emulators, do not set COLORTERM — `TERM` itself is
  // typically unset entirely on Windows, since it is a Unix convention.
  // Without this, every native-Windows session silently fell all the way
  // through to `ansi16`, which is a fixed, unthemeable palette (see this
  // function's caller, `resolveTheme()`'s ansi16 branch: it uses `ANSI16`
  // regardless of the requested palette name) — so no theme choice, shipped
  // or user, ever visibly took effect there (2026-09-02 UI feedback:
  // reported three times as "still purple" no matter what was changed).
  // `WT_SESSION` is Windows Terminal's own env var, set for the life of
  // the session; `TERM_PROGRAM=vscode` is VS Code's integrated terminal.
  // Both are the same well-established signals `supports-color`/chalk use
  // for this exact case, not a Lykos invention.
  if (env.WT_SESSION !== undefined || env.TERM_PROGRAM === "vscode") return "truecolor";
  return "ansi16";
}

export function detectGlyphSet(env: NodeJS.ProcessEnv): GlyphSet {
  if (env.LYKOS_ASCII === "1") return "ascii";
  if (env.TERM === "dumb") return "ascii";
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  if (locale !== "" && !/utf-?8/i.test(locale)) return "ascii";
  return "unicode";
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

/** Standard 6x6x6 cube + greyscale-ramp quantisation to an xterm-256 index. */
function rgbToAnsi256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const toCube = (c: number) => Math.round((c / 255) * 5);
  return 16 + 36 * toCube(r) + 6 * toCube(g) + toCube(b);
}

const ANSI16_CODES: Record<string, number> = {
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  brightblack: 90,
  brightred: 91,
  brightgreen: 92,
  brightyellow: 93,
  brightblue: 94,
  brightmagenta: 95,
  brightcyan: 96,
  brightwhite: 97,
};

const RESET = "\x1b[0m";

/** token -> the ANSI prefix to write before text, or "" for the mono/none theme. */
export type ResolvedTheme = {
  capability: ColorCapability;
  glyphs: GlyphSet;
  prefixFor(token: SemanticToken): string;
  /**
   * T51.3: the background-colour counterpart to `prefixFor` — SGR 48 (bg)
   * instead of 38 (fg). Only the three `*Bg` tokens carry a meaningful
   * value in any shipped palette; calling this for a foreground-only token
   * is legal and simply returns "" if the palette has no hex for it (mono
   * always does). Kept as a separate function rather than an optional
   * second argument on `prefixFor` so every existing call site is
   * unaffected.
   */
  bgPrefixFor(token: SemanticToken): string;
};

export function resolvePalette(name: string, roots: ThemeLoadRoots = {}): Palette {
  if (SHIPPED_PALETTES[name]) return SHIPPED_PALETTES[name]!;
  return loadPalette(name, roots, { fallback: true });
}

export function resolveTheme(
  paletteName: string,
  capability: ColorCapability,
  glyphs: GlyphSet,
  roots: ThemeLoadRoots = {},
): ResolvedTheme {
  if (capability === "none") {
    return { capability, glyphs, prefixFor: () => "", bgPrefixFor: () => "" };
  }
  if (capability === "ansi16") {
    const palette = ANSI16;
    return {
      capability,
      glyphs,
      prefixFor: (token) => {
        const code = ANSI16_CODES[palette.tokens[token]];
        return code === undefined ? "" : `\x1b[${code}m`;
      },
      // Standard SGR: a background code is the foreground code + 10
      // (30->40, 90->100) for every one of the 16 standard colours.
      bgPrefixFor: (token) => {
        const code = ANSI16_CODES[palette.tokens[token]];
        return code === undefined ? "" : `\x1b[${code + 10}m`;
      },
    };
  }

  const palette = resolvePalette(paletteName, roots);
  if (palette.name === "mono" || palette.name === "ansi16") {
    return resolveTheme("rose-pine-moon", capability, glyphs, roots);
  }

  if (capability === "truecolor") {
    const cache = new Map<SemanticToken, string>();
    const bgCache = new Map<SemanticToken, string>();
    return {
      capability,
      glyphs,
      prefixFor: (token) => {
        const cached = cache.get(token);
        if (cached !== undefined) return cached;
        const hex = palette.tokens[token];
        const prefix = hex ? (() => {
          const [r, g, b] = hexToRgb(hex);
          return `\x1b[38;2;${r};${g};${b}m`;
        })() : "";
        cache.set(token, prefix);
        return prefix;
      },
      bgPrefixFor: (token) => {
        const cached = bgCache.get(token);
        if (cached !== undefined) return cached;
        const hex = palette.tokens[token];
        const prefix = hex ? (() => {
          const [r, g, b] = hexToRgb(hex);
          return `\x1b[48;2;${r};${g};${b}m`;
        })() : "";
        bgCache.set(token, prefix);
        return prefix;
      },
    };
  }

  // ansi256 — quantised once at theme load (§5.3), not per render.
  const quantised = new Map<SemanticToken, string>();
  const quantisedBg = new Map<SemanticToken, string>();
  for (const token of Object.keys(palette.tokens) as SemanticToken[]) {
    const hex = palette.tokens[token];
    if (!hex) {
      quantised.set(token, "");
      quantisedBg.set(token, "");
      continue;
    }
    const [r, g, b] = hexToRgb(hex);
    const idx = rgbToAnsi256(r, g, b);
    quantised.set(token, `\x1b[38;5;${idx}m`);
    quantisedBg.set(token, `\x1b[48;5;${idx}m`);
  }
  return {
    capability,
    glyphs,
    prefixFor: (token) => quantised.get(token) ?? "",
    bgPrefixFor: (token) => quantisedBg.get(token) ?? "",
  };
}

export function style(text: string, token: SemanticToken, theme: ResolvedTheme): string {
  const prefix = theme.prefixFor(token);
  return prefix ? `${prefix}${text}${RESET}` : text;
}

/**
 * Wraps an ALREADY-STYLED line (built from one or more `style()` calls) in
 * a full-width background colour, padded to `targetWidth` with plain
 * spaces so the tint fills the row rather than stopping at the last glyph.
 *
 * `style()`'s RESET (`\x1b[0m`) clears everything, foreground AND
 * background — approval-modal.ts named this exact problem in T51.2 as the
 * reason background support was deferred: a nested `style()` call inside
 * an already-bg-wrapped line would erase the background the moment its own
 * RESET fires. The fix is to re-open the background after every RESET
 * found inside `styledInner`, not to avoid nested styling — `renderUser`
 * needs the accent-coloured "> " prefix AND the body text to share one
 * background, and patching resets is what lets both survive.
 *
 * `visibleWidth` is the caller-supplied plain-text length of `styledInner`
 * (ANSI escapes have zero visible width, so it can't be measured off the
 * string itself without stripping codes back out).
 */
export function withBackground(
  styledInner: string,
  bgToken: SemanticToken,
  theme: ResolvedTheme,
  visibleWidth: number,
  targetWidth: number,
): string {
  const bgPrefix = theme.bgPrefixFor(bgToken);
  if (!bgPrefix) return styledInner;
  const patched = styledInner.split(RESET).join(RESET + bgPrefix);
  const pad = targetWidth > visibleWidth ? " ".repeat(targetWidth - visibleWidth) : "";
  return `${bgPrefix}${patched}${pad}${RESET}`;
}

/**
 * A background tint over a SPAN inside a line, not across a whole row —
 * the composer's selection highlight (2026-09-02 UI feedback: "choosing
 * whole word with cursor, drag select to copy… add everything a normal
 * editor has"). Unlike `withBackground`, this closes with SGR 49
 * (default background) rather than SGR 0 (reset everything), so the
 * foreground colour the caller opened around the whole line — the
 * composer's accent-coloured `> ` prompt, for instance — survives the end
 * of the selection instead of being cleared with it.
 */
export function withInlineBackground(text: string, bgToken: SemanticToken, theme: ResolvedTheme): string {
  const bgPrefix = theme.bgPrefixFor(bgToken);
  return bgPrefix ? `${bgPrefix}${text}\x1b[49m` : text;
}
