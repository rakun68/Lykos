import { basename, join } from "node:path";
import { homedir } from "node:os";
import { existsSync as fileExists } from "node:fs";
import type { ResolvedConfig } from "../config/types.js";
import { specialistModelSpec } from "../config/providers.js";
import { DEFAULT_SPECIALIST, discoverSpecialists, primarySpecialists } from "../config/specialists.js";
import {
  applySpecialistGuardEnv,
  formatSpecialistChangeReport,
  formatSpecialistList,
  specialistNamesFor,
  resolveSpecialistSwitch,
} from "../session/specialist-switch.js";
import { specialistStreamMessage } from "../session/specialist-stream.js";
import { deleteSessionConversation } from "../session/mutations.js";
import { transcriptDir } from "../session/transcript.js";
import { allProjectSources, gatherSessions } from "../session/sources.js";
import { nestSessions, type SessionListRow } from "../session/listing.js";
import { PreviewCache, deriveSessionName } from "../session/preview.js";
import { readLiveSnapshot } from "../ledger/live.js";
import { loadHistory } from "./history.js";
import { lykosVersion } from "../version.js";
import { listCheckpoints, restoreCheckpoint } from "../loop/checkpoint.js";
import { compactionRecordsOf } from "../loop/self-compact.js";
import { copyToClipboard, readClipboard } from "./clipboard.js";
import { stdoutWrite, stderrWrite } from "./io-mode.js";
import { detectColorCapability, detectGlyphSet, resolveTheme } from "./theme/resolve.js";
import { GLYPHS } from "./theme/types.js";
import { createAgentUi, type AgentUi, type SystemPart, type StreamEvent } from "./s0.js";
import {
  bootInteractiveSession,
  closeSessionForBrowser,
  createReadlineLineSource,
  injectReplay,
  PLAN_CONTINUE_AUTO,
  PLAN_CONTINUE_MANUAL,
  PLAN_STAY,
  runInteractiveLoop,
  type InteractiveHandle,
  type InteractiveSession,
  type LineSource,
  type InteractiveLoopResult,
  type RunInteractiveStandaloneSessionInput,
  type RunInteractiveStandaloneSessionResult,
  type StandaloneBootInputs,
} from "../session/interactive.js";
import type { ApprovalGate, ReadOnlyPosture } from "../gate/approval.js";
import { ApprovalMetrics } from "../gate/approval-metrics.js";
import { TerminalApprovalGate } from "../gate/approval.js";
import {
  canSealAllowanceEverAllow,
  createSealTestCommandAllowance,
  wrapApprovalGateWithSealAllowance,
} from "../gate/delegated.js";
import {
  resolveApprovalGate,
  resolveHostModel,
  startLiveCapture,
  subscribeStandaloneUsage,
} from "../session/session.js";
import {
  hasOpenItems,
  parseAskAnswer,
  renderAskPrompt,
  resumeTaskListState,
  TerminalAsk,
} from "../tools.js";
import { registerPiCommands } from "./pi-commands.js";
import { setExtensionCommands, setOutputStyleNames, setSpecialistNames, setSkillCommands } from "./commands.js";
import { createOutputStyleSwitcher, outputStyleNamesFor } from "../config/output-styles.js";
import { createCredentialCommands, showRotationNotices } from "./credential-commands.js";
import type { LykosEventSink } from "../extensions/api.js";
import type { BrowserState } from "./screen/browser.js";
import type { ClickAction } from "./screen/scrollback.js";
import { openUrl } from "./open-url.js";
import { setStderrSink } from "./io-mode.js";
import { loadPermissions, rememberAllow, rememberExtraDir, rememberMode, startingMode } from "../gate/permissions.js";
import {
  MODE_INFO,
  modeSwitchNotice,
  type InteractionMode,
} from "../gate/modes.js";
import { resolveProject } from "../session/identity.js";
import { resolveGatePolicy } from "../gate/verify-gate.js";
import type { BootedStandaloneSession, StandaloneSessionState } from "../session/session.js";
import type { LiveTranscriptRecorder } from "../session/live-capture.js";
import { renderOutcomeResult, renderOutcomePrompt, parseOutcomeAnswer } from "./outcome.js";
import { type RunInteractiveStandaloneSessionResult as Result } from "../session/interactive.js";

export type FinishInteractiveSession = (opts: Parameters<typeof import("../session/interactive.js").finishInteractiveSession>[0]) => Promise<Result>;

/** `<globalDir>/specialists` — `config/load.ts`'s own default, inlined the same way every other module here already does (`gate/trust.ts`, `gate/permissions.ts`, `session/identity.ts`). */
function defaultGlobalDir(): string {
  return join(homedir(), ".lykos");
}

/** The subset of the real `AgentSession` a specialist switch touches. Structural — the concrete session objects both surfaces hold satisfy it. */
interface SpecialistMutableSession {
  setModel(model: unknown, options?: { persist?: boolean }): Promise<void>;
  setActiveToolsByName(names: string[]): void;
  setThinkingLevel?(level: string, options?: { persist?: boolean }): void;
  /** What the request carries now — the set a restriction is measured against. */
  getActiveToolNames?(): string[];
}

/**
 * Ticket 04: `/specialist`'s live half, shared by both render-mode branches so
 * they cannot independently decide how a switch is applied.
 *
 * **What is actually mutated, and why.** `session.setActiveToolsByName()`
 * is Pi's own API and its doc comment says it plainly: "Also rebuilds the
 * system prompt to reflect the new tool set" — that IS the prefix break the
 * head contract defines (`tools` is a `HEAD_FIELD_ORDER` member,
 * `session/head-contract.ts`), so calling it is both how the new specialist's
 * tool surface takes effect and how the switch earns the ticket's "records a
 * prefix break" checkbox honestly rather than by a label with nothing behind
 * it. Model and thinking level are applied through the same SDK methods
 * `/model` and boot already use. `instructions` is NOT re-injected: Pi's
 * `AgentSession` has no public setter for `_systemPromptOverride` (it is
 * private, set once at construction — verified by reading
 * `dist/core/agent-session.d.ts` directly, rule 1), and `HeadContract
 * .rebase()` refuses for the identical reason (T17.3). The report says so
 * rather than silently doing nothing; the new instructions take effect on
 * the next session, same as before this ticket.
 */
export interface SpecialistSwitcher {
  currentSpecialistName: () => string | undefined;
  listSpecialists: () => string;
  switchSpecialist: (name: string) => Promise<{ ok: true; report: string } | { ok: false; message: string }>;
  takeSpecialistNotice: () => string | undefined;
}

export function createSpecialistSwitcher(opts: {
  cwd: string;
  session: SpecialistMutableSession;
  modelRuntime: Parameters<typeof resolveHostModel>[1];
  initialConfig: ResolvedConfig;
  initialSpecialistName: string | undefined;
  toolsOverride: readonly string[] | undefined;
  state: StandaloneSessionState;
  /** Repaint whatever shows the active specialist (header, HUD). */
  onSwitched?: (name: string) => void;
  /** P10.9 (ticket 21, D2): the session's Lykos extension sink, for `specialist_switch`. */
  events?: LykosEventSink;
  /** T214 (ADR-0043, Ruling 3): live read-only posture to lift/tighten on switch. */
  readOnlyPosture?: ReadOnlyPosture | undefined;
  /** T215 (ADR-0044): initial specialist stream message queued on boot. */
  initialSpecialistMessage?: string | undefined;
  /** T215: current permission mode query for specialist stream message format. */
  currentMode?: () => InteractionMode;
}): SpecialistSwitcher {
  const globalDir = defaultGlobalDir();
  let currentConfig = opts.initialConfig;
  let currentSpecialistName = opts.initialSpecialistName;
  let pendingSpecialistNotice: string | undefined = opts.initialSpecialistMessage;

  const switcher: SpecialistSwitcher = {
    currentSpecialistName: () => currentSpecialistName,
    listSpecialists: () => formatSpecialistList(discoverSpecialists(opts.cwd, globalDir), currentSpecialistName),
    takeSpecialistNotice: () => {
      const notice = pendingSpecialistNotice;
      pendingSpecialistNotice = undefined;
      return notice;
    },
    switchSpecialist: async (name: string) => {
      const previous = currentSpecialistName ?? "build";
      const result = resolveSpecialistSwitch({
        name,
        cwd: opts.cwd,
        globalDir,
        currentConfig,
        ...(opts.toolsOverride !== undefined ? { toolsOverride: opts.toolsOverride } : {}),
        ...(opts.state.currentModel !== undefined ? { runningModel: opts.state.currentModel } : {}),
        // What the request carries right now. Without this the second switch in a
        // session measures off-limits against the previous specialist's set and
        // lets everything outside it through.
        ...(opts.session.getActiveToolNames !== undefined
          ? { sessionToolNames: opts.session.getActiveToolNames() }
          : {}),
        // P10.9 (ticket 21, D2): `specialist_switch` fires inside the
        // resolver, which is where the diff is computed — see the field's own
        // comment there for what that does and does not claim.
        ...(opts.events !== undefined ? { events: opts.events } : {}),
      });
      if (!result.ok) return { ok: false, message: result.message };

      // D3: The model never changes on a switch. The running model stays.
      if (result.config.thinkingLevel !== undefined) {
        try {
          opts.session.setThinkingLevel?.(result.config.thinkingLevel);
        } catch {
          // A model that does not support thinking effort is not a switch failure — boot() already treats it the same way.
        }
      }
      // D4: The tool list and system prompt prefix stay byte-identical (ADR-0021).
      // T209 / Ruling 2: startingMode supplies the permission mode; a specialist never sets it.

      // T214 (Ruling 3): Apply read_only live on a /specialist switch: read_only to writing
      // lifts the ceiling, the reverse tightens it.
      if (opts.readOnlyPosture !== undefined) {
        opts.readOnlyPosture.readOnly = result.config.readOnly === true;
      }

      // D5: The restrictions bite immediately on the turn right after the switch.
      applySpecialistGuardEnv(name, result.offLimitToolNames, result.allowedToolNames);

      opts.state.specialistSwitches = (opts.state.specialistSwitches ?? 0) + 1;
      opts.state.specialistPath = opts.state.specialistPath
        ? `${opts.state.specialistPath}>${name}`
        : `${currentSpecialistName ?? "(none)"}>${name}`;
      opts.state.specialistSwitchedPending = true;

      currentConfig = result.config;
      currentSpecialistName = name;
      opts.onSwitched?.(name);

      const modeLabel = MODE_INFO[opts.currentMode?.() ?? "manual"]?.label ?? "Manual";
      pendingSpecialistNotice = specialistStreamMessage({
        previous,
        name,
        ...(result.config.instructions !== undefined ? { instructions: result.config.instructions } : {}),
        ...(result.offLimitToolNames.length > 0 ? { offLimits: result.offLimitToolNames } : {}),
        modeLabel,
        ...(result.offLimitToolNames.length > 0 ? { tools: result.allowedToolNames } : {}),
      });

      return { ok: true, report: formatSpecialistChangeReport(name, result.changed, result.notices) };
    },
  };

  return switcher;
}

