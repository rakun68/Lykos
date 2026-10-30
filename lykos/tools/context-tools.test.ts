import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CONTEXT_NOTES_DESCRIPTION,
  CONTEXT_NOTES_MAX_BYTES,
  CONTEXT_NOTES_MAX_KEYS,
  CONTEXT_NOTES_PARAMETERS,
  CONTEXT_NOTES_TOOL_NAME,
  CONTEXT_TOOL_NAMES,
  GOAL_DESCRIPTION,
  GOAL_MAX_CHARS,
  GOAL_PARAMETERS,
  GOAL_TOOL_NAME,
  SCRATCHPAD_NOTICE,
  THINK_ACKNOWLEDGEMENT,
  THINK_DESCRIPTION,
  THINK_PARAMETERS,
  THINK_TOOL_NAME,
  buildContextNotesTool,
  buildContextTools,
  buildGoalTool,
  buildThinkTool,
  newSessionScratch,
  storeBytes,
  type SessionScratch,
} from "./context-tools.js";
import { assembleMountedCatalogHead } from "../session/mounted-catalog-head.js";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { measureToolset } from "../ledger/tool-schema.js";
import { riskForTool, tierForTool } from "./tool-risk.js";
import { DEFAULT_RESIDENT_TOOLS, MOUNTED_TOOLS, RUNTIME_AVAILABLE_TOOLS, TOOL_REGISTRY } from "./tool-surface.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Calls a definition the way `tool_call` does, and returns the text plus the details. */
async function call(
  tool: { execute: (...args: never[]) => unknown },
  args: Record<string, unknown>,
): Promise<{ text: string; details: Record<string, unknown>; isError: boolean }> {
  const result = (await (tool.execute as unknown as (
    id: string,
    params: unknown,
  ) => Promise<{
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
    isError?: boolean;
  }>)("call-1", args)) as {
    content: Array<{ text: string }>;
    details: Record<string, unknown>;
    isError?: boolean;
  };
  return {
    text: result.content.map((c) => c.text).join("\n"),
    details: result.details,
    isError: result.isError === true,
  };
}

function scratchAndNotes(): { scratch: SessionScratch; notes: ReturnType<typeof buildContextNotesTool> } {
  const scratch = newSessionScratch();
  return { scratch, notes: buildContextNotesTool({ scratch }) };
}

