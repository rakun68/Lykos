// `lykos resume <id>`.
//
// The agent is never booted here: `runResume` takes an injectable `launch`,
// so everything this phase promises about identity, refusal and cost can be
// asserted without a model call. The one thing a test cannot show is a real
// follow-up answered from replayed context; that is the live acceptance, run
// against a real session.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Ledger } from "../ledger/ledger.js";
import { TranscriptWriter, readTranscript, writeSessionMeta } from "../session/transcript.js";
import { applyInheritedFlags, planFromPreflight, runResume, type LaunchInput } from "./resume.js";
import { preflightResume } from "../session/resume-preflight.js";
import { LiveTranscriptRecorder } from "../session/live-capture.js";

const OFF_PEAK = new Date("2026-08-29T12:00:00Z");

function realLedger(): { ledger: Ledger; ledgerPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "lykos-t57-"));
  const ledgerPath = join(dir, "ledger.db");
  return { ledger: Ledger.open(ledgerPath), ledgerPath, dir };
}

/** An original session worth resuming: stream-captured, hash-verified, attached to a task. */
function seedOriginal(
  ledger: Ledger,
  ledgerPath: string,
  id: string,
  opts?: { captureMode?: "stream" | "snapshot"; taskId?: string },
): void {
  const writer = new TranscriptWriter(ledgerPath, id);
  writer.append({ kind: "user_message", text: "rename the parser's entry point" });
  writer.append({ kind: "assistant_message", text: "renamed it to parseInput", final: false });
  writer.append({ kind: "user_message", text: "and update the callers" });
  const fin = writer.finalize();
  if (opts?.taskId) {
    ledger.ensureProject({ id: "proj", rootPath: "/work", createdUtc: "2026-09-01T00:00:00.000Z" });
    ledger.startTask({ id: opts.taskId, projectId: "proj", brief: "parser rename" });
  }
  ledger.startSession({
    id,
    brief: id,
    model: "deepseek/deepseek-v4-flash",
    captureMode: opts?.captureMode ?? "stream",
    ...(opts?.taskId ? { taskId: opts.taskId, projectId: "proj" } : {}),
    startedUtc: "2026-09-01T00:00:00.000Z",
  });
  ledger.endSession({
    id,
    endedUtc: "2026-09-01T01:00:00.000Z",
    transcriptPath: fin.path,
    transcriptSha256: fin.sha256,
    transcriptBytes: fin.bytes,
  });
  writeSessionMeta(ledgerPath, {
    schemaVersion: 2,
    sessionId: id,
    taskId: opts?.taskId ?? null,
    projectId: opts?.taskId ? "proj" : null,
    parentSessionId: null,
    resumedFrom: null,
    agentRole: "worker",
    model: "deepseek/deepseek-v4-flash",
    cwd: "/work",
    startedUtc: "2026-09-01T00:00:00.000Z",
    captureMode: opts?.captureMode ?? "stream",
    flags: { headContract: true, promptDiet: false, outputDiet: true },
  });
}

