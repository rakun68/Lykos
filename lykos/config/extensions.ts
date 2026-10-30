// T29 — the declarative third-party extension surface (`docs/10-phase2-tasks.md`,
// `docs/06-extension-policy.md` §1 and §3, `problems/13-separation-from-pi.md`
// mitigations 1 and 4, `problems/14-extension-sprawl.md`).
//
// **What this task is, and is not.** Lykos can already load any Pi extension —
// `additionalExtensionPaths` gets a deterministic caller-controlled position and
// loads even under `noExtensions: true` (verified at source in T16.1), and
// `pi-cache-optimizer` ships through that path today. What was missing is a way
// for a *user* to say "also load extension X" without editing Lykos. This
// module is that declaration and its translation, and nothing else.
//
// **Two surfaces, deliberately separate.**
//   - **`lykos extensions install`** is the *installation* surface: it npm-installs
//     a pinned set into Pi's own package prefix on the host. A runtime
//     `npm install` at session start would be both a startup tax and a
//     supply-chain hole (`problems/11`).
//   - **`config.yaml` is the *activation* surface**: which of them a session
//     actually loads, in what order, at which hop.
// `lykos doctor` reconciles the two (T29.5). Adding a genuinely new extension is
// therefore one line here, and **no change to any
// Lykos code and no patch to Pi or to any extension** — which is the accretion
// `problems/13` exists to prevent.
//
// **Translation happens at the boundary, never inside the extension.** A
// declaration resolves to a path in this machine's install tree; the extension is never
// told about `.lykos/` (AGENTS.md rule 7).
//
// **Versions are exact, never ranges** (`06-extension-policy.md` bar 5). A
// floating version silently changes both the head and the tool surface, which is
// two intake-bar violations at once, and it does it without a commit anyone can
// point at.

import { createHash } from "node:crypto";
import { REGISTRY_OFF_TOOLS } from "../tools/tool-surface.js";
import {
  defaultExtensionPath,
  defaultExtensionVersion,
  isDefaultExtension,
  type DefaultExtensionKind,
} from "../extensions/defaults/index.js";

/** The only scope that exists today. Specialist names become legal here once Phase 8 lands. */
export const HOP0_SCOPE = "hop0";

/**
 * T147 (backlog D25): the config.yaml key that declares LYKOS extensions —
 * packages written against `extensions/api.ts`, not Pi's API. Same entry
 * shape as `extensions:` (`ExtensionDecl`), resolved to the same per-machine
 * path, reported missing by the same notice and installed by the same host
 * install path. Only the loader differs (`extensions/load.ts`).
 */
export const LYKOS_EXTENSIONS_KEY = "lykos_extensions";

/** One `extensions:` (or `lykos_extensions:`) entry in config.yaml. */
export interface ExtensionDecl {
  name: string;
  /** Exact. Optional only for a default extension, where omitted means the build shipped with this Lykos. */
  version?: string;
  /** Defaults to `[hop0]`. A specialist name is accepted and carried, but nothing consumes it before Phase 8. */
  scope?: string[];
}

export interface ResolvedExtension {
  name: string;
  version: string;
  scope: string[];
  /** True when this declaration applies to the hop-0 worker. */
  hop0: boolean;
}

export interface ExtensionResolution {
  extensions: ResolvedExtension[];
  /** One line per rejected declaration, naming the declaration and why. Never silently dropped. */
  errors: string[];
}

/**
 * npm package name, optionally scoped. Deliberately strict: this string becomes
 * a filesystem path under an install tree, so anything that could climb out of
 * `node_modules` is rejected rather than sanitised.
 */
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** Exact semver, with an optional prerelease/build tail. No range operators, no `x`, no `latest`. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function isExactVersion(version: unknown): version is string {
  return typeof version === "string" && EXACT_VERSION.test(version);
}

export function isPackageName(name: unknown): name is string {
  return typeof name === "string" && name.length <= 214 && PACKAGE_NAME.test(name);
}

function readScope(raw: unknown): string[] | null {
  if (raw === undefined) return [HOP0_SCOPE];
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim() === "") return null;
    out.push(entry.trim());
  }
  return out.length > 0 ? out : null;
}

/**
 * Validate and resolve the `extensions:` block. Declaration order is preserved
 * and is load order — an extension that mutates the prompt sees whatever the one
 * before it produced, so re-sorting this list would be a silent head change.
 *
 * Rejections are collected rather than thrown: one bad entry must not take a
 * session down, and a rejection nobody sees is worse than one that is printed.
 *
 * T147 (D25): `key` names the block in each rejection. The Lykos extension
 * list (`lykos_extensions:`, `LYKOS_EXTENSIONS_KEY`) is validated by this same
 * function — same shape, same exact-version rule, same order-is-load-order
 * rule — so the two lists cannot drift into two dialects.
 */
