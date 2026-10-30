// T64 — retrospective hit quality, from the diff (`docs/20-phase9-tasks.md` §5).
//
// `problems/06-retrieval-engine-scope.md` mitigation 2, whose instruction is
// unusually specific: *"Define 'hit quality' as a metric on day one... After
// a task is done, the files that actually changed are known — from the diff.
// Retrieval hit quality is: did the returned context include them, and at
// what rank? Computed retrospectively from real sessions, this is the one
// retrieval metric available for free... build that before building any
// ranking heuristic."*
//
// The insight that makes it free: **a session's own trace already contains
// its answer key.** The files the agent edited are the files that mattered,
// and they are known after the fact with no labelling and no judgement call.
// So the question "how much exploration did it take to reach the file that
// mattered?" is answerable today, over history, with no retrieval built —
// which is what converts Phase 9 from a phase `02-plan.md` §1 marks
// "Measurable for free? **No**" into one with a real before-number.
//
// Three metrics per session:
//
//   first_touch_rank  For each file the session edited, how many exploration
//                     calls had happened by the time it first read that file.
//                     1 means it went straight there. High means it read a
//                     lot of wrong files first, which is exactly the pain a
//                     repo map would relieve.
//   blind_edits       Files edited that were never read first. Not a
//                     retrieval failure — usually a new file — but it has to
//                     be separated out, because counting a `write` of a file
//                     created from nothing as "rank 0, found instantly"
//                     would make hit quality look perfect for free.
//   hit_quality       Share of edited files that were read before being
//                     edited. The pre-retrieval baseline.
//
// **This is not `calls.retrieval_hit_quality`, and must never be written
// there.** That column is per *call* and means "did this retrieval call's
// returned set contain the files that turned out to matter". There is no
// retrieval call yet, so it stays NULL and gets its first writer in T69/T70.
// What this module produces is per *session*, needs no retrieval to exist,
// and is the before-number that column will eventually be compared against.
// Collapsing the two would make the baseline look like a result.
//
// **A deliberate looseness, and the direction it errs in.** After T20 a file
// is often read through `bash` (`sed -n '1,40p' docs/02-plan.md`), not the
// `read` tool, so a path is credited as read when an exploration command
// mentions it — by full path or by basename as a whole token. That can
// over-credit: a `grep` whose *output* happens to name the file counts as
// having read it. Over-crediting lowers first_touch_rank and raises
// hit_quality, which makes the case for building retrieval *weaker*, not
// stronger. That is the same direction T63's conservative classifier errs
// in, and it is the direction this phase's gate must err in.

import { classifyToolCall } from "../loop/exploration.js";
import { resolveActualToolArgs, resolveActualToolName } from "../tools/tool-call.js";

/** Bumped when the definitions above change in a way that makes rows incomparable. */
// 2 (P4 T143): an edit is whatever the tool registry declares file-changing,
// through the `tool_call` transport — `ast_edit` and an `lsp` rename count.
// 3 (T159): an `ast_edit` or `lsp` rename's edited files are the ones its
// RESULT says it changed (`details.changedFiles`), not its arguments — a
// rewrite over `src/` recorded `src`, and a rename recorded one file of many.
export const HIT_QUALITY_VERSION = 3;

export interface HitQualityToolCall {
  name?: string | undefined;
  state?: string | undefined;
  args?: unknown;
  /** T159: the tool's result, whose `details.changedFiles` names what a multi-file edit changed. */
  result?: unknown;
}

/** T159: the tools whose result, not their arguments, says which files they changed. */
const RESULT_REPORTS_FILES = new Set(["ast_edit", "lsp"]);

/**
 * T159: the files a call's result says it changed, or undefined when the
 * result does not say (an older trace, or a result spilled to an artifact
 * stub) — in which case the arguments are all there is.
 */
