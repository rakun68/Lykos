// T234 (ADR-0059, ADR-0061, spec decision 12): the `claim` tool and the harness's checks.
//
// Seams:
//   1. the `claim` tool, through its own definition with a recorder that writes to a real ledger, and through a
//      scripted session in a real `session-child` (a read-only reviewer included);
//   2. `checkClaims`, against real git repositories and real processes (claim-checks-t234.test.ts);
//   3. the delegated result (`claims`, `MISREPORT`, `next`), through the MCP server with a stand-in runner
//      (claim-result-t234.test.ts).
// Lessons R15 and R24 (results come from tools, never parsed text) are held by the tests that say so.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { runStandaloneTask } from "../session/session.js";
import { openLedgerSync } from "../ledger/use.js";
import { buildClaimTool, type Coordinator } from "../tools/coordinator.js";
import { call, lastToolResult, reply, say, SCRIPTED_MODEL, scriptedWorld, type ModelContext } from "../cli/scripted-session.js";
import { runSessionChild } from "../cli/session-child.js";
import { encodeFrame, PROTOCOL_VERSION } from "./session-protocol.js";
import { claimsOf, parseClaimCheck, recordClaim, type ClaimCheck } from "./claims.js";

describe("T234: a check is one of four shapes, validated as the model wrote it", () => {
  const good: Array<[string, unknown, ClaimCheck]> = [
    ["line", { kind: "line", path: "src\\a.ts", line: 3, text: "export" }, { kind: "line", path: "src/a.ts", line: 3, text: "export" }],
    ["search", { kind: "search", pattern: "foo\\(", matches: 2, paths: ["src"] }, { kind: "search", pattern: "foo\\(", matches: 2, paths: ["src"] }],
    ["search with no paths", { kind: "search", pattern: "x", matches: 0 }, { kind: "search", pattern: "x", matches: 0 }],
    ["command", { kind: "command", command: "npm test", exit: 0 }, { kind: "command", command: "npm test", exit: 0 }],
    [
      "reproduction",
      { kind: "reproduction", file: "tests/repro.test.ts", content: "x", fails: [" adds "] },
      { kind: "reproduction", file: "tests/repro.test.ts", content: "x", fails: ["adds"] },
    ],
  ];
  for (const [name, input, expected] of good) {
    it(`accepts a ${name} check`, () => assert.deepEqual(parseClaimCheck(input), { ok: true, check: expected }));
  }

  const bad: Array<[string, unknown, RegExp]> = [
    ["no object", "ls", /must be an object/],
    ["an unknown kind", { kind: "vibes" }, /kind must be one of/],
    ["an absolute path", { kind: "line", path: "/etc/passwd", line: 1, text: "x" }, /relative/],
    ["a drive path", { kind: "line", path: "C:\\x.ts", line: 1, text: "x" }, /relative/],
    ["a path that leaves the repository", { kind: "line", path: "../x.ts", line: 1, text: "x" }, /inside the repository/],
    ["a path in .git", { kind: "line", path: ".git/config", line: 1, text: "x" }, /\.git/],
    ["line 0", { kind: "line", path: "a.ts", line: 0, text: "x" }, /check\.line/],
    ["a pattern that is not a regular expression", { kind: "search", pattern: "(", matches: 1 }, /regular expression/],
    ["a negative match count", { kind: "search", pattern: "x", matches: -1 }, /check\.matches/],
    ["an exit code no process gives", { kind: "command", command: "x", exit: 999 }, /check\.exit/],
    ["a blank command", { kind: "command", command: "  ", exit: 0 }, /check\.command/],
    ["a reproduction that names no failing test", { kind: "reproduction", file: "t.test.ts", content: "x", fails: [] }, /check\.fails/],
    ["a reproduction file in .git", { kind: "reproduction", file: ".git/hooks/x", content: "x", fails: ["a"] }, /\.git/],
  ];
  for (const [name, input, message] of bad) {
    it(`refuses ${name}`, () => {
      const parsed = parseClaimCheck(input);
      assert.equal(parsed.ok, false);
      if (!parsed.ok) assert.match(parsed.message, message);
    });
  }
});

