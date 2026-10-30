// T168 (ADR-0031): `edit-match.ts` is a port of Pi's matching, so the proof that
// it is a faithful one is a differential test — the same call run through Pi's
// own `edit` and through Lykos's, on the same bytes, comparing what lands on
// disk, what the model is told and what the interface renders. `replaceAll`,
// which Pi does not have, is tested on its own below.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { AutoApproveGate } from "../gate/approval.js";
import { buildEditTool } from "./edit.js";
import { applyEditsToNormalizedContent, prepareEditArguments, type TextEdit } from "./edit-match.js";

interface Outcome {
  error?: string;
  text?: string | undefined;
  diff?: string;
  firstChangedLine?: number;
  file: string;
}

type Exec = (id: string, input: unknown, signal?: AbortSignal) => Promise<{ content: Array<{ text?: string }>; details?: { diff?: string; firstChangedLine?: number } }>;

async function run(tool: { prepareArguments?: (a: unknown) => unknown; execute: unknown }, dir: string, content: string, args: unknown): Promise<Outcome> {
  const file = resolve(dir, "a.ts");
  writeFileSync(file, content);
  try {
    const prepared = tool.prepareArguments ? tool.prepareArguments(structuredClone(args)) : args;
    const result = await (tool.execute as Exec)("c1", prepared);
    return {
      text: result.content[0]?.text,
      ...(result.details?.diff !== undefined ? { diff: result.details.diff } : {}),
      ...(result.details?.firstChangedLine !== undefined ? { firstChangedLine: result.details.firstChangedLine } : {}),
      file: readFileSync(file, "utf8"),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err), file: readFileSync(file, "utf8") };
  }
}

/** The same call through Pi's tool and Lykos's, in two directories holding the same file. */
async function bothWays(content: string, args: unknown): Promise<{ pi: Outcome; lykos: Outcome }> {
  const piDir = mkdtempSync(resolve(tmpdir(), "lykos-edit-pi-"));
  const lykosDir = mkdtempSync(resolve(tmpdir(), "lykos-edit-lykos-"));
  const pi = await run(createEditToolDefinition(piDir) as never, piDir, content, args);
  const lykos = await run(buildEditTool({ cwd: lykosDir, gate: new AutoApproveGate() }) as never, lykosDir, content, args);
  return { pi, lykos };
}

const e = (oldText: string, newText: string): { oldText: string; newText: string } => ({ oldText, newText });

