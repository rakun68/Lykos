// `ast_edit`.
//
// The tests that matter here are the ones about what is NOT written. A
// structural rewrite is the one tool in this codebase that can change a
// hundred files from one call, so every test below that ends in "and nothing
// was written" is checking the working tree on disk rather than a return
// value: a tool that reports a refusal and writes anyway would pass every
// assertion about its own message.
//
// The gate is exercised with a recording gate rather than `AutoApproveGate`
// alone, because D3's claim — the gate IS the apply — is only true if the
// diff the human sees is the diff that lands, and only testable if the test
// can see what the human was shown.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  AutoApproveGate,
  DenialLog,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
} from "../gate/approval.js";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { measureToolset } from "../ledger/tool-schema.js";
import { decideForMode, tierForAction } from "../gate/modes.js";
import { DEFAULT_RESIDENT_TOOLS } from "./tool-surface.js";
import { riskForTool, tierForTool } from "./tool-risk.js";
import { tierForToolCall } from "./tool-call.js";
import { piWalk } from "./ast.js";
import {
  AST_EDIT_DESCRIPTION,
  AST_EDIT_NO_CHANGE,
  AST_EDIT_NO_MATCH,
  AST_EDIT_PARAMETERS,
  AST_EDIT_TOOL_NAME,
  buildAstEditTool,
} from "./ast-edit.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function asJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

interface TextResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
  details?: Record<string, unknown>;
}

async function run(tool: unknown, params: unknown): Promise<TextResult> {
  const def = tool as { execute: (...args: unknown[]) => Promise<TextResult> };
  return await def.execute("call-1", params, undefined, undefined, undefined);
}

function textOf(result: TextResult): string {
  return result.content?.[0]?.text ?? "";
}

/** Every request the gate was asked, and a decision the test chooses per call. */
class RecordingGate implements ApprovalGate {
  readonly seen: ApprovalRequest[] = [];
  constructor(private readonly answer: (req: ApprovalRequest, index: number) => ApprovalDecision) {}
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.seen.push(req);
    return this.answer(req, this.seen.length - 1);
  }
}

describe("P10.4 D8: the catalog prices what ast_edit would send", () => {
  it("the row equals the live definition, description and parameters both", () => {
    const row = TOOL_CATALOG.ast_edit;
    assert.ok(row);
    assert.equal(row.name, AST_EDIT_TOOL_NAME);
    assert.equal(row.source, "lykos");
    assert.equal(row.description, AST_EDIT_DESCRIPTION);
    assert.deepEqual(row.parameters, asJson(AST_EDIT_PARAMETERS));
  });

  // Measured with `measureToolset` on SCHEMA_TOKENS_BASIS, 2026-09-21. The
  // last two assertions are the point of D8: two tools were added and the
  // resident surface did not move a single token, because both are mounted.
  it("costs 356 tokens if it ever goes resident, and 0 today", () => {
    const alone = measureToolset([AST_EDIT_TOOL_NAME]);
    assert.equal(alone.complete, true);
    assert.equal(alone.tokens, 356);
    assert.equal(alone.bytes, 1426);
    assert.equal(measureToolset(["ast_grep", "ast_edit"]).tokens, 632);
    // P10.7 (ticket 12): 1423 until this line was last touched, and 2062 now.
    // The resident total MOVED for the first time since P10.4, because
    // `web_search` (314 alone) and `web_fetch` (326 alone) were made RESIDENT
    // rather than mounted — 639 together, since array wrapping means the pair
    // is not the sum of the two. Nothing about this file's tool moved; this
    // line prices the surface it is being compared against.
    assert.equal(measureToolset(DEFAULT_RESIDENT_TOOLS).tokens, 2255);
    assert.equal(DEFAULT_RESIDENT_TOOLS.includes(AST_EDIT_TOOL_NAME), false);
  });
});

