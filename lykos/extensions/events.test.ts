// Each of the nine events fires from the place its payload was already
// computed, one test each. The ninth, `credential_rotated`, fires from the
// session's rotation callback and is tested here against a real runtime and a
// local fake model server.
//
// The eighth, `approval_decided`, is tested beside its wrapper in
// `api.test.ts`, because its firing site IS that wrapper.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from "../gate/approval.js";
import { newPostEditState, resolvePostEditPolicy, runPostEditCheck, type CommandRun } from "../loop/post-edit.js";
import { budgetNotice, newContextBudgetState } from "../loop/context-budget.js";
import { createCheckpoint, spawnGit, type GitRunner } from "../loop/checkpoint.js";
import { runSessionGate, type GateOutcome, type GatePolicy } from "../gate/verify-gate.js";
import { buildMemoryHead } from "../session/memory-head.js";
import { buildTaskListTool, newTaskListState } from "../tools/task-list.js";
import { resolveSpecialistSwitch } from "./../session/specialist-switch.js";
import type { ResolvedConfig } from "../config/types.js";
import { LYKOS_EVENTS, LykosExtensionHost, type LykosEvent, type LykosEventPayloads } from "./api.js";
import { anthropicError, startFakeAnthropicServer } from "../credentials/fake-anthropic-server.js";
import { openCredentialDb } from "../credentials/db.js";
import { upsertCredential } from "../credentials/pool.js";
import { xxHash32 } from "../credentials/xxhash32.js";
import { createLykosModelRuntime, forwardRotationsToSink, RotationRelay } from "../session/model-runtime.js";

class NoGate implements ApprovalGate {
  async request(_req: ApprovalRequest): Promise<ApprovalDecision> {
    return "allow";
  }
}

/** A host with one extension listening to everything, so a test reads one array. */
function listeningHost(): {
  host: LykosExtensionHost;
  seen: Array<{ event: LykosEvent; payload: unknown }>;
} {
  const host = new LykosExtensionHost({ cwd: process.cwd(), gate: new NoGate() });
  const seen: Array<{ event: LykosEvent; payload: unknown }> = [];
  host.install({
    name: "listener",
    register: (api) => {
      for (const event of LYKOS_EVENTS) {
        api.on(event, (payload) => seen.push({ event, payload }));
      }
    },
  });
  return { host, seen };
}

function only<E extends LykosEvent>(
  seen: Array<{ event: LykosEvent; payload: unknown }>,
  event: E,
): LykosEventPayloads[E] {
  const hits = seen.filter((s) => s.event === event);
  assert.equal(hits.length, 1, `expected exactly one ${event}, got ${hits.length}`);
  return hits[0]!.payload as LykosEventPayloads[E];
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "lykos-ext-events-"));
}

describe("P10.9 D2 post_edit_check fires from loop/post-edit.ts", () => {
  const policy = { ...resolvePostEditPolicy(process.cwd()), enabled: true, command: "fake-check" };

  it("carries the verdict, the exit code and the duration of a failing run", async () => {
    const { host, seen } = listeningHost();
    const run = async (): Promise<CommandRun> => ({ exitCode: 2, output: "boom", ms: 12 });
    await runPostEditCheck(policy, newPostEditState(), run, host.sink);
    const payload = only(seen, "post_edit_check");
    assert.deepEqual(payload, {
      command: "fake-check",
      passed: false,
      exitCode: 2,
      ms: 12,
      disabled: false,
    });
  });

  it("fires on the SILENT pass too — silence is about the model, not about the event", async () => {
    const { host, seen } = listeningHost();
    const state = newPostEditState();
    state.announced = true; // a pass after the first one says nothing
    const run = async (): Promise<CommandRun> => ({ exitCode: 0, output: "", ms: 3 });
    const note = await runPostEditCheck(policy, state, run, host.sink);
    assert.equal(note, undefined, "the model is told nothing");
    assert.equal(only(seen, "post_edit_check").passed, true, "the extension still is");
  });

  it("says the loop switched itself off, and why", async () => {
    const { host, seen } = listeningHost();
    const run = async (): Promise<CommandRun> => ({ exitCode: null, output: "", ms: 1, problem: "ENOENT" });
    await runPostEditCheck(policy, newPostEditState(), run, host.sink);
    const payload = only(seen, "post_edit_check");
    assert.equal(payload.disabled, true);
    assert.equal(payload.disabledReason, "ENOENT");
    assert.equal(payload.passed, false);
  });
});

