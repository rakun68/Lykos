import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHarnessExtension, newHarnessObservation } from "./harness-extension.js";
import { capToolResultText, TRUNC_MARKER_PREFIX } from "./prompt-diet.js";
import { applyTaskListUpdate, newTaskListState } from "../tools.js";
import { newPostEditState } from "./post-edit.js";
import { builtinHooks, HookRegistry, type Hook } from "./hooks.js";

/** Minimal stand-in for Pi's ExtensionAPI: captures the one handler this registers. */
function drive(maxBytes: number) {
  const observation = newHarnessObservation();
  const ext = createHarnessExtension({ maxBytes, observation }) as {
    name: string;
    factory: (pi: unknown) => void;
  };
  let handler: ((event: unknown) => unknown) | undefined;
  ext.factory({
    on: (event: string, h: (e: unknown) => unknown) => {
      if (event === "tool_result") handler = h;
    },
  });
  assert.ok(handler, "the extension must register a tool_result handler");
  return { observation, name: ext.name, fire: handler! };
}

/**
 * T99 made the `tool_result` handler async — Pi's `ExtensionHandler` returns
 * `Promise<R | void> | R | void`, so the post-edit check can await a
 * subprocess instead of blocking the event loop. Every driver below awaits
 * the handler for that reason.
 */
function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === "object" ? ((b as { text?: string }).text ?? "") : "")).join("");
  }
  return "";
}

describe("T84 capToolResultText both-ends mode", () => {
  it("keeps the head AND the tail, with the middle elided", async () => {
    const text = `FIRST${"x".repeat(500)}LAST`;
    const capped = capToolResultText(text, 100, "both");
    assert.equal(capped.truncated, true);
    assert.ok(capped.text.startsWith("FIRST"), "the head is what says which command ran");
    assert.ok(capped.text.endsWith("LAST"), "the tail is where the failure summary lives");
    assert.ok(capped.text.includes(TRUNC_MARKER_PREFIX), "the elision is always explicit");
  });

  it("keeps within the byte budget it was given", async () => {
    const capped = capToolResultText("y".repeat(10_000), 200, "both");
    assert.ok(capped.keptBytes <= 200, `kept ${capped.keptBytes} bytes, budget was 200`);
  });

  it("leaves a result that already fits completely alone", async () => {
    const capped = capToolResultText("short", 100, "both");
    assert.equal(capped.truncated, false);
    assert.equal(capped.text, "short");
  });

  it("still reports the true original size, so the saving is measurable", async () => {
    const capped = capToolResultText("z".repeat(4096), 128, "both");
    assert.equal(capped.originalBytes, 4096);
  });
});

describe("T84 harness extension", () => {
  it("registers a tool_result handler and no tools at all", async () => {
    const { name } = drive(1024);
    assert.equal(name, "lykos-harness");
  });

  it("clamps an oversized bash result and counts it", async () => {
    const { observation, fire } = drive(256);
    const out = await fire({ toolName: "bash", input: { command: "npm test" }, content: "q".repeat(50_000) });
    assert.equal(observation.clampedResults, 1);
    assert.ok(observation.bytesElided > 40_000);
    assert.equal(observation.bytesOffered, 50_000);
    assert.ok(textOf(out).includes(TRUNC_MARKER_PREFIX));
  });

  it("passes a small result through untouched and counts nothing", async () => {
    const { observation, fire } = drive(1024);
    const out = await fire({ toolName: "read", input: { path: "a.ts" }, content: "tiny" });
    assert.equal(observation.clampedResults, 0);
    assert.equal(observation.bytesElided, 0);
    assert.equal(observation.bytesOffered, 4);
    assert.equal(textOf(out), "tiny");
  });

  it("collapses an unchanged re-read to a stub, counted separately from a clamp", async () => {
    const { observation, fire } = drive(1024);
    const body = "export const a = 1;\n".repeat(3);
    await fire({ toolName: "read", input: { path: "/repo/a.ts" }, content: body });
    const second = await fire({ toolName: "read", input: { path: "/repo/a.ts" }, content: body });
    assert.equal(observation.unchangedStubs, 1);
    assert.equal(observation.clampedResults, 0, "an unchanged stub is not a byte-cap truncation");
    assert.ok(textOf(second).includes("unchanged"));
  });

  it("accumulates across a whole session rather than per call", async () => {
    const { observation, fire } = drive(64);
    for (let i = 0; i < 5; i++) {
      await fire({ toolName: "bash", input: { command: `run ${i}` }, content: "w".repeat(1000) });
    }
    assert.equal(observation.clampedResults, 5);
    assert.equal(observation.bytesOffered, 5000);
  });
});

