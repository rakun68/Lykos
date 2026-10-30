import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildContinuationPrompt, decideContinuation } from "./continuation.js";
import { newTaskListState, type TaskListState } from "../tools.js";

const unfinished = (): TaskListState => ({
  ...newTaskListState(),
  items: [{ id: 1, text: "finish the migration", status: "pending" }],
  nextId: 2,
});

const ready = (overrides: Partial<Parameters<typeof decideContinuation>[0]> = {}) => ({
  enabled: true,
  thresholdReached: true,
  openItems: true,
  gateGreen: false,
  continuationsUsed: 0,
  cap: 1,
  fileChanged: true,
  taskListMoved: false,
  ...overrides,
});

describe("T109 decideContinuation", () => {
  it("continues only when the threshold, open-list, gate, cap, and progress conditions all allow it", () => {
    assert.deepEqual(decideContinuation(ready()), {
      action: "continue",
      reason: "unfinished-and-unverified",
    });
  });

  it("is off by default and cannot be enabled by an open task list", () => {
    assert.deepEqual(decideContinuation(ready({ enabled: false })), { action: "stop", reason: "disabled" });
  });

  it("stops before the boundary, after a green gate, or with no unfinished items", () => {
    assert.equal(decideContinuation(ready({ thresholdReached: false })).reason, "below-threshold");
    assert.equal(decideContinuation(ready({ gateGreen: true })).reason, "gate-passed");
    assert.equal(decideContinuation(ready({ openItems: false })).reason, "no-open-items");
  });

  it("enforces the hard cap before progress or stagnation can matter", () => {
    assert.equal(decideContinuation(ready({ continuationsUsed: 1 })).reason, "cap-reached");
    assert.equal(decideContinuation(ready({ cap: 0 })).reason, "cap-reached");
  });

  it("stops a continuation that changed neither files nor the task list", () => {
    assert.deepEqual(decideContinuation(ready({ fileChanged: false })), {
      action: "stop",
      reason: "stagnated",
    });
    assert.deepEqual(decideContinuation(ready({ fileChanged: false, taskListMoved: true })).action, "continue");
  });
});

describe("T109 buildContinuationPrompt", () => {
  it("names the disk facts and preserves the original instruction instead of carrying a summary", () => {
    const prompt = buildContinuationPrompt({
      predecessorSessionId: "session-1",
      continuationIndex: 1,
      taskListPath: ".lykos/session/session-1/tasks.json",
      taskList: unfinished(),
      checkpointRef: "refs/lykos/checkpoints",
      checkpointCommit: "abc123",
      verificationCommand: "npm test",
      contextFiles: [{ path: "CLAUDE.md", bytes: 1234 }],
      originalPrompt: "finish the migration",
    });

    assert.match(prompt, /Do not rely on a conversation summary/);
    assert.match(prompt, /tasks\.json/);
    assert.match(prompt, /1 \[ \] finish the migration/);
    assert.match(prompt, /refs\/lykos\/checkpoints -> abc123/);
    assert.match(prompt, /verification command: npm test/);
    assert.match(prompt, /CLAUDE\.md \(1234 bytes\)/);
    assert.match(prompt, /Original task instruction:\nfinish the migration/);
  });
});
