// `lykos theme list | preview | eject` — judge a palette in the terminal it
// will run in (docs/07-ui-and-hud.md §6), not from hex on a page.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { derive } from "../tui/derive.js";
import { stdoutWrite } from "../tui/io-mode.js";
import { renderTriadLine } from "../tui/renderers/line.js";
import { renderWatchFrame } from "../tui/renderers/watch.js";
import { ensureBuiltinSegments } from "../tui/segments/builtin.js";
import { renderFormat } from "../tui/segments/registry.js";
import { listShippedThemeNames, listUserThemeNames, loadPalette } from "../tui/theme/load.js";
import { detectColorCapability, detectGlyphSet, resolveTheme, style, type ColorFlag } from "../tui/theme/resolve.js";
import { GLYPHS, type SemanticToken } from "../tui/theme/types.js";
import type { ResolvedConfig } from "../config/types.js";
import type { Snapshot, ViewModel } from "../tui/types.js";

export interface RunThemeOptions {
  cwd: string;
  resolved: ResolvedConfig;
  colorFlag?: ColorFlag;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
}

function sampleVm(): ViewModel {
  const snap: Snapshot = {
    now: new Date("2026-08-31T12:00:00Z"),
    run: {
      sessionId: "preview-session",
      brief: "theme preview",
      startedUtc: "2026-08-31T11:59:00Z",
      heartbeatUtc: "2026-08-31T12:00:00Z",
      endedUtc: null,
      outcome: null,
      outcomeSource: null,
      totals: {
        costUsd: 0.038,
        input: 42100,
        output: 3800,
        cacheRead: 38400,
        cacheWrite: 2100,
        reasoning: 0,
        calls: 4,
      },
      lastCall: {
        tsUtc: "2026-08-31T12:00:00Z",
        agent: "worker",
        phase: "implement",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        contextBefore: 50000,
        contextAfter: 52000,
        toolSchemaTokens: 4200,
        toolCount: 8,
        prefixChanged: false,
      },
    },
    today: { date: "2026-08-31", spentUsd: 0.41, sessions: 3, successes: 2 },
    budget: { perRunUsd: 0.5, perDayUsd: 2.0, onExceed: "stop" },
    parentContext: { usedTokens: 116000, totalTokens: 200000, usedPercentage: 0.58 },
    rateLimits: null,
    delegateContextTokens: 1_000_000,
  };
  return derive(snap);
}

export function runThemeList(opts: RunThemeOptions): number {
  const shipped = listShippedThemeNames();
  const user = listUserThemeNames({ cwd: opts.cwd });
  stdoutWrite("shipped:\n");
  for (const name of shipped) stdoutWrite(`  ${name}\n`);
  stdoutWrite("user (.lykos/themes / ~/.lykos/themes):\n");
  if (user.length === 0) stdoutWrite("  (none)\n");
  else for (const name of user) stdoutWrite(`  ${name}\n`);
  stdoutWrite(`active: ${opts.resolved.ui.theme}\n`);
  return 0;
}

export function runThemePreview(opts: RunThemeOptions, name: string): number {
  ensureBuiltinSegments();
  let palette;
  try {
    palette = loadPalette(name, { cwd: opts.cwd }, { fallback: false });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  const capability = detectColorCapability({
    env: opts.env,
    isTTY: opts.isTTY,
    ...(opts.colorFlag !== undefined ? { colorFlag: opts.colorFlag } : {}),
  });
  const glyphs =
    opts.resolved.ui.glyphs === "unicode" ? detectGlyphSet(opts.env) : opts.resolved.ui.glyphs;
  const theme = resolveTheme(name, capability, glyphs, { cwd: opts.cwd });
  const vm = sampleVm();
  const width = Number(opts.env.COLUMNS) || 100;

  stdoutWrite(`theme ${palette.name}  source ${palette.source}  checked ${palette.checked}\n`);
  stdoutWrite(`capability ${capability}  glyphs ${glyphs}\n\n`);
  // T51.1: every semantic token, including the seven the full-screen
  // surface added — "shows the new tokens for all five palettes" is
  // otherwise unverifiable by eye, since none of them appear in the triad,
  // the hud format, or the watch sample below.
  stdoutWrite("tokens:\n");
  for (const token of Object.keys(palette.tokens) as SemanticToken[]) {
    const swatch = style(GLYPHS[glyphs].full.repeat(3), token, theme);
    stdoutWrite(`  ${swatch}  ${token}\n`);
  }
  stdoutWrite("\n");
  stdoutWrite("triad:\n");
  stdoutWrite(renderTriadLine(vm, { width, theme }) + "\n\n");
  stdoutWrite("hud format:\n");
  stdoutWrite(
    renderFormat(opts.resolved.ui.hud.format, vm, { theme, width }) + "\n\n",
  );
  stdoutWrite("watch sample:\n");
  stdoutWrite(
    renderWatchFrame(vm, {
      width,
      height: 40,
      theme,
      panels: ["now", "cost", "tokens", "health"],
      source: "live",
    }) + "\n",
  );
  return 0;
}

/**
 * `lykos theme eject [base] [name]` — 2026-09-02 UI feedback: "there
 * should be a theme file to edit this." The mechanism (`.lykos/themes/
 * <name>.yaml`, `extends` a shipped palette, override just the tokens you
 * want) already existed (`tui/theme/load.ts`) but nothing surfaced it —
 * a user had to already know the exact YAML schema to write one by hand.
 * This writes a real, ready-to-edit file: every token commented out at
 * its current value (inherited from `base`), so editing means uncommenting
 * one line and changing a hex, not starting from a blank schema.
 *
 * Refuses to overwrite an existing file rather than silently clobbering
 * whatever the user already edited there — same default as everywhere
 * else in this package that writes into `.lykos/`.
 */
export function runThemeEject(opts: RunThemeOptions, baseName?: string, outName?: string): number {
  const base = baseName ?? opts.resolved.ui.theme;
  const name = outName ?? "custom";
  let palette;
  try {
    palette = loadPalette(base, { cwd: opts.cwd }, { fallback: false });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  const dir = join(opts.cwd, ".lykos", "themes");
  const path = join(dir, `${name}.yaml`);
  if (existsSync(path)) {
    process.stderr.write(`lykos theme eject: ${path} already exists — edit it directly, or pass a different name (\`lykos theme eject ${base} <name>\`)\n`);
    return 1;
  }

  const tokenLines = (Object.keys(palette.tokens) as SemanticToken[])
    .map((token) => `  # ${token}: "${palette.tokens[token] || "(no colour — this token is unset on this palette)"}"`)
    .join("\n");

  const content = `# Generated by \`lykos theme eject ${base} ${name}\` — edit freely.
# Every token below is commented out at the value it currently inherits
# from "extends". Uncomment a line and change the hex to override just
# that one token; leave a line commented to keep inheriting it.
# Run \`lykos theme preview ${name}\` to see the result before switching to
# it (set \`ui.theme: ${name}\` in .lykos/config.yaml).
name: ${name}
extends: ${base}
source: "hand-edited, based on ${base}"
checked: unverified — this is your own file, not a shipped palette

tokens:
${tokenLines}
`;

  mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, "utf8");
  stdoutWrite(`wrote ${path}\n`);
  stdoutWrite(`edit it, then set \`ui.theme: ${name}\` in .lykos/config.yaml (or \`lykos theme preview ${name}\` first)\n`);
  return 0;
}
