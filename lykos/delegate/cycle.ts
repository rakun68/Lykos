// The review cycle (T236, ADR-0059, ADR-0061, spec decisions 13 and 18): `lykos cycle <session>` reviews a delegated
// session's change, has the session fix what the review proves, and has the same reviewer recheck, until nothing is
// left open or something needs the coordinator. Code drives it; no model decides what happens next.
//
// The loop, one step at a time, each step written to the ledger before it acts (`cycle_steps`):
//   review   round 1: one reviewer reads the whole change and records findings with the `finding` tool;
//   judge    the harness runs every finding's check and decides by rule (`judgeFindings`): blocks, triage or dropped;
//   fix      the implementer's session is continued with every open item at once, whole (R20), and must run the proofs
//            and their neighbours green;
//   proof    the proof suite, the reproductions of every finding that was ever proven, is rerun at the new head;
//   recheck  the same reviewer session reads the fix's diff and records what is still wrong, or new;
//   judge    again. A proof that no longer fails retires its finding; one that fails again is open again.
//
// A step that starts a session carries `request_id` = cycle id + step id, so a recovered cycle finds the session it
// started (`owner_requests`) and never starts a second one (G10). Every session the cycle starts runs with decide-alone
// off: a question nobody answers in time stops the cycle with `answer_question`, and the answer becomes a ruling for the
// fixer and every later reviewer (spec decision 18). An environment or provider error stops the round before any test
// (G3, G4) with `fix_environment`; resuming reruns that step only.
//
// Lessons held here: G3, G4, G6, G10, G11, R8, R20, W3 (Boxie parity table); cause `worker_careless`.
//   - G11: the caps are `delegation.cycle_max_rounds`, `cycle_max_fixes` and `cycle_stall_after`, read from the loaded
//     config where they are used. No other number decides when the cycle stops.
//   - R8: only the steps the cycle needs run. No second reviewer, no baseline of its own, no proof step without a proof,
//     no recheck without a fix.
//   - W3: more retries mean more cheating, so the fixes and the rounds are capped, and a stall stops the cycle.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import type { ResolvedConfig } from "../config/types.js";
import type { TrustSource } from "../gate/trust.js";
import { defaultLedgerPath, withLedger, withLedgerSync, type Ledger } from "../ledger/use.js";
import { confirmQuiescence, type QuiescenceDeps } from "../process/quiescence.js";
import { checkClaims } from "./claim-checks.js";
import type { ClaimCheck } from "./claims.js";
import { recordFindingDecision } from "./decisions.js";
import { findingKey, findingsOf, type JudgedFinding, type Severity, type StoredFinding } from "./findings.js";
import { runDelegated } from "./mcp-server.js";
import {
  closeQuestions,
  isLive,
  MAX_CRASHES,
  openQuestions,
  ownerLiveness,
  ownerRow,
  selfIdentity,
  type LivenessOf,
  type OwnerRow,
} from "./ownership.js";
import { recoverSession } from "./recover.js";
import { MAX_BRIEF_DIFF_CHARS, REVIEW_ROLE, changeOf, flagsOfChange, judgeFindings, planReview } from "./review.js";
import { commitOf, sessionModelPath } from "./session-base.js";
import type { ContainmentChoice, SessionFlag, SessionRunner } from "./session-protocol.js";
import { renderRulings } from "./spec-check.js";

/** Where a cycle can stop and ask for the coordinator (spec decision 13). */
export const CYCLE_STOPS = ["approve", "answer_spec", "triage", "answer_question", "decide", "fix_environment", "recover"] as const;
export type CycleStop = (typeof CYCLE_STOPS)[number];

export type StepKind = "review" | "judge" | "fix" | "proof" | "recheck" | "triage" | "add";
type StepState = "started" | "done" | "error";

/** The steps that start a session. */
const SESSION_STEPS: ReadonlySet<StepKind> = new Set(["review", "fix", "recheck"]);
/** The steps the coordinator's options write; they are inputs, not work, and are never retried. */
const INPUT_STEPS: ReadonlySet<StepKind> = new Set(["triage", "add"]);

/** One thing the fixer has to do: a finding that blocks, one the coordinator forwarded or added, or a red verification. */
export interface Item {
  /** Identifies the same defect across rounds: the reproduction's file and tests, the command, or the text. */
  key: string;
  source: "finding" | "triage" | "added" | "verification";
  finding_id?: string;
  severity: Severity;
  text: string;
  basis: string;
  /** The whole check, never the reported shortcut: a reproduction keeps its file's text (R20). */
  check?: ClaimCheck;
}

export interface Step {
  cycle_id: string;
  seq: number;
  step_id: string;
  kind: StepKind;
  round: number;
  state: StepState;
  request_id: string | null;
  session_id: string | null;
  started_at: string;
  ended_at: string | null;
  input: Record<string, unknown>;
  result: Record<string, unknown> | undefined;
}

interface StepRow extends Omit<Step, "input" | "result"> {
  input_json: string | null;
  result_json: string | null;
}

interface CycleRow {
  id: string;
  target_session: string;
  branch: string;
  base_commit: string;
  options_json: string;
  owner_pid: number;
  owner_recorded_at_ms: number;
  state: "running" | "stopped" | "done";
  stop: CycleStop | null;
  started_at: string;
  ended_at: string | null;
  crashes: number;
  result_json: string | null;
}

/** What the coordinator gave the cycle that outlives one process: kept on the row, so a resume merges into it. */
interface StoredOptions {
  taskFile?: string;
  note?: string;
  maxSteps?: number;
}

export interface CycleOptions {
  /** `--task`: a task file; its body, scope and files are what the change is judged against. */
  taskFile?: string | undefined;
  /** `-m`: answers the open question of a cycle stopped with `answer_question`, else a note to the reviewer. */
  note?: string | undefined;
  base?: string | undefined;
  maxSteps?: number | undefined;
  /** `--add`: one more item for the fixer, whatever the review found. */
  add?: string | undefined;
  /** `--forward` and `--drop`: finding ids left to triage, decided. */
  forward?: readonly string[] | undefined;
  drop?: readonly string[] | undefined;
  trustSource: TrustSource;
  signal?: AbortSignal | undefined;
  onProgress?: ((message: string) => void) | undefined;
  /** Tests: the session runner. Absent: a real session child. */
  run?: SessionRunner | undefined;
  livenessOf?: LivenessOf | undefined;
  quiescence?: QuiescenceDeps | undefined;
}

// ---------------------------------------------------------------------------
// The ledger

const STEP_COLUMNS = "cycle_id, seq, step_id, kind, round, state, request_id, session_id, started_at, ended_at, input_json, result_json";
const CYCLE_COLUMNS = "id, target_session, branch, base_commit, options_json, owner_pid, owner_recorded_at_ms, state, stop, started_at, ended_at, crashes, result_json";

function toStep(row: StepRow): Step {
  const { input_json, result_json, ...rest } = row;
  return {
    ...rest,
    input: input_json !== null ? (JSON.parse(input_json) as Record<string, unknown>) : {},
    result: result_json !== null ? (JSON.parse(result_json) as Record<string, unknown>) : undefined,
  };
}

export function cycleRow(ledger: Ledger, id: string): CycleRow | undefined {
  return ledger.db.prepare(`SELECT ${CYCLE_COLUMNS} FROM cycles WHERE id = ?`).get(id) as CycleRow | undefined;
}

export function stepsOf(ledger: Ledger, cycleId: string): Step[] {
  return (ledger.db.prepare(`SELECT ${STEP_COLUMNS} FROM cycle_steps WHERE cycle_id = ? ORDER BY seq ASC`).all(cycleId) as StepRow[]).map(toStep);
}

