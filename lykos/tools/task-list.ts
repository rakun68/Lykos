// T98 — a task list the session owns (`docs/24-strength-and-tooling-audit.md`
// §2.2, `docs/27-phase12-tasks.md`).
//
// WHAT IS MISSING, restated because it is the whole justification: Lykos has
// no task list of any kind. One long conversation and hope. A frontier model
// holds a five-step plan in its head; the cheap tier Lykos targets does not —
// it finishes step 2, forgets steps 4 and 5, and reports success. An
// externalised list that the model is shown again is the cheapest known fix
// for exactly that failure, and it is the substrate T100's mechanical gate is
// built on: an item carrying its own verify command *is* a gate at step
// granularity.
//
// THREE DESIGN CHOICES, each of which could have gone the other way.
//
//  1. **Operations, not a full-list rewrite.** A whole-list `TodoWrite`
//     takes the entire list every call, which is robust (no ids to get
//     wrong) and costs the whole list in OUTPUT tokens every time. Output is
//     3.6% of tokens and 33.9% of spend on DeepSeek, so a
//     rewrite-per-call is the expensive shape on precisely the provider this
//     project assumes. So: `add` / `start` / `done` / `drop`, small integer
//     ids assigned here, and the whole list rendered back after every call so
//     the model never has to remember an id it was not just shown.
//
//  2. **One item in progress at a time.** `start` moves any other
//     in-progress item back to pending. Not a style preference: a list that
//     permits four simultaneous in-progress items is a list that records
//     what was touched, not what is being done, and the cheap tier will
//     happily start everything and finish nothing.
//
//  3. **An unknown id is an error with the valid ids in it.** The recovery
//     path a cheap model can follow is "here are the ids that exist", not
//     "invalid argument". Same reasoning as T87's recoverable refusal
//     message.
//
// The list lives in the transcript and the archive, not only in the context
// (`docs/08-sessions-and-archive.md`): a resumed session reopening with its
// unfinished list intact is a capability Pi does not have and is nearly free
// once the list exists. `tasks.json` in the session directory is that file.
//
// SCHEMA TAX, recorded at the moment the tool is added, per rule 3: one tool
// resident for the session. `ledger/tool-catalog.ts` carries the wire
// shape, so `measureToolset(["read","bash","edit","write","todo"])` prices it
// exactly rather than returning NULL for an unknown name.
//
// ---------------------------------------------------------------------------
// P10.6 (ticket 20, D7) — DESIGN CHOICES
// ---------------------------------------------------------------------------
//
// D7 records each deliberate design choice and why. **A silent difference is
// the thing that bullet exists to prevent**, so here is every one of them.
//
// WHAT WAS CLOSED IN THIS TICKET, because both were contract bugs rather than
// design choices:
//
//   - **A refused call now sets `isError`.** The reference marks a failed op
//     `isError: true` and discards the mutation. Lykos discarded the mutation
//     correctly and returned it as an ordinary success, so a model reading the
//     structured half could not tell a refusal from a completed update — and
//     the gate refusal, which is the most important "no" this tool can say,
//     was the same. Both now say so.
//   - **`details` carries the ids that just closed.** The reference returns
//     `completedTasks` so a caller can react to a task completing; the
//     information already existed here (`applyTaskListUpdate` returns
//     `completedIds`) and was being thrown away at the tool boundary.
//
// WHAT DIFFERS DELIBERATELY, with the reason for each:
//
//   - **A flat list with integer ids, not phases with content-addressed
//     tasks.** The reference groups tasks into named phases and targets a task
//     by exact string equality on its content, which is why its own notes say
//     duplicate content makes later ops ambiguous. Lykos assigns small integer
//     ids and renders the whole list after every call, so the model never has
//     to remember or retype a string it was not just shown. Adding phases
//     would add a `phase` field to four operations of a RESIDENT tool — paid
//     on every request of every session — to express grouping a numbered list
//     already gives for free.
//   - **No `block` / `unblock`, and no `blocked` status.** Same reason: two
//     more ops and a `reason` field on the wire, on the resident tool, for a
//     state a `drop` plus a new item already expresses. Recorded as a real gap
//     rather than a non-feature: a blocked item that stays visible with its
//     blocker attached is genuinely better than a dropped one, and it is worth
//     revisiting if `todo` ever stops being resident.
//   - **No `rm`.** The reference removes a task outright; this drops it, which
//     leaves it rendered as `[-]`. That is the project's own rule — nothing
//     Lykos runs is deleted — and it is also the more useful answer, because a
//     model that cannot see it dropped something will add it again.
//   - **No `init` full-replacement op.** T98's first design note explains it:
//     A whole-list rewrite costs the entire list in OUTPUT tokens
//     on every call, and `add`/`start`/`done`/`drop` were chosen over it
//     deliberately.
//   - **No automatic promotion of the next pending item.** The reference
//     normalises after every op and, when nothing is in progress, promotes the
//     first pending task itself. Lykos does not: "what is being worked on" is
//     a claim about the agent, and a list that makes it on the agent's behalf
//     reports something nobody decided. The single-in-progress invariant IS
//     enforced — `start` demotes any other — which is the half that prevents a
//     list of four simultaneous in-progress items.
//   - **`verify` has no counterpart in the reference at all.** T100's gate is
//     Lykos's own: an item can carry a command whose exit code decides whether
//     it may be marked done. This is the one axis where this tool is ahead.
//   - **The reminder injection has no counterpart either** (T98.4), and it
//     needs no UI: Lykos appends it to a tool result after N unseen calls, which works in
//     an MCP worker with no terminal at all.
//   - **Resume keeps only the unfinished items, renumbered.** Lykos renumbers, because its ids are
//     positional and a resumed list starting at 7 would be confusing for no
//     gain.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { NULL_EVENT_SINK, type LykosEventSink } from "../extensions/api.js";

