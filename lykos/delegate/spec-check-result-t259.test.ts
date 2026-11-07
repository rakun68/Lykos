// T259 ACCEPTANCE: the result shows the spec check and its points; `lykos status` shows them too.
//
// Seam: the MCP server over an in-memory transport with a stand-in session runner (as claim-result-t234.test.ts). The
// runner plays the session and records the check through `recordSpecCheck`, the writer the `spec_checked` tool uses.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { firstPositional, RUN_VALUED_FLAGS, unknownRunFlag } from "../cli/args.js";
import { loadConfig } from "../config/load.js";
import { defaultLedgerPath, openLedgerSync } from "../ledger/use.js";
import { TranscriptWriter } from "../session/transcript.js";
import { createMcpServer, ledgerViews } from "./mcp-server.js";
import { recordSpecCheck, type SpecPoint } from "./spec-check.js";
import type { SessionOutcome, SessionRequest, SessionRunner } from "./session-protocol.js";

const saved: Record<string, string | undefined> = {};
let home: string;
before(() => {
  home = mkdtempSync(join(tmpdir(), "lykos-t259r-home-"));
  for (const k of ["HOME", "USERPROFILE", "LYKOS_TRUST_WORKSPACE", "NODE_TEST_CONTEXT"]) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LYKOS_TRUST_WORKSPACE = "1";
  delete process.env.NODE_TEST_CONTEXT;
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();
}

function repo(config?: string): string {
  const ws = mkdtempSync(join(tmpdir(), "lykos-t259r-ws-"));
  git(ws, "init", "-q", "-b", "main");
  writeFileSync(join(ws, ".gitignore"), ".lykos/\n");
  writeFileSync(join(ws, "README.md"), "# project\n");
  if (config !== undefined) {
    mkdirSync(join(ws, ".lykos"), { recursive: true });
    writeFileSync(join(ws, ".lykos", "config.yaml"), config);
  }
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "first");
  return ws;
}

/** A session that ends with the given check (or none). */
function runner(ws: string, check: SpecPoint[] | undefined): SessionRunner {
  let n = 0;
  return async ({ request }) => {
    const id = (request as SessionRequest).newSessionId ?? `t259r-${++n}-${Date.now()}`;
    const ledgerPath = defaultLedgerPath(ws);
    const ledger = openLedgerSync(ledgerPath);
    try {
      ledger.startSession({ id, brief: "do it", executionShape: "mcp_worker", runtime: "host", workspace: ws, captureMode: "stream" });
      const transcript = new TranscriptWriter(ledgerPath, id);
      transcript.append({ kind: "assistant_message", text: "done", final: false });
      const file = transcript.finalize();
      ledger.endSession({ id, transcriptPath: file.path, transcriptSha256: file.sha256, transcriptBytes: file.bytes } as Parameters<typeof ledger.endSession>[0]);
      if (check !== undefined) recordSpecCheck(ledger, id, check);
    } finally {
      ledger.close();
    }
    return { outcome: "ok", answer: "done", sessionId: id } as SessionOutcome;
  };
}

type Result = Record<string, unknown> & { sessionId?: string; spec_check?: { points: SpecPoint[]; recorded_at: string } };

async function call(ws: string, tool: string, check: SpecPoint[] | undefined): Promise<Result> {
  const server = createMcpServer({ workspace: ws, version: "0.0.1-test", run: runner(ws, check) });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t259", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.callTool({ name: tool, arguments: { brief: "do it" } });
    return JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as Result;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("T259 ACCEPTANCE: the result shows the check and its points", () => {
  it("a recorded check is in the result with each point and its ruling", async () => {
    const ws = repo();
    const points: SpecPoint[] = [{ point: "Who gets the extra cent?", ruling: "The first people." }, { point: "Round up or down?" }];
    const r = await call(ws, "lykos_implement", points);
    assert.deepEqual(r.spec_check?.points, points, JSON.stringify(r));
    assert.match(r.spec_check?.recorded_at ?? "", /^\d{4}-\d\d-\d\dT/);
  });

  it("a recorded check with no points shows an empty list", async () => {
    const r = await call(repo(), "lykos_implement", []);
    assert.deepEqual(r.spec_check?.points, [], JSON.stringify(r));
    assert.ok(r.spec_check?.recorded_at);
  });

  it("a session that recorded none has nothing to show (it could not have edited)", async () => {
    const r = await call(repo(), "lykos_implement", undefined);
    assert.equal("spec_check" in r, false, JSON.stringify(r));
  });

  it("delegation.spec_check: false leaves it out of the result", async () => {
    const r = await call(repo("delegation:\n  spec_check: false\n"), "lykos_implement", undefined);
    assert.equal("spec_check" in r, false, JSON.stringify(r));
  });

  it("a read-only session has no check to show", async () => {
    const r = await call(repo(), "lykos_review", undefined);
    assert.equal("spec_check" in r, false, JSON.stringify(r));
  });

  it("lykos status shows the recorded check", async () => {
    const ws = repo();
    const points: SpecPoint[] = [{ point: "Which port?", ruling: "8080" }];
    const r = await call(ws, "lykos_implement", points);
    const views = ledgerViews(ws, [r.sessionId!]);
    const view = views[0] as unknown as { spec_check?: { points: SpecPoint[] } };
    assert.deepEqual(view.spec_check?.points, points, JSON.stringify(views));
  });
});

describe("T259: delegation.spec_check and --rulings-from", () => {
  it("defaults to on, reads false, and refuses anything but a boolean", () => {
    assert.equal(loadConfig({ cwd: repo() }).resolved.delegation.spec_check, true);
    assert.equal(loadConfig({ cwd: repo("delegation:\n  spec_check: false\n") }).resolved.delegation.spec_check, false);
    assert.throws(() => loadConfig({ cwd: repo('delegation:\n  spec_check: "no"\n') }), /delegation\.spec_check must be true or false/);
  });

  it("`lykos run` knows --rulings-from and takes its value", () => {
    assert.equal(unknownRunFlag(["--rulings-from", "abc,def", "review it"]), undefined);
    assert.equal(firstPositional(["--rulings-from", "abc", "review it"], RUN_VALUED_FLAGS), "review it");
  });
});