/** Writes a step as `started`, before it acts. A session step carries its request id. */
function beginStep(ledger: Ledger, cycleId: string, kind: StepKind, round: number, input: Record<string, unknown>): Step {
  const write = ledger.db.transaction((): Step => {
    const seq = (ledger.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM cycle_steps WHERE cycle_id = ?").get(cycleId) as { n: number }).n;
    const stepId = `s${seq}`;
    const requestId = SESSION_STEPS.has(kind) ? `${cycleId}.${stepId}` : null;
    const startedAt = new Date().toISOString();
    ledger.db
      .prepare(`INSERT INTO cycle_steps (cycle_id, seq, step_id, kind, round, state, request_id, started_at, input_json) VALUES (?, ?, ?, ?, ?, 'started', ?, ?, ?)`)
      .run(cycleId, seq, stepId, kind, round, requestId, startedAt, JSON.stringify(input));
    return { cycle_id: cycleId, seq, step_id: stepId, kind, round, state: "started", request_id: requestId, session_id: null, started_at: startedAt, ended_at: null, input, result: undefined };
  });
  return write.immediate();
}

function endStep(ledger: Ledger, step: Step, state: Exclude<StepState, "started">, result: Record<string, unknown>, sessionId?: string): void {
  ledger.db
    .prepare("UPDATE cycle_steps SET state = ?, ended_at = ?, result_json = ?, session_id = COALESCE(?, session_id) WHERE cycle_id = ? AND seq = ?")
    .run(state, new Date().toISOString(), JSON.stringify(result), sessionId ?? null, step.cycle_id, step.seq);
  step.state = state;
  step.result = result;
  if (sessionId !== undefined) step.session_id = sessionId;
}

/** The owner row of the session a request id started, or undefined when no session was admitted under it. */
function sessionOfRequest(ledger: Ledger, requestId: string): OwnerRow | undefined {
  const found = ledger.db.prepare("SELECT session_id FROM owner_requests WHERE request_id = ?").get(requestId) as { session_id: string } | undefined;
  return found === undefined ? undefined : ownerRow(ledger, found.session_id);
}

// ---------------------------------------------------------------------------
// Caps, items and the rule for what comes next

interface Caps {
  rounds: number;
  fixes: number;
  stall: number;
}

/** The caps, from the loaded config and nowhere else (G11). */
export function capsOf(config: ResolvedConfig): Caps {
  return { rounds: config.delegation.cycle_max_rounds, fixes: config.delegation.cycle_max_fixes, stall: config.delegation.cycle_stall_after };
}

interface JudgeResult {
  head: string;
  round: number;
  open: Item[];
  triage: Item[];
  counts: { blocks: number; triage: number; dropped: number };
  open_count: number;
  /** Consecutive rounds, up to this one, that left no fewer items open than the round before. */
  stall: number;
}

type Evaluation =
  | { kind: "approve" }
  | { kind: "stop"; token: Exclude<CycleStop, "approve">; message: string; items?: Item[]; triage?: Item[] }
  | { kind: "fix"; items: Item[] };

const done = (steps: readonly Step[], kind: StepKind): Step[] => steps.filter((s) => s.kind === kind && s.state === "done");

function dedupe(items: readonly Item[]): Item[] {
  const seen = new Set<string>();
  const out: Item[] = [];
  for (const item of items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    out.push(item);
  }
  return out;
}

/** The same defect, named the same in every round. */
export function itemKey(check: ClaimCheck | undefined, text: string, severity: string): string {
  if (check?.kind === "reproduction") return `repro:${check.file}|${[...check.fails].sort().join(",")}`;
  if (check?.kind === "command") return `cmd:${check.command}|${check.exit}`;
  return `text:${severity}:${text.trim()}`;
}

function itemOf(f: StoredFinding, source: Item["source"] = "finding"): Item {
  return {
    key: itemKey(f.check, f.text, f.severity),
    source,
    finding_id: findingKey(f),
    severity: f.severity,
    text: f.text,
    basis: f.basis,
    ...(f.check !== undefined ? { check: f.check } : {}),
  };
}

/**
 * What the cycle does next, from the steps alone. Pure: a recovered or resumed cycle reads its steps and arrives at
 * the same answer the dead process would have.
 */
export function evaluate(steps: readonly Step[], caps: Caps): Evaluation {
  const judges = done(steps, "judge");
  const lastJudge = judges.at(-1);
  if (lastJudge?.result === undefined) return { kind: "stop", token: "fix_environment", message: "the cycle has no judged review to continue from" };
  const judge = lastJudge.result as unknown as JudgeResult;

  const after = steps.filter((s) => s.seq > lastJudge.seq);
  const decided = new Set<string>();
  for (const s of after) {
    if (s.kind !== "triage") continue;
    for (const id of (s.input["decided"] as string[] | undefined) ?? []) decided.add(id);
  }
  const pending = judge.triage.filter((t) => t.finding_id !== undefined && !decided.has(t.finding_id));
  if (pending.length > 0) {
    return { kind: "stop", token: "triage", message: `${pending.length} finding${pending.length === 1 ? "" : "s"} without a reproduction need your ruling: resume with --forward <id> to hand one to the fixer or --drop <id> to set it aside`, triage: pending };
  }

  // Inputs the coordinator gave since the last fix are the fixer's next, once: forwarded triage and added items.
  const lastFix = done(steps, "fix").at(-1)?.seq ?? 0;
  const given: Item[] = [];
  for (const s of steps) {
    if (s.seq <= lastFix) continue;
    if (s.kind === "add") given.push(s.input["item"] as Item);
    else if (s.kind === "triage") given.push(...((s.input["forward"] as Item[] | undefined) ?? []));
  }
  const items = dedupe([...judge.open, ...given]);
  if (items.length === 0) return { kind: "approve" };

  const rounds = judges.length;
  const fixes = done(steps, "fix").length;
  if (judge.stall >= caps.stall) {
    return { kind: "stop", token: "decide", message: `the cycle stalled: ${judge.stall} rounds in a row left no fewer than ${judge.open_count} item${judge.open_count === 1 ? "" : "s"} open (delegation.cycle_stall_after is ${caps.stall})`, items };
  }
  if (fixes >= caps.fixes) {
    return { kind: "stop", token: "decide", message: `${fixes} fixes are done and ${items.length} item${items.length === 1 ? " is" : "s are"} still open (delegation.cycle_max_fixes is ${caps.fixes})`, items };
  }
  if (rounds >= caps.rounds) {
    return { kind: "stop", token: "decide", message: `${rounds} rounds are done and ${items.length} item${items.length === 1 ? " is" : "s are"} still open (delegation.cycle_max_rounds is ${caps.rounds})`, items };
  }
  return { kind: "fix", items };
}

// ---------------------------------------------------------------------------
// Briefs

/** One item as the fixer reads it: the whole of it, including the scenario when the description is empty (R20). */
export function renderItem(item: Item, index: number): string {
  const lines = [`### ${index}. ${item.severity}: ${item.text.trim() === "" ? "(the reviewer gave no description; the scenario below is the finding)" : item.text.trim()}`];
  if (item.basis.trim() !== "") lines.push(`Basis: ${item.basis}`);
  const c = item.check;
  if (c === undefined) {
    lines.push(item.source === "added" ? "The coordinator added this item." : "No reproduction was given; this rests on the reviewer's reading of the change.");
  } else if (c.kind === "reproduction") {
    lines.push(
      `Scenario: the test file \`${c.file}\` fails today, in: ${c.fails.map((n) => `\`${n}\``).join(", ")}. Its whole text:`,
      "```",
      c.content,
      "```",
    );
  } else if (c.kind === "command") {
    lines.push(`Scenario: \`${c.command}\` exits ${c.exit} today, and that is the defect.`);
  } else if (c.kind === "line") {
    lines.push(`Scenario: \`${c.path}\` line ${c.line} contains \`${c.text}\`.`);
  } else {
    lines.push(`Scenario: ${c.matches} line${c.matches === 1 ? "" : "s"} match /${c.pattern}/${c.paths !== undefined ? ` in ${c.paths.join(", ")}` : ""}.`);
  }
  return lines.join("\n");
}

export function fixBrief(items: readonly Item[], rulings: ReadonlyArray<{ point: string; ruling: string }>, round: number, note: string | undefined): string {
  const proofs = items.filter((i) => i.check?.kind === "reproduction");
  return [
    `A reviewer of another model family read your change (round ${round}). ${items.length} item${items.length === 1 ? " is" : "s are"} open. Fix all of them in this one pass; none is optional, and none is for a later round.`,
    note !== undefined && note.trim() !== "" ? `From the coordinator:\n${note.trim()}` : "",
    renderRulings(rulings),
    "## Open items",
    items.map((item, i) => renderItem(item, i + 1)).join("\n\n"),
    "## Before you finish",
    [
      proofs.length > 0
        ? `- Keep each reproduction above, unchanged, as a test in your branch, at the path it names (the harness runs that file as it stands, and refuses one whose text differs). Run them: every one must pass after your fix. They are the proof suite, and the harness reruns them at your head.`
        : "- No item has a reproduction. State in your answer, for each, what you changed and where.",
      "- Run the verification command and the tests beside the files you changed. They must stay green: a fix that breaks a neighbour is not a fix.",
      "- Do not weaken, skip or delete a test to make it pass, and do not special-case an input a test reads.",
      "- Commit your work on your branch.",
    ].join("\n"),
  ]
    .filter((p) => p !== "")
    .join("\n\n");
}

export function recheckBrief(opts: { task?: string; items: readonly Item[]; rulings: ReadonlyArray<{ point: string; ruling: string }>; from: string; to: string; stat: string; diff: string; note: string | undefined }): string {
  const truncated = opts.diff.length > MAX_BRIEF_DIFF_CHARS;
  return [
    `The implementer changed the branch since your last review, to fix what you and the coordinator found. Recheck the fix: the diff below is what it changed (${opts.from.slice(0, 12)}..${opts.to.slice(0, 12)}).`,
    opts.task !== undefined && opts.task.trim() !== "" ? `## The task the change was made for

${opts.task.trim()}` : "",
    opts.note !== undefined && opts.note.trim() !== "" ? `From the coordinator:\n${opts.note.trim()}` : "",
    renderRulings(opts.rulings),
    "## What was handed to the fixer",
    opts.items.map((item, i) => renderItem(item, i + 1)).join("\n\n"),
    "## How to report",
    [
      "- Record with the `finding` tool every defect that is still there and every new one the fix introduced, one call each, with a check whenever a test can show it. Do not record a finding the fix resolved.",
      "- The harness reruns the reproductions of the earlier findings itself, so you do not need to repeat those that still fail; repeat any whose scenario the fix only moved.",
      "- Judge the fix against the task and the tests, not only against the findings: a fix that special-cases a test's input is a finding.",
      "- Do not edit anything.",
    ].join("\n"),
    "## The fix",
    opts.stat === "" ? "(no file changes)" : opts.stat,
    "```diff",
    truncated ? opts.diff.slice(0, MAX_BRIEF_DIFF_CHARS) : opts.diff,
    "```",
    truncated ? `The diff is cut at ${MAX_BRIEF_DIFF_CHARS} characters. The rest: \`git diff ${opts.from.slice(0, 12)}..${opts.to.slice(0, 12)}\`.` : "",
  ]
    .filter((p) => p !== "")
    .join("\n\n");
}