export async function runInteractiveSurface(
  shared: StandaloneBootInputs,
  finish: FinishInteractiveSession,
): Promise<RunInteractiveStandaloneSessionResult> {
  const { input } = shared;
  if (input.lineSource === undefined && input.approvalGate === undefined) {
    const { vtSupport } = await import("./screen/vt.js");
    const { decideRenderMode } = await import("./screen/fallback.js");
    const { getIoMode } = await import("./io-mode.js");
    const vt = await vtSupport();
    const decision = decideRenderMode({
      ioMode: getIoMode(),
      isTTY: Boolean(process.stdout.isTTY),
      vtSupported: vt.supported,
      noFullscreen: input.noFullscreen === true,
      term: process.env.TERM,
    });
    if (decision.mode === "fullscreen") return runFullscreenInteractive(shared, finish);
  }
  return runAppendOnlyInteractive(shared, finish);
}

export async function runAppendOnlyInteractive(shared: StandaloneBootInputs, finish: FinishInteractiveSession): Promise<RunInteractiveStandaloneSessionResult> {
  const { cwd, ledgerPath, config, boot, modelSpec, model, modelRuntime, input } = shared;

  const lineSource = input.lineSource ?? createReadlineLineSource();
  let ui: AgentUi | undefined;
  let gate =
    input.approvalGate ??
    resolveApprovalGate({
      autoApprove: input.autoApprove === true,
      interactiveGate: new TerminalApprovalGate(
        () => lineSource.next(),
        { write: (chunk: string) => stdoutWrite(String(chunk)) },
        (req) => {
          ui?.renderApproval(req);
        },
        { projectId: resolveProject(cwd).id, cwd },
      ),
    });
  const specialist = input.specialist ?? DEFAULT_SPECIALIST;
  if (canSealAllowanceEverAllow({ cwd, config, specialist })) {
    const allowance = createSealTestCommandAllowance({
      cwd,
      config,
      specialist,
    });
    gate = wrapApprovalGateWithSealAllowance(gate, allowance);
  }

  const booted = await bootInteractiveSession(shared, {
    gate,
    // T103: the human channel exists here, so `ask` is registered. It is the
    // same `lineSource` the approval gate reads, and `TerminalAsk` serializes
    // onto one outstanding read for the same reason the gate does.
    askHuman: new TerminalAsk(
      () => lineSource.next(),
      { write: (chunk: string) => stdoutWrite(String(chunk)) },
    ).ask,
  });
  // T131: hand the discovered skills to the command surface, so `/handoff`
  // both completes and dispatches. This is the one runtime seam the old
  // `const` registry could not have: the roster differs per project.
  setSkillCommands(booted.skillRoster);
  // Ticket 04: same reasoning, for `/specialist <name>`'s Tab-completion.
  setSpecialistNames(specialistNamesFor(cwd, defaultGlobalDir()));
  setOutputStyleNames(outputStyleNamesFor(cwd, defaultGlobalDir()));
  // P10.9 (ticket 21, D5): and the same seam again, for the slash commands
  // this session's Lykos extensions registered. Names and descriptions only —
  // the handler stays on the host, which `runExtensionCommand` below reaches.
  setExtensionCommands(booted.extensionHost.commands());
  // T163: and the commands Pi extensions registered, so every slash command
  // that runs when typed is also offered by Tab. A shadowed one is named.
  for (const line of registerPiCommands(booted)) stderrWrite(`lykos: ${line}\n`);

  const { session } = booted;
  const { state, unsubscribe } = subscribeStandaloneUsage(booted);
  // T53: capture opens with the session, not with ingest — a session killed
  // mid-turn still leaves a readable, self-describing directory behind.
  const { recorder, detach } = startLiveCapture({
    ledgerPath,
    booted,
    session,
    modelSpec,
    modelSource: boot.source,
    providers: config.providers,
    executionShape: "standalone",
    // Deliberately no `resumedFrom`: the session IS the one being resumed,
    // and a row pointing at itself is the messy artefact item 1 removed.
    ...(input.resume?.taskId !== undefined ? { taskId: input.resume.taskId } : {}),
    ...(input.resume?.projectId !== undefined ? { projectId: input.resume.projectId } : {}),
    ...(input.continuation !== undefined
      ? {
          ...(input.continuation.taskId !== undefined ? { taskId: input.continuation.taskId } : {}),
          ...(input.continuation.projectId !== undefined ? { projectId: input.continuation.projectId } : {}),
          resumedFrom: input.continuation.predecessorSessionId,
          continuationsUsed: input.continuation.index,
        }
      : {}),
  });

  if (input.resume) await injectReplay(session, recorder, input.resume);

  const width = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;
  const capability = detectColorCapability({
    env: process.env,
    isTTY: Boolean(process.stdout.isTTY),
    ...(config.ui.color !== "auto" ? { colorFlag: config.ui.color } : {}),
  });
  const glyphs = config.ui.glyphs === "unicode" ? detectGlyphSet(process.env) : config.ui.glyphs;
  const theme = resolveTheme(config.ui.theme, capability, glyphs, { cwd });
  ui = createAgentUi({
    width,
    theme,
    header: { model: modelSpec, sessionId: session.sessionId, cwd, ...(booted.specialistName !== undefined ? { specialist: booted.specialistName } : {}) },
    ledgerPath,
    config,
    startedUtc: booted.startedAt,
  });
  const unsubUi = session.subscribe
    ? ui.attach({ subscribe: (fn) => session.subscribe!((ev) => fn(ev as import("../tui/s0.js").StreamEvent)) }, () => state)
    : undefined;

  // Ticket 04: `/specialist`'s live half. The append-only header is painted
  // once (there is no persistent repainted region the way the fullscreen
  // header is), so a switch here changes what `/specialist` itself reports and
  // what the NEXT `/session` shows — not the header line already printed.
  const specialistSwitcher = createSpecialistSwitcher({
    cwd,
    session,
    modelRuntime,
    initialConfig: config,
    initialSpecialistName: booted.specialistName,
    toolsOverride: input.tools,
    state,
    events: booted.extensionHost.sink,
    readOnlyPosture: booted.readOnlyPosture,
    initialSpecialistMessage: booted.specialistMessage,
  });
  // P14.6 ticket 06: `/login`, `/credential`, and the one-line rotation notice.
  const credentialCommands = createCredentialCommands({ session, config });
  const stopRotationNotices = showRotationNotices(shared.rotations, (line) => ui?.writeSystem(line));
  const outputStyleSwitcher = createOutputStyleSwitcher({
    cwd,
    globalDir: defaultGlobalDir(),
    initialOutputStyleName: config.output_style,
  });

  let loopResult: InteractiveLoopResult;
  try {
    loopResult = await runInteractiveLoop({
      session,
      lineSource,
      state,
      ledgerPath,
      config,
      modelSpec,
      contained: shared.containment !== undefined && shared.containment.record.used !== "off",
      projectId: resolveProject(cwd).id,
      runExtensionCommand: (name, args) => booted.extensionHost.runCommand(name, args),
      currentModel: () => {
        const current = session.model;
        return current ? `${current.provider}/${current.id}` : modelSpec;
      },
      setModel: async (spec, persist) => {
        const next = await resolveHostModel(spec, modelRuntime);
        await session.setModel(next, { persist });
        const ref = `${next.provider}/${next.id}`;
        if (state.currentModel !== ref) {
          state.modelPath = state.modelPath ? `${state.modelPath}>${ref}` : `${state.initialModel}>${ref}`;
          state.modelSwitches = (state.modelSwitches ?? 0) + 1;
          state.currentModel = ref;
        }
        ui.writeHud(state, session.sessionId);
        return ref;
      },
      cycleModel: async () => {
        const next = await session.cycleModel("forward", { persist: false });
        if (!next) return undefined;
        const ref = `${next.model.provider}/${next.model.id}`;
        if (state.currentModel !== ref) {
          state.modelPath = state.modelPath ? `${state.modelPath}>${ref}` : `${state.initialModel}>${ref}`;
          state.modelSwitches = (state.modelSwitches ?? 0) + 1;
          state.currentModel = ref;
        }
        ui.writeHud(state, session.sessionId);
        return ref;
      },
      listSpecialists: specialistSwitcher.listSpecialists,
      takeSpecialistNotice: specialistSwitcher.takeSpecialistNotice,
      switchSpecialist: async (name) => {
        const outcome = await specialistSwitcher.switchSpecialist(name);
        ui.writeHud(state, session.sessionId);
        return outcome;
      },
      listOutputStyles: outputStyleSwitcher.listOutputStyles,
      switchOutputStyle: outputStyleSwitcher.switchOutputStyle,
      takeOutputStyleNotice: outputStyleSwitcher.takeOutputStyleNotice,
      ui,
      compactionRecords: () => compactionRecordsOf(booted),
      contextInfo: () => ({
        systemPromptChars: session.systemPrompt.length,
        contextFiles: booted.frozenContextFiles.map((f) => ({ name: basename(f.path), bytes: f.bytes })),
        skills: booted.skillNames,
        toolNames: session.getActiveToolNames(),
      }),
      ...(input.onReady !== undefined ? { onReady: input.onReady } : {}),
      ...(recorder !== undefined ? { recorder } : {}),
      ...(input.continuation !== undefined ? { initialPrompt: input.continuation.prompt } : {}),
      continuationRequested: () => booted.continuationState.requested,
      login: credentialCommands.login,
      credential: credentialCommands.credential,
    });
  } finally {
    stopRotationNotices();
    unsubUi?.();
    unsubscribe();
    detach();
  }

  return finish({
    booted,
    session,
    state,
    loopResult,
    ...(recorder !== undefined ? { recorder } : {}),
    model,
    boot,
    config,
    cwd,
    ledgerPath,
    label: input.label,
    askOutcome: input.askOutcome,
    ...(input.trustSource !== undefined ? { trustSource: input.trustSource } : {}),
    ...(input.resume !== undefined ? { resume: input.resume } : {}),
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.continuation !== undefined ? { continuation: input.continuation } : {}),
    outcomeLineSource: lineSource,
    outcomeWrite: (text) => (ui ? ui.writeSystem(text) : stderrWrite(`${text}\n`)),
  });
}

