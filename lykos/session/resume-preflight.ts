// The resume preflight.
//
// **A pure function that performs nothing.** It takes a session id and a
// workspace and returns a list of verdicts. It creates no session, spends no
// tokens, writes no ledger row and moves no file. That is what makes it
// testable without ever performing a resume, and it is why it exists before
// `lykos resume` does rather than inside it.
//
// It is also the *only* implementation of "is this safe, and what will it
// cost". `lykos resume` (T57), the session picker (T58) and, later, Phase 5's
// supervisor all display this same list. A second opinion about resume safety
// living somewhere else is the failure this shape is designed to prevent.
//
// Every hazard in `08` §5, plus two this phase added (capture mode, and the
// sandbox image). The verdicts are ordered by severity, not by check order,
// because what a caller needs first is the worst thing found.
//
// **`avoided` is deliberately not claimed here.** A refused resume averts
// spend and it is tempting to record it — but the counterfactual is
// unknowable: nobody knows whether the person would have gone through with
// it. So no `avoided` row is written, `avoided_basis` gains no new value, and
// T62 counts refusals as a plain count instead.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalToolName } from "../tools/tool-surface.js";
import type { Ledger } from "../ledger/ledger.js";
import { priceCall, type PriceCallResult } from "../ledger/prices.js";
import { estimateTokensChars4 } from "../ledger/tool-schema.js";
import { currentGitCommit } from "./identity.js";
import { buildReplay, type ReplayBundle, type TranscriptRecord } from "./replay.js";
import {
  readSessionMeta,
  readTranscript,
  resolveTranscriptFile,
  transcriptFilePath,
  verifyTranscriptHash,
  type SessionMeta,
} from "./transcript.js";

/**
 * Four verdicts, and the difference between the middle two matters:
 * `warn` is information the person should have; `confirm` is something they
 * must actively agree to before anything happens. Money and a moved working
 * tree are `confirm`; a price-table bump is `warn`.
 */
export type ResumeVerdict = "proceed" | "warn" | "confirm" | "refuse";

export interface ResumeCheck {
  /** Stable identifier, so a UI can order or filter without parsing prose. */
  id:
    | "session"
    | "resumable"
    | "capture_mode"
    | "transcript_integrity"
    | "working_tree"
    | "rebuild_cost"
    | "price_drift"
    | "model_availability"
    | "tool_surface";
  verdict: ResumeVerdict;
  message: string;
}

export interface RebuildCost {
  tokens: number;
  /** NULL when the model is not in the price table — tokens recorded, dollars never invented. */
  usd: number | null;
  provider: string;
  model: string;
  /** `peak` / `off_peak` for DeepSeek, null for a provider without windows. */
  rateWindow: PriceCallResult["rateWindow"] | null;
  /** True when the provider charges a premium for a cache write, so the replay is priced at the write rate. */
  writeIsPremium: boolean;
  priceVersion: string | null;
}

export interface ResumePreflight {
  sessionId: string;
  checks: ResumeCheck[];
  /** The worst verdict found. `refuse` means T57 stops here. */
  overall: ResumeVerdict;
  /** Present whenever the transcript could be read at all. */
  replay?: ReplayBundle;
  cost?: RebuildCost;
  /** The row and meta the checks were computed from, so a caller need not re-read them. */
  meta?: SessionMeta | null;
}

export interface PreflightInput {
  ledger: Ledger;
  sessionId: string;
  /** The project directory the resume would run in. */
  workspace: string;
  /**
   * Whether a model is still resolvable. Injected rather than imported: the
   * registry lives behind `ModelRuntime.create()`, which is async and would
   * make this function impure. Omitted, the check reports that it was not
   * performed — which is honest, and never "available".
   */
  modelAvailable?: (spec: string) => boolean;
  /** `--force`: proceed past a refusal that names a file the session edited which no longer exists. */
  allowMissingFiles?: boolean;
  /** Priced at this instant, because DeepSeek's peak window doubles the base rate. */
  now?: Date;
}

