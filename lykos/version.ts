// The package version, read synchronously — for the one place that needs
// it without an async import (T50.1's full-screen header). `cli.ts`'s own
// `readPackageVersion()` (used for `--version`) stays as it is; this is
// not a replacement for it, just the sync form a renderer can call inline.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/** package.json sits at the repo root; this file is one level below it. */
export function lykosVersion(): string {
  if (cached) return cached;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { version?: string };
    cached = pkg.version ?? "0.0.0";
  } catch {
    cached = "0.0.0";
  }
  return cached;
}
