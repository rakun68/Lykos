// The post-edit loop and the task list in `lykos show`'s strength section.
//
// READ, NEVER RECOMPUTED. Every line below comes from one of two places: the
// session's ledger row (the counters T99 and T98 already write) and two files
// in the session directory — `post-edit.jsonl`, one line per run with the text
// the model was shown, and `tasks.json`, the list as its last change left it.
// Nothing is re-run and nothing is inferred from the transcript, so this
// section cannot disagree with the record.
//
// P4 T149 (spec stories 17, 18, 34): the reviewer, and every extension's
// counters. The reviewer is the `lykos-reviewer` extension; what it did is
// read from three records it left — its counters in `extension_counters`,
// its child session's ledger row (the model), and that child's transcript
// (the findings, as the child wrote them). A session with no counters from
// it says "did not run", and says why when the reviewer recorded a reason.
//
// T168 part B (ADR-0031, decision 12): the `edit` tool's own record. How many
// calls, how many failed and why, and how many post-edit failures there were per
// successful edit. Every number comes from the transcript's `tool_result` events
// (the one place a call's outcome and its error text are kept) and the post-edit
// record above; a session whose transcript cannot say prints `unmeasured`, never
// a guess, and nothing is backfilled (AGENTS.md rule 4).
//
// ABSENCE IS SAID. A mechanism that was off, had nothing to do, or predates
// its record reads "did not run" or says what is missing — never an empty
// block a reader could take for "ran and found nothing".

import type { Ledger } from "../ledger/use.js";
import { REVIEWER_EXTENSION } from "../extensions/defaults/index.js";
import { resolveTranscriptFile, readTranscript, transcriptFilePath } from "../session/transcript.js";
import { readPostEditRuns, type PostEditRunRecord } from "../loop/post-edit.js";
import { readTaskListFile, type TaskItem } from "../tools/task-list.js";
import {
  classifyEditFailure,
  EDIT_FAILURE_REASONS,
  emptyFailureCounts,
  type EditFailureReason,
} from "../tools/edit-failure.js";
import type { TranscriptEventInput } from "../session/transcript.js";
import { stdoutWrite } from "../tui/io-mode.js";

interface StrengthRow {
  post_edit_command: string | null;
  post_edit_runs: number | null;
  post_edit_failures: number | null;
  post_edit_disabled_reason: string | null;
  task_list_calls: number | null;
}

/**
 * T168 part B: the `edit` tool's calls and failures, and the post-edit failures
 * per successful edit.
 *
 * **The denominator.** `file_changing_calls` is the number of SUCCESSFUL
 * file-changing calls in the transcript (a `tool_result` marked `changes_files`),
 * the set the post-edit loop runs after, so the numerator (failed post-edit runs)
 * and the denominator count the same events. In a session that only used `edit`
 * it equals `succeeded`; one `write` or `ast_edit` makes it larger, and the line
 * says so. The ratio is stated only when the loop ran after every one of them.
 */
export interface EditsRecord {
  /** Why no per-call figure could be read (a snapshot transcript, none readable); null when the figures below are real. */
  unmeasured_reason: string | null;
  /** `edit` calls that finished, successful or not. */
  calls: number | null;
  succeeded: number | null;
  failed: number | null;
  /** Failed `edit` calls by reason, zeros included; null with `calls`. */
  failures_by_reason: Record<EditFailureReason, number> | null;
  /** Successful file-changing calls of any tool; null when the transcript predates T146's `changes_files` marks. */
  file_changing_calls: number | null;
  /** Post-edit runs whose verdict was a failure; null when the loop never ran or kept no count. */
  post_edit_failed_runs: number | null;
  /** `post_edit_failed_runs / file_changing_calls`; null when either is unknown or the loop did not watch every call. */
  post_edit_failures_per_edit: number | null;
  /** Why the ratio is null; null when it is a number. */
  post_edit_failures_unmeasured_reason: string | null;
}

export interface StrengthRecord {
  post_edit: {
    command: string | null;
    /** The ledger's counters, as ingested at the session's end. Null before T99 or before the session ended. */
    counted_runs: number | null;
    counted_failures: number | null;
    disabled_reason: string | null;
    /** Per-run records from the session directory; null when none were written. */
    runs: PostEditRunRecord[] | null;
  };
  task_list: {
    calls: number | null;
    /** The list as `tasks.json` holds it at the session's end; null when the list was never changed. */
    items: TaskItem[] | null;
    updated_utc: string | null;
  };
  /** T168 part B. */
  edits: EditsRecord;
  /** T149: every counter any Lykos extension recorded for this session, in ledger order. */
  extension_counters: Array<{ extension: string; name: string; value: number }>;
  reviewer: {
    /** `lykos-reviewer`'s own counters; empty when it recorded nothing. */
    counters: Record<string, number>;
    /** The read-only child sessions it ran, oldest first. */
    reviews: Array<{ session_id: string; model: string | null; outcome: string | null; text: string | null }>;
  };
}

