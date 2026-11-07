// Every MCP tool declares all four hints as booleans, read from the real tools/list.
// Seam: createMcpServer over an InMemoryTransport (as specialist-tools-t222.test.ts).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "./mcp-server.js";
import type { SessionOutcome } from "./session-protocol.js";

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

afterEach(() => {
  delete process.env.LYKOS_TRUST_WORKSPACE;
});

/** A git repository with one project specialist, so a project tool is listed too. */
function repo(): string {
  const workspace = mkdtempSync(join(tmpdir(), "lykos-hints-ws-"));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  mkdirSync(join(workspace, ".lykos", "specialists"), { recursive: true });
  writeFileSync(
    join(workspace, ".lykos", "specialists", "auditor.yaml"),
    "name: auditor\ndescription: Audit the repository.\nrole: subagent\nread_only: true\n",
  );
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: workspace });
  return workspace;
}

async function listTools(): Promise<Map<string, Tool>> {
  const home = mkdtempSync(join(tmpdir(), "lykos-hints-home-"));
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LYKOS_TRUST_WORKSPACE = "1";
  try {
    const ok: SessionOutcome = { outcome: "ok", answer: "done", sessionId: "sess-1" };
    const trustPath = join(mkdtempSync(join(tmpdir(), "lykos-hints-store-")), "trust.json");
    const server = createMcpServer({ workspace: repo(), version: "0.0.1-test", trustPath, run: async () => ok });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "lykos-hints-client", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      return new Map(tools.map((t) => [t.name, t]));
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("MCP tool hints", () => {
  it("every listed tool sets all four hints to a boolean", async () => {
    const tools = await listTools();
    assert.ok(tools.has("lykos_auditor"), `the project specialist is listed; got ${[...tools.keys()].join(", ")}`);
    for (const [name, tool] of tools) {
      for (const hint of HINTS) {
        assert.equal(typeof tool.annotations?.[hint], "boolean", `${name}.${hint} is a boolean`);
      }
    }
  });

  it("a tool that can start a writing session is destructive; a read-only one is not", async () => {
    const tools = await listTools();
    for (const name of ["lykos_start", "lykos_implement", "lykos_refactor", "lykos_debug", "lykos_general", "lykos_implementer"]) {
      assert.equal(tools.get(name)?.annotations?.readOnlyHint, false, `${name} is not read-only`);
      assert.equal(tools.get(name)?.annotations?.destructiveHint, true, `${name} is destructive`);
    }
    for (const name of ["lykos_review", "lykos_explore", "lykos_auditor", "lykos_status"]) {
      assert.equal(tools.get(name)?.annotations?.readOnlyHint, true, `${name} is read-only`);
      assert.equal(tools.get(name)?.annotations?.destructiveHint, false, `${name} is not destructive`);
    }
    for (const name of ["lykos_steer", "lykos_stop", "lykos_decide"]) {
      assert.equal(tools.get(name)?.annotations?.destructiveHint, false, `${name} is not destructive`);
    }
  });
});
