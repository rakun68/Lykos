import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  appendMemoryEntry,
  memoryFilePath,
  parseMemoryEntries,
  removeMemoryEntry,
} from "../memory.js";
import { runMemoryAdd, runMemoryForget, runMemoryList } from "./memory.js";

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-memorycli-"));
  mkdirSync(join(dir, ".lykos", "memory"), { recursive: true });
  writeFileSync(
    join(dir, ".lykos", "memory", "gotchas.md"),
    "# Project gotchas\n\nNon-obvious constraints and traps.\n",
    "utf8",
  );
  writeFileSync(
    join(dir, ".lykos", "memory", "failed-approaches.md"),
    "# Failed approaches\n\nThings tried and abandoned.\n",
    "utf8",
  );
  return dir;
}

function capture(streamName: "stdout" | "stderr", fn: () => number): { code: number; text: string } {
  const chunks: string[] = [];
  const stream = process[streamName];
  const original = stream.write.bind(stream);
  stream.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof stream.write;
  try {
    const code = fn();
    return { code, text: chunks.join("") };
  } finally {
    stream.write = original;
  }
}

describe("parseMemoryEntries", () => {
  it("parses entry lines and ignores header/prose lines", () => {
    const raw = "# Project gotchas\n\nSome prose.\n\n- [a1b2c3d4] the entry text\n- [deadbeef] another one\n";
    const entries = parseMemoryEntries(raw);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.id, "a1b2c3d4");
    assert.equal(entries[0]!.text, "the entry text");
    assert.equal(entries[1]!.id, "deadbeef");
  });
});

describe("appendMemoryEntry / removeMemoryEntry", () => {
  it("appends a line and leaves the rest of the file untouched", () => {
    const dir = tempProject();
    const path = memoryFilePath(dir, "project", "gotchas");
    const before = readFileSync(path, "utf8");

    const entry = appendMemoryEntry(path, "watch out for X");
    const after = readFileSync(path, "utf8");

    assert.ok(after.startsWith(before));
    // T77: `added` is written on every new entry — a memory with no date
    // cannot be aged, and problems/09's rot is a function of time.
    assert.equal(after, `${before}- [${entry.id}] watch out for X {added=${entry.meta.added}}\n`);
    assert.match(entry.meta.added ?? "", /^\d{4}-\d{2}-\d{2}$/);
  });

  it("creates the file with a minimal header when it doesn't exist yet (the global-scope case)", () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-memorycli-global-"));
    const path = join(root, "memory", "gotchas.md");
    appendMemoryEntry(path, "a lesson");
    const raw = readFileSync(path, "utf8");
    assert.match(raw, /^# Project gotchas/);
    assert.match(raw, /a lesson/);
  });

  it("removes exactly the matched entry, leaving every other line untouched", () => {
    const dir = tempProject();
    const path = memoryFilePath(dir, "project", "gotchas");
    const a = appendMemoryEntry(path, "first entry");
    const b = appendMemoryEntry(path, "second entry");
    const before = readFileSync(path, "utf8");

    const result = removeMemoryEntry(path, a.id);
    assert.equal(result.status, "removed");

    const after = readFileSync(path, "utf8");
    assert.ok(!after.includes("first entry"));
    assert.ok(after.includes("second entry"));
    assert.ok(before.includes(`[${b.id}] second entry`));
    assert.ok(after.includes(`[${b.id}] second entry`));
  });

  it("matches by substring when no id matches", () => {
    const dir = tempProject();
    const path = memoryFilePath(dir, "project", "gotchas");
    appendMemoryEntry(path, "the unique phrase XYZZY appears here");

    const result = removeMemoryEntry(path, "XYZZY");
    assert.equal(result.status, "removed");
  });

  it("reports ambiguous when a substring matches more than one entry", () => {
    const dir = tempProject();
    const path = memoryFilePath(dir, "project", "gotchas");
    appendMemoryEntry(path, "shared phrase one");
    appendMemoryEntry(path, "shared phrase two");

    const result = removeMemoryEntry(path, "shared phrase");
    assert.equal(result.status, "ambiguous");
    if (result.status === "ambiguous") assert.equal(result.matches.length, 2);
  });

  it("reports not_found for a match against no entry", () => {
    const dir = tempProject();
    const path = memoryFilePath(dir, "project", "gotchas");
    assert.equal(removeMemoryEntry(path, "nothing-here").status, "not_found");
  });
});

