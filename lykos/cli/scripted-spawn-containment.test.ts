// `agent` chooses its child's containment.
//
// The seam is the `agent` tool itself with a stand-in container runtime behind
// the real containment code and a stubbed Pi session: what a child's ledger row
// says about containment, what the runtime was asked to start, and what the
// model is told when a spawn is refused.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { createAgentSession } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config/load.js";
import { startContainment, type Containment } from "../containment/containment.js";
import { AutoApproveGate } from "../gate/approval.js";
import { openLedgerSync } from "../ledger/use.js";
import { buildAgentTool, type SpawnContext } from "../tools/spawn.js";
import { standInRuntime, type StandInRuntime } from "./scripted-container.js";
import { mounted, reply, runScriptedSession, say, SCRIPTED_MODEL } from "./scripted-session.js";

// Keep Pi's agent dir off the real ~/.lykos/pi-host, as spawn.test.ts does.
process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));

const stubSession = (async (opts: any = {}) => ({
  session: {
    sessionId: `c-${Math.random().toString(36).slice(2)}`,
    model: opts.model ?? { provider: "deepseek", id: "deepseek-v4-flash" },
    systemPrompt: "stub",
    getActiveToolNames: () => [],
    setActiveToolsByName: () => {},
    abort: () => {},
    subscribe: () => () => {},
    prompt: async () => {},
    waitForIdle: async () => {},
    dispose: () => {},
  },
})) as unknown as typeof createAgentSession;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function workspace(projectConfig?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-t182-"));
  dirs.push(dir);
  if (projectConfig !== undefined) {
    mkdirSync(join(dir, ".lykos"), { recursive: true });
    writeFileSync(join(dir, ".lykos", "config.yaml"), projectConfig);
  }
  return dir;
}

/** A parent that started its own containment at `level` against `runtime`, as `runStandaloneTask` does. */
async function parentAt(
  dir: string,
  level: "off" | "auto" | "required",
  runtime: StandInRuntime,
  network?: "open" | "none",
): Promise<{ ctx: SpawnContext; parent: Containment }> {
  const parent = await startContainment({ config: { level, ...(network !== undefined ? { network } : {}) }, workspace: dir, sessionId: "p-test", drivers: [runtime.driver] });
  const { resolved: config } = loadConfig({ cwd: dir });
  const ctx: SpawnContext = {
    parentSessionId: "p-test",
    workspace: dir,
    ledgerPath: join(dir, "ledger.db"),
    config,
    modelSpec: "deepseek/deepseek-v4-flash",
    gate: new AutoApproveGate(),
    autoApprove: true,
    parentBrief: "brief",
    executionShape: "standalone",
    allowSpawn: true,
    executor: parent.executor,
    containment: parent.record,
    containmentDrivers: [runtime.driver],
    bootDeps: { createSession: stubSession },
    env: { ...process.env, DEEPSEEK_API_KEY: "sk-test-fake" },
  };
  return { ctx, parent };
}

/** A specialist in the project, so a child can be spawned under a network or image of its own. */
function specialist(dir: string, name: string, containment: string): void {
  mkdirSync(join(dir, ".lykos", "specialists"), { recursive: true });
  writeFileSync(join(dir, ".lykos", "specialists", `${name}.yaml`), `description: ${name}\ncontainment:\n${containment}\n`);
}

const spawnChild = (ctx: SpawnContext, containment?: "off" | "auto" | "required", subagentType?: string) =>
  (buildAgentTool(ctx) as any).execute(
    "call-1",
    {
      prompt: "look around",
      description: "look around",
      ...(containment !== undefined ? { containment } : {}),
      ...(subagentType !== undefined ? { subagent_type: subagentType } : {}),
    },
    undefined,
    undefined,
    undefined,
  ) as Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;

function childRows(ctx: SpawnContext) {
  const ledger = openLedgerSync(ctx.ledgerPath);
  try {
    return ledger.db
      .prepare(
        `SELECT containment_requested AS requested, containment_used AS used, container_runtime AS runtime
         FROM sessions WHERE parent_session_id = ?`,
      )
      .all(ctx.parentSessionId) as Array<{ requested: string | null; used: string | null; runtime: string | null }>;
  } finally {
    ledger.close();
  }
}

const starts = (runtime: StandInRuntime) => runtime.operations.filter((o) => o.op === "start").length;