/**
 * T50.1's fullscreen branch: T41's `ScreenTerminal` owns raw mode and the
 * alternate screen for exactly the span that needs it — boot through the
 * end of `runInteractiveLoop()` — and nothing after that span runs while
 * the terminal is still altered. `finishInteractiveSession()`'s ledger
 * ingest and T52.1's outcome question both run AFTER `term.run()` returns,
 * printing to the NORMAL buffer with a freshly created `readline` line
 * source — `RawLineSource` cannot answer them, because by then the stdin
 * router that fed it bytes has already been torn down along with raw mode
 * itself. This mirrors T41's own "restore first, print after" rule for a
 * crash, applied to the ordinary end-of-session path instead of a crash.
 */
export async function runFullscreenInteractive(shared: StandaloneBootInputs, finish: FinishInteractiveSession): Promise<RunInteractiveStandaloneSessionResult> {
  const { cwd, ledgerPath, config, boot, modelSpec, model, modelRuntime, input } = shared;

  const width = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;
  const height = process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : 24;
  const capability = detectColorCapability({
    env: process.env,
    isTTY: Boolean(process.stdout.isTTY),
    ...(config.ui.color !== "auto" ? { colorFlag: config.ui.color } : {}),
  });
  const glyphs = config.ui.glyphs === "unicode" ? detectGlyphSet(process.env) : config.ui.glyphs;
  const theme = resolveTheme(config.ui.theme, capability, glyphs, { cwd });

  const { ScreenTerminal } = await import("../tui/screen/terminal.js");
  const { ScreenPipeline } = await import("../tui/screen/pipeline.js");
  const { RawLineSource } = await import("../tui/screen/raw-line-source.js");
  const { RawApprovalGate } = await import("../tui/screen/approval-modal.js");
  const { createFullscreenAgentUi } = await import("../tui/screen/fullscreen-ui.js");
  const { renderComposer, composerMaxRows, COMPOSER_PREFIX_WIDTH } = await import("../tui/screen/composer.js");
  const { copyToClipboard, readClipboard } = await import("../tui/clipboard.js");
  const { renderCompletionPopup } = await import("../tui/screen/completion.js");
  const { routeStdin } = await import("../tui/screen/stdin-router.js");
  // T114: the session browser. Dynamically imported with the rest of the
  // fullscreen surface, so a non-TTY caller never loads any of it.
  const { BrowserOverlay } = await import("../tui/screen/browser-overlay.js");
  const { RewindOverlay } = await import("../tui/screen/rewind.js");
  const { renderRewind } = await import("../tui/screen/rewind.js");
      const { listCheckpoints, restoreCheckpoint } = await import("../loop/checkpoint.js");
  const { allProjectSources, gatherSessions } = await import("../session/sources.js");
  const { renderBrowser: renderBrowserView } = await import("../tui/screen/browser.js");
  const { PreviewCache } = await import("../session/preview.js");
  const { existsSync: fileExists } = await import("node:fs");
  const { readLiveSnapshot } = await import("../ledger/live.js");
  const { loadHistory } = await import("../tui/history.js");
  const { lykosVersion } = await import("../version.js");

  // Mouse tracking is unconditional (2026-09-02 round three, item 1). It
  // was briefly a setting, on the theory that holding the mouse is what
  // cost the terminal its Ctrl+scroll zoom — it is, and the maintainer's
  // answer was that zoom lives on Ctrl +/- anyway, so the setting was a
  // mistake and is gone rather than left at a different default.
  const term = new ScreenTerminal({ mouse: true, kittyKeyboard: true });
  let pipelineRef: InstanceType<typeof ScreenPipeline> | undefined;
  let handleRef: InteractiveHandle | undefined;
  let uiRef: AgentUi | undefined;

  /**
   * A glossary for the footer's own triad — 2026-09-02 round nine, item 4:
   * "Add hoverable message... for the information beneath the prompt chat
   * box: ledger, context... Since not all people may understand each of
   * them." True hover was rejected in favour of a click (`pipeline.
   * actionAt()`'s own doc has why); this is what that click shows — one
   * glossary covering every segment, not a per-segment tooltip, since the
   * footer packs several width tiers of abbreviated segments into one row
   * with no per-segment column boundary tracked anywhere to click on
   * individually.
   */
  /** A fixed id, not `nextId("system")` — `handleClickAction`'s `showLegend` case compares the transcript's last block id against this to decide whether a click is a no-op (round ten, item 3). */
  const FOOTER_LEGEND_BLOCK_ID = "footer-legend";

  function footerLegend(): { text: string; parts: SystemPart[] } {
    const g = GLYPHS[theme.glyphs];
    // Round ten, item 2: "The glossary miss a lot of things" — the first
    // cut only named the six segments the narrowest width tier still
    // shows. This is now every segment `renderTriadLine()` can put on the
    // footer at ANY width, in the same left-to-right order they appear.
    const rows: Array<[string, string]> = [
      [`${g.arrowUp}`, "fresh input tokens sent this run — not served from cache"],
      [`${g.bolt}`, "cache hit ratio — the % of input tokens served from cache instead of paid fresh"],
      [`${g.write}`, "cache-write tokens — the premium paid to create a cache entry, not a saving"],
      [`${g.arrowDown}`, "output tokens generated this run"],
      ["ctx", "context window used — the bar, the used/max token counts, and the percentage"],
      ["$", "total spend this run, in USD"],
      [`${g.warnGlyph}`, "an active alert on this run — the code after it names which one; a +N badge is how many more are waiting"],
      ["model · effort", "the model this run is using and its reasoning-effort level, bottom right"],
    ];
    const parts: SystemPart[] = [{ text: "lykos footer glossary — /usage and /context show the full numbers\n", token: "dim" }];
    for (const [glyph, desc] of rows) {
      parts.push({ text: `  ${glyph} `, token: "accent" }, { text: `${desc}\n`, token: "dim" });
    }
    return { text: parts.map((p) => p.text).join(""), parts };
  }

  /**
   * Every `ClickAction` this session can produce that a click's own gate
   * (the composer/`RawLineSource`, or `RawApprovalGate` while open) does
   * not already interpret itself — 2026-09-02 round nine, items 3 and 4.
   * Declared here, at the OUTER scope, rather than inside
   * `runOwningTheTerminal()`: `rawGate` (below) is constructed before
   * `pipeline`/`ui` exist, so it is wired to a stable reference to THIS
   * function rather than one that closes over them directly — the same
   * forward-reference trick `pipelineRef`/`handleRef` already use for the
   * identical timing problem.
   *
   * `approvalKey` never reaches here — `RawApprovalGate` applies it
   * directly, through the same guarded `decide()` a keyboard press uses,
   * so this function only ever sees the three kinds neither gate
   * understands on its own.
   */
  /** T114: set once the fullscreen path builds it — `handleClickAction` runs before it exists, same forward-reference shape as `pipelineRef`. */
  let browserRef: { toggle(height: number): void; setHeight(height: number): void } | null = null;

  function handleClickAction(action: ClickAction): void {
    try {
      dispatchClickAction(action);
    } catch (err) {
      // A click must never be able to end the session. Before this, an
      // exception raised in here propagated out of the stdin `data`
      // listener as an uncaught exception, and `ScreenTerminal`'s crash
      // handler did exactly what it promises — restored the terminal and
      // exited — so a mis-handled click read to the user as "it crashed and
      // now I can't do anything". The error goes into the transcript
      // instead, where it can be reported.
      uiRef?.writeSystem(`lykos: click handler failed (${action.kind}): ${(err as Error).message}`);
      pipelineRef?.flush();
    }
  }

  function dispatchClickAction(action: ClickAction): void {
    if (action.kind === "openBrowser") {
      // The header's back affordance. A second click closes it again —
      // one target, two directions, so it behaves like the button it looks
      // like rather than reloading the list on top of itself.
      // 2026-09-07 (UI feedback item 8): the FRAME's height, not the
      // viewport's. This was `viewportHeight()`, which excludes the header,
      // the composer and the footer — so a browser opened by CLICKING the
      // back button was laid out several rows shorter than the screen it
      // replaced, and the rows it did not fill kept showing whatever had
      // been under them. That is the "empty blank below the hint": the
      // keyboard route (Ctrl-B / Ctrl-Left) always passed the full height
      // and never showed it, which is why it survived this long.
      browserRef?.toggle(pipelineRef?.frameHeight ?? 24);
    } else if (action.kind === "toggleVerbose") {
      // Mirrors `runInteractiveLoop`'s own `/verbose` case exactly — this
      // function cannot call that one directly (it lives inside a
      // different async function, constructed after this one is already
      // wired up), so the two effects it has are reproduced here instead
      // of introducing a second, indirect calling path between them.
      if (uiRef) uiRef.view.toolsCollapsed = !uiRef.view.toolsCollapsed;
      const collapsed = uiRef?.view.toolsCollapsed ?? true;
      pipelineRef?.setExpanded(!collapsed);
      uiRef?.writeSystem(collapsed ? "tool results collapsed" : "tool results expanded");
      pipelineRef?.flush();
    } else if (action.kind === "openLink") {
      const opened = openUrl(action.url);
      uiRef?.writeSystem(opened ? `lykos: opening ${action.url}` : `lykos: could not open ${action.url} — no browser launcher found on this platform`);
      pipelineRef?.flush();
    } else if (action.kind === "showLegend") {
      // Round ten, item 3: "If the user click it once and do nothing,
      // clicking again should not generate the text." The glossary is
      // stateless — nothing distinguishes "still reading it" from "wants
      // it again" — so the signal used here is simpler and exact: if
      // nothing else has been pushed to the transcript since the last
      // time this ran, the glossary is still the last thing on screen and
      // a second click is a no-op rather than a second identical copy.
      if (pipelineRef?.lastBlockId() === FOOTER_LEGEND_BLOCK_ID) return;
      const legend = footerLegend();
      pipelineRef?.pushBlock({ id: FOOTER_LEGEND_BLOCK_ID, kind: "system", text: legend.text, parts: legend.parts });
      pipelineRef?.flush();
    } else if (action.kind === "copyText") {
      // Round thirteen, item 3. OSC 52 through the same stdout the frames
      // use — the terminal owns the clipboard, Lykos only asks — with the
      // platform's own copy tool as the fallback `tui/clipboard.ts` already
      // implements for the composer's Ctrl-C.
      copyToClipboard(action.text, { write: (t) => stdoutWrite(t) });
      const chars = action.text.length;
      uiRef?.writeSystem(`lykos: copied the ${action.label} to the clipboard (${chars} character${chars === 1 ? "" : "s"})`);
      pipelineRef?.flush();
    }
  }

  // Nothing may write to the terminal except the frame writer while the
  // alternate screen is up (io-mode.ts's `setStderrSink` doc). A diagnostic
  // becomes a system block in the transcript instead, where the scrollback
  // owns it and the frame diff can erase it. Diagnostics raised before the
  // pipeline exists (boot, model resolution) are held and pushed once it
  // does, rather than dropped.
  let stderrSeq = 0;
  const deferredStderr: string[] = [];
  const restoreStderr = setStderrSink((text) => {
    const trimmed = text.replace(/\n+$/, "");
    if (trimmed.length === 0) return;
    if (pipelineRef) pipelineRef.pushBlock({ id: `stderr-${stderrSeq++}`, kind: "system", text: trimmed });
    else deferredStderr.push(trimmed);
  });

  // T131: the project's remembered approvals and its last interaction mode.
  // Per project, exactly like `trust.json` — approving `npm test` here must
  // never approve it in a repo cloned this morning.
  const permissionProjectId = resolveProject(cwd).id;
  const storedPermissions = loadPermissions(permissionProjectId);

  // T111.2: one tally for the life of this session, handed to the gate that
  // makes the decisions and read back at session end. Only this path has
  // one: `runAppendOnlyInteractive` uses `TerminalApprovalGate`, which never
  // consults `decideForMode` and therefore has no tier or mode to attribute
  // a count to. That session records NULL, which is the honest answer.
  const approvalMetrics = new ApprovalMetrics();
  const gatePolicy = resolveGatePolicy(cwd, config.gate);
  const verifyCommand = gatePolicy.enabled && gatePolicy.command ? gatePolicy.command : undefined;

  const rawGate = new RawApprovalGate({
    projectId: permissionProjectId,
    cwd,
    verifyCommand,
    metrics: approvalMetrics,
    onRememberFolder: (folder) => {
      rememberExtraDir(permissionProjectId, folder);
      pipelineRef?.pushBlock({
        id: `remember-folder-${stderrSeq++}`,
        kind: "system",
        text: `allowed folder for this project: ${folder}`,
      });
      pipelineRef?.flush();
    },
    // T131: a refusal explains itself, in the transcript and (via the tool
    // result) to the model, so a denied mode is something it can plan around
    // rather than something it retries into.
    onDenied: (req, reason) => {
      pipelineRef?.pushBlock({
        id: `mode-denial-${stderrSeq++}`,
        kind: "system",
        text: `${MODE_INFO[rawGate.mode].label} mode refused ${req.kind}: ${req.detail}
${reason}`,
      });
      pipelineRef?.flush();
    },
    // T131: "always" writes command PATTERNS for this project, so friction
    // decays to zero with use instead of being reset by every restart.
    onRemember: (patterns) => {
      rememberAllow(permissionProjectId, patterns);
      rawGate.setAllowlist(loadPermissions(permissionProjectId).allow);
      pipelineRef?.pushBlock({
        id: `remember-${stderrSeq++}`,
        kind: "system",
        text: `remembered for this project: ${patterns.join(", ")}`,
      });
      pipelineRef?.flush();
    },
    // Push the prompt the first time and mutate it in place when the
    // decision lands, so the transcript keeps both the question and the
    // answer (2026-09-02 round three, item 11).
    onRender: (id, view) => {
      const block = { id, kind: "approval" as const, approval: view };
      if (!pipelineRef?.updateBlock(id, block)) {
        pipelineRef?.pushBlock(block);
        // A NEW, undecided prompt is the one thing allowed to yank a
        // scrolled-back viewport to the tail (2026-09-02 round six, item
        // 1) — see `ScreenPipeline.scrollToEnd()`. Never on an update: the
        // decision landing must not move the view a second time.
        if (!view.decision) pipelineRef?.scrollToEnd();
      }
      pipelineRef?.flush();
    },
    onScroll: (action) => {
      if (action === "pageUp") pipelineRef?.pageUp();
      else if (action === "pageDown") pipelineRef?.pageDown();
      else if (action === "wheelUp") pipelineRef?.scrollUp(3);
      else pipelineRef?.scrollDown(3);
    },
    onInterrupt: () => handleRef?.interrupt(),
    // Show the approved command's own output before the next prompt
    // (2026-09-02 round seven, item 4). The signal that releases the next
    // one is `createFullscreenAgentUi`'s `onToolEnd`, wired below.
    deferAdvance: true,
    // 2026-09-02 round nine, item 3: while this gate is open it is the
    // ONLY thing routeStdin() delivers mouse bytes to, so a click on a
    // fold hint or a link sitting in the transcript above the prompt has
    // to resolve here too, not just a click on the prompt's own pills.
    resolveClick: (row, col) => pipelineRef?.actionAt(row, col) ?? null,
    onAction: handleClickAction,
    // Round eleven, item 1: the pipeline decides whether a pointer move
    // is worth a repaint — see `ScreenPipeline.setHover()`. `flush()`
    // rather than waiting for the scheduler's next tick, for the same
    // reason `onRender` above flushes: while the gate is open nothing
    // else is driving the frame.
    onHover: (row, col) => {
      pipelineRef?.setHover(row, col);
      pipelineRef?.flush();
    },
  });
  rawGate.setAllowlist(storedPermissions.allow);
  /**
   * T131: the mode change reaches the model as a CONVERSATION message, drained
   * into the next prompt — never as a head block. T17 freezes the system
   * prompt for the whole session, so a plan-mode block appearing on a
   * keystroke would rewrite the cache prefix and trip the drift detector.
   */
  let pendingModeNotice: string | undefined;
  const applyInteractionMode = (mode: InteractionMode): void => {
    rawGate.setMode(mode);
    rememberMode(permissionProjectId, mode);
    pendingModeNotice = modeSwitchNotice(mode);
    pipelineRef?.setHeader({ permissionMode: MODE_INFO[mode].label });
    uiRef?.writeSystem(`mode: ${MODE_INFO[mode].label} — ${MODE_INFO[mode].description}`);
    pipelineRef?.flush();
  };
  // A restored mode has to be ANNOUNCED, not just set. Reopening a project
  // that was last driven in Ask would otherwise start the model read-only
  // with no way to know it, so it would discover the rule by being refused.
  // The header reads `rawGate.mode` directly, so this only has to supply the
  // notice; `pipelineRef`/`uiRef` do not exist yet at this point.
  // T209 / ADR-0041: startingMode supplies the permission mode (Manual on first run,
  // remembered per project). An explicit start-up --mode in an interactive session
  // is remembered. A specialist never sets the permission mode.
  const explicitStartupMode = shared.input.mode;
  if (explicitStartupMode !== undefined) {
    rememberMode(permissionProjectId, explicitStartupMode, shared.input.permissionsOpts);
  }
  const initialMode = explicitStartupMode ?? startingMode(permissionProjectId, shared.input.permissionsOpts);
  rawGate.setMode(initialMode);
  pendingModeNotice = modeSwitchNotice(initialMode);
  let gate = resolveApprovalGate({ autoApprove: shared.input.autoApprove === true, interactiveGate: rawGate });
  const specialist = shared.input.specialist ?? DEFAULT_SPECIALIST;
  if (canSealAllowanceEverAllow({ cwd, config, specialist })) {
    const allowance = createSealTestCommandAllowance({
      cwd,
      config,
      specialist,
    });
    gate = wrapApprovalGateWithSealAllowance(gate, allowance);
  }

  interface RunOutcome {
    booted: BootedStandaloneSession;
    state: StandaloneSessionState;
    loopResult: InteractiveLoopResult;
    /** T53: undefined only for a `:memory:` ledger, which has no session directory. */
    recorder: LiveTranscriptRecorder | undefined;
  }

  let outcome: RunOutcome;
  try {
    outcome = await runOwningTheTerminal();
  } finally {
    // Restored the moment the alternate screen is given back, and before
    // `finishInteractiveSession()` prints anything to the normal buffer —
    // holding the sink past that point would swallow the outcome question.
    restoreStderr();
    for (const text of deferredStderr.splice(0)) process.stderr.write(`${text}\n`);
  }

  async function runOwningTheTerminal(): Promise<RunOutcome> {
    return term.run<RunOutcome>(async () => {
    const terminalAsk = new TerminalAsk(
      () => lineSource.next(),
      { write: (chunk: string) => stdoutWrite(String(chunk)) },
      // Rendered through the existing system-message channel rather than a
      // new AgentUi method: the question is a system block, and adding a
      // renderer to two surfaces to say four lines is surface for its own
      // sake.
      (req) => ui?.writeSystem(renderAskPrompt(req)),
    );
    const booted = await bootInteractiveSession(shared, {
      gate,
      // T103: the full-screen surface renders the question as a block and
      // then reads the answer off the same raw line source the gate uses.
      askHuman: terminalAsk.ask,
      // T131: the exit-plan tool's channel. Deliberately the SAME
      // `TerminalAsk` instance as `askHuman` above rather than a second
      // reader: that class exists to serialise onto one outstanding read, and
      // two independent readers on one line source would let a single typed
      // line answer both a question and a plan approval.
      currentMode: () => rawGate.mode,
      requestPlanExit: async (plan) => {
        const answer = await terminalAsk.ask({
          question: `${plan}

Start carrying this plan out?`,
          assumption: PLAN_STAY,
          options: [PLAN_CONTINUE_AUTO, PLAN_CONTINUE_MANUAL, PLAN_STAY],
        });
        const chosen = parseAskAnswer(answer, {
          question: "",
          assumption: PLAN_STAY,
          options: [PLAN_CONTINUE_AUTO, PLAN_CONTINUE_MANUAL, PLAN_STAY],
        });
        if (chosen === PLAN_CONTINUE_AUTO) {
          applyInteractionMode("auto");
          return "auto";
        }
        if (chosen === PLAN_CONTINUE_MANUAL) {
          applyInteractionMode("manual");
          return "manual";
        }
        // Anything else — free text, an empty line, a closed channel — keeps
        // Plan mode. Leaving a read-only mode is never the default answer.
        return null;
      },
    });
    // T131: hand the discovered skills to the command surface, so `/handoff`
    // both completes and dispatches. The roster differs per project, which is
    // the one thing the old `const` registry could not express.
    setSkillCommands(booted.skillRoster);
    // Ticket 04: same reasoning, for `/specialist <name>`'s Tab-completion.
    setSpecialistNames(specialistNamesFor(cwd, defaultGlobalDir()));
    setOutputStyleNames(outputStyleNamesFor(cwd, defaultGlobalDir()));
    // P10.9 (ticket 21, D5): the extension-registered slash commands.
    setExtensionCommands(booted.extensionHost.commands());
    // T163: the Pi extensions' commands too; a shadowed one is named.
    for (const line of registerPiCommands(booted)) stderrWrite(`lykos: ${line}\n`);

    const { session } = booted;
    const { state, unsubscribe } = subscribeStandaloneUsage(booted);
    const { recorder, detach } = startLiveCapture({
      ledgerPath,
      booted,
      session,
      modelSpec,
      modelSource: boot.source,
      providers: config.providers,
      ...(input.trustSource !== undefined ? { trustSource: input.trustSource } : {}),
      executionShape: "standalone",
      // Deliberately no `resumedFrom` — see the append-only path above.
      ...(input.resume?.taskId !== undefined ? { taskId: input.resume.taskId } : {}),
      ...(input.resume?.projectId !== undefined ? { projectId: input.resume.projectId } : {}),
      ...(input.continuation !== undefined
        ? {
            ...(input.continuation.taskId !== undefined ? { taskId: input.continuation.taskId } : {}),
            ...(input.continuation.projectId !== undefined ? { projectId: input.continuation.projectId } : {}),
            resumedFrom: input.continuation.predecessorSessionId,
            continuationsUsed: input.continuation.index,
          }
        : {}),
    });

    if (input.resume) await injectReplay(session, recorder, input.resume);

    const headerInfo = {
      // T114: this is the only shape where the affordance is real — it is a
      // click target, and `lykos show`'s header has nothing to click.
      back: true,
      product: "LYKOS",
      version: lykosVersion(),
      model: modelSpec,
      cwd,
      branch: null,
      sessionId: session.sessionId,
      executionShape: "standalone",
      permissionMode: MODE_INFO[rawGate.mode].label,
      ...(booted.specialistName !== undefined ? { specialist: booted.specialistName } : {}),
    };
    const pipeline = new ScreenPipeline({
      width,
      height,
      theme,
      header: headerInfo,
      sink: { write: (t: string) => stdoutWrite(t) },
      completionAbove: config.ui.completion_position !== "below",
    });
    pipelineRef = pipeline;
    // Ticket 04: `/specialist`'s live half. `onSwitched` repaints the pinned
    // header — the one region on this surface that is genuinely "displayed
    // continuously" rather than scrolled past.
    const specialistSwitcher = createSpecialistSwitcher({
      cwd,
      session,
      modelRuntime,
      initialConfig: config,
      initialSpecialistName: booted.specialistName,
      toolsOverride: input.tools,
      state,
      events: booted.extensionHost.sink,
      onSwitched: (name) => {
        pipeline.setHeader({ specialist: name });
        pipeline.flush();
      },
      readOnlyPosture: booted.readOnlyPosture,
      initialSpecialistMessage: booted.specialistMessage,
      currentMode: () => rawGate.mode as InteractionMode,
    });
    const outputStyleSwitcher = createOutputStyleSwitcher({
      cwd,
      globalDir: defaultGlobalDir(),
      initialOutputStyleName: config.output_style,
    });
    for (const text of deferredStderr.splice(0)) pipeline.pushBlock({ id: `stderr-${stderrSeq++}`, kind: "system", text });
    let currentWidth = width;
    let currentHeight = height;
    const stopResize = term.onResize((size) => {
      currentWidth = size.columns;
      currentHeight = size.rows;
      pipeline.resize(size.columns, size.rows);
      // T114: a full view owns every row, so it has to be re-rendered at
      // the new size here — `pipeline.resize()` redraws the frame, but the
      // lines a full view supplied were laid out for the old one.
      browserRef?.setHeight(pipeline.frameHeight);
      // 2026-09-02 round five, item 4: "you see the two bar does not reach
      // the end" after resizing. `pipeline.resize()` forces a full redraw
      // at the new width, but the composer's own rows — including its two
      // border rules, each built as `hbar.repeat(width)` — were computed at
      // the OLD width by the last `paintComposer()` call and only
      // recomputed on the next keystroke. Between a resize and whatever the
      // user typed next, the frame writer was clipping/padding a bar sized
      // for the previous terminal width into the new one, which left it
      // visibly short on a widen. `paintComposer` and `lineSource` are
      // referenced here via closure — both are assigned further down this
      // function but this callback only ever runs later, after setup has
      // finished, so the reference is safe despite the declaration order.
      paintComposer(lineSource.editorState);
    });

    const ui = createFullscreenAgentUi({
      pipeline,
      header: headerInfo,
      ledgerPath,
      config,
      startedUtc: booted.startedAt,
      theme,
      // Read fresh on every HUD write: `/effort` changes one of these and
      // every turn changes the other (2026-09-02 item 6).
      live: () => ({
        contextUsage: session.getContextUsage?.(),
        thinkingLevel: session.thinkingLevel,
        model: modelSpec,
      }),
      onToolEnd: () => rawGate.advance(),
    });
    uiRef = ui;
    // P14.6 ticket 06: `/login`, `/credential`, and the one-line rotation notice.
    const credentialCommands = createCredentialCommands({ session, config });
    const stopRotationNotices = showRotationNotices(shared.rotations, (line) => {
      ui.writeSystem(line);
      pipeline.flush();
    });

    // 2026-09-01 UI feedback: "Pi shows context, skills, extensions,
    // really useful, add this" — real boot-time counts, pushed once
    // before the first frame so it's the first thing on screen, the same
    // place Pi's own CLI shows its startup banner.
    pipeline.pushBlock({
      id: "resources-boot",
      kind: "resources",
      resources: {
        contextEnabled: booted.promptDietEnabled,
        contextFiles: booted.frozenContextFiles.map((f) => basename(f.path)),
        contextTokens: booted.frozenContextFiles.reduce((n, f) => n + Math.ceil(f.bytes / 4), 0),
        skills: booted.skillNames,
        // T97 follow-up: what actually LOADED on this host, not a hardcoded
        // empty list. A declared package that is missing here is reported on
        // stderr at boot and is deliberately not listed, because this panel
        // answers "what is in force".
        extensions: booted.hostExtensions.loaded.map((e) => e.name),
      },
    });
    // T124: the session-owned list is a live block, not a repeated system
    // message. The sink is installed by live capture, so wrap it after both
    // pieces exist and keep its persistence behavior intact.
    const taskBlockId = "session-tasks";
    pipeline.pushBlock({ id: taskBlockId, kind: "tasks", items: booted.taskList.items });
    const previousTaskWrite = booted.taskListSink.write;
    booted.taskListSink.write = (next) => {
      previousTaskWrite?.(next);
      pipeline.updateBlock(taskBlockId, { id: taskBlockId, kind: "tasks", items: next.items });
      pipeline.flush();
    };

    // The footer's triad, the context gauge and the model/effort badge all
    // come from `writeHud`, which nothing called until a turn had finished —
    // so the whole bottom of the screen was blank until the user had chatted
    // at least once (2026-09-02 round three, item 6). One call at boot, with
    // the session's own zeroed usage, fills it from the first frame.
    ui.writeHud(state, session.sessionId);

    const unsubUi = session.subscribe
      ? ui.attach({ subscribe: (fn) => session.subscribe!((ev) => fn(ev as import("../tui/s0.js").StreamEvent)) }, () => state)
      : undefined;

    let composerRowCount = 1;
    let composerRowMap: Array<{ logicalRow: number; startCol: number; endCol: number }> = [];
    let composerRowOffset = 0;
    const paintComposer = (editorState: Parameters<typeof renderComposer>[0]) => {
      // The border rules carry the current reasoning effort as a brightness
      // (2026-09-02 round three, item 7). Read live off the session on every
      // repaint rather than cached: `/effort` changes it between keystrokes.
      const composer = renderComposer(editorState, theme, currentWidth, session.thinkingLevel ?? null, composerMaxRows(currentHeight));
      // The VISUAL row count, not the logical one — soft word-wrap
      // (2026-09-02 round five) can turn one logical line into several
      // rendered rows, and `rowCount` here is what the mouse handler uses
      // to decide whether a click landed in the composer at all.
      composerRowCount = composer.lines.length - 2;
      composerRowMap = composer.rowMap;
      composerRowOffset = composer.windowStart;
      pipeline.setComposerLines([...composer.lines]);
      pipeline.setCursor({ row: pipeline.composerTopRow() + composer.cursorRow, col: composer.cursorCol });
    };

    // ------------------------------------------------------------------
    // T114 — the session browser, openable without ending the session.
    //
    // It is a scrollback block, not an overlay: the overlay primitive was
    // deleted on 2026-09-02 when the approval modal became a block, and
    // this task is not the reason to bring it back.
    // ------------------------------------------------------------------
    /** Set once `lineSource` exists — the browser hands it `/resume <id>`, and the two are mutually referential. */
    let injectLine: ((text: string) => void) | null = null;
    /**
     * Item 2 + item 3: what THIS session is called right now, so the row the
     * browser synthesises for it carries a name rather than a bare id. Set
     * by `/rename`, and left null until then — the derived name is computed
     * by the preview layer from the transcript, which the browser reads
     * anyway.
     */
    let currentSessionName: string | null = null;
    // Transcripts are read once per session and kept, because the preview
    // pane is asked for the highlighted row on every cursor move.
    const previewCache = new PreviewCache();
    const loadBrowserScope = (
      sources: Array<{ ledgerPath: string; workspace: string; projectName: string | null }>,
      scope: "project" | "all",
    ) => {
      const started = Date.now();
      const readable = sources.filter((source) => fileExists(source.ledgerPath));
      const failures = sources
        .filter((source) => !fileExists(source.ledgerPath))
        .map((source) => ({ project: source.projectName ?? basename(source.workspace), reason: "no ledger yet — this project has no recorded sessions" }));
      let rows: SessionListRow[] = [];
      const gathered: SessionListRow[] = [];
      for (const source of readable) {
        try {
          gathered.push(...gatherSessions([source]).rows);
        } catch (err) {
          failures.push({ project: source.projectName ?? basename(source.workspace), reason: (err as Error).message });
        }
      }
      // 2026-09-07 (UI feedback item 3): the session this browser was
      // opened FROM belongs in the list.
      //
      // It has no `sessions` row yet — ingest writes one when the session
      // ends — so it is synthesised here from what this process already
      // knows about itself, and marked so the renderer can say which one it
      // is. This is the only row in the list that is not read from a
      // ledger, and it is deliberately built from the same fields the real
      // one will carry so that the row does not visibly change shape at the
      // moment the session ends.
      //
      // A CONTINUED session (item 1) already has a row, because it is the
      // one being continued: the synthetic row is skipped and the real one
      // is marked instead, so a resumed session appears exactly once.
      const currentId = session.sessionId;
      const currentName = currentSessionName ?? undefined;
      let sawCurrent = false;
      rows = nestSessions(gathered).map((row) => {
        const live = row.ledgerPath ? readLiveSnapshot(row.ledgerPath, row.id) : null;
        if (row.id === currentId) {
          sawCurrent = true;
          return {
            ...row,
            heartbeatUtc: live?.heartbeatUtc ?? null,
            ...(currentName !== undefined ? { brief: currentName } : {}),
            isCurrent: true,
            isRunning: !session.isIdle,
            endedUtc: null,
            closedUtc: null,
            callCount: Math.max(row.callCount ?? 0, state.usage.calls.length),
          };
        }
        return { ...row, heartbeatUtc: live?.heartbeatUtc ?? null };
      });
      if (!sawCurrent && sources.some((source) => source.ledgerPath === ledgerPath)) {
        rows = [
          {
            id: currentId,
            taskId: null,
            taskBrief: null,
            brief: currentName ?? null,
            startedUtc: booted.startedAt,
            endedUtc: null,
            model: modelSpec,
            executionShape: "standalone",
            outcome: null,
            outcomeSource: null,
            archiveState: "recent",
            captureMode: "stream",
            // Nothing in the browser may offer to resume the session you are
            // already in; `browserKey` refuses it on `isCurrent` before it
            // ever reads this, and the reason is stated rather than implied.
            resumable: false,
            notResumableReason: "this is the session you are in",
            parentSessionId: null,
            resumedFrom: null,
            closedUtc: null,
            deletedUtc: null,
            heartbeatUtc: null,
            isCurrent: true,
            isRunning: !session.isIdle,
            callCount: state.usage.calls.length,
            projectName: basename(cwd),
            projectPath: cwd,
            ledgerPath,
            costUsd: state.usage.calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0),
            durationSeconds: null,
            depth: 0,
            edge: null,
          },
          ...rows,
        ];
      }
      const fanout = {
        elapsedMs: Date.now() - started,
        projectsScanned: sources.length,
        rowsReturned: rows.length,
      };
      // The current row is not in SQLite until the session ends; the
      // snapshot carries this measurement through the ordinary ingest path.
      (state as StandaloneSessionState & { browserFanout?: typeof fanout }).browserFanout = fanout;
      return { rows, failures, fanout };
    };
    const browserOverlay = new BrowserOverlay({
      source: {
        load: () => loadBrowserScope([{ ledgerPath, workspace: cwd, projectName: basename(cwd) }], "project"),
        loadAll: () => loadBrowserScope(allProjectSources(), "all"),
        preview: (row: SessionListRow) =>
          previewCache.get(row.ledgerPath ?? ledgerPath, row.id, row.brief ?? row.taskBrief),
      },
      onRender: (state: BrowserState, _viewHeight: number) => {
        // Item 8: the frame's OWN height, never a separately tracked one.
        const viewHeight = pipeline.frameHeight;
        // The browser IS the screen while it is open — see
        // `ScreenPipeline.setFullView()`. It is not a block: a list of
        // sessions is not part of the conversation and must not be left
        // behind in its scroll history.
        pipeline.setFullView(
          renderBrowserView(state, {
            width: currentWidth,
            height: viewHeight,
            theme,
            preview: (row: SessionListRow) =>
              previewCache.get(row.ledgerPath ?? ledgerPath, row.id, row.brief ?? row.taskBrief),
          }),
        );
        pipeline.flush();
      },
      onClose: () => {
        pipeline.setFullView(null);
        pipeline.flush();
      },
      onSelect: (row: SessionListRow) => {
        // Ends this session and resumes the chosen one. T116 replaces the
        // process restart with an in-process resume; the rule that a resume
        // is a NEW session with `resumed_from` set is the same either way.
        injectLine?.(`/resume ${row.id}`);
      },
      onNew: () => injectLine?.("/__new"),
      onCloseSession: (row) => {
        // Items 7 and 10. `browser.ts` has already refused to send this for
        // a running session, so this only ever closes a session nothing is
        // driving. The write is one UPDATE and it is the ledger's, not a
        // second state machine's.
        const path = row.ledgerPath ?? ledgerPath;
        try {
          closeSessionForBrowser(path, row.id);
        } catch (err) {
          uiRef?.writeSystem(`lykos: could not close ${row.id.slice(0, 8)} — ${(err as Error).message}`);
        }
      },
      onDelete: (row) => {
        if (!row.ledgerPath) {
          uiRef?.writeSystem("lykos: cannot delete this row because its ledger source is unknown");
          return;
        }
        try {
          deleteSessionConversation(row.ledgerPath, row.id);
          uiRef?.writeSystem(`lykos: deleted conversation ${row.id.slice(0, 8)}; accounting remains`);
        } catch (err) {
          uiRef?.writeSystem(`lykos: delete failed — ${(err as Error).message}`);
        }
      },
    });
    browserRef = browserOverlay;
    const rewindOverlay = new RewindOverlay({
      load: () => listCheckpoints({ cwd }),
      onRender: (rewindState, viewHeight) => {
        pipeline.setFullView(renderRewind(rewindState, { width: currentWidth, height: viewHeight, theme }));
        pipeline.flush();
      },
      onClose: () => {
        pipeline.setFullView(null);
        pipeline.flush();
      },
      onRestore: (index) => {
        const result = restoreCheckpoint({ cwd }, index);
        uiRef?.writeSystem(result.status === "restored"
          ? `rewind restored checkpoint ${result.commit.slice(0, 8)} — ${result.label}`
          : `rewind failed — ${result.message}`);
        pipeline.flush();
      },
    });

    const lineSource = new RawLineSource({
      history: loadHistory(cwd),
      workspace: cwd,
      onInterrupt: () => {
        // Deny anything the gate is still holding before aborting. While
        // `deferAdvance` (2026-09-02 round seven, item 4) is waiting for
        // the approved command's output, the gate is deliberately NOT open
        // — stdin is back with the composer — so a Ctrl-C typed in that
        // gap arrives here rather than at the gate. Without this the
        // queued requests would sit there until the watchdog promoted
        // them, popping a prompt onto the screen seconds after the user
        // cancelled the very turn they belonged to.
        rawGate.close();
        handleRef?.interrupt();
      },
      onChange: paintComposer,
      onScroll: (action) => {
        // 3 lines per wheel notch is the common terminal-app convention (xterm, iTerm2, Windows Terminal).
        if (action === "pageUp") pipeline.pageUp();
        else if (action === "pageDown") pipeline.pageDown();
        else if (action === "wheelUp") pipeline.scrollUp(3);
        else pipeline.scrollDown(3);
      },
      completionRoot: cwd,
      // 2026-09-02 (UI feedback item 8). Copying goes out as OSC 52 on the
      // same stdout the frames use — the terminal, not Lykos, owns the
      // clipboard. Pasting shells out, because no terminal will let a
      // program READ the clipboard through an escape sequence; both are
      // best-effort and the editor's own register covers the gap.
      onCopy: (text) => void copyToClipboard(text, { write: (t) => stdoutWrite(t) }),
      readClipboard: () => readClipboard(),
      composerGeometry: () => ({
        // +1 for the composer's own top border rule: buffer row 0 is the
        // row after it.
        firstBufferRow: pipeline.composerTopRow() + 1,
        prefixWidth: COMPOSER_PREFIX_WIDTH,
        rowCount: composerRowCount,
        rowMap: composerRowMap,
        rowOffset: composerRowOffset,
      }),
      onCompletionChange: (candidates, selected) => {
        if (candidates.length === 0) {
          pipeline.setCompletionPopup(null);
          return;
        }
        const popup = renderCompletionPopup(candidates, { width: currentWidth, theme, selected });
        pipeline.setCompletionPopup(popup);
      },
      // 2026-09-02 round nine, item 3: the tab completer's own fixed frame
      // region, so a click on a candidate row can select AND accept it.
      completionGeometry: () => ({ firstRow: pipeline.completionTopRow() }),
      // Everything outside the composer and the completion popup — an
      // approval's pills, a fold hint, a link, the footer's legend.
      resolveClick: (row, col) => pipeline.actionAt(row, col),
      onAction: handleClickAction,
      // Round eleven, item 1. No flush here: the scheduler's own tick is
      // what paints during normal editing, and hover has no more claim on
      // an immediate frame than a keystroke does.
      onHover: (row, col) => pipeline.setHover(row, col),
      // T114: Ctrl-B is the keyboard half of the header's back affordance.
      // A mouse-only gesture is unusable over a connection with no mouse
      // reporting, which is most of the ways people reach a remote shell.
      onCtrlKey: (key) => {
        if (key === "b") {
          browserOverlay.toggle(pipeline.frameHeight);
          return true;
        }
        if (key === "f") {
          lineSource.beginTranscriptSearch();
          return true;
        }
        if (key === "g") {
          pipeline.scrollToEnd();
          return true;
        }
        if (key === "l") {
          uiRef?.writeSystem("model picker — type /model <provider/model> (session-only)");
          pipeline.flush();
          return true;
        }
        if (key === "p") {
          if (!session.isIdle) {
            uiRef?.writeSystem("lykos: model cannot change while a turn is in flight");
          } else {
            void session.cycleModel("forward", { persist: false }).then((next) => {
              if (!next) {
                uiRef?.writeSystem("lykos: no alternate model is available");
                return;
              }
              const ref = `${next.model.provider}/${next.model.id}`;
              if (state.currentModel !== ref) {
                state.modelPath = state.modelPath ? `${state.modelPath}>${ref}` : `${state.initialModel}>${ref}`;
                state.modelSwitches = (state.modelSwitches ?? 0) + 1;
                state.currentModel = ref;
              }
              pipeline.setHeader({ model: ref });
              uiRef?.writeHud(state, session.sessionId);
              uiRef?.writeSystem(`model is now ${ref}`);
              pipeline.flush();
            }).catch((err) => uiRef?.writeSystem(`lykos: model switch refused — ${(err as Error).message}`));
          }
          return true;
        }
        return false;
      },
      onShiftTab: () => {
        if (!session.isIdle) {
          uiRef?.writeSystem("lykos: specialist cannot change while a turn is in flight");
          pipeline.flush();
          return true;
        }
        const list = primarySpecialists(cwd, defaultGlobalDir());
        if (list.length === 0) return true;
        const current = specialistSwitcher.currentSpecialistName();
        const currentIndex = current !== undefined ? list.indexOf(current) : -1;
        const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % list.length : 0;
        const next = list[nextIndex]!;
        void specialistSwitcher.switchSpecialist(next).then((outcome) => {
          uiRef?.writeHud(state, session.sessionId);
          if (outcome.ok) {
            uiRef?.writeSystem(outcome.report);
          } else {
            uiRef?.writeSystem(`lykos: specialist switch refused — ${outcome.message}`);
          }
          pipeline.flush();
        }).catch((err) => {
          uiRef?.writeSystem(`lykos: specialist switch refused — ${(err as Error).message}`);
          pipeline.flush();
        });
        return true;
      },
      onAltArrow: (direction) => {
        if (direction !== "left") return false;
        browserOverlay.toggle(pipeline.frameHeight);
        return true;
      },
      onTranscriptSearchQuery: (query) => pipeline.setStatus(`search: ${query || "type to search"} · Enter apply · Esc close`),
      onTranscriptSearchSubmit: (query) => {
        pipeline.setStatus(null);
        pipeline.searchTranscript(query);
        pipeline.flush();
      },
      onTranscriptSearchCancel: () => {
        pipeline.setStatus(null);
        pipeline.searchTranscript("");
        pipeline.flush();
      },
      onTranscriptSearchMove: (direction) => {
        if (direction === "next") pipeline.nextTranscriptMatch();
        else pipeline.previousTranscriptMatch();
        pipeline.flush();
      },
      onDoubleEscape: () => {
        if (rewindOverlay.isOpen) rewindOverlay.close();
        else rewindOverlay.open(currentHeight);
        return true;
      },
    });
    injectLine = (text: string) => lineSource.inject(text);
    // Order is priority: an approval raised while the browser is open still
    // gets the keystroke that answers it.
    const stopRouter = routeStdin({ stdin: process.stdin, primary: lineSource, overlay: [rawGate, rewindOverlay, browserOverlay] });
    // Nothing marks the frame dirty until the first keystroke or streamed
    // event otherwise — the screen stays blank (T41 hid the cursor and
    // entered the alt buffer, but painted nothing) until the user types,
    // which reads as "I have to click into the terminal before anything
    // shows up." Paint the empty composer once, immediately, so the prompt
    // is visible the moment the alt screen opens.
    paintComposer(lineSource.editorState);

    let loopResult: InteractiveLoopResult;
    try {
      loopResult = await runInteractiveLoop({
        session,
        lineSource,
        state,
        ledgerPath,
        config,
        modelSpec,
        contained: shared.containment !== undefined && shared.containment.record.used !== "off",
        runExtensionCommand: (name, args) => booted.extensionHost.runCommand(name, args),
        currentModel: () => {
          const current = session.model;
          return current ? `${current.provider}/${current.id}` : modelSpec;
        },
        currentMode: () => rawGate.mode,
        setMode: (mode) => applyInteractionMode(mode),
        takeModeNotice: () => {
          const notice = pendingModeNotice;
          pendingModeNotice = undefined;
          return notice;
        },
        projectId: permissionProjectId,
        ...(shared.input.permissionsOpts !== undefined ? { permissionsOpts: shared.input.permissionsOpts } : {}),
        onPermissionsChange: () => {
          rawGate.setAllowlist(loadPermissions(permissionProjectId, shared.input.permissionsOpts).allow);
        },
        setModel: async (spec, persist) => {
          const next = await resolveHostModel(spec, modelRuntime);
          await session.setModel(next, { persist });
          pipeline.setHeader({ model: `${next.provider}/${next.id}` });
          pipeline.flush();
          return `${next.provider}/${next.id}`;
        },
        cycleModel: async () => {
          const next = await session.cycleModel("forward", { persist: false });
          if (!next) return undefined;
          pipeline.setHeader({ model: `${next.model.provider}/${next.model.id}` });
          pipeline.flush();
          return `${next.model.provider}/${next.model.id}`;
        },
        listSpecialists: specialistSwitcher.listSpecialists,
        takeSpecialistNotice: specialistSwitcher.takeSpecialistNotice,
        switchSpecialist: async (name) => {
          const outcome = await specialistSwitcher.switchSpecialist(name);
          ui.writeHud(state, session.sessionId);
          pipeline.flush();
          return outcome;
        },
        listOutputStyles: outputStyleSwitcher.listOutputStyles,
        switchOutputStyle: outputStyleSwitcher.switchOutputStyle,
        takeOutputStyleNotice: outputStyleSwitcher.takeOutputStyleNotice,
        ui,
        compactionRecords: () => compactionRecordsOf(booted),
        contextInfo: () => ({
          systemPromptChars: session.systemPrompt.length,
          contextFiles: booted.frozenContextFiles.map((f) => ({ name: basename(f.path), bytes: f.bytes })),
          skills: booted.skillNames,
          toolNames: session.getActiveToolNames(),
        }),
        onExpandedChange: (expanded) => pipeline.setExpanded(expanded),
        // Round thirteen, item 4: repaint the composer so its border rules
        // pick up the new effort colour immediately, instead of waiting
        // for the next keystroke to do it as a side effect.
        onEffortChange: () => {
          paintComposer(lineSource.editorState);
          pipeline.flush();
        },
        // Round thirteen, item 3: the same OSC 52 path the composer's own
        // Ctrl-C uses, and the same message a click-to-copy produces, so
        // `/copy` and clicking an answer's hint are one behaviour reached
        // two ways.
        onCopyText: (text, label) => handleClickAction({ kind: "copyText", text, label }),
        // Item 2: the name is visible immediately — in the browser's row for
        // this session, and in the ledger the moment the session ends.
        onRename: (name) => {
          currentSessionName = name;
        },
        onReady: (handle) => {
          handleRef = handle;
          input.onReady?.(handle);
        },
        ...(recorder !== undefined ? { recorder } : {}),
        ...(input.continuation !== undefined ? { initialPrompt: input.continuation.prompt } : {}),
        continuationRequested: () => booted.continuationState.requested,
        login: credentialCommands.login,
        credential: credentialCommands.credential,
      });
    } finally {
      stopRotationNotices();
      stopRouter();
      stopResize();
      unsubUi?.();
      unsubscribe();
      detach();
      lineSource.close();
      pipeline.stop();
    }

    return { booted, state, loopResult, recorder };
    });
  }

  return finish({
    booted: outcome.booted,
    session: outcome.booted.session,
    state: outcome.state,
    loopResult: outcome.loopResult,
    ...(outcome.recorder !== undefined ? { recorder: outcome.recorder } : {}),
    approvals: approvalMetrics,
    model,
    boot,
    config,
    cwd,
    ledgerPath,
    label: input.label,
    askOutcome: input.askOutcome,
    ...(input.resume !== undefined ? { resume: input.resume } : {}),
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.continuation !== undefined ? { continuation: input.continuation } : {}),
    outcomeLineSource: createReadlineLineSource(),
    outcomeWrite: (text) => stderrWrite(`${text}\n`),
  });
}

