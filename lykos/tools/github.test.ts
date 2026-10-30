// `github`: D1's argument arrays, D2's two sentences, D3's gate tiers and D4's
// stub.
//
// **NO TEST HERE REACHES GITHUB, AND NONE CAN.** Every test builds the tool
// with an injected `GhRunner`; `LOCAL_GH_RUNNER` — the only thing in
// `github.ts` that spawns anything — is never constructed. The stub records
// every invocation, and the tests assert on what WOULD have been spawned. This
// repository is local-only and has no remote; nothing here adds one.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  DenialLog,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
} from "../gate/approval.js";
import { decideForMode, tierForAction } from "../gate/modes.js";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { measureToolset } from "../ledger/tool-schema.js";
import {
  GH_MISSING_NOTICE,
  GH_NO_REPO_NOTICE,
  GH_UNAUTHENTICATED_NOTICE,
  GITHUB_DESCRIPTION,
  GITHUB_OPS,
  GITHUB_PARAMETERS,
  GITHUB_TOOL_NAME,
  GITHUB_WRITE_OPS,
  buildGithubTool,
  ghArgsFor,
  isAuthFailure,
  isNoRepoFailure,
  writeSummaryFor,
  type GhCommandResult,
  type GhRunner,
} from "./github.js";
import { riskForTool, tierForTool } from "./tool-risk.js";
import { tierForToolCall } from "./tool-call.js";
import { DEFAULT_RESIDENT_TOOLS, MOUNTED_TOOLS } from "./tool-surface.js";

function asJson(schema: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

class RecordingGate implements ApprovalGate {
  readonly seen: ApprovalRequest[] = [];
  constructor(private readonly answer: ApprovalDecision = "allow") {}
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.seen.push(req);
    return this.answer;
  }
}

interface Invocation {
  command: "gh" | "git";
  args: string[];
}

function ok(stdout: string, code = 0): GhCommandResult {
  return { status: "ok", code, stdout, stderr: "", truncated: false };
}

function failed(stderr: string, code = 1): GhCommandResult {
  return { status: "ok", code, stdout: "", stderr, truncated: false };
}

/**
 * D4's stub. `answers` is consulted by the first argument of the call, so a
 * test that needs `git rev-parse` to succeed and `gh pr create` to fail can
 * say so without writing a switch.
 */
class StubRunner implements GhRunner {
  readonly calls: Invocation[] = [];
  constructor(private readonly answer: (inv: Invocation) => GhCommandResult = () => ok("")) {}
  async run(command: "gh" | "git", args: readonly string[]): Promise<GhCommandResult> {
    const inv: Invocation = { command, args: [...args] };
    this.calls.push(inv);
    return this.answer(inv);
  }
}

interface Harness {
  dir: string;
  tool: ToolDefinition;
  gate: RecordingGate;
  denials: DenialLog;
  runner: StubRunner;
  dispose: () => void;
}

function harness(
  answer: (inv: Invocation) => GhCommandResult = () => ok(""),
  decision: ApprovalDecision = "allow",
): Harness {
  const dir = mkdtempSync(join(tmpdir(), "lykos-github-"));
  const gate = new RecordingGate(decision);
  const denials = new DenialLog();
  const runner = new StubRunner(answer);
  const tool = buildGithubTool({ cwd: dir, gate, denials, runner });
  return {
    dir,
    tool,
    gate,
    denials,
    runner,
    dispose: () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        // A Windows handle still closing is not a test failure.
      }
    },
  };
}

async function call(h: Harness, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; details: any }> {
  const result = (await h.tool.execute("call-1", args as never, undefined as never, undefined as never, undefined as never)) as {
    content?: Array<{ text?: string }>;
    isError?: boolean;
    details?: unknown;
  };
  return {
    text: result.content?.map((c) => c.text ?? "").join("\n") ?? "",
    isError: result.isError === true,
    details: result.details as any,
  };
}

// ---------------------------------------------------------------------------
// D10: the catalog prices what github would send
// ---------------------------------------------------------------------------