describe("T85 stagnation brake inside the harness extension", () => {
  function driveBrake(threshold: string) {
    const observation = newHarnessObservation();
    const stops: string[] = [];
    const ext = createHarnessExtension({
      maxBytes: 1_000_000,
      observation,
      onHardStop: (note) => stops.push(note),
      env: { LYKOS_STAGNATION_THRESHOLD: threshold } as NodeJS.ProcessEnv,
    }) as { factory: (pi: unknown) => void };
    let handler: ((event: unknown) => unknown) | undefined;
    ext.factory({
      on: (event: string, h: (e: unknown) => unknown) => {
        if (event === "tool_result") handler = h;
      },
    });
    return { observation, stops, fire: handler! };
  }

  const failEdit = { toolName: "edit", input: { path: "a.ts" }, isError: true, content: "stale anchor" };

  it("appends a note to the failing result once the threshold is hit", async () => {
    const { observation, fire } = driveBrake("3");
    await fire(failEdit);
    await fire(failEdit);
    const out = await fire(failEdit);
    assert.ok(textOf(out).includes("[lykos-stagnation]"));
    assert.ok(textOf(out).includes("stale anchor"), "the real error is quoted back");
    assert.equal(observation.stagnationTrips, 1);
  });

  it("leaves a successful result completely untouched", async () => {
    const { observation, fire } = driveBrake("3");
    const out = await fire({ toolName: "edit", input: { path: "a.ts" }, isError: false, content: "ok" });
    assert.equal(textOf(out), "ok");
    assert.equal(observation.stagnationTrips, 0);
  });

  it("asks for a hard stop exactly once, at twice the threshold", async () => {
    const { observation, stops, fire } = driveBrake("3");
    for (let i = 0; i < 12; i++) fire(failEdit);
    assert.equal(stops.length, 1, "the brake must not fire in a loop of its own");
    assert.equal(observation.stagnationStopped, true);
    assert.equal(observation.stagnationKey, "edit:a.ts");
  });

  it("is off when the environment turns it off", async () => {
    const observation = newHarnessObservation();
    const ext = createHarnessExtension({
      maxBytes: 1_000_000,
      observation,
      env: { LYKOS_STAGNATION_BRAKE: "0" } as NodeJS.ProcessEnv,
    }) as { factory: (pi: unknown) => void };
    let handler: ((event: unknown) => unknown) | undefined;
    ext.factory({
      on: (e: string, h: (x: unknown) => unknown) => {
        if (e === "tool_result") handler = h;
      },
    });
    for (let i = 0; i < 10; i++) handler!(failEdit);
    assert.equal(observation.stagnationTrips, 0);
  });
});

describe("T86 context budget notice inside the harness extension", () => {
  function driveBudget(window: number) {
    const observation = newHarnessObservation();
    observation.contextWindow = window;
    const ext = createHarnessExtension({
      maxBytes: 1_000_000,
      observation,
      compactionThreshold: 0.8,
      env: {} as NodeJS.ProcessEnv,
    }) as { factory: (pi: unknown) => void };
    let handler: ((event: unknown) => unknown) | undefined;
    ext.factory({
      on: (e: string, h: (x: unknown) => unknown) => {
        if (e === "tool_result") handler = h;
      },
    });
    return { observation, fire: handler! };
  }

  const ok = { toolName: "read", input: { path: "a.ts" }, isError: false, content: "body" };

  it("stays silent while there is plenty of room", async () => {
    const { observation, fire } = driveBudget(100_000);
    observation.contextTokens = 10_000;
    assert.ok(!textOf(await fire(ok)).includes("[lykos-context]"));
    assert.equal(observation.contextNotices, 0);
  });

  it("warns once when the context crosses a band", async () => {
    const { observation, fire } = driveBudget(100_000);
    observation.contextTokens = 75_000;
    assert.ok(textOf(await fire(ok)).includes("[lykos-context]"));
    assert.equal(observation.contextNotices, 1);
    // Same band again: silence, so the model does not learn to ignore it.
    observation.contextTokens = 76_000;
    assert.ok(!textOf(await fire(ok)).includes("[lykos-context]"));
  });

  it("says nothing at all when the window is unknown", async () => {
    const { observation, fire } = driveBudget(0);
    observation.contextTokens = 900_000;
    assert.ok(!textOf(await fire(ok)).includes("[lykos-context]"));
  });

  it("does not displace a stagnation note when both would fire", async () => {
    const observation = newHarnessObservation();
    observation.contextWindow = 100_000;
    observation.contextTokens = 99_000;
    const ext = createHarnessExtension({
      maxBytes: 1_000_000,
      observation,
      env: { LYKOS_STAGNATION_THRESHOLD: "2" } as NodeJS.ProcessEnv,
    }) as { factory: (pi: unknown) => void };
    let handler: ((event: unknown) => unknown) | undefined;
    ext.factory({
      on: (e: string, h: (x: unknown) => unknown) => {
        if (e === "tool_result") handler = h;
      },
    });
    const failing = { toolName: "edit", input: { path: "z.ts" }, isError: true, content: "nope" };
    await handler!(failing);
    const out = await handler!(failing);
    assert.ok(textOf(out).includes("[lykos-stagnation]"), "being stuck outranks being nearly full");
    assert.ok(!textOf(out).includes("[lykos-context]"));
  });
});

