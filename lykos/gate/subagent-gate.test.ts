import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AutoApproveGate, PostureGate, ReadOnlyGate, type ApprovalRequest } from "./approval.js";
import { SubagentGate, inheritPermissions } from "./delegated.js";
import { decidePath, type PathContext } from "./path-rules.js";

const CTX: PathContext = { cwd: "/work/proj", home: "/home/u", extraDirs: [], outside: { read: "ask", write: "ask" } };
const write: ApprovalRequest = { kind: "write", summary: "write a file", detail: "/work/proj/a.ts" };
const read: ApprovalRequest = { kind: "read", summary: "read a file", detail: "/work/proj/a.ts" };

function child(parentGate: SubagentGate["parentGate"]) {
  return new SubagentGate({ name: "general", parentGate, mode: "auto", rules: [], ctx: CTX });
}

describe("SubagentGate under a parent that refuses by rule", () => {
  it("a subagent of a read-only Plan session cannot write, though its own mode would allow it", async () => {
    const plan = new PostureGate(new AutoApproveGate(), { readOnly: true });
    const sub = child(plan);
    assert.equal(await sub.request(write), "deny");
    assert.equal(await sub.request(read), "allow");
    assert.match(sub.denialReason(write) ?? "", /read-only/);
  });

  it("the posture lifting (exit_plan) lifts it for the subagent too", async () => {
    const posture = { readOnly: true };
    const sub = child(new PostureGate(new AutoApproveGate(), posture));
    posture.readOnly = false;
    assert.equal(await sub.request(write), "allow");
  });

  it("holds through a nested subagent and under a read-only child gate", async () => {
    const nested = child(child(new PostureGate(new AutoApproveGate(), { readOnly: true })));
    assert.equal(await nested.request(write), "deny");
    assert.equal(await child(new ReadOnlyGate()).request(write), "deny");
  });
});

describe("inheritPermissions keeps a child's rules in its own source", () => {
  it("a child negation labelled global cannot cancel the parent's global deny", () => {
    const parentRules = [{ pattern: "private/**", access: "read" as const, decision: "deny" as const, source: "global" }];
    const inherited = inheritPermissions(
      { mode: "auto", rules: parentRules, ctx: CTX },
      { rules: [{ pattern: "!private/**", access: "read", decision: "deny", source: "global" }] },
    );
    assert.equal(decidePath("/work/proj/private/a.md", "read", inherited.rules, inherited.ctx).decision, "deny");
  });
});
