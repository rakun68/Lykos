// User theme files (docs/07-ui-and-hud.md §6): data, not a fork of the
// renderer. Resolved project → global → shipped; `extends` inherits tokens.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { SHIPPED_PALETTES } from "./palettes.js";
import type { Palette, PaletteHex, SemanticToken } from "./types.js";

const SEMANTIC_TOKENS: SemanticToken[] = [
  "bg",
  "panel",
  "border",
  "text",
  "dim",
  "faint",
  "accent",
  "spend",
  "avoided",
  "cache",
  "delegate",
  "ok",
  "warn",
  "danger",
  // T51.1: without these here, a user theme setting e.g. `tokens.thinking`
  // would parse fine and then be silently dropped by mergeTokens() below,
  // which only ever reads keys from this list — the token would exist on
  // the type, be recognised nowhere, and the user's colour choice would
  // never take effect with no error telling them why.
  "thinking",
  "speech",
  "costed",
  "local",
  "added",
  "removed",
  "modalBg",
  // T51.3 (2026-09-01): same trap as the comment above already names —
  // added to SemanticToken in types.ts but missed here on first landing,
  // which would have made `tokens.userBg`/etc. in a user theme file fail
  // validation as an "unknown token" instead of taking effect.
  "userBg",
  "thinkingBg",
  "readBg",
  "code",
];
const SEMANTIC_TOKEN_SET = new Set<string>(SEMANTIC_TOKENS);

export interface ThemeLoadRoots {
  /** Project root (contains `.lykos/`). */
  cwd?: string;
  /** Global Lykos dir (default `~/.lykos`). */
  globalDir?: string;
}

interface ThemeFile {
  name?: string;
  extends?: string;
  source?: string;
  checked?: string;
  tokens?: Partial<Record<SemanticToken, string>>;
}

let cachedParseYaml: ((input: string) => unknown) | undefined;

function parseYaml(raw: string): unknown {
  if (!cachedParseYaml) {
    const req = createRequire(import.meta.url);
    cachedParseYaml = (req("yaml") as { parse: (input: string) => unknown }).parse;
  }
  return cachedParseYaml(raw);
}

function themesDir(root: string): string {
  return join(root, "themes");
}

function projectThemesDir(cwd: string): string {
  return join(cwd, ".lykos", "themes");
}

function isPathLike(name: string): boolean {
  return name.includes("/") || name.includes("\\") || name.endsWith(".yaml") || name.endsWith(".yml");
}

function readThemeFile(path: string): ThemeFile {
  const parsed = parseYaml(readFileSync(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`lykos theme: ${path} did not parse to an object`);
  }
  return parsed as ThemeFile;
}

function resolveThemePath(name: string, roots: ThemeLoadRoots): string | null {
  if (isPathLike(name)) {
    const path = isAbsolute(name) ? name : join(roots.cwd ?? process.cwd(), name);
    return existsSync(path) ? path : null;
  }
  const candidates: string[] = [];
  if (roots.cwd) candidates.push(join(projectThemesDir(roots.cwd), `${name}.yaml`));
  const globalDir = roots.globalDir ?? join(homedir(), ".lykos");
  candidates.push(join(themesDir(globalDir), `${name}.yaml`));
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * T51.1's "user-palette validation": a key in the file's `tokens:` map that
 * isn't a real `SemanticToken` fails loudly, naming the key and the file —
 * silently ignoring an unrecognised token (which is what happened to
 * `thinking`/`speech`/`costed`/`local`/`added`/`removed`/`modalBg` before
 * they were added to `SEMANTIC_TOKENS` above) is a worse failure mode than
 * a startup error, per this project's own "record failures" rule.
 */
function validateTokenKeys(override: Partial<Record<SemanticToken, string>>, path: string): void {
  for (const key of Object.keys(override)) {
    if (!SEMANTIC_TOKEN_SET.has(key)) {
      throw new Error(`lykos theme: ${path} sets unknown token "${key}" — not a recognised SemanticToken`);
    }
  }
}

function mergeTokens(base: PaletteHex, override: Partial<Record<SemanticToken, string>> | undefined, path: string): PaletteHex {
  if (!override) return { ...base };
  validateTokenKeys(override, path);
  const out = { ...base };
  for (const token of SEMANTIC_TOKENS) {
    const v = override[token];
    if (typeof v === "string" && v.length > 0) out[token] = v;
  }
  return out;
}

/**
 * Resolve a palette by shipped name, user theme name, or path. Cycles in
 * `extends` throw. Unknown names fall back to rose-pine-moon only when
 * `fallback` is true (the resolveTheme default); otherwise throw.
 */
export function loadPalette(name: string, roots: ThemeLoadRoots = {}, opts: { fallback?: boolean } = {}): Palette {
  const fallback = opts.fallback !== false;
  const seen = new Set<string>();

  const load = (ref: string): Palette => {
    if (seen.has(ref)) {
      throw new Error(`lykos theme: cycle in extends involving "${ref}"`);
    }
    seen.add(ref);

    const shipped = SHIPPED_PALETTES[ref];
    if (shipped && !isPathLike(ref)) {
      return shipped;
    }

    const path = resolveThemePath(ref, roots);
    if (!path) {
      if (fallback) return SHIPPED_PALETTES["rose-pine-moon"]!;
      throw new Error(`lykos theme: no theme named "${ref}" (shipped, ~/.lykos/themes/, or .lykos/themes/)`);
    }

    const file = readThemeFile(path);
    const parentName = file.extends;
    const parent = parentName ? load(parentName) : SHIPPED_PALETTES["rose-pine-moon"]!;
    const fileName = file.name ?? basename(path).replace(/\.ya?ml$/i, "");
    return {
      name: fileName,
      source: file.source ?? path,
      checked: file.checked ?? "unverified",
      tokens: mergeTokens(parent.tokens as PaletteHex, file.tokens, path),
    };
  };

  if (name === "auto") {
    // Light-bg detection is optional; dark default is cheap to override (§5.3).
    return SHIPPED_PALETTES["rose-pine-moon"]!;
  }

  return load(name);
}

export function listShippedThemeNames(): string[] {
  return Object.keys(SHIPPED_PALETTES).sort();
}

export function listUserThemeNames(roots: ThemeLoadRoots): string[] {
  const names = new Set<string>();
  const dirs: string[] = [];
  if (roots.cwd) dirs.push(projectThemesDir(roots.cwd));
  dirs.push(themesDir(roots.globalDir ?? join(homedir(), ".lykos")));
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith(".yaml") || entry.endsWith(".yml")) {
        names.add(entry.replace(/\.ya?ml$/i, ""));
      }
    }
  }
  return [...names].sort();
}