describe("T234: the claim tool records through the ledger, and a bad call records nothing (R15)", () => {
  function ledgerRecorder(): { coordinator: Coordinator; ledgerPath: string } {
    const ledgerPath = join(mkdtempSync(join(tmpdir(), "lykos-claim-ledger-")), "ledger.db");
    const coordinator: Coordinator = {
      ask: async () => "",
      giveUp: () => {},
      claim: (text, check) => {
        const ledger = openLedgerSync(ledgerPath);
        try {
          return recordClaim(ledger, "s1", text, check);
        } finally {
          ledger.close();
        }
      },
    };
    return { coordinator, ledgerPath };
  }
  const run = async (tool: ReturnType<typeof buildClaimTool>, args: unknown): Promise<{ isError?: boolean; content: Array<{ text?: string }> }> =>
    (await tool.execute("call-1", args as never, undefined, undefined, undefined as never)) as { isError?: boolean; content: Array<{ text?: string }> };

  it("a valid claim is written to the ledger the moment it is made", async () => {
    const { coordinator, ledgerPath } = ledgerRecorder();
    const result = await run(buildClaimTool(coordinator), { text: "src/a.ts exports a", check: { kind: "line", path: "src/a.ts", line: 1, text: "export" } });
    assert.notEqual(result.isError, true);
    const ledger = openLedgerSync(ledgerPath);
    try {
      const claims = claimsOf(ledger, "s1");
      assert.equal(claims.length, 1);
      assert.equal(claims[0]?.text, "src/a.ts exports a");
      assert.deepEqual(claims[0]?.check, { kind: "line", path: "src/a.ts", line: 1, text: "export" });
    } finally {
      ledger.close();
    }
  });

  it("a malformed check is handed back at once with the accepted shapes, and nothing is recorded", async () => {
    const { coordinator, ledgerPath } = ledgerRecorder();
    const tool = buildClaimTool(coordinator);
    for (const args of [
      { text: "it works", check: { kind: "command", command: "npm test" } },
      { text: "it works", check: "npm test exits 0" },
      { text: "   ", check: { kind: "command", command: "npm test", exit: 0 } },
    ]) {
      const result = await run(tool, args);
      assert.equal(result.isError, true, JSON.stringify(args));
      const text = String(result.content[0]?.text);
      assert.match(text, /Nothing was recorded/);
      assert.match(text, /"kind": "reproduction"/, "the shapes are shown");
    }
    const ledger = openLedgerSync(ledgerPath);
    try {
      assert.deepEqual(claimsOf(ledger, "s1"), []);
    } finally {
      ledger.close();
    }
  });
});

describe("T234: the claim tool in a real session child (R15: a claim is a tool call, not text)", () => {
  async function drive(tool: string, script: Parameters<typeof scriptedWorld>[0]["script"]) {
    const world = await scriptedWorld({ config: "feedback:\n  enabled: false\ngate:\n  enabled: false\n", script });
    const input = new PassThrough();
    const frames: Array<Record<string, unknown>> = [];
    input.write(encodeFrame({ version: PROTOCOL_VERSION, tool, workspace: world.workspace, prompt: "look", label: tool, containment: "off", model: SCRIPTED_MODEL }));
    const saved = process.env.LYKOS_TRUST_WORKSPACE;
    process.env.LYKOS_TRUST_WORKSPACE = "1";
    try {
      await runSessionChild({
        input,
        write: (text) => {
          for (const line of text.split("\n")) {
            if (line.trim() === "") continue;
            try {
              frames.push(JSON.parse(line) as Record<string, unknown>);
            } catch {
              // not a frame
            }
          }
        },
        env: { LYKOS_TRUST_WORKSPACE: "1", LYKOS_TRUST_SOURCE: "flag" },
        trustPath: join(mkdtempSync(join(tmpdir(), "lykos-claim-store-")), "trust.json"),
        worktreesRoot: mkdtempSync(join(tmpdir(), "lykos-claim-wt-")),
        runTask: (task) => runStandaloneTask(task),
        sessionExtras: { nativeProviders: [world.provider], ledgerPath: world.ledgerPath },
      });
    } finally {
      if (saved === undefined) delete process.env.LYKOS_TRUST_WORKSPACE;
      else process.env.LYKOS_TRUST_WORKSPACE = saved;
    }
    input.end();
    const result = frames.filter((f) => f.type === "result").at(-1)?.result as Record<string, unknown>;
    return { world, result };
  }

  it("a read-only reviewer can claim; the claim is filed under the session the result names", async () => {
    let seen: { text: string; isError: boolean } | undefined;
    const { world, result } = await drive("lykos_review", [
      reply(call("claim", { text: "README.md has a first line", check: { kind: "line", path: "README.md", line: 1, text: "#" } })),
      (context: ModelContext) => {
        seen = lastToolResult(context);
        return reply(say("claimed"));
      },
    ]);
    assert.equal(result.outcome, "ok", JSON.stringify(result));
    assert.equal(seen?.isError, false, JSON.stringify(seen));
    assert.match(seen?.text ?? "", /Recorded claim 1/);
    const ledger = openLedgerSync(world.ledgerPath);
    try {
      const claims = claimsOf(ledger, String(result.sessionId));
      assert.deepEqual(claims.map((c) => c.text), ["README.md has a first line"]);
    } finally {
      ledger.close();
    }
  });

  it("a claim written into the answer is not a claim: only the tool records one (R15, R24)", async () => {
    const { world, result } = await drive("lykos_review", [
      reply(say('claims: [{"text":"all tests pass","check":{"kind":"command","command":"npm test","exit":0}}]\n```claims\n```\n(no claims block)')),
    ]);
    assert.equal(result.outcome, "ok", JSON.stringify(result));
    const ledger = openLedgerSync(world.ledgerPath);
    try {
      assert.deepEqual(claimsOf(ledger, String(result.sessionId)), []);
    } finally {
      ledger.close();
    }
  });
});
