// `lykos status`, `lykos wait`, `lykos stop` (T243), `lykos steer`, `lykos continue` (T244): thin front ends over
// the delegation core. They read and write
// the project ledger, so they see every delegated session of the project, whichever process owns it (`lykos run`
// or an MCP server). Every command prints JSON with `next`; no arguments prints its usage; an unknown flag is an
// error (R19).

import { resolve } from "node:path";
import { stderrWrite } from "../tui/io-mode.js";
import { cycleViews, isCycleId, recoverCycle, runCycle } from "../delegate/cycle.js";
import { ledgerViews, runDelegated, steerElsewhere, stopElsewhere, waitForQuestions, waitForSessions } from "../delegate/mcp-server.js";
import { ensureWorkspaceTrust, WorkspaceTrustError, type TrustDecision } from "../gate/trust.js";
import { loadConfig } from "../config/load.js";
import { noBashMessage, resolveHostBash } from "../process/host-bash.js";
import { readProcessStdin } from "./brief.js";
import type { SessionView } from "../delegate/ownership.js";
import { CAUSE_LIST, decideAt, type DecisionKind } from "../delegate/decisions.js";
import { defaultLedgerPath } from "../ledger/use.js";
import { stdoutWrite } from "../tui/io-mode.js";

export interface ParsedFlags {
  ids: string[];
  flags: Map<string, string | true>;
}

/** Splits arguments into ids and flags; an unknown flag is an error that names the known ones. */
export function parseFlags(args: readonly string[], command: string, valued: readonly string[], booleans: readonly string[]): ParsedFlags | { error: string } {
  const ids: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i += 1) {
    // `-m` is `--message`, the one short flag.
    const arg = args[i] === "-m" ? "--message" : args[i]!;
    if (!arg.startsWith("--")) {
      ids.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    if (valued.includes(name)) {
      const value = eq !== -1 ? arg.slice(eq + 1) : args[i + 1];
      if (value === undefined || (eq === -1 && value.startsWith("--"))) return { error: `lykos ${command}: --${name} needs a value` };
      if (eq === -1) i += 1;
      flags.set(name, value);
    } else if (booleans.includes(name) && eq === -1) {
      flags.set(name, true);
    } else {
      const known = [...valued.map((v) => `--${v} <value>`), ...booleans.map((b) => `--${b}`)];
      return { error: `lykos ${command}: unknown flag ${arg}${known.length > 0 ? ` (known: ${known.join(", ")})` : " (it takes none)"}` };
    }
  }
  return { ids, flags };
}

/** A delegated run's exit code: 1 only when it could not run (`error`, `blocked`); every result the session reached is 0, read through `next`. */
export function delegatedExitCode(result: { outcome?: unknown }): number {
  return result.outcome === "error" || result.outcome === "blocked" ? 1 : 0;
}

function print(value: unknown): void {
  stdoutWrite(`${JSON.stringify(value, null, 2)}\n`);
}

/** The one `next` a list of sessions asks for: a crash first, then a question, then a wait, then the first result's. */
export function nextOf(views: readonly SessionView[]): string {
  for (const want of ["recover", "answer_question"]) if (views.some((v) => v.next === want)) return want;
  if (views.some((v) => v.state === "running" || v.state === "waiting")) return "wait";
  return views.find((v) => v.next !== undefined)?.next ?? "review_or_accept";
}

export const STATUS_USAGE = "usage: lykos status <session-id>... | --all    the sessions' state, owner and result, from the project ledger";
export const WAIT_USAGE =
  "usage: lykos wait <session-id>... [--any] [--questions] [--timeout <seconds>]    block until the sessions end (or one, with --any; or one asks a question nobody answered, with --questions)";
export const STEER_USAGE = "usage: lykos steer <session-id> -m <message|->    send a live session a message; it answers the session's open question";
export const CONTINUE_USAGE =
  "usage: lykos continue <session-id> -m <message|-> [--max-steps n] [--request-id id] [--reseal <commit>] [--trust-workspace]    resume an ended session on its branch with a new message; --reseal seals its branch again at the commit that corrects a sealed test";
export const RECOVER_USAGE =
  "usage: lykos recover <session-id|cycle-id> [-m <message|->] [--max-steps n] [--add <text>] [--trust-workspace]    continue a crashed session, or a crashed review cycle from its last written step (its owner is dead), after confirming everything it started is stopped; never kills anything";
