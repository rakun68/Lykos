// T213 acceptance (sealed): delegated sessions deny asks, subagents inherit and tighten (ADR-0041).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DelegatedGate, inheritPermissions, labelForSubagent, type DeniedAction } from "./delegated.js";
import type { ApprovalRequest } from "./approval.js";
import { collectPathRules, decidePath, type PathContext } from "./path-rules.js";

const write = (detail: string, extra: Partial<ApprovalRequest> = {}): ApprovalRequest => ({ kind: "write", summary: "write a file", detail, ...extra });
const bash = (command: string): ApprovalRequest => ({ kind: "bash", summary: command, detail: command, shell: "bash" });

describe("T213: a delegated session has nobody to ask", () => {
  it("turns a path ask into a deny and lists it with its rule", async () => {
    const denied: DeniedAction[] = [];
    const gate = new DelegatedGate({ mode: "auto", allowed: new Set(), denied });
    const req = write("/elsewhere/out.txt", { pathAsk: { rule: "outside the directory" } });
    assert.equal(await gate.request(req), "deny");
    assert.equal(denied.length, 1);
    assert.equal(denied[0]!.kind, "write");
    assert.equal(denied[0]!.detail, "/elsewhere/out.txt");
    assert.match(denied[0]!.rule, /outside/);
    assert.match(gate.denialReason(req) ?? "", /outside/);
  });

  it("turns a mode ask into a deny: a risky command under Auto, an edit under Manual", async () => {
    const denied: DeniedAction[] = [];
    assert.equal(await new DelegatedGate({ mode: "auto", allowed: new Set(), denied }).request(bash("rm -rf build")), "deny");
    assert.equal(await new DelegatedGate({ mode: "manual", allowed: new Set(), denied }).request(write("/work/proj/a.ts")), "deny");
    assert.equal(denied.length, 2);
    assert.ok(denied.every((d) => d.rule.length > 0));
  });

  it("allows what the mode allows without asking", async () => {
    const denied: DeniedAction[] = [];
    const gate = new DelegatedGate({ mode: "auto", allowed: new Set(), denied });
    assert.equal(await gate.request(write("/work/proj/a.ts")), "allow");
    assert.equal(await gate.request(bash("git status")), "allow");
    assert.equal(denied.length, 0);
  });
});

describe("T213: a subagent inherits and can only tighten", () => {
  const CTX: PathContext = { cwd: "/work/proj", home: "/home/u", extraDirs: ["/data"], outside: { read: "ask", write: "ask" } };

  it("takes the parent's mode, and a child may only pick a stricter one", () => {
    assert.equal(inheritPermissions({ mode: "auto", rules: [], ctx: CTX }, {}).mode, "auto");
    assert.equal(inheritPermissions({ mode: "auto", rules: [], ctx: CTX }, { mode: "manual" }).mode, "manual");
    assert.equal(inheritPermissions({ mode: "manual", rules: [], ctx: CTX }, { mode: "auto" }).mode, "manual");
    assert.equal(inheritPermissions({ mode: "accept-edits", rules: [], ctx: CTX }, { mode: "auto" }).mode, "accept-edits");
  });

  it("cannot reach a path the parent denies, whatever the child's rules say", () => {
    const parentRules = collectPathRules({ global: { read: { "private/**": "deny" } } }, true);
    const child = inheritPermissions(
      { mode: "auto", rules: parentRules, ctx: CTX },
      { rules: [{ pattern: "private/**", access: "read", decision: "allow", source: "subagent" }, { pattern: "!private/**", access: "read", decision: "deny", source: "subagent" }] },
    );
    assert.equal(decidePath("/work/proj/private/a.md", "read", child.rules, child.ctx).decision, "deny");
  });

  it("keeps the parent's extra directories and outside rules, and cannot widen them", () => {
    const child = inheritPermissions(
      { mode: "auto", rules: [], ctx: CTX },
      { extraDirs: ["/home/u"], outside: { read: "allow", write: "allow" } },
    );
    assert.deepEqual([...child.ctx.extraDirs], ["/data"]);
    assert.equal(child.ctx.outside.read, "ask");
    assert.equal(child.ctx.outside.write, "ask");
  });

  it("can tighten the outside rules and add deny rules", () => {
    const child = inheritPermissions(
      { mode: "auto", rules: [], ctx: CTX },
      { outside: { read: "deny", write: "deny" }, rules: [{ pattern: "docs/**", access: "write", decision: "deny", source: "subagent" }] },
    );
    assert.equal(child.ctx.outside.read, "deny");
    assert.equal(decidePath("/work/proj/docs/a.md", "write", child.rules, child.ctx).decision, "deny");
  });
});

describe("T213: a subagent's ask is labelled in the parent", () => {
  it("names the subagent in the request the parent sees", () => {
    const labelled = labelForSubagent(write("/work/proj/a.ts"), "explore");
    assert.match(labelled.summary, /explore/);
    assert.equal(labelled.detail, "/work/proj/a.ts");
    assert.equal(labelled.kind, "write");
  });
});