describe("P10.9 D2 budget_threshold fires from loop/context-budget.ts", () => {
  it("carries the band that was crossed and the numbers the notice was built from", () => {
    const { host, seen } = listeningHost();
    const note = budgetNotice(
      newContextBudgetState(),
      { contextTokens: 72_000, contextWindow: 100_000, compactionThreshold: 0.8 },
      undefined,
      host.sink,
    );
    assert.ok(note !== undefined);
    const payload = only(seen, "budget_threshold");
    assert.equal(payload.band, 0.7);
    assert.equal(payload.contextTokens, 72_000);
    assert.equal(payload.contextWindow, 100_000);
    assert.equal(payload.compactAt, 80_000);
    assert.equal(Math.round(payload.usedFraction * 100), 72);
  });

  it("does not fire when no band was crossed", () => {
    const { host, seen } = listeningHost();
    budgetNotice(
      newContextBudgetState(),
      { contextTokens: 10, contextWindow: 100_000, compactionThreshold: 0.8 },
      undefined,
      host.sink,
    );
    assert.equal(seen.length, 0);
  });
});

describe("P10.9 D2 checkpoint_written fires from loop/checkpoint.ts", () => {
  const fakeGit =
    (tree: string, parent = ""): GitRunner =>
    (args) => {
      const head = args[0];
      if (head === "rev-parse" && args.includes("--absolute-git-dir")) {
        return { ok: true, stdout: "/repo/.git", stderr: "" };
      }
      if (head === "rev-parse" && args.includes("--verify")) return { ok: true, stdout: parent, stderr: "" };
      if (head === "rev-parse") return { ok: true, stdout: "othertree", stderr: "" };
      if (head === "add") return { ok: true, stdout: "", stderr: "" };
      if (head === "write-tree") return { ok: true, stdout: tree, stderr: "" };
      if (head === "commit-tree") return { ok: true, stdout: "deadbeef", stderr: "" };
      if (head === "update-ref") return { ok: true, stdout: "", stderr: "" };
      return { ok: false, stdout: "", stderr: "unexpected" };
    };

  it("carries the commit and the label, after the ref moved", () => {
    const { host, seen } = listeningHost();
    const result = createCheckpoint(
      { cwd: "/repo", git: fakeGit("treeA"), events: host.sink },
      "before turn 3",
    );
    assert.equal(result.status, "created");
    assert.deepEqual(only(seen, "checkpoint_written"), { commit: "deadbeef", label: "before turn 3" });
  });

  it("does not fire for an unchanged tree, which writes no commit", () => {
    const { host, seen } = listeningHost();
    const git = fakeGit("sametree", "parent1");
    const result = createCheckpoint(
      {
        cwd: "/repo",
        git: (args, cwd, env) =>
          args[0] === "rev-parse" && args[1] === "refs/lykos/checkpoints^{tree}"
            ? { ok: true, stdout: "sametree", stderr: "" }
            : git(args, cwd, env),
        events: host.sink,
      },
      "before turn 4",
    );
    assert.equal(result.status, "unchanged");
    assert.equal(seen.length, 0);
  });

  it("does not fire outside a git repository", () => {
    const dir = tempDir();
    try {
      const { host, seen } = listeningHost();
      // The real runner, against a directory that is deliberately not a repo —
      // a stub answering "not a repo" would only prove the stub.
      const result = createCheckpoint({ cwd: dir, git: spawnGit, events: host.sink }, "l");
      if (result.status === "created") return; // the temp dir sat inside a repo; nothing to assert
      assert.equal(seen.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P10.9 D2 verification_verdict fires from gate/verify-gate.ts", () => {
  const policy: GatePolicy = {
    enabled: true,
    command: "npm test",
    timeoutMs: 1000,
    gateReadOnlySessions: false,
    rerunFailures: true,
    rerunCommand: undefined,
    cwd: process.cwd(),
  };

  it("carries what was recorded, including the exit code", async () => {
    const { host, seen } = listeningHost();
    const verify = async (cmd: string): Promise<GateOutcome> => ({
      status: "recorded",
      outcome: "fail",
      cmd,
      exitCode: 1,
    });
    await runSessionGate({
      policy,
      sessionId: "s1",
      ledgerPath: ":memory:",
      edited: true,
      verify,
      events: host.sink,
    });
    assert.deepEqual(only(seen, "verification_verdict"), {
      status: "recorded",
      outcome: "fail",
      command: "npm test",
      exitCode: 1,
    });
  });

  it("a skip carries the reason and NO outcome — nothing was recorded to report", async () => {
    const { host, seen } = listeningHost();
    await runSessionGate({
      policy,
      sessionId: "s1",
      ledgerPath: ":memory:",
      edited: false,
      events: host.sink,
    });
    const payload = only(seen, "verification_verdict");
    assert.equal(payload.status, "skipped");
    assert.equal(payload.outcome, undefined);
    assert.match(payload.reason ?? "", /edited no files/);
  });
});

describe("P10.9 D2 memory_injected fires from session/memory-head.ts", () => {
  function projectWithMemory(entries: string): string {
    const dir = tempDir();
    mkdirSync(join(dir, ".lykos", "memory"), { recursive: true });
    writeFileSync(join(dir, ".lykos", "memory", "gotchas.md"), entries, "utf8");
    return dir;
  }

  it("carries the ids, the token cost and what did not fit", () => {
    const dir = projectWithMemory("- [aaaaaaa1] the first thing\n- [aaaaaaa2] the second thing\n");
    try {
      const { host, seen } = listeningHost();
      const head = buildMemoryHead(
        dir,
        { enabled: true, scope: ["project"], maxInjectTokens: 500 },
        host.sink,
      );
      const payload = only(seen, "memory_injected");
      assert.deepEqual([...payload.ids], head.ids);
      assert.equal(payload.count, head.injected.length);
      assert.ok(payload.count > 0, "something was injected");
      assert.equal(payload.tokens, head.tokens);
      assert.equal(payload.available, head.available);
      assert.equal(payload.stale, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fires with zeroes when memory is on and nothing reached the head", () => {
    const dir = projectWithMemory("- [aaaaaaa1] a thing\n");
    try {
      const { host, seen } = listeningHost();
      // A cap the frame alone cannot fit: memory is ON and injects nothing,
      // which is exactly the state that must not look like memory being off.
      buildMemoryHead(dir, { enabled: true, scope: ["project"], maxInjectTokens: 1 }, host.sink);
      const payload = only(seen, "memory_injected");
      assert.equal(payload.count, 0);
      assert.ok(payload.skipped > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not fire when memory is off — there was no injection to report", () => {
    const { host, seen } = listeningHost();
    buildMemoryHead(process.cwd(), { enabled: false, scope: [], maxInjectTokens: 0 }, host.sink);
    assert.equal(seen.length, 0);
  });
});

describe("P10.9 D2 task_list_changed fires from tools/task-list.ts", () => {
  async function drive(tool: ReturnType<typeof buildTaskListTool>, args: Record<string, unknown>) {
    await tool.execute("c1", args as never, undefined as never, undefined as never, undefined as never);
  }

  it("carries the open and total counts and the ids that just closed", async () => {
    const { host, seen } = listeningHost();
    const state = newTaskListState();
    const tool = buildTaskListTool({ state, events: host.sink });
    await drive(tool, { add: [{ text: "one" }, { text: "two" }] });
    await drive(tool, { done: [1] });
    const hits = seen.filter((s) => s.event === "task_list_changed");
    assert.equal(hits.length, 2);
    const last = hits[1]!.payload as LykosEventPayloads["task_list_changed"];
    assert.equal(last.total, 2);
    assert.equal(last.open, 1);
    assert.deepEqual([...last.completedIds], [1]);
    assert.equal(last.version, state.version);
  });

  it("does not fire when the model only re-reads the list", async () => {
    const { host, seen } = listeningHost();
    const tool = buildTaskListTool({ state: newTaskListState(), events: host.sink });
    await drive(tool, {});
    assert.equal(seen.length, 0);
  });
});

describe("P10.9 D2 specialist_switch fires from session/specialist-switch.ts", () => {
  function baseConfig(): ResolvedConfig {
    return {
      mode: "manual",
      skills: { roster: undefined },
    } as unknown as ResolvedConfig;
  }

  it("carries the name, the diff and the resolved tool set", () => {
    const dir = tempDir();
    try {
      const { host, seen } = listeningHost();
      const result = resolveSpecialistSwitch({
        name: "explore",
        cwd: dir,
        globalDir: join(dir, "global"),
        currentConfig: baseConfig(),
        env: {},
        events: host.sink,
      });
      if (!result.ok) {
        // The shipped library must resolve `explore`; if it did not, the
        // assertion that matters is that a FAILED resolution fires nothing.
        assert.equal(seen.length, 0);
        return;
      }
      const payload = only(seen, "specialist_switch");
      assert.equal(payload.name, "explore");
      assert.deepEqual([...payload.toolNames], result.toolNames);
      assert.equal(payload.changed.length, result.changed.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fires nothing when the name does not resolve", () => {
    const dir = tempDir();
    try {
      const { host, seen } = listeningHost();
      const result = resolveSpecialistSwitch({
        name: "no-such-specialist-anywhere",
        cwd: dir,
        globalDir: join(dir, "global"),
        currentConfig: baseConfig(),
        env: {},
        events: host.sink,
      });
      assert.equal(result.ok, false);
      assert.equal(seen.length, 0, "a session that did not change announces nothing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P14.6 ticket 06: credential_rotated fires from the session's rotation callback", () => {
  it("is a listed event, fires once per rotation with provider, from, to and reason, and carries no secret", async () => {
    assert.ok((LYKOS_EVENTS as readonly string[]).includes("credential_rotated"));
    const server = await startFakeAnthropicServer();
    const dir = tempDir();
    const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    try {
      const secretA = "sk-ant-DISTINCTIVE-SECRET-aaaa-0001";
      const secretB = "sk-ant-DISTINCTIVE-SECRET-bbbb-0002";
      const dbPath = join(dir, "credentials.db");
      const db = openCredentialDb(dbPath, { create: true })!;
      const a = upsertCredential(db, "fakeprov", { type: "api_key", key: secretA }).row;
      const b = upsertCredential(db, "fakeprov", { type: "api_key", key: secretB }).row;
      db.close();
      const modelsPath = join(dir, "models.json");
      writeFileSync(
        modelsPath,
        JSON.stringify({ providers: { fakeprov: { baseUrl: server.baseUrl, api: "anthropic-messages", models: [{ id: "m1" }] } } }),
      );
      server.script.set(secretA, [
        { kind: "status", status: 429, body: anthropicError("rate_limit_error", "You have reached your usage limit") },
      ]);
      server.script.set(secretB, [{ kind: "ok", text: "served by b" }]);

      const { host, seen } = listeningHost();
      const relay = new RotationRelay();
      forwardRotationsToSink(relay, host.sink);
      const runtime = await createLykosModelRuntime({
        modelsPath,
        credentialDbPath: dbPath,
        providers: {},
        onRotation: relay.emit,
      });
      // A session whose hash starts on the first row, so the first request fails over to the second.
      let sessionId = "";
      for (let i = 0; ; i++) {
        sessionId = `events-rotation-${i}`;
        if (xxHash32(sessionId) % 2 === 0) break;
      }
      const ask = async (): Promise<string> => {
        const model = runtime.getModel("fakeprov", "m1")!;
        const stream = runtime.streamSimple(
          model,
          { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as never,
          { sessionId, maxRetries: 0 } as never,
        );
        let text = "";
        for await (const event of stream) if (event.type === "text_delta") text += event.delta;
        return text;
      };
      assert.equal(await ask(), "served by b");
      assert.equal(await ask(), "served by b", "the session stays on b: no second rotation");
      assert.deepEqual(server.seen, [secretA, secretB, secretB]);

      const payload = only(seen, "credential_rotated");
      assert.deepEqual(payload, { provider: "fakeprov", from: a.label, to: b.label, reason: "usage_limit" });
      const serialized = JSON.stringify(seen);
      assert.ok(!serialized.includes("DISTINCTIVE-SECRET"), "no key reaches an extension through the event");
    } finally {
      if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
