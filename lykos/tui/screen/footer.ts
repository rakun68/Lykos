// The always-on ledger footer. Not a new accounting path: this draws
// `renderTriadLine()` over the same ViewModel `collect()`/`derive()` already
// produce (07-ui-and-hud.md §2). A renderer that computed its own numbers here
// would be the exact bug §1.2 exists to prevent.

import { renderTriadLine } from "../renderers/line.js";
import type { ResolvedTheme } from "../theme/resolve.js";
import type { ViewModel } from "../types.js";

/**
 * Zero rows when `vm` is null (no session yet) or the caller has hidden the
 * footer (T42.4) — never a blank reserved row, so the viewport actually
 * grows rather than showing dead space.
 */
export function renderFooterLines(vm: ViewModel | null, theme: ResolvedTheme, width: number, visible: boolean): string[] {
  if (!visible || !vm) return [];
  return [renderTriadLine(vm, { width, theme })];
}