/** Every case here is one Pi's `edit` handles; Lykos's must answer it identically. */
const PI_CASES: Array<{ name: string; content: string; args: Record<string, unknown> }> = [
  { name: "one exact replacement", content: "one\ntwo\nthree\n", args: { path: "a.ts", edits: [e("two", "TWO")] } },
  {
    name: "several disjoint replacements, matched against the original",
    content: "a\nb\nc\nd\n",
    args: { path: "a.ts", edits: [e("d", "D"), e("a", "A"), e("c", "C")] },
  },
  { name: "text that is not there (one edit)", content: "one\n", args: { path: "a.ts", edits: [e("nope", "x")] } },
  { name: "text that is not there (several edits)", content: "one\ntwo\n", args: { path: "a.ts", edits: [e("one", "1"), e("nope", "x")] } },
  { name: "text that occurs twice (one edit)", content: "x\nx\n", args: { path: "a.ts", edits: [e("x", "y")] } },
  { name: "text that occurs twice (several edits)", content: "a\nx\nx\n", args: { path: "a.ts", edits: [e("a", "b"), e("x", "y")] } },
  { name: "an empty oldText (one edit)", content: "one\n", args: { path: "a.ts", edits: [e("", "x")] } },
  { name: "an empty oldText (several edits)", content: "one\ntwo\n", args: { path: "a.ts", edits: [e("one", "1"), e("", "x")] } },
  { name: "overlapping edits", content: "abcdef\n", args: { path: "a.ts", edits: [e("abcd", "X"), e("cdef", "Y")] } },
  { name: "nested edits", content: "abcdef\n", args: { path: "a.ts", edits: [e("abcdef", "X"), e("cd", "Y")] } },
  { name: "adjacent, non-overlapping edits", content: "abcdef\n", args: { path: "a.ts", edits: [e("abc", "X"), e("def", "Y")] } },
  { name: "a replacement that changes nothing (one edit)", content: "one\n", args: { path: "a.ts", edits: [e("one", "one")] } },
  { name: "a replacement that changes nothing (several edits)", content: "a\nb\n", args: { path: "a.ts", edits: [e("a", "a"), e("b", "b")] } },
  {
    name: "fuzzy: trailing whitespace in the file that oldText lacks",
    content: "const a = 1;   \nconst b = 2;\n",
    args: { path: "a.ts", edits: [e("const a = 1;\nconst b = 2;", "const a = 10;\nconst b = 20;")] },
  },
  {
    name: "fuzzy: smart quotes in the file, ASCII in oldText",
    content: "say(“hello”);\nother();   \n",
    args: { path: "a.ts", edits: [e('say("hello");', 'say("bye");')] },
  },
  {
    name: "fuzzy: an en dash in the file, a hyphen in oldText, other lines keep their own whitespace",
    content: "keep   \nrange 1–2\nkeep too\t\n",
    args: { path: "a.ts", edits: [e("range 1-2", "range 3-4")] },
  },
  {
    name: "fuzzy plus exact in one call",
    content: "alpha  \nbeta\ngamma\n",
    args: { path: "a.ts", edits: [e("alpha", "ALPHA"), e("gamma", "GAMMA")] },
  },
  {
    name: "unique exactly but not after normalization, so not unique",
    content: "foo\nfoo  \n",
    args: { path: "a.ts", edits: [e("foo\n", "bar\n")] },
  },
  { name: "a CRLF file edited with LF oldText", content: "one\r\ntwo\r\nthree\r\n", args: { path: "a.ts", edits: [e("two", "TWO\nEXTRA")] } },
  { name: "a CRLF oldText against an LF file", content: "one\ntwo\n", args: { path: "a.ts", edits: [e("one\r\ntwo", "1\r\n2")] } },
  { name: "a BOM that the model cannot see", content: "﻿one\ntwo\n", args: { path: "a.ts", edits: [e("one", "ONE")] } },
  { name: "a CRLF file with a BOM", content: "﻿one\r\ntwo\r\n", args: { path: "a.ts", edits: [e("two", "2")] } },
  { name: "no trailing newline in the file", content: "one\ntwo", args: { path: "a.ts", edits: [e("two", "TWO")] } },
  { name: "a deletion", content: "keep\ndrop\nkeep\n", args: { path: "a.ts", edits: [e("drop\n", "")] } },
  { name: "edits sent as a JSON string", content: "one\ntwo\n", args: { path: "a.ts", edits: JSON.stringify([e("two", "2")]) } },
  { name: "edits sent as one object", content: "one\ntwo\n", args: { path: "a.ts", edits: e("two", "2") } },
  { name: "legacy top-level oldText/newText", content: "one\ntwo\n", args: { path: "a.ts", oldText: "two", newText: "2" } },
  {
    name: "legacy top-level oldText/newText beside edits[]",
    content: "one\ntwo\nthree\n",
    args: { path: "a.ts", edits: [e("one", "1")], oldText: "three", newText: "3" },
  },
  { name: "an empty edits array", content: "one\n", args: { path: "a.ts", edits: [] } },
  { name: "no edits at all", content: "one\n", args: { path: "a.ts" } },
  { name: "a file that does not exist", content: "one\n", args: { path: "missing.ts", edits: [e("one", "1")] } },
];

describe("T168: Lykos's edit answers every Pi edit case the way Pi does (differential)", () => {
  for (const c of PI_CASES) {
    it(c.name, async () => {
      const { pi, lykos } = await bothWays(c.content, c.args);
      // Pi names the file in some messages: both ran against `a.ts`, so the text is comparable.
      assert.deepEqual(lykos, pi);
    });
  }
});

