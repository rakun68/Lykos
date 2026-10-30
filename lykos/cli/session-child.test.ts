// The child side of the MCP boundary (T181), in this process with a stand-in
// session engine. The real process, with a real session, is in
// delegate/session-process.test.ts.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { ensureWorkspaceTrust, WorkspaceTrustError } from "../gate/trust.js";
import { openLedger } from "../ledger/use.js";
import type { RunStandaloneTaskInput, RunStandaloneTaskResult } from "../session/session.js";
import { encodeFrame, parseFrame, PROTOCOL_VERSION, type Frame, type SessionRequest } from "../delegate/session-protocol.js";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { runStandaloneTask } from "../session/session.js";
import { acquireWorktree } from "../git/worktree.js";
import { resolveProject } from "../session/identity.js";
import { call, lastToolResult, reply, runScriptedSession, say, SCRIPTED_MODEL, scriptedPiHost, scriptedProvider, scriptedWorld, toolResults, type ModelContext } from "./scripted-session.js";
import { SUPERSEDED_NOTICE } from "../loop/tool-result-prune.js";
import { describeReplayCost, resolveChildTrust, runSessionChild } from "./session-child.js";

function repo(): string {
  const workspace = mkdtempSync(join(tmpdir(), "lykos-child-ws-"));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: workspace });
  return workspace;
}

