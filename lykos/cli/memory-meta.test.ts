import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseMemoryEntries,
  renderEntryMeta,
  renderMemoryEntry,
  splitEntryMeta,
  type MemoryMeta,
} from "../memory.js";

describe("T77 — entry metadata", () => {
  it("keeps a pre-T77 hand-written line parsing exactly as before", () => {
    // The store IS the maintainer's markdown files. A format that changes
    // what an existing line means is not admissible.
    const entries = parseMemoryEntries("# h\n\n- [a1b2c3d4] DeepSeek peak pricing swings 2x.\n");
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.text, "DeepSeek peak pricing swings 2x.");
    assert.deepEqual(entries[0]?.meta, {});
  });

  it("parses provenance, dependencies and validity off the end of the line", () => {
    const entries = parseMemoryEntries(
      "- [a1b2c3d4] prices come from primary docs only " +
        '{added=2026-09-04 src=s7f3a2b paths=lykos/ledger/prices.yaml,docs/03-telemetry.md ' +
        'invalid=2026-10-01 by=s991 reason="superseded by the v2 table"}\n',
    );
    const e = entries[0]!;
    assert.equal(e.text, "prices come from primary docs only");
    assert.equal(e.meta.added, "2026-09-04");
    assert.equal(e.meta.src, "s7f3a2b");
    assert.deepEqual(e.meta.paths, ["lykos/ledger/prices.yaml", "docs/03-telemetry.md"]);
    assert.equal(e.meta.invalid, "2026-10-01");
    assert.equal(e.meta.by, "s991");
    assert.equal(e.meta.reason, "superseded by the v2 table");
  });

  // Rule 2 of the format, and the one that protects the maintainer's files:
  // an unparseable trailing group is TEXT, never silently truncated.
  it("treats a trailing brace group it cannot parse as part of the lesson", () => {
    for (const body of [
      "always pass {} to the constructor",
      'the config shape is {"retries": 3}',
      "beware {foo=bar}", // a real key=value, but `foo` is not a known key
      "beware {added}", // a known key with no value
      "beware {added=2026-09-04 stray}", // trailing junk after a valid pair
    ]) {
      const { text, meta } = splitEntryMeta(body);
      assert.equal(text, body, `should have stayed text: ${body}`);
      assert.deepEqual(meta, {});
    }
  });

  it("round-trips through render and parse", () => {
    const meta: MemoryMeta = {
      added: "2026-09-04",
      src: "s1",
      paths: ["a.ts", "b/c.ts"],
      reason: "has spaces and a \" quote",
    };
    const line = renderMemoryEntry("a1b2c3d4", "the lesson", meta);
    const parsed = parseMemoryEntries(`${line}\n`)[0]!;
    assert.equal(parsed.text, "the lesson");
    assert.deepEqual(parsed.meta, meta);
  });

  it("renders nothing at all for empty metadata, so an untouched line stays untouched", () => {
    assert.equal(renderEntryMeta({}), "");
    assert.equal(renderMemoryEntry("a1b2c3d4", "x", {}), "- [a1b2c3d4] x");
  });

  it("drops empty path segments rather than storing a path that is the empty string", () => {
    const { meta } = splitEntryMeta("x {paths=a.ts,,b.ts,}");
    assert.deepEqual(meta.paths, ["a.ts", "b.ts"]);
  });
});
