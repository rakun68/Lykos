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
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { hostGit } from "../git/host-git.js";
import { createTemporaryWorktree } from "../seal/git.js";
import { failureSignature, parseCargoTestOutput } from "../seal/failing-names.js";
import { detectAdapter, parseNodeTestStream, REPORTER_CJS } from "../seal/runner.js";
import { resolveHostBash, noBashMessage } from "../process/host-bash.js";
import { localExecutor, type ProjectExecutor } from "../tools/executor.js";
import { TREE_KILL_SPAWN_OPTIONS, killExecChild } from "../tools/job-runner.js";
import { withLedger, type Ledger } from "../ledger/use.js";

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

/**
 * The files an install leaves in `node_modules` that say which packages it holds. The run uses the main checkout's
 * `node_modules` through a junction, so a changed install changes what the baseline measured.
 */
const INSTALL_STATE_FILES = [".package-lock.json", ".yarn-state.yml", ".modules.yaml"];

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
  /** Absent when the ledger row holds none: it is never made up. */
  exit_code?: number;
  /** The tests that failed, as `file > describe > name`. Empty with `kind: "names"` means a run that failed none. */
  failing: string[];
  /** `names` only: how many tests ran. */
  tests_total?: number;
  /** `exit-only` and exit non-zero: the failure's signature. */
  signature?: string;
  /** Absent when the ledger row holds none. */
  duration_ms?: number;
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

/** Hash of every lockfile in the base commit, by path and content; `none` when it has none. Undefined when git could not say: unknown is not "no lockfile". */
export function lockfileHashAt(repo: string, base: string): string | undefined {
  const tree = hostGit(["ls-tree", "-r", "--name-only", base], repo, { maxBuffer: 64 * 1024 * 1024 });
  if (!tree.ok) return undefined;
  const paths = tree.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "" && LOCKFILES.has(basename(l))).sort();
  if (paths.length === 0) return NO_LOCKFILE;
  const hash = createHash("sha256");
  for (const p of paths) {
    const blob = hostGit(["show", `${base}:${p}`], repo, { raw: true, maxBuffer: 256 * 1024 * 1024 });
    if (!blob.ok) return undefined;
    hash.update(`${p}\0`).update(blob.stdout).update("\0");
  }
  return hash.digest("hex");
}

/** Hash of what the checkout's install says it holds (the `node_modules` the run reaches through its junction); undefined when it leaves no such file. */
export function installedStateHash(repo: string): string | undefined {
  const hash = createHash("sha256");
  let found = false;
  for (const name of INSTALL_STATE_FILES) {
    const file = join(repo, "node_modules", name);
    if (!existsSync(file)) continue;
    try {
      hash.update(`${name}\0`).update(readFileSync(file)).update("\0");
      found = true;
    } catch {
      return undefined;
    }
  }
  return found ? hash.digest("hex") : undefined;
}

/**
 * The key a run of `command` on `base` has: undefined when `base` names no commit or its lockfiles cannot be read.
 * The lockfile part is the base's lockfiles and, when the checkout has an install, what that install holds. `platform`
 * defaults to this machine's.
 */
export function baselineKey(repo: string, base: string, command: string, platform: string = process.platform): BaselineKey | undefined {
  const resolved = hostGit(["rev-parse", "--verify", `${base}^{commit}`], repo);
  if (!resolved.ok) return undefined;
  const lockfiles = lockfileHashAt(repo, resolved.stdout);
  if (lockfiles === undefined) return undefined;
  const installed = installedStateHash(repo);
  return { base: resolved.stdout, command, lockfileHash: installed === undefined ? lockfiles : `${lockfiles}+installed-${installed}`, platform };
}

/** node:test's reporter events to the tests that failed, and how many ran. A file that failed to run is one failing entry, the file's path. */
export function parseNodeTestFailures(stdout: string, dir: string): { failing: string[]; total: number } | undefined {
  const norm = (p: string): string => p.replace(/\\/g, "/");
  const d = norm(dir).replace(/\/+$/, "");
  const rel = (file: string): string => {
    const f = norm(file);
    return f.startsWith(`${d}/`) ? f.slice(d.length + 1) : f;
  };
  const parsed = parseNodeTestStream(stdout, rel);
  if (!parsed.parsedAnyEvent) return undefined;
  const failing: string[] = [];
  let total = 0;
  for (const [file, tests] of parsed.testsByFile) {
    for (const t of tests) {
      if (t.status === "skip") continue;
      total += 1;
      if (t.status !== "pass") failing.push([file, ...t.describe, t.name].filter((x) => x !== "").join(" > "));
    }
  }
  for (const file of parsed.fileErrors.keys()) failing.push(file);
  return { failing, total };
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
  // The shell line runs in the bash Pi resolves (T247). Without one the local executor falls back to cmd.exe, whose
  // "command not found" is exit 1 and cannot be told from a failing run, so nothing is measured.
  if (executor === localExecutor) {
    const bash = resolveHostBash();
    if (!bash.ok) {
      worktree.cleanup();
      return { status: "unmeasured", reason: noBashMessage(bash).split("\n")[0]! };
    }
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
    const child = executor.spawn(command, [], { cwd: worktree.dir, shell: true, env, containerPaths: true, windowsHide: true, ...TREE_KILL_SPAWN_OPTIONS });
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
    // On a timeout the run is over for the baseline's purposes: the command's whole process tree is killed (and that
    // awaited, so nothing outlives the run into the worktree's removal) and `close` is not waited for, since a
    // grandchild that held the pipes open would keep it from ever firing.
    const exit = await new Promise<number | null | Error>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        void killExecChild(child).then(() => resolve(null));
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
    ...(row.exit_code !== null ? { exit_code: row.exit_code } : {}),
    failing: row.failing_json === null ? [] : (JSON.parse(row.failing_json) as string[]),
    ...(row.tests_total !== null ? { tests_total: row.tests_total } : {}),
    ...(row.signature !== null ? { signature: row.signature } : {}),
    ...(row.duration_ms !== null ? { duration_ms: row.duration_ms } : {}),
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
    ...(b.exit_code !== undefined ? { exit_code: b.exit_code } : {}),
    failing: b.failing,
    ...(b.tests_total !== undefined ? { tests_total: b.tests_total } : {}),
  };
}
