import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  newStagnationState,
  observeToolCall,
  stagnationEnabledFromEnv,
  stagnationThresholdFromEnv,
  targetKey,
} from "./stagnation.js";

describe("targetKey", () => {
  it("keys bash on the command so different failing commands do not collide", () => {
    assert.equal(targetKey({ toolName: "bash", input: { command: "npm test" } }), "bash:npm test");
    assert.notEqual(
      targetKey({ toolName: "bash", input: { command: "npm test" } }),
      targetKey({ toolName: "bash", input: { command: "npm run lint" } }),
    );
  });

  it("keys file tools on the path", () => {
    assert.equal(targetKey({ toolName: "edit", input: { path: "a.ts" } }), "edit:a.ts");
    assert.equal(targetKey({ toolName: "write", input: { file_path: "b.ts" } }), "write:b.ts");
  });

  it("returns undefined when there is no recoverable target", () => {
    assert.equal(targetKey({ toolName: "edit", input: {} }), undefined);
    assert.equal(targetKey({ toolName: "edit" }), undefined);
  });
});

describe("observeToolCall", () => {
  const failing = { toolName: "edit", input: { path: "a.ts" }, isError: true };

  it("stays quiet below the threshold", () => {
    const s = newStagnationState();
    assert.equal(observeToolCall(s, failing, "stale anchor").action, "none");
    assert.equal(observeToolCall(s, failing, "stale anchor").action, "none");
  });

  it("warns on the third consecutive identical failure and quotes the error", () => {
    const s = newStagnationState();
    observeToolCall(s, failing, "stale anchor");
    observeToolCall(s, failing, "stale anchor");
    const v = observeToolCall(s, failing, "stale anchor");
    assert.equal(v.action, "warn");
    if (v.action !== "warn") return;
    assert.equal(v.failures, 3);
    assert.ok(v.note.includes("a.ts"));
    assert.ok(v.note.includes("stale anchor"));
    assert.ok(v.note.includes("A bare retry is not available"));
    assert.equal(s.trips, 1);
  });

  it("a success clears the counter completely", () => {
    const s = newStagnationState();
    observeToolCall(s, failing, "boom");
    observeToolCall(s, failing, "boom");
    observeToolCall(s, { toolName: "edit", input: { path: "a.ts" }, isError: false }, undefined);
    assert.equal(observeToolCall(s, failing, "boom").action, "none");
  });

  it("does not trip on three different failing targets", () => {
    const s = newStagnationState();
    for (const p of ["a.ts", "b.ts", "c.ts"]) {
      assert.equal(observeToolCall(s, { toolName: "edit", input: { path: p }, isError: true }, "x").action, "none");
    }
    assert.equal(s.trips, 0);
  });

  it("gives a grace window after the warning before escalating", () => {
    const s = newStagnationState();
    for (let i = 0; i < 3; i++) observeToolCall(s, failing, "stale anchor");
    // Failures 4 and 5 stay quiet: the model may be part-way through a
    // genuinely different approach that happens to fail once more.
    assert.equal(observeToolCall(s, failing, "stale anchor").action, "none");
    assert.equal(observeToolCall(s, failing, "stale anchor").action, "none");
  });

  it("escalates to stop at twice the threshold", () => {
    const s = newStagnationState();
    for (let i = 0; i < 5; i++) observeToolCall(s, failing, "stale anchor");
    const v = observeToolCall(s, failing, "stale anchor");
    assert.equal(v.action, "stop");
    if (v.action !== "stop") return;
    assert.ok(v.note.includes("handing back to the human"));
    assert.equal(s.stopped, true);
  });

  it("stops exactly once, never in a loop of its own", () => {
    const s = newStagnationState();
    for (let i = 0; i < 10; i++) observeToolCall(s, failing, "stale anchor");
    const after = observeToolCall(s, failing, "stale anchor");
    assert.equal(after.action, "none");
  });

  it("ignores calls with no recoverable target rather than guessing", () => {
    const s = newStagnationState();
    for (let i = 0; i < 5; i++) {
      assert.equal(observeToolCall(s, { toolName: "edit", input: {}, isError: true }, "x").action, "none");
    }
    assert.equal(s.trips, 0);
  });
});

describe("env resolution", () => {
  it("is on by default and off only on an explicit 0", () => {
    assert.equal(stagnationEnabledFromEnv({} as NodeJS.ProcessEnv), true);
    assert.equal(stagnationEnabledFromEnv({ LYKOS_STAGNATION_BRAKE: "0" } as NodeJS.ProcessEnv), false);
  });

  it("refuses a threshold below 2, which would trip on a first failure", () => {
    assert.equal(stagnationThresholdFromEnv({ LYKOS_STAGNATION_THRESHOLD: "1" } as NodeJS.ProcessEnv), 3);
    assert.equal(stagnationThresholdFromEnv({ LYKOS_STAGNATION_THRESHOLD: "5" } as NodeJS.ProcessEnv), 5);
  });
});
