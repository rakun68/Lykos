// T266: fork a session, through the scripted-model seam. A real interactive
// session, then `lykos resume --fork`'s own preflight and plan launching the
// fork as a real interactive session. What is checked is what a person could
// observe: what the fork's first request carried, the parent's transcript on
// disk, the ledger rows, `lykos sessions`, `lykos show` and the task's sum.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { AutoApproveGate } from "../gate/approval.js";
import { openLedgerSync } from "../ledger/use.js";
import { runInteractiveStandaloneSession, type LineSource } from "../session/interactive.js";
import { transcriptFilePath } from "../session/transcript.js";
import { runResume } from "./resume.js";
import { runSessions } from "./sessions.js";
import { runShow } from "./show.js";
import { listTasks } from "./task.js";
import { captureStdout, reply, say, SCRIPTED_MODEL, scriptedWorld, type ModelContext, type ScriptStep } from "./scripted-session.js";

class Lines implements LineSource {
  constructor(private readonly lines: string[]) {}
  async next(): Promise<string | null> {
    return this.lines.shift() ?? null;
  }
  close(): void {
    this.lines.length = 0;
  }
}

/** Every typed line lands in a session the scripted world answers; stdout and stderr are teed, never swallowed. */
async function teed<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  let out = "";
  const original = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const tee =
    (to: typeof original) =>
    (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      out += String(chunk);
      return (to as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
    };
  process.stdout.write = tee(original) as typeof process.stdout.write;
  process.stderr.write = tee(originalErr) as typeof process.stderr.write;
  try {
    return { value: await fn(), out };
  } finally {
    process.stdout.write = original;
    process.stderr.write = originalErr;
  }
}

async function forkScenario(parentLines: string[], parentScript: ScriptStep[]) {
  let forkFirst: ModelContext | undefined;
  const world = await scriptedWorld({
    script: [
      ...parentScript,
      (ctx) => {
        forkFirst = ctx;
        return reply(say("answered in the fork"));
      },
    ],
  });
  const session = (lines: string[], resume?: Parameters<typeof runInteractiveStandaloneSession>[0]["resume"]) =>
    runInteractiveStandaloneSession({
      workspace: world.workspace,
      ledgerPath: world.ledgerPath,
      model: SCRIPTED_MODEL,
      nativeProviders: [world.provider],
      lineSource: new Lines(lines),
      approvalGate: new AutoApproveGate(),
      askOutcome: false,
      ...(resume !== undefined ? { resume } : {}),
    });

  const parent = await teed(() => session(parentLines));
  assert.equal(parent.value.status, "ok", parent.out);
  const parentId = parent.value.status === "ok" ? parent.value.sessionId : "";
  const parentTranscript = readFileSync(transcriptFilePath(world.ledgerPath, parentId));

  let forkId: string | undefined;
  const forked = await teed(() =>
    runResume(world.workspace, world.ledgerPath, parentId, {
      fork: true,
      // A message's fork (`/__fork`) is cut before its prompt, as `cli/resume.ts` continues it.
      ...(parent.value.status === "ok" && parent.value.forkAt !== undefined
        ? { forkAt: parent.value.forkAt.turn, inputText: parent.value.forkAt.inputText }
        : {}),
      yes: true,
      launch: async (input) => {
        const result = await session(["third: in the fork", "/exit"], input.resume);
        if (result.status !== "ok") return { status: "error", message: result.message };
        forkId = result.sessionId;
        return { status: "ok", sessionId: result.sessionId };
      },
    }),
  );
  world.check();
  assert.equal(forked.value, 0, forked.out);
  assert.equal(world.unusedSteps(), 0, forked.out);
  assert.ok(forkId !== undefined && forkId !== parentId, "the fork is a new session");

  const row = (id: string) => {
    const ledger = openLedgerSync(world.ledgerPath);
    try {
      return ledger.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown>;
    } finally {
      ledger.close();
    }
  };
  return {
    parent: parent.value,
    parentId,
    forkId: forkId!,
    forkFirst: forkFirst!,
    parentTranscriptBefore: parentTranscript,
    parentTranscriptAfter: () => readFileSync(transcriptFilePath(world.ledgerPath, parentId)),
    row,
    sessions: () => {
      let text = "";
      runSessions({ sources: [{ ledgerPath: world.ledgerPath, workspace: world.workspace, projectName: null }], write: (t) => (text += t) });
      return text;
    },
    show: (id: string) => captureStdout("lykos show", () => runShow(world.ledgerPath, id, {})),
    tasks: () => {
      const ledger = openLedgerSync(world.ledgerPath);
      try {
        return listTasks(ledger);
      } finally {
        ledger.close();
      }
    },
  };
}

