import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  assembleMemoryHead,
  buildMemoryHead,
  collectMemoryEntries,
  emptyMemoryHead,
  MEMORY_HEADING,
  memoryInjectEnabledFromEnv,
  resolveMemoryPolicy,
  serializeInjectedIds,
  type InjectedMemory,
} from "./memory-head.js";
import { estimateTokensChars4 } from "../ledger/tool-schema.js";

function tempProject(files: Partial<Record<"gotchas" | "failed-approaches", string>> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-memory-head-"));
  mkdirSync(join(dir, ".lykos", "memory"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, ".lykos", "memory", `${name}.md`), body, "utf8");
  }
  return dir;
}

const entry = (id: string, text: string, file: "gotchas" | "failed-approaches" = "gotchas"): InjectedMemory => ({
  id,
  scope: "project",
  file,
  text,
});

describe("resolveMemoryPolicy (T65)", () => {
  it("honours config.enabled and the env kill switch independently", () => {
    assert.equal(resolveMemoryPolicy({ enabled: true }, {}).enabled, true);
    assert.equal(resolveMemoryPolicy({ enabled: false }, {}).enabled, false);
    assert.equal(resolveMemoryPolicy({ enabled: true }, { LYKOS_MEMORY_INJECT: "0" }).enabled, false);
    assert.equal(memoryInjectEnabledFromEnv({ LYKOS_MEMORY_INJECT: "0" }), false);
    assert.equal(memoryInjectEnabledFromEnv({}), true);
  });

  it("falls back to the shipped 500-token cap rather than to unlimited", () => {
    assert.equal(resolveMemoryPolicy(undefined, {}).maxInjectTokens, 500);
    assert.equal(resolveMemoryPolicy({ max_inject_tokens: 0 }, {}).maxInjectTokens, 500);
    assert.equal(resolveMemoryPolicy({ max_inject_tokens: -5 }, {}).maxInjectTokens, 500);
    assert.equal(resolveMemoryPolicy({ max_inject_tokens: 120 }, {}).maxInjectTokens, 120);
  });
});