describe("T57 lykos resume", () => {
  it("refuses a snapshot-captured session, starts nothing and spends nothing", async () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seedOriginal(ledger, ledgerPath, "snap", { captureMode: "snapshot" });
    ledger.close();
    let launched = false;
    const code = await runResume(dir, ledgerPath, "snap", {
      yes: true,
      now: OFF_PEAK,
      launch: async () => {
        launched = true;
        return { status: "ok" as const };
      },
    });
    assert.equal(code, 1);
    assert.equal(launched, false);
  });

  it("--dry-run reports the preflight and starts nothing", async () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seedOriginal(ledger, ledgerPath, "dry");
    ledger.close();
    let launched = false;
    const code = await runResume(dir, ledgerPath, "dry", {
      dryRun: true,
      now: OFF_PEAK,
      launch: async () => {
        launched = true;
        return { status: "ok" as const };
      },
    });
    assert.equal(code, 0);
    assert.equal(launched, false);
  });

  it("carries the ORIGINAL's task_id, so a task resumed is one expensive task rather than two cheap ones", async () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seedOriginal(ledger, ledgerPath, "orig", { taskId: "task-parser" });
    ledger.close();
    let seen: LaunchInput | undefined;
    await runResume(dir, ledgerPath, "orig", {
      yes: true,
      now: OFF_PEAK,
      launch: async (input) => {
        seen = input;
        return { status: "ok" as const };
      },
    });
    assert.equal(seen?.resume.taskId, "task-parser");
    assert.equal(seen?.resume.projectId, "proj");
    assert.equal(seen?.resume.fromSessionId, "orig");
    // The model is the original's unless the caller names one.
    assert.equal(seen?.model, "deepseek/deepseek-v4-flash");
  });

  it("hands the launcher the exact bytes the preflight priced, and a non-zero estimate", async () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seedOriginal(ledger, ledgerPath, "bytes");
    ledger.close();
    let seen: LaunchInput | undefined;
    await runResume(dir, ledgerPath, "bytes", {
      yes: true,
      now: OFF_PEAK,
      launch: async (input) => {
        seen = input;
        return { status: "ok" as const };
      },
    });
    assert.ok(seen);
    assert.match(seen!.resume.replayText, /rename the parser's entry point/);
    assert.match(seen!.resume.replayText, /and update the callers/);
    assert.equal(seen!.resume.replayUserTurns, 2);
    assert.ok(seen!.resume.estimateTokens > 0);
    assert.ok((seen!.resume.estimateUsd ?? 0) > 0);
    assert.equal(seen!.resume.priceVersion !== null, true);
  });

  it("cancels rather than spending when the confirmation is declined", async () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seedOriginal(ledger, ledgerPath, "ask");
    ledger.close();
    let launched = false;
    const code = await runResume(dir, ledgerPath, "ask", {
      now: OFF_PEAK,
      lineSource: { next: async () => "n", close: () => {} },
      launch: async () => {
        launched = true;
        return { status: "ok" as const };
      },
    });
    assert.equal(code, 1);
    assert.equal(launched, false);
  });

  // 2026-09-07 (UI feedback item 1). This used to assert that the original
  // row was byte-identical after a resume, because a resume created a rival
  // row and linked back to it. A resume now CONTINUES the session it names,
  // so the row is reopened — and the assertion that matters is the narrow
  // one: reopening changes only the fields that said the run was over, and
  // touches nothing that carries a number or a verdict.
  it("reopens the session it continues, and changes nothing else about the row", async () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seedOriginal(ledger, ledgerPath, "untouched");
    const before = ledger.db.prepare(`SELECT * FROM sessions WHERE id = 'untouched'`).get() as Record<string, unknown>;
    ledger.close();
    await runResume(dir, ledgerPath, "untouched", {
      yes: true,
      now: OFF_PEAK,
      launch: async () => ({ status: "ok" as const }),
    });
    const after = Ledger.open(ledgerPath);
    const row = after.db.prepare(`SELECT * FROM sessions WHERE id = 'untouched'`).get() as Record<string, unknown>;
    after.close();

    assert.equal(row.ended_utc, null, "the session is live again");
    assert.equal(row.closed_utc, null);
    const reopened = new Set(["ended_utc", "closed_utc", "outcome", "outcome_source", "archive_state"]);
    for (const [key, value] of Object.entries(before)) {
      if (reopened.has(key)) continue;
      assert.deepEqual(row[key], value, `resume must not change ${key}`);
    }
    // The one that would actually corrupt a metric if it moved.
    assert.deepEqual(row.total_cost_usd, before.total_cost_usd);
    assert.deepEqual(row.started_utc, before.started_utc);
  });

  it("keeps a verified outcome across a resume, and drops a run-scoped one", async () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seedOriginal(ledger, ledgerPath, "verified");
    seedOriginal(ledger, ledgerPath, "abandoned");
    ledger.db
      .prepare(`UPDATE sessions SET outcome = 'success', outcome_source = 'verification_command' WHERE id = 'verified'`)
      .run();
    ledger.db.prepare(`UPDATE sessions SET outcome = 'abandoned' WHERE id = 'abandoned'`).run();
    ledger.close();

    for (const id of ["verified", "abandoned"]) {
      await runResume(dir, ledgerPath, id, { yes: true, now: OFF_PEAK, launch: async () => ({ status: "ok" as const }) });
    }
    const after = Ledger.open(ledgerPath);
    const verified = after.db.prepare(`SELECT outcome FROM sessions WHERE id = 'verified'`).get() as { outcome: string | null };
    const abandoned = after.db.prepare(`SELECT outcome FROM sessions WHERE id = 'abandoned'`).get() as { outcome: string | null };
    after.close();
    // A verification command's verdict is a fact about work that was
    // checked. Reopening the session does not un-check it.
    assert.equal(verified.outcome, "success");
    // `abandoned` described the run that stopped, and that run is being
    // continued — so it is cleared rather than left to describe a session
    // that is now live.
    assert.equal(abandoned.outcome, null);
  });
});

