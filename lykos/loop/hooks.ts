// T105 — a hook surface (`docs/24-strength-and-tooling-audit.md` §2.9,
// `docs/27-phase12-tasks.md`).
//
// WHAT IS MISSING, and by the time this task was reached the evidence was
// sitting in this repository rather than in the register. §2.9 says
// `gate/approval.ts` is the only interception point and warns that building
// deterministic policies separately "is how a codebase acquires five
// interception points". Phase 12 then built four more in eight days: T99's
// post-edit check, T98's list reminder, T102's skill counter and T104's
// checkpoint, all hand-wired inline in `loop/harness-extension.ts` beside
// T85's brake and T86's budget notice. The warning was accurate and this
// task is the correction.
//
// WHAT A HOOK IS HERE. A named function on one of five events, returning one
// of three outcomes: continue, deny (with a reason the model can act on), or
// note (text appended to what the model reads next). That is the whole
// contract, and it is small on purpose — every mechanism this phase built
// fits it, and anything that does not fit it is not a policy, it is a
// feature.
//
// THE TWO PLACES A HOOK CAN INTERCEPT, and why they are different:
//
//   `pre_tool` runs on Pi's `tool_call` event, which sees EVERY tool
//   including `read` — the one `gate/approval.ts` deliberately does not
//   shadow. It can `block` with a reason, which is how a "never touch
//   `.lykos/ledger.db`" rule becomes mechanical instead of prompt text.
//
//   `post_tool` runs on `tool_result`, after the clamp, so a note a hook
//   adds is text the model will actually see.
//
// WHY THE EXISTING MECHANISMS ARE NOT ALL REWRITTEN AS HOOKS. Three of them
// (T85's brake, T86's budget notice, T102's skill counter) hold per-session
// state that the harness observation object already owns, and moving them
// would be a refactor whose only benefit is uniformity — rule 5's discipline
// applies to capability work too, in the form of not rewriting three working
// things to prove a fourth. What T105 does instead is make the surface exist,
// route the NEW policies through it, and give `loop/harness-extension.ts` one
// call site per event instead of a growing chain of `if` blocks. The register
// asked for "one mechanism with one implementation"; this is the
// implementation, and the migration of the older mechanisms is a later
// clean-up that changes no behaviour.
//
// USER HOOKS ARE COMMANDS, NOT CODE. A hook declared in `config.yaml` runs a
// shell command; a non-zero exit denies (on `pre_tool`) or annotates (on
// `post_tool`), and its output is what the model is told. That is the whole
// extension surface, and it is deliberately not a plugin API: a plugin API
// is a second place Lykos can be extended, and `docs/06-extension-policy.md`
// already has one.

import { localExecutor, type ProjectExecutor } from "../tools/executor.js";
import { TREE_KILL_SPAWN_OPTIONS, killExecChild } from "../tools/job-runner.js";
import { splitShellSegments, tokenizeSegment } from "./exploration.js";

export type HookEvent = "session_start" | "turn_start" | "pre_tool" | "post_tool" | "session_end";

export interface HookContext {
  event: HookEvent;
  cwd: string;
  /** Present on `pre_tool` and `post_tool`. */
  toolName?: string;
  /** The tool's arguments, as the model supplied them. */
  input?: Record<string, unknown>;
  /** `post_tool` only: whether the call failed. */
  isError?: boolean;
  /** `turn_start` only. */
  turnIndex?: number;
}

export type HookOutcome =
  | { action: "continue" }
  /** `pre_tool` only. The reason is shown to the model, so it must say what to do instead. */
  | { action: "deny"; reason: string }
  /** Text appended to what the model reads next. */
  | { action: "note"; note: string };

export interface Hook {
  name: string;
  event: HookEvent;
  /** Narrow to particular tools. Omitted → every tool on that event. */
  tools?: readonly string[];
  run: (ctx: HookContext) => Promise<HookOutcome> | HookOutcome;
}

export interface HookRun {
  /** The first deny wins; later hooks on that event do not run. */
  denied?: { hook: string; reason: string };
  /** Notes in registration order. The caller decides how many it can afford to show. */
  notes: Array<{ hook: string; note: string }>;
}