describe("runMemoryAdd / runMemoryList / runMemoryForget (CLI layer)", () => {
  it("add appends to the right file and list shows it", () => {
    const dir = tempProject();
    const { code } = capture("stdout", () => runMemoryAdd(dir, "a real gotcha"));
    assert.equal(code, 0);

    const { text } = capture("stdout", () => runMemoryList(dir));
    assert.match(text, /a real gotcha/);
    assert.match(text, /project\/gotchas/);
  });

  it("add respects --file failed-approaches", () => {
    const dir = tempProject();
    runMemoryAdd(dir, "tried X, didn't work", { file: "failed-approaches" });
    const raw = readFileSync(memoryFilePath(dir, "project", "failed-approaches"), "utf8");
    assert.match(raw, /tried X, didn't work/);
  });

  // T78: `forget` supersedes by default. The line stays in the file with an
  // `invalid=` date, is no longer injected, and every OTHER line is
  // byte-identical -- the same discipline the delete path always had.
  it("forget invalidates in place, keeps the line, and leaves every other line untouched", () => {
    const dir = tempProject();
    const path = memoryFilePath(dir, "project", "gotchas");
    capture("stdout", () => runMemoryAdd(dir, "keep this one"));
    capture("stdout", () => runMemoryAdd(dir, "supersede this one"));
    const before = readFileSync(path, "utf8");

    const { code, text } = capture("stdout", () => runMemoryForget(dir, "supersede this one", { reason: "moved" }));
    assert.equal(code, 0);
    assert.match(text, /invalidated/);

    const after = readFileSync(path, "utf8");
    assert.notEqual(after, before);
    // Kept, not removed.
    assert.ok(after.includes("supersede this one"));
    assert.match(after, /invalid=\d{4}-\d{2}-\d{2}/);
    assert.match(after, /reason=moved/);
    // Every line but the superseded one is byte-identical.
    const beforeLines = before.split("\n").filter((l) => !l.includes("supersede this one"));
    const afterLines = after.split("\n").filter((l) => !l.includes("supersede this one"));
    assert.deepEqual(afterLines, beforeLines);
  });

  it("--purge really deletes, and says that is what it did", () => {
    const dir = tempProject();
    const path = memoryFilePath(dir, "project", "gotchas");
    capture("stdout", () => runMemoryAdd(dir, "keep this one"));
    capture("stdout", () => runMemoryAdd(dir, "remove this one"));
    const before = readFileSync(path, "utf8");

    const { code, text } = capture("stdout", () => runMemoryForget(dir, "remove this one", { purge: true }));
    assert.equal(code, 0);
    assert.match(text, /purged/);

    const after = readFileSync(path, "utf8");
    assert.ok(!after.includes("remove this one"));
    assert.ok(after.includes("keep this one"));
    const beforeLines = before.split("\n").filter((l) => !l.includes("remove this one"));
    assert.deepEqual(after.split("\n"), beforeLines);
  });

  it("invalidating twice does not rewrite the date it was superseded on", () => {
    const dir = tempProject();
    const path = memoryFilePath(dir, "project", "gotchas");
    capture("stdout", () => runMemoryAdd(dir, "one entry"));
    capture("stdout", () => runMemoryForget(dir, "one entry"));
    const after1 = readFileSync(path, "utf8");
    const { code, text } = capture("stdout", () => runMemoryForget(dir, "one entry"));
    assert.equal(code, 0);
    assert.match(text, /already invalidated/);
    assert.equal(readFileSync(path, "utf8"), after1);
  });

  it("list hides superseded entries unless --all is passed", () => {
    const dir = tempProject();
    capture("stdout", () => runMemoryAdd(dir, "live entry"));
    capture("stdout", () => runMemoryAdd(dir, "dead entry"));
    capture("stdout", () => runMemoryForget(dir, "dead entry"));

    const plain = capture("stdout", () => runMemoryList(dir)).text;
    assert.ok(plain.includes("live entry"));
    assert.ok(!plain.includes("dead entry"));
    assert.match(plain, /1 invalidated, --all to show/);

    const all = capture("stdout", () => runMemoryList(dir, { all: true })).text;
    assert.ok(all.includes("dead entry"));
  });

  it("forget fails clearly for no match", () => {
    const dir = tempProject();
    const { code, text } = capture("stderr", () => runMemoryForget(dir, "nope"));
    assert.equal(code, 1);
    assert.match(text, /no entry matching/);
  });

  it("reports no entries yet rather than an empty success", () => {
    const dir = tempProject();
    const { code, text } = capture("stdout", () => runMemoryList(dir));
    assert.equal(code, 0);
    assert.match(text, /no memory entries yet/);
  });
});
