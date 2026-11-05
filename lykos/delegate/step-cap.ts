// The step cap a request may set (T250, `SessionRequest.maxSteps`). A step is one model turn: Pi emits
// `turn_end` once the turn's assistant message and its tool results are in. When the count reaches the cap
// the session is aborted, so no further model call starts.

import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type StepCappable = Pick<AgentSession, "subscribe" | "abort">;

/** Aborts `session` after `cap` turns and calls `onCapped` once. Returns the unsubscribe. */
export function watchStepCap(session: StepCappable, cap: number, onCapped: () => void): () => void {
  let turns = 0;
  let capped = false;
  return session.subscribe((event) => {
    if (event.type !== "turn_end" || capped) return;
    turns += 1;
    if (turns < cap) return;
    capped = true;
    onCapped();
    void session.abort();
  });
}

export function stepCapNote(cap: number): string {
  return `stopped at the step cap of ${cap} turn${cap === 1 ? "" : "s"}`;
}
