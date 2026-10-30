// T168 part B (ADR-0031, decision 11): `edit.require_read`. The record, the check
// in front of `edit` and `write`, and the one property that matters most: a call
// the rule rejects never reaches the approval gate. The session-level proof (a
// scripted model, the ledger, `lykos show`) is `cli/scripted-require-read.test.ts`.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import { DenialLog, type ApprovalDecision, type ApprovalRequest } from "../gate/approval.js";
import { EDIT_DESCRIPTION, buildEditTool } from "./edit.js";
import { buildGatedTools } from "./gated.js";
import { buildReadTool } from "./read.js";
import {
  FileReadRecord,
  REQUIRE_READ_SENTENCE,
  STALE_TAIL,
  UNREAD_TAIL,
  contentHash,
  hashFileNow,
  recordKey,
} from "./read-record.js";

interface ExecResult {
  content: Array<{ type?: string; text?: string }>;
}
type AnyTool = {
  name: string;
  description: string;
  prepareArguments?: (args: unknown) => unknown;
  execute: (id: string, p: unknown, signal?: AbortSignal) => Promise<ExecResult>;
};

class RecordingGate {
  readonly requests: ApprovalRequest[] = [];
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.requests.push(req);
    return "allow";
  }
}

interface World {
  dir: string;
  gate: RecordingGate;
  reads: FileReadRecord;
  read: AnyTool;
  edit: AnyTool;
  write: AnyTool;
  put: (rel: string, content: string) => string;
  text: (rel: string) => string;
}

