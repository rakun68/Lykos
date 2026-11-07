// `lykos review` (T235, ADR-0059, ADR-0061, spec decision 13): one reviewer reads a session's change, and what it finds
// comes back as claims the harness has checked. The reviewer is the `review-both` role, swapped for its alternate when it
// is the implementer's model family. It is read-only and records each defect with `finding`; this module then has the
// harness run every finding's check on the branch and decides, by rule (`findings.ts`), which findings block, which go to
// the coordinator and which are dropped, and files each decision in `finding_decisions`.
//
// Lessons held here:
//   - R16: the diff is against the base the session was admitted with (`session-base.ts`), never the host's HEAD.
//   - R14: a reviewer that cannot run stops the review with its own error. No findings is never the answer to "did not run".
//   - R23: a flag on the change names the session that made the change; a read-only reviewer is named only for what it did.
//   - W2: the reviewer is told to look for special-casing, and to judge the acceptance criteria and the tests, not only the
//     checks it was handed.
//   - W7 / `review_false_positive`: a low finding needs a reproduction to block; a medium one without goes to triage.

import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../config/load.js";
import { modelFamily, reviewerRole, type RoleChoice } from "../config/roles.js";
import type { ResolvedConfig } from "../config/types.js";
import type { TrustSource } from "../gate/trust.js";
import { hostGit } from "../git/host-git.js";
import { defaultLedgerPath, withLedger, withLedgerSync, type Ledger } from "../ledger/use.js";
import { sessionBaseline } from "./baseline.js";
import { checkClaims } from "./claim-checks.js";
import type { ClaimResult } from "./claims.js";
import { recordFindingDecision } from "./decisions.js";
import { dispose, judged, findingsOf, nextOfFindings, recordFindingJudgements, type JudgedFinding, type StoredFinding } from "./findings.js";
import { runDelegated } from "./mcp-server.js";
import { changeFlags, parseNameStatus, addedLines, type ChangedPath } from "./result-flags.js";
import { commitOf, sessionBaseOf } from "./session-base.js";
import type { ContainmentChoice, SessionFlag, SessionRunner } from "./session-protocol.js";
import { parseTaskFile, TaskFileError, type TaskFile } from "./task-file.js";

/** The role that reviews. P18 has one; the split into spec and standards reviewers is P21. */
export const REVIEW_ROLE = "review-both";

/** The most diff text the reviewer's brief carries; past it the brief says so and names the command that shows the rest. */
export const MAX_BRIEF_DIFF_CHARS = 60_000;

/** Lines of context around each hunk: the reviewer reads the change from this diff, so it sees what surrounds it. */
const DIFF_CONTEXT_LINES = 20;

/** The most files a reviewer's context pack names. */
const MAX_PACK_FILES = 20;

export interface ReviewTarget {
  /** The ref that holds the work. */
  branch: string;
  /** The commit it is at. */
  head: string;
  /** The commit the work started from. */
  base: string;
  /** `stored` (the session's own), `given` (the caller named it), `merge-base` (a branch with no session; HEAD's merge base). */
  baseSource: "stored" | "given" | "merge-base";
  /** The session that made the change, when the branch is one's. */
  session?: string;
}

export type Resolved<T> = ({ ok: true } & T) | { ok: false; message: string };

/**
 * What to review. `target` is a session id (its `lykos/<id>` branch) or a branch. The base is the caller's `--base`,
 * else the one stored with the session (R16), else, for a branch no session of this project made, the merge base with
 * HEAD, which the result says is not a stored one.
 */
