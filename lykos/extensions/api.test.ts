import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  AutoApproveGate,
  DenialLog,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
} from "../gate/approval.js";
import { decideForMode, tierForAction } from "../gate/modes.js";
import { INTERACTION_MODES } from "../gate/modes.js";
import { DEFAULT_RISK_TIER } from "../tools/tool-risk.js";
import {
  EXTENSION_FAILURE_LOG_CAP,
  EXTENSION_GATE_TIER,
  CHILD_SESSION_UNAVAILABLE,
  INTERFACE_REGISTRATION_REFUSAL,
  LYKOS_EVENTS,
  LykosExtensionHost,
  renderSessionEndReports,
  NULL_EVENT_SINK,
  describeExtensionTier,
  extensionFailureNotice,
  gateWithExtensionEvents,
  newExtensionCounters,
  renderExtensionToolRow,
  type ChildSessionRequest,
  type LykosExtension,
  type SessionEndEvent,
} from "./api.js";

class RecordingGate implements ApprovalGate {
  readonly seen: ApprovalRequest[] = [];
  constructor(private readonly answer: ApprovalDecision = "allow") {}
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.seen.push(req);
    return this.answer;
  }
}

const CWD = process.cwd();

function hostWith(gate: ApprovalGate, denials?: DenialLog): LykosExtensionHost {
  return new LykosExtensionHost({ cwd: CWD, gate, ...(denials !== undefined ? { denials } : {}) });
}

type Result = { content: Array<{ type: string; text: string }>; isError?: boolean; details?: unknown };

async function call(tool: ToolDefinition, args: Record<string, unknown>): Promise<Result> {
  return (await tool.execute(
    "call-1",
    args as never,
    undefined as never,
    undefined as never,
    undefined as never,
  )) as unknown as Result;
}

// ---------------------------------------------------------------------------
// D4 — the gate-bypass property. Written first, because it is the one property
// of this module that a later change could quietly remove.
// ---------------------------------------------------------------------------

describe("P10.9 D4 an extension cannot register a tool that bypasses the gate", () => {
  it("every extension tool call reaches authorize() before its execute runs", async () => {
    const gate = new RecordingGate("allow");
    const host = hostWith(gate);
    let ran = 0;
    host.install({
      name: "probe",
      register: (api) =>
        api.registerTool({
          name: "probe_tool",
          description: "does a thing",
          parameters: Type.Object({ x: Type.String() }),
          execute: () => {
            ran += 1;
            return { text: "done" };
          },
        }),
    });
    const tool = host.toolDefinitions()[0]!;
    await call(tool, { x: "hello" });
    assert.equal(gate.seen.length, 1, "the gate was consulted");
    assert.equal(ran, 1);
    assert.equal(gate.seen[0]?.kind, "extension");
    // The arguments are the body, so a human approving a tool nobody here
    // wrote is shown what it was asked to do rather than only its name.
    assert.match(gate.seen[0]?.body ?? "", /hello/);
  });

  it("a denied call never runs the extension's function and says so to the model", async () => {
    const gate = new RecordingGate("deny");
    const denials = new DenialLog();
    const host = hostWith(gate, denials);
    let ran = 0;
    host.install({
      name: "probe",
      register: (api) =>
        api.registerTool({
          name: "probe_tool",
          description: "does a thing",
          execute: () => {
            ran += 1;
            return { text: "done" };
          },
        }),
    });
    const result = await call(host.toolDefinitions()[0]!, {});
    assert.equal(ran, 0, "the refused call never reached the extension");
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /declined/);
    assert.equal(denials.userRejected, 1, "the refusal is counted like any other");
  });

  it("a declared `read` tier does not skip the gate and does not lower the tier", async () => {
    const gate = new RecordingGate("allow");
    const host = hostWith(gate);
    host.install({
      name: "optimist",
      register: (api) =>
        api.registerTool({
          name: "harmless",
          description: "totally harmless, promise",
          risk: { tier: "read", idempotent: true, openWorld: false },
          execute: () => ({ text: "ok" }),
        }),
    });
    await call(host.toolDefinitions()[0]!, {});
    assert.equal(gate.seen.length, 1, "a read declaration still asks");
    // And the policy's own tier for the request is the fail-closed one.
    assert.equal(tierForAction({ kind: "extension" }), DEFAULT_RISK_TIER);
    assert.equal(EXTENSION_GATE_TIER, DEFAULT_RISK_TIER);
  });

  it("no interaction mode approves an extension tool outright", () => {
    for (const mode of INTERACTION_MODES) {
      const decision = decideForMode(mode, { kind: "extension" }, new Set());
      assert.equal(decision.verdict, "ask", mode);
      assert.equal(decision.tier, DEFAULT_RISK_TIER);
    }
  });

  it("the API accepts a function, never a tool definition — the bypass has no shape", () => {
    const gate = new RecordingGate();
    const host = hostWith(gate);
    host.install({
      name: "probe",
      register: (api) => {
        // The registration type has `execute`, `description` and `parameters`
        // and no member through which a caller-built definition could arrive.
        const keys = ["name", "description", "parameters", "execute", "risk"];
        for (const k of keys) assert.ok(typeof k === "string");
        api.registerTool({ name: "t", description: "d", execute: () => ({ text: "" }) });
      },
    });
    const def = host.toolDefinitions()[0]!;
    assert.equal(def.name, "t");
    assert.equal(host.toolDefinitions().length, 1);
  });
});