describe("collectMemoryEntries (T65)", () => {
  it("reads the entries `lykos memory` writes, in file order", () => {
    const dir = tempProject({
      gotchas: "# Project gotchas\n\n- [aaaaaaaa] first thing\n- [bbbbbbbb] second thing\n",
      "failed-approaches": "# Failed approaches\n\n- [cccccccc] tried X, it broke Y\n",
    });
    try {
      const entries = collectMemoryEntries(dir, ["project"]);
      assert.deepEqual(
        entries.map((e) => e.id),
        ["aaaaaaaa", "bbbbbbbb", "cccccccc"],
      );
      // gotchas before failed-approaches: MEMORY_SOURCE_ORDER, not disk order.
      assert.equal(entries[2]?.file, "failed-approaches");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns nothing when the scope excludes the only populated file", () => {
    const dir = tempProject({ gotchas: "- [aaaaaaaa] x\n" });
    try {
      assert.deepEqual(collectMemoryEntries(dir, ["global"]).map((e) => e.id).includes("aaaaaaaa"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores prose and headings — only `- [id] text` lines are entries", () => {
    const dir = tempProject({
      gotchas: "# Project gotchas\n\nSome explanation.\n\n- not an entry\n- [12345678] a real one\n",
    });
    try {
      assert.deepEqual(collectMemoryEntries(dir, ["project"]).map((e) => e.id), ["12345678"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("assembleMemoryHead (T65)", () => {
  it("emits nothing at all when there are no entries — not an empty heading", () => {
    const head = assembleMemoryHead([], 500);
    assert.equal(head.text, "");
    assert.equal(head.tokens, 0);
    assert.deepEqual(head.ids, []);
  });

  it("puts the heading, the preamble and every entry in one frozen block", () => {
    const head = assembleMemoryHead([entry("aaaaaaaa", "the ledger is append-only")], 500);
    assert.ok(head.text.startsWith(MEMORY_HEADING));
    assert.match(head.text, /- \[aaaaaaaa\] \(gotcha\) the ledger is append-only/);
    assert.deepEqual(head.ids, ["aaaaaaaa"]);
    assert.equal(head.tokens, estimateTokensChars4(head.text));
    assert.equal(head.skipped, 0);
    assert.equal(head.available, 1);
  });

  it("labels a global entry so an injected line is traceable to the file it came from", () => {
    const head = assembleMemoryHead([{ id: "aaaaaaaa", scope: "global", file: "failed-approaches", text: "x" }], 500);
    assert.match(head.text, /\(global failed\)/);
  });

  it("stops at the first entry that does not fit, and counts what it dropped", () => {
    const long = "y".repeat(400); // ~100 tokens each
    const entries = [entry("a1", long), entry("a2", long), entry("a3", long), entry("a4", long)];
    const head = assembleMemoryHead(entries, 200);
    assert.ok(head.injected.length >= 1 && head.injected.length < 4, `injected ${head.injected.length}`);
    assert.equal(head.skipped, 4 - head.injected.length);
    assert.equal(head.available, 4);
    // The cap is a real ceiling, not a target.
    assert.ok(head.tokens <= 200, `tokens ${head.tokens} exceeded the cap`);
  });

  it("never truncates mid-entry — half a gotcha is worse than no gotcha", () => {
    const head = assembleMemoryHead([entry("a1", "z".repeat(4000))], 200);
    assert.equal(head.text, "");
    assert.equal(head.injected.length, 0);
    assert.equal(head.skipped, 1);
  });

  it("keeps the maintainer's file order as the priority order", () => {
    // A long entry followed by a short one: the short one is NOT promoted
    // past the long one to use up the remaining budget.
    const head = assembleMemoryHead([entry("big", "z".repeat(2000)), entry("small", "tiny")], 120);
    assert.deepEqual(head.ids, []);
    assert.equal(head.skipped, 2);
  });

  it("counts the heading and preamble against the budget, not only the entries", () => {
    const frameOnly = assembleMemoryHead([entry("a1", "x")], 1000);
    const framelessTokens = estimateTokensChars4("- [a1] (gotcha) x");
    assert.ok(frameOnly.tokens > framelessTokens, "the frame's own tokens must be counted");
  });

  it("injects nothing when the cap is smaller than the frame itself", () => {
    const head = assembleMemoryHead([entry("a1", "x")], 3);
    assert.equal(head.text, "");
    assert.equal(head.skipped, 1);
  });

  it("serialises the injected ids for the ledger", () => {
    const head = assembleMemoryHead([entry("aaaaaaaa", "x"), entry("bbbbbbbb", "y")], 500);
    assert.deepEqual(JSON.parse(serializeInjectedIds(head)), ["aaaaaaaa", "bbbbbbbb"]);
  });
});

describe("buildMemoryHead (T65)", () => {
  it("is off, and reads nothing, when the policy is disabled", () => {
    const dir = tempProject({ gotchas: "- [aaaaaaaa] x\n" });
    try {
      const head = buildMemoryHead(dir, { enabled: false, scope: ["project"], maxInjectTokens: 500 });
      assert.equal(head.enabled, false);
      assert.equal(head.text, "");
      // available stays 0: a disabled policy does not read the files at all,
      // so reporting a count would imply a read that did not happen.
      assert.equal(head.available, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads, budgets and freezes in one call", () => {
    const dir = tempProject({ gotchas: "- [aaaaaaaa] deepseek peak pricing swings 2x\n" });
    try {
      const head = buildMemoryHead(dir, { enabled: true, scope: ["project"], maxInjectTokens: 500 });
      assert.equal(head.enabled, true);
      assert.deepEqual(head.ids, ["aaaaaaaa"]);
      assert.match(head.text, /deepseek peak pricing swings 2x/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("produces byte-identical output on repeated calls — the block is stable for a session", () => {
    const dir = tempProject({ gotchas: "- [aaaaaaaa] one\n- [bbbbbbbb] two\n" });
    try {
      const policy = { enabled: true, scope: ["project" as const], maxInjectTokens: 500 };
      assert.equal(buildMemoryHead(dir, policy).text, buildMemoryHead(dir, policy).text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("emits no block for a project with no memory files at all", () => {
    const dir = tempProject();
    try {
      const head = buildMemoryHead(dir, { enabled: true, scope: ["project"], maxInjectTokens: 500 });
      assert.equal(head.text, "");
      assert.equal(head.available, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("emptyMemoryHead (T65)", () => {
  it("carries the enabled flag so 'off' and 'on but empty' stay distinguishable", () => {
    assert.equal(emptyMemoryHead(false).enabled, false);
    assert.equal(emptyMemoryHead(true).enabled, true);
  });
});
