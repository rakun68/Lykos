// T210: the file tools consult the path rules. Outside the project asks, a deny refuses with the rule named.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from "../gate/approval.js";
import { confineToWorkspace } from "./workspace-confine.js";

class Gate implements ApprovalGate {
  readonly seen: ApprovalRequest[] = [];
  constructor(private readonly answer: ApprovalDecision) {}
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.seen.push(req);
    return this.answer;
  }
}

function tool(name: string, ran: string[]): ToolDefinition {
  return {
    name,
    execute: async (_id: string, params: unknown) => {
      ran.push(JSON.stringify(params));
      return { content: [], details: undefined };
    },
  } as unknown as ToolDefinition;
}

async function call(t: ToolDefinition, params: unknown): Promise<void> {
  await (t.execute as (...a: unknown[]) => Promise<unknown>)("id", params, undefined, undefined, undefined);
}

function denyRule(root: string, access: "read" | "write", target: string): void {
  mkdirSync(join(root, ".lykos"), { recursive: true });
  writeFileSync(
    join(root, ".lykos", "config.yaml"),
    `path_rules:\n  ${access}:\n    '${target.split("\\").join("/")}/**': deny\n`,
  );
}

describe("confineToWorkspace under path rules (T210)", () => {
  it("asks about a read outside the project and does not run the tool when declined", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-t210-conf-root-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "lykos-t210-conf-else-"));
    try {
      const ran: string[] = [];
      const gate = new Gate("deny");
      await assert.rejects(() => call(confineToWorkspace(tool("read", ran), root, gate), { path: join(elsewhere, "a.txt") }), /declined/);
      assert.equal(gate.seen.length, 1);
      assert.equal(ran.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("runs a read outside the project once the human allows it", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-t210-conf-root-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "lykos-t210-conf-else-"));
    try {
      const ran: string[] = [];
      const gate = new Gate("allow");
      await call(confineToWorkspace(tool("grep", ran), root, gate), { path: join(elsewhere, "a.txt") });
      assert.equal(gate.seen.length, 1);
      assert.equal(ran.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("does not ask about a path inside the project", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-t210-conf-root-"));
    try {
      const ran: string[] = [];
      const gate = new Gate("deny");
      await call(confineToWorkspace(tool("read", ran), root, gate), { path: "src/a.ts" });
      assert.equal(gate.seen.length, 0);
      assert.equal(ran.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a denied path without asking, naming the rule", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-t210-conf-root-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "lykos-t210-conf-else-"));
    try {
      denyRule(root, "read", elsewhere);
      const ran: string[] = [];
      const gate = new Gate("allow");
      await assert.rejects(
        () => call(confineToWorkspace(tool("read", ran), root, gate), { path: join(elsewhere, "a.txt") }),
        /denied: secret path/,
      );
      assert.equal(gate.seen.length, 0);
      assert.equal(ran.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("refuses a symlink inside the project that points at a denied folder", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "lykos-t210-conf-root-"));
    const vault = mkdtempSync(join(tmpdir(), "lykos-t210-conf-vault-"));
    try {
      try {
        symlinkSync(vault, join(root, "innocent"), "junction");
      } catch {
        t.skip("cannot create a symlink here");
        return;
      }
      writeFileSync(join(vault, "key.txt"), "secret");
      denyRule(root, "read", vault);
      const ran: string[] = [];
      await assert.rejects(
        () => call(confineToWorkspace(tool("read", ran), root, new Gate("allow")), { path: "innocent/key.txt" }),
        /denied/,
      );
      assert.equal(ran.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(vault, { recursive: true, force: true });
    }
  });
});
