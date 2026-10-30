// `lykos show <session>` — T28.3 (docs/10-phase2-tasks.md T28, "Head and
// session inspection"), docs/05-cli-and-config.md §4, docs/08-sessions-and-
// archive.md §2. T9 already captures a redacted, append-only, sha256-hashed
// transcript per session; this is simply the reader nobody wrote yet. It
// computes nothing new — readTranscript()/verifyTranscriptHash() from
// session/transcript.ts are the whole contract, reused verbatim.
//
// T28.4: this is host-side only. It never runs inside a delegate session,
// registers no Pi tool, and touches no head — showing a transcript is a
// question a human asks the ledger, not something the model is ever asked.
//
// Judgement calls:
//  - Session resolution tries an exact `sessions.id` match first (so a full
//    id that also happens to prefix other rows still resolves), then a
//    unique LIKE-prefix match. Ambiguous or absent, it lists the most recent
//    handful of session ids on stderr — the acceptance bar is "so the user
//    can pick one," not "give a full diagnostic."
//  - A hash mismatch refuses IDENTICALLY in text and `--json` mode: nothing
//    reaches stdout beyond nothing at all, only the loud stderr refusal.
//    `doctor` treats a damaged transcript as a real, reported state
//    (checkTranscriptIntegrity in cli/doctor.ts); this must not be more
//    trusting than that.
//  - `verifyTranscriptHash()` gives a bool; the mismatch message also wants
//    the *actual* hash to show beside the expected one, so this file hashes
//    the file a second time only on the mismatch path (rare) rather than
//    reimplementing the check.
//  - Cost is deliberately never computed here — `UsageEvent.call_id`'s own
//    comment in transcript.ts says why: the ledger's `priceCall()` is the one
//    place that arithmetic happens, and a second copy could drift from it.

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";

import { openLedgerSync, type Ledger, type SealEventRow } from "../ledger/use.js";
import type { CommitShown, FlakyTestRow } from "../ledger/ledger.js";

import { outcomeLabel } from "../ledger/summary.js";
import {
  readSessionMeta,
  readTranscript,
  readTranscriptBytes,
  resolveTranscriptFile,
  transcriptDir,
  transcriptFilePath,
  verifyTranscriptHash,
  type SessionMeta,
  type TranscriptEventInput,
  type TranscriptEventRecord,
} from "../session/transcript.js";
import { clampVerificationOutput } from "../session/verify-outcome.js";
import { checkpointsForSession, isGitRepo, shortHash, type CheckpointEntry } from "../loop/checkpoint.js";
import { PRUNE_NOTICES } from "../loop/tool-result-prune.js";
import { SHAKE_NOTICE } from "../loop/shake.js";
import { stdoutWrite } from "../tui/io-mode.js";
import { readStrength, writeStrength } from "./show-strength.js";

export interface ShowOptions {
  json?: boolean;
}

interface SessionRow {
  id: string;
  task_id: string | null;
  brief: string | null;
  started_utc: string;
  ended_utc: string | null;
  outcome: string | null;
  outcome_source: string | null;
  model: string | null;
  capture_mode: string | null;
  transcript_path: string | null;
  transcript_sha256: string | null;
  verification_cmd: string | null;
  verification_output: string | null;
  verification_exit_code: number | null;
}

const SESSION_COLUMNS =
  "id, task_id, brief, started_utc, ended_utc, outcome, outcome_source, model, capture_mode, transcript_path, transcript_sha256, " +
  "verification_cmd, verification_output, verification_exit_code";

/** T144: how much of the gate's stored output `lykos show` prints. The ledger keeps up to 4000 characters. */
export const GATE_EXCERPT_LIMIT = 1200;

/** T55: the hash is always of the UNCOMPRESSED bytes, so an archived transcript reports the same value a raw one did. */
function sha256File(path: string): string {
  return createHash("sha256").update(readTranscriptBytes(path)).digest("hex");
}

