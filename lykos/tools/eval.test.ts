// The `eval` tool: D6's unconfigured Python, the gate on every call, and D10's
// catalog parity and measured tax.
//
// The runtime's own properties — D5's isolation, D7's retained state, D8's
// timeout, D9's cap — are proven in `eval-runtime.test.ts` against the runtime
// directly. This file proves the TOOL: that it asks before it runs anything,
// that it hands the outcomes on faithfully, and that a language it does not
// have is a sentence rather than a failure.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  DenialLog,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
} from "../gate/approval.js";
import { decideForMode, tierForAction } from "../gate/modes.js";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { measureToolset } from "../ledger/tool-schema.js";
import {
  EVAL_DESCRIPTION,
  EVAL_PARAMETERS,
  EVAL_PYTHON_CONFIG_KEY,
  EVAL_PYTHON_UNCONFIGURED_NOTICE,
  EVAL_TOOL_NAME,
  buildEvalTool,
  cellHeadline,
  resolveEvalTimeoutMs,
} from "./eval.js";
import { EVAL_MAX_TIMEOUT_SECONDS, EvalRuntimePool } from "./eval-runtime.js";
import { waitForOsProcess } from "./process-probe.js";
import { riskForTool, tierForTool } from "./tool-risk.js";
import { tierForToolCall } from "./tool-call.js";
import { DEFAULT_RESIDENT_TOOLS, MOUNTED_TOOLS } from "./tool-surface.js";

function asJson(schema: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

class RecordingGate implements ApprovalGate {
  readonly seen: ApprovalRequest[] = [];
  constructor(private readonly answer: ApprovalDecision = "allow") {}
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.seen.push(req);
    return this.answer;
  }
}

interface Harness {
  dir: string;
  tool: ToolDefinition;
  gate: RecordingGate;
  denials: DenialLog;
  runtimes: EvalRuntimePool;
  dispose: () => Promise<void>;
}

function harness(opts: { answer?: ApprovalDecision; python?: string } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "lykos-evaltool-"));
  const gate = new RecordingGate(opts.answer ?? "allow");
  const denials = new DenialLog();
  const runtimes = new EvalRuntimePool({ cwd: dir });
  const tool = buildEvalTool({
    cwd: dir,
    gate,
    denials,
    runtimes,
    ...(opts.python !== undefined ? { python: opts.python } : {}),
  });
  return {
    dir,
    tool,
    gate,
    denials,
    runtimes,
    dispose: async () => {
      const pids = runtimes.pids();
      // The same teardown the session does.
      await runtimes.disposeAll();
      for (const pid of pids) {
        assert.equal(await waitForOsProcess(pid, false), false, `pid ${pid} outlived the session`);
      }
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        // A Windows handle still closing is not a test failure.
      }
    },
  };
}

async function call(h: Harness, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; details: any }> {
  const result = (await h.tool.execute("call-1", args as never, undefined as never, undefined as never, undefined as never)) as {
    content?: Array<{ text?: string }>;
    isError?: boolean;
    details?: unknown;
  };
  return {
    text: result.content?.map((c) => c.text ?? "").join("\n") ?? "",
    isError: result.isError === true,
    details: result.details as any,
  };
}

// ---------------------------------------------------------------------------
// D10: the catalog prices what eval would send
// ---------------------------------------------------------------------------

