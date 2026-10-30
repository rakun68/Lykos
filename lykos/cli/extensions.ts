// `lykos extensions install` and `lykos extensions list`.
//
// `installMissingHostExtensions` (P10.9, `extensions/host-install.ts`) could
// install a declared-but-missing extension and had no CLI caller, so every
// "DECLARED BUT NOT INSTALLED" notice left a person to assemble the npm
// command themselves. This is its caller, for both lists at once:
// `extensions:` (Pi extensions) and `lykos_extensions:` (Lykos ones), which
// resolve to the same per-machine install tree.
//
// **A default extension is never installed.** It ships inside Lykos's package
// and resolves there (`extensions/defaults/index.ts`), so there is nothing for
// npm to fetch. Declared at another version, it is an ordinary package and
// installs like one — the same rule `resolveHostExtensions` applies.
//
// Never automatic: a person types this. A session that npm-installs at boot is
// the startup tax and supply-chain hole `host-install.ts` refuses to be.

import { existsSync } from "node:fs";
import {
  hop0Extensions,
  hostExtensionPath,
  LYKOS_EXTENSIONS_KEY,
  resolveExtensions,
  resolveHostExtensions,
  type HostExtension,
  type ResolvedExtension,
} from "../config/extensions.js";
import { loadConfig } from "../config/load.js";
import { piHostDir } from "../config/pi-host.js";
import { defaultExtensionPath, type DefaultExtensionKind } from "../extensions/defaults/index.js";
import {
  installMissingHostExtensions,
  renderHostInstall,
  spawnInstall,
  type InstallRunner,
} from "../extensions/host-install.js";
import { stdoutWrite } from "../tui/io-mode.js";

/** The command every missing-extension notice names. */
export const EXTENSIONS_INSTALL_COMMAND = "lykos extensions install";

/** Which `config.yaml` list a declaration came from. */
export type ExtensionList = "extensions" | typeof LYKOS_EXTENSIONS_KEY;

const KIND_OF: Record<ExtensionList, DefaultExtensionKind> = {
  extensions: "pi",
  [LYKOS_EXTENSIONS_KEY]: "lykos",
};

export interface ExtensionRow {
  name: string;
  version: string;
  list: ExtensionList;
  /** Ships inside Lykos's package at this version, so it is never installed. */
  isDefault: boolean;
  /** Where the session loads it from on this machine. */
  path: string;
  installed: boolean;
  /** False when its scope never includes hop 0, so no session on this host loads it. */
  hop0: boolean;
}

export interface DeclaredExtensions {
  extensions: readonly ResolvedExtension[];
  lykosExtensions: readonly ResolvedExtension[];
  /** Rejected declarations, one line each, from both lists. */
  errors: readonly string[];
}

export function declaredExtensions(raw: { extensions?: unknown; lykos_extensions?: unknown }): DeclaredExtensions {
  const pi = resolveExtensions(raw.extensions);
  const lykos = resolveExtensions(raw.lykos_extensions, LYKOS_EXTENSIONS_KEY);
  return { extensions: pi.extensions, lykosExtensions: lykos.extensions, errors: [...pi.errors, ...lykos.errors] };
}

/** Every declared extension, in declaration order, Pi list first. Pure but for `exists`. */
export function extensionRows(
  declared: DeclaredExtensions,
  agentDir: string,
  exists: (path: string) => boolean,
): ExtensionRow[] {
  const rows: ExtensionRow[] = [];
  const lists: [ExtensionList, readonly ResolvedExtension[]][] = [
    ["extensions", declared.extensions],
    [LYKOS_EXTENSIONS_KEY, declared.lykosExtensions],
  ];
  for (const [list, exts] of lists) {
    const kind = KIND_OF[list];
    for (const e of exts) {
      // The rule `resolveHostExtensions` applies: a default at Lykos's own
      // version resolves inside this package, anything else to the install tree.
      const bundled = defaultExtensionPath(e.name, e.version, kind);
      const path = bundled ?? hostExtensionPath(agentDir, e.name);
      rows.push({
        name: e.name,
        version: e.version,
        list,
        isDefault: bundled !== undefined,
        path,
        installed: exists(path),
        hop0: e.hop0,
      });
    }
  }
  return rows;
}