export interface HookCounters {
  /**
   * Per hook name: how many times it RAN. A hook that threw counted here too
   * from P10.9 onward — see `HookRegistry.run` and backlog defect D12.
   */
  runs: Record<string, number>;
  denials: number;
  notes: number;
  /**
   * P10.9 (ticket 21, D3): hook invocations that threw. The hook surface and
   * the Lykos extension API are held to one standard, because two standards
   * is how the older one survives.
   */
  failures: number;
  /** Per hook name, so "which one is broken" is answerable without a log. */
  failuresByHook: Record<string, number>;
  /** The most recent failure, for the session's one-line report. */
  lastFailure?: { hook: string; event: HookEvent; message: string };
}

export function newHookCounters(): HookCounters {
  return { runs: {}, denials: 0, notes: 0, failures: 0, failuresByHook: {} };
}

/**
 * P10.9 (ticket 21, D3): the one line a session prints about hooks that broke.
 * Undefined when none did, so a healthy session stays silent.
 *
 * It says the policy is not running, because that is the fact the author needs
 * and the one a swallowed exception hid: a hook the author believes is running
 * and is not is worse than no hook, which is the same sentence
 * `hookRejectionNotice` already makes about a malformed declaration.
 */
export function hookFailureNotice(counters: HookCounters): string | undefined {
  if (counters.failures === 0) return undefined;
  const who = Object.entries(counters.failuresByHook)
    .map(([name, n]) => `${name} (${n})`)
    .join(", ");
  const last = counters.lastFailure;
  return (
    `lykos: ${counters.failures} hook failure(s) this session — ${who}. ` +
    (last !== undefined ? `Most recent: ${last.hook} on ${last.event}: ${last.message}. ` : "") +
    `A throwing hook is skipped, not fatal — but its policy is NOT running.`
  );
}

export class HookRegistry {
  private readonly hooks: Hook[] = [];
  readonly counters: HookCounters = newHookCounters();

  register(hook: Hook): void {
    this.hooks.push(hook);
  }

  /** Registered hooks, in order. For `lykos doctor` and for tests. */
  list(): readonly Hook[] {
    return this.hooks;
  }

  has(event: HookEvent): boolean {
    return this.hooks.some((h) => h.event === event);
  }