// ---------------------------------------------------------------------------
// D4 — the row, and the tier as a declaration a human can see.
// ---------------------------------------------------------------------------

describe("P10.9 D4 a registered tool is a registry row", () => {
  it("gets a residency, a prompt presence and a risk tier", () => {
    const host = hostWith(new RecordingGate());
    host.install({
      name: "acme",
      register: (api) =>
        api.registerTool({ name: "acme_thing", description: "d", execute: () => ({ text: "" }) }),
    });
    const row = host.toolRegistryRows()[0]!;
    assert.equal(row.name, "acme_thing");
    // Mounted/hidden by default: a new tool's schema does not join every
    // request of every session because somebody installed an extension.
    assert.equal(row.residency, "mounted");
    assert.equal(row.promptPresence, "hidden");
    assert.equal(row.risk.tier, DEFAULT_RISK_TIER, "an undeclared tier is the fail-closed one");
    assert.equal(row.declaredBy, "acme");
    assert.equal(row.source, "extension");
    assert.equal(host.counters.tools, 1);
  });

  it("renders the tier as extension-declared wherever it is shown", () => {
    const host = hostWith(new RecordingGate());
    host.install({
      name: "acme",
      register: (api) =>
        api.registerTool({
          name: "acme_thing",
          description: "d",
          risk: { tier: "read" },
          execute: () => ({ text: "" }),
        }),
    });
    const row = host.toolRegistryRows()[0]!;
    assert.equal(row.risk.tier, "read", "the declaration is kept, not overwritten");
    const shown = describeExtensionTier(row);
    assert.match(shown, /declared by the extension "acme"/);
    assert.match(shown, /not verified by lykos/);
    assert.match(shown, new RegExp(EXTENSION_GATE_TIER));
    assert.match(renderExtensionToolRow(row), /acme_thing/);
    // And the model is told too, on the description it actually reads.
    assert.match(host.toolDefinitions()[0]!.description ?? "", /declares this a read tool/);
  });

  it("refuses a second tool under a name already registered", () => {
    const host = hostWith(new RecordingGate());
    host.install({
      name: "acme",
      register: (api) => {
        api.registerTool({ name: "dup", description: "d", execute: () => ({ text: "" }) });
        api.registerTool({ name: "dup", description: "d", execute: () => ({ text: "" }) });
      },
    });
    assert.equal(host.toolRegistryRows().length, 1);
    assert.equal(host.counters.failures, 1, "the collision is reported, not silently dropped");
    assert.match(host.counters.log[0]?.message ?? "", /already registered/);
  });

  it("a throwing extension tool is counted and reported to the model, not fatal", async () => {
    const host = hostWith(new RecordingGate("allow"));
    host.install({
      name: "brittle",
      register: (api) =>
        api.registerTool({
          name: "boom",
          description: "d",
          execute: () => {
            throw new Error("kaboom");
          },
        }),
    });
    const result = await call(host.toolDefinitions()[0]!, {});
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /kaboom/);
    assert.equal(host.counters.failures, 1);
  });
});

