import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXIT_PLAN_TOOL_NAME,
  NOT_PLANNING_NOTICE,
  PLAN_DECLINED_NOTICE,
  buildExitPlanTool,
  newPlanState,
  type ExitPlanToolOpts,
} from "./plan-tool.js";
import type { InteractionMode } from "../gate/modes.js";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { measureToolset } from "../ledger/tool-schema.js";

const call = async (tool: ReturnType<typeof buildExitPlanTool>, params: unknown) =>
  await (
    tool as unknown as {
      execute: (
        id: string,
        p: unknown,
      ) => Promise<{ content: Array<{ text: string }>; details?: Record<string, unknown> }>;
    }
  ).execute("call-1", params);

function harness(over: Partial<ExitPlanToolOpts> & { isPlanning?: () => boolean } = {}) {
  const state = newPlanState();
  let mode: InteractionMode = "manual";
  let planning = true;
  const presented: string[] = [];
  const recorded: Array<[string, string]> = [];
  const opts: ExitPlanToolOpts = {
    state,
    currentMode: () => mode,
    isPlanning: () => planning,
    requestExit: async (plan) => {
      presented.push(plan);
      return "auto";
    },
    record: (plan, outcome) => recorded.push([plan, outcome]),
    ...over,
  };
  return {
    tool: buildExitPlanTool(opts),
    state,
    presented,
    recorded,
    setMode: (m: InteractionMode) => {
      mode = m;
    },
    setPlanning: (p: boolean) => {
      planning = p;
    },
  };
}

describe("the exit-plan tool", () => {
  it("presents the plan and reports the mode it landed in", async () => {
    const h = harness();
    const out = await call(h.tool, { plan: "1. rename the type 2. run the tests" });
    assert.deepEqual(h.presented, ["1. rename the type 2. run the tests"]);
    assert.equal(out.details?.exited, true);
    assert.equal(out.details?.mode, "auto");
    assert.match(out.content[0]!.text, /Auto/);
    assert.deepEqual(h.state, { presented: 1, approved: 1, rejected: 0, misfired: 0 });
  });

  it("stays in Plan mode when the human declines, and says what to do instead", async () => {
    const h = harness({ requestExit: async () => null });
    const out = await call(h.tool, { plan: "p" });
    assert.equal(out.content[0]!.text, PLAN_DECLINED_NOTICE);
    assert.equal(out.details?.exited, false);
    assert.deepEqual(h.state, { presented: 1, approved: 0, rejected: 1, misfired: 0 });
  });

  it("treats a broken channel as a decline, never as an exit", async () => {
    const h = harness({
      requestExit: async () => {
        throw new Error("no tty");
      },
    });
    const out = await call(h.tool, { plan: "p" });
    assert.equal(out.details?.exited, false, "a failed prompt must not leave Plan mode");
    assert.equal(h.state.rejected, 1);
  });

  it("changes nothing when called outside Plan mode, and counts the misfire", async () => {
    const h = harness();
    h.setPlanning(false);
    const out = await call(h.tool, { plan: "p" });
    assert.equal(out.content[0]!.text, NOT_PLANNING_NOTICE);
    assert.equal(out.details?.exited, false);
    assert.deepEqual(h.presented, [], "the human is not disturbed by a misfire");
    assert.deepEqual(h.state, { presented: 0, approved: 0, rejected: 0, misfired: 1 });
  });

  it("records the outcome for the transcript", async () => {
    const h = harness();
    await call(h.tool, { plan: "the plan" });
    assert.deepEqual(h.recorded, [["the plan", "approved"]]);
  });
});

describe("the schema tax", () => {
  it("is catalogued, so the bill is a number and not a recollection", () => {
    const entry = TOOL_CATALOG[EXIT_PLAN_TOOL_NAME];
    assert.ok(entry, "rule 3: record the schema tax at the moment the tool is added");
    assert.equal(entry.source, "lykos");
  });

  it("keeps the catalogued description identical to the real one", () => {
    // The parity rule `ask` follows: an edit to one description that is not
    // made in the other silently misprices every session that carries it.
    const real = (harness().tool as unknown as { description: string }).description;
    assert.equal(
      TOOL_CATALOG[EXIT_PLAN_TOOL_NAME]!.description.replace(/[-—]/g, "-"),
      real.replace(/[-—]/g, "-"),
    );
  });

  it("costs what the repository says it costs", () => {
    const withTool = measureToolset(["read", "bash", EXIT_PLAN_TOOL_NAME]);
    const without = measureToolset(["read", "bash"]);
    assert.ok(withTool.complete && without.complete, "both specialists must be catalogued");
    const tax = (withTool.tokens ?? 0) - (without.tokens ?? 0);
    // Recorded, not merely computed: 114 tokens on 2026-09-08. A change that
    // moves this is a cost decision and should be made deliberately, so the
    // bound is tight enough to notice one.
    assert.equal(tax, 114, `exit_plan schema tax changed to ${tax} tokens — update plan-tool.ts's recorded bill`);
  });
});
