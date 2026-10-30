// T168 (ADR-0031, decision 7): `read` numbers every text line, `cat -n` style,
// and leaves everything else of Pi's read alone. The strongest check is the
// differential one: with the numbers stripped back off, Lykos's output must
// be Pi's output, byte for byte, for every shape of read.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { measureToolset } from "../ledger/tool-schema.js";
import { READ_NUMBERING_GUIDELINE, READ_NUMBERING_NOTE, buildReadTool, numberReadText, numberedLine } from "./read.js";

interface ExecResult {
  content: Array<{ type?: string; text?: string }>;
  details?: unknown;
  isError?: boolean;
}

type AnyTool = { execute: (id: string, p: unknown, s?: unknown, u?: unknown, c?: unknown) => Promise<ExecResult> };

function fixture(): { dir: string; read: (p: unknown) => Promise<ExecResult>; pi: (p: unknown) => Promise<ExecResult> } {
  const dir = mkdtempSync(resolve(tmpdir(), "lykos-read-"));
  const ours = buildReadTool({ cwd: dir }) as unknown as AnyTool;
  const pi = createReadToolDefinition(dir) as unknown as AnyTool;
  return {
    dir,
    read: (p) => ours.execute("c1", p),
    pi: (p) => pi.execute("c1", p),
  };
}

const text = (r: ExecResult): string => r.content[0]?.text ?? "";

/** The prefix is `padStart(6)`, a tab: strip one off the front of every line. */
const strip = (s: string): string => s.replace(/^ {0,5}\d+\t/gm, "");

const lines = (n: number, make: (i: number) => string = (i) => `line ${i}`): string =>
  Array.from({ length: n }, (_, i) => make(i + 1)).join("\n");

describe("the numbering", () => {
  it("numbers each line right-aligned in six columns, then a tab", async () => {
    const f = fixture();
    writeFileSync(resolve(f.dir, "a.ts"), "alpha\nbeta\ngamma\n");
    assert.equal(text(await f.read({ path: "a.ts" })), "     1\talpha\n     2\tbeta\n     3\tgamma\n");
  });

  it("matches cat -n's shape past nine lines", async () => {
    const f = fixture();
    writeFileSync(resolve(f.dir, "a.txt"), `${lines(12)}\n`);
    const out = text(await f.read({ path: "a.txt" }));
    assert.match(out, /^ {5}1\tline 1\n/);
    assert.match(out, /\n {4}10\tline 10\n {4}11\tline 11\n {4}12\tline 12\n$/);
  });

  it("does not number the phantom line after a final newline, and keeps the newline", async () => {
    const f = fixture();
    writeFileSync(resolve(f.dir, "a.txt"), "one\ntwo\n");
    assert.equal(text(await f.read({ path: "a.txt" })), "     1\tone\n     2\ttwo\n");
  });

  it("numbers the last line of a file with no trailing newline, and adds none", async () => {
    const f = fixture();
    writeFileSync(resolve(f.dir, "a.txt"), "one\ntwo");
    assert.equal(text(await f.read({ path: "a.txt" })), "     1\tone\n     2\ttwo");
  });

  it("numbers blank lines, including a real blank last line", async () => {
    const f = fixture();
    writeFileSync(resolve(f.dir, "a.txt"), "one\n\n\ntwo\n\n");
    assert.equal(text(await f.read({ path: "a.txt" })), "     1\tone\n     2\t\n     3\t\n     4\ttwo\n     5\t\n");
  });

  it("returns an empty file as empty, because cat -n has no line to number", async () => {
    const f = fixture();
    writeFileSync(resolve(f.dir, "empty.txt"), "");
    assert.equal(text(await f.read({ path: "empty.txt" })), "");
  });

  it("keeps a line's own tabs and carriage returns untouched", async () => {
    const f = fixture();
    writeFileSync(resolve(f.dir, "a.txt"), "\tindented\r\nplain\r\n");
    assert.equal(text(await f.read({ path: "a.txt" })), "     1\t\tindented\r\n     2\tplain\r\n");
  });

  it("starts at the offset it was given", async () => {
    const f = fixture();
    writeFileSync(resolve(f.dir, "a.txt"), `${lines(20)}\n`);
    const out = text(await f.read({ path: "a.txt", offset: 15 }));
    assert.match(out, /^ {4}15\tline 15\n {4}16\tline 16\n/);
    assert.match(out, /\n {4}20\tline 20\n$/);
  });

  it("treats offset 0 and a negative offset as line 1, as Pi does", async () => {
    const f = fixture();
    writeFileSync(resolve(f.dir, "a.txt"), "one\ntwo\n");
    assert.equal(text(await f.read({ path: "a.txt", offset: 0 })), "     1\tone\n     2\ttwo\n");
    assert.equal(text(await f.read({ path: "a.txt", offset: -3 })), "     1\tone\n     2\ttwo\n");
  });
});