function world(requireRead: boolean, files: Record<string, string> = { "a.ts": "one\ntwo\nthree\n" }): World {
  const dir = mkdtempSync(resolve(tmpdir(), "lykos-reqread-"));
  const gate = new RecordingGate();
  const denials = new DenialLog();
  const reads = new FileReadRecord(requireRead);
  const put = (rel: string, content: string): string => {
    const abs = resolve(dir, rel);
    mkdirSync(resolve(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
    return abs;
  };
  for (const [rel, content] of Object.entries(files)) put(rel, content);
  const gated = buildGatedTools(dir, gate, denials, { reads }) as unknown as AnyTool[];
  return {
    dir,
    gate,
    reads,
    read: buildReadTool({ cwd: dir, reads }) as unknown as AnyTool,
    edit: buildEditTool({ cwd: dir, gate, denials, reads }) as unknown as AnyTool,
    write: gated.find((t) => t.name === "write")!,
    put,
    text: (rel) => readFileSync(resolve(dir, rel), "utf8"),
  };
}

async function run(tool: AnyTool, args: unknown): Promise<string> {
  const prepared = tool.prepareArguments ? tool.prepareArguments(structuredClone(args)) : args;
  const result = await tool.execute("call", prepared);
  return result.content.map((c) => c.text ?? "").join("");
}

async function refusal(tool: AnyTool, args: unknown): Promise<string> {
  try {
    await run(tool, args);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new assert.AssertionError({ message: "expected the call to be refused, and it was not" });
}

const EDIT_ONE = { path: "a.ts", edits: [{ oldText: "two", newText: "TWO" }] };

describe("the record", () => {
  it("keys a path case-insensitively on Windows and exactly elsewhere, after resolving it", () => {
    const abs = resolve(tmpdir(), "Some", "File.ts");
    const folded = recordKey(abs.toUpperCase()) === recordKey(abs.toLowerCase());
    assert.equal(folded, process.platform === "win32");
    assert.equal(recordKey(resolve(tmpdir(), "x", "..", "y.ts")), recordKey(resolve(tmpdir(), "y.ts")));
  });

  it("hashes bytes, so the same text is the same hash and a BOM is a different one", () => {
    assert.equal(contentHash("abc"), contentHash(Buffer.from("abc")));
    assert.notEqual(contentHash("abc"), contentHash("﻿abc"));
    assert.notEqual(contentHash("a\n"), contentHash("a\r\n"));
  });

  it("hashFileNow is undefined for a file that is not there and for a directory", async () => {
    const w = world(true);
    assert.equal(await hashFileNow(resolve(w.dir, "missing.ts")), undefined);
    assert.equal(await hashFileNow(w.dir), undefined);
    assert.equal(await hashFileNow(resolve(w.dir, "a.ts")), contentHash("one\ntwo\nthree\n"));
  });

  it("is per instance: one session's read does not satisfy another's check", () => {
    const abs = resolve(tmpdir(), "shared.ts");
    const one = new FileReadRecord(true);
    const two = new FileReadRecord(true);
    one.noteRead(abs, contentHash("x"));
    assert.equal(one.has(abs), true);
    assert.equal(two.has(abs), false);
    assert.throws(() => two.check(abs, Buffer.from("x"), "shared.ts"), (e: Error) => e.message.includes(UNREAD_TAIL));
  });

  it("never throws when the rule is off, but keeps what it is told", () => {
    const abs = resolve(tmpdir(), "off.ts");
    const record = new FileReadRecord(false);
    assert.doesNotThrow(() => record.check(abs, Buffer.from("anything"), "off.ts"));
    record.noteRead(abs, contentHash("a"));
    assert.equal(record.has(abs), true);
  });
});

describe("edit.require_read on: edit", () => {
  it("rejects an edit to a file that has not been read, names the way out, and writes nothing", async () => {
    const w = world(true);
    const message = await refusal(w.edit, EDIT_ONE);
    assert.equal(message, "`a.ts` has not been read in this session. Read it first (edit.require_read is on).");
    assert.equal(w.text("a.ts"), "one\ntwo\nthree\n");
  });

  it("never asks the approval gate about a call it rejects", async () => {
    const w = world(true);
    await refusal(w.edit, EDIT_ONE);
    assert.equal(w.gate.requests.length, 0);
    writeFileSync(resolve(w.dir, "a.ts"), "one\ntwo\nthree\nfour\n");
    await run(w.read, { path: "a.ts" });
    writeFileSync(resolve(w.dir, "a.ts"), "changed\n");
    await refusal(w.edit, EDIT_ONE);
    assert.equal(w.gate.requests.length, 0);
  });

  it("accepts the edit once the file has been read, and then asks the gate exactly once", async () => {
    const w = world(true);
    await run(w.read, { path: "a.ts" });
    assert.match(await run(w.edit, EDIT_ONE), /^Successfully replaced 1 block\(s\) in a\.ts\./);
    assert.equal(w.text("a.ts"), "one\nTWO\nthree\n");
    assert.equal(w.gate.requests.length, 1);
  });

  it("counts a partial read (offset and limit) as a read", async () => {
    const w = world(true);
    await run(w.read, { path: "a.ts", offset: 2, limit: 1 });
    assert.match(await run(w.edit, EDIT_ONE), /^Successfully replaced/);
  });

  it("rejects an edit to a file that changed after it was read, and says to read it again", async () => {
    const w = world(true);
    await run(w.read, { path: "a.ts" });
    writeFileSync(resolve(w.dir, "a.ts"), "one\ntwo\nthree\n// outside\n");
    const message = await refusal(w.edit, EDIT_ONE);
    assert.equal(message, "`a.ts` changed since it was last read. Read it again before editing (edit.require_read is on).");
    assert.equal(w.text("a.ts"), "one\ntwo\nthree\n// outside\n");
    // Reading it again is the way out.
    await run(w.read, { path: "a.ts" });
    assert.match(await run(w.edit, EDIT_ONE), /^Successfully replaced/);
  });

  it("lets the model's own consecutive edits through without another read", async () => {
    const w = world(true);
    await run(w.read, { path: "a.ts" });
    await run(w.edit, EDIT_ONE);
    assert.match(await run(w.edit, { path: "a.ts", edits: [{ oldText: "three", newText: "THREE" }] }), /^Successfully replaced/);
    assert.equal(w.text("a.ts"), "one\nTWO\nTHREE\n");
  });

  it("treats a path spelled two ways (relative, absolute) as one file", async () => {
    const w = world(true);
    await run(w.read, { path: resolve(w.dir, "a.ts") });
    assert.match(await run(w.edit, EDIT_ONE), /^Successfully replaced/);
  });

  it("keeps its existing not-found error for a file that does not exist", async () => {
    const w = world(true);
    const message = await refusal(w.edit, { path: "nope.ts", edits: [{ oldText: "a", newText: "b" }] });
    assert.match(message, /^Could not edit file: nope\.ts\./);
  });

  it("a failed read records nothing", async () => {
    const w = world(true);
    await assert.rejects(run(w.read, { path: "nope.ts" }));
    assert.equal(w.reads.has(resolve(w.dir, "nope.ts")), false);
  });

  it("a file read in one session is still unread in another", async () => {
    const one = world(true);
    const dir = one.dir;
    await run(one.read, { path: "a.ts" });
    const gate = new RecordingGate();
    const other = buildEditTool({ cwd: dir, gate, reads: new FileReadRecord(true) }) as unknown as AnyTool;
    assert.match(await refusal(other, EDIT_ONE), /has not been read in this session/);
  });
});

describe("edit.require_read on: write", () => {
  it("rejects an overwrite of an existing file that was not read, before the gate, writing nothing", async () => {
    const w = world(true);
    const message = await refusal(w.write, { path: "a.ts", content: "replaced\n" });
    assert.equal(message, "`a.ts` has not been read in this session. Read it first (edit.require_read is on).");
    assert.equal(w.text("a.ts"), "one\ntwo\nthree\n");
    assert.equal(w.gate.requests.length, 0);
  });

  it("accepts an overwrite after a read, and rejects one after an outside change", async () => {
    const w = world(true);
    await run(w.read, { path: "a.ts" });
    await run(w.write, { path: "a.ts", content: "replaced\n" });
    assert.equal(w.text("a.ts"), "replaced\n");
    assert.equal(w.gate.requests.length, 1);

    writeFileSync(resolve(w.dir, "a.ts"), "somebody else\n");
    assert.match(await refusal(w.write, { path: "a.ts", content: "again\n" }), /changed since it was last read/);
    assert.equal(w.text("a.ts"), "somebody else\n");
    assert.equal(w.gate.requests.length, 1);
  });

  it("lets a new file be written without a read, including one in a new directory", async () => {
    const w = world(true);
    await run(w.write, { path: "fresh.ts", content: "new\n" });
    await run(w.write, { path: "sub/deeper/fresh.ts", content: "new too\n" });
    assert.equal(w.text("fresh.ts"), "new\n");
    assert.equal(w.text("sub/deeper/fresh.ts"), "new too\n");
    assert.equal(w.gate.requests.length, 2);
  });

  it("counts a write as a read of what it wrote, so an edit straight after it passes", async () => {
    const w = world(true);
    await run(w.write, { path: "fresh.ts", content: "alpha\nbeta\n" });
    assert.match(await run(w.edit, { path: "fresh.ts", edits: [{ oldText: "beta", newText: "BETA" }] }), /^Successfully replaced/);
  });

  it("a write and an edit share one record: the edit's own write satisfies the write's check", async () => {
    const w = world(true);
    await run(w.read, { path: "a.ts" });
    await run(w.edit, EDIT_ONE);
    await run(w.write, { path: "a.ts", content: "whole new file\n" });
    assert.equal(w.text("a.ts"), "whole new file\n");
  });

  it("a write the human declines is not recorded as written", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "lykos-reqread-deny-"));
    writeFileSync(resolve(dir, "a.ts"), "x\n");
    const deny = { async request(): Promise<ApprovalDecision> { return "deny"; } };
    const reads = new FileReadRecord(true);
    const write = (buildGatedTools(dir, deny, new DenialLog(), { reads }) as unknown as AnyTool[]).find((t) => t.name === "write")!;
    const read = buildReadTool({ cwd: dir, reads }) as unknown as AnyTool;
    await run(read, { path: "a.ts" });
    await assert.rejects(run(write, { path: "a.ts", content: "y\n" }));
    // The file is as it was and still counts as read, so the next attempt is not a stale-read rejection.
    assert.equal(readFileSync(resolve(dir, "a.ts"), "utf8"), "x\n");
    await assert.rejects(run(write, { path: "a.ts", content: "y\n" }), (e: Error) => !e.message.includes("edit.require_read"));
  });
});

