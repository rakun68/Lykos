import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  applyTaskListUpdate,
  buildTaskListTool,
  DEFAULT_REMINDER_INTERVAL,
  hasOpenItems,
  newTaskListState,
  readTaskListFile,
  renderTaskList,
  resumeTaskListState,
  TASK_LIST_TOOL_NAME,
  taskListReminder,
  writeTaskListFile,
  type TaskListState,
} from "./task-list.js";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { measureToolset } from "../ledger/tool-schema.js";

const here = dirname(fileURLToPath(import.meta.url));

function seeded(texts: string[]): TaskListState {
  const state = newTaskListState();
  applyTaskListUpdate(state, { add: texts.map((text) => ({ text })) });
  return state;
}

describe("applyTaskListUpdate", () => {
  it("assigns sequential ids and counts what it created", () => {
    const state = seeded(["parse", "wire", "document"]);
    assert.deepEqual(
      state.items.map((i) => i.id),
      [1, 2, 3],
    );
    assert.equal(state.created, 3);
    assert.equal(state.items.every((i) => i.status === "pending"), true);
  });

  it("keeps exactly one item in progress", () => {
    const state = seeded(["a", "b"]);
    applyTaskListUpdate(state, { start: 1 });
    applyTaskListUpdate(state, { start: 2 });
    assert.equal(state.items[0]!.status, "pending");
    assert.equal(state.items[1]!.status, "in_progress");
  });

  it("counts a completion once, however many times it is marked", () => {
    const state = seeded(["a"]);
    applyTaskListUpdate(state, { done: [1] });
    applyTaskListUpdate(state, { done: [1] });
    assert.equal(state.completed, 1);
  });

  it("rejects an unknown id and names the open ones", () => {
    const state = seeded(["a", "b"]);
    const result = applyTaskListUpdate(state, { done: [7] });
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, /no item 7/);
    assert.match((result as { error: string }).error, /open ids: 1, 2/);
  });

  it("applies nothing at all when one referenced id is bad", () => {
    const state = seeded(["a", "b"]);
    const result = applyTaskListUpdate(state, { done: [1, 99] });
    assert.equal(result.ok, false);
    // The good half must not have landed: a half-applied list is worse than
    // a rejected one, because the model cannot tell what took effect.
    assert.equal(state.items[0]!.status, "pending");
    assert.equal(state.completed, 0);
  });

  it("refuses an empty item rather than adding a blank line to the list", () => {
    const state = newTaskListState();
    const result = applyTaskListUpdate(state, { add: [{ text: "   " }] });
    assert.equal(result.ok, false);
    assert.equal(state.items.length, 0);
  });

  it("reports changed:false for a call that only re-reads", () => {
    const state = seeded(["a"]);
    const result = applyTaskListUpdate(state, {});
    assert.equal(result.ok, true);
    assert.equal((result as { changed: boolean }).changed, false);
  });

  it("carries a verify command onto the item and trims it", () => {
    const state = newTaskListState();
    applyTaskListUpdate(state, { add: [{ text: "typecheck clean", verify: "  npm run typecheck  " }] });
    assert.equal(state.items[0]!.verify, "npm run typecheck");
  });

  it("does not store an empty verify string as a command", () => {
    const state = newTaskListState();
    applyTaskListUpdate(state, { add: [{ text: "a", verify: "  " }] });
    assert.equal(state.items[0]!.verify, undefined);
  });
});

describe("renderTaskList", () => {
  it("says so when the list is empty", () => {
    assert.equal(renderTaskList(newTaskListState()), "task list: empty");
  });

  it("shows a mark per status and counts what is open", () => {
    const state = seeded(["a", "b", "c"]);
    applyTaskListUpdate(state, { start: 1, done: [2], drop: [3] });
    const text = renderTaskList(state);
    assert.match(text, /task list \(1 open of 3\)/);
    assert.match(text, /1 \[>\] a/);
    assert.match(text, /2 \[x\] b/);
    assert.match(text, /3 \[-\] c/);
  });

  it("shows the verify command and its verdict", () => {
    const state = newTaskListState();
    applyTaskListUpdate(state, { add: [{ text: "a", verify: "npm test" }] });
    state.items[0]!.verified = { ok: false, exitCode: 1, at: "2026-09-06T00:00:00.000Z" };
    assert.match(renderTaskList(state), /\(verify: npm test\)  VERIFY FAILED/);
  });
});