function writeNoMatch(ledger: Ledger, idOrPrefix: string, reason: string): void {
  process.stderr.write(`lykos show: ${reason}: "${idOrPrefix}"\n`);
  const recent = ledger.db
    .prepare(`SELECT id, brief, started_utc FROM sessions ORDER BY started_utc DESC LIMIT 8`)
    .all() as Array<{ id: string; brief: string | null; started_utc: string }>;
  if (recent.length === 0) {
    process.stderr.write("  no sessions recorded yet.\n");
    return;
  }
  process.stderr.write("  most recent sessions:\n");
  for (const r of recent) {
    process.stderr.write(`    ${r.id}  ${r.started_utc}  ${r.brief ?? "(no brief)"}\n`);
  }
}

/** Exact `sessions.id` match first, then a unique id-prefix match. Null (and an already-written stderr message) on ambiguous or absent. */
function resolveSessionRow(ledger: Ledger, idOrPrefix: string): SessionRow | null {
  const exact = ledger.db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`)
    .get(idOrPrefix) as SessionRow | undefined;
  if (exact) return exact;

  const matches = ledger.db
    .prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE id LIKE ? ORDER BY started_utc DESC`)
    .all(`${idOrPrefix}%`) as SessionRow[];
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    writeNoMatch(ledger, idOrPrefix, `ambiguous session prefix — ${matches.length} sessions match`);
    return null;
  }
  writeNoMatch(ledger, idOrPrefix, "no session matches");
  return null;
}

function writeHeader(row: SessionRow, verified: boolean, eventCount: number, taskState?: string | null): void {
  const rule = "─".repeat(63);
  stdoutWrite(`${rule}\n`);
  stdoutWrite(` lykos show  session ${row.id}\n`);
  stdoutWrite(`${rule}\n`);
  stdoutWrite(` brief      ${row.brief ?? "(no brief)"}\n`);
  stdoutWrite(` model      ${row.model ?? "?"}\n`);
  stdoutWrite(` started    ${row.started_utc}\n`);
  stdoutWrite(` ended      ${row.ended_utc ?? "(not ended)"}\n`);
  const taskStateSuffix = taskState === "disputed" ? " (task: disputed)" : "";
  stdoutWrite(` outcome    ${outcomeLabel(row.outcome, row.outcome_source, row.ended_utc)}${taskStateSuffix}\n`);
  stdoutWrite(` events     ${eventCount}\n`);
  // T53: what this transcript actually IS. `stream` was captured live off
  // the agent's event stream and holds the human side of the conversation;
  // `snapshot` is the terminal-snapshot subset and has no user message in it
  // anywhere, which is why it can be read but never resumed as a
  // conversation. A session predating the column says so, rather than being
  // guessed at.
  stdoutWrite(` capture    ${row.capture_mode ?? "(unrecorded — predates capture_mode)"}\n`);
  stdoutWrite(
    verified
      ? ` verified   sha256:${(row.transcript_sha256 as string).slice(0, 12)}…\n`
      : " verified   UNVERIFIED — no recorded hash (session did not finalize)\n",
  );
  stdoutWrite(`${rule}\n`);
}

/**
 * T144: the gate's verdict as the ledger holds it — command, outcome, exit
 * code, and a bounded excerpt of what the command printed. Read, never
 * recomputed. A session no command verified says so and shows no exit code:
 * "not run" must never read as zero.
 */
function writeGate(row: SessionRow, flaky: readonly FlakyTestRow[] = []): void {
  if (row.verification_cmd === null) {
    stdoutWrite(" gate       did not run — no verification command recorded\n");
    stdoutWrite(" exit code  (none)\n");
    return;
  }
  stdoutWrite(` gate       \`${row.verification_cmd}\`\n`);
  stdoutWrite(` verdict    ${row.outcome ?? "(none)"} (source=${row.outcome_source ?? "unspecified"})\n`);
  stdoutWrite(` exit code  ${row.verification_exit_code ?? "(not recorded — verified before exit codes were kept)"}\n`);
  const output = row.verification_output?.trim() ?? "";
  // T176: a run a signal ended ends its output with a marker line. A timeout is a different fact from a crashed or failing test run.
  const stopped = /^\[(timed out after [^\]]+|killed by [^\]]+)\]$/.exec(output.split("\n").at(-1) ?? "");
  if (stopped?.[1] !== undefined) stdoutWrite(` stopped    ${stopped[1]}\n`);
  writeFlaky(flaky);
  if (output.length === 0) {
    stdoutWrite(" output     (empty)\n");
    return;
  }
  stdoutWrite(" output\n");
  for (const line of clampVerificationOutput(output, GATE_EXCERPT_LIMIT).split("\n")) stdoutWrite(`    | ${line}\n`);
}

