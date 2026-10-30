// S1 — the Claude Code status-line adapter (docs/07-ui-and-hud.md §1.3,
// T4.4). The only surface that shows both sides of the project's argument at
// once: the parent's own context/cost (from Claude Code's stdin JSON) beside
// the delegate's token flow (from the ledger, via the live cache).
//
// `avoided` is deliberately never rendered here — open question in
// docs/07-ui-and-hud.md §10 answers "no" for S1/S2 by default
// (ui.hud.show_avoided). Live, per-turn avoided cost specifically risks
// encouraging gaming one's own metric (§10); end-of-session reporting stays
// the honest place for it regardless of how much of T6 has landed.
//
// T38: line 1 is a segment-registry format string (`ui.statusline.format`).

import { fmtPct, fmtTokens, fmtUsd } from "../format.js";
import { ensureBuiltinSegments } from "../segments/builtin.js";
import { renderFormat, validateFormat } from "../segments/registry.js";
import type { ResolvedTheme } from "../theme/resolve.js";
import { style } from "../theme/resolve.js";
import { GLYPHS } from "../theme/types.js";
import type { ViewModel } from "../types.js";

export interface StatuslineMeta {
  parentModelName: string | null;
  delegateModelName: string | null;
  delegateCalls: number;
}

export interface StatuslineOptions {
  width: number;
  theme: ResolvedTheme;
  meta: StatuslineMeta;
  /** From ui.statusline.format — unknown names fail at validateFormat. */
  format?: string;
  delegateLine?: boolean;
}

function parentLineFromFormat(vm: ViewModel, opts: StatuslineOptions): string {
  ensureBuiltinSegments();
  const format = opts.format ?? "{model} {context} | {cost} | {rate_limits}";
  validateFormat(format);
  return renderFormat(format, vm, {
    theme: opts.theme,
    width: opts.width,
    meta: {
      parentModelName: opts.meta.parentModelName,
      delegateModelName: opts.meta.delegateModelName,
      delegateCalls: opts.meta.delegateCalls,
    },
  });
}

function delegateLine(vm: ViewModel, opts: StatuslineOptions): string | null {
  const { width, theme, meta } = opts;
  if (meta.delegateCalls === 0) return null;
  const g = GLYPHS[theme.glyphs];
  const model = meta.delegateModelName ?? "delegate";
  const countBadge = meta.delegateCalls > 1 ? ` ×${meta.delegateCalls}` : "";
  const head = style(`${g.corner} lykos ${model}${countBadge}`, "delegate", theme);

  if (width < 80) return `${head}  ${style(fmtUsd(vm.cost.runUsd), "spend", theme)}`;

  const flow = [
    style(`${g.arrowUp}${fmtTokens(vm.tokens.counters.fresh)}`, "text", theme),
    style(`${g.bolt}${fmtTokens(vm.tokens.counters.cacheRead)} ${fmtPct(vm.tokens.hitRatio)}`, "cache", theme),
    style(`${g.arrowDown}${fmtTokens(vm.tokens.counters.output)}`, "text", theme),
  ].join(" ");
  return `${head}  ${flow}  ${style(fmtUsd(vm.cost.runUsd), "spend", theme)}`;
}

/**
 * Two lines matching the docs/07-ui-and-hud.md §1.3 example. The second line
 * — the whole thesis made visible — is dropped when no delegate has run yet.
 * Line 1 is the segment-registry format string (T38).
 */
export function renderStatusline(vm: ViewModel, opts: StatuslineOptions): string {
  const line1 = parentLineFromFormat(vm, opts);
  if (opts.delegateLine === false) return line1;
  const line2 = delegateLine(vm, opts);
  return line2 ? `${line1}\n${line2}` : line1;
}
