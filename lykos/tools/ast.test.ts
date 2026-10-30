// The seam the two AST tools share.
//
// Two of these tests exist because the plan's D2 says they must: the
// separator case, where joining captured node texts loses the space in
// `console.log(1, 2)`, and the unknown-language case, where a file that is
// skipped has to be NAMED rather than dropped. Both are failure modes that
// pass every type check and every smoke test and are wrong on disk, so they
// are pinned against the real `@ast-grep/napi` and the real walker rather
// than against a stand-in that would agree with whatever this module does.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Lang } from "@ast-grep/napi";
import {
  AST_MAX_LISTED_SKIPS,
  AST_SUPPORTED_EXTENSIONS,
  AstPatternError,
  applyEdits,
  displayPath,
  hasParseError,
  languageForPath,
  metavariablesIn,
  overlapProblems,
  piWalk,
  renderSkipped,
  resolveScope,
  rewriteProblems,
  scanFiles,
  searchSource,
  substitute,
  toLF,
  type AstWalk,
  type PlannedEdit,
} from "./ast.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("P10.4 D2: a multi-node capture keeps the separators the source had", () => {
  it("reads $$$ARGS as a source slice, not as joined node text", () => {
    const source = "console.log(1, 2);\n";
    const matches = searchSource(Lang.JavaScript, source, "console.log($$$ARGS)");
    assert.equal(matches.length, 1);
    const args = matches[0]!.captures.find((c) => c.name === "ARGS");
    assert.ok(args);
    assert.equal(args.multiple, true);
    // The trap: `getMultipleMatches("ARGS")` returns the nodes `1`, `,` and
    // `2`, and joining their `.text()` gives "1,2". The space is the thing
    // this assertion exists for.
    assert.equal(args.text, "1, 2");
    assert.notEqual(args.text, "1,2");
  });

  it("keeps newlines and indentation inside a capture that spans lines", () => {
    const source = "foo(\n  alpha,\n  beta,\n);\n";
    const [match] = searchSource(Lang.TypeScript, source, "foo($$$A)");
    assert.ok(match);
    assert.equal(match.captures.find((c) => c.name === "A")?.text, "alpha,\n  beta,");
  });

  it("an empty $$$ capture is empty text, not a missing capture", () => {
    const [match] = searchSource(Lang.TypeScript, "foo();\n", "foo($$$A)");
    assert.ok(match);
    assert.equal(match.captures.find((c) => c.name === "A")?.text, "");
  });

  it("reads $NAME captures as that node's own text", () => {
    const [match] = searchSource(Lang.TypeScript, "foo(bar, baz);\n", "foo($A, $B)");
    assert.ok(match);
    assert.deepEqual(
      match.captures.map((c) => [c.name, c.text, c.multiple]),
      [
        ["A", "bar", false],
        ["B", "baz", false],
      ],
    );
  });

  it("finds a call shape a regex would miss across line breaks, with its line numbers", () => {
    // The ticket's first acceptance box. `/openLedger\(db, opts\)/` finds
    // neither of these; the pattern finds both, and says which lines they are
    // on so an edit can follow.
    const source = ["openLedger(db, opts);", "openLedger(", "  db,", "  opts,", ");", ""].join("\n");
    const matches = searchSource(Lang.TypeScript, source, "openLedger($$$ARGS)");
    assert.equal(matches.length, 2);
    assert.deepEqual(
      matches.map((m) => [m.startLine, m.endLine]),
      [
        [1, 1],
        [2, 5],
      ],
    );
    assert.deepEqual(
      matches.map((m) => m.captures.find((c) => c.name === "ARGS")?.text),
      ["db, opts", "db,\n  opts,"],
    );
  });

  it("offsets are UTF-16 code units, so a slice above a non-ASCII character still lands", () => {
    // `sgnode.d.ts` calls `Pos.index` a byte offset. It is not, and the whole
    // module slices with these numbers.
    const source = "const s = 'héllo→';\nfoo(a, b);\n";
    const [match] = searchSource(Lang.TypeScript, source, "foo($$$A)");
    assert.ok(match);
    assert.equal(source.slice(match.start, match.end), "foo(a, b)");
    assert.equal(match.captures.find((c) => c.name === "A")?.text, "a, b");
  });

  it("raises AstPatternError for something that is not a pattern at all", () => {
    assert.throws(() => searchSource(Lang.TypeScript, "const x = 1;\n", "   "), AstPatternError);
  });
});

