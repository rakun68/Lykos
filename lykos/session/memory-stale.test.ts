import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildMemoryHead, partitionStale, type InjectedMemory } from "./memory-head.js";

function project(gotchas: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-stale-"));
  mkdirSync(join(dir, ".lykos", "memory"), { recursive: true });
  writeFileSync(join(dir, ".lykos", "memory", "gotchas.md"), gotchas, "utf8");
  return dir;
}

const entry = (id: string, text: string, paths?: string[]): InjectedMemory => ({
  id,
  scope: "project",
  file: "gotchas",
  text,
  ...(paths ? { meta: { paths } } : {}),
});

describe("T79 — staleness as a silent no-op", () => {
  it("holds an entry back when ANY declared path is gone", () => {
    // The check errs toward silence on purpose: problems/09 names
    // "confidently wrong guidance" as the failure mode that actually bites,
    // and a held-back memory costs a rediscovery while an injected stale one
    // costs a wrong path plus the tokens to get out of it.
    const { fresh, stale } = partitionStale("/repo", [entry("a1b2c3d4", "x", ["there.ts", "gone.ts"])], (p) =>
      p.includes("there.ts"),
    );
    assert.equal(fresh.length, 0);
    assert.equal(stale.length, 1);
    assert.deepEqual(stale[0]?.missingPaths, ["gone.ts"]);
  });

  it("treats an entry with no declared paths as fresh — un-checkable is not stale", () => {
    // Most entries will never declare a path. A gotcha about a provider's
    // cache semantics has none, and holding those back would empty the store.
    const { fresh, stale } = partitionStale("/repo", [entry("a1b2c3d4", "DeepSeek peak swings 2x")], () => false);
    assert.equal(fresh.length, 1);
    assert.equal(stale.length, 0);
  });

  it("injects an entry whose declared paths all still exist", () => {
    const { fresh, stale } = partitionStale("/repo", [entry("a1b2c3d4", "x", ["a.ts", "b.ts"])], () => true);
    assert.equal(fresh.length, 1);
    assert.equal(stale.length, 0);
  });

  it("keeps a stale entry out of the head but inside the eligibility record", () => {
    const dir = project(
      "# h\n\n- [aaaaaaaa] live one\n- [bbbbbbbb] dead one {paths=nope/missing.ts}\n",
    );
    const head = buildMemoryHead(dir, { enabled: true, scope: ["project"], maxInjectTokens: 500 });
    assert.equal(head.injected.length, 1);
    assert.equal(head.injected[0]?.id, "aaaaaaaa");
    assert.ok(!head.text.includes("dead one"));
    assert.equal(head.stale.length, 1);
    assert.equal(head.stale[0]?.id, "bbbbbbbb");
    // T76 has to be able to tell "held back for staleness" from "never
    // stored" and from "lost to the cap". Three states, three answers.
    const states = new Map(head.eligibility.map((e) => [e.entryId, e.state]));
    assert.equal(states.get("aaaaaaaa"), "injected");
    assert.equal(states.get("bbbbbbbb"), "stale");
  });

  it("never rewrites, invalidates or deletes the stale entry — it stays in the file", () => {
    const raw = "# h\n\n- [bbbbbbbb] dead one {paths=nope/missing.ts}\n";
    const dir = project(raw);
    buildMemoryHead(dir, { enabled: true, scope: ["project"], maxInjectTokens: 500 });
    assert.equal(readFileSync(join(dir, ".lykos", "memory", "gotchas.md"), "utf8"), raw);
  });
});
