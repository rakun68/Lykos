// Every checkpoint records its session and turn, `lykos show` lists the turns that
// changed files with the checkpoint taken before each and flags one that has none,
// and `lykos rewind` shows the session each checkpoint belongs to.
//
// Proven through the scripted-model session (T142): the test reads only the
// ledger, `lykos show` and `lykos rewind`.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { call, reply, runScriptedSession, say } from "./scripted-session.js";

/** Turn 0 writes a.txt, turn 1 writes b.txt, turn 2 ends the session. */
function twoFileChangingTurns() {
  return runScriptedSession({
    files: { "a.txt": "one\n", "b.txt": "uno\n" },
    script: [
      reply(call("write", { path: "a.txt", content: "two\n" })),
      reply(call("write", { path: "b.txt", content: "dos\n" })),
      reply(say("done")),
    ],
  });
}

describe("checkpoints tied to their session and turn (T146)", () => {
  it("`lykos show` lists both file-changing turns with the checkpoint taken before each", async () => {
    const run = await twoFileChangingTurns();
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
    // A checkpoint before each of the three turns: the tree differed every time.
    assert.equal(run.session().checkpoints_written, 3);

    const shown = run.show();
    assert.match(shown, /edits\s+2 turn\(s\) changed files; every one has a checkpoint/);
    // T165: the command names the checkpoint by its hash, never by an index that shifts.
    assert.match(shown, /turn 0 {2}a\.txt {2}checkpoint ([0-9a-f]{8}) \(lykos rewind \1\)/);
    assert.match(shown, /turn 1 {2}b\.txt {2}checkpoint ([0-9a-f]{8}) \(lykos rewind \1\)/);
    assert.doesNotMatch(shown, /turn 2 /, "turn 2 only spoke, so it is not listed");
    assert.doesNotMatch(shown, /MISSING/);

    // The checkpoint `lykos show` names for a turn is the one `lykos rewind`
    // lists under this session and that turn.
    const listed = run.rewind();
    const id = run.sessionId;
    for (const turn of [0, 1]) {
      const commit = new RegExp(`turn ${turn} {2}\\S+ {2}checkpoint ([0-9a-f]{8})`).exec(shown)?.[1];
      assert.ok(commit !== undefined, `show names a checkpoint for turn ${turn}`);
      assert.match(listed, new RegExp(`${commit} .* before turn ${turn} {2}\\[session ${id} turn ${turn}\\]`));
    }
    assert.match(listed, new RegExp(`before turn 2 {2}\\[session ${id} turn 2\\]`));
  });

  it("a turn that starts on an unchanged tree still gets its own checkpoint once it changes a file", async () => {
    // Turn 0 only reads, so turn 1 starts on the tree turn 0's checkpoint
    // already holds and writes no commit then — until it edits.
    const run = await runScriptedSession({
      files: { "a.txt": "one\n" },
      script: [
        reply(call("read", { path: "a.txt" })),
        reply(call("write", { path: "a.txt", content: "two\n" })),
        reply(say("done")),
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);

    const shown = run.show();
    assert.match(shown, /edits\s+1 turn\(s\) changed files; every one has a checkpoint/);
    assert.match(shown, /turn 1 {2}a\.txt {2}checkpoint [0-9a-f]{8}/);
    assert.match(run.rewind(), new RegExp(`before turn 1 {2}\\[session ${run.sessionId} turn 1\\]`));
    // Before turn 0 (fresh ref), before turn 1 (on its edit), before turn 2 (tree changed).
    assert.equal(run.session().checkpoints_written, 3);
  });

  it("a turn that changed files with no checkpoint is flagged as missing", async () => {
    // Turn 1 deletes the checkpoint ref, which takes turn 0's checkpoint
    // with it; turn 2 starts a fresh one. Turn 0 still changed a file.
    const run = await runScriptedSession({
      files: { "a.txt": "one\n", "b.txt": "uno\n" },
      script: [
        reply(call("write", { path: "a.txt", content: "two\n" })),
        reply(call("bash", { command: "git update-ref -d refs/lykos/checkpoints" })),
        reply(call("write", { path: "b.txt", content: "dos\n" })),
        reply(say("done")),
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);

    const shown = run.show();
    assert.match(shown, /edits\s+2 turn\(s\) changed files; 1 MISSING a checkpoint/);
    assert.match(shown, /turn 0 {2}a\.txt {2}MISSING — no checkpoint was taken before this turn/);
    assert.match(shown, /turn 2 {2}b\.txt {2}checkpoint [0-9a-f]{8}/);
  });

  it("a checkpoint without a session or turn still lists and restores beside the new ones", async () => {
    const run = await twoFileChangingTurns();
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));

    // `lykos rewind --now` writes a checkpoint with no session and no turn —
    // the same record every checkpoint written before T146 has.
    writeFileSync(join(run.workspace, "a.txt"), "by hand\n");
    assert.match(run.rewind({ now: true }), /checkpoint [0-9a-f]{8} taken/);

    const listed = run.rewind();
    assert.match(listed, /^\s+0 {2}[0-9a-f]{8} {2}\S+ {2}manual checkpoint {2}\[session \(not recorded\)\]$/m);
    assert.match(listed, new RegExp(`^\\s+3 {2}[0-9a-f]{8} {2}\\S+ {2}before turn 0 {2}\\[session ${run.sessionId} turn 0\\]$`, "m"));

    // Restoring a session's checkpoint works with the legacy one on the ref…
    assert.match(run.rewind({ index: "3" }), /restored the working tree to [0-9a-f]{8} — before turn 0/);
    assert.equal(run.file("a.txt"), "one\n");
    assert.equal(run.file("b.txt"), "uno\n");
    // …and so does restoring the one without a session. It is still index 0:
    // the tree the restore replaced was the manual checkpoint's own, so its
    // safety checkpoint was `unchanged` and wrote nothing.
    assert.match(run.rewind({ index: "0" }), /restored the working tree to [0-9a-f]{8} — manual checkpoint/);
    assert.equal(run.file("a.txt"), "by hand\n");

    // `lykos show` still ties this session's turns to their checkpoints.
    assert.match(run.show(), /edits\s+2 turn\(s\) changed files; every one has a checkpoint/);
  });

  it("T165: `lykos rewind <hash>` restores the checkpoint `lykos show` named, even after later checkpoints shift the indexes", async () => {
    const run = await twoFileChangingTurns();
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    const shown = run.show();
    const beforeTurn0 = /turn 0 {2}a\.txt {2}checkpoint [0-9a-f]{8} \(lykos rewind ([0-9a-f]{8})\)/.exec(shown)?.[1];
    const beforeTurn1 = /turn 1 {2}b\.txt {2}checkpoint [0-9a-f]{8} \(lykos rewind ([0-9a-f]{8})\)/.exec(shown)?.[1];
    assert.ok(beforeTurn0 !== undefined && beforeTurn1 !== undefined, shown);

    // The listing shows the hashes it can be restored by.
    const listed = run.rewind();
    assert.match(listed, new RegExp(`\\b${beforeTurn0}\\b.*before turn 0`));
    assert.match(listed, /`lykos rewind <hash>`/);

    // A checkpoint written after `show` pushes every index down by one.
    writeFileSync(join(run.workspace, "a.txt"), "by hand\n");
    run.rewind({ now: true });

    // The hash still names the turn-1 checkpoint: b.txt is back to "uno", a.txt holds turn 0's write.
    assert.match(run.rewind({ index: beforeTurn1 }), new RegExp(`restored the working tree to ${beforeTurn1} — before turn 1`));
    assert.equal(run.file("a.txt"), "two\n");
    assert.equal(run.file("b.txt"), "uno\n");

    // Any unambiguous prefix works, and restores the turn-0 checkpoint.
    assert.match(run.rewind({ index: beforeTurn0.slice(0, 6).toUpperCase() }), /before turn 0/);
    assert.equal(run.file("a.txt"), "one\n");
    assert.equal(run.file("b.txt"), "uno\n");

    // Indexes still work: 0 is the safety checkpoint the last restore took.
    assert.match(run.rewind({ index: "0" }), /restored the working tree to [0-9a-f]{8} — before rewind to/);
    assert.equal(run.file("a.txt"), "two\n");
  });

  it("T165: an unknown hash is refused with a clear message and restores nothing", async () => {
    const run = await twoFileChangingTurns();
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    const before = run.rewind();
    writeFileSync(join(run.workspace, "a.txt"), "by hand\n");

    // No checkpoint hash can start with every one of these; pick one the ref does not hold.
    const hashes = [...before.matchAll(/^\s+\d+ {2}([0-9a-f]{8})/gm)].map((m) => m[1]!);
    const unknown = ["dead", "beef", "cafe", "f00d"].find((p) => !hashes.some((h) => h.startsWith(p)))!;
    assert.throws(() => run.rewind({ index: unknown }), new RegExp(`no checkpoint ${unknown}.*Nothing was restored`));
    assert.throws(() => run.rewind({ index: "not-a-hash" }), /expected a checkpoint hash/);
    assert.equal(run.file("a.txt"), "by hand\n");
    // Nothing was restored, so no safety checkpoint was taken either.
    assert.equal(run.rewind(), before);
  });
});