describe("agent chooses its child's containment (T182)", () => {
  it("a contained parent spawns a contained child by default, in the parent's container, and the child's row says so", async () => {
    const runtime = standInRuntime();
    const { ctx, parent } = await parentAt(workspace(), "required", runtime);
    const out = await spawnChild(ctx);
    assert.equal(out.details.role, "explore", out.content[0]?.text);
    assert.deepEqual(childRows(ctx), [{ requested: "required", used: "required", runtime: "podman" }]);
    assert.equal(starts(runtime), 1, "the child reuses the parent's container");
    await parent.dispose();
  });

  it("a parent passing off gets an uncontained child, and the child's row says off", async () => {
    const runtime = standInRuntime();
    const { ctx, parent } = await parentAt(workspace(), "required", runtime);
    const out = await spawnChild(ctx, "off");
    assert.equal(out.details.role, "explore", out.content[0]?.text);
    assert.deepEqual(childRows(ctx), [{ requested: "off", used: "off", runtime: null }]);
    await parent.dispose();
  });

  it("a parent that was uncontained can ask for a contained child, which gets a container of its own, removed afterwards", async () => {
    const runtime = standInRuntime();
    const { ctx, parent } = await parentAt(workspace(), "off", runtime);
    const out = await spawnChild(ctx, "required");
    assert.equal(out.details.role, "explore", out.content[0]?.text);
    assert.deepEqual(childRows(ctx), [{ requested: "required", used: "required", runtime: "podman" }]);
    assert.equal(starts(runtime), 1);
    assert.deepEqual(runtime.running(), [], "the child's container is gone when the child ends");
    await parent.dispose();
  });

  it("off below a floor is refused naming the floor's file, and no child session is recorded", async () => {
    const runtime = standInRuntime();
    const dir = workspace("containment:\n  minimum: required\n");
    const { ctx, parent } = await parentAt(dir, "required", runtime);
    const out = await spawnChild(ctx, "off");
    const text = out.content[0]?.text ?? "";
    assert.match(text, /below the floor "required"/);
    assert.ok(text.includes(join(dir, ".lykos", "config.yaml")), text);
    assert.match(text, /spawn/);
    assert.deepEqual(childRows(ctx), []);
    await parent.dispose();
  });

  it("inheriting a level above the floor is not refused", async () => {
    const runtime = standInRuntime();
    const { ctx, parent } = await parentAt(workspace("containment:\n  minimum: auto\n"), "required", runtime);
    const out = await spawnChild(ctx);
    assert.equal(out.details.role, "explore", out.content[0]?.text);
    await parent.dispose();
  });

  it("auto under a contained required parent reuses the parent's container, and the row says what was asked and what was met", async () => {
    const runtime = standInRuntime();
    const { ctx, parent } = await parentAt(workspace(), "required", runtime);
    const out = await spawnChild(ctx, "auto");
    assert.equal(out.details.role, "explore", out.content[0]?.text);
    assert.equal(starts(runtime), 1);
    assert.deepEqual(childRows(ctx), [{ requested: "auto", used: "required", runtime: "podman" }]);
    await parent.dispose();
  });

  it("a specialist that wants no network does not share an open parent's container", async () => {
    const runtime = standInRuntime();
    const dir = workspace();
    specialist(dir, "offline", "  network: none");
    const { ctx, parent } = await parentAt(dir, "required", runtime, "open");
    const out = await spawnChild(ctx, undefined, "offline");
    assert.equal(out.details.role, "offline", out.content[0]?.text);
    const started = runtime.operations.filter((o) => o.op === "start");
    assert.equal(started.length, 2, "the child started a container of its own");
    assert.equal(started[1]?.op === "start" && started[1].spec.network, "none");
    await parent.dispose();
  });

  it("a child that starts its own container keeps a parent's no-network mode unless its specialist says otherwise", async () => {
    const runtime = standInRuntime();
    const dir = workspace();
    specialist(dir, "own-image", "  image: example/other:1");
    const { ctx, parent } = await parentAt(dir, "required", runtime, "none");
    const out = await spawnChild(ctx, undefined, "own-image");
    assert.equal(out.details.role, "own-image", out.content[0]?.text);
    const started = runtime.operations.filter((o) => o.op === "start");
    assert.equal(started.length, 2);
    const second = started[1];
    assert.equal(second?.op === "start" && second.spec.network, "none");
    assert.equal(second?.op === "start" && second.spec.image, "example/other:1");
    await parent.dispose();
  });
});

describe("agent through a real session (T182)", () => {
  it("a contained session's child boots on the parent's record and its row says required, in the parent's container", async () => {
    const runtime = standInRuntime();
    const s = await runScriptedSession({
      config: "feedback:\n  enabled: false\ngate:\n  enabled: false\ncontainment:\n  level: required\n",
      extra: { containmentDrivers: [runtime.driver], subagents: true },
      script: [
        reply(mounted("agent", { prompt: "look", description: "look around", model: SCRIPTED_MODEL })),
        reply(say("child answer")),
        reply(say("done")),
      ],
    });
    assert.equal(s.result.status, "ok", JSON.stringify(s.result));
    assert.equal(s.unusedSteps, 0);
    assert.equal(starts(runtime), 1, "one container for the family");
    const rows = s.query<{ requested: string; used: string; runtime: string }>(
      `SELECT containment_requested AS requested, containment_used AS used, container_runtime AS runtime
       FROM sessions WHERE parent_session_id IS NOT NULL`,
    );
    assert.deepEqual(rows, [{ requested: "required", used: "required", runtime: "podman" }]);
  });
});