describe("P10.6 D2: context_notes is session state, not memory and not the transcript", () => {
  it("writes, reads back and lists a note, and says out loud that it dies with the session", async () => {
    const { scratch, notes } = scratchAndNotes();

    const written = await call(notes, { note: "api-shape", text: "openLedger takes a path, not a handle." });
    assert.equal(written.isError, false);
    assert.equal(written.details.written, true);
    assert.equal(written.details.replaced, false);
    assert.ok(written.text.includes(SCRATCHPAD_NOTICE));

    const read = await call(notes, { note: "api-shape" });
    assert.equal(read.isError, false);
    assert.equal(read.text, "[api-shape]\nopenLedger takes a path, not a handle.");

    const listed = await call(notes, {});
    assert.deepEqual(listed.details.notes, ["api-shape"]);
    assert.ok(listed.text.includes("openLedger takes a path"));
    assert.ok(listed.text.includes(SCRATCHPAD_NOTICE));

    // The state it survives in is the object handed in, and nothing else.
    assert.equal(scratch.notes.get("api-shape"), "openLedger takes a path, not a handle.");
    assert.equal(scratch.writes, 1);
  });

  it("a second write to the same key replaces rather than appends", async () => {
    const { scratch, notes } = scratchAndNotes();
    await call(notes, { note: "k", text: "first" });
    const again = await call(notes, { note: "k", text: "second" });
    assert.equal(again.details.replaced, true);
    assert.equal(scratch.notes.get("k"), "second");
    assert.equal(scratch.notes.size, 1);
  });

  it("drops a note, and refuses to drop one that is not there rather than reporting success", async () => {
    const { scratch, notes } = scratchAndNotes();
    await call(notes, { note: "k", text: "v" });
    const dropped = await call(notes, { note: "k", drop: true });
    assert.equal(dropped.isError, false);
    assert.equal(dropped.details.dropped, true);
    assert.equal(scratch.notes.size, 0);

    const missing = await call(notes, { note: "k", drop: true });
    assert.equal(missing.isError, true);
    assert.equal(missing.details.dropped, false);
  });

  it("a read of an unknown key names what exists instead of inventing an empty note", async () => {
    const { notes } = scratchAndNotes();
    await call(notes, { note: "alpha", text: "a" });
    const miss = await call(notes, { note: "beta" });
    assert.equal(miss.isError, true);
    assert.equal(miss.details.found, false);
    assert.ok(miss.text.includes("alpha"));
  });

  it("rejects a key that is not the documented shape", async () => {
    const { scratch, notes } = scratchAndNotes();
    for (const bad of ["Findings", "with space", "-leading", "a".repeat(65), "sl/ash"]) {
      const result = await call(notes, { note: bad, text: "x" });
      assert.equal(result.isError, true, bad);
      assert.equal(result.details.reason, "bad_key", bad);
    }
    assert.equal(scratch.notes.size, 0);
  });

  // The cap is the reference's figure and the refusal is the point: a note
  // silently truncated is a note the model believes it has and does not.
  it("refuses a write past the byte cap and changes nothing, rather than truncating", async () => {
    const { scratch, notes } = scratchAndNotes();
    await call(notes, { note: "keep", text: "small" });
    const huge = await call(notes, { note: "big", text: "x".repeat(CONTEXT_NOTES_MAX_BYTES) });
    assert.equal(huge.isError, true);
    assert.equal(huge.details.reason, "byte_cap");
    assert.equal(scratch.notes.has("big"), false);
    assert.equal(scratch.notes.get("keep"), "small");
    assert.ok(storeBytes(scratch.notes) < CONTEXT_NOTES_MAX_BYTES);
  });

  it("counts a replacement against the cap using the new size, not the sum of both", async () => {
    const { scratch, notes } = scratchAndNotes();
    const nearly = "y".repeat(CONTEXT_NOTES_MAX_BYTES - 100);
    assert.equal((await call(notes, { note: "k", text: nearly })).isError, false);
    // Replacing it with the same size must be allowed: the old bytes go away.
    assert.equal((await call(notes, { note: "k", text: nearly })).isError, false);
    assert.equal(scratch.notes.get("k")!.length, nearly.length);
  });

  it("refuses a new key past the key cap", async () => {
    const { scratch, notes } = scratchAndNotes();
    for (let i = 0; i < CONTEXT_NOTES_MAX_KEYS; i++) {
      assert.equal((await call(notes, { note: `n${i}`, text: "v" })).isError, false, `n${i}`);
    }
    const over = await call(notes, { note: "one-too-many", text: "v" });
    assert.equal(over.isError, true);
    assert.equal(over.details.reason, "key_cap");
    // But replacing an existing key still works at the cap.
    assert.equal((await call(notes, { note: "n0", text: "replaced" })).isError, false);
    assert.equal(scratch.notes.size, CONTEXT_NOTES_MAX_KEYS);
  });

  // D2's structural half: this module cannot write anything durable because it
  // was handed nothing that could. Asserted against the source, because the
  // thing being pinned is an absence.
  it("has no file path, no writer and no memory store anywhere in the module", () => {
    const source = readFileSync(join(here, "context-tools.ts"), "utf8");
    for (const forbidden of ["writeFileSync", "proposeMemory", "memoryFilePath", "node:fs", "appendFileSync"]) {
      assert.equal(source.includes(forbidden), false, `${forbidden} must not be reachable from context-tools.ts`);
    }
  });

  it("two sessions do not share a store", async () => {
    const a = scratchAndNotes();
    const b = scratchAndNotes();
    await call(a.notes, { note: "k", text: "a's" });
    const fromB = await call(b.notes, { note: "k" });
    assert.equal(fromB.isError, true);
    assert.equal(b.scratch.notes.size, 0);
  });
});

