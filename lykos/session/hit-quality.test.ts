import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HIT_QUALITY_VERSION,
  commandMentionsPath,
  computeHitQuality,
  normalizePath,
  serializeEditedFiles,
  toolCallsFromTranscript,
} from "./hit-quality.js";

const bash = (command: string) => ({ name: "bash", state: "ok", args: { command } });
const read = (path: string) => ({ name: "read", state: "ok", args: { path } });
const edit = (path: string, state = "ok") => ({ name: "edit", state, args: { path } });
const write = (path: string) => ({ name: "write", state: "ok", args: { file_path: path } });

describe("normalizePath (T64)", () => {
  it("normalises Windows separators, trailing slashes and ./", () => {
    assert.equal(normalizePath("lykos\\session\\session.ts"), "lykos/session/session.ts");
    assert.equal(normalizePath("./docs/02-plan.md"), "docs/02-plan.md");
    assert.equal(normalizePath("docs/"), "docs");
  });
});

describe("commandMentionsPath (T64)", () => {
  it("matches a full path", () => {
    assert.ok(commandMentionsPath("sed -n '1,40p' docs/02-plan.md", "docs/02-plan.md"));
  });

  it("matches a basename as a whole token", () => {
    assert.ok(commandMentionsPath("head -40 docs/02-plan.md", "docs/02-plan.md"));
    assert.ok(commandMentionsPath('grep -n "x" 02-plan.md', "docs/02-plan.md"));
  });

  it("does not match a partial basename", () => {
    assert.equal(commandMentionsPath("head -40 docs/002-plan.mdx", "docs/02-plan.md"), false);
    assert.equal(commandMentionsPath("cat session.tsx", "lykos/session/session.ts"), false);
  });

  it("crosses separator styles", () => {
    assert.ok(commandMentionsPath('grep -n x "C:\\Work\\lykos\\session\\session.ts"', "lykos/session/session.ts"));
  });

  it("refuses a basename too short to be evidence", () => {
    assert.equal(commandMentionsPath("ls a", "a"), false);
  });
});

describe("computeHitQuality (T64)", () => {
  it("is empty when the session edited nothing — an exploration-only session has no answer key", () => {
    const hq = computeHitQuality([bash("grep -rn foo ."), read("a.ts")]);
    assert.equal(hq.editedFileCount, 0);
    assert.equal(hq.hitQuality, null);
    assert.equal(hq.firstTouchRank, null);
    assert.deepEqual(hq.files, []);
  });

  it("ranks a file found on the first exploration call as 1", () => {
    const hq = computeHitQuality([read("lykos/session/session.ts"), edit("lykos/session/session.ts")]);
    assert.equal(hq.editedFileCount, 1);
    assert.equal(hq.firstTouchRank, 1);
    assert.equal(hq.hitQuality, 1);
    assert.equal(hq.blindEdits, 0);
  });

  it("counts the exploration calls that came first — the number a repo map would cut", () => {
    const hq = computeHitQuality([
      bash("ls lykos/"),
      bash("grep -rn wrong lykos/cli"),
      bash("ls lykos/session"),
      read("lykos/session/session.ts"),
      edit("lykos/session/session.ts"),
    ]);
    assert.equal(hq.firstTouchRank, 4);
    assert.equal(hq.files[0]?.rank, 4);
  });

  it("credits a file read through bash after T20 moved search there", () => {
    const hq = computeHitQuality([
      bash("sed -n '1,40p' docs/02-plan.md"),
      edit("docs/02-plan.md"),
    ]);
    assert.equal(hq.firstTouchRank, 1);
    assert.equal(hq.blindEdits, 0);
  });

  it("separates a blind edit rather than scoring it as found instantly", () => {
    const hq = computeHitQuality([bash("ls docs"), write("docs/20-new.md")]);
    assert.equal(hq.editedFileCount, 1);
    assert.equal(hq.blindEdits, 1);
    assert.equal(hq.hitQuality, 0);
    // The whole point: a blind edit must not contribute rank 0 to the mean.
    assert.equal(hq.firstTouchRank, null);
    assert.equal(hq.files[0]?.blind, true);
    assert.equal(hq.files[0]?.rank, null);
  });

  it("averages rank over the files that were read, and reports hit quality over all of them", () => {
    const hq = computeHitQuality([
      read("a.ts"), //            rank 1 for a.ts
      bash("grep -rn x ."), //    rank 2 boundary
      read("b.ts"), //            rank 3 for b.ts
      edit("a.ts"),
      edit("b.ts"),
      write("c.ts"), //           blind
    ]);
    assert.equal(hq.editedFileCount, 3);
    assert.equal(hq.blindEdits, 1);
    assert.equal(hq.firstTouchRank, 2); // (1 + 3) / 2
    assert.equal(hq.hitQuality, 2 / 3);
  });

  it("only counts a read that happened BEFORE the edit", () => {
    const hq = computeHitQuality([write("new.ts"), read("new.ts"), edit("new.ts")]);
    // The first edit was blind; reading it afterwards does not retroactively find it.
    assert.equal(hq.blindEdits, 1);
    assert.equal(hq.hitQuality, 0);
  });

  it("ignores a failed edit — editing the wrong file is not evidence the file mattered", () => {
    const hq = computeHitQuality([read("a.ts"), edit("wrong.ts", "error"), edit("a.ts")]);
    assert.equal(hq.editedFileCount, 1);
    assert.equal(hq.files[0]?.path, "a.ts");
  });

  it("treats an edit with no recorded state as successful, so the historical baseline is not empty", () => {
    const hq = computeHitQuality([read("a.ts"), { name: "edit", args: { path: "a.ts" } }]);
    assert.equal(hq.editedFileCount, 1);
  });

  it("skips an edit whose path cannot be recovered rather than guessing", () => {
    const hq = computeHitQuality([read("a.ts"), { name: "edit", state: "ok", args: { truncated: true } }]);
    assert.equal(hq.editedFileCount, 0);
  });

  it("normalises separators so a Windows read matches a Windows edit once", () => {
    const hq = computeHitQuality([
      { name: "read", state: "ok", args: { path: "lykos\\session\\session.ts" } },
      { name: "edit", state: "ok", args: { path: "lykos/session/session.ts" } },
    ]);
    assert.equal(hq.editedFileCount, 1);
    assert.equal(hq.blindEdits, 0);
  });

  it("counts a file edited twice once, at its first edit", () => {
    const hq = computeHitQuality([read("a.ts"), edit("a.ts"), bash("ls"), edit("a.ts")]);
    assert.equal(hq.editedFileCount, 1);
    assert.equal(hq.firstTouchRank, 1);
  });

  it("carries the version so rows written under a later definition are not compared", () => {
    assert.equal(computeHitQuality([]).version, HIT_QUALITY_VERSION);
  });

  it("serialises a stable, sorted file list", () => {
    const hq = computeHitQuality([read("b.ts"), read("a.ts"), edit("b.ts"), edit("a.ts")]);
    const parsed = JSON.parse(serializeEditedFiles(hq)) as Array<{ path: string }>;
    assert.deepEqual(
      parsed.map((f) => f.path),
      ["a.ts", "b.ts"],
    );
  });
});