describe("edit.require_read off", () => {
  it("checks nothing: an unread file can be edited and overwritten", async () => {
    const w = world(false);
    assert.match(await run(w.edit, EDIT_ONE), /^Successfully replaced/);
    await run(w.write, { path: "a.ts", content: "overwritten\n" });
    assert.equal(w.text("a.ts"), "overwritten\n");
  });

  it("still keeps the record, so the rule can be turned on for the same session", async () => {
    const w = world(false);
    await run(w.read, { path: "a.ts" });
    assert.equal(w.reads.has(resolve(w.dir, "a.ts")), true);
  });

  it("an edit tool built with no record at all behaves as it always did", async () => {
    const dir = mkdtempSync(resolve(tmpdir(), "lykos-reqread-none-"));
    writeFileSync(resolve(dir, "a.ts"), "one\ntwo\n");
    const edit = buildEditTool({ cwd: dir, gate: new RecordingGate() }) as unknown as AnyTool;
    assert.match(await run(edit, EDIT_ONE), /^Successfully replaced/);
  });
});

describe("the descriptions", () => {
  it("are byte-identical to the ones without a record when the rule is off", () => {
    const w = world(false);
    assert.equal(w.edit.description, EDIT_DESCRIPTION);
    const dir = mkdtempSync(resolve(tmpdir(), "lykos-reqread-desc-"));
    const pi = createWriteToolDefinition(dir) as unknown as AnyTool;
    assert.equal(w.write.description, pi.description);
    assert.equal(buildEditTool({ cwd: dir, gate: new RecordingGate() }).description, EDIT_DESCRIPTION);
  });

  it("each gain exactly one sentence when the rule is on", () => {
    const w = world(true);
    assert.equal(w.edit.description, `${EDIT_DESCRIPTION}${REQUIRE_READ_SENTENCE}`);
    const dir = mkdtempSync(resolve(tmpdir(), "lykos-reqread-desc-"));
    const pi = createWriteToolDefinition(dir) as unknown as AnyTool;
    assert.equal(w.write.description, `${pi.description}${REQUIRE_READ_SENTENCE}`);
    assert.equal(REQUIRE_READ_SENTENCE.match(/\./g)?.length, 1, "one sentence");
  });

  it("the gated list is still the same four tools in the same order", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "lykos-reqread-names-"));
    const names = buildGatedTools(dir, new RecordingGate(), undefined, { reads: new FileReadRecord(true) }).map((t) => t.name);
    assert.deepEqual(names, ["write", "edit", "bash", "powershell"]);
  });

  it("the tails the classifier matches are the ones the check throws", () => {
    const record = new FileReadRecord(true);
    const abs = resolve(tmpdir(), "t.ts");
    assert.throws(() => record.check(abs, Buffer.from("x"), "t.ts"), (e: Error) => e.message === `\`t.ts\`${UNREAD_TAIL}`);
    record.noteRead(abs, contentHash("x"));
    assert.throws(() => record.check(abs, Buffer.from("y"), "t.ts"), (e: Error) => e.message === `\`t.ts\`${STALE_TAIL}`);
    assert.doesNotThrow(() => record.check(abs, Buffer.from("x"), "t.ts"));
  });
});