describe("P10.6 D6: goal is the session's standing objective", () => {
  it("reads as unset, sets, reads back, and replaces", async () => {
    const scratch = newSessionScratch();
    const goal = buildGoalTool({ scratch, now: () => new Date("2026-09-21T10:00:00.000Z") });

    const empty = await call(goal, {});
    assert.equal(empty.details.set, false);

    const set = await call(goal, { goal: "Ship the session and context tools." });
    assert.equal(set.details.set, true);
    assert.equal(scratch.goal, "Ship the session and context tools.");
    assert.equal(scratch.goalSetAt, "2026-09-21T10:00:00.000Z");

    const read = await call(goal, {});
    assert.equal(read.details.goal, "Ship the session and context tools.");
    assert.ok(read.text.includes("2026-09-21T10:00:00.000Z"));

    const replaced = await call(goal, { goal: "Ship them and close the ticket." });
    assert.equal(replaced.details.previous, "Ship the session and context tools.");
    assert.equal(scratch.goalSets, 2);
  });

  it("flattens a multi-line objective to one line and refuses one past the cap", async () => {
    const scratch = newSessionScratch();
    const goal = buildGoalTool({ scratch });
    await call(goal, { goal: "  first line\n\n  second line  " });
    assert.equal(scratch.goal, "first line second line");

    const over = await call(goal, { goal: "z".repeat(GOAL_MAX_CHARS + 1) });
    assert.equal(over.isError, true);
    assert.equal(over.details.reason, "too_long");
    assert.equal(scratch.goal, "first line second line");
  });

  it("an empty or whitespace goal reads rather than clearing the objective", async () => {
    const scratch = newSessionScratch();
    const goal = buildGoalTool({ scratch });
    await call(goal, { goal: "the objective" });
    const blank = await call(goal, { goal: "   " });
    assert.equal(blank.details.op, "read");
    assert.equal(scratch.goal, "the objective");
  });
});

describe("P10.6 D6: think produces no side effect at all", () => {
  // The assertion the decision asks for, made by trying: the definition is
  // handed nothing, so there is nothing for it to have changed.
  it("changes nothing anywhere, and always answers the same sentence", async () => {
    const think = buildThinkTool();
    assert.equal(buildThinkTool.length, 0, "buildThinkTool takes no options — that is the enforcement");

    const scratch = newSessionScratch();
    const before = JSON.stringify({ ...scratch, notes: [...scratch.notes] });

    const first = await call(think, { thought: "Maybe the gate belongs upstream of the registry." });
    const second = await call(think, { thought: "No — the registry is what the gate reads." });
    assert.equal(first.text, THINK_ACKNOWLEDGEMENT);
    assert.equal(second.text, THINK_ACKNOWLEDGEMENT);
    assert.equal(first.details.changed, false);

    assert.equal(JSON.stringify({ ...scratch, notes: [...scratch.notes] }), before);
  });

  it("does not keep a counter of its own, because a counter is a side effect", () => {
    const source = readFileSync(join(here, "context-tools.ts"), "utf8");
    const start = source.indexOf("export function buildThinkTool");
    const thinkSection = source.slice(start, source.indexOf("/** All three", start));
    assert.ok(thinkSection.length > 200, "the slice must actually cover buildThinkTool's body");
    for (const forbidden of ["+= 1", "scratch", "opts"]) {
      assert.equal(thinkSection.includes(forbidden), false, `buildThinkTool must not reference ${forbidden}`);
    }
  });
});

describe("buildContextTools", () => {
  it("builds the three in the documented order, over one piece of session state", () => {
    const scratch = newSessionScratch();
    const tools = buildContextTools({ scratch });
    assert.deepEqual(
      tools.map((t) => t.name),
      [...CONTEXT_TOOL_NAMES],
    );
    assert.deepEqual([...CONTEXT_TOOL_NAMES], [CONTEXT_NOTES_TOOL_NAME, GOAL_TOOL_NAME, THINK_TOOL_NAME]);
  });
});

// ---------------------------------------------------------------------------
// D6 / D9: mounted, hidden, in the catalog, measured
// ---------------------------------------------------------------------------