describe("taskListReminder", () => {
  it("stays silent while nothing is open", () => {
    const state = seeded(["a"]);
    applyTaskListUpdate(state, { done: [1] });
    for (let i = 0; i < DEFAULT_REMINDER_INTERVAL * 2; i++) {
      assert.equal(taskListReminder(state), undefined);
    }
    assert.equal(state.reminders, 0);
  });

  it("fires once per interval and renders the list", () => {
    const state = seeded(["a"]);
    for (let i = 0; i < DEFAULT_REMINDER_INTERVAL - 1; i++) {
      assert.equal(taskListReminder(state), undefined);
    }
    const note = taskListReminder(state);
    assert.match(String(note), /task list \(1 open of 1\)/);
    assert.equal(state.reminders, 1);
    // And the clock restarts rather than firing on every call from here on.
    assert.equal(taskListReminder(state), undefined);
  });
});

describe("hasOpenItems", () => {
  it("ignores done and dropped items", () => {
    const state = seeded(["a", "b"]);
    applyTaskListUpdate(state, { done: [1], drop: [2] });
    assert.equal(hasOpenItems(state), false);
  });
});

describe("the tasks.json file", () => {
  it("round-trips through the session directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-tasks-"));
    try {
      const state = seeded(["a", "b"]);
      applyTaskListUpdate(state, { done: [1] });
      writeTaskListFile(dir, "sess-1", state);
      const back = readTaskListFile(dir);
      assert.equal(back?.sessionId, "sess-1");
      assert.equal(back?.items.length, 2);
      assert.equal(back?.counters.completed, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a missing file rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-tasks-"));
    try {
      assert.equal(readTaskListFile(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a damaged file rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-tasks-"));
    try {
      writeFileSync(join(dir, "tasks.json"), "{not json", "utf8");
      assert.equal(readTaskListFile(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resumeTaskListState", () => {
  it("carries only the unfinished items, renumbered from 1", () => {
    const state = seeded(["done one", "still open", "dropped one", "also open"]);
    applyTaskListUpdate(state, { done: [1], drop: [3], start: 2 });
    const resumed = resumeTaskListState({
      schemaVersion: 1,
      sessionId: "s",
      updatedUtc: "now",
      items: state.items,
      nextId: state.nextId,
      counters: { calls: 4, created: 4, completed: 1, reminders: 2, gateRefusals: 1 },
    });
    assert.deepEqual(
      resumed.items.map((i) => [i.id, i.text, i.status]),
      [
        [1, "still open", "pending"],
        [2, "also open", "pending"],
      ],
    );
  });

  it("does not inherit the previous session's counters", () => {
    const resumed = resumeTaskListState({
      schemaVersion: 1,
      sessionId: "s",
      updatedUtc: "now",
      items: [{ id: 1, text: "open", status: "pending" }],
      nextId: 2,
      counters: { calls: 9, created: 9, completed: 9, reminders: 9, gateRefusals: 9 },
    });
    assert.equal(resumed.calls, 0);
    assert.equal(resumed.created, 0);
    assert.equal(resumed.completed, 0);
    assert.equal(resumed.reminders, 0);
    assert.equal(resumed.gateRefusals, 0);
  });

  it("starts empty when there is no previous file", () => {
    assert.equal(resumeTaskListState(null).items.length, 0);
  });

  it("keeps a verify command across the resume", () => {
    const resumed = resumeTaskListState({
      schemaVersion: 1,
      sessionId: "s",
      updatedUtc: "now",
      items: [{ id: 1, text: "open", status: "in_progress", verify: "npm test" }],
      nextId: 2,
      counters: { calls: 0, created: 0, completed: 0, reminders: 0, gateRefusals: 0 },
    });
    assert.equal(resumed.items[0]!.verify, "npm test");
  });
});

describe("the todo tool", () => {
  const call = async (tool: ReturnType<typeof buildTaskListTool>, params: unknown) =>
    (await (tool as unknown as {
      execute: (id: string, p: unknown, s?: unknown, u?: unknown, c?: unknown) => Promise<{ content: Array<{ text: string }>; details?: unknown }>;
    }).execute("call-1", params)) as { content: Array<{ text: string }>; details?: Record<string, unknown> };

  it("counts every call, so 'was this ever used' has an answer", async () => {
    const state = newTaskListState();
    const tool = buildTaskListTool({ state });
    await call(tool, {});
    await call(tool, { add: [{ text: "a" }] });
    assert.equal(state.calls, 2);
  });

  it("returns the whole list so the model never has to remember an id", async () => {
    const state = newTaskListState();
    const tool = buildTaskListTool({ state });
    const result = await call(tool, { add: [{ text: "parse" }, { text: "wire" }] });
    assert.match(result.content[0]!.text, /1 \[ \] parse/);
    assert.match(result.content[0]!.text, /2 \[ \] wire/);
  });

  it("calls onChange for a mutation and not for a re-read", async () => {
    const state = newTaskListState();
    let changes = 0;
    const tool = buildTaskListTool({ state, onChange: () => void (changes += 1) });
    await call(tool, { add: [{ text: "a" }] });
    await call(tool, {});
    assert.equal(changes, 1);
  });

  it("resets the reminder clock on any call, including a re-read", async () => {
    const state = seeded(["a"]);
    const tool = buildTaskListTool({ state });
    for (let i = 0; i < DEFAULT_REMINDER_INTERVAL - 1; i++) taskListReminder(state);
    await call(tool, {});
    assert.equal(state.callsSinceSeen, 0);
    assert.equal(taskListReminder(state), undefined);
  });

  it("reports an unknown id as recoverable text, not a thrown error", async () => {
    const state = seeded(["a"]);
    const tool = buildTaskListTool({ state });
    const result = await call(tool, { done: [42] });
    assert.match(result.content[0]!.text, /no item 42/);
    assert.match(result.content[0]!.text, /1 \[ \] a/);
  });

  it("takes done at the model's word when no verifier is wired (T98 behaviour)", async () => {
    const state = newTaskListState();
    const tool = buildTaskListTool({ state });
    await call(tool, { add: [{ text: "a", verify: "exit 1" }] });
    await call(tool, { done: [1] });
    assert.equal(state.items[0]!.status, "done");
  });
});

describe("the gate, wired into the tool (T100)", () => {
  const call = async (tool: ReturnType<typeof buildTaskListTool>, params: unknown) =>
    (await (tool as unknown as {
      execute: (id: string, p: unknown) => Promise<{ content: Array<{ text: string }>; details?: Record<string, unknown> }>;
    }).execute("call-1", params));

  it("refuses done when the item's verify command fails, and leaves the item open", async () => {
    const state = newTaskListState();
    const tool = buildTaskListTool({
      state,
      verifier: async () => ({ ok: false, exitCode: 1, output: "2 tests failed" }),
    });
    await call(tool, { add: [{ text: "make it pass", verify: "npm test" }] });
    const result = await call(tool, { done: [1] });
    assert.equal(state.items[0]!.status, "pending");
    assert.equal(state.gateRefusals, 1);
    assert.match(result.content[0]!.text, /not marked done/);
    assert.match(result.content[0]!.text, /2 tests failed/);
  });

  it("allows done when the command passes, and records the verdict on the item", async () => {
    const state = newTaskListState();
    const tool = buildTaskListTool({
      state,
      verifier: async () => ({ ok: true, exitCode: 0, output: "" }),
    });
    await call(tool, { add: [{ text: "make it pass", verify: "npm test" }] });
    await call(tool, { done: [1] });
    assert.equal(state.items[0]!.status, "done");
    assert.equal(state.items[0]!.verified?.ok, true);
    assert.equal(state.gateRefusals, 0);
  });

  it("never runs a command for an item that has none", async () => {
    const state = newTaskListState();
    let runs = 0;
    const tool = buildTaskListTool({
      state,
      verifier: async () => {
        runs += 1;
        return { ok: false, exitCode: 1, output: "" };
      },
    });
    await call(tool, { add: [{ text: "no command here" }] });
    await call(tool, { done: [1] });
    assert.equal(runs, 0);
    assert.equal(state.items[0]!.status, "done");
  });

  it("rejects a bad id before running any verify command (D10)", async () => {
    const state = newTaskListState();
    let runs = 0;
    const tool = buildTaskListTool({
      state,
      verifier: async () => {
        runs += 1;
        return { ok: true, exitCode: 0, output: "" };
      },
    });
    await call(tool, { add: [{ text: "make it pass", verify: "npm test" }] });
    const result = await call(tool, { done: [1, 99] });
    assert.equal(runs, 0, "the good item's command must not run on a call that is rejected");
    assert.equal(state.items[0]!.verified, undefined, "nothing may be stamped verified by a rejected call");
    assert.equal(state.items[0]!.status, "pending");
    assert.match(result.content[0]!.text, /no item 99/);
  });

  it("says that the rest of a refused call was not applied (D10)", async () => {
    const state = newTaskListState();
    const tool = buildTaskListTool({
      state,
      verifier: async () => ({ ok: false, exitCode: 1, output: "failed" }),
    });
    await call(tool, { add: [{ text: "make it pass", verify: "npm test" }] });
    const result = await call(tool, { done: [1], add: [{ text: "next step" }] });
    assert.equal(state.items.length, 1);
    assert.match(result.content[0]!.text, /nothing else in this call was applied/i);
  });
});

describe("the schema tax, recorded at the moment the tool is added (rule 3)", () => {
  it("prices the todo tool rather than making the toolset NULL", () => {
    const withTodo = measureToolset(["read", "bash", "edit", "write", "todo"]);
    assert.equal(withTodo.complete, true, "an unpriced tool makes the whole measurement NULL");
    const without = measureToolset(["read", "bash", "edit", "write"]);
    const delta = (withTodo.tokens ?? 0) - (without.tokens ?? 0);
    // Not an assertion about a specific number — the catalog owns that. It
    // asserts the tax is real and small next to the tools already admitted,
    // which is the claim §2.2 makes about it.
    assert.ok(delta > 0, "the tool has to cost something; a zero delta means it was not measured");
    assert.ok(delta < (without.tokens ?? 0), "one list tool must not cost more than the whole worker four");
  });

  it("keeps the catalog's wire description identical to the tool's own", () => {
    const tool = buildTaskListTool({ state: newTaskListState() }) as unknown as { description: string };
    assert.equal(TOOL_CATALOG.todo!.description, tool.description);
  });
});

// ---------------------------------------------------------------------------
// P10.6 (ticket 20, D7): what the contract review closed.
// ---------------------------------------------------------------------------

describe("P10.6 D7: the todo contract", () => {
  const call = async (tool: ReturnType<typeof buildTaskListTool>, params: unknown) =>
    (await (tool as unknown as {
      execute: (id: string, p: unknown) => Promise<{
        content: Array<{ text: string }>;
        isError?: boolean;
        details?: Record<string, unknown>;
      }>;
    }).execute("call-1", params));

  it("marks a refused call isError, so a caller can tell a refusal from an update", async () => {
    const state = seeded(["a"]);
    const result = await call(buildTaskListTool({ state }), { done: [42] });
    assert.equal(result.isError, true);
    assert.match(result.details?.error as string, /no item 42/);
    assert.equal(state.items[0]!.status, "pending", "the mutation is still discarded");
  });

  it("marks a gate refusal isError too — it is the most important no this tool says", async () => {
    const state = newTaskListState();
    const tool = buildTaskListTool({ state, verifier: async () => ({ ok: false, exitCode: 1, output: "failed" }) });
    await call(tool, { add: [{ text: "make it pass", verify: "npm test" }] });
    const refused = await call(tool, { done: [1] });
    assert.equal(refused.isError, true);
    assert.equal(refused.details?.gate, "refused");
    assert.equal(state.items[0]!.status, "pending");
  });

  it("reports the ids that closed on this call", async () => {
    const state = seeded(["a", "b", "c"]);
    const tool = buildTaskListTool({ state });
    const first = await call(tool, { done: [1, 3] });
    assert.deepEqual(first.details?.completed, [1, 3]);
    // Already-done ids are not reported a second time: nothing closed.
    const again = await call(tool, { done: [1] });
    assert.deepEqual(again.details?.completed, []);
    assert.equal(again.isError, undefined);
  });

  it("records every deliberate difference in the module comment rather than keeping it silent", () => {
    const source = readFileSync(join(here, "task-list.ts"), "utf8");
    const section = source.slice(source.indexOf("WHAT DIFFERS DELIBERATELY"));
    assert.ok(section.length > 1000, "the comparison section must actually be there");
    // Each name below is a feature this tool deliberately does not have. A future
    // edit that adds one, or drops the reason for not having it, fails here.
    for (const difference of ["block", "rm", "init", "phase", "verify"]) {
      assert.ok(section.includes(difference), `the comparison must account for ${difference}`);
    }
  });

  it("is still called todo on the wire", () => {
    assert.equal(TASK_LIST_TOOL_NAME, "todo");
    assert.equal((buildTaskListTool({ state: newTaskListState() }) as unknown as { name: string }).name, "todo");
  });
});
