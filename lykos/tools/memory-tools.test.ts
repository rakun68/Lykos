// The five memory tools.
//
// **D9 governs this whole file.** Every test builds its tools over a store
// pointed at a fresh temporary directory and removes it afterwards, GLOBAL
// scope included — `memoryFilePath` resolves global under `homedir()`, so a
// harness that redirected only `cwd` would still write into the developer's
// own `~/.lykos/memory/`. A test that changes the machine it runs on is not a
// test.
//
// The test this ticket exists for is at the bottom: `no tool activates a
// memory`. It tries, through every tool, and then shows that the human path
// is the only one that works.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { measureToolset } from "../ledger/tool-schema.js";
import {
  acceptProposal,
  isEntryValid,
  parseMemoryEntries,
  proposedPath,
  type MemoryFile,
  type MemoryScope,
} from "../memory.js";
import * as memoryToolsModule from "./memory-tools.js";
import {
  buildLearnTool,
  buildMemoryEditTool,
  buildMemoryTools,
  buildRecallTool,
  buildReflectTool,
  buildRetainTool,
  LEARN_DESCRIPTION,
  LEARN_PARAMETERS,
  LEARN_TOOL_NAME,
  LOCAL_MEMORY_STORE,
  MEMORY_EDIT_DESCRIPTION,
  MEMORY_EDIT_PARAMETERS,
  MEMORY_EDIT_TOOL_NAME,
  MEMORY_TOOL_NAMES,
  PROPOSAL_NOTICE,
  RECALL_DESCRIPTION,
  RECALL_PARAMETERS,
  RECALL_TOOL_NAME,
  REFLECT_DESCRIPTION,
  REFLECT_PARAMETERS,
  REFLECT_TITLE_COUNT,
  REFLECT_TOOL_NAME,
  RETAIN_DESCRIPTION,
  RETAIN_PARAMETERS,
  RETAIN_TOOL_NAME,
  type MemoryStoreAccess,
} from "./memory-tools.js";
import { riskForTool, tierForTool } from "./tool-risk.js";
import { DEFAULT_RESIDENT_TOOLS, MOUNTED_TOOLS, RUNTIME_AVAILABLE_TOOLS, TOOL_REGISTRY } from "./tool-surface.js";