describe("P10.4 D3: the gate is the apply", () => {
  it("shows the human a unified diff and writes only after they approve", async () => {
    const dir = tmp("lykos-p104-astedit-gate-");
    try {
      const file = join(dir, "a.ts");
      writeFileSync(file, "openLedger(\n  db,\n  opts,\n);\n", "utf8");
      const gate = new RecordingGate(() => "allow");
      const result = await run(buildAstEditTool({ cwd: dir, gate, walk: piWalk(dir) }), {
        rules: [{ pattern: "openLedger($$$ARGS)", replacement: "openLedger(ctx, $$$ARGS)" }],
        paths: ["."],
      });

      assert.equal(gate.seen.length, 1);
      const req = gate.seen[0]!;
      assert.equal(req.kind, "edit");
      assert.equal(req.detail, file);
      // D3: the body is the DIFF, not the whole new file. That is the one
      // thing this tool can show that a `writeFile(path, content)` seam
      // cannot, and it is why `authorizeEditBody` exists.
      assert.match(req.body ?? "", /^--- a\.ts$/m);
      assert.match(req.body ?? "", /^\+\+\+ a\.ts$/m);
      assert.match(req.body ?? "", /^-openLedger\($/m);
      assert.match(req.body ?? "", /^\+openLedger\(ctx, db,$/m);

      // D2 all the way to disk: the capture is the SOURCE between the first
      // and last captured node, so the newline and the indentation between
      // `db,` and `opts,` survive — joining node texts would have written
      // `db,opts,` here. The line break before the closing paren does not
      // survive, and should not: it is outside the capture, and a rewrite is
      // a 1:1 substitution of the matched node rather than a reformatter.
      assert.equal(readFileSync(file, "utf8"), "openLedger(ctx, db,\n  opts,);\n");
      assert.match(textOf(result), /^Applied 1 replacement across 1 file\.$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a refusal writes nothing, and the denial is recorded as a human intervention", async () => {
    const dir = tmp("lykos-p104-astedit-deny-");
    try {
      const file = join(dir, "a.ts");
      writeFileSync(file, "foo(1);\n", "utf8");
      const denials = new DenialLog();
      const gate = new RecordingGate(() => "deny");
      await assert.rejects(
        () =>
          run(buildAstEditTool({ cwd: dir, gate, denials, walk: piWalk(dir) }), {
            rules: [{ pattern: "foo($A)", replacement: "bar($A)" }],
            paths: ["."],
          }),
        /declined this edit/,
      );
      assert.equal(readFileSync(file, "utf8"), "foo(1);\n");
      assert.equal(denials.userRejected, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("declining ONE file of a set writes nothing anywhere, including the files already approved", async () => {
    const dir = tmp("lykos-p104-astedit-partial-");
    try {
      const a = join(dir, "a.ts");
      const b = join(dir, "b.ts");
      writeFileSync(a, "foo(1);\n", "utf8");
      writeFileSync(b, "foo(2);\n", "utf8");
      // Approve the first file, decline the second. A tool that wrote as each
      // answer arrived would leave the tree half-rewritten, which is the one
      // state the model cannot reason about.
      const gate = new RecordingGate((_req, i) => (i === 0 ? "allow" : "deny"));
      await assert.rejects(
        () =>
          run(buildAstEditTool({ cwd: dir, gate, walk: piWalk(dir) }), {
            rules: [{ pattern: "foo($A)", replacement: "bar($A)" }],
            paths: ["."],
          }),
        /all-or-nothing across 2 files/,
      );
      assert.equal(gate.seen.length, 2);
      assert.equal(readFileSync(a, "utf8"), "foo(1);\n");
      assert.equal(readFileSync(b, "utf8"), "foo(2);\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a path outside the root asks, and a refusal leaves the file alone (T210)", async () => {
    const outside = tmp("lykos-p104-astedit-outside-");
    const root = tmp("lykos-p104-astedit-root-");
    try {
      const file = join(outside, "a.ts");
      writeFileSync(file, "foo(1);\n", "utf8");
      const gate = new RecordingGate(() => "deny");
      await assert.rejects(
        () =>
          run(buildAstEditTool({ cwd: root, gate, walk: async () => [file] }), {
            rules: [{ pattern: "foo($A)", replacement: "bar($A)" }],
            paths: ["."],
          }),
        /./,
      );
      assert.ok(gate.seen.length >= 1, "outside the root is a question now");
      assert.equal(readFileSync(file, "utf8"), "foo(1);\n");
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a deny rule on a path outside the root refuses it before the gate is consulted (T210)", async () => {
    const outside = tmp("lykos-p104-astedit-outside-");
    const root = tmp("lykos-p104-astedit-root-");
    try {
      const file = join(outside, "a.ts");
      writeFileSync(file, "foo(1);\n", "utf8");
      mkdirSync(join(root, ".lykos"), { recursive: true });
      writeFileSync(join(root, ".lykos", "config.yaml"), `path_rules:\n  write:\n    '${outside.split("\\").join("/")}/**': deny\n`);
      const gate = new RecordingGate(() => "allow");
      await assert.rejects(
        () =>
          run(buildAstEditTool({ cwd: root, gate, walk: async () => [file] }), {
            rules: [{ pattern: "foo($A)", replacement: "bar($A)" }],
            paths: ["."],
          }),
        /denied/,
      );
      assert.equal(gate.seen.length, 0, "a deny is never a question");
      assert.equal(readFileSync(file, "utf8"), "foo(1);\n");
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("P10.4: ast_edit reaches the gate at its declared tier", () => {
  it("is soft-write everywhere the question can be asked", () => {
    assert.equal(tierForTool(AST_EDIT_TOOL_NAME), "soft-write");
    assert.deepEqual(riskForTool(AST_EDIT_TOOL_NAME), {
      tier: "soft-write",
      idempotent: false,
      openWorld: false,
    });
    // The transport does not launder the tier: `tool_call` is `hard-write`
    // itself and is tiered on whatever it dispatches to.
    assert.equal(tierForToolCall("tool_call", { name: AST_EDIT_TOOL_NAME, arguments: {} }), "soft-write");
    // And the gate itself agrees, because the request goes through the one
    // `authorize()` as `kind: "edit"` — the same tier `edit` and `write`
    // already carry, reached through the same function, so there is no
    // second opinion to drift.
    assert.equal(tierForAction({ kind: "edit" }), "soft-write");
  });

  it("asks in Manual and is auto-allowed nowhere a soft write would not be", () => {
    const action = { kind: "edit" } as const;
    assert.equal(decideForMode("manual", action, new Set()).tier, "soft-write");
    assert.equal(decideForMode("manual", action, new Set()).verdict, "ask");
    assert.equal(
      decideForMode("auto", action, new Set()).verdict,
      decideForMode("auto", { kind: "write" }, new Set()).verdict,
    );
  });
});

describe("P10.4 D6: all-or-nothing across the file set", () => {
  it("a rewrite matching nothing writes nothing and says so", async () => {
    const dir = tmp("lykos-p104-astedit-nomatch-");
    try {
      const file = join(dir, "a.ts");
      writeFileSync(file, "const x = 1;\n", "utf8");
      const gate = new RecordingGate(() => "allow");
      const result = await run(buildAstEditTool({ cwd: dir, gate, walk: piWalk(dir) }), {
        rules: [{ pattern: "openLedger($$$A)", replacement: "openLedger(ctx, $$$A)" }],
        paths: ["."],
      });
      assert.equal(textOf(result), AST_EDIT_NO_MATCH);
      assert.equal(result.details?.applied, false);
      assert.equal(gate.seen.length, 0, "nothing to approve means nobody is asked");
      assert.equal(readFileSync(file, "utf8"), "const x = 1;\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a rewrite whose replacement equals what it replaces says so, and is not reported as no match", async () => {
    const dir = tmp("lykos-p104-astedit-nochange-");
    try {
      const file = join(dir, "a.ts");
      writeFileSync(file, "foo(1);\n", "utf8");
      const gate = new RecordingGate(() => "allow");
      const result = await run(buildAstEditTool({ cwd: dir, gate, walk: piWalk(dir) }), {
        rules: [{ pattern: "foo($A)", replacement: "foo($A)" }],
        paths: ["."],
      });
      // "Nothing matched" would send the model off to debug a pattern that is
      // working perfectly, so the two ways of changing nothing say different
      // things.
      assert.equal(textOf(result), AST_EDIT_NO_CHANGE);
      assert.equal(result.details?.matchedSomething, true);
      assert.equal(gate.seen.length, 0);
      assert.equal(readFileSync(file, "utf8"), "foo(1);\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("one unparseable file stops the whole set, and the good file is untouched", async () => {
    const dir = tmp("lykos-p104-astedit-broken-");
    try {
      const good = join(dir, "good.ts");
      const broken = join(dir, "broken.ts");
      writeFileSync(good, "foo(1);\n", "utf8");
      writeFileSync(broken, "function ( {{{\n", "utf8");
      const gate = new RecordingGate(() => "allow");
      await assert.rejects(
        () =>
          run(buildAstEditTool({ cwd: dir, gate, walk: piWalk(dir) }), {
            rules: [{ pattern: "foo($A)", replacement: "bar($A)" }],
            paths: ["."],
          }),
        /did not parse: broken\.ts/,
      );
      assert.equal(gate.seen.length, 0);
      assert.equal(readFileSync(good, "utf8"), "foo(1);\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("two rules that rewrite overlapping code are refused, never half-applied", async () => {
    const dir = tmp("lykos-p104-astedit-overlap-");
    try {
      const file = join(dir, "a.ts");
      writeFileSync(file, "foo(foo(1));\n", "utf8");
      const gate = new RecordingGate(() => "allow");
      // ast-grep matches `foo($A)` at both the outer and the inner call, and
      // the package's own commitEdits would silently drop one of them.
      await assert.rejects(
        () =>
          run(buildAstEditTool({ cwd: dir, gate, walk: piWalk(dir) }), {
            rules: [{ pattern: "foo($A)", replacement: "bar($A)" }],
            paths: ["."],
          }),
        /overlapping code/,
      );
      assert.equal(readFileSync(file, "utf8"), "foo(foo(1));\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rewrites every file in the set when every file is approved", async () => {
    const dir = tmp("lykos-p104-astedit-multi-");
    try {
      const a = join(dir, "a.ts");
      const b = join(dir, "b.tsx");
      writeFileSync(a, "foo(1);\n", "utf8");
      writeFileSync(b, "foo(2);\nfoo(3);\n", "utf8");
      const result = await run(
        buildAstEditTool({ cwd: dir, gate: new AutoApproveGate(), walk: piWalk(dir) }),
        { rules: [{ pattern: "foo($A)", replacement: "bar($A)" }], paths: ["."] },
      );
      assert.equal(readFileSync(a, "utf8"), "bar(1);\n");
      assert.equal(readFileSync(b, "utf8"), "bar(2);\nbar(3);\n");
      const out = textOf(result);
      assert.match(out, /^Applied 3 replacements across 2 files\.$/m);
      // T168: the result names each changed file and carries no tag.
      assert.match(out, /^1 replacement in a\.ts$/m);
      assert.match(out, /^2 replacements in b\.tsx$/m);
      assert.doesNotMatch(out, /#[0-9A-F]{4}\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P10.4: a rule is checked before any file is opened", () => {
  const gateAndDir = () => ({ gate: new RecordingGate(() => "allow") });

  it("refuses an empty rule set, an empty path set, a duplicate pattern and an unbound capture", async () => {
    const dir = tmp("lykos-p104-astedit-rules-");
    try {
      writeFileSync(join(dir, "a.ts"), "foo(1);\n", "utf8");
      const tool = buildAstEditTool({ cwd: dir, ...gateAndDir(), walk: piWalk(dir) });
      await assert.rejects(() => run(tool, { rules: [], paths: ["."] }), /rules is empty/);
      await assert.rejects(
        () => run(tool, { rules: [{ pattern: "foo($A)", replacement: "bar($A)" }], paths: [] }),
        /paths is empty/,
      );
      await assert.rejects(
        () =>
          run(tool, {
            rules: [
              { pattern: "foo($A)", replacement: "bar($A)" },
              { pattern: "foo($A)", replacement: "baz($A)" },
            ],
            paths: ["."],
          }),
        /is given twice/,
      );
      // The one that would otherwise write `bar()` to disk: it compiles, it
      // looks deliberate, and it silently dropped the argument.
      await assert.rejects(
        () => run(tool, { rules: [{ pattern: "foo($A)", replacement: "bar($B)" }], paths: ["."] }),
        /the replacement uses \$B, which the pattern never captures/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports every problem in one message rather than one per round trip", async () => {
    const dir = tmp("lykos-p104-astedit-many-");
    try {
      await assert.rejects(
        () =>
          run(buildAstEditTool({ cwd: dir, ...gateAndDir(), walk: piWalk(dir) }), {
            rules: [{ pattern: "  ", replacement: "x" }],
            paths: [],
          }),
        /2 problems in this call/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P10.4: a rewrite is not also a whitespace commit", () => {
  it("restores the CRLF line endings the file already had", async () => {
    const dir = tmp("lykos-p104-astedit-crlf-");
    try {
      const file = join(dir, "a.ts");
      writeFileSync(file, "foo(1);\r\nfoo(2);\r\n", "utf8");
      await run(buildAstEditTool({ cwd: dir, gate: new AutoApproveGate(), walk: piWalk(dir) }), {
        rules: [{ pattern: "foo($A)", replacement: "bar($A)" }],
        paths: ["."],
      });
      assert.equal(readFileSync(file, "utf8"), "bar(1);\r\nbar(2);\r\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an empty replacement deletes the matched node", async () => {
    const dir = tmp("lykos-p104-astedit-delete-");
    try {
      const file = join(dir, "a.ts");
      writeFileSync(file, "const x = 1;\ndebugger;\nconst y = 2;\n", "utf8");
      await run(buildAstEditTool({ cwd: dir, gate: new AutoApproveGate(), walk: piWalk(dir) }), {
        rules: [{ pattern: "debugger;", replacement: "" }],
        paths: ["a.ts"],
      });
      assert.equal(readFileSync(file, "utf8"), "const x = 1;\n\nconst y = 2;\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the files it skipped, so a rewrite's scope is as visible as a search's", async () => {
    const dir = tmp("lykos-p104-astedit-skip-");
    try {
      writeFileSync(join(dir, "a.ts"), "foo(1);\n", "utf8");
      writeFileSync(join(dir, "notes.md"), "foo(1)\n", "utf8");
      const out = textOf(
        await run(buildAstEditTool({ cwd: dir, gate: new AutoApproveGate(), walk: piWalk(dir) }), {
          rules: [{ pattern: "foo($A)", replacement: "bar($A)" }],
          paths: ["."],
        }),
      );
      assert.match(out, /Skipped 1 file whose language is not inferable/);
      assert.match(out, /notes\.md/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