describe("P10.6 D9: the registry, the catalog and the measured tax", () => {
  it("all three are mounted, hidden and runtime-available, and none is resident", () => {
    for (const name of CONTEXT_TOOL_NAMES) {
      const row = TOOL_REGISTRY.find((e) => e.name === name);
      assert.ok(row, `${name} has no registry row`);
      assert.equal(row.residency, "mounted", name);
      assert.equal(row.promptPresence, "hidden", name);
      assert.equal(RUNTIME_AVAILABLE_TOOLS.has(name), true, name);
      assert.equal(MOUNTED_TOOLS.includes(name), true, name);
      assert.equal(DEFAULT_RESIDENT_TOOLS.includes(name), false, name);
    }
  });

  // D6's other half: "no entry in any catalog listing the model reads". The
  // mounted-catalog block is that listing — it renders `named` and `full`
  // entries and omits `hidden` ones — so goal and think appear nowhere in it.
  it("goal and think appear in no catalog listing the model reads", () => {
    const head = assembleMountedCatalogHead();
    assert.ok(head.length > 0, "the block is non-empty, so absence from it means something");
    for (const name of CONTEXT_TOOL_NAMES) {
      assert.equal(head.includes(`- ${name}:`), false, name);
      assert.equal(head.includes(`### ${name}`), false, name);
    }
  });

  it("declares the tier each one actually reaches", () => {
    // All three are `read`: none writes a file, runs a command or reaches the
    // network. `context_notes` and `goal` mutate an object that dies with the
    // session, which is why neither is idempotent; `think` mutates nothing.
    for (const name of CONTEXT_TOOL_NAMES) assert.equal(tierForTool(name), "read", name);
    assert.deepEqual(riskForTool(THINK_TOOL_NAME), { tier: "read", idempotent: true, openWorld: false });
    assert.deepEqual(riskForTool(CONTEXT_NOTES_TOOL_NAME), { tier: "read", idempotent: false, openWorld: false });
  });

  it("every catalog row equals its live definition, description and parameters both", () => {
    const rows: Array<[string, string, unknown]> = [
      [CONTEXT_NOTES_TOOL_NAME, CONTEXT_NOTES_DESCRIPTION, CONTEXT_NOTES_PARAMETERS],
      [GOAL_TOOL_NAME, GOAL_DESCRIPTION, GOAL_PARAMETERS],
      [THINK_TOOL_NAME, THINK_DESCRIPTION, THINK_PARAMETERS],
    ];
    for (const [name, description, parameters] of rows) {
      const row = TOOL_CATALOG[name];
      assert.ok(row, `${name} has no catalog row`);
      assert.equal(row.name, name);
      assert.equal(row.source, "lykos");
      assert.equal(row.description, description);
      assert.deepEqual(row.parameters, JSON.parse(JSON.stringify(parameters)));
    }
  });

  // Measured with `measureToolset` on SCHEMA_TOKENS_BASIS, 2026-09-21.
  it("costs 606 tokens if the three ever go resident, and 0 today", () => {
    const each: Record<string, [number, number]> = {
      context_notes: [265, 1062],
      goal: [176, 705],
      think: [166, 664],
    };
    for (const [name, [tokens, bytes]] of Object.entries(each)) {
      const m = measureToolset([name]);
      assert.equal(m.complete, true, name);
      assert.equal(m.tokens, tokens, name);
      assert.equal(m.bytes, bytes, name);
    }
    const three = measureToolset([...CONTEXT_TOOL_NAMES]);
    // Measured whole, not summed: measure(A+B) is not measure(A)+measure(B),
    // because the array wrapping is paid once.
    assert.equal(three.tokens, 606);
    assert.equal(three.bytes, 2429);

    // The resident surface is what rides every request, and THIS ticket did
    // not touch it — it was 1423 before and after the work in this file.
    // P10.7 (ticket 12): 1423 until this line was last touched, and 2062 now.
    // The resident total MOVED for the first time since P10.4, because
    // `web_search` (314 alone) and `web_fetch` (326 alone) were made RESIDENT
    // rather than mounted — 639 together, since array wrapping means the pair
    // is not the sum of the two. Nothing about this file's tool moved; this
    // line prices the surface it is being compared against.
    assert.equal(measureToolset(DEFAULT_RESIDENT_TOOLS).tokens, 2255);
  });

  it("registers all three through loadTools, so tool_call can reach them", async () => {
    const { loadTools } = await import("./session-tools.js");
    const loaded = loadTools([], {
      cwd: process.cwd(),
      gate: { request: async () => "allow" } as never,
      modelProvider: "",
      modelId: "",
    });
    for (const name of CONTEXT_TOOL_NAMES) {
      assert.ok(loaded.customTools.some((t) => t.name === name), `${name} is not registered`);
      assert.equal(loaded.activeToolNames.includes(name), false, `${name} must stay off the wire`);
    }
    // The state is the SESSION's, created once per loadTools call, so one
    // session's notes cannot be read by the next in this process.
    assert.equal(loaded.scratch.notes.size, 0);
    const second = loadTools([], {
      cwd: process.cwd(),
      gate: { request: async () => "allow" } as never,
      modelProvider: "",
      modelId: "",
    });
    assert.notEqual(loaded.scratch, second.scratch);
    loaded.lsp.shutdownAll();
    second.lsp.shutdownAll();
    await loaded.jobs.stopAll();
    await second.jobs.stopAll();
    await loaded.evalRuntimes.disposeAll();
    await second.evalRuntimes.disposeAll();
  });
});