/**
 * T167 (ADR-0030): the tests that failed in the gate's run and passed when
 * only their file was rerun. Read from the ledger's `flaky_tests` rows; a
 * session with none prints nothing, which includes every session before T167.
 */
function writeFlaky(flaky: readonly FlakyTestRow[]): void {
  if (flaky.length === 0) return;
  const first = flaky[0]!;
  stdoutWrite(
    ` flaky      ${flaky.length} test${flaky.length === 1 ? "" : "s"} failed, then passed on rerun ` +
      `(exit ${first.first_exit_code ?? "?"} → ${first.rerun_exit_code ?? "?"})\n`,
  );
  for (const t of flaky) {
    const edited = t.edited_by_session === 1 ? "  [file edited this session — verdict stays fail]" : "";
    stdoutWrite(`    - ${t.test_file}: ${t.test_name}${edited}\n`);
  }
  stdoutWrite(` rerun      \`${first.rerun_command}\`\n`);
}

/** T179: one commit as `lykos show` lists it. A count that was never taken reads `unmeasured`, not 0. */
export function formatCommitLine(c: Pick<CommitShown, "sha" | "subject" | "files_changed">): string {
  const files = c.files_changed === null ? "files unmeasured" : `${c.files_changed} file${c.files_changed === 1 ? "" : "s"}`;
  return `    ${c.sha.slice(0, 8)}  ${c.subject}  (${files})`;
}

/**
 * T179: the commits the session made through `commit`, from the ledger's
 * `commits` rows, short id, subject and file count. A session with none prints nothing, which
 * includes every session before T179.
 */
function writeCommits(commits: readonly CommitShown[]): void {
  if (commits.length === 0) return;
  stdoutWrite(` commits    ${commits.length} commit${commits.length === 1 ? "" : "s"} made through ${String.fromCharCode(96)}commit${String.fromCharCode(96)}${String.fromCharCode(10)}`);
  for (const c of commits) stdoutWrite(`${formatCommitLine(c)}${String.fromCharCode(10)}`);
}


/** A figure a row does not hold is "unreported", never 0. */
function figure(v: unknown): string {
  return typeof v === "number" ? String(v) : "unreported";
}

/** A compaction call's usage in one line: the same columns a row and a fell-through entry both carry. */
function usageText(u: Record<string, unknown>): string {
  return (
    `input=${figure(u.input_tokens)} output=${figure(u.output_tokens)} cache_read=${figure(u.cache_read_tokens)} ` +
    `cache_write=${figure(u.cache_write_tokens)} cache_write_1h=${figure(u.cache_write_1h_tokens)}`
  );
}

/**
 * T190: the lines for one `compactions` row -- which method ran, what fell
 * through before it and why, tokens before and after, and the compaction's own
 * model call with cache read and cache write apart. A figure the row does not
 * hold is "unreported", never 0.
 */
export function formatCompactionLines(c: Record<string, unknown>): string[] {
  const lines = [
    `   ${String(c.trigger)}  ${c.method === null || c.method === undefined ? "(no method recorded)" : `method=${String(c.method)}`}  ${String(c.result)}` +
      `  tokens ${figure(c.tokens_before)} -> ${figure(c.tokens_after)}`,
  ];
  if (c.input_tokens !== null && c.input_tokens !== undefined) lines.push(`     call: ${usageText(c)}`);
  if (typeof c.fell_through === "string") {
    try {
      for (const f of JSON.parse(c.fell_through) as Array<{ method: string; reason: string; usage?: Record<string, unknown> }>) {
        lines.push(`     fell through: ${f.method} -- ${f.reason}${f.usage !== undefined ? ` (call: ${usageText(f.usage)})` : ""}`);
      }
    } catch {
      // A column that is not JSON is shown by the JSON output; the text view skips it.
    }
  }
  return lines;
}

function writeCompactions(compactions: ReadonlyArray<Record<string, unknown>>): void {
  if (compactions.length === 0) return;
  stdoutWrite(` compactions ${compactions.length}\n`);
  for (const c of compactions) for (const line of formatCompactionLines(c)) stdoutWrite(`${line}\n`);
}