describe("Pi's trailing notices stay unnumbered and unchanged", () => {
  it("a limit that stops early: the more-lines notice follows the numbered lines", async () => {
    const f = fixture();
    writeFileSync(resolve(f.dir, "a.txt"), `${lines(50)}\n`);
    const out = text(await f.read({ path: "a.txt", offset: 10, limit: 5 }));
    assert.equal(
      out,
      "    10\tline 10\n    11\tline 11\n    12\tline 12\n    13\tline 13\n    14\tline 14\n\n[37 more lines in file. Use offset=15 to continue.]",
    );
  });

  it("the 2000-line cap: the showing-lines notice follows, from line 1", async () => {
    const f = fixture();
    writeFileSync(resolve(f.dir, "big.txt"), `${lines(2500)}\n`);
    const out = text(await f.read({ path: "big.txt" }));
    assert.match(out, /^ {5}1\tline 1\n/);
    assert.match(out, / 2000\tline 2000\n\n\[Showing lines 1-2000 of 2501\. Use offset=2001 to continue\.\]$/);
    assert.equal((out.match(/\[Showing lines/g) ?? []).length, 1);
  });

  it("the 2000-line cap with an offset: numbers continue from the offset", async () => {
    const f = fixture();
    writeFileSync(resolve(f.dir, "big.txt"), `${lines(5000)}\n`);
    const out = text(await f.read({ path: "big.txt", offset: 100 }));
    assert.match(out, /^ {3}100\tline 100\n/);
    assert.match(out, / 2099\tline 2099\n\n\[Showing lines 100-2099 of 5001\. Use offset=2100 to continue\.\]$/);
  });

  it("the 50KB cap: the size notice follows the numbered lines", async () => {
    const f = fixture();
    writeFileSync(resolve(f.dir, "wide.txt"), `${lines(400, (i) => `${i}:${"x".repeat(300)}`)}\n`);
    const out = text(await f.read({ path: "wide.txt" }));
    assert.match(out, /\n\n\[Showing lines 1-\d+ of 401 \(50\.0KB limit\)\. Use offset=\d+ to continue\.\]$/);
    assert.match(out, /^ {5}1\t1:x{300}\n {5}2\t2:x{300}\n/);
  });

  it("a first line larger than the limit: Pi's notice only, no numbers", async () => {
    const f = fixture();
    writeFileSync(resolve(f.dir, "one-line.txt"), `${"y".repeat(60 * 1024)}\n`);
    const mine = text(await f.read({ path: "one-line.txt" }));
    assert.match(mine, /^\[Line 1 is 60\.0KB, exceeds 50\.0KB limit\. Use bash: sed -n '1p' one-line\.txt \| head -c 51200\]$/);
    assert.equal(mine, text(await f.pi({ path: "one-line.txt" })));
  });

  it("an offset past the end: Pi's error, unchanged", async () => {
    const f = fixture();
    writeFileSync(resolve(f.dir, "a.txt"), "one\n");
    await assert.rejects(f.read({ path: "a.txt", offset: 99 }), /Offset 99 is beyond end of file/);
  });

  it("a file whose last line looks like the notice is not mistaken for one", async () => {
    const f = fixture();
    writeFileSync(resolve(f.dir, "a.txt"), "one\n\n[5 more lines in file. Use offset=9 to continue.]");
    assert.equal(
      text(await f.read({ path: "a.txt" })),
      "     1\tone\n     2\t\n     3\t[5 more lines in file. Use offset=9 to continue.]",
    );
  });
});

describe("with the numbers stripped back off, the output is Pi's, for every shape of read", () => {
  const cases: Array<{ name: string; content: string; args: Record<string, unknown> }> = [
    { name: "a small file", content: "alpha\nbeta\n", args: {} },
    { name: "no trailing newline", content: "alpha\nbeta", args: {} },
    { name: "a double trailing newline", content: "alpha\n\n", args: {} },
    { name: "an empty file", content: "", args: {} },
    { name: "a single newline", content: "\n", args: {} },
    { name: "an offset", content: `${lines(30)}\n`, args: { offset: 12 } },
    { name: "an offset that is the last line", content: "a\nb\nc", args: { offset: 3 } },
    { name: "an offset on the phantom line", content: "a\nb\n", args: { offset: 3 } },
    { name: "a limit that stops early", content: `${lines(30)}\n`, args: { limit: 7 } },
    { name: "a limit past the end", content: `${lines(5)}\n`, args: { limit: 100 } },
    { name: "a limit that lands on the last real line", content: "a\nb\n", args: { limit: 2 } },
    { name: "an offset and a limit", content: `${lines(30)}\n`, args: { offset: 5, limit: 3 } },
    { name: "a blank line in the window", content: "a\n\nb\n\nc\n", args: { offset: 2, limit: 2 } },
    { name: "the line cap", content: `${lines(2600)}\n`, args: {} },
    { name: "the line cap with an offset", content: `${lines(2600)}\n`, args: { offset: 300 } },
    { name: "the byte cap", content: `${lines(300, (i) => `${i}${"z".repeat(400)}`)}\n`, args: {} },
    { name: "a limit larger than the line cap", content: `${lines(2600)}\n`, args: { limit: 2500 } },
    { name: "CRLF line endings", content: "a\r\nb\r\nc\r\n", args: {} },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const f = fixture();
      writeFileSync(resolve(f.dir, "f.txt"), c.content);
      const params = { path: "f.txt", ...c.args };
      const mine = await f.read(params);
      const pi = await f.pi(params);
      assert.equal(strip(text(mine)), text(pi));
      // Pi's details (the truncation record the interface renders) are passed through untouched.
      assert.deepEqual(mine.details, pi.details);
    });
  }
});

