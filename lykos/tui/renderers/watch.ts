// S3 — `lykos watch` panel renderer (docs/07-ui-and-hud.md §4.1). Pure over
// the ViewModel: no queries, no ledger writes. Health finally shows
// tool-schema tokens (deferred from T4 to Phase 3 in §9).

import { fmtPct, fmtTokens, fmtUsd, gauge, truncate } from "../format.js";
import { renderTriadLine } from "./line.js";
import type { ResolvedTheme } from "../theme/resolve.js";
import { style } from "../theme/resolve.js";
import { GLYPHS } from "../theme/types.js";
import type { ViewModel } from "../types.js";

export type WatchPanel = "now" | "cost" | "tokens" | "context" | "delegates" | "health" | "session";

export const DEFAULT_WATCH_PANELS: WatchPanel[] = [
  "now",
  "cost",
  "tokens",
  "context",
  "health",
  "session",
];

export interface WatchRenderOptions {
  width: number;
  height: number;
  theme: ResolvedTheme;
  panels: WatchPanel[];
  /** live | ledger — shown in the header so a finished session is honest. */
  source: "live" | "ledger";
  focused?: WatchPanel | null;
  paused?: boolean;
}

function fmtElapsed(sec: number | null): string {
  if (sec === null) return "?";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function panelTitle(name: WatchPanel, focused: WatchPanel | null | undefined, theme: ResolvedTheme): string {
  const g = GLYPHS[theme.glyphs];
  const mark = focused === name ? ">" : " ";
  return style(`${mark}${name.toUpperCase()}`, focused === name ? "accent" : "dim", theme);
}

function box(title: string, body: string[], width: number, theme: ResolvedTheme): string[] {
  const g = GLYPHS[theme.glyphs];
  const ascii = theme.glyphs === "ascii";
  const inner = Math.max(8, width - 2);
  const rule = g.hbar.repeat(Math.min(inner, 40));
  const lines = [style(`${title} ${rule}`, "border", theme)];
  for (const row of body) {
    lines.push(`  ${truncate(row, inner, ascii)}`);
  }
  return lines;
}

function renderNow(vm: ViewModel, theme: ResolvedTheme): string[] {
  const state = vm.session.endedUtc ? "finished" : "running";
  return [
    `state   ${style(state, state === "running" ? "ok" : "dim", theme)}`,
    `agent   ${vm.session.agent ?? "—"}`,
    `model   ${vm.session.model ?? "—"}`,
    `phase   ${vm.session.phase ?? "—"}`,
    `elapsed ${fmtElapsed(vm.session.elapsedSec)}`,
  ];
}

function renderCost(vm: ViewModel, theme: ResolvedTheme): string[] {
  const runPct = vm.cost.capRunUsd > 0 ? vm.cost.runUsd / vm.cost.capRunUsd : null;
  const dayPct =
    vm.cost.todayUsd !== null && vm.cost.capDayUsd > 0 ? vm.cost.todayUsd / vm.cost.capDayUsd : null;
  const ascii = theme.glyphs === "ascii";
  return [
    `run     ${style(fmtUsd(vm.cost.runUsd), "spend", theme)}  / ${fmtUsd(vm.cost.capRunUsd)}  ${gauge(runPct, 10, ascii)}`,
    `today   ${style(fmtUsd(vm.cost.todayUsd), "spend", theme)}  / ${fmtUsd(vm.cost.capDayUsd)}  ${gauge(dayPct, 10, ascii)}`,
    `on_exceed ${vm.cost.onExceed}`,
  ];
}

function renderTokens(vm: ViewModel, theme: ResolvedTheme): string[] {
  const g = GLYPHS[theme.glyphs];
  const c = vm.tokens.counters;
  return [
    `${g.arrowUp} fresh ${fmtTokens(c.fresh)}   ${g.bolt} cache_read ${style(fmtTokens(c.cacheRead), "cache", theme)}`,
    `${g.write} write ${fmtTokens(c.cacheWrite)}   ${g.arrowDown} output ${fmtTokens(c.output)}`,
    `hit ${style(fmtPct(vm.tokens.hitRatio), "cache", theme)}   calls ${vm.tokens.calls}`,
  ];
}

function renderContext(vm: ViewModel, theme: ResolvedTheme): string[] {
  const ascii = theme.glyphs === "ascii";
  const lines: string[] = [];
  if (vm.context.parent) {
    lines.push(`parent   ${gauge(vm.context.parent.pct, 10, ascii)} ${fmtPct(vm.context.parent.pct)}`);
  } else {
    lines.push("parent   —");
  }
  if (vm.context.delegate) {
    lines.push(`delegate ${gauge(vm.context.delegate.pct, 10, ascii)} ${fmtPct(vm.context.delegate.pct)}`);
  } else {
    lines.push("delegate —");
  }
  return lines;
}

function renderDelegates(vm: ViewModel, theme: ResolvedTheme): string[] {
  // T39: show each child with resumable vs not — never pretend MCP hop-1
  // is resumable, and never hide a Lykos-spawned child's resumability.
  if (vm.children.length === 0) {
    return ["(no child sessions)"];
  }
  return vm.children.map((c) => {
    const resume = c.resumable
      ? style("resumable", "ok", theme)
      : style(`not resumable`, "warn", theme);
    const reason = !c.resumable && c.notResumableReason
      ? ` — ${truncate(c.notResumableReason, 40, theme.glyphs === "ascii")}`
      : c.resumable
        ? " — Lykos-spawned"
        : "";
    return `${c.id.slice(0, 8)}  ${c.agent ?? "?"}  ${fmtUsd(c.costUsd)}  ${resume}${reason}`;
  });
}

function renderHealth(vm: ViewModel, theme: ResolvedTheme): string[] {
  const g = GLYPHS[theme.glyphs];
  const schema =
    vm.health.toolSchemaTokens !== null
      ? style(`${fmtTokens(vm.health.toolSchemaTokens)} tokens`, "accent", theme)
      : style("unmeasured", "dim", theme);
  const tools = vm.health.toolCount !== null ? String(vm.health.toolCount) : "—";
  const prefix = vm.health.prefixChanged
    ? style(`${g.warnGlyph} changed`, "warn", theme)
    : style("stable", "ok", theme);
  const alertLines =
    vm.alerts.length === 0
      ? ["alerts  none"]
      : vm.alerts.map(
          (a) =>
            `${style(a.id, a.severity === "danger" ? "danger" : "warn", theme)} ${a.message}`,
        );
  return [`schema  ${schema}  (${tools} tools)`, `prefix  ${prefix}`, ...alertLines];
}

function renderSession(vm: ViewModel, theme: ResolvedTheme): string[] {
  const lines = [
    `id     ${vm.session.id ?? "—"}`,
    `brief  ${vm.session.brief ?? "—"}`,
  ];
  if (vm.outcome) {
    const label =
      vm.outcome.value === "success" && !vm.outcome.verified
        ? style("✓? success (unverified)", "warn", theme)
        : vm.outcome.value === "success"
          ? style("✓ success", "ok", theme)
          : style(vm.outcome.value, "danger", theme);
    lines.push(`outcome ${label}`);
    lines.push(`source  ${vm.outcome.source ?? "—"}`);
  } else {
    lines.push("outcome —");
  }
  return lines;
}

const PANEL_RENDERERS: Record<WatchPanel, (vm: ViewModel, theme: ResolvedTheme) => string[]> = {
  now: renderNow,
  cost: renderCost,
  tokens: renderTokens,
  context: renderContext,
  delegates: renderDelegates,
  health: renderHealth,
  session: renderSession,
};

/**
 * One full frame. Redraw-only: the caller diffs or clears; this returns text.
 */
export function renderWatchFrame(vm: ViewModel, opts: WatchRenderOptions): string {
  const { width, theme, panels, source, focused, paused } = opts;
  const g = GLYPHS[theme.glyphs];
  const ascii = theme.glyphs === "ascii";
  const id = truncate(vm.session.id ?? "—", 12, ascii);
  const src = style(source, source === "live" ? "ok" : "dim", theme);
  const pause = paused ? style(" paused", "warn", theme) : "";
  const header = [
    style("lykos watch", "accent", theme),
    id,
    src,
    pause,
    style("1-7 panel  p pause  q quit", "faint", theme),
  ]
    .filter(Boolean)
    .join(`  ${g.vbar}  `);

  const triad = renderTriadLine(vm, { width: Math.min(width, 120), theme });
  const out: string[] = [header, triad, ""];

  for (const name of panels) {
    const body = PANEL_RENDERERS[name](vm, theme);
    out.push(...box(panelTitle(name, focused, theme), body, width, theme));
    out.push("");
  }

  // Soft height cap: drop trailing blank, then truncate from the bottom of
  // lower-priority panels if needed — never half-print a number mid-line.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  if (opts.height > 0 && out.length > opts.height) {
    return out.slice(0, opts.height).join("\n");
  }
  return out.join("\n");
}
