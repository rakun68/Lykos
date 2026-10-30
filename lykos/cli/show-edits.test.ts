// T168 part B (ADR-0031, decision 12): `readEdits` — the pure half of `lykos
// show`'s edit evidence. The scripted-session tests (`scripted-require-read.test
// .ts`) prove the measured case end to end; this file is every case where the
// answer is `unmeasured`, because AGENTS.md rule 4 says a number that cannot be
// computed is never estimated.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { TranscriptEventInput } from "../session/transcript.js";
import { readEdits, writeStrength, type StrengthRecord } from "./show-strength.js";

type PostEdit = StrengthRecord["post_edit"];

const NO_LOOP: PostEdit = { command: null, counted_runs: null, counted_failures: null, disabled_reason: null, runs: null };

function loop(verdicts: Array<"pass" | "fail" | "none">): PostEdit {
  return {
    command: "check",
    counted_runs: verdicts.length,
    counted_failures: verdicts.filter((v) => v === "fail").length,
    disabled_reason: null,
    runs: verdicts.map((verdict, i) => ({ seq: i + 1, ts_utc: "t", command: "check", verdict, exit_code: 0, ms: 1, shown: null })),
  };
}

const turn = (n: number): TranscriptEventInput => ({ kind: "turn_start", turn: n }) as TranscriptEventInput;
function result(name: string, state: "ok" | "error", text?: string, changes = false): TranscriptEventInput {
  return {
    kind: "tool_result",
    name,
    state,
    ...(text !== undefined ? { result: { content: [{ type: "text", text }] } } : {}),
    ...(changes ? { changes_files: true as const, path: "a.ts" } : {}),
  } as TranscriptEventInput;
}

describe("readEdits: what it will not guess", () => {
  it("no transcript read: everything unmeasured", () => {
    const e = readEdits(undefined, "stream", NO_LOOP);
    assert.equal(e.unmeasured_reason, "no transcript was read");
    assert.equal(e.calls, null);
    assert.equal(e.failures_by_reason, null);
    assert.equal(e.post_edit_failures_per_edit, null);
  });

  it("a snapshot transcript holds no per-call results, so no count is offered", () => {
    const e = readEdits([result("edit", "ok", "x", true)], "snapshot", loop(["pass"]));
    assert.match(e.unmeasured_reason ?? "", /snapshot/);
    assert.equal(e.calls, null);
    assert.equal(e.succeeded, null);
  });

  it("an unrecorded capture mode is unmeasured too", () => {
    assert.match(readEdits([], null, NO_LOOP).unmeasured_reason ?? "", /capture mode was not recorded/);
  });

  it("a stream transcript from before T146's turn marks still counts its edit calls, but not the per-edit ratio", () => {
    const e = readEdits([result("edit", "ok", "ok"), result("edit", "error", "Could not find the exact text in a.ts. x")], "stream", loop(["pass"]));
    assert.equal(e.unmeasured_reason, null);
    assert.equal(e.calls, 2);
    assert.equal(e.failures_by_reason?.not_found, 1);
    assert.equal(e.file_changing_calls, null);
    assert.equal(e.post_edit_failures_per_edit, null);
    assert.match(e.post_edit_failures_unmeasured_reason ?? "", /predates the file-change marks/);
  });

  it("the loop never ran: zero calls, and the ratio says why it has none", () => {
    const e = readEdits([turn(0), result("edit", "ok", "ok", true)], "stream", NO_LOOP);
    assert.equal(e.calls, 1);
    assert.equal(e.post_edit_failures_per_edit, null);
    assert.equal(e.post_edit_failures_unmeasured_reason, "the post-edit loop did not run");
    assert.equal(e.post_edit_failed_runs, null);
  });

  it("the loop ran after fewer calls than succeeded (it switched itself off): unmeasured, with both numbers in the reason", () => {
    const e = readEdits(
      [turn(0), result("edit", "ok", "ok", true), result("edit", "ok", "ok", true), result("edit", "ok", "ok", true)],
      "stream",
      loop(["fail", "pass"]),
    );
    assert.equal(e.post_edit_failures_per_edit, null);
    assert.equal(e.post_edit_failures_unmeasured_reason, "the post-edit loop ran after 2 of 3 file-changing call(s)");
    assert.equal(e.post_edit_failed_runs, 1);
  });

  it("no successful file-changing call: no ratio", () => {
    const e = readEdits([turn(0), result("edit", "error", "oldText must not be empty in a.ts.")], "stream", loop(["pass"]));
    assert.equal(e.post_edit_failures_unmeasured_reason, "no file-changing call succeeded");
  });
});

