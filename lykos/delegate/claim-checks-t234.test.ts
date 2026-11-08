// T234 (ADR-0059, ADR-0061): the harness runs each claim's check, in a temporary worktree at the final head, and decides
// the verdict. Every test uses a real git repository and real processes: node's own test runner for reproductions,
// a shell command for command checks. Lessons covered here: W5 (execution is the gate: a convincing claim whose check
// fails is `failed`), W6 (a false claim is `failed`), G7 (removing the check's worktree never follows its
// `node_modules` junction into the main checkout).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { localExecutor, type ProjectExecutor } from "../tools/executor.js";
import { defaultLedgerPath, openLedgerSync } from "../ledger/use.js";
import { createTemporaryWorktree } from "../seal/git.js";
import { checkClaims, type CheckClaimsInput } from "./claim-checks.js";
import { parseClaimCheck, recordClaim, type ClaimCheck, type StoredClaim } from "./claims.js";
import { judgeSessionClaims } from "./session-claims.js";

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const saved: Record<string, string | undefined> = {};
let home: string;

before(() => {
  home = mkdtempSync(join(tmpdir(), "lykos-t234-home-"));
  for (const k of ["HOME", "USERPROFILE", "LYKOS_TRUST_WORKSPACE", "NODE_TEST_CONTEXT"]) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.NODE_TEST_CONTEXT;
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();
}

function put(dir: string, rel: string, text: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

interface Project {
  repo: string;
  base: string;
  head: string;
}

/**
 * A repository (its path has a space in it) whose base commit adds correctly and whose head commit, on top of it,
 * subtracts. `node_modules` is ignored and holds a marker file, so the check's worktree links to it.
 */
function project(opts: { lockfileAtHead?: string } = {}): Project {
  const repo = mkdtempSync(join(tmpdir(), "lykos t234 "));
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "core.autocrlf", "false");
  put(repo, ".gitignore", "node_modules/\n.lykos/\n");
  put(repo, "node_modules/marker.txt", "the main checkout's install\n");
  put(repo, "src/math.mjs", "export const add = (a, b) => a + b;\n");
  put(repo, "README.md", "# project\nsecond line\n");
  put(repo, "package-lock.json", '{"lockfileVersion":3,"v":1}\n');
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  put(repo, "src/math.mjs", "export const add = (a, b) => a - b;\n");
  put(repo, "src/extra.mjs", "// TODO fix\n// TODO again\nexport const x = 1;\n");
  if (opts.lockfileAtHead !== undefined) put(repo, "package-lock.json", opts.lockfileAtHead);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "head");
  return { repo, base, head: git(repo, "rev-parse", "HEAD") };
}

const REPRO_FILE = "tests/repro.test.mjs";
const REPRO = `
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/math.mjs";
describe("math", () => {
  test("adds two numbers", () => assert.equal(add(1, 2), 3));
  test("adds zero", () => assert.equal(add(5, 0), 5));
});
`;

/** A check as the claim tool's parser leaves it. */
function parsed(value: unknown): ClaimCheck {
  const r = parseClaimCheck(value);
  if (!r.ok) throw new Error(r.message);
  return r.check;
}

let nextId = 1;
function claim(check: ClaimCheck, text = "a claim"): StoredClaim {
  return { id: nextId++, session_id: "s1", ts: "2026-11-07T00:00:00Z", text, check };
}

function inputFor(p: Project, claims: StoredClaim[], over: Partial<CheckClaimsInput> = {}): CheckClaimsInput {
  return {
    repo: p.repo,
    ledgerPath: defaultLedgerPath(p.repo),
    sessionId: "s1",
    claims,
    head: p.head,
    base: p.base,
    trust: "stored",
    containment: "off",
    testCommand: "node --test {files}",
    timeoutMs: 120_000,
    ...over,
  };
}

/** A path as a command line can hold it between quotes: forward slashes work on every platform. */
const fwd = (p: string): string => p.split("\\").join("/");

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(fn: () => boolean, ms = 8000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return fn();
}

