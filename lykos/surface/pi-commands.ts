// T163 — the commands Pi extensions registered, handed to the command surface.
//
// Pi's extension runner is the one place that knows them: `registerCommand`
// adds to the registering extension's own map, and `getRegisteredCommands()`
// resolves the whole set with Pi's invocation names (`foo:1`, `foo:2` when two
// Pi extensions register the same word). Read here once per session, after
// boot, the same moment the skill and Lykos-extension rosters are set.

import { basename, dirname } from "node:path";
import { commandConflicts, setPiExtensionCommands, type PiCommandSpec } from "./commands.js";

/** The part of a booted session this reads: Pi's extension runner, if it has one. */
export interface PiCommandSource {
  session: {
    extensionRunner?: {
      getRegisteredCommands(): ReadonlyArray<{
        name: string;
        invocationName?: string;
        description?: string;
        sourceInfo?: { path?: string; source?: string };
      }>;
    };
  };
}

/** A readable name for the Pi extension a command came from: its package directory, or its file. */
export function piExtensionName(sourceInfo: { path?: string; source?: string } | undefined): string {
  const path = sourceInfo?.path;
  if (path === undefined || path.length === 0) return sourceInfo?.source ?? "unknown";
  const file = basename(path).replace(/\.(?:[cm]?[jt]s)$/, "");
  return file === "index" ? basename(dirname(path)) : file;
}

export function piCommandsOf(booted: PiCommandSource): PiCommandSpec[] {
  const commands = booted.session.extensionRunner?.getRegisteredCommands() ?? [];
  return commands.map((c) => ({
    name: c.invocationName ?? c.name,
    description: c.description ?? "",
    extension: piExtensionName(c.sourceInfo),
  }));
}

/** Registers this session's Pi-extension commands and returns every conflict to report, one line each. */
export function registerPiCommands(booted: PiCommandSource): string[] {
  setPiExtensionCommands(piCommandsOf(booted));
  return commandConflicts();
}