interface SessionRow {
  id: string;
  model: string | null;
  capture_mode: string | null;
  resumable: number | null;
  not_resumable_reason: string | null;
  git_commit: string | null;
  git_dirty: number | null;
  transcript_path: string | null;
  transcript_sha256: string | null;
  ended_utc: string | null;
  execution_shape: string | null;
  parent_session_id: string | null;
  runtime: string | null;
}

const SEVERITY: Record<ResumeVerdict, number> = { proceed: 0, warn: 1, confirm: 2, refuse: 3 };

function worst(checks: readonly ResumeCheck[]): ResumeVerdict {
  return checks.reduce<ResumeVerdict>((acc, c) => (SEVERITY[c.verdict] > SEVERITY[acc] ? c.verdict : acc), "proceed");
}

/** `provider/model`, tolerating a bare model id the same way the ledger's own rows do. */
function splitModel(spec: string | null): { provider: string; model: string } | null {
  if (!spec) return null;
  const idx = spec.indexOf("/");
  if (idx <= 0 || idx === spec.length - 1) return null;
  return { provider: spec.slice(0, idx), model: spec.slice(idx + 1) };
}

/**
 * Prices a replay of `tokens` tokens **with the cache-write premium on the
 * correct side of the provider asymmetry**, which the task names as the
 * single most likely error here.
 *
 * The asymmetry, from `prices.yaml` and CLAUDE.md: Anthropic charges a
 * premium for a cache write (1.25× at 5m, 2× at 1h); DeepSeek charges none —
 * a miss is simply normal input price — and its peak window doubles the base
 * rate on top of that. So the replay is priced at the *write* rate where
 * writing is a premium and at the *input* rate where it is not. The branch is
 * taken on `write_is_premium`, read from the price table, never on the
 * provider's name.
 */
export function priceReplay(provider: string, model: string, tokens: number, ts: Date): RebuildCost {
  const base: RebuildCost = {
    tokens,
    usd: null,
    provider,
    model,
    rateWindow: null,
    writeIsPremium: false,
    priceVersion: null,
  };
  let probe: PriceCallResult;
  try {
    probe = priceCall({ provider, model, tokens: { input: 0, output: 0 }, ts });
  } catch {
    // Unknown provider or model: tokens recorded, dollars NULL. Never an
    // invented number — the same rule `price_basis = 'unpriced'` follows.
    return base;
  }
  const writeIsPremium = probe.rates.writeIsPremium;
  const priced = priceCall({
    provider,
    model,
    tokens: writeIsPremium
      ? { input: 0, output: 0, cacheWrite: tokens }
      : { input: tokens, output: 0 },
    ts,
  });
  return {
    tokens,
    usd: priced.costUsd,
    provider,
    model,
    rateWindow: priced.rateWindow,
    writeIsPremium,
    priceVersion: priced.priceVersion,
  };
}