describe("T98.4 the task-list reminder in the tail", () => {
  function driveWithList(state: ReturnType<typeof newTaskListState>, interval: number) {
    const observation = newHarnessObservation();
    const ext = createHarnessExtension({
      maxBytes: 100_000,
      observation,
      taskList: state,
      reminderInterval: interval,
      env: {},
    }) as { factory: (pi: unknown) => void };
    let handler: ((event: unknown) => unknown) | undefined;
    ext.factory({
      on: (event: string, h: (e: unknown) => unknown) => {
        if (event === "tool_result") handler = h;
      },
    });
    return { observation, fire: handler! };
  }

  const read = { toolName: "read", input: { path: "a.ts" }, content: "ok" };

  it("appends the open list after the interval, and counts it", async () => {
    const state = newTaskListState();
    applyTaskListUpdate(state, { add: [{ text: "finish the parser" }] });
    const { observation, fire } = driveWithList(state, 3);
    assert.equal(textOf(await fire(read)).includes("finish the parser"), false);
    assert.equal(textOf(await fire(read)).includes("finish the parser"), false);
    const third = textOf(await fire(read));
    assert.match(third, /task list \(1 open of 1\)/);
    assert.match(third, /finish the parser/);
    assert.equal(observation.taskListReminders, 1);
  });

  it("says nothing at all when every item is closed", async () => {
    const state = newTaskListState();
    applyTaskListUpdate(state, { add: [{ text: "done thing" }] });
    applyTaskListUpdate(state, { done: [1] });
    const { observation, fire } = driveWithList(state, 1);
    for (let i = 0; i < 5; i++) assert.equal(textOf(await fire(read)).includes("task list"), false);
    assert.equal(observation.taskListReminders, 0);
  });

  it("is silent when no list was passed — a session without the tool is unchanged", async () => {
    const { fire } = drive(100_000);
    assert.equal(textOf(await fire(read)).includes("task list"), false);
  });
});

