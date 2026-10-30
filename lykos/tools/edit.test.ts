// T168 (ADR-0031): the tool around the matching — registration, the gate, the
// result the model reads, the details the interface renders, same-file
// serialisation, and the catalog row that prices it. The matching itself is
// `edit-match.test.ts`.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { AutoApproveGate, DenialLog, type ApprovalDecision, type ApprovalRequest } from "../gate/approval.js";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { measureToolset } from "../ledger/tool-schema.js";
import { EDIT_DESCRIPTION, EDIT_PARAMETERS, buildEditTool, resolveEditPath, successText } from "./edit.js";
import { loadTools } from "./session-tools.js";

interface ExecResult {
  content: Array<{ type?: string; text?: string }>;
  details?: { diff?: string; patch?: string; firstChangedLine?: number };
}

type AnyTool = {
  prepareArguments?: (args: unknown) => unknown;
  execute: (id: string, p: unknown, signal?: AbortSignal) => Promise<ExecResult>;
};

/** A gate that records what it was asked and answers however the test says. */
class RecordingGate {
  readonly requests: ApprovalRequest[] = [];
  constructor(private readonly answer: ApprovalDecision = "allow") {}
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(req);
    return this.answer;
  }
}

interface Fixture {
  dir: string;
  file: string;
  tool: AnyTool;
  gate: RecordingGate;
  denials: DenialLog;
  read: () => string;
}

function fixture(content: string, answer: ApprovalDecision = "allow"): Fixture {
  const dir = mkdtempSync(resolve(tmpdir(), "lykos-edit-"));
  const file = resolve(dir, "a.ts");
  writeFileSync(file, content);
  const gate = new RecordingGate(answer);
  const denials = new DenialLog();
  const tool = buildEditTool({ cwd: dir, gate, denials }) as unknown as AnyTool;
  return { dir, file, tool, gate, denials, read: () => readFileSync(file, "utf8") };
}

/** What the agent loop does with a model's arguments: `prepareArguments`, then `execute`. */
async function call(f: Fixture, args: unknown): Promise<ExecResult> {
  const prepared = f.tool.prepareArguments ? f.tool.prepareArguments(structuredClone(args)) : args;
  return f.tool.execute("call-1", prepared);
}