export const CYCLE_USAGE =
  "usage: lykos cycle <session-id|cycle-id> [--task <file>] [-m <note|->] [--base <ref>] [--max-steps n] [--add <text>] [--forward <finding-id,...>] [--drop <finding-id,...>] [--trust-workspace]    review a session's change, have it fixed and rechecked until nothing is open; a session id starts a cycle, a cycle id resumes one that stopped, and every option works at both. It stops with `next`: approve, answer_spec, triage, answer_question, decide, fix_environment or recover. The caps are delegation.cycle_max_rounds, cycle_max_fixes and cycle_stall_after";
export const REVIEW_USAGE =
  "usage: lykos review <session-id|branch> [--task <file>] [-m <note|->] [--base <ref>] [--max-steps n] [--request-id id] [--trust-workspace]    one reviewer reads the change against the base the session started from; each finding comes back as a claim the harness has checked";
export const STOP_USAGE = "usage: lykos stop <session-id>    ask the session's owner to stop it, and wait up to 10 s for it to end";

function usage(line: string): number {
  stdoutWrite(`${line}\n`);
  return 2;
}

function missing(ids: readonly string[], views: readonly SessionView[]): string[] {
  const known = new Set(views.map((v) => v.session_id));
  return ids.filter((id) => !known.has(id));
}

export function runStatus(cwd: string, args: readonly string[]): number {
  if (args.length === 0) return usage(STATUS_USAGE);
  const parsed = parseFlags(args, "status", [], ["all"]);
  if ("error" in parsed) {
    stderrWrite(`${parsed.error}\n`);
    return 1;
  }
  const all = parsed.flags.has("all");
  if (all === (parsed.ids.length > 0)) {
    stderrWrite("lykos status: give session ids or --all, not both\n");
    return 1;
  }
  // T236: an id may be a review cycle's. Cycles are listed beside the sessions, and a crashed one asks for `recover` too.
  const cycleIds = all ? undefined : parsed.ids.filter((id) => isCycleId(cwd, id));
  const sessionIds = all ? undefined : parsed.ids.filter((id) => !(cycleIds ?? []).includes(id));
  const views = ledgerViews(cwd, sessionIds);
  const cycles = cycleViews(cwd, cycleIds);
  const unknown = sessionIds === undefined ? [] : missing(sessionIds, views);
  if (unknown.length > 0) {
    print({ outcome: "error", message: `unknown session id: ${unknown.join(", ")}`, sessions: views, ...(cycles.length > 0 ? { cycles } : {}), next: "fix_environment" });
    return 1;
  }
  const next =
    views.length === 0 && cycles.length === 0
      ? "run"
      : cycles.some((c) => c.next === "recover")
        ? "recover"
        : views.length === 0
          ? (cycles.find((c) => c.state === "running")?.next ?? cycles.at(-1)!.next)
          : // A cycle asking a question asks it whatever the sessions beside it say, as a session's own question does.
            nextOf([...views, ...cycles.filter((c) => c.state === "running" || c.next === "answer_question").map((c) => ({ state: c.state === "running" ? "running" : "stopped", next: c.next }) as SessionView)]);
  print({ sessions: views, ...(cycles.length > 0 ? { cycles } : {}), next });
  return 0;
}

export async function runWait(cwd: string, args: readonly string[]): Promise<number> {
  if (args.length === 0) return usage(WAIT_USAGE);
  const parsed = parseFlags(args, "wait", ["timeout"], ["any", "questions"]);
  if ("error" in parsed) {
    stderrWrite(`${parsed.error}\n`);
    return 1;
  }
  if (parsed.ids.length === 0) return usage(WAIT_USAGE);
  const timeoutRaw = parsed.flags.get("timeout");
  let timeoutMs: number | undefined;
  if (timeoutRaw !== undefined) {
    const seconds = Number(timeoutRaw);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      stderrWrite(`lykos wait: --timeout must be a positive number of seconds, got "${String(timeoutRaw)}"\n`);
      return 1;
    }
    timeoutMs = seconds * 1000;
  }
  const unknown = missing(parsed.ids, ledgerViews(cwd, parsed.ids));
  if (unknown.length > 0) {
    print({ outcome: "error", message: `unknown session id: ${unknown.join(", ")}`, next: "fix_environment" });
    return 1;
  }
  if (parsed.flags.has("questions")) {
    // T244 (G8): only a question nobody answered wakes it.
    const { questions, sessions } = await waitForQuestions(cwd, parsed.ids, timeoutMs);
    print({ questions, sessions, next: questions.length > 0 ? "answer_question" : nextOf(sessions) });
    return 0;
  }
  const views = await waitForSessions(cwd, parsed.ids, parsed.flags.has("any"), timeoutMs);
  print({ sessions: views, next: nextOf(views) });
  return 0;
}

