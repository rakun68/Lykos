import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { ResolvedConfig } from "../config/types.js";
import { DEFAULT_SPECIALIST, discoverSpecialists } from "../config/specialists.js";
import { globalConfigPath, projectConfigPath } from "../config/load.js";
import { runProviderAdd } from "../config/provider-add.js";
import { BUILTIN_PROVIDERS } from "../config/provider-table.js";
import {
  applySpecialistGuardEnv,
  formatSpecialistChangeReport,
  formatSpecialistList,
  specialistNamesFor,
  resolveSpecialistSwitch,
} from "../session/specialist-switch.js";
import { specialistStreamMessage } from "../session/specialist-stream.js";
import { sessionOptions, type SessionOptions } from "../session/session-options.js";
import { compactionRecordsOf } from "../loop/self-compact.js";
import { stdoutWrite, stderrWrite } from "../io-mode.js";
import { detectColorCapability, detectGlyphSet, resolveTheme } from "./theme/resolve.js";
import { createAgentUi, type AgentUi } from "./s0.js";
import {
  bootInteractiveSession,
  createReadlineLineSource,
  injectReplay,
  writeInteractiveBootRow,
  PLAN_CONTINUE_AUTO,
  PLAN_CONTINUE_MANUAL,
  PLAN_STAY,
  runInteractiveLoop,
  type InteractiveHandle,
  type InteractiveLoopResult,
  type RunInteractiveStandaloneSessionResult,
  type StandaloneBootInputs,
} from "../session/interactive.js";
import type { ReadOnlyPosture } from "../gate/approval.js";
import { ApprovalMetrics } from "../gate/approval-metrics.js";
import { AutoApproveGate, TerminalApprovalGate } from "../gate/approval.js";
import { ModeGate } from "../gate/mode-gate.js";
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
import { reloadProviders } from "../session/provider-models.js";
import {
  parseAskAnswer,
  TerminalAsk,
} from "../tools.js";
import { registerPiCommands } from "./pi-commands.js";
import { setExtensionCommands, setOutputStyleNames, setSpecialistNames, setSkillCommands } from "./commands.js";
import { createOutputStyleSwitcher, outputStyleNamesFor } from "../config/output-styles.js";
import { createCredentialCommands, showRotationNotices } from "./credential-commands.js";
import type { LykosEventSink } from "../extensions/api.js";
import { loadPermissions, rememberAllow, rememberMode, startingMode } from "../gate/permissions.js";
import {
  MODE_INFO,
  modeSwitchNotice,
  type InteractionMode,
} from "../gate/modes.js";
import { resolveProject } from "../session/identity.js";
import { resolveGatePolicy } from "../gate/verify-gate.js";
import type { StandaloneSessionState } from "../session/session.js";
import { askAside } from "../session/aside.js";
import { skillsHeadCost } from "../session/skills.js";
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
  const projectId = resolveProject(cwd).id;
  const permissionsOpts = input.permissionsOpts;
  // T131 / P5 #55: the interaction modes, in front of the gate that asks. Never in front of `--yes`: a gate
  // that allows everything has no mode to apply.
  const approvals = input.interactionModes === true && !(gate instanceof AutoApproveGate) ? new ApprovalMetrics() : undefined;
  let modes: ModeGate | undefined;
  /** A mode change reaches the model as a conversation message drained into the next prompt, never a head block (T17). */
  let pendingModeNotice: string | undefined;
  if (approvals !== undefined) {
    const policy = resolveGatePolicy(cwd, config.gate);
    const modeGate = new ModeGate(gate, {
      metrics: approvals,
      onDenied: (req, reason) => ui?.writeSystem(`${MODE_INFO[modeGate.mode].label} mode refused ${req.kind}: ${req.detail}\n${reason}`),
      onRemember: (patterns) => {
        rememberAllow(projectId, patterns, permissionsOpts);
        modeGate.setAllowlist(loadPermissions(projectId, permissionsOpts).allow);
        ui?.writeSystem(`remembered for this project: ${patterns.join(", ")}`);
      },
    });
    modeGate.verifyCommand = policy.enabled && policy.command ? policy.command : undefined;
    modeGate.setAllowlist(loadPermissions(projectId, permissionsOpts).allow);
    // T209 / ADR-0041: Manual on first run, then remembered per project. An explicit --mode is remembered.
    if (input.mode !== undefined) rememberMode(projectId, input.mode, permissionsOpts);
    const initial = input.mode ?? startingMode(projectId, permissionsOpts);
    modeGate.setMode(initial);
    pendingModeNotice = modeSwitchNotice(initial);
    modes = modeGate;
    gate = modeGate;
  }
  const applyMode = (mode: InteractionMode): void => {
    if (modes === undefined) return;
    modes.setMode(mode);
    rememberMode(projectId, mode, permissionsOpts);
    pendingModeNotice = modeSwitchNotice(mode);
    ui?.writeSystem(`mode: ${MODE_INFO[mode].label} — ${MODE_INFO[mode].description}`);
  };
  const specialist = input.specialist ?? DEFAULT_SPECIALIST;
  if (canSealAllowanceEverAllow({ cwd, config, specialist })) {
    const allowance = createSealTestCommandAllowance({
      cwd,
      config,
      specialist,
    });
    gate = wrapApprovalGateWithSealAllowance(gate, allowance);
  }

  // T103: the human channel exists here, so `ask` is registered. It is the
  // same `lineSource` the approval gate reads, and `TerminalAsk` serializes
  // onto one outstanding read for the same reason the gate does.
  const askHuman =
    input.askHuman ??
    new TerminalAsk(
      () => lineSource.next(),
      { write: (chunk: string) => stdoutWrite(String(chunk)) },
    ).ask;
  const booted = await bootInteractiveSession(shared, {
    gate,
    askHuman,
    // T131: the exit-plan tool's channel is the same ask, so one typed line never answers two questions.
    ...(modes !== undefined
      ? {
          currentMode: () => modes.mode,
          requestPlanExit: async (plan: string): Promise<InteractionMode | null> => {
            const options = [PLAN_CONTINUE_AUTO, PLAN_CONTINUE_MANUAL, PLAN_STAY];
            const answer = await askHuman({ question: `${plan}\n\nStart carrying this plan out?`, assumption: PLAN_STAY, options });
            const chosen = parseAskAnswer(answer, { question: "", assumption: PLAN_STAY, options });
            // Anything else keeps Plan mode: leaving a read-only mode is never the default answer.
            const next = chosen === PLAN_CONTINUE_AUTO ? "auto" : chosen === PLAN_CONTINUE_MANUAL ? "manual" : null;
            if (next !== null) applyMode(next);
            return next;
          },
        }
      : {}),
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

  await writeInteractiveBootRow({
    booted,
    session,
    state,
    model,
    boot,
    config,
    cwd,
    ledgerPath,
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(recorder !== undefined ? { recorder } : {}),
    ...(input.resume !== undefined ? { resume: input.resume } : {}),
    ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.continuation !== undefined ? { continuation: input.continuation } : {}),
  });
  if (input.resume) await injectReplay(session, recorder, input.resume, booted.rewind);

  const width = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;
  const capability = detectColorCapability({
    env: process.env,
    isTTY: Boolean(process.stdout.isTTY),
    ...(config.ui.color !== "auto" ? { colorFlag: config.ui.color } : {}),
  });
  const glyphs = config.ui.glyphs === "unicode" ? detectGlyphSet(process.env) : config.ui.glyphs;
  const theme = resolveTheme(config.ui.theme, capability, glyphs, { cwd });
  const uiOptions = {
    width,
    theme,
    header: { model: modelSpec, sessionId: session.sessionId, cwd, ...(booted.specialistName !== undefined ? { specialist: booted.specialistName } : {}) },
    ledgerPath,
    config,
    startedUtc: booted.startedAt,
  };
  const options = (): SessionOptions =>
    sessionOptions({
      cwd,
      globalDir: defaultGlobalDir(),
      session,
      modelSpec,
      modelRuntime,
      specialist: specialistSwitcher.currentSpecialistName(),
      providers: config.providers ?? {},
    });
  ui = input.createUi !== undefined ? input.createUi(uiOptions, session, (question) => askAside(session, state, question), options) : createAgentUi(uiOptions);
  const unsubUi = session.subscribe
    ? ui.attach({ subscribe: (fn) => session.subscribe!((ev) => fn(ev as import("./s0.js").StreamEvent)) }, () => state)
    : undefined;

  // Ticket 04: `/specialist`'s live half. The append-only header is painted
  // once, so a switch here changes what `/specialist` itself reports and
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
      projectId,
      ...(permissionsOpts !== undefined ? { permissionsOpts } : {}),
      ...(modes !== undefined
        ? {
            currentMode: () => modes.mode,
            setMode: applyMode,
            takeModeNotice: () => {
              const notice = pendingModeNotice;
              pendingModeNotice = undefined;
              return notice;
            },
            onPermissionsChange: () => modes.setAllowlist(loadPermissions(projectId, permissionsOpts).allow),
          }
        : {}),
      runExtensionCommand: (name, args) => booted.extensionHost.runCommand(name, args),
      currentModel: () => {
        const current = session.model;
        return current ? `${current.provider}/${current.id}` : modelSpec;
      },
      setModel: async (spec, persist) => {
        let next: Awaited<ReturnType<typeof resolveHostModel>>;
        try {
          next = await resolveHostModel(spec, modelRuntime);
        } catch {
          // Unknown to the runtime this session started with: read the providers again, then ask once more.
          await reloadProviders(modelRuntime, cwd);
          next = await resolveHostModel(spec, modelRuntime);
        }
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
        skillTokens: skillsHeadCost(booted.skillRoster),
        toolNames: session.getActiveToolNames(),
      }),
      ...(input.onReady !== undefined ? { onReady: (handle: InteractiveHandle) => input.onReady?.({ ...handle, jobs: booted.jobs }) } : {}),
      ...(recorder !== undefined ? { recorder } : {}),
      ...(input.continuation !== undefined ? { initialPrompt: input.continuation.prompt } : {}),
      continuationRequested: () => booted.continuationState.requested,
      login: credentialCommands.login,
      credential: credentialCommands.credential,
      addProvider: (io) =>
        runProviderAdd(io, {
          globalPath: globalConfigPath(defaultGlobalDir()),
          projectPath: projectConfigPath(cwd),
          taken: [...new Set([...Object.keys(BUILTIN_PROVIDERS), ...Object.keys(config.providers)])],
        }),
      rewind: booted.rewind,
      ...(input.resume?.inputText !== undefined ? { inputText: input.resume.inputText } : {}),
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
    ...(approvals !== undefined ? { approvals } : {}),
  });
}
