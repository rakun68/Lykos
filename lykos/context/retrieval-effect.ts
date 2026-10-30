// T70 — the output cap and the recovery path (`docs/20-phase9-tasks.md` §5).
//
// **What T70 turned out to be, once T69 shipped.** The task was written as
// "a token budget per retrieval result, enforced in the tool layer" plus a
// `retrieval_fallbacks` counter. T69 built the map as a **frozen head
// block rather than a tool**, so half of that is already done — the cap is
// `RepoMapPolicy.maxTokens`, enforced in `renderRepoMap` and tested — and
// the other half has no instances: there is no retrieval *call* to fall back
// *from*.
//
// Rewriting the task to match what exists would be the easy move and the
// wrong one, so what follows is the question T70 was actually for, asked in
// the form the shipped mechanism allows:
//
//   **Did the map surface the files the session went on to need?**
//
// Two measurements, both free, both computed from things already recorded:
//
//   editedMissed   Files the session EDITED that the map did not name. This
//                  is `problems/06`'s early-warning signal verbatim — *"any
//                  task where the agent edited a file that retrieval did not
//                  surface"* — and it is the closest thing to a correctness
//                  test retrieval has. A map that misses the file you change
//                  is not merely useless; `problems/06` calls confidently
//                  wrong retrieval *worse than no retrieval*, because
//                  exploration at least self-corrects.
//   exploreCovered Exploration calls aimed at files the map had ALREADY
//                  named. Every one of these is a read the map was supposed
//                  to prevent and did not. If this stays high while the map
//                  is on, the map is pure cost.
//
// **Neither writes `calls.retrieval_calls` or `calls.retrieval_hit_quality`.**
// Those two columns have existed since T8 with no writer, and they mean "a
// retrieval call happened" and "that call's returned set contained the files
// that mattered". No retrieval call happens on this design, so they stay
// NULL. Filling them from a head block would make a per-call column describe
// something that is not a call — the same category error T64 refused when it
// kept session-level hit quality out of `retrieval_hit_quality`.
//
// **`bash` is untouched.** `problems/06` mitigation 5: retrieval augments
// exploration and never replaces it, and the agent must be able to recover
// when the map misses. T69 added no tool and removed none; `exploreCovered`
// is how often that recovery was needed anyway.

import { classifyToolCall } from "../loop/exploration.js";
import { normalizePath, type HitQualityToolCall } from "../session/hit-quality.js";
import { REPO_MAP_HEADING } from "./repo-map.js";

export const RETRIEVAL_EFFECT_VERSION = 1;

export interface RetrievalEffect {
  version: number;
  /** Repo-relative paths the map named. Empty when no map was injected. */
  mapNamed: Set<string>;
  /** Files edited that the map DID name. */
  editedCovered: number;
  /** Files edited that the map did NOT name — problems/06's warning signal. */
  editedMissed: number;
  /** Paths of those misses, so the signal is inspectable rather than a bare count. */
  missedPaths: string[];
  /** Exploration calls aimed at a file the map had already named. Reads the map should have prevented. */
  exploreCovered: number;
  /** Exploration calls aimed at something the map did not name. */
  exploreUncovered: number;
}

export function emptyRetrievalEffect(): RetrievalEffect {
  return {
    version: RETRIEVAL_EFFECT_VERSION,
    mapNamed: new Set(),
    editedCovered: 0,
    editedMissed: 0,
    missedPaths: [],
    exploreCovered: 0,
    exploreUncovered: 0,
  };
}

/**
 * Recover the repo-relative paths a rendered map named.
 *
 * The map renders one line per directory as `dir/  a.ts b.ts (+N more)`, so
 * the paths are reconstructed by joining. The `(+N more)` suffix and the
 * overflow footer are deliberately NOT counted: those files were *not*
 * surfaced, and counting them as named would let the map take credit for
 * everything it dropped — which would turn `editedMissed` into a metric that
 * can never fire.
 */
export function parseMapFiles(mapText: string): Set<string> {
  const out = new Set<string>();
  if (!mapText.startsWith(REPO_MAP_HEADING)) return out;
  for (const line of mapText.split("\n")) {
    const m = /^(\S+)\/\s\s(.+)$/.exec(line);
    if (!m) continue;
    const dir = m[1]!;
    const names = m[2]!.replace(/\s*\(\+\d+ more\)\s*$/, "").trim();
    if (names.length === 0) continue;
    for (const name of names.split(/\s+/)) {
      out.add(dir === "." ? name : `${dir}/${name}`);
    }
  }
  return out;
}

function pathOf(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const rec = args as Record<string, unknown>;
  for (const key of ["path", "file_path", "file", "target", "filename"]) {
    const v = rec[key];
    if (typeof v === "string" && v.length > 0) return normalizePath(v);
  }
  return undefined;
}

function commandOf(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const rec = args as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    const v = rec[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/** True when a command names a path the map already listed. */
function commandHitsMap(command: string, mapNamed: ReadonlySet<string>): boolean {
  const haystack = normalizePath(command);
  for (const path of mapNamed) {
    if (path.length >= 3 && haystack.includes(path)) return true;
  }
  return false;
}

const EDIT_TOOLS = new Set(["edit", "write"]);

/**
 * Compute the effect of one session's map against its own trace.
 *
 * An empty `mapText` yields an empty result rather than zeros that look
 * measured: a session with no map has no coverage, which is a different
 * answer from a map that covered nothing.
 */
export function retrievalEffect(
  mapText: string,
  toolCalls: ReadonlyArray<HitQualityToolCall> | undefined,
): RetrievalEffect {
  const out = emptyRetrievalEffect();
  out.mapNamed = parseMapFiles(mapText);
  if (out.mapNamed.size === 0 || !toolCalls || toolCalls.length === 0) return out;

  const editedSeen = new Set<string>();
  for (const call of toolCalls) {
    const name = typeof call.name === "string" ? call.name : "";

    if (EDIT_TOOLS.has(name) && call.state !== "error") {
      const path = pathOf(call.args);
      if (path !== undefined && !editedSeen.has(path)) {
        editedSeen.add(path);
        if (out.mapNamed.has(path)) out.editedCovered += 1;
        else {
          out.editedMissed += 1;
          out.missedPaths.push(path);
        }
      }
      continue;
    }

    if (classifyToolCall(call).kind !== "explore") continue;
    const direct = pathOf(call.args);
    if (direct !== undefined) {
      if (out.mapNamed.has(direct)) out.exploreCovered += 1;
      else out.exploreUncovered += 1;
      continue;
    }
    const command = commandOf(call.args);
    if (command !== undefined && commandHitsMap(command, out.mapNamed)) out.exploreCovered += 1;
    else out.exploreUncovered += 1;
  }

  out.missedPaths.sort();
  return out;
}
