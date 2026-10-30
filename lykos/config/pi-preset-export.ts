// "The five fields Pi's own preset format shares remain
// readable by it: a Lykos specialist file is valid input to Pi's preset
// extension for those five".
//
// **The two formats do not match as files, and cannot be made to.** Ticket
// 01 chose one YAML file per specialist (`.lykos/specialists/<name>.yaml`;
// handoff 01). Pi's preset extension
// (`node_modules/@earendil-works/pi-coding-agent/examples/extensions/
// preset.ts`, read at implementation time per rule 2) reads a SINGLE JSON
// file that is a map of `name -> Preset`, from a fixed, non-redirectable
// location (`~/.pi/agent/presets.json` or `<cwd>/.pi/presets.json` —
// `loadPresets()` builds both paths itself with no override). Different
// serialization (JSON vs YAML), different shape (one map vs one file per
// specialist), different location. Changing ticket 01's format to match would
// undo a settled decision for a compatibility feature that is not this
// project's own mechanism.
//
// **Resolution: translate at the boundary (rule 7)** — populate the location
// Pi's extension already looks at rather than teaching or patching it to look
// elsewhere, the pattern T10 once followed for `.pi/agents/*.md` (that
// generator was removed in #47 with the delegate container it fed). This
// module: `exportPiPresets()` is a pure function producing exactly Pi's
// `Preset` shape (only the five shared fields — extra keys are dropped, not
// merely ignored, so the output is unambiguously valid `Preset[]` input) for
// every discovered specialist, and `writePiPresetsFile()` writes it to
// `<cwd>/.pi/presets.json`.
//
// **Still needed after ADR-0027 (P14 ticket 08, D5), checked against source.**
// Pi's core never reads a presets file: nothing in the installed
// `@earendil-works/pi-coding-agent` 0.84.3 `dist/` names `presets.json`. Its one
// reader is Pi's preset extension, `examples/extensions/preset.ts` line 72
// (`join(cwd, CONFIG_DIR_NAME, "presets.json")`), which is `cwd`-relative and
// so untouched by moving the agent directory; its global twin on line 71 uses
// `getAgentDir()`, which a Lykos process now points at the pi-host. The file
// is kept because that extension, run by Pi in this workspace, still reads it,
// and it stays generated from `.lykos/` specialists and written only when a
// person asks (`lykos specialist export-pi`).
//
// **Deliberately NOT called from `boot()` or from every session start**,
// unlike T10's agents generation. Two differences from that case: producing
// this export requires a full specialist-directory scan (`discoverSpecialists()`
// plus one parse per file), not a per-session cost every boot already pays;
// and Pi's preset extension is an opt-in example a project may never have
// installed, so writing into its `.pi/presets.json` unconditionally would be
// an unasked-for file write for a mechanism most sessions never use. This is
// exported as a ready, tested mechanism; wiring it to a CLI command (e.g.
// `lykos specialist export-pi`) is interface surface and left to the
// specialist-switching work, consistent with how specialist discovery left
// `discoverSpecialists()` unconnected to any CLI command for the same reason.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { discoverSpecialists, resolveSpecialistLayer, shippedSpecialistsDir } from "./specialists.js";
import type { ThinkingLevel } from "./types.js";

/** Exactly Pi's own `Preset` interface (`examples/extensions/preset.ts`) — copied, not imported: Pi ships it as example source, not a package export. */
export interface PiPreset {
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  instructions?: string;
}

export type PiPresetsConfig = Record<string, PiPreset>;

/** Extracts only the five Pi-compatible fields from a resolved specialist's `ConfigFile` value, dropping every Lykos-owned one. */
export function toPiPreset(value: {
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  instructions?: string;
}): PiPreset {
  const preset: PiPreset = {};
  if (value.provider !== undefined) preset.provider = value.provider;
  if (value.model !== undefined) preset.model = value.model;
  if (value.thinkingLevel !== undefined) preset.thinkingLevel = value.thinkingLevel;
  if (value.tools !== undefined) preset.tools = value.tools;
  if (value.instructions !== undefined) preset.instructions = value.instructions;
  return preset;
}

/**
 * Every discoverable specialist (project overriding global overriding shipped by
 * name, same rule `discoverSpecialists`/`resolveSpecialistLayer` already follow),
 * reduced to its Pi-compatible five. A specialist that fails to resolve (an
 * unknown field, an unknown tool, volatile instructions) is skipped rather
 * than failing the whole export — `errors` names which and why, so the export
 * is honest about what it left out instead of silently thinning the roster.
 */
export function exportPiPresets(cwd: string, globalDir: string, shippedDir: string = shippedSpecialistsDir()): { presets: PiPresetsConfig; errors: string[] } {
  const presets: PiPresetsConfig = {};
  const errors: string[] = [];
  for (const loc of discoverSpecialists(cwd, globalDir, shippedDir)) {
    try {
      const layer = resolveSpecialistLayer(loc.name, cwd, globalDir, shippedDir);
      presets[loc.name] = toPiPreset(layer.value);
    } catch (err) {
      errors.push(`${loc.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { presets, errors };
}

/** `<cwd>/.pi/presets.json` — Pi's own preset extension's fixed project-local path (`loadPresets()`, `CONFIG_DIR_NAME` + `presets.json`). */
export function piPresetsPath(cwd: string): string {
  return join(cwd, ".pi", "presets.json");
}

/**
 * Writes the export to Pi's own expected location. Errors from specialists that
 * did not resolve are returned, never thrown — a broken specialist should not
 * block every other specialist's export.
 */
export function writePiPresetsFile(cwd: string, globalDir: string, shippedDir: string = shippedSpecialistsDir()): { path: string; written: string[]; errors: string[] } {
  const { presets, errors } = exportPiPresets(cwd, globalDir, shippedDir);
  const path = piPresetsPath(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(presets, null, 2)}\n`, "utf8");
  return { path, written: Object.keys(presets), errors };
}
