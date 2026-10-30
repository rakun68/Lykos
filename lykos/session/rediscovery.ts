// T66 — the rediscovery rate, measured before anything is built
// (`docs/20-phase9-tasks.md` §5).
//
// `problems/09-memory-rot.md` asks one question and says it should decide
// whether Phase 10 happens at all:
//
//   *"What is the actual rediscovery rate across sessions in this workload?
//   Measurable from the ledger accumulated in every phase before Memory
//   (Phase 10) **before** building it, and it should gate whether that phase
//   happens at all."*
//
// Memory's entire premise is that the system stops rediscovering things it
// already knows. If the same discoveries are not in fact being repeated
// across sessions, memory has nothing to save and its injection cost is a
// pure loss — which `problems/09`'s own kill criterion already anticipates:
// *"If Experiment H shows no measurable reduction in repeated work, memory
// stays off. This is a likely outcome for a solo developer on a small number
// of repositories."*
//
// So this is the number that has to exist before the mechanism does. Three
// signals, each computed from the archive and none of them modelled:
//
//   repeatedFiles     A file read in this session that some EARLIER session
//                     already read. The clearest form of rediscovery, and
//                     the one a repo map or a memory note could remove.
//   repeatedCommands  An exploration command run verbatim in an earlier
//                     session. Stronger evidence than a repeated file: the
//                     agent did not merely revisit a file, it re-derived the
//                     same question.
//   repeatedErrors    A tool call that failed the same way in an earlier
//                     session. This is the one `failed-approaches.md`
//                     exists for, and the only signal here that argues for
//                     *memory* specifically rather than for retrieval.
//
// **Ordering is by session start, and "earlier" is strict.** The first
// session to touch anything is never counted as rediscovery, so the rate is
// structurally 0 on a one-session archive — which is the correct answer, not
// a failure of the metric.
//
// **What this deliberately does not do.** It does not judge whether a repeat
// was *wasteful*. Re-reading a file you are editing is not rediscovery in
// any sense memory would fix, and a high rate here is evidence to
// investigate, never a mandate to build. `02-plan.md` §11's instruction
// stands: try the hand-maintained markdown file first, and make any
// automated system beat it.

import { classifyToolCall, toolResultBytes, type ExploreKind } from "../loop/exploration.js";
import { normalizePath, type HitQualityToolCall } from "./hit-quality.js";

// T75 (`docs/23-phase10-tasks.md`) bumps this to 2. v1 counted repeated
// calls; v2 also retains each repeated call's REAL result bytes, because
// `evaluatePhase10()` was multiplying the v1 count by an archive-wide mean
// and calling the product an upper bound -- which it is not, in either
// direction (`docs/22-memory-and-retrieval-source-review.md` §11.5).
// Nothing is backfilled: a v1 number and a v2 number are not comparable and
// the version is what says so.
export const REDISCOVERY_VERSION = 2;

/**
 * One exploration call whose target an EARLIER session had already paid for.
 *
 * Retained individually rather than aggregated on the spot for one reason:
 * a total hides its own composition. `problems/09`'s saving side is priced
 * from these, and the review's instruction is to preserve the total (an
 * expensive outlier is real spend, not statistical dirt) while showing the
 * median and maximum beside it so one event cannot hide inside the sum.
 */
export interface RepeatedEvent {
  sessionId: string;
  /** Which identity repeated. A call can repeat both; it is recorded once, `file` winning. */
  kind: "file" | "command";
  target: string;
  /** Real result bytes of THIS call, hydrated through T9.4's spilled-artifact stub. */
  bytes: number;
}

/** Bytes, summed and described. Every field is over `RepeatedEvent[]`. */
export interface RepeatedCost {
  events: number;
  /** The total. The outlier stays in -- deleting it would be the flattering accounting. */
  totalBytes: number;
  medianBytes: number | null;
  maxBytes: number | null;
  /** sessionId -> bytes repeated in that session. Per-session, never an archive-wide mean. */
  bySession: Array<{ sessionId: string; bytes: number; events: number }>;
}

/** A trace call, plus the result T75 needs to price it. */
export type RediscoveryToolCall = HitQualityToolCall & { result?: unknown };

export interface RediscoverySession {
  sessionId: string;
  /** ISO 8601. Sessions are processed in this order; ties break on sessionId. */
  startedUtc: string;
  toolCalls: ReadonlyArray<RediscoveryToolCall>;
}

export interface RepeatedTarget {
  /** The path, command, or error signature. */
  target: string;
  /** Sessions that touched it, in order. Length > 1 is what makes it a repeat. */
  sessions: string[];
}

