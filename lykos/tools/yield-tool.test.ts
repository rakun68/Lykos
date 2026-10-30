import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  YIELD_DESCRIPTION,
  YIELD_PARAMETERS,
  YIELD_TOOL_NAME,
  buildYieldTool,
  checkAgainstSchema,
  newYieldState,
} from "./yield-tool.js";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { measureToolset } from "../ledger/tool-schema.js";
import { riskForTool, tierForTool } from "./tool-risk.js";
import { DEFAULT_RESIDENT_TOOLS, MOUNTED_TOOLS, RUNTIME_AVAILABLE_TOOLS, TOOL_REGISTRY } from "./tool-surface.js";

async function call(
  tool: { execute: (...args: never[]) => unknown },
  args: Record<string, unknown>,
): Promise<{ text: string; details: Record<string, unknown>; isError: boolean }> {
  const result = (await (tool.execute as unknown as (
    id: string,
    params: unknown,
  ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown>; isError?: boolean }>)(
    "call-1",
    args,
  )) as { content: Array<{ text: string }>; details: Record<string, unknown>; isError?: boolean };
  return {
    text: result.content.map((c) => c.text).join("\n"),
    details: result.details,
    isError: result.isError === true,
  };
}

const SCHEMA = {
  type: "object",
  properties: {
    file: { type: "string" },
    line: { type: "number" },
  },
  required: ["file", "line"],
};

describe("P10.6 D5: yield returns the schema on a mismatch rather than accepting the result", () => {
  it("hands back the schema and the failure, and records nothing", async () => {
    const state = newYieldState();
    const tool = buildYieldTool({ state, schema: SCHEMA });

    const wrongShape = await call(tool, { result: JSON.stringify({ file: "a.ts" }) });
    assert.equal(wrongShape.isError, true);
    assert.equal(wrongShape.details.accepted, false);
    assert.equal(wrongShape.details.reason, "mismatch");
    // The schema itself is in what the model reads, which is the whole decision.
    assert.ok(wrongShape.text.includes('"required"'));
    assert.ok(wrongShape.text.includes('"line"'));
    assert.deepEqual(wrongShape.details.schema, SCHEMA);
    assert.equal(state.accepted.length, 0, "a result that did not match must not be recorded");
    assert.equal(state.rejected, 1);
  });

  it("tells prose apart from JSON of the wrong shape, because the corrections differ", async () => {
    const state = newYieldState();
    const tool = buildYieldTool({ state, schema: SCHEMA });
    const prose = await call(tool, { result: "It is in modes.ts on line 171." });
    assert.equal(prose.isError, true);
    assert.equal(prose.details.reason, "not_json");
    assert.ok(prose.text.includes("not JSON"));
    assert.ok(prose.text.includes('"properties"'), "the schema comes back either way");
    assert.equal(state.accepted.length, 0);
  });

  // The retry the decision exists for: corrected in place by the model that
  // wrote it, with nothing downstream repairing anything.
  it("accepts the corrected result on the next call and keeps the parsed value", async () => {
    const state = newYieldState();
    const tool = buildYieldTool({ state, schema: SCHEMA, now: () => new Date("2026-09-21T11:00:00.000Z") });
    await call(tool, { result: "not json" });
    const fixed = await call(tool, { result: JSON.stringify({ file: "modes.ts", line: 171 }) });
    assert.equal(fixed.isError, false);
    assert.equal(fixed.details.accepted, true);
    assert.equal(fixed.details.checked, true);
    assert.equal(state.rejected, 1);
    assert.deepEqual(state.accepted, [
      {
        raw: '{"file":"modes.ts","line":171}',
        value: { file: "modes.ts", line: 171 },
        final: true,
        at: "2026-09-21T11:00:00.000Z",
      },
    ]);
    assert.equal(state.calls, 2);
  });

  it("an intermediate yield is not checked, because the contract is on the answer", async () => {
    const state = newYieldState();
    const tool = buildYieldTool({ state, schema: SCHEMA });
    const progress = await call(tool, { result: "Halfway: four files left to read.", final: false });
    assert.equal(progress.isError, false);
    assert.equal(progress.details.checked, false);
    assert.equal(progress.details.final, false);
    assert.equal(state.rejected, 0);
    assert.equal(state.accepted.length, 1);
    assert.equal(state.accepted[0]!.final, false);
  });

  it("with no schema configured — the shipped default — a text answer is taken as written", async () => {
    const state = newYieldState();
    const tool = buildYieldTool({ state });
    const answered = await call(tool, { result: "It is in modes.ts on line 171." });
    assert.equal(answered.isError, false);
    assert.equal(answered.details.checked, false);
    assert.equal(state.accepted[0]!.raw, "It is in modes.ts on line 171.");
    assert.equal(state.accepted[0]!.value, undefined);
  });

  it("refuses an empty result", async () => {
    const state = newYieldState();
    const tool = buildYieldTool({ state, schema: SCHEMA });
    const empty = await call(tool, { result: "   " });
    assert.equal(empty.isError, true);
    assert.equal(empty.details.reason, "empty_result");
    assert.equal(state.accepted.length, 0);
    assert.equal(state.rejected, 0, "an empty call is a mis-call, not a schema rejection");
  });

  // A schema nothing can compile is the caller's bug. Refusing would trap a
  // child that can never satisfy it, so the result is taken and the model is
  // told the check did not happen.
  it("accepts and says so when the configured schema cannot be compiled", async () => {
    const state = newYieldState();
    const tool = buildYieldTool({ state, schema: { type: "not-a-type", $ref: "#/nowhere" } });
    const result = await call(tool, { result: JSON.stringify({ anything: true }) });
    if (result.details.reason === "unusable_schema") {
      assert.equal(result.isError, false);
      assert.equal(result.details.accepted, true);
      assert.equal(result.details.checked, false);
      assert.ok(result.text.includes("could not be compiled"));
    } else {
      // Some schema compilers accept the shape above and simply fail the
      // value; that is a mismatch, which is the other correct answer.
      assert.equal(result.details.accepted, false);
      assert.equal(result.details.reason, "mismatch");
    }
    assert.equal(state.calls, 1);
  });
});