/** The coordinator's answers to the questions the cycle's sessions asked, in the order they were given. */
function cycleRulings(ledger: Ledger, cycleId: string): Array<{ point: string; ruling: string }> {
  return (ledger.db.prepare("SELECT question, ruling FROM cycle_rulings WHERE cycle_id = ? ORDER BY id ASC").all(cycleId) as Array<{ question: string; ruling: string }>).map(
    (r) => ({ point: r.question, ruling: r.ruling }),
  );
}

/**
 * Questions a session asked and the coordinator answered with `steer` become rulings: the answer is the first message
 * posted to the session after the question. A ruling binds the fixer and every later reviewer.
 */
function collectRulings(ledger: Ledger, cycleId: string, sessionId: string): void {
  const questions = ledger.db
    .prepare("SELECT question, asked_at FROM questions WHERE session_id = ? AND answered_by = 'steer' ORDER BY id ASC")
    .all(sessionId) as Array<{ question: string; asked_at: string }>;
  if (questions.length === 0) return;
  const inbox = ledger.db.prepare("SELECT message, created_at FROM inbox WHERE session_id = ? ORDER BY id ASC").all(sessionId) as Array<{ message: string; created_at: string }>;
  const insert = ledger.db.prepare("INSERT OR IGNORE INTO cycle_rulings (cycle_id, session_id, question, ruling, ts) VALUES (?, ?, ?, ?, ?)");
  for (const q of questions) {
    const answer = inbox.find((m) => m.created_at >= q.asked_at);
    if (answer !== undefined) insert.run(cycleId, sessionId, q.question, answer.message, new Date().toISOString());
  }
}

// ---------------------------------------------------------------------------
// Running a cycle

interface Ctx {
  workspace: string;
  ledgerPath: string;
  cycleId: string;
  opts: CycleOptions;
  config: ResolvedConfig;
  stored: StoredOptions;
  /** The implementer's session and its branch: the fixer, and the change under review. */
  session: string;
  branch: string;
  base: string;
}

const progress = (ctx: Ctx, message: string): void => ctx.opts.onProgress?.(`cycle ${ctx.cycleId}: ${message}`);

const errorResult = (message: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ outcome: "error", message, next: "fix_environment", ...extra });

function tip(ctx: Ctx): string | undefined {
  return commitOf(ctx.workspace, ctx.branch);
}

/** The result a session step ended with, classified by what the cycle does about it. */
type Classified =
  | { kind: "ok"; verificationFailed?: { command: string | null; tail: string } }
  | { kind: "environment"; message: string }
  | { kind: "question"; question: string }
  | { kind: "spec"; message: string }
  | { kind: "decide"; message: string };

function classify(ctx: Ctx, result: Record<string, unknown>, sessionId: string | undefined): Classified {
  const message = typeof result["message"] === "string" ? result["message"] : typeof result["reason"] === "string" ? result["reason"] : `the session ended ${String(result["outcome"])}`;
  const unanswered = Array.isArray(result["unanswered_questions"]) ? (result["unanswered_questions"] as unknown[]).find((q): q is string => typeof q === "string") : undefined;
  const open = sessionId !== undefined ? withLedgerSync(ctx.ledgerPath, (l) => openQuestions(l, [sessionId])[0]?.question) : undefined;
  if (result["outcome"] === "needs_answer") {
    return result["next"] === "answer_spec" ? { kind: "spec", message: typeof result["question"] === "string" ? result["question"] : message } : { kind: "question", question: typeof result["question"] === "string" ? result["question"] : (open ?? message) };
  }
  if (unanswered !== undefined || (open !== undefined && result["outcome"] !== "ok" && result["outcome"] !== "unverified")) return { kind: "question", question: unanswered ?? open! };
  if (result["outcome"] === "disputed") return { kind: "decide", message: "a sealed test is disputed; rule on it with `lykos continue --reseal` or reject the dispute" };
  // A run that ended in an error on a session that had already ended once reads as a finished run; the result says so.
  if (typeof result["runner_error"] === "string") return { kind: "environment", message: result["runner_error"] };
  if (result["outcome"] === "ok" || result["outcome"] === "unverified") return { kind: "ok" };
  if (result["outcome"] === "error" && result["next"] === "continue_with_failure") {
    const v = result["verification"] as { command?: string | null; output_tail?: string } | undefined;
    return { kind: "ok", verificationFailed: { command: v?.command ?? null, tail: v?.output_tail ?? "" } };
  }
  return { kind: "environment", message };
}

type StepOutcome = { stop: undefined } | { stop: Exclude<CycleStop, "approve">; message: string; extra?: Record<string, unknown> };

/** Runs one session step: finds the session its request id started, or recovers it, or starts it. Never starts a second. */
async function runSession(ctx: Ctx, step: Step, args: Parameters<typeof runDelegated>[1]): Promise<{ result: Record<string, unknown> } | { blocked: string }> {
  const existing = withLedgerSync(ctx.ledgerPath, (l) => sessionOfRequest(l, step.request_id!));
  const deps = {
    trustSource: ctx.opts.trustSource,
    ...(ctx.opts.signal !== undefined ? { signal: ctx.opts.signal } : {}),
    ...(ctx.opts.onProgress !== undefined ? { onProgress: ctx.opts.onProgress } : {}),
    ...(ctx.opts.run !== undefined ? { run: ctx.opts.run } : {}),
  };
  if (existing === undefined) {
    return { result: await runDelegated(ctx.workspace, { ...args, request_id: step.request_id!, decide_alone: false }, deps) };
  }
  if (isLive(existing.state)) {
    const liveness = (ctx.opts.livenessOf ?? ownerLiveness)(existing);
    if (liveness !== "dead") return { blocked: `the step's session ${existing.session_id} is ${existing.state}, owned by pid ${existing.owner_pid} (${liveness}); the cycle starts nothing twice` };
    progress(ctx, `${step.step_id}: its session ${existing.session_id} crashed; recovering it`);
    const recovered = await recoverSession(ctx.workspace, existing.session_id, {
      trustSource: ctx.opts.trustSource,
      decideAlone: false,
      ...(ctx.opts.signal !== undefined ? { signal: ctx.opts.signal } : {}),
      ...(ctx.opts.onProgress !== undefined ? { onProgress: ctx.opts.onProgress } : {}),
      ...(ctx.opts.run !== undefined ? { run: ctx.opts.run } : {}),
      ...(ctx.opts.livenessOf !== undefined ? { livenessOf: ctx.opts.livenessOf } : {}),
      ...(ctx.opts.quiescence !== undefined ? { quiescence: ctx.opts.quiescence } : {}),
    });
    return { result: recovered };
  }
  progress(ctx, `${step.step_id}: its session ${existing.session_id} already ended; not started again`);
  return { result: existing.result_json !== null ? (JSON.parse(existing.result_json) as Record<string, unknown>) : { outcome: "error", message: `session ${existing.session_id} ended with no result`, sessionId: existing.session_id, next: "fix_environment" } };
}

function reviewerSession(steps: readonly Step[]): string | undefined {
  return done(steps, "review").at(-1)?.session_id ?? undefined;
}