export function resolveReviewTarget(workspace: string, ledger: Ledger | undefined, target: string, givenBase?: string): Resolved<{ target: ReviewTarget }> {
  let session: string | undefined;
  let branch: string | undefined;
  const asSession = commitOf(workspace, `refs/heads/lykos/${target}`);
  if (asSession !== undefined) {
    session = target;
    branch = `lykos/${target}`;
  } else if (commitOf(workspace, target) !== undefined) {
    branch = target;
    if (target.startsWith("lykos/")) session = target.slice("lykos/".length);
  }
  if (branch === undefined) {
    return { ok: false, message: `lykos review: "${target}" is neither a session with a branch of its own nor a branch or commit of this project (a read-only session, or one that wrote in place, has no branch to review)` };
  }
  const head = commitOf(workspace, branch)!;
  let base: string | undefined;
  let baseSource: ReviewTarget["baseSource"];
  if (givenBase !== undefined) {
    base = commitOf(workspace, givenBase);
    if (base === undefined) return { ok: false, message: `lykos review: --base "${givenBase}" names no commit` };
    baseSource = "given";
  } else {
    const stored = session !== undefined && ledger !== undefined ? sessionBaseOf(ledger, session) : undefined;
    if (stored !== undefined) {
      base = stored;
      baseSource = "stored";
    } else {
      const merge = hostGit(["merge-base", "HEAD", head], workspace);
      base = merge.ok && merge.stdout !== "" ? merge.stdout : undefined;
      baseSource = "merge-base";
    }
  }
  if (base === undefined) return { ok: false, message: `lykos review: no base for ${branch}: it has no stored one and shares no history with HEAD; name one with --base` };
  if (base === head) return { ok: false, message: `lykos review: ${branch} has nothing beyond its base ${base.slice(0, 12)} to review` };
  return { ok: true, target: { branch, head, base, baseSource, ...(session !== undefined ? { session } : {}) } };
}

export interface ChangeFacts {
  changed: ChangedPath[];
  added: string[];
  removedLines: Map<string, number>;
  commits: Array<{ sha: string; subject: string }>;
  stat: string;
  diff: string;
}

/** What `base..head` changed, read from git. Every range is the stored base to the branch's own head (R16). */
export function changeOf(workspace: string, base: string, head: string): ChangeFacts {
  const range = `${base}..${head}`;
  const git = (args: string[]): string => {
    const r = hostGit(args, workspace, { maxBuffer: 64 * 1024 * 1024, raw: true });
    return r.ok ? r.stdout : "";
  };
  const removedLines = new Map<string, number>();
  for (const line of git(["-c", "core.quotepath=false", "diff", "--numstat", "--no-renames", range]).split("\n")) {
    const [, del, file] = line.replace(/\r$/, "").split("\t");
    if (file !== undefined) removedLines.set(file, del === "-" ? 1 : Number(del));
  }
  const commits = git(["log", "--format=%H%x1f%s", range])
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const [sha = "", subject = ""] = l.replace(/\r$/, "").split("\u001f");
      return { sha, subject };
    });
  return {
    changed: parseNameStatus(git(["-c", "core.quotepath=false", "diff", "--name-status", "--no-renames", range])),
    added: addedLines(git(["diff", "-U0", "--no-renames", range])),
    removedLines,
    commits,
    stat: git(["diff", "--stat", "--no-renames", range]).trim(),
    diff: git(["diff", `-U${DIFF_CONTEXT_LINES}`, "--no-renames", range]),
  };
}

/**
 * The flags of the change, naming the session that made it (R23). A review's own flags name the reviewer and are the
 * child's to raise; this is only the change's.
 */
export function flagsOfChange(facts: ChangeFacts, session: string | undefined, scope: string[], files: string[]): SessionFlag[] {
  return changeFlags({
    ...(session !== undefined ? { sessionId: session } : {}),
    changed: facts.changed,
    added: facts.added,
    commits: facts.commits,
    removedLines: facts.removedLines,
    ...(scope.length > 0 ? { scope } : {}),
    ...(files.length > 0 ? { files } : {}),
  });
}

export interface BriefInput {
  target: ReviewTarget;
  facts: ChangeFacts;
  /** The task the change was made for: what the reviewer judges it against. */
  task: string;
  /** The verification command and the tests that fail on the base already, when a baseline was measured. */
  baseline?: { command: string; failing: string[] } | { command: string; unmeasured: string } | undefined;
  /** The caller's own note to the reviewer. */
  note?: string | undefined;
}