function fmtUsd(n: number): string {
  return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * Every hazard, computed. Performs nothing.
 */
export function preflightResume(input: PreflightInput): ResumePreflight {
  const { ledger, sessionId, workspace } = input;
  const now = input.now ?? new Date();
  const checks: ResumeCheck[] = [];

  const row = ledger.db
    .prepare(
      `SELECT id, model, capture_mode, resumable, not_resumable_reason, git_commit, git_dirty,
              transcript_path, transcript_sha256, ended_utc, execution_shape, parent_session_id, runtime
         FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as SessionRow | undefined;
  if (!row) {
    return {
      sessionId,
      checks: [{ id: "session", verdict: "refuse", message: `no session "${sessionId}" in this ledger` }],
      overall: "refuse",
    };
  }

  const meta = readSessionMeta(ledger.path, row.id);
  // T60: a Lykos-spawned child. Both signals are recorded at ingest and
  // either alone is enough — `execution_shape` is the label, and a parent
  // pointer is the structural fact behind it.
  const isChildSession = row.execution_shape === "subagent" || row.parent_session_id !== null;
  // `sessions.model` holds a BARE model id (ingest writes `fallback.model`);
  // T54's meta records the full `provider/model`. Prefer the meta so the cost
  // estimate and the availability check are talking about the same thing —
  // two checks disagreeing about which model this was is worse than one of
  // them being unable to answer.
  const modelSpec = meta?.model ?? row.model ?? null;

  // --- Resumability -------------------------------------------------------
  // T39.3 already decided this per execution shape; the reason is printed
  // verbatim rather than paraphrased, because it is the only explanation the
  // person gets.
  if (row.resumable === 0) {
    checks.push({
      id: "resumable",
      verdict: "refuse",
      message: row.not_resumable_reason ?? "this session is recorded as not resumable, with no reason given",
    });
  } else {
    checks.push({ id: "resumable", verdict: "proceed", message: "session is marked resumable" });
  }

  // --- Capture mode -------------------------------------------------------
  // The distinction T53 exists for. A `snapshot` transcript has no user
  // message in it anywhere, so replaying it would rebuild the agent's tool
  // calls and its last sentence and call that a conversation. Refused as a
  // conversation — and offered as a BRIEF for a fresh session, which is a
  // different and honest thing.
  if (row.capture_mode === "stream") {
    checks.push({ id: "capture_mode", verdict: "proceed", message: "captured live (capture_mode=stream)" });
  } else if (row.capture_mode === "snapshot") {
    checks.push({
      id: "capture_mode",
      verdict: "refuse",
      message:
        "this session was captured from a terminal snapshot, which contains no user messages — it cannot be resumed " +
        "as a conversation. Use it as a brief for a new session instead: `lykos show " +
        `${row.id}\`.`,
    });
  } else {
    checks.push({
      id: "capture_mode",
      verdict: "refuse",
      message:
        "this session predates capture_mode and its transcript is the snapshot subset — not backfilled, and not " +
        "resumable as a conversation. Use it as a brief for a new session instead.",
    });
  }

  // --- Transcript integrity ----------------------------------------------
  const rawPath = row.transcript_path ?? transcriptFilePath(ledger.path, row.id);
  const resolved = resolveTranscriptFile(rawPath);
  let records: TranscriptRecord[] = [];
  if (!resolved) {
    checks.push({ id: "transcript_integrity", verdict: "refuse", message: `transcript file missing: ${rawPath}` });
  } else if (row.transcript_sha256 && !verifyTranscriptHash(resolved.path, row.transcript_sha256)) {
    checks.push({
      id: "transcript_integrity",
      verdict: "refuse",
      message: `transcript no longer matches its recorded hash (${resolved.path}) — damaged or tampered with`,
    });
  } else {
    let read: ReturnType<typeof readTranscript> | undefined;
    try {
      read = readTranscript(resolved.path);
    } catch (err) {
      checks.push({ id: "transcript_integrity", verdict: "refuse", message: (err as Error).message });
    }
    if (read) {
      records = read.events as TranscriptRecord[];
      if (!row.transcript_sha256) {
        // T53's honest NULL: the process died before finalize(). Never
        // silently treated as fine, and never called damage either.
        checks.push({
          id: "transcript_integrity",
          verdict: "warn",
          message: "no recorded hash — this session ended without finalizing (a crash), so integrity is unverified",
        });
      } else if (read.truncated) {
        checks.push({
          id: "transcript_integrity",
          verdict: "warn",
          message: `last line is partial (killed mid-write) at turn index ${records.length}; it will not be replayed`,
        });
      } else {
        checks.push({ id: "transcript_integrity", verdict: "proceed", message: "transcript hash-verified" });
      }
    }
  }

  // --- Working tree -------------------------------------------------------
  const head = currentGitCommit(workspace);
  if (!row.git_commit || !head) {
    checks.push({
      id: "working_tree",
      verdict: "warn",
      message: !row.git_commit
        ? "the original session recorded no git commit — whether the working tree moved cannot be checked"
        : "this workspace is not a git repository — whether the working tree moved cannot be checked",
    });
  } else if (row.git_commit === head) {
    checks.push({ id: "working_tree", verdict: "proceed", message: `working tree is at the session's commit ${head.slice(0, 12)}` });
  } else {
    checks.push({
      id: "working_tree",
      verdict: "confirm",
      message:
        `the working tree has moved since this session ran: ${row.git_commit.slice(0, 12)} → ${head.slice(0, 12)}. ` +
        "The replayed conversation describes files as they were then.",
    });
  }
  // A file the session was editing that no longer exists is worse than a
  // moved HEAD: the conversation refers to something that is not there.
  const missing = missingEditedFiles(workspace, records, row.runtime);
  if (missing.length > 0) {
    checks.push({
      id: "working_tree",
      verdict: input.allowMissingFiles ? "warn" : "refuse",
      message:
        `${missing.length} file(s) this session edited no longer exist: ${missing.slice(0, 5).join(", ")}` +
        (input.allowMissingFiles ? " (overridden)" : " — pass --force to resume anyway"),
    });
  }

  // --- Rebuild cost -------------------------------------------------------
  let replay: ReplayBundle | undefined;
  let cost: RebuildCost | undefined;
  if (records.length > 0) {
    replay = buildReplay(row.id, records);
    const ref = splitModel(modelSpec);
    const tokens = estimateTokensChars4(replay.text);
    if (ref) {
      cost = priceReplay(ref.provider, ref.model, tokens, now);
      checks.push({
        id: "rebuild_cost",
        verdict: "confirm",
        message:
          cost.usd === null
            ? `resuming replays ${fmtTokens(tokens)} tokens; ${ref.provider}/${ref.model} is not in the price table, so the cost is unpriced`
            : `resuming replays ${fmtTokens(tokens)} tokens ≈ ${fmtUsd(cost.usd)}` +
              (cost.rateWindow ? ` (${cost.rateWindow} rate)` : "") +
              (cost.writeIsPremium ? " — priced at the cache-write rate, which this provider charges a premium for" : ""),
      });
    } else {
      checks.push({
        id: "rebuild_cost",
        verdict: "warn",
        message: `resuming replays ${fmtTokens(tokens)} tokens; no provider/model recorded, so it cannot be priced`,
      });
    }
  }

  // --- Price drift --------------------------------------------------------
  // Never a recost. The original's rows keep the version that priced them,
  // forever (`08` §5).
  if (meta?.priceVersion && cost?.priceVersion && meta.priceVersion !== cost.priceVersion) {
    checks.push({
      id: "price_drift",
      verdict: "warn",
      message:
        `prices have moved since this session ran (${meta.priceVersion} → ${cost.priceVersion}). ` +
        "The original session's rows keep their own version; nothing is recosted.",
    });
  } else if (meta?.priceBasis && meta.priceBasis === "unpriced") {
    checks.push({
      id: "price_drift",
      verdict: "warn",
      message: "the original session ran unpriced, so its cost and this estimate are not comparable",
    });
  }

  // --- Model availability -------------------------------------------------
  if (!modelSpec) {
    checks.push({ id: "model_availability", verdict: "warn", message: "no model recorded for this session" });
  } else if (!input.modelAvailable) {
    checks.push({
      id: "model_availability",
      verdict: "warn",
      message: `model availability not checked (${modelSpec})`,
    });
  } else if (input.modelAvailable(modelSpec)) {
    checks.push({ id: "model_availability", verdict: "proceed", message: `model ${modelSpec} is available` });
  } else {
    checks.push({
      id: "model_availability",
      verdict: "refuse",
      message:
        `model ${modelSpec} is no longer in the registry. Name a substitute explicitly with --model; ` +
        "it will be recorded as model_source=caller_override, never substituted silently.",
    });
  }

  // --- Tool surface -------------------------------------------------------
  //
  // T60 (docs/19-phase4-tasks.md). A conversation full of `Agent` calls
  // resumed without them fails in a confusing way, and a CHILD's resume
  // that regained `Agent` would let a subagent spawn subagents — which
  // `resolveStandaloneTools()` forbids at boot and a resume must not undo.
  const recordedTools = meta?.tools?.active;
  if (!recordedTools || recordedTools.length === 0) {
    checks.push({
      id: "tool_surface",
      verdict: "warn",
      message:
        "no tool surface recorded (the session predates meta.json v2) — the resume boots the default surface, " +
        "which may not be the one this conversation used",
    });
  } else if (isChildSession && recordedTools.some((name) => canonicalToolName(name) === "agent")) {
    // Recorded state contradicting an invariant is worth saying out loud
    // rather than silently repairing: `resume.ts` strips it either way.
    checks.push({
      id: "tool_surface",
      verdict: "warn",
      message: "this subagent session records the Agent tool, which children never receive — it will be dropped on resume",
    });
  } else {
    checks.push({
      id: "tool_surface",
      verdict: "proceed",
      message: `${recordedTools.length} tools inherited: ${recordedTools.join(", ")}`,
    });
  }

  // No sandbox-image check. T54 compared meta.sandboxImage with the pinned
  // delegate image, which #38 retired. Resume chooses no image, so no caller
  // had a current one to pass and the check never ran (#47).
  // meta.sandboxImage is still recorded and shown by `lykos show`.

  checks.sort((a, b) => SEVERITY[b.verdict] - SEVERITY[a.verdict]);
  return {
    sessionId: row.id,
    checks,
    overall: worst(checks),
    ...(replay !== undefined ? { replay } : {}),
    ...(cost !== undefined ? { cost } : {}),
    meta,
  };
}

