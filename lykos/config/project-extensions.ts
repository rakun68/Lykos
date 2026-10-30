// Which of a project's own extensions a delegated session may load.
//
// A workspace handed to Lykos can declare extensions in its `.lykos/config.yaml`, and an extension is code that
// runs on the host with the session's authority. So a delegated session loads them only when the project is
// trusted in the user-level store (`stored` or `prompt`); the one-run flag (`LYKOS_TRUST_WORKSPACE`,
// `--trust-workspace`) passes the trust gate and trusts nothing else. Default extensions (they ship inside
// Lykos) and extensions the user's own config declares are not the project's, and are never touched.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { CONTAINMENT_LEVELS, DELEGATED_DEFAULT_LEVEL } from "../containment/request.js";
import type { ContainmentLevel } from "../containment/containment.js";
import { defaultExtensionPath } from "../extensions/defaults/index.js";
import { discoverGateCommand } from "../gate/verify-gate.js";
import { discoverPostEditCommand } from "../loop/post-edit.js";
import { LYKOS_EXTENSIONS_KEY, resolveExtensions } from "./extensions.js";
import type { ConfigLayer, ResolvedConfig } from "./types.js";

type ListKey = "extensions" | typeof LYKOS_EXTENSIONS_KEY;

/**
 * One thing withheld from an untrusted project. `skipped_extensions` on the wire is a list of strings (the #22
 * contract), but it names three kinds of thing, so internally each is tagged and `skippedLabel` is the one place
 * that turns it into a wire string.
 */
export type SkippedItem =
  | { kind: "extension"; name: string; version: string | undefined }
  | { kind: "pi-package"; source: string }
  | { kind: "provider-command"; provider: string; field: "credential" | { header: string } }
  /** T194: a project config command field a trusted project would have run on the host (`gate.command`, `eval.python`, ...). */
  | { kind: "config-command"; field: CommandField }
  | { kind: "hook"; index: number; event: string }
  | { kind: "lsp-server"; key: string }
  /** The post-edit check Lykos would have found in the project's `package.json` when no command was configured. */
  | { kind: "post-edit-discovery"; command: string }
  | { kind: "gate-discovery"; command: string }
  | { kind: "containment-level"; asked: string; kept: string };

/** The project config keys that hold one command (or interpreter) each. */
export type CommandField = "feedback.command" | "gate.command" | "gate.rerun_command" | "eval.python";

/** The wire string: `name@version` (bare name without a version), `pi package <source> (...)`, or `provider <name>: !command ...`. */
export function skippedLabel(item: SkippedItem): string {
  switch (item.kind) {
    case "extension":
      return item.version === undefined || item.version === "" ? item.name : `${item.name}@${item.version}`;
    case "pi-package":
      // A delegated session boots Pi with `noExtensions`, so a package in the project's settings is installed but
      // never loaded even for a trusted project; the label says what was withheld (the install).
      return `pi package ${item.source} (install withheld; delegated sessions never load Pi packages)`;
    case "provider-command":
      return item.field === "credential"
        ? `provider ${item.provider}: !command credential`
        : `provider ${item.provider}: !command header ${item.field.header}`;
    case "config-command":
      return `project ${item.field} withheld`;
    case "hook":
      return `project hooks[${item.index}] (${item.event}): command withheld`;
    case "lsp-server":
      return `project lsp.servers.${item.key}: command withheld`;
    case "post-edit-discovery":
      return `project post-edit check "${item.command}" (discovered from the project) withheld`;
    case "gate-discovery":
      return `project gate check "${item.command}" (discovered from the project) withheld (commands run on the host)`;
    case "containment-level":
      return `project containment.level: ${item.asked} withheld (kept ${item.kept})`;
  }
}

/** A provider `source` or header value starting with `!` is a command Pi runs on the host. */
const isCommandValue = (value: unknown): value is string => typeof value === "string" && value.startsWith("!");

const idOf = (name: string, version: string | undefined): string => `${name}@${version ?? ""}`;