describe("P10.6 D10: the catalog prices what github would send", () => {
  it("the row equals the live definition, description and parameters both", () => {
    const row = TOOL_CATALOG.github;
    assert.ok(row);
    assert.equal(row.name, GITHUB_TOOL_NAME);
    assert.equal(row.source, "lykos");
    assert.equal(row.description, GITHUB_DESCRIPTION);
    assert.deepEqual(row.parameters, asJson(GITHUB_PARAMETERS));
  });

  // Measured with `measureToolset` on SCHEMA_TOKENS_BASIS, 2026-09-21. The
  // last two assertions are the point of D10: a tool with eighteen schema
  // properties was added and the resident surface did not move a single
  // token, because it is mounted.
  it("costs 734 tokens if it ever goes resident, and 0 today", () => {
    const alone = measureToolset([GITHUB_TOOL_NAME]);
    assert.equal(alone.complete, true);
    assert.equal(alone.tokens, 734);
    assert.equal(alone.bytes, 2935);
    // P10.7 (ticket 12): 1423 until this line was last touched, and 2062 now.
    // The resident total MOVED for the first time since P10.4, because
    // `web_search` (314 alone) and `web_fetch` (326 alone) were made RESIDENT
    // rather than mounted — 639 together, since array wrapping means the pair
    // is not the sum of the two. Nothing about this file's tool moved; this
    // line prices the surface it is being compared against.
    assert.equal(measureToolset(DEFAULT_RESIDENT_TOOLS).tokens, 2255);
    assert.equal(DEFAULT_RESIDENT_TOOLS.includes(GITHUB_TOOL_NAME), false);
    // The mounted set is what moved: 5322 tokens after P10.6's memory five,
    // 6430 once `eval` (376) and `github` (734) joined it, 8605 once
    // P10.6's ticket 20 mounted the nine session and context tools, and 9027
    // once P10.8 mounted `security_scan`. None of it rides a
    // request — `tool_call` fetches one schema at a time — but an unpriced
    // tool makes the whole toolset NULL rather than a silent undercount.
    assert.equal(measureToolset(MOUNTED_TOOLS).tokens, 9023);
    assert.equal(MOUNTED_TOOLS.includes(GITHUB_TOOL_NAME), true);
  });

  it("is declared hard-write, the ceiling its three write operations reach", () => {
    assert.equal(tierForTool(GITHUB_TOOL_NAME), "hard-write");
    assert.deepEqual(riskForTool(GITHUB_TOOL_NAME), { tier: "hard-write", idempotent: false, openWorld: true });
    assert.equal(tierForToolCall("tool_call", { name: GITHUB_TOOL_NAME, arguments: {} }), "hard-write");
  });
});

// ---------------------------------------------------------------------------
// D1: nine operations, and an argument array for each
// ---------------------------------------------------------------------------

