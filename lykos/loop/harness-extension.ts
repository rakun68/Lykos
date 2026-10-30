// T84 — wire the live tool-result clamp into the standalone path.
// (`docs/25-phase15-sharpening-tasks.md` T84.)
//
// THE CLAMP ALREADY EXISTED AND WAS CONNECTED TO NOTHING. `ToolResultDiet`
// (T21.2, `prompt-diet.ts`) caps a tool result as it is produced,
// keeps a per-path hash so an unchanged re-read collapses to a stub, and
// counts both. It was written in Phase 2, it is tested, and a repo-wide
// search for its name returns exactly one hit: its own definition. This
// file is the missing wire.
//
// `session/session.ts`'s own header has said so since T33, in the "deliberately
// out of scope" note: "T21.2's live tool-result byte cap ... container-only
// today; this path runs Pi's own default compaction and uncapped tool
// results." That note is what this task closes, so the note is now stale and
// is updated in the same commit.
//
// WHY AN EXTENSION AND NOT A TOOL WRAPPER. Lykos already shadows
// `write`/`edit`/`bash` through `customTools` for the approval gate, so
// clamping there would have been easy — and would have missed `read`, which
// is the single largest producer of context bytes and is deliberately not
// shadowed. Pi's `tool_result` hook sees every tool including `read`, and
// `DefaultResourceLoader` accepts `extensionFactories`, so this needs no
// patch to Pi and no change to the tool surface: it registers ZERO tools,
// and the hop-0 schema tax is unchanged. That is the whole reason this is
// an extension rather than the eleventh entry in a tool allowlist.
//

import type { InlineExtension, ToolResultEvent as PiToolResultEvent } from "@earendil-works/pi-coding-agent";
import { ToolResultDiet, type ToolResultEvent } from "./prompt-diet.js";
import {
  budgetNotice,
  contextNoticeEnabledFromEnv,
  newContextBudgetState,
  type ContextBudgetState,
} from "./context-budget.js";
import { observeSkillCall, observeSkillRead, type SkillInvocationState, type SkillLike } from "../session/skills.js";
import { SKILL_TOOL_NAME } from "../tools/skill-tools.js";
import { resolveActualToolArgs, resolveActualToolName, tierForToolCall } from "../tools/tool-call.js";
import { createCheckpoint, type CheckpointDeps } from "./checkpoint.js";
import { isFileChangingCall } from "../tools/tool-call.js";
import type { HookRegistry } from "./hooks.js";
import { NULL_EVENT_SINK, type LykosEventSink, type LykosExtensionHost } from "../extensions/api.js";
import {
  isMutatingTool,
  runPostEditCheck,
  type CommandRunner,
  type PostEditPolicy,
  type PostEditState,
} from "./post-edit.js";
import {
  taskListReminder,
  DEFAULT_REMINDER_INTERVAL,
  type TaskListState,
} from "../tools.js";
import {
  newStagnationState,
  observeToolCall,
  stagnationEnabledFromEnv,
  stagnationThresholdFromEnv,
  type StagnationState,
} from "./stagnation.js";

/** Live counters, read at snapshot time. One object per session. */
export interface HarnessObservation {
  /** Results the byte cap actually shortened. */
  clampedResults: number;
  /** Re-reads of an unchanged file collapsed to a stub. */
  unchangedStubs: number;
  /** Bytes the clamp kept out of the context. The saving, measured rather than modelled. */
  bytesElided: number;
  /** Bytes that would have entered the context with no clamp. The denominator. */
  bytesOffered: number;
  /** T85: times the stagnation brake fired (warn or stop). */
  stagnationTrips: number;
  /** T85: true when the brake asked for a hard stop. */
  stagnationStopped: boolean;
  /** T85: the target that stalled, for the ledger note. */
  stagnationKey: string | undefined;
  /**
   * T86: tokens in the context right now — the last model call's
   * input + cache_read. `session/session.ts` updates this on `message_end`;
   * the extension only reads it.
   */
  contextTokens: number;
  /** T86: the model's window, resolved at boot. 0 means unknown — say nothing. */
  contextWindow: number;
  /** T86: how many budget notices were actually shown. */
  contextNotices: number;
  /** T98: times the unseen task list was appended back onto a tool result. */
  taskListReminders: number;
  /** T104: turn checkpoints actually written (an unchanged tree writes none). */
  checkpoints: number;
  /** T105: tool calls a hook refused outright. */
  hookDenials: number;
  /** T105: notes hooks appended to what the model reads. */
  hookNotes: number;
}

