// The picker's state machine and renderer.
//
// The requirement these tests exist for, in the task's own words: **T56's
// verdict is shown before you press Enter, not after**, and a
// `resumable = 0` row is visibly marked with its reason and cannot be
// selected. Both are asserted on the rendered lines, because a promise that
// only holds in the view model is a promise the person never sees.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionListRow } from "../session/listing.js";
import type { KeyEvent } from "./screen/input.js";
import {
  initialPickerState,
  pickerKey,
  pickerPageSize,
  renderPicker,
  renderPickerFallback,
  visibleRows,
} from "./session-picker.js";

const NOW = new Date("2026-09-03T12:00:00Z");

function row(id: string, over: Partial<SessionListRow> = {}): SessionListRow {
  return {
    id,
    taskId: null,
    taskBrief: null,
    brief: id,
    startedUtc: "2026-09-03T11:00:00.000Z",
    endedUtc: "2026-09-03T11:30:00.000Z",
    model: "deepseek/deepseek-v4-flash",
    executionShape: "standalone",
    outcome: null,
    outcomeSource: null,
    archiveState: "recent",
    captureMode: "stream",
    resumable: true,
    notResumableReason: null,
    parentSessionId: null,
    resumedFrom: null,
    costUsd: 0.0123,
    durationSeconds: 1800,
    depth: 0,
    edge: null,
    ...over,
  };
}

const key = (k: KeyEvent): KeyEvent => k;

describe("T58 picker navigation", () => {
  const rows = [row("aaaaaaaa"), row("bbbbbbbb"), row("cccccccc")];

  it("moves with the arrows and clamps at both ends", () => {
    let state = initialPickerState(rows);
    state = pickerKey(state, key({ type: "arrow", dir: "up" }), 10).state;
    assert.equal(state.cursor, 0);
    state = pickerKey(state, key({ type: "arrow", dir: "down" }), 10).state;
    state = pickerKey(state, key({ type: "arrow", dir: "down" }), 10).state;
    state = pickerKey(state, key({ type: "arrow", dir: "down" }), 10).state;
    assert.equal(state.cursor, 2);
  });

  it("scrolls so the cursor stays inside the window", () => {
    const many = Array.from({ length: 20 }, (_, i) => row(`s${i}`));
    let state = initialPickerState(many);
    for (let i = 0; i < 6; i += 1) state = pickerKey(state, key({ type: "arrow", dir: "down" }), 3).state;
    assert.equal(state.cursor, 6);
    assert.ok(state.scroll <= 6 && state.scroll + 3 > 6);
  });

  it("filters as you type and resets the cursor to the first match", () => {
    let state = initialPickerState(rows);
    state = pickerKey(state, key({ type: "arrow", dir: "down" }), 10).state;
    for (const ch of "cccc") state = pickerKey(state, key({ type: "char", value: ch }), 10).state;
    assert.equal(state.filter, "cccc");
    assert.deepEqual(visibleRows(state).map((r) => r.id), ["cccccccc"]);
    assert.equal(state.cursor, 0);
    for (let i = 0; i < 4; i += 1) state = pickerKey(state, key({ type: "backspace" }), 10).state;
    assert.equal(visibleRows(state).length, 3);
  });

  it("Enter selects the highlighted row", () => {
    let state = initialPickerState(rows);
    state = pickerKey(state, key({ type: "arrow", dir: "down" }), 10).state;
    const { action } = pickerKey(state, key({ type: "enter" }), 10);
    assert.equal(action.kind, "select");
    assert.equal(action.kind === "select" ? action.row.id : "", "bbbbbbbb");
  });

  it("Escape and Ctrl-C cancel", () => {
    const state = initialPickerState(rows);
    assert.equal(pickerKey(state, key({ type: "escape" }), 10).action.kind, "cancel");
    assert.equal(pickerKey(state, key({ type: "ctrl", key: "c" }), 10).action.kind, "cancel");
  });
});

