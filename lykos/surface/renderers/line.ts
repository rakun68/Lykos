// The width degradation ladder (docs/07-ui-and-hud.md §4): whole segments
// drop in reverse tier order as the line narrows. Never wrap, never
// half-print a number — "a truncated $0.03… is worse than no cost segment
// at all, because it reads as a number and is not one." Shared by S1 and S2;
// S1 adds the delegate row and stdin-JSON fields on top of this.

import { fmtPct, fmtTokens, fmtUsd, gauge } from "../format.js";
import { stringWidth } from "../width.js";
import type { ResolvedTheme } from "../theme/resolve.js";
import { style } from "../theme/resolve.js";
import { GLYPHS } from "../theme/types.js";
import type { ViewModel } from "../types.js";

export interface TriadLineOptions {
  width: number;
  theme: ResolvedTheme;
}

/**
 * Highest-severity alert only, with a `+N` badge for the rest (§3.1).
 *
 * The space after the glyph is load-bearing (2026-09-02 round three, item
 * 9: "the pencil icon is still on top of a number... and the warning sign
 * overlap with some number too"). `⚠` and `✎` are East Asian **Ambiguous**:
 * the terminal advances one cell, and a font that falls back to a colour
 * emoji for the same code point paints two — so the glyph bleeds over
 * whatever is drawn immediately to its right. Round two asked for the
 * monochrome form with U+FE0E and the report says that was not enough on
 * this terminal. A following space is the fix that does not depend on the
 * font honouring anything: the bleed lands on a blank cell.
 */
function alertBadge(vm: ViewModel, theme: ResolvedTheme): string {
  if (vm.alerts.length === 0) return "";
  const order = { danger: 2, warn: 1, info: 0 } as const;
  const top = [...vm.alerts].sort((a, b) => order[b.severity] - order[a.severity])[0]!;
  const glyph = GLYPHS[theme.glyphs].warnGlyph;
  const rest = vm.alerts.length - 1;
  const text = rest > 0 ? `${glyph} ${top.id} +${rest}` : `${glyph} ${top.id}`;
  return style(text, top.severity === "danger" ? "danger" : "warn", theme);
}

/**
 * `deepseek-v4-pro · high`, right-aligned on the footer's last row —
 * 2026-09-02 UI feedback item 6, quoted almost verbatim ("add model and
 * thinking effort on the right bottom corner").
 *
 * Empty when there is no model to name; the effort half is dropped on its
 * own when the surface has no live session to read it from, rather than
 * printed as `off` or `?`. A ledger-backed view (`lykos hud`, `lykos
 * watch`) genuinely does not know the current setting — it is a property
 * of a running `AgentSession`, not of any row — and inventing one beside a
 * real model name is exactly the kind of quietly-wrong number this
 * project's rules exist to prevent.
 */
function modelBadge(vm: ViewModel, theme: ResolvedTheme): { plain: string; styled: string } {
  const model = vm.session.model;
  if (!model) return { plain: "", styled: "" };
  const effort = vm.session.thinkingLevel;
  const plain = effort ? `${model} · ${effort}` : model;
  const styled = effort
    ? `${style(model, "delegate", theme)}${style(" · ", "faint", theme)}${style(effort, "accent", theme)}`
    : style(model, "delegate", theme);
  return { plain, styled };
}

/**
 * `ctx 12.0k/64k 19%` — the same request's "add current context window /
 * max context window too". Both numbers, not just the percentage: a
 * percentage alone cannot tell you whether 19% is 12k of 64k or 190k of
 * 1M, which is the difference between "plenty of room" and "compact now".
 *
 * `ctx ?` stays the honest answer when the window is unknown. Until this
 * round that was ALSO what a standalone session showed even when it knew,
 * because the gauge was only ever fed from a compaction event's
 * before/after tokens — `deriveHud` now reads Pi's own `getContextUsage()`
 * instead, which is a number Pi computes and Lykos reports rather than one
 * the UI derives (07-ui-and-hud.md §1.2).
 */
