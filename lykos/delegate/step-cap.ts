// The step cap a request may set (T250, `SessionRequest.maxSteps`). A step is one model turn: Pi emits
// `turn_end` once the turn's assistant message and its tool results are in. When the count reaches the cap
// the session is aborted, so no further model call starts.

import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type StepCappable = Pick<AgentSession, "subscribe" | "abort">;

/**
 * Counts `session`'s turns into `counter` and, with a cap, aborts it after `cap` turns and calls `onCapped` once. The
 * one count: the cap is enforced from it and the result reports it (R13). Returns the unsubscribe.
 */
export function watchStepCap(session: StepCappable, cap: number | undefined, onCapped: () => void, counter: { turns: number } = { turns: 0 }): () => void {
  let capped = false;
  return session.subscribe((event) => {
    // Once capped, a turn already under way when the abort lands is not counted: the report never exceeds the cap.
    if (event.type !== "turn_end" || capped) return;
    counter.turns += 1;
    if (cap === undefined || counter.turns < cap) return;
    capped = true;
    onCapped();
    void session.abort();
  });
}

export function stepCapNote(cap: number): string {
  return `stopped at the step cap of ${cap} turn${cap === 1 ? "" : "s"}`;
}