describe("what gets no numbers", () => {
  it("a directory: Pi's own error, unchanged", async () => {
    const f = fixture();
    mkdirSync(resolve(f.dir, "sub"));
    await assert.rejects(f.read({ path: "sub" }), /EISDIR/);
  });

  it("a file that is not there: Pi's own error, unchanged", async () => {
    const f = fixture();
    await assert.rejects(f.read({ path: "missing.ts" }), /ENOENT/);
  });

  it("an image: the note and the attachment, exactly as Pi returns them", async () => {
    const f = fixture();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(resolve(f.dir, "dot.png"), png);
    const mine = await f.read({ path: "dot.png" });
    const pi = await f.pi({ path: "dot.png" });
    assert.deepEqual(mine.content.map((c) => c.type), ["text", "image"]);
    assert.deepEqual(mine, pi);
    assert.match(text(mine), /^Read image file \[image\/png\]/);
  });

  it("an image that cannot be processed: Pi's single-block note, unnumbered", () => {
    // Pi describes a failed resize in one text block; it has no file lines, so it must pass through.
    assert.equal(numberReadText("Read image file [image/png]\nCould not resize", {}, undefined), undefined);
  });
});

describe("numberReadText", () => {
  it("leaves a truncation record that does not describe the text alone", () => {
    assert.equal(numberReadText("body", {}, { truncated: true, content: "not a prefix" }), undefined);
  });

  it("does not take a more-lines notice at face value when the offset arithmetic disagrees", () => {
    // limit 2 from line 1 means a genuine notice says offset=3; this one says 999, so it is file content.
    const fake = "[3 more lines in file. Use offset=999 to continue.]";
    assert.equal(numberReadText(`a
b

${fake}`, { limit: 2 }, undefined), `     1	a
     2	b
     3	
     4	${fake}`);
  });

  it("formats one line", () => {
    assert.equal(numberedLine(7, "const x = 1;"), "     7\tconst x = 1;");
    assert.equal(numberedLine(1234567, "x"), "1234567\tx");
  });
});

describe("the wrapper is Pi's read otherwise", () => {
  it("has a byte-identical schema, so offset and limit are exactly Pi's", () => {
    const base = createReadToolDefinition(process.cwd());
    const wrapped = buildReadTool({ cwd: process.cwd() });
    assert.equal(wrapped.parameters, base.parameters);
  });

  it("keeps Pi's name, label and prompt snippet", () => {
    const base = createReadToolDefinition(process.cwd()) as unknown as Record<string, unknown>;
    const wrapped = buildReadTool({ cwd: process.cwd() }) as unknown as Record<string, unknown>;
    for (const key of ["name", "label", "promptSnippet"]) assert.equal(wrapped[key], base[key], key);
  });

  it("tells the model the prefix is not file content, in the description and the guidelines", () => {
    const base = createReadToolDefinition(process.cwd());
    const wrapped = buildReadTool({ cwd: process.cwd() });
    assert.equal(wrapped.description, `${base.description}${READ_NUMBERING_NOTE}`);
    assert.match(wrapped.description, /not part of the file; never copy them into edit/);
    assert.deepEqual(wrapped.promptGuidelines, [...(base.promptGuidelines ?? []), READ_NUMBERING_GUIDELINE]);
    assert.match(READ_NUMBERING_GUIDELINE, /never include them in edit's oldText/);
  });

  it("is priced by the catalog's `read` row, which says the same thing", () => {
    const wrapped = buildReadTool({ cwd: process.cwd() });
    assert.equal(TOOL_CATALOG.read!.description, wrapped.description);
    assert.equal(TOOL_CATALOG.read!.source, "lykos");
    assert.equal(measureToolset(["read"]).complete, true);
  });
});