describe("T234: line and search checks are read by the harness at the final head, no shell", () => {
  it("a line check is verified when the line holds the text, and failed when it does not", async () => {
    const p = project();
    const [ok, wrongText, past, missing] = await checkClaims(
      inputFor(p, [
        claim({ kind: "line", path: "src/math.mjs", line: 1, text: "a - b" }),
        claim({ kind: "line", path: "src/math.mjs", line: 1, text: "a + b" }),
        claim({ kind: "line", path: "src/math.mjs", line: 40, text: "x" }),
        claim({ kind: "line", path: "src/nothing.mjs", line: 1, text: "x" }),
      ]),
    );
    assert.equal(ok?.verdict, "verified", ok?.reason);
    assert.equal(wrongText?.verdict, "failed");
    assert.match(wrongText?.reason ?? "", /line 1 of src\/math\.mjs is/);
    assert.equal(past?.verdict, "failed");
    assert.match(past?.reason ?? "", /has 1 line/);
    assert.equal(missing?.verdict, "failed");
    assert.match(missing?.reason ?? "", /does not exist/);
  });

  it("a line check reads the final head, not the base", async () => {
    const p = project();
    const [atHead] = await checkClaims(inputFor(p, [claim({ kind: "line", path: "src/math.mjs", line: 1, text: "a + b" })], { head: p.base }));
    assert.equal(atHead?.verdict, "verified", "at the base the line holds a + b");
  });

  it("a search check counts matching lines, over all files or under the given paths", async () => {
    const p = project();
    const [all, wrong, under, none] = await checkClaims(
      inputFor(p, [
        claim({ kind: "search", pattern: "TODO", matches: 2 }),
        claim({ kind: "search", pattern: "TODO", matches: 1 }),
        claim({ kind: "search", pattern: "export const", matches: 1, paths: ["src/extra.mjs"] }),
        claim({ kind: "search", pattern: "nonexistent_symbol", matches: 0 }),
      ]),
    );
    assert.equal(all?.verdict, "verified", all?.reason);
    assert.equal(wrong?.verdict, "failed");
    assert.match(wrong?.reason ?? "", /2 lines match.*expected 1/);
    assert.equal(under?.verdict, "verified", under?.reason);
    assert.equal(none?.verdict, "verified");
  });

  it("a search under a folder named with a trailing slash reads that folder", async () => {
    const p = project();
    const [slash, zero] = await checkClaims(
      inputFor(p, [claim(parsed({ kind: "search", pattern: "TODO", matches: 2, paths: ["src/"] })), claim(parsed({ kind: "search", pattern: "TODO", matches: 0, paths: ["src/"] }))]),
    );
    assert.equal(slash?.verdict, "verified", slash?.reason);
    assert.equal(zero?.verdict, "failed", zero?.reason);
  });

  it("a search that does not finish in the time limit is unchecked (a pattern that backtracks without end)", async () => {
    const p = project();
    put(p.repo, "src/long.txt", `${"a".repeat(28)}!${String.fromCharCode(10)}`);
    git(p.repo, "add", "-A");
    git(p.repo, "commit", "-q", "-m", "a long line");
    const head = git(p.repo, "rev-parse", "HEAD");
    const started = Date.now();
    const [r] = await checkClaims(inputFor({ ...p, head }, [claim({ kind: "search", pattern: "^(a+)+$", matches: 0 })], { timeoutMs: 300 }));
    assert.equal(r?.verdict, "unchecked", r?.reason);
    assert.match(r?.reason ?? "", /did not finish/);
    assert.ok(Date.now() - started < 10_000, "the limit stopped it");
  });

  it("a search never reads the install: node_modules is not a tracked file", async () => {
    const p = project();
    const [r] = await checkClaims(inputFor(p, [claim({ kind: "search", pattern: "main checkout", matches: 0 })]));
    assert.equal(r?.verdict, "verified", r?.reason);
  });

  it("making the read worktree runs no project hook", async () => {
    const p = project();
    const marker = join(p.repo, "..", `hook-ran-${Date.now()}.txt`);
    put(p.repo, ".git/hooks/post-checkout", `#!/bin/sh\necho ran > "${fwd(marker)}"\n`);
    const [r] = await checkClaims(inputFor(p, [claim({ kind: "line", path: "README.md", line: 1, text: "# project" })], { trust: "flag" }));
    assert.equal(r?.verdict, "verified", r?.reason);
    assert.equal(existsSync(marker), false, "the post-checkout hook did not run");
  });

  it("they run on an untrusted project with no containment: nothing is executed", async () => {
    const p = project();
    const [r] = await checkClaims(inputFor(p, [claim({ kind: "line", path: "README.md", line: 1, text: "# project" })], { trust: "flag" }));
    assert.equal(r?.verdict, "verified");
    assert.equal(r?.uncontained, undefined);
  });
});

