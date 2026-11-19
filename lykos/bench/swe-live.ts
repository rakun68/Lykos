// One public benchmark task (T258, P18 spec decision 22): a SWE-bench-Live instance imported as a Lykos task file,
// its hidden tests kept out of the session's view, and a command that runs them on a finished branch.
//
// The protocol is SWE-bench's, as SWE-bench-Live's evaluation README states it: during the run the agent sees only the
// problem statement and the repository at the base commit; never the test patch, the FAIL_TO_PASS and PASS_TO_PASS
// lists, the hints, or any commit after the base. So:
//   - the repository is fetched at the base commit alone (depth 1, no remote left), so no later commit is reachable;
//   - the task file holds the problem statement and nothing else from the row;
//   - the full row, and every hidden-test log, is kept under `~/.lykos/bench/`, which the gate denies to every session
//     (`lykos/gate/path-rules.ts`).
// The hidden tests run only from `lykos bench check`, after the session ends, in a temporary worktree of the branch.
// P20's bench reuses this importer.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hostGit } from "../git/host-git.js";
import type { Ledger } from "../ledger/use.js";
import { createTemporaryWorktree } from "../seal/git.js";

/** One SWE-bench-Live row, with the fields its dataset card's schema names that Lykos reads. */
export interface SweLiveInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  test_patch: string;
  rebuild_cmds: string[];
  test_cmds: string[];
  print_cmds: string[];
  log_parser: string;
  FAIL_TO_PASS: string[];
  PASS_TO_PASS: string[];
  issue_numbers?: string[];
  language?: string;
  created_at?: string;
  [field: string]: unknown;
}

/** What the importer keeps beside the row: where it came from, and when. */
export interface StoredInstance {
  dataset: string;
  /** The dataset repository's commit on Hugging Face when the row was read; "unknown" when it could not be read. */
  revision: string;
  imported_at: string;
  instance: SweLiveInstance;
}

export class BenchError extends Error {}

const REQUIRED_STRINGS = ["instance_id", "repo", "base_commit", "problem_statement", "test_patch", "log_parser"] as const;
const REQUIRED_LISTS = ["rebuild_cmds", "test_cmds", "print_cmds", "FAIL_TO_PASS", "PASS_TO_PASS"] as const;

/** Narrows a parsed row to an instance; a missing or mistyped field is an error, never a default. */
export function asInstance(value: unknown): SweLiveInstance {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new BenchError("bench: an instance must be an object");
  const row = value as Record<string, unknown>;
  for (const key of REQUIRED_STRINGS) {
    if (typeof row[key] !== "string" || row[key] === "") throw new BenchError(`bench: instance field "${key}" must be a non-empty string`);
  }
  for (const key of REQUIRED_LISTS) {
    const list = row[key];
    if (!Array.isArray(list) || !list.every((v) => typeof v === "string")) throw new BenchError(`bench: instance field "${key}" must be a list of strings`);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(row.instance_id as string)) throw new BenchError(`bench: instance id "${String(row.instance_id)}" is not a plain name`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(row.repo as string)) throw new BenchError(`bench: repo "${String(row.repo)}" is not owner/name`);
  if (!/^[0-9a-f]{40}$/.test(row.base_commit as string)) throw new BenchError(`bench: base_commit "${String(row.base_commit)}" is not a full sha`);
  return row as SweLiveInstance;
}

/** Where the hidden material lives: under the user's Lykos home, denied to every session by a shipped gate rule. */
export function benchHome(home: string = homedir()): string {
  return join(home, ".lykos", "bench");
}

export function storedInstancePath(instanceId: string, home?: string): string {
  return join(benchHome(home), instanceId, "instance.json");
}

export function readStoredInstance(instanceId: string, home?: string): StoredInstance {
  const path = storedInstancePath(instanceId, home);
  if (!existsSync(path)) throw new BenchError(`bench: ${instanceId} is not imported (no ${path}); run \`lykos bench import\` first`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return {
    dataset: String(parsed.dataset),
    revision: String(parsed.revision),
    imported_at: String(parsed.imported_at),
    instance: asInstance(parsed.instance),
  };
}

export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Reads one row of a Hugging Face dataset's `test` split through the public datasets-server `rows` endpoint, a page at a
 * time, and the dataset repository's commit. The `filter` endpoint is not used: on 2026-11-20 it answered "the dataset
 * index is loading" for this dataset.
 */
export async function fetchInstance(dataset: string, instanceId: string, fetchImpl: FetchLike = fetch): Promise<{ instance: SweLiveInstance; revision: string }> {
  const page = 100;
  let revision = "unknown";
  const meta = await fetchImpl(`https://huggingface.co/api/datasets/${dataset}`);
  if (meta.ok) {
    const body = (await meta.json()) as { sha?: unknown };
    if (typeof body.sha === "string") revision = body.sha;
  }
  for (let offset = 0; ; offset += page) {
    const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}&config=default&split=test&offset=${offset}&length=${page}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new BenchError(`bench: ${url} answered HTTP ${res.status}`);
    const body = (await res.json()) as { rows?: Array<{ row?: unknown }>; num_rows_total?: unknown };
    const rows = body.rows ?? [];
    for (const r of rows) {
      const row = r.row as { instance_id?: unknown } | undefined;
      if (row?.instance_id === instanceId) return { instance: asInstance(row), revision };
    }
    const total = typeof body.num_rows_total === "number" ? body.num_rows_total : 0;
    if (rows.length === 0 || offset + page >= total) break;
  }
  throw new BenchError(`bench: ${dataset} has no instance "${instanceId}" in its test split`);
}

