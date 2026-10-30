// Containment, as a request: what level a session asked for, who asked, and
// whether a floor in config allows it (ADR-0036).
//
// The level resolves through the config layers that already exist: the
// caller's argument (the flags layer), then the specialist, project config and
// user config, then a default. The default is the only thing that differs by
// shape: standalone and delegated sessions default to `off` (T219, #75).
// (stories 30, 40). The parent session's level sits between the argument and
// the specialist. `spawn` (T182, #35) passes it, or the level its caller chose,
// as the argument, so a child meets the same floor as any other request.
//
// The floor (`containment.minimum`) is read by the config loader from the
// user and project files only. This module only compares and names.

import type { ConfigLayer, ResolvedConfig } from "../config/types.js";
import type { ContainmentLevel, ContainmentRecord } from "./containment.js";
import type { NetworkMode } from "./runtime.js";

/** Lowest to highest: the one ordering the floor, the loader and the request check share. */
export const CONTAINMENT_LEVELS = ["off", "auto", "required"] as const satisfies readonly ContainmentLevel[];
const RANK = (level: ContainmentLevel): number => CONTAINMENT_LEVELS.indexOf(level);

export const DELEGATED_DEFAULT_LEVEL: ContainmentLevel = "off";

/** A floor in force, and the file (or layer) that set it. */
export interface ContainmentFloor {
  level: ContainmentLevel;
  /** A path when a file set it. */
  source: string;
}

/** The layer that set the floor that won: the higher of the user's and the project's, the project's on a tie. */
export function containmentFloor(config: ResolvedConfig, layers: readonly ConfigLayer[]): ContainmentFloor | undefined {
  const level = config.containment.minimum;
  if (level === "off") return undefined;
  const setters = layers.filter((l) => (l.name === "global" || l.name === "project") && l.value.containment?.minimum === level);
  const winner = setters.at(-1);
  return { level, source: winner?.path ?? `the ${winner?.name ?? "user"} config` };
}

function whereLevelWasSet(layers: readonly ConfigLayer[], flagsFrom: string): { from: string; set: boolean } {
  for (const layer of [...layers].reverse()) {
    if (layer.name === "defaults" || layer.value.containment?.level === undefined) continue;
    switch (layer.name) {
      case "flags":
        return { from: flagsFrom, set: true };
      case "env":
        return { from: "the environment", set: true };
      case "specialist":
        return { from: "the specialist", set: true };
      default:
        return { from: layer.path ?? `the ${layer.name} config`, set: true };
    }
  }
  return { from: "the default", set: false };
}

export type ContainmentRequest =
  | { ok: true; config: ResolvedConfig; floor?: ContainmentFloor }
  | { ok: false; message: string };

/**
 * The effective containment of a session that is about to boot. A delegated
 * session whose layers never named a level gets `auto`. A level below the
 * floor is refused here, before anything boots, naming the floor and the file
 * that set it. `auto` passes a floor of `auto`: whether it falls back is only
 * known once the runtime has been asked (`startContainment`'s `minimum`).
 */
export function resolveContainmentRequest(input: {
  config: ResolvedConfig;
  layers: readonly ConfigLayer[];
  delegated: boolean;
  /** Who passed the level in the flags layer, named in a refusal. Default `--containment`; `spawn` says "the spawn call" (T182). */
  askedFrom?: string;
}): ContainmentRequest {
  const where = whereLevelWasSet(input.layers, input.askedFrom ?? "--containment");
  const config =
    input.delegated && !where.set
      ? { ...input.config, containment: { ...input.config.containment, level: DELEGATED_DEFAULT_LEVEL } }
      : input.config;
  const floor = containmentFloor(config, input.layers);
  const level = config.containment.level;
  if (floor !== undefined && RANK(level as ContainmentLevel) < RANK(floor.level)) {
    return {
      ok: false,
      message:
        `lykos: containment level "${level}" (from ${where.from}) is below the floor "${floor.level}" set by containment.minimum in ` +
        `${floor.source}; ask for "${floor.level}" or lower the floor there`,
    };
  }
  return { ok: true, config, ...(floor !== undefined ? { floor } : {}) };
}

/** How a spawned child's commands run, decided once (T182, spec stories 38 and 39). */
export type ChildContainment =
  /** The parent has no record of its own (a host handed it an executor): the child shares that executor and records nothing. */
  | { kind: "unmanaged" }
  /** The child runs where the parent's commands run, and its row records `record`. */
  | { kind: "share"; record: ContainmentRecord }
  /** The child starts a container of its own at `level`; `network` is the parent's, kept when the specialist sets none. */
  | { kind: "own"; level: ContainmentLevel; network?: NetworkMode }
  | { kind: "refused"; message: string };

/**
 * One decision for a child: the level it runs at (the call's, else the parent's), whether that clears the
 * floor, and whether the parent's container is the right one for it. The container is shared only when it
 * already satisfies the request: the child wants containment exactly when the parent has it, and a
 * specialist's own network or image matches the parent's. A child that starts its own container takes the
 * parent's network unless its specialist sets one, so it never loosens its parent by accident.
 *
 * `config` and `layers` are the child's, loaded with the level as the flags layer.
 */
export function resolveChildContainment(input: {
  parent: ContainmentRecord | undefined;
  asked: ContainmentLevel | undefined;
  config: ResolvedConfig;
  layers: readonly ConfigLayer[];
}): ChildContainment {
  const { parent, asked } = input;
  if (parent === undefined && asked === undefined) return { kind: "unmanaged" };
  const level = asked ?? parent!.requested;
  const request = resolveContainmentRequest({
    config: input.config,
    layers: input.layers,
    delegated: false,
    askedFrom: asked !== undefined ? "the spawn call" : "the parent session",
  });
  if (!request.ok) return { kind: "refused", message: request.message };

  const specialist = input.layers.find((l) => l.name === "specialist")?.value.containment;
  const parentContained = parent !== undefined && parent.used !== "off";
  if (parent !== undefined) {
    const sameKind = asked === undefined || (level !== "off") === parentContained;
    const sameBox =
      !parentContained ||
      ((specialist?.network === undefined || specialist.network === parent.network) &&
        (specialist?.image === undefined || specialist.image === parent.image));
    if (sameKind && sameBox) return { kind: "share", record: { ...parent, requested: level } };
  }
  const network = specialist?.network === undefined ? parent?.network : undefined;
  return { kind: "own", level, ...(network !== undefined ? { network } : {}) };
}

/** One line for the person or the orchestrator: the level used, the runtime, and what was asked when they differ. */
export function formatContainmentResult(record: ContainmentRecord): string {
  if (record.used === "off") {
    return record.requested === "off"
      ? "containment: off (commands ran on this machine)"
      : `containment: off (requested ${record.requested}; no container runtime was available, commands ran on this machine)`;
  }
  const runtime = record.runtime !== undefined ? ` in ${record.runtime}${record.runtimeVersion !== undefined ? ` ${record.runtimeVersion}` : ""}` : "";
  return `containment: ${record.used}${runtime}${record.image !== undefined ? `, image ${record.image}` : ""}`;
}