/** The project's own layers: its `.lykos/config.yaml`, and a specialist read from inside the project. */
function isProjectLayer(layer: ConfigLayer, cwd: string): boolean {
  if (layer.name === "project") return true;
  if (layer.name !== "specialist" || layer.path === undefined) return false;
  return resolve(layer.path).startsWith(resolve(cwd) + sep);
}

export interface ProjectExtensionsInput {
  config: ResolvedConfig;
  layers: readonly ConfigLayer[];
  /** The project's root, not a worktree: config, identity and the trust store are keyed on it. */
  cwd: string;
  trusted: boolean;
  /** Where the project's commands run (a worktree), when that is not `cwd`. What is discovered is read from here. */
  commandCwd?: string;
}

export interface ProjectExtensionsResult {
  config: ResolvedConfig;
  /** Everything this call withheld from the untrusted project: extensions, Pi packages, `!command` provider values. */
  skipped: SkippedItem[];
}

export function withoutUntrustedProjectExtensions(input: ProjectExtensionsInput): ProjectExtensionsResult {
  if (input.trusted) return { config: input.config, skipped: [] };
  const skipped: SkippedItem[] = [];
  const filter = <T extends { name: string; version?: string }>(list: readonly T[], key: ListKey): T[] => {
    const own = new Set<string>();
    const elsewhere = new Set<string>();
    for (const layer of input.layers) {
      for (const e of resolveExtensions(layer.value[key], key).extensions) {
        const id = idOf(e.name, e.version);
        if (!isProjectLayer(layer, input.cwd)) elsewhere.add(id);
        else if (defaultExtensionPath(e.name, e.version, key === "extensions" ? "pi" : "lykos") === undefined) own.add(id);
      }
    }
    return list.filter((e) => {
      // A default may omit its version; resolving the entry the way boot does gives it the same id the layers got.
      const resolved = resolveExtensions([e], key).extensions[0];
      const id = idOf(e.name, resolved?.version ?? e.version);
      // Shipped or declared by the user's own config too: the project is not why it is here.
      if (!own.has(id) || elsewhere.has(id)) return true;
      skipped.push({ kind: "extension", name: e.name, version: resolved?.version ?? e.version });
      return false;
    });
  };
  return {
    config: {
      ...input.config,
      extensions: filter(input.config.extensions, "extensions"),
      lykos_extensions: filter(input.config.lykos_extensions, LYKOS_EXTENSIONS_KEY),
    },
    skipped,
  };
}

/**
 * The packages a project's own `.pi/settings.json` lists, as written. Pi installs a listed package on the host, so
 * for an untrusted project they are named as skipped (the session hides the file from Pi, see `piProjectTrusted`).
 */
export function projectPiPackages(cwd: string): SkippedItem[] {
  const path = join(cwd, ".pi", "settings.json");
  if (!existsSync(path)) return [];
  try {
    const packages = (JSON.parse(readFileSync(path, "utf8")) as { packages?: unknown }).packages;
    if (!Array.isArray(packages)) return [];
    return packages.flatMap((p): SkippedItem[] => {
      const source = typeof p === "string" ? p : (p as { source?: unknown } | null)?.source;
      return typeof source === "string" && source.length > 0 ? [{ kind: "pi-package", source }] : [];
    });
  } catch {
    return [];
  }
}

/**
 * A provider's `source` and `headers` may be `!command`, which Pi runs on the host when it resolves the
 * provider's key (`resolve-config-value.js`). A project's own config can declare them, so an untrusted delegated
 * session drops every `!command` the project layer declared and names it. A `!command` from the user's own
 * config is theirs and stays; `$ENV_VAR` and literal header values are not commands and stay.
 */