export function newHarnessObservation(): HarnessObservation {
  return {
    clampedResults: 0,
    unchangedStubs: 0,
    bytesElided: 0,
    bytesOffered: 0,
    stagnationTrips: 0,
    stagnationStopped: false,
    stagnationKey: undefined,
    contextTokens: 0,
    contextWindow: 0,
    contextNotices: 0,
    taskListReminders: 0,
    checkpoints: 0,
    hookDenials: 0,
    hookNotes: 0,
  };
}

export interface HarnessExtensionOpts {
  /** Byte cap per tool result. Comes from the resolved diet policy. */
  maxBytes: number;
  /** Mutated in place; the session reads it when it builds its snapshot. */
  observation: HarnessObservation;
  /**
   * T85: called once when the brake asks for a hard stop. `session/session.ts`
   * wires this to `session.abort()`. It is a callback rather than an abort
   * call here because an extension has no business owning the session
   * lifecycle — it reports the condition, the owner decides.
   */
  onHardStop?: (note: string) => void;
  /** T86: the compaction threshold, so the notice can say what happens next. */
  compactionThreshold?: number;
  /**
   * T98.4: the session's task list. Present only when the `todo` tool is on
   * the surface. When present, a list with open items that the model has not
   * looked at for `reminderInterval` tool calls is appended to the next tool
   * result — the same tail channel T85 and T86 use, for the same reason.
   */
  taskList?: TaskListState;
  reminderInterval?: number;
  /**
   * T99: the post-edit feedback loop. Both present → a successful `write` or
   * `edit` runs the project's check and its failure is appended to the tool
   * result the model is already reading. Absent → the session has no
   * post-edit loop, which is what every session before T99 had.
   */
  postEdit?: { policy: PostEditPolicy; state: PostEditState; run?: CommandRunner; events?: LykosEventSink };
  /**
   * T102: the skills on offer and where their invocations are counted. A
   * skill body is loaded with `read`, so an invocation IS a read of a skill
   * file — observable from the trace without instrumenting anything the
   * model does, and without a tool of its own.
   */
  skills?: { roster: readonly SkillLike[]; invocation: SkillInvocationState };
  /**
   * T104: where turn checkpoints are taken. Present → a checkpoint is written
   * at the start of every turn whose tree differs from the last one. Absent →
   * no checkpointing, which is what a session outside a git repository gets.
   */
  checkpoint?: CheckpointDeps & {
    /**
     * T156: a tool this session's Lykos extensions registered. Its call may
     * change files — declared or not, which only its result can tell — so the
     * turn's checkpoint is taken before it, as before any file-changing call.
     */
    isExtensionTool?: (name: string) => boolean;
  };
  /**
   * T105: the hook surface. Present → `pre_tool` runs on Pi's `tool_call`
   * event (which sees every tool, including the `read` that
   * `gate/approval.ts` deliberately does not shadow) and `post_tool` runs
   * here, after the clamp, so a hook's note is text the model will see.
   */
  hooks?: { registry: HookRegistry; cwd: string };
  /**
   * P10.9 (ticket 21, D2): the session's Lykos extension sink.
   *
   * This extension is where `budgetNotice` is called from, and the budget band
   * it crosses is computed inside that function — so the sink has to reach it
   * from here. `postEdit.events` and `checkpoint.events` are threaded on their
   * own sub-objects because those two functions take the sink themselves.
   */
  events?: LykosEventSink;
  /**
   * P4 T149: this is a READ-ONLY child session (`BootConfig.readOnly`). Every
   * call that would change a file (T143's one declaration) or whose declared
   * tier is not `read` is blocked on Pi's `tool_call`, before the tool runs —
   * the last of the read-only layers, catching what the tool list and the
   * gate did not: a tool a Pi package registered, reached by any route.
   */
  readOnly?: boolean;
  /** T199: the extension host for tool_call veto handlers (lykos-seal, etc.). */
  extensionHost?: LykosExtensionHost;
  /** Test seam. Defaults to the real environment. */
  env?: NodeJS.ProcessEnv;
}

/** The reason a read-only child's refused call carries back to its model. */
export function readOnlyRefusal(toolName: string): string {
  return (
    `lykos: ${toolName} is refused — this is a read-only child session, and it cannot change files ` +
    `or run anything that could. Read what you need and answer in text.`
  );
}

/**
 * The Lykos harness extension: one inline extension, no registered tools.
 *
 * Named `lykos-harness` rather than `lykos-tool-result-clamp` because T85 and
 * T86 hook the same `tool_result` event and belong in the same place — three
 * extensions listening to one event would be exactly the sprawl
 * `problems/14` warns about.
 */