describe("T234: a command check runs in a temporary worktree and compares the exit code (W5, W6)", () => {
  it("the expected exit is verified; a false claim is failed and says what the tool saw", async () => {
    const p = project();
    const [ok, lie, five] = await checkClaims(
      inputFor(p, [
        claim({ kind: "command", command: "node -e \"process.exit(0)\"", exit: 0 }),
        claim({ kind: "command", command: "node -e \"console.log('3 failing'); process.exit(1)\"", exit: 0 }, "all tests pass"),
        claim({ kind: "command", command: "node -e \"process.exit(5)\"", exit: 5 }),
      ]),
    );
    assert.equal(ok?.verdict, "verified", ok?.reason);
    assert.equal(lie?.verdict, "failed", "a claim that reads as a success does not decide the verdict");
    assert.match(lie?.reason ?? "", /exited 1.*expected 0/);
    assert.match(lie?.reason ?? "", /3 failing/);
    assert.equal(five?.verdict, "verified");
  });

  it("it runs at the final head, in a worktree: the main checkout is not touched", async () => {
    const p = project();
    const [r] = await checkClaims(
      inputFor(p, [claim({ kind: "command", command: "node -e \"require('fs').writeFileSync('scratch.txt','x'); process.exit(require('fs').readFileSync('src/math.mjs','utf8').includes('a - b') ? 0 : 3)\"", exit: 0 })]),
    );
    assert.equal(r?.verdict, "verified", r?.reason);
    assert.equal(existsSync(join(p.repo, "scratch.txt")), false);
  });

  it("a command that cannot run is unchecked, not failed", async () => {
    const p = project();
    const [r] = await checkClaims(inputFor(p, [claim({ kind: "command", command: "definitely-not-a-command-xyz", exit: 0 })]));
    assert.equal(r?.verdict, "unchecked", r?.reason);
    assert.match(r?.reason ?? "", /could not run/);
  });

  it("a command that does not finish in the time limit is unchecked, and nothing it started is left", async () => {
    const p = project();
    const pidFile = join(p.repo, "..", `pid-${Date.now()}.txt`);
    const [r] = await checkClaims(
      inputFor(
        p,
        [claim({ kind: "command", command: `node -e "require('fs').writeFileSync('${fwd(pidFile)}', String(process.pid)); setInterval(()=>{}, 1000)"`, exit: 0 })],
        { timeoutMs: 3000 },
      ),
    );
    assert.equal(r?.verdict, "unchecked", r?.reason);
    assert.match(r?.reason ?? "", /did not finish in 3s/);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.equal(await waitFor(() => !alive(pid)), true, "the command's process is gone");
  });
});