/** T146: one turn that changed files, and the checkpoint taken before it (absent = missing). */
export interface FileChangingTurn {
  turn: number;
  paths: string[];
  checkpoint?: CheckpointEntry;
}

/**
 * T146: the turns that changed files, read from the transcript's own marks
 * (`turn_start`, and `changes_files` on a result — both written at capture
 * time), paired with the session's checkpoints by the turn each checkpoint
 * records. Null when the transcript has no turn markers: it predates T146,
 * or it is a snapshot, and either way which turn did what was never written.
 */
export function fileChangingTurns(
  events: ReadonlyArray<TranscriptEventInput>,
  checkpoints: readonly CheckpointEntry[],
): FileChangingTurn[] | null {
  if (!events.some((e) => e.kind === "turn_start")) return null;
  const byTurn = new Map<number, FileChangingTurn>();
  let turn: number | undefined;
  for (const e of events) {
    if (e.kind === "turn_start") turn = e.turn;
    else if (e.kind === "tool_result" && e.changes_files === true && turn !== undefined) {
      const entry = byTurn.get(turn) ?? { turn, paths: [] };
      if (e.path !== undefined && !entry.paths.includes(e.path)) entry.paths.push(e.path);
      byTurn.set(turn, entry);
    }
  }
  return [...byTurn.values()]
    .sort((a, b) => a.turn - b.turn)
    .map((t) => {
      // Newest first, so a turn somehow checkpointed twice shows the later one.
      const checkpoint = checkpoints.find((c) => c.turn === t.turn);
      return checkpoint !== undefined ? { ...t, checkpoint } : t;
    });
}

/**
 * T146: the session's checkpoints, from the repository `meta.json` names. Unreadable is reported, never guessed.
 * A delegated session's worktree is removed when its call ends (T184), but the checkpoint ref lives in the main
 * repository's git directory, which the worktree shared: the ledger's own directory reaches it.
 */
function sessionCheckpoints(meta: SessionMeta | null, sessionId: string, ledgerPath: string): { entries: CheckpointEntry[]; note?: string } {
  const cwd = meta?.cwd ?? null;
  if (cwd === null) return { entries: [], note: "no working directory recorded, so no checkpoints could be read" };
  for (const dir of [cwd, dirname(ledgerPath)]) {
    if (existsSync(dir) && isGitRepo({ cwd: dir })) return { entries: checkpointsForSession({ cwd: dir }, sessionId) };
  }
  return { entries: [], note: `${cwd} is not a git repository now, so no checkpoints could be read` };
}

interface CredentialRow {
  provider: string | null;
  auth_mode: string | null;
  credential_label: string | null;
  calls: number;
}

/** T186: which credential served the session's calls, from the ledger's `calls` rows. No label is a key from outside the pool. */
function sessionCredentials(ledger: Ledger, sessionId: string): CredentialRow[] {
  return ledger.db
    .prepare(
      "SELECT provider, auth_mode, credential_label, COUNT(*) AS calls FROM calls WHERE session_id = ? " +
        "GROUP BY provider, auth_mode, credential_label ORDER BY MIN(rowid)",
    )
    .all(sessionId) as CredentialRow[];
}

function writeCredentials(rows: readonly CredentialRow[]): void {
  if (rows.length === 0) {
    stdoutWrite(" credential (no model calls recorded)\n");
    return;
  }
  for (const r of rows) {
    const calls = `(${r.calls} call${r.calls === 1 ? "" : "s"})`;
    const served =
      r.credential_label !== null
        ? `pool credential ${r.credential_label}`
        : `no pool credential (${r.auth_mode ?? "auth not recorded"})`;
    stdoutWrite(` credential ${r.provider ?? "(provider not recorded)"}: ${served} ${calls}\n`);
  }
}