/** The reviewer's brief. The rulings of the implementer's spec check are appended by the session child. */
export function reviewBrief(input: BriefInput): string {
  const { target, facts } = input;
  const truncated = facts.diff.length > MAX_BRIEF_DIFF_CHARS;
  const diff = truncated ? facts.diff.slice(0, MAX_BRIEF_DIFF_CHARS) : facts.diff;
  const baseline =
    input.baseline === undefined
      ? "No verification command is set, so there is no baseline of known failures."
      : "unmeasured" in input.baseline
        ? `Verification command: ${input.baseline.command}. Its failures on the base were not measured (${input.baseline.unmeasured}).`
        : input.baseline.failing.length === 0
          ? `Verification command: ${input.baseline.command}. It passes on the base: any failure it shows on the branch is the change's.`
          : `Verification command: ${input.baseline.command}. These tests already fail on the base; the change did not break them, so do not report them:\n${input.baseline.failing.map((f) => `- ${f}`).join("\n")}`;
  return `Review the change on branch ${target.branch} (head ${target.head.slice(0, 12)}). It started from ${target.base.slice(0, 12)}; the diff below is that base against the head, whatever the project's HEAD is now.

## The task the change was made for

${input.task.trim() === "" ? "(none recorded: judge it against the repository's own documented rules)" : input.task.trim()}
${input.note !== undefined && input.note.trim() !== "" ? `\n## From the coordinator\n\n${input.note.trim()}\n` : ""}
## What to judge

- Spec: does the change do what the task asks? Go through every acceptance criterion and say which the change meets. A criterion the change does not meet is a finding.
- Tests: are the change's tests adequate? Would a wrong implementation pass them? A criterion no test would catch failing is a finding. Judge the acceptance criteria and the tests' adequacy, not only the checks you were handed: a passing check shows the check passed, not that the work is right.
- Special-casing: look for code that passes the tests without doing the work: a branch on a test's input or name, an expected value copied into the code, a stub that returns what the test reads. That is the most serious kind of finding.
- Standards: does it follow the repository's documented rules (AGENTS.md and the docs it links)? Cite the rule.

## How to report

- Record each defect with the \`finding\` tool, one call per defect: a severity, the \`path:line\` it rests on, and a check. Prose in your answer is not a finding.
- A check is run by the harness, not by you, on the branch, and the finding blocks only if the check holds there. Best is a reproduction: a new test file and the names of the tests that must fail. Next is a command and the exit code the defect makes it give. A finding with no check is dropped when it is low and handed to the coordinator when it is medium or worse, so give one whenever a test can show the defect.
- Do not edit anything. The tree you are in is the project's current tree, not the branch: a file you read there may differ from the branch's. The branch's text is the diff below, with ${DIFF_CONTEXT_LINES} lines of context around each change; cite its new-side line numbers, and say so when the diff does not show what you need.
- ${baseline}

## The change

${facts.commits.length} commit${facts.commits.length === 1 ? "" : "s"}:
${facts.commits.map((c) => `- ${c.sha.slice(0, 12)} ${c.subject}`).join("\n")}

${facts.stat === "" ? "(no file changes)" : facts.stat}

\`\`\`diff
${diff}
\`\`\`${truncated ? `\n\nThe diff is cut at ${MAX_BRIEF_DIFF_CHARS} characters. The rest: \`git diff ${target.base.slice(0, 12)}..${target.head.slice(0, 12)}\`.` : ""}`;
}

export interface ReviewOptions {
  /** `--task`: a task file; its body is the task the change is judged against. */
  taskFile?: string | undefined;
  /** `-m`: a note to the reviewer. */
  note?: string | undefined;
  base?: string | undefined;
  maxSteps?: number | undefined;
  requestId?: string | undefined;
  trustSource: TrustSource;
  signal?: AbortSignal | undefined;
  onProgress?: ((message: string) => void) | undefined;
  /** Tests: the session runner. Absent: a real session child. */
  run?: SessionRunner | undefined;
}

interface SessionFacts {
  brief: string | null;
  model: string | null;
}

function sessionFacts(ledger: Ledger, sessionId: string): SessionFacts {
  try {
    return (ledger.db.prepare("SELECT brief, model FROM sessions WHERE id = ?").get(sessionId) as SessionFacts | undefined) ?? { brief: null, model: null };
  } catch {
    return { brief: null, model: null };
  }
}

function readTask(path: string): { ok: true; task: TaskFile } | { ok: false; message: string } {
  if (!existsSync(path)) return { ok: false, message: `lykos review: the task file ${path} does not exist` };
  try {
    return { ok: true, task: parseTaskFile(readFileSync(path, "utf8")) };
  } catch (err) {
    if (err instanceof TaskFileError) return { ok: false, message: `lykos review: ${err.message}` };
    throw err;
  }
}

export interface JudgeInput {
  workspace: string;
  ledgerPath: string;
  /** The reviewer session the findings were recorded under. */
  reviewerId: string;
  /** The findings to judge: all of the reviewer's, or (in a cycle's recheck) the ones that recheck recorded. */
  stored: readonly StoredFinding[];
  head: string;
  base: string;
  /** The session whose change is reviewed; decisions are filed under it. Absent: under the reviewer. */
  targetSession?: string | undefined;
  trust: TrustSource;
  containment: ContainmentChoice;
  /** `seal.test_command`. */
  testCommand: string;
  /** `delegation.shell_path`. */
  shellPath?: string | undefined;
  /** The cycle these findings belong to; its id is on every decision row (T236). */
  cycleId?: string | undefined;
}

/**
 * The harness's side of a review, shared by `lykos review` and the review cycle: it runs every finding's check on the
 * branch, decides by rule (`findings.ts`), stores what it found and files the decisions. Recording is idempotent, so a
 * retried review or a recovered cycle judges again without appending a decision twice.
 */
export async function judgeFindings(input: JudgeInput): Promise<JudgedFinding[]> {
  const { reviewerId, head, base, ledgerPath } = input;
  const checkable = input.stored.filter((f) => f.check !== undefined);
  const results: ClaimResult[] =
    checkable.length === 0
      ? []
      : await checkClaims({
          repo: input.workspace,
          ledgerPath,
          sessionId: reviewerId,
          claims: checkable.map((f) => ({ id: f.id, session_id: f.session_id, ts: f.ts, text: f.text, check: f.check! })),
          head,
          base,
          trust: input.trust,
          containment: input.containment,
          testCommand: input.testCommand,
          shellPath: input.shellPath,
        });
  const baselineFailing = await withLedger(ledgerPath, async (ledger) => {
    const found = sessionBaseline(ledger, reviewerId) ?? (input.targetSession !== undefined ? sessionBaseline(ledger, input.targetSession) : undefined);
    return found?.baseline.status === "measured" && found.baseline.kind === "names" ? found.baseline.failing : undefined;
  });
  const judgedFindings: JudgedFinding[] = input.stored.map((f) => {
    const result = results.find((r) => r.id === f.id);
    return judged(f, result, dispose({ severity: f.severity, check: f.check, result, baselineFailing }));
  });

  // The decisions go under the session the findings are about, so `lykos status` on it shows what became of them.
  const about = input.targetSession ?? reviewerId;
  withLedgerSync(ledgerPath, (ledger) => {
    recordFindingJudgements(ledger, judgedFindings, head, base);
    for (const f of judgedFindings) {
      if (f.disposition === "triage") continue;
      recordFindingDecision(ledger, {
        sessionId: about,
        ...(input.cycleId !== undefined ? { cycleId: input.cycleId } : {}),
        findingId: f.finding_id,
        action: f.disposition === "blocks" ? "forwarded" : "dropped",
        reason: f.why,
      });
    }
  });
  return judgedFindings;
}

const error = (message: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ outcome: "error", message, ...extra, next: "fix_environment" });

export interface ReviewPlan {
  config: ResolvedConfig;
  task?: TaskFile;
  target: ReviewTarget;
  implementerModel?: string;
  choice: RoleChoice;
  sameFamily: boolean;
  facts: ChangeFacts;
  /** The verification command the task or the stored baseline names. */
  testCommand?: string;
  /** The task the change is judged against: the task file's body, else the brief the session was given. */
  taskText: string;
  /** What the reviewer is told of the verification command's failures on the base. */
  baselineBrief: BriefInput["baseline"];
  /** The first reviewer brief. */
  brief: string;
  packFiles: string[];
}

/**
 * Everything a review needs before its reviewer starts, shared by `lykos review` and the review cycle's first round:
 * the target and its stored base, the reviewer role (swapped when its model is the implementer's family), the change,
 * the task and the brief. A review that cannot be planned comes back as the error result to return.
 */
export function planReview(
  workspace: string,
  targetArg: string,
  opts: Pick<ReviewOptions, "taskFile" | "note" | "base">,
): { ok: true; plan: ReviewPlan } | { ok: false; result: Record<string, unknown> } {
  const ledgerPath = defaultLedgerPath(workspace);
  const config = (() => {
    try {
      return loadConfig({ cwd: workspace }).resolved;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  })();
  if (config instanceof Error) return { ok: false, result: error(`lykos review: the configuration cannot be read: ${config.message}`) };

  let task: TaskFile | undefined;
  if (opts.taskFile !== undefined) {
    const read = readTask(opts.taskFile);
    if (!read.ok) return { ok: false, result: error(read.message) };
    task = read.task;
  }

  const lookup = (ledger: Ledger | undefined) => {
    const found = resolveReviewTarget(workspace, ledger, targetArg, opts.base);
    if (!found.ok || ledger === undefined || found.target.session === undefined) return { ...found, facts: { brief: null, model: null } as SessionFacts, baseline: undefined };
    return { ...found, facts: sessionFacts(ledger, found.target.session), baseline: sessionBaseline(ledger, found.target.session)?.baseline };
  };
  const resolved = existsSync(ledgerPath) ? withLedgerSync(ledgerPath, lookup) : lookup(undefined);
  if (!resolved.ok) return { ok: false, result: error(resolved.message) };
  const { target } = resolved;

  // The reviewer: the role's model, or its alternate when the role's is the implementer's family. An implementer whose
  // model the ledger does not know cannot be told apart from, so the role's model stays and the flag below is not raised.
  const implementerModel = resolved.facts.model ?? undefined;
  const choice = reviewerRole(config.models.roles, REVIEW_ROLE, implementerModel);
  const sameFamily = choice.model !== undefined && implementerModel !== undefined && modelFamily(choice.model) === modelFamily(implementerModel);

  const facts = changeOf(workspace, target.base, target.head);
  const testCommand = task?.test ?? (resolved.baseline !== undefined ? resolved.baseline.key.command : undefined);
  const baselineBrief: BriefInput["baseline"] =
    resolved.baseline === undefined
      ? testCommand !== undefined
        ? { command: testCommand, unmeasured: "no baseline was recorded for this change" }
        : undefined
      : resolved.baseline.status === "measured"
        ? { command: resolved.baseline.key.command, failing: resolved.baseline.failing }
        : { command: resolved.baseline.key.command, unmeasured: resolved.baseline.reason };
  const taskText = task?.body ?? resolved.facts.brief ?? "";
  const brief = reviewBrief({ target, facts, task: taskText, baseline: baselineBrief, note: opts.note });
  const packFiles = [...new Set([...(task?.files ?? []), ...facts.changed.filter((c) => c.status !== "D").map((c) => c.path)])].slice(0, MAX_PACK_FILES);
  return {
    ok: true,
    plan: {
      config,
      ...(task !== undefined ? { task } : {}),
      target,
      ...(implementerModel !== undefined ? { implementerModel } : {}),
      choice,
      sameFamily,
      facts,
      ...(testCommand !== undefined ? { testCommand } : {}),
      taskText,
      baselineBrief,
      brief,
      packFiles,
    },
  };
}

/**
 * Reviews a session's change (or a branch) with one reviewer and returns the findings as the harness judged them. Never
 * throws; a review that could not run is an `error` result with the reviewer's own message (R14).
 */
export async function runReview(workspace: string, targetArg: string, opts: ReviewOptions): Promise<Record<string, unknown>> {
  const ledgerPath = defaultLedgerPath(workspace);
  const planned = planReview(workspace, targetArg, opts);
  if (!planned.ok) return planned.result;
  const { config, task, target, implementerModel, choice, sameFamily, facts, testCommand, brief, packFiles } = planned.plan;

  opts.onProgress?.(`reviewer: ${choice.role}${choice.model !== undefined ? ` on ${choice.model}` : ""}${choice.reason !== undefined ? ` (the alternate: ${choice.reason})` : ""}`);
  const reviewed = await runDelegated(
    workspace,
    {
      brief,
      specialist: REVIEW_ROLE,
      ...(choice.model !== undefined ? { model: choice.model } : {}),
      base: target.base,
      review: true,
      ...(target.session !== undefined ? { rulings_from: [target.session] } : {}),
      ...(packFiles.length > 0 ? { files: packFiles } : {}),
      ...(testCommand !== undefined ? { test: testCommand } : {}),
      ...(opts.maxSteps !== undefined ? { max_steps: opts.maxSteps } : {}),
      ...(opts.requestId !== undefined ? { request_id: opts.requestId } : {}),
    },
    {
      trustSource: opts.trustSource,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
      ...(opts.run !== undefined ? { run: opts.run } : {}),
    },
  );

  const reviewerId = typeof reviewed["sessionId"] === "string" ? reviewed["sessionId"] : undefined;
  const reviewer = { ...(reviewerId !== undefined ? { session_id: reviewerId } : {}), role: choice.role, ...(choice.model !== undefined ? { model: choice.model } : {}), ...(choice.reason !== undefined ? { swapped: choice.reason } : {}) };
  // R14: a reviewer that did not review stops the review with what it said. An empty list of findings would read as
  // "nothing wrong", which nobody has said.
  if (reviewed["outcome"] !== "ok" && reviewed["outcome"] !== "unverified") {
    const why = typeof reviewed["message"] === "string" ? reviewed["message"] : typeof reviewed["reason"] === "string" ? reviewed["reason"] : `the reviewer ended ${String(reviewed["outcome"])}`;
    return {
      outcome: "error",
      message: `lykos review: the reviewer (${choice.role}${choice.model !== undefined ? ` on ${choice.model}` : ""}) did not review: ${why}`,
      reviewer,
      reviewed: reviewedOf(target),
      ...(typeof reviewed["next"] === "string" ? { next: reviewed["next"] } : { next: "fix_environment" }),
    };
  }
  if (reviewerId === undefined) return { ...error("lykos review: the reviewer ended with no session id", { reviewer }), reviewed: reviewedOf(target) };

  const stored = await withLedger(ledgerPath, async (ledger) => findingsOf(ledger, reviewerId));
  const containment: ContainmentChoice = (reviewed["containment"] as ContainmentChoice | undefined) ?? config.containment.level ?? "off";
  const judgedFindings = await judgeFindings({
    workspace,
    ledgerPath,
    reviewerId,
    stored,
    head: target.head,
    base: target.base,
    ...(target.session !== undefined ? { targetSession: target.session } : {}),
    trust: opts.trustSource,
    containment,
    testCommand: config.seal.test_command,
    shellPath: config.delegation.shell_path,
  });

  const flags: SessionFlag[] = [
    ...flagsOfChange(facts, target.session, task?.scope ?? [], task?.files ?? []),
    ...(sameFamily
      ? [{ flag: "SAME-FAMILY" as const, detail: `the reviewer (${choice.model}) is the implementer's model family (${modelFamily(implementerModel!)}) and its alternate does not differ`, session: reviewerId }]
      : []),
    ...(Array.isArray(reviewed["flags"]) ? (reviewed["flags"] as SessionFlag[]) : []),
  ];
  const counts = { blocks: 0, triage: 0, dropped: 0 };
  for (const f of judgedFindings) counts[f.disposition] += 1;
  return {
    outcome: "ok",
    reviewer,
    reviewed: reviewedOf(target),
    findings: judgedFindings,
    counts,
    ...(flags.length > 0 ? { flags } : {}),
    next: nextOfFindings(judgedFindings, flags.length > 0),
  };
}

function reviewedOf(target: ReviewTarget): Record<string, unknown> {
  return { ...(target.session !== undefined ? { session_id: target.session } : {}), branch: target.branch, head: target.head, base: target.base, base_source: target.baseSource };
}