export function withoutUntrustedProjectCommands(input: ProjectExtensionsInput): ProjectExtensionsResult {
  if (input.trusted) return { config: input.config, skipped: [] };
  const skipped: SkippedItem[] = [];
  const providers = { ...input.config.providers };
  // Providers merge by whole entry (`mergeProviders`), so the layer that declared a provider last owns all of it.
  // Only when that layer is the project's is the merged entry the project's, whatever a user layer's values look like.
  const winner = new Map<string, ConfigLayer>();
  for (const layer of input.layers) for (const name of Object.keys(layer.value.providers ?? {})) winner.set(name, layer);
  for (const [name, layer] of winner) {
    if (!isProjectLayer(layer, input.cwd)) continue;
    const merged = providers[name];
    if (merged === undefined) continue;
    let next = merged;
    if (isCommandValue(merged.source)) {
      const { source: _dropped, ...rest } = next;
      next = rest;
      skipped.push({ kind: "provider-command", provider: name, field: "credential" });
    }
    if (merged.headers !== undefined) {
      const kept: Record<string, string> = {};
      for (const [key, value] of Object.entries(merged.headers)) {
        if (isCommandValue(value)) skipped.push({ kind: "provider-command", provider: name, field: { header: key } });
        else kept[key] = value;
      }
      if (Object.keys(kept).length !== Object.keys(merged.headers).length) next = { ...next, headers: kept };
    }
    providers[name] = next;
  }
  return { config: { ...input.config, providers }, skipped };
}

/**
 * For one config key: whether the layer that wins it is the project's, what the project set, and what the layers
 * outside the project (shipped defaults included) would give instead. A later non-project layer (a specialist
 * from the user's own library, the environment, the caller's flags) that sets the key wins over the project, so
 * the project's value is not in force and nothing is withheld.
 */