export type TaskItemStatus = "pending" | "in_progress" | "done" | "dropped";

export interface TaskItem {
  id: number;
  text: string;
  status: TaskItemStatus;
  /**
   * T100's substrate. A shell command whose exit code decides whether this
   * step is really finished. Carried from T98 and *enforced* by T100's gate,
   * so the field is not speculative surface: the tool that writes it and the
   * gate that runs it land in the same phase.
   */
  verify?: string;
  /** T100: what the gate's last run of `verify` decided. Absent means never run. */
  verified?: { ok: boolean; exitCode: number | null; at: string };
}

export interface TaskListState {
  items: TaskItem[];
  nextId: number;
  /** How many times the tool actually fired. The "did anyone ever use this?" counter rule 5 asks for. */
  calls: number;
  created: number;
  completed: number;
  /** T98.4: reminders the harness appended because the list had gone unseen. */
  reminders: number;
  /** Tool calls since the model last saw the list. Reset by every `todo` call. */
  callsSinceSeen: number;
  /** T100: times the gate refused a `done` because the item's verify command failed. */
  gateRefusals: number;
  /** Bumped on every mutation, so a persistence hook can skip a no-op write. */
  version: number;
}

export function newTaskListState(): TaskListState {
  return {
    items: [],
    nextId: 1,
    calls: 0,
    created: 0,
    completed: 0,
    reminders: 0,
    callsSinceSeen: 0,
    gateRefusals: 0,
    version: 0,
  };
}

export interface TaskListUpdate {
  add?: Array<{ text: string; verify?: string }>;
  start?: number;
  done?: number[];
  drop?: number[];
}

export type TaskListApplyResult =
  | { ok: true; changed: boolean; completedIds: number[] }
  | { ok: false; error: string };

/**
 * Applies one update. Validates FIRST and mutates second: a call naming one
 * good id and one bad one changes nothing, because a half-applied list is
 * worse than a rejected one — the model would have to diff the render
 * against its own intent to find out what landed.
 */
export function applyTaskListUpdate(state: TaskListState, update: TaskListUpdate): TaskListApplyResult {
  const invalid = validateTaskListUpdate(state, update);
  if (invalid !== undefined) return { ok: false, error: invalid };
  const byId = new Map(state.items.map((i) => [i.id, i]));

  let changed = false;
  const completedIds: number[] = [];

  for (const spec of update.add ?? []) {
    const item: TaskItem = {
      id: state.nextId++,
      text: spec.text.trim(),
      status: "pending",
      ...(spec.verify !== undefined && spec.verify.trim().length > 0 ? { verify: spec.verify.trim() } : {}),
    };
    state.items.push(item);
    state.created += 1;
    changed = true;
  }

  if (update.start !== undefined) {
    for (const item of state.items) {
      if (item.status === "in_progress" && item.id !== update.start) item.status = "pending";
    }
    const target = byId.get(update.start)!;
    if (target.status !== "in_progress") {
      target.status = "in_progress";
      changed = true;
    }
  }

  for (const id of update.done ?? []) {
    const item = byId.get(id)!;
    if (item.status !== "done") {
      item.status = "done";
      state.completed += 1;
      completedIds.push(id);
      changed = true;
    }
  }

  for (const id of update.drop ?? []) {
    const item = byId.get(id)!;
    if (item.status !== "dropped") {
      item.status = "dropped";
      changed = true;
    }
  }

  if (changed) state.version += 1;
  return { ok: true, changed, completedIds };
}

