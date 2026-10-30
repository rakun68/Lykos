// `commit`: the gate it asks, the git it runs, the registry and catalog rows
// that price it. The whole-session behaviour (the commit exists, no hook runs,
// `lykos show`, no repository) is `cli/commit-session.test.ts`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DenialLog, type ApprovalDecision, type ApprovalGate, type ApprovalRequest } from "../gate/approval.js";
import { tierForAction } from "../gate/modes.js";
import type { GitRun } from "../git/host-git.js";
import { READ_ONLY_CHILD_TOOLS } from "../session/boot.js";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { COMMIT_DESCRIPTION, COMMIT_PARAMETERS, COMMIT_TOOL_NAME, CommitLog, buildCommitTool } from "./commit.js";
import { loadTools } from "./session-tools.js";
import { riskForTool, tierForTool } from "./tool-risk.js";
import { DEFAULT_RESIDENT_TOOLS, MOUNTED_TOOLS } from "./tool-surface.js";

class RecordingGate implements ApprovalGate {
  readonly seen: ApprovalRequest[] = [];
  constructor(private readonly answer: ApprovalDecision = "allow") {}
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.seen.push(req);
    return this.answer;
  }
}

/** A git that records its argv and answers like a repository with one change to commit. */
function stubGit() {
  const calls: string[][] = [];
  const envs: Array<NodeJS.ProcessEnv | undefined> = [];
  const git = (args: string[], _cwd?: string, env?: NodeJS.ProcessEnv): GitRun => {
    calls.push(args);
    envs.push(env);
    const verb = args.find((a) => ["add", "diff", "commit", "rev-parse", "show", "read-tree", "reset"].includes(a));
    if (verb === "diff" && args.includes("--name-only")) return { ok: true, stdout: "", stderr: "" }; // nothing staged by the person
    if (verb === "diff") return { ok: false, stdout: "", stderr: "" }; // exit 1: something is staged
    if (verb === "rev-parse") return { ok: true, stdout: "a".repeat(40), stderr: "" };
    if (verb === "show") return { ok: true, stdout: "x.txt\ny.txt", stderr: "" };
    return { ok: true, stdout: "", stderr: "" };
  };
  return { git, calls, envs };
}

/** What the model is sent: the result text, and whether the call failed (Pi turns a throw into an error result). */
async function run(tool: ToolDefinition, params: Record<string, unknown>) {
  try {
    const out = (await tool.execute("id", params as never, undefined, undefined, undefined as never)) as {
      content: Array<{ text: string }>;
    };
    return { isError: false, text: out.content[0]!.text };
  } catch (err) {
    return { isError: true, text: (err as Error).message };
  }
}

describe("commit: the gate (T179, story 22)", () => {
  it("asks with the edit kind, naming the message, before it stages anything", async () => {
    const gate = new RecordingGate();
    const { git, calls } = stubGit();
    const tool = buildCommitTool({ cwd: process.cwd(), gate, log: new CommitLog(), git });
    await run(tool, { message: "Fix the thing\n\nBecause." });
    assert.equal(gate.seen.length, 1);
    assert.equal(gate.seen[0]!.kind, "edit");
    assert.match(gate.seen[0]!.summary, /Fix the thing/);
    assert.equal(gate.seen[0]!.body, "Fix the thing\n\nBecause.");
    assert.ok(calls.length > 0);
  });

  it("is declared at the tier edit is, and its request is an edit request", () => {
    assert.equal(tierForTool(COMMIT_TOOL_NAME), tierForTool("edit"));
    assert.equal(tierForAction({ kind: "edit" }), "soft-write");
  });

  it("a refusal runs no git and says it was declined, and the denial is recorded", async () => {
    const gate = new RecordingGate("deny");
    const denials = new DenialLog();
    const { git, calls } = stubGit();
    const tool = buildCommitTool({ cwd: process.cwd(), gate, denials, log: new CommitLog(), git });
    const out = await run(tool, { message: "No" });
    assert.equal(out.isError, true);
    assert.match(out.text, /declined/);
    assert.deepEqual(calls, []);
    assert.equal(denials.userRejected, 1);
  });
});

