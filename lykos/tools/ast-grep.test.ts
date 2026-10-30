// `ast_grep`.
//
// Three kinds of test, and the split follows `search.test.ts`. The parity
// test compares the catalog row against the LIVE tool definition rather than
// against a transcription of it, because the whole value of the row is that
// it prices what would actually go on the wire. The tax test pins the
// measured numbers the module comment records, so a description edit that
// doubles the bill fails here instead of passing silently. The behaviour
// tests run the real `@ast-grep/napi` over real files, because a match that
// agrees with a stand-in and disagrees with the parser is worth nothing.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AutoApproveGate } from "../gate/approval.js";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { measureToolset } from "../ledger/tool-schema.js";
import { DEFAULT_RESIDENT_TOOLS } from "./tool-surface.js";
import { riskForTool, tierForTool } from "./tool-risk.js";
import { tierForToolCall } from "./tool-call.js";
import { piWalk, type AstWalk } from "./ast.js";
import {
  AST_GREP_DESCRIPTION,
  AST_GREP_PARAMETERS,
  AST_GREP_TOOL_NAME,
  buildAstGrepTool,
  renderAstGrepResult,
} from "./ast-grep.js";
import { buildEditTool } from "./edit.js";

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

describe("P10.4 D8: the catalog prices what ast_grep would send", () => {
  it("the row equals the live definition, description and parameters both", () => {
    const row = TOOL_CATALOG.ast_grep;
    assert.ok(row);
    assert.equal(row.name, AST_GREP_TOOL_NAME);
    assert.equal(row.source, "lykos");
    assert.equal(row.description, AST_GREP_DESCRIPTION);
    assert.deepEqual(row.parameters, asJson(AST_GREP_PARAMETERS));
  });

  // The figures the module comment records, measured with `measureToolset` on
  // SCHEMA_TOKENS_BASIS on 2026-09-21. The second assertion is the one that
  // matters most: this ticket added two tools and moved the resident surface
  // by nothing at all, because both are mounted.
  it("costs 276 tokens if it ever goes resident, and 0 today", () => {
    const alone = measureToolset([AST_GREP_TOOL_NAME]);
    assert.equal(alone.complete, true);
    // T168 (ADR-0031): 281 / 1123 until the description stopped promising a [path#TAG] header. Re-measured.
    assert.equal(alone.tokens, 276);
    assert.equal(alone.bytes, 1104);
    // P10.7 (ticket 12): 1423 until this line was last touched, and 2062 now.
    // The resident total MOVED for the first time since P10.4, because
    // `web_search` (314 alone) and `web_fetch` (326 alone) were made RESIDENT
    // rather than mounted — 639 together, since array wrapping means the pair
    // is not the sum of the two. Nothing about this file's tool moved; this
    // line prices the surface it is being compared against.
    // T168: 2057 -> 2092. `edit` gained `replaceAll` and `read` gained a sentence about its line numbers; re-measured.
    assert.equal(measureToolset(DEFAULT_RESIDENT_TOOLS).tokens, 2255);
    assert.equal(DEFAULT_RESIDENT_TOOLS.includes(AST_GREP_TOOL_NAME), false);
  });
});