export function contextSegment(
  g: { usedTokens: number; totalTokens: number | null; pct: number | null } | null,
  detail: "pct" | "full",
  ascii: boolean,
): string {
  if (!g || g.pct === null) return "ctx ?";
  // At boot — before any turn has run — `usedTokens` is genuinely 0, and
  // showing that as `0.0k/64.0k 0%` reads as a real measurement ("you have
  // used none of your 64k") rather than what it actually is: nothing has
  // been measured yet. 2026-09-02 round five, item 7: "at the start just
  // let it be nothing / <max_value> instead of just ?, it should show
  // nothing instead of 0" — an em dash stands in for the unmeasured used
  // count and the percent is omitted outright, while the max (the one
  // number that IS known at boot) still shows, which is the difference
  // between this and the plain "ctx ?" fallback above: that path has no
  // total either, this one does.
  if (g.usedTokens === 0) {
    const totalStr = g.totalTokens !== null ? fmtTokens(g.totalTokens) : "?";
    if (detail === "pct") return "ctx —";
    return `ctx ${gauge(0, 10, ascii)} —/${totalStr}`;
  }
  const pct = `${Math.round(g.pct * 100)}%`;
  // The used/total pair is the widest thing on the line, so it belongs to
  // the widest tier only — the ladder's own rule is that a segment is
  // dropped whole rather than squeezed.
  if (detail === "pct") return `ctx ${pct}`;
  const counts = g.totalTokens !== null ? `${fmtTokens(g.usedTokens)}/${fmtTokens(g.totalTokens)} ` : "";
  return `ctx ${gauge(g.pct, 10, ascii)} ${counts}${pct}`;
}

/**
 * Renders the always-on triad (cost, tokens, context) at the width tier
 * matching `opts.width`. Whole segments are dropped, never truncated.
 */
export function renderTriadLine(vm: ViewModel, opts: TriadLineOptions): string {
  const { width, theme } = opts;
  const g = GLYPHS[theme.glyphs];
  const ascii = theme.glyphs === "ascii";
  const badge = alertBadge(vm, theme);
  const costStr = style(fmtUsd(vm.cost.runUsd), "spend", theme);

  if (width < 40) {
    return [costStr, badge].filter(Boolean).join(" ");
  }

  const ctxPct = vm.context.parent?.pct ?? vm.context.delegate?.pct ?? null;
  const hitPct = style(`${g.bolt}${fmtPct(vm.tokens.hitRatio)}`, "cache", theme);

  if (width < 60) {
    // 40-59: hard-compact — "58%ctx ⚡91% $0.038"
    const ctx = ctxPct !== null ? `${Math.round(ctxPct * 100)}%ctx ` : "";
    return [`${ctx}${hitPct} ${costStr}`, badge].filter(Boolean).join(" ");
  }

  const fresh = style(`${g.arrowUp}${fmtTokens(vm.tokens.counters.fresh)}`, "text", theme);
  const out = style(`${g.arrowDown}${fmtTokens(vm.tokens.counters.output)}`, "text", theme);

  if (width < 80) {
    // 60-79: one line, triad only.
    const ctx = `${contextSegment(vm.context.parent ?? vm.context.delegate, "pct", ascii)} ${g.vbar} `;
    return [`${hitPct} ${fresh} ${out} ${g.vbar} ${ctx}${costStr}`, badge].filter(Boolean).join(" ");
  }

  const ctxGauge = vm.context.parent ?? vm.context.delegate;

  if (width < 100) {
    // 80-99: the full triad, but no room for the right-aligned model badge.
    const write80 = style(`${g.write} ${fmtTokens(vm.tokens.counters.cacheWrite)}`, "text", theme);
    return [`${fresh} ${hitPct} ${write80} ${out} ${g.vbar} ${contextSegment(ctxGauge, "full", ascii)} ${g.vbar} ${costStr}`, badge]
      .filter(Boolean)
      .join("  ");
  }

  // 100+: abbreviated labels, full triad, cache write shown separately (never
  // collapsed into "input" — docs/07-ui-and-hud.md §2.2), plus the
  // right-aligned model/effort badge (2026-09-02 item 6).
  const write = style(`${g.write} ${fmtTokens(vm.tokens.counters.cacheWrite)}`, "text", theme);
  const ctxText = contextSegment(ctxGauge, "full", ascii);
  const cache = vm.cache && vm.cache.length > 0
    ? style(`cache ${vm.cache[0]!.pct === null ? "?" : `${Math.round(vm.cache[0]!.pct * 100)}%`} ${vm.cache[0]!.status}`, "cache", theme)
    : "";
  const left = [`${fresh} ${hitPct} ${write} ${out} ${g.vbar} ${ctxText} ${cache ? `${g.vbar} ${cache} ` : ""}${g.vbar} ${costStr}`, badge]
    .filter(Boolean)
    .join("  ");
  const badgeParts = modelBadge(vm, theme);
  if (badgeParts.plain.length === 0) return left;
  // Same whole-segment-drop rule as everything else on this line: if the
  // badge does not fit with at least two columns of gap, it is not shown.
  const gap = width - stringWidth(stripAnsi(left)) - stringWidth(badgeParts.plain);
  if (gap < 2) return left;
  return `${left}${" ".repeat(gap)}${badgeParts.styled}`;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}
