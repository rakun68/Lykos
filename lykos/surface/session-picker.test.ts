// The numbered session list: every row numbered, a row that cannot be resumed marked, an agent's claim never shown
// as a success.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionListRow } from "../session/listing.js";
import { renderPickerFallback } from "./session-picker.js";

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

describe("T58 the append-only fallback", () => {
  it("numbers the rows and marks the ones that cannot be resumed", () => {
    const lines = renderPickerFallback(
      [row("aaaaaaaa"), row("bbbbbbbb", { resumable: false, notResumableReason: "hop-1" })],
      { now: NOW },
    );
    assert.match(lines[0]!, /^\s*1\)/);
    assert.match(lines[1]!, /\[not resumable\]/);
  });

  it("displays an agent's own claim as a claim, never as a success", () => {
    const lines = renderPickerFallback([row("claimed0", { outcome: "success", outcomeSource: "agent_claim" })], { now: NOW });
    assert.ok(lines[0]!.includes("success?"));
  });

  it("says how many it did not print rather than silently truncating", () => {
    const many = Array.from({ length: 30 }, (_, i) => row(`s${i}`));
    const lines = renderPickerFallback(many, { now: NOW, limit: 5 });
    assert.equal(lines.length, 6);
    assert.match(lines[5]!, /25 more/);
  });
});
