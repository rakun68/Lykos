import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  acceptProposal,
  DEFAULT_PROMOTE_AFTER,
  normalizeLesson,
  proposeMemory,
  proposedPath,
} from "./memory-propose.js";
import { memoryFilePath, parseMemoryEntries } from "../memory.js";
import { buildMemoryHead } from "../session/memory-head.js";

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-propose-"));
  mkdirSync(join(dir, ".lykos", "memory"), { recursive: true });
  writeFileSync(join(dir, ".lykos", "memory", "gotchas.md"), "# Project gotchas\n\n", "utf8");
  writeFileSync(join(dir, ".lykos", "memory", "failed-approaches.md"), "# Failed approaches\n\n", "utf8");
  return dir;
}

describe("T81 — the proposal queue", () => {
  it("counts a repeat instead of queueing a second row", () => {
    const dir = tempProject();
    const a = proposeMemory(dir, "Prices come from primary docs only.");
    // Same lesson, different case, whitespace and trailing punctuation.
    const b = proposeMemory(dir, "  prices come from primary   docs only  ");
    assert.equal(a.id, b.id);
    assert.equal(a.seen, 1);
    assert.equal(b.seen, 2);
    assert.equal(b.status, "repeated");
    assert.equal(parseMemoryEntries(readFileSync(proposedPath(dir), "utf8")).length, 1);
  });

  it("keeps genuinely different lessons apart", () => {
    // Under-matching costs a duplicate the maintainer can merge; over-matching
    // silently manufactures the repetition the promotion gate depends on.
    const dir = tempProject();
    const a = proposeMemory(dir, "cache_read and cache_write must both be recorded");
    const b = proposeMemory(dir, "DeepSeek has no cache write premium");
    assert.notEqual(a.id, b.id);
    assert.equal(parseMemoryEntries(readFileSync(proposedPath(dir), "utf8")).length, 2);
  });

  it("refuses to accept a lesson observed only once", () => {
    const dir = tempProject();
    const { id } = proposeMemory(dir, "seen just the once");
    const r = acceptProposal(dir, id);
    assert.equal(r.status, "below_threshold");
    if (r.status === "below_threshold") {
      assert.equal(r.seen, 1);
      assert.equal(r.needed, DEFAULT_PROMOTE_AFTER);
    }
    // And nothing leaked into the real store.
    assert.equal(parseMemoryEntries(readFileSync(memoryFilePath(dir, "project", "gotchas"), "utf8")).length, 0);
  });

  it("promotes on the second independent proposal, carrying provenance across", () => {
    const dir = tempProject();
    proposeMemory(dir, "the ledger is write-heavy", { src: "s1", paths: ["lykos/ledger/ledger.ts"] });
    const { id } = proposeMemory(dir, "the ledger is write-heavy");
    const r = acceptProposal(dir, id);
    assert.equal(r.status, "accepted");

    const stored = parseMemoryEntries(readFileSync(memoryFilePath(dir, "project", "gotchas"), "utf8"));
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.text, "the ledger is write-heavy");
    assert.equal(stored[0]?.meta.src, "s1");
    assert.deepEqual(stored[0]?.meta.paths, ["lykos/ledger/ledger.ts"]);
  });

  it("marks the accepted proposal rather than deleting it, and will not accept it twice", () => {
    const dir = tempProject();
    proposeMemory(dir, "a repeated lesson");
    const { id } = proposeMemory(dir, "a repeated lesson");
    acceptProposal(dir, id);

    const queued = parseMemoryEntries(readFileSync(proposedPath(dir), "utf8"));
    assert.equal(queued.length, 1);
    assert.ok(queued[0]?.meta.invalid);
    assert.match(queued[0]?.meta.reason ?? "", /accepted as [0-9a-f]{8}/);
    assert.equal(acceptProposal(dir, id).status, "already_accepted");
  });

  it("honours --file, so a failed approach lands in failed-approaches.md", () => {
    const dir = tempProject();
    proposeMemory(dir, "tried the graph store, too heavy", { file: "failed-approaches" });
    const { id } = proposeMemory(dir, "tried the graph store, too heavy");
    const r = acceptProposal(dir, id);
    assert.equal(r.status, "accepted");
    if (r.status === "accepted") assert.equal(r.target, "failed-approaches");
    const raw = readFileSync(memoryFilePath(dir, "project", "failed-approaches"), "utf8");
    assert.match(raw, /tried the graph store/);
  });

  // The load-bearing property of the whole task: a proposal has no route
  // into a prompt. MEMORY_SOURCE_ORDER names gotchas and failed-approaches;
  // proposed.md is not in it and cannot be without editing that constant.
  it("never injects a proposal, however many times it has been seen", () => {
    const dir = tempProject();
    for (let i = 0; i < 5; i++) proposeMemory(dir, "an unaccepted proposal");
    assert.ok(existsSync(proposedPath(dir)));
    const head = buildMemoryHead(dir, { enabled: true, scope: ["project"], maxInjectTokens: 500 });
    assert.equal(head.injected.length, 0);
    assert.ok(!head.text.includes("an unaccepted proposal"));
  });

  it("normalizes only case, whitespace and trailing punctuation", () => {
    assert.equal(normalizeLesson("  A  Lesson. "), "a lesson");
    assert.notEqual(normalizeLesson("a lesson about x"), normalizeLesson("a lesson about y"));
  });
});
