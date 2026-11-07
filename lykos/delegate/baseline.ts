// The baseline of known failures (T249, spec decision 9): the verification command run once on the base commit, so a
// session and its reviewers can tell a failure the task caused from one the base already had.
//
// A baseline is keyed by the base commit, the verification command, the hash of the base's lockfiles and the
// platform. A second session on the same key reuses the recorded run; a changed lockfile, command or platform is a
// different key and so a new run. Nothing here guesses: a run that did not happen (the command could not start, it
// timed out, there is no base commit) is recorded as `unmeasured` with its reason, never as an empty failure list,
// and an unmeasured baseline is run again by the next session rather than reused.
//
// The command runs in a temporary worktree of the base, never in the session's tree.

import { createHash } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { hostGit } from "../git/host-git.js";
import { createTemporaryWorktree } from "../seal/git.js";
import { failureSignature, parseCargoTestOutput } from "../seal/failing-names.js";
import { detectAdapter, REPORTER_CJS } from "../seal/runner.js";
import { localExecutor, type ProjectExecutor } from "../tools/executor.js";
import { withLedger, withLedgerSync, type Ledger } from "../ledger/use.js";

/** The lockfiles whose content decides the dependencies a verification run saw. */
const LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
]);

/** What the lockfile hash says when the base has no lockfile: a fact about the base, not a missing value. */
export const NO_LOCKFILE = "none";

/** A standalone `--test` flag of node (or tsx): not `--test-name-pattern` and the like. */
const NODE_TEST_FLAG = /(^|\s)--test(?=\s|$)/;

export const DEFAULT_BASELINE_TIMEOUT_MS = 15 * 60_000;

export interface BaselineKey {
  base: string;
  command: string;
  lockfileHash: string;
  platform: string;
}

/** `names`: the failing tests, by name. `exit-only`: the runner reports no tests, so only the exit code and a hash of its normalised output identify the failure. */
export type BaselineKind = "names" | "exit-only";

export interface MeasuredBaseline {
  status: "measured";
  id: number;
  key: BaselineKey;
  adapter: string;
  kind: BaselineKind;
  exit_code: number;
  /** The tests that failed, as `file > describe > name`. Empty with `kind: "names"` means a run that failed none. */
  failing: string[];
  /** `names` only: how many tests ran. */
  tests_total?: number;
  /** `exit-only` and exit non-zero: the failure's signature. */
  signature?: string;
  duration_ms: number;
  recorded_at: string;
}

export interface UnmeasuredBaseline {
  status: "unmeasured";
  id: number;
  key: BaselineKey;
  reason: string;
  recorded_at: string;
}

export type Baseline = MeasuredBaseline | UnmeasuredBaseline;

export interface BaselineResult {
  baseline: Baseline;
  /** True when an earlier session's run on this key was used and the command was not run again. */
  reused: boolean;
}

/** Hash of every lockfile in the base commit, by path and content; `none` when it has none. */
export function lockfileHashAt(repo: string, base: string): string {
  const tree = hostGit(["ls-tree", "-r", "--name-only", base], repo, { maxBuffer: 64 * 1024 * 1024 });
  const paths = (tree.ok ? tree.stdout.split("\n") : []).map((l) => l.trim()).filter((l) => l !== "" && LOCKFILES.has(basename(l))).sort();
  if (paths.length === 0) return NO_LOCKFILE;
  const hash = createHash("sha256");
  for (const p of paths) {
    const blob = hostGit(["show", `${base}:${p}`], repo, { raw: true, maxBuffer: 256 * 1024 * 1024 });
    hash.update(`${p}\0`).update(blob.ok ? blob.stdout : `unreadable:${blob.stderr}`).update("\0");
  }
  return hash.digest("hex");
}

/** The key a run of `command` on `base` has: undefined when `base` names no commit. `platform` defaults to this machine's. */
export function baselineKey(repo: string, base: string, command: string, platform: string = process.platform): BaselineKey | undefined {
  const resolved = hostGit(["rev-parse", "--verify", `${base}^{commit}`], repo);
  if (!resolved.ok) return undefined;
  return { base: resolved.stdout, command, lockfileHash: lockfileHashAt(repo, resolved.stdout), platform };
}

interface NodeTestEvent {
  type?: string;
  data?: { name?: string; file?: string; nesting?: number; details?: { type?: string } };
}

