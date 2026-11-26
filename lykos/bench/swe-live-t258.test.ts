// T258: one public benchmark task. A SWE-bench-Live row imports as a repository at its base commit and a task file that
// holds the problem statement only; the hidden material is under `~/.lykos/bench/`, which the gate denies; and
// `lykos bench check` runs the hidden tests on a branch and records the outcome in the ledger.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { parseTaskFile } from "../delegate/task-file.js";
import { collectPathRules, decidePath, type PathContext } from "../gate/path-rules.js";
import { loadConfig } from "../config/load.js";
import { openLedgerSync } from "../ledger/use.js";
import { applySpecialist } from "../session/specialist-apply.js";
import { applyToolDeltas, resolveStandaloneTools } from "../tools/session-tools.js";
import { createSpecialistGuardHandler } from "../tools/specialist-guard-extension.js";
import {
  asInstance,
  BENCH_WEB_TOOLS,
  BenchError,
  checkInstance,
  fetchInstance,
  gradeList,
  importInstance,
  nameKey,
  pythonLogParser,
  recordCheck,
  storedInstancePath,
  taskFileFor,
  type FetchLike,
  type SweLiveInstance,
} from "./swe-live.js";

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-t258-"));
  roots.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  const run = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", windowsHide: true });
  assert.equal(run.status, 0, `git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
}

const TEST_PATCH = [
  "diff --git a/test/hidden.test.js b/test/hidden.test.js",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/test/hidden.test.js",
  "@@ -0,0 +1 @@",
  "+// the hidden test",
  "",
].join("\n");

/** An upstream repository with a base commit and a later fix the session must never reach. */
function upstream(): { dir: string; base: string; later: string } {
  const dir = scratch();
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "uploadpack.allowAnySHA1InWant", "true");
  writeFileSync(join(dir, "app.js"), "export const broken = true;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "base");
  const base = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "app.js"), "export const broken = false;\n");
  git(dir, "commit", "-q", "-am", "the gold fix");
  return { dir, base, later: git(dir, "rev-parse", "HEAD") };
}

function instance(base: string, over: Partial<SweLiveInstance> = {}): SweLiveInstance {
  return {
    instance_id: "acme__app-1",
    repo: "acme/app",
    base_commit: base,
    issue_numbers: ["7"],
    problem_statement: "The app is broken on Windows.\r\nIt should not be.",
    patch: "GOLD-PATCH-TEXT",
    test_patch: TEST_PATCH,
    hints_text: "HINT-TEXT",
    rebuild_cmds: ["npm install"],
    test_cmds: ["npm test"],
    print_cmds: ["Get-Content out.tap"],
    log_parser: "def parser(log):\n    return {}\n",
    FAIL_TO_PASS: ["fixes the bug"],
    PASS_TO_PASS: ["still works"],
    ...over,
  };
}

describe("T258: the instance row", () => {
  it("is refused when a field is missing or mistyped", () => {
    const good = instance("a".repeat(40));
    assert.equal(asInstance(good).instance_id, "acme__app-1");
    assert.throws(() => asInstance({ ...good, test_patch: undefined }), BenchError);
    assert.throws(() => asInstance({ ...good, FAIL_TO_PASS: "x" }), BenchError);
    assert.throws(() => asInstance({ ...good, base_commit: "abc" }), BenchError);
    assert.throws(() => asInstance({ ...good, instance_id: "../escape" }), BenchError);
    assert.throws(() => asInstance({ ...good, repo: "not a repo" }), BenchError);
  });

  it("is found by paging the datasets-server rows endpoint, with the dataset's revision", async () => {
    const urls: string[] = [];
    const rows = Array.from({ length: 150 }, (_, i) => ({ row: instance("b".repeat(40), { instance_id: `x__y-${i}` }) }));
    const fetchImpl: FetchLike = async (url) => {
      urls.push(url);
      if (url.startsWith("https://huggingface.co/api/datasets/")) return { ok: true, status: 200, json: async () => ({ sha: "rev123" }) };
      const offset = Number(new URL(url).searchParams.get("offset"));
      return { ok: true, status: 200, json: async () => ({ rows: rows.slice(offset, offset + 100), num_rows_total: rows.length }) };
    };
    const got = await fetchInstance("SWE-bench-Live/Windows", "x__y-120", fetchImpl);
    assert.equal(got.instance.instance_id, "x__y-120");
    assert.equal(got.revision, "rev123");
    assert.equal(urls.length, 3);
    await assert.rejects(fetchInstance("SWE-bench-Live/Windows", "absent", fetchImpl), /no instance "absent"/);
  });
});

describe("T258: the task file", () => {
  it("carries the problem statement and nothing hidden", () => {
    const row = instance("c".repeat(40));
    const text = taskFileFor(row);
    const task = parseTaskFile(text);
    assert.match(task.body, /The app is broken on Windows\.\nIt should not be\./);
    assert.equal(task.red, false);
    assert.equal(task.test, undefined);
    assert.deepEqual(task.sealed, []);
    assert.deepEqual(task.warnings, []);
    for (const hidden of ["GOLD-PATCH-TEXT", "HINT-TEXT", "hidden.test.js", "fixes the bug", "still works", "npm test"]) {
      assert.ok(!text.includes(hidden), `the task file leaks ${hidden}`);
    }
  });
});

describe("T258: import", () => {
  it("leaves the repository at the base commit alone, with no later commit and no remote", () => {
    const up = upstream();
    const out = scratch();
    const home = scratch();
    const row = instance(up.base);
    const res = importInstance({ dataset: "SWE-bench-Live/Windows", revision: "rev1", instance: row, out, home, cloneUrl: pathToFileURL(up.dir).href });

    assert.equal(git(res.repoDir, "rev-parse", "HEAD"), up.base);
    assert.equal(git(res.repoDir, "branch", "--show-current"), "main");
    assert.equal(git(res.repoDir, "rev-list", "--all", "--count"), "1");
    assert.equal(git(res.repoDir, "remote"), "");
    assert.equal(spawnSync("git", ["cat-file", "-e", `${up.later}^{commit}`], { cwd: res.repoDir, windowsHide: true }).status === 0, false, "the gold fix is not reachable");
    assert.equal(existsSync(join(res.repoDir, ".git", "FETCH_HEAD")), false);
    assert.equal(git(res.repoDir, "status", "--porcelain"), "");

    assert.equal(readFileSync(res.taskFile, "utf8"), taskFileFor(row));
    assert.ok(!res.taskFile.startsWith(res.repoDir), "the task file is outside the repository");
    assert.equal(res.stored, storedInstancePath(row.instance_id, home));
    const stored = JSON.parse(readFileSync(res.stored, "utf8")) as { dataset: string; revision: string; instance: SweLiveInstance };
    assert.equal(stored.revision, "rev1");
    assert.equal(stored.instance.test_patch, TEST_PATCH);

    assert.throws(() => importInstance({ dataset: "d", revision: "r", instance: row, out, home, cloneUrl: pathToFileURL(up.dir).href }), /exists/);
  });

  it("leaves a session in the repository no tool that reaches the web, and git sees no trace of it", () => {
    const up = upstream();
    const out = scratch();
    const res = importInstance({ dataset: "SWE-bench-Live/Windows", revision: "rev1", instance: instance(up.base), out, home: scratch(), cloneUrl: pathToFileURL(up.dir).href });

    // The path `session/boot.ts` takes: the project layer's delta on the default surface, then the specialist guard,
    // which refuses an off-limits tool both called directly and through `tool_call`.
    const { resolved } = loadConfig({ cwd: res.repoDir, globalDir: scratch(), env: {} });
    const defaults = resolveStandaloneTools({ isChild: false });
    for (const name of BENCH_WEB_TOOLS) assert.ok(defaults.includes(name), `${name} is on the default surface, so withholding it is real`);
    const app = applySpecialist({
      context: "session-start",
      defaultToolNames: defaults,
      specialistToolNames: applyToolDeltas(defaults, resolved.tools_add, resolved.tools_remove),
    });
    const guard = createSpecialistGuardHandler({ offLimitTools: app.offLimitToolNames, registryOffTools: [] });
    for (const name of BENCH_WEB_TOOLS) {
      const verdict = guard({ type: "tool_call", toolCallId: "c1", toolName: name, input: {} } as ToolCallEvent);
      assert.equal(verdict?.block, true, `${name} is refused`);
    }
    for (const name of ["read", "bash", "edit"]) assert.equal(guard({ type: "tool_call", toolCallId: "c2", toolName: name, input: {} } as ToolCallEvent), undefined, `${name} stays`);
    assert.equal(git(res.repoDir, "status", "--porcelain", "--ignored"), "!! .lykos/");
  });

  it("keeps the hidden material where the gate denies every session, for read and write", () => {
    const home = process.platform === "win32" ? "C:/Users/u" : "/home/u";
    const ctx: PathContext = { cwd: `${home}/work/app`, home, extraDirs: [home], outside: { read: "allow", write: "allow" } };
    const rules = collectPathRules({}, false);
    const path = storedInstancePath("acme__app-1", home).replace(/\\/g, "/");
    for (const access of ["read", "write"] as const) {
      assert.equal(decidePath(path, access, rules, ctx).decision, "deny", access);
      assert.equal(decidePath(`${home}/.lykos/bench/acme__app-1/runs/x.log`, access, rules, ctx).decision, "deny", access);
    }
  });
});

describe("T258: grading", () => {
  it("matches the dataset's console-mangled names to clean ones", () => {
    const results = {
      "resolveBridgeRuntimeConfig falls back when GSD_WEB_PACKAGE_ROOT is absent": "pass",
      "(a) SSE emits request → typed payload": "pass",
      "ADR-1016 — tightened": "pass",
      "AzureMcp.Tests.UnitTests.Metrics": "pass",
    };
    const graded = gradeList(
      [
        "resolveBridgeRuntimeConfig falls back when GSD_WEB_PACCKAGE_ROOT is absent",
        "(a) SSE emits request â†’ typed paylload",
        "ADR-1016 ΓÇö tightened",
        "AzureMcp.Tests.Unit\ntTests.Metrics",
      ],
      results,
    );
    assert.deepEqual(graded, { passed: 4, total: 4, notPassed: [] });
  });

  it("counts a missing test as not passed, and lets a failure win a shared key", () => {
    assert.equal(nameKey("a  b"), nameKey("ab"));
    const graded = gradeList(["gone", "shared", "skipped"], { "shared": "pass", "sharred": "fail", "skipped": "skip" });
    assert.deepEqual(graded.notPassed, [
      { name: "gone", status: "missing" },
      { name: "skipped", status: "skip" },
    ]);
    // An exact name wins over its key; a name found only by key takes the failing one.
    assert.deepEqual(gradeList(["shaaared"], { shared: "pass", sharred: "fail" }).notPassed, [{ name: "shaaared", status: "fail" }]);
  });
});

describe("T258: lykos bench check", () => {
  function imported(over: Partial<SweLiveInstance> = {}): { repo: string; home: string; row: SweLiveInstance } {
    const up = upstream();
    const home = scratch();
    const row = instance(up.base, over);
    const res = importInstance({ dataset: "SWE-bench-Live/Windows", revision: "rev1", instance: row, out: scratch(), home, cloneUrl: pathToFileURL(up.dir).href });
    // The session's work: a branch with a fix on it.
    git(res.repoDir, "checkout", "-q", "-b", "lykos/fix");
    writeFileSync(join(res.repoDir, "app.js"), "export const broken = false;\n");
    git(res.repoDir, "commit", "-q", "-am", "fix");
    git(res.repoDir, "checkout", "-q", "main");
    return { repo: res.repoDir, home, row };
  }

  it("runs the dataset's commands on the ref with the test patch applied, outside the checkout, and grades them", async () => {
    const { repo, home } = imported();
    const scripts: Array<{ text: string; cwd: string; patched: boolean; fixed: boolean }> = [];
    const result = await checkInstance({
      repo,
      ref: "lykos/fix",
      instanceId: "acme__app-1",
      home,
      runScript: async (script, cwd) => {
        scripts.push({
          text: readFileSync(script, "utf8"),
          cwd,
          patched: existsSync(join(cwd, "test", "hidden.test.js")),
          fixed: readFileSync(join(cwd, "app.js"), "utf8").includes("false"),
        });
        return { code: 0, output: scripts.length === 1 ? "build and test output" : "ok 1 - fixes the bug\nok 2 - still works\n" };
      },
      parseLog: async (source, log) => {
        assert.match(source, /def parser/);
        assert.match(log, /^ok 1/);
        return { "fixes the bug": "pass", "still works": "pass" };
      },
    });
    assert.equal(result.status, "resolved", result.error);
    assert.deepEqual(result.failToPass, { passed: 1, total: 1, notPassed: [] });
    assert.equal(scripts.length, 2);
    assert.equal(scripts[0]!.text, "npm install\nnpm test\n");
    assert.equal(scripts[1]!.text, "Get-Content out.tap\n");
    assert.ok(scripts.every((s) => s.patched && s.fixed && s.cwd !== repo));
    assert.equal(result.head, git(repo, "rev-parse", "lykos/fix"));
    assert.equal(existsSync(join(repo, "test", "hidden.test.js")), false, "the checkout never sees the test patch");
    assert.equal(git(repo, "worktree", "list").split("\n").length, 1, "the temporary worktree is gone");
    assert.ok(result.log.startsWith(join(home, ".lykos", "bench")));
    assert.match(readFileSync(result.log, "utf8"), /build and test output/);

    const ledgerPath = join(scratch(), "ledger.db");
    const ledger = openLedgerSync(ledgerPath);
    try {
      const id = recordCheck(ledger, result, "2026-11-20T00:00:00.000Z");
      const row = ledger.db.prepare("SELECT * FROM bench_results WHERE id = ?").get(id) as Record<string, unknown>;
      assert.equal(row.instance_id, "acme__app-1");
      assert.equal(row.dataset, "SWE-bench-Live/Windows");
      assert.equal(row.revision, "rev1");
      assert.equal(row.ref, "lykos/fix");
      assert.equal(row.status, "resolved");
      assert.equal(row.f2p_passed, 1);
      assert.equal(row.p2p_total, 1);
      assert.equal(row.error, null);
    } finally {
      ledger.close();
    }
  });

  it("is unresolved when a FAIL_TO_PASS or PASS_TO_PASS test does not pass", async () => {
    const { repo, home } = imported();
    const result = await checkInstance({
      repo,
      ref: "lykos/fix",
      instanceId: "acme__app-1",
      home,
      runScript: async () => ({ code: 1, output: "" }),
      parseLog: async () => ({ "fixes the bug": "pass", "still works": "fail" }),
    });
    assert.equal(result.status, "unresolved");
    assert.deepEqual(result.passToPass?.notPassed, [{ name: "still works", status: "fail" }]);
  });

  it("is an error, with nothing run, when the ref is unknown or the test patch does not apply", async () => {
    const { repo, home } = imported();
    let ran = 0;
    const runScript = async () => {
      ran += 1;
      return { code: 0, output: "" };
    };
    const noRef = await checkInstance({ repo, ref: "no-such-branch", instanceId: "acme__app-1", home, runScript, parseLog: async () => ({}) });
    assert.equal(noRef.status, "error");
    assert.match(noRef.error ?? "", /does not resolve/);

    const bad = imported({ instance_id: "acme__app-2", test_patch: "diff --git a/app.js b/app.js\n--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-nothing like this\n+x\n" });
    const noPatch = await checkInstance({ repo: bad.repo, ref: "lykos/fix", instanceId: "acme__app-2", home: bad.home, runScript, parseLog: async () => ({}) });
    assert.equal(noPatch.status, "error");
    assert.match(noPatch.error ?? "", /test patch does not apply/);
    assert.equal(ran, 0);
  });

  it("refuses an instance that was never imported", async () => {
    await assert.rejects(checkInstance({ repo: scratch(), ref: "HEAD", instanceId: "never__imported-1", home: scratch() }), /not imported/);
  });
});

describe("T258: the dataset's Python log parser", () => {
  const python = spawnSync("python", ["--version"], { windowsHide: true });
  it("runs isolated and returns its mapping", { skip: python.status !== 0 ? "no python on PATH" : false }, async () => {
    const source = "def parser(log: str) -> dict[str, str]:\n    import re\n    return {m.group(2): ('pass' if m.group(1) == 'ok' else 'fail') for m in re.finditer(r'^(ok|not ok) \\d+ - (.*)$', log, re.M)}\n";
    const parsed = await pythonLogParser()(source, "ok 1 - a → b\nnot ok 2 - c\n");
    assert.deepEqual(parsed, { "a → b": "pass", c: "fail" });
    await assert.rejects(pythonLogParser()("def parser(log):\n    raise ValueError('boom')\n", ""), /log parser failed/);
  });
});