async function failure(f: Fixture, args: unknown): Promise<string> {
  try {
    await call(f, args);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new assert.AssertionError({ message: "expected the call to be refused, and it was not" });
}

describe("what the model is told", () => {
  it("keeps Pi's one-line result for a plain edit", async () => {
    const f = fixture("one\ntwo\n");
    const result = await call(f, { path: "a.ts", edits: [{ oldText: "two", newText: "TWO" }] });
    assert.equal(result.content[0]!.text, "Successfully replaced 1 block(s) in a.ts.");
    assert.equal(f.read(), "one\nTWO\n");
  });

  it("counts blocks for several plain edits, as Pi does", async () => {
    const f = fixture("a\nb\nc\n");
    const result = await call(f, {
      path: "a.ts",
      edits: [
        { oldText: "a", newText: "A" },
        { oldText: "c", newText: "C" },
      ],
    });
    assert.equal(result.content[0]!.text, "Successfully replaced 2 block(s) in a.ts.");
  });

  it("states the number of occurrences a replaceAll edit made", async () => {
    const f = fixture("foo foo\nfoo\nfoo foo\nfoo\nbar\nfoo\nfoo\n");
    const result = await call(f, { path: "a.ts", edits: [{ oldText: "foo", newText: "baz", replaceAll: true }] });
    assert.equal(result.content[0]!.text, "Successfully replaced 8 occurrences in a.ts.");
    assert.equal(f.read(), "baz baz\nbaz\nbaz baz\nbaz\nbar\nbaz\nbaz\n");
  });

  it("says occurrence, not occurrences, for one", () => {
    assert.equal(successText("a.ts", 1, 1, true), "Successfully replaced 1 occurrence in a.ts.");
  });

  it("states the total and the number of edits when replaceAll and plain entries share a call", async () => {
    const f = fixture("a a a\nb\n");
    const result = await call(f, {
      path: "a.ts",
      edits: [
        { oldText: "a", newText: "A", replaceAll: true },
        { oldText: "b", newText: "B" },
      ],
    });
    assert.equal(result.content[0]!.text, "Successfully replaced 4 occurrences across 2 edits in a.ts.");
  });

  it("returns the diff fields the interface renders", async () => {
    const f = fixture("one\ntwo\n");
    const result = await call(f, { path: "a.ts", edits: [{ oldText: "two", newText: "TWO" }] });
    assert.equal(typeof result.details?.diff, "string");
    assert.match(result.details!.diff!, /^\+2 TWO$/m);
    assert.match(result.details!.patch!, /^--- a\.ts$/m);
    assert.equal(result.details!.firstChangedLine, 2);
  });
});

describe("The old_string shape, through the same path the agent loop takes", () => {
  it("applies old_string/new_string as one edit", async () => {
    const f = fixture("one\ntwo\n");
    const result = await call(f, { path: "a.ts", old_string: "two", new_string: "2" });
    assert.equal(result.content[0]!.text, "Successfully replaced 1 block(s) in a.ts.");
    assert.equal(f.read(), "one\n2\n");
  });

  it("applies replace_all as replaceAll", async () => {
    const f = fixture("x x x\n");
    const result = await call(f, { path: "a.ts", old_string: "x", new_string: "y", replace_all: true });
    assert.equal(result.content[0]!.text, "Successfully replaced 3 occurrences in a.ts.");
    assert.equal(f.read(), "y y y\n");
  });

  it("without replace_all, an old_string that occurs twice is refused like any other", async () => {
    const f = fixture("x x\n");
    assert.match(await failure(f, { path: "a.ts", old_string: "x", new_string: "y" }), /Found 2 occurrences/);
    assert.equal(f.read(), "x x\n");
  });

  it("accepts file_path for path", async () => {
    const f = fixture("one\n");
    await call(f, { file_path: "a.ts", old_string: "one", new_string: "1" });
    assert.equal(f.read(), "1\n");
  });

  it("refuses a call that mixes the two shapes, and writes nothing", async () => {
    const f = fixture("one\ntwo\n");
    const msg = await failure(f, {
      path: "a.ts",
      edits: [{ oldText: "one", newText: "1" }],
      old_string: "two",
      new_string: "2",
    });
    assert.match(msg, /both the old_string shape/);
    assert.equal(f.read(), "one\ntwo\n");
  });

  it("shows the model Pi's schema, not the old_string one", () => {
    const f = fixture("x");
    const params = JSON.parse(JSON.stringify((f.tool as unknown as { parameters: unknown }).parameters)) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    assert.deepEqual(Object.keys(params.properties).sort(), ["edits", "path"]);
    assert.deepEqual([...params.required].sort(), ["edits", "path"]);
  });
});

describe("the gate", () => {
  it("asks once, as an edit, with the absolute path and the whole new file", async () => {
    const f = fixture("one\ntwo\n");
    await call(f, { path: "a.ts", edits: [{ oldText: "one", newText: "ONE" }] });
    assert.equal(f.gate.requests.length, 1);
    const req = f.gate.requests[0]!;
    assert.equal(req.kind, "edit");
    assert.equal(req.summary, "apply edit");
    assert.equal(req.detail, f.file);
    assert.equal(req.body, "ONE\ntwo\n");
  });

  it("asks once for a replaceAll call, not once per occurrence", async () => {
    const f = fixture("x x x\n");
    await call(f, { path: "a.ts", edits: [{ oldText: "x", newText: "y", replaceAll: true }] });
    assert.equal(f.gate.requests.length, 1);
    assert.equal(f.gate.requests[0]!.body, "y y y\n");
  });

  it("writes nothing when the human declines, and records the denial", async () => {
    const f = fixture("one\ntwo\n", "deny");
    const msg = await failure(f, { path: "a.ts", edits: [{ oldText: "one", newText: "ONE" }] });
    assert.match(msg, /the human declined this edit/);
    assert.equal(f.read(), "one\ntwo\n");
    assert.equal(f.denials.userRejected, 1);
  });

  it("asks nobody about a call that fails to match", async () => {
    const f = fixture("one\n");
    await failure(f, { path: "a.ts", edits: [{ oldText: "zzz", newText: "x" }] });
    assert.equal(f.gate.requests.length, 0);
  });

  it("asks about a path outside the project root, and a refusal leaves the file alone (T210)", async () => {
    const f = fixture("one\n", "deny");
    const outside = resolve(f.dir, "..", "escape.ts");
    writeFileSync(outside, "one\n");
    try {
      const msg = await failure(f, { path: outside, edits: [{ oldText: "one", newText: "X" }] });
      assert.match(msg, /the human declined this edit/);
      assert.equal(f.gate.requests.length, 1, "outside the root is a question now");
      assert.equal(readFileSync(outside, "utf8"), "one\n");
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("refuses a path outside the root that a deny rule covers, before asking anyone (T210)", async () => {
    const f = fixture("one\n");
    const elsewhere = mkdtempSync(resolve(tmpdir(), "lykos-edit-elsewhere-"));
    try {
      const outside = resolve(elsewhere, "escape.ts");
      writeFileSync(outside, "one\n");
      mkdirSync(resolve(f.dir, ".lykos"), { recursive: true });
      writeFileSync(
        resolve(f.dir, ".lykos", "config.yaml"),
        `path_rules:\n  write:\n    '${elsewhere.split("\\").join("/")}/**': deny\n`,
      );
      const msg = await failure(f, { path: outside, edits: [{ oldText: "one", newText: "X" }] });
      assert.match(msg, /denied/);
      assert.equal(f.gate.requests.length, 0);
      assert.equal(f.denials.outOfRoot, 1);
      assert.equal(readFileSync(outside, "utf8"), "one\n");
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe("same-file calls are serialised", () => {
  it("two concurrent edits to one file both land, rather than one overwriting the other", async () => {
    const f = fixture("a\nb\n");
    await Promise.all([
      call(f, { path: "a.ts", edits: [{ oldText: "a", newText: "A" }] }),
      call(f, { path: "a.ts", edits: [{ oldText: "b", newText: "B" }] }),
    ]);
    assert.equal(f.read(), "A\nB\n");
  });
});

describe("an aborted call", () => {
  it("writes nothing", async () => {
    const f = fixture("one\n");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      f.tool.execute("c", { path: "a.ts", edits: [{ oldText: "one", newText: "1" }] }, controller.signal),
      /Operation aborted/,
    );
    assert.equal(f.read(), "one\n");
  });
});

describe("path resolution is Pi's", () => {
  it("resolves relative paths against the cwd and leaves absolute ones alone", () => {
    assert.equal(resolveEditPath("a.ts", resolve("/proj")), resolve("/proj", "a.ts"));
    assert.equal(resolveEditPath(resolve("/other/b.ts"), resolve("/proj")), resolve("/other/b.ts"));
  });

  it("strips a leading @, expands ~ and folds unicode spaces", () => {
    assert.equal(resolveEditPath("@a.ts", resolve("/proj")), resolve("/proj", "a.ts"));
    assert.equal(resolveEditPath("~/x.ts", resolve("/proj")), resolve(homedir(), "x.ts"));
    assert.equal(resolveEditPath("my file.ts", resolve("/proj")), resolve("/proj", "my file.ts"));
  });
});

describe("the schema tax", () => {
  it("keeps the catalog's wire description identical to the tool's own", () => {
    assert.equal(TOOL_CATALOG.edit!.description, EDIT_DESCRIPTION);
  });

  it("keeps the catalog's wire parameters identical to the typebox schema", () => {
    assert.deepEqual(TOOL_CATALOG.edit!.parameters, JSON.parse(JSON.stringify(EDIT_PARAMETERS)));
  });

  it("is Pi's schema plus replaceAll and nothing else", () => {
    const pi = JSON.parse(JSON.stringify(createEditToolDefinition(process.cwd()).parameters)) as {
      properties: { edits: { items: { properties: Record<string, unknown>; required: string[] } } };
    };
    const ours = JSON.parse(JSON.stringify(EDIT_PARAMETERS)) as typeof pi;
    const { replaceAll, ...rest } = ours.properties.edits.items.properties;
    assert.ok(replaceAll, "replaceAll is in the schema");
    assert.deepEqual(Object.keys(rest), Object.keys(pi.properties.edits.items.properties));
    assert.deepEqual(ours.properties.edits.items.required, pi.properties.edits.items.required);
  });

  it("is measured and complete, and says `edit` is Lykos's own tool", () => {
    assert.equal(measureToolset(["read", "bash", "edit", "write"]).complete, true, "an unpriced tool makes the whole measurement NULL");
    assert.equal(TOOL_CATALOG.edit!.source, "lykos");
  });
});

describe("session registration", () => {
  const deps = () => ({
    cwd: process.cwd(),
    gate: new AutoApproveGate(),
    denials: new DenialLog(),
    modelProvider: "deepseek",
    modelId: "deepseek-v4-flash",
  });

  it("registers Lykos's edit and its numbered read, in place of Pi's", () => {
    const loaded = loadTools(["read", "bash", "edit", "write"], deps());
    const edit = loaded.customTools.find((t) => t.name === "edit");
    const read = loaded.customTools.find((t) => t.name === "read");
    assert.equal(edit?.description, EDIT_DESCRIPTION);
    assert.match(read?.description ?? "", /Text lines are numbered/);
  });

  it("keeps the registration order a session has always had: write, edit, bash", () => {
    const names = loadTools(["read", "bash", "edit", "write"], deps()).customTools.map((t) => t.name);
    assert.ok(names.indexOf("write") < names.indexOf("edit"));
    assert.ok(names.indexOf("edit") < names.indexOf("bash"));
  });

  it("registers exactly one tool per name", () => {
    const names = loadTools(["read", "bash", "edit", "write"], deps()).customTools.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
  });

  it("exposes no snapshot store and no edit mode: there is one editor", () => {
    const loaded = loadTools(["read", "bash", "edit", "write"], deps()) as unknown as Record<string, unknown>;
    assert.equal("snapshots" in loaded, false);
  });
});

describe("edit's call renderer (T168 R5)", () => {
  type Rendered = { preview?: { diff?: string; error?: string }; previewPending?: boolean };
  const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t };

  /** Renders the call as Pi's interactive mode would once the arguments are complete, and lets any preview settle. */
  async function renderCall(args: unknown): Promise<{ preview: Rendered["preview"]; invalidated: number }> {
    const f = fixture("let a = 1;\nlet b = a;\n");
    const tool = buildEditTool({ cwd: f.dir, gate: f.gate, denials: f.denials }) as unknown as {
      renderCall: (args: unknown, theme: unknown, context: unknown) => unknown;
    };
    const state: { callComponent?: Rendered } = {};
    let invalidated = 0;
    tool.renderCall(args, theme, {
      argsComplete: true,
      state,
      cwd: f.dir,
      invalidate: () => invalidated++,
      lastComponent: undefined,
      isError: false,
      isPartial: false,
      expanded: false,
      showImages: false,
    });
    await new Promise((r) => setTimeout(r, 100));
    return { preview: state.callComponent?.preview, invalidated };
  }

  it("Pi's preview of a text that occurs twice is an error — the reason a replaceAll call skips it", async () => {
    const r = await renderCall({ path: "a.ts", edits: [{ oldText: "a", newText: "x" }] });
    assert.match(r.preview?.error ?? "", /occurrences/);
  });

  it("a replaceAll call is rendered with no preview, so a valid rename never shows as a failure", async () => {
    const r = await renderCall({ path: "a.ts", edits: [{ oldText: "a", newText: "x", replaceAll: true }] });
    assert.equal(r.preview, undefined);
    assert.equal(r.invalidated, 0);
  });

  it("an ordinary unique edit still gets Pi's diff preview", async () => {
    const r = await renderCall({ path: "a.ts", edits: [{ oldText: "let b", newText: "const b" }] });
    assert.match(r.preview?.diff ?? "", /const b/);
  });
});
