// T231: Boxie's task file parses unchanged; `issue:` fetches the issue with its whole spec (R17); the test
// command comes from the task or project config, never guessed (R10); `scope` is the task's (scope_too_narrow).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/load.js";
import { SHIPPED_DEFAULTS } from "../config/defaults.js";
import { fetchIssue, parseIssueRef, specRef, taskBrief, type IssueView, type IssueViewer } from "./issue-fetch.js";
import { fillTestCommand, parseTaskFile, resolveTestCommand, TaskFileError } from "./task-file.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(join(here, "fixtures", name), "utf8");

describe("T231: a Boxie task file parses unchanged", () => {
  it("a real Boxie task with issue, files, scope, sealed and test", () => {
    const t = parseTaskFile(fixture("boxie-task-t195.md"));
    assert.deepEqual(t.issue, ["50"]);
    assert.equal(t.files.length, 6);
    assert.deepEqual(t.scope, ["lykos/**", "docs/reference/**"]);
    assert.deepEqual(t.sealed, ["lykos/cli/seal-t195.test.ts"]);
    assert.match(t.test ?? "", /^npx --no-install tsx --test "lykos\/cli\/seal\*\.test\.ts"/);
    assert.equal(t.red, true);
    assert.match(t.body, /^Implement T195 \(issue #50\)/);
    assert.deepEqual(t.warnings, []);
  });

  it("a real Boxie task with red: false", () => {
    const t = parseTaskFile(fixture("boxie-task-any-src.md").replace(/\n/g, "\r\n"));
    assert.equal(t.red, false);
    assert.equal(t.files.length, 20);
    assert.match(t.body, /^Remove the TypeScript `any` type/);
  });

  it("steps, areas and single values; unknown keys warn", () => {
    const t = parseTaskFile("---\nfiles: src/a.ts\nareas: [core]\nsteps: 25\nissue: owner/repo#7\nmodel: x\n---\nDo it.\n");
    assert.deepEqual(t.files, ["src/a.ts"]);
    assert.deepEqual(t.areas, ["core"]);
    assert.equal(t.steps, 25);
    assert.deepEqual(t.issue, ["owner/repo#7"]);
    assert.deepEqual(t.warnings, ['task file: unknown frontmatter key "model" ignored']);
  });

  it("no frontmatter is all body", () => {
    const t = parseTaskFile("Just do it.\n");
    assert.equal(t.body, "Just do it.\n");
    assert.equal(t.red, true);
  });

  it("a wrongly typed key is an error, never a default", () => {
    assert.throws(() => parseTaskFile("---\nsteps: 0\n---\n"), TaskFileError);
    assert.throws(() => parseTaskFile("---\nred: no thanks\n---\n"), TaskFileError);
    assert.throws(() => parseTaskFile("---\ntest: [a, b]\n---\n"), TaskFileError);
    assert.throws(() => parseTaskFile("---\nfiles: {a: 1}\n---\n"), TaskFileError);
    assert.throws(() => parseTaskFile("---\n[unclosed\n---\n"), TaskFileError);
  });
});

describe("T231: issue fetch (R17)", () => {
  const longSpec = `# The spec\n\n${"Decision text that must reach every worker. ".repeat(3000)}\nLAST LINE OF THE SPEC`;
  const issues: Record<number, IssueView> = {
    50: { number: 50, title: "Seal create", state: "OPEN", body: "Spec: #1\n\nBuild it. Blocked by #49.", labels: [{ name: "ready" }], comments: [{ author: { login: "a" }, createdAt: "t", body: "note" }] },
    1: { number: 1, title: "P3 spec", state: "OPEN", body: longSpec },
    49: { number: 49, title: "Keys", state: "CLOSED", body: "x".repeat(5000) },
  };
  const calls: string[] = [];
  const view: IssueViewer = (_cwd, slug, n) => {
    calls.push(`${slug ?? ""}#${n}`);
    const it = issues[n];
    if (!it) throw new Error(`no issue ${n}`);
    return it;
  };

  it("a spec over the issue-link convention's length is fetched whole", () => {
    assert.ok(longSpec.length > 80_000, "the spec is longer than Boxie's old cut");
    const f = fetchIssue("50", { cwd: ".", view });
    assert.match(f.main, /GitHub issue #50: Seal create/);
    assert.match(f.main, /### Comments \(1\)/);
    assert.match(f.spec, /LAST LINE OF THE SPEC/);
    assert.doesNotMatch(f.spec, /cut at/);
    assert.match(f.links, /#49: Keys \(CLOSED\)/);
    assert.match(f.links, /cut at 1500 of 5000/);
  });

  it("the brief is the body then the issue", () => {
    const brief = taskBrief({ body: "Do T195.\n", issue: ["#50"] }, { cwd: ".", view });
    assert.match(brief, /^Do T195\.\n\n## GitHub issue #50/);
  });

  it("an owner/repo reference is fetched from that repository, spec included", () => {
    calls.length = 0;
    fetchIssue("rakun68/Lykos#50", { cwd: ".", view });
    assert.deepEqual(calls.slice(0, 2), ["rakun68/Lykos#50", "rakun68/Lykos#1"]);
  });

  it("a spec that cannot be fetched stops the task", () => {
    const noSpec: IssueViewer = (cwd, slug, n, fields) => {
      if (n === 1) throw new Error("gh: not found");
      return view(cwd, slug, n, fields);
    };
    assert.throws(() => fetchIssue("50", { cwd: ".", view: noSpec }), /not found/);
  });

  it("spec references and issue references", () => {
    assert.equal(specRef("Spec: #12\nrest"), 12);
    assert.equal(specRef("**Parent issue:** #3"), 3);
    assert.equal(specRef("## Parent\n\n- #9\n"), 9);
    assert.equal(specRef("See #4"), undefined);
    assert.deepEqual(parseIssueRef("#5"), { n: 5 });
    assert.throws(() => parseIssueRef("five"));
  });
});

describe("T231: the test command is the task's or the project's, never guessed (R10)", () => {
  const config = (test_command: string) => ({ delegation: { test_command } });

  it("the task's test: wins", () => {
    assert.deepEqual(resolveTestCommand({ test: "make check", sealed: [], files: [] }, config("x {files}")), { command: "make check", source: "task" });
  });

  it("a Gradle-style filtered command comes from config, filled with the task's tests", () => {
    const task = { sealed: ["src/test/java/com/acme/FooTest.java"], files: ["src/main/java/com/acme/Foo.java"] };
    assert.deepEqual(resolveTestCommand(task, config("./gradlew :app:test {tests}")), {
      command: "./gradlew :app:test --tests com.acme.FooTest",
      source: "delegation.test_command",
    });
  });

  it("with neither, there is no command", () => {
    assert.equal(resolveTestCommand({ sealed: ["a.test.ts"], files: ["src/a.ts"] }, config("")), undefined);
    assert.equal(resolveTestCommand({ sealed: [], files: [] }, { delegation: SHIPPED_DEFAULTS.delegation }), undefined);
  });

  it("a path with a space or a shell character stays one word in {files} and {dirs}", () => {
    assert.equal(fillTestCommand("node --test {files}", ["my test.test.ts", "a;rm -rf x.test.ts", "plain.test.ts"]), 'node --test "my test.test.ts" "a;rm -rf x.test.ts" plain.test.ts');
    assert.equal(fillTestCommand("go test {dirs}", ["my pkg/a_test.go"]), 'go test "./my pkg"');
  });

  it("{files} gets sealed tests and the test files among files; {dirs} their directories", () => {
    assert.equal(fillTestCommand("go test {dirs}", ["pkg/a/a_test.go", "pkg/a/b_test.go", "main_test.go"]), "go test ./pkg/a .");
    const r = resolveTestCommand({ sealed: ["t/x.test.ts"], files: ["src/x.ts", "src/y.test.ts"] }, config("npx tsx --test {files}"));
    assert.equal(r?.command, "npx tsx --test t/x.test.ts src/y.test.ts");
  });

  it("delegation.test_command loads from project config, and an unknown key is refused", () => {
    const ws = mkdtempSync(join(tmpdir(), "lykos-t231-"));
    const home = mkdtempSync(join(tmpdir(), "lykos-t231-home-"));
    mkdirSync(join(ws, ".lykos"), { recursive: true });
    writeFileSync(join(ws, ".lykos", "config.yaml"), 'delegation:\n  test_command: "./gradlew :core:test {tests}"\n');
    const { resolved } = loadConfig({ cwd: ws, globalDir: join(home, ".lykos"), env: {} });
    assert.equal(resolved.delegation.test_command, "./gradlew :core:test {tests}");
    writeFileSync(join(ws, ".lykos", "config.yaml"), "delegation:\n  testcmd: x\n");
    assert.throws(() => loadConfig({ cwd: ws, globalDir: join(home, ".lykos"), env: {} }), /unknown key "testcmd" in delegation/);
  });
});