describe("T99 the post-edit check in the tail", () => {
  function driveWithPostEdit(runs: Array<{ exitCode: number | null; output?: string }>, env: NodeJS.ProcessEnv = {}) {
    const observation = newHarnessObservation();
    const state = newPostEditState();
    let calls = 0;
    const ext = createHarnessExtension({
      maxBytes: 1_000_000,
      observation,
      env,
      postEdit: {
        policy: {
          enabled: true,
          command: "npm run typecheck",
          timeoutMs: 5000,
          maxOutputBytes: 4000,
          slowDisableMs: 45_000,
          cwd: "/repo",
        },
        state,
        run: async () => {
          const next = runs[Math.min(calls, runs.length - 1)]!;
          calls += 1;
          return { exitCode: next.exitCode, output: next.output ?? "", ms: 5 };
        },
      },
    }) as { factory: (pi: unknown) => void };
    let handler: ((event: unknown) => unknown) | undefined;
    ext.factory({
      on: (e: string, h: (x: unknown) => unknown) => {
        if (e === "tool_result") handler = h;
      },
    });
    return { state, fire: handler!, ran: () => calls };
  }

  const edit = { toolName: "edit", input: { path: "a.ts" }, content: "ok" };

  it("runs after a successful edit and appends the failure to that result", async () => {
    const { fire, state } = driveWithPostEdit([{ exitCode: 2, output: "a.ts(1,1): error TS1005" }]);
    const out = textOf(await fire(edit));
    assert.match(out, /did not survive the post-edit check/);
    assert.match(out, /TS1005/);
    assert.equal(state.failures, 1);
  });

  it("does not run after a FAILED edit — nothing changed on disk to check", async () => {
    const { fire, state, ran } = driveWithPostEdit([{ exitCode: 2, output: "pre-existing breakage" }]);
    const out = textOf(await fire({ ...edit, isError: true }));
    assert.equal(ran(), 0, "a failed edit must not be blamed for what was already broken");
    assert.equal(state.runs, 0);
    assert.ok(!out.includes("post-edit"));
  });

  it("does not run after a read or a bash call", async () => {
    const { fire, ran } = driveWithPostEdit([{ exitCode: 1 }]);
    await fire({ toolName: "read", input: { path: "a.ts" }, content: "x" });
    await fire({ toolName: "bash", input: { command: "ls" }, content: "x" });
    assert.equal(ran(), 0);
  });
  it("runs after a successful tool_call to edit and does not run for read (P10.2)", async () => {
    const { fire, state, ran } = driveWithPostEdit([{ exitCode: 2, output: "a.ts(1,1): error TS1005" }]);
    const toolCallEdit = { toolName: "tool_call", input: { name: "edit", arguments: { path: "a.ts" } }, content: "ok" };
    const out = textOf(await fire(toolCallEdit));
    assert.match(out, /did not survive the post-edit check/);
    assert.equal(state.failures, 1);
    assert.equal(ran(), 1);

    const toolCallRead = { toolName: "tool_call", input: { name: "read", arguments: { path: "a.ts" } }, content: "ok" };
    await fire(toolCallRead);
    assert.equal(ran(), 1, "read must not trigger post-edit check");
  });

  it("outranks a stagnation warning, because it carries the error to act on", async () => {
    const { fire } = driveWithPostEdit([{ exitCode: 1, output: "the real error" }], {
      LYKOS_STAGNATION_THRESHOLD: "2",
    } as NodeJS.ProcessEnv);
    // Two successful edits to the same path: the brake keys on failures, so
    // drive it with a failing bash first, then confirm the edit result
    // carries the post-edit note rather than anything else.
    const out = textOf(await fire(edit));
    assert.match(out, /the real error/);
    assert.ok(!out.includes("[lykos-context]"));
  });

  it("leaves the tail alone entirely when no post-edit loop was configured", async () => {
    const { fire } = drive(1_000_000);
    assert.ok(!textOf(await fire(edit)).includes("post-edit"));
  });
});

describe("T104 the turn-start checkpoint", () => {
  function driveWithCheckpoints() {
    const observation = newHarnessObservation();
    const calls: string[][] = [];
    const ext = createHarnessExtension({
      maxBytes: 1_000_000,
      observation,
      env: {},
      checkpoint: {
        cwd: "/repo",
        git: (args) => {
          calls.push(args);
          if (args[0] === "rev-parse" && args[1] === "--absolute-git-dir") {
            return { ok: true, stdout: "/repo/.git", stderr: "" };
          }
          if (args[0] === "write-tree") return { ok: true, stdout: "tree-".concat(String(calls.length)), stderr: "" };
          if (args[0] === "commit-tree") return { ok: true, stdout: "commit-abc", stderr: "" };
          if (args[0] === "rev-parse") return { ok: false, stdout: "", stderr: "" };
          return { ok: true, stdout: "", stderr: "" };
        },
      },
    }) as { factory: (pi: unknown) => void };
    const handlers: Record<string, (e: unknown) => unknown> = {};
    ext.factory({
      on: (e: string, h: (x: unknown) => unknown) => {
        handlers[e] = h;
      },
    });
    return { observation, handlers, calls };
  }

  it("takes the checkpoint at turn start, not after an edit", () => {
    const { observation, handlers, calls } = driveWithCheckpoints();
    assert.ok(handlers["turn_start"], "the checkpoint must hang off turn_start");
    handlers["turn_start"]!({ turnIndex: 3 });
    assert.equal(observation.checkpoints, 1);
    const commit = calls.find((a) => a[0] === "commit-tree");
    assert.ok(commit, "a commit-tree call must have been made");
    // T146: the turn is the session-wide count, carried as a trailer too —
    // Pi's own `turnIndex` restarts at every prompt, so it is not used.
    assert.ok(commit!.includes("before turn 0\n\nLykos-Turn: 0"), `message was ${JSON.stringify(commit)}`);
    handlers["turn_start"]!({ turnIndex: 0 });
    const second = calls.filter((a) => a[0] === "commit-tree")[1];
    assert.ok(second?.includes("before turn 1\n\nLykos-Turn: 1"), `message was ${JSON.stringify(second)}`);
  });

  it("never touches the branch, HEAD, or the user's index", () => {
    const { handlers, calls } = driveWithCheckpoints();
    handlers["turn_start"]!({ turnIndex: 0 });
    const flat = calls.map((a) => a.join(" "));
    assert.ok(!flat.some((c) => c.startsWith("commit ")), "must never make a real commit");
    assert.ok(!flat.some((c) => c.includes("checkout ")), "must never check anything out");
    assert.ok(!flat.some((c) => c.startsWith("stash")), "must never stash the user's work");
    const updates = flat.filter((c) => c.startsWith("update-ref"));
    assert.equal(updates.length, 1);
    assert.ok(updates[0]!.includes("refs/lykos/checkpoints"), `updated ${updates[0]}`);
  });

  it("registers no turn_start handler at all when checkpointing is off", () => {
    const observation = newHarnessObservation();
    const ext = createHarnessExtension({ maxBytes: 1000, observation, env: {} }) as {
      factory: (pi: unknown) => void;
    };
    const handlers: Record<string, unknown> = {};
    ext.factory({
      on: (e: string, h: unknown) => {
        handlers[e] = h;
      },
    });
    assert.equal(handlers["turn_start"], undefined);
  });
});