/**
 * The task file: Boxie's format with the problem statement as the brief. Nothing else from the row goes in: no test
 * command (the FAIL_TO_PASS tests do not exist at the base), no sealed files, no hints. `red: false`, since there is no
 * sealed test to be red. The wording is general, as the SWE-bench-Live protocol requires of a prompt.
 */
export function taskFileFor(instance: SweLiveInstance): string {
  const issues = (instance.issue_numbers ?? []).map((n) => `#${n}`).join(", ");
  return [
    "---",
    "red: false",
    "---",
    `# ${instance.repo}${issues === "" ? "" : `: issue ${issues}`}`,
    "",
    "Resolve the issue below in this repository: change the source so the described problem is fixed. Add or update",
    "tests where they help. Do not look up this issue, its pull request, or later commits of the upstream repository.",
    "",
    "## Issue",
    "",
    instance.problem_statement.replace(/\r\n/g, "\n").trimEnd(),
    "",
  ].join("\n");
}

/** Runs git in `cwd` with no repository hook, whether or not `cwd` is a repository yet. */
function freshGit(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const noHooks = mkdtempSync(join(tmpdir(), "lykos-no-hooks-"));
  try {
    const run = spawnSync("git", ["-c", `core.hooksPath=${noHooks}`, "-c", "core.fsmonitor=false", ...args], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: run.error === undefined && run.status === 0, stdout: (run.stdout ?? "").trim(), stderr: (run.stderr ?? "").trim() };
  } finally {
    rmSync(noHooks, { recursive: true, force: true });
  }
}

export interface ImportResult {
  instanceId: string;
  repoDir: string;
  taskFile: string;
  stored: string;
}

/**
 * Imports one instance: fetches the repository at its base commit alone into `<out>/repo` on a branch `main` (one
 * commit, no remote, so no later commit is reachable from the session), writes `<out>/task.md`, and stores the row
 * under `~/.lykos/bench/<instance>/`. `cloneUrl` is for tests; it defaults to the instance's GitHub repository.
 */
export function importInstance(input: {
  dataset: string;
  revision: string;
  instance: SweLiveInstance;
  out: string;
  home?: string;
  cloneUrl?: string;
  now?: () => Date;
}): ImportResult {
  const { instance } = input;
  const out = resolve(input.out);
  const repoDir = join(out, "repo");
  if (existsSync(repoDir)) throw new BenchError(`bench: ${repoDir} exists; import into a new directory`);
  mkdirSync(repoDir, { recursive: true });
  const url = input.cloneUrl ?? `https://github.com/${instance.repo}.git`;
  const steps: string[][] = [
    ["init", "-q", "-b", "main"],
    ["fetch", "-q", "--depth", "1", "--no-tags", url, instance.base_commit],
    ["reset", "-q", "--hard", "FETCH_HEAD"],
  ];
  for (const args of steps) {
    const run = freshGit(args, repoDir);
    if (!run.ok) throw new BenchError(`bench: git ${args[0]} failed: ${run.stderr}`);
  }
  const head = freshGit(["rev-parse", "HEAD"], repoDir);
  if (head.stdout !== instance.base_commit) throw new BenchError(`bench: the checkout is at ${head.stdout || "(none)"}, not the base commit ${instance.base_commit}`);
  // FETCH_HEAD names the upstream URL and is the only trace of it; the reflog holds nothing past the base either.
  rmSync(join(repoDir, ".git", "FETCH_HEAD"), { force: true });

  const taskFile = join(out, "task.md");
  writeFileSync(taskFile, taskFileFor(instance));

  const stored = storedInstancePath(instance.instance_id, input.home);
  mkdirSync(dirname(stored), { recursive: true });
  const record: StoredInstance = {
    dataset: input.dataset,
    revision: input.revision,
    imported_at: (input.now ?? (() => new Date()))().toISOString(),
    instance,
  };
  writeFileSync(stored, JSON.stringify(record, null, 1));
  return { instanceId: instance.instance_id, repoDir, taskFile, stored };
}