describe("T57 mechanism flags: inherited by default, overridden explicitly, recorded either way", () => {
  it("inherits the original's flags when the caller says nothing", () => {
    const env: NodeJS.ProcessEnv = {};
    const got = applyInheritedFlags({ flags: { promptDiet: false, outputDiet: true } }, {}, env);
    assert.deepEqual(got, { promptDiet: false, outputDiet: true, overridden: false });
    // Implemented by setting the environment the ONE existing reader
    // (dietEnabledFromEnv) already uses, rather than adding a second reader
    // that could disagree with it.
    assert.equal(env.LYKOS_PROMPT_DIET, "0");
    assert.equal(env.LYKOS_OUTPUT_DIET, "1");
  });

  it("an explicit flag overrides the original's, and the override is marked", () => {
    const env: NodeJS.ProcessEnv = {};
    const got = applyInheritedFlags({ flags: { promptDiet: false, outputDiet: true } }, { promptDiet: true }, env);
    assert.equal(got.promptDiet, true);
    assert.equal(got.overridden, true);
    assert.equal(env.LYKOS_PROMPT_DIET, "1");
  });

  it("a flag set to the value it already had is not an override", () => {
    const env: NodeJS.ProcessEnv = {};
    const got = applyInheritedFlags({ flags: { promptDiet: false } }, { promptDiet: false }, env);
    assert.equal(got.overridden, false);
  });
});

describe("T57 the resume marker", () => {
  it("opens the new transcript, naming the original, the turns replayed and the estimate", () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seedOriginal(ledger, ledgerPath, "src");
    const pre = preflightResume({ ledger, sessionId: "src", workspace: dir, now: OFF_PEAK });
    const plan = planFromPreflight(
      pre,
      { promptDiet: true, outputDiet: false, overridden: true },
      { taskId: null, projectId: null },
    );

    const recorder = new LiveTranscriptRecorder(ledgerPath, "new");
    recorder.resumeMarker({
      from: plan.fromSessionId,
      events: plan.replayEvents,
      user_turns: plan.replayUserTurns,
      estimate_tokens: plan.estimateTokens,
      estimate_usd: plan.estimateUsd,
      price_version: plan.priceVersion,
      ...(plan.flags !== undefined ? { inherited_flags: plan.flags } : {}),
    });
    recorder.userMessage("carry on");

    const { events } = readTranscript(recorder.finalize().path);
    assert.equal(events[0]!.kind, "resume");
    const marker = events[0] as unknown as {
      from: string;
      user_turns: number;
      estimate_tokens: number;
      inherited_flags: { overridden: boolean };
    };
    assert.equal(marker.from, "src");
    assert.equal(marker.user_turns, 2);
    assert.ok(marker.estimate_tokens > 0);
    // The override is recorded, not merely accepted.
    assert.equal(marker.inherited_flags.overridden, true);
    ledger.close();
  });
});
