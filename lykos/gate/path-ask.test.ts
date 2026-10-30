// T210 follow-up: a path rule's ask reaches a human in every permission mode.
// Auto, and a remembered command approval, never answer it. Where no human can
// answer (`--yes`), it is a deny that names the rule and the way out.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { confineToWorkspace } from "../tools/workspace-confine.js";
import { RawApprovalGate } from "../tui/screen/approval-modal.js";
import {
  ApprovalDeniedError,
  AutoApproveGate,
  ReadOnlyGate,
  buildWriteOperations,
  type ApprovalGate,
} from "./approval.js";

let home: string;
let root: string;
let outside: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  // The per-project store and the project registry live under the home directory.
  home = mkdtempSync(join(tmpdir(), "lykos-pathask-home-"));
  root = mkdtempSync(join(tmpdir(), "lykos-pathask-root-"));
  outside = mkdtempSync(join(tmpdir(), "lykos-pathask-outside-"));
  for (const k of ["HOME", "USERPROFILE"]) {
    saved[k] = process.env[k];
    process.env[k] = home;
  }
});

afterEach(() => {
  for (const k of ["HOME", "USERPROFILE"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const d of [home, root, outside]) rmSync(d, { recursive: true, force: true });
});

/** A file tool behind the confine; calling it returns a promise, and `ran` records that the tool itself ran. */
function confineToWorkspaceForTest(name: string, cwd: string, gate: ApprovalGate, ran: string[]): (params: unknown) => Promise<unknown> {
  const inner = {
    name,
    execute: async (_id: string, params: unknown) => {
      ran.push(JSON.stringify(params));
      return { content: [], details: undefined };
    },
  } as unknown as ToolDefinition;
  const t = confineToWorkspace(inner, cwd, gate);
  return (params) => (t.execute as (...a: unknown[]) => Promise<unknown>)("id", params, undefined, undefined, undefined);
}

async function promptOpen(gate: RawApprovalGate): Promise<void> {
  for (let i = 0; i < 500 && !gate.isOpen; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(gate.isOpen, true, "the prompt never opened");
}

describe("T210: a path ask reaches a human in Auto", () => {
  it("Auto + a write outside the directory asks, and 'n' writes nothing", async () => {
    const gate = new RawApprovalGate({ onRender: () => {} });
    gate.setMode("auto");
    const target = join(outside, "a.txt");
    const write = buildWriteOperations(root, gate).writeFile(target, "x");
    await promptOpen(gate);
    gate.feedBytes("n");
    await assert.rejects(write, ApprovalDeniedError);
    assert.equal(existsSync(target), false);
  });

  it("Auto + a write outside the directory runs when the human says yes", async () => {
    const gate = new RawApprovalGate({ onRender: () => {} });
    gate.setMode("auto");
    const target = join(outside, "a.txt");
    const write = buildWriteOperations(root, gate).writeFile(target, "x");
    await promptOpen(gate);
    gate.feedBytes("y");
    await write;
    assert.equal(readFileSync(target, "utf8"), "x");
  });

  it("Auto + a read outside the directory asks", async () => {
    const gate = new RawApprovalGate({ onRender: () => {} });
    gate.setMode("auto");
    const ran: string[] = [];
    const tool = confineToWorkspaceForTest("read", root, gate, ran);
    const call = tool({ path: join(outside, "a.txt") });
    await promptOpen(gate);
    gate.feedBytes("n");
    await assert.rejects(call, ApprovalDeniedError);
    assert.equal(ran.length, 0);
  });

  it("a path ask is not remembered as a command approval ('always' is not offered)", async () => {
    const gate = new RawApprovalGate({ onRender: () => {} });
    gate.setMode("auto");
    const first = buildWriteOperations(root, gate).writeFile(join(outside, "a.txt"), "1");
    await promptOpen(gate);
    gate.feedBytes("a");
    await first.catch(() => {});
    const second = buildWriteOperations(root, gate).writeFile(join(outside, "b.txt"), "2");
    await promptOpen(gate);
    gate.feedBytes("n");
    await assert.rejects(second, ApprovalDeniedError);
  });

  it("an extra directory under Auto runs without asking", async () => {
    const gate = new RawApprovalGate({ onRender: () => {} });
    gate.setMode("auto");
    // The human allows the folder once...
    const first = buildWriteOperations(root, gate).writeFile(join(outside, "a.txt"), "1");
    await promptOpen(gate);
    gate.feedBytes("f");
    await first;
    // ...and the next write there is Auto's to approve, with no prompt.
    await buildWriteOperations(root, gate).writeFile(join(outside, "b.txt"), "2");
    assert.equal(gate.isOpen, false);
    assert.equal(readFileSync(join(outside, "b.txt"), "utf8"), "2");
  });

});

describe("T210: no human to answer (--yes, read-only child)", () => {
  it("AutoApproveGate + a write outside the directory is denied, naming the rule and the way out", async () => {
    const target = join(outside, "a.txt");
    await assert.rejects(
      () => buildWriteOperations(root, new AutoApproveGate()).writeFile(target, "x"),
      (err: unknown) => {
        assert.ok(err instanceof ApprovalDeniedError);
        assert.match(err.message, /path rule: outside the project directory/);
        assert.match(err.message, /allow the folder/);
        assert.match(err.message, /path_rules/);
        return true;
      },
    );
    assert.equal(existsSync(target), false);
  });

  it("AutoApproveGate still approves a write inside the directory", async () => {
    const target = join(root, "a.txt");
    await buildWriteOperations(root, new AutoApproveGate()).writeFile(target, "x");
    assert.equal(readFileSync(target, "utf8"), "x");
  });

  it("the read-only gate does not let an outside read through", async () => {
    const gate = new ReadOnlyGate();
    const tool = confineToWorkspaceForTest("read", root, gate, []);
    await assert.rejects(tool({ path: join(outside, "a.txt") }), ApprovalDeniedError);
  });
});