export function resolveExtensions(raw: unknown, key: string = "extensions"): ExtensionResolution {
  const errors: string[] = [];
  const extensions: ResolvedExtension[] = [];
  if (raw === undefined || raw === null) return { extensions, errors };
  if (!Array.isArray(raw)) {
    return { extensions, errors: [`${key}: expected a list, got ${typeof raw}`] };
  }

  const seen = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const where = `${key}[${i}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${where}: expected a mapping with name and version`);
      continue;
    }
    const decl = entry as Record<string, unknown>;
    if (!isPackageName(decl.name)) {
      errors.push(`${where}: "${String(decl.name)}" is not a valid npm package name`);
      continue;
    }
    const name = decl.name;
    // A default extension (it ships inside Lykos) may omit `version`: it then
    // means the build that ships with this Lykos, so a Lykos upgrade cannot
    // leave a project's pinned default pointing at a version no longer bundled.
    // Every other package still needs an exact version.
    const version = decl.version === undefined && isDefaultExtension(name) ? defaultExtensionVersion() : decl.version;
    if (!isExactVersion(version)) {
      errors.push(
        `${where} (${name}): version must be exact, got "${String(decl.version)}" — ` +
          "a range silently changes the head and the tool surface (06-extension-policy.md bar 5)",
      );
      continue;
    }
    const scope = readScope(decl.scope);
    if (scope === null) {
      errors.push(`${where} (${name}): scope must be a non-empty list of names, e.g. [${HOP0_SCOPE}]`);
      continue;
    }
    if (seen.has(name)) {
      errors.push(`${where} (${name}): declared more than once — load order would be ambiguous`);
      continue;
    }
    seen.add(name);
    extensions.push({
      name,
      version,
      scope,
      hop0: scope.includes(HOP0_SCOPE),
    });
  }
  return { extensions, errors };
}

/** Declaration order, hop-0 only. This is what `additionalExtensionPaths` receives. */
export function hop0Extensions(extensions: readonly ResolvedExtension[]): ResolvedExtension[] {
  return extensions.filter((e) => e.hop0);
}

/**
 * The extension that replaces Pi's `read` and `edit` with per-line
 * `LINE#HASH:content` anchors (`docs/reference/extension-policy.md`).
 * T97.1 activated it as a default; T168 (ADR-0031) took it out of the defaults
 * and the scaffold, and boot drops it if a config still declares it.
 */
export const HASHLINE_EDIT_EXTENSION = "pi-hashline-edit";

/**
 * T168 (ADR-0031) — one editor, so `pi-hashline-edit` is never loaded.
 *
 * It registers its own `read` and `edit` under Pi's tool names. Lykos's
 * numbered `read` and text-replacement `edit` are registered under the same
 * two names, and which of two same-named tools wins is decided by load order
 * rather than by anybody. Lykos has one edit mode and ADR-0031 rejected
 * adopting this extension as an opt-in, so a config that still declares it
 * (an old `.lykos/config.yaml`, a copied scaffold) gets the declaration
 * filtered out and a one-line notice naming the decision, never a silent
 * second editor.
 *
 * The declaration is FILTERED at boot, not rewritten in the file: the human's
 * config is theirs, and the notice says which line to remove.
 */
export function withoutHashlineEdit(extensions: readonly ResolvedExtension[]): {
  extensions: ResolvedExtension[];
  notice: string | undefined;
} {
  const kept = extensions.filter((e) => e.name !== HASHLINE_EDIT_EXTENSION);
  if (kept.length === extensions.length) return { extensions: kept, notice: undefined };
  return {
    extensions: kept,
    notice:
      `lykos: ${HASHLINE_EDIT_EXTENSION} was not loaded: it registers its own read and edit, and Lykos has one editor now (ADR-0031). ` +
      `Remove it from extensions: in your config.yaml to silence this.`,
  };
}

// ---------------------------------------------------------------------------
// T97.2 — the same declaration, resolved against the HOST filesystem.
//
// T29 built this surface for the container only, and `session/session.ts` said so
// in a comment for three phases: the standalone agent boots with
// `noExtensions: true` and no `additionalExtensionPaths`, so `config.yaml`'s
// `extensions:` block governed the delegate and nothing else. The shape a human
// drives had no third-party extension surface at all.
//
// The path differs and NOTHING else does. The host declares WHAT to load; where
// it lives is recomputed from that machine's own agent dir, exactly as
// the retired delegate image computed it from the container's. Mirroring the rule
// rather than exporting the container's absolute path is AGENTS.md rule 6 —
// translate at the boundary.
//
// `exists` is injected so the resolution is testable without a real install
// tree, the same reason `doctor.ts` keeps `reconcileHostExtensions` free of file IO.
// ---------------------------------------------------------------------------

/** Where Pi installs its packages under an agent dir, host or container. */
export function hostExtensionPath(agentDir: string, name: string): string {
  // Both separators: the host may be Windows, where `PI_CODING_AGENT_DIR` and
  // `homedir()` both produce backslashes. The joined segments stay forward-slashed
  // because that is what Pi's loader emits, and Node accepts
  // either on Windows.
  const root = agentDir.replace(/[\\/]+$/, "");
  return `${root}/npm/node_modules/${name}`;
}

export interface HostExtension {
  name: string;
  version: string;
  path: string;
}

