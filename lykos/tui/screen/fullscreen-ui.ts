// The full-screen surface's `AgentUi` — same interface `s0.ts`'s
// `createAgentUi()` satisfies (`session/interactive.ts`'s `runInteractiveLoop`
// calls either one identically), backed by `ScreenPipeline` instead of
// writing lines to stdout. This is the piece that turns T41-T51's tested-
// in-isolation modules into what `lykos run --interactive` actually shows,
// gated by `fallback.ts`'s `decideRenderMode()` from `session/interactive.ts`.
//
// Two things this file does that `createAgentUi()` does not need to:
// stream deltas by MUTATING a block in place (`ScreenPipeline.
// updateBlock()`) rather than appending bytes, so a streamed reply stays
// one flowing paragraph instead of one scrollback line per token; and
// separate a tool's status from its diff into two block kinds (T44's
// taxonomy keeps them distinct, unlike the append-only renderer's single
// `ToolBlock` with an embedded optional diff).
//
// `toolsCollapsed` is tracked (so `/verbose`'s toggle message is honest)
// but does not yet change any rendering here — the full-screen tool block
// has no expanded-body form to collapse the way the append-only renderer's
// does, since a diff is its own block kind. Named rather than silently
// inert.

import type { ResolvedConfig } from "../../config/types.js";
import type { ApprovalRequest } from "../../gate/approval.js";
import type { StandaloneSessionState } from "../../session/session.js";
import { deriveHud, piContextFraction, previewResult, toolSummary, type AgentUi, type LiveSessionFacts, type StreamEvent, type Subscribable } from "../s0.js";
import type { ConversationView } from "../renderers/conversation.js";
import { renderJson } from "../renderers/json.js";
import { style, type ResolvedTheme } from "../theme/resolve.js";
import { GLYPHS } from "../theme/types.js";
import { fmtDuration } from "../format.js";
import { extractFullDiff, type DiffView } from "./diff.js";
import { ScreenPipeline } from "./pipeline.js";
import type { ScreenHeaderInfo } from "./header.js";
import type { ScreenBlock, ScreenToolInfo, SystemPart, TurnStatsView } from "./blocks.js";

export interface FullscreenAgentUiOptions {
  pipeline: ScreenPipeline;
  header: ScreenHeaderInfo;
  ledgerPath: string;
  config: ResolvedConfig;
  startedUtc: string;
  theme: ResolvedTheme;
  /**
   * Live facts only a running `AgentSession` has — the current reasoning
   * effort and Pi's own context-window occupancy (2026-09-02 item 6). A
   * callback rather than a value because both change during the session:
   * `/effort` sets one and every turn moves the other.
   */
  live?: () => LiveSessionFacts;
  /**
   * Fired once a tool call's result blocks are on screen, and again when a
   * turn ends. `session/interactive.ts` wires it to `RawApprovalGate.
   * advance()`, which is what holds the NEXT queued approval prompt back
   * until the previously approved command's own output has landed
   * (2026-09-02 round seven, item 4). Deliberately a broad signal rather
   * than a per-tool-call correlation: the gate only ever has one decision
   * waiting to be advanced, so "any tool finished" is enough, and a
   * signal that cannot go missing is worth more here than a precise one
   * that can.
   */
  onToolEnd?: () => void;
}

/**
 * Pi's own `Loader` component (`@earendil-works/pi-tui`, read directly out
 * of `node_modules` — 2026-09-02: "inspect Pi code for this"): a braille
 * spinner cycled on an 80ms `setInterval`, independent of whether any real
 * content has arrived. That timer, not the token-delta pipeline, is what
 * was actually missing — every delta-handling piece here was already
 * correct (subscribe-before-run, per-delta `updateBlock`, a 30Hz
 * scheduler), which is why the 2026-09-01 investigation into "1-3s then
 * dump everything" found no bug in any of them. What Pi has and Lykos
 * didn't is continuous visual feedback during the silent gap BEFORE the
 * first token — TTFT, or a tool call's own latency — during which nothing
 * here ever called `markDirty()`, so the screen looked frozen the whole
 * time and then "dumped" once real content started arriving fast enough
 * to look instantaneous by comparison.
 */
