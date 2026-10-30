// T213 (issue #81): explicit tool lists must be exact; implementer retains dispute_test.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ModelRuntime, createAgentSession } from "@earendil-works/pi-coding-agent";
import { SHIPPED_DEFAULTS } from "../config/defaults.js";
import { AutoApproveGate } from "../gate/approval.js";
import type { BootConfig } from "./boot.js";
import { boot } from "./boot.js";

async function bootWith(
  overrides: Partial<BootConfig> = {},
): Promise<{ tools: string[]; booted: Awaited<ReturnType<typeof boot>> }> {
  const cwd = overrides.cwd ?? mkdtempSync(join(tmpdir(), "lykos-boot-t213-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevPiHost = process.env.LYKOS_PI_HOST_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "pi-agent");
  process.env.LYKOS_PI_HOST_DIR = join(cwd, "pi-agent");
  let capturedTools: string[] = [];
  try {
    const stub = (async (opts: { tools?: string[] } = {}) => {
      capturedTools = [...(opts.tools ?? [])];
      return {
        session: {
          sessionId: "test-session",
          getActiveToolNames: () => capturedTools,
          setActiveToolsByName: (names: string[]) => {
            capturedTools = [...names];
          },
          abort: () => {},
        },
      };
    }) as unknown as typeof createAgentSession;

    const booted = await boot(
      {
        cwd,
        config: overrides.config ?? SHIPPED_DEFAULTS,
        model: overrides.model ?? ({ provider: "test", id: "stub" } as BootConfig["model"]),
        modelRuntime: overrides.modelRuntime ?? ({} as ModelRuntime),
        gate: overrides.gate ?? new AutoApproveGate(),
        ledgerPath: overrides.ledgerPath ?? ":memory:",
        modelSpec: overrides.modelSpec ?? "test/stub",
        ...(overrides.tools !== undefined ? { tools: overrides.tools } : {}),
        ...(overrides.specialistName !== undefined ? { specialistName: overrides.specialistName } : {}),
        ...(overrides.readOnly !== undefined ? { readOnly: overrides.readOnly } : {}),
      },
      { createSession: stub },
    );
    return { tools: capturedTools, booted };
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevPiHost === undefined) delete process.env.LYKOS_PI_HOST_DIR;
    else process.env.LYKOS_PI_HOST_DIR = prevPiHost;
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe("T213: explicit tool lists and resident extension tools (issue #81)", () => {
  it("the implementer specialist (which sets no tools) still has dispute_test resident", async () => {
    const { tools } = await bootWith({ specialistName: "implementer" });
    assert.equal(tools.includes("dispute_test"), true, "implementer must retain resident dispute_test");
  });

  it("an explicit caller tool list excludes resident extension tools not named", async () => {
    const { tools } = await bootWith({ tools: ["read", "bash"] });
    assert.deepEqual([...tools].sort(), ["bash", "read"]);
    assert.equal(tools.includes("dispute_test"), false);
  });

  it("an explicit caller tool list includes dispute_test when named", async () => {
    const { tools } = await bootWith({ tools: ["read", "dispute_test"] });
    assert.deepEqual([...tools].sort(), ["dispute_test", "read"]);
  });

  it("config.tools with tools_mode: override excludes resident extension tools not named", async () => {
    const { tools } = await bootWith({
      config: { ...SHIPPED_DEFAULTS, tools_mode: "override", tools: ["read"] },
    });
    assert.deepEqual(tools, ["read"]);
  });

  it("a read-only session excludes dispute_test", async () => {
    const { tools } = await bootWith({ readOnly: true });
    assert.equal(tools.includes("dispute_test"), false);
  });
});