export interface RediscoveryReport {
  version: number;
  sessions: number;
  /** Sessions that made at least one exploration call — the only ones that can repeat anything. */
  exploringSessions: number;

  files: {
    distinct: number;
    /** Distinct files read in more than one session. */
    repeated: number;
    /** Read events whose file an earlier session had already read. */
    repeatReads: number;
    totalReads: number;
    /** repeatReads / totalReads. NULL when nothing was read. */
    rate: number | null;
    top: RepeatedTarget[];
  };

  commands: {
    distinct: number;
    repeated: number;
    repeatRuns: number;
    totalRuns: number;
    rate: number | null;
    top: RepeatedTarget[];
  };

  errors: {
    distinct: number;
    repeated: number;
    repeatFailures: number;
    totalFailures: number;
    rate: number | null;
    top: RepeatedTarget[];
  };

  /**
   * The headline: exploration calls whose target had already been paid for by
   * an earlier session, over all exploration calls. NULL when nothing
   * explored. This is the number Phase 10's go/no-go is weighed against.
   */
  exploreCalls: number;
  rediscoveredExploreCalls: number;
  rate: number | null;

  /**
   * T75: the repeated calls themselves, with their real bytes. This is what
   * `evaluatePhase10()` prices, and it is an upper bound on savings **from
   * exact repeats only** -- it credits a memory note with removing the
   * entire cost of every repeat, and it says nothing about a lesson
   * re-derived by different means, which T66 cannot see at all.
   */
  repeatedEvents: RepeatedEvent[];
  repeatedCost: RepeatedCost;
}