describe("P10.4: a pattern finds what a regex misses", () => {
  it("finds a call shape across line breaks and reports its captures", async () => {
    const dir = tmp("lykos-p104-astgrep-");
    try {
      writeFileSync(
        join(dir, "a.ts"),
        ["openLedger(db, opts);", "openLedger(", "  db,", "  opts,", ");", ""].join("\n"),
        "utf8",
      );
      const out = textOf(
        await run(buildAstGrepTool({ cwd: dir, walk: piWalk(dir) }), { pattern: "openLedger($$$ARGS)" }),
      );
      // Both call sites, and the wrapped one reported with the lines it
      // actually occupies — a regex for `openLedger\(db, opts\)` finds one.
      assert.match(out, /^1: openLedger\(db, opts\);$/m);
      assert.match(out, /^2: openLedger\($/m);
      assert.match(out, /^5: \);$/m);
      // D2's separator rule survives all the way into the rendered result.
      assert.match(out, /meta: ARGS=db, opts$/m);
      assert.match(out, /meta: ARGS=db, opts,$/m);
      assert.match(out, /^2 matches in 1 file\.$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names every skipped file rather than answering 'no matches' over a scope it never opened", async () => {
    const dir = tmp("lykos-p104-astgrep-skip-");
    try {
      writeFileSync(join(dir, "a.ts"), "const x = 1;\n", "utf8");
      writeFileSync(join(dir, "notes.md"), "openLedger(db)\n", "utf8");
      writeFileSync(join(dir, "schema.sql"), "select 1;\n", "utf8");
      const result = await run(buildAstGrepTool({ cwd: dir, walk: piWalk(dir) }), {
        pattern: "openLedger($$$A)",
      });
      const out = textOf(result);
      assert.match(out, /^No matches found\./m);
      // The Markdown file contains the text a grep would have hit. Saying
      // "no matches" without saying "and I never opened these two" is the
      // proof-of-absence failure D4 exists to prevent.
      assert.match(out, /Skipped 2 files whose language is not inferable/);
      assert.match(out, /notes\.md, schema\.sql/);
      assert.equal(result.details?.filesSkipped, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a pattern that compiles for no language in scope instead of reporting absence", async () => {
    const dir = tmp("lykos-p104-astgrep-bad-");
    try {
      writeFileSync(join(dir, "a.ts"), "const x = 1;\n", "utf8");
      await assert.rejects(
        () => run(buildAstGrepTool({ cwd: dir, walk: piWalk(dir) }), { pattern: "$$$" }),
        /did not compile for any language/,
      );
      await assert.rejects(
        () => run(buildAstGrepTool({ cwd: dir, walk: piWalk(dir) }), { pattern: "   " }),
        /pattern is empty/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops at the limit and says so", async () => {
    const dir = tmp("lykos-p104-astgrep-limit-");
    try {
      writeFileSync(join(dir, "a.ts"), "foo(1);\nfoo(2);\nfoo(3);\n", "utf8");
      const result = await run(buildAstGrepTool({ cwd: dir, walk: piWalk(dir) }), {
        pattern: "foo($A)",
        limit: 2,
      });
      assert.match(textOf(result), /Stopped at the 2-match limit/);
      assert.equal(result.details?.matchCount, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("searches a file the grammar could not parse, and names it as under-reported", async () => {
    const dir = tmp("lykos-p104-astgrep-broken-");
    try {
      writeFileSync(join(dir, "broken.ts"), "foo(1);\nfunction ( {{{\n", "utf8");
      const out = textOf(await run(buildAstGrepTool({ cwd: dir, walk: piWalk(dir) }), { pattern: "foo($A)" }));
      // A partial search is still evidence, so the match is reported — but
      // the file is named so "one match" is not read as "exactly one".
      assert.match(out, /^1: foo\(1\);$/m);
      assert.match(out, /did not parse cleanly and may be under-reported: broken\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P10.4 D7, as amended by T168: an ast_grep result is headed by the file's path", () => {
  it("prints a bare [path] header, with no tag", async () => {
    const dir = tmp("lykos-p104-astgrep-notag-");
    try {
      writeFileSync(join(dir, "a.ts"), "foo(1);\n", "utf8");
      const out = textOf(await run(buildAstGrepTool({ cwd: dir, walk: piWalk(dir) }), { pattern: "foo($A)" }));
      assert.equal(out.split("\n")[0], "[a.ts]");
      assert.doesNotMatch(out, /#[0-9A-F]{4}\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an edit follows an ast_grep with the text the search printed", async () => {
    const dir = tmp("lykos-p104-astgrep-edit-");
    try {
      const file = join(dir, "target.ts");
      writeFileSync(file, "openLedger(\n  db,\n);\n", "utf8");
      const out = textOf(await run(buildAstGrepTool({ cwd: dir, walk: piWalk(dir) }), { pattern: "openLedger($$$A)" }));
      assert.match(out, /openLedger\(/);

      const edit = buildEditTool({ cwd: dir, gate: new AutoApproveGate() });
      const applied = await run(edit, {
        path: "target.ts",
        edits: [{ oldText: "openLedger(\n  db,\n);", newText: "openLedger(db);" }],
      });
      assert.notEqual(applied.isError, true);
      assert.equal(readFileSync(file, "utf8"), "openLedger(db);\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P10.4: the footer is the part that keeps a search honest", () => {
  const empty = {
    cwd: "/repo",
    files: [],
    skipped: [],
    unparsed: [],
    patternIssues: [],
    capped: false,
    limitReached: false,
    limit: 50,
  };

  it("says a file cap stopped the scan, so 'no matches' is not read as 'searched everything'", () => {
    const out = renderAstGrepResult({ ...empty, capped: true });
    assert.match(out, /^No matches found\./m);
    assert.match(out, /Stopped at the file cap/m);
  });

  it("carries a pattern that did not compile for a language present in the scope", () => {
    const out = renderAstGrepResult({ ...empty, patternIssues: ["Not searched as Css: nope"] });
    assert.match(out, /Not searched as Css: nope/);
  });

  it("collapses a multi-line capture onto the meta line rather than breaking the layout", () => {
    const out = renderAstGrepResult({
      ...empty,
      files: [
        {
          display: "a.ts",
          source: "foo(\n  a,\n  b\n)",
          matches: [
            {
              start: 0,
              end: 15,
              startLine: 1,
              endLine: 4,
              text: "foo(\n  a,\n  b\n)",
              captures: [{ name: "A", multiple: true, text: "a,\n  b" }],
            },
          ],
        },
      ],
    });
    assert.match(out, /meta: A=a, b$/m);
    assert.match(out, /^1 match in 1 file\.$/m);
  });
});

describe("P10.4: ast_grep is a read, and reaches no gate", () => {
  it("is declared read-tier, and a tool_call to it is tiered as a read", () => {
    assert.equal(tierForTool(AST_GREP_TOOL_NAME), "read");
    assert.deepEqual(riskForTool(AST_GREP_TOOL_NAME), { tier: "read", idempotent: true, openWorld: false });
    // The transport must not launder the tier: `tool_call` is `hard-write`
    // itself, and what it is tiered on is the tool it is dispatching to.
    assert.equal(tierForToolCall("tool_call", { name: AST_GREP_TOOL_NAME, arguments: {} }), "read");
  });

  it("runs to completion with no gate in reach, the same answer grep and read already have", async () => {
    const dir = tmp("lykos-p104-astgrep-ungated-");
    try {
      writeFileSync(join(dir, "a.ts"), "foo(1);\n", "utf8");
      // `AstGrepOpts` has no `gate` field, so there is no approval path to
      // take by accident; this is the behavioural half of that — a full
      // search with nothing to ask and nobody to ask it.
      const out = textOf(await run(buildAstGrepTool({ cwd: dir, walk: piWalk(dir) }), { pattern: "foo($A)" }));
      assert.match(out, /^1 match in 1 file\.$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P10.4: the walk is injectable only so a test need not shell out", () => {
  it("uses the walk it was given", async () => {
    const dir = tmp("lykos-p104-astgrep-walk-");
    try {
      const file = join(dir, "a.ts");
      writeFileSync(file, "foo(1);\n", "utf8");
      const walk: AstWalk = async () => [file];
      const out = textOf(await run(buildAstGrepTool({ cwd: dir, walk }), { pattern: "foo($A)" }));
      assert.match(out, /^1: foo\(1\);$/m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports nothing found over an empty scope without pretending it searched", async () => {
    const dir = tmp("lykos-p104-astgrep-none-");
    try {
      mkdirSync(join(dir, "empty"));
      const out = textOf(
        await run(buildAstGrepTool({ cwd: dir, walk: piWalk(dir) }), { pattern: "foo($A)", path: "empty" }),
      );
      assert.match(out, /^No matches found\./m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