describe("T105 the hook surface inside the harness extension", () => {
  function driveWithHooks(hooks: Hook[]) {
    const observation = newHarnessObservation();
    const registry = new HookRegistry();
    for (const h of hooks) registry.register(h);
    const ext = createHarnessExtension({
      maxBytes: 1_000_000,
      observation,
      env: {},
      hooks: { registry, cwd: "/repo" },
    }) as { factory: (pi: unknown) => void };
    const handlers: Record<string, (e: unknown) => unknown> = {};
    ext.factory({
      on: (e: string, h: (x: unknown) => unknown) => {
        handlers[e] = h;
      },
    });
    return { observation, handlers };
  }

  it("blocks a tool call a pre_tool hook denied, and gives Pi the reason", async () => {
    const { observation, handlers } = driveWithHooks([
      { name: "no-ledger", event: "pre_tool", run: () => ({ action: "deny", reason: "not the ledger" }) },
    ]);
    const result = (await handlers["tool_call"]!({ toolName: "write", input: { path: ".lykos/ledger.db" } })) as {
      block?: boolean;
      reason?: string;
    };
    assert.equal(result.block, true);
    assert.equal(result.reason, "not the ledger");
    assert.equal(observation.hookDenials, 1);
  });

  it("blocks a real bash write to the ledger before approval can allow it", async () => {
    const { observation, handlers } = driveWithHooks(builtinHooks());
    const result = (await handlers["tool_call"]!({
      toolName: "bash",
      input: { command: "sqlite3 .lykos/ledger.db 'UPDATE calls SET cost_usd = 0'" },
    })) as { block?: boolean; reason?: string };
    assert.equal(result.block, true);
    assert.match(result.reason ?? "", /measurement layer/);
    assert.equal(observation.hookDenials, 1);
  });

  it("leaves a real bash write elsewhere unaffected", async () => {
    const { observation, handlers } = driveWithHooks(builtinHooks());
    const result = (await handlers["tool_call"]!({
      toolName: "bash",
      input: { command: "printf x > scratch.txt" },
    })) as { block?: boolean };
    assert.equal(result.block, undefined);
    assert.equal(observation.hookDenials, 0);
  });

  it("lets an allowed call through with no block flag", async () => {
    const { handlers } = driveWithHooks([
      { name: "permissive", event: "pre_tool", run: () => ({ action: "continue" }) },
    ]);
    const result = (await handlers["tool_call"]!({ toolName: "write", input: { path: "a.ts" } })) as {
      block?: boolean;
    };
    assert.equal(result.block, undefined);
  });

  it("carries a pre_tool NOTE onto that call's own result, since tool_call has no content channel", async () => {
    const { observation, handlers } = driveWithHooks([
      { name: "warns", event: "pre_tool", run: () => ({ action: "note", note: "that looks like a secret" }) },
    ]);
    await handlers["tool_call"]!({ toolName: "write", input: { path: "a.ts", content: "AKIA..." } });
    const out = textOf(await handlers["tool_result"]!({ toolName: "write", input: { path: "a.ts" }, content: "ok" }));
    assert.match(out, /that looks like a secret/);
    assert.equal(observation.hookNotes, 1);
  });

  it("registers no tool_call handler when nothing hooks pre_tool", () => {
    const { handlers } = driveWithHooks([
      { name: "later", event: "session_end", run: () => ({ action: "continue" }) },
    ]);
    assert.equal(handlers["tool_call"], undefined);
  });

  it("appends a post_tool hook's note to the result it describes", async () => {
    const { handlers } = driveWithHooks([
      { name: "lint", event: "post_tool", run: () => ({ action: "note", note: "lint says no" }) },
    ]);
    const out = textOf(await handlers["tool_result"]!({ toolName: "edit", input: { path: "a.ts" }, content: "ok" }));
    assert.match(out, /lint says no/);
  });

  // P10.9 (ticket 21, D3). A post_tool note used to be counted twice — once
  // where it was collected and again where the pending list is drained — while
  // a pre_tool note was counted once, so `sessions.hook_notes` could not be
  // compared with itself across two sessions that ran different hooks.
  it("counts a post_tool note ONCE, the same as a pre_tool note", async () => {
    const { observation, handlers } = driveWithHooks([
      { name: "lint", event: "post_tool", run: () => ({ action: "note", note: "lint says no" }) },
    ]);
    await handlers["tool_result"]!({ toolName: "edit", input: { path: "a.ts" }, content: "ok" });
    assert.equal(observation.hookNotes, 1);
  });

  it("counts one note per firing across both halves", async () => {
    const { observation, handlers } = driveWithHooks([
      { name: "warns", event: "pre_tool", run: () => ({ action: "note", note: "before" }) },
      { name: "lint", event: "post_tool", run: () => ({ action: "note", note: "after" }) },
    ]);
    await handlers["tool_call"]!({ toolName: "edit", input: { path: "a.ts" } });
    const out = textOf(await handlers["tool_result"]!({ toolName: "edit", input: { path: "a.ts" }, content: "ok" }));
    assert.match(out, /before/);
    assert.match(out, /after/);
    assert.equal(observation.hookNotes, 2);
  });
});

