import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectPathRules, containmentPathPlan, decidePath, type PathContext } from "./path-rules.js";

const CTX: PathContext = { cwd: "/work/proj", home: "/home/u", extraDirs: [], outside: { read: "ask", write: "ask" } };

describe("decidePath: dot segments", () => {
  it("judges a path that climbs out of the directory by where it points", () => {
    assert.equal(decidePath("/work/proj/../../etc/passwd", "read", [], CTX).decision, "ask");
    assert.equal(decidePath("../outside.txt", "write", [], CTX).decision, "ask");
  });

  it("a deny rule still matches through dot segments", () => {
    const rules = [{ pattern: "~/.ssh/**", access: "read" as const, decision: "deny" as const, source: "global" }];
    assert.equal(decidePath("/work/proj/../../home/u/./.ssh/id_rsa", "read", rules, CTX).decision, "deny");
  });

  it("a path that climbs and comes back inside stays inside", () => {
    assert.equal(decidePath("/work/proj/src/../lib/a.ts", "read", [], CTX).decision, "allow");
  });
});

describe("T211 regressions", () => {
  it("credential store WAL/SHM/journal files are denied for read", () => {
    const rules = collectPathRules({}, false);
    const ctx: PathContext = { cwd: "/work/proj", home: "/home/u", extraDirs: ["/home/u"], outside: { read: "ask", write: "ask" } };
    for (const p of ["credentials.db-wal", "credentials.db-shm", "credentials.db-journal"]) {
      const v = decidePath(`/home/u/.lykos/${p}`, "read", rules, ctx);
      assert.equal(v.decision, "deny", `${p}: got ${v.decision}`);
    }
  });

  it("writing secrets inside a session worktree remains denied", () => {
    const rules = collectPathRules({}, false);
    const wt = "/home/u/.lykos/worktrees/proj/session1";
    const ctx: PathContext = { cwd: wt, home: "/home/u", extraDirs: [], outside: { read: "ask", write: "ask" } };
    const envRes = decidePath(`${wt}/.env`, "write", rules, ctx);
    assert.equal(envRes.decision, "deny");
    const rsaRes = decidePath(`${wt}/deploy/id_rsa`, "write", rules, ctx);
    assert.equal(rsaRes.decision, "deny");
  });

  it("Lykos memory writes do not ask", () => {
    const rules = collectPathRules({}, false);
    const ctx: PathContext = { cwd: "/work/proj", home: "/home/u", extraDirs: [], outside: { read: "ask", write: "ask" } };
    assert.equal(decidePath("/home/u/.lykos/memory/gotchas.md", "write", rules, ctx).decision, "allow");
    assert.equal(decidePath("/work/proj/.lykos/memory/gotchas.md", "write", rules, ctx).decision, "allow");
  });

  it("a user deny for .env.example reaches container shadow list without exception", () => {
    const ctx: PathContext = { cwd: "/work/proj", home: "/home/u", extraDirs: [], outside: { read: "ask", write: "ask" } };
    const rules = collectPathRules({ global: { read: { "*.env.example": "deny" } } }, true);
    assert.equal(decidePath("/work/proj/.env.example", "read", rules, ctx).decision, "deny");
    const plan = containmentPathPlan(rules);
    assert.ok(plan.secretPatterns.includes("*.env.example"));
    assert.ok(!plan.secretExceptions.includes("*.env.example"));
  });

  it("absolute user deny patterns inside workspace are included in container plan", () => {
    const ctx: PathContext = { cwd: "/work/proj", home: "/home/u", extraDirs: [], outside: { read: "ask", write: "ask" } };
    const rules = collectPathRules({ global: { read: { "/work/proj/secrets/**": "deny" } } }, true);
    assert.equal(decidePath("/work/proj/secrets/key.txt", "read", rules, ctx).decision, "deny");
    const plan = containmentPathPlan(rules);
    assert.ok(plan.secretPatterns.length > 6);
  });
});