/** `-m <text>`, or `-m -` for stdin. */
async function messageOf(parsed: ParsedFlags, command: string): Promise<string | { error: string }> {
  const raw = parsed.flags.get("message");
  if (typeof raw !== "string") return { error: `lykos ${command}: -m <message> is required` };
  const text = raw === "-" ? await readProcessStdin() : raw;
  if (text.trim() === "") return { error: `lykos ${command}: the message is empty` };
  return text;
}

export async function runSteer(cwd: string, args: readonly string[]): Promise<number> {
  if (args.length === 0) return usage(STEER_USAGE);
  const parsed = parseFlags(args, "steer", ["message"], []);
  if ("error" in parsed) {
    stderrWrite(`${parsed.error}\n`);
    return 1;
  }
  if (parsed.ids.length !== 1) return usage(STEER_USAGE);
  const message = await messageOf(parsed, "steer");
  if (typeof message !== "string") {
    stderrWrite(`${message.error}\n`);
    return 1;
  }
  const id = parsed.ids[0]!;
  const steered = steerElsewhere(cwd, id, message);
  if (steered === undefined) {
    print({ outcome: "error", message: `unknown session id: ${id}`, next: "fix_environment" });
    return 1;
  }
  if (!steered.steered) {
    print({ ...steered, outcome: "error", message: `session ${id} is ${steered.state}; continue it instead`, next: steered.state === "crashed" ? "recover" : "resume" });
    return 1;
  }
  print({ ...steered, next: "wait" });
  return 0;
}

/** What every command that starts a session needs first: the project's trust, decided without a prompt, and the one bash. */
async function trustAndShell(cwd: string, command: string, trustWorkspace: boolean): Promise<TrustDecision | undefined> {
  let trust: TrustDecision;
  try {
    trust = await ensureWorkspaceTrust({ workspace: cwd, interactive: false, ...(trustWorkspace ? { trustWorkspace: true } : {}) });
  } catch (err) {
    stderrWrite(`lykos ${command}: refused — ${err instanceof WorkspaceTrustError ? err.message : String(err)}\n`);
    return undefined;
  }
  const bash = resolveHostBash(loadConfig({ cwd }).resolved.delegation.shell_path);
  if (!bash.ok) {
    stderrWrite(`lykos ${command}: refused — ${noBashMessage(bash)}\n`);
    return undefined;
  }
  return trust;
}

export async function runContinue(cwd: string, args: readonly string[]): Promise<number> {
  if (args.length === 0) return usage(CONTINUE_USAGE);
  const parsed = parseFlags(args, "continue", ["message", "max-steps", "request-id", "reseal"], ["trust-workspace"]);
  if ("error" in parsed) {
    stderrWrite(`${parsed.error}\n`);
    return 1;
  }
  if (parsed.ids.length !== 1) return usage(CONTINUE_USAGE);
  const message = await messageOf(parsed, "continue");
  if (typeof message !== "string") {
    stderrWrite(`${message.error}\n`);
    return 1;
  }
  const stepsRaw = parsed.flags.get("max-steps");
  const maxSteps = stepsRaw === undefined ? undefined : Number(stepsRaw);
  if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1)) {
    stderrWrite(`lykos continue: --max-steps must be a positive integer, got "${String(stepsRaw)}"\n`);
    return 1;
  }
  const trust = await trustAndShell(cwd, "continue", parsed.flags.has("trust-workspace"));
  if (trust === undefined) return 1;
  const requestId = parsed.flags.get("request-id");
  const reseal = parsed.flags.get("reseal");
  const result = await runDelegated(
    cwd,
    {
      brief: message,
      session_id: parsed.ids[0]!,
      ...(maxSteps !== undefined ? { max_steps: maxSteps } : {}),
      ...(typeof requestId === "string" ? { request_id: requestId } : {}),
      ...(typeof reseal === "string" ? { reseal } : {}),
    },
    { trustSource: trust.source, onProgress: (line) => stderrWrite(`lykos continue: ${line}\n`) },
  );
  print(result);
  return delegatedExitCode(result);
}