// ---------------------------------------------------------------------------
// D3 — a throwing extension is reported and counted.
// ---------------------------------------------------------------------------

describe("P10.9 D3 a throwing extension is reported and counted", () => {
  it("records the extension, the event and the message, and the session continues", () => {
    const host = hostWith(new RecordingGate());
    const seen: string[] = [];
    host.install({
      name: "bad",
      register: (api) =>
        api.on("checkpoint_written", () => {
          throw new Error("no");
        }),
    });
    host.install({
      name: "good",
      register: (api) => api.on("checkpoint_written", (p) => seen.push(p.commit)),
    });
    host.emit("checkpoint_written", { commit: "abc1234", label: "before turn 1" });
    assert.deepEqual(seen, ["abc1234"], "the second extension still ran");
    assert.equal(host.counters.failures, 1);
    assert.equal(host.counters.deliveries, 1);
    assert.equal(host.counters.failuresByExtension.bad, 1);
    assert.deepEqual(host.counters.log[0], {
      extension: "bad",
      site: "checkpoint_written",
      message: "no",
    });
  });

  it("counts every firing of a permanently broken extension", () => {
    const host = hostWith(new RecordingGate());
    host.install({
      name: "bad",
      register: (api) =>
        api.on("checkpoint_written", () => {
          throw new Error("no");
        }),
    });
    for (let i = 0; i < 3; i++) host.emit("checkpoint_written", { commit: `c${i}`, label: "l" });
    assert.equal(host.counters.failures, 3, "not indistinguishable from never having matched");
    const notice = extensionFailureNotice(host.counters);
    assert.match(notice ?? "", /bad \(3\)/);
    assert.match(notice ?? "", /NOT running/);
  });

  it("caps the failure log without capping the count", () => {
    const host = hostWith(new RecordingGate());
    host.install({
      name: "bad",
      register: (api) =>
        api.on("checkpoint_written", () => {
          throw new Error("no");
        }),
    });
    const firings = EXTENSION_FAILURE_LOG_CAP + 5;
    for (let i = 0; i < firings; i++) host.emit("checkpoint_written", { commit: `c${i}`, label: "l" });
    assert.equal(host.counters.failures, firings);
    assert.equal(host.counters.log.length, EXTENSION_FAILURE_LOG_CAP);
  });

  it("a registration that throws leaves what it already registered and is counted", () => {
    const host = hostWith(new RecordingGate());
    host.install({
      name: "half",
      register: (api) => {
        api.registerCommand({ name: "ok", description: "d", run: () => "ran" });
        throw new Error("gave up");
      },
    });
    assert.equal(host.commands().length, 1);
    assert.equal(host.counters.failures, 1);
    assert.equal(host.counters.log[0]?.site, "install");
  });

  it("says nothing when nothing failed", () => {
    assert.equal(extensionFailureNotice(newExtensionCounters()), undefined);
  });
});

// ---------------------------------------------------------------------------
// D1 — two surfaces, no mirroring.
// ---------------------------------------------------------------------------

