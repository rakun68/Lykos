// Loading the Lykos extensions `config.yaml` declares.
//
// **The gap.** P10.9 built the Lykos extension API (`api.ts`) and a host
// install path (`host-install.ts`), and nothing in `config.yaml` could name a
// Lykos extension, so the only way to install one was in-process code calling
// `LykosExtensionHost.install` directly.
//
// **Everything but the loader is the Pi list's.** `lykos_extensions:` is
// validated by `resolveExtensions` (same shape, exact versions, order is load
// order), resolved per machine by `resolveHostExtensions` (the same
// `<pi-host>/npm/node_modules/<name>`), reported missing by
// `hostExtensionNotice`, reconciled by `lykos doctor`, and installed by
// `installMissingHostExtensions`. Only this file is new, because Pi's loader
// hands a module Pi's API and a Lykos extension wants Lykos's.
//
// **Entry resolution mirrors Pi's, read at source** (`pi-coding-agent`
// `dist/core/extensions/loader.js` `resolveExtensionEntries`): a
// `package.json` manifest listing entry files, else `index.ts`, else
// `index.js`. Pi's manifest key is `pi`; ours is `lykos`, so one package can
// carry both halves without either loader picking up the other's entry. Pi's
// loader takes the module's default export as a factory; so does this one,
// and it also accepts the `LykosExtension` object shape `api.ts` defines.
//
// **The import is native `import()`**, not Pi's jiti: jiti is Pi's
// dependency, not Lykos's. A `.js` entry loads everywhere; a `.ts` entry loads
// where the running Node strips types (Node refuses to do that under
// `node_modules`, so a published package should ship `.js`).
//
// **A package that fails to load is counted, never fatal.** No entry, an
// import that throws, an export that is not an extension: each goes to
// `LykosExtensionHost.recordLoadFailure`, the same failure ledger a throwing
// handler writes to, which the session prints at its end. The extensions
// after it still load.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { HostExtension } from "../config/extensions.js";
import type { LykosExtensionApi, LykosExtensionHost } from "./api.js";

/** The `package.json` key a Lykos extension package lists its entry files under. Pi's is `pi`. */
export const LYKOS_MANIFEST_KEY = "lykos";

/**
 * The entry files of an installed extension package, or null when it has
 * none. `package.json` `lykos.extensions` first, then `index.ts`, then
 * `index.js` — Pi's order, with Pi's key swapped for ours.
 */
export function resolveLykosExtensionEntries(dir: string): string[] | null {
  // T149: a default extension (`extensions/defaults/`) resolves to its entry
  // FILE inside Lykos's package, not to a package directory. Pi's loader takes
  // a file path the same way (`resolveExtensionEntries` is only consulted for
  // a directory).
  try {
    if (statSync(dir).isFile()) return [dir];
  } catch {
    return null;
  }
  const manifestPath = join(dir, "package.json");
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      const block = manifest[LYKOS_MANIFEST_KEY] as { extensions?: unknown } | undefined;
      if (block !== undefined && Array.isArray(block.extensions)) {
        const entries = block.extensions
          .filter((p): p is string => typeof p === "string")
          .map((p) => resolve(dir, p))
          .filter((p) => existsSync(p));
        if (entries.length > 0) return entries;
      }
    } catch {
      // A package.json that does not parse falls through to the index files,
      // as Pi's loader does; if there are none the caller reports "no entry".
    }
  }
  for (const index of ["index.ts", "index.js"]) {
    const p = join(dir, index);
    if (existsSync(p)) return [p];
  }
  return null;
}

/** What a module must default-export: the `LykosExtension` shape, or its `register` function alone. */
export type LykosExtensionExport =
  | ((api: LykosExtensionApi) => void)
  | { name?: string; register: (api: LykosExtensionApi) => void };

function registerOf(mod: unknown): ((api: LykosExtensionApi) => void) | undefined {
  const candidate =
    mod !== null && typeof mod === "object" && "default" in mod ? (mod as { default: unknown }).default : mod;
  if (typeof candidate === "function") return candidate as (api: LykosExtensionApi) => void;
  if (candidate !== null && typeof candidate === "object") {
    const register = (candidate as { register?: unknown }).register;
    if (typeof register === "function") return register.bind(candidate) as (api: LykosExtensionApi) => void;
  }
  return undefined;
}

export type ModuleImporter = (path: string) => Promise<unknown>;

export const nativeImport: ModuleImporter = (path) => import(pathToFileURL(path).href);

export interface LykosExtensionLoadReport {
  /** Declared names whose every entry loaded and whose `register` did not throw. */
  loaded: string[];
  /** Declared names that failed to load or to register. Each is also in the host's failure ledger. */
  failed: string[];
}

/**
 * Load every declared-and-present Lykos extension into `host`, in declaration
 * order. The declared NAME is the extension's name on the host — it is what
 * the failure ledger and `lykos doctor` show, and a module cannot rename
 * itself out of its own failure count.
 */
export async function loadLykosExtensions(
  host: LykosExtensionHost,
  present: readonly HostExtension[],
  importer: ModuleImporter = nativeImport,
): Promise<LykosExtensionLoadReport> {
  const report: LykosExtensionLoadReport = { loaded: [], failed: [] };
  for (const ext of present) {
    const before = host.counters.failuresByExtension[ext.name] ?? 0;
    const entries = resolveLykosExtensionEntries(ext.path);
    if (entries === null) {
      host.recordLoadFailure(
        ext.name,
        new Error(
          `no entry file in ${ext.path} — expected package.json "${LYKOS_MANIFEST_KEY}": { "extensions": [...] }, index.ts or index.js`,
        ),
      );
      report.failed.push(ext.name);
      continue;
    }
    for (const entry of entries) {
      let mod: unknown;
      try {
        mod = await importer(entry);
      } catch (err) {
        host.recordLoadFailure(ext.name, new Error(`import of ${entry} threw: ${err instanceof Error ? err.message : String(err)}`));
        continue;
      }
      const register = registerOf(mod);
      if (register === undefined) {
        host.recordLoadFailure(
          ext.name,
          new Error(`${entry} does not default-export a register function or an object with register(api)`),
        );
        continue;
      }
      host.install({ name: ext.name, register });
    }
    const after = host.counters.failuresByExtension[ext.name] ?? 0;
    (after > before ? report.failed : report.loaded).push(ext.name);
  }
  return report;
}