/** node:test's reporter events to the tests that failed, and how many ran. Suites and the file's own entry are not tests. */
export function parseNodeTestFailures(stdout: string, dir: string): { failing: string[]; total: number } | undefined {
  const stack: string[] = [];
  const failing: string[] = [];
  let total = 0;
  let sawEvent = false;
  const norm = (p: string): string => p.replace(/\\/g, "/");
  const rel = (file: string | undefined): string => {
    if (file === undefined || file === "") return "";
    const f = norm(file);
    const d = norm(dir).replace(/\/+$/, "");
    return f.startsWith(`${d}/`) ? f.slice(d.length + 1) : f;
  };
  for (const line of stdout.split("\n")) {
    let event: NodeTestEvent;
    try {
      event = JSON.parse(line) as NodeTestEvent;
    } catch {
      continue;
    }
    const data = event.data;
    if (data === undefined || typeof event.type !== "string" || !event.type.startsWith("test:")) continue;
    sawEvent = true;
    if (event.type === "test:start" && typeof data.nesting === "number") {
      stack.length = data.nesting;
      stack.push(data.name ?? "");
      continue;
    }
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    if (data.details?.type === "suite") continue;
    const name = data.name ?? "";
    const file = rel(data.file);
    const fileEntry = (data.nesting ?? 0) === 0 && file !== "" && (file === name || file.endsWith(`/${name}`));
    if (name === "" || fileEntry) continue;
    total += 1;
    if (event.type === "test:fail") {
      const path = typeof data.nesting === "number" && stack.length > data.nesting ? stack.slice(0, data.nesting + 1) : [name];
      failing.push([file, ...path].filter((s) => s !== "").join(" > "));
    }
  }
  return sawEvent ? { failing, total } : undefined;
}

