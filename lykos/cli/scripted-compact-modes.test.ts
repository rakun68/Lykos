// P17 T191: `/compact <method>` through the interactive session and the ledger,
// the scripted-model seam (T142). What is checked is what a person could
// observe: the `compactions` rows, the number of model calls, and what the
// session said on its output -- never which function ran.
//
// A manual `/compact` is typed at the interactive prompt; the context is a
// dozen reads of 8 000 tokens each, which a shake can drop and a window of
// 400 000 never compacts by itself.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AutoApproveGate } from "../gate/approval.js";
import { runInteractiveStandaloneSession, type LineSource } from "../session/interactive.js";
import { openLedgerSync } from "../ledger/use.js";
import { call, fail, reply, say, SCRIPTED_MODEL, scriptedWorld, type ScriptStep } from "./scripted-session.js";

class Lines implements LineSource {
  constructor(private readonly lines: string[]) {}
  async next(): Promise<string | null> {
    return this.lines.shift() ?? null;
  }
  close(): void {
    this.lines.length = 0;
  }
}

const WINDOW = 400_000;
// The gauge's lines sit above anything this test builds, so only a typed /compact compacts.
const CONFIG = "self_compact:\n  models:\n    faux/scripted-1: { notice: 250k, warning: 300k, cutoff: 350k }\n";
const FILES = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`f${i}.txt`, String.fromCharCode(97 + i).repeat(40_000)]));
const READS: ScriptStep[] = Array.from({ length: 14 }, (_, i) => reply(call("read", { path: `f${i}.txt` })));

interface Row {
  trigger: string;
  result: string;
  method: string | null;
  fell_through: string | null;
  tokens_before: number | null;
  tokens_after: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

/** Runs the session with these typed lines after a first prompt that reads every file; returns what it printed and the ledger's rows. */
async function run(typed: string[], tail: ScriptStep[] = [], head: ScriptStep[] = [reply(say("done"))]) {
  const world = await scriptedWorld({ files: FILES, config: CONFIG, contextWindow: WINDOW, script: [...READS, ...head, ...tail] });
  let out = "";
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    out += String(chunk);
    return (original as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  let result;
  try {
    result = await runInteractiveStandaloneSession({
      workspace: world.workspace,
      ledgerPath: world.ledgerPath,
      model: SCRIPTED_MODEL,
      nativeProviders: [world.provider],
      lineSource: new Lines(["read them all", ...typed, "/exit"]),
      approvalGate: new AutoApproveGate(),
    });
  } finally {
    process.stdout.write = original;
  }
  world.check();
  assert.equal(result.status, "ok", JSON.stringify(result));
  const ledger = openLedgerSync(world.ledgerPath);
  let rows: Row[];
  try {
    rows = ledger.db
      .prepare(`SELECT trigger, result, method, fell_through, tokens_before, tokens_after, input_tokens, output_tokens FROM compactions ORDER BY ts_utc, rowid`)
      .all() as unknown as Row[];
  } finally {
    ledger.close();
  }
  return { out, rows, modelCalls: world.modelCalls(), unusedSteps: world.unusedSteps() };
}

describe("/compact <method> (T191)", () => {
  it("`/compact shake` runs shake alone: no model call, and the compactions row says shake", async () => {
    const r = await run(["/compact shake"]);
    assert.equal(r.unusedSteps, 0);
    assert.match(r.out, /compacted by shake, about \d+ to \d+ tokens \(an estimate\)/, "the session says how it went, not Pi's cancellation");
    assert.equal(r.modelCalls, 15, "the fourteen reads and the answer; the shake made no call");
    assert.equal(r.rows.length, 1, "Pi's cancelled compaction is not a second row");
    const [row] = r.rows as [Row];
    assert.equal(row.method, "shake");
    assert.equal(row.trigger, "manual");
    assert.equal(row.result, "ok");
    assert.deepEqual(JSON.parse(row.fell_through ?? "null"), []);
    assert.deepEqual([row.input_tokens, row.output_tokens], [0, 0]);
    assert.ok(row.tokens_before !== null && row.tokens_after !== null && row.tokens_before - row.tokens_after > 60_000, JSON.stringify(row));
  });

  it("`/compact shake <text>` is rejected with a message, and nothing runs", async () => {
    const r = await run(["/compact shake keep the auth work"]);
    assert.match(r.out, /\/compact shake takes no focus text/);
    assert.equal(r.rows.length, 0);
    assert.equal(r.modelCalls, 15);
    assert.equal(r.unusedSteps, 0);
  });

  it("`/compact shake` with an agent note left pending by a failed compaction runs shake, not Pi's summariser", async () => {
    // The agent saves a note; the compaction it asks for fails every attempt (SELF_COMPACT_MAX_ATTEMPTS = 3), so
    // the note is still pending at the prompt. A method the person typed wins over it.
    const outage = (n: number): ScriptStep => fail(`scripted summariser outage ${n}`);
    const r = await run(["/compact shake"], [outage(1), outage(2), outage(3)], [reply(call("self_compact", { note: "## Goal\nkeep going" }))]);
    assert.equal(r.unusedSteps, 0);
    assert.equal(r.modelCalls, 14 + 1 + 3, "no summariser call for the shake: the reads, the note, the three failed attempts");
    assert.deepEqual(
      r.rows.map((row) => [row.method, row.result]),
      [["note", "failed"], ["note", "failed"], ["note", "failed"], ["shake", "ok"]],
    );
    assert.match(r.out, /compacted by shake/);
  });

  it("`/compact <text>` with no method name is the compaction it always was: a handoff document with the text as focus", async () => {
    const seen: string[] = [];
    const side: ScriptStep = (ctx) => {
      seen.push(JSON.stringify(ctx.messages[ctx.messages.length - 1]?.content ?? ""));
      return reply(say("## Goal\nFinish the task.\n\n## Next Steps\n1. Nothing."));
    };
    const r = await run(["/compact keep the auth work"], [side]);
    assert.equal(r.unusedSteps, 0);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]?.method, "handoff");
    assert.match(seen[0] ?? "", /keep the auth work/, "the text reached the side call as focus");
  });
});