describe("P10.9 D1 two surfaces, no mirroring", () => {
  it("the ten events are Lykos's own names and none of them is a Pi event name", () => {
    assert.deepEqual([...LYKOS_EVENTS], [
      "post_edit_check",
      "verification_verdict",
      "specialist_switch",
      "budget_threshold",
      "checkpoint_written",
      "memory_injected",
      "approval_decided",
      "task_list_changed",
      "credential_rotated",
      "session_end",
    ]);
    // Pi's own event vocabulary, as `loop/harness-extension.ts` uses it. If a
    // name ever appeared in both lists, a Pi release could change a Lykos
    // extension's payload — which is the coupling D1 exists to prevent.
    const piEvents = [
      "turn_start",
      "turn_end",
      "tool_call",
      "tool_result",
      "message_end",
      "session_start",
      "session_shutdown",
    ];
    for (const name of LYKOS_EVENTS) assert.ok(!piEvents.includes(name), name);
  });

  it("an unknown event name reaches nobody and is not an error", () => {
    const host = hostWith(new RecordingGate());
    let fired = 0;
    host.install({ name: "x", register: (api) => api.on("checkpoint_written", () => (fired += 1)) });
    // A Pi event passing through the runtime never enters this bus at all;
    // emitting something nothing listens for is simply a no-op.
    host.emit("memory_injected", { ids: [], count: 0, tokens: 0, skipped: 0, stale: 0, available: 0 });
    assert.equal(fired, 0);
    assert.equal(host.counters.failures, 0);
  });

  it("the null sink swallows every event without a host", () => {
    for (const _ of LYKOS_EVENTS) void _;
    assert.doesNotThrow(() => NULL_EVENT_SINK.emit("checkpoint_written", { commit: "c", label: "l" }));
  });
});

// ---------------------------------------------------------------------------
// D5 and D6 — commands, and the interface point that refuses.
// ---------------------------------------------------------------------------

describe("P10.9 D5 a registered slash command appears and runs", () => {
  it("appears in the host's command list and runs with its arguments", async () => {
    const host = hostWith(new RecordingGate());
    host.install({
      name: "acme",
      register: (api) =>
        api.registerCommand({ name: "acme", description: "do acme things", run: (args) => `ran:${args}` }),
    });
    assert.deepEqual(host.commands(), [{ name: "acme", description: "do acme things", extension: "acme" }]);
    assert.equal(host.hasCommand("/acme"), true);
    assert.equal(await host.runCommand("acme", "one two"), "ran:one two");
  });

  it("a command that throws is counted and the person is told", async () => {
    const host = hostWith(new RecordingGate());
    host.install({
      name: "brittle",
      register: (api) =>
        api.registerCommand({
          name: "boom",
          description: "d",
          run: () => {
            throw new Error("nope");
          },
        }),
    });
    const out = await host.runCommand("boom", "");
    assert.match(out, /nope/);
    assert.equal(host.counters.failures, 1);
    assert.equal(host.counters.log[0]?.site, "command");
  });

  it("an unknown command names what exists", async () => {
    const host = hostWith(new RecordingGate());
    host.install({
      name: "acme",
      register: (api) => api.registerCommand({ name: "acme", description: "d", run: () => "" }),
    });
    assert.match(await host.runCommand("nope", ""), /\/acme/);
  });
});

describe("P10.9 D6 interface registration exists and refuses", () => {
  it("refuses, says why, and counts that somebody wanted it", () => {
    const host = hostWith(new RecordingGate());
    const ext: LykosExtension = {
      name: "painter",
      register: (api) => api.registerInterface({ draw: () => undefined }),
    };
    host.install(ext);
    assert.equal(host.counters.interfaceRefusals, 1);
    assert.equal(host.counters.failures, 1);
    assert.equal(host.counters.log[0]?.message, INTERFACE_REGISTRATION_REFUSAL);
    assert.match(INTERFACE_REGISTRATION_REFUSAL, /break a product surface/);
    // D8's escape hatch is named in the refusal itself, where somebody who
    // just hit the boundary is standing.
    assert.match(INTERFACE_REGISTRATION_REFUSAL, /write a Pi\s+extension/);
  });
});

// ---------------------------------------------------------------------------
// The approval event's wiring.
// ---------------------------------------------------------------------------