describe("P10.4 D4: a file whose language cannot be inferred is skipped and named", () => {
  it("maps the extensions the description advertises and nothing else", () => {
    assert.equal(languageForPath("a/b/c.ts"), Lang.TypeScript);
    assert.equal(languageForPath("c.MTS"), Lang.TypeScript);
    assert.equal(languageForPath("c.tsx"), Lang.Tsx);
    assert.equal(languageForPath("c.jsx"), Lang.JavaScript);
    assert.equal(languageForPath("c.css"), Lang.Css);
    assert.equal(languageForPath("c.html"), Lang.Html);
    // Things a reader might assume are supported, that the installed package
    // ships no grammar for. Guessing one would turn a reportable skip into an
    // unreportable parse failure.
    for (const path of ["notes.md", "data.json", "schema.sql", "go/main.go", "a.py", "a.vue", "Makefile"]) {
      assert.equal(languageForPath(path), undefined, path);
    }
  });

  it("scanFiles separates the files it can parse from the ones it names as skipped", async () => {
    const root = process.cwd();
    const walked = [
      join(root, "src", "a.ts"),
      join(root, "src", "b.tsx"),
      join(root, "README.md"),
      join(root, "package.json"),
      join(root, "src", "a.ts"),
    ];
    const walk: AstWalk = async () => walked;
    const scan = await scanFiles(root, ["."], walk);
    assert.deepEqual(scan.files, [join(root, "src", "a.ts"), join(root, "src", "b.tsx")]);
    assert.deepEqual(scan.skipped, [join(root, "README.md"), join(root, "package.json")]);
    assert.equal(scan.capped, false);
  });

  it("the skip heading always carries the exact count, even when the list is capped", () => {
    const many = Array.from({ length: AST_MAX_LISTED_SKIPS + 5 }, (_, i) => `/repo/doc-${i}.md`);
    const lines = renderSkipped("/repo", many);
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, new RegExp(`^Skipped ${many.length} files `));
    assert.match(lines[1]!, /, and 5 more$/);
    for (const ext of AST_SUPPORTED_EXTENSIONS) assert.ok(lines[0]!.includes(ext), ext);
    assert.deepEqual(renderSkipped("/repo", []), []);
  });
});