export function changedFilesFromResult(result: unknown): string[] | undefined {
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return undefined;
  const files = (details as { changedFiles?: unknown }).changedFiles;
  if (!Array.isArray(files)) return undefined;
  return files.filter((f): f is string => typeof f === "string" && f.length > 0).map(normalizePath);
}

export interface EditedFile {
  /** Path as the trace recorded it, normalised to forward slashes. */
  path: string;
  /** Exploration calls that had happened when this file was first read. NULL when it was never read first. */
  rank: number | null;
  /** True when the file was edited without ever being read — a new file, or an edit made on faith. */
  blind: boolean;
}

export interface HitQuality {
  files: EditedFile[];
  editedFileCount: number;
  blindEdits: number;
  /** Mean rank over the files that *were* read first. NULL when none were. */
  firstTouchRank: number | null;
  /** Share of edited files read before being edited. NULL when the session edited nothing. */
  hitQuality: number | null;
  version: number;
}

export function emptyHitQuality(): HitQuality {
  return {
    files: [],
    editedFileCount: 0,
    blindEdits: 0,
    firstTouchRank: null,
    hitQuality: null,
    version: HIT_QUALITY_VERSION,
  };
}

/** Forward slashes, no trailing separator, no `./` prefix. Windows hosts write both separators. */
export function normalizePath(raw: string): string {
  let p = raw.replace(/\\/g, "/").trim();
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  if (p.startsWith("./")) p = p.slice(2);
  return p;
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

function pathFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const rec = args as Record<string, unknown>;
  // Same key order `edit-retry.ts` uses, plus `file_path`, which Pi's write tool emits.
  for (const key of ["path", "file_path", "file", "target", "filename"]) {
    const v = rec[key];
    if (typeof v === "string" && v.length > 0) return normalizePath(v);
  }
  return undefined;
}

function commandFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const rec = args as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    const v = rec[key];
    if (typeof v === "string") return v;
  }
  return undefined;
}

/**
 * Does this exploration command name the given path?
 *
 * Full path first (the unambiguous case), then the basename as a whole token
 * — bounded by anything that is not a path character, so `plan.md` matches in
 * `head -40 docs/02-plan.md` but `an.md` does not.
 */
export function commandMentionsPath(command: string, path: string): boolean {
  const haystack = normalizePath(command);
  // Both the full path and the bare basename are matched on token
  // boundaries, never as a naked substring: `ls a` must not count as having
  // read a file called `a`, and `cat session.tsx` must not count as having
  // read `session.ts`.
  return mentionsToken(haystack, path) || mentionsToken(haystack, basename(path));
}

function mentionsToken(haystack: string, needle: string): boolean {
  // Under three characters a name is not evidence of anything.
  if (needle.length < 3) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `/` is *allowed* on both boundaries so a relative path matches inside an
  // absolute one (`lykos/session/session.ts` inside `C:/Work/lykos/session/session.ts`).
  // Letters, digits, `_`, `.` and `-` are not, which is what keeps
  // `session.ts` from matching `session.tsx` and `02-plan.md` from matching
  // `002-plan.mdx`.
  const boundary = "[^A-Za-z0-9_.\\-]";
  return new RegExp(`(^|${boundary})${escaped}(${boundary}|$)`).test(haystack);
}

/**
 * The paths an edit names: the one path most tools take, or every entry of
 * `ast_edit`'s `paths` (which may be a directory or a glob — recorded as
 * given, because which files a rewrite reached is in its result, not its call).
 */
function editedPathsFromArgs(args: unknown): string[] {
  const one = pathFromArgs(args);
  if (one !== undefined) return [one];
  if (!args || typeof args !== "object" || Array.isArray(args)) return [];
  const many = (args as Record<string, unknown>).paths;
  if (!Array.isArray(many)) return [];
  return many.filter((p): p is string => typeof p === "string" && p.length > 0).map(normalizePath);
}