function commandOf(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const rec = args as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return undefined;
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

/**
 * Whitespace-collapsed, `cd`-prefix-stripped command text. Two invocations
 * that differ only in indentation or in the absolute path they `cd` into are
 * the same question asked twice.
 */
export function normalizeCommand(command: string): string {
  return command
    .replace(/^\s*cd\s+[^\s&;|]+\s*(&&|;)\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** `name` plus its target — enough to say "this failed the same way before". */
function errorSignature(call: RediscoveryToolCall): string | undefined {
  if (call.state !== "error") return undefined;
  const name = typeof call.name === "string" ? call.name : "";
  if (name.length === 0) return undefined;
  const command = commandOf(call.args);
  if (command !== undefined) return `${name}: ${normalizeCommand(command)}`;
  const path = pathOf(call.args);
  if (path !== undefined) return `${name}: ${path}`;
  return undefined;
}

interface Tracker {
  /** target -> sessions that touched it, in order, deduplicated. */
  seen: Map<string, string[]>;
  events: number;
  repeatEvents: number;
}

function newTracker(): Tracker {
  return { seen: new Map(), events: 0, repeatEvents: 0 };
}

/** Records one occurrence. Returns true when an EARLIER session had it already. */
function record(tracker: Tracker, target: string, sessionId: string): boolean {
  tracker.events += 1;
  const sessions = tracker.seen.get(target);
  if (sessions === undefined) {
    tracker.seen.set(target, [sessionId]);
    return false;
  }
  const earlier = sessions.some((s) => s !== sessionId);
  if (sessions[sessions.length - 1] !== sessionId) sessions.push(sessionId);
  if (earlier) {
    tracker.repeatEvents += 1;
    return true;
  }
  return false;
}

function summarize(tracker: Tracker, topN = 5): {
  distinct: number;
  repeated: number;
  repeatEvents: number;
  totalEvents: number;
  rate: number | null;
  top: RepeatedTarget[];
} {
  const repeatedTargets: RepeatedTarget[] = [];
  for (const [target, sessions] of tracker.seen) {
    if (sessions.length > 1) repeatedTargets.push({ target, sessions });
  }
  repeatedTargets.sort((a, b) => b.sessions.length - a.sessions.length || a.target.localeCompare(b.target));
  return {
    distinct: tracker.seen.size,
    repeated: repeatedTargets.length,
    repeatEvents: tracker.repeatEvents,
    totalEvents: tracker.events,
    rate: tracker.events > 0 ? tracker.repeatEvents / tracker.events : null,
    top: repeatedTargets.slice(0, topN),
  };
}

/**
 * Which file, if any, an exploration call touched. A `read` names its path
 * directly; a bash explorer names paths only inside its command text, and
 * extracting them reliably is not possible — so bash contributes to the
 * *command* signal, not the *file* signal. Undercounting file rediscovery is
 * the conservative direction, the same one T63 and T64 chose.
 */
function fileTouchedBy(call: RediscoveryToolCall, kind: ExploreKind): string | undefined {
  if (kind !== "read") return undefined;
  return pathOf(call.args);
}

/**
 * Median by the lower-of-two convention on an even count. Which convention
 * is used matters less than saying which: the median is descriptive here and
 * never enters the total.
 */
function summarizeRepeatedCost(events: ReadonlyArray<RepeatedEvent>): RepeatedCost {
  const bySession = new Map<string, { bytes: number; events: number }>();
  let totalBytes = 0;
  for (const e of events) {
    totalBytes += e.bytes;
    const acc = bySession.get(e.sessionId) ?? { bytes: 0, events: 0 };
    acc.bytes += e.bytes;
    acc.events += 1;
    bySession.set(e.sessionId, acc);
  }
  const sorted = events.map((e) => e.bytes).sort((a, b) => a - b);
  return {
    events: events.length,
    totalBytes,
    medianBytes: sorted.length === 0 ? null : sorted[Math.floor((sorted.length - 1) / 2)]!,
    maxBytes: sorted.length === 0 ? null : sorted[sorted.length - 1]!,
    bySession: [...bySession.entries()]
      .map(([sessionId, v]) => ({ sessionId, bytes: v.bytes, events: v.events }))
      .sort((a, b) => b.bytes - a.bytes || a.sessionId.localeCompare(b.sessionId)),
  };
}

export function computeRediscovery(
  sessions: ReadonlyArray<RediscoverySession>,
  topN = 5,
): RediscoveryReport {
  const ordered = [...sessions].sort(
    (a, b) => a.startedUtc.localeCompare(b.startedUtc) || a.sessionId.localeCompare(b.sessionId),
  );

  const files = newTracker();
  const commands = newTracker();
  const errors = newTracker();
  let exploreCalls = 0;
  let rediscovered = 0;
  let exploringSessions = 0;
  const repeatedEvents: RepeatedEvent[] = [];

  for (const session of ordered) {
    let explored = false;
    for (const call of session.toolCalls) {
      const sig = errorSignature(call);
      if (sig !== undefined) record(errors, sig, session.sessionId);

      const cls = classifyToolCall(call);
      if (cls.kind !== "explore") continue;
      explored = true;
      exploreCalls += 1;

      // A call is "rediscovery" if EITHER of its identities was already paid
      // for. Counted once per call, never twice, so the headline rate cannot
      // exceed 1 for a call that repeats both its file and its command.
      let repeat = false;
      // T75: which identity repeated, so the priced event is attributable to
      // a file the maintainer could have written a memory about or a command
      // they could have recorded. `file` wins when both repeat, because a
      // repeated read is the thing `problems/09` forbids memory from
      // storing and the distinction has to survive into the report.
      let repeatKind: RepeatedEvent["kind"] | undefined;
      let repeatTarget: string | undefined;
      const file = fileTouchedBy(call, cls.explore);
      if (file !== undefined && record(files, file, session.sessionId)) {
        repeat = true;
        repeatKind = "file";
        repeatTarget = file;
      }
      const command = commandOf(call.args);
      if (command !== undefined) {
        const normalized = normalizeCommand(command);
        if (record(commands, normalized, session.sessionId)) {
          repeat = true;
          if (repeatKind === undefined) {
            repeatKind = "command";
            repeatTarget = normalized;
          }
        }
      }
      if (repeat) {
        rediscovered += 1;
        repeatedEvents.push({
          sessionId: session.sessionId,
          kind: repeatKind!,
          target: repeatTarget!,
          bytes: toolResultBytes(call.result),
        });
      }
    }
    if (explored) exploringSessions += 1;
  }

  const f = summarize(files, topN);
  const c = summarize(commands, topN);
  const e = summarize(errors, topN);

  return {
    version: REDISCOVERY_VERSION,
    sessions: ordered.length,
    exploringSessions,
    files: {
      distinct: f.distinct,
      repeated: f.repeated,
      repeatReads: f.repeatEvents,
      totalReads: f.totalEvents,
      rate: f.rate,
      top: f.top,
    },
    commands: {
      distinct: c.distinct,
      repeated: c.repeated,
      repeatRuns: c.repeatEvents,
      totalRuns: c.totalEvents,
      rate: c.rate,
      top: c.top,
    },
    errors: {
      distinct: e.distinct,
      repeated: e.repeated,
      repeatFailures: e.repeatEvents,
      totalFailures: e.totalEvents,
      rate: e.rate,
      top: e.top,
    },
    exploreCalls,
    rediscoveredExploreCalls: rediscovered,
    rate: exploreCalls > 0 ? rediscovered / exploreCalls : null,
    repeatedEvents,
    repeatedCost: summarizeRepeatedCost(repeatedEvents),
  };
}
