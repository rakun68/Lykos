// The observable substrate for tool selection, and the metric this project
// refuses to compute.
//
// **THERE IS NO "TOOL SELECTION ACCURACY" HERE, AND ADDING ONE IS THE
// MISTAKE THIS COMMENT EXISTS TO PREVENT.** The field's day-one list names
// it; Lykos records four of the seven metrics, adds two, and refuses this
// one on the record. There is no ground truth for "the right tool" — no
// oracle says that `read` was correct and `bash cat` was not — so every
// available proxy is a model judging a model, which is `agent_claim`
// wearing a metric's clothes. `recordOutcome` already refuses that source
// for success and this refuses it for tool choice, for the same reason.
// The word "accuracy" appears in no column, view, or report.
//
// What is recorded instead is raw and uninterpreted:
//
//   - **Per-tool call and error counts.** A rate is not stored, because a
//     rate is a derived number and the ledger stores what happened.
//   - **Adjacent pairs where the tool changed but the target did not.** An
//     agent that calls `edit` on a file and immediately calls `write` on
//     the same file probably chose wrong the first time.
//
// **The honest limit, which belongs here rather than in a commit nobody
// re-reads: the second number is EVIDENCE ABOUT tool selection, not a
// measure of it.** Its dominant shape is `read` then `edit` on one file,
// which is not a mistake — it is the normal way to change a file. A reader
// wanting a defect rate out of this column will not find one, and the
// answer is that the ground truth does not exist, not that nobody got round
// to computing it.

import { targetOf, type StagnationToolCall } from "../loop/stagnation.js";
import { resolveActualToolName } from "../tools/tool-call.js";

export interface SubstrateToolCall {
  name?: string | undefined;
  args?: unknown;
  state?: string | undefined;
}

export interface ToolSubstrate {
  /** Calls per tool name, in first-seen order. The denominator of any rate a reader computes. */
  callCounts: Record<string, number>;
  /**
   * D26: the same calls counted under the tool a transport dispatch resolved
   * to — `tool_call` naming `lsp` counts as `lsp` here and as `tool_call`
   * above. The two maps describe the same dispatches and are never summed.
   */
  actualCallCounts: Record<string, number>;
  /** Errored calls per tool name. Absent from this map means the tool never errored, not that it was never called. */
  errorCounts: Record<string, number>;
  /** Adjacent call pairs where BOTH sides had a resolvable target. The denominator for the number below. */
  adjacentPairs: number;
  /** Of those, pairs where the tool changed and the target did not. Never a rate, and never named accuracy. */
  switchSameTarget: number;
}

export function emptyToolSubstrate(): ToolSubstrate {
  return { callCounts: {}, actualCallCounts: {}, errorCounts: {}, adjacentPairs: 0, switchSameTarget: 0 };
}

/** The one error test, matching `edit-retry.ts`'s: Pi marks a failed tool call `state: "error"`. */
function isError(call: SubstrateToolCall): boolean {
  return call.state === "error";
}

function asStagnationCall(call: SubstrateToolCall): StagnationToolCall {
  return { toolName: call.name ?? "", input: call.args };
}

export function summarizeToolSubstrate(calls: readonly SubstrateToolCall[] | undefined): ToolSubstrate {
  const out = emptyToolSubstrate();
  if (!Array.isArray(calls) || calls.length === 0) return out;

  for (const call of calls) {
    const name = call.name;
    if (typeof name !== "string" || name.length === 0) continue;
    out.callCounts[name] = (out.callCounts[name] ?? 0) + 1;
    const actual = resolveActualToolName(name, call.args) ?? name;
    out.actualCallCounts[actual] = (out.actualCallCounts[actual] ?? 0) + 1;
    if (isError(call)) out.errorCounts[name] = (out.errorCounts[name] ?? 0) + 1;
  }

  for (let i = 0; i + 1 < calls.length; i += 1) {
    const a = calls[i]!;
    const b = calls[i + 1]!;
    if (typeof a.name !== "string" || typeof b.name !== "string") continue;
    const targetA = targetOf(asStagnationCall(a));
    const targetB = targetOf(asStagnationCall(b));
    // A pair only counts when BOTH targets are known. A call whose target
    // could not be read is not evidence of anything, and counting it in the
    // denominator alone would quietly deflate the number.
    if (targetA === undefined || targetB === undefined) continue;
    out.adjacentPairs += 1;
    if (a.name !== b.name && targetA === targetB) out.switchSameTarget += 1;
  }

  return out;
}

/** JSON for the ledger's TEXT column. `{}` is a real answer — the session ran tools and none matched. */
export function serializeCounts(counts: Record<string, number>): string {
  return JSON.stringify(counts);
}
