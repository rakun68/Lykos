// Interactive: turns, steering, the approval gate, abort. D3.1's second half:
// this changes the UX and not the execution path — the loop from T33/`boot()`
// becomes a conversation.
//
// T34.1 multi-turn: read a line, run a turn, print the result, read the
// next line. The session outlives the turn. The head is assembled once at
// boot and never again (T17.2/T17.3 do not suspend because the session is
// now interactive) — `boot()` is called exactly once, at
// the top of `runInteractiveStandaloneSession()`, and nothing in this file
// touches it again. T18's drift detector (`HeadContract.observe()`) is
// armed from the first call, the same as the one-shot path.
//
// T34.2 approval gate: every session booted here goes through the same
// `boot()` T33/T34 share, so `gate/approval.ts`'s gated
// write/edit/bash tools apply identically — nothing new to wire here.
//
// T34.3 steering and abort: `runInteractiveLoop()` races
// `session.waitForIdle()` against the next input line while a turn is
// running — a line that arrives before idle is a `steer()`, not a new
// prompt. A SIGINT during a running turn calls `session.abort()` and stays
// in the loop; a SIGINT while idle ends the session (`runState: "aborted"`,
// which `ingestDelegateSnapshot()` already maps to `outcome: "abandoned"`).
// `human_interventions` counts `steer()` calls only, per T34.3's own text —
// an abort is not counted as an intervention on top of ending the turn it
// already ended.
//
// The old specialist freeze, now superseded: `/specialist` used to
// be refused outright — there was no working multi-specialist system yet
// (Phase 8). It is not refused any more. Specialists have real discovery,
// resolution and a default ponytail head, and mid-session switching is this
// file's own half of it: `/specialist` bare lists what is
// discoverable, `/specialist <name>` switches — it rebuilds the resident tool
// surface via `AgentSession.setActiveToolsByName()` (a REAL prefix break
// under the head contract's own definition: `tools` is a `HEAD_FIELD_ORDER`
// member, `session/head-contract.ts`) and, where the surface allows it,
// applies the new model and thinking level too. Frozen `instructions` text
// stays frozen — Pi's `AgentSession` has no public setter for it
// (`_systemPromptOverride` is private, set once at construction), and T17.3's
// `HeadContract.rebase()` refusal is not a gap this ticket works around; the
// switch report says so rather than silently no-opping.
//
// The orchestration (`runInteractiveLoop`) is deliberately decoupled from
// session construction: it takes an `InteractiveSession` — the small
// structural subset of `AgentSession` it actually calls — so
// `interactive.test.ts` can drive the real state machine against a fake
// session with exact, scripted timing, with no network call and no real
// terminal.

import { startContainment, type Containment } from "../containment/containment.js";
import { collectPathRules } from "../gate/path-rules.js";
import { isWorkspaceTrusted } from "../gate/trust.js";
import { resolveContainmentRequest } from "../containment/request.js";
import type { ContainerRuntimeDriver } from "../containment/runtime.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  DEFAULT_INTERACTION_MODE,
  INTERACTION_MODES,
  MODE_INFO,
  isInteractionMode,
  parseInteractionMode,
  modeSwitchNotice,
  type InteractionMode,
} from "../gate/modes.js";
import { loadPermissions, rememberAllow, rememberMode, type PermissionsOptions } from "../gate/permissions.js";
import { runPermissionsCommand } from "../gate/permissions-command.js";
import { setSkillCommands, skillPrompt } from "../tui/commands.js";
import { nestSessions, type SessionListRow } from "./listing.js";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import type { ResolvedConfig } from "../config/types.js";
import { loadConfig } from "../config/load.js";
import { resolveGatePolicy, renderGateOutcome, renderGateStart, runSessionGate, type GateOutcome } from "../gate/verify-gate.js";

/** T131: the three answers the exit-plan prompt offers. Named constants because the tool's caller has to compare against the exact strings `parseAskAnswer` returns. */
export const PLAN_CONTINUE_AUTO = "yes — continue in Auto";
export const PLAN_CONTINUE_MANUAL = "yes — continue in Manual, approving each step";
export const PLAN_STAY = "no — keep planning";
import { transcriptDir } from "./transcript.js";
import { builtinProviderDecls, cacheModelsPath, generateProviderConfig, specialistModelSpec, resolveBootModel } from "../config/providers.js";
import { assertHostProviderUsable, assertSpecialistProviderUsable } from "../config/specialist-credentials.js";
import { DEFAULT_SPECIALIST } from "../config/specialists.js";

import { defaultLedgerPath, openLedger, openLedgerSync, type Ledger } from "../ledger/use.js";

// 2026-09-07 (UI feedback item 2): auto-naming reuses the browser's own
// derivation rather than growing a second one. Two rules that disagree about
// what a session is called is exactly the failure `session/preview.ts`'s
// header warns about, and this is a pure string function — no IO, nothing
// the hot-path scan cares about.
import { deriveSessionName } from "./preview.js";
import { gitStatus, resolveProject } from "./identity.js";
import { deleteSessionConversation } from "./mutations.js";
import { ingestDelegateSnapshot, parseProviderModel, type DelegateSnapshot } from "../ledger/ingest.js";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createLykosModelRuntime, forwardRotationsToSink, RotationRelay, type Provider } from "./model-runtime.js";
import {
  bindExtensionChildSessions,
  boot as bootSession,
  buildStandaloneSnapshot,
  endExtensionSession,
  checkStandaloneBudget,
  resolveApprovalGate,
  resolveHostModel,
  sessionEditedFiles,
  sessionEditedPaths,
  startLiveCapture,
  subscribeStandaloneUsage,
  type BootedStandaloneSession,
  type StandaloneSessionState,
} from "./session.js";
import {
  hasOpenItems,
  parseAskAnswer,
  readTaskListFile,
  renderAskPrompt,
  resumeTaskListState,
  TerminalAsk,
  type AskHuman,
} from "../tools.js";
import { PostureGate, TerminalApprovalGate, type ApprovalGate, type ReadOnlyPosture } from "../gate/approval.js";
import { ApprovalMetrics } from "../gate/approval-metrics.js";
import { setStderrSink, stdoutWrite, stderrWrite } from "../tui/io-mode.js";
import { extensionFailureNotice } from "../extensions/api.js";
import { hookFailureNotice } from "../loop/hooks.js";
import type { LiveTranscriptRecorder, TranscriptRecorder } from "./live-capture.js";
import { EFFORT_LEVELS, parseInteractiveInput, S0_HELP, type AgentUi, type SystemPart } from "../tui/s0.js";
import { runInteractiveSurface } from "../tui/interactive-surface.js";
import { effortToken } from "../tui/effort.js";
import { fmtUsd } from "../tui/format.js";
import { openUrl } from "../tui/open-url.js";
import { parseOutcomeAnswer, renderOutcomePrompt, renderOutcomeResult } from "../tui/outcome.js";
import { parseCompactArgs } from "../loop/compaction-chain.js";
import type { CompactionRecord } from "../loop/self-compact.js";
import { buildContinuationPrompt, decideContinuation, type ContinuationPlan } from "../loop/continuation.js";
import { listCheckpoints } from "../loop/checkpoint.js";
import { sessionChangedPaths } from "../loop/diff-summary.js";

/** The subset of `AgentSession` this loop actually calls — the real class satisfies this structurally. */
export interface InteractiveSession {
  readonly sessionId: string;
  readonly systemPrompt: string;
  /** Synchronous truth, not a promise chain's accumulated flag — the loop's inner steering race checks this directly so a coincidental tie (idle and a new line arriving on the same microtask) can never leave a completed turn misread as still running. */
  readonly isIdle: boolean;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  getActiveToolNames(): string[];
  dispose(): void;
  subscribe?(listener: (ev: unknown) => void): () => void;
  /** T57: append to the context without starting a turn — how a replayed conversation gets in. */
  sendCustomMessage?(
    message: { customType: string; content: string; display: boolean },
    options?: { triggerTurn?: boolean },
  ): Promise<void>;
  followUp?(text: string): Promise<void>;
  compact?(instructions?: string): Promise<unknown>;
  executeBash?(
    command: string,
    onChunk?: (chunk: string) => void,
    options?: { excludeFromContext?: boolean },
  ): Promise<{ output: string; exitCode: number | undefined }>;
  getLastAssistantText?(): string | undefined;
  /** T-2026-09-02 item 6: Pi's reasoning-effort control. Absent on the fake session `interactive.test.ts` drives, which is why every caller is optional-chained. */
  readonly thinkingLevel?: string;
  setThinkingLevel?(level: string, options?: { persist?: boolean }): void;
  getAvailableThinkingLevels?(): string[];
  supportsThinking?(): boolean;
  getContextUsage?(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
}

export interface LineSource {
  /** Resolves with the next line, or null at EOF/close. */
  next(): Promise<string | null>;
  /**
   * P14.6 ticket 06: the next line as a secret — shown masked while typed and
   * kept out of input history. Absent on a source that cannot mask (readline
   * in cooked mode), where `/login` says so before it asks.
   */
  nextSecret?(): Promise<string | null>;
  /** Wakes any pending `next()` with null — used by the idle-Ctrl-C handler. */
  close(): void;
}

/**
 * Real stdin, one shared `readline.Interface` for both the main prompt and
 * approval prompts (T34.2's `TerminalApprovalGate` reads from the SAME
 * source) — two independent `readline` interfaces on one stdin fight each
 * other for lines.
 */
export function createReadlineLineSource(input: NodeJS.ReadableStream = process.stdin): LineSource {
  const rl = createInterface({ input, terminal: false });
  const pending: Array<(v: string | null) => void> = [];
  const buffered: string[] = [];
  let closed = false;
  rl.on("line", (line) => {
    const resolve = pending.shift();
    if (resolve) resolve(line);
    else buffered.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (pending.length > 0) pending.shift()!(null);
  });
  return {
    next: () =>
      new Promise((resolve) => {
        if (buffered.length > 0) {
          resolve(buffered.shift()!);
          return;
        }
        if (closed) {
          resolve(null);
          return;
        }
        pending.push(resolve);
      }),
    close: () => {
      if (closed) return;
      closed = true;
      while (pending.length > 0) pending.shift()!(null);
      rl.close();
    },
  };
}

/**
 * How long a first Ctrl-C stays armed. 2026-09-02 round seven, item 2:
 * "Ctrl + C now do not exit the session instantly, you have to do it 2
 * times... twice in a row in less than 3 seconds apart."
 */
export const CTRL_C_EXIT_WINDOW_MS = 3000;

/**
 * The two-press rule for the one gesture that cannot be undone. A single
 * Ctrl-C at an idle prompt used to end the session outright, which is a
 * lot of consequence for a key people also press to clear a line, to stop
 * something, or purely by reflex: "sometimes I just press Ctrl C and it
 * exit instantly, stop it."
 *
 * Deliberately its own object rather than two variables inline: it is the
 * only piece of `runInteractiveLoop`'s interrupt handling with a clock in
 * it, and a clock is the one thing a test cannot drive without an
 * injection point.
 */
export class DoublePressExit {
  private armedAt: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  /** True when this press is the SECOND one inside the window - i.e. the caller should actually exit. */
  press(): boolean {
    const at = this.now();
    if (this.armedAt !== null && at - this.armedAt <= CTRL_C_EXIT_WINDOW_MS) {
      this.armedAt = null;
      return true;
    }
    this.armedAt = at;
    return false;
  }