describe("P10.6 D1: nine operations, built as argument arrays", () => {
  it("names exactly the nine, and refuses anything else by naming them", async () => {
    assert.deepEqual(
      [...GITHUB_OPS],
      ["repo_view", "file_read", "issue_list", "issue_view", "search_code", "run_watch", "pr_create", "pr_checkout", "pr_push"],
    );
    const h = harness();
    try {
      const res = await call(h, { op: "merge_everything" });
      assert.equal(res.isError, true);
      assert.match(res.text, /repo_view/);
      assert.equal(h.runner.calls.length, 0);
      assert.equal(h.gate.seen.length, 0);
    } finally {
      h.dispose();
    }
  });

  it("builds argv, never a command line — every argument is its own element", () => {
    // The proof that there is no shell string to have a quoting bug in: a PR
    // title full of shell metacharacters is ONE array element, untouched.
    const nasty = 'fix: `rm -rf /` && echo "pwned" | tee $HOME/x';
    const args = ghArgsFor("pr_create", { title: nasty, body: "" });
    assert.ok(args.includes(nasty), "the title was rewritten on its way to argv");
    assert.equal(args.filter((a) => a === nasty).length, 1);
    for (const arg of args) {
      assert.equal(typeof arg, "string");
    }
    assert.deepEqual(args, ["pr", "create", "--title", nasty, "--body", ""]);
  });

  it("each operation's argv is the documented gh invocation", () => {
    assert.deepEqual(ghArgsFor("repo_view", { repo: "acme/widgets" }).slice(0, 3), ["repo", "view", "acme/widgets"]);
    assert.deepEqual(ghArgsFor("repo_view", {}).slice(0, 2), ["repo", "view"]);

    assert.deepEqual(ghArgsFor("file_read", { path: "src/a b.ts", branch: "main" }, { repo: "acme/widgets" }), [
      "api",
      "/repos/acme/widgets/contents/src/a%20b.ts",
      "--method",
      "GET",
      "-H",
      "Accept: application/vnd.github.raw+json",
      "-f",
      "ref=main",
    ]);

    assert.deepEqual(ghArgsFor("issue_list", { repo: "acme/widgets", state: "closed", limit: 3 }), [
      "issue",
      "list",
      "--repo",
      "acme/widgets",
      "--limit",
      "3",
      "--state",
      "closed",
    ]);
    assert.deepEqual(ghArgsFor("issue_view", { issue: "42" }).slice(0, 3), ["issue", "view", "42"]);
    assert.deepEqual(ghArgsFor("search_code", { query: "openLedger", limit: 200 }), [
      "search",
      "code",
      "openLedger",
      "--limit",
      "50",
    ]);
    assert.deepEqual(ghArgsFor("run_watch", { run: "12345" }), ["run", "watch", "12345", "--exit-status"]);
    assert.deepEqual(ghArgsFor("pr_checkout", { pr: "7", force: true }), ["pr", "checkout", "7", "--force"]);
    assert.deepEqual(ghArgsFor("pr_push", { force_with_lease: true }, { branch: "feature/x" }), [
      "push",
      "--force-with-lease",
      "origin",
      "HEAD:refs/heads/feature/x",
    ]);
  });

  it("clamps a limit rather than forwarding whatever was asked for", () => {
    assert.equal(ghArgsFor("issue_list", { limit: 0 }).join(" ").includes("--limit 10"), true);
    assert.equal(ghArgsFor("issue_list", { limit: 999 }).join(" ").includes("--limit 50"), true);
    assert.equal(ghArgsFor("issue_list", { limit: 7.9 }).join(" ").includes("--limit 7"), true);
  });

  it("pr_create passes an explicit empty body, so gh never opens an editor", () => {
    const args = ghArgsFor("pr_create", { title: "t" });
    const at = args.indexOf("--body");
    assert.notEqual(at, -1, "no --body means gh opens an interactive editor nobody can close");
    assert.equal(args[at + 1], "");
  });

  it("pr_push is the one operation that is git, not gh", async () => {
    const h = harness((inv) => (inv.args[0] === "rev-parse" ? ok("feature/x\n") : ok("Everything up-to-date")));
    try {
      const res = await call(h, { op: "pr_push", repo: "acme/widgets" });
      assert.equal(res.isError, false, res.text);
      const push = h.runner.calls.find((c) => c.args[0] === "push");
      assert.ok(push, "nothing was pushed");
      assert.equal(push.command, "git");
      assert.deepEqual(push.args, ["push", "origin", "HEAD:refs/heads/feature/x"]);
    } finally {
      h.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// D2: a missing or unauthenticated gh is a sentence
// ---------------------------------------------------------------------------

describe("P10.6 D2: a missing or unauthenticated gh is a sentence, not an exception", () => {
  it("with no gh installed, says so by naming gh and how to install it", async () => {
    const h = harness(() => ({ status: "missing", code: null, stdout: "", stderr: "", truncated: false }));
    try {
      // The whole point: this does not throw, and the caller gets prose.
      const res = await call(h, { op: "repo_view" });
      assert.equal(res.text, GH_MISSING_NOTICE);
      assert.match(res.text, /`gh`/);
      assert.match(res.text, /gh auth login/);
      assert.match(res.text, /install/i);
      // Not an error, for `lsp`'s reason: "you have not installed gh" is an
      // answer, and an error is what makes a model retry.
      assert.equal(res.isError, false);
      assert.equal(res.details.available, false);
      assert.equal(res.details.success, false);
      // And it is not a spawn error, a stack or a CLI usage dump.
      assert.doesNotMatch(res.text, /ENOENT|spawn|Usage:|at Object\./);
    } finally {
      h.dispose();
    }
  });

  it("with gh unauthenticated, says to run gh auth login and nothing else", async () => {
    const h = harness(() => failed("gh: You are not logged into any GitHub hosts. Run gh auth login to authenticate."));
    try {
      const res = await call(h, { op: "issue_list" });
      assert.equal(res.text, GH_UNAUTHENTICATED_NOTICE);
      assert.equal(res.isError, false);
      assert.equal(res.details.available, false);
      // The raw CLI complaint does not reach the model.
      assert.doesNotMatch(res.text, /not logged into any GitHub hosts/);
    } finally {
      h.dispose();
    }
  });

  it("with no repository context, names `repo` rather than repeating gh's error", async () => {
    const h = harness(() => failed("failed to run git: no git remotes found"));
    try {
      const res = await call(h, { op: "repo_view" });
      assert.equal(res.text, GH_NO_REPO_NOTICE);
      assert.match(res.text, /repo/);
      assert.equal(res.isError, false);
    } finally {
      h.dispose();
    }
  });

  it("any OTHER gh failure keeps gh's own account of it, because that is the useful part", async () => {
    const h = harness(() => failed("could not find pull request #9999"));
    try {
      const res = await call(h, { op: "issue_view", issue: "9999" });
      assert.equal(res.isError, true);
      assert.match(res.text, /could not find pull request/);
      assert.equal(res.details.exitCode, 1);
    } finally {
      h.dispose();
    }
  });

  it("the two classifiers recognise what they are for, and not each other", () => {
    assert.equal(isAuthFailure("gh: Bad credentials (HTTP 401)"), true);
    assert.equal(isAuthFailure("To get started with GitHub CLI, please run: gh auth login"), true);
    assert.equal(isAuthFailure("could not find pull request"), false);
    assert.equal(isNoRepoFailure("none of the git remotes configured for this repository point to a known GitHub host"), true);
    assert.equal(isNoRepoFailure("gh: Bad credentials"), false);
  });
});

// ---------------------------------------------------------------------------
// D3: the gate
// ---------------------------------------------------------------------------

describe("P10.6 D3: read operations reach the gate at the read tier", () => {
  it("asks as a read, and Auto lets it through without a prompt", async () => {
    const h = harness(() => ok("{}"));
    try {
      await call(h, { op: "repo_view", repo: "acme/widgets" });
      assert.equal(h.gate.seen.length, 1);
      assert.equal(h.gate.seen[0]!.kind, "read");
      // Not a bash request: no POSIX classifier runs over a `gh` argv.
      assert.notEqual(h.gate.seen[0]!.kind, "bash");
      assert.equal(h.gate.seen[0]!.shell, undefined);

      assert.equal(tierForAction({ kind: "read" }), "read");
      for (const mode of ["manual", "accept-edits", "auto"] as const) {
        assert.equal(decideForMode(mode, { kind: "read" }, new Set()).verdict, "allow");
      }
    } finally {
      h.dispose();
    }
  });

  it("every one of the six reads asks at the read tier", async () => {
    const h = harness((inv) => (inv.args[0] === "run" && inv.args[1] === "list" ? ok("42\n") : ok("{}")));
    try {
      await call(h, { op: "repo_view" });
      await call(h, { op: "file_read", path: "a.ts", repo: "acme/widgets" });
      await call(h, { op: "issue_list" });
      await call(h, { op: "issue_view", issue: "1" });
      await call(h, { op: "search_code", query: "x" });
      await call(h, { op: "run_watch", branch: "main" });
      assert.equal(h.gate.seen.length, 6);
      for (const req of h.gate.seen) assert.equal(req.kind, "read");
    } finally {
      h.dispose();
    }
  });
});

describe("P10.6 D3: pr_* reach the gate as writes, and the summary says what becomes visible", () => {
  it("asks as a github write at the hard-write tier, which Auto stops on", async () => {
    const h = harness((inv) => (inv.args[0] === "rev-parse" ? ok("feature/x\n") : ok("https://example.invalid/pr/1")));
    try {
      await call(h, { op: "pr_create", repo: "acme/widgets", title: "t", base: "main" });
      assert.equal(h.gate.seen.length, 1);
      const req = h.gate.seen[0]!;
      assert.equal(req.kind, "github");
      assert.match(req.summary, /acme\/widgets/);
      assert.match(req.summary, /visible/);

      assert.equal(tierForAction({ kind: "github" }), "hard-write");
      for (const mode of ["manual", "accept-edits", "auto"] as const) {
        const decision = decideForMode(mode, { kind: "github" }, new Set());
        assert.equal(decision.verdict, "ask", `Auto and others must stop before something other people can see: ${mode}`);
        assert.equal(decision.tier, "hard-write");
      }
    } finally {
      h.dispose();
    }
  });

  it("the summary names the repository and the branch for each of the three", () => {
    assert.match(writeSummaryFor("pr_create", { repo: "acme/widgets", base: "main" }, "feature/x"), /acme\/widgets/);
    assert.match(writeSummaryFor("pr_create", { repo: "acme/widgets", base: "main" }, "feature/x"), /feature\/x/);
    assert.match(writeSummaryFor("pr_create", { repo: "acme/widgets", base: "main" }, "feature/x"), /main/);
    assert.match(writeSummaryFor("pr_push", { repo: "acme/widgets" }, "feature/x"), /feature\/x/);
    assert.match(writeSummaryFor("pr_push", { repo: "acme/widgets" }, "feature/x"), /visible/);
    assert.match(writeSummaryFor("pr_checkout", { repo: "acme/widgets", pr: "7" }, undefined), /7/);
    // With no `repo` given, it says whose repository it is rather than making
    // a network call to find out before the human has said yes.
    assert.match(writeSummaryFor("pr_push", {}, "feature/x"), /current checkout/);
  });

  it("declares exactly three write operations", () => {
    assert.deepEqual([...GITHUB_WRITE_OPS], ["pr_create", "pr_checkout", "pr_push"]);
  });

  it("a declined write sends nothing and is recorded as a refusal", async () => {
    const h = harness(() => ok(""), "deny");
    try {
      const res = await call(h, { op: "pr_checkout", repo: "acme/widgets", pr: "7" });
      assert.equal(res.isError, true);
      assert.match(res.text, /declined/);
      assert.equal(h.runner.calls.length, 0, "a declined pull-request checkout ran anyway");
      assert.equal(h.denials.userRejected, 1);
    } finally {
      h.dispose();
    }
  });

  it("nothing is sent before the human answers", async () => {
    // The gate is asked FIRST, so a `deny` means no network call happened at
    // all rather than one that was undone.
    const h = harness(() => ok(""), "deny");
    try {
      await call(h, { op: "search_code", query: "secret" });
      assert.equal(h.runner.calls.length, 0);
      assert.equal(h.gate.seen.length, 1);
    } finally {
      h.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Local validation, and the two resolutions
// ---------------------------------------------------------------------------

describe("P10.6: what github refuses locally, before spawning anything", () => {
  it("file_read needs a repository-relative path", async () => {
    const h = harness();
    try {
      const missing = await call(h, { op: "file_read" });
      assert.equal(missing.isError, true);
      assert.match(missing.text, /needs a `path`/);

      const absolute = await call(h, { op: "file_read", path: "/etc/passwd" });
      assert.equal(absolute.isError, true);
      assert.match(absolute.text, /repository-relative/);
      assert.equal(h.runner.calls.length, 0);
      assert.equal(h.gate.seen.length, 0, "a call that cannot run must not ask a human about it");
    } finally {
      h.dispose();
    }
  });

  it("pr_create refuses fill together with title or body", async () => {
    const h = harness();
    try {
      const both = await call(h, { op: "pr_create", fill: true, title: "t" });
      assert.equal(both.isError, true);
      assert.match(both.text, /cannot be combined/);
      const neither = await call(h, { op: "pr_create" });
      assert.equal(neither.isError, true);
      assert.match(neither.text, /needs a `title`/);
      assert.equal(h.runner.calls.length, 0);
    } finally {
      h.dispose();
    }
  });

  it("file_read resolves the current repository when none was given", async () => {
    const h = harness((inv) => (inv.args[0] === "repo" ? ok("acme/widgets\n") : ok("file contents here")));
    try {
      const res = await call(h, { op: "file_read", path: "README.md" });
      assert.equal(res.isError, false, res.text);
      assert.equal(res.text.trim(), "file contents here");
      assert.equal(res.details.repo, "acme/widgets");
      const api = h.runner.calls.find((c) => c.args[0] === "api");
      assert.ok(api);
      assert.equal(api.args[1], "/repos/acme/widgets/contents/README.md");
    } finally {
      h.dispose();
    }
  });

  it("run_watch with no run id finds the newest run on the branch", async () => {
    const h = harness((inv) => (inv.args[1] === "list" ? ok("987654\n") : ok("run succeeded")));
    try {
      const res = await call(h, { op: "run_watch", branch: "main" });
      assert.equal(res.isError, false, res.text);
      assert.equal(res.details.run, "987654");
      const watch = h.runner.calls.find((c) => c.args[1] === "watch");
      assert.ok(watch);
      assert.deepEqual(watch.args, ["run", "watch", "987654", "--exit-status"]);
    } finally {
      h.dispose();
    }
  });

  it("run_watch says so when there is no run to watch, rather than watching nothing", async () => {
    const h = harness((inv) => (inv.args[1] === "list" ? ok("\n") : ok("")));
    try {
      const res = await call(h, { op: "run_watch", branch: "main" });
      assert.equal(res.isError, false);
      assert.match(res.text, /nothing to watch/);
      assert.equal(res.details.runs, 0);
    } finally {
      h.dispose();
    }
  });

  it("renders repo_view's JSON as lines rather than handing back a blob", async () => {
    const h = harness(() =>
      ok(
        JSON.stringify({
          nameWithOwner: "acme/widgets",
          description: "a thing",
          url: "https://example.invalid/acme/widgets",
          defaultBranchRef: { name: "main" },
          visibility: "PUBLIC",
          primaryLanguage: { name: "TypeScript" },
          stargazerCount: 3,
        }),
      ),
    );
    try {
      const res = await call(h, { op: "repo_view", repo: "acme/widgets" });
      assert.match(res.text, /^# acme\/widgets/);
      assert.match(res.text, /default branch: main/);
      assert.match(res.text, /language: TypeScript/);
      assert.match(res.text, /stars: 3/);
    } finally {
      h.dispose();
    }
  });

  it("says when output was cut rather than returning a silent prefix", async () => {
    const h = harness(() => ({ status: "ok", code: 0, stdout: "partial", stderr: "", truncated: true }));
    try {
      const res = await call(h, { op: "issue_list" });
      assert.equal(res.details.truncated, true);
      assert.match(res.text, /cut here/);
    } finally {
      h.dispose();
    }
  });

  it("a spawn that never finished is reported as one, not as an empty result", async () => {
    const h = harness(() => ({
      status: "failed",
      code: null,
      stdout: "",
      stderr: "",
      truncated: false,
      reason: "`gh run watch 1` did not finish within 300s and was killed.",
    }));
    try {
      const res = await call(h, { op: "run_watch", run: "1" });
      assert.equal(res.isError, true);
      assert.match(res.text, /did not finish within 300s/);
    } finally {
      h.dispose();
    }
  });
});