export interface HostExtensionResolution {
  /** Declared, hop-0, and present on this filesystem. Declaration order preserved. */
  loaded: HostExtension[];
  /**
   * Declared and NOT present. Never silently dropped: Lykos reports a
   * missing declared package rather than skipping it, and that matters more on
   * the host, where today nothing is installed at all.
   */
  missing: HostExtension[];
  /** `additionalExtensionPaths`, in declaration order — load order. */
  paths: string[];
}

export function resolveHostExtensions(
  extensions: readonly ResolvedExtension[],
  agentDir: string,
  exists: (path: string) => boolean,
  /**
   * T148: which list this is — `extensions:` (Pi) or `lykos_extensions:` — so
   * a default extension resolves only from the list its API belongs to.
   */
  kind: DefaultExtensionKind = "pi",
): HostExtensionResolution {
  const loaded: HostExtension[] = [];
  const missing: HostExtension[] = [];
  const paths: string[] = [];
  for (const e of hop0Extensions(extensions)) {
    // T148: a default extension ships inside Lykos's package and resolves there;
    // everything else — including a default's name pinned at another version —
    // resolves to this machine's install tree like any third-party package.
    const bundled = defaultExtensionPath(e.name, e.version, kind);
    const entry: HostExtension = {
      name: e.name,
      version: e.version,
      path: bundled ?? hostExtensionPath(agentDir, e.name),
    };
    if (exists(entry.path)) {
      loaded.push(entry);
      paths.push(entry.path);
    } else {
      missing.push(entry);
    }
  }
  return { loaded, missing, paths };
}

/**
 * The one line a standalone session prints about its extension surface. Returns
 * undefined when there is nothing to say — nothing declared and nothing missing
 * — so a default session stays silent.
 */
export function hostExtensionNotice(
  resolution: HostExtensionResolution,
  kind: string = "extensions",
): string | undefined {
  const parts: string[] = [];
  if (resolution.loaded.length > 0) {
    parts.push(`${kind} loaded: ${resolution.loaded.map((e) => `${e.name}@${e.version}`).join(", ")}`);
  }
  if (resolution.missing.length > 0) {
    parts.push(
      `${kind} DECLARED BUT NOT INSTALLED on this host: ${resolution.missing
        .map((e) => `${e.name}@${e.version}`)
        .join(", ")} — declared in config.yaml, absent from the host agent dir, so this session runs without them. ` +
        "Install them with `lykos extensions install`",
    );
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

/**
 * A stable handle for "which extensions were in force", so `lykos cost --compare
 * extensions` can split real work on it (T29.4, `06-extension-policy.md` bar 6:
 * adoption is a hypothesis, and a hypothesis with no split is decoration).
 *
 * Order-sensitive on purpose — two sets with the same members in a different
 * load order are not the same configuration.
 */
export function extensionSetKey(extensions: readonly ResolvedExtension[]): string {
  if (extensions.length === 0) return "none";
  const canonical = extensions.map((e) => `${e.name}@${e.version}`).join(",");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/** Human-readable form of the set, for a log line or a doctor row. */
export function extensionSetLabel(extensions: readonly ResolvedExtension[]): string {
  if (extensions.length === 0) return "(none)";
  return extensions.map((e) => `${e.name}@${e.version}`).join(", ");
}

/**
 * Specialists band 2 ticket 02: the environment surface for tool restriction
 * enforcement (D2). All three names and the codec live HERE and nowhere else.
 *
 * The guard extension is loaded by Pi through jiti with `moduleCache: false`,
 * so it is evaluated as its own module graph rather than sharing this process's
 * import cache. A second copy of the encoding in that file would be a second
 * source of truth across a boundary neither side can see, and the first change
 * to one of them would make the writer and the reader disagree silently.
 */
export const SPECIALIST_NAME_ENV = "LYKOS_SPECIALIST_NAME";
export const SPECIALIST_OFF_LIMITS_ENV = "LYKOS_SPECIALIST_OFF_LIMITS";
export const SPECIALIST_ALLOWED_ENV = "LYKOS_SPECIALIST_ALLOWED";
export const REGISTRY_OFF_TOOLS_ENV = "LYKOS_REGISTRY_OFF_TOOLS";

export function encodeSpecialistOffLimitsEnv(tools: readonly string[]): string {
  return JSON.stringify(tools);
}

export function decodeSpecialistOffLimitsEnv(raw: string | undefined): string[] | null {
  if (raw === undefined || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    for (const item of parsed) {
      if (typeof item !== "string") return null;
    }
    return parsed as string[];
  } catch {
    return null;
  }
}

export function encodeRegistryOffToolsEnv(tools: readonly string[]): string {
  return JSON.stringify(tools);
}

export function decodeRegistryOffToolsEnv(raw: string | undefined): string[] | null {
  return decodeSpecialistOffLimitsEnv(raw);
}

/** Same names as `TOOL_REGISTRY` rows with residency `off`. Not a second list. */
export const DEFAULT_REGISTRY_OFF_TOOLS: readonly string[] = REGISTRY_OFF_TOOLS;

