// `lykos sessions` and the numbered picker `lykos resume` shows without a terminal. The picker is READ-ONLY:
// returning a session id is the whole of what it does. T57 re-runs the preflight and owns every decision about
// spending.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Ledger } from "../ledger/ledger.js";
import { TranscriptWriter, writeSessionMeta } from "../session/transcript.js";
import {
  gatherSessions,
  pickSessionFallback,
  runSessions,
  type SessionSource,
} from "./sessions.js";

const NOW = new Date("2026-09-03T12:00:00Z");

function project(): { source: SessionSource; ledger: Ledger; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "lykos-t58-cli-"));
  const ledgerPath = join(dir, "ledger.db");
  return {
    source: { ledgerPath, workspace: dir, projectName: null },
    ledger: Ledger.open(ledgerPath),
    dir,
  };
}

function seed(
  ledger: Ledger,
  ledgerPath: string,
  id: string,
  over: { resumable?: boolean; reason?: string; parent?: string; resumedFrom?: string; captureMode?: "stream" | "snapshot" } = {},
): void {
  const writer = new TranscriptWriter(ledgerPath, id);
  writer.append({ kind: "user_message", text: `do the thing in ${id}` });
  writer.append({ kind: "assistant_message", text: "done", final: false });
  const fin = writer.finalize();
  ledger.startSession({
    id,
    brief: `brief for ${id}`,
    model: "deepseek/deepseek-v4-flash",
    captureMode: over.captureMode ?? "stream",
    startedUtc: "2026-09-03T10:00:00.000Z",
    ...(over.resumable === false ? { resumable: false, notResumableReason: over.reason ?? "hop-1" } : {}),
    ...(over.parent ? { parentSessionId: over.parent } : {}),
    ...(over.resumedFrom ? { resumedFrom: over.resumedFrom } : {}),
  });
  ledger.endSession({
    id,
    endedUtc: "2026-09-03T10:30:00.000Z",
    transcriptPath: fin.path,
    transcriptSha256: fin.sha256,
    transcriptBytes: fin.bytes,
  });
  writeSessionMeta(ledgerPath, {
    schemaVersion: 2,
    sessionId: id,
    taskId: null,
    projectId: null,
    parentSessionId: over.parent ?? null,
    resumedFrom: over.resumedFrom ?? null,
    agentRole: "worker",
    model: "deepseek/deepseek-v4-flash",
    cwd: "/w",
    startedUtc: "2026-09-03T10:00:00.000Z",
    captureMode: over.captureMode ?? "stream",
  });
}

describe("T58 gatherSessions", () => {
  it("merges several ledgers and remembers which one each session came from", () => {
    const a = project();
    const b = project();
    seed(a.ledger, a.source.ledgerPath, "aaaa1111");
    seed(b.ledger, b.source.ledgerPath, "bbbb2222");
    a.ledger.close();
    b.ledger.close();

    const { rows, sourceOf } = gatherSessions([a.source, b.source]);
    assert.deepEqual(
      rows.map((r) => r.id).sort(),
      ["aaaa1111", "bbbb2222"],
    );
    assert.equal(sourceOf.get("aaaa1111")?.ledgerPath, a.source.ledgerPath);
    assert.equal(sourceOf.get("bbbb2222")?.ledgerPath, b.source.ledgerPath);
  });

  it("skips a project whose ledger has gone rather than failing the whole listing", () => {
    const a = project();
    seed(a.ledger, a.source.ledgerPath, "aaaa1111");
    a.ledger.close();
    const missing: SessionSource = { ledgerPath: join(a.dir, "nope.db"), workspace: a.dir, projectName: "gone" };
    assert.equal(gatherSessions([a.source, missing]).rows.length, 1);
  });
});

describe("T58 the append-only fallback", () => {
  it("reads a number and returns that session", async () => {
    const p = project();
    seed(p.ledger, p.source.ledgerPath, "aaaa1111");
    p.ledger.close();
    const out: string[] = [];
    const picked = await pickSessionFallback({
      sources: [p.source],
      now: NOW,
      read: async () => "1",
      write: (t) => out.push(t),
    });
    assert.equal(picked, "aaaa1111");
  });

  it("with no way to read, prints the list and names the explicit command instead of hanging", async () => {
    const p = project();
    seed(p.ledger, p.source.ledgerPath, "aaaa1111");
    p.ledger.close();
    const out: string[] = [];
    assert.equal(
      await pickSessionFallback({ sources: [p.source], now: NOW, write: (t) => out.push(t) }),
      null,
    );
    assert.match(out.join(""), /lykos resume <id>/);
  });

  it("rejects a number that is not on the list rather than picking something arbitrary", async () => {
    const p = project();
    seed(p.ledger, p.source.ledgerPath, "aaaa1111");
    p.ledger.close();
    const out: string[] = [];
    assert.equal(
      await pickSessionFallback({ sources: [p.source], now: NOW, read: async () => "9", write: (t) => out.push(t) }),
      null,
    );
    assert.match(out.join(""), /not one of/);
  });
});

describe("T58 lykos sessions", () => {
  it("prints the rows, and says how to resume one", () => {
    const p = project();
    seed(p.ledger, p.source.ledgerPath, "aaaa1111");
    p.ledger.close();
    const out: string[] = [];
    assert.equal(runSessions({ sources: [p.source], now: NOW, write: (t) => out.push(t) }), 0);
    const text = out.join("");
    assert.match(text, /aaaa1111/);
    assert.match(text, /lykos resume <id>/);
  });

  it("--json emits the rows with their nesting intact", () => {
    const p = project();
    seed(p.ledger, p.source.ledgerPath, "parent11");
    seed(p.ledger, p.source.ledgerPath, "child111", { parent: "parent11" });
    p.ledger.close();
    const out: string[] = [];
    runSessions({ sources: [p.source], json: true, write: (t) => out.push(t) });
    const rows = JSON.parse(out.join("")) as Array<{ id: string; depth: number; edge: string | null }>;
    assert.equal(rows.find((r) => r.id === "child111")?.depth, 1);
    assert.equal(rows.find((r) => r.id === "child111")?.edge, "subagent");
  });

  it("--filter narrows to what was asked for", () => {
    const p = project();
    seed(p.ledger, p.source.ledgerPath, "aaaa1111");
    seed(p.ledger, p.source.ledgerPath, "zzzz9999");
    p.ledger.close();
    const out: string[] = [];
    runSessions({ sources: [p.source], filter: "zzzz9999", now: NOW, write: (t) => out.push(t) });
    assert.match(out.join(""), /zzzz9999/);
    assert.ok(!out.join("").includes("aaaa1111"));
  });

  it("says nothing has been recorded rather than printing an empty table", () => {
    const p = project();
    p.ledger.close();
    const out: string[] = [];
    runSessions({ sources: [p.source], write: (t) => out.push(t) });
    assert.match(out.join(""), /nothing recorded yet/);
  });
});
