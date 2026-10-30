// T37 S0 driver: folds AgentSessionEvents into a ConversationView and writes
// incrementally. The renderer (renderers/conversation.ts) is pure; this
// file owns the subscription and the slash-command surface.
//
// HUD numbers go through collect() → derive() — the same pipeline S1/S2
// use — with the in-process usage accumulator overlaid as the run snapshot
// because T34 ingest happens once at session end, so live.json is empty
// mid-turn. Overlaying is not a second accounting path: same Snapshot
// shape, same derive(), same renderTriadLine().

import type { ResolvedConfig } from "../config/types.js";
import type { ApprovalRequest } from "../gate/approval.js";
import type { StandaloneSessionState } from "../session/session.js";
import { collect } from "./collect.js";
import { derive } from "./derive.js";
import { stdoutWrite } from "./io-mode.js";
import {
  extractDiff,
  renderApprovalBlock,
  renderBlock,
  S0_HELP,
  type ConversationBlock,
  type ConversationView,
  type HeaderView,
  type ToolBlock,
} from "./renderers/conversation.js";
import { renderJson } from "./renderers/json.js";
import type { ResolvedTheme } from "./theme/resolve.js";
import { contextTokens } from "../ledger/context-tokens.js";
import type { RunLastCall, RunSnapshot, Snapshot, ViewModel } from "./types.js";
import type { CacheObservation } from "./cache-gauge.js";
import type { SystemPart } from "./screen/blocks.js";
import { isOwnedName, resolveExtensionCommandName, resolvePiCommandName, resolveSkillName } from "./commands.js";

export type { SystemPart };