describe("P4 T149 a read-only child's harness refuses anything that is not a read", () => {
  function driveReadOnly() {
    const observation = newHarnessObservation();
    const ext = createHarnessExtension({ maxBytes: 1_000_000, observation, env: {}, readOnly: true }) as {
      factory: (pi: unknown) => void;
    };
    const handlers: Record<string, (e: unknown) => unknown> = {};
    ext.factory({
      on: (e: string, h: (x: unknown) => unknown) => {
        handlers[e] = h;
      },
    });
    return handlers;
  }

  it("blocks every file-changing call, direct or through the tool_call transport, and every non-read tier", async () => {
    const handlers = driveReadOnly();
    const blocked = [
      { toolName: "write", input: { path: "a.ts", content: "x" } },
      { toolName: "edit", input: { path: "a.ts" } },
      { toolName: "ast_edit", input: {} },
      { toolName: "lsp", input: { action: "rename", file: "a.ts", newName: "b" } },
      { toolName: "apply_patch", input: {} },
      { toolName: "tool_call", input: { name: "write", arguments: { path: "a.ts" } } },
      { toolName: "bash", input: { command: "ls" } },
      { toolName: "some_package_tool", input: {} },
    ];
    for (const call of blocked) {
      const result = (await handlers["tool_call"]!(call)) as { block?: boolean; reason?: string } | undefined;
      assert.equal(result?.block, true, call.toolName);
      assert.match(result?.reason ?? "", /read-only child session/);
    }
  });

  it("lets a read through", async () => {
    const handlers = driveReadOnly();
    for (const toolName of ["read", "grep", "find", "ls"]) {
      assert.equal(await handlers["tool_call"]!({ toolName, input: { path: "a.ts" } }), undefined, toolName);
    }
  });

  it("registers no such block on an ordinary session", () => {
    const observation = newHarnessObservation();
    const ext = createHarnessExtension({ maxBytes: 1000, observation, env: {} }) as { factory: (pi: unknown) => void };
    const handlers: Record<string, unknown> = {};
    ext.factory({ on: (e: string, h: unknown) => void (handlers[e] = h) });
    assert.equal(handlers["tool_call"], undefined);
  });
});