function asJson(schema: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// D9: a store that cannot reach the developer's own .lykos/
// ---------------------------------------------------------------------------

interface Harness {
  cwd: string;
  store: MemoryStoreAccess;
  tools: ToolDefinition[];
  retain: ToolDefinition;
  recall: ToolDefinition;
  reflect: ToolDefinition;
  memoryEdit: ToolDefinition;
  learn: ToolDefinition;
  /** Where this harness keeps the file for a given scope and file. */
  path: (scope: MemoryScope, file: MemoryFile) => string;
  cleanup: () => void;
}

function harness(opts: { sessionId?: string } = {}): Harness {
  const cwd = mkdtempSync(join(tmpdir(), "lykos-memtools-"));
  // The project half lands under `<cwd>/.lykos`, which is where
  // `proposedPath` and `acceptProposal` also put things, so the real proposal
  // queue is exercised rather than a stand-in. The GLOBAL half is redirected
  // into the same temporary directory — this is the line that keeps the test
  // off `homedir()`.
  const path = (scope: MemoryScope, file: MemoryFile): string =>
    join(cwd, scope === "project" ? ".lykos" : "fake-home/.lykos", "memory", `${file}.md`);
  const store: MemoryStoreAccess = { ...LOCAL_MEMORY_STORE, filePath: (_cwd, scope, file) => path(scope, file) };
  const built = buildMemoryTools({
    cwd,
    store,
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
  });
  const byName = (n: string): ToolDefinition => {
    const t = built.find((x) => x.name === n);
    assert.ok(t, `${n} was not built`);
    return t;
  };
  return {
    cwd,
    store,
    tools: built,
    retain: byName(RETAIN_TOOL_NAME),
    recall: byName(RECALL_TOOL_NAME),
    reflect: byName(REFLECT_TOOL_NAME),
    memoryEdit: byName(MEMORY_EDIT_TOOL_NAME),
    learn: byName(LEARN_TOOL_NAME),
    path,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

function seed(h: Harness, scope: MemoryScope, file: MemoryFile, lines: string[]): void {
  const p = h.path(scope, file);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, `# seeded\n\n${lines.join("\n")}\n`, "utf8");
}

async function call(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean; details: any }> {
  const result = (await tool.execute(
    "call-1",
    args as never,
    undefined as never,
    undefined as never,
    undefined as never,
  )) as { content?: Array<{ text?: string }>; isError?: boolean; details?: unknown };
  return {
    text: result.content?.map((c) => c.text ?? "").join("\n") ?? "",
    isError: result.isError === true,
    details: result.details as any,
  };
}

/** Every entry the two PROJECT files hold, invalidated ones included. */
function projectEntries(h: Harness, file: MemoryFile = "gotchas") {
  const p = h.path("project", file);
  return existsSync(p) ? parseMemoryEntries(readFileSync(p, "utf8")) : [];
}

// ---------------------------------------------------------------------------
// D2: retain proposes and never activates
// ---------------------------------------------------------------------------

describe("P10.6 D2: retain proposes, and says so", () => {
  it("queues a proposal and writes nothing into either memory file", async () => {
    const h = harness();
    try {
      const res = await call(h.retain, { memory: "The ledger's history before 2026-09-06 was lost." });
      assert.equal(res.isError, false);
      assert.equal(res.details.active, false);
      assert.equal(res.details.awaitingHuman, true);
      assert.equal(res.details.seen, 1);
      assert.equal(res.details.target, "gotchas");

      // The proposal is in the queue...
      const queued = parseMemoryEntries(readFileSync(proposedPath(h.cwd), "utf8"));
      assert.equal(queued.length, 1);
      assert.equal(queued[0]!.text, "The ledger's history before 2026-09-06 was lost.");
      // ...and NOWHERE else. This is the assertion the whole ticket rests on.
      assert.equal(existsSync(h.path("project", "gotchas")), false);
      assert.equal(existsSync(h.path("project", "failed-approaches")), false);
      assert.equal(existsSync(h.path("global", "gotchas")), false);
    } finally {
      h.cleanup();
    }
  });

  it("says, in the text the model reads, that the memory is not active yet", async () => {
    const h = harness();
    try {
      const res = await call(h.retain, { memory: "Pi renders tools, then system, then messages." });
      assert.ok(res.text.includes(PROPOSAL_NOTICE), "the notice is verbatim in the result");
      assert.match(res.text, /PROPOSAL, not an active memory/);
      assert.match(res.text, /only a human running `lykos memory accept <id>` can activate it/);
      assert.match(res.text, /No tool can/);
      // The failure mode ADR-0017 kept the acceptance rule against: a model
      // that stops re-deriving a fact it never actually stored.
      assert.match(res.text, /act on it yourself/);
    } finally {
      h.cleanup();
    }
  });

  it("is not returned by recall until a human accepts it", async () => {
    const h = harness();
    try {
      await call(h.retain, { memory: "The gate is a default, not an opt-in." });
      const before = await call(h.recall, { query: "gate" });
      assert.equal(before.details.matched, 0);
      assert.match(before.text, /No accepted memory matches/);
      assert.match(before.text, /1 proposal is queued and NOT searched here/);

      // The repetition gate wants a second independent sighting, and then the
      // HUMAN verb — `acceptProposal`, which no tool is handed — promotes it.
      await call(h.retain, { memory: "The gate is a default, not an opt-in." });
      const accepted = acceptProposal(h.cwd, "The gate is a default");
      assert.equal(accepted.status, "accepted");

      const after = await call(h.recall, { query: "gate" });
      assert.equal(after.details.matched, 1);
      assert.match(after.text, /The gate is a default, not an opt-in\./);
    } finally {
      h.cleanup();
    }
  });

  it("flattens a multi-line memory, because one entry is one line of markdown", async () => {
    const h = harness();
    try {
      await call(h.retain, { memory: "  first line\n\n  second line  " });
      const queued = parseMemoryEntries(readFileSync(proposedPath(h.cwd), "utf8"));
      assert.equal(queued.length, 1);
      assert.equal(queued[0]!.text, "first line second line");
    } finally {
      h.cleanup();
    }
  });

  it("refuses an empty memory and an unknown file rather than queueing noise", async () => {
    const h = harness();
    try {
      await assert.rejects(() => call(h.retain, { memory: "   " }), /memory is empty/);
      await assert.rejects(() => call(h.retain, { memory: "x", file: "notes" }), /unknown file "notes"/);
      assert.equal(existsSync(proposedPath(h.cwd)), false);
    } finally {
      h.cleanup();
    }
  });

  it("records paths and the session that proposed it, so a bad memory is traceable", async () => {
    const h = harness({ sessionId: "sess-7" });
    try {
      await call(h.retain, { memory: "ast_grep needs a language for the extension.", paths: ["lykos/tools/ast.ts", " "] });
      const queued = parseMemoryEntries(readFileSync(proposedPath(h.cwd), "utf8"));
      assert.deepEqual(queued[0]!.meta.paths, ["lykos/tools/ast.ts"]);
      assert.equal(queued[0]!.meta.src, "sess-7");
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// D4: recall searches what the store supports and nothing more
// ---------------------------------------------------------------------------

describe("P10.6 D4: recall over the parsed entries", () => {
  it("returns identifiers and provenance with every hit", async () => {
    const h = harness();
    try {
      seed(h, "project", "gotchas", ["- [aaaaaaaa] stdout belongs to the transport in MCP mode {added=2026-09-01 src=s1 paths=lykos/tui/io-mode.ts}"]);
      const res = await call(h.recall, { query: "stdout" });
      assert.equal(res.details.matched, 1);
      assert.match(res.text, /\[aaaaaaaa\] \(project\/gotchas\)/);
      // memory_edit takes an identifier, so a hit that hides one is useless.
      assert.match(res.text, /added=2026-09-01/);
      assert.match(res.text, /src=s1/);
      assert.match(res.text, /paths=lykos\/tui\/io-mode\.ts/);
    } finally {
      h.cleanup();
    }
  });

  it("never returns an invalidated entry, and says how many it skipped", async () => {
    const h = harness();
    try {
      seed(h, "project", "gotchas", [
        "- [aaaaaaaa] live claim {added=2026-09-01}",
        "- [bbbbbbbb] retired claim {added=2026-09-01 invalid=2026-09-10 reason=\"no longer true\"}",
      ]);
      const res = await call(h.recall, {});
      assert.equal(res.details.matched, 1);
      assert.equal(res.details.invalidatedSkipped, 1);
      assert.match(res.text, /live claim/);
      assert.doesNotMatch(res.text, /retired claim/);
      assert.match(res.text, /1 invalidated entry was skipped/);
    } finally {
      h.cleanup();
    }
  });

  it("filters by scope and by file, and matches an exact id", async () => {
    const h = harness();
    try {
      seed(h, "project", "gotchas", ["- [aaaaaaaa] project gotcha {added=2026-09-01}"]);
      seed(h, "project", "failed-approaches", ["- [cccccccc] project failure {added=2026-09-01}"]);
      seed(h, "global", "gotchas", ["- [bbbbbbbb] global gotcha {added=2026-09-01}"]);

      assert.equal((await call(h.recall, {})).details.matched, 3);
      assert.equal((await call(h.recall, { scope: "global" })).details.matched, 1);
      assert.equal((await call(h.recall, { scope: "project" })).details.matched, 2);
      assert.equal((await call(h.recall, { file: "failed-approaches" })).details.matched, 1);
      const byId = await call(h.recall, { query: "bbbbbbbb" });
      assert.equal(byId.details.matched, 1);
      assert.match(byId.text, /global gotcha/);
    } finally {
      h.cleanup();
    }
  });

  it("caps at the limit and says it stopped, rather than returning everything", async () => {
    const h = harness();
    try {
      seed(
        h,
        "project",
        "gotchas",
        Array.from({ length: 6 }, (_, i) => `- [aaaaaaa${i}] claim number ${i} {added=2026-09-0${i + 1}}`),
      );
      const res = await call(h.recall, { limit: 2 });
      assert.equal(res.details.matched, 6);
      assert.equal(res.details.returned, 2);
      assert.match(res.text, /Stopped at the 2-hit limit/);
    } finally {
      h.cleanup();
    }
  });

  it("says nothing matched without implying the claim is false", async () => {
    const h = harness();
    try {
      const res = await call(h.recall, { query: "nothing here" });
      assert.match(res.text, /not evidence the claim is false/);
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// D6: memory_edit invalidates; it does not delete
// ---------------------------------------------------------------------------

describe("P10.6 D6: memory_edit invalidates rather than deletes", () => {
  it("keeps the line, marks it, and stops recalling it", async () => {
    const h = harness({ sessionId: "sess-9" });
    try {
      seed(h, "project", "gotchas", ["- [aaaaaaaa] embeddings are prohibited {added=2026-09-01}"]);
      const res = await call(h.memoryEdit, { op: "invalidate", id: "aaaaaaaa", reason: "ADR-0016 replaced it" });
      assert.equal(res.isError, false);
      assert.equal(res.details.status, "invalidated");
      assert.match(res.text, /Nothing was deleted/);

      const entries = projectEntries(h);
      assert.equal(entries.length, 1, "the line is still there");
      assert.equal(entries[0]!.text, "embeddings are prohibited");
      assert.equal(isEntryValid(entries[0]!), false);
      assert.equal(entries[0]!.meta.reason, "ADR-0016 replaced it");
      assert.equal(entries[0]!.meta.by, "sess-9");

      assert.equal((await call(h.recall, { query: "embeddings" })).details.matched, 0);
    } finally {
      h.cleanup();
    }
  });

  it("amends by invalidating and proposing, so the correction also waits for a human", async () => {
    const h = harness();
    try {
      seed(h, "project", "gotchas", ["- [aaaaaaaa] the cap is 200 lines {added=2026-09-01 paths=CLAUDE.md}"]);
      const res = await call(h.memoryEdit, {
        op: "amend",
        id: "aaaaaaaa",
        text: "the cap is 150 lines",
        reason: "counted it",
      });
      assert.equal(res.details.status, "amended");
      assert.equal(res.details.active, false);
      assert.equal(res.details.awaitingHuman, true);
      assert.ok(res.text.includes(PROPOSAL_NOTICE));

      // The old claim is superseded in place; the new one is only queued.
      const entries = projectEntries(h);
      assert.equal(entries.length, 1);
      assert.equal(isEntryValid(entries[0]!), false);
      const queued = parseMemoryEntries(readFileSync(proposedPath(h.cwd), "utf8"));
      assert.equal(queued.length, 1);
      assert.equal(queued[0]!.text, "the cap is 150 lines");
      // The amendment inherits the superseded entry's paths — the claim is
      // about the same file, and dropping that would silently disarm T79's
      // staleness check on the replacement.
      assert.deepEqual(queued[0]!.meta.paths, ["CLAUDE.md"]);
      assert.equal((await call(h.recall, { query: "150" })).details.matched, 0);
    } finally {
      h.cleanup();
    }
  });

  it("refuses an ambiguous match by naming the candidates instead of picking one", async () => {
    const h = harness();
    try {
      seed(h, "project", "gotchas", ["- [aaaaaaaa] the cap is 200 lines {added=2026-09-01}"]);
      seed(h, "global", "gotchas", ["- [bbbbbbbb] the cap is 200 bytes {added=2026-09-01}"]);
      const res = await call(h.memoryEdit, { op: "invalidate", id: "the cap is 200" });
      assert.equal(res.isError, true);
      assert.equal(res.details.status, "ambiguous");
      assert.match(res.text, /matches 2 memories/);
      assert.match(res.text, /\[aaaaaaaa\]/);
      assert.match(res.text, /\[bbbbbbbb\]/);
      // Nothing was touched.
      assert.equal(isEntryValid(projectEntries(h)[0]!), true);
    } finally {
      h.cleanup();
    }
  });

  it("reports a miss, an unknown op and a missing amendment without changing anything", async () => {
    const h = harness();
    try {
      seed(h, "project", "gotchas", ["- [aaaaaaaa] a claim {added=2026-09-01}"]);
      const miss = await call(h.memoryEdit, { op: "invalidate", id: "zzzzzzzz" });
      assert.equal(miss.isError, true);
      assert.equal(miss.details.status, "not_found");
      await assert.rejects(() => call(h.memoryEdit, { op: "delete", id: "aaaaaaaa" }), /unknown op "delete"/);
      await assert.rejects(() => call(h.memoryEdit, { op: "amend", id: "aaaaaaaa" }), /amend needs `text`/);
      assert.equal(isEntryValid(projectEntries(h)[0]!), true);
    } finally {
      h.cleanup();
    }
  });

  it("says so and changes nothing when the entry is already invalid", async () => {
    const h = harness();
    try {
      seed(h, "project", "gotchas", ["- [aaaaaaaa] a claim {added=2026-09-01 invalid=2026-09-05}"]);
      const res = await call(h.memoryEdit, { op: "invalidate", id: "aaaaaaaa" });
      assert.equal(res.details.status, "already_invalid");
      assert.match(res.text, /already invalidated on 2026-09-05/);
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// D5: reflect summarises without reading the store into context
// ---------------------------------------------------------------------------

describe("P10.6 D5: reflect answers 'what do you know' cheaply", () => {
  it("reports counts by scope and file, and the pending proposals", async () => {
    const h = harness();
    try {
      seed(h, "project", "gotchas", [
        "- [aaaaaaaa] one {added=2026-09-01}",
        "- [bbbbbbbb] two {added=2026-09-02}",
        "- [cccccccc] retired {added=2026-09-02 invalid=2026-09-03}",
      ]);
      seed(h, "global", "failed-approaches", ["- [dddddddd] three {added=2026-09-04}"]);
      await call(h.retain, { memory: "a pending proposal" });

      const res = await call(h.reflect, {});
      assert.equal(res.details.active, 3);
      assert.equal(res.details.invalidated, 1);
      assert.equal(res.details.pending, 1);
      assert.equal(res.details.readyToAccept, 0);
      assert.match(res.text, /project\/gotchas 2/);
      assert.match(res.text, /project\/failed-approaches 0/);
      assert.match(res.text, /global\/failed-approaches 1/);
      assert.match(res.text, /1 invalidated and no longer recalled/);
      assert.match(res.text, /1 proposal waiting for a human \(0 ready to accept\)/);
      assert.match(res.text, /no tool can accept one/);
    } finally {
      h.cleanup();
    }
  });

  it("prints titles only, capped, rather than the whole store", async () => {
    const h = harness();
    try {
      const long = "x".repeat(300);
      seed(
        h,
        "project",
        "gotchas",
        Array.from({ length: 9 }, (_, i) => `- [aaaaaaa${i}] ${long}${i} {added=2026-09-0${i + 1}}`),
      );
      const res = await call(h.reflect, {});
      assert.equal(res.details.active, 9);
      const titleLines = res.text.split("\n").filter((l) => l.trim().startsWith("[aaaaaaa"));
      assert.equal(titleLines.length, REFLECT_TITLE_COUNT);
      // Nine entries of 300 characters is 2700 characters; the whole result
      // must be a small fraction of that or `reflect` is just `recall`.
      assert.ok(res.text.length < 900, `reflect returned ${res.text.length} chars`);
      assert.match(res.text, /…/);
      // Newest first: 2026-09-09 leads.
      assert.match(titleLines[0]!, /aaaaaaa8/);
    } finally {
      h.cleanup();
    }
  });

  it("says plainly when nothing is stored and nothing is pending", async () => {
    const h = harness();
    try {
      const res = await call(h.reflect, {});
      assert.equal(res.details.active, 0);
      assert.match(res.text, /0 accepted memories/);
      assert.match(res.text, /No proposals are waiting/);
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// D7: learn attaches the exchange as provenance
// ---------------------------------------------------------------------------

describe("P10.6 D7: learn attaches the exchange", () => {
  it("puts the exchange on the entry and keeps it through acceptance", async () => {
    const h = harness();
    try {
      const exchange = 'Human: no, prices come from provider docs.\nAgent: I used a remembered price.';
      const res = await call(h.learn, {
        memory: "Prices come from primary provider documentation only.",
        exchange,
        file: "gotchas",
      });
      assert.equal(res.details.active, false);
      assert.equal(res.details.awaitingHuman, true);
      assert.match(res.text, /attached to the entry as provenance/);

      const queued = parseMemoryEntries(readFileSync(proposedPath(h.cwd), "utf8"));
      assert.equal(queued.length, 1);
      assert.equal(
        queued[0]!.meta.from,
        "Human: no, prices come from provider docs. Agent: I used a remembered price.",
      );

      // A second sighting, then the human's verb. The provenance has to
      // survive: a memory whose origin is gone is one nobody can audit.
      await call(h.learn, { memory: "Prices come from primary provider documentation only.", exchange });
      const accepted = acceptProposal(h.cwd, "Prices come from primary");
      assert.equal(accepted.status, "accepted");
      const live = projectEntries(h);
      assert.equal(live.length, 1);
      assert.match(live[0]!.meta.from ?? "", /I used a remembered price/);
    } finally {
      h.cleanup();
    }
  });

  it("strips braces and caps the exchange, so one entry stays one parseable line", async () => {
    const h = harness();
    try {
      await call(h.learn, {
        memory: "A meta value may not contain a brace.",
        // `{` and `}` in a meta value would send the whole line back to being
        // plain text and lose every other key on it, because the meta group is
        // matched with `[^{}]*`.
        exchange: `Human: use {braces} here. ${"y".repeat(600)}`,
      });
      const raw = readFileSync(proposedPath(h.cwd), "utf8");
      const queued = parseMemoryEntries(raw);
      assert.equal(queued.length, 1, "the line still parses as an entry");
      const from = queued[0]!.meta.from ?? "";
      assert.doesNotMatch(from, /[{}]/);
      assert.ok(from.length <= 400, `from was ${from.length} chars`);
      assert.match(from, /…$/);
      // Every other key survived, which is what the brace strip protects.
      assert.equal(queued[0]!.meta.target, "gotchas");
      assert.equal(queued[0]!.meta.seen, "1");
    } finally {
      h.cleanup();
    }
  });

  it("refuses an empty exchange, because that is what it adds over retain", async () => {
    const h = harness();
    try {
      await assert.rejects(() => call(h.learn, { memory: "x", exchange: "   " }), /exchange is empty/);
      await assert.rejects(() => call(h.learn, { memory: " ", exchange: "y" }), /memory is empty/);
      assert.equal(existsSync(proposedPath(h.cwd)), false);
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// The property this ticket exists for
// ---------------------------------------------------------------------------

describe("P10.6: no tool activates a memory by itself", () => {
  it("the dependency object holds no accept and no delete", () => {
    // D2 and D6 made structural. A later edit that wanted auto-acceptance
    // would have to add a member here first, and this assertion is what it
    // would have to walk past.
    assert.deepEqual(Object.keys(LOCAL_MEMORY_STORE).sort(), [
      "filePath",
      "invalidate",
      "proposals",
      "propose",
      "readEntries",
    ]);
  });

  it("the module exports nothing that accepts or removes", () => {
    const exported = Object.keys(memoryToolsModule);
    for (const name of exported) {
      assert.doesNotMatch(name, /accept/i, `${name} is exported from the tool module`);
      assert.doesNotMatch(name, /^removeMemory/, `${name} is exported from the tool module`);
    }
  });

  it("tries through every tool, and every one of them fails to activate anything", async () => {
    const h = harness();
    try {
      const lesson = "A model must never accept its own memory.";
      // Every write a tool can reach, including the repetition the queue's
      // promotion gate wants — the gate is about noise, not about authority,
      // and reaching its threshold still activates nothing.
      await call(h.retain, { memory: lesson });
      await call(h.retain, { memory: lesson });
      await call(h.retain, { memory: lesson });
      await call(h.learn, { memory: lesson, exchange: "Human: it has to be you who accepts." });
      seed(h, "project", "failed-approaches", ["- [aaaaaaaa] an old claim {added=2026-09-01}"]);
      await call(h.memoryEdit, { op: "amend", id: "aaaaaaaa", text: lesson });

      // Nothing the tools did put the lesson into a file anything injects.
      for (const scope of ["project", "global"] as const) {
        for (const file of ["gotchas", "failed-approaches"] as const) {
          const p = h.path(scope, file);
          const raw = existsSync(p) ? readFileSync(p, "utf8") : "";
          assert.equal(raw.includes(lesson), false, `${scope}/${file} contains the proposed lesson`);
        }
      }
      assert.equal((await call(h.recall, { query: "never accept" })).details.matched, 0);
      const queue = h.store.proposals(h.cwd).filter((e) => !e.meta.invalid);
      assert.ok(queue.length >= 1, "it is queued, though");

      // And the human's verb — the one no tool is handed — is what works.
      const accepted = acceptProposal(h.cwd, "A model must never accept");
      assert.equal(accepted.status, "accepted");
      assert.equal((await call(h.recall, { query: "never accept" })).details.matched, 1);
    } finally {
      h.cleanup();
    }
  });

  it("never touches the real ~/.lykos/memory — the harness redirects global scope too", () => {
    // D9, asserted rather than assumed: the one thing separating this suite
    // from a test that edits the developer's machine is the `filePath` in
    // `harness()`, so it is checked here.
    const h = harness();
    try {
      const real = join(homedir(), ".lykos", "memory");
      for (const file of ["gotchas", "failed-approaches"] as const) {
        assert.equal(h.path("global", file).startsWith(real), false);
        assert.equal(h.path("global", file).startsWith(h.cwd), true);
        assert.equal(h.path("project", file).startsWith(h.cwd), true);
      }
      assert.equal(proposedPath(h.cwd).startsWith(h.cwd), true);
    } finally {
      h.cleanup();
    }
  });

  it("defaults to the real store when no store is injected, and that store still cannot accept", () => {
    // The production wiring is the same object the assertions above pin, so
    // a session gets exactly the reachability a test does.
    const tools = [
      buildRetainTool({ cwd: process.cwd() }),
      buildRecallTool({ cwd: process.cwd() }),
      buildReflectTool({ cwd: process.cwd() }),
      buildMemoryEditTool({ cwd: process.cwd() }),
      buildLearnTool({ cwd: process.cwd() }),
    ];
    assert.deepEqual(
      tools.map((t) => t.name),
      [RETAIN_TOOL_NAME, RECALL_TOOL_NAME, REFLECT_TOOL_NAME, MEMORY_EDIT_TOOL_NAME, LEARN_TOOL_NAME],
    );
    assert.equal("accept" in LOCAL_MEMORY_STORE, false);
  });
});

// ---------------------------------------------------------------------------
// D8: mounted, hidden, in the catalog, measured
// ---------------------------------------------------------------------------

describe("P10.6 D8: the registry, the catalog and the measured tax", () => {
  it("all five are mounted, hidden and runtime-available", () => {
    for (const name of MEMORY_TOOL_NAMES) {
      const row = TOOL_REGISTRY.find((e) => e.name === name);
      assert.ok(row, `${name} has no registry row`);
      assert.equal(row.residency, "mounted", name);
      assert.equal(row.promptPresence, "hidden", name);
      assert.equal(RUNTIME_AVAILABLE_TOOLS.has(name), true, name);
      assert.equal(MOUNTED_TOOLS.includes(name), true, name);
      assert.equal(DEFAULT_RESIDENT_TOOLS.includes(name), false, name);
    }
  });

  it("declares the tier each one actually reaches", () => {
    // The two that only read are `read`; the three that write a line of
    // markdown are `soft-write`. None is `hard-write`: none runs a command,
    // and the only file `retain` and `learn` can write is a queue nothing
    // injects.
    assert.equal(tierForTool(RECALL_TOOL_NAME), "read");
    assert.equal(tierForTool(REFLECT_TOOL_NAME), "read");
    assert.equal(tierForTool(RETAIN_TOOL_NAME), "soft-write");
    assert.equal(tierForTool(LEARN_TOOL_NAME), "soft-write");
    assert.equal(tierForTool(MEMORY_EDIT_TOOL_NAME), "soft-write");
    assert.deepEqual(riskForTool(RECALL_TOOL_NAME), { tier: "read", idempotent: true, openWorld: false });
    assert.deepEqual(riskForTool(RETAIN_TOOL_NAME), { tier: "soft-write", idempotent: false, openWorld: false });
  });

  it("every catalog row equals its live definition, description and parameters both", () => {
    const rows: Array<[string, string, unknown]> = [
      [RETAIN_TOOL_NAME, RETAIN_DESCRIPTION, RETAIN_PARAMETERS],
      [RECALL_TOOL_NAME, RECALL_DESCRIPTION, RECALL_PARAMETERS],
      [REFLECT_TOOL_NAME, REFLECT_DESCRIPTION, REFLECT_PARAMETERS],
      [MEMORY_EDIT_TOOL_NAME, MEMORY_EDIT_DESCRIPTION, MEMORY_EDIT_PARAMETERS],
      [LEARN_TOOL_NAME, LEARN_DESCRIPTION, LEARN_PARAMETERS],
    ];
    for (const [name, description, parameters] of rows) {
      const row = TOOL_CATALOG[name];
      assert.ok(row, `${name} has no catalog row`);
      assert.equal(row.name, name);
      assert.equal(row.source, "lykos");
      assert.equal(row.description, description);
      assert.deepEqual(row.parameters, asJson(parameters));
    }
  });

  // Measured with `measureToolset` on SCHEMA_TOKENS_BASIS, 2026-09-21. The
  // last assertions are the point of D8: five tools were added and the
  // resident surface did not move a single token, because they are mounted.
  it("costs 1258 tokens if the five ever go resident, and 0 today", () => {
    const each: Record<string, [number, number]> = {
      retain: [310, 1241],
      recall: [263, 1053],
      reflect: [123, 492],
      memory_edit: [295, 1182],
      learn: [269, 1077],
    };
    for (const [name, [tokens, bytes]] of Object.entries(each)) {
      const m = measureToolset([name]);
      assert.equal(m.complete, true, name);
      assert.equal(m.tokens, tokens, name);
      assert.equal(m.bytes, bytes, name);
    }
    const five = measureToolset([...MEMORY_TOOL_NAMES]);
    assert.equal(five.tokens, 1258);
    assert.equal(five.bytes, 5041);

    // The resident surface is what rides every request, and THIS ticket did
    // not touch it — it was 1423 before and after the work in this file.
    // P10.7 (ticket 12): 1423 until this line was last touched, and 2062 now.
    // The resident total MOVED for the first time since P10.4, because
    // `web_search` (314 alone) and `web_fetch` (326 alone) were made RESIDENT
    // rather than mounted — 639 together, since array wrapping means the pair
    // is not the sum of the two. Nothing about this file's tool moved; this
    // line prices the surface it is being compared against.
    assert.equal(measureToolset(DEFAULT_RESIDENT_TOOLS).tokens, 2255);
    // The mounted set is what moved: 4065 tokens / 16297 bytes before this
    // ticket, 5322 / 21337 after it, and 6430 / 25773 once ticket 19 mounted
    // `eval` and `github` too. None of it rides a request — `tool_call`
    // fetches one schema at a time — but an unpriced tool makes the whole
    // toolset NULL rather than a silent undercount, so it is measured either
    // way. The figures this test OWNS are the five above, unchanged; the
    // mounted total is a shared number that every mounted tool moves when it
    // ships.
    // P10.6 ticket 20 moved it again — 6430 / 25773 before the nine session
    // and context tools, 8605 / 34500 after them. The five figures this test
    // OWNS are unchanged.
    const mounted = measureToolset(MOUNTED_TOOLS);
    assert.equal(mounted.tokens, 9023);
    assert.equal(mounted.bytes, 36175);
  });

  it("registers all five through loadTools, so tool_call can reach them", async () => {
    const { loadTools } = await import("./session-tools.js");
    const loaded = loadTools([], {
      cwd: process.cwd(),
      gate: { request: async () => "allow" } as never,
      modelProvider: "",
      modelId: "",
    });
    for (const name of MEMORY_TOOL_NAMES) {
      assert.ok(
        loaded.customTools.some((t) => t.name === name),
        `${name} is not registered, so tool_call would report it unknown`,
      );
      // Mounted, so it must NOT be on the active allowlist.
      assert.equal(loaded.activeToolNames.includes(name), false, name);
    }
    loaded.lsp.shutdownAll?.();
    await loaded.jobs.stopAll?.();
  });
});
