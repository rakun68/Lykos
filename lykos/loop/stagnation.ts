// T85 — the stagnation brake (`docs/25-phase15-sharpening-tasks.md` T85).
//
// `loop/edit-retry.ts` has computed `countEditRetries()` since T24.3 — an
// edit on a path whose previous edit on that path failed. Nothing consumes
// it. It was built as a *metric* for T24's adoption question and never
// became a *behaviour*, so an agent retrying the same broken anchor runs
// until the budget kill switch stops it, which on a cheap model can be forty
// turns later.
//
// This module is the behaviour. It is deliberately not in `edit-retry.ts`:
// that file computes a number from a finished trace for the ledger, this one
// makes a decision from a live stream. Mixing them would make the metric
// depend on the intervention that changes it.
//
// WHY THIS CANNOT BE A SKILL. Prose telling the model "don't repeat a failing
// call" is read by a model that is already repeating a failing call — being
// stuck is precisely the state in which instructions stop being followed.
// Breaking a loop requires acting between turns, on state accumulated across
// them, which is the harness's job and nothing else's.

/** Consecutive identical failures before the brake trips. */
export const DEFAULT_STAGNATION_THRESHOLD = 3;

export interface StagnationToolCall {
  toolName: string;
  input?: unknown | undefined;
  isError?: boolean | undefined;
}

/**
 * The target a call acted on, as a stable string. Two calls collide only if
 * they are the same tool doing the same thing to the same thing.
 *
 * `bash` keys on the command text, so `npm test` failing three times trips
 * but three different failing commands do not — an agent working through a
 * list of genuinely different broken things is making progress, and stopping
 * it would be the brake causing the stall it exists to prevent.
 */
export function targetKey(call: StagnationToolCall): string | undefined {
  const target = targetOf(call);
  return target === undefined ? undefined : `${call.toolName}:${target}`;
}

/**
 * The same target, WITHOUT the tool name in front of it.
 *
 * Split out for T111.3, which needs the opposite collision rule from the
 * brake above: the brake asks "same tool, same thing" and the substrate
 * metric asks "DIFFERENT tool, same thing". Both questions have to be
 * answered from one definition of what a call's target is, or the two
 * disagree about a path the other cannot see — which is the same failure
 * `command-safety.ts` avoids by refusing to own a second parser.
 */
export function targetOf(call: StagnationToolCall): string | undefined {
  const input = call.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const rec = input as Record<string, unknown>;
  if (call.toolName === "bash" || call.toolName === "powershell") {
    const cmd = rec.command;
    return typeof cmd === "string" && cmd.length > 0 ? cmd.trim() : undefined;
  }
  for (const field of ["path", "file", "target", "file_path"]) {
    const v = rec[field];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export type StagnationVerdict =
  | { action: "none" }
  /** Inject a note naming the failure. The model may still choose its next move. */
  | { action: "warn"; key: string; failures: number; note: string }
  /** Second trip in one session: stop and hand back to the human. */
  | { action: "stop"; key: string; failures: number; note: string };

export interface StagnationState {
  /** Consecutive failures per target, reset by any success on that target. */
  failures: Map<string, number>;
  /** Last error text seen per target, quoted back in the note. */
  lastError: Map<string, string>;
  /** Targets already warned about, so one target warns once and then stops. */
  warned: Set<string>;
  trips: number;
  stopped: boolean;
}

export function newStagnationState(): StagnationState {
  return { failures: new Map(), lastError: new Map(), warned: new Set(), trips: 0, stopped: false };
}

function buildNote(key: string, failures: number, error: string | undefined, stopping: boolean): string {
  const what = key.slice(key.indexOf(":") + 1);
  const quoted = error && error.trim().length > 0 ? `\nThe error was: ${error.trim()}` : "";
  if (stopping) {
    return (
      `[lykos-stagnation] Second stall this session. \`${what}\` has now failed ${failures} times in a row.${quoted}\n` +
      `Stopping and handing back to the human rather than spending more of the budget on the same call.`
    );
  }
  return (
    `[lykos-stagnation] \`${what}\` has failed ${failures} times in a row with no change between attempts.${quoted}\n` +
    `A bare retry is not available. Change something first: re-read the file to get the current text, ` +
    `try a different approach, or say plainly that you are stuck and why.`
  );
}

/**
 * Fold one finished tool call into the state and decide what to do.
 *
 * A success on a target clears its counter completely — an agent that fails
 * twice and then succeeds has recovered, and carrying that history forward
 * would make an unrelated later failure trip early.
 */
export function observeToolCall(
  state: StagnationState,
  call: StagnationToolCall,
  errorText: string | undefined,
  threshold: number = DEFAULT_STAGNATION_THRESHOLD,
): StagnationVerdict {
  const key = targetKey(call);
  // A call with no recoverable target is not counted. Claiming a repeat
  // needs to know what was repeated, and a guess would trip on unrelated
  // work — the same discipline countEditRetries already applies.
  if (key === undefined) return { action: "none" };

  if (call.isError !== true) {
    state.failures.delete(key);
    state.lastError.delete(key);
    state.warned.delete(key);
    return { action: "none" };
  }

  const failures = (state.failures.get(key) ?? 0) + 1;
  state.failures.set(key, failures);
  if (errorText !== undefined && errorText.length > 0) state.lastError.set(key, errorText);
  if (failures < threshold) return { action: "none" };
  // Already warned about this exact target and it is STILL failing after a
  // second full threshold's worth of attempts: the note did not work, so
  // escalate. The grace window matters — stopping on the very next failure
  // would punish an agent that read the note and is mid-way through a
  // genuinely different approach that happens to fail once more.
  if (state.warned.has(key)) {
    if (state.stopped || failures < threshold * 2) return { action: "none" };
    state.stopped = true;
    state.trips += 1;
    return {
      action: "stop",
      key,
      failures,
      note: buildNote(key, failures, state.lastError.get(key), true),
    };
  }
  state.warned.add(key);
  state.trips += 1;
  return {
    action: "warn",
    key,
    failures,
    note: buildNote(key, failures, state.lastError.get(key), false),
  };
}

/** Threshold from the environment, so a session can widen it without a rebuild. */
export function stagnationThresholdFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.LYKOS_STAGNATION_THRESHOLD);
  return Number.isFinite(raw) && raw >= 2 ? Math.floor(raw) : DEFAULT_STAGNATION_THRESHOLD;
}

/** `LYKOS_STAGNATION_BRAKE=0` turns it off entirely. On by default: it is a defect fix, not an experiment. */
export function stagnationEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LYKOS_STAGNATION_BRAKE !== "0";
}