describe("readEdits: what it does count", () => {
  it("the denominator is every successful file-changing call, so a write in the mix is counted and the line can say so", () => {
    const e = readEdits(
      [turn(0), result("edit", "ok", "ok", true), result("write", "ok", "Wrote", true), result("edit", "error", "Found 3 occurrences of the text in a.ts.")],
      "stream",
      loop(["fail", "pass"]),
    );
    assert.equal(e.calls, 2);
    assert.equal(e.succeeded, 1);
    assert.equal(e.file_changing_calls, 2);
    assert.equal(e.post_edit_failures_per_edit, 0.5);
    assert.equal(e.failures_by_reason?.not_unique, 1);
  });

  it("a run that could not start is a run but not a failure", () => {
    const e = readEdits([turn(0), result("edit", "ok", "ok", true), result("edit", "ok", "ok", true)], "stream", loop(["none", "fail"]));
    assert.equal(e.post_edit_failures_per_edit, 0.5);
  });

  it("falls back to the ledger's counters when the per-run records were not kept", () => {
    const counted: PostEdit = { command: "c", counted_runs: 2, counted_failures: 1, disabled_reason: null, runs: null };
    const e = readEdits([turn(0), result("edit", "ok", "ok", true), result("edit", "ok", "ok", true)], "stream", counted);
    assert.equal(e.post_edit_failures_per_edit, 0.5);
  });

  it("an error result with no readable text (a spilled stub, a bare object) is `other`, never dropped", () => {
    const stub = { kind: "tool_result", name: "edit", state: "error", result: { truncated: true, bytes: 9999, artifact: "x" } } as TranscriptEventInput;
    const bare = { kind: "tool_result", name: "edit", state: "error" } as TranscriptEventInput;
    const asString = { kind: "tool_result", name: "edit", state: "error", result: "Found 2 occurrences of the text in a.ts." } as TranscriptEventInput;
    const e = readEdits([stub, bare, asString], "stream", NO_LOOP);
    assert.equal(e.failed, 3);
    assert.equal(e.failures_by_reason?.other, 2);
    assert.equal(e.failures_by_reason?.not_unique, 1);
    const total = Object.values(e.failures_by_reason ?? {}).reduce((a, b) => a + b, 0);
    assert.equal(total, e.failed, "every failure lands in exactly one reason");
  });

  it("only `edit` calls are counted as edit calls", () => {
    const e = readEdits([turn(0), result("write", "error", "x"), result("read", "ok", "y"), result("edit", "ok", "z", true)], "stream", NO_LOOP);
    assert.equal(e.calls, 1);
  });
});

describe("writeStrength: the two new lines", () => {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  afterEach(() => {
    process.stdout.write = original;
    written.length = 0;
  });

  function render(edits: ReturnType<typeof readEdits>): string {
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const record: StrengthRecord = {
      post_edit: NO_LOOP,
      edits,
      task_list: { calls: null, items: null, updated_utc: null },
      extension_counters: [],
      reviewer: { counters: {}, reviews: [] },
    };
    writeStrength(record);
    process.stdout.write = original;
    return written.join("");
  }

  it("an unmeasured session prints `unmeasured` with the reason, and no failure line", () => {
    const text = render(readEdits([], "snapshot", NO_LOOP));
    assert.match(text, / edit calls unmeasured — the transcript is a snapshot, which holds no per-call results\n/);
    assert.doesNotMatch(text, / edit fails /);
  });

  it("a measured session prints only the non-zero reasons, in the fixed order", () => {
    const text = render(
      readEdits(
        [
          turn(0),
          result("edit", "ok", "ok", true),
          result("edit", "error", "`a.ts` changed since it was last read. Read it again before editing (edit.require_read is on)."),
          result("edit", "error", "Could not find the exact text in a.ts."),
          result("edit", "error", "Could not find the exact text in a.ts."),
          result("edit", "error", "`b.ts` has not been read in this session. Read it first (edit.require_read is on)."),
        ],
        "stream",
        loop(["fail"]),
      ),
    );
    assert.match(text, / edit calls 5 call\(s\), 1 succeeded, 4 failed; post-edit failures per successful edit 1\.00 \(1 failed post-edit run\(s\) over 1 successful file-changing call\(s\)\)\n/);
    assert.match(text, / edit fails not_found 2, unread 1, stale 1\n/);
  });
});