describe("P10.6 D10: the catalog prices what eval would send", () => {
  it("the row equals the live definition, description and parameters both", () => {
    const row = TOOL_CATALOG.eval;
    assert.ok(row);
    assert.equal(row.name, EVAL_TOOL_NAME);
    assert.equal(row.source, "lykos");
    assert.equal(row.description, EVAL_DESCRIPTION);
    assert.deepEqual(row.parameters, asJson(EVAL_PARAMETERS));
  });

  // Measured with `measureToolset` on SCHEMA_TOKENS_BASIS, 2026-09-21. The
  // last two assertions are the point of D10: two tools were added and the
  // resident surface did not move a single token, because both are mounted.
  it("costs 376 tokens if it ever goes resident, and 0 today", () => {
    const alone = measureToolset([EVAL_TOOL_NAME]);
    assert.equal(alone.complete, true);
    assert.equal(alone.tokens, 376);
    assert.equal(alone.bytes, 1503);
    // The resident surface is what rides every request, and THIS ticket did
    // not touch it — it was 1423 before and after the work in this file.
    // P10.7 (ticket 12): 1423 until this line was last touched, and 2062 now.
    // The resident total MOVED for the first time since P10.4, because
    // `web_search` (314 alone) and `web_fetch` (326 alone) were made RESIDENT
    // rather than mounted — 639 together, since array wrapping means the pair
    // is not the sum of the two. Nothing about this file's tool moved; this
    // line prices the surface it is being compared against.
    assert.equal(measureToolset(DEFAULT_RESIDENT_TOOLS).tokens, 2255);
    assert.equal(DEFAULT_RESIDENT_TOOLS.includes(EVAL_TOOL_NAME), false);
    // The mounted set is what moved: 5322 tokens after P10.6's memory five,
    // 6430 once `eval` (376) and `github` (734) joined it, 8605 once
    // P10.6's ticket 20 mounted the nine session and context tools, and 9027
    // once P10.8 mounted `security_scan`. None of it rides a
    // request — `tool_call` fetches one schema at a time — but an unpriced
    // tool makes the whole toolset NULL rather than a silent undercount, so it
    // is measured either way. `github.test.ts` records the same step from its
    // own side.
    assert.equal(measureToolset(MOUNTED_TOOLS).tokens, 9023);
    assert.equal(MOUNTED_TOOLS.includes(EVAL_TOOL_NAME), true);
  });

  it("is declared hard-write, which is where arbitrary code lands", () => {
    assert.equal(tierForTool(EVAL_TOOL_NAME), "hard-write");
    assert.deepEqual(riskForTool(EVAL_TOOL_NAME), { tier: "hard-write", idempotent: false, openWorld: true });
    // The transport does not launder the tier.
    assert.equal(tierForToolCall("tool_call", { name: EVAL_TOOL_NAME, arguments: {} }), "hard-write");
  });
});

// ---------------------------------------------------------------------------
// D6: Python is declared and unconfigured
// ---------------------------------------------------------------------------