describe("applyEditsToNormalizedContent: Pi's wording, pinned", () => {
  const apply = (content: string, edits: TextEdit[]) => applyEditsToNormalizedContent(content, edits, "f.ts");

  it("names the single-edit and the indexed forms of each error", () => {
    assert.throws(() => apply("a\n", [e("zz", "y")]), /^Error: Could not find the exact text in f\.ts\. The old text must match exactly including all whitespace and newlines\.$/);
    assert.throws(() => apply("a\n", [e("a", "b"), e("zz", "y")]), /Could not find edits\[1\] in f\.ts\. The oldText must match exactly/);
    assert.throws(() => apply("x x\n", [e("x", "y")]), /Found 2 occurrences of the text in f\.ts\. The text must be unique\. Please provide more context to make it unique\./);
    assert.throws(() => apply("x x a\n", [e("a", "b"), e("x", "y")]), /Found 2 occurrences of edits\[1\] in f\.ts\. Each oldText must be unique\./);
    assert.throws(() => apply("a\n", [e("", "y")]), /^Error: oldText must not be empty in f\.ts\.$/);
    assert.throws(() => apply("ab\n", [e("a", "1"), e("", "y")]), /edits\[1\]\.oldText must not be empty in f\.ts\./);
    assert.throws(() => apply("abc\n", [e("ab", "1"), e("bc", "2")]), /edits\[0\] and edits\[1\] overlap in f\.ts\. Merge them into one edit or target disjoint regions\./);
    assert.throws(() => apply("a\n", [e("a", "a")]), /No changes made to f\.ts\. The replacement produced identical content\. This might indicate/);
    assert.throws(() => apply("a\nb\n", [e("a", "a"), e("b", "b")]), /No changes made to f\.ts\. The replacements produced identical content\./);
  });

  it("matches exactly first, and only then folds whitespace and quotes", () => {
    assert.equal(apply("a  \nb\n", [e("a\nb", "X")]).newContent, "X\n");
    // The unchanged line keeps its own trailing whitespace; only the touched lines are rewritten from the normalized view.
    assert.equal(apply("keep  \ntouch  \nnext\n", [e("touch\nnext", "T")]).newContent, "keep  \nT\n");
    // An exact match is a plain replacement: nothing around it is normalized.
    assert.equal(apply("keep  \ntouch  \n", [e("touch", "T")]).newContent, "keep  \nT  \n");
  });
});

describe("replaceAll (ADR-0031 decision 9)", () => {
  const apply = (content: string, edits: TextEdit[]) => applyEditsToNormalizedContent(content, edits, "f.ts");
  const all = (oldText: string, newText: string): TextEdit => ({ oldText, newText, replaceAll: true });

  it("replaces every occurrence and counts them", () => {
    const r = apply("foo bar foo\nfoo\n", [all("foo", "baz")]);
    assert.equal(r.newContent, "baz bar baz\nbaz\n");
    assert.equal(r.replacements, 3);
    assert.deepEqual(r.perEdit, [3]);
    assert.equal(r.anyReplaceAll, true);
  });

  it("accepts a single occurrence, which a plain edit would also accept", () => {
    assert.equal(apply("one\n", [all("one", "1")]).replacements, 1);
  });

  it("is an error when the text is not there, with no quiet no-op", () => {
    assert.throws(() => apply("one\n", [all("two", "2")]), /Could not find the exact text in f\.ts\..*replaceAll matches exact text only/);
    assert.throws(() => apply("one\ntwo\n", [e("one", "1"), all("zz", "2")]), /Could not find edits\[1\] in f\.ts\..*replaceAll matches exact text only/);
  });

  it("matches exact text only: no whitespace or quote folding", () => {
    assert.throws(() => apply("foo  \nfoo  \n", [all("foo\nfoo", "x")]), /replaceAll matches exact text only/);
    assert.throws(() => apply("say(“x”)\n", [all('say("x")', "y")]), /replaceAll matches exact text only/);
  });

  it("does not require uniqueness, and does not apply the normalized-space count that a plain edit uses", () => {
    // `foo` occurs once with trailing whitespace and once without: a plain edit calls that two matches and refuses it, replaceAll just replaces both.
    const r = apply("foo\nfoo  \n", [all("foo", "x")]);
    assert.equal(r.newContent, "x\nx  \n");
  });

  it("does not match occurrences that overlap each other", () => {
    // "aa" in "aaaa": two non-overlapping hits, not three.
    assert.equal(apply("aaaa\n", [all("aa", "b")]).newContent, "bb\n");
  });

  it("applies the overlap rule against every other entry", () => {
    // The plain entry sits inside one of the three `foo` hits.
    assert.throws(() => apply("foo(foo)\n", [all("foo", "x"), e("o(f", "y")]), /edits\[0\] and edits\[1\] overlap in f\.ts/);
  });

  it("composes with plain entries that do not touch it", () => {
    const r = apply("a foo b foo\nc\n", [all("foo", "F"), e("c", "C")]);
    assert.equal(r.newContent, "a F b F\nC\n");
    assert.equal(r.replacements, 3);
    assert.deepEqual(r.perEdit, [2, 1]);
  });

  it("refuses to mix with an entry that needed the fuzzy fallback, and says how to split the call", () => {
    assert.throws(
      () => apply("a  \nfoo\nfoo\n", [e("a", "A"), all("foo", "x"), e("a\nfoo", "z")]),
      /edits\[2\] in f\.ts only matches after whitespace or quote folding.*own call\. Nothing was written\./,
    );
  });

  it("an identical replacement is still a no-change error", () => {
    assert.throws(() => apply("foo foo\n", [all("foo", "foo")]), /No changes made to f\.ts\./);
  });

  it("an empty oldText is refused before anything is searched for", () => {
    assert.throws(() => apply("foo\n", [all("", "x")]), /oldText must not be empty in f\.ts\./);
  });
});