export async function runRecover(cwd: string, args: readonly string[]): Promise<number> {
  if (args.length === 0) return usage(RECOVER_USAGE);
  const parsed = parseFlags(args, "recover", ["message", "max-steps", "add"], ["trust-workspace"]);
  if ("error" in parsed) {
    stderrWrite(`${parsed.error}\n`);
    return 1;
  }
  if (parsed.ids.length !== 1) return usage(RECOVER_USAGE);
  let message: string | undefined;
  if (parsed.flags.has("message")) {
    const read = await messageOf(parsed, "recover");
    if (typeof read !== "string") {
      stderrWrite(`${read.error}\n`);
      return 1;
    }
    message = read;
  }
  const stepsRaw = parsed.flags.get("max-steps");
  const maxSteps = stepsRaw === undefined ? undefined : Number(stepsRaw);
  if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1)) {
    stderrWrite(`lykos recover: --max-steps must be a positive integer, got "${String(stepsRaw)}"\n`);
    return 1;
  }
  const add = parsed.flags.get("add");
  const trust = await trustAndShell(cwd, "recover", parsed.flags.has("trust-workspace"));
  if (trust === undefined) return 1;
  if (isCycleId(cwd, parsed.ids[0]!)) {
    const recovered = await recoverCycle(cwd, parsed.ids[0]!, {
      trustSource: trust.source,
      ...(message !== undefined ? { note: message } : {}),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      ...(typeof add === "string" ? { add } : {}),
      onProgress: (line) => stderrWrite(`lykos recover: ${line}\n`),
    });
    print(recovered);
    return delegatedExitCode(recovered);
  }
  if (add !== undefined) {
    stderrWrite("lykos recover: --add is an item for a review cycle's fixer; a session takes -m\n");
    return 1;
  }
  const { recoverSession } = await import("../delegate/recover.js");
  const result = await recoverSession(cwd, parsed.ids[0]!, {
    trustSource: trust.source,
    ...(message !== undefined ? { message } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    onProgress: (line) => stderrWrite(`lykos recover: ${line}\n`),
  });
  print(result);
  return delegatedExitCode(result);
}

export async function runStop(cwd: string, args: readonly string[]): Promise<number> {
  if (args.length === 0) return usage(STOP_USAGE);
  const parsed = parseFlags(args, "stop", [], []);
  if ("error" in parsed) {
    stderrWrite(`${parsed.error}\n`);
    return 1;
  }
  if (parsed.ids.length !== 1) return usage(STOP_USAGE);
  const id = parsed.ids[0]!;
  const stopped = await stopElsewhere(cwd, id);
  if (stopped === undefined) {
    print({ outcome: "error", message: `unknown session id: ${id}`, next: "fix_environment" });
    return 1;
  }
  print({ ...stopped, next: stopped.next ?? (stopped.state === "running" || stopped.state === "waiting" ? "wait" : "review_or_accept") });
  return 0;
}

/** R12: a command with no arguments prints its usage and the causes. */
const DECISION_USAGE: Record<DecisionKind, string> = {
  accept: "usage: lykos accept <session-id> --why <reason> [--cause <cause>] [--actor <name>]    record that you accept the session's result",
  reject: "usage: lykos reject <session-id> --why <reason> [--cause <cause>] [--actor <name>]    record that you reject the session's result, and why",
  merged: "usage: lykos merged <session-id> --why <reason> [--cause <cause>] [--actor <name>]    record that the session's work is merged",
  discard:
    "usage: lykos discard <session-id> --why <reason> [--cause <cause>] [--actor <name>]    give up on the session, ended or crashed (once everything it started is confirmed stopped); never kills anything",
};
export function decisionUsage(kind: DecisionKind): string {
  return `${DECISION_USAGE[kind]}
${CAUSE_LIST}`;
}

export async function runDecision(cwd: string, kind: DecisionKind, args: readonly string[]): Promise<number> {
  if (args.length === 0) return usage(decisionUsage(kind));
  const parsed = parseFlags(args, kind, ["why", "cause", "actor"], []);
  if ("error" in parsed) {
    stderrWrite(`${parsed.error}
`);
    return 1;
  }
  if (parsed.ids.length !== 1) return usage(decisionUsage(kind));
  const decided = await decideAt(
    defaultLedgerPath(cwd),
    kind,
    parsed.ids[0]!,
    { reason: parsed.flags.get("why"), cause: parsed.flags.get("cause"), actor: parsed.flags.get("actor") },
    "--why <reason>",
  );
  if (decided.kind === "invalid") {
    stderrWrite(`${decided.message}
`);
    return 1;
  }
  print(decided.body);
  return decided.kind === "recorded" ? 0 : 1;
}