const WORKING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WORKING_INTERVAL_MS = 80;

/**
 * Pi's `bash` tool returns `{ content: [{ type: "text", text }], details }`
 * — no `output` field and no `exitCode` field, and it THROWS on a non-zero
 * exit rather than returning the code (read out of `node_modules`, the
 * bundled `createBashTool`). This function used to look for `output` and
 * `exitCode` and find neither, which is exactly the 2026-09-02 report's
 * item 12: "bash right now does not show content too" — with `⚠ exit
 * unknown` underneath it, because undefined is what it kept reading.
 *
 * So: the text comes out of the content array, and the exit code is
 * inferred from the event's own `isError` — 0 when the tool returned
 * normally (Pi would have thrown otherwise), undefined when it errored,
 * since the code that caused the throw is only in the message text.
 */
function bashResultFields(result: unknown, isError: boolean): { output: string; exitCode: number | undefined } {
  const rec = result !== null && typeof result === "object" ? (result as Record<string, unknown>) : {};
  const parts: string[] = [];
  if (Array.isArray(rec.content)) {
    for (const item of rec.content) {
      if (item !== null && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
        parts.push((item as { text: string }).text);
      }
    }
  }
  const output = parts.length > 0 ? parts.join("\n") : typeof rec.output === "string" ? rec.output : typeof result === "string" ? result : "";
  const exitCode = typeof rec.exitCode === "number" ? rec.exitCode : isError ? undefined : 0;
  return { output, exitCode };
}