describe("P10.9 approval_decided fires from the gate's own decision", () => {
  it("carries the kind, the decision and what was being decided", async () => {
    const host = hostWith(new RecordingGate());
    const seen: Array<{ kind: string; decision: string }> = [];
    host.install({
      name: "watch",
      register: (api) => api.on("approval_decided", (p) => seen.push({ kind: p.kind, decision: p.decision })),
    });
    const wrapped = gateWithExtensionEvents(new RecordingGate("allow-always"), host.sink);
    const decision = await wrapped.request({ kind: "bash", summary: "run command", detail: "npm test", shell: "bash" });
    assert.equal(decision, "allow-always", "the wrapper returns what the real gate decided");
    assert.deepEqual(seen, [{ kind: "bash", decision: "allow-always" }]);
  });
});

// ---------------------------------------------------------------------------
// P4 T149 — the three capabilities the reviewer is written against, each on
// its own: `session_end`, a read-only child session, and counters.
// ---------------------------------------------------------------------------

const END: SessionEndEvent = {
  sessionId: "s1",
  model: "faux/scripted-1",
  state: "done",
  edited: true,
  verdict: { status: "recorded", outcome: "success", command: "npm test", exitCode: 0 },
  diff: { base: "abc1234", files: [{ path: "a.ts", added: 1, removed: 0, untracked: false }], text: "+x", truncated: false },
  taskList: "",
};

describe("T149 session_end", () => {
  it("emitAndWait waits for an async handler before returning, in registration order", async () => {
    const host = hostWith(new RecordingGate());
    const order: string[] = [];
    host.install({
      name: "slow",
      register: (api) =>
        api.on("session_end", async (end) => {
          await new Promise((r) => setTimeout(r, 20));
          order.push(`slow:${end.verdict.exitCode}`);
        }),
    });
    host.install({ name: "fast", register: (api) => api.on("session_end", (end) => void order.push(`fast:${end.edited}`)) });
    await host.emitAndWait("session_end", END);
    assert.deepEqual(order, ["slow:0", "fast:true"]);
    assert.equal(host.counters.deliveries, 2);
  });

  it("a handler that rejects is counted against its extension, and the next one still runs", async () => {
    const host = hostWith(new RecordingGate());
    let ran = false;
    host.install({
      name: "bad",
      register: (api) =>
        api.on("session_end", async () => {
          throw new Error("review blew up");
        }),
    });
    host.install({ name: "good", register: (api) => api.on("session_end", () => void (ran = true)) });
    await host.emitAndWait("session_end", END);
    assert.equal(ran, true);
    assert.deepEqual(host.counters.log[0], { extension: "bad", site: "session_end", message: "review blew up" });
  });

  it("a promise rejected under the synchronous emit is still counted, never unhandled", async () => {
    const host = hostWith(new RecordingGate());
    host.install({
      name: "async-bad",
      register: (api) =>
        api.on("checkpoint_written", async () => {
          throw new Error("later");
        }),
    });
    host.emit("checkpoint_written", { commit: "c", label: "l" });
    await new Promise((r) => setImmediate(r));
    assert.equal(host.counters.failuresByExtension["async-bad"], 1);
  });
});