export interface StreamEvent {
  type: string;
  assistantMessageEvent?: { type?: string; delta?: string; content?: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

export interface Subscribable {
  subscribe(listener: (ev: StreamEvent) => void): () => void;
}

export type ParsedInput =
  | { kind: "empty" }
  | { kind: "continue"; prefix: string }
  | { kind: "exit" }
  | { kind: "help" }
  | { kind: "session" }
  | { kind: "copy" }
  | { kind: "verbose" }
  | { kind: "thinking" }
  | { kind: "compact"; hint: string }
  | { kind: "followup"; text: string }
  | { kind: "effort"; level: string }
  /** 2026-09-02 round three, item 8 — both local, both free: they read state Lykos already holds in memory and never touch the model. */
  | { kind: "usage" }
  | { kind: "context" }
  /**
   * T58: open the session picker. Ends this session first — a resume is a
   * NEW session, never a swap of this one's context.
   *
   * T114: `sessionId` is set when the in-session browser already chose the
   * row, so the caller resumes it directly instead of asking a second time.
   * The rule it carries is unchanged either way.
   */
  | { kind: "resume"; sessionId?: string }
  | { kind: "new-session" }
  | { kind: "close-session" }
  /**
   * 2026-09-07 (UI feedback item 2): name this session. With no argument it
   * reports the name it currently has and where that name came from —
   * a command whose only visible effect is a changed word in a list should
   * be askable before it is used.
   */
  | { kind: "rename"; name: string }
  /** Ticket 04: `/specialist` with no argument — list every discovered specialist, marking the active one. */
  | { kind: "specialist-list" }
  /** Ticket 04: `/specialist <name>` — switch mid-session. Unlike `/model`, a nonexistent name is reported and the session is left exactly as it was; there is no "refused" variant any more. */
  | { kind: "specialist-switch"; name: string }
  /** T217: `/output-style` bare — list discovered output styles. */
  | { kind: "output-style-list" }
  /** T217: `/output-style <name>` — switch output style mid-session. */
  | { kind: "output-style-switch"; name: string }
  | { kind: "refuse-model"; spec?: string; persist?: boolean }
  /** P14.6 ticket 06: `/login <provider> [--api-key]` — the same flow as `lykos login`. `provider` is empty when none was typed. */
  | { kind: "login"; provider: string; apiKey: boolean }
  /** P14.6 ticket 06: `/credential` lists the pool, `/credential <label>` pins, `/credential auto` unpins. */
  | { kind: "credential"; arg: string }
  | { kind: "bash"; command: string; sendToModel: boolean }
  /** T131: a skill invoked as `/handoff` or `/skill:handoff`. `skill` is the roster name, whose case may differ from what was typed. */
  | { kind: "skill"; skill: string; args: string }
  /** T131: the interaction mode. Bare reports the current one; an argument sets it. */
  | { kind: "mode"; mode: string }
  /** T209 / ADR-0041: view or adjust permissions. */
  | { kind: "permissions"; args: string }
  /**
   * P10.9 (ticket 21, D5): a slash command a Lykos extension registered. The
   * loop runs it through the host it was booted with — this parser only says
   * which one was typed, because the parser is pure and the host is not.
   */
  | { kind: "extension-command"; command: string; args: string }
  | { kind: "prompt"; text: string };

/**
 * T131: dispatch reads the SAME source completion does. `OWNED` used to be
 * a second hand-maintained list here, and it had already drifted from
 * `COMMAND_REGISTRY` — `/rename` and `/name` dispatched without ever
 * completing. `isOwnedName()` also answers for skills, which is what makes
 * `/handoff` reach a skill instead of being posted to the model as prose.
 */


/** Pi's own reasoning-effort ladder — re-exported from `tui/effort.ts`, which owns it along with the ramp that colours it. */
export { EFFORT_LEVELS } from "./effort.js";

export function parseInteractiveInput(line: string): ParsedInput {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { kind: "empty" };
  if (line.endsWith("\\") && !trimmed.startsWith("!")) {
    return { kind: "continue", prefix: line.slice(0, -1) };
  }
  if (trimmed === "/exit" || trimmed === "/quit") return { kind: "exit" };
  if (trimmed.startsWith("!!")) return { kind: "bash", command: trimmed.slice(2).trim(), sendToModel: false };
  if (trimmed.startsWith("!")) return { kind: "bash", command: trimmed.slice(1).trim(), sendToModel: true };
  if (!trimmed.startsWith("/")) return { kind: "prompt", text: trimmed };

  const space = trimmed.indexOf(" ");
  const name = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).toLowerCase();
  const arg = space === -1 ? "" : trimmed.slice(space + 1).trim();
  // A skill first: `/handoff`, or `/skill:handoff` for one a built-in
  // shadows. Before T131 this fell through to `prompt` and the literal text
  // `/skill:review` was sent to the model.
  const skill = resolveSkillName(name);
  if (skill !== undefined) return { kind: "skill", skill, args: arg };
  // P10.9 (ticket 21, D5): after skills and before the built-ins' own words,
  // because `resolveExtensionCommandName` already refuses a name a built-in
  // owns — `/help` stays `/help` however many extensions want it.
  const extensionCommand = resolveExtensionCommandName(name);
  if (extensionCommand !== undefined) {
    return { kind: "extension-command", command: extensionCommand, args: arg };
  }
  // T163: a Pi extension's command is Pi's to run — sent as text, as before
  // it was completable, so Pi's prompt path dispatches it.
  if (resolvePiCommandName(name) !== undefined) return { kind: "prompt", text: trimmed };
  if (!isOwnedName(name)) return { kind: "prompt", text: trimmed };
  if (name === "help" || name === "hotkeys") return { kind: "help" };
  if (name === "session") return { kind: "session" };
  if (name === "resume") return arg.length > 0 ? { kind: "resume", sessionId: arg } : { kind: "resume" };
  if (name === "close-session") return { kind: "close-session" };
  if (name === "rename" || name === "name") return { kind: "rename", name: arg };
  // Internal browser action. `/new` remains refused because it is a head
  // rewrite when typed by a person; the browser's explicit action ends this
  // session and starts a new one through the ordinary CLI path.
  if (name === "__new") return { kind: "new-session" };
  if (name === "copy") return { kind: "copy" };
  if (name === "verbose") return { kind: "verbose" };
  if (name === "thinking") return { kind: "thinking" };
  if (name === "effort") return { kind: "effort", level: arg.toLowerCase() };
  if (name === "usage") return { kind: "usage" };
  if (name === "context") return { kind: "context" };
  if (name === "mode") return { kind: "mode", mode: arg.toLowerCase() };
  if (name === "permissions") return { kind: "permissions", args: arg };
  if (name === "compact") return { kind: "compact", hint: arg };
  if (name === "followup") return { kind: "followup", text: arg };
  if (name === "specialist") return arg.length > 0 ? { kind: "specialist-switch", name: arg } : { kind: "specialist-list" };
  if (name === "output-style") return arg.length > 0 ? { kind: "output-style-switch", name: arg } : { kind: "output-style-list" };
  if (name === "login") {
    const words = arg.split(/\s+/).filter((w) => w.length > 0);
    const apiKey = words.includes("--api-key");
    const positionals = words.filter((w) => !w.startsWith("--"));
    const unknownFlag = words.some((w) => w.startsWith("--") && w !== "--api-key");
    return { kind: "login", provider: positionals.length === 1 && !unknownFlag ? positionals[0]! : "", apiKey };
  }
  if (name === "credential") return { kind: "credential", arg };
  if (name === "model") {
    const persist = arg.endsWith(" --persist") || arg === "--persist";
    const spec = arg.replace(/\s+--persist$/, "").trim();
    return { kind: "refuse-model", ...(spec ? { spec } : {}), ...(persist ? { persist: true } : {}) };
  }
  if (name === "new") return { kind: "refuse-model" };
  return { kind: "prompt", text: trimmed };
}

export function runFromSessionState(opts: {
  sessionId: string;
  startedUtc: string;
  state: StandaloneSessionState;
}): RunSnapshot {
  const { state } = opts;
  const last = [...state.usage.calls].reverse().find((c) => c.source === "assistant_message") ?? state.usage.calls.at(-1);
  const lastCall: RunLastCall | null = last
    ? {
        tsUtc: typeof last.ts === "number" ? new Date(last.ts).toISOString() : typeof last.ts === "string" ? last.ts : new Date().toISOString(),
        agent: "worker",
        phase: last.source === "compaction" ? "compact" : null,
        provider: last.provider ?? "unknown",
        model: last.model ?? "unknown",
        contextBefore: last.contextBefore ?? null,
        contextAfter: last.contextAfter ?? null,
        toolSchemaTokens: null,
        toolCount: null,
        prefixChanged: false,
      }
    : null;
  const costUsd = state.usage.calls.reduce((s, c) => s + (c.costUsd ?? 0), 0);
  return {
    sessionId: opts.sessionId,
    brief: null,
    startedUtc: opts.startedUtc,
    heartbeatUtc: new Date().toISOString(),
    endedUtc: null,
    outcome: null,
    outcomeSource: null,
    totals: {
      costUsd,
      input: state.usage.input,
      output: state.usage.output,
      cacheRead: state.usage.cacheRead,
      cacheWrite: state.usage.cacheWrite,
      reasoning: state.usage.reasoning,
      calls: state.usage.calls.length,
    },
    lastCall,
    ...(state.currentModel !== undefined ? { currentModel: state.currentModel } : {}),
    cacheObservations: state.usage.calls
      .filter((call) => call.model !== undefined && call.ts !== undefined)
      .map((call): CacheObservation => ({
        model: `${call.provider ?? "unknown"}/${call.model}`,
        cacheRead: call.cacheRead ?? 0,
        cacheWrite: call.cacheWrite ?? 0,
        atUtc: typeof call.ts === "number" ? new Date(call.ts).toISOString() : String(call.ts),
        ...(call.provider?.toLowerCase().includes("anthropic")
          ? { ttlSeconds: call.cacheWrite1h && call.cacheWrite1h > 0 ? 3600 : 300 }
          : {}),
      })),
  };
}

/**
 * What a *live* `AgentSession` knows that no ledger row does — 2026-09-02
 * UI feedback item 6.
 *
 * Both values are read straight off Pi (`AgentSession.getContextUsage()`
 * and `.thinkingLevel`) and passed through untouched. That is deliberate
 * and is the difference between this and a derived number: `07-ui-and-hud.md`
 * §1.2 forbids the UI computing its own, and Pi already computes context
 * occupancy correctly for the model actually in use. The previous
 * behaviour — a gauge fed only by a compaction event's before/after
 * tokens — is why a standalone session showed `ctx ?` for its whole life
 * unless it happened to compact.
 */
export interface LiveSessionFacts {
  contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  thinkingLevel?: string | undefined;
  /** The model spec, for surfaces that want it before the first call has recorded one. */
  model?: string | undefined;
}

/**
 * D28: Pi's `getContextUsage().percent` is on a 0-100 scale
 * (`(tokens / contextWindow) * 100`), and every Lykos gauge takes a 0-1
 * fraction. Passing Pi's number straight through showed 11.1k of a 1M window
 * as 111%.
 */
export function piContextFraction(percent: number | null): number | null {
  return percent === null ? null : percent / 100;
}

export function deriveHud(opts: {
  ledgerPath: string;
  config: ResolvedConfig;
  sessionId: string;
  startedUtc: string;
  state: StandaloneSessionState;
  live?: LiveSessionFacts;
}): ViewModel {
  const base = collect({ ledgerPath: opts.ledgerPath, sessionId: null, config: opts.config });
  const run = runFromSessionState({ sessionId: opts.sessionId, startedUtc: opts.startedUtc, state: opts.state });
  const last = run.lastCall;
  const live = opts.live;
  // Pi's own figure wins over the priced-model lookup: it is the window of
  // the model actually running, and it is what Pi compacts against.
  const delegateContextTokens = live?.contextUsage?.contextWindow ?? (last ? contextTokens(last.provider, last.model) : undefined);
  const withLiveContext =
    live?.contextUsage && live.contextUsage.tokens !== null && run.lastCall
      ? { ...run, lastCall: { ...run.lastCall, contextAfter: live.contextUsage.tokens } }
      : run;
  const snapshot: Snapshot = {
    ...base,
    run: withLiveContext,
    ...(delegateContextTokens !== undefined ? { delegateContextTokens } : {}),
    ...(live?.thinkingLevel !== undefined ? { thinkingLevel: live.thinkingLevel } : {}),
  };
  const vm = derive(snapshot);
  // The footer names the model from boot, not from the last recorded call —
  // otherwise the badge is blank for the whole first turn.
  if (live?.model && vm.session.model === null) vm.session.model = live.model;
  return vm;
}

export interface AgentUiOptions {
  width: number;
  theme: ResolvedTheme;
  header: HeaderView;
  write?: (text: string) => void;
  ledgerPath: string;
  config: ResolvedConfig;
  startedUtc: string;
}

export interface AgentUi {
  view: ConversationView;
  streamed: boolean;
  writeUser(text: string): void;
  /** Optional: called once a turn (started by writeUser, possibly extended by steers) has fully ended — success, error, or abort alike. The fullscreen surface uses this as the safety net that stops its animated "Working..." indicator even for a turn that produced no visible content at all; the append-only renderer has no such state to clear and does not implement it. */
  endTurn?(): void;
  /**
   * `parts` is the same message with its own colours — the effort ladder
   * (2026-09-02 round three, item 7) is the only caller so far, and it
   * needs `max` to be a different colour from `low` for the message to say
   * anything the plain string does not. Surfaces that cannot paint runs
   * (the append-only renderer, a non-TTY) ignore it and print `text`, which
   * is why `text` is never optional.
   */
  writeSystem(text: string, parts?: readonly SystemPart[]): void;
  /** T124: display a queued follow-up without pretending it is a new turn. */
  writeFollowup?(text: string): void;
  writeHud(state: StandaloneSessionState, sessionId: string): ViewModel;
  renderApproval(req: ApprovalRequest): string;
  attach(session: Subscribable, getState: () => StandaloneSessionState): () => void;
  snapshotJson(): string;
}

/** Exported for reuse: the full-screen surface's AgentUi (screen/fullscreen-ui.ts) needs the identical tool-args-to-summary logic, not a second copy of it. */
export function previewResult(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

export function toolSummary(name: string, args: unknown): string {
  if (args !== null && typeof args === "object") {
    const rec = args as Record<string, unknown>;
    if (typeof rec.path === "string") return rec.path;
    if (typeof rec.command === "string") return rec.command;
    if (typeof rec.pattern === "string") return rec.pattern;
  }
  return name;
}

export function createAgentUi(opts: AgentUiOptions): AgentUi {
  const write = opts.write ?? stdoutWrite;
  const view: ConversationView = {
    blocks: [],
    hud: null,
    toolsCollapsed: true,
    // T44.3: the default flips to visible — a reasoning stream nobody sees
    // by default is not the transparency this phase requires. /thinking
    // still toggles it off for a session that wants it quiet.
    thinkingCollapsed: false,
  };
  const openTools = new Map<string, ToolBlock>();
  let streamed = false;
  let assistantOpen = false;

  const emit = (block: ConversationBlock): void => {
    view.blocks.push(block);
    const text = renderBlock(block, { width: opts.width, theme: opts.theme }, view);
    if (text) write(`${text}\n`);
  };

  emit({ kind: "header", header: opts.header });

  const ui: AgentUi = {
    view,
    get streamed() {
      return streamed;
    },
    writeUser(text: string) {
      assistantOpen = false;
      emit({ kind: "user", text });
    },
    writeSystem(text: string) {
      emit({ kind: "system", text });
    },
    writeHud(state, sessionId) {
      const vm = deriveHud({
        ledgerPath: opts.ledgerPath,
        config: opts.config,
        sessionId,
        startedUtc: opts.startedUtc,
        state,
      });
      view.hud = vm;
      const line = renderBlock({ kind: "hud" }, { width: opts.width, theme: opts.theme }, view);
      if (line) write(`${line}\n`);
      return vm;
    },
    renderApproval(req: ApprovalRequest) {
      const approval = {
        kind: req.kind,
        summary: req.summary,
        detail: req.detail,
        ...(req.pathAsk?.protected ? { protected: true } : {}),
        ...(req.kind === "bash" && req.pathAsk !== undefined ? { bashPathAsk: true } : {}),
      };
      emit({ kind: "approval", approval });
      return renderApprovalBlock(approval, opts.theme);
    },
    attach(session, getState) {
      void getState;
      return session.subscribe((ev) => {
        switch (ev.type) {
          case "message_update": {
            const ame = ev.assistantMessageEvent;
            if (!ame) break;
            if (ame.type === "text_delta" && typeof ame.delta === "string") {
              streamed = true;
              if (!assistantOpen) {
                assistantOpen = true;
                view.blocks.push({ kind: "assistant", text: ame.delta });
                write(ame.delta);
              } else {
                const last = view.blocks.at(-1);
                if (last?.kind === "assistant") last.text += ame.delta;
                write(ame.delta);
              }
            } else if (ame.type === "text_end") {
              if (assistantOpen) write("\n");
              assistantOpen = false;
            } else if (ame.type === "thinking_delta" && typeof ame.delta === "string" && !view.thinkingCollapsed) {
              emit({ kind: "thinking", text: ame.delta });
            }
            break;
          }
          case "tool_execution_start": {
            const name = ev.toolName ?? "tool";
            const diff = extractDiff(name, ev.args, undefined);
            const tool: ToolBlock = {
              name,
              summary: toolSummary(name, ev.args),
              state: "running",
              ...(diff !== undefined ? { diff } : {}),
            };
            if (ev.toolCallId) openTools.set(ev.toolCallId, tool);
            emit({ kind: "tool", tool });
            break;
          }
          case "tool_execution_end": {
            const tool =
              (ev.toolCallId ? openTools.get(ev.toolCallId) : undefined) ??
              [...openTools.values()].reverse().find((t) => t.name === ev.toolName);
            if (!tool) break;
            tool.state = ev.isError ? "error" : "ok";
            const diff = extractDiff(tool.name, ev.args, ev.result);
            if (diff) tool.diff = diff;
            const preview = previewResult(ev.result);
            if (preview) tool.resultPreview = preview;
            if (ev.toolCallId) openTools.delete(ev.toolCallId);
            emit({ kind: "tool", tool });
            break;
          }
          case "compaction_start":
            emit({ kind: "system", text: "compacting…" });
            break;
          case "compaction_end":
            emit({ kind: "system", text: "compacted" });
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
  return ui;
}

export { S0_HELP };
