import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countEditErrors, countEditRetries, countEditToolCalls } from "./edit-retry.js";

describe("countEditToolCalls (T24.3)", () => {
  it("counts only edit calls, successful or not", () => {
    const calls = [
      { name: "read", state: "ok" },
      { name: "edit", state: "ok" },
      { name: "edit", state: "error" },
      { name: "bash", state: "ok" },
    ];
    assert.equal(countEditToolCalls(calls), 2);
  });

  it("is 0 on an undefined or empty trace", () => {
    assert.equal(countEditToolCalls(undefined), 0);
    assert.equal(countEditToolCalls([]), 0);
  });
});

describe("countEditErrors (T24.3)", () => {
  it("counts edit calls whose result was an error", () => {
    const calls = [
      { name: "edit", state: "ok", args: { path: "a.ts" } },
      { name: "edit", state: "error", args: { path: "a.ts" } },
      { name: "edit", state: "error", args: { path: "b.ts" } },
      { name: "read", state: "error" },
    ];
    assert.equal(countEditErrors(calls), 2);
  });
});

describe("countEditRetries (T24.3)", () => {
  it("counts an edit on a path whose most recent prior edit on that path failed", () => {
    const calls = [
      { name: "edit", state: "error", args: { path: "a.ts" } },
      { name: "edit", state: "ok", args: { path: "a.ts" } }, // retry, now succeeds
      { name: "edit", state: "ok", args: { path: "a.ts" } }, // not a retry, prior succeeded
    ];
    assert.equal(countEditRetries(calls), 1);
  });

  it("counts every consecutive retry, not just the first", () => {
    const calls = [
      { name: "edit", state: "error", args: { path: "a.ts" } },
      { name: "edit", state: "error", args: { path: "a.ts" } }, // retry #1 (also fails)
      { name: "edit", state: "ok", args: { path: "a.ts" } }, // retry #2 (succeeds)
    ];
    assert.equal(countEditRetries(calls), 2);
  });

  it("tracks paths independently", () => {
    const calls = [
      { name: "edit", state: "error", args: { path: "a.ts" } },
      { name: "edit", state: "ok", args: { path: "b.ts" } }, // different file, not a retry
      { name: "edit", state: "ok", args: { path: "a.ts" } }, // retry of a.ts
    ];
    assert.equal(countEditRetries(calls), 1);
  });

  it("excludes edit calls whose args carry no recoverable path", () => {
    const calls = [
      { name: "edit", state: "error", args: {} },
      { name: "edit", state: "ok", args: {} },
    ];
    assert.equal(countEditRetries(calls), 0);
  });

  it("accepts file and target as path aliases", () => {
    const calls = [
      { name: "edit", state: "error", args: { file: "a.ts" } },
      { name: "edit", state: "ok", args: { target: "a.ts" } },
    ];
    assert.equal(countEditRetries(calls), 1);
  });

  it("ignores non-edit tool calls entirely", () => {
    const calls = [
      { name: "edit", state: "error", args: { path: "a.ts" } },
      { name: "read", state: "ok", args: { path: "a.ts" } },
      { name: "bash", state: "error" },
    ];
    assert.equal(countEditRetries(calls), 0);
  });

  it("is 0 on an undefined trace", () => {
    assert.equal(countEditRetries(undefined), 0);
  });
});