/** T146: which turns changed files and the checkpoint before each; a turn with none is flagged. */
function writeCheckpoints(turns: FileChangingTurn[] | null, note: string | undefined): void {
  if (turns === null) {
    stdoutWrite(" edits      (turns not recorded — transcript predates turn markers)\n");
    return;
  }
  if (turns.length === 0) {
    stdoutWrite(" edits      no turn changed a file\n");
    return;
  }
  const missing = turns.filter((t) => t.checkpoint === undefined).length;
  stdoutWrite(
    ` edits      ${turns.length} turn(s) changed files; ${missing === 0 ? "every one has a checkpoint" : `${missing} MISSING a checkpoint`}\n`,
  );
  if (note !== undefined) stdoutWrite(`            ${note}\n`);
  for (const t of turns) {
    const files = t.paths.length > 0 ? t.paths.join(", ") : "(file not named)";
    const cp =
      t.checkpoint !== undefined
        ? `checkpoint ${shortHash(t.checkpoint.commit)} (lykos rewind ${shortHash(t.checkpoint.commit)})`
        : "MISSING — no checkpoint was taken before this turn";
    stdoutWrite(`   turn ${t.turn}  ${files}  ${cp}\n`);
  }
}

/**
 * T54: the resume contract, printed from `meta.json` rather than recomputed.
 *
 * A field that is absent is printed as absent. That is the whole discipline
 * of this block: a v1 file (every session before T53) has none of these, and
 * a reader that filled in plausible values would make an un-resumable
 * session look resumable.
 */
function writeResumeContract(meta: SessionMeta | null): void {
  if (!meta) {
    stdoutWrite(" meta       no meta.json beside this transcript\n");
    return;
  }
  const missing = "(not recorded)";
  const priced = [meta.priceBasis, meta.priceVersion].filter(Boolean).join(" @ ") || missing;
  const files = meta.head?.contextFiles;
  const tools = meta.tools?.active;
  const exts = meta.tools?.extensions;
  const flags = meta.flags;
  stdoutWrite(` meta       schemaVersion ${meta.schemaVersion}\n`);
  stdoutWrite(` model src  ${meta.modelSource ?? missing}\n`);
  stdoutWrite(` price      ${priced}\n`);
  stdoutWrite(` effort     ${meta.effort ?? missing}   specialist ${meta.specialist ?? missing}\n`);
  stdoutWrite(` head       ${meta.head?.bootFingerprint ?? missing}\n`);
  stdoutWrite(
    ` context    ${files === undefined ? missing : files.length === 0 ? "(none frozen)" : files.map((f) => `${f.name} ${f.bytes}B`).join(", ")}\n`,
  );
  stdoutWrite(` tools      ${tools === undefined ? missing : tools.join(", ")}\n`);
  stdoutWrite(
    ` extensions ${exts === undefined ? missing : exts.length === 0 ? "(none)" : exts.map((e) => (e.version ? `${e.name}@${e.version}` : e.name)).join(", ")}\n`,
  );
  stdoutWrite(
    ` mechanisms ${flags === undefined ? missing : `head=${flags.headContract === true} prompt_diet=${flags.promptDiet === true} output_diet=${flags.outputDiet === true}`}\n`,
  );
  stdoutWrite(
    ` worktree   ${meta.git?.commit ? `${meta.git.commit.slice(0, 12)}${meta.git.dirty ? " (dirty)" : ""}` : missing}\n`,
  );
  stdoutWrite(` contained  ${formatContainment(meta.containment) ?? missing}
`);
  stdoutWrite(
    ` where      ${meta.runtime ?? missing}${meta.executionShape ? `/${meta.executionShape}` : ""}${meta.containment?.runtime !== undefined ? `, commands in ${meta.containment.runtime}` : ""}  image ${meta.sandboxImage === undefined ? missing : (meta.sandboxImage ?? "(none - host)")}\n`,
  );
  if (meta.withheld && meta.withheld.length > 0) {
    stdoutWrite(` withheld   ${meta.withheld.join(", ")}\n`);
  }
}

/** `off`, or `required (used required) podman 5.0.1 lykos/toolchain:abc network=open mount=rw`; undefined when the session recorded none. */
function formatContainment(c: SessionMeta["containment"]): string | undefined {
  if (c === undefined) return undefined;
  const asked = c.requested === c.used ? c.requested : `${c.requested} (ran ${c.used})`;
  if (c.runtime === undefined) return asked;
  return `${asked}  ${c.runtime} ${c.runtimeVersion ?? "?"}  image ${c.image ?? "?"}  network=${c.network ?? "?"} mount=${c.mount ?? "?"}`;
}