  /** Disarm - anything that handled a Ctrl-C as something OTHER than "exit" must not leave the next one primed to end the session. */
  reset(): void {
    this.armedAt = null;
  }

  get isArmed(): boolean {
    return this.armedAt !== null;
  }
}

/** Handed to `opts.onReady` before the loop starts consuming input — the CLI wires real SIGINT to it; tests call it directly at a scripted moment. */
export interface InteractiveHandle {
  interrupt: () => void;
}

export interface InteractiveLoopResult {
  runState: "done" | "aborted" | "error";
  sawError?: string;
  /**
   * T58: `/resume` was typed. The loop ENDS and says so rather than
   * swapping this session's context for another one's — a resume is a new
   * session (T57's rule 1), and a command that quietly replaced the
   * conversation you were in would be a fork, which this phase deliberately
   * does not build.
   */
  resumeRequested?: boolean;
  /**
   * T114: the browser was used to pick WHICH session, so the caller does not
   * have to ask again. `resumeRequested` without this is `/resume`'s older
   * shape — end, then show the picker — and both still mean "a resume is a
   * new session", which is T57's rule and is not relaxed by having chosen
   * the row earlier.
   */
  resumeSessionId?: string;
  /** T130: explicit browser action, not the refused `/new` command. */
  newRequested?: boolean;
  /** T129: close the current session after flushing its transcript. */
  closeRequested?: boolean;
  /**
   * 2026-09-07 (UI feedback item 2): what this session should be CALLED.
   *
   * Two sources, and the precedence is the same one `lykos task name` set:
   * a name a person typed with `/rename` outranks one derived from the
   * first thing they said. `nameIsHuman` is what tells the caller which of
   * the two it is holding, because a derived name may be recomputed later
   * and a human one may never be overwritten.
   */
  sessionName?: string;
  nameIsHuman?: boolean;
  /** T109: first human instruction, preserved verbatim for a successor. */
  originalPrompt?: string;
}

export interface RunInteractiveLoopOpts {
  session: InteractiveSession;
  lineSource: LineSource;
  state: StandaloneSessionState;
  ledgerPath: string;
  config: ResolvedConfig;
  modelSpec: string;
  /** T120: session-only model mutations supplied by the boot owner. */
  setModel?: (spec: string, persist: boolean) => Promise<string>;
  /**
   * Ticket 04: `/specialist` with no argument. Synchronous and free — the same
   * "these two commands must be local and cost nothing" rule `contextInfo`
   * above already follows, because it is nothing more than a filesystem
   * read (`discoverSpecialists`) formatted with the currently active name.
   */
  listSpecialists?: () => string;
  /**
   * Ticket 04: `/specialist <name>`. Resolves the specialist, applies whatever is
   * live-mutable on the real session (model, tool surface, thinking level,
   * and — on the surface that has one — interaction mode), records the
   * switch, and reports what changed. `ok: false` means the name did not
   * resolve (or its file was invalid) and the running session is untouched.
   */
  switchSpecialist?: (name: string) => Promise<{ ok: true; report: string } | { ok: false; message: string }>;
  /** T215: Drains a pending specialist-switch notice or initial specialist stream notice. */
  takeSpecialistNotice?: () => string | undefined;
  /** T217: `/output-style` with no argument. Lists available output styles. */
  listOutputStyles?: () => string;
  /** T217: `/output-style <name>`. Switches output style mid-session via stream notice. */
  switchOutputStyle?: (name: string) => Promise<{ ok: true; report: string } | { ok: false; message: string }> | { ok: true; report: string } | { ok: false; message: string };
  /** T217: Drains a pending output-style-switch notice and style text to prepend to next turn. */
  takeOutputStyleNotice?: () => string | undefined;
  /**
   * T131: the interaction mode, owned by whichever surface is driving. Both
   * the append-only and full-screen paths share this loop, and only one of
   * them has an approval modal to hold the mode in — so the loop asks rather
   * than reaching for a gate that may not exist.
   */
  currentMode?: () => InteractionMode;
  setMode?: (mode: InteractionMode) => void;
  /** T209 / ADR-0041: project id for permissions queries and adjustments. */
  projectId?: string;
  /** T209: options passed to the permissions store (e.g. custom permissionsPath for tests). */
  permissionsOpts?: PermissionsOptions | undefined;
  /** T209: hook called after a successful permissions change (e.g. reload allowlist). */
  onPermissionsChange?: () => void;
  /** T212: whether commands run in a container (enforced) or on host (best effort). */
  contained?: boolean | (() => boolean) | undefined;
  /** Drains a pending mode-switch notice, which is prepended to the next prompt so the model learns the new rule without a head rewrite. */
  takeModeNotice?: () => string | undefined;
  cycleModel?: () => Promise<string | undefined>;
  currentModel?: () => string;
  onReady?: (handle: InteractiveHandle) => void;
  /** Where the agent's own replies print. Default `stdoutWrite` (T32: standalone owns stdout). Chrome (prompts, refusals) always goes to stderr, matching the rest of the codebase. */
  writeReply?: (text: string) => void;
  /** T37: S0 conversation surface. When set, streaming, tools, diffs, the HUD line, and slash commands all go through it. */
  ui?: AgentUi;
  /**
   * Boot-time facts `/context` reports that the loop cannot reach on its
   * own — they live on `BootedStandaloneSession`, which is constructed one
   * layer up. Omitted (tests, any caller that has no booted session) leaves
   * `/context` reporting only what the live session knows.
   */
  contextInfo?: () => SessionContextFacts;
  /**
   * T191: the compactions `lykos-self-compact` has recorded so far, oldest first. `/compact <method>` reads
   * what its own run recorded to say how it went: a shake cancels Pi's compaction by design (Pi has no
   * "compacted in place"), so Pi's error is no report, and the extension cannot reach the person from
   * inside Pi. Omitted (tests, a strategy without the extension) and the command says only Pi's error.
   */
  compactionRecords?: () => ReadonlyArray<CompactionRecord>;
  /**
   * `/verbose`: the full-screen surface re-renders every folded block
   * (long diffs, long command output, a long approval body) at the new
   * setting. T51 tracked `toolsCollapsed` and changed no rendering with it;
   * this is the wire that finally makes the toggle do something
   * (2026-09-02 round three, item 12).
   */
  onExpandedChange?: (expanded: boolean) => void;
  /**
   * The reasoning effort changed through `/effort` (round thirteen, item
   * 4). The full-screen wiring repaints the composer, whose border rules
   * carry the level as a brightness. The footer half of the same fix does
   * not need a hook — `writeHud()` is on the `AgentUi` interface both
   * surfaces already share, so the loop calls it directly.
   */
  onEffortChange?: (level: string | null) => void;
  /**
   * `/copy`, and anything else that wants text on the system clipboard
   * (round thirteen, item 3). Omitted means no clipboard is reachable, and
   * `/copy` falls back to printing the text — which is all it ever did
   * before this round.
   */
  onCopyText?: (text: string, label: string) => void;
  /**
   * 2026-09-07 (UI feedback item 2): a name the user just chose, so the
   * surface that draws the session can show it immediately instead of
   * waiting for ingest to write `sessions.brief` at the end of the run.
   */
  onRename?: (name: string) => void;
  /** T109: a disk-backed successor should start immediately after the threshold abort. */
  initialPrompt?: string;
  continuationRequested?: () => boolean;
  /**
   * T53 (docs/19-phase4-tasks.md): where the human side of the conversation
   * is written down. The loop is the only place that knows a line was a
   * top-level prompt rather than a steer, and that distinction is not
   * recoverable afterwards from anything else — so it is recorded here, at
   * the moment it happens, or not at all.
   *
   * Optional because the loop is unit-tested against a scripted session with
   * no session directory to write into.
   */
  recorder?: TranscriptRecorder;
  /**
   * P10.9 (ticket 21, D5): run a slash command a Lykos extension registered.
   *
   * A callback rather than the host itself, for the reason every other entry
   * here is one: the loop is unit-tested against a scripted session and must
   * not need an extension host to exist. `tui/commands.ts` decides what
   * `/foo` IS; this decides what running it does, which is the half that
   * belongs to whoever owns the session.
   */
  runExtensionCommand?: (name: string, args: string) => Promise<string>;
  /**
   * P14.6 ticket 06: `/login <provider> [--api-key]`. The surface runs the
   * same flow `lykos login` runs (`credentials/login-flow.ts`); the loop hands
   * it the session's own line source to answer prompts from, and its system
   * channel to print on.
   */
  login?: (provider: string, apiKey: boolean, io: TuiLoginIO) => Promise<void>;
  /** P14.6 ticket 06: `/credential [label|auto]`. Returns the lines to print. */
  credential?: (arg: string) => string;
}

/** What the loop gives `/login`: a prompt-and-read, and a line printer. */
export interface TuiLoginIO {
  /** Print one line on the session's system channel. */
  write: (line: string) => void;
  /** Read the next typed line; `secret` masks it where the surface can. Null at end of input. */
  read: (secret: boolean) => Promise<string | null>;
  /** Whether `read(true)` actually masks on this surface. */
  masks: boolean;
}

/**
 * What `/context` needs from the session's boot, in the shape the report
 * prints it. Every field is something Lykos already holds — the command
 * opens no file, calls no model and touches no ledger, which is the
 * maintainer's own condition for it ("these two command must be local and
 * cost nothing").
 */
export interface SessionContextFacts {
  systemPromptChars: number;
  contextFiles: Array<{ name: string; bytes: number }>;
  skills: string[];
  toolNames: string[];
}

/** T34.1/T34.3/T34.4's orchestration, decoupled from session construction — see this file's module doc. */
export async function runInteractiveLoop(opts: RunInteractiveLoopOpts): Promise<InteractiveLoopResult> {
  const { session, lineSource, state, ledgerPath, config } = opts;
  const writeReply = opts.writeReply ?? stdoutWrite;
  const ui = opts.ui;
  const chrome = (text: string, parts?: readonly SystemPart[]) => {
    if (ui) ui.writeSystem(text, parts);
    else stderrWrite(text.endsWith("\n") ? text : `${text}\n`);
  };

  let turnRunning = false;
  let endRequested = false;
  let resumeRequested = false;
  /** T114: set when the session browser chose the row, so the caller does not ask again. */
  let resumeSessionId: string | undefined;
  let newRequested = false;
  let closeRequested = false;
  /**
   * T2 (2026-09-07, UI feedback item 2) — auto-naming, computed once from
   * the first thing the user actually said and never from a model call.
   * `session/preview.ts` already derives a display name this way for the
   * browser; doing it here as well is what makes the name DURABLE — it
   * lands in `sessions.brief` at ingest, so `lykos sessions`, `lykos cost
   * --by task` and every other surface see the same name the browser does.
   */
  let derivedName: string | undefined;
  let humanName: string | undefined;
  let modelSpec = opts.modelSpec;
  let runState: "done" | "aborted" | "error" = "done";
  let sawError: string | undefined;
  // T34.3 (found live, docs/15-phase3-tasks.md's own acceptance discipline
  // — "run a real task, then query the row" applies to output too): an
  // aborted turn can leave `state.lastText` exactly as the PREVIOUS turn's
  // reply, because no new text ever arrived. Without tracking what was
  // already printed, the loop re-prints the prior turn's answer as if it
  // were this turn's — observed on a real DeepSeek call.
  let lastPrintedText = "";
  let pending = "";
  let originalPrompt: string | undefined;

  const exitArm = new DoublePressExit();
  const handle: InteractiveHandle = {
    interrupt: () => {
      if (turnRunning) {
        // A runaway turn is still stopped by ONE press: the double-press
        // rule below is about ending the SESSION, which is the
        // irreversible half, and making an abort cost two presses would
        // slow down the one thing Ctrl-C is most urgently for.
        exitArm.reset();
        opts.recorder?.intervention("abort_turn");
        void session.abort();
        stderrWrite(
          "\nlykos: aborted the current turn (session still open) — press Ctrl-C twice at the prompt to end the session\n",
        );
      } else if (exitArm.press()) {
        endRequested = true;
        lineSource.close();
      } else {
        stderrWrite(`
lykos: press Ctrl-C again within ${Math.round(CTRL_C_EXIT_WINDOW_MS / 1000)}s to end the session
`);
      }
    },
  };
  opts.onReady?.(handle);

  // One pending read at a time, reused across both the top-level "read the
  // next prompt" wait and the inner steering race — `lineSource.next()` is
  // called again only once a line has actually been consumed. Calling it
  // fresh on every race iteration (the first cut of this loop did) leaves
  // an earlier still-pending read orphaned every time `waitForIdle` wins
  // the race instead, and a later real line then resolves that ORPHAN
  // rather than the read the loop is actually about to await — the input
  // silently vanishes and the loop hangs. `pendingRead` is what prevents a
  // second concurrent registration from ever existing.
  let pendingRead: Promise<string | null> | undefined;
  let initialPrompt = opts.initialPrompt;
  function nextLine(): Promise<string | null> {
    if (!pendingRead) pendingRead = lineSource.next();
    return pendingRead;
  }
  function consumeLine(): void {
    pendingRead = undefined;
  }

  function sessionInfo(): string {
    const g = state.usage;
    // Same costUsd source deriveHud() sums for the footer's running total
    // (tui/s0.ts's runFromSessionState) — /session is not a second cost path.
    const costUsd = g.calls.reduce((s, c) => s + (c.costUsd ?? 0), 0);
    return `session ${session.sessionId}\nmodel  ${modelSpec}\nturns  ${state.turns}  interventions ${state.humanInterventions}\ntokens ↑ ${g.input}  ⚡ ${g.cacheRead}  ✎ ${g.cacheWrite}  ↓ ${g.output}\ncost   ${fmtUsd(costUsd)}`;
  }

  /**
   * `/effort [level]` — 2026-09-02 item 6.
   *
   * Unlike `/model` and `/specialist`, this is NOT refused, and the difference
   * is worth being explicit about: reasoning effort is a per-request
   * parameter, not part of the system prompt, so changing it does not
   * rewrite the frozen head and cannot cold-start the cache prefix. T18's
   * drift detector is armed on every call and would say so if that were
   * ever wrong on some provider — which is the check, rather than a promise.
   *
   * With no argument it reports the current level and what this model
   * supports rather than cycling: a command whose only feedback is a
   * changed number in the corner should not change anything by accident.
   */
  function effortReport(lead: string, current: string | null, available: readonly string[]): { text: string; parts: SystemPart[] } {
    const parts: SystemPart[] = [{ text: lead, token: "dim" }];
    if (current) parts.push({ text: current, token: effortToken(current) });
    parts.push({ text: " — available: ", token: "dim" });
    available.forEach((lvl, i) => {
      if (i > 0) parts.push({ text: ", ", token: "faint" });
      parts.push({ text: lvl, token: effortToken(lvl) });
    });
    return { text: parts.map((p) => p.text).join(""), parts };
  }

  function setEffort(level: string): { text: string; parts?: SystemPart[] } {
    if (!session.setThinkingLevel || session.supportsThinking?.() === false) {
      return { text: "lykos: this model has no reasoning-effort control" };
    }
    const available = session.getAvailableThinkingLevels?.() ?? [...EFFORT_LEVELS];
    if (level.length === 0) {
      return effortReport("current effort is ", session.thinkingLevel ?? null, available);
    }
    if (!available.includes(level)) {
      return effortReport(`lykos: unknown effort "${level}"`, null, available);
    }
    session.setThinkingLevel(level);
    // Read back rather than echo: Pi clamps to what the model actually
    // supports, and reporting the requested level when it was clamped is
    // the kind of small lie the footer would then repeat all session.
    const now = session.thinkingLevel ?? level;
    return {
      text: `effort is set to ${now}`,
      parts: [
        { text: "effort is set to ", token: "dim" },
        { text: now, token: effortToken(now) },
      ],
    };
  }

  /**
   * `/usage` — 2026-09-02 round three, item 8. Every number here is summed
   * from `state.usage`, the in-process accumulator the footer already
   * draws from, so this is a second VIEW of the run's accounting and never
   * a second accounting path (07-ui-and-hud.md §1.1). It opens nothing and
   * costs nothing.
   *
   * Cache read and cache write stay separate lines, never a combined
   * "input" — the one number that would destroy both is the trap this
   * project's own orientation names first.
   */
  function usageReport(): string {
    const u = state.usage;
    const costUsd = u.calls.reduce((sum, c) => sum + (c.costUsd ?? 0), 0);
    const billedIn = u.input + u.cacheRead + u.cacheWrite;
    const hit = billedIn > 0 ? u.cacheRead / billedIn : 0;
    const byModel = new Map<string, { calls: number; costUsd: number }>();
    for (const call of u.calls) {
      const key = `${call.provider ?? "unknown"}/${call.model ?? "unknown"}`;
      const row = byModel.get(key) ?? { calls: 0, costUsd: 0 };
      row.calls += 1;
      row.costUsd += call.costUsd ?? 0;
      byModel.set(key, row);
    }
    const lines = [
      `usage — ${state.turns} turn${state.turns === 1 ? "" : "s"}, ${u.calls.length} call${u.calls.length === 1 ? "" : "s"}`,
      `  fresh input   ${u.input}`,
      `  cache read    ${u.cacheRead}   (${Math.round(hit * 100)}% of billed input)`,
      `  cache write   ${u.cacheWrite}`,
      `  output        ${u.output}`,
      `  reasoning     ${u.reasoning}`,
      `  spent         ${fmtUsd(costUsd)}`,
    ];
    for (const [key, row] of byModel) lines.push(`  ${key}  ${row.calls} call${row.calls === 1 ? "" : "s"}  ${fmtUsd(row.costUsd)}`);
    if (u.calls.length === 0) lines.push("  (no calls yet — nothing has been sent to the model)");
    return lines.join("\n");
  }

  /**
   * `/context` — the other half of item 8: "how much context is used and
   * how much used by each thing (memory, skill, messages, ...)".
   *
   * Two honesty rules run this. Pi's `getContextUsage()` is the only
   * measured number — it is what Pi compacts against, and it is reported
   * rather than derived. Everything underneath it is a byte-count estimate
   * at 4 bytes per token, and every such line says `~` so nobody reads it
   * as a measurement; the tool schemas are the one component Lykos genuinely
   * cannot size (Pi builds them and never exposes the serialised form), and
   * that line says so instead of guessing a number.
   */
  function contextReport(): string {
    const est = (bytes: number) => `~${Math.ceil(bytes / 4)}`;
    const usage = session.getContextUsage?.();
    const facts = opts.contextInfo?.();
    const lines: string[] = [];
    if (usage) {
      const pct = usage.percent !== null ? ` (${Math.round(usage.percent)}%)` : ""; // D28: Pi's percent is already 0-100
      lines.push(`context ${usage.tokens ?? "?"} / ${usage.contextWindow}${pct}  — measured by Pi`);
    } else {
      lines.push("context — this session exposes no usage figure");
    }
    if (!facts) {
      lines.push("  (no boot facts available on this surface)");
      return lines.join("\n");
    }
    lines.push(`  system prompt   ${est(facts.systemPromptChars)} tokens   frozen at boot (T17.2)`);
    for (const file of facts.contextFiles) lines.push(`    ${file.name}      ${est(file.bytes)} tokens`);
    if (facts.contextFiles.length === 0) lines.push("    (no context files ingested)");
    lines.push(`  skills          ${facts.skills.length === 0 ? "(none)" : facts.skills.join(", ")}`);
    lines.push(`  tools           ${facts.toolNames.length} registered — schema size not measurable from here`);
    if (usage?.tokens !== null && usage?.tokens !== undefined) {
      const rest = usage.tokens - Math.ceil(facts.systemPromptChars / 4);
      lines.push(`  conversation    ~${Math.max(0, rest)} tokens   (measured total minus the estimate above)`);
    }
    return lines.join("\n");
  }

  async function runBash(command: string, sendToModel: boolean): Promise<string | undefined> {
    if (!session.executeBash) {
      chrome("lykos: !cmd needs executeBash on the session (Pi AgentSession).");
      return undefined;
    }
    chrome(`$ ${command}`);
    const result = await session.executeBash(command, (chunk) => chrome(chunk), {
      excludeFromContext: !sendToModel,
    });
    if (result.output) chrome(result.output);
    return sendToModel ? `$ ${command}\n${result.output}` : undefined;
  }

  async function handleOwned(
    parsed: Exclude<ReturnType<typeof parseInteractiveInput>, { kind: "prompt" } | { kind: "empty" } | { kind: "continue" }>,
  ): Promise<"exit" | "ok"> {
    switch (parsed.kind) {
      case "exit":
        return "exit";
      case "help":
        chrome(S0_HELP);
        return "ok";
      case "session":
        chrome(sessionInfo());
        return "ok";
      case "resume":
        // Ends this session cleanly and hands the picker back to the
        // caller.
        //
        // 2026-09-07 (UI feedback item 1): what the caller then does is no
        // longer "start a new row that links back". A resume REOPENS the
        // session it names — same id, same transcript, same row — so the
        // wording here stopped promising a second session that will not be
        // created. This session is still finalised on the way out exactly
        // as `/exit` finalises it; that has not changed and is what makes
        // its numbers correct if it is never resumed.
        resumeRequested = true;
        if (parsed.sessionId !== undefined) {
          resumeSessionId = parsed.sessionId;
          chrome(`leaving this session and reopening ${parsed.sessionId.slice(0, 8)} — it continues as itself`);
        } else {
          chrome("leaving this session and opening the session browser");
        }
        return "exit";
      case "rename": {
        const wanted = parsed.name.trim();
        if (wanted.length === 0) {
          const current = humanName ?? derivedName;
          chrome(
            current === undefined
              ? "this session has no name yet — it gets one from the first thing you say, or type /rename <name>"
              : `this session is called "${current}" (${humanName !== undefined ? "you named it" : "derived from what you said first"})`,
          );
          return "ok";
        }
        humanName = wanted;
        opts.onRename?.(wanted);
        chrome(`this session is now called "${wanted}"`);
        return "ok";
      }
      case "new-session":
        newRequested = true;
        chrome("ending this session and starting a new session");
        return "exit";
      case "close-session":
        closeRequested = true;
        chrome("closing this session");
        return "exit";
      case "copy": {
        const text = session.getLastAssistantText?.() ?? state.lastText;
        if (!text) {
          chrome("lykos: no assistant message to copy");
          return "ok";
        }
        // Round thirteen, item 3: `/copy` now actually copies. It used to
        // PRINT the last answer back into the transcript, which on the
        // full-screen surface is the one place a reader still could not
        // select it from — the command was named for the thing it was the
        // least able to do. Where no clipboard hook is wired (the
        // append-only surface, and any caller that passes none), printing
        // it remains the only thing that can be done and still is.
        if (opts.onCopyText) opts.onCopyText(text, "last answer");
        else chrome(text);
        return "ok";
      }
      case "verbose": {
        if (ui) ui.view.toolsCollapsed = !ui.view.toolsCollapsed;
        const collapsed = ui?.view.toolsCollapsed ?? true;
        opts.onExpandedChange?.(!collapsed);
        chrome(collapsed ? "tool results collapsed" : "tool results expanded");
        return "ok";
      }
      case "thinking":
        if (ui) ui.view.thinkingCollapsed = !ui.view.thinkingCollapsed;
        chrome(ui?.view.thinkingCollapsed ? "thinking hidden" : "thinking shown");
        return "ok";
      case "compact": {
        if (!session.compact) {
          chrome("lykos: compact is not available on this session");
          return "ok";
        }
        // T191: `/compact shake <text>` is refused here, before anything runs; the extension refuses it too
        // (a surface that is not this one), but its notice reaches nobody in this session.
        const asked = parseCompactArgs(parsed.hint);
        if ("error" in asked) {
          chrome(asked.error);
          return "ok";
        }
        const seen = opts.compactionRecords?.().length ?? 0;
        let failure: Error | undefined;
        try {
          await session.compact(parsed.hint || undefined);
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error));
        }
        const made = asked.method !== undefined ? opts.compactionRecords?.().slice(seen) : undefined;
        const last = made?.[made.length - 1];
        if (last !== undefined) {
          const figures =
            last.tokens_before !== null && last.tokens_after !== null
              ? `, about ${last.tokens_before} to ${last.tokens_after} tokens (an estimate)`
              : "";
          chrome(
            last.result === "ok"
              ? `compacted by ${last.method ?? asked.method}${figures}`
              : `lykos: /compact ${asked.method} did not compact (${last.result}${last.error !== undefined ? `: ${last.error}` : ""})`,
          );
        } else if (failure !== undefined) {
          chrome(`lykos: compact: ${failure.message}`);
        }
        return "ok";
      }
      case "effort": {
        const report = setEffort(parsed.level);
        chrome(report.text, report.parts);
        // 2026-09-02 round thirteen, item 4: "after I type the command
        // effort <level> and it switches effort, the bar should change
        // colour instantly... furthermore, no matter what effort i change,
        // the effort showing at the bottom right corner does not change."
        //
        // Both halves were the same omission — nothing redrew anything
        // that reads the effort. The composer's border rules take their
        // brightness from `session.thinkingLevel` at PAINT time, and the
        // only thing that painted the composer was a keystroke; the
        // footer's model/effort badge comes from the view model, which
        // only `writeHud()` builds, and until this round nothing called
        // that outside a finished turn or boot. So the level changed
        // immediately and every surface showing it kept the old value
        // until something unrelated happened to repaint.
        if (ui) ui.writeHud(state, session.sessionId);
        opts.onEffortChange?.(session.thinkingLevel ?? null);
        return "ok";
      }
      case "usage":
        chrome(usageReport());
        return "ok";
      case "context":
        chrome(contextReport());
        return "ok";
      case "specialist-list":
        if (!opts.listSpecialists) {
          chrome("lykos: specialist listing is not available on this session");
          return "ok";
        }
        chrome(opts.listSpecialists());
        return "ok";
      case "specialist-switch": {
        if (!opts.switchSpecialist) {
          chrome("lykos: specialist switching is not available on this session");
          return "ok";
        }
        if (!session.isIdle) {
          chrome("lykos: specialist cannot change while a turn is in flight");
          return "ok";
        }
        const outcome = await opts.switchSpecialist(parsed.name);
        chrome(outcome.ok ? outcome.report : `lykos: specialist switch refused — ${outcome.message}`);
        return "ok";
      }
      case "output-style-list":
        if (!opts.listOutputStyles) {
          chrome("lykos: output style listing is not available on this session");
          return "ok";
        }
        chrome(opts.listOutputStyles());
        return "ok";
      case "output-style-switch": {
        if (!opts.switchOutputStyle) {
          chrome("lykos: output style switching is not available on this session");
          return "ok";
        }
        if (!session.isIdle) {
          chrome("lykos: output style cannot change while a turn is in flight");
          return "ok";
        }
        const outcome = await opts.switchOutputStyle(parsed.name);
        chrome(outcome.ok ? outcome.report : `lykos: output style switch refused — ${outcome.message}`);
        return "ok";
      }
      case "refuse-model":
        if (!opts.setModel) {
          chrome("lykos: model switching is not available on this session");
          return "ok";
        }
        if (!session.isIdle) {
          chrome("lykos: model cannot change while a turn is in flight");
          return "ok";
        }
        if (parsed.kind !== "refuse-model") return "ok";
        if (parsed.spec) {
          try {
            modelSpec = await opts.setModel(parsed.spec, parsed.persist === true);
            chrome(`model is now ${modelSpec}`);
          } catch (err) {
            chrome(`lykos: model switch refused — ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          chrome(`current model is ${opts.currentModel?.() ?? modelSpec}; use /model <provider/model> to switch`);
        }
        return "ok";
      case "mode": {
        if (parsed.mode.length === 0) {
          const current = opts.currentMode?.() ?? DEFAULT_INTERACTION_MODE;
          chrome(`interaction mode is ${MODE_INFO[current].label} — ${MODE_INFO[current].description}`);
          chrome(`  switch with /mode <${INTERACTION_MODES.join("|")}>`);
          return "ok";
        }
        const parsedMode = parseInteractionMode(parsed.mode);
        if (!parsedMode.ok) {
          chrome(`lykos: ${parsedMode.error}`);
          return "ok";
        }
        if (!opts.setMode) {
          chrome("lykos: this session shape cannot change interaction mode");
          return "ok";
        }
        opts.setMode(parsedMode.mode);
        return "ok";
      }
      case "permissions": {
        const projectId = opts.projectId ?? resolveProject(process.cwd()).id;
        const liveMode = opts.currentMode?.();
        const contained = typeof opts.contained === "function" ? opts.contained() : (opts.contained ?? false);
        const res = runPermissionsCommand(parsed.args, {
          projectId,
          ...(opts.permissionsOpts !== undefined ? { opts: opts.permissionsOpts } : {}),
          ...(liveMode !== undefined ? { liveMode } : {}),
          contained,
        });
        chrome(res.report);
        if (res.ok) {
          if (res.mode !== undefined) {
            opts.setMode?.(res.mode);
          }
          opts.onPermissionsChange?.();
        }
        return "ok";
      }
      case "login": {
        if (!opts.login) {
          chrome("lykos: /login is not available on this session");
          return "ok";
        }
        if (parsed.provider.length === 0) {
          chrome("usage: /login <provider> [--api-key]");
          return "ok";
        }
        if (!session.isIdle) {
          chrome("lykos: /login cannot run while a turn is in flight");
          return "ok";
        }
        await opts.login(parsed.provider, parsed.apiKey, {
          write: (line) => chrome(line),
          // Top level only (refused mid-turn above), so no read is pending
          // and these answers cannot be taken for prompts.
          read: async (secret) => {
            if (secret && lineSource.nextSecret) return lineSource.nextSecret();
            const line = await nextLine();
            consumeLine();
            return line;
          },
          masks: lineSource.nextSecret !== undefined,
        });
        return "ok";
      }
      case "credential":
        if (!opts.credential) {
          chrome("lykos: /credential is not available on this session");
          return "ok";
        }
        chrome(opts.credential(parsed.arg));
        return "ok";
      case "extension-command": {
        // The host catches whatever the extension throws and returns a
        // sentence about it (D3), so there is nothing to guard here — and a
        // session with no host at all says so rather than doing nothing
        // visible, which is what a person typing a slash command would read
        // as the command being broken.
        if (!opts.runExtensionCommand) {
          chrome(`lykos: /${parsed.command} is an extension command and this session shape has no extension host`);
          return "ok";
        }
        chrome(await opts.runExtensionCommand(parsed.command, parsed.args));
        return "ok";
      }
      case "skill":
      case "followup":
      case "bash":
        return "ok";
    }
  }

  async function startTurn(rawText: string): Promise<boolean> {
    if (originalPrompt === undefined) originalPrompt = rawText;
    // T131: a mode change since the last turn rides in on the front of this
    // one. It is an ordinary conversation message, so the frozen head (T17)
    // and the cache prefix are both untouched.
    const specialistNotice = opts.takeSpecialistNotice?.();
    const modeNotice = opts.takeModeNotice?.();
    const outputStyleNotice = opts.takeOutputStyleNotice?.();
    const notices = [specialistNotice, modeNotice, outputStyleNotice].filter(Boolean).join("\n\n");
    const text = notices ? `${notices}\n\n${rawText}` : rawText;
    const verdict = checkStandaloneBudget({ prompt: text, ledgerPath, config, modelSpec });
    if (verdict.tripped) {
      chrome(`lykos: blocked — ${verdict.reason}`);
      return false;
    }
    ui?.writeUser(text);
    // T53: recorded after the budget guard, because a blocked turn is not a
    // turn — nothing was sent, and a transcript that claimed otherwise would
    // replay a prompt the model never saw.
    opts.recorder?.userMessage(text);
    turnRunning = true;
    try {
      await session.prompt(text);
      return true;
    } catch (err) {
      turnRunning = false;
      runState = "error";
      sawError = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  while (true) {
    const line = initialPrompt ?? (await nextLine());
    initialPrompt = undefined;
    if (line !== null) consumeLine();
    if (line === null) {
      runState = endRequested ? "aborted" : "done";
      break;
    }
    const physical = pending + line;
    if (line.endsWith("\\") && !line.trim().startsWith("!")) {
      pending = physical.slice(0, -1);
      continue;
    }
    pending = "";
    const parsed = parseInteractiveInput(physical);
    if (parsed.kind === "empty") continue;
    if (parsed.kind === "continue") {
      pending = parsed.prefix;
      continue;
    }
    if (parsed.kind === "exit") {
      runState = "done";
      break;
    }
    if (parsed.kind !== "prompt" && parsed.kind !== "followup" && parsed.kind !== "bash" && parsed.kind !== "skill") {
      const owned = await handleOwned(parsed);
      if (owned === "exit") {
        runState = "done";
        break;
      }
      continue;
    }

    let promptText: string | undefined;
    if (parsed.kind === "bash") {
      promptText = await runBash(parsed.command, parsed.sendToModel);
      if (promptText === undefined) continue;
    } else if (parsed.kind === "skill") {
      // T131: `/handoff` becomes an instruction to read and follow the
      // skill. Before this, the literal text `/skill:review` was posted to
      // the model as prose and nothing loaded the skill at all.
      promptText = skillPrompt(parsed.skill, parsed.args);
      chrome(`skill: ${parsed.skill}`);
    } else if (parsed.kind === "followup") {
      promptText = parsed.text;
      if (!promptText) {
        chrome("lykos: /followup needs some text");
        continue;
      }
      ui?.writeFollowup?.(promptText);
    } else {
      promptText = parsed.text;
    }

    if (derivedName === undefined && parsed.kind === "prompt" && promptText) {
      derivedName = deriveSessionName(promptText) ?? undefined;
    }

    const started = await startTurn(promptText);
    if (!started) {
      if (sawError !== undefined) break;
      continue;
    }

    // T34.3: the outer guard is `session.isIdle` itself — synchronous truth
    // checked fresh on every iteration — never a boolean fed by a promise
    // chain. A promise-chain flag can lose a genuine tie (idle settling and
    // a line arriving on the same microtask) to whichever chain happens to
    // be shallower; `isIdle` cannot, because it is re-read, not accumulated.
    try {
      while (!session.isIdle) {
        const raced = await Promise.race([
          session.waitForIdle().then(() => ({ kind: "idle" as const })),
          nextLine().then((l) => ({ kind: "line" as const, line: l })),
        ]);
        if (raced.kind === "idle") break;
        consumeLine();
        if (raced.line === null) {
          endRequested = true;
          break;
        }
        const mid = parseInteractiveInput(raced.line);
        if (mid.kind === "empty") continue;
        if (mid.kind === "exit") {
          endRequested = true;
          break;
        }
        if (mid.kind === "followup") {
          if (mid.text) ui?.writeFollowup?.(mid.text);
          const usedFollowUp = Boolean(session.followUp) && Boolean(mid.text);
          if (usedFollowUp) await session.followUp!(mid.text);
          else await session.steer(mid.text);
          opts.recorder?.steer(mid.text, usedFollowUp ? "follow_up" : "steer");
          state.humanInterventions += 1;
          continue;
        }
        if (mid.kind !== "prompt" && mid.kind !== "bash" && mid.kind !== "continue") {
          if ((await handleOwned(mid)) === "exit") {
            endRequested = true;
            break;
          }
          continue;
        }
        const steerText = mid.kind === "prompt" ? mid.text : raced.line.trim();
        if (steerText.length === 0) continue;
        // T34.3: a line arriving while the turn is running is a steer, not a
        // new prompt — but it was never shown anywhere before this, which
        // read as "I typed something and it silently vanished." ui.writeUser()
        // is the same call startTurn() makes for a fresh prompt; the flat,
        // chronological scrollback places it right where it happened, next
        // to whatever tool/thinking block the running turn produces next,
        // rather than as a disconnected new conversation entry.
        ui?.writeUser(steerText);
        await session.steer(steerText);
        opts.recorder?.steer(steerText, "steer");
        state.humanInterventions += 1;
      }
    } catch (err) {
      runState = "error";
      sawError = err instanceof Error ? err.message : String(err);
    }
    turnRunning = false;
    ui?.endTurn?.();

    if (opts.continuationRequested?.()) {
      // The idle branch of the steering race may have left one top-level
      // `next()` pending. A successor gets a fresh interactive surface, so
      // close this source to release that read before returning.
      lineSource.close();
      runState = "done";
      break;
    }
    if (endRequested) {
      await session.abort();
      runState = "aborted";
      break;
    }
    if (sawError !== undefined) break;
    if (ui) ui.writeHud(state, session.sessionId);
    if (!ui?.streamed && state.lastText && state.lastText !== lastPrintedText) {
      writeReply(`\n${state.lastText}\n`);
      lastPrintedText = state.lastText;
    }
  }

  return {
    runState,
    ...(sawError !== undefined ? { sawError } : {}),
    ...(resumeRequested ? { resumeRequested: true } : {}),
    ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
    ...(humanName !== undefined
      ? { sessionName: humanName, nameIsHuman: true }
      : derivedName !== undefined
        ? { sessionName: derivedName, nameIsHuman: false }
        : {}),
    ...(newRequested ? { newRequested: true } : {}),
    ...(closeRequested ? { closeRequested: true } : {}),
    ...(originalPrompt !== undefined ? { originalPrompt } : {}),
  };
}

/**
 * T57 (docs/19-phase4-tasks.md): everything a resumed session needs that an
 * ordinary one does not.
 *
 * Assembled by `cli/resume.ts` from T56's preflight — never recomputed here,
 * so the number the person confirmed is the number that gets sent and the
 * number the transcript records.
 */
export interface ResumePlan {
  /** The session being continued. Written to `resumed_from`; the original is never touched. */
  fromSessionId: string;
  /** The SAME task as the original. This is the clause with the metric consequence: a task resumed four times is one expensive task. */
  taskId?: string;
  projectId?: string;
  /** The exact bytes T56 priced, from the one shared `buildReplay()`. */
  replayText: string;
  replayEvents: number;
  replayUserTurns: number;
  estimateTokens: number;
  estimateUsd: number | null;
  priceVersion: string | null;
  /** Mechanism flags in force, and whether the caller overrode the original's. Recorded, not just accepted. */
  flags?: { promptDiet?: boolean; outputDiet?: boolean; overridden?: boolean };
  /**
   * T60: the original's tool surface, from T54's meta. Absent means the
   * session predates meta.json v2 and the resume boots the default surface
   * — which T56 warns about rather than passing off as inherited.
   */
  tools?: string[];
}

export interface RunInteractiveStandaloneSessionInput {
  workspace: string;
  model?: string;
  /** T209 / ADR-0041: explicit starting permission mode passed on startup (e.g. via --mode). */
  mode?: InteractionMode;
  /** T209: options passed to the permissions store (e.g. custom permissionsPath for tests). */
  permissionsOpts?: PermissionsOptions | undefined;
  tools?: string[];
  /** T39: enable the Lykos-owned Agent tool. */
  subagents?: boolean;
  ledgerPath?: string;
  label?: string;
  /** Default: a shared `readline` interface on real stdin. */
  lineSource?: LineSource;
  /** Default: `TerminalApprovalGate` sharing `lineSource`. */
  approvalGate?: ApprovalGate;
  /**
   * T162: native providers registered on this run's model runtime — tests
   * only, as for `runStandaloneTask`. The scripted-model session's faux
   * provider, so the terminal UI's end of session runs at no model cost.
   * A model whose provider is one of these skips the credential check.
   */
  /** T173: the container runtimes to consider — tests only. See `RunStandaloneTaskInput.containmentDrivers`. */
  containmentDrivers?: readonly ContainerRuntimeDriver[];
  nativeProviders?: readonly Provider[];
  /**
   * `lykos run --interactive --yes`: every gated action is allowed without a
   * prompt, as `--yes` already does for a one-shot run. It was accepted on
   * the command line and dropped here, so an interactive session asked anyway.
   */
  autoApprove?: boolean;
  onReady?: (handle: InteractiveHandle) => void;
  /**
   * T52.1: ask "did that work?" when the session ends normally.
   *
   * **Opt-in as of 2026-09-07 (UI feedback item 4).** It used to default to
   * true, so every ordinary session ended by interrogating the person who
   * had just closed it. The maintainer's objection is the correct one:
   * asking is not free — a question nobody wants is answered by whatever
   * dismisses it fastest, and `s`/skip on every session is a column full of
   * NULLs bought at the price of an irritating prompt.
   *
   * Nothing about the ledger's honesty rules changes. T100's mechanical
   * gate still runs on every editing session and still writes
   * `outcome = 'success'` from an exit code, which is the *better* writer
   * and the one CLAUDE.md named as the cheapest available; `lykos verify`
   * is still there for a human who wants to record a verdict deliberately.
   * What was removed is only the unsolicited question.
   *
   * Turn it back on per-run with `lykos run --ask-outcome`, or for a shell
   * with `LYKOS_ASK_OUTCOME=1`.
   */
  askOutcome?: boolean;
  /** T50.1: force the append-only surface even when `decideRenderMode()` would otherwise choose full-screen. */
  noFullscreen?: boolean;
  /** T57: when set, this session continues another one. */
  resume?: ResumePlan;
  /**
   * T61: `lykos run --task <id>` — join an EXISTING task rather than letting
   * ingest auto-create a rival one from this session's brief. Two attempts
   * at one piece of work are one task, or the headline metric quietly turns
   * a task that took three tries into three cheap tasks.
   */
  taskId?: string;
  projectId?: string;
  /** T117: trust source established before config/head loading. */
  trustSource?: "stored" | "flag" | "prompt";
  /** T109: internal successor-session state; absent on the root run. */
  continuation?: ContinuationPlan;
  /**
   * Ticket 04: `lykos run --interactive --specialist <name>`. Handoff 01 left
   * this dormant — `runStandaloneTask` threaded `input.specialist` through
   * `loadConfig`/`boot` from ticket 01 on, but nothing wired the same path
   * for the interactive shape. Wired here the same way: resolved into the
   * sixth config layer before boot, and into `boot()`'s `specialistName` for
   * the session record (`sessions.specialist`) — exactly `runStandaloneTask`'s
    * own two call sites, mirrored.
   */
  specialist?: string;
  /** T217: `lykos run --interactive --output-style <name>`. */
  outputStyle?: string;
}

export type RunInteractiveStandaloneSessionResult =
  | {
      status: "ok";
      sessionId: string;
      snapshot: DelegateSnapshot;
      /** T58: the session ended because `/resume` was typed. The caller opens the picker. */
      resumeRequested?: boolean;
      /** T114: ...unless the browser already chose one, in which case the caller skips straight to it. */
      resumeSessionId?: string;
      newRequested?: boolean;
      closeRequested?: boolean;
      /** T109: the context threshold requested a disk-rebuilt successor. */
      continuation?: ContinuationPlan;
    }
  | { status: "error"; message: string };

/** What both render-mode branches need after model resolution — computed once so neither branch re-derives it, and so they can never disagree about which model a session boots with. Flags and the tool surface are read inside `boot`. */
export interface StandaloneBootInputs {
  cwd: string;
  ledgerPath: string;
  config: ResolvedConfig;
  boot: ReturnType<typeof resolveBootModel>;
  modelSpec: string;
  model: Awaited<ReturnType<typeof resolveHostModel>>;
  modelRuntime: ModelRuntime;
  input: RunInteractiveStandaloneSessionInput;
  /**
   * Ticket 06: the runtime's rotation callback, late-bound. `bootInteractiveSession`
   * forwards it to the session's extension sink (`credential_rotated`); the
   * surface subscribes for its one-line notice. Absent = nothing rotates visibly.
   */
  rotations?: RotationRelay;
  /** T173: where this session's commands run; started by `runInteractiveStandaloneSession` and disposed by it. */
  containment?: Containment;
  /** T176: the id the contained session carries, which labels its container. Pinned at boot when a container is used. */
  containedSessionId?: string;
}

/**
 * A specialist with `read_only: true` is read-only by a posture enforced on the
 * gate, not by boot's read-only-child tool cut, so the session keeps `bash` and
 * `exit_plan`. A plan the human accepts lifts the posture for the rest of the session (T214, ADR-0043).
 */
export function readOnlyPosture(
  config: Pick<ResolvedConfig, "readOnly">,
  extras: { gate: ApprovalGate; requestPlanExit?: (plan: string) => Promise<InteractionMode | null> },
): {
  gate: ApprovalGate;
  isPlanning: () => boolean;
  requestPlanExit: ((plan: string) => Promise<InteractionMode | null>) | undefined;
  posture: ReadOnlyPosture;
} {
  const posture: ReadOnlyPosture = { readOnly: config.readOnly === true };
  const requestExit = extras.requestPlanExit;
  return {
    posture,
    gate: new PostureGate(extras.gate, posture),
    isPlanning: () => posture.readOnly,
    requestPlanExit:
      requestExit === undefined
        ? undefined
        : async (plan) => {
            const next = await requestExit(plan);
            if (next !== null) posture.readOnly = false;
            return next;
          },
  };
}

export async function bootInteractiveSession(
  shared: StandaloneBootInputs,
  extras: {
    gate: ApprovalGate;
    askHuman?: AskHuman;
    requestPlanExit?: (plan: string) => Promise<InteractionMode | null>;
    currentMode?: () => InteractionMode;
  },
): Promise<BootedStandaloneSession> {
  const { cwd, ledgerPath, config, modelSpec, model, modelRuntime, input } = shared;
  const posture = readOnlyPosture(config, extras);
  const booted = await bootSession({
    cwd,
    config,
    model,
    modelRuntime,
    gate: posture.gate,
    isPlanning: posture.isPlanning,
    ledgerPath,
    modelSpec,
    parentBrief: input.label ?? "(interactive)",
    neutralHead: true,
    ...(shared.containment !== undefined
      ? { executor: shared.containment.executor, containment: shared.containment.record }
      : {}),
    ...(input.tools !== undefined ? { tools: input.tools } : {}),
    ...(input.subagents !== undefined ? { subagents: input.subagents } : {}),
    ...(input.specialist !== undefined ? { specialistName: input.specialist } : {}),
    ...(input.trustSource !== undefined ? { trustSource: input.trustSource } : {}),
    ...(extras.askHuman !== undefined ? { askHuman: extras.askHuman } : {}),
    ...(posture.requestPlanExit !== undefined && extras.currentMode !== undefined
      ? { requestPlanExit: posture.requestPlanExit, currentMode: extras.currentMode }
      : {}),
    ...(input.resume?.fromSessionId !== undefined
      ? {
          resumeTaskListFrom: transcriptDir(ledgerPath, input.resume.fromSessionId),
          // T152: an unfinished self-compact handoff finishes in the resumed session.
          resumeHandoffFrom: transcriptDir(ledgerPath, input.resume.fromSessionId),
          sessionIdOverride: input.resume.fromSessionId,
        }
      : shared.containment !== undefined && shared.containment.record.used !== "off" && shared.containedSessionId !== undefined
        ? { sessionIdOverride: shared.containedSessionId }
        : {}),
    ...(input.continuation !== undefined
      ? {
          continuationIndex: input.continuation.index,
          resumeTaskListFrom: transcriptDir(ledgerPath, input.continuation.predecessorSessionId),
        }
      : {}),
  });
  // Ticket 06: the sink exists now. The relay lives exactly as long as the
  // runtime it belongs to, which is this session's, so nothing unsubscribes.
  if (shared.rotations !== undefined) forwardRotationsToSink(shared.rotations, booted.extensionHost.sink);
  // P4 T149: this session's extensions may run read-only child sessions. The
  // id is read when a child starts, since a resume pins it after boot.
  bindExtensionChildSessions(booted, {
    cwd,
    ledgerPath,
    sessionId: () => booted.session.sessionId,
    config,
    gate: posture.gate,
    ...(input.nativeProviders !== undefined ? { nativeProviders: input.nativeProviders } : {}),
  });
  booted.readOnlyPosture = posture.posture;
  return booted;
}

/** The browser is a TUI adapter; ledger mutation remains owned by core. */
export function closeSessionForBrowser(path: string, sessionId: string): void {
  const ledger = openLedgerSync(path);
  try {
    ledger.closeSession(sessionId);
  } finally {
    ledger.close();
  }
}

/** The production entry point: boots one session, runs `runInteractiveLoop()` on it, ingests exactly once at the end (T33's "one ledger, one ingest path" — see DECISIONS.md). */
export async function runInteractiveStandaloneSession(
  input: RunInteractiveStandaloneSessionInput,
): Promise<RunInteractiveStandaloneSessionResult> {
  input = { ...input, specialist: input.specialist ?? DEFAULT_SPECIALIST };
  const cwd = input.workspace;
  const ledgerPath = input.ledgerPath ?? defaultLedgerPath(cwd);
  // T113: a booted project is visible globally even if the session later
  // fails before ingest can write its ledger row.
  resolveProject(cwd);
  let config;
  let layers;
  try {
    ({ resolved: config, layers } = loadConfig({
      cwd,
      ...(input.specialist !== undefined ? { specialistName: input.specialist } : {}),
      ...(input.outputStyle !== undefined ? { flags: { output_style: input.outputStyle } } : {}),
    }));
  } catch (err) {
    // Same treatment `runStandaloneTask` gives a specialist that does not
    // exist or whose content is invalid — before a model call, a ledger
    // row, or a boot.
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
  // T180: the floor applies to a conversation too; only the delegated default and the caller's argument are not here.
  const request = resolveContainmentRequest({ config, layers, delegated: false });
  if (!request.ok) return { status: "error", message: request.message };
  config = request.config;

  // Specialists ticket 02: `provider`+`model`, resolved through the config
  // layers — `runStandaloneTask`'s own seam (`session.ts`'s `specialistModel`),
  // mirrored here rather than left dormant.
  const specialistModel = specialistModelSpec(config);
  const boot = resolveBootModel({
    ...(input.model !== undefined ? { callerModel: input.model } : {}),
    ...(specialistModel !== undefined ? { specialistModel } : {}),
    defaultModel: config.models.default,
    ...(config.models.roles.worker !== undefined ? { roleModel: config.models.roles.worker } : {}),
  });
  const modelSpec = boot.spec;

  const specialistLayer = layers?.find((l) => l.name === "specialist");
  const specialistProvider = specialistLayer?.value?.provider;
  if (input.specialist !== undefined && specialistProvider !== undefined) {
    try {
      assertSpecialistProviderUsable({
        specialistName: input.specialist,
        specialistProvider,
        providers: config.providers,
        env: process.env,
      });
    } catch (err) {
      return { status: "error", message: err instanceof Error ? err.message : String(err) };
    }
  } else if (!(input.nativeProviders ?? []).some((p) => p.id === parseProviderModel(modelSpec).provider)) {
    try {
      const { provider: hostProvider } = parseProviderModel(modelSpec);
      assertHostProviderUsable({
        provider: hostProvider,
        providers: config.providers,
        env: process.env,
      });
    } catch (err) {
      return { status: "error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  const generated = generateProviderConfig({
    providers: config.providers,
    builtins: builtinProviderDecls(),
    targetPath: cacheModelsPath(cwd),
  });
  if (generated.errors.length > 0) {
    return { status: "error", message: generated.errors.join("; ") };
  }

  // Ticket 06: built before boot() and the surface, so rotation reaches both through a relay.
  const rotations = new RotationRelay();
  const modelRuntime = await createLykosModelRuntime({
    ...(generated.written ? { modelsPath: generated.targetPath } : {}),
    providerConfig: config.providers,
    onRotation: rotations.emit,
    ...(input.nativeProviders !== undefined ? { nativeProviders: input.nativeProviders } : {}),
  });
  const model = await resolveHostModel(modelSpec, modelRuntime);

  // T173: the same decision `runStandaloneTask` makes, before anything boots.
  let containment: Containment;
  const containedSessionId = input.resume?.fromSessionId ?? randomUUID();
  try {
    containment = await startContainment({
      config: config.containment,
      workspace: cwd,
      rules: collectPathRules(config.path_rules, isWorkspaceTrusted(cwd)),
      sessionId: containedSessionId,
      ...(request.floor !== undefined ? { minimum: request.floor } : {}),
      ...(input.containmentDrivers !== undefined ? { drivers: input.containmentDrivers } : {}),
      log: (line) => stderrWrite(`${line}
`),
    });
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
  if (containment.notice !== undefined) stderrWrite(`${containment.notice}
`);

  const shared: StandaloneBootInputs = { cwd, ledgerPath, config, boot, modelSpec, model, modelRuntime, input, rotations, containment, containedSessionId };

  let result: Awaited<ReturnType<typeof runInteractiveSurface>>;
  try {
    result = await runInteractiveSurface(shared, finishInteractiveSession);
  } finally {
    // After the surface has finished, which runs the gate in the container.
    await containment.dispose();
  }
  if (result.status === "ok" && result.continuation !== undefined) {
    const { lineSource: _lineSource, approvalGate: _approvalGate, ...freshInput } = input;
    return runInteractiveStandaloneSession({
      ...freshInput,
      continuation: result.continuation,
      ...(result.continuation.taskId !== undefined ? { taskId: result.continuation.taskId } : {}),
      ...(result.continuation.projectId !== undefined ? { projectId: result.continuation.projectId } : {}),
    });
  }
  return result;
}

/**
 * T57: put the replayed conversation into a booted session's context.
 *
 * `sendCustomMessage(..., { triggerTurn: false })` appends to the session's
 * message state without starting a turn — so the conversation is APPENDED
 * AFTER the ordinary frozen head, never merged into it (rule 1 of the
 * phase's §1), and no model call happens until the person says something.
 * The resume marker goes into the new transcript first, so the archive
 * explains itself from its first line.
 */
export async function injectReplay(
  session: InteractiveSession,
  recorder: LiveTranscriptRecorder | undefined,
  plan: ResumePlan,
): Promise<void> {
  recorder?.resumeMarker({
    from: plan.fromSessionId,
    events: plan.replayEvents,
    user_turns: plan.replayUserTurns,
    estimate_tokens: plan.estimateTokens,
    estimate_usd: plan.estimateUsd,
    price_version: plan.priceVersion,
    ...(plan.flags !== undefined ? { inherited_flags: plan.flags } : {}),
  });
  await session.sendCustomMessage?.(
    { customType: "lykos_resume", content: plan.replayText, display: false },
    { triggerTurn: false },
  );
}

/** T37's surface, unchanged in behaviour from before T50.1's branch existed — the fallback every mode not `fullscreen` gets, and the only mode a caller that injects its own `lineSource`/`approvalGate` (a test, an acceptance script) ever gets. */
/**
 * T33's "one ledger, one ingest path" for real: both render-mode branches
 * end here, so ingest and the T52.1 outcome question can never diverge
 * between them. `outcomeLineSource`/`outcomeWrite` are the one thing each
 * branch supplies differently — the append-only path reuses its own
 * `lineSource`/`ui`; the full-screen path hands in a fresh `readline`
 * source and a plain stderr writer, because by the time this runs its own
 * `RawLineSource` and the terminal it needed have already been torn down.
 */
export async function finishInteractiveSession(opts: {
  booted: BootedStandaloneSession;
  session: InteractiveSession;
  state: StandaloneSessionState;
  loopResult: InteractiveLoopResult;
  /** T53: present whenever this session was captured live; its writer holds the transcript and ingest finalizes the hash through it. */
  recorder?: LiveTranscriptRecorder;
  model: Awaited<ReturnType<typeof resolveHostModel>>;
  boot: ReturnType<typeof resolveBootModel>;
  config: ResolvedConfig;
  cwd: string;
  ledgerPath: string;
  label: string | undefined;
  askOutcome: boolean | undefined;
  outcomeLineSource: LineSource;
  outcomeWrite: (text: string) => void;
  /** T57: written onto the NEW row only. The original's numbers stand exactly as they were. */
  resume?: ResumePlan;
  /** T61: an explicit `--task`, joined rather than auto-created. */
  taskId?: string;
  projectId?: string;
  /** T109: this is a disk-rebuilt successor session. */
  continuation?: ContinuationPlan;
  /** T117: how this session crossed the trust boundary. */
  trustSource?: "stored" | "flag" | "prompt";
  /**
   * T111.2: the gate's own tally. Absent on the append-only path, which
   * uses a gate that has no interaction mode to attribute a count to.
   */
  approvals?: ApprovalMetrics;
}): Promise<RunInteractiveStandaloneSessionResult> {
  const { booted, session, state, loopResult, model, boot, config, cwd, ledgerPath } = opts;
  const activeTools = session.getActiveToolNames();
  const sessionId = session.sessionId;
  session.dispose();
  // P10.4 (ticket 15, D5): the session's language servers die with the
  // session, beside `dispose()` rather than in a lifecycle of their own. A
  // server that outlives its session is a process the user has to find and
  // kill by hand.
  await booted.lsp.shutdownAll();
  // P10.5 (ticket 16, D6): and so do its background jobs, in the same place
  // and for the same reason. A job that outlives its session is an orphan
  // nobody will ever stop.
  await booted.jobs.stopAll();
  // P10.6 (ticket 19, D5): and so do its evaluation runtimes. A retained cell
  // runtime is a Node process holding the session's variables; nothing ever
  // printed its pid, so if it is not killed here it is not killed at all.
  await booted.evalRuntimes.disposeAll();
  // P10.5 (ticket 17, D4): and this agent comes off its family's roster, so a
  // peer's `send` to it fails honestly instead of queueing for an agent that
  // has stopped reading.
  booted.mailbox.leave();

  // P10.9 (ticket 21, D3): a broken extension or a broken hook is said out
  // loud at the end of the session it was broken in. A counter nobody prints
  // is the swallowed exception in a slower form — the author still never
  // learns their policy did not run.
  for (const notice of [
    extensionFailureNotice(booted.extensionHost.counters),
    hookFailureNotice(booted.hooks.counters),
  ]) {
    if (notice !== undefined) stderrWrite(`${notice}\n`);
  }

  // 2026-09-07 (UI feedback items 2 and 9): the session's NAME reaches the
  // ledger through the same field the MCP shapes have always used for it.
  // An explicit caller label still wins — `lykos_implement` and friends are
  // naming the job, not guessing at it — and the auto-derived name only
  // fills the gap that used to be filled with the literal "(delegate)".
  const label = opts.label ?? opts.loopResult.sessionName;
  const snapshot = buildStandaloneSnapshot({
    booted,
    state,
    sessionId,
    label,
    runState: loopResult.runState,
    sawError: loopResult.sawError,
    modelRef: `${model.provider}/${model.id}`,
    activeTools,
    // T111: both are absent unless something actually observed them, so a
    // shape without a gate or without a live transcript records NULL rather
    // than a zero it did not measure.
    ...(opts.approvals !== undefined ? { approvals: opts.approvals } : {}),
    ...(opts.recorder !== undefined ? { artifactBytes: opts.recorder.writer.artifactBytes } : {}),
  });

  const ledger = await openLedger(ledgerPath);
  try {
    ingestDelegateSnapshot(ledger, snapshot, {
      workspace: cwd,
      executionShape: "standalone",
      runtime: "host",
      modelSource: boot.source,
      providers: config.providers,
      // T57: the resume's task wins over the spawn context's, because
      // sharing the ORIGINAL's task_id is the clause with the metric
      // consequence — a task resumed four times is one expensive task, not
      // four cheap ones.
      // Precedence, worst-consequence-first: a resume's task wins over an
      // explicit --task, which wins over a spawn context's. All three are
      // deliberate statements about which task this session belongs to; the
      // resume's is the one whose absence would silently split a task.
      ...(opts.resume?.taskId !== undefined
        ? { taskId: opts.resume.taskId }
        : opts.taskId !== undefined
          ? { taskId: opts.taskId }
          : booted.spawnContext?.taskId !== undefined
            ? { taskId: booted.spawnContext.taskId }
            : {}),
      ...(opts.resume?.projectId !== undefined
        ? { projectId: opts.resume.projectId }
        : opts.projectId !== undefined
          ? { projectId: opts.projectId }
          : booted.spawnContext?.projectId !== undefined
            ? { projectId: booted.spawnContext.projectId }
            : {}),
      ...(opts.continuation !== undefined
        ? {
            resumedFrom: opts.continuation.predecessorSessionId,
            continuationsUsed: opts.continuation.index,
          }
        : {}),
      // Item 1: no `resumed_from`. The row this ingest lands on IS the
      // original — `sessionAlreadyExists` in `ingest.ts` sees it and
      // updates rather than inserting — so an edge from a session to itself
      // is neither needed nor meaningful.
      ...(loopResult.closeRequested ? { closedUtc: new Date().toISOString() } : {}),
      ...(opts.recorder !== undefined ? { liveTranscript: opts.recorder } : {}),
    });
    // A CONTINUED session (UI feedback item 1) already had a row, so
    // `startSession()` was skipped and the brief above never landed. A name
    // the human typed is not allowed to be lost to that: write it directly.
    // A merely DERIVED name does not overwrite what the session is already
    // called — the first thing said in the original run named it, and the
    // first thing said in the continuation is not a better answer.
    if (opts.loopResult.nameIsHuman === true && opts.loopResult.sessionName !== undefined) {
      ledger.renameSession(sessionId, opts.loopResult.sessionName);
    }
  } finally {
    ledger.close();
  }

  // T100, granularity 3: the mechanical gate runs BEFORE the human is asked,
  // and when it produces a verdict the question is not asked at all.
  //
  // That ordering is the substance of the task. An exit code is a better
  // answer than an opinion, and asking afterwards would invite overwriting a
  // fact with a recollection -- `recordOutcome` would happily take it. The
  // question survives for every case the gate cannot answer: no test script,
  // a read-only session, a command that would not start.
  let gateAnswered = false;
  let gateGreen = false;
  let gateOutcome: GateOutcome | undefined;
  if (loopResult.runState === "done") {
    const gatePolicy = resolveGatePolicy(cwd, config.gate);
    const changedPaths = sessionChangedPaths(cwd, booted.bootArtifacts.gitHeadAtBoot);
    const gate = await runSessionGate({
      policy: gatePolicy,
      sessionId,
      ledgerPath,
      edited: sessionEditedFiles(state.toolCalls),
      editedFiles: sessionEditedPaths(state.toolCalls, changedPaths),
      // P10.9 (ticket 21, D2): `verification_verdict` fires inside
      // `runSessionGate`, which is where the outcome exists.
      events: booted.extensionHost.sink,
      executor: booted.executor,
      extensionHost: booted.extensionHost,
      startCommit: booted.bootArtifacts.gitHeadAtBoot,
      specialist: booted.extensionHost.getSpecialist(),
      onStart: (cmd) => opts.outcomeWrite(renderGateStart(cmd, gatePolicy.timeoutMs)),
    });
    gateOutcome = gate;
    // A skip is said too: a gate that silently did not run reads as one that passed.
    opts.outcomeWrite(renderGateOutcome(gate));
    if (gate.status === "recorded") {
      gateAnswered = true;
      gateGreen = gate.outcome === "success";
    }
  }

  // P4 T149: `session_end` after the gate, then the extensions' counters.
  // The reviewer (`lykos-reviewer`) runs from here now.
  await endExtensionSession(booted, {
    cwd,
    ledgerPath,
    sessionId,
    isChild: false,
    model: `${model.provider}/${model.id}`,
    state: loopResult.runState,
    edited: sessionEditedFiles(state.toolCalls),
    ...(gateOutcome !== undefined ? { gateOutcome } : {}),
    report: opts.outcomeWrite,
  });

  if (loopResult.runState === "done" && booted.contextStrategy.active === "continue") {
    const predecessorDir = transcriptDir(ledgerPath, sessionId);
    const persistedTaskList = readTaskListFile(predecessorDir);
    const persistedTaskState = resumeTaskListState(persistedTaskList);
    const decision = decideContinuation({
      // T150: continuation is the active strategy, or this block is never reached.
      enabled: booted.contextStrategy.active === "continue",
      thresholdReached: booted.continuationState.requested,
      openItems: persistedTaskList !== null && hasOpenItems(persistedTaskState),
      gateGreen,
      continuationsUsed: opts.continuation?.index ?? 0,
      cap: config.continuation.max,
      fileChanged: gitStatus(cwd) !== booted.continuationState.gitStatusAtBoot,
      taskListMoved: booted.taskList.version > booted.continuationState.taskListVersionAtBoot,
    });
    if (decision.action === "continue") {
      const checkpoint = listCheckpoints({ cwd })[0];
      const gatePolicy = resolveGatePolicy(cwd, config.gate);
      const continuationIndex = (opts.continuation?.index ?? 0) + 1;
      const next = await openLedger(ledgerPath);
      let taskId: string | undefined = opts.continuation?.taskId ?? opts.taskId;
      let projectId: string | undefined = opts.continuation?.projectId ?? opts.projectId;
      try {
        const identity = next.db
          .prepare(`SELECT task_id, project_id FROM sessions WHERE id = ?`)
          .get(sessionId) as { task_id: string | null; project_id: string | null } | undefined;
        taskId = identity?.task_id ?? taskId;
        projectId = identity?.project_id ?? projectId;
      } finally {
        next.close();
      }
      const prompt = buildContinuationPrompt({
        predecessorSessionId: sessionId,
        continuationIndex,
        taskListPath: join(predecessorDir, "tasks.json"),
        taskList: persistedTaskState,
        checkpointRef: "refs/lykos/checkpoints",
        ...(checkpoint !== undefined ? { checkpointCommit: checkpoint.commit } : {}),
        ...(gatePolicy.command !== undefined ? { verificationCommand: gatePolicy.command } : {}),
        contextFiles: booted.frozenContextFiles.map((file) => ({ path: file.path, bytes: file.bytes })),
        ...(opts.continuation?.originalPrompt !== undefined
          ? { originalPrompt: opts.continuation.originalPrompt }
          : opts.loopResult.originalPrompt !== undefined
            ? { originalPrompt: opts.loopResult.originalPrompt }
            : {}),
      });
      opts.outcomeWrite(`lykos: context boundary reached; starting continuation ${continuationIndex}/${config.continuation.max}`);
      const continuation = {
        predecessorSessionId: sessionId,
        index: continuationIndex,
        prompt,
        originalPrompt: opts.continuation?.originalPrompt ?? opts.loopResult.originalPrompt ?? prompt,
        ...(taskId !== undefined ? { taskId } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
      };
      opts.outcomeLineSource.close();
      return {
        status: "ok",
        sessionId,
        snapshot,
        continuation,
      };
    }
  }

  // T52.1: the session-end outcome block. AFTER ingest, because ingest is
  // what ends the row, and only for a session that ended normally -- an
  // abort or an error already has an outcome (`abandoned` / `fail`) that
  // `ingest.ts` wrote from what actually happened, and asking "did that
  // work?" about a run the user interrupted invites a wrong answer over a
  // right one the ledger already holds.
  if (loopResult.runState === "done" && opts.askOutcome === true && !gateAnswered) {
    await askSessionOutcome({
      sessionId,
      workspace: cwd,
      ledgerPath,
      lineSource: opts.outcomeLineSource,
      write: opts.outcomeWrite,
    });
  }
  opts.outcomeLineSource.close();

  if (loopResult.runState === "error") {
    return { status: "error", message: loopResult.sawError ?? "interactive session ended in error" };
  }
  return {
    status: "ok",
    sessionId,
    snapshot,
    ...(loopResult.resumeRequested ? { resumeRequested: true } : {}),
    ...(loopResult.resumeSessionId !== undefined ? { resumeSessionId: loopResult.resumeSessionId } : {}),
    ...(loopResult.newRequested ? { newRequested: true } : {}),
    ...(loopResult.closeRequested ? { closeRequested: true } : {}),
  };
}

/**
 * T52.1's flow, extracted so `interactive.test.ts` can drive it against a
 * scripted `LineSource` and a temp ledger with no session and no terminal.
 *
 * The division of labour is `07-ui-and-hud.md` §1.1, unchanged by Phase 3.5:
 * `tui/outcome.ts` renders the question and parses the answer and touches no
 * ledger; `cli/verify.ts` runs the command and performs the single write.
 * Nothing here can produce `outcome_source = 'agent_claim'` -- it is not an
 * option on screen, and the ledger writer rejects the value outright.
 */
export async function askSessionOutcome(opts: {
  sessionId: string;
  workspace: string;
  ledgerPath: string;
  lineSource: LineSource;
  write: (text: string) => void;
  /** Overridable for tests; production derives it from the project's package.json. */
  suggestedCmd?: string | undefined;
}): Promise<void> {
  const suggested = opts.suggestedCmd !== undefined ? opts.suggestedCmd : suggestedVerificationCommand(opts.workspace);
  opts.write(
    renderOutcomePrompt({
      sessionId: opts.sessionId,
      ...(suggested !== undefined ? { suggestedCmd: suggested } : {}),
    }),
  );
  // Three attempts, then treat it as a skip. An unparseable answer should
  // not become an interrogation at the end of a session the user is trying
  // to leave, and a skip is a legitimate row.
  let choice = parseOutcomeAnswer(await opts.lineSource.next(), suggested);
  for (let attempt = 0; choice === null && attempt < 2; attempt++) {
    opts.write("lykos: answer c, y, n, or s (or type the command to run)");
    choice = parseOutcomeAnswer(await opts.lineSource.next(), suggested);
  }
  if (choice === null) choice = { kind: "skip" };

  const { runVerify } = await import("./verify-outcome.js");
  const result = await runVerify(opts.sessionId, {
    ledgerPath: opts.ledgerPath,
    cwd: opts.workspace,
    answer: choice,
  });
  opts.write(
    renderOutcomeResult(
      result.status === "recorded"
        ? {
            status: "recorded",
            outcome: result.outcome,
            outcomeSource: result.outcomeSource,
            ...(result.run !== undefined ? { exitCode: result.run.exitCode, cmd: result.run.cmd } : {}),
          }
        : result,
    ),
  );
}

/**
 * The command offered as the default, derived from the project rather than
 * from configuration: `npm test` when package.json declares a `test` script,
 * and nothing when it does not. No new config key -- a session-end block that
 * requires typing the command every time gets skipped every time, and a
 * config key nobody sets would have the same effect with more surface.
 */
export function suggestedVerificationCommand(workspace: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts?.test ? "npm test" : undefined;
  } catch {
    return undefined;
  }
}