function projectWinner<T>(layers: readonly ConfigLayer[], cwd: string, get: (layer: ConfigLayer) => T | undefined): { project: T; outside: T | undefined } | undefined {
  let project: T | undefined;
  let outside: T | undefined;
  let projectWins = false;
  for (const layer of layers) {
    const value = get(layer);
    if (value === undefined) continue;
    if (isProjectLayer(layer, cwd)) {
      project = value;
      projectWins = true;
    } else {
      outside = value;
      projectWins = false;
    }
  }
  return projectWins ? { project: project as T, outside } : undefined;
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * T194 (#49, spec #22 story 75): the project's own command fields. Each runs on the session's executor, which is
 * the host when containment is off, so an untrusted delegated session drops what the project layer set and falls
 * back to what the user's and the shipped layers give. Dropped: `hooks[].command`, `feedback.command` (the
 * post-edit check), `gate.command` and `gate.rerun_command`, every `lsp.servers.*` entry the project declared
 * (whatever its path), and `eval.python`.
 *
 * The post-edit check Lykos finds in `package.json` when no command is set (`npm run typecheck`, `npx tsc`) is
 * the project's own script or binary, so it is withheld too (the loop is switched off, since a configured command
 * could only come from the user's layers). The gate's discovered test command is a separate step, because it is
 * withheld only when the session runs on the host: `withoutUntrustedProjectGateDiscovery`.
 */
export function withoutUntrustedProjectHostCommands(input: ProjectExtensionsInput): ProjectExtensionsResult {
  if (input.trusted) return { config: input.config, skipped: [] };
  const { layers, cwd } = input;
  const skipped: SkippedItem[] = [];
  let config = input.config;

  const hooks = projectWinner(layers, cwd, (l) => l.value.hooks);
  if (hooks !== undefined && hooks.project.length > 0) {
    hooks.project.forEach((h, index) => skipped.push({ kind: "hook", index, event: String(h?.event ?? "?") }));
    config = { ...config, hooks: hooks.outside ?? [] };
  }

  const dropProjectCommand = (field: CommandField): void => {
    const [section, key] = field.split(".") as ["feedback" | "gate" | "eval", string];
    const pick = (l: ConfigLayer): string | undefined => {
      const v = (l.value[section] as Record<string, unknown> | undefined)?.[key];
      return typeof v === "string" ? v : undefined;
    };
    const won = projectWinner(layers, cwd, pick);
    if (won === undefined || !nonEmpty(won.project)) return;
    skipped.push({ kind: "config-command", field });
    config = { ...config, [section]: { ...config[section], [key]: won.outside ?? "" } };
  };
  dropProjectCommand("feedback.command");
  dropProjectCommand("gate.command");
  dropProjectCommand("gate.rerun_command");

  const servers = { ...config.lsp.servers };
  const keys = new Set<string>();
  for (const layer of layers) if (isProjectLayer(layer, cwd)) for (const key of Object.keys(layer.value.lsp?.servers ?? {})) keys.add(key);
  for (const key of keys) {
    const won = projectWinner(layers, cwd, (l) => l.value.lsp?.servers?.[key]);
    if (won === undefined) continue;
    skipped.push({ kind: "lsp-server", key });
    if (won.outside !== undefined) servers[key] = won.outside;
    else delete servers[key];
  }
  if (keys.size > 0) config = { ...config, lsp: { ...config.lsp, servers } };

  dropProjectCommand("eval.python");

  // With no command left from the user's layers, the loop would find one in the project.
  if (config.feedback.enabled !== false && !nonEmpty(config.feedback.command)) {
    const found = discoverPostEditCommand(input.commandCwd ?? cwd);
    if (found !== undefined) {
      config = { ...config, feedback: { ...config.feedback, enabled: false } };
      // A project command that was just withheld already says the project's check did not run.
      if (!skipped.some((s) => s.kind === "config-command" && s.field === "feedback.command")) skipped.push({ kind: "post-edit-discovery", command: found });
    }
  }
  return { config, skipped };
}

/**
 * T194: a project may raise `containment.level`, never lower it. The level the user's layers give (the delegated
 * default `off` when none names one) is the level kept for an untrusted project; a project layer asking for less has
 * its `level` removed, so the session resolves, and says so, as if the project had not set it. The caller's own
 * argument (the flags layer) and the user's layers are not the project's, and can still choose `off`.
 */
export function withoutUntrustedProjectContainmentLowering(
  input: ProjectExtensionsInput,
): ProjectExtensionsResult & { layers: ConfigLayer[] } {
  const unchanged = { config: input.config, layers: [...input.layers], skipped: [] };
  if (input.trusted) return unchanged;
  const rank = (level: unknown): number => CONTAINMENT_LEVELS.indexOf(level as ContainmentLevel);
  const won = projectWinner(input.layers, input.cwd, (l) => (l.name === "defaults" ? undefined : l.value.containment?.level));
  if (won === undefined) return unchanged;
  const kept: ContainmentLevel = won.outside ?? DELEGATED_DEFAULT_LEVEL;
  if (rank(won.project) >= rank(kept)) return unchanged;
  const layers = input.layers.map((layer) => {
    if (!isProjectLayer(layer, input.cwd) || layer.value.containment?.level === undefined) return layer;
    const { level: _dropped, ...containment } = layer.value.containment;
    return { ...layer, value: { ...layer.value, containment } };
  });
  return {
    config: { ...input.config, containment: { ...input.config.containment, level: kept } },
    layers,
    skipped: [{ kind: "containment-level", asked: String(won.project), kept }],
  };
}

/**
 * T194: with no gate command left (the project's was dropped and the user's layers set none), the gate would find
 * `npm test` in the project's `package.json`: the project's own script. Where the session runs on the host that
 * is withheld, by switching the gate off. In a container the same command stays, so verification still works.
 * The session decides which case it is in, and calls this when the gate resolves with `cwd` the folder the command
 * runs in (the worktree, not the project's root); this only narrows.
 */
export function withoutUntrustedProjectGateDiscovery(input: { config: ResolvedConfig; cwd: string; trusted: boolean }): ProjectExtensionsResult {
  if (input.trusted || input.config.gate.enabled === false || nonEmpty(input.config.gate.command)) return { config: input.config, skipped: [] };
  const found = discoverGateCommand(input.cwd);
  if (found === undefined) return { config: input.config, skipped: [] };
  return { config: { ...input.config, gate: { ...input.config.gate, enabled: false } }, skipped: [{ kind: "gate-discovery", command: found }] };
}