/** A call that wrote leaves its branch on every outcome (T184); these tests are about the rest of the result. */
const apartFromBranch = (frame: Frame | undefined): unknown => {
  const { branch, ...rest } = (frame as Extract<Frame, { type: "result" }>).result as Record<string, unknown>;
  assert.match(String(branch), /^lykos\//, "the branch is named");
  return { type: "result", result: rest };
};

const emptyStore = (): string => join(mkdtempSync(join(tmpdir(), "lykos-child-store-")), "trust.json");

describe("trust in the child (T181, #24): the parent's claim can pass the gate and never upgrade it", () => {
  // The parent's word is an env var; this process's own LYKOS_TRUST_WORKSPACE is a second way to the gate and is held off.
  const saved = process.env.LYKOS_TRUST_WORKSPACE;
  const hold = (): void => void delete process.env.LYKOS_TRUST_WORKSPACE;
  const restore = (): void => void (saved === undefined ? delete process.env.LYKOS_TRUST_WORKSPACE : (process.env.LYKOS_TRUST_WORKSPACE = saved));

  it("a project the store does not hold is `flag` whatever the claim says, even a claim of `stored`", async () => {
    hold();
    try {
      const workspace = repo();
      const trustPath = emptyStore();
      for (const claim of ["flag", "stored", "prompt"]) {
        assert.equal(await resolveChildTrust({ workspace, env: { LYKOS_TRUST_SOURCE: claim }, trustPath }), "flag", `claim ${claim}`);
      }
    } finally {
      restore();
    }
  });

  it("a project the store holds is `stored` with a claim of `flag`, and with none", async () => {
    hold();
    try {
      const workspace = repo();
      const trustPath = emptyStore();
      const { projectId } = await ensureWorkspaceTrust({ workspace, trustWorkspace: true, trustPath });
      writeFileSync(trustPath, JSON.stringify({ version: 1, projects: { [projectId]: { trustedUtc: "2026-01-01T00:00:00Z" } } }));
      assert.equal(await resolveChildTrust({ workspace, env: { LYKOS_TRUST_SOURCE: "flag" }, trustPath }), "stored");
      assert.equal(await resolveChildTrust({ workspace, env: {}, trustPath }), "stored");
    } finally {
      restore();
    }
  });

  it("with no claim and no store entry the child refuses; a claim that is not a trust source is not one", async () => {
    hold();
    try {
      const workspace = repo();
      const trustPath = emptyStore();
      await assert.rejects(resolveChildTrust({ workspace, env: {}, trustPath }), WorkspaceTrustError);
      await assert.rejects(resolveChildTrust({ workspace, env: { LYKOS_TRUST_SOURCE: "yes please" }, trustPath }), WorkspaceTrustError);
    } finally {
      restore();
    }
  });
});

function request(workspace: string, extra: Partial<SessionRequest> = {}): SessionRequest {
  return { version: PROTOCOL_VERSION, tool: "lykos_implement", workspace, prompt: "do it", label: "lykos_implement", ...extra };
}

async function drive(
  req: SessionRequest | string,
  runTask: (input: RunStandaloneTaskInput) => Promise<RunStandaloneTaskResult>,
  opts: { env?: NodeJS.ProcessEnv; trustPath?: string; keepOpen?: boolean; extras?: Partial<RunStandaloneTaskInput>; worktreesRoot?: string } = {},
): Promise<{ frames: Frame[]; lines: string[]; code: number; input: PassThrough; gone: () => number }> {
  const input = new PassThrough();
  const lines: string[] = [];
  let goneCalls = 0;
  input.write(typeof req === "string" ? req : encodeFrame(req));
  const done = runSessionChild({
    input,
    write: (text) => void lines.push(...text.split("\n").filter((l) => l.length > 0)),
    env: { LYKOS_TRUST_SOURCE: "flag", ...opts.env },
    trustPath: opts.trustPath ?? emptyStore(),
    // A writing call makes a worktree; never in the real home.
    worktreesRoot: opts.worktreesRoot ?? mkdtempSync(join(tmpdir(), "lykos-child-wt-")),
    runTask,
    ...(opts.extras !== undefined ? { sessionExtras: opts.extras } : {}),
    onParentGone: () => void goneCalls++,
  });
  const code = await done;
  if (opts.keepOpen !== true) input.end();
  await new Promise((r) => setImmediate(r));
  return { frames: lines.map((l) => parseFrame(l)!), lines, code, input, gone: () => goneCalls };
}

describe("the child's protocol (T181, stories 70-72)", () => {
  it("writes only frames to stdout: progress first, then exactly one result, each line valid JSON", async () => {
    const workspace = repo();
    const seen: RunStandaloneTaskInput[] = [];
    const { frames, lines, code } = await drive(
      request(workspace, { model: "p/m", budgetUsd: 0.25, containment: "required" }),
      async (input) => {
        seen.push(input);
        return { status: "ok", sessionId: "s1", text: "answer", snapshot: {} as never, containment: { requested: "required", used: "required", runtime: "podman" } };
      },
      { env: { LYKOS_TRUST_WORKSPACE: "1" } },
    );
    assert.equal(code, 0);
    assert.ok(lines.every((l) => parseFrame(l) !== undefined), `every line is a frame: ${lines.join(" | ")}`);
    assert.deepEqual(frames.map((f) => f.type), ["progress", "result"]);
    // A writing call (the default tool, implement) ran on a branch of its own, which the result names.
    const { branch, ...rest } = (frames[1] as Extract<Frame, { type: "result" }>).result as Record<string, unknown>;
    assert.match(String(branch), /^lykos\/.+/);
    assert.deepEqual(rest, { outcome: "ok", answer: "answer", sessionId: "s1", containment: "required", runtime: "podman" });
    // The same delegated session `lykos run` starts.
    assert.equal(seen[0]!.delegated, true);
    assert.equal(seen[0]!.containmentLevel, "required");
    assert.equal(seen[0]!.budgetPerRunUsd, "0.25");
    assert.equal(seen[0]!.model, "p/m");
    assert.equal(seen[0]!.label, "lykos_implement");
    // The interaction mode decides, not a blanket approval: an implement call writes (`auto`) on a worktree of its own.
    assert.equal(seen[0]!.autoApprove, undefined, "an MCP call does not switch the gate off; its mode is what lets it write");
    assert.equal(seen[0]!.interactionMode, "auto");
    assert.ok(seen[0]!.workTree !== undefined, "a writing call works on a worktree");
    assert.ok(seen[0]!.sessionId, "the session is given the id its branch is named from");
    assert.equal(seen[0]!.workspace, workspace);
    assert.equal(seen[0]!.trustSource, "flag");
  });

  it("returns the commits the session made, from the ledger, oldest first", async () => {
    const workspace = repo();
    const ledgerPath = join(workspace, "ledger.db");
    const ledger = await openLedger(ledgerPath);
    try {
      ledger.recordCommits("s7", [
        { sha: "a".repeat(40), subject: "First", message: "First body", filesChanged: 2, scope: "paths", tsUtc: "2026-10-10T10:00:00.000Z" },
        { sha: "b".repeat(40), subject: "Second", message: "Second", filesChanged: null, scope: "all", tsUtc: "2026-10-10T10:05:00.000Z" },
      ]);
    } finally {
      ledger.close();
    }
    // In place: with a branch of its own the commits come from git, which the next test covers.
    const { frames } = await drive(request(workspace, { writeInPlace: true }), async () => ({ status: "ok", sessionId: "s7", text: "ok", snapshot: {} as never }), {
      extras: { ledgerPath },
    });
    const result = (frames.at(-1) as Extract<Frame, { type: "result" }>).result;
    assert.deepEqual(result.outcome === "ok" ? result.commits : undefined, [
      { sha: "a".repeat(40), subject: "First" },
      { sha: "b".repeat(40), subject: "Second" },
    ]);
  });

  it("maps a blocked or failed session to the matching outcome", async () => {
    const workspace = repo();
    const blocked = await drive(request(workspace), async () => ({ status: "blocked", reason: "daily spend cap reached" }));
    assert.deepEqual(apartFromBranch(blocked.frames.at(-1)), { type: "result", result: { outcome: "blocked", reason: "daily spend cap reached" } });
    const failed = await drive(request(workspace), async () => ({ status: "error", message: "below the floor" }));
    assert.deepEqual(apartFromBranch(failed.frames.at(-1)), { type: "result", result: { outcome: "error", message: "below the floor" } });
    const thrown = await drive(request(workspace), async () => {
      throw new Error("engine fell over");
    });
    assert.deepEqual(apartFromBranch(thrown.frames.at(-1)), { type: "result", result: { outcome: "error", message: "engine fell over" } });
  });

  it("answers a request it cannot read with an error result and a non-zero exit, and runs nothing", async () => {
    let ran = 0;
    const { frames, code } = await drive("not json at all\n", async () => (ran++, { status: "blocked", reason: "x" }));
    assert.equal(code, 2);
    assert.equal(ran, 0);
    assert.equal((frames[0] as Extract<Frame, { type: "result" }>).result.outcome, "error");
  });

  it("emits a heartbeat while the session runs", async () => {
    const workspace = repo();
    const { frames } = await drive(
      request(workspace),
      () => new Promise((resolve) => setTimeout(() => resolve({ status: "blocked", reason: "slow" }), 150)),
      { env: { LYKOS_TRUST_WORKSPACE: "1", LYKOS_SESSION_PROGRESS_MS: "20" } },
    );
    const heartbeats = frames.filter((f) => f.type === "progress");
    assert.ok(heartbeats.length >= 3, `${heartbeats.length} progress frames`);
  });

  it("tells its owner when its parent goes away after the request was read", async () => {
    const workspace = repo();
    const result = await drive(request(workspace), async () => ({ status: "blocked", reason: "x" }), { keepOpen: true });
    assert.equal(result.gone(), 0);
    result.input.end();
    await new Promise((r) => setImmediate(r));
    assert.ok(result.gone() >= 1);
  });
});

describe("a review cannot change the tree (T181, story 41)", () => {
  const FILE = "src/a.ts";
  const WIDEN = "tools_add: [write, bash, commit]\n";

  /** Runs `tool` through the child against a project that tries to widen every session's tools, and returns the wire. */
  async function review(
    tool: string,
    opts: { script?: Parameters<typeof scriptedWorld>[0]["script"]; extras?: Partial<RunStandaloneTaskInput>; withSpecialist?: boolean; widen?: boolean } = {},
  ) {
    const world = await scriptedWorld({
      files: { [FILE]: "export const a = 1;\n", ".lykos/specialists/adder.yaml": "tools_add: [write, bash]\n" },
      ...(opts.widen === false ? {} : { config: WIDEN }),
      script: opts.script ?? [reply(say("looked"))],
    });
    const saved = process.env.LYKOS_TRUST_WORKSPACE;
    process.env.LYKOS_TRUST_WORKSPACE = "1";
    let result;
    try {
      const { frames } = await drive(
        request(world.workspace, { tool, containment: "off", model: SCRIPTED_MODEL }),
        (input) => runStandaloneTask(input),
        { extras: { nativeProviders: [world.provider], ledgerPath: world.ledgerPath, ...(opts.withSpecialist === false ? { specialist: undefined } : { specialist: "adder" }), ...opts.extras } },
      );
      result = (frames.at(-1) as Extract<Frame, { type: "result" }>).result;
    } finally {
      if (saved === undefined) delete process.env.LYKOS_TRUST_WORKSPACE;
      else process.env.LYKOS_TRUST_WORKSPACE = saved;
    }
    return { world, result, wire: (world.sent[0]?.tools ?? []).map((t) => t.name) };
  }

  it("lykos_review, in a project whose config and specialist add write, bash and commit, still has none of them on its wire", async () => {
    const { result, wire } = await review("lykos_review");
    assert.equal(result.outcome, "ok", JSON.stringify(result));
    assert.ok(wire.includes("read"), wire.join(","));
    assert.ok(wire.every((n) => ["read", "grep", "find", "ls", "ask_coordinator", "give_up"].includes(n)), `only the read-only surface, extension tools included: ${wire.join(",")}`);
    for (const forbidden of ["edit", "write", "bash", "powershell", "commit"]) assert.ok(!wire.includes(forbidden), forbidden);
  });

  it("if a mutating tool does reach the list, the read-only gate refuses the call and the file is unchanged", async () => {
    const { world, result } = await review("lykos_review", {
      script: [
        reply(call("write", { path: FILE, content: "tampered\n" })),
        (context) => {
          const refused = lastToolResult(context);
          assert.equal(refused.isError, true, "the write is refused");
          assert.match(refused.text, /refused by the read-only gate|read-only child session/);
          return reply(say("looked"));
        },
      ],
      // No specialist and no tools_add here: the tool allow-list they set would refuse the call first, and this proves the gate.
      withSpecialist: false,
      widen: false,
      extras: { bootDeps: { readOnlyChildTest: { extraTools: ["write"], bypass: "harness" } } },
    });
    assert.equal(result.outcome, "ok", JSON.stringify(result));
    world.check();
    assert.equal(readFileSync(join(world.workspace, FILE), "utf8"), "export const a = 1;\n");
  });

  it("ask_coordinator is callable in a lykos_review session (1.both.1)", { timeout: 60_000 }, async () => {
    let seen: { tool: string; text: string; isError: boolean } | undefined;
    const world = await scriptedWorld({
      config: "feedback:\n  enabled: false\ngate:\n  enabled: false\n",
      script: [
        reply(call("ask_coordinator", { question: "Which file should I review first?" })),
        (context: ModelContext) => {
          seen = lastToolResult(context);
          return reply(say("looked"));
        },
      ],
    });
    const input = new PassThrough();
    const frames: Array<Record<string, unknown>> = [];
    input.write(encodeFrame(request(world.workspace, { tool: "lykos_review", containment: "off", model: SCRIPTED_MODEL })));
    await runSessionChild({
      input,
      write: (text) => {
        for (const line of text.split("\n")) {
          if (line.trim().length === 0) continue;
          let frame: Record<string, unknown>;
          try { frame = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          frames.push(frame);
          if (frame.type === "question") input.write(`${JSON.stringify({ type: "steer", message: "README.md" })}\n`);
        }
      },
      env: { LYKOS_TRUST_WORKSPACE: "1", LYKOS_TRUST_SOURCE: "flag" },
      trustPath: join(mkdtempSync(join(tmpdir(), "lykos-repro-store-")), "trust.json"),
      worktreesRoot: mkdtempSync(join(tmpdir(), "lykos-repro-wt-")),
      runTask: (task) => runStandaloneTask(task),
      sessionExtras: { nativeProviders: [world.provider], ledgerPath: world.ledgerPath },
    });
    input.end();
    const questions = frames.filter((f) => f.type === "question");
    assert.deepEqual(questions.map((f) => f.question), ["Which file should I review first?"]);
    assert.equal(seen?.isError, false, `ask_coordinator was refused in a read-only session: ${JSON.stringify(seen)}`);
  });

  it("the other three tools keep the full surface", async () => {
    const { wire } = await review("lykos_implement");
    for (const wanted of ["edit", "write", "bash"]) assert.ok(wire.includes(wanted), `${wanted} in ${wire.join(",")}`);
  });

  it("resolves the review specialist for lykos_review, inheriting its instructions and read_only", async () => {
    const workspace = repo();
    let seenInput: RunStandaloneTaskInput | undefined;
    const { code } = await drive(
      request(workspace, { tool: "lykos_review" }),
      async (input) => {
        seenInput = input;
        return { status: "ok", sessionId: "s-review", text: "done", snapshot: {} as never };
      },
      { env: { LYKOS_TRUST_WORKSPACE: "1" } },
    );
    assert.equal(code, 0);
    assert.equal(seenInput?.specialist, "review");
    assert.equal(seenInput?.readOnly, true);
  });
});

describe("the MCP review path resolves the review specialist on its own (T214, ADR-0043)", () => {
  it("lykos_review, with no specialist injected, boots a session that carries the review specialist's instructions", async () => {
    const MARKER = "REVIEW-SPECIALIST-MARKER-7f3a";
    const world = await scriptedWorld({
      files: { "src/a.ts": "export const a = 1;\n", ".lykos/specialists/review.yaml": `read_only: true\ninstructions: ${MARKER}\n` },
      script: [reply(say("looked"))],
    });
    const saved = process.env.LYKOS_TRUST_WORKSPACE;
    process.env.LYKOS_TRUST_WORKSPACE = "1";
    try {
      const { frames } = await drive(
        request(world.workspace, { tool: "lykos_review", containment: "off", model: SCRIPTED_MODEL }),
        (input) => runStandaloneTask(input),
        // No `specialist` key here: the only thing that can name one is the child's own resolution.
        { extras: { nativeProviders: [world.provider], ledgerPath: world.ledgerPath } },
      );
      const result = (frames.at(-1) as Extract<Frame, { type: "result" }>).result;
      assert.equal(result.outcome, "ok", JSON.stringify(result));
    } finally {
      if (saved === undefined) delete process.env.LYKOS_TRUST_WORKSPACE;
      else process.env.LYKOS_TRUST_WORKSPACE = saved;
    }
    assert.ok(JSON.stringify(world.sent[0]).includes(MARKER), "the review specialist's instructions reached the model");
  });
});

describe("an error carries the session id when a session exists (T181, story 70)", () => {
  it("passes the id of a session that failed partway to the result", async () => {
    const { frames } = await drive(request(repo()), async () => ({ status: "error", message: "model failed", sessionId: "s5" }), {
      env: { LYKOS_TRUST_WORKSPACE: "1" },
    });
    assert.deepEqual(apartFromBranch(frames.at(-1)), { type: "result", result: { outcome: "error", message: "model failed", sessionId: "s5" } });
  });

  it("a continuation that fails keeps the id it was asked to continue", async () => {
    const { frames } = await drive(request(repo(), { sessionId: "gone" }), async () => ({ status: "blocked", reason: "x" }), {
      env: { LYKOS_TRUST_WORKSPACE: "1" },
    });
    const result = (frames.at(-1) as Extract<Frame, { type: "result" }>).result;
    assert.equal(result.outcome, "error");
    assert.equal(result.outcome === "error" ? result.sessionId : undefined, "gone");
    assert.match(result.outcome === "error" ? result.message : "", /^could not continue session gone: lykos resume: no ledger at /);
  });

  it("an error from a contained run carries realized containment and runtime", async () => {
    const { frames } = await drive(
      request(repo()),
      async () => ({
        status: "error",
        message: "contained failure",
        sessionId: "s-contained-err",
        containment: { requested: "auto", used: "auto", runtime: "docker" },
      }),
      { env: { LYKOS_TRUST_WORKSPACE: "1" } },
    );
    const result = (frames.at(-1) as Extract<Frame, { type: "result" }>).result;
    assert.equal(result.outcome, "error");
    assert.equal(result.containment, "auto");
    assert.equal(result.runtime, "docker");
  });
});

describe("a continuation reports no figure it did not measure (ADR-0038, AGENTS.md rule 4)", () => {
  it("says the replayed context's size and price are unmeasured, with no token count and no zero", () => {
    const line = describeReplayCost();
    assert.match(line, /unmeasured/);
    assert.doesNotMatch(line, /\d|\$|about|estimat/);
  });
});

describe("the engine reports the id of a session that failed partway (T181, story 70)", () => {
  it("an error result from a booted session carries its id, and the ledger knows that id", async () => {
    // The real session, booted for real; its first prompt throws, as a provider that gives up does.
    const bootDeps = {
      createSession: async (opts: Parameters<typeof createAgentSession>[0]) => {
        const created = await createAgentSession(opts);
        created.session.prompt = async () => {
          throw new Error("model fell over");
        };
        return created;
      },
    };
    const run = await runScriptedSession({ script: [reply(say("never"))], extra: { delegated: true, containmentLevel: "off", bootDeps } });
    assert.equal(run.result.status, "error");
    const id = run.result.status === "error" ? run.result.sessionId : undefined;
    assert.ok(id, "an id is returned");
    assert.equal(run.query<{ id: string }>("SELECT id FROM sessions WHERE id = ?", id).length, 1);
  });
});

describe("a writing call works on a branch of its own and a continuation adds to it (T184, stories 42-47)", () => {
  const QUIET = "feedback:\n  enabled: false\ngate:\n  enabled: false\n";
  const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

  /** One call through the child on the real engine, with a scripted model, against `workspace`. */
  async function callChild(
    workspace: string,
    ledgerPath: string,
    worktreesRoot: string,
    script: Parameters<typeof scriptedProvider>[0],
    extra: Partial<SessionRequest> = {},
  ) {
    const scripted = await scriptedProvider(script);
    const saved = process.env.LYKOS_TRUST_WORKSPACE;
    process.env.LYKOS_TRUST_WORKSPACE = "1";
    try {
      const { frames } = await drive(
        request(workspace, { model: SCRIPTED_MODEL, containment: "off", ...extra }),
        (input) => runStandaloneTask(input),
        { worktreesRoot, extras: { nativeProviders: [scripted.provider], ledgerPath } },
      );
      scripted.check();
      return (frames.at(-1) as Extract<Frame, { type: "result" }>).result;
    } finally {
      if (saved === undefined) delete process.env.LYKOS_TRUST_WORKSPACE;
      else process.env.LYKOS_TRUST_WORKSPACE = saved;
    }
  }

  const change = (file: string, content: string, subject: string) => [
    reply(call("write", { path: file, content })),
    reply(call("commit", { message: subject })),
    reply(say("done")),
  ];

  it("returns the branch and its commits, leaves the caller's tree alone, and a continuation adds commits to the same branch", async () => {
    const world = await scriptedWorld({ files: { "src/a.ts": "export const a = 1;\n" }, config: QUIET, script: [] });
    const root = mkdtempSync(join(tmpdir(), "lykos-child-wt-"));
    const ws = world.workspace;

    const first = await callChild(ws, world.ledgerPath, root, change("src/a.ts", "export const a = 2;\n", "First call"));
    assert.equal(first.outcome, "ok", JSON.stringify(first));
    if (first.outcome !== "ok") return;
    assert.equal(first.branch, `lykos/${first.sessionId}`);
    assert.deepEqual(first.commits?.map((c) => c.subject), ["First call"]);
    assert.equal(first.write_in_place, undefined);
    assert.equal(readFileSync(join(ws, "src", "a.ts"), "utf8"), "export const a = 1;\n", "the caller's file is untouched");
    assert.equal(gitIn(ws, "status", "--porcelain"), "");
    assert.equal(gitIn(ws, "worktree", "list", "--porcelain").includes(first.sessionId), false, "the worktree is gone");
    assert.match(gitIn(ws, "branch", "--list", first.branch!), /lykos\//, "the branch remains");

    const second = await callChild(ws, world.ledgerPath, root, change("src/b.ts", "export const b = 1;\n", "Second call"), { sessionId: first.sessionId });
    assert.equal(second.outcome, "ok", JSON.stringify(second));
    if (second.outcome !== "ok") return;
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(second.branch, first.branch, "the same branch");
    assert.deepEqual(second.commits?.map((c) => c.subject), ["Second call", "First call"], "the continuation added a commit to it");
    assert.equal(gitIn(ws, "show", `${first.branch}:src/a.ts`), "export const a = 2;", "the first call's work is still there");
    assert.equal(gitIn(ws, "show", `${first.branch}:src/b.ts`), "export const b = 1;");
    assert.equal(existsSync(join(ws, "src", "b.ts")), false, "and the caller's tree still has neither");
  });

  it("two calls on one session cannot hold the worktree at once", async () => {
    const world = await scriptedWorld({ files: { "src/a.ts": "export const a = 1;\n" }, config: QUIET, script: [] });
    const root = mkdtempSync(join(tmpdir(), "lykos-child-wt-"));
    const first = await callChild(world.workspace, world.ledgerPath, root, change("src/a.ts", "export const a = 2;\n", "First call"));
    assert.equal(first.outcome, "ok", JSON.stringify(first));
    if (first.outcome !== "ok") return;

    // Another call is in the middle of this session.
    const held = acquireWorktree({ workspace: world.workspace, projectId: resolveProject(world.workspace).id, sessionId: first.sessionId, root });
    try {
      const refused = await callChild(world.workspace, world.ledgerPath, root, [reply(say("never"))], { sessionId: first.sessionId });
      assert.equal(refused.outcome, "error");
      assert.match(refused.outcome === "error" ? refused.message : "", /already running a call/);
    } finally {
      held.release();
    }
  });

  it("write_in_place changes the caller's tree and says there is no branch; outside a repository a write needs it, and then writes with no commits", async () => {
    const world = await scriptedWorld({ files: { "src/a.ts": "export const a = 1;\n" }, config: QUIET, script: [], repo: false });
    const root = mkdtempSync(join(tmpdir(), "lykos-child-wt-"));

    const refused = await callChild(world.workspace, world.ledgerPath, root, [reply(say("never"))]);
    assert.equal(refused.outcome, "error");
    assert.match(refused.outcome === "error" ? refused.message : "", /write_in_place/);
    assert.equal(refused.outcome === "error" ? refused.sessionId : "none", undefined, "no session was started, so there is no id");

    const review = await callChild(world.workspace, world.ledgerPath, root, [reply(say("looked"))], { tool: "lykos_review" });
    assert.equal(review.outcome, "ok", "a read-only call proceeds without a repository");

    const placed = await callChild(
      world.workspace,
      world.ledgerPath,
      root,
      [reply(call("write", { path: "src/a.ts", content: "export const a = 5;\n" })), reply(say("done"))],
      { writeInPlace: true },
    );
    assert.equal(placed.outcome, "ok", JSON.stringify(placed));
    if (placed.outcome !== "ok") return;
    assert.equal(placed.write_in_place, true);
    assert.equal(placed.branch, undefined);
    assert.equal(placed.commits, undefined);
    assert.match(placed.note ?? "", /no commits/);
    assert.equal(readFileSync(join(world.workspace, "src", "a.ts"), "utf8"), "export const a = 5;\n");
  });

  it("a call that did not finish still returns the branch and the commits on it", async () => {
    const world = await scriptedWorld({ files: { "src/a.ts": "export const a = 1;\n" }, config: QUIET, script: [] });
    const root = mkdtempSync(join(tmpdir(), "lykos-child-wt-"));
    const { frames } = await drive(
      request(world.workspace),
      async (input) => {
        const wt = input.workTree!.path;
        writeFileSync(join(wt, "done.txt"), "partial\n");
        gitIn(wt, "add", "-A");
        gitIn(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "Partial work");
        return { status: "error", message: "model fell over", sessionId: "s9" };
      },
      { worktreesRoot: root, env: { LYKOS_TRUST_WORKSPACE: "1" } },
    );
    const result = (frames.at(-1) as Extract<Frame, { type: "result" }>).result;
    assert.equal(result.outcome, "error");
    if (result.outcome !== "error") return;
    assert.match(result.branch ?? "", /^lykos\//);
    assert.deepEqual(result.commits?.map((c) => c.subject), ["Partial work"]);
  });

  it("a blocked or failed call with no commits still names its branch and the note about files it archived", async () => {
    const world = await scriptedWorld({ files: { "src/a.ts": "export const a = 1;\n" }, config: QUIET, script: [] });
    writeFileSync(join(world.workspace, ".git", "info", "exclude"), "*.dat\n");
    const root = mkdtempSync(join(tmpdir(), "lykos-child-wt-"));
    for (const status of ["blocked", "error"] as const) {
      const { frames } = await drive(
        request(world.workspace),
        async (input) => {
          writeFileSync(join(input.workTree!.path, "findings.dat"), "evidence\n");
          return status === "blocked" ? { status: "blocked", reason: "over budget" } : { status: "error", message: "model fell over", sessionId: "s9" };
        },
        { worktreesRoot: root, env: { LYKOS_TRUST_WORKSPACE: "1" } },
      );
      const result = (frames.at(-1) as Extract<Frame, { type: "result" }>).result;
      assert.equal(result.outcome, status);
      assert.match(result.branch ?? "", /^lykos\//, `${status}: the branch is named though it has no commits`);
      assert.equal(result.commits, undefined);
      assert.match(result.note ?? "", /\.ignored/, `${status}: the note says where the ignored files went`);
    }
  });

  it("changes a session left uncommitted are saved on the branch, returned, and recorded in the ledger like any commit", async () => {
    const world = await scriptedWorld({ files: { "src/a.ts": "export const a = 1;\n" }, config: QUIET, script: [] });
    const root = mkdtempSync(join(tmpdir(), "lykos-child-wt-"));
    const first = await callChild(world.workspace, world.ledgerPath, root, [
      reply(call("write", { path: "src/a.ts", content: "export const a = 7;\n" })),
      reply(say("done, but I never committed")),
    ]);
    assert.equal(first.outcome, "ok", JSON.stringify(first));
    if (first.outcome !== "ok") return;
    assert.match(first.commits?.[0]?.subject ?? "", /left uncommitted/);
    assert.match(first.note ?? "", /uncommitted/);
    const ledger = await openLedger(world.ledgerPath);
    try {
      assert.deepEqual(ledger.commits(first.sessionId).map((c) => c.sha), [first.commits![0]!.sha], "the ledger knows the saving commit");
    } finally {
      ledger.close();
    }
  });

  it("continuing with a context-limit successor's id reaches the branch of the call's original session", async () => {
    const world = await scriptedWorld({ files: { "src/a.ts": "export const a = 1;\n" }, config: QUIET, script: [] });
    const root = mkdtempSync(join(tmpdir(), "lykos-child-wt-"));
    const first = await callChild(world.workspace, world.ledgerPath, root, change("src/a.ts", "export const a = 2;\n", "Before the limit"));
    assert.equal(first.outcome, "ok", JSON.stringify(first));
    if (first.outcome !== "ok") return;
    // The successor the engine starts at a context boundary is a row of its own that points back.
    const ledger = await openLedger(world.ledgerPath);
    try {
      const row = ledger.db.prepare("SELECT * FROM sessions WHERE id = ?").get(first.sessionId) as Record<string, unknown>;
      const successor = { ...row, id: "successor-1", resumed_from: first.sessionId };
      const columns = Object.keys(successor);
      ledger.db.prepare(`INSERT INTO sessions (${columns.join(",")}) VALUES (${columns.map((c) => `@${c}`).join(",")})`).run(successor);
    } finally {
      ledger.close();
    }
    const { frames } = await drive(request(world.workspace, { sessionId: "successor-1" }), async () => ({ status: "blocked", reason: "x" }), {
      worktreesRoot: root,
      env: { LYKOS_TRUST_WORKSPACE: "1" },
      extras: { ledgerPath: world.ledgerPath },
    });
    const result = (frames.at(-1) as Extract<Frame, { type: "result" }>).result;
    // The stand-in session does nothing, so the call ends blocked or refused; either way it names the work found.
    assert.notEqual(result.outcome, "ok");
    assert.equal(result.branch, first.branch, "but the worktree it asked for is the original branch's");
    assert.deepEqual(result.commits?.map((c) => c.subject), ["Before the limit"]);
    assert.equal(gitIn(world.workspace, "branch", "--list", "lykos/successor-1"), "", "no branch was made for the successor");
  });
});

describe("a project's own extensions need the project trusted in the user store (T183, stories 75-76)", () => {
  const BODY = "line of the file that is long enough to be worth pruning\n".repeat(20);
  const tool = (name: string): string => `
import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({ name: "${name}", label: "${name}", description: "demo", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "ok" }], details: {} }; } });
}
`;
  /** An extension installed the way `lykos extensions install` leaves one, in the scripted Pi host. */
  function install(name: string, toolName: string): void {
    const dir = join(scriptedPiHost(), "npm", "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", type: "module" }));
    writeFileSync(join(dir, "index.js"), tool(toolName));
  }

  async function callOnce(trusted: boolean) {
    install("demo-user-ext", "demo_user_tool");
    install("demo-project-ext", "demo_project_tool");
    const markerDir = mkdtempSync(join(tmpdir(), "lykos-pkg-marker-"));
    const marker = join(markerDir, "installed");
    const fakeNpm = join(markerDir, "fake-npm.js");
    writeFileSync(fakeNpm, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(" "));`);
    const home = join(scriptedPiHost(), "..");
    const globalConfig = join(home, "config.yaml");
    writeFileSync(globalConfig, "extensions:\n  - { name: demo-user-ext, version: 1.0.0 }\n");
    try {
      let afterReads: string[] = [];
      const world = await scriptedWorld({
        files: {
          "a.txt": BODY,
          // The project's own Pi settings list an npm package and name the command that installs it. Pi runs that
          // command on the host for a listed package that is not installed; the fake one leaves a marker instead.
          ".pi/settings.json": JSON.stringify({ npmCommand: [process.execPath, fakeNpm], packages: ["npm:lykos-t183-package@1.0.0"] }),
        },
        config:
          "feedback:\n  enabled: false\ngate:\n  enabled: false\nextensions:\n  - { name: lykos-prune }\n" +
          "  - { name: demo-user-ext, version: 1.0.0 }\n  - { name: demo-project-ext, version: 1.0.0 }\n" +
          // A project credential that is a command: Pi would run it on the host when it resolves the key.
          'providers:\n  deepseek:\n    auth: api_key\n    source: "!echo project-command"\n',
        script: [
          reply(call("read", { path: "a.txt" })),
          reply(call("write", { path: "a.txt", content: `${BODY}and one more line, so the second read differs\n` })),
          reply(call("read", { path: "a.txt" })),
          (context) => {
            afterReads = toolResults(context).filter((r) => r.tool === "read").map((r) => r.text);
            return reply(say("done"));
          },
        ],
      });
      const trustPath = emptyStore();
      if (trusted) {
        const { projectId } = await ensureWorkspaceTrust({ workspace: world.workspace, trustWorkspace: true, trustPath });
        writeFileSync(trustPath, JSON.stringify({ version: 1, projects: { [projectId]: { trustedUtc: "2026-01-01T00:00:00Z" } } }));
      }
      // LYKOS_TRUST_WORKSPACE passes the gate in both cases; only the store trusts the project's extensions.
      const { frames } = await drive(
        request(world.workspace, { containment: "off", model: SCRIPTED_MODEL }),
        (input) => runStandaloneTask(input),
        { trustPath, env: { LYKOS_TRUST_WORKSPACE: "1", LYKOS_TRUST_SOURCE: "flag" }, extras: { nativeProviders: [world.provider], ledgerPath: world.ledgerPath } },
      );
      const result = (frames.at(-1) as Extract<Frame, { type: "result" }>).result;
      return { result, wire: (world.sent[0]?.tools ?? []).map((t) => t.name), pruned: afterReads[0] === SUPERSEDED_NOTICE, packageLoaded: existsSync(marker) };
    } finally {
      rmSync(globalConfig, { force: true });
    }
  }

  it("untrusted: the project's extension and Pi package are skipped, named, and not loaded; default and user-level extensions load", async () => {
    const { result, wire, pruned, packageLoaded } = await callOnce(false);
    assert.equal(result.outcome, "ok", JSON.stringify(result));
    assert.deepEqual(result.outcome === "ok" ? result.skipped_extensions : undefined, ["demo-project-ext@1.0.0", "provider deepseek: !command credential", "pi package npm:lykos-t183-package@1.0.0 (install withheld; delegated sessions never load Pi packages)"]);
    assert.ok(!wire.includes("demo_project_tool"), wire.join(","));
    assert.equal(packageLoaded, false, "Pi never ran an install for the project's package");
    assert.ok(wire.includes("demo_user_tool"), "the user-level extension loads");
    assert.equal(pruned, true, "the default extension lykos-prune loads");
  });

  it("a call that errors or is blocked still names what was skipped", async () => {
    install("demo-project-ext", "demo_project_tool");
    const world = await scriptedWorld({
      files: { "a.txt": "x\n" },
      config: "extensions:\n  - { name: demo-project-ext, version: 1.0.0 }\nbudget:\n  per_run_usd: 0\n",
      script: [],
    });
    const { frames } = await drive(
      request(world.workspace, { tool: "lykos_review", containment: "off", model: "nonexistent-provider/none" }),
      (input) => runStandaloneTask(input),
      { env: { LYKOS_TRUST_SOURCE: "flag" }, extras: { nativeProviders: [world.provider], ledgerPath: world.ledgerPath } },
    );
    const result = (frames.at(-1) as Extract<Frame, { type: "result" }>).result;
    assert.notEqual(result.outcome, "ok", JSON.stringify(result));
    assert.deepEqual(result.outcome !== "ok" ? result.skipped_extensions : undefined, ["demo-project-ext@1.0.0"], JSON.stringify(result));
  });

  it("a throw ends a delegated session as an error result whether or not anything was skipped, and still throws for a session that is not delegated", async () => {
    const world = await scriptedWorld({ files: { "a.txt": "x\n" }, script: [] });
    const base = { workspace: world.workspace, prompt: "p", model: "nonexistent-provider/none", ledgerPath: world.ledgerPath, nativeProviders: [world.provider], trustSource: "flag" as const };
    const delegated = await runStandaloneTask({ ...base, delegated: true });
    assert.equal(delegated.status, "error");
    assert.equal(delegated.status === "error" ? delegated.skippedExtensions : "x", undefined, "nothing was skipped, and the shape is still a result");
    await assert.rejects(() => runStandaloneTask(base), /unknown provider/);
  });

  it("trusted in the store: the same project loads its extension and skips nothing", async () => {
    const { result, wire, pruned, packageLoaded } = await callOnce(true);
    assert.equal(packageLoaded, true, "trusted: Pi runs the install as it does today");
    assert.equal(result.outcome, "ok", JSON.stringify(result));
    assert.equal(result.outcome === "ok" ? result.skipped_extensions : "x", undefined);
    assert.ok(wire.includes("demo_project_tool"), wire.join(","));
    assert.ok(wire.includes("demo_user_tool"));
    assert.equal(pruned, true);
  });
});

describe("dispute reporting in session-child (T206)", () => {
  it("carries disputes from seal_events and returns outcome disputed when task state is disputed", async () => {
    const world = await scriptedWorld({ files: { "a.txt": "x\n" }, script: [] });

    const { frames } = await drive(
      request(world.workspace, { tool: "lykos_implement" }),
      async (base) => {
        const sid = base.sessionId!;
        const ledger = await openLedger(world.ledgerPath);
        try {
          ledger.db.prepare("INSERT INTO projects (id, root_path, created_utc) VALUES ('p1', '/path', datetime('now'))").run();
          ledger.db.prepare("INSERT INTO tasks (id, project_id, brief, created_utc, state) VALUES ('task-1', 'p1', 'brief', datetime('now'), 'disputed')").run();
          ledger.db.prepare("INSERT INTO sessions (id, task_id, started_utc, harness_commit) VALUES (?, 'task-1', datetime('now'), 'c1')").run(sid);
          ledger.db.prepare(
            "INSERT INTO seal_events (ts, session_id, creator, specialist, branch, kind, paths, detail) VALUES (?, ?, 'cli', 'implementer', 'lykos/test', 'dispute filed', ?, ?)",
          ).run(
            new Date().toISOString(),
            sid,
            "test/add.test.mjs",
            JSON.stringify({ file: "test/add.test.mjs", describe: ["math"], name: "adds", reason: "bad spec", evidence: "truth" }),
          );
        } finally {
          ledger.close();
        }
        return { status: "error", message: "tests failed", sessionId: sid };
      },
      {
        extras: { ledgerPath: world.ledgerPath },
        env: { LYKOS_TRUST_WORKSPACE: "1" },
      },
    );
    const result = (frames.at(-1) as Extract<Frame, { type: "result" }>).result;
    assert.equal(result.outcome, "disputed", JSON.stringify(result));
    assert.equal(result.disputes?.length, 1);
    assert.equal(result.disputes?.[0]?.test.file, "test/add.test.mjs");
    assert.equal(result.disputes?.[0]?.reason, "bad spec");
    assert.equal(result.disputes?.[0]?.status, "open");
  });

  it("aggregates disputes across the full child session tree under the parent session", async () => {
    const world = await scriptedWorld({ files: { "a.txt": "x\n" }, script: [] });

    const { frames } = await drive(
      request(world.workspace, { tool: "lykos_implement" }),
      async (base) => {
        const sid = base.sessionId!;
        const childSid = "child-session-1";
        const ledger = await openLedger(world.ledgerPath);
        try {
          ledger.db.prepare("INSERT INTO projects (id, root_path, created_utc) VALUES ('p1', '/path', datetime('now'))").run();
          ledger.db.prepare("INSERT INTO tasks (id, project_id, brief, created_utc, state) VALUES ('task-1', 'p1', 'brief', datetime('now'), 'disputed')").run();
          ledger.db.prepare("INSERT INTO sessions (id, task_id, started_utc, harness_commit) VALUES (?, 'task-1', datetime('now'), 'c1')").run(sid);
          ledger.db.prepare("INSERT INTO sessions (id, task_id, parent_session_id, started_utc, harness_commit) VALUES (?, 'task-1', ?, datetime('now'), 'c1')").run(childSid, sid);
          ledger.db.prepare(
            "INSERT INTO seal_events (ts, session_id, creator, specialist, branch, kind, paths, detail) VALUES (?, ?, 'cli', 'subagent', 'lykos/test', 'dispute filed', ?, ?)",
          ).run(
            new Date().toISOString(),
            childSid,
            "test/child.test.mjs",
            JSON.stringify({ file: "test/child.test.mjs", describe: ["math"], name: "subtracts", reason: "subagent dispute", evidence: "sub proof" }),
          );
        } finally {
          ledger.close();
        }
        return { status: "error", message: "tests failed", sessionId: sid };
      },
      {
        extras: { ledgerPath: world.ledgerPath },
        env: { LYKOS_TRUST_WORKSPACE: "1" },
      },
    );
    const result = (frames.at(-1) as Extract<Frame, { type: "result" }>).result;
    assert.equal(result.outcome, "disputed", JSON.stringify(result));
    assert.equal(result.disputes?.length, 1);
    assert.equal(result.disputes?.[0]?.test.file, "test/child.test.mjs");
    assert.equal(result.disputes?.[0]?.reason, "subagent dispute");
    assert.equal(result.disputes?.[0]?.status, "open");
  });

  it("derives dispute status from later seal events (escalated, upheld, rejected)", async () => {
    const world = await scriptedWorld({ files: { "a.txt": "x\n" }, script: [] });

    const { frames } = await drive(
      request(world.workspace, { tool: "lykos_implement" }),
      async (base) => {
        const sid = base.sessionId!;
        const ledger = await openLedger(world.ledgerPath);
        try {
          ledger.db.prepare("INSERT INTO projects (id, root_path, created_utc) VALUES ('p1', '/path', datetime('now'))").run();
          ledger.db.prepare("INSERT INTO tasks (id, project_id, brief, created_utc, state) VALUES ('task-1', 'p1', 'brief', datetime('now'), 'open')").run();
          ledger.db.prepare("INSERT INTO sessions (id, task_id, started_utc, harness_commit) VALUES (?, 'task-1', datetime('now'), 'c1')").run(sid);

          const insertEvent = (kind: string, file: string, name: string) => {
            ledger.db.prepare(
              "INSERT INTO seal_events (ts, session_id, creator, specialist, branch, kind, paths, detail) VALUES (?, ?, 'cli', 'implementer', 'lykos/test', ?, ?, ?)",
            ).run(
              new Date().toISOString(),
              sid,
              kind,
              file,
              JSON.stringify({ file, describe: ["suite"], name, reason: `reason for ${name}`, evidence: `evidence for ${name}` }),
            );
          };

          // Test 1: filed then escalated
          insertEvent("dispute filed", "test/t1.test.mjs", "test1");
          insertEvent("dispute escalated", "test/t1.test.mjs", "test1");

          // Test 2: filed then upheld
          insertEvent("dispute filed", "test/t2.test.mjs", "test2");
          insertEvent("dispute upheld", "test/t2.test.mjs", "test2");

          // Test 3: filed then rejected
          insertEvent("dispute filed", "test/t3.test.mjs", "test3");
          insertEvent("dispute rejected", "test/t3.test.mjs", "test3");

          // Test 4: filed with no subsequent event
          insertEvent("dispute filed", "test/t4.test.mjs", "test4");
        } finally {
          ledger.close();
        }
        return { status: "ok", sessionId: sid, text: "finished", snapshot: {} as never };
      },
      {
        extras: { ledgerPath: world.ledgerPath },
        env: { LYKOS_TRUST_WORKSPACE: "1" },
      },
    );
    const result = (frames.at(-1) as Extract<Frame, { type: "result" }>).result;
    assert.equal(result.outcome, "ok");
    assert.equal(result.disputes?.length, 4);

    const d1 = result.disputes?.find((d) => d.test.name === "test1");
    const d2 = result.disputes?.find((d) => d.test.name === "test2");
    const d3 = result.disputes?.find((d) => d.test.name === "test3");
    const d4 = result.disputes?.find((d) => d.test.name === "test4");

    assert.equal(d1?.status, "escalated");
    assert.equal(d2?.status, "upheld");
    assert.equal(d3?.status, "rejected");
    assert.equal(d4?.status, "open");
  });
});