/**
 * Files the session wrote or edited that are not on disk any more.
 *
 * Read from the transcript's own tool calls rather than from git, because
 * what matters is what THIS conversation refers to. A path argument is taken
 * only from the tools Lykos gates (`write`, `edit`) — a `read` of a file that
 * has since been deleted is not a hazard, it is just history.
 */
/** The retired delegate container's bind-mount, where it mounted the host workspace. */
const CONTAINER_WORK = "/work";

/**
 * Where a transcript path is on the host. A container session records `/work/...`
 * (D8). On Windows that string is absolute, `existsSync` looks for it on the
 * host, and every file the session edited is reported missing. `runtime` is
 * the column that says which machine the path belongs to.
 *
 * A container path outside `/work` is not a host file. Returning undefined
 * leaves it out of the missing list rather than refusing a resume for a path
 * the host was never going to have.
 */
function hostPathForEditedFile(workspace: string, path: string, runtime: string | null): string | undefined {
  if (runtime === "container") {
    if (path === CONTAINER_WORK) return workspace;
    if (path.startsWith(`${CONTAINER_WORK}/`)) return join(workspace, path.slice(CONTAINER_WORK.length + 1));
    if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return undefined;
  }
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return path;
  return join(workspace, path);
}

function missingEditedFiles(
  workspace: string,
  records: readonly TranscriptRecord[],
  runtime: string | null,
): string[] {
  const seen = new Set<string>();
  for (const record of records) {
    if (record.kind !== "tool_call") continue;
    const name = record.name.toLowerCase();
    if (name !== "write" && name !== "edit") continue;
    const args = record.args as { path?: unknown; file_path?: unknown } | undefined;
    const path = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : undefined;
    if (!path) continue;
    seen.add(path);
  }
  const missing: string[] = [];
  for (const path of seen) {
    const abs = hostPathForEditedFile(workspace, path, runtime);
    if (abs !== undefined && !existsSync(abs)) missing.push(path);
  }
  return missing.sort();
}

/** One line per check, worst first — what `lykos resume` prints and T58's picker shows. */
export function formatPreflight(pre: ResumePreflight): string {
  const glyph: Record<ResumeVerdict, string> = { proceed: "✓", warn: "⚠", confirm: "?", refuse: "✗" };
  return pre.checks.map((c) => `  ${glyph[c.verdict]} ${c.id.padEnd(20)} ${c.message}`).join("\n");
}