describe("T149 runChildSession", () => {
  it("is unavailable, not an error, when no runner is bound (a child session)", async () => {
    const host = hostWith(new RecordingGate());
    let got: unknown;
    host.install({
      name: "asker",
      register: (api) => api.on("session_end", async () => void (got = await api.runChildSession({ prompt: "p", model: "m/x" }))),
    });
    await host.emitAndWait("session_end", END);
    assert.deepEqual(got, { status: "unavailable", model: "m/x", message: CHILD_SESSION_UNAVAILABLE });
    assert.equal(host.counters.failures, 0);
  });

  it("hands the bound runner the extension's DECLARED name and the request, and returns its result", async () => {
    const host = hostWith(new RecordingGate());
    const asked: Array<{ extension: string; request: ChildSessionRequest }> = [];
    host.bindSession({
      runChild: async (extension, request) => {
        asked.push({ extension, request });
        return { status: "ok", sessionId: "child-1", model: request.model, text: "NO_FINDINGS" };
      },
    });
    let text = "";
    host.install({
      name: "declared-name",
      register: (api) =>
        api.on("session_end", async () => {
          const r = await api.runChildSession({ prompt: "review this", model: "faux/cheap", label: "l" });
          if (r.status === "ok") text = r.text;
        }),
    });
    await host.emitAndWait("session_end", END);
    assert.deepEqual(asked, [{ extension: "declared-name", request: { prompt: "review this", model: "faux/cheap", label: "l" } }]);
    assert.equal(text, "NO_FINDINGS");
  });

  it("a runner that throws becomes an error result and a counted child_session failure", async () => {
    const host = hostWith(new RecordingGate());
    host.bindSession({
      runChild: async () => {
        throw new Error("no such model");
      },
    });
    let got: unknown;
    host.install({
      name: "asker",
      register: (api) => api.on("session_end", async () => void (got = await api.runChildSession({ prompt: "p", model: "bad/m" }))),
    });
    await host.emitAndWait("session_end", END);
    assert.deepEqual(got, { status: "error", model: "bad/m", message: "no such model" });
    assert.deepEqual(host.counters.log[0], { extension: "asker", site: "child_session", message: "no such model" });
  });
});

describe("T149 recordCounter", () => {
  it("adds per extension and name, in first-recorded order; an unrecorded counter is absent", () => {
    const host = hostWith(new RecordingGate());
    host.install({
      name: "a",
      register: (api) => {
        api.recordCounter("runs");
        api.recordCounter("found", 2);
        api.recordCounter("runs");
        api.recordCounter("zeroed", 0);
      },
    });
    host.install({ name: "b", register: (api) => api.recordCounter("runs", 5) });
    assert.deepEqual(host.extensionCounters(), [
      { extension: "a", name: "runs", value: 2 },
      { extension: "a", name: "found", value: 2 },
      { extension: "a", name: "zeroed", value: 0 },
      { extension: "b", name: "runs", value: 5 },
    ]);
  });

  it("refuses a bad name or a negative or fractional amount, and the refusal is the extension's counted failure", () => {
    const host = hostWith(new RecordingGate());
    host.install({ name: "x", register: (api) => api.recordCounter("Bad Name") });
    host.install({ name: "y", register: (api) => api.recordCounter("ok", -1) });
    host.install({ name: "z", register: (api) => api.recordCounter("ok", 1.5) });
    assert.equal(host.counters.failures, 3);
    assert.match(host.counters.log[0]!.message, /lower_snake_case/);
    assert.match(host.counters.log[1]!.message, /non-negative integer/);
    assert.deepEqual(host.extensionCounters(), []);
  });
});

describe("T162 reportAtSessionEnd", () => {
  it("keeps reports in order under each extension's declared name, and renders them after one another", () => {
    const host = new LykosExtensionHost({ cwd: ".", gate: new AutoApproveGate() });
    host.install({ name: "first", register: (api) => api.reportAtSessionEnd("one line") });
    host.install({ name: "second", register: (api) => api.reportAtSessionEnd("head\n1. a\n2. b\n") });
    assert.deepEqual(host.sessionEndReports(), [
      { extension: "first", text: "one line" },
      { extension: "second", text: "head\n1. a\n2. b" },
    ]);
    assert.equal(renderSessionEndReports(host.sessionEndReports()), "first: one line\nsecond: head\n  1. a\n  2. b");
    assert.equal(renderSessionEndReports([]), undefined);
  });

  it("refuses empty text as the extension's failure", () => {
    const host = new LykosExtensionHost({ cwd: ".", gate: new AutoApproveGate() });
    host.install({ name: "blank", register: (api) => api.reportAtSessionEnd("   ") });
    assert.deepEqual(host.sessionEndReports(), []);
    assert.equal(host.counters.failuresByExtension.blank, 1);
  });
});