export function renderExtensionList(rows: readonly ExtensionRow[], errors: readonly string[], agentDir: string): string {
  const lines: string[] = [];
  if (rows.length === 0) {
    lines.push("lykos extensions: nothing declared in `extensions:` or `lykos_extensions:`");
  } else {
    lines.push(`lykos extensions: ${rows.length} declared (installs resolve under ${agentDir})`);
    const width = Math.max(...rows.map((r) => `${r.name}@${r.version}`.length));
    for (const r of rows) {
      const state = r.installed ? "installed" : r.isDefault ? "MISSING from Lykos's package" : "MISSING";
      const notes = [
        r.isDefault ? "default, ships with Lykos" : undefined,
        r.hop0 ? undefined : "scope excludes hop0, not loaded on this host",
      ].filter((n): n is string => n !== undefined);
      lines.push(
        `  ${`${r.name}@${r.version}`.padEnd(width)}  ${r.list.padEnd(LYKOS_EXTENSIONS_KEY.length)}  ${state}` +
          (notes.length > 0 ? `  (${notes.join("; ")})` : ""),
      );
    }
    const missing = rows.filter((r) => !r.installed && !r.isDefault && r.hop0).length;
    if (missing > 0) lines.push("", `${missing} missing — install with \`${EXTENSIONS_INSTALL_COMMAND}\``);
  }
  for (const e of errors) lines.push(`  REJECTED: ${e}`);
  return lines.join("\n");
}

export interface ExtensionsCliDeps {
  env?: NodeJS.ProcessEnv;
  /** Where the global config layer is read from. Tests point it at a temp dir. */
  globalDir?: string;
  run?: InstallRunner;
  exists?: (path: string) => boolean;
}

export function runExtensionsCli(cwd: string, sub: string | undefined, deps: ExtensionsCliDeps = {}): number {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const agentDir = piHostDir(env);
  const { resolved } = loadConfig({ cwd, env, ...(deps.globalDir !== undefined ? { globalDir: deps.globalDir } : {}) });
  const declared = declaredExtensions(resolved);

  if (sub === undefined || sub === "list") {
    stdoutWrite(`${renderExtensionList(extensionRows(declared, agentDir, exists), declared.errors, agentDir)}\n`);
    return declared.errors.length > 0 ? 1 : 0;
  }

  if (sub === "install") {
    for (const e of declared.errors) process.stderr.write(`lykos extensions: declaration rejected, not installed: ${e}\n`);
    // Both lists, Pi list first, each in declaration order (load order). A
    // default at Lykos's own version is left out: it resolves inside this package.
    const missing: HostExtension[] = [];
    const seen = new Set<string>();
    for (const [list, exts] of [
      ["extensions", declared.extensions],
      [LYKOS_EXTENSIONS_KEY, declared.lykosExtensions],
    ] as const) {
      const kind = KIND_OF[list];
      for (const m of resolveHostExtensions(hop0Extensions(exts), agentDir, exists, kind).missing) {
        if (defaultExtensionPath(m.name, m.version, kind) !== undefined) continue;
        // The same package declared in both lists installs once.
        const key = `${m.name}@${m.version}`;
        if (seen.has(key)) continue;
        seen.add(key);
        missing.push(m);
      }
    }
    const results = installMissingHostExtensions(
      { loaded: [], missing, paths: [] },
      agentDir,
      deps.run ?? spawnInstall,
      exists,
    );
    const text = renderHostInstall(results);
    const failed = results.some((r) => r.status === "failed");
    (failed ? (s: string) => process.stderr.write(s) : stdoutWrite)(`${text}\n`);
    return failed || declared.errors.length > 0 ? 1 : 0;
  }

  process.stderr.write(`lykos extensions: unknown subcommand "${sub}". Valid: list, install\n`);
  return 1;
}