export async function runReview(cwd: string, args: readonly string[]): Promise<number> {
  if (args.length === 0) return usage(REVIEW_USAGE);
  const parsed = parseFlags(args, "review", ["task", "message", "base", "max-steps", "request-id"], ["trust-workspace"]);
  if ("error" in parsed) {
    stderrWrite(`${parsed.error}\n`);
    return 1;
  }
  if (parsed.ids.length !== 1) return usage(REVIEW_USAGE);
  let note: string | undefined;
  if (parsed.flags.has("message")) {
    const read = await messageOf(parsed, "review");
    if (typeof read !== "string") {
      stderrWrite(`${read.error}\n`);
      return 1;
    }
    note = read;
  }
  const stepsRaw = parsed.flags.get("max-steps");
  const maxSteps = stepsRaw === undefined ? undefined : Number(stepsRaw);
  if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1)) {
    stderrWrite(`lykos review: --max-steps must be a positive integer, got "${String(stepsRaw)}"\n`);
    return 1;
  }
  const trust = await trustAndShell(cwd, "review", parsed.flags.has("trust-workspace"));
  if (trust === undefined) return 1;
  const task = parsed.flags.get("task");
  const base = parsed.flags.get("base");
  const requestId = parsed.flags.get("request-id");
  const { runReview: review } = await import("../delegate/review.js");
  const result = await review(cwd, parsed.ids[0]!, {
    trustSource: trust.source,
    ...(typeof task === "string" ? { taskFile: resolve(cwd, task) } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(typeof base === "string" ? { base } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    ...(typeof requestId === "string" ? { requestId } : {}),
    onProgress: (line) => stderrWrite(`lykos review: ${line}
`),
  });
  print(result);
  return delegatedExitCode(result);
}

/** A comma list of finding ids. */
function listOf(value: string | true | undefined): string[] {
  return typeof value === "string" ? value.split(",").map((v) => v.trim()).filter((v) => v !== "") : [];
}

export async function runCycleCommand(cwd: string, args: readonly string[]): Promise<number> {
  if (args.length === 0) return usage(CYCLE_USAGE);
  const parsed = parseFlags(args, "cycle", ["task", "message", "base", "max-steps", "add", "forward", "drop"], ["trust-workspace"]);
  if ("error" in parsed) {
    stderrWrite(`${parsed.error}
`);
    return 1;
  }
  if (parsed.ids.length !== 1) return usage(CYCLE_USAGE);
  let note: string | undefined;
  if (parsed.flags.has("message")) {
    const read = await messageOf(parsed, "cycle");
    if (typeof read !== "string") {
      stderrWrite(`${read.error}
`);
      return 1;
    }
    note = read;
  }
  const stepsRaw = parsed.flags.get("max-steps");
  const maxSteps = stepsRaw === undefined ? undefined : Number(stepsRaw);
  if (maxSteps !== undefined && (!Number.isInteger(maxSteps) || maxSteps < 1)) {
    stderrWrite(`lykos cycle: --max-steps must be a positive integer, got "${String(stepsRaw)}"\n`);
    return 1;
  }
  const trust = await trustAndShell(cwd, "cycle", parsed.flags.has("trust-workspace"));
  if (trust === undefined) return 1;
  const task = parsed.flags.get("task");
  const base = parsed.flags.get("base");
  const add = parsed.flags.get("add");
  const result = await runCycle(cwd, parsed.ids[0]!, {
    trustSource: trust.source,
    ...(typeof task === "string" ? { taskFile: resolve(cwd, task) } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(typeof base === "string" ? { base } : {}),
    ...(maxSteps !== undefined ? { maxSteps } : {}),
    ...(typeof add === "string" ? { add } : {}),
    forward: listOf(parsed.flags.get("forward")),
    drop: listOf(parsed.flags.get("drop")),
    onProgress: (line) => stderrWrite(`lykos cycle: ${line}
`),
  });
  print(result);
  return delegatedExitCode(result);
}