describe("P10.6 D6: py reports itself unconfigured by naming the setting", () => {
  it("names eval.python, is not an error, and spawns nothing", async () => {
    const h = harness();
    try {
      const res = await call(h, { language: "py", code: "print(1)" });
      assert.equal(res.text, EVAL_PYTHON_UNCONFIGURED_NOTICE);
      assert.match(res.text, /eval\.python/);
      // Not an error: "you have not configured Python" is an answer to the
      // question the model asked, and marking it an error is what makes a
      // model retry the same call.
      assert.equal(res.isError, false);
      assert.equal(res.details.configured, false);
      assert.equal(res.details.setting, EVAL_PYTHON_CONFIG_KEY);
      assert.equal(res.details.success, false);
      // Nothing was approved and nothing was started.
      assert.equal(h.gate.seen.length, 0);
      assert.deepEqual(h.runtimes.pids(), []);
    } finally {
      await h.dispose();
    }
  });

  it("a configured interpreter still says the backend is unbuilt rather than running js instead", async () => {
    const h = harness({ python: "python3" });
    try {
      const res = await call(h, { language: "py", code: "print(1)" });
      assert.match(res.text, /not built yet/);
      assert.match(res.text, /python3/);
      assert.equal(res.details.configured, true);
      assert.equal(res.details.success, false);
      assert.equal(h.gate.seen.length, 0);
    } finally {
      await h.dispose();
    }
  });

  it("a language that is neither is refused by naming the two that exist", async () => {
    const h = harness();
    try {
      const res = await call(h, { language: "ruby", code: "puts 1" });
      assert.equal(res.isError, true);
      assert.match(res.text, /js, py/);
      assert.equal(h.gate.seen.length, 0);
    } finally {
      await h.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// The gate, on every call
// ---------------------------------------------------------------------------

describe("P10.6 D5: eval reaches the gate on every call", () => {
  it("asks as an eval operation, with the whole cell as the body", async () => {
    const h = harness();
    try {
      const code = "const x = 1;\nx + 1";
      const res = await call(h, { language: "js", code });
      assert.equal(res.isError, false);
      assert.equal(h.gate.seen.length, 1);
      const req = h.gate.seen[0]!;
      assert.equal(req.kind, "eval");
      assert.match(req.summary, /evaluate a js cell/);
      // The human decides on the WHOLE cell, not on a one-line summary of it.
      assert.equal(req.body, code);
      assert.equal(req.detail, "const x = 1;");
      // Not a bash request, so no POSIX classifier is ever run over source
      // code, and no always-allow pattern can be minted from one.
      assert.notEqual(req.kind, "bash");
      assert.equal(req.shell, undefined);
    } finally {
      await h.dispose();
    }
  });

  it("asks again on the second call — approval is per cell, not per session", async () => {
    const h = harness();
    try {
      await call(h, { language: "js", code: "1" });
      await call(h, { language: "js", code: "2" });
      assert.equal(h.gate.seen.length, 2);
    } finally {
      await h.dispose();
    }
  });

  it("stops and asks, because the declared tier is hard-write", () => {
    assert.equal(tierForAction({ kind: "eval" }), "hard-write");
    for (const mode of ["manual", "accept-edits", "auto"] as const) {
      const decision = decideForMode(mode, { kind: "eval" }, new Set());
      assert.equal(decision.verdict, "ask", mode);
      assert.equal(decision.tier, "hard-write");
    }
  });

  it("a declined cell runs nothing, starts no process, and is recorded as a refusal", async () => {
    const h = harness({ answer: "deny" });
    try {
      const res = await call(h, { language: "js", code: "require('node:fs').writeFileSync('proof.txt','x')" });
      assert.equal(res.isError, true);
      assert.match(res.text, /declined/);
      assert.deepEqual(h.runtimes.pids(), [], "a declined cell started a process anyway");
      assert.equal(h.denials.userRejected, 1);
    } finally {
      await h.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// D7/D8/D9, through the tool
// ---------------------------------------------------------------------------

describe("P10.6 D7: the tool retains state across two calls in one session", () => {
  it("keeps a value from one call to the next, and reset discards it", async () => {
    const h = harness();
    try {
      const first = await call(h, { language: "js", code: "const kept = 'from the first call'; kept.length" });
      assert.equal(first.isError, false, first.text);
      assert.match(first.text, /=> 19/);

      const second = await call(h, { language: "js", code: "kept" });
      assert.equal(second.isError, false, second.text);
      assert.match(second.text, /from the first call/);

      const third = await call(h, { language: "js", code: "typeof kept", reset: true });
      assert.equal(third.isError, false, third.text);
      assert.match(third.text, /undefined/);
      assert.equal(third.details.restarted, true);
    } finally {
      await h.dispose();
    }
  });

  it("reports what the cell printed as well as what it evaluated to", async () => {
    const h = harness();
    try {
      const res = await call(h, { language: "js", code: "console.log('printed'); 'value'" });
      assert.match(res.text, /printed/);
      assert.match(res.text, /=> 'value'/);
    } finally {
      await h.dispose();
    }
  });

  it("a cell that throws is an answer, not a failed tool call", async () => {
    const h = harness();
    try {
      const res = await call(h, { language: "js", code: "null.nope" });
      assert.equal(res.details.status, "error");
      // The model asked what this code does; "it throws" is the answer.
      assert.equal(res.isError, false);
      assert.match(res.text, /TypeError/);
    } finally {
      await h.dispose();
    }
  });
});

describe("P10.6 D8: a hung cell, through the tool", () => {
  it("says the runtime restarted and the variables are gone, and stays usable", async () => {
    const h = harness();
    try {
      await call(h, { language: "js", code: "const before = 1;" });
      const hung = await call(h, { language: "js", code: "for (;;) {}", timeout: 1 });
      assert.equal(hung.isError, true);
      assert.equal(hung.details.status, "timeout");
      assert.match(hung.text, /EVERY VARIABLE IS GONE/);
      assert.match(hung.text, /restarted/);

      const after = await call(h, { language: "js", code: "typeof before" });
      assert.equal(after.isError, false, after.text);
      assert.match(after.text, /undefined/);
    } finally {
      await h.dispose();
    }
  });

  it("clamps a timeout to the band the schema advertises", () => {
    assert.equal(resolveEvalTimeoutMs(undefined), 30_000);
    assert.equal(resolveEvalTimeoutMs(0), 30_000, "zero is not 'no watchdog at all'");
    assert.equal(resolveEvalTimeoutMs(-5), 30_000);
    assert.equal(resolveEvalTimeoutMs(2.7), 2_000);
    assert.equal(resolveEvalTimeoutMs(999_999), EVAL_MAX_TIMEOUT_SECONDS * 1000);
  });
});

describe("P10.6: the small refusals", () => {
  it("an empty cell is a mis-call, not a no-op", async () => {
    const h = harness();
    try {
      const res = await call(h, { language: "js", code: "   " });
      assert.equal(res.isError, true);
      assert.match(res.text, /empty/);
      assert.equal(h.gate.seen.length, 0);
    } finally {
      await h.dispose();
    }
  });

  it("the approval headline is the first non-empty line, elided rather than dropped", () => {
    assert.equal(cellHeadline("\n\n  const a = 1;\nconst b = 2;"), "const a = 1;");
    assert.equal(cellHeadline(""), "(empty cell)");
    assert.equal(cellHeadline("x".repeat(200)).length, 120);
    assert.ok(cellHeadline("x".repeat(200)).endsWith("…"));
  });
});
