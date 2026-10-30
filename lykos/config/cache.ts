// A resolved-config cache, for the same reason live.json exists (ledger/
// live.ts): `lykos hud` (S1 in particular, budgeted at p95 < 50ms including
// node start — docs/07-ui-and-hud.md §8) cannot afford `loadConfig()`'s cost
// on its hot path.
//
// Measured on the dev machine (DECISIONS.md 2026-08-29, "yaml import
// dominates the S1 budget, not SQLite"): importing the `yaml` package alone
// costs ~120ms — nearly 3x a bare `node` process start, and by itself
// already blows the entire 50ms budget before any Lykos code runs.
// `config/load.ts` imports `yaml` unconditionally, so anything that imports
// it — even dynamically, even without calling loadConfig() — pays that cost.
// The fix is for `lykos hud` to never import config/load.ts at all when a
// cache is available, not to make loadConfig() itself faster.
//
// This is deliberately a plain, possibly-stale cache: it is refreshed as a
// side effect by ordinary commands that already pay the full loadConfig()
// cost (`init`, `doctor`, `cost`), the same "written by the writer, read by
// the fast path" pattern as live.json. A user who hand-edits
// .lykos/config.yaml and immediately runs `lykos hud` sees stale values
// until the next full-load command refreshes the cache — an acceptable
// trade for a surface that must never block on parsing YAML.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ResolvedConfig } from "./types.js";

export function resolvedConfigCachePath(cwd: string): string {
  return join(cwd, ".lykos", "resolved-config.json");
}

export function writeResolvedConfigCache(cwd: string, resolved: ResolvedConfig): void {
  const path = resolvedConfigCachePath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(resolved), "utf8");
  try {
    renameSync(tmp, path);
  } catch (err) {
    // D15: a failed rename (on Windows, a reader holding the target open)
    // must not leave the temporary file behind; the caller still sees the error.
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Never throws: a missing or corrupt cache is a cache miss, not an error. */
export function readResolvedConfigCache(cwd: string): ResolvedConfig | null {
  const path = resolvedConfigCachePath(cwd);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ResolvedConfig;
  } catch {
    return null;
  }
}
