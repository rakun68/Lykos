import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { appendHistory, historyPath, loadHistory, searchHistoryByPrefix } from "./history.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "lykos-history-"));
}

describe("T46.3: prompt history", () => {
  it("missing history is empty, not a crash", () => {
    assert.deepEqual(loadHistory(tmp()), []);
  });

  it("appendHistory persists and loadHistory reads it back, oldest first", () => {
    const dir = tmp();
    appendHistory(dir, "first");
    appendHistory(dir, "second");
    assert.deepEqual(loadHistory(dir), ["first", "second"]);
  });

  it("blank entries are never persisted", () => {
    const dir = tmp();
    appendHistory(dir, "   ");
    appendHistory(dir, "real");
    assert.deepEqual(loadHistory(dir), ["real"]);
  });

  it("history is capped, dropping the oldest first", () => {
    const dir = tmp();
    for (let i = 0; i < 10; i++) appendHistory(dir, `prompt ${i}`, 5);
    assert.deepEqual(loadHistory(dir, 5), ["prompt 5", "prompt 6", "prompt 7", "prompt 8", "prompt 9"]);
  });

  it("corrupt history on disk is treated as empty, never crashes", () => {
    const dir = tmp();
    mkdirSync(join(dir, ".lykos"), { recursive: true });
    writeFileSync(historyPath(dir), "not json{{{", "utf8");
    assert.deepEqual(loadHistory(dir), []);
  });

  it("history lives under .lykos/, not the ledger", () => {
    const dir = tmp();
    assert.equal(historyPath(dir), join(dir, ".lykos", "history.json"));
  });
});

describe("T46.3: prefix-filtered search — newest match first", () => {
  it("filters to entries starting with the prefix", () => {
    const history = ["fix the bug", "add a feature", "fix the header", "refactor"];
    assert.deepEqual(searchHistoryByPrefix(history, "fix"), ["fix the header", "fix the bug"]);
  });

  it("an empty prefix returns full history, newest first", () => {
    const history = ["a", "b", "c"];
    assert.deepEqual(searchHistoryByPrefix(history, ""), ["c", "b", "a"]);
  });

  it("no matches returns an empty array", () => {
    assert.deepEqual(searchHistoryByPrefix(["a", "b"], "zzz"), []);
  });
});
