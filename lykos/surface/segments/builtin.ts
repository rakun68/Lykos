// Built-in segments for hud/statusline format strings (docs/07-ui-and-hud.md §6).

import { fmtPct, fmtTokens, fmtUsd, gauge } from "../format.js";
import { style } from "../theme/resolve.js";
import { GLYPHS } from "../theme/types.js";
import { registerSegment, type SegmentContext, type StyledSpan } from "./registry.js";
import type { ViewModel } from "../types.js";

function tokensSegment(vm: ViewModel, ctx: SegmentContext): StyledSpan[] {
  const { theme } = ctx;
  const g = GLYPHS[theme.glyphs];
  const hit = style(`${g.bolt}${fmtPct(vm.tokens.hitRatio)}`, "cache", theme);
  const fresh = style(`${g.arrowUp}${fmtTokens(vm.tokens.counters.fresh)}`, "text", theme);
  const out = style(`${g.arrowDown}${fmtTokens(vm.tokens.counters.output)}`, "text", theme);
  if (ctx.width >= 80) {
    const write = style(`${g.write}${fmtTokens(vm.tokens.counters.cacheWrite)}`, "text", theme);
    return [`${fresh} ${hit} ${write} ${out}`];
  }
  return [`${hit} ${fresh} ${out}`];
}

function contextSegment(vm: ViewModel, ctx: SegmentContext): StyledSpan[] {
  const { theme } = ctx;
  const ascii = theme.glyphs === "ascii";
  const pct = vm.context.parent?.pct ?? vm.context.delegate?.pct ?? null;
  if (pct === null) return ctx.width >= 60 ? [style("ctx ?", "dim", theme)] : [];
  if (ctx.width < 60) return [];
  if (ctx.width >= 80) {
    return [`ctx ${gauge(pct, 10, ascii)} ${Math.round(pct * 100)}%`];
  }
  return [`ctx ${Math.round(pct * 100)}%`];
}

function costSegment(vm: ViewModel, ctx: SegmentContext): StyledSpan[] {
  return [style(fmtUsd(vm.cost.runUsd), "spend", ctx.theme)];
}

function statusSegment(vm: ViewModel, ctx: SegmentContext): StyledSpan[] {
  const { theme } = ctx;
  const g = GLYPHS[theme.glyphs];
  if (vm.session.endedUtc) {
    return [style("done", "dim", theme)];
  }
  if (vm.session.phase) {
    return [style(vm.session.phase, "accent", theme)];
  }
  if (vm.tokens.calls > 0) {
    return [style(`${vm.tokens.calls} calls`, "dim", theme)];
  }
  return [style(`${g.diamond} idle`, "dim", theme)];
}

function modelSegment(vm: ViewModel, ctx: SegmentContext): StyledSpan[] {
  const { theme, meta } = ctx;
  const g = GLYPHS[theme.glyphs];
  const name = meta?.parentModelName ?? vm.session.model ?? "lykos";
  return [style(`${g.diamond} ${name}`, "accent", theme)];
}

function rateLimitsSegment(vm: ViewModel, ctx: SegmentContext): StyledSpan[] {
  // Rate limits arrive only via S1 stdin; when absent the segment is empty
  // rather than inventing a number (rule 4).
  void vm;
  void ctx;
  return [];
}

function alertsSegment(vm: ViewModel, ctx: SegmentContext): StyledSpan[] {
  if (vm.alerts.length === 0) return [];
  const { theme } = ctx;
  const g = GLYPHS[theme.glyphs];
  const order = { danger: 2, warn: 1, info: 0 } as const;
  const top = [...vm.alerts].sort((a, b) => order[b.severity] - order[a.severity])[0]!;
  const rest = vm.alerts.length - 1;
  const text = rest > 0 ? `${g.warnGlyph}${top.id} +${rest}` : `${g.warnGlyph}${top.id}`;
  return [style(text, top.severity === "danger" ? "danger" : "warn", theme)];
}

let registered = false;

/** Idempotent — safe to call from every surface that uses formats. */
export function ensureBuiltinSegments(): void {
  if (registered) return;
  registered = true;
  registerSegment("status", statusSegment);
  registerSegment("tokens", tokensSegment);
  registerSegment("context", contextSegment);
  registerSegment("cost", costSegment);
  registerSegment("model", modelSegment);
  registerSegment("rate_limits", rateLimitsSegment);
  registerSegment("alerts", alertsSegment);
}

/** Test-only: allow re-registration after clearSegmentRegistry(). */
export function resetBuiltinSegmentsFlag(): void {
  registered = false;
}
