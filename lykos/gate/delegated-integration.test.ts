// T213 integration tests:
// 1. A delegated write outside the directory is denied and appears in the MCP result's `denied` (ADR-0041).
// 2. A subagent under a parent deny rule cannot read the path (ADR-0042).
// 3. A subagent's ask reaches the parent gate labelled (ADR-0042).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { DelegatedGate, type DeniedAction } from "./delegated.js";
import { AutoApproveGate, type ApprovalGate, type ApprovalRequest, type ApprovalDecision } from "./approval.js";
import { buildAgentTool, type SpawnContext } from "../tools/spawn.js";
import { loadConfig } from "../config/load.js";
import type { createAgentSession } from "@earendil-works/pi-coding-agent";
import { call, reply, runScriptedSession, say } from "../cli/scripted-session.js";
import { runSessionChild } from "../cli/session-child.js";
import { encodeFrame, parseFrame, PROTOCOL_VERSION, type Frame, type SessionRequest } from "../delegate/session-protocol.js";
import { PassThrough } from "node:stream";

describe("T213 integration: delegated sessions and subagent inheritance", () => {
  it("a delegated write outside the directory is denied and appears in the MCP result's `denied`", async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "lykos-outside-"));
    const outsideFile = join(outsideDir, "forbidden.txt");

    try {
      // 1. Real delegated session via runScriptedSession
      const run = await runScriptedSession({
        files: { "index.txt": "hello\n" },
        autoApprove: false,
        extra: { delegated: true, interactionMode: "auto" },
        script: [
          reply(call("write", { path: outsideFile, content: "hacked" })),
          reply(say("done")),
        ],
      });

      assert.equal(run.result.status, "ok", JSON.stringify(run.result));
      assert.ok(run.result.denied !== undefined, "denied should be present on run.result");
      assert.ok(run.result.denied.length > 0, "denied array should not be empty");
      assert.equal(run.result.denied![0]!.kind, "write");
      assert.match(run.result.denied![0]!.rule, /outside the project directory/);

      // 2. Verify that runSessionChild packages this into the MCP result frame
      const input = new PassThrough();
      const lines: string[] = [];
      const req: SessionRequest = {
        version: PROTOCOL_VERSION,
        tool: "lykos_implement",
        label: "implement",
        workspace: run.workspace,
        prompt: "do something",
      };
      input.write(JSON.stringify(req) + "\n");

      const done = runSessionChild({
        input,
        write: (text) => void lines.push(...text.split("\n").filter((l) => l.length > 0)),
        env: { LYKOS_TRUST_SOURCE: "flag" },
        trustPath: join(outsideDir, "trust.json"),
        worktreesRoot: join(outsideDir, "worktrees"),
        runTask: async () => run.result,
      });

      await done;
      input.end();

      const frames = lines.map((l) => parseFrame(l)!).filter(Boolean);
      const resultFrame = frames.find((f): f is Extract<Frame, { type: "result" }> => f.type === "result");
      assert.ok(resultFrame, "a result frame must be emitted");
      assert.equal(resultFrame.result.outcome, "ok", JSON.stringify(resultFrame.result));
      assert.ok(resultFrame.result.denied !== undefined, "denied must be on SessionOutcome");
      assert.ok(resultFrame.result.denied.length > 0, "result frame denied should not be empty");
      assert.equal(resultFrame.result.denied![0]!.kind, "write");
      assert.match(resultFrame.result.denied![0]!.rule, /outside the project directory/);
    } finally {
      try { rmSync(outsideDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("a subagent under a parent deny rule cannot read the path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-subagent-deny-"));
    const ledgerPath = join(dir, "ledger.db");
    const { resolved: config } = loadConfig({ cwd: dir });

    let capturedOpts: any;
    const stubCreateSession = (async (opts: any) => {
      capturedOpts = opts;
      let active = [...(opts.tools ?? [])];
      return {
        session: {
          sessionId: "subagent-session-1",
          model: opts.model ?? { provider: "deepseek", id: "deepseek-v4-flash" },
          systemPrompt: "stub",
          getActiveToolNames: () => active,
          setActiveToolsByName: (n: string[]) => { active = [...n]; },
          abort: () => {},
          subscribe: () => () => {},
          prompt: async () => {},
          waitForIdle: async () => {},
          dispose: () => {},
        },
        head: "head",
        fingerprint: "fp",
      };
    }) as unknown as typeof createAgentSession;

    const parentGate = new DelegatedGate({
      mode: "auto",
      allowed: new Set(),
      denied: [],
      rules: [
        { pattern: "secret/**", access: "read", decision: "deny", source: "global" },
      ],
      ctx: { cwd: dir, home: dir, extraDirs: [], outside: { read: "ask", write: "ask" } },
    });

    const ctx: SpawnContext = {
      parentSessionId: "parent-1",
      workspace: dir,
      ledgerPath,
      config,
      modelSpec: "deepseek/deepseek-v4-flash",
      gate: parentGate,
      autoApprove: false,
      parentBrief: "parent task",
      executionShape: "standalone",
      allowSpawn: true,
      bootDeps: { createSession: stubCreateSession },
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "sk-fake",
        OPENAI_API_KEY: "sk-fake",
        DEEPSEEK_API_KEY: "sk-fake",
      },
    };

    try {
      // Create a secret file in the workspace
      writeFileSync(join(dir, "secret.txt"), "super secret");

      const agentTool = buildAgentTool(ctx);
      await (agentTool as any).execute("call-1", {
        prompt: "read the secret",
        description: "explore secret",
        subagent_type: "explore",
      });

      assert.ok(capturedOpts, "subagent session must be booted");
      const readTool = capturedOpts.customTools.find((t: any) => t.name === "read");
      assert.ok(readTool, "subagent should have read tool in customTools");

      // The subagent attempts to read a denied path
      await assert.rejects(
        async () => {
          await readTool.execute("read-call-1", { path: "secret/confidential.txt" });
        },
        (err: any) => {
          assert.match(err.message, /refused|denied/i);
          return true;
        },
      );
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("a subagent's ask reaches the parent gate labelled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-subagent-label-"));
    const ledgerPath = join(dir, "ledger.db");
    const { resolved: config } = loadConfig({ cwd: dir });

    const parentRequests: ApprovalRequest[] = [];
    const parentGate: ApprovalGate = {
      async request(req: ApprovalRequest): Promise<ApprovalDecision> {
        parentRequests.push(req);
        return "deny";
      },
    };

    let capturedOpts: any;
    const stubCreateSession = (async (opts: any) => {
      capturedOpts = opts;
      let active = [...(opts.tools ?? [])];
      return {
        session: {
          sessionId: "subagent-session-2",
          model: opts.model ?? { provider: "deepseek", id: "deepseek-v4-flash" },
          systemPrompt: "stub",
          getActiveToolNames: () => active,
          setActiveToolsByName: (n: string[]) => { active = [...n]; },
          abort: () => {},
          subscribe: () => () => {},
          prompt: async () => {},
          waitForIdle: async () => {},
          dispose: () => {},
        },
        head: "head",
        fingerprint: "fp",
      };
    }) as unknown as typeof createAgentSession;

    const ctx: SpawnContext = {
      parentSessionId: "parent-2",
      workspace: dir,
      ledgerPath,
      config,
      modelSpec: "deepseek/deepseek-v4-flash",
      gate: parentGate,
      autoApprove: false,
      parentBrief: "parent task",
      executionShape: "standalone",
      allowSpawn: true,
      bootDeps: { createSession: stubCreateSession },
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "sk-fake",
        OPENAI_API_KEY: "sk-fake",
        DEEPSEEK_API_KEY: "sk-fake",
      },
    };

    try {
      const agentTool = buildAgentTool(ctx);
      await (agentTool as any).execute("call-2", {
        prompt: "perform task",
        description: "explore task",
        subagent_type: "explore",
      });

      assert.ok(capturedOpts, "subagent session must be booted");
      const readTool = capturedOpts.customTools.find((t: any) => t.name === "read");
      assert.ok(readTool, "subagent should have read tool in customTools");

      // When the subagent tool encounters an ask (e.g. read an outside directory path)
      await assert.rejects(
        async () => {
          await readTool.execute("read-outside-1", { path: "/tmp/outside-probe.txt" });
        },
        (err: any) => {
          assert.match(err.message, /refused|denied|declined/i);
          return true;
        },
      );

      assert.equal(parentRequests.length, 1);
      // The gate sees the absolute path; on Windows "/tmp/x" resolves to "C:\tmp\x".
      const probe = resolve("/tmp/outside-probe.txt");
      assert.equal(parentRequests[0]!.summary, "[explore] read /tmp/outside-probe.txt");
      assert.equal(parentRequests[0]!.detail, probe);
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});