describe("T234: without containment a trusted project's check runs on the host, marked uncontained; an untrusted one is unchecked (ADR-0061)", () => {
  const marker = (p: Project) => join(p.repo, "..", `ran-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const writes = (file: string) => `node -e "require('fs').writeFileSync('${fwd(file)}', 'ran')"`;

  it("trusted (stored), containment off: it runs and the verdict is marked uncontained", async () => {
    const p = project();
    const file = marker(p);
    const [r] = await checkClaims(inputFor(p, [claim({ kind: "command", command: writes(file), exit: 0 })], { trust: "stored" }));
    assert.equal(r?.verdict, "verified", r?.reason);
    assert.equal(r?.uncontained, true);
    assert.equal(existsSync(file), true);
  });

  it("a trust answered at the prompt counts as the store", async () => {
    const p = project();
    const [r] = await checkClaims(inputFor(p, [claim({ kind: "command", command: "node -e \"\"", exit: 0 })], { trust: "prompt" }));
    assert.equal(r?.uncontained, true);
  });

  it("untrusted (a one-run flag, or none), containment off: unchecked with the reason, and nothing runs", async () => {
    for (const trust of ["flag", undefined] as const) {
      const p = project();
      const file = marker(p);
      const [command, repro] = await checkClaims(
        inputFor(
          p,
          [
            claim({ kind: "command", command: writes(file), exit: 0 }),
            claim({ kind: "reproduction", file: REPRO_FILE, content: REPRO, fails: ["adds two numbers"] }),
          ],
          { trust },
        ),
      );
      for (const r of [command, repro]) {
        assert.equal(r?.verdict, "unchecked", `${trust}: ${r?.reason}`);
        assert.match(r?.reason ?? "", /not trusted/);
        assert.match(r?.reason ?? "", /containment is off/);
        assert.equal(r?.uncontained, undefined);
      }
      assert.equal(existsSync(file), false, "the command never ran");
    }
  });

  it("with containment the check runs through the container's executor, on a project that is not trusted too, and is not marked uncontained", async () => {
    const p = project();
    const file = marker(p);
    let spawned = 0;
    let disposed = 0;
    const executor: ProjectExecutor = { ...localExecutor, spawn: (...args) => { spawned += 1; return localExecutor.spawn(...args); } };
    const [r] = await checkClaims(
      inputFor(p, [claim({ kind: "command", command: writes(file), exit: 0 })], {
        trust: "flag",
        containment: "required",
        deps: {
          startContained: async () => ({
            executor,
            record: { requested: "required", used: "required", runtime: "podman" },
            dispose: async () => { disposed += 1; },
          }),
        },
      }),
    );
    assert.equal(r?.verdict, "verified", r?.reason);
    assert.equal(r?.uncontained, undefined);
    assert.ok(spawned > 0, "the command went through the container's executor");
    assert.equal(disposed, 1);
  });

  it("containment asked for and not available (required, no runtime): unchecked with the runtime's reason, nothing runs on the host", async () => {
    const p = project();
    const file = marker(p);
    const [r] = await checkClaims(
      inputFor(p, [claim({ kind: "command", command: writes(file), exit: 0 })], {
        containment: "required",
        deps: { startContained: async () => { throw new Error('containment.level is "required" but no container runtime is available'); } },
      }),
    );
    assert.equal(r?.verdict, "unchecked");
    assert.match(r?.reason ?? "", /no container runtime/);
    assert.equal(existsSync(file), false);
  });
});

describe("T234: a reproduction runs through seal.test_command and proves a regression against the base", () => {
  it("fails on the branch and passes on the base: verified, and a regression", async () => {
    const p = project();
    const [r] = await checkClaims(inputFor(p, [claim({ kind: "reproduction", file: REPRO_FILE, content: REPRO, fails: ["adds two numbers"] })]));
    assert.equal(r?.verdict, "verified", r?.reason);
    assert.match(r?.reason ?? "", /adds two numbers/);
    assert.equal(r?.base?.verdict, "passes", r?.base?.reason);
    assert.equal(r?.regression, true);
    assert.equal(r?.uncontained, true);
  });

  it("fails on both: verified at the head, but the base fails too, so it is not a regression", async () => {
    const p = project();
    const alwaysRed = `import { test } from "node:test"; import assert from "node:assert/strict"; test("broken forever", () => assert.equal(1, 2));\n`;
    const [r] = await checkClaims(inputFor(p, [claim({ kind: "reproduction", file: REPRO_FILE, content: alwaysRed, fails: ["broken forever"] })]));
    assert.equal(r?.verdict, "verified", r?.reason);
    assert.equal(r?.base?.verdict, "fails");
    assert.equal(r?.regression, undefined, "the base fails too, so the change did not break it");
  });

  it("a named test that passes at the head makes the claim failed, naming it", async () => {
    const p = project();
    const [r] = await checkClaims(
      inputFor(p, [claim({ kind: "reproduction", file: REPRO_FILE, content: REPRO, fails: ["adds two numbers", "adds zero", "no such test"] })]),
    );
    assert.equal(r?.verdict, "failed");
    assert.match(r?.reason ?? "", /adds zero/);
    assert.match(r?.reason ?? "", /no such test/);
    assert.equal(r?.base, undefined, "the base is not asked about a reproduction that did not reproduce");
  });

  it("a test is named by its title, its suite and title, or its full path", async () => {
    const p = project();
    const results = await checkClaims(
      inputFor(p, [
        claim({ kind: "reproduction", file: REPRO_FILE, content: REPRO, fails: ["math > adds two numbers"] }),
        claim({ kind: "reproduction", file: REPRO_FILE, content: REPRO, fails: [`${REPRO_FILE} > math > adds two numbers`] }),
        claim({ kind: "reproduction", file: REPRO_FILE, content: REPRO, fails: ["numbers"] }),
      ]),
    );
    assert.deepEqual(results.map((r) => r.verdict), ["verified", "verified", "failed"], results.map((r) => r.reason).join(" | "));
  });

  it("a reproduction file that does not run is unchecked, with the runner's error: it never ran, so it shows nothing false", async () => {
    const p = project();
    const [r] = await checkClaims(inputFor(p, [claim({ kind: "reproduction", file: REPRO_FILE, content: "this is not javascript (\n", fails: ["x"] })]));
    assert.equal(r?.verdict, "unchecked", r?.reason);
    assert.match(r?.reason ?? "", /did not run/);
  });

  it("a reproduction kept at its own path with the same text is run, not refused (the fix brief keeps it as a test)", async () => {
    const p = project();
    put(p.repo, REPRO_FILE, REPRO.split(String.fromCharCode(10)).join(String.fromCharCode(13, 10)));
    git(p.repo, "add", "-A");
    git(p.repo, "commit", "-q", "-m", "keep the reproduction");
    const head = git(p.repo, "rev-parse", "HEAD");
    const [r] = await checkClaims(inputFor({ ...p, head }, [claim({ kind: "reproduction", file: REPRO_FILE, content: REPRO, fails: ["adds two numbers"] })], { base: undefined }));
    assert.equal(r?.verdict, "verified", r?.reason);
  });

  it("a reproduction whose path holds other text at the commit is still unchecked: it would replace that file", async () => {
    const p = project();
    put(p.repo, REPRO_FILE, REPRO.replace("adds zero", "adds nothing"));
    git(p.repo, "add", "-A");
    git(p.repo, "commit", "-q", "-m", "a changed reproduction");
    const head = git(p.repo, "rev-parse", "HEAD");
    const [r] = await checkClaims(inputFor({ ...p, head }, [claim({ kind: "reproduction", file: REPRO_FILE, content: REPRO, fails: ["adds two numbers"] })], { base: undefined }));
    assert.equal(r?.verdict, "unchecked");
    assert.match(r?.reason ?? "", /already exists/);
  });

  it("a reproduction whose path goes through the install's link is unchecked, and nothing is written outside the worktree", async () => {
    const p = project();
    const [r] = await checkClaims(inputFor(p, [claim({ kind: "reproduction", file: "node_modules/escape.test.mjs", content: REPRO, fails: ["adds two numbers"] })], { base: undefined }));
    assert.equal(r?.verdict, "unchecked", r?.reason);
    assert.match(r?.reason ?? "", /outside the worktree/);
    assert.equal(existsSync(join(p.repo, "node_modules", "escape.test.mjs")), false, "the main checkout's install is untouched");
  });

  it("a reproduction over a file the commit already has is unchecked: it would replace it", async () => {
    const p = project();
    const [r] = await checkClaims(inputFor(p, [claim({ kind: "reproduction", file: "src/math.mjs", content: REPRO, fails: ["adds two numbers"] })]));
    assert.equal(r?.verdict, "unchecked");
    assert.match(r?.reason ?? "", /already exists/);
  });

  it("a runner that reports no test names cannot attribute the named failures: unchecked, never verified", async () => {
    const p = project();
    const [r] = await checkClaims(
      inputFor(p, [claim({ kind: "reproduction", file: "tests/repro.js", content: "process.exit(1)\n", fails: ["adds two numbers"] })], { testCommand: "node {files}" }),
    );
    assert.equal(r?.verdict, "unchecked", r?.reason);
    assert.match(r?.reason ?? "", /no test names/);
  });

  it("a lockfile that differs between base and head makes the base verdict unknown", async () => {
    const p = project({ lockfileAtHead: '{"lockfileVersion":3,"v":2}\n' });
    const [r] = await checkClaims(inputFor(p, [claim({ kind: "reproduction", file: REPRO_FILE, content: REPRO, fails: ["adds two numbers"] })]));
    assert.equal(r?.verdict, "verified", r?.reason);
    assert.equal(r?.base?.verdict, "unknown");
    assert.match(r?.base?.reason ?? "", /lockfile differs/);
  });

  it("no base given: the base is not asked", async () => {
    const p = project();
    const [r] = await checkClaims(inputFor(p, [claim({ kind: "reproduction", file: REPRO_FILE, content: REPRO, fails: ["adds two numbers"] })], { base: undefined }));
    assert.equal(r?.verdict, "verified");
    assert.equal(r?.base, undefined);
  });
});

describe("T234: a check's processes are proven stopped before its worktree is removed", () => {
  /** A reproduction whose test fails and leaves a background process running that outlives the test run. */
  function leaver(pidFile: string): string {
    return `
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
test("leaves a process behind", () => {
  const child = spawn(process.execPath, ["-e", "require('fs').writeFileSync(" + JSON.stringify(${JSON.stringify(pidFile)}) + ", String(process.pid)); setInterval(() => {}, 1000)"], { stdio: "ignore" });
  child.unref();
  // The leftover is running before the test fails: wait until it has written its pid.
  const until = Date.now() + 15000;
  while (!existsSync(${JSON.stringify(pidFile)}) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  assert.equal(1, 2);
});
`;
  }

  it("a reproduction's leftover process is gone before the worktree is removed", async () => {
    const p = project();
    const pidFile = join(p.repo, "..", `leftover-${Date.now()}.txt`);
    const events: Array<{ dir: string; aliveAtRemoval: boolean }> = [];
    const [r] = await checkClaims(
      inputFor(p, [claim({ kind: "reproduction", file: REPRO_FILE, content: leaver(pidFile), fails: ["leaves a process behind"] })], {
        base: undefined,
        deps: {
          createWorktree: (cwd, commit, env) => {
            const wt = createTemporaryWorktree(cwd, commit, env);
            return {
              dir: wt.dir,
              cleanup: () => {
                const pid = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8")) : 0;
                events.push({ dir: wt.dir, aliveAtRemoval: pid > 0 && alive(pid) });
                wt.cleanup();
              },
            };
          },
        },
      }),
    );
    assert.equal(r?.verdict, "verified", r?.reason);
    assert.equal(existsSync(pidFile), true, "the test did start its leftover");
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.equal(alive(pid), false, "the leftover is gone when the check returns");
    assert.ok(events.length > 0, "the worktree was removed");
    assert.deepEqual(events.map((e) => e.aliveAtRemoval), events.map(() => false), "it was gone before every removal");
    assert.ok(events.every((e) => !existsSync(e.dir)), "and the worktrees are gone");
  });

  it("a process the guard's tree still lists is killed and then confirmed gone, whatever started it", async () => {
    // A detached leftover leaves the guard's job object; the OS lookup of the guard's tree is what finds it (T256).
    const p = project();
    const pidFile = join(p.repo, "..", `escaped-${Date.now()}.txt`);
    const detached = leaver(pidFile).replace('{ stdio: "ignore" }', '{ detached: true, stdio: "ignore" }');
    assert.notEqual(detached, leaver(pidFile), "the leftover is detached");
    const listed = (): number[] => (existsSync(pidFile) && alive(Number(readFileSync(pidFile, "utf8"))) ? [Number(readFileSync(pidFile, "utf8"))] : []);
    const [r] = await checkClaims(
      inputFor(p, [claim({ kind: "reproduction", file: REPRO_FILE, content: detached, fails: ["leaves a process behind"] })], {
        base: undefined,
        deps: { quiescence: { treeOf: listed } },
      }),
    );
    assert.equal(r?.verdict, "verified", r?.reason);
    assert.doesNotMatch(r?.reason ?? "", /not proven stopped/, "it was killed and confirmed, not left");
    assert.equal(alive(Number(readFileSync(pidFile, "utf8"))), false, "the escaped leftover is gone");
  });

  it("a reproduction that does not finish in the time limit is unchecked and its processes are gone", async () => {
    const p = project();
    const pidFile = join(p.repo, "..", `hang-${Date.now()}.txt`);
    const hang = `
import { test } from "node:test";
import { writeFileSync } from "node:fs";
test("hangs", () => { writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000); return new Promise(() => {}); });
`;
    const [r] = await checkClaims(inputFor(p, [claim({ kind: "reproduction", file: REPRO_FILE, content: hang, fails: ["hangs"] })], { timeoutMs: 4000, base: undefined }));
    assert.equal(r?.verdict, "unchecked", r?.reason);
    assert.match(r?.reason ?? "", /did not finish in 4s/);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.equal(await waitFor(() => !alive(pid)), true, "the hung test process is gone");
  });

  it("a process that cannot be proven stopped keeps the worktree and says so (fail-closed)", async () => {
    const p = project();
    const removed: string[] = [];
    const [r] = await checkClaims(
      inputFor(p, [claim({ kind: "command", command: "node -e \"\"", exit: 0 })], {
        deps: {
          quiescence: { livenessOf: () => "unknown", treeOf: () => undefined },
          createWorktree: (cwd, commit, env) => {
            const wt = createTemporaryWorktree(cwd, commit, env);
            return { dir: wt.dir, cleanup: () => { removed.push(wt.dir); wt.cleanup(); } };
          },
        },
      }),
    );
    assert.equal(r?.verdict, "verified", "what the check saw still stands");
    assert.match(r?.reason ?? "", /not proven stopped/);
    assert.deepEqual(removed, [], "the worktree was not removed");
  });

  it("a reproduction that times out and keeps its worktree says both", async () => {
    const p = project();
    const hang = `
import { test } from "node:test";
test("hangs", () => new Promise(() => {}));
`;
    const [r] = await checkClaims(
      inputFor(p, [claim({ kind: "reproduction", file: REPRO_FILE, content: hang, fails: ["hangs"] })], {
        timeoutMs: 3000,
        base: undefined,
        deps: { quiescence: { livenessOf: () => "unknown", treeOf: () => undefined } },
      }),
    );
    assert.equal(r?.verdict, "unchecked", r?.reason);
    assert.match(r?.reason ?? "", /did not finish in 3s/);
    assert.match(r?.reason ?? "", /worktree was kept/);
  });

  it("a proof of stopping that throws keeps the worktree: a throw proves nothing (fail-closed)", async () => {
    const p = project();
    const removed: string[] = [];
    const [r] = await checkClaims(
      inputFor(p, [claim({ kind: "command", command: "node -e \"\"", exit: 0 })], {
        deps: {
          quiescence: { livenessOf: () => { throw new Error("the OS lookup failed"); }, treeOf: () => undefined },
          createWorktree: (cwd, commit, env) => {
            const wt = createTemporaryWorktree(cwd, commit, env);
            return { dir: wt.dir, cleanup: () => { removed.push(wt.dir); wt.cleanup(); } };
          },
        },
      }),
    );
    assert.match(r?.reason ?? "", /could not be proven stopped.*the OS lookup failed/);
    assert.deepEqual(removed, [], "the worktree was not removed");
  });

  it("a container that cannot be removed keeps the worktree it may still mount (fail-closed)", async () => {
    const p = project();
    const removed: string[] = [];
    const [r] = await checkClaims(
      inputFor(p, [claim({ kind: "command", command: "node -e \"\"", exit: 0 })], {
        containment: "required",
        deps: {
          startContained: async () => ({
            executor: localExecutor,
            record: { requested: "required", used: "required", runtime: "podman" },
            dispose: async () => { throw new Error("podman rm failed"); },
          }),
          createWorktree: (cwd, commit, env) => {
            const wt = createTemporaryWorktree(cwd, commit, env);
            return { dir: wt.dir, cleanup: () => { removed.push(wt.dir); wt.cleanup(); } };
          },
        },
      }),
    );
    assert.equal(r?.verdict, "verified", r?.reason);
    assert.match(r?.reason ?? "", /container could not be removed.*podman rm failed/);
    assert.deepEqual(removed, [], "the worktree was not removed");
  });
});

describe("T234: removing a check's worktree never follows its node_modules junction (G7)", () => {
  it("the main checkout's install is intact after a command and a reproduction ran", async () => {
    const p = project();
    const marker = join(p.repo, "node_modules", "marker.txt");
    const results = await checkClaims(
      inputFor(p, [
        claim({ kind: "command", command: "node -e \"process.exit(require('fs').existsSync('node_modules/marker.txt') ? 0 : 4)\"", exit: 0 }),
        claim({ kind: "reproduction", file: REPRO_FILE, content: REPRO, fails: ["adds two numbers"] }),
      ]),
    );
    assert.equal(results[0]?.verdict, "verified", "the worktree did have the junction: " + results[0]?.reason);
    assert.equal(results[1]?.verdict, "verified", results[1]?.reason);
    assert.equal(existsSync(marker), true, "the main node_modules still holds its file");
    assert.equal(readFileSync(marker, "utf8"), "the main checkout's install\n");
  });
});

describe("T234: a check that throws is unchecked, never a thrown error", () => {
  it("a head that names no commit leaves every claim unchecked with the reason", async () => {
    const p = project();
    const results = await checkClaims(inputFor(p, [claim({ kind: "line", path: "README.md", line: 1, text: "#" })], { head: "no-such-ref" }));
    assert.equal(results[0]?.verdict, "unchecked");
    assert.match(results[0]?.reason ?? "", /no-such-ref/);
  });
});

describe("T234: a session that wrote in the caller's tree is checked at its commits when it left nothing uncommitted", () => {
  function inPlaceClaim(p: Project): void {
    const ledger = openLedgerSync(defaultLedgerPath(p.repo));
    try {
      recordClaim(ledger, "inplace", "README's first line is the title", { kind: "line", path: "README.md", line: 1, text: "# a title it never wrote" });
    } finally {
      ledger.close();
    }
  }
  const judge = (p: Project) =>
    judgeSessionClaims({ workspace: p.repo, ledgerPath: defaultLedgerPath(p.repo), sessionId: "inplace", head: "HEAD", base: p.base, wroteInPlace: true, trust: "stored", containment: "off", testCommand: "node --test {files}" });

  it("committed work: a false claim is failed, so it raises MISREPORT", async () => {
    const p = project();
    inPlaceClaim(p);
    const report = await judge(p);
    assert.equal(report?.claims[0]?.verdict, "failed", report?.claims[0]?.reason);
    assert.equal(report?.misreports.length, 1);
  });

  it("a change left uncommitted: unchecked, naming it", async () => {
    const p = project();
    put(p.repo, "README.md", "# a title it never wrote\n");
    inPlaceClaim(p);
    const report = await judge(p);
    assert.equal(report?.claims[0]?.verdict, "unchecked");
    assert.match(report?.claims[0]?.reason ?? "", /not committed \(README\.md\)/);
  });
});
