// json(): the test harness (docs/07-ui-and-hud.md §1.2) — every surface
// takes --json and emits its ViewModel so UI logic is testable with no TTY
// and no escape-code snapshotting.

import type { ViewModel } from "../types.js";

export function renderJson(vm: ViewModel): string {
  return JSON.stringify(vm);
}
