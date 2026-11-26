// S2 — the stderr HUD (docs/07-ui-and-hud.md §1.3, T4.3): one line, per
// turn, triad only. The fallback surface for an MCP host with no status
// line. Format follows docs/03-telemetry.md §1.1's own example, honestly cut
// down to what a live.json snapshot actually carries today — there is no
// separate "turn" counter or tool-call counter in the live cache yet
// (T9's transcript capture is what will add per-turn granularity), so this
// uses the call count it does have rather than inventing a turn number.

import { fmtPct, fmtTokens, fmtUsd } from "../format.js";
import type { ResolvedTheme } from "../theme/resolve.js";
import { style } from "../theme/resolve.js";
import { GLYPHS } from "../theme/types.js";
import type { ViewModel } from "../types.js";

export interface StderrLineOptions {
  theme: ResolvedTheme;
  elapsedMs?: number;
}

function fmtElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function renderStderrLine(vm: ViewModel, opts: StderrLineOptions): string {
  const { theme } = opts;
  const g = GLYPHS[theme.glyphs];
  const parts = [
    style(g.diamond, "accent", theme) + " lykos",
    `${vm.tokens.calls} calls`,
  ];
  parts.push(
    style(`${g.arrowUp}${fmtTokens(vm.tokens.counters.fresh)}`, "text", theme) +
      " " +
      style(`${g.arrowDown}${fmtTokens(vm.tokens.counters.output)}`, "text", theme),
  );
  parts.push(
    style(`${g.bolt}${fmtTokens(vm.tokens.counters.cacheRead)} cached (${fmtPct(vm.tokens.hitRatio)})`, "cache", theme),
  );
  if (opts.elapsedMs !== undefined) parts.push(fmtElapsed(opts.elapsedMs));
  parts.push(style(fmtUsd(vm.cost.runUsd), "spend", theme));

  const topAlert = [...vm.alerts].sort((a, b) => (b.severity === "danger" ? 1 : 0) - (a.severity === "danger" ? 1 : 0))[0];
  if (topAlert) {
    parts.push(
      style(`${g.warnGlyph}${topAlert.id}`, topAlert.severity === "danger" ? "danger" : "warn", theme),
    );
  }

  return parts.join(`  ${g.vbar}  `);
}
