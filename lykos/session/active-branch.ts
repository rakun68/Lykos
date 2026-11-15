// T266: the active branch of a transcript — the conversation as the model has
// it now, without the turns a rewind undid (spec #25, decisions 4 and 5).
//
// A transcript is append-only, so an undone branch stays in it (T263): its
// prompts, turns and tool calls sit above the `rewind` event that undid them.
// Whatever rebuilds a conversation from the transcript — a fork, a resume, and
// the rebuild a rewind past a resume makes (T264) — reads this branch, never
// the whole file.
//
// A conversation rewind names the turn it went back to (`to_turn`): the undone
// branch starts at the prompt that started that turn and ends at the rewind.
// A summarize (T265) cuts at the same prompt and keeps its own event, whose
// `summary` is what the model is sent in place of the turns it summarized, so
// a replay carries the summary where the live session has it. A code-only
// rewind leaves the conversation as it was, and stays in the branch as the
// record that the files moved.
//
// Rewinds are read in order, each on the branch the ones before it left. A
// turn is named by its number, which is session-wide across processes since
// T264: a resumed process numbers its turns after the transcript's last. A
// transcript from before that has each process count from 0 again, and nothing
// is renumbered; a rewind then reached only its own process's turns, which are
// the latest with their numbers, so a turn is looked for from the end.

import type { TranscriptRecord } from "./replay.js";

/** The records still on the conversation, in order. Pure: nothing is read or written. */
export function activeBranch(records: readonly TranscriptRecord[]): TranscriptRecord[] {
  const branch: TranscriptRecord[] = [];
  for (const record of records) {
    if (record.kind === "rewind" && record.restore !== "code") {
      const cut = promptStarting(branch, record.to_turn);
      if (cut !== undefined) {
        branch.length = cut;
        if (record.restore === "summarize" && record.summary !== undefined) branch.push(record);
        continue;
      }
    }
    branch.push(record);
  }
  return branch;
}

/** T264: the turn the next process of a session starts at: one past the highest its transcript has. */
export function nextTurn(records: readonly TranscriptRecord[]): number {
  let next = 0;
  for (const r of records) if (r.kind === "turn_start" && r.turn >= next) next = r.turn + 1;
  return next;
}

/** The index of the prompt that started the latest turn numbered `turn`; undefined when there is none. */
function promptStarting(branch: readonly TranscriptRecord[], turn: number | undefined): number | undefined {
  if (turn === undefined) return undefined;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    const r = branch[i]!;
    if (r.kind !== "turn_start" || r.turn !== turn) continue;
    for (let j = i - 1; j >= 0; j -= 1) if (branch[j]!.kind === "user_message") return j;
    return undefined;
  }
  return undefined;
}
