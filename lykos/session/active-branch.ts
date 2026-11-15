// T266: the active branch of a transcript — the conversation as the model has
// it now, without the turns a rewind undid (spec #25, decisions 4 and 5).
//
// A transcript is append-only, so an undone branch stays in it (T263): its
// prompts, turns and tool calls sit above the `rewind` event that undid them.
// Whatever rebuilds a conversation from the transcript — a fork today, a
// resume once T264 reads this too — reads this branch, never the whole file.
//
// A conversation rewind names the turn it went back to (`to_turn`): the undone
// branch starts at the prompt that started that turn and ends at the rewind.
// Turns are numbered afresh by each process (a resume starts again at 0), and
// a rewind reaches only its own process's prompts, so the turn is looked for
// after the last resume marker. Rewinds are read in order, each on the branch
// the ones before it left. A code-only rewind leaves the conversation as it
// was, and stays in the branch as the record that the files moved; so does any
// other kind of rewind until this reader is taught what it does to the branch.

import type { TranscriptRecord } from "./replay.js";

/** The records still on the conversation, in order. Pure: nothing is read or written. */
export function activeBranch(records: readonly TranscriptRecord[]): TranscriptRecord[] {
  const branch: TranscriptRecord[] = [];
  // Where this process's records start: just after the last resume marker.
  let processStart = 0;
  for (const record of records) {
    if (record.kind === "rewind" && (record.restore === "both" || record.restore === "conversation")) {
      const cut = promptStarting(branch, processStart, record.to_turn);
      if (cut !== undefined) {
        branch.length = cut;
        continue;
      }
    }
    branch.push(record);
    if (record.kind === "resume") processStart = branch.length;
  }
  return branch;
}

/** The index of the prompt that started turn `turn`, at or after `from`; undefined when there is none. */
function promptStarting(branch: readonly TranscriptRecord[], from: number, turn: number | undefined): number | undefined {
  if (turn === undefined) return undefined;
  for (let i = branch.length - 1; i >= from; i -= 1) {
    const r = branch[i]!;
    if (r.kind !== "turn_start" || r.turn !== turn) continue;
    for (let j = i - 1; j >= from; j -= 1) if (branch[j]!.kind === "user_message") return j;
    return undefined;
  }
  return undefined;
}