describe("toolCallsFromTranscript (T64)", () => {
  it("keeps tool_call events in order and drops everything else", () => {
    const calls = toolCallsFromTranscript([
      { kind: "usage" },
      { kind: "tool_call", name: "read", state: "ok", args: { path: "a.ts" } },
      { kind: "assistant_message" },
      { kind: "tool_call", name: "edit", state: "ok", args: { path: "a.ts" } },
      { kind: "outcome" },
    ]);
    assert.deepEqual(
      calls.map((c) => c.name),
      ["read", "edit"],
    );
    assert.equal(computeHitQuality(calls).hitQuality, 1);
  });
});

describe("T159: a multi-file edit's files come from its result", () => {
  const astEdit = (result: unknown) => ({
    name: "tool_call",
    state: "ok",
    args: { name: "ast_edit", arguments: { rules: [], paths: ["src/**/*.ts"] } },
    result,
  });

  it("uses details.changedFiles for ast_edit and lsp, through the tool_call transport", () => {
    const hq = computeHitQuality([astEdit({ details: { changedFiles: ["src/a.ts", "src\\b.ts"] } })]);
    assert.deepEqual(hq.files.map((f) => f.path), ["src/a.ts", "src/b.ts"]);
    const rename = computeHitQuality([
      { name: "lsp", state: "ok", args: { action: "rename", file: "a.ts" }, result: { details: { changedFiles: ["a.ts", "b.ts", "c.ts"] } } },
    ]);
    assert.deepEqual(rename.files.map((f) => f.path), ["a.ts", "b.ts", "c.ts"]);
  });

  it("records nothing for a call whose result says it changed nothing", () => {
    assert.equal(computeHitQuality([astEdit({ details: { changedFiles: [] } })]).editedFileCount, 0);
  });

  it("falls back to the arguments when the result does not say (an older trace, or a spilled stub)", () => {
    assert.deepEqual(computeHitQuality([astEdit(undefined)]).files.map((f) => f.path), ["src/**/*.ts"]);
    assert.deepEqual(computeHitQuality([astEdit({ artifact: "artifacts/x.json", bytes: 10 })]).files.map((f) => f.path), ["src/**/*.ts"]);
  });

  it("never reads a result for any other tool", () => {
    const hq = computeHitQuality([{ name: "write", state: "ok", args: { path: "x.ts" }, result: { details: { changedFiles: ["y.ts"] } } }]);
    assert.deepEqual(hq.files.map((f) => f.path), ["x.ts"]);
  });
});