/**
 * Compute hit quality from one session's tool-call trace, in order.
 *
 * A failed edit (`state === "error"`) does not establish that the file
 * mattered — the model may have been editing the wrong file, which is the
 * failure retrieval is supposed to prevent, not evidence of a hit. Only
 * successful edits count. A trace with no `state` recorded (older snapshots)
 * is treated as successful, since refusing every one of them would empty the
 * historical baseline this task exists to produce.
 */
export function computeHitQuality(toolCalls: ReadonlyArray<HitQualityToolCall> | undefined): HitQuality {
  const out = emptyHitQuality();
  if (!toolCalls || toolCalls.length === 0) return out;

  // Pass 1: when was each path first read, measured in exploration calls so far.
  const firstReadRank = new Map<string, number>();
  const firstEditIndex = new Map<string, number>();
  let exploreSoFar = 0;

  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i]!;
    const name = typeof call.name === "string" ? call.name : "";
    const cls = classifyToolCall(call);

    if (cls.kind === "explore") {
      exploreSoFar += 1;
      const direct = pathFromArgs(call.args);
      if (direct !== undefined && !firstReadRank.has(direct)) firstReadRank.set(direct, exploreSoFar);
      // A bash exploration reads whatever its command names; resolved lazily
      // in pass 2 against the paths that turned out to matter, because the
      // set of interesting paths is not known until the edits are seen.
      continue;
    }

    if (cls.kind === "edit" && call.state !== "error") {
      // An edit with no recoverable path cannot be attributed to a file. It
      // is skipped rather than guessed at — the same choice `edit-retry.ts`
      // makes for the retry rate.
      const actual = resolveActualToolName(name, call.args) ?? name;
      const reported = RESULT_REPORTS_FILES.has(actual) ? changedFilesFromResult(call.result) : undefined;
      for (const path of reported ?? editedPathsFromArgs(resolveActualToolArgs(name, call.args))) {
        if (!firstEditIndex.has(path)) firstEditIndex.set(path, i);
      }
    }
  }

  if (firstEditIndex.size === 0) return out;

  // Pass 2: for each edited path, find the earliest exploration call before
  // its first edit that read it — directly, or by naming it in a command.
  const files: EditedFile[] = [];
  for (const [path, editIndex] of firstEditIndex) {
    let rank: number | null = null;
    let explore = 0;
    for (let i = 0; i < editIndex; i++) {
      const call = toolCalls[i]!;
      if (classifyToolCall(call).kind !== "explore") continue;
      explore += 1;
      const direct = pathFromArgs(call.args);
      if (direct === path) {
        rank = explore;
        break;
      }
      const command = commandFromArgs(call.args);
      if (command !== undefined && commandMentionsPath(command, path)) {
        rank = explore;
        break;
      }
    }
    files.push({ path, rank, blind: rank === null });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const seen = files.filter((f) => !f.blind);
  out.files = files;
  out.editedFileCount = files.length;
  out.blindEdits = files.length - seen.length;
  out.firstTouchRank =
    seen.length > 0 ? seen.reduce((sum, f) => sum + (f.rank ?? 0), 0) / seen.length : null;
  out.hitQuality = files.length > 0 ? seen.length / files.length : null;
  return out;
}

/** Compact JSON for the `edited_files` column. */
export function serializeEditedFiles(hq: HitQuality): string {
  return JSON.stringify(hq.files);
}

/** Tool calls carried by a transcript, in order — the retrospective path's input. */
export function toolCallsFromTranscript(
  events: ReadonlyArray<{ kind?: string; name?: string; state?: string; args?: unknown; result?: unknown }>,
): HitQualityToolCall[] {
  const out: HitQualityToolCall[] = [];
  for (const ev of events) {
    if (ev.kind !== "tool_call") continue;
    out.push({ name: ev.name, state: ev.state, args: ev.args, ...(ev.result !== undefined ? { result: ev.result } : {}) });
  }
  return out;
}
