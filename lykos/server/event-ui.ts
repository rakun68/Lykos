/**
 * The surface a server session draws on (P5 #35): the old TUI's `AgentUi`, with every block it would print
 * turned into a protocol event instead. Pi's events are read the way `tui/s0.ts`'s `attach` reads them, and the
 * status line's numbers come from the same `deriveHud` the old footer uses.
 */
import type { ApprovalRequest } from "../gate/approval.js";
import type { InteractiveSession } from "../session/interactive.js";
import { deriveHud, previewResult, toolSummary, type AgentUi, type AgentUiOptions, type StreamEvent } from "../tui/s0.js";
import { extractDiff, type ConversationView } from "../tui/renderers/conversation.js";
import { renderJson } from "../tui/renderers/json.js";
import type { EventData, SessionStatus, UsageData } from "./protocol.js";

/** A tool's output is shown, not stored, here: the transcript keeps all of it. */
const PREVIEW_MAX = 8 * 1024;

export interface EventUiHooks {
  emit: (data: EventData) => void;
  status: (status: SessionStatus) => void;
}

export function createEventUi(opts: AgentUiOptions, session: InteractiveSession, hooks: EventUiHooks): AgentUi {
  const view: ConversationView = { blocks: [], hud: null, toolsCollapsed: true, thinkingCollapsed: false };
  const toolNames = new Map<string, string>();
  let streamed = false;
  let assistantOpen = false;
  let toolSeq = 0;

  const usage = (state: Parameters<AgentUi["writeHud"]>[0], sessionId: string): ReturnType<AgentUi["writeHud"]> => {
    const contextUsage = session.getContextUsage?.();
    const model = opts.header.model;
    const vm = deriveHud({
      ledgerPath: opts.ledgerPath,
      config: opts.config,
      sessionId,
      startedUtc: opts.startedUtc,
      state,
      live: { contextUsage, thinkingLevel: session.thinkingLevel, model: state.currentModel ?? model },
    });
    view.hud = vm;
    const gauge = vm.context.parent;
    const data: UsageData = {
      model: vm.session.model ?? state.currentModel ?? model,
      effort: session.thinkingLevel ?? null,
      contextTokens: contextUsage?.tokens ?? gauge?.usedTokens ?? null,
      contextWindow: contextUsage?.contextWindow ?? gauge?.totalTokens ?? null,
      contextPercent: contextUsage?.percent ?? (gauge?.pct !== null && gauge?.pct !== undefined ? gauge.pct * 100 : null),
      runUsd: vm.cost.runUsd,
      todayUsd: vm.cost.todayUsd,
      cacheHitRatio: vm.tokens.hitRatio,
      calls: vm.tokens.calls,
    };
    hooks.emit({ type: "usage", usage: data });
    return vm;
  };

  return {
    view,
    get streamed() {
      return streamed;
    },
    writeUser(text, typed) {
      assistantOpen = false;
      hooks.emit({ type: "message.user", text: typed ?? text });
    },
    endTurn() {
      if (assistantOpen) hooks.emit({ type: "message.end" });
      assistantOpen = false;
      hooks.emit({ type: "turn.end" });
    },
    writeSystem(text) {
      hooks.emit({ type: "system", text });
    },
    writeFollowup(text) {
      hooks.emit({ type: "message.followup", text });
    },
    writeHud: usage,
    renderApproval(req: ApprovalRequest) {
      return `${req.kind}: ${req.summary}`;
    },
    attach(source) {
      return source.subscribe((ev: StreamEvent) => {
        switch (ev.type) {
          case "agent_start":
            hooks.status("running");
            break;
          case "agent_end":
            if (assistantOpen) hooks.emit({ type: "message.end" });
            assistantOpen = false;
            hooks.status("idle");
            break;
          case "message_update": {
            const ame = ev.assistantMessageEvent;
            if (!ame) break;
            if (ame.type === "text_delta" && typeof ame.delta === "string") {
              streamed = true;
              assistantOpen = true;
              hooks.emit({ type: "message.delta", text: ame.delta });
            } else if (ame.type === "text_end") {
              if (assistantOpen) hooks.emit({ type: "message.end" });
              assistantOpen = false;
            } else if (ame.type === "thinking_delta" && typeof ame.delta === "string") {
              hooks.emit({ type: "thinking.delta", text: ame.delta });
            }
            break;
          }
          case "tool_execution_start": {
            const name = ev.toolName ?? "tool";
            const toolId = ev.toolCallId ?? `tool-${++toolSeq}`;
            toolNames.set(toolId, name);
            hooks.emit({ type: "tool.start", toolId, name, summary: toolSummary(name, ev.args), args: ev.args ?? null });
            break;
          }
          case "tool_execution_end": {
            const toolId = ev.toolCallId ?? [...toolNames.keys()].reverse().find((id) => toolNames.get(id) === ev.toolName) ?? `tool-${toolSeq}`;
            const name = toolNames.get(toolId) ?? ev.toolName ?? "tool";
            toolNames.delete(toolId);
            const diff = extractDiff(name, ev.args, ev.result);
            const full = previewResult(ev.result);
            const preview = full !== undefined && full.length > PREVIEW_MAX ? `${full.slice(0, PREVIEW_MAX)}\n… ${full.length - PREVIEW_MAX} more characters in the transcript` : full;
            hooks.emit({
              type: "tool.end",
              toolId,
              name,
              ok: ev.isError !== true,
              ...(preview !== undefined ? { preview } : {}),
              ...(diff !== undefined ? { diff } : {}),
            });
            break;
          }
          case "compaction_start":
            hooks.emit({ type: "system", text: "compacting…" });
            break;
          case "compaction_end":
            hooks.emit({ type: "system", text: "compacted" });
            break;
          default:
            break;
        }
      });
    },
    snapshotJson() {
      return view.hud ? renderJson(view.hud) : "{}";
    },
  };
}