  /**
   * Runs every hook for an event.
   *
   * **A throwing hook is skipped, not fatal.** A policy that crashes must not
   * take the session with it — the failure mode of a hook surface is that one
   * bad hook makes the agent unusable, and the mitigation is that a hook's
   * only power is to deny or annotate.
   *
   * **P10.9 (ticket 21, D3) — and it is REPORTED AND COUNTED, which is defect
   * D12 closed.** The catch used to `continue` past the run counter as well as
   * the outcome, so a hook that threw on every single call was indistinguishable
   * from one that never matched a tool: both showed zero runs and no trace of
   * anything at all. Not fatal was and is the right policy; leaving no evidence
   * was not. So the run is counted BEFORE the call rather than after it — a
   * hook that ran, ran — and the throw increments `failures`, names the hook
   * and the event, and keeps the message for `hookFailureNotice`.
   *
   * The same standard now governs `extensions/api.ts`'s `emit`, in the same
   * change, because two standards for "what happens when somebody else's code
   * throws" is how the weaker one survives.
   */
  async run(event: HookEvent, ctx: Omit<HookContext, "event">): Promise<HookRun> {
    const result: HookRun = { notes: [] };
    for (const hook of this.hooks) {
      if (hook.event !== event) continue;
      if (hook.tools !== undefined && (ctx.toolName === undefined || !hook.tools.includes(ctx.toolName))) {
        continue;
      }
      this.counters.runs[hook.name] = (this.counters.runs[hook.name] ?? 0) + 1;
      let outcome: HookOutcome;
      try {
        outcome = await hook.run({ ...ctx, event });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.counters.failures += 1;
        this.counters.failuresByHook[hook.name] = (this.counters.failuresByHook[hook.name] ?? 0) + 1;
        this.counters.lastFailure = { hook: hook.name, event, message };
        continue;
      }
      if (outcome.action === "deny") {
        this.counters.denials += 1;
        result.denied = { hook: hook.name, reason: outcome.reason };
        // The first deny ends it: running later hooks against a call that is
        // not going to happen wastes their time and confuses their counters.
        return result;
      }
      if (outcome.action === "note") {
        this.counters.notes += 1;
        result.notes.push({ hook: hook.name, note: outcome.note });
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// The built-in policies.
// ---------------------------------------------------------------------------

/**
 * Paths no agent has any business writing to, ever, in any project.
 *
 * `.lykos/ledger.db` is the one that matters and is the reason this exists:
 * the ledger is the measurement layer, an agent editing its own cost record
 * is the single worst thing that could happen to this project's evidence, and
 * until now the only thing preventing it was that nobody had tried.
 * `.git` is not here: it is a protected path that asks through the path-rule
 * gate (ADR-0042), for file tools and for bash and powershell file commands.
 *
 * Deny rather than ask: `gate/approval.ts` would surface these as an approval
 * prompt, and a prompt is a thing a human clicks through at 2am. `01-idea.md`
 * §5 is explicit that restrictions must be framework-enforced rather than
 * requested politely.
 */
export const PROTECTED_PATH_PATTERNS: readonly { pattern: RegExp; why: string }[] = [
  {
    pattern: /(^|[\\/])\.lykos[\\/](ledger\.db|ledger\.db-wal|ledger\.db-shm|ledger\.db-journal)(?:$|[\\/])/i,
    why: "the ledger is the measurement layer; an agent editing its own cost record destroys the evidence every claim in this project rests on",
  },
  {
    pattern: /(^|[\\/])\.lykos[\\/]sessions(?:$|[\\/])/i,
    why: "session transcripts are the archive, and nothing Lykos runs is ever deleted or rewritten",
  },
];

export function protectedPathReason(path: string | undefined): string | undefined {
  if (path === undefined || path.length === 0) return undefined;
  for (const { pattern, why } of PROTECTED_PATH_PATTERNS) {
    if (pattern.test(path)) return why;
  }
  return undefined;
}

function protectedShellPathReason(command: string): string | undefined {
  for (const segment of splitShellSegments(command)) {
    for (const token of tokenizeSegment(segment)) {
      const candidates = [token, token.replace(/^\d*>{1,2}/, ""), token.slice(token.lastIndexOf("=") + 1)];
      for (const candidate of candidates) {
        const why = protectedPathReason(candidate);
        if (why !== undefined) return why;
      }
    }
  }
  return undefined;
}

/** The tools whose arguments name a file this rule should look at. */
const PATH_TOOLS = ["write", "edit", "multi_edit", "apply_patch", "bash"] as const;

export function protectedPathsHook(): Hook {
  return {
    name: "lykos:protected-paths",
    event: "pre_tool",
    tools: PATH_TOOLS,
    run: (ctx) => {
      const input = ctx.input ?? {};
      const isShell = ctx.toolName === "bash";
      const path = firstString(input, ["path", "file_path", "filePath"]);
      const command = isShell ? firstString(input, ["command"]) : undefined;
      const why = isShell
        ? command === undefined
          ? undefined
          : protectedShellPathReason(command)
        : protectedPathReason(path);
      if (why === undefined) return { action: "continue" };
      return {
        action: "deny",
        reason:
          `lykos refuses to write ${isShell ? command : path}: ${why}. ` +
          `If you need to change what is recorded there, say so and let a human do it.`,
      };
    },
  };
}

/**
 * A secrets check, and it **notes rather than denies** — deliberately.
 *
 * The patterns below match real credential shapes, and they also match a test
 * fixture, a documentation example and a redaction test. Blocking on a
 * heuristic that has false positives produces exactly T90's crying-wolf
 * detector: an agent that cannot write a file it legitimately needs to write,
 * with no way to explain itself. A note the model reads and can answer is the
 * honest strength of the evidence.
 */
export const SECRET_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: "Anthropic-style key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
];

export function detectSecrets(text: string | undefined): string[] {
  if (text === undefined || text.length === 0) return [];
  const found: string[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) found.push(name);
  }
  return found;
}

/** Argument keys that carry content a tool is about to put into a file. */
const BODY_KEYS = ["content", "new_string", "replacement", "text", "newText"] as const;

/**
 * Every string in a tool call that is about to become file content.
 *
 * This used to be `firstString(input, [...])`, a top-level key lookup, and
 * `write` is the only one of the four hooked tools whose body IS a top-level
 * key. `edit` passes `edits: [{ oldText, newText }]` (and, until T168 removed
 * it, P10.3's anchored `edit` passed `hunks: [{ start, end, text }]`), so the
 * lookup found nothing and the hook returned `continue` on every edit that has ever run — a guard
 * that was registered, tested, and never handed anything to guard, which is
 * the exact trap CLAUDE.md names.
 *
 * So: the named keys at the top level, plus the same keys on every object
 * inside any array-valued argument. Scanning every array rather than a list of
 * known array names (`edits`, `hunks`) is deliberate — the next edit-shaped
 * tool that arrives gets covered without anyone remembering to come back here,
 * and the alternative is this same silent gap again. One level deep, because
 * every one of these shapes is a flat list of flat records and an unbounded
 * walk over model-supplied JSON is a cost with no case behind it.
 *
 * ALL bodies, not the first: a call with a clean first hunk and a credential
 * in the third is exactly the call a first-match check would wave through.
 */
export function candidateBodies(input: Record<string, unknown>): string[] {
  const bodies: string[] = [];
  const take = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) bodies.push(value);
  };
  for (const key of BODY_KEYS) take(input[key]);
  for (const value of Object.values(input)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      for (const key of BODY_KEYS) take((entry as Record<string, unknown>)[key]);
    }
  }
  return bodies;
}

