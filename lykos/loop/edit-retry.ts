// T24.3 — edit-retry rate: the prerequisite metric (docs/10-phase2-tasks.md
// T24, docs/06-extension-policy.md bar 6).
//
// "A failed edit is the most expensive output a cheap model produces: it
// pays for the patch, pays again for the retry, and often pays a third time
// for a re-read." The ledger counts calls and tokens but has no metric for
// an edit that failed and was retried. Without a "before", T24's own
// acceptance ("output tokens per successful edit... adoption if the net is
// positive") cannot be evaluated at all — this is that before.
//
// Computed host-side from the snapshot's existing toolCalls trace.
// The session's `tool_execution_end` handler already sets `call.state = ev.isError ? "error" : "ok"` on every
// tool call (T20's `countExplorationToolCalls` reads the same trace) — so
// this needs no new hook and no patch to Pi (AGENTS.md rule 6).

// Only the `edit` tool is counted. `ast_edit` and `lsp` rename change files
// too, but they match a pattern or a symbol rather than text the model copied
// out of a read, so a failure of theirs is not the failure this metric exists
// to measure (T166). T168 (ADR-0031) replaced the anchored `edit` with exact
// text replacement; the counters are unchanged and now count its failures: an
// `oldText` that was not found, not unique or overlapping, a `replaceAll` that
// found nothing, a declined approval.
const EDIT_TOOL_NAME = "edit";

export interface EditToolCallLike {
  name?: string;
  state?: string;
  args?: unknown;
}

function editPathFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const rec = args as Record<string, unknown>;
  for (const key of ["path", "file", "target"]) {
    const v = rec[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/** Every `edit` tool call this session, successful or not. The rate's denominator. */
export function countEditToolCalls(toolCalls: ReadonlyArray<EditToolCallLike> | undefined): number {
  if (!toolCalls) return 0;
  let n = 0;
  for (const call of toolCalls) {
    if (call.name === EDIT_TOOL_NAME) n += 1;
  }
  return n;
}

/** `edit` tool calls whose result was an error (an oldText not found, not unique or overlapping, ...). */
export function countEditErrors(toolCalls: ReadonlyArray<EditToolCallLike> | undefined): number {
  if (!toolCalls) return 0;
  let n = 0;
  for (const call of toolCalls) {
    if (call.name === EDIT_TOOL_NAME && call.state === "error") n += 1;
  }
  return n;
}

/**
 * `edit` calls that are retries: an edit on a path whose most recent prior
 * edit on that same path failed. An edit call whose args carry no
 * recoverable path (`path` / `file` / `target`) still counts toward
 * countEditErrors above but is excluded here — a retry claim requires
 * knowing which file was retried, and a guess would overstate the rate.
 */
export function countEditRetries(toolCalls: ReadonlyArray<EditToolCallLike> | undefined): number {
  if (!toolCalls) return 0;
  const lastFailed = new Map<string, boolean>();
  let retries = 0;
  for (const call of toolCalls) {
    if (call.name !== EDIT_TOOL_NAME) continue;
    const path = editPathFromArgs(call.args);
    if (!path) continue;
    if (lastFailed.get(path) === true) retries += 1;
    lastFailed.set(path, call.state === "error");
  }
  return retries;
}