describe("T58 a session that cannot be resumed", () => {
  const rows = [
    row("hop1hop1", {
      resumable: false,
      notResumableReason: "MCP hop-1 sessions have no local transcript to replay",
    }),
  ];

  it("cannot be selected, and Enter answers with the recorded reason VERBATIM", () => {
    const state = initialPickerState(rows);
    const { action } = pickerKey(state, key({ type: "enter" }), 10);
    assert.equal(action.kind, "refused");
    // `08` §1.1: never softened into a generic error message.
    assert.equal(
      action.kind === "refused" ? action.reason : "",
      "MCP hop-1 sessions have no local transcript to replay",
    );
  });

  it("is visibly marked in the rendered detail panel", () => {
    const lines = renderPicker(initialPickerState(rows), { width: 100, height: 12, now: NOW });
    assert.ok(lines.some((l) => l.includes("not resumable") && l.includes("MCP hop-1")));
  });
});

describe("T58 the verdict is on screen before Enter is pressed", () => {
  const rows = [row("aaaaaaaa"), row("bbbbbbbb")];

  it("shows the highlighted row's estimated rebuild cost", () => {
    const lines = renderPicker(initialPickerState(rows), {
      width: 100,
      height: 14,
      now: NOW,
      verdictFor: (r) =>
        r.id === "aaaaaaaa"
          ? { overall: "proceed", summary: "replays 94200 tokens ≈ $0.1200", estimateTokens: 94_200 }
          : { overall: "warn", summary: "HEAD has moved since this session ran" },
    });
    assert.ok(lines.some((l) => l.includes("proceed") && l.includes("94200 tokens")));
    // Only the highlighted row's verdict is computed — the other row's is not
    // on screen, which is what keeps a thousand-row list to one preflight.
    assert.ok(!lines.some((l) => l.includes("HEAD has moved")));
  });

  it("says so plainly when no verdict has been computed yet, rather than implying safety", () => {
    const lines = renderPicker(initialPickerState(rows), { width: 80, height: 12, now: NOW });
    assert.ok(lines.some((l) => l.includes("checking")));
  });
});

describe("T58 rendering", () => {
  it("never exceeds the height it was given, and draws the tree edge for a nested row", () => {
    const rows = [row("parent00"), row("child000", { depth: 1, edge: "subagent" }), row("resumed0", { depth: 1, edge: "resumed" })];
    const lines = renderPicker(initialPickerState(rows), { width: 100, height: 11, now: NOW });
    assert.ok(lines.length <= 11);
    assert.ok(lines.some((l) => l.includes("└─ ")));
    assert.ok(lines.some((l) => l.includes("└→ ")));
  });

  it("displays an agent's own claim as a claim, never as a success", () => {
    const rows = [row("claimed0", { outcome: "success", outcomeSource: "agent_claim" })];
    const lines = renderPicker(initialPickerState(rows), { width: 100, height: 12, now: NOW });
    assert.ok(lines.some((l) => l.includes("success?")));
  });

  it("leaves room for the chrome it always draws", () => {
    assert.equal(pickerPageSize(24), 18);
    assert.equal(pickerPageSize(3), 1);
  });
});

describe("T58 the append-only fallback", () => {
  it("numbers the rows and marks the ones that cannot be resumed", () => {
    const lines = renderPickerFallback(
      [row("aaaaaaaa"), row("bbbbbbbb", { resumable: false, notResumableReason: "hop-1" })],
      { now: NOW },
    );
    assert.match(lines[0]!, /^\s*1\)/);
    assert.match(lines[1]!, /\[not resumable\]/);
  });

  it("says how many it did not print rather than silently truncating", () => {
    const many = Array.from({ length: 30 }, (_, i) => row(`s${i}`));
    const lines = renderPickerFallback(many, { now: NOW, limit: 5 });
    assert.equal(lines.length, 6);
    assert.match(lines[5]!, /25 more/);
  });
});