/** Builds the full-screen `AgentUi`. `pipeline` is owned by the caller (`session/interactive.ts`), which is what owns the terminal and the real stdin/stdout — this file never touches either. */
export function createFullscreenAgentUi(opts: FullscreenAgentUiOptions): AgentUi {
  const { pipeline } = opts;
  const view: ConversationView = { blocks: [], hud: null, toolsCollapsed: true, thinkingCollapsed: false };
  let streamed = false;
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${seq++}`;

  let turn = 0;
  let assistantId: string | null = null;
  let thinkingId: string | null = null;
  const accumulatedText = new Map<string, string>();

  // 2026-09-02 round eight, item 2's per-turn stats line. `getState` is
  // only known once `attach()` runs (it hands over the closure Pi's own
  // usage accumulator lives behind), so the span markers below start out
  // unset and `writeUser`/`endTurn` are no-ops for them until attach has
  // happened — which, in production, is before the first prompt is ever
  // typed.
  let getState: (() => StandaloneSessionState) | null = null;
  let turnStartedAt: number | null = null;
  let turnStartUsage: { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number } | null = null;

  function usageSnapshot(state: StandaloneSessionState): { input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number } {
    return {
      input: state.usage.input,
      output: state.usage.output,
      cacheRead: state.usage.cacheRead,
      cacheWrite: state.usage.cacheWrite,
      costUsd: state.usage.calls.reduce((sum, c) => sum + (c.costUsd ?? 0), 0),
    };
  }

  function accumulate(kind: "speech" | "thinking", id: string, delta: string): void {
    const next = (accumulatedText.get(id) ?? "") + delta;
    accumulatedText.set(id, next);
    // Still streaming: `blocks.ts` uses this to hold back the
    // click-to-copy hint until the answer is finished (round thirteen,
    // item 3), so it appears once rather than being redrawn one row lower
    // on every delta.
    pipeline.updateBlock(id, { id, kind, text: next, ...(kind === "speech" ? { streaming: true } : {}) });
  }

  function pushDiff(toolId: string, diff: DiffView): void {
    pipeline.pushBlock({ id: `${toolId}-diff`, kind: "diff", diff });
  }

  let workingTimer: ReturnType<typeof setInterval> | null = null;
  let workingFrame = 0;

  function stopWorking(): void {
    if (workingTimer) {
      clearInterval(workingTimer);
      workingTimer = null;
    }
    pipeline.setStatus(null);
  }

  /**
   * The line under a running tool — round twelve, item 2: "when approving
   * a bash command... then there should be something underneath saying
   * like: waiting for bash for <formatted_time>, up to <formatted_max
   * waiting time>".
   *
   * `tool_execution_start` used to call `stopWorking()` and leave the
   * status region EMPTY, which is precisely the gap the request describes:
   * a decision is made, the screen goes quiet, and nothing on it says
   * whether anything is happening or how long it has been happening for.
   * This replaces the generic "Working..." with the tool's own name, its
   * elapsed time, and the limit past which it has taken too long.
   *
   * **What happens at the limit, and why it is not a kill.** Moving a long
   * command to the background so the agent can carry on would help, but
   * Lykos cannot do it: the tool
   * process belongs to Pi, `session.executeBash` returns one promise for
   * the whole run with no handle to detach or terminate, and manufacturing
   * one would mean patching Pi — which this project does not do without a
   * decision entry saying what was tried first (AGENTS.md rule 6). What
   * IS replicated is the part that helps: a limit that is stated up front,
   * a running elapsed count, and — at the limit — the line turning into a
   * warning that names the escape hatch that does exist, Ctrl-C, which
   * interrupts the turn. The limit is a config value rather than something
   * the model chooses, for the same reason `outcome_source` exists: an
   * agent's own estimate of how long its command should take is exactly
   * the kind of self-report this project refuses to trust.
   */
  function startWaiting(toolName: string): void {
    stopWorking();
    workingFrame = 0;
    const startedAt = Date.now();
    const limit = Math.max(0, opts.config.ui.tool_wait_limit_seconds);
    const paint = () => {
      const glyph = WORKING_FRAMES[workingFrame % WORKING_FRAMES.length]!;
      workingFrame += 1;
      const elapsed = (Date.now() - startedAt) / 1000;
      const over = limit > 0 && elapsed > limit;
      const body = limit > 0
        ? `waiting for ${toolName} — ${fmtDuration(elapsed)} of up to ${fmtDuration(limit)}`
        : `waiting for ${toolName} — ${fmtDuration(elapsed)}`;
      const tail = over ? `  ${GLYPHS[opts.theme.glyphs].warnGlyph} over the limit — Ctrl-C interrupts` : "";
      pipeline.setStatus(
        `${style(glyph, "accent", opts.theme)} ${style(body, over ? "warn" : "dim", opts.theme)}${tail ? style(tail, "warn", opts.theme) : ""}`,
      );
    };
    paint();
    workingTimer = setInterval(paint, WORKING_INTERVAL_MS);
    // Never a reason to keep the process alive: this is a repaint timer,
    // not work. Without the unref a session whose last event was a tool
    // finishing would hang at exit waiting on the spinner — which is
    // exactly what it did to the test runner the moment `tool_execution_
    // end` started re-arming the loader (round thirteen).
    workingTimer.unref?.();
  }

  /** Called once per turn (writeUser) — restarts cleanly even if a prior turn's timer was somehow still armed. */
  function startWorking(): void {
    stopWorking();
    workingFrame = 0;
    const paint = () => {
      const glyph = WORKING_FRAMES[workingFrame % WORKING_FRAMES.length]!;
      workingFrame += 1;
      pipeline.setStatus(`${style(glyph, "accent", opts.theme)} ${style("Working...", "dim", opts.theme)}`);
    };
    paint();
    workingTimer = setInterval(paint, WORKING_INTERVAL_MS);
    workingTimer.unref?.();
  }

  const ui: AgentUi = {
    view,
    get streamed() {
      return streamed;
    },
    writeUser(text: string) {
      turn += 1;
      assistantId = null;
      thinkingId = null;
      // Only arm on the FIRST writeUser of an idle turn — a mid-turn steer
      // also calls this (2026-09-02 round three, item 3's own "typed
      // something and it silently vanished" fix), and a steer is still
      // part of answering the same prompt, not a new stopwatch. `endTurn`
      // is what clears these back to null, so a second writeUser before
      // that never resets them.
      if (turnStartedAt === null && getState) {
        turnStartedAt = Date.now();
        turnStartUsage = usageSnapshot(getState());
      }
      pipeline.pushBlock({ id: nextId("user"), kind: "user", text });
      startWorking();
    },
    /** Safety net for a turn that produces no visible content at all (an immediate abort) — the per-delta/per-tool stops below cover the normal case. */
    endTurn() {
      stopWorking();
      if (turnStartedAt !== null && turnStartUsage && getState) {
        const now = usageSnapshot(getState());
        const stats: TurnStatsView = {
          elapsedSeconds: (Date.now() - turnStartedAt) / 1000,
          costUsd: now.costUsd - turnStartUsage.costUsd,
          tokens: {
            input: now.input - turnStartUsage.input,
            output: now.output - turnStartUsage.output,
            cacheRead: now.cacheRead - turnStartUsage.cacheRead,
            cacheWrite: now.cacheWrite - turnStartUsage.cacheWrite,
          },
          context: ((): TurnStatsView["context"] => {
            const usage = opts.live?.().contextUsage;
            // Same zero-used placeholder as round six's boot gauge: no
            // response has landed yet if `tokens` is null, which reads as
            // "nothing measured" (an em dash), not "0 of N used".
            return usage ? { usedTokens: usage.tokens ?? 0, totalTokens: usage.contextWindow, pct: piContextFraction(usage.percent) } : null;
          })(),
        };
        pipeline.pushBlock({ id: nextId("stats"), kind: "stats", stats });
      }
      turnStartedAt = null;
      turnStartUsage = null;
      // A turn cannot end with an approval still legitimately queued, so
      // this is the second half of `onToolEnd`'s safety story: whatever
      // happened, the queue is never left waiting on a signal that is not
      // coming.
      opts.onToolEnd?.();
    },
    writeSystem(text: string, parts?: readonly SystemPart[]) {
      pipeline.pushBlock({ id: nextId("system"), kind: "system", text, ...(parts && parts.length > 0 ? { parts } : {}) });
    },
    writeFollowup(text: string) {
      pipeline.pushBlock({ id: nextId("followup"), kind: "followup", text });
    },
    writeHud(state: StandaloneSessionState, sessionId: string) {
      const live = opts.live?.();
      const vm = deriveHud({
        ledgerPath: opts.ledgerPath,
        config: opts.config,
        sessionId,
        startedUtc: opts.startedUtc,
        state,
        ...(live ? { live } : {}),
      });
      view.hud = vm;
      pipeline.setViewModel(vm);
      return vm;
    },
    renderApproval(req: ApprovalRequest) {
      // The raw-mode approval flow (T49's RawApprovalGate) renders its own
      // modal via ScreenPipeline.setOverlay() and never calls this — this
      // exists so the decision still leaves a visible trace in scrollback
      // history, and so the AgentUi interface contract is honestly met for
      // any other caller.
      pipeline.pushBlock({
        id: nextId("approval"),
        kind: "approval",
        approval: { kind: req.kind, summary: req.summary, detail: req.detail },
      });
      return `${req.kind}: ${req.summary}`;
    },
    attach(session: Subscribable, getStateFn: () => StandaloneSessionState) {
      getState = getStateFn;
      const unsubscribe = session.subscribe((ev: StreamEvent) => {
        switch (ev.type) {
          case "message_update": {
            const ame = ev.assistantMessageEvent;
            if (!ame) break;
            if (ame.type === "text_delta" && typeof ame.delta === "string") {
              streamed = true;
              stopWorking();
              if (!assistantId) {
                assistantId = nextId(`assistant-${turn}`);
                accumulatedText.set(assistantId, ame.delta);
                pipeline.pushBlock({ id: assistantId, kind: "speech", text: ame.delta, streaming: true });
              } else {
                // The block's OWN accumulated text is read back from nowhere
                // here — `accumulatedText` holds it, since the pipeline only
                // stores a rendered block, not a way to read its source text
                // back out.
                accumulate("speech", assistantId, ame.delta);
              }
            } else if (ame.type === "text_end") {
              // One final re-render with `streaming` cleared, which is what
              // puts the click-to-copy hint under the finished answer
              // (round thirteen, item 3).
              if (assistantId) {
                const full = accumulatedText.get(assistantId);
                if (full !== undefined) pipeline.updateBlock(assistantId, { id: assistantId, kind: "speech", text: full });
              }
              assistantId = null;
            } else if (ame.type === "thinking_delta" && typeof ame.delta === "string" && !view.thinkingCollapsed) {
              stopWorking();
              if (!thinkingId) {
                thinkingId = nextId(`thinking-${turn}`);
                accumulatedText.set(thinkingId, ame.delta);
                pipeline.pushBlock({ id: thinkingId, kind: "thinking", text: ame.delta });
              } else {
                accumulate("thinking", thinkingId, ame.delta);
              }
            }
            break;
          }
          case "tool_execution_start": {
            const name = ev.toolName ?? "tool";
            const id = ev.toolCallId ?? nextId("tool");
            const tool: ScreenToolInfo = { name, summary: toolSummary(name, ev.args), state: "running" };
            pipeline.pushBlock({ id, kind: "tool", tool });
            // Round twelve, item 2: the status region says what is being
            // waited on rather than going blank for the duration.
            startWaiting(name);
            break;
          }
          case "tool_execution_end": {
            const name = ev.toolName ?? "tool";
            const isRead = name.toLowerCase() === "read";
            const id = ev.toolCallId ?? `tool-unknown-${seq}`;
            // T51.3 (2026-09-01 UI feedback): a completed `read` replaces
            // its own "running" tool line with the green full-width bar
            // (blocks.ts's `renderRead`), matching Pi's presentation,
            // instead of the generic diamond-marker tool line.
            if (isRead) {
              const path = toolSummary(name, ev.args);
              if (!pipeline.updateBlock(id, { id, kind: "read", path })) {
                pipeline.pushBlock({ id: nextId("read"), kind: "read", path });
              }
            } else {
              const tool: ScreenToolInfo = { name, summary: toolSummary(name, ev.args), state: ev.isError ? "error" : "ok" };
              if (!pipeline.updateBlock(id, { id, kind: "tool", tool })) {
                // The matching start event was never seen (a delegate-side
                // race, or a session resumed mid-tool) — show the end result
                // rather than dropping it silently.
                pipeline.pushBlock({ id: nextId("tool"), kind: "tool", tool });
              }
            }
            if (name === "bash") {
              const { output, exitCode } = bashResultFields(ev.result, ev.isError ?? false);
              const command = typeof (ev.args as { command?: unknown } | null)?.command === "string" ? (ev.args as { command: string }).command : name;
              pipeline.pushBlock({
                id: nextId("bash"),
                kind: "bash",
                bash: { command, output, exitCode, sendToModel: true },
              });
            } else {
              const diff = extractFullDiff(name, ev.args, ev.result);
              if (diff) pushDiff(id, diff);
            }
            // The read block above already IS the full result summary —
            // the generic JSON preview underneath it was the source of the
            // "too much emoji" complaint (renderSystem stamped ⚡ on every
            // wrapped line of a multi-hundred-line file's JSON dump).
            // Round twelve, item 1: off unless asked for. `ui.
            // tool_result_preview` turns it on permanently, `/verbose`
            // turns it on for the session — the same switch that already
            // means "show me the parts that are folded away".
            const wantsPreview = opts.config.ui.tool_result_preview || pipeline.isExpanded;
            const preview = wantsPreview ? previewResult(ev.result) : undefined;
            if (preview && name !== "bash" && !isRead) {
              pipeline.pushBlock({ id: nextId("system"), kind: "system", text: preview.slice(0, 2000) });
            }
            // The tool is done but the turn is not: back to the generic
            // spinner, so the gap between a tool finishing and the next
            // token arriving is not the same silent screen round twelve's
            // item 2 is about. `endTurn` (or the first delta) clears it.
            startWorking();
            // Every result block for this tool call is now pushed - see
            // `onToolEnd`'s own doc for why the approval queue waits for it.
            opts.onToolEnd?.();
            break;
          }
          case "compaction_start":
            pipeline.pushBlock({ id: nextId("system"), kind: "system", text: "compacting..." });
            break;
          case "compaction_end":
            pipeline.pushBlock({ id: nextId("system"), kind: "system", text: "compacted" });
            break;
          default:
            break;
        }
      });
      // Teardown safety net: whatever the last turn's state was, a
      // detached UI has no business still repainting an animation timer.
      return () => {
        stopWorking();
        unsubscribe();
      };
    },
    snapshotJson() {
      return view.hud ? renderJson(view.hud) : "{}";
    },
  };

  return ui;
}