export function createHarnessExtension(opts: HarnessExtensionOpts): InlineExtension {
  const diet = new ToolResultDiet(opts.maxBytes);
  const obs = opts.observation;
  const env = opts.env ?? process.env;
  const brakeOn = stagnationEnabledFromEnv(env);
  const threshold = stagnationThresholdFromEnv(env);
  const stagnation: StagnationState = newStagnationState();
  const noticeOn = contextNoticeEnabledFromEnv(env);
  const budget: ContextBudgetState = newContextBudgetState();
  const compactionThreshold = opts.compactionThreshold ?? 0.8;
  const reminderInterval = opts.reminderInterval ?? DEFAULT_REMINDER_INTERVAL;
  const events = opts.events ?? NULL_EVENT_SINK;
  // T146: outside the factory so a reload of the extension does not restart the count.
  const checkpointTurns: { next: number; unstamped: { turn: number; tree: string } | undefined } = {
    next: 0,
    unstamped: undefined,
  };
  // T105: notes raised by a `pre_tool` hook, waiting for a result to ride on.
  const pendingPreToolNotes: string[] = [];
  return {
    name: "lykos-harness",
    factory: (pi) => {
      // T150: the T109 continuation threshold watch that lived here is now the
      // `lykos-continuation` default extension (`extensions/defaults/`).

      // T104: the checkpoint is taken at TURN START, not after an edit. The
      // state worth returning to is the one before the model touched
      // anything this turn, and a checkpoint written after the damage is a
      // record of the damage. An unchanged tree writes no commit at all, so
      // a turn that only read things costs one `git write-tree`.
      //
      // T146: the turn is counted across the whole session, not taken from
      // Pi's `turnIndex`, which restarts at every prompt — a second prompt's
      // "turn 0" would otherwise share a number with the first's. The live
      // transcript counts the same `turn_start` events (Pi emits each to the
      // extensions, then to subscribers), which is how `lykos show` pairs a
      // turn that changed files with the checkpoint taken before it.
      if (opts.checkpoint !== undefined) {
        const deps = opts.checkpoint;
        pi.on("turn_start", () => {
          const turn = checkpointTurns.next++;
          const result = createCheckpoint(deps, `before turn ${turn}`, { turn });
          if (result.status === "created") obs.checkpoints += 1;
          checkpointTurns.unstamped = result.status === "unchanged" ? { turn, tree: result.tree } : undefined;
        });
        // T146: a turn that began on an unchanged tree wrote no commit, so
        // its "before" state is only the previous checkpoint — which belongs
        // to another turn, or another session. The first file-changing call
        // of such a turn gives it a checkpoint of its own, holding the tree
        // the turn started from. A turn that only reads writes nothing.
        pi.on("tool_call", (event) => {
          const pending = checkpointTurns.unstamped;
          if (pending === undefined) return undefined;
          const e = event as { toolName?: string; input?: unknown };
          const actual = resolveActualToolName(e.toolName, e.input);
          const extension = actual !== undefined && deps.isExtensionTool?.(actual) === true;
          if (!extension && !isFileChangingCall(e.toolName, e.input)) return undefined;
          checkpointTurns.unstamped = undefined;
          const result = createCheckpoint(deps, `before turn ${pending.turn}`, pending);
          if (result.status === "created") obs.checkpoints += 1;
          return undefined;
        });
      }

      // P4 T149: a read-only child refuses anything that is not a read,
      // before a hook or the tool itself sees it.
      if (opts.readOnly === true) {
        pi.on("tool_call", (event) => {
          const e = event as { toolName?: string; input?: unknown };
          const name = e.toolName ?? "?";
          if (isFileChangingCall(e.toolName, e.input) || tierForToolCall(name, e.input) !== "read") {
            return { block: true, reason: readOnlyRefusal(resolveActualToolName(e.toolName, e.input) ?? name) };
          }
          return undefined;
        });
      }

      // T199: Lykos extension tool_call veto handlers (lykos-seal, etc.).
      if (opts.extensionHost !== undefined) {
        const host = opts.extensionHost;
        pi.on("tool_call", async (event) => {
          const e = event as { toolName?: string; input?: unknown };
          const actualName = resolveActualToolName(e.toolName, e.input) ?? e.toolName ?? "";
          const actualArgs = resolveActualToolArgs(e.toolName, e.input) ?? (e.input as Record<string, unknown> | undefined) ?? {};
          const veto = await host.runToolCallVeto(actualName, actualArgs);
          if (veto?.block === true) {
            return { block: true, reason: veto.reason };
          }
          if (veto?.warning) {
            pendingPreToolNotes.push(veto.warning);
          }
          return undefined;
        });
      }

      // T105: the PreToolUse half. `tool_call` can `block` with a reason,
      // which is how "never write to .lykos/ledger.db" stops being prompt
      // text and starts being mechanical (`01-idea.md` §5: restrictions are
      // framework-enforced, not requested politely).
      if (opts.hooks !== undefined) {
        const { registry, cwd } = opts.hooks;
        if (registry.has("pre_tool")) {
          pi.on("tool_call", async (event) => {
            const e = event as { toolName?: string; input?: Record<string, unknown> };
            const result = await registry.run("pre_tool", {
              cwd,
              ...(e.toolName !== undefined ? { toolName: e.toolName } : {}),
              ...(e.input !== undefined ? { input: e.input } : {}),
            });
            if (result.denied !== undefined) {
              obs.hookDenials += 1;
              return { block: true, reason: result.denied.reason };
            }
            // A pre-tool NOTE cannot be returned here — `tool_call` has no
            // content channel — so it is held and attached to that call's
            // result instead, which is the next thing the model reads.
            for (const n of result.notes) pendingPreToolNotes.push(n.note);
            return {};
          });
        }
      }

      pi.on("tool_result", async (event) => {
        // Pi's ToolResultEvent is a discriminated union over tool names;
        // ToolResultDiet reads only `toolName`, `input` and `content`, which
        // every member carries. The cast is to the structural subset this
        // module actually uses, not a widening of the SDK's type.
        const applied = diet.apply(event as unknown as ToolResultEvent);
        obs.bytesOffered += applied.originalBytes;
        if (applied.truncated) {
          obs.bytesElided += Math.max(0, applied.originalBytes - applied.keptBytes);
          if (applied.unchanged) obs.unchangedStubs += 1;
          else obs.clampedResults += 1;
        }
        // T105: the PostToolUse half, run before the note chain so a project
        // hook's output competes on the same terms as the built-in notices.
        if (opts.hooks !== undefined && opts.hooks.registry.has("post_tool")) {
          const e = event as { toolName?: string; input?: Record<string, unknown>; isError?: boolean };
          const run = await opts.hooks.registry.run("post_tool", {
            cwd: opts.hooks.cwd,
            ...(e.toolName !== undefined ? { toolName: e.toolName } : {}),
            ...(e.input !== undefined ? { input: e.input } : {}),
            ...(e.isError !== undefined ? { isError: e.isError } : {}),
          });
          // P10.9 (ticket 21, D3): counted ONCE, at the drain below, not here
          // as well. A `post_tool` note is pushed onto the same pending list a
          // `pre_tool` note uses, and that list's drain — thirty lines down,
          // in the same handler, on the same event — already adds its length
          // to `obs.hookNotes`. Incrementing here too made every post-tool
          // note worth two in `sessions.hook_notes`, while a pre-tool note was
          // worth one, so the column could not be compared with itself.
          // Backlog D13 described this counter as having the opposite fault;
          // see the entry for what actually reproduced.
          for (const n of run.notes) pendingPreToolNotes.push(n.note);
        }

        // T102: counted before anything else and affecting nothing — this is
        // a measurement, not a policy. It reads the event rather than the
        // clamped result, because the clamp may have replaced a re-read with
        // a stub and a re-read of a skill is still a read of that skill.
        if (opts.skills !== undefined) {
          const e = event as { toolName?: string; input?: { path?: string; file_path?: string } };
          if (e.toolName === "read") {
            observeSkillRead(opts.skills.invocation, e.input?.path ?? e.input?.file_path, opts.skills.roster);
          }
          // P4 T143: the `skill` tool, reached directly or through `tool_call`.
          // A refused call (no such skill) loaded nothing and is not a use.
          const called = e as { toolName?: string; input?: unknown; isError?: boolean };
          if (resolveActualToolName(called.toolName, called.input) === SKILL_TOOL_NAME && called.isError !== true) {
            const args = resolveActualToolArgs(called.toolName, called.input) as { name?: unknown } | undefined;
            observeSkillCall(opts.skills.invocation, typeof args?.name === "string" ? args.name : undefined, opts.skills.roster);
          }
        }

        let note: string | undefined;

        // T105: a note raised before the call ran outranks everything else on
        // this result — it is about the very call whose result this is, and
        // the model has not seen it yet.
        if (pendingPreToolNotes.length > 0) {
          note = pendingPreToolNotes.join("\n");
          obs.hookNotes += pendingPreToolNotes.length;
          pendingPreToolNotes.length = 0;
        }

        // T99 runs FIRST and outranks every other note. A failing post-edit
        // check is about the edit that just happened and carries the error
        // text the model has to act on; a stall warning or a context notice
        // describes the session. When both would fire, the specific one wins.
        //
        // `isError` is checked because a failed edit changed nothing on
        // disk, so re-running the project's typecheck would report whatever
        // was already broken and blame it on an edit that never landed.
        if (opts.postEdit !== undefined && note === undefined) {
          const e = event as { toolName?: string; input?: unknown; isError?: boolean; details?: unknown };
          if (isMutatingTool(e.toolName, e.input, { details: e.details }) && e.isError !== true) {
            // `undefined` here takes the parameter default, which is the
            // real `spawn`-backed runner; tests inject their own.
            note = await runPostEditCheck(
              opts.postEdit.policy,
              opts.postEdit.state,
              opts.postEdit.run,
              opts.postEdit.events ?? events,
            );
          }
        }

        // T85: the brake reads the SAME event, after the clamp, so the note
        // it quotes is the text the model will actually see.
        if (brakeOn) {
          const e = event as { toolName: string; input?: unknown; isError?: boolean };
          const verdict = observeToolCall(
            stagnation,
            { toolName: e.toolName, input: e.input, isError: e.isError },
            errorTextOf(applied.content),
            threshold,
          );
          if (verdict.action !== "none") {
            obs.stagnationTrips = stagnation.trips;
            obs.stagnationKey = verdict.key;
            // The trip is recorded and the hard stop still fires even when
            // T99 has already claimed the note — the brake's authority is
            // over the session, not over the tail.
            if (note === undefined) note = verdict.note;
            if (verdict.action === "stop") {
              obs.stagnationStopped = true;
              opts.onHardStop?.(verdict.note);
            }
          }
        }

        // T86: at most one budget notice per band per session, appended the
        // same way and for the same reason as T85's note — the tail is where
        // a changing number is allowed to live.
        if (noticeOn && note === undefined) {
          note = budgetNotice(
            budget,
            {
              contextTokens: obs.contextTokens,
              contextWindow: obs.contextWindow > 0 ? obs.contextWindow : undefined,
              compactionThreshold,
            },
            undefined,
            events,
          );
          if (note !== undefined) obs.contextNotices = budget.notices;
        }

        // T98.4: last in precedence, deliberately. A stalled session (T85) or
        // a context about to compact (T86) is a more urgent thing to say than
        // "here is your list again", and appending two notices to one result
        // is how a tail becomes noise. The reminder's own clock still
        // advances on every call, so it fires on the next result instead.
        if (opts.taskList !== undefined && note === undefined) {
          // Only consulted when nothing else is being said: `taskListReminder`
          // resets its own clock when it fires, so calling it and discarding
          // the result would silently swallow a reminder and count one that
          // the model never saw.
          const reminder = taskListReminder(opts.taskList, reminderInterval);
          if (reminder !== undefined) {
            obs.taskListReminders = opts.taskList.reminders;
            note = reminder;
          }
        }

        // Returning `content` replaces what the model sees. `details` is
        // passed through untouched when the diet produced one, so a tool's
        // structured result is not silently dropped along with its text.
        // `DietToolResult.content` is `unknown` by design — `setToolResultText`
        // preserves whichever shape the tool produced (string, or a content
        // block array) rather than normalising it. The cast restores the
        // SDK's content type without changing the value.
        //
        // The stagnation note is APPENDED to the failing result rather than
        // sent as its own message: Pi's extension API has no per-turn message
        // injection, and a tool result is already the thing the model reads
        // next. It lands in the tail, never the head — T17 is not suspended.
        const content = note === undefined ? applied.content : appendNote(applied.content, note);
        return {
          content: content as PiToolResultEvent["content"],
          ...(applied.details !== undefined ? { details: applied.details } : {}),
        };
      });
    },
  };
}

/** Best-effort error text from whatever shape the tool produced. Never throws. */
function errorTextOf(content: unknown): string | undefined {
  if (typeof content === "string") return content.slice(0, 400);
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
        parts.push((block as { text: string }).text);
      }
    }
    if (parts.length > 0) return parts.join("").slice(0, 400);
  }
  return undefined;
}

/** Append a note preserving whichever content shape the tool produced. */
function appendNote(content: unknown, note: string): unknown {
  if (typeof content === "string") return `${content}

${note}`;
  if (Array.isArray(content)) return [...content, { type: "text", text: `
${note}` }];
  return content;
}