function latestMax(ledger: Ledger, sessionId: string): number {
  return (ledger.db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM findings WHERE session_id = ?").get(sessionId) as { n: number }).n;
}

/** The end of a session step: its result recorded, rulings collected, and the stop it asks for, if any. */
function finishSessionStep(ctx: Ctx, step: Step, result: Record<string, unknown>): { classified: Classified; sessionId: string | undefined } {
  const sessionId = typeof result["sessionId"] === "string" ? result["sessionId"] : typeof result["session_id"] === "string" ? result["session_id"] : undefined;
  const classified = classify(ctx, result, sessionId);
  withLedgerSync(ctx.ledgerPath, (l) => {
    if (sessionId !== undefined) collectRulings(l, ctx.cycleId, sessionId);
    endStep(l, step, classified.kind === "ok" ? "done" : "error", { ...result, classified: classified.kind, ...(classified.kind === "ok" && classified.verificationFailed !== undefined ? { verification_failed: classified.verificationFailed } : {}) }, sessionId);
  });
  return { classified, sessionId };
}

function stopOf(classified: Exclude<Classified, { kind: "ok" }>, sessionId: string | undefined): StepOutcome {
  switch (classified.kind) {
    case "environment":
      return { stop: "fix_environment", message: classified.message };
    case "question":
      return { stop: "answer_question", message: `a session of the cycle asked a question nobody answered: ${classified.question}`, extra: { question: { session_id: sessionId, question: classified.question } } };
    case "spec":
      return { stop: "answer_spec", message: classified.message };
    case "decide":
      return { stop: "decide", message: classified.message };
  }
}

async function stepReview(ctx: Ctx, step: Step): Promise<StepOutcome> {
  const input = step.input as { brief: string; model?: string; files?: string[]; base: string; retryOf?: string; continueSession?: string };
  const rulings = withLedgerSync(ctx.ledgerPath, (l) => cycleRulings(l, ctx.cycleId));
  const args: Parameters<typeof runDelegated>[1] =
    input.continueSession !== undefined
      ? { brief: input.brief, session_id: input.continueSession, specialist: REVIEW_ROLE, review: true, ...(input.model !== undefined ? { model: input.model } : {}), ...(ctx.stored.maxSteps !== undefined ? { max_steps: ctx.stored.maxSteps } : {}) }
      : {
          brief: rulings.length > 0 ? `${input.brief}\n\n${renderRulings(rulings)}` : input.brief,
          specialist: REVIEW_ROLE,
          ...(input.model !== undefined ? { model: input.model } : {}),
          base: input.base,
          review: true,
          rulings_from: [ctx.session],
          ...(input.files !== undefined && input.files.length > 0 ? { files: input.files } : {}),
          ...(ctx.stored.maxSteps !== undefined ? { max_steps: ctx.stored.maxSteps } : {}),
        };
  const ran = await runSession(ctx, step, args);
  if ("blocked" in ran) return { stop: "fix_environment", message: ran.blocked };
  const { classified, sessionId } = finishSessionStep(ctx, step, ran.result);
  if (classified.kind !== "ok") return stopOf(classified, sessionId);
  if (sessionId === undefined) {
    withLedgerSync(ctx.ledgerPath, (l) => endStep(l, step, "error", { ...ran.result, classified: "environment" }));
    return { stop: "fix_environment", message: "the reviewer ended with no session id" };
  }
  return { stop: undefined };
}

async function stepFix(ctx: Ctx, step: Step): Promise<StepOutcome> {
  const input = step.input as { brief: string };
  const owner = withLedgerSync(ctx.ledgerPath, (l) => ownerRow(l, ctx.session));
  // A continuation keeps the model the implementer ran on, by its full path (the ledger's bare id names the wrong provider).
  const model = withLedgerSync(ctx.ledgerPath, (l) => sessionModelPath(l, ctx.session));
  const ran = await runSession(ctx, step, {
    brief: input.brief,
    session_id: ctx.session,
    ...(model !== undefined ? { model } : {}),
    ...(owner?.specialist != null ? { specialist: owner.specialist } : {}),
    ...(ctx.stored.maxSteps !== undefined ? { max_steps: ctx.stored.maxSteps } : {}),
  });
  if ("blocked" in ran) return { stop: "fix_environment", message: ran.blocked };
  const { classified, sessionId } = finishSessionStep(ctx, step, ran.result);
  if (classified.kind !== "ok") return stopOf(classified, sessionId);
  return { stop: undefined };
}

async function stepRecheck(ctx: Ctx, step: Step): Promise<StepOutcome> {
  const input = step.input as { brief: string; reviewer: string; model?: string };
  const ran = await runSession(ctx, step, {
    brief: input.brief,
    session_id: input.reviewer,
    specialist: REVIEW_ROLE,
    review: true,
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(ctx.stored.maxSteps !== undefined ? { max_steps: ctx.stored.maxSteps } : {}),
  });
  if ("blocked" in ran) return { stop: "fix_environment", message: ran.blocked };
  const { classified, sessionId } = finishSessionStep(ctx, step, ran.result);
  if (classified.kind !== "ok") return stopOf(classified, sessionId);
  return { stop: undefined };
}

/** The reproductions of every finding that was ever proven in this cycle: the proof suite. */
function proofSuite(ledger: Ledger, reviewerSessions: readonly string[]): StoredFinding[] {
  const out: StoredFinding[] = [];
  for (const session of reviewerSessions) {
    const proven = new Set(
      (ledger.db.prepare("SELECT id FROM findings WHERE session_id = ? AND disposition = 'blocks' AND kind = 'reproduction'").all(session) as Array<{ id: number }>).map((r) => r.id),
    );
    out.push(...findingsOf(ledger, session).filter((f) => proven.has(f.id)));
  }
  // A reviewer who repeats a finding gives the suite one proof, not two.
  const seen = new Set<string>();
  return out.filter((f) => {
    const key = itemKey(f.check, f.text, f.severity);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reviewerSessions(steps: readonly Step[]): string[] {
  return [...new Set(done(steps, "review").flatMap((s) => (s.session_id !== null ? [s.session_id] : [])))];
}

function containmentOf(ctx: Ctx): ContainmentChoice {
  return ctx.config.containment.level ?? "off";
}

async function stepProof(ctx: Ctx, step: Step, steps: readonly Step[]): Promise<StepOutcome> {
  const head = tip(ctx);
  if (head === undefined) return finishProof(ctx, step, "fix_environment", `branch ${ctx.branch} names no commit`);
  const sessions = reviewerSessions(steps);
  const suite = withLedgerSync(ctx.ledgerPath, (l) => proofSuite(l, sessions));
  const holding: string[] = [];
  const fixed: string[] = [];
  const unchecked: string[] = [];
  for (const session of sessions) {
    const claims = suite.filter((f) => f.session_id === session);
    if (claims.length === 0) continue;
    // No base: the proof suite asks whether the defect is still there, not whether the change made it.
    const results = await checkClaims({
      repo: ctx.workspace,
      ledgerPath: ctx.ledgerPath,
      sessionId: session,
      claims: claims.map((f) => ({ id: f.id, session_id: f.session_id, ts: f.ts, text: f.text, check: f.check! })),
      head,
      trust: ctx.opts.trustSource,
      containment: containmentOf(ctx),
      testCommand: ctx.config.seal.test_command,
      shellPath: ctx.config.delegation.shell_path,
    });
    for (const r of results) {
      const f = claims.find((c) => c.id === r.id)!;
      const key = findingKey(f);
      if (r.verdict === "verified") holding.push(key);
      else if (r.verdict === "failed") fixed.push(key);
      else unchecked.push(`${key}: ${r.reason}`);
    }
  }
  if (unchecked.length > 0) return finishProof(ctx, step, "fix_environment", `the proof suite could not run: ${unchecked.join("; ")}`);
  withLedgerSync(ctx.ledgerPath, (l) => {
    for (const key of fixed) {
      recordFindingDecision(l, { sessionId: ctx.session, cycleId: ctx.cycleId, findingId: key, action: "retired", reason: `its reproduction no longer fails at ${head.slice(0, 12)}` });
    }
    for (const key of holding) {
      // A finding retired earlier whose reproduction fails again is open again: the latest row says so.
      const latest = l.db
        .prepare("SELECT action FROM finding_decisions WHERE session_id = ? AND finding_id = ? AND cycle_id = ? ORDER BY id DESC LIMIT 1")
        .get(ctx.session, key, ctx.cycleId) as { action: string } | undefined;
      if (latest?.action === "retired") recordFindingDecision(l, { sessionId: ctx.session, cycleId: ctx.cycleId, findingId: key, action: "forwarded", reason: `its reproduction fails again at ${head.slice(0, 12)}` });
    }
    endStep(l, step, "done", { head, holding, fixed, suite: suite.length });
  });
  return { stop: undefined };
}

function finishProof(ctx: Ctx, step: Step, stop: "fix_environment", message: string): StepOutcome {
  withLedgerSync(ctx.ledgerPath, (l) => endStep(l, step, "error", { stop, message }));
  return { stop, message };
}

async function stepJudge(ctx: Ctx, step: Step, steps: readonly Step[]): Promise<StepOutcome> {
  const input = step.input as { from: number; reviewer: string };
  const head = tip(ctx);
  if (head === undefined) {
    withLedgerSync(ctx.ledgerPath, (l) => endStep(l, step, "error", { message: `branch ${ctx.branch} names no commit` }));
    return { stop: "fix_environment", message: `branch ${ctx.branch} names no commit` };
  }
  const stored = withLedgerSync(ctx.ledgerPath, (l) => findingsOf(l, input.reviewer).filter((f) => f.id > input.from));
  const judged: JudgedFinding[] = await judgeFindings({
    workspace: ctx.workspace,
    ledgerPath: ctx.ledgerPath,
    reviewerId: input.reviewer,
    stored,
    head,
    base: ctx.base,
    targetSession: ctx.session,
    cycleId: ctx.cycleId,
    trust: ctx.opts.trustSource,
    containment: containmentOf(ctx),
    testCommand: ctx.config.seal.test_command,
    shellPath: ctx.config.delegation.shell_path,
  });

  const byId = new Map(stored.map((f) => [findingKey(f), f]));
  const open: Item[] = judged.filter((j) => j.disposition === "blocks").map((j) => itemOf(byId.get(j.finding_id)!));
  const triage: Item[] = judged.filter((j) => j.disposition === "triage").map((j) => itemOf(byId.get(j.finding_id)!, "triage"));

  // Proofs from earlier rounds that still fail at this head are open, whether or not the reviewer repeated them.
  const lastFix = done(steps, "fix").at(-1);
  const lastProof = lastFix !== undefined ? done(steps, "proof").filter((s) => s.seq > lastFix.seq).at(-1) : undefined;
  const holding = (lastProof?.result?.["holding"] as string[] | undefined) ?? [];
  if (holding.length > 0) {
    const sessions = reviewerSessions(steps);
    const suite = withLedgerSync(ctx.ledgerPath, (l) => proofSuite(l, sessions));
    for (const f of suite) if (holding.includes(findingKey(f))) open.push(itemOf(f));
  }
  const failed = lastFix?.result?.["verification_failed"] as { command: string | null; tail: string } | undefined;
  if (failed !== undefined) {
    open.push({
      key: "verification",
      source: "verification",
      severity: "high",
      text: `The verification command${failed.command !== null ? ` (\`${failed.command}\`)` : ""} fails after your last fix, so a test beside the change is red.`,
      basis: "the harness ran the verification command at the end of the fix",
      ...(failed.tail !== "" ? { check: { kind: "command" as const, command: failed.command ?? "the verification command", exit: 1 } } : {}),
    });
    const last = open.at(-1)!;
    last.text += failed.tail !== "" ? `\nIts output ends:\n${failed.tail}` : "";
  }
  const items = dedupe(open);

  // The forwarded triage items the last fix was given are cleared by that fix's recheck: retired. The reviewer reports
  // again, as a new finding, any it finds still wrong.
  if (lastFix !== undefined) {
    const handed = steps.filter((s) => s.kind === "triage" && s.seq < lastFix.seq).flatMap((s) => (s.input["forward"] as Item[] | undefined) ?? []);
    withLedgerSync(ctx.ledgerPath, (l) => {
      for (const item of handed) {
        if (item.finding_id !== undefined) recordFindingDecision(l, { sessionId: ctx.session, cycleId: ctx.cycleId, findingId: item.finding_id, action: "retired", reason: `handed to the fixer in ${lastFix.step_id}; the recheck judged the fix` });
      }
    });
  }

  const previous = done(steps, "judge").at(-1)?.result as JudgeResult | undefined;
  const stall = previous === undefined ? 0 : items.length >= previous.open_count ? previous.stall + 1 : 0;
  const counts = { blocks: 0, triage: 0, dropped: 0 };
  for (const j of judged) counts[j.disposition] += 1;
  const result: JudgeResult = { head, round: step.round, open: items, triage, counts, open_count: items.length, stall };
  withLedgerSync(ctx.ledgerPath, (l) => endStep(l, step, "done", result as unknown as Record<string, unknown>));
  return { stop: undefined };
}

// ---------------------------------------------------------------------------
// Beginning steps

/**
 * Writes the first round's review step. A review stopped on a question is continued, in the same reviewer session, with
 * the coordinator's answer; one that failed on the environment starts a reviewer afresh.
 */
function beginReview(ctx: Ctx, round: number, continuing?: { session: string; message: string }): { step: Step } | { error: Record<string, unknown> } {
  const planned = planReview(ctx.workspace, ctx.session, {
    base: ctx.base,
    ...(ctx.stored.taskFile !== undefined ? { taskFile: ctx.stored.taskFile } : {}),
    ...(ctx.stored.note !== undefined ? { note: ctx.stored.note } : {}),
  });
  if (!planned.ok) return { error: planned.result };
  const { plan } = planned;
  const input: Record<string, unknown> = {
    brief: continuing?.message ?? plan.brief,
    ...(plan.choice.model !== undefined ? { model: plan.choice.model } : {}),
    role: plan.choice.role,
    ...(plan.choice.reason !== undefined ? { swapped: plan.choice.reason } : {}),
    same_family: plan.sameFamily,
    ...(plan.implementerModel !== undefined ? { implementer_model: plan.implementerModel } : {}),
    files: plan.packFiles,
    base: ctx.base,
    head: plan.target.head,
    ...(continuing !== undefined ? { continueSession: continuing.session } : {}),
  };
  return { step: withLedgerSync(ctx.ledgerPath, (l) => beginStep(l, ctx.cycleId, "review", round, input)) };
}

function lastReviewedHead(steps: readonly Step[]): string | undefined {
  return (done(steps, "judge").at(-1)?.result as JudgeResult | undefined)?.head;
}

// ---------------------------------------------------------------------------
// The driver

/** What a cycle's result carries however it ended. */
function summary(ctx: Ctx, steps: readonly Step[]): Record<string, unknown> {
  const judge = done(steps, "judge").at(-1)?.result as JudgeResult | undefined;
  const review = done(steps, "review").at(-1);
  const input = review?.input as { role?: string; model?: string; swapped?: string } | undefined;
  return {
    cycle_id: ctx.cycleId,
    target: { session_id: ctx.session, branch: ctx.branch, head: tip(ctx), base: ctx.base },
    ...(review?.session_id != null
      ? { reviewer: { session_id: review.session_id, ...(input?.role !== undefined ? { role: input.role } : {}), ...(input?.model !== undefined ? { model: input.model } : {}), ...(input?.swapped !== undefined ? { swapped: input.swapped } : {}) } }
      : {}),
    rounds: done(steps, "judge").length,
    fixes: done(steps, "fix").length,
    ...(judge !== undefined ? { counts: judge.counts } : {}),
    steps: steps.map((s) => ({ step_id: s.step_id, kind: s.kind, round: s.round, state: s.state, ...(s.session_id !== null ? { session_id: s.session_id } : {}) })),
  };
}

function changeFlags(ctx: Ctx, steps: readonly Step[]): SessionFlag[] {
  const head = tip(ctx);
  if (head === undefined) return [];
  const { scope, files } = taskOf(ctx);
  const flags = flagsOfChange(changeOf(ctx.workspace, ctx.base, head), ctx.session, scope, files);
  const review = done(steps, "review").at(-1);
  const input = review?.input as { same_family?: boolean; model?: string; implementer_model?: string } | undefined;
  if (input?.same_family === true && review?.session_id != null) {
    flags.push({ flag: "SAME-FAMILY", detail: `the reviewer (${input.model}) is the implementer's model family (${input.implementer_model}) and its alternate does not differ`, session: review.session_id });
  }
  return flags;
}

/** The task file's scope, files and body, as the task the change is judged against. */
function taskOf(ctx: Ctx): { scope: string[]; files: string[]; text: string } {
  const planned = planReview(ctx.workspace, ctx.session, { base: ctx.base, ...(ctx.stored.taskFile !== undefined ? { taskFile: ctx.stored.taskFile } : {}) });
  if (!planned.ok) return { scope: [], files: [], text: "" };
  return { scope: planned.plan.task?.scope ?? [], files: planned.plan.task?.files ?? [], text: planned.plan.taskText };
}

/** Ends the cycle with a stop: the row says why, and the result is what the coordinator reads. */
function finish(ctx: Ctx, stop: CycleStop, message: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const steps = withLedgerSync(ctx.ledgerPath, (l) => stepsOf(l, ctx.cycleId));
  const flags = stop === "approve" || stop === "decide" ? changeFlags(ctx, steps) : [];
  const result: Record<string, unknown> = {
    outcome: stop === "fix_environment" ? "error" : "ok",
    stop,
    message,
    ...summary(ctx, steps),
    ...extra,
    ...(flags.length > 0 ? { flags } : {}),
    next: stop,
  };
  withLedgerSync(ctx.ledgerPath, (l) => {
    l.db
      .prepare("UPDATE cycles SET state = ?, stop = ?, ended_at = ?, result_json = ? WHERE id = ? AND state = 'running'")
      .run(stop === "approve" ? "done" : "stopped", stop, new Date().toISOString(), JSON.stringify(result), ctx.cycleId);
  });
  progress(ctx, `stopped: ${stop}: ${message}`);
  return result;
}

async function execute(ctx: Ctx, step: Step, steps: readonly Step[]): Promise<StepOutcome> {
  progress(ctx, `${step.step_id} ${step.kind} (round ${step.round})`);
  switch (step.kind) {
    case "review":
      return stepReview(ctx, step);
    case "fix":
      return stepFix(ctx, step);
    case "recheck":
      return stepRecheck(ctx, step);
    case "proof":
      return stepProof(ctx, step, steps);
    case "judge":
      return stepJudge(ctx, step, steps);
    default:
      return { stop: undefined };
  }
}

/**
 * Runs the cycle until it stops, and never throws: a failure of the cycle's own code ends it as `fix_environment`, with the
 * message, so its row is never left `running` under a live process. The steps written so far stay for a resume.
 */
async function drive(ctx: Ctx): Promise<Record<string, unknown>> {
  try {
    return await loop(ctx);
  } catch (err) {
    return finish(ctx, "fix_environment", `the cycle failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The loop itself: from the steps it has written until it stops. The same loop starts, resumes and recovers a cycle. */
async function loop(ctx: Ctx): Promise<Record<string, unknown>> {
  for (;;) {
    if (ctx.opts.signal?.aborted === true) return finish(ctx, "fix_environment", "the cycle was interrupted");
    const steps = withLedgerSync(ctx.ledgerPath, (l) => stepsOf(l, ctx.cycleId));
    const work = steps.filter((s) => !INPUT_STEPS.has(s.kind));
    const last = work.at(-1);

    // A step that was started and never finished: the process died in it. Run it again from the same request id.
    if (last?.state === "started") {
      const outcome = await execute(ctx, last, steps);
      if (outcome.stop !== undefined) return finish(ctx, outcome.stop, outcome.message, outcome.extra);
      continue;
    }

    let next: Step;
    if (last === undefined) {
      const begun = beginReview(ctx, 1);
      if ("error" in begun) return finish(ctx, "fix_environment", String(begun.error["message"] ?? "the review could not be planned"));
      next = begun.step;
    } else if (last.state === "error") {
      // A resume after a stop that was the step's own: rerun that step only (G3, G4).
      const again = retry(ctx, last, steps);
      if ("error" in again) return finish(ctx, "fix_environment", String(again.error["message"] ?? "the step could not be planned again"));
      next = again.step;
    } else if (last.kind === "review" || last.kind === "recheck") {
      const reviewer = last.kind === "review" ? last.session_id : (last.input["reviewer"] as string);
      const from = last.kind === "review" ? 0 : ((last.input["from"] as number | undefined) ?? 0);
      next = withLedgerSync(ctx.ledgerPath, (l) => beginStep(l, ctx.cycleId, "judge", last.round, { reviewer, from }));
    } else if (last.kind === "judge") {
      const verdict = evaluate(steps, capsOf(ctx.config));
      if (verdict.kind === "approve") return finish(ctx, "approve", "nothing is left open");
      if (verdict.kind === "stop") {
        return finish(ctx, verdict.token, verdict.message, {
          ...(verdict.items !== undefined ? { items: verdict.items } : {}),
          ...(verdict.triage !== undefined ? { triage: verdict.triage.map(describeItem) } : {}),
        });
      }
      const round = last.round;
      const rulings = withLedgerSync(ctx.ledgerPath, (l) => cycleRulings(l, ctx.cycleId));
      next = withLedgerSync(ctx.ledgerPath, (l) => beginStep(l, ctx.cycleId, "fix", round, { brief: fixBrief(verdict.items, rulings, round, ctx.stored.note), items: verdict.items }));
    } else if (last.kind === "fix") {
      const suite = withLedgerSync(ctx.ledgerPath, (l) => proofSuite(l, reviewerSessions(steps)));
      next = withLedgerSync(ctx.ledgerPath, (l) => beginStep(l, ctx.cycleId, suite.length > 0 ? "proof" : "recheck", last.round, suite.length > 0 ? {} : recheckInput(ctx, steps, last.round)));
    } else if (last.kind === "proof") {
      next = withLedgerSync(ctx.ledgerPath, (l) => beginStep(l, ctx.cycleId, "recheck", last.round, recheckInput(ctx, steps, last.round)));
    } else {
      return finish(ctx, "fix_environment", `the cycle does not know what follows a ${last.kind} step`);
    }

    const outcome = await execute(ctx, next, withLedgerSync(ctx.ledgerPath, (l) => stepsOf(l, ctx.cycleId)));
    if (outcome.stop !== undefined) return finish(ctx, outcome.stop, outcome.message, outcome.extra);
  }
}

function describeItem(item: Item): Record<string, unknown> {
  return { finding_id: item.finding_id, severity: item.severity, text: item.text, basis: item.basis, ...(item.check !== undefined ? { check_kind: item.check.kind } : {}) };
}

/** What a recheck needs written before it runs: the reviewer, the fix's diff, and what the fixer was handed. */
function recheckInput(ctx: Ctx, steps: readonly Step[], fixRound: number): Record<string, unknown> {
  const reviewer = reviewerSession(steps);
  const from = lastReviewedHead(steps) ?? ctx.base;
  const to = tip(ctx) ?? from;
  const facts = changeOf(ctx.workspace, from, to);
  const items = (done(steps, "fix").at(-1)?.input["items"] as Item[] | undefined) ?? [];
  const rulings = withLedgerSync(ctx.ledgerPath, (l) => cycleRulings(l, ctx.cycleId));
  const findingsFrom = reviewer !== undefined ? withLedgerSync(ctx.ledgerPath, (l) => latestMax(l, reviewer)) : 0;
  const reviewStep = done(steps, "review").at(-1);
  return {
    reviewer,
    ...((reviewStep?.input["model"] as string | undefined) !== undefined ? { model: reviewStep!.input["model"] } : {}),
    from: findingsFrom,
    fixed_from: from,
    fixed_to: to,
    round: fixRound + 1,
    brief: recheckBrief({ task: taskOf(ctx).text, items, rulings, from, to, stat: facts.stat, diff: facts.diff, note: ctx.stored.note }),
  };
}

/**
 * The step to run again after a stop that was the step's own. A question's answer is carried to the session that asked;
 * anything else reruns the step as it was: a review afresh, a fix or a recheck as the same continuation (G3, G4).
 */
function retry(ctx: Ctx, failed: Step, steps: readonly Step[]): { step: Step } | { error: Record<string, unknown> } {
  const answer = failed.result?.["classified"] === "question" ? (failed.result["answer"] as string | undefined) : undefined;
  if (failed.kind === "review") {
    return beginReview(ctx, failed.round, answer !== undefined && failed.session_id !== null ? { session: failed.session_id, message: answer } : undefined);
  }
  let input: Record<string, unknown> = failed.input;
  if (answer !== undefined) {
    input = { ...failed.input, brief: answer };
  } else if (failed.kind === "fix") {
    // What the coordinator gave since (--add, -m) is in the rerun's brief.
    const verdict = evaluate(steps, capsOf(ctx.config));
    if (verdict.kind === "fix") {
      const rulings = withLedgerSync(ctx.ledgerPath, (l) => cycleRulings(l, ctx.cycleId));
      input = { brief: fixBrief(verdict.items, rulings, failed.round, ctx.stored.note), items: verdict.items };
    }
  } else if (failed.kind === "recheck") {
    // The findings the failed attempt already recorded stay this recheck's: its window starts where the first began.
    input = { ...recheckInput(ctx, steps, failed.round), from: failed.input["from"] };
  }
  return { step: withLedgerSync(ctx.ledgerPath, (l) => beginStep(l, ctx.cycleId, failed.kind, failed.round, input)) };
}

// ---------------------------------------------------------------------------
// Starting, resuming, recovering


function readConfig(workspace: string): ResolvedConfig | Error {
  try {
    return loadConfig({ cwd: workspace }).resolved;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function storedOf(row: CycleRow): StoredOptions {
  return JSON.parse(row.options_json) as StoredOptions;
}

function mergeOptions(stored: StoredOptions, opts: CycleOptions, workspace: string): StoredOptions {
  return {
    ...stored,
    ...(opts.taskFile !== undefined ? { taskFile: resolve(workspace, opts.taskFile) } : {}),
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
  };
}

/**
 * Records the options a start, a resume or a recover was given, as rows and steps, before anything runs. They are the
 * same at all three (G6): `-m` answers the question a cycle stopped on, else it is a note for the reviewer; `--add` is one
 * more item for the fixer; `--forward` and `--drop` decide the findings left to triage.
 */
function applyInputs(ctx: Ctx): Record<string, unknown> | undefined {
  const { opts } = ctx;
  const steps = withLedgerSync(ctx.ledgerPath, (l) => stepsOf(l, ctx.cycleId));
  const last = steps.filter((s) => !INPUT_STEPS.has(s.kind)).at(-1);

  if (opts.note !== undefined && opts.note.trim() !== "") {
    const note = opts.note;
    if (last?.state === "error" && last.result?.["classified"] === "question" && last.session_id !== null) {
      const sessionId = last.session_id;
      withLedgerSync(ctx.ledgerPath, (l) => {
        for (const q of openQuestions(l, [sessionId])) {
          l.db.prepare("INSERT OR IGNORE INTO cycle_rulings (cycle_id, session_id, question, ruling, ts) VALUES (?, ?, ?, ?, ?)").run(ctx.cycleId, sessionId, q.question, note, new Date().toISOString());
        }
        closeQuestions(l, sessionId, "steer");
        const answer = `The coordinator answers your question: ${note}
Carry on from where you stopped.`;
        l.db.prepare("UPDATE cycle_steps SET result_json = ? WHERE cycle_id = ? AND seq = ?").run(JSON.stringify({ ...last.result, answer }), ctx.cycleId, last.seq);
      });
    } else {
      ctx.stored = { ...ctx.stored, note };
    }
  }

  if (opts.add !== undefined && opts.add.trim() !== "") {
    const item: Item = { key: `added:${opts.add.trim()}`, source: "added", severity: "high", text: opts.add.trim(), basis: "added by the coordinator" };
    withLedgerSync(ctx.ledgerPath, (l) => {
      const step = beginStep(l, ctx.cycleId, "add", last?.round ?? 1, { item });
      endStep(l, step, "done", {});
    });
  }

  const forward = opts.forward ?? [];
  const drop = opts.drop ?? [];
  if (forward.length > 0 || drop.length > 0) {
    const judge = done(steps, "judge").at(-1);
    const triage = (judge?.result as JudgeResult | undefined)?.triage ?? [];
    const unknown = [...forward, ...drop].filter((id) => !triage.some((t) => t.finding_id === id));
    if (unknown.length > 0) {
      return errorResult(
        `lykos cycle: ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not left to triage in cycle ${ctx.cycleId}${triage.length > 0 ? ` (they are: ${triage.map((t) => t.finding_id).join(", ")})` : ""}`,
        { cycle_id: ctx.cycleId },
      );
    }
    const forwarded = triage.filter((t) => forward.includes(t.finding_id!));
    withLedgerSync(ctx.ledgerPath, (l) => {
      for (const t of triage) {
        const fwd = forward.includes(t.finding_id!);
        if (!fwd && !drop.includes(t.finding_id!)) continue;
        recordFindingDecision(l, {
          sessionId: ctx.session,
          cycleId: ctx.cycleId,
          findingId: t.finding_id!,
          action: fwd ? "forwarded" : "dropped",
          reason: fwd ? "the coordinator forwarded it from triage" : "the coordinator dropped it from triage",
        });
      }
      const step = beginStep(l, ctx.cycleId, "triage", judge?.round ?? 1, { forward: forwarded, decided: [...forward, ...drop] });
      endStep(l, step, "done", {});
    });
  }
  return undefined;
}

function preflightTarget(ledgerPath: string, session: string, livenessOf: LivenessOf | undefined): Record<string, unknown> | undefined {
  const row = withLedgerSync(ledgerPath, (l) => ownerRow(l, session));
  if (row === undefined) return errorResult(`lykos cycle: ${session} is not a delegated session of this project`);
  if (isLive(row.state)) {
    const liveness = (livenessOf ?? ownerLiveness)(row);
    return liveness === "dead"
      ? errorResult(`lykos cycle: session ${session} crashed; continue it with \`lykos recover ${session}\` first`, { next: "recover" })
      : errorResult(`lykos cycle: session ${session} is still ${row.state} (owner pid ${row.owner_pid}); wait for it`, { next: "wait" });
  }
  const result = row.result_json !== null ? (JSON.parse(row.result_json) as Record<string, unknown>) : {};
  const flags = Array.isArray(result["flags"]) ? (result["flags"] as SessionFlag[]) : [];
  if (result["next"] === "answer_spec" || flags.some((f) => f.flag === "WEAK-SPEC")) {
    return { stop: "answer_spec", message: `session ${session} ended with WEAK-SPEC: a sealed test already passes, so the spec asks for nothing. Answer the spec first.` };
  }
  return undefined;
}

/** A cycle's id is not a session's: the first is looked up before the second. */
export function isCycleId(workspace: string, id: string): boolean {
  const path = defaultLedgerPath(workspace);
  if (!existsSync(path)) return false;
  try {
    return withLedgerSync(path, (l) => cycleRow(l, id) !== undefined);
  } catch {
    return false;
  }
}

/**
 * `lykos cycle <session | cycle>`. A session id starts a cycle on that session's change; a cycle id resumes a cycle that
 * stopped. Every option works at both (G6). Never throws; a cycle that could not run is an `error` result.
 */
export async function runCycle(workspace: string, targetArg: string, opts: CycleOptions): Promise<Record<string, unknown>> {
  const ledgerPath = defaultLedgerPath(workspace);
  const config = readConfig(workspace);
  if (config instanceof Error) return errorResult(`lykos cycle: the configuration cannot be read: ${config.message}`);
  const existing = isCycleId(workspace, targetArg);
  return existing ? resume(workspace, ledgerPath, config, targetArg, opts) : start(workspace, ledgerPath, config, targetArg, opts);
}

/** The running cycle on `session`, as a refusal to start another (the insert checks it again, atomically). */
function runningCycleRefusal(ledgerPath: string, session: string, livenessOf: LivenessOf | undefined): Record<string, unknown> | undefined {
  const live = withLedgerSync(ledgerPath, (l) => l.db.prepare("SELECT id, owner_pid, owner_recorded_at_ms FROM cycles WHERE target_session = ? AND state = 'running'").all(session) as Array<{ id: string; owner_pid: number; owner_recorded_at_ms: number }>);
  for (const c of live) {
    const liveness = (livenessOf ?? ownerLiveness)(c);
    return errorResult(
      liveness === "dead"
        ? `lykos cycle: cycle ${c.id} on ${session} crashed; continue it with \`lykos recover ${c.id}\``
        : `lykos cycle: cycle ${c.id} is already running on ${session} (pid ${c.owner_pid}, ${liveness})`,
      { cycle_id: c.id, next: liveness === "dead" ? "recover" : "wait" },
    );
  }
  return undefined;
}

async function start(workspace: string, ledgerPath: string, config: ResolvedConfig, targetArg: string, opts: CycleOptions): Promise<Record<string, unknown>> {
  const running = runningCycleRefusal(ledgerPath, targetArg, opts.livenessOf);
  if (running !== undefined) return running;
  const refusal = preflightTarget(ledgerPath, targetArg, opts.livenessOf);
  if (refusal !== undefined) {
    if (refusal["stop"] === "answer_spec") return { outcome: "ok", ...refusal, next: "answer_spec" };
    return refusal;
  }
  const stored: StoredOptions = {
    ...(opts.taskFile !== undefined ? { taskFile: resolve(workspace, opts.taskFile) } : {}),
    ...(opts.note !== undefined && opts.note.trim() !== "" ? { note: opts.note } : {}),
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
  };
  const planned = planReview(workspace, targetArg, { ...(stored.taskFile !== undefined ? { taskFile: stored.taskFile } : {}), ...(opts.base !== undefined ? { base: opts.base } : {}) });
  if (!planned.ok) return planned.result;
  const { target } = planned.plan;
  if (target.session === undefined || target.session !== targetArg) {
    return errorResult(`lykos cycle: "${targetArg}" is not a delegated session with a branch of its own to review and fix`);
  }

  const cycleId = `cycle-${randomUUID().slice(0, 8)}`;
  const me = selfIdentity();
  const claimed = withLedgerSync(ledgerPath, (l) => {
    const run = l.db.transaction((): Record<string, unknown> | undefined => {
      const live = l.db.prepare("SELECT id FROM cycles WHERE target_session = ? AND state = 'running'").get(target.session) as { id: string } | undefined;
      if (live !== undefined) return errorResult(`lykos cycle: cycle ${live.id} is already running on ${target.session}`, { cycle_id: live.id, next: "wait" });
      l.db
        .prepare(`INSERT INTO cycles (id, target_session, branch, base_commit, options_json, owner_pid, owner_recorded_at_ms, state, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?)`)
        .run(cycleId, target.session, target.branch, target.base, JSON.stringify(stored), me.pid, me.recordedAt, new Date(me.recordedAt).toISOString());
      return undefined;
    });
    return run.immediate();
  });
  if (claimed !== undefined) return claimed;

  const ctx: Ctx = { workspace, ledgerPath, cycleId, opts, config, stored, session: target.session, branch: target.branch, base: target.base };
  progress(ctx, `started on ${target.session} (${target.branch})`);
  const refused = applyInputs(ctx);
  if (refused !== undefined) return finish(ctx, "fix_environment", String(refused["message"]));
  return drive(ctx);
}

async function resume(workspace: string, ledgerPath: string, config: ResolvedConfig, cycleId: string, opts: CycleOptions): Promise<Record<string, unknown>> {
  const row = withLedgerSync(ledgerPath, (l) => cycleRow(l, cycleId))!;
  if (row.state === "running") {
    const liveness = (opts.livenessOf ?? ownerLiveness)(row);
    return liveness === "dead"
      ? errorResult(`lykos cycle: cycle ${cycleId} crashed (its owner, pid ${row.owner_pid}, is gone); continue it with \`lykos recover ${cycleId}\``, { cycle_id: cycleId, next: "recover" })
      : errorResult(`lykos cycle: cycle ${cycleId} is running, owned by pid ${row.owner_pid} (${liveness})`, { cycle_id: cycleId, next: "wait" });
  }
  const adding = (opts.add !== undefined && opts.add.trim() !== "") || (opts.forward?.length ?? 0) > 0 || (opts.drop?.length ?? 0) > 0;
  if (row.state === "done" && !adding) {
    return { ...(JSON.parse(row.result_json ?? "{}") as Record<string, unknown>), duplicate: true };
  }
  const me = selfIdentity();
  const taken = withLedgerSync(
    ledgerPath,
    (l) =>
      l.db
        .prepare("UPDATE cycles SET state = 'running', stop = NULL, ended_at = NULL, result_json = NULL, owner_pid = ?, owner_recorded_at_ms = ?, base_commit = COALESCE(?, base_commit) WHERE id = ? AND state IN ('stopped', 'done')")
        .run(me.pid, me.recordedAt, opts.base !== undefined ? (commitOf(workspace, opts.base) ?? null) : null, cycleId).changes,
  );
  if (taken !== 1) return errorResult(`lykos cycle: cycle ${cycleId} changed while it was being resumed; read it again`, { cycle_id: cycleId, next: "wait" });
  const fresh = withLedgerSync(ledgerPath, (l) => cycleRow(l, cycleId))!;
  const stored = mergeOptions(storedOf(fresh), opts, workspace);
  withLedgerSync(ledgerPath, (l) => l.db.prepare("UPDATE cycles SET options_json = ? WHERE id = ?").run(JSON.stringify(stored), cycleId));
  const ctx: Ctx = { workspace, ledgerPath, cycleId, opts, config, stored, session: fresh.target_session, branch: fresh.branch, base: fresh.base_commit };
  progress(ctx, `resumed (was stopped: ${row.stop ?? "?"})`);
  const refusal = preflightTarget(ledgerPath, ctx.session, opts.livenessOf);
  if (refusal !== undefined && refusal["stop"] === "answer_spec") return finish(ctx, "answer_spec", String(refusal["message"]));
  if (refusal !== undefined) return finish(ctx, "fix_environment", String(refusal["message"]));
  const refused = applyInputs(ctx);
  if (refused !== undefined) {
    // The option was wrong, not the cycle: it goes back to the stop it was resumed from.
    return { ...finish(ctx, row.stop ?? "triage", String(refused["message"])), outcome: "error", message: refused["message"] };
  }
  const persisted = JSON.stringify(ctx.stored);
  withLedgerSync(ledgerPath, (l) => l.db.prepare("UPDATE cycles SET options_json = ? WHERE id = ?").run(persisted, cycleId));
  return drive(ctx);
}

export interface RecoverCycleOptions {
  trustSource: TrustSource;
  signal?: AbortSignal | undefined;
  onProgress?: ((message: string) => void) | undefined;
  run?: SessionRunner | undefined;
  livenessOf?: LivenessOf | undefined;
  quiescence?: QuiescenceDeps | undefined;
  /** Options given to a recover work as at a resume (G6). */
  note?: string | undefined;
  maxSteps?: number | undefined;
  add?: string | undefined;
}

/**
 * `lykos recover <cycle>` (ADR-0060 amended, G10): continue a cycle whose process died, from its last written step. It
 * is refused while the owner is alive or unknown, and while anything the cycle's sessions started is not confirmed
 * stopped; it never kills anything. Ownership moves with one conditional update. The step that was running finds its
 * session by its request id, so no second fixer or reviewer starts.
 */
export async function recoverCycle(workspace: string, cycleId: string, opts: RecoverCycleOptions): Promise<Record<string, unknown>> {
  const ledgerPath = defaultLedgerPath(workspace);
  const config = readConfig(workspace);
  if (config instanceof Error) return errorResult(`lykos recover: the configuration cannot be read: ${config.message}`);
  const refuse = (message: string, next: string, extra: Record<string, unknown> = {}): Record<string, unknown> => errorResult(`lykos recover: ${message}`, { cycle_id: cycleId, ...extra, next });
  const row = withLedgerSync(ledgerPath, (l) => cycleRow(l, cycleId));
  if (row === undefined) return refuse(`unknown cycle id: ${cycleId}`, "fix_environment");
  if (row.state !== "running") return refuse(`cycle ${cycleId} is ${row.state === "done" ? "approved" : "stopped"}, not crashed; continue it with \`lykos cycle ${cycleId}\``, "resume");
  const liveness = (opts.livenessOf ?? ownerLiveness)(row);
  if (liveness !== "dead") {
    return refuse(
      liveness === "alive"
        ? `its owner, pid ${row.owner_pid}, is alive; recover never kills anything`
        : `the OS will not say whether its owner, pid ${row.owner_pid}, is alive; make sure it is gone first; recover never kills anything`,
      liveness === "alive" ? "wait" : "fix_environment",
      { owner_pid: row.owner_pid, owner_liveness: liveness },
    );
  }
  // Everything the cycle's sessions started must be confirmed gone before anything continues.
  const sessions = withLedgerSync(ledgerPath, (l) => [...new Set(stepsOf(l, cycleId).flatMap((s) => (s.session_id !== null ? [s.session_id] : [])))]);
  const pendingSessions = withLedgerSync(ledgerPath, (l) =>
    stepsOf(l, cycleId).flatMap((s) => (s.state === "started" && s.request_id !== null ? [sessionOfRequest(l, s.request_id)?.session_id].filter((x): x is string => x !== undefined) : [])),
  );
  const checked = await withLedger(ledgerPath, async (l) => {
    for (const id of [...new Set([...sessions, ...pendingSessions])]) {
      const quiet = await confirmQuiescence(l, id, opts.quiescence ?? {});
      if (!quiet.quiet) return { id, notStopped: quiet.notStopped };
    }
    return undefined;
  });
  if (checked !== undefined) {
    const named = checked.notStopped.map((n) => `${n.kind}${n.pid !== undefined ? ` pid ${n.pid}` : ""}${n.container !== undefined ? ` ${n.container}` : ""} (${n.liveness})`);
    return refuse(`what session ${checked.id} started is not confirmed stopped: ${named.join(", ")}; stop it first; recover never kills anything`, "fix_environment", { not_stopped: checked.notStopped });
  }
  const me = selfIdentity();
  const took = withLedgerSync(ledgerPath, (l) =>
    l.db.transaction((): { ok: true; crashes: number } | { ok: false; message: string } => {
      const current = cycleRow(l, cycleId);
      if (current === undefined || current.state !== "running" || current.owner_pid !== row.owner_pid || current.owner_recorded_at_ms !== row.owner_recorded_at_ms) {
        return { ok: false, message: `another recover took cycle ${cycleId} over first` };
      }
      if (current.crashes >= MAX_CRASHES) {
        const message = `cycle ${cycleId} crashed ${current.crashes + 1} times; it is stopped (at most ${MAX_CRASHES} are recovered)`;
        l.db.prepare("UPDATE cycles SET state = 'stopped', stop = 'fix_environment', ended_at = ?, result_json = ? WHERE id = ?").run(new Date().toISOString(), JSON.stringify(errorResult(message, { cycle_id: cycleId })), cycleId);
        return { ok: false, message };
      }
      l.db.prepare("UPDATE cycles SET owner_pid = ?, owner_recorded_at_ms = ?, crashes = crashes + 1 WHERE id = ?").run(me.pid, me.recordedAt, cycleId);
      return { ok: true, crashes: current.crashes + 1 };
    }).immediate(),
  );
  if (!took.ok) return refuse(took.message, "wait");

  const stored = mergeOptions(storedOf(row), { ...opts, trustSource: opts.trustSource }, workspace);
  const ctx: Ctx = {
    workspace,
    ledgerPath,
    cycleId,
    opts: {
      trustSource: opts.trustSource,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
      ...(opts.run !== undefined ? { run: opts.run } : {}),
      ...(opts.livenessOf !== undefined ? { livenessOf: opts.livenessOf } : {}),
      ...(opts.quiescence !== undefined ? { quiescence: opts.quiescence } : {}),
      ...(opts.note !== undefined ? { note: opts.note } : {}),
      ...(opts.add !== undefined ? { add: opts.add } : {}),
    },
    config,
    stored,
    session: row.target_session,
    branch: row.branch,
    base: row.base_commit,
  };
  progress(ctx, `took over from dead pid ${row.owner_pid} (crash ${took.crashes})`);
  const refused = applyInputs(ctx);
  if (refused !== undefined) return finish(ctx, "fix_environment", String(refused["message"]));
  withLedgerSync(ledgerPath, (l) => l.db.prepare("UPDATE cycles SET options_json = ? WHERE id = ?").run(JSON.stringify(ctx.stored), cycleId));
  const result = await drive(ctx);
  return { ...result, recovered: { from_pid: row.owner_pid, crashes: took.crashes } };
}

// ---------------------------------------------------------------------------
// What `lykos status` shows

export interface CycleView {
  cycle_id: string;
  kind: "cycle";
  state: "running" | "stopped" | "done" | "crashed";
  owner_pid: number;
  owner_liveness?: "alive" | "dead" | "unknown";
  target_session: string;
  branch: string;
  started_at: string;
  ended_at: string | null;
  stop: CycleStop | null;
  crashes: number;
  rounds: number;
  fixes: number;
  /** The step the cycle is in, or was in when it stopped. */
  step?: { step_id: string; kind: StepKind; state: StepState; session_id?: string };
  result?: unknown;
  next: string;
}

export function cycleViews(workspace: string, ids?: readonly string[], livenessOf: LivenessOf = ownerLiveness): CycleView[] {
  const path = defaultLedgerPath(workspace);
  if (!existsSync(path)) return [];
  try {
    return withLedgerSync(path, (l) => {
      const rows = ids === undefined ? (l.db.prepare(`SELECT ${CYCLE_COLUMNS} FROM cycles ORDER BY started_at ASC`).all() as CycleRow[]) : ids.map((id) => cycleRow(l, id)).filter((r): r is CycleRow => r !== undefined);
      return rows.map((row) => {
        const steps = stepsOf(l, row.id);
        const ownerState = row.state === "running" ? livenessOf(row) : undefined;
        const crashed = ownerState === "dead";
        const last = steps.filter((s) => !INPUT_STEPS.has(s.kind)).at(-1);
        return {
          cycle_id: row.id,
          kind: "cycle" as const,
          state: crashed ? ("crashed" as const) : row.state,
          owner_pid: row.owner_pid,
          ...(ownerState !== undefined ? { owner_liveness: ownerState } : {}),
          target_session: row.target_session,
          branch: row.branch,
          started_at: row.started_at,
          ended_at: row.ended_at,
          stop: row.stop,
          crashes: row.crashes,
          rounds: done(steps, "judge").length,
          fixes: done(steps, "fix").length,
          ...(last !== undefined ? { step: { step_id: last.step_id, kind: last.kind, state: last.state, ...(last.session_id !== null ? { session_id: last.session_id } : {}) } } : {}),
          ...(row.result_json !== null ? { result: JSON.parse(row.result_json) as unknown } : {}),
          next: crashed ? "recover" : row.state === "running" ? "wait" : (row.stop ?? "approve"),
        };
      });
    });
  } catch {
    return [];
  }
}