/**
 * The error an update would be rejected with, or undefined when it is valid.
 * Separate from `applyTaskListUpdate` so the tool can ask BEFORE its gate runs
 * any verify command (D10): a call naming one good id and one typo used to
 * run the good item's command, stamp it verified, and then be rejected.
 */
export function validateTaskListUpdate(state: TaskListState, update: TaskListUpdate): string | undefined {
  const ids = new Set(state.items.map((i) => i.id));
  const referenced = [update.start, ...(update.done ?? []), ...(update.drop ?? [])].filter(
    (id): id is number => id !== undefined,
  );
  for (const id of referenced) {
    if (!ids.has(id)) return `no item ${id}. ${validIdsHint(state)}`;
  }
  for (const item of update.add ?? []) {
    if (item.text.trim().length === 0) return "an item needs text";
  }
  return undefined;
}

function validIdsHint(state: TaskListState): string {
  const open = state.items.filter((i) => i.status !== "done" && i.status !== "dropped").map((i) => i.id);
  if (state.items.length === 0) return "the list is empty — add items before referring to one";
  if (open.length === 0) return "every item is closed; open ids: (none)";
  return `open ids: ${open.join(", ")}`;
}

const MARK: Record<TaskItemStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  done: "[x]",
  dropped: "[-]",
};

/**
 * The list as the model sees it. Deliberately terse — it is re-rendered on
 * every tool call and on every reminder, so a decorative format is a tax
 * paid many times per session. Dropped items are rendered too: a model that
 * cannot see it dropped something will add it again.
 */
export function renderTaskList(state: TaskListState): string {
  if (state.items.length === 0) return "task list: empty";
  const lines = state.items.map((item) => {
    const verify = item.verify !== undefined ? `  (verify: ${item.verify})` : "";
    const verdict =
      item.verified !== undefined ? `  ${item.verified.ok ? "verified" : "VERIFY FAILED"}` : "";
    return `${item.id} ${MARK[item.status]} ${item.text}${verify}${verdict}`;
  });
  const open = state.items.filter((i) => i.status === "pending" || i.status === "in_progress").length;
  return `task list (${open} open of ${state.items.length}):\n${lines.join("\n")}`;
}

/** True when something is still outstanding. What the reminder and the end-of-session check both ask. */
export function hasOpenItems(state: TaskListState): boolean {
  return state.items.some((i) => i.status === "pending" || i.status === "in_progress");
}

export const DEFAULT_REMINDER_INTERVAL = 8;

/**
 * T98.4: the list re-read without the model having to ask for it.
 *
 * The register's claim is that an externalised list works because it is
 * *re-read*, and a list the model only sees when it chooses to call the tool
 * is exactly the list a forgetful model stops calling. So after N tool calls
 * with open items and no `todo` call, the next tool result carries the list
 * back — the same tail-injection channel T85's brake and T86's budget notice
 * use, for the same reason: Pi has no per-turn message injection, and the
 * head is frozen for the session (T17 is not suspended).
 *
 * At most one reminder per N calls, and none at all when nothing is open.
 */
export function taskListReminder(
  state: TaskListState,
  interval = DEFAULT_REMINDER_INTERVAL,
): string | undefined {
  if (!hasOpenItems(state)) return undefined;
  state.callsSinceSeen += 1;
  if (state.callsSinceSeen < interval) return undefined;
  state.callsSinceSeen = 0;
  state.reminders += 1;
  return `lykos: ${renderTaskList(state)}`;
}

// ---------------------------------------------------------------------------
// Persistence: the list is part of the session directory, not only the context.
// ---------------------------------------------------------------------------

export const TASK_LIST_FILE = "tasks.json";

