// Specialists tickets 02 and 04 — the command-line surface for the specialist
// roster.
//
// Ticket 04 gave the interactive `/specialist` command its listing and its
// switch. This file is the non-interactive half, and it exists for one
// checkbox ticket 02 could not close on its own:
//
//   "The five fields Pi's own preset format shares remain readable by it: a
//    Lykos specialist file is valid input to Pi's preset extension for those
//    five."
//
// Pi's preset extension reads ONE JSON map at `<cwd>/.pi/presets.json`
// (`examples/extensions/preset.ts`, `loadPresets()`); a Lykos specialist is one
// YAML file per name under `.lykos/specialists/`. The two shapes cannot be the
// same file, so `config/pi-preset-export.ts` translates at the boundary —
// AGENTS.md rule 7. That translator was written but nothing called it, which
// made the checkbox unmet in practice: no command ever produced the file Pi
// reads. `lykos specialist export-pi` is that command.

import { homedir } from "node:os";
import { join } from "node:path";
import { discoverSpecialists, shippedSpecialistsDir } from "../config/specialists.js";
import { writePiPresetsFile } from "../config/pi-preset-export.js";
import { formatSpecialistList } from "../session/specialist-switch.js";
import { stdoutWrite } from "../tui/io-mode.js";
import { loadConfig } from "../config/load.js";
import {
  applySpecialist,
  type SpecialistApplication,
  type SpecialistContext,
  type SpecialistFields,
} from "../session/specialist-apply.js";
import { applyToolDeltas, resolveStandaloneTools } from "../tools.js";

/** `~/.lykos` — the same default `loadConfig` uses when no override is given. */
export function defaultGlobalDir(): string {
  return join(homedir(), ".lykos");
}

/**
 * `lykos specialist list` — every discoverable specialist with its one-line
 * `description`. Reuses ticket 04's renderer so the interactive `/specialist`
 * listing and this one can never drift apart.
 */
export function runSpecialistList(cwd: string, globalDir: string, shippedDir: string = shippedSpecialistsDir()): number {
  const locations = discoverSpecialists(cwd, globalDir, shippedDir);
  stdoutWrite(`${formatSpecialistList(locations, undefined)}\n`);
  return 0;
}

/**
 * `lykos specialist export-pi` — translate the specialist roster into Pi's own
 * `presets.json` for the five fields the two formats share.
 *
 * A specialist that fails to resolve is reported and skipped rather than
 * aborting the export: one broken file should not deny Pi every other
 * specialist. The exit code is non-zero when anything was skipped, so a script
 * can tell a partial export from a clean one.
 */
export function runSpecialistExportPi(cwd: string, globalDir: string, shippedDir: string = shippedSpecialistsDir()): number {
  const { path, written, errors } = writePiPresetsFile(cwd, globalDir, shippedDir);
  const names = written.length > 0 ? written.join(", ") : "(none)";
  stdoutWrite(`lykos: wrote ${written.length} specialist(s) to ${path} for Pi's preset extension: ${names}\n`);
  for (const err of errors) process.stderr.write(`lykos specialist export-pi: skipped — ${err}\n`);
  return errors.length > 0 ? 1 : 0;
}


export interface SpecialistShowOptions {
  globalDir?: string;
  shippedDir?: string;
  context?: SpecialistContext;
}

/**
 * Render the specialist application result as diffable text.
 * D3: three named groups: resident, mounted, off.
 * D4: deterministic and diffable (tools sorted, no timestamps).
 * D5: omit off group if empty.
 * D2: neither command may branch on prompt_mode or tools_mode.
 */
export function formatSpecialistShow(app: SpecialistApplication, name: string): string {
  const lines: string[] = [
    `specialist: ${name}`,
    `prompt_mode: ${app.promptMode}`,
    `tools_mode: ${app.toolsMode}`,
    `model: ${app.model ?? "(default)"}`,
    "tools:",
  ];

  const resident = [...new Set(app.tools.filter((t) => t.disposition === "resident").map((t) => t.name))].sort();
  lines.push(`  resident: ${resident.length > 0 ? resident.join(", ") : "(none)" }`);
  const mounted = [...new Set(app.tools.filter((t) => t.disposition === "mounted").map((t) => t.name))].sort();
  lines.push(`  mounted: ${mounted.length > 0 ? mounted.join(", ") : "(none — P10.1)"}`);

  const off = [...new Set(app.tools.filter((t) => t.disposition === "off").map((t) => t.name))].sort();
  if (off.length > 0) {
    lines.push(`  off: ${off.join(", ")}`);
  }

  if (app.notices.length > 0) {
    lines.push("notices:");
    for (const notice of app.notices) {
      lines.push(`  - ${notice}`);
    }
  }

  return lines.join("\n");
}

/**
 * `lykos specialist show <name>` — inspect what a specialist will do before running it.
 * Reads applySpecialist's result and reimplements none of its rules (D2).
 */
export function runSpecialistShow(
  cwd: string,
  name: string,
  opts: SpecialistShowOptions = {},
): number {
  const context: SpecialistContext = opts.context ?? "session-start";

  let loaded;
  try {
    loaded = loadConfig({
      cwd,
      ...(opts.globalDir !== undefined ? { globalDir: opts.globalDir } : {}),
      ...(opts.shippedDir !== undefined ? { shippedSpecialistsDir: opts.shippedDir } : {}),
      specialistName: name,
    });
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
  const { resolved, layers } = loaded;

  const specLayer = layers.find((l) => l.name === "specialist");
  const specialistFields: SpecialistFields | undefined = specLayer?.present
    ? {
        ...(specLayer.value as SpecialistFields),
        ...(resolved.instructions !== undefined ? { instructions: resolved.instructions } : {}),
      }
    : undefined;

  const isChild = false;
  const baseTools = resolved.tools;
  const hasSpecialistTools =
    resolved.tools !== undefined ||
    (resolved.tools_add !== undefined && resolved.tools_add.length > 0) ||
    (resolved.tools_remove !== undefined && resolved.tools_remove.length > 0);
  const defaultToolNames = resolveStandaloneTools({
    isChild,
  });
  const specialistToolNames = hasSpecialistTools
    ? applyToolDeltas(
        resolveStandaloneTools({
          ...(baseTools !== undefined ? { tools: baseTools } : {}),
          isChild,
        }),
        resolved.tools_add,
        resolved.tools_remove,
      )
    : undefined;

  const app = applySpecialist({
    name,
    ...(specialistFields !== undefined ? { specialist: specialistFields } : {}),
    context,
    defaultToolNames,
    ...(specialistToolNames !== undefined ? { specialistToolNames } : {}),
  });

  const allNotices = [...new Set([...app.notices, ...(specLayer?.notices ?? [])])];
  const appWithNotices = { ...app, notices: allNotices };
  stdoutWrite(`${formatSpecialistShow(appWithNotices, name)}\n`);
  return 0;
}
