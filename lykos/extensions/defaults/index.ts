// The default extensions: extensions that ship inside Lykos's own package,
// carry the `lykos-` prefix, and use only an API a third party could use
// (GLOSSARY.md, "Default extension").
//
// **Declared like any other extension.** A default extension appears in
// `SHIPPED_DEFAULTS.extensions` (a Pi extension) or `lykos_extensions` (a
// Lykos one) with an exact version, exactly as a third-party package does, so
// switching it off is the ordinary syntax: write the list without it. The only
// difference is WHERE the declaration resolves — to a file in this package
// rather than to `<pi-host>/npm/node_modules/<name>` — and that difference
// lives in one place, `resolveHostExtensions`, which asks this module first.
//
// **Its version is Lykos's.** It ships in this package, so the package version
// is the only true answer to "which build of it is this". A declaration that
// pins a different version does not resolve here; it falls through to the
// per-machine path like any other package, so a separately published build of
// the same name can still be installed and pinned on purpose.
//
// **Never in the container.** A default extension runs on the host with the
// session; only the session's commands run in a container (ADR-0036).
//
// **The gate is never one** (spec story 27): it is code in `gate/`, not an
// entry here, so no configuration can remove it.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lykosVersion } from "../../version.js";

/** Which API a default extension is written against, and so which list declares it. */
export type DefaultExtensionKind = "pi" | "lykos";

export interface DefaultExtension {
  /** Always `lykos-`-prefixed. */
  name: string;
  kind: DefaultExtensionKind;
  /** Entry file in this directory, without its extension (`.ts` in source, `.js` in `dist/`). */
  file: string;
}

export const DEFAULT_EXTENSION_PREFIX = "lykos-";

/** Name of the repo map default extension (T148). */
export const REPO_MAP_EXTENSION = "lykos-repo-map";

/** Name of the reviewer default extension (T149), a Lykos extension. */
export const REVIEWER_EXTENSION = "lykos-reviewer";

/** Name of the continuation default extension (T150): the `continue` context strategy. */
export const CONTINUATION_EXTENSION = "lykos-continuation";

/** Name of the self-compact default extension (T151): the `self-compact` context strategy. */
export const SELF_COMPACT_EXTENSION = "lykos-self-compact";

/** Name of the prune default extension (T188): superseded reads and useless results. */
export const PRUNE_EXTENSION = "lykos-prune";

/** Name of the seal veto default extension (T199): protected sealed paths and test command allowance. */
export const SEAL_EXTENSION = "lykos-seal";

/** Every default extension Lykos ships. Order is irrelevant; load order is the configuration's. */
export const DEFAULT_EXTENSIONS: readonly DefaultExtension[] = [
  { name: REPO_MAP_EXTENSION, kind: "pi", file: "lykos-repo-map" },
  { name: REVIEWER_EXTENSION, kind: "lykos", file: "lykos-reviewer" },
  { name: CONTINUATION_EXTENSION, kind: "pi", file: "lykos-continuation" },
  { name: SELF_COMPACT_EXTENSION, kind: "pi", file: "lykos-self-compact" },
  { name: PRUNE_EXTENSION, kind: "pi", file: "lykos-prune" },
  { name: SEAL_EXTENSION, kind: "lykos", file: "lykos-seal" },
];

/** The version every default extension carries: the package it ships in. */
export function defaultExtensionVersion(): string {
  return lykosVersion();
}

export function findDefaultExtension(name: string): DefaultExtension | undefined {
  return DEFAULT_EXTENSIONS.find((e) => e.name === name);
}

export function isDefaultExtension(name: string): boolean {
  return findDefaultExtension(name) !== undefined;
}

/**
 * The file a declaration resolves to inside this package, or undefined when
 * the declaration is not a shipped default extension of this kind at this
 * package's version — in which case the caller resolves it like any other.
 */
export function defaultExtensionPath(
  name: string,
  version: string,
  kind: DefaultExtensionKind = "pi",
): string | undefined {
  const ext = findDefaultExtension(name);
  if (ext === undefined || ext.kind !== kind || version !== defaultExtensionVersion()) return undefined;
  const here = dirname(fileURLToPath(import.meta.url));
  const ts = join(here, `${ext.file}.ts`);
  return existsSync(ts) ? ts : join(here, `${ext.file}.js`);
}