function sanitizeControl(str: unknown): string {
  if (typeof str !== "string") return "";
  return str
    .replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?/g, "")
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]?/g, "")
    .replace(/\x1b[^a-zA-Z0-9]?/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

type ShownSealEvent = Pick<SealEventRow, "kind" | "specialist" | "paths" | "detail">;

function sessionSealEvents(ledger: Ledger, sessionId: string): ShownSealEvent[] {
  try {
    return ledger.db
      .prepare(
        "SELECT kind, specialist, paths, detail FROM seal_events WHERE session_id = ? OR session_id IN (SELECT id FROM sessions WHERE parent_session_id = ?) ORDER BY id ASC",
      )
      .all(sessionId, sessionId) as ShownSealEvent[];
  } catch {
    // seal_events may not exist in pre-T195 ledgers
    return [];
  }
}

function writeSealEvents(events: ShownSealEvent[], meta?: SessionMeta | null): void {
  if (events.length === 0) return;
  stdoutWrite(`\nseal events (${events.length}):\n`);
  for (const e of events) {
    if ((e.kind === "dispute filed" || e.kind === "disputed" || e.kind === "dispute upheld" || e.kind === "dispute rejected" || e.kind === "dispute escalated") && e.detail) {
      try {
        const parsed = JSON.parse(e.detail);
        const file = sanitizeControl(parsed.file ?? e.paths);
        const describe = Array.isArray(parsed.describe) ? parsed.describe.map(sanitizeControl).filter(Boolean) : [];
        const name = sanitizeControl(parsed.name ?? "");
        const describePath = describe.length > 0 ? ` > ${describe.join(" > ")}` : "";
        const testName = name ? `${file}${describePath} > ${name}` : sanitizeControl(e.detail ?? e.paths);
        stdoutWrite(`  ${e.kind.padEnd(18)}  ${testName}\n`);
        if (parsed.reason) stdoutWrite(`                      reason: ${sanitizeControl(parsed.reason)}\n`);
        if (parsed.evidence) stdoutWrite(`                      evidence: ${sanitizeControl(parsed.evidence)}\n`);
        if (parsed.ruling) stdoutWrite(`                      ruling: ${sanitizeControl(parsed.ruling)}\n`);
        continue;
      } catch {}
    }
    stdoutWrite(`  ${e.kind.padEnd(12)}  ${sanitizeControl(e.detail ?? e.paths)}\n`);
  }
  const level: string = meta?.containment?.used ?? meta?.containment?.requested ?? "off";
  if (level === "off" || level === "unavailable") {
    stdoutWrite("  warning: guarantee was weaker (the session was not contained; the shell could read the signing key)\n");
  }
}

function oneLine(value: unknown, max = 200): string {
  const json = JSON.stringify(value);
  if (json === undefined) return "undefined";
  return json.length > max ? `${json.slice(0, max)}…` : json;
}

/** The T9.4 spill stub `capOversized()` writes in place of an oversized result. */
function isSpillStub(result: unknown): result is { truncated: true; bytes: number; artifact: string } {
  if (typeof result !== "object" || result === null) return false;
  const r = result as Record<string, unknown>;
  return r.truncated === true && typeof r.bytes === "number" && typeof r.artifact === "string";
}

function formatEventBlock(record: TranscriptEventRecord & TranscriptEventInput): string {
  const head = `[${record.turn_index}] ${record.ts_utc}  ${record.kind}`;
  const lines: string[] = [];
  switch (record.kind) {
    case "tool_call": {
      const repeat = record.repeat_count && record.repeat_count > 1 ? `  x${record.repeat_count}, collapsed` : "";
      const ms = record.ms !== undefined ? `  ms=${record.ms}` : "";
      lines.push(`${head}  ${record.name}  state=${record.state}${ms}${repeat}`);
      if (record.args !== undefined) lines.push(`    args:   ${oneLine(record.args)}`);
      if (record.result !== undefined) {
        lines.push(
          isSpillStub(record.result)
            ? `    result: (spilled ${record.result.bytes} bytes) -> ${record.result.artifact}`
            : `    result: ${oneLine(record.result)}`,
        );
      }
      break;
    }
    case "usage": {
      lines.push(`${head}  hop=${record.hop}  ${record.provider}/${record.model}`);
      lines.push(
        `    input=${record.input}  output=${record.output}  cache_read=${record.cache_read}  cache_write=${record.cache_write}`,
      );
      lines.push(
        `    call_id: ${record.call_id}  (cost is joinable from the ledger's calls table by call_id, not duplicated here)`,
      );
      break;
    }
    case "assistant_message": {
      lines.push(`${head}${record.final ? "  (final)" : ""}`);
      lines.push(`    ${record.text}`);
      break;
    }
    // T53's stream-capture kinds. `lykos show` is the only reader a person
    // has for a transcript, so a kind it cannot render is a kind that was
    // captured for nobody.
    case "user_message":
    case "thinking": {
      lines.push(head);
      lines.push(`    ${record.text}`);
      break;
    }
    case "steer": {
      lines.push(`${head}  mode=${record.mode}`);
      lines.push(`    ${record.text}`);
      break;
    }
    case "tool_result": {
      lines.push(`${head}  ${record.name}  state=${record.state}${record.changes_files ? `  changed ${record.path ?? "a file"}` : ""}`);
      if (record.result !== undefined) {
        lines.push(
          isSpillStub(record.result)
            ? `    result: (spilled ${record.result.bytes} bytes) -> ${record.result.artifact}`
            : `    result: ${oneLine(record.result)}`,
        );
      }
      break;
    }
    case "turn_start": {
      lines.push(`${head}  turn ${record.turn}`);
      break;
    }
    case "prune": {
      // T188: the results above stay in the archive; this is what the model was sent instead.
      const superseded = record.entries.filter((e) => e.notice === "superseded").length;
      lines.push(
        `${head}  superseded=${superseded}  useless=${record.entries.length - superseded}` +
          `${record.tokens_saved !== undefined ? `  est_tokens_saved=${record.tokens_saved}` : ""}` +
          `${record.reason !== undefined ? `  reason=${record.reason}` : ""}`,
      );
      for (const e of record.entries) {
        lines.push(`    ${e.tool_call_id} -> ${PRUNE_NOTICES[e.notice]}`);
      }
      break;
    }
    case "shake": {
      // T193: as a prune, the results above stay in the archive.
      lines.push(`${head}  results=${record.tool_call_ids.length}  est_tokens_saved=${record.tokens_saved}`);
      for (const id of record.tool_call_ids) lines.push(`    ${id} -> ${SHAKE_NOTICE}`);
      break;
    }
    case "compaction": {
      const reason = record.reason ? `  reason=${record.reason}` : "";
      const aborted = record.aborted ? "  aborted" : "";
      lines.push(`${head}  ${record.phase}${reason}${aborted}`);
      break;
    }
    case "answer": {
      lines.push(head);
      lines.push(`    q: ${record.question}`);
      lines.push(`    a: ${record.answer}`);
      break;
    }
    case "resume": {
      lines.push(`${head}  from ${record.from}`);
      lines.push(
        `    replayed ${record.events} event(s), ${record.user_turns} of them the user's;` +
          ` estimated ${record.estimate_tokens} tokens` +
          (record.estimate_usd === null ? " (unpriced)" : ` ≈ $${record.estimate_usd.toFixed(4)}`) +
          (record.price_version ? ` at prices ${record.price_version}` : ""),
      );
      lines.push("    the ACTUAL replay cost is the first calls row on this session — compare, do not assume");
      break;
    }
    case "intervention": {
      lines.push(`${head}  ${record.action}${record.detail ? `  ${record.detail}` : ""}`);
      break;
    }
    case "error": {
      lines.push(head);
      lines.push(`    ${record.message}`);
      break;
    }
    case "outcome": {
      lines.push(
        `${head}  state=${record.state ?? "?"}  turns=${record.turns ?? "?"}  ` +
          `tool_calls=${record.tool_calls ?? "?"}  outcome=${record.outcome ?? "?"}`,
      );
      break;
    }
  }
  return `${lines.join("\n")}\n\n`;
}

export function runShow(ledgerPath: string, sessionId: string, opts?: ShowOptions): number {
  const json = opts?.json ?? false;

  if (!existsSync(ledgerPath)) {
    process.stderr.write(`lykos show: no ledger at ${ledgerPath} — nothing has been recorded yet.\n`);
    return 1;
  }

  const ledger = openLedgerSync(ledgerPath);
  try {
    const row = resolveSessionRow(ledger, sessionId);
    if (!row) return 1;

    // `transcript_path` always names the RAW file — that is what the hash
    // covers — so an archived session resolves to the `.gz` beside it. T55.
    const recorded = row.transcript_path ?? transcriptFilePath(ledgerPath, row.id);
    const resolved = resolveTranscriptFile(recorded);
    if (!resolved) {
      process.stderr.write(`lykos show: transcript file missing for session ${row.id}: ${recorded}\n`);
      return 1;
    }
    const path = resolved.path;

    let verified = false;
    if (row.transcript_sha256) {
      if (!verifyTranscriptHash(path, row.transcript_sha256)) {
        const actual = sha256File(path);
        process.stderr.write(
          `lykos show: TRANSCRIPT HASH MISMATCH for session ${row.id}\n` +
            `  path:     ${path}\n` +
            `  expected: ${row.transcript_sha256}\n` +
            `  actual:   ${actual}\n` +
            "  refusing to replay a transcript that no longer matches its recorded hash — the file may be damaged or tampered with.\n",
        );
        return 1;
      }
      verified = true;
    }

    // readTranscript throws on an unparseable line that is NOT the last one
    // (a mid-file corruption it refuses to guess about). That is a reportable
    // state, the same as a hash mismatch — not a stack trace out of the CLI.
    let read: ReturnType<typeof readTranscript>;
    try {
      read = readTranscript(path);
    } catch (err) {
      process.stderr.write(`lykos show: cannot replay session ${row.id}: ${(err as Error).message}\n`);
      return 1;
    }
    const { events, truncated } = read;
    const flakyTests = ledger.flakyTests(row.id);
    const commits = ledger.commits(row.id);
    const compactions = ledger.compactions(row.id);
    const meta = readSessionMeta(ledgerPath, row.id);
    const checkpoints = sessionCheckpoints(meta, row.id, ledgerPath);
    const credentials = sessionCredentials(ledger, row.id);
    const turns = fileChangingTurns(events, checkpoints.entries);
    const sealEvents = sessionSealEvents(ledger, row.id);

    // T168 part B: the transcript just read, so the edit figures come from it and not from a second read.
    const strength = readStrength(ledger, row.id, transcriptDir(ledgerPath, row.id), ledgerPath, {
      events,
      captureMode: row.capture_mode,
    });

    if (json) {
      const out = {
        session: {
          id: row.id,
          brief: row.brief,
          model: row.model,
          started_utc: row.started_utc,
          ended_utc: row.ended_utc,
          outcome: row.outcome,
          outcome_source: row.outcome_source,
          capture_mode: row.capture_mode,
          verification_cmd: row.verification_cmd,
          verification_exit_code: row.verification_exit_code,
          verification_output: row.verification_output,
        },
        flaky_tests: flakyTests,
        credentials,
        commits,
        compactions,
        seal_events: sealEvents,
        transcript: { path, sha256: row.transcript_sha256, verified, truncated },
        meta,
        file_changing_turns: turns,
        strength,
        events,
      };
      stdoutWrite(`${JSON.stringify(out)}\n`);
      return 0;
    }

    let taskState: string | null = null;
    if (row.task_id) {
      try {
        const task = ledger.db.prepare("SELECT state FROM tasks WHERE id = ?").get(row.task_id) as
          | { state: string }
          | undefined;
        taskState = task?.state ?? null;
      } catch {}
    }

    writeHeader(row, verified, events.length, taskState);
    writeGate(row, flakyTests);
    writeCredentials(credentials);
    writeCommits(commits);
    writeCompactions(compactions);
    writeCheckpoints(turns, checkpoints.note);
    writeStrength(strength);
    writeResumeContract(meta);
    writeSealEvents(sealEvents, meta);
  stdoutWrite(`${"\u2500".repeat(63)}\n`);
    for (const event of events) stdoutWrite(formatEventBlock(event));
    if (truncated) {
      stdoutWrite("⚠ transcript truncated — the last line was partial (process likely killed mid-write).\n");
    }
    return 0;
  } finally {
    ledger.close();
  }
}