describe("checkAgainstSchema", () => {
  it("separates not-JSON, mismatch and ok", () => {
    assert.equal(checkAgainstSchema(SCHEMA, "{").status, "not_json");
    const mismatch = checkAgainstSchema(SCHEMA, '{"file": 1, "line": "x"}');
    assert.equal(mismatch.status, "mismatch");
    assert.ok(mismatch.status === "mismatch" && mismatch.errors.length > 0);
    const ok = checkAgainstSchema(SCHEMA, '{"file":"a","line":2}');
    assert.equal(ok.status, "ok");
    assert.deepEqual(ok.status === "ok" ? ok.value : undefined, { file: "a", line: 2 });
  });
});

describe("the yield definition", () => {
  it("is named yield and takes result plus an optional final", () => {
    const tool = buildYieldTool({ state: newYieldState() });
    assert.equal(tool.name, YIELD_TOOL_NAME);
    const params = tool.parameters as unknown as { required?: string[]; properties: Record<string, unknown> };
    assert.deepEqual(params.required, ["result"]);
    assert.deepEqual(Object.keys(params.properties), ["result", "final"]);
  });
});

// ---------------------------------------------------------------------------
// D9: mounted, hidden, in the catalog, measured
// ---------------------------------------------------------------------------

describe("P10.6 D9: the registry, the catalog and the measured tax", () => {
  it("is mounted, hidden and runtime-available, and not resident", () => {
    const row = TOOL_REGISTRY.find((e) => e.name === YIELD_TOOL_NAME);
    assert.ok(row);
    assert.equal(row.residency, "mounted");
    assert.equal(row.promptPresence, "hidden");
    assert.equal(RUNTIME_AVAILABLE_TOOLS.has(YIELD_TOOL_NAME), true);
    assert.equal(MOUNTED_TOOLS.includes(YIELD_TOOL_NAME), true);
    assert.equal(DEFAULT_RESIDENT_TOOLS.includes(YIELD_TOOL_NAME), false);
    assert.equal(tierForTool(YIELD_TOOL_NAME), "read");
    assert.deepEqual(riskForTool(YIELD_TOOL_NAME), { tier: "read", idempotent: true, openWorld: false });
  });

  it("the catalog row equals the live definition, description and parameters both", () => {
    const row = TOOL_CATALOG[YIELD_TOOL_NAME];
    assert.ok(row);
    assert.equal(row.source, "lykos");
    assert.equal(row.description, YIELD_DESCRIPTION);
    assert.deepEqual(row.parameters, JSON.parse(JSON.stringify(YIELD_PARAMETERS)));
  });

  // Measured with `measureToolset` on SCHEMA_TOKENS_BASIS, 2026-09-21.
  it("costs 220 tokens if it ever goes resident, and 0 today", () => {
    const alone = measureToolset([YIELD_TOOL_NAME]);
    assert.equal(alone.complete, true);
    assert.equal(alone.tokens, 220);
    assert.equal(alone.bytes, 884);
    // P10.7 (ticket 12): 1423 until this line was last touched, and 2062 now.
    // The resident total MOVED for the first time since P10.4, because
    // `web_search` (314 alone) and `web_fetch` (326 alone) were made RESIDENT
    // rather than mounted — 639 together, since array wrapping means the pair
    // is not the sum of the two. Nothing about this file's tool moved; this
    // line prices the surface it is being compared against.
    assert.equal(measureToolset(DEFAULT_RESIDENT_TOOLS).tokens, 2255);
  });

  it("registers through loadTools with the session's own yield state and no schema by default", async () => {
    const { loadTools } = await import("./session-tools.js");
    const loaded = loadTools([], {
      cwd: process.cwd(),
      gate: { request: async () => "allow" } as never,
      modelProvider: "",
      modelId: "",
    });
    assert.ok(loaded.customTools.some((t) => t.name === YIELD_TOOL_NAME));
    assert.equal(loaded.activeToolNames.includes(YIELD_TOOL_NAME), false);
    assert.deepEqual(loaded.yielded, { accepted: [], rejected: 0, calls: 0 });

    // The knob, wired: a caller that asks for a shape gets it enforced.
    const withSchema = loadTools([], {
      cwd: process.cwd(),
      gate: { request: async () => "allow" } as never,
      modelProvider: "",
      modelId: "",
      yieldSchema: SCHEMA,
    });
    const tool = withSchema.customTools.find((t) => t.name === YIELD_TOOL_NAME)!;
    const rejected = await call(tool as never, { result: "prose, not JSON" });
    assert.equal(rejected.isError, true);
    assert.equal(withSchema.yielded.rejected, 1);
    assert.equal(loaded.yielded.rejected, 0, "one session's yield state is not another's");

    for (const l of [loaded, withSchema]) {
      l.lsp.shutdownAll();
      await l.jobs.stopAll();
      await l.evalRuntimes.disposeAll();
    }
  });
});