/**
 * The key a test name is matched by when it is not found as written. The dataset's names were read off a Windows
 * container's console, which wraps long lines (a character doubled or a newline at the wrap, "PACCKAGE") and decodes
 * UTF-8 as a code page ("ΓÇö" for "—"). The key drops whitespace and every non-ASCII character and collapses each run of
 * one character to one, on both sides. Two different tests can share a key; an exact name always wins over a key.
 */
export function nameKey(name: string): string {
  return name.replace(/\s+/g, "").replace(/[^\x21-\x7e]/g, "").replace(/(.)\1+/g, "$1");
}

export type TestStatus = "pass" | "fail" | "skip" | "missing";

export interface Graded {
  passed: number;
  total: number;
  /** Names that did not pass, with what they did. */
  notPassed: Array<{ name: string; status: TestStatus }>;
}

export function gradeList(expected: readonly string[], results: Readonly<Record<string, string>>): Graded {
  const byKey = new Map<string, string>();
  for (const [name, status] of Object.entries(results)) {
    const key = nameKey(name);
    // A key two results share is ambiguous: a fail among them wins, so a collision never turns a failure into a pass.
    const prior = byKey.get(key);
    if (prior === undefined || status !== "pass") byKey.set(key, status);
  }
  const notPassed: Graded["notPassed"] = [];
  for (const name of expected) {
    const raw = Object.hasOwn(results, name) ? results[name] : byKey.get(nameKey(name));
    const status: TestStatus = raw === "pass" || raw === "fail" || raw === "skip" ? raw : raw === undefined ? "missing" : "fail";
    if (status !== "pass") notPassed.push({ name, status });
  }
  return { passed: expected.length - notPassed.length, total: expected.length, notPassed };
}

export type CheckStatus = "resolved" | "unresolved" | "error";

export interface CheckResult {
  instanceId: string;
  dataset: string;
  revision: string;
  ref: string;
  head: string;
  status: CheckStatus;
  /** SWE-bench's rule: resolved when every FAIL_TO_PASS and every PASS_TO_PASS test passes. A missing test fails. */
  failToPass?: Graded;
  passToPass?: Graded;
  error?: string;
  durationMs: number;
  /** The run's full output, under `~/.lykos/bench/<instance>/runs/`. */
  log: string;
}

export interface ScriptRun {
  code: number | null;
  output: string;
}

/** Runs a PowerShell script file in `cwd`: the dataset's commands are PowerShell. */
export type ScriptRunner = (script: string, cwd: string) => Promise<ScriptRun>;

export const runPowerShell: ScriptRunner = (script, cwd) =>
  new Promise((resolveRun, reject) => {
    const exe = process.platform === "win32" ? "powershell.exe" : "pwsh";
    const child = spawn(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script], { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (output += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, output }));
  });

/** Runs the dataset's `log_parser` on a log; it is Python, defining `parser(log) -> dict[str, str]`. */
export type LogParser = (parserSource: string, log: string) => Promise<Record<string, string>>;

