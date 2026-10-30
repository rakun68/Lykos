// P14 ticket 08 (ADR-0027) — Pi's agent directory is one Lykos generates.
//
// **One resolver.** Every place Lykos names the directory Pi calls its
// `agentDir` asks `piHostDir()`. Before this, five modules each resolved
// `PI_CODING_AGENT_DIR ?? ~/.pi/agent` for themselves, which left the
// settings, the extension install prefix and the global AGENTS.md of every
// Lykos session in a directory any other Pi install on the machine also
// writes to. `LYKOS_PI_HOST_DIR` is the only override; an inherited
// `PI_CODING_AGENT_DIR` is not one, because Lykos owns this directory.
//
// **What Pi reads from it, checked against the installed source (0.84.3,
// rule 1).** `config.js` `getAgentDir()` reads `process.env.PI_CODING_AGENT_DIR`
// on every call and caches nothing, so setting the variable early for the
// process is enough for every later caller, Pi's or an extension's.
// `DefaultResourceLoader` reads `<agentDir>/settings.json` (through its
// `SettingsManager`), `skills/`, `prompts/`, `themes/`, `extensions/`,
// `AGENTS.md`, `SYSTEM.md` and `APPEND_SYSTEM.md`; `ModelRuntime.create()`
// defaults `models.json` and `models-store.json` to `getAgentDir()`; the
// `auth.json` default of `AuthStorage` is `getAgentDir()` too, though Lykos
// passes its own credential store.
//
// **The generated settings file is `{}`, and on purpose.** Pi discovers
// npm-installed packages from a `packages` list in `settings.json`
// (`package-manager.js` `resolve()`), and for a listed package that is not
// installed it RUNS `npm install` (`resolvePackageSources` → `installMissing`,
// skipped only under `PI_OFFLINE`). Lykos does not load host extensions that
// way: `session/boot.ts` passes `noExtensions: true` and hands Pi the resolved
// `<agentDir>/npm/node_modules/<name>` paths as `additionalExtensionPaths`
// (`config/extensions.ts` `resolveHostExtensions`). Listing the declared
// extensions as `packages` would therefore load nothing extra and would turn a
// declared-but-missing extension into a network install at session start,
// which `extensions/host-install.ts` exists to forbid. No other Lykos config
// value maps onto a Pi setting today, and Pi's retry defaults stay Pi's (no
// `retry` block), which is what `lykos doctor`'s retry check reports.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The one override: tests, and a person who wants the host somewhere else. */
export const PI_HOST_DIR_ENV = "LYKOS_PI_HOST_DIR";

/** The variable Pi's `getAgentDir()` reads (`config.js` `ENV_AGENT_DIR` for APP_NAME "pi"). */
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** Where Pi's agent directory lives for Lykos: `LYKOS_PI_HOST_DIR`, else `~/.lykos/pi-host`. Never `~/.pi`. */
export function piHostDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[PI_HOST_DIR_ENV];
  if (override !== undefined && override.length > 0) return resolve(override);
  return join(homedir(), ".lykos", "pi-host");
}

/** Pi's `settings.json` for the host, generated. See the header for why it is empty. */
export function piHostSettings(): Record<string, never> {
  return {};
}

/** The exact bytes `ensurePiHost` writes. */
export function renderPiHostSettings(): string {
  return `${JSON.stringify(piHostSettings(), null, 2)}\n`;
}

export interface EnsurePiHostResult {
  dir: string;
  settingsPath: string;
  /** False when the file already held exactly the generated content. */
  written: boolean;
}

/**
 * Create the directory and write its generated `settings.json`. Idempotent:
 * the file is rewritten only when its content differs, so a setting Pi saved
 * into it (Pi's `SettingsManager` can write) is replaced by the generated one
 * at the next start rather than accumulating.
 */
export function ensurePiHost(opts: { dir: string }): EnsurePiHostResult {
  const dir = resolve(opts.dir);
  mkdirSync(dir, { recursive: true });
  const settingsPath = join(dir, "settings.json");
  const want = renderPiHostSettings();
  let have: string | undefined;
  try {
    have = readFileSync(settingsPath, "utf8");
  } catch {
    have = undefined;
  }
  if (have === want) return { dir, settingsPath, written: false };
  writeFileSync(settingsPath, want);
  return { dir, settingsPath, written: true };
}

/**
 * The process-wide half of ADR-0027: set `PI_CODING_AGENT_DIR` to the host so
 * an extension calling Pi's `getAgentDir()` agrees with the `agentDir` Lykos
 * passes Pi. Always set, even over an inherited value. Returns the directory.
 */
export function adoptPiHost(env: NodeJS.ProcessEnv = process.env): string {
  const dir = piHostDir(env);
  env[PI_AGENT_DIR_ENV] = dir;
  return dir;
}

/** The pre-ADR-0027 npm package directory, `~/.pi/agent/npm/node_modules`. Named only for `lykos doctor`. */
export function legacyPiAgentPackagesDir(home: string = homedir()): string {
  return join(home, ".pi", "agent", "npm", "node_modules");
}

/**
 * The npm packages under the pre-ADR-0027 location, by directory name only —
 * never read. `undefined` when the directory does not exist. This module is
 * the one place Lykos names `~/.pi/agent`, and only so `lykos doctor` can say
 * those packages are no longer loaded.
 */
export function legacyPiAgentPackages(home: string = homedir()): { dir: string; names: string[] } | undefined {
  const dir = legacyPiAgentPackagesDir(home);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  const names: string[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      let scoped: string[] = [];
      try {
        scoped = readdirSync(join(dir, entry));
      } catch {
        scoped = [];
      }
      for (const name of scoped.sort()) if (!name.startsWith(".")) names.push(`${entry}/${name}`);
      continue;
    }
    names.push(entry);
  }
  return { dir, names };
}