export function secretsHook(): Hook {
  return {
    name: "lykos:secrets",
    event: "pre_tool",
    tools: ["write", "edit", "multi_edit", "apply_patch"],
    run: (ctx) => {
      const input = ctx.input ?? {};
      const found: string[] = [];
      for (const body of candidateBodies(input)) {
        for (const name of detectSecrets(body)) {
          if (!found.includes(name)) found.push(name);
        }
      }
      if (found.length === 0) return { action: "continue" };
      return {
        action: "note",
        note:
          `lykos: that write looks like it contains a credential (${found.join(", ")}). ` +
          `If it is a real secret, do not commit it — put it in an environment variable and reference it. ` +
          `If it is a fixture or an example, say so and carry on.`,
      };
    },
  };
}

function firstString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// User hooks, declared in config.yaml as commands.
// ---------------------------------------------------------------------------

export interface HookDecl {
  /**
   * Typed as a plain string because it arrives from YAML, which is untrusted
   * input: `resolveHookDecls()` is what narrows it to a `HookEvent`, and a
   * declaration that fails that narrowing is rejected with a reason rather
   * than silently dropped.
   */
  event?: string;
  /** Tools this applies to. Omitted → all of them on that event. */
  tools?: string[];
  command?: string;
  timeout_seconds?: number;
  /** `pre_tool` only: a non-zero exit denies the call. Default true. */
  blocking?: boolean;
}

export interface HookCommandRun {
  exitCode: number | null;
  output: string;
  problem?: string;
}

export type HookCommandRunner = (
  command: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
) => HookCommandRun | Promise<HookCommandRun>;

/**
 * Defect D21. This used to be `spawnSync` with a timeout, which on Windows
 * signals the command interpreter and leaves whatever that interpreter
 * started still running. The kill is `killProcessTree`, the same one `hub`
 * and the post-edit runner use, and it has to be async: a tree kill cannot
 * run from inside `spawnSync`, which is holding the only thread.
 *
 * A timeout stays a problem, not a non-zero exit. The shell's exit after the
 * kill must not become a deny of the tool call the hook was watching.
 */
export function createHookCommandRunner(executor: ProjectExecutor): HookCommandRunner {
  return (command, cwd, timeoutMs, env) => runHookCommand(executor, command, cwd, timeoutMs, env);
}

/** The runner for this machine, which is what a session without a container has. */
export const spawnHookCommand: HookCommandRunner = createHookCommandRunner(localExecutor);

