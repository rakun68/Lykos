// T215 acceptance (sealed): a neutral head; specialist text and the mode go in the stream (ADR-0044).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ModelRuntime, createAgentSession } from "@earendil-works/pi-coding-agent";
import { boot, type BootConfig } from "./boot.js";
import { specialistStreamMessage } from "./specialist-stream.js";
import { loadConfig } from "../config/load.js";
import { AutoApproveGate } from "../gate/approval.js";

process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "lykos-t215-"));
  const dir = join(cwd, ".lykos", "specialists");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "alpha.yaml"), "description: a\nread_only: true\ninstructions: ALPHA-INSTRUCTIONS-7Q\ntools:\n  - read\n  - bash\n");
  writeFileSync(join(dir, "beta.yaml"), "description: b\ninstructions: BETA-INSTRUCTIONS-9Z\n");
  writeFileSync(join(dir, "solo.yaml"), "description: s\nprompt_mode: override\ninstructions: SOLO-OVERRIDE-HEAD-3K\n");
  return cwd;
}

async function bootAs(cwd: string, name: string, neutralHead: boolean) {
  const { resolved: config } = loadConfig({ cwd, globalDir: join(cwd, ".g"), specialistName: name });
  let head: string[] = [];
  let tools: string[] = [];
  let system = "";
  const stub = (async (opts: any = {}) => {
    head = [...(opts.resourceLoader?.getAppendSystemPrompt?.() ?? [])];
    system = String(opts.resourceLoader?.getSystemPrompt?.() ?? "");
    tools = [...(opts.tools ?? [])].sort();
    return { session: { sessionId: "s", getActiveToolNames: () => tools, setActiveToolsByName: () => {}, abort: () => {} } };
  }) as unknown as typeof createAgentSession;
  const booted = await boot(
    {
      cwd,
      config,
      model: { provider: "test", id: "stub" } as BootConfig["model"],
      modelRuntime: {} as ModelRuntime,
      gate: new AutoApproveGate(),
      ledgerPath: ":memory:",
      modelSpec: "test/stub",
      specialistName: name,
      neutralHead,
    },
    { createSession: stub },
  );
  return { head: [system, ...head].join("\n\u0000\n"), tools, booted };
}

describe("T215: the head of a session a person drives is neutral", () => {
  it("is byte-identical, tools included, under a read-only and a writing specialist", async () => {
    const cwd = project();
    const a = await bootAs(cwd, "alpha", true);
    const b = await bootAs(cwd, "beta", true);
    assert.equal(a.head, b.head);
    assert.deepEqual(a.tools, b.tools);
    assert.ok(!a.head.includes("ALPHA-INSTRUCTIONS-7Q"));
    assert.ok(!b.head.includes("BETA-INSTRUCTIONS-9Z"));
    assert.ok(a.tools.length > 2, "the request's tool list is the default set, not alpha's read+bash");
  });

  it("puts the specialist's instructions and the mode in the first stream message", async () => {
    const cwd = project();
    const { booted } = await bootAs(cwd, "alpha", true);
    const msg = (booted as { specialistMessage?: string }).specialistMessage ?? "";
    assert.match(msg, /ALPHA-INSTRUCTIONS-7Q/);
    assert.match(msg, /Manual|Accept Edits|Auto/);
  });
});

describe("T215: a switch revokes the previous instructions", () => {
  it("opens with a line saying the previous specialist's instructions no longer apply", () => {
    const msg = specialistStreamMessage({ name: "build", instructions: "BUILD-TEXT", modeLabel: "Manual", previous: "plan" });
    const first = msg.split("\n")[0]!;
    assert.match(first, /plan/);
    assert.match(first, /no longer apply/i);
    assert.match(msg, /BUILD-TEXT/);
    assert.match(msg, /Manual/);
  });

  it("the start message has no revoking line", () => {
    const msg = specialistStreamMessage({ name: "build", instructions: "BUILD-TEXT", modeLabel: "Auto" });
    assert.doesNotMatch(msg, /no longer apply/i);
    assert.match(msg, /BUILD-TEXT/);
  });
});

describe("T215: a subagent keeps today's head", () => {
  it("an override specialist still gets its own head", async () => {
    const cwd = project();
    const s = await bootAs(cwd, "solo", false);
    assert.ok(s.head.includes("SOLO-OVERRIDE-HEAD-3K"));
  });
});