describe("P10.4 D5: scope is a path, a directory or a glob, and the walk is Pi's", () => {
  it("resolves a directory to a recursive walk and a file to itself", async () => {
    const dir = tmp("lykos-p104-scope-");
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "a.ts"), "const a = 1;\n", "utf8");
      const asDirectory = await resolveScope(dir, "src");
      assert.equal(asDirectory.glob, "**/*");
      assert.equal(asDirectory.isFile, false);
      const asFile = await resolveScope(dir, "src/a.ts");
      assert.equal(asFile.glob, "a.ts");
      assert.equal(asFile.isFile, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("splits a glob at the last separator before its first metacharacter", async () => {
    const cwd = process.cwd();
    assert.deepEqual(await resolveScope(cwd, "lykos/tools/*.ts"), {
      base: join(cwd, "lykos", "tools"),
      glob: "*.ts",
      isFile: false,
    });
    assert.deepEqual(await resolveScope(cwd, "**/*.ts"), { base: cwd, glob: "**/*.ts", isFile: false });
  });

  it("refuses a literal path that does not exist rather than searching nothing quietly", async () => {
    await assert.rejects(() => resolveScope(process.cwd(), "no/such/place.ts"), /does not exist/);
    await assert.rejects(() => resolveScope(process.cwd(), "  "), /empty path/);
  });

  it("the real walk finds source files, drops directories, and honours .gitignore", async () => {
    const dir = tmp("lykos-p104-walk-");
    try {
      mkdirSync(join(dir, "src"));
      mkdirSync(join(dir, "build"));
      writeFileSync(join(dir, ".gitignore"), "build/\n", "utf8");
      writeFileSync(join(dir, "src", "a.ts"), "const a = 1;\n", "utf8");
      writeFileSync(join(dir, "build", "a.ts"), "const a = 1;\n", "utf8");
      writeFileSync(join(dir, "notes.md"), "hi\n", "utf8");
      const scan = await scanFiles(dir, ["."], piWalk(dir));
      // `build/a.ts` is gitignored and never reaches the scan; `notes.md` and
      // the dotfile do reach it and are named as skipped rather than dropped,
      // which is exactly the report D4 asks for.
      assert.deepEqual(scan.files, [join(dir, "src", "a.ts")]);
      assert.deepEqual(scan.skipped, [join(dir, ".gitignore"), join(dir, "notes.md")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("P10.4 D2: substitution is ours, because node.replace() is a raw replacement", () => {
  it("substitutes both arities and leaves the unbound forms alone", () => {
    const captures = [
      { name: "ARGS", multiple: true, text: "1, 2" },
      { name: "FN", multiple: false, text: "log" },
    ];
    assert.equal(substitute("logger.$FN($$$ARGS)", captures), "logger.log(1, 2)");
    // `$_` and a bare `$$$` bind nothing, so there is nothing to put in their
    // place; they survive as the literal text they are.
    assert.equal(substitute("keep $_ and $$$", captures), "keep $_ and $$$");
    // Lowercase is not a metavariable in ast-grep, so it is literal text.
    assert.equal(substitute("$path", captures), "$path");
  });

  it("resolves a name written with the other arity rather than dropping it", () => {
    const captures = [{ name: "A", multiple: true, text: "x, y" }];
    assert.equal(substitute("bar($A)", captures), "bar(x, y)");
  });

  it("reads every named metavariable out of a pattern, once each, in order", () => {
    assert.deepEqual(metavariablesIn("$A.$B($$$C, $A, $_, $$$)"), { single: ["A", "B"], multi: ["C"] });
  });
});

describe("P10.4: a rule is checked before any file is read", () => {
  it("refuses an empty pattern and a replacement naming a capture the pattern never binds", () => {
    assert.deepEqual(rewriteProblems("foo($A)", "bar($A)", "rule 1"), []);
    assert.equal(rewriteProblems("  ", "x", "rule 1").length, 1);
    const problems = rewriteProblems("foo($A)", "bar($B, $$$C)", "rule 2");
    assert.equal(problems.length, 1);
    // The whole point: `bar($B)` would otherwise be written to disk as
    // `bar()` — it compiles, it looks deliberate, and it is wrong.
    assert.match(problems[0]!, /\$B, \$C/);
    assert.match(problems[0]!, /^rule 2:/);
  });
});

describe("P10.4 D6: overlapping rewrites are refused, never silently half-applied", () => {
  const edit = (start: number, end: number, text: string, rule = 1, line = 1): PlannedEdit => ({
    start,
    end,
    text,
    rule,
    line,
  });

  it("names both rules when two matches cover the same code", () => {
    // ast-grep matches `foo($A)` twice in `foo(foo(1))`, outer and inner, and
    // the package's own commitEdits drops one of them without saying so.
    const source = "foo(foo(1));\n";
    const matches = searchSource(Lang.TypeScript, source, "foo($A)");
    assert.equal(matches.length, 2);
    const problems = overlapProblems(matches.map((m) => edit(m.start, m.end, "X", 1, m.startLine)));
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /overlapping code/);
  });

  it("two edits that merely touch are not an overlap", () => {
    assert.deepEqual(overlapProblems([edit(0, 3, "a"), edit(3, 6, "b")]), []);
  });

  it("applies edits in source order regardless of the order they were planned in", () => {
    const source = "alpha beta gamma";
    const out = applyEdits(source, [edit(11, 16, "GAMMA", 2), edit(0, 5, "ALPHA", 1)]);
    assert.equal(out, "ALPHA beta GAMMA");
  });

  it("an empty replacement deletes the matched range", () => {
    assert.equal(applyEdits("keep drop keep", [edit(5, 10, "")]), "keep keep");
  });
});

describe("P10.4 D6: a file the grammar did not understand is detectable", () => {
  it("says so for a broken file and not for a real one", () => {
    assert.equal(hasParseError(Lang.TypeScript, "export const x: number = 1;\n"), false);
    assert.equal(hasParseError(Lang.TypeScript, "function ( {{{\n"), true);
  });
});

describe("P10.4: shared rendering", () => {
  it("shows a path the way an edit would have to name it", () => {
    const cwd = process.cwd();
    assert.equal(displayPath(cwd, join(cwd, "lykos", "tools", "ast.ts")), "lykos/tools/ast.ts");
    assert.equal(displayPath(join(cwd, "lykos"), join(cwd, "docs", "x.md")), join(cwd, "docs", "x.md"));
  });

  it("collapses line endings without eating the trailing newline", () => {
    assert.equal(toLF("a\r\nb\rc\n"), "a\nb\nc\n");
    assert.equal(toLF("a\nb"), "a\nb");
  });
});
