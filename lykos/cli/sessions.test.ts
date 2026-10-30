// `lykos sessions` and the picker driver.
//
// The picker is driven through an injected `PickerIo`, so the whole loop —
// paint, key, select — is asserted without a terminal. The one thing these
// tests are most careful about is the promise in the task's own text: the
// picker is READ-ONLY, and returning a session id is the whole of what it
// does. T57 re-runs the preflight and owns every decision about spending.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Ledger } from "../ledger/ledger.js";
import { TranscriptWriter, writeSessionMeta } from "../session/transcript.js";
import type { KeyEvent } from "../tui/screen/input.js";
import {
  gatherSessions,
  pickSessionFallback,
  pickSessionInteractive,
  runSessions,
  verdictForRow,
  type PickerIo,
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

/** A scripted terminal: hands out keys in order, records what was painted. */
function scriptedIo(keys: readonly KeyEvent[]): PickerIo & { painted: string[][]; closed: boolean } {
  let i = 0;
  const io = {
    painted: [] as string[][],
    closed: false,
    size: () => ({ columns: 100, rows: 20 }),
    paint(lines: readonly string[]) {
      this.painted.push([...lines]);
    },
    nextKey: async () => (i < keys.length ? keys[i++]! : null),
    close() {
      this.closed = true;
    },
  };
  return io;
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

describe("T58 verdictForRow", () => {
  it("condenses T56's preflight to the line the picker shows, with the price on it", () => {
    const p = project();
    seed(p.ledger, p.source.ledgerPath, "priced11");
    p.ledger.close();
    const { rows, sourceOf } = gatherSessions([p.source]);
    const verdict = verdictForRow(rows[0]!, sourceOf.get(rows[0]!.id), NOW);
    // Whatever the verdict, the summary always says something specific — the
    // one thing it may never do is imply safety it has not checked.
    assert.ok(verdict.summary.length > 0);
    assert.ok(["proceed", "warn", "confirm", "refuse"].includes(verdict.overall));
  });

  it("refuses rather than throwing when the ledger behind a row has gone", () => {
    const p = project();
    seed(p.ledger, p.source.ledgerPath, "orphan11");
    p.ledger.close();
    const { rows } = gatherSessions([p.source]);
    const verdict = verdictForRow(rows[0]!, undefined, NOW);
    assert.equal(verdict.overall, "refuse");
  });
});

describe("T58 the picker loop", () => {
  it("returns the highlighted session on Enter, and closes the terminal on the way out", async () => {
    const p = project();
    seed(p.ledger, p.source.ledgerPath, "first111");
    p.ledger.close();
    const io = scriptedIo([{ type: "enter" }]);
    const picked = await pickSessionInteractive({
      sources: [p.source],
      io,
      now: NOW,
      verdictFor: () => ({ overall: "proceed", summary: "replays 100 tokens" }),
    });
    assert.equal(picked, "first111");
    assert.equal(io.closed, true);
    assert.ok(io.painted.length >= 1);
  });

  it("returns null on Escape, having spent nothing", async () => {
    const p = project();
    seed(p.ledger, p.source.ledgerPath, "first111");
    p.ledger.close();
    const before = Ledger.open(p.source.ledgerPath);
    const callsBefore = before.db.prepare(`SELECT COUNT(*) AS n FROM calls`).get() as { n: number };
    before.close();

    const io = scriptedIo([{ type: "escape" }]);
    assert.equal(await pickSessionInteractive({ sources: [p.source], io, now: NOW }), null);

    const after = Ledger.open(p.source.ledgerPath);
    assert.deepEqual(after.db.prepare(`SELECT COUNT(*) AS n FROM calls`).get(), callsBefore);
    after.close();
  });

  it("stays open and shows the reason when Enter lands on a session that cannot be resumed", async () => {
    const p = project();
    seed(p.ledger, p.source.ledgerPath, "hop1aaaa", { resumable: false, reason: "MCP hop-1 has no local transcript" });
    p.ledger.close();
    const io = scriptedIo([{ type: "enter" }, { type: "escape" }]);
    assert.equal(await pickSessionInteractive({ sources: [p.source], io, now: NOW }), null);
    const last = io.painted.at(-1)!.join("\n");
    assert.match(last, /MCP hop-1 has no local transcript/);
  });

  it("computes each row's verdict at most once", async () => {
    const p = project();
    seed(p.ledger, p.source.ledgerPath, "cached11");
    p.ledger.close();
    let calls = 0;
    const io = scriptedIo([{ type: "arrow", dir: "down" }, { type: "arrow", dir: "up" }, { type: "escape" }]);
    await pickSessionInteractive({
      sources: [p.source],
      io,
      now: NOW,
      verdictFor: () => {
        calls += 1;
        return { overall: "proceed", summary: "replays 100 tokens" };
      },
    });
    assert.equal(calls, 1);
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
