import type { BrowserState } from "../tui/screen/browser.js";

export function noop(): BrowserState | undefined {
  return undefined;
}
