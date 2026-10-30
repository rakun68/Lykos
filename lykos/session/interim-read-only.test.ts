// T208 interim (removed by T214): a Plan specialist session is read-only by a posture on the gate,
// keeps bash and exit_plan, and the posture ends when a plan is accepted.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ModelRuntime, createAgentSession } from "@earendil-works/pi-coding-agent";
import { boot, type BootConfig } from "./boot.js";
import { readOnlyPosture } from "./interactive.js";
import { loadConfig } from "../config/load.js";
import { AutoApproveGate, type ApprovalRequest } from "../gate/approval.js";

process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));

const req = (kind: ApprovalRequest["kind"], detail = "x"): ApprovalRequest => ({ kind, summary: kind, detail });

async function planSession(bootToo = true) {
  const cwd = mkdtempSync(join(tmpdir(), "lykos-plan-"));
  const { resolved: config } = loadConfig({ cwd, globalDir: join(cwd, ".g"), specialistName: "plan" });
  assert.equal(config.readOnly, true, "the shipped plan specialist is read-only");
  const posture = readOnlyPosture(config, { gate: new AutoApproveGate(), requestPlanExit: async () => "manual" });
  if (!bootToo) return { posture, captured: () => ({ tools: [], customTools: [] }) };
  let captured: { tools: string[]; customTools: Array<{ name: string; execute: (...a: unknown[]) => Promise<{ details?: Record<string, unknown> }> }> } = { tools: [], customTools: [] };
  const stub = (async (opts: any = {}) => {
    captured = { tools: [...(opts.tools ?? [])], customTools: opts.customTools ?? [] };
    return { session: { sessionId: "s", getActiveToolNames: () => captured.tools, setActiveToolsByName: () => {}, abort: () => {} } };
  }) as unknown as typeof createAgentSession;
  await boot(
    {
      cwd,
      config,
      model: { provider: "test", id: "stub" } as BootConfig["model"],
      modelRuntime: {} as ModelRuntime,
      gate: posture.gate,
      ledgerPath: ":memory:",
      modelSpec: "test/stub",
      specialistName: "plan",
      isPlanning: posture.isPlanning,
      requestPlanExit: posture.requestPlanExit!,
      currentMode: () => "manual",
    },
    { createSession: stub },
  );
  return { posture, captured: () => captured };
}

describe("a Plan specialist session (interim read-only posture)", () => {
  it("boots with bash and exit_plan, not the read-only-child tool cut", async () => {
    const { captured } = await planSession();
    assert.ok(captured().tools.includes("bash"), "bash stays");
    assert.ok(captured().tools.includes("exit_plan"), "exit_plan stays");
  });

  it("denies writes, edits and non-read bash naming read-only; runs reads and read-only bash", async () => {
    const { posture } = await planSession(false);
    for (const r of [req("write"), req("edit"), req("bash", "mkdir out"), req("bash", "rm a.ts")]) {
      assert.equal(await posture.gate.request(r), "deny", `${r.kind} ${r.detail}`);
      assert.match(posture.gate.denialReason!(r)!, /read-only/);
    }
    for (const r of [req("read"), req("bash", "git status"), req("bash", "ls -la")]) {
      assert.equal(await posture.gate.request(r), "allow", `${r.kind} ${r.detail}`);
    }
  });

  it("exit_plan, once accepted, lifts the posture for the rest of the session", async () => {
    const { posture, captured } = await planSession();
    assert.equal(await posture.gate.request(req("write")), "deny");
    const tool = captured().customTools.find((t) => t.name === "exit_plan")!;
    const out = await tool.execute("c1", { plan: "do it" });
    assert.equal(out.details?.exited, true, "the shipped isPlanning is true while the posture is on");
    assert.equal(await posture.gate.request(req("write")), "allow");
    assert.equal(await posture.gate.request(req("bash", "mkdir out")), "allow");
    const again = await tool.execute("c2", { plan: "again" });
    assert.equal(again.details?.reason, "not-planning", "after the lift exit_plan has nothing to exit");
  });

  it("a declined plan keeps the posture", async () => {
    const p = readOnlyPosture({ readOnly: true }, { gate: new AutoApproveGate(), requestPlanExit: async () => null });
    await p.requestPlanExit!("p");
    assert.equal(await p.gate.request(req("write")), "deny");
    assert.equal(p.isPlanning(), true);
  });
});