describe("commit: the git it runs (T179)", () => {
  it("stages and commits every change when no paths are given, in a scratch index, and returns the new id", async () => {
    const { git, calls, envs } = stubGit();
    const log = new CommitLog();
    const tool = buildCommitTool({ cwd: process.cwd(), gate: new RecordingGate(), log, git });
    const out = await run(tool, { message: "All of it" });
    assert.equal(out.isError, false);
    assert.match(out.text, new RegExp(`Committed ${"a".repeat(40)}`));
    const verbs = calls.map((c) => c.find((a) => ["rev-parse", "read-tree", "add", "reset", "diff", "commit", "show"].includes(a)));
    assert.deepEqual(verbs, ["rev-parse", "read-tree", "add", "diff", "reset", "diff", "commit", "reset", "rev-parse", "show"]);
    const add = calls.find((c) => c.includes("add"))!;
    assert.deepEqual(add, ["add", "-A", "--", "."]);
    // Everything up to and including the commit runs against the scratch index; the real index is only
    // touched by the last call, once the commit exists.
    const indexFiles = envs.map((e) => e?.GIT_INDEX_FILE);
    for (const i of [1, 2, 4, 5, 6]) assert.ok(typeof indexFiles[i] === "string" && indexFiles[i] !== "", `call ${i} uses the scratch index`);
    assert.equal(new Set([1, 2, 4, 5, 6].map((i) => indexFiles[i])).size, 1, "one scratch index throughout");
    assert.equal(indexFiles[3], undefined, "reading what the person staged looks at their real index");
    assert.equal(indexFiles[7], undefined, "the real index is changed only after the commit, to bring it up to date");
    assert.deepEqual(calls[4], ["reset", "-q", "--", ":(icase).lykos", ":(icase).pi"], "protected directories, in any case, back to HEAD in the scratch index");
    assert.deepEqual(calls[7], ["reset", "-q", "--", ".", ":(exclude,icase).lykos", ":(exclude,icase).pi"]);
    const commit = calls.find((c) => c.includes("commit") && c.includes("-m"))!;
    assert.ok(commit.includes("All of it"));
    assert.ok(!commit.includes("--"), "no pathspec: the scratch index decides what is committed");
    assert.deepEqual(log.records.map((r) => [r.sha, r.subject, r.filesChanged, r.scope]), [["a".repeat(40), "All of it", 2, "all"]]);
  });

  it("with paths it passes them literally, after --, relative to the project", async () => {
    const { git, calls } = stubGit();
    const tool = buildCommitTool({ cwd: process.cwd(), gate: new RecordingGate(), log: new CommitLog(), git });
    await run(tool, { message: "Some", paths: ["src/*.ts"] });
    assert.deepEqual(calls.find((c) => c.includes("add")), ["--literal-pathspecs", "add", "-A", "--", "src/*.ts"]);
    assert.deepEqual(calls.find((c) => c.includes("reset")), ["--literal-pathspecs", "reset", "-q", "--", "src/*.ts"]);
  });

  it("turns signing off, because gpg.program is a program the repository chooses", async () => {
    const { git, calls } = stubGit();
    const tool = buildCommitTool({ cwd: process.cwd(), gate: new RecordingGate(), log: new CommitLog(), git });
    await run(tool, { message: "Unsigned" });
    const commit = calls.find((c) => c.includes("commit"))!;
    assert.ok(commit.join(" ").includes("-c commit.gpgsign=false commit"));
  });

  it("an empty message is refused before the gate is asked", async () => {
    const gate = new RecordingGate();
    const tool = buildCommitTool({ cwd: process.cwd(), gate, log: new CommitLog(), git: stubGit().git });
    const out = await run(tool, { message: "   " });
    assert.equal(out.isError, true);
    assert.equal(gate.seen.length, 0);
  });

  it("git's own error text reaches the model, and nothing is logged", async () => {
    const log = new CommitLog();
    const git = (args: string[]): GitRun =>
      args.includes("commit")
        ? { ok: false, stdout: "", stderr: "Author identity unknown" }
        : args.includes("diff") && !args.includes("--name-only")
          ? { ok: false, stdout: "", stderr: "" }
          : { ok: true, stdout: "", stderr: "" };
    const tool = buildCommitTool({ cwd: process.cwd(), gate: new RecordingGate(), log, git });
    const out = await run(tool, { message: "Anon" });
    assert.equal(out.isError, true);
    assert.match(out.text, /Author identity unknown/);
    assert.deepEqual(log.records, []);
  });
});

describe("commit: the rows that price it (T179)", () => {
  it("the catalog row equals the live definition, description and parameters both", () => {
    const row = TOOL_CATALOG.commit;
    assert.ok(row);
    assert.equal(row.name, COMMIT_TOOL_NAME);
    assert.equal(row.description, COMMIT_DESCRIPTION);
    assert.deepEqual(row.parameters, JSON.parse(JSON.stringify(COMMIT_PARAMETERS)));
  });

  it("is not on a read-only child's surface, which is the four read tools", () => {
    assert.ok(!READ_ONLY_CHILD_TOOLS.includes(COMMIT_TOOL_NAME));
  });

  it("is resident, soft-write and not idempotent", () => {
    assert.ok(DEFAULT_RESIDENT_TOOLS.includes(COMMIT_TOOL_NAME));
    assert.ok(!MOUNTED_TOOLS.includes(COMMIT_TOOL_NAME));
    assert.deepEqual(riskForTool(COMMIT_TOOL_NAME), { tier: "soft-write", idempotent: false, openWorld: false });
  });
});

describe("commit: when the session can write (T179)", () => {
  const deps = { cwd: process.cwd(), gate: new RecordingGate(), modelProvider: "p", modelId: "m", commitEnabled: true };
  const has = (names: string[], extra: object = {}) =>
    loadTools(names, { ...deps, ...extra }).customTools.some((t) => t.name === COMMIT_TOOL_NAME);

  it("is built when the surface carries edit or write", () => {
    assert.equal(has(["read", "edit", "commit"]), true);
    assert.equal(has(["read", "write", "commit"]), true);
  });

  it("is absent when the surface has neither, or when the folder is not a repository", () => {
    assert.equal(has(["read", "grep", "commit"]), false);
    assert.equal(has(["read", "edit", "commit"], { commitEnabled: false }), false);
  });
});