export interface RunBaselineInput {
  repo: string;
  key: BaselineKey;
  executor?: ProjectExecutor;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

type Measured = Omit<MeasuredBaseline, "id" | "key" | "recorded_at">;
type Measurement = Measured | { status: "unmeasured"; reason: string };

/** Runs the command once in a temporary worktree of the base. Never throws: what could not be measured says why. */
export async function measureBaseline(input: RunBaselineInput): Promise<Measurement> {
  const { key } = input;
  const executor = input.executor ?? localExecutor;
  const env: NodeJS.ProcessEnv = { ...(input.env ?? process.env) };
  delete env["NODE_TEST_CONTEXT"];
  delete env["VITEST"];
  let worktree: ReturnType<typeof createTemporaryWorktree>;
  try {
    worktree = createTemporaryWorktree(input.repo, key.base, env);
  } catch (err) {
    return { status: "unmeasured", reason: `could not check out the base commit: ${err instanceof Error ? err.message : String(err)}` };
  }
  const adapter = detectAdapter(key.command);
  const reporterRel = `.lykos-baseline-reporter-${process.pid}-${Date.now()}.cjs`;
  const reporterPath = join(worktree.dir, reporterRel);
  const started = Date.now();
  try {
    let command = key.command;
    // node: options after the test files are taken for more files, so the reporter goes right after `--test`.
    const reporting = adapter === "node:test" && NODE_TEST_FLAG.test(key.command);
    if (reporting) {
      writeFileSync(reporterPath, REPORTER_CJS, "utf8");
      command = key.command.replace(NODE_TEST_FLAG, `$1--test --test-reporter="./${reporterRel}" --test-reporter-destination=stdout`);
    }
    let stdout = "";
    let stderr = "";
    let merged = "";
    const child = executor.spawn(command, [], { cwd: worktree.dir, shell: true, env, containerPaths: true });
    child.stdout?.on("data", (c: Buffer | string) => {
      stdout += c.toString();
      merged += c.toString();
    });
    child.stderr?.on("data", (c: Buffer | string) => {
      stderr += c.toString();
      merged += c.toString();
    });
    const timeoutMs = input.timeoutMs ?? DEFAULT_BASELINE_TIMEOUT_MS;
    let timedOut = false;
    // On a timeout the run is over for the baseline's purposes: the command is killed and not waited for, since a
    // grandchild that holds the pipes open would keep `close` from ever firing.
    const exit = await new Promise<number | null | Error>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
        resolve(null);
      }, timeoutMs);
      child.once("error", (e) => {
        clearTimeout(timer);
        resolve(e);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    if (timedOut) return { status: "unmeasured", reason: `the verification command did not finish in ${Math.round(timeoutMs / 1000)}s` };
    if (exit instanceof Error) return { status: "unmeasured", reason: `the verification command could not start: ${exit.message}` };
    if (exit === null) return { status: "unmeasured", reason: "the verification command was killed by a signal" };
    if (exit === 126 || exit === 127) return { status: "unmeasured", reason: `the verification command could not run (exit ${exit})` };
    const duration_ms = Date.now() - started;

    if (adapter === "cargo") {
      const tests = parseCargoTestOutput(merged);
      if (tests.length > 0) {
        const failing = tests.filter((t) => t.status === "assertion" || t.status === "error").map((t) => [t.file, ...t.describe, t.name].filter((s) => s !== "").join(" > "));
        return { status: "measured", adapter, kind: "names", exit_code: exit, failing, tests_total: tests.length, duration_ms };
      }
    }
    if (reporting) {
      const parsed = parseNodeTestFailures(stdout, worktree.dir);
      if (parsed !== undefined) {
        return { status: "measured", adapter, kind: "names", exit_code: exit, failing: parsed.failing, tests_total: parsed.total, duration_ms };
      }
    }
    // No per-test results: a failing command is identified by its exit code and the hash of its normalised output.
    const signature = exit === 0 ? undefined : failureSignature(exit, `${stdout}\n${stderr}`, [worktree.dir]).hash;
    return { status: "measured", adapter, kind: "exit-only", exit_code: exit, failing: [], ...(signature !== undefined ? { signature } : {}), duration_ms };
  } finally {
    try {
      unlinkSync(reporterPath);
    } catch {
      // not written, or already gone
    }
    worktree.cleanup();
  }
}

interface BaselineRow {
  id: number;
  base_commit: string;
  command: string;
  lockfile_hash: string;
  platform: string;
  status: string;
  adapter: string | null;
  kind: string | null;
  exit_code: number | null;
  failing_json: string | null;
  tests_total: number | null;
  signature: string | null;
  unmeasured_reason: string | null;
  duration_ms: number | null;
  recorded_at: string;
}

function toBaseline(row: BaselineRow): Baseline {
  const key: BaselineKey = { base: row.base_commit, command: row.command, lockfileHash: row.lockfile_hash, platform: row.platform };
  if (row.status !== "measured") return { status: "unmeasured", id: row.id, key, reason: row.unmeasured_reason ?? "unknown", recorded_at: row.recorded_at };
  return {
    status: "measured",
    id: row.id,
    key,
    adapter: row.adapter ?? "exit",
    kind: row.kind === "names" ? "names" : "exit-only",
    exit_code: row.exit_code ?? -1,
    failing: row.failing_json === null ? [] : (JSON.parse(row.failing_json) as string[]),
    ...(row.tests_total !== null ? { tests_total: row.tests_total } : {}),
    ...(row.signature !== null ? { signature: row.signature } : {}),
    duration_ms: row.duration_ms ?? 0,
    recorded_at: row.recorded_at,
  };
}

const SELECT_BY_KEY = `SELECT * FROM baselines WHERE base_commit = ? AND command = ? AND lockfile_hash = ? AND platform = ?`;

/** The measured baseline recorded for this key, or undefined. An unmeasured one is not reused. */
export function findBaseline(ledger: Ledger, key: BaselineKey): MeasuredBaseline | undefined {
  const row = ledger.db.prepare(SELECT_BY_KEY).get(key.base, key.command, key.lockfileHash, key.platform) as BaselineRow | undefined;
  const found = row === undefined ? undefined : toBaseline(row);
  return found?.status === "measured" ? found : undefined;
}

/**
 * Records a measurement under its key. If another session recorded a measured baseline for the key while this one
 * ran, that one stays (the first measurement is the baseline) and is returned.
 */
function recordBaseline(ledger: Ledger, key: BaselineKey, measured: Measurement): BaselineResult {
  const write = ledger.db.transaction((): BaselineResult => {
    const existing = findBaseline(ledger, key);
    if (existing !== undefined) return { baseline: existing, reused: true };
    const m = measured.status === "measured" ? measured : undefined;
    ledger.db
      .prepare(
        `INSERT INTO baselines (base_commit, command, lockfile_hash, platform, status, adapter, kind, exit_code, failing_json, tests_total, signature, unmeasured_reason, duration_ms, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (base_commit, command, lockfile_hash, platform) DO UPDATE SET
           status = excluded.status, adapter = excluded.adapter, kind = excluded.kind, exit_code = excluded.exit_code,
           failing_json = excluded.failing_json, tests_total = excluded.tests_total, signature = excluded.signature,
           unmeasured_reason = excluded.unmeasured_reason, duration_ms = excluded.duration_ms, recorded_at = excluded.recorded_at`,
      )
      .run(
        key.base,
        key.command,
        key.lockfileHash,
        key.platform,
        measured.status,
        m?.adapter ?? null,
        m?.kind ?? null,
        m?.exit_code ?? null,
        m === undefined ? null : JSON.stringify(m.failing),
        m?.tests_total ?? null,
        m?.signature ?? null,
        measured.status === "unmeasured" ? measured.reason : null,
        m?.duration_ms ?? null,
        new Date().toISOString(),
      );
    const row = ledger.db.prepare(SELECT_BY_KEY).get(key.base, key.command, key.lockfileHash, key.platform) as BaselineRow;
    return { baseline: toBaseline(row), reused: false };
  });
  return write.immediate();
}

/**
 * The baseline for a session: the recorded one when this key has a measured one, else the command is run on the base
 * and recorded. The ledger is not held open while the command runs.
 */
export async function ensureBaseline(ledgerPath: string, input: RunBaselineInput): Promise<BaselineResult> {
  const known = await withLedger(ledgerPath, async (ledger) => findBaseline(ledger, input.key));
  if (known !== undefined) return { baseline: known, reused: true };
  const measured = await measureBaseline(input);
  return withLedger(ledgerPath, async (ledger) => recordBaseline(ledger, input.key, measured));
}

/** Ties a session to the baseline it was given, and says whether it was reused. */
export function recordSessionBaseline(ledger: Ledger, sessionId: string, result: BaselineResult): void {
  ledger.db
    .prepare(`INSERT OR REPLACE INTO session_baselines (session_id, baseline_id, reused, recorded_at) VALUES (?, ?, ?, ?)`)
    .run(sessionId, result.baseline.id, result.reused ? 1 : 0, new Date().toISOString());
}

/** What the ledger holds of a session's baseline, or undefined when it had none. */
export function sessionBaseline(ledger: Ledger, sessionId: string): BaselineResult | undefined {
  const link = ledger.db.prepare(`SELECT baseline_id, reused FROM session_baselines WHERE session_id = ?`).get(sessionId) as { baseline_id: number; reused: number } | undefined;
  if (link === undefined) return undefined;
  const row = ledger.db.prepare(`SELECT * FROM baselines WHERE id = ?`).get(link.baseline_id) as BaselineRow | undefined;
  return row === undefined ? undefined : { baseline: toBaseline(row), reused: link.reused === 1 };
}

/** The baseline as `lykos status` shows it, flat and with the key spelled out. */
export interface BaselineSummary {
  status: "measured" | "unmeasured";
  reused: boolean;
  base: string;
  command: string;
  lockfile_hash: string;
  platform: string;
  recorded_at: string;
  kind?: BaselineKind;
  exit_code?: number;
  failing?: string[];
  tests_total?: number;
  reason?: string;
}

export function baselineSummary(ledger: Ledger, sessionId: string): BaselineSummary | undefined {
  const found = sessionBaseline(ledger, sessionId);
  if (found === undefined) return undefined;
  const b = found.baseline;
  const common = { reused: found.reused, base: b.key.base, command: b.key.command, lockfile_hash: b.key.lockfileHash, platform: b.key.platform, recorded_at: b.recorded_at };
  if (b.status === "unmeasured") return { status: "unmeasured", ...common, reason: b.reason };
  return {
    status: "measured",
    ...common,
    kind: b.kind,
    exit_code: b.exit_code,
    failing: b.failing,
    ...(b.tests_total !== undefined ? { tests_total: b.tests_total } : {}),
  };
}

/** Ties a session to its baseline for a caller that holds no ledger handle. */
export function recordSessionBaselineAt(ledgerPath: string, sessionId: string, result: BaselineResult): void {
  withLedgerSync(ledgerPath, (ledger) => recordSessionBaseline(ledger, sessionId, result));
}