/** The last final assistant text of a session's transcript, or null when there is none to read. */
function finalText(ledgerPath: string, sessionId: string, recordedPath: string | null): string | null {
  const resolved = resolveTranscriptFile(recordedPath ?? transcriptFilePath(ledgerPath, sessionId));
  if (!resolved) return null;
  try {
    const { events } = readTranscript(resolved.path);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const e = events[i] as { kind?: string; text?: string };
      if (e.kind === "assistant_message" && typeof e.text === "string" && e.text.trim().length > 0) return e.text;
    }
  } catch {
    return null;
  }
  return null;
}

/** The text of a tool result as the transcript keeps it: Pi's `{content:[{type:"text",text}]}`, a bare string, or nothing readable (a spill stub). */
function resultText(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  if (typeof result !== "object" || result === null) return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((block) => block as { type?: unknown; text?: unknown })
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * T168 part B: the `edit` figures. `events` and `captureMode` are the
 * transcript `lykos show` already read; absent, or not a live (`stream`)
 * capture, there are no per-call results and everything is `unmeasured`.
 */
export function readEdits(
  events: ReadonlyArray<TranscriptEventInput> | undefined,
  captureMode: string | null | undefined,
  postEdit: StrengthRecord["post_edit"],
): EditsRecord {
  const none = (unmeasured_reason: string): EditsRecord => ({
    unmeasured_reason,
    calls: null,
    succeeded: null,
    failed: null,
    failures_by_reason: null,
    file_changing_calls: null,
    post_edit_failed_runs: null,
    post_edit_failures_per_edit: null,
    post_edit_failures_unmeasured_reason: unmeasured_reason,
  });
  if (events === undefined) return none("no transcript was read");
  if (captureMode !== "stream") {
    return none(
      captureMode === null || captureMode === undefined
        ? "the transcript's capture mode was not recorded, so it cannot be trusted to hold every call's result"
        : `the transcript is a ${captureMode}, which holds no per-call results`,
    );
  }

  let calls = 0;
  let failed = 0;
  const byReason = emptyFailureCounts();
  let fileChanging = 0;
  for (const e of events) {
    if (e.kind !== "tool_result") continue;
    if (e.changes_files === true) fileChanging += 1;
    if (e.name !== "edit") continue;
    calls += 1;
    if (e.state === "error") {
      failed += 1;
      byReason[classifyEditFailure(resultText(e.result))] += 1;
    }
  }

  // Failed post-edit runs, the way the post-edit line itself counts them: the per-run
  // records when they were kept, the ledger's counter when only that survives.
  const runs = postEdit.runs ?? [];
  const failedRuns = runs.length > 0 ? runs.filter((r) => r.verdict === "fail").length : postEdit.counted_failures;
  const totalRuns = runs.length > 0 ? runs.length : (postEdit.counted_runs ?? 0);
  const marked = events.some((e) => e.kind === "turn_start");

  let ratio: number | null = null;
  let why: string | null = null;
  if (!marked) {
    why = "the transcript predates the file-change marks (T146), so its file-changing calls cannot be counted";
  } else if (totalRuns === 0 || failedRuns === null) {
    why = "the post-edit loop did not run";
  } else if (fileChanging === 0) {
    why = "no file-changing call succeeded";
  } else if (totalRuns !== fileChanging) {
    why = `the post-edit loop ran after ${totalRuns} of ${fileChanging} file-changing call(s)`;
  } else {
    ratio = failedRuns / fileChanging;
  }

  return {
    unmeasured_reason: null,
    calls,
    succeeded: calls - failed,
    failed,
    failures_by_reason: byReason,
    file_changing_calls: marked ? fileChanging : null,
    post_edit_failed_runs: totalRuns === 0 ? null : failedRuns,
    post_edit_failures_per_edit: ratio,
    post_edit_failures_unmeasured_reason: why,
  };
}

/** What `readStrength` needs from the transcript `lykos show` already read. */
export interface StrengthTranscript {
  events: ReadonlyArray<TranscriptEventInput>;
  captureMode: string | null;
}

/** Everything the strength section prints, from the ledger row, the session directory and the transcript already read. */
export function readStrength(
  ledger: Ledger,
  sessionId: string,
  sessionDir: string,
  ledgerPath?: string,
  transcript?: StrengthTranscript,
): StrengthRecord {
  const row = ledger.db
    .prepare(
      `SELECT post_edit_command, post_edit_runs, post_edit_failures, post_edit_disabled_reason, task_list_calls
         FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as StrengthRow | undefined;
  const list = readTaskListFile(sessionDir);
  const counters = ledger.extensionCounters(sessionId);
  const reviewerCounters: Record<string, number> = {};
  for (const c of counters) if (c.extension === REVIEWER_EXTENSION) reviewerCounters[c.name] = c.value;
  const children = ledger.db
    .prepare(
      `SELECT id, model, outcome, transcript_path FROM sessions
        WHERE parent_session_id = ? AND agent_role = ? ORDER BY started_utc, id`,
    )
    .all(sessionId, `extension:${REVIEWER_EXTENSION}`) as Array<{
    id: string;
    model: string | null;
    outcome: string | null;
    transcript_path: string | null;
  }>;
  const postEdit: StrengthRecord["post_edit"] = {
    command: row?.post_edit_command ?? null,
    counted_runs: row?.post_edit_runs ?? null,
    counted_failures: row?.post_edit_failures ?? null,
    disabled_reason: row?.post_edit_disabled_reason ?? null,
    runs: readPostEditRuns(sessionDir),
  };
  return {
    post_edit: postEdit,
    edits: readEdits(transcript?.events, transcript?.captureMode, postEdit),
    task_list: {
      calls: row?.task_list_calls ?? null,
      items: list?.items ?? null,
      updated_utc: list?.updatedUtc ?? null,
    },
    extension_counters: counters,
    reviewer: {
      counters: reviewerCounters,
      reviews: children.map((c) => ({
        session_id: c.id,
        model: c.model,
        outcome: c.outcome,
        text: ledgerPath !== undefined ? finalText(ledgerPath, c.id, c.transcript_path) : null,
      })),
    },
  };
}

const MARK: Record<TaskItem["status"], string> = {
  pending: "[ ] pending    ",
  in_progress: "[>] in progress",
  done: "[x] done       ",
  dropped: "[-] dropped    ",
};

function writePostEdit(p: StrengthRecord["post_edit"]): void {
  const runs = p.runs ?? [];
  if (runs.length === 0) {
    if ((p.counted_runs ?? 0) > 0) {
      // Counted but not itemised: the session predates T145's per-run record.
      stdoutWrite(
        ` post-edit  ${p.counted_runs} run(s), ${p.counted_failures ?? 0} failed — per-run records not kept (predates T145)\n`,
      );
      return;
    }
    const why =
      p.command === null
        ? "no post-edit command was configured or discovered"
        : `\`${p.command}\` never ran — no file-changing call reached it, or the loop was off`;
    stdoutWrite(` post-edit  did not run — ${why}\n`);
    return;
  }
  const failed = runs.filter((r) => r.verdict === "fail").length;
  const passed = runs.filter((r) => r.verdict === "pass").length;
  const none = runs.length - failed - passed;
  stdoutWrite(
    ` post-edit  ${runs.length} run(s): ${failed} failed, ${passed} passed${none > 0 ? `, ${none} could not run` : ""}\n`,
  );
  for (const r of runs) {
    const verdict = r.verdict === "fail" ? "FAIL" : r.verdict === "pass" ? "pass" : "NO VERDICT";
    const off = r.disabled_reason !== undefined ? `  then off: ${r.disabled_reason}` : "";
    stdoutWrite(`   run ${r.seq}  ${verdict}  \`${r.command}\`  exit ${r.exit_code ?? "(none)"}  ${r.ms}ms${off}\n`);
    if (r.verdict !== "pass" && r.shown !== null) {
      stdoutWrite("     the model saw:\n");
      for (const line of r.shown.split("\n")) stdoutWrite(`       | ${line}\n`);
    }
  }
}

/**
 * T168 part B: two lines after the post-edit block. ` edit calls` carries the
 * counts and the post-edit failures per successful edit; ` edit fails` names the
 * reasons, non-zero ones only, and is absent when nothing failed. (The older
 * ` edits` line is the file-changing turns and their checkpoints.)
 */
function writeEdits(e: EditsRecord): void {
  if (e.unmeasured_reason !== null || e.calls === null) {
    stdoutWrite(` edit calls unmeasured — ${e.unmeasured_reason ?? "no transcript"}\n`);
    return;
  }
  const ratio =
    e.post_edit_failures_per_edit !== null
      ? `${e.post_edit_failures_per_edit.toFixed(2)} (${e.post_edit_failed_runs} failed post-edit run(s) over ${e.file_changing_calls} successful file-changing call(s))`
      : `unmeasured — ${e.post_edit_failures_unmeasured_reason}`;
  stdoutWrite(
    ` edit calls ${e.calls} call(s), ${e.succeeded} succeeded, ${e.failed} failed; post-edit failures per successful edit ${ratio}\n`,
  );
  if (e.failed !== null && e.failed > 0 && e.failures_by_reason !== null) {
    const counts = e.failures_by_reason;
    const parts = EDIT_FAILURE_REASONS.filter((r) => counts[r] > 0).map((r) => `${r} ${counts[r]}`);
    stdoutWrite(` edit fails ${parts.join(", ")}\n`);
  }
}

function writeTaskList(t: StrengthRecord["task_list"]): void {
  if (t.items === null) {
    stdoutWrite(
      (t.calls ?? 0) > 0
        ? ` task list  called ${t.calls} time(s) but never changed — no list was kept\n`
        : " task list  did not run — the task list was never used\n",
    );
    return;
  }
  const open = t.items.filter((i) => i.status === "pending" || i.status === "in_progress").length;
  stdoutWrite(` task list  ${t.items.length} item(s) at the end, ${open} open  (as of ${t.updated_utc ?? "?"})\n`);
  for (const item of t.items) {
    const verified =
      item.verified !== undefined ? `  ${item.verified.ok ? "verified" : "VERIFY FAILED"} (exit ${item.verified.exitCode ?? "?"})` : "";
    stdoutWrite(`   ${item.id} ${MARK[item.status]}  ${item.text}${verified}\n`);
  }
}

/** Why the reviewer did not run, from the reason it recorded — or from the absence of any record. */
function reviewerSkipReason(c: Record<string, number>): string {
  if ((c.skipped_no_edits ?? 0) > 0) return "the session edited no files";
  if ((c.skipped_no_diff ?? 0) > 0) return "the session edited files but left no diff to review";
  if ((c.skipped_unfinished ?? 0) > 0) return "the session did not finish, so there was no verdict to review after";
  return `no record from ${REVIEWER_EXTENSION} — it was off (\`reviewer.enabled\`), not declared in \`lykos_extensions\`, or the session predates it`;
}

const REVIEW_TEXT_MAX_LINES = 40;

function writeReviewer(r: StrengthRecord["reviewer"]): void {
  const runs = r.counters.invocations ?? 0;
  if (runs === 0) {
    stdoutWrite(` reviewer   did not run — ${reviewerSkipReason(r.counters)}\n`);
    return;
  }
  const findings = r.counters.findings;
  const failures = r.counters.failures ?? 0;
  const models = [...new Set(r.reviews.map((v) => v.model ?? "?"))].join(", ") || "(no child session recorded)";
  stdoutWrite(
    ` reviewer   ran ${runs} time(s) on ${models} — ` +
      (findings !== undefined ? `${findings} finding(s), advisory` : "no findings recorded") +
      (failures > 0 ? `; ${failures} run(s) did not complete` : "") +
      "\n",
  );
  for (const v of r.reviews) {
    stdoutWrite(`   review ${v.session_id}  model ${v.model ?? "?"}\n`);
    if (v.text === null) {
      stdoutWrite("     (no final text in its transcript)\n");
      continue;
    }
    const lines = v.text.trim().split("\n");
    for (const line of lines.slice(0, REVIEW_TEXT_MAX_LINES)) stdoutWrite(`     | ${line}\n`);
    if (lines.length > REVIEW_TEXT_MAX_LINES) {
      stdoutWrite(`     | … ${lines.length - REVIEW_TEXT_MAX_LINES} more line(s): lykos show ${v.session_id}\n`);
    }
  }
}

function writeExtensionCounters(rows: StrengthRecord["extension_counters"]): void {
  if (rows.length === 0) {
    stdoutWrite(" extensions no counters recorded\n");
    return;
  }
  const byExtension = new Map<string, string[]>();
  for (const r of rows) byExtension.set(r.extension, [...(byExtension.get(r.extension) ?? []), `${r.name}=${r.value}`]);
  for (const [extension, parts] of byExtension) stdoutWrite(` extension  ${extension}  ${parts.join("  ")}\n`);
}

/** The post-edit, task-list, reviewer and extension-counter lines of `lykos show`'s strength section. */
export function writeStrength(s: StrengthRecord): void {
  writePostEdit(s.post_edit);
  writeEdits(s.edits);
  writeTaskList(s.task_list);
  writeReviewer(s.reviewer);
  writeExtensionCounters(s.extension_counters);
}