export interface TaskListFile {
  schemaVersion: 1;
  sessionId: string;
  updatedUtc: string;
  items: TaskItem[];
  nextId: number;
  counters: { calls: number; created: number; completed: number; reminders: number; gateRefusals: number };
}

export function taskListFilePath(sessionDir: string): string {
  return join(sessionDir, TASK_LIST_FILE);
}

export function writeTaskListFile(sessionDir: string, sessionId: string, state: TaskListState): void {
  const file: TaskListFile = {
    schemaVersion: 1,
    sessionId,
    updatedUtc: new Date().toISOString(),
    items: state.items,
    nextId: state.nextId,
    counters: {
      calls: state.calls,
      created: state.created,
      completed: state.completed,
      reminders: state.reminders,
      gateRefusals: state.gateRefusals,
    },
  };
  writeFileSync(taskListFilePath(sessionDir), `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

/**
 * Reads a list back. Returns null for a missing or damaged file — a resume
 * that cannot read the previous list continues without one rather than
 * refusing, because the conversation is the primary record and the list is
 * an aid to it.
 */
export function readTaskListFile(sessionDir: string): TaskListFile | null {
  const path = taskListFilePath(sessionDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as TaskListFile;
    if (!Array.isArray(parsed.items)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * T98.5: what a resumed session reopens with.
 *
 * Only the UNFINISHED items carry over, renumbered from 1. A resumed session
 * that reopened with forty closed items would spend its first turn reading a
 * changelog; what it needs is the outstanding work. The closed items are not
 * lost — they are in the previous session's `tasks.json` and its transcript,
 * and nothing Lykos runs is deleted.
 *
 * The counters do NOT carry over. They count what THIS session did, and a
 * resumed session inheriting its parent's totals would double-count the pair
 * in any measurement that summed across sessions in a task.
 */
export function resumeTaskListState(file: TaskListFile | null): TaskListState {
  const state = newTaskListState();
  if (file === null) return state;
  for (const item of file.items) {
    if (item.status === "done" || item.status === "dropped") continue;
    state.items.push({
      id: state.nextId++,
      text: item.text,
      // An item that was mid-flight is reopened as pending: nothing is in
      // progress in a session that has not started yet, and claiming
      // otherwise would make the first `start` a no-op.
      status: "pending",
      ...(item.verify !== undefined ? { verify: item.verify } : {}),
    });
  }
  return state;
}

// ---------------------------------------------------------------------------
// The tool.
// ---------------------------------------------------------------------------

/**
 * T100's gate, injected rather than imported: the task list is a pure state
 * machine and running shell commands is not its job. `gate/verify-gate.ts`
 * supplies the real one; T98's tests pass none and get T98's behaviour.
 */
export type TaskItemVerifier = (
  item: TaskItem,
) => Promise<{ ok: boolean; exitCode: number | null; output: string }>;

export interface TaskListToolOpts {
  state: TaskListState;
  /** Persistence + transcript. Called after any change; never on a pure re-render. */
  onChange?: (state: TaskListState) => void;
  /** T100. Omitted → `done` is taken at the model's word, which is T98's behaviour. */
  verifier?: TaskItemVerifier;
  /**
   * P10.9 (ticket 21, D2): where `task_list_changed` fires from.
   *
   * Here rather than inside `applyTaskListUpdate`, because that function is
   * also what `resumeTaskListState`'s callers and the tests drive directly and
   * a resume is not a change anybody made. The tool is the one place a change
   * has an author, and the payload below is the same object the tool already
   * assembles for its own `details`.
   */
  events?: LykosEventSink;
}

export const TASK_LIST_TOOL_NAME = "todo";

export function buildTaskListTool(opts: TaskListToolOpts): ToolDefinition {
  return defineTool({
    name: TASK_LIST_TOOL_NAME,
    label: "Todo",
    description:
      "Track multi-step work. Add the steps before starting, mark one in progress, mark each done as " +
      "you finish it. Call with no arguments to re-read the list. Returns the whole list every time. " +
      "Give a step a `verify` command and it is checked before it can be marked done.",
    promptSnippet: "Track multi-step work as a checklist the session owns",
    parameters: Type.Object({
      add: Type.Optional(
        Type.Array(
          Type.Object({
            text: Type.String({ description: "One step, imperative and specific." }),
            verify: Type.Optional(
              Type.String({
                description: "Shell command whose exit code decides this step. Checked before done.",
              }),
            ),
          }),
          { description: "New steps, appended in order." },
        ),
      ),
      start: Type.Optional(Type.Number({ description: "Item id to mark in progress. Only one at a time." })),
      done: Type.Optional(Type.Array(Type.Number(), { description: "Item ids that are finished." })),
      drop: Type.Optional(Type.Array(Type.Number(), { description: "Item ids that turned out not to be needed." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const text = (s: string) => [{ type: "text" as const, text: s }];
      const state = opts.state;
      state.calls += 1;
      // Any call is the model reading the list, so the reminder clock resets
      // whether or not anything changed.
      state.callsSinceSeen = 0;

      const update: TaskListUpdate = {
        ...(params.add !== undefined ? { add: params.add } : {}),
        ...(params.start !== undefined ? { start: params.start } : {}),
        ...(params.done !== undefined ? { done: params.done } : {}),
        ...(params.drop !== undefined ? { drop: params.drop } : {}),
      };

      // D10: validated before the gate, so a rejected call runs no verify
      // command and stamps nothing verified.
      const invalid = validateTaskListUpdate(state, update);
      if (invalid !== undefined) {
        return {
          content: text(`todo: ${invalid}\n${renderTaskList(state)}`),
          isError: true,
          details: { error: invalid },
        };
      }

      // T100: the gate runs BEFORE anything is applied, so a refused `done`
      // leaves the item exactly as it was rather than marked and reverted.
      if (opts.verifier !== undefined && update.done !== undefined && update.done.length > 0) {
        const refusal = await runGate(state, update.done, opts.verifier);
        if (refusal !== undefined) {
          state.gateRefusals += 1;
          state.version += 1;
          opts.onChange?.(state);
          // D10: the whole call is refused, and the model is told so rather
          // than left to find its `add`, `start` or `drop` silently missing.
          const others = update.add !== undefined || update.start !== undefined || update.drop !== undefined;
          const note = others ? "\n\nNothing else in this call was applied either; send it again without the failing `done`." : "";
          // D7: `isError`, because this is the most important "no" this tool
          // says and a caller reading only the structured half could not see
          // it before.
          return { content: text(refusal + note), isError: true, details: { gate: "refused" } };
        }
      }

      const result = applyTaskListUpdate(state, update);
      if (!result.ok) {
        return {
          content: text(`todo: ${result.error}\n${renderTaskList(state)}`),
          isError: true,
          details: { error: result.error },
        };
      }
      if (result.changed) opts.onChange?.(state);
      const open = state.items.filter((i) => i.status === "pending" || i.status === "in_progress").length;
      // Only a real change. A bare `todo` call is the model re-reading the
      // list, and announcing that as a change would make the event useless for
      // the thing anybody would hook it for.
      if (result.changed) {
        (opts.events ?? NULL_EVENT_SINK).emit("task_list_changed", {
          open,
          total: state.items.length,
          completedIds: result.completedIds,
          version: state.version,
        });
      }
      return {
        content: text(renderTaskList(state)),
        details: {
          open,
          total: state.items.length,
          // D7: the ids that closed on THIS call. The reference returns the
          // same thing as `completedTasks`; it already existed here and was
          // being dropped at the tool boundary.
          completed: result.completedIds,
        },
      };
    },
  });
}

/**
 * Runs each verify command attached to an item being marked done. Returns a
 * refusal message, or undefined when everything passed (or nothing had a
 * command).
 *
 * The verdict is recorded on the item either way — a passing check is the
 * evidence `outcome_source = verification_command` is allowed to rest on, and
 * a failing one is what the model is shown instead of a green tick.
 */
async function runGate(
  state: TaskListState,
  ids: number[],
  verifier: TaskItemVerifier,
): Promise<string | undefined> {
  const byId = new Map(state.items.map((i) => [i.id, i]));
  const failures: string[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (item === undefined || item.verify === undefined) continue;
    const run = await verifier(item);
    item.verified = { ok: run.ok, exitCode: run.exitCode, at: new Date().toISOString() };
    if (!run.ok) {
      failures.push(
        `item ${id} (${item.text}) — \`${item.verify}\` exited ${run.exitCode ?? "?"}:\n${run.output}`,
      );
    }
  }
  if (failures.length === 0) return undefined;
  return (
    `todo: not marked done — the verify command failed. Fix the cause and mark it done again.\n\n` +
    `${failures.join("\n\n")}\n\n${renderTaskList(state)}`
  );
}