const runHookCommand = (
  executor: ProjectExecutor,
  command: string,
  cwd: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<HookCommandRun> =>
  new Promise<HookCommandRun>((resolvePromise) => {
    let settled = false;
    const finish = (run: HookCommandRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(run);
    };
    const child = executor.spawn(command, [], {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, ...env },
      ...TREE_KILL_SPAWN_OPTIONS,
    });
    let output = "";
    const append = (chunk: Buffer): void => {
      if (output.length < 4 * 1024 * 1024) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void killExecChild(child, "SIGTERM").then(() => {
        finish({
          exitCode: null,
          output: output.trim(),
          problem: `killed by SIGTERM (timeout after ${timeoutMs}ms)`,
        });
      });
    }, timeoutMs);
    child.on("error", (err) => {
      if (timedOut) return;
      finish({ exitCode: null, output: output.trim(), problem: err.message });
    });
    child.on("close", (code) => {
      if (timedOut) return;
      finish({ exitCode: code, output: output.trim() });
    });
  });

const VALID_EVENTS: readonly HookEvent[] = [
  "session_start",
  "turn_start",
  "pre_tool",
  "post_tool",
  "session_end",
];

export interface HookDeclResolution {
  hooks: Hook[];
  /** Declarations that were dropped, and why. Reported, never silently ignored. */
  rejected: Array<{ index: number; reason: string }>;
}

/**
 * Turns declarations into hooks. A malformed declaration is **rejected with a
 * reason**, not skipped: T97.3's rule, now applied to a third kind of
 * resource. A hook the author believes is running and is not is worse than no
 * hook, because it looks like a policy that passed.
 */
export function resolveHookDecls(
  decls: readonly HookDecl[] | undefined,
  run: HookCommandRunner = spawnHookCommand,
): HookDeclResolution {
  const resolution: HookDeclResolution = { hooks: [], rejected: [] };
  (decls ?? []).forEach((decl, index) => {
    if (decl.event === undefined || !VALID_EVENTS.includes(decl.event as HookEvent)) {
      resolution.rejected.push({
        index,
        reason: `event must be one of ${VALID_EVENTS.join(", ")} (got ${JSON.stringify(decl.event)})`,
      });
      return;
    }
    const command = decl.command?.trim();
    if (command === undefined || command.length === 0) {
      resolution.rejected.push({ index, reason: "a hook needs a command" });
      return;
    }
    const timeoutMs = Math.max(1, decl.timeout_seconds ?? 30) * 1000;
    const blocking = decl.blocking ?? true;
    const event = decl.event as HookEvent;
    resolution.hooks.push({
      name: `config:${event}[${index}]`,
      event,
      ...(decl.tools !== undefined ? { tools: decl.tools } : {}),
      run: async (ctx) => {
        const result = await run(command, ctx.cwd, timeoutMs, {
          // The context reaches the command as environment rather than as
          // arguments: an argument built from a model-supplied path is a
          // shell-injection surface, and an environment variable is not.
          LYKOS_HOOK_EVENT: ctx.event,
          LYKOS_HOOK_TOOL: ctx.toolName ?? "",
          LYKOS_HOOK_PATH: firstString(ctx.input ?? {}, ["path", "file_path", "filePath"]) ?? "",
        });
        if (result.problem !== undefined) {
          // A hook that cannot run says nothing about the call. Denying here
          // would let a typo in config.yaml stop the agent from working.
          return { action: "note", note: `lykos: hook command failed to run (${result.problem})` };
        }
        if (result.exitCode === 0) return { action: "continue" };
        if (ctx.event === "pre_tool" && blocking) {
          return {
            action: "deny",
            reason: result.output.length > 0 ? result.output : `a project hook refused this ${ctx.toolName} call`,
          };
        }
        return {
          action: "note",
          note: result.output.length > 0 ? result.output : `lykos: a project hook exited ${result.exitCode}`,
        };
      },
    });
  });
  return resolution;
}

export function hookRejectionNotice(resolution: HookDeclResolution): string | undefined {
  if (resolution.rejected.length === 0) return undefined;
  return (
    `lykos: ${resolution.rejected.length} hook declaration(s) in config.yaml were NOT loaded — ` +
    resolution.rejected.map((r) => `hooks[${r.index}]: ${r.reason}`).join("; ")
  );
}

/** The built-ins, in the order they run. */
export function builtinHooks(): Hook[] {
  return [protectedPathsHook(), secretsHook()];
}