describe("prepareEditArguments", () => {
  it("is Pi's repair, unchanged, for the edits[] shapes", () => {
    assert.deepEqual(prepareEditArguments({ path: "a", edits: JSON.stringify([e("o", "n")]) }), { path: "a", edits: [e("o", "n")] });
    assert.deepEqual(prepareEditArguments({ path: "a", edits: e("o", "n") }), { path: "a", edits: [e("o", "n")] });
    assert.deepEqual(prepareEditArguments({ path: "a", oldText: "o", newText: "n" }), { path: "a", edits: [e("o", "n")] });
    assert.deepEqual(prepareEditArguments({ path: "a", edits: [e("1", "2")], oldText: "o", newText: "n" }), {
      path: "a",
      edits: [e("1", "2"), e("o", "n")],
    });
    assert.equal(prepareEditArguments(undefined), undefined);
    assert.equal(prepareEditArguments("x"), "x");
  });

  it("turns the old_string shape into one edits[] entry", () => {
    assert.deepEqual(prepareEditArguments({ path: "a.ts", old_string: "o", new_string: "n" }), {
      path: "a.ts",
      edits: [{ oldText: "o", newText: "n" }],
    });
  });

  it("carries replace_all across as replaceAll, and only when it is true", () => {
    assert.deepEqual(prepareEditArguments({ path: "a.ts", old_string: "o", new_string: "n", replace_all: true }), {
      path: "a.ts",
      edits: [{ oldText: "o", newText: "n", replaceAll: true }],
    });
    assert.deepEqual(prepareEditArguments({ path: "a.ts", old_string: "o", new_string: "n", replace_all: false }), {
      path: "a.ts",
      edits: [{ oldText: "o", newText: "n" }],
    });
  });

  it("accepts an empty new_string, which is a deletion", () => {
    assert.deepEqual(prepareEditArguments({ path: "a.ts", old_string: "o", new_string: "" }), {
      path: "a.ts",
      edits: [{ oldText: "o", newText: "" }],
    });
  });

  it("takes file_path for path when path is absent", () => {
    assert.deepEqual(prepareEditArguments({ file_path: "a.ts", old_string: "o", new_string: "n" }), {
      path: "a.ts",
      edits: [{ oldText: "o", newText: "n" }],
    });
  });

  it("rejects a mix of the two shapes instead of guessing which was meant", () => {
    const mixed = /both the old_string shape \((old_string|new_string|replace_all)[^)]*\) and the edits\[\] shape/;
    assert.throws(() => prepareEditArguments({ path: "a", edits: [e("o", "n")], old_string: "o", new_string: "n" }), mixed);
    assert.throws(() => prepareEditArguments({ path: "a", oldText: "o", newText: "n", old_string: "o", new_string: "n" }), mixed);
    assert.throws(() => prepareEditArguments({ path: "a", edits: [e("o", "n")], replace_all: true }), mixed);
  });

  it("rejects a half-given old_string shape with a message that says what is missing", () => {
    assert.throws(() => prepareEditArguments({ path: "a", old_string: "o" }), /needs both old_string and new_string/);
    assert.throws(() => prepareEditArguments({ path: "a", old_string: "o", new_string: "n", replace_all: "yes" }), /replace_all must be true or false/);
  });
});
