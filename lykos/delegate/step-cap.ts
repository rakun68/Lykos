// The step cap a request may set (T250, `SessionRequest.maxSteps`). A step is one model turn: Pi emits
// `turn_end` once the turn's assistant message and its tool results are in. When the count reaches the cap
// the session is aborted, so no further model call starts.
//
// Before that, the session is told once that the cap is near (Boxie's `WRAP_MIN`, d063a30): a session cut
// mid-edit leaves a half-done change and no claims, and a note a few turns ahead lets it finish the edit in
// hand and record what it did. WRAP_TURNS is a chosen margin, unmeasured: a claim and a last edit take a few
// turns. A cap too small to leave room for both work and the margin gets no note.

import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type StepCappable = Pick<AgentSession, "subscribe" | "abort">;

/** Turns before the cap at which the session is told the cap is near. */
export const WRAP_TURNS = 5;

/**
 * Counts `session`'s turns into `counter` and, with a cap, aborts it after `cap` turns and calls `onCapped` once. The
 * one count: the cap is enforced from it and the result reports it (R13). With `onWrap`, calls it once when
 * WRAP_TURNS turns are left, when the cap is over twice that. Returns the unsubscribe.
 */
export function watchStepCap(
  session: StepCappable,
  cap: number | undefined,
  onCapped: () => void,
  counter: { turns: number } = { turns: 0 },
  onWrap?: (left: number) => void,
): () => void {
  let capped = false;
  return session.subscribe((event) => {
    // Once capped, a turn already under way when the abort lands is not counted: the report never exceeds the cap.
    if (event.type !== "turn_end" || capped) return;
    counter.turns += 1;
    if (cap === undefined) return;
    if (onWrap !== undefined && cap > 2 * WRAP_TURNS && counter.turns === cap - WRAP_TURNS) onWrap(WRAP_TURNS);
    if (counter.turns < cap) return;
    capped = true;
    onCapped();
    void session.abort();
  });
}

export function stepCapNote(cap: number): string {
  return `stopped at the step cap of ${cap} turn${cap === 1 ? "" : "s"}`;
}

/** What the session is told when the cap is near. */
export function wrapUpNote(left: number): string {
  return (
    `${left} turns are left before the step cap stops this session. Finish the edit in hand, start nothing new, ` +
    `and record what you did and what is left (your claims, or your findings) before the cap.`
  );
}