export function pythonLogParser(python = "python"): LogParser {
  return async (parserSource, log) => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-bench-parser-"));
    try {
      const file = join(dir, "parse.py");
      writeFileSync(file, `${parserSource}\n\nimport json, sys\nsys.stdout.write(json.dumps(parser(sys.stdin.read())))\n`);
      // -I: the script's directory and the user's site packages stay off the path.
      const run = spawnSync(python, ["-I", "-X", "utf8", file], { input: log, encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
      if (run.error !== undefined) throw new BenchError(`bench: ${python} cannot run the log parser: ${run.error.message}`);
      if (run.status !== 0) throw new BenchError(`bench: the log parser failed (exit ${run.status}): ${(run.stderr ?? "").trim().slice(-2000)}`);
      const parsed = JSON.parse(run.stdout) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new BenchError("bench: the log parser did not return a mapping");
      return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * Runs an imported instance's hidden tests on `ref` of `repo`: a temporary worktree at the ref, the test patch applied,
 * then the dataset's rebuild, test and print commands in PowerShell, the print output parsed by the dataset's parser, and
 * FAIL_TO_PASS and PASS_TO_PASS graded. Nothing runs in the repository's own checkout.
 */
export async function checkInstance(input: {
  repo: string;
  ref: string;
  instanceId: string;
  home?: string;
  runScript?: ScriptRunner;
  parseLog?: LogParser;
  now?: () => number;
}): Promise<CheckResult> {
  const now = input.now ?? Date.now;
  const started = now();
  const stored = readStoredInstance(input.instanceId, input.home);
  const { instance } = stored;
  const runs = join(benchHome(input.home), instance.instance_id, "runs");
  mkdirSync(runs, { recursive: true });
  const log = join(runs, `${new Date(started).toISOString().replace(/[:.]/g, "-")}.log`);
  const head = hostGit(["rev-parse", "--verify", `${input.ref}^{commit}`], input.repo);
  const base: Omit<CheckResult, "status" | "durationMs"> = {
    instanceId: instance.instance_id,
    dataset: stored.dataset,
    revision: stored.revision,
    ref: input.ref,
    head: head.ok ? head.stdout : "",
    log,
  };
  if (!head.ok) {
    writeFileSync(log, `ref ${input.ref} does not resolve: ${head.stderr}\n`);
    return { ...base, status: "error", error: `ref ${input.ref} does not resolve in ${input.repo}`, durationMs: now() - started };
  }

  const transcript: string[] = [`instance ${instance.instance_id} (${stored.dataset} @ ${stored.revision})`, `ref ${input.ref} = ${base.head}`];
  const tree = createTemporaryWorktree(input.repo, base.head);
  try {
    const patchFile = join(runs, "test.patch");
    writeFileSync(patchFile, instance.test_patch.endsWith("\n") ? instance.test_patch : `${instance.test_patch}\n`);
    const applied = hostGit(["apply", "--whitespace=nowarn", patchFile], tree.dir);
    transcript.push(`$ git apply test.patch -> ${applied.ok ? "ok" : `failed: ${applied.stderr}`}`);
    if (!applied.ok) return finish({ status: "error", error: `the test patch does not apply at ${base.head.slice(0, 12)}: ${applied.stderr}` });

    const runScript = input.runScript ?? runPowerShell;
    const scriptDir = mkdtempSync(join(tmpdir(), "lykos-bench-"));
    try {
      const build = join(scriptDir, "test.ps1");
      writeFileSync(build, [...instance.rebuild_cmds, ...instance.test_cmds].join("\n") + "\n");
      const ran = await runScript(build, tree.dir);
      transcript.push(`$ rebuild + test (exit ${ran.code})`, ran.output);
      let parseInput = ran.output;
      if (instance.print_cmds.length > 0) {
        const print = join(scriptDir, "print.ps1");
        writeFileSync(print, instance.print_cmds.join("\n") + "\n");
        const printed = await runScript(print, tree.dir);
        transcript.push(`$ print (exit ${printed.code})`, printed.output);
        parseInput = printed.output;
      }
      const results = await (input.parseLog ?? pythonLogParser())(instance.log_parser, parseInput);
      const failToPass = gradeList(instance.FAIL_TO_PASS, results);
      const passToPass = gradeList(instance.PASS_TO_PASS, results);
      const resolved = failToPass.notPassed.length === 0 && passToPass.notPassed.length === 0;
      transcript.push(`parsed ${Object.keys(results).length} results`, JSON.stringify({ failToPass, passToPass }, null, 1));
      return finish({ status: resolved ? "resolved" : "unresolved", failToPass, passToPass });
    } finally {
      rmSync(scriptDir, { recursive: true, force: true });
    }
  } catch (err) {
    return finish({ status: "error", error: err instanceof Error ? err.message : String(err) });
  } finally {
    tree.cleanup();
  }

  function finish(part: Pick<CheckResult, "status"> & Partial<CheckResult>): CheckResult {
    if (part.error !== undefined) transcript.push(`error: ${part.error}`);
    writeFileSync(log, transcript.join("\n") + "\n");
    return { ...base, ...part, durationMs: now() - started };
  }
}

/** Appends a check's outcome to the project ledger's `bench_results`. Returns the row id. */
export function recordCheck(ledger: Ledger, result: CheckResult, ts: string = new Date().toISOString()): number {
  const info = ledger.db
    .prepare(
      `INSERT INTO bench_results (ts, dataset, revision, instance_id, ref, head, status, f2p_passed, f2p_total, p2p_passed, p2p_total, error, duration_ms, log_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ts,
      result.dataset,
      result.revision,
      result.instanceId,
      result.ref,
      result.head,
      result.status,
      result.failToPass?.passed ?? null,
      result.failToPass?.total ?? null,
      result.passToPass?.passed ?? null,
      result.passToPass?.total ?? null,
      result.error ?? null,
      result.durationMs,
      result.log,
    );
  return Number(info.lastInsertRowid);
}