describe("fork a session (T266)", () => {
  it("/fork after two turns: a new session whose first request carries both, the parent's transcript untouched", async () => {
    const f = await forkScenario(["first: hello", "second: again", "/fork"], [reply(say("one")), reply(say("two"))]);
    assert.equal(f.parent.status === "ok" && f.parent.forkRequested, true, "/fork ends the parent and asks for the fork");

    const sent = JSON.stringify(f.forkFirst.messages);
    assert.match(sent, /first: hello/);
    assert.match(sent, /second: again/);
    assert.match(sent, /third: in the fork/);
    assert.ok(f.parentTranscriptAfter().equals(f.parentTranscriptBefore), "the parent's transcript is byte-identical");

    const fork = f.row(f.forkId);
    const parent = f.row(f.parentId);
    assert.equal(fork.forked_from, f.parentId);
    assert.equal(fork.forked_from_turn, 1, "two prompts, one turn each: turns 0 and 1");
    assert.equal(fork.task_id, parent.task_id, "the parent's task is kept");
    assert.equal(parent.forked_from, null);

    const listed = f.sessions();
    assert.match(listed, new RegExp(`${f.forkId.slice(0, 8)}.*forked from ${f.parentId.slice(0, 8)} at turn 1`));

    const task = f.tasks().find((t) => t.id === parent.task_id);
    assert.equal(task?.sessions, 2, "the task's cost sums both sessions");

    const show = f.show(f.forkId);
    assert.match(show, new RegExp(`forked +from ${f.parentId} at turn 1`));
    const marker = show.indexOf(`resume  from ${f.parentId}`);
    assert.ok(marker > 0, show);
    const copied = show.slice(0, marker);
    assert.match(copied, /first: hello/, "the fork's transcript holds the conversation it was copied from");
    assert.match(copied, /second: again/);
    assert.doesNotMatch(copied, /usage +hop=|outcome +state=/, "the parent's calls and outcome stay the parent's");
  });

  it("a message's fork: the copy is cut before that prompt, which waits in the input box", async () => {
    const f = await forkScenario(["first: hello", "second: again", "/__fork 0 second: again"], [reply(say("one")), reply(say("two"))]);
    assert.deepEqual(f.parent.status === "ok" && f.parent.forkAt, { turn: 1, inputText: "second: again" });
    const sent = JSON.stringify(f.forkFirst.messages);
    assert.match(sent, /first: hello/);
    assert.doesNotMatch(sent, /second: again/, "the prompt forked from and what followed stay behind");
    assert.match(sent, /third: in the fork/);
    assert.equal(f.row(f.forkId).forked_from_turn, 0, "the last turn before the cut");
    assert.ok(f.parentTranscriptAfter().equals(f.parentTranscriptBefore));
  });

  it("a message's revert takes code and conversation back to before that prompt", async () => {
    const f = await forkScenario(
      ["first: keep", "second: undo me", "/__rewind 0 second: undo me", "second: instead", "/exit"],
      [reply(say("one")), reply(say("undone")), reply(say("two"))],
    );
    const sent = JSON.stringify(f.forkFirst.messages);
    assert.match(sent, /first: keep/);
    assert.match(sent, /second: instead/);
    assert.doesNotMatch(sent, /undo me/, "the reverted turn is not carried");
  });

  it("lykos resume --fork on an ended session carries only the active branch, not the turns a rewind undid", async () => {
    const f = await forkScenario(
      ["first: keep", "second: undo me", "/rewind", "2", "2", "second: instead", "/exit"],
      [reply(say("one")), reply(say("undone")), reply(say("two"))],
    );
    assert.equal(f.parent.status === "ok" && f.parent.forkRequested, undefined);
    assert.ok(f.row(f.parentId).ended_utc !== null, "the parent had ended");

    const sent = JSON.stringify(f.forkFirst.messages);
    assert.match(sent, /first: keep/);
    assert.match(sent, /second: instead/);
    assert.doesNotMatch(sent, /undo me/, "the undone turn is not carried");
    assert.ok(f.parentTranscriptAfter().equals(f.parentTranscriptBefore));
    assert.equal(f.row(f.forkId).forked_from_turn, 2, "the last turn on the active branch");
  });
});
