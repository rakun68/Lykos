// T211 review round: each finding reproduced against the real functions.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildWriteOperations, type ApprovalGate, type ApprovalRequest } from "./approval.js";
import { collectPathRules, containmentPathPlan, decidePath, type PathContext } from "./path-rules.js";

const ctxAt = (cwd: string, extra: string[] = []): PathContext => ({
  cwd,
  home: "/home/u",
  extraDirs: extra,
  outside: { read: "ask", write: "ask" },
});

describe("T211 review: secrets are never cancelled by the shipped exceptions", () => {
  const wt = "/home/u/.lykos/worktrees/proj/session1";
  it("1.2: .env, id_rsa and a credential journal stay denied in a worktree", () => {
    const rules = collectPathRules({}, false);
    for (const p of [`${wt}/.env`, `${wt}/deploy/id_rsa`, `${wt}/k.pem`]) {
      assert.equal(decidePath(p, "write", rules, ctxAt(wt)).decision, "deny", p);
    }
    assert.equal(decidePath("/home/u/.lykos/memory/.env", "write", rules, ctxAt("/work/proj")).decision, "deny");
  });
  it("1.2: a worktree's own .git is still a protected ask", () => {
    const v = decidePath(`${wt}/.git/config`, "write", collectPathRules({}, false), ctxAt(wt));
    assert.equal(v.decision, "ask");
    assert.equal(v.protected, true);
  });
  it("1.2: the worktree exception does not block a user's own negation of a user deny", () => {
    const rules = collectPathRules({ global: { read: { "deploy/**": "deny", "!deploy/worktrees/**": "allow" } } }, true);
    assert.equal(decidePath("/work/proj/deploy/worktrees/a", "read", rules, ctxAt("/work/proj")).decision, "allow");
    assert.equal(decidePath("/work/proj/deploy/b", "read", rules, ctxAt("/work/proj")).decision, "deny");
  });
  it("1.1: the credential store's WAL and SHM are denied for read and write", () => {
    const rules = collectPathRules({}, false);
    for (const f of ["credentials.db", "credentials.db-wal", "credentials.db-shm"]) {
      for (const a of ["read", "write"] as const) {
        assert.equal(decidePath(`/home/u/.lykos/${f}`, a, rules, ctxAt("/work/proj", ["/home/u"])).decision, "deny", `${f} ${a}`);
      }
    }
  });
  it("1.4: a ~/.lykos/memory write is allowed with no extra directory", () => {
    const v = decidePath("/home/u/.lykos/memory/gotchas.md", "write", collectPathRules({}, false), ctxAt("/work/proj"));
    assert.equal(v.decision, "allow");
  });
});

describe("T211 review: the container plan follows each rule's source", () => {
  it("1.5: a user's own `!*.pem` does not unshadow a shipped *.pem", () => {
    const rules = collectPathRules({ global: { read: { "!*.pem": "allow" } } }, true);
    assert.equal(decidePath("/work/proj/a.pem", "read", rules, ctxAt("/work/proj")).decision, "deny");
    const plan = containmentPathPlan(rules);
    assert.ok(plan.secretPatterns.includes("*.pem"));
    assert.ok(!plan.secretExceptions.includes("*.pem"));
  });
  it("1.5: a user deny of the literal .env.example is not unshadowed by the shipped !*.env.example", () => {
    const rules = collectPathRules({ global: { read: { ".env.example": "deny" } } }, true);
    assert.equal(decidePath("/work/proj/.env.example", "read", rules, ctxAt("/work/proj")).decision, "deny");
    const plan = containmentPathPlan(rules);
    assert.ok(!plan.secretExceptions.some((e) => e === "*.env.example"), JSON.stringify(plan.secretExceptions));
  });
  it("1.5: the shipped exception still holds when nobody denies .env.example", () => {
    assert.deepEqual(containmentPathPlan(collectPathRules({}, false)).secretExceptions, ["*.env.example"]);
  });
  it("1.6: an absolute deny inside the workspace is kept, relativised to it", () => {
    const rules = collectPathRules({ global: { read: { "/work/proj/secrets/**": "deny", "/elsewhere/x/**": "deny" } } }, true);
    const plan = containmentPathPlan(rules, ctxAt("/work/proj"));
    assert.ok(plan.secretPatterns.includes("secrets/**"), JSON.stringify(plan.secretPatterns));
    assert.ok(!plan.secretPatterns.some((p) => p.startsWith("/")), JSON.stringify(plan.secretPatterns));
  });
});

describe("T211 review: session-allowed protected paths belong to one gate", () => {
  let home: string;
  let root: string;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "lykos-t211-home-"));
    root = mkdtempSync(join(tmpdir(), "lykos-t211-root-"));
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
    for (const d of [home, root]) rmSync(d, { recursive: true, force: true });
  });
  const recording = (seen: ApprovalRequest[]): ApprovalGate => ({
    async request(req) {
      seen.push(req);
      return "allow";
    },
  });
  it("1.7: a second gate asks again for a path the first gate allowed", async () => {
    const target = join(root, ".git", "config");
    const a: ApprovalRequest[] = [];
    const b: ApprovalRequest[] = [];
    const opsA = buildWriteOperations(root, recording(a));
    await opsA.writeFile(target, "x");
    await opsA.writeFile(target, "y");
    assert.equal(a.length, 2);
    assert.equal(a[0]?.pathAsk?.protected, true);
    assert.equal(a[1]?.pathAsk, undefined, "the same gate remembers its own session allow");
    await buildWriteOperations(root, recording(b)).writeFile(target, "z");
    assert.equal(b[0]?.pathAsk?.protected, true, "another gate must not inherit it");
  });
});

describe("T211 review: a user's own exception does not unshadow a shipped secret in the container", () => {
  it("1.5: user `!id_rsa.pub` is a host no-op, so it is no container exception", () => {
    const rules = collectPathRules({ global: { read: { "!id_rsa.pub": "allow" } } }, true);
    assert.equal(decidePath("/work/proj/id_rsa.pub", "read", rules, ctxAt("/work/proj")).decision, "deny");
    assert.ok(!containmentPathPlan(rules).secretExceptions.includes("id_rsa.pub"));
  });
});

describe("T211 review: a protected prompt offers no always or folder, by key or by click", () => {
  const req: ApprovalRequest = {
    kind: "write",
    summary: "write .git/config",
    detail: "/work/proj/.git/config",
    pathAsk: { rule: ".git/**", protected: true },
  };
  it("1.3: the a and f keys are ignored and y allows for the session only", async () => {
    const { RawApprovalGate } = await import("../tui/screen/approval-modal.js");
    const folders: string[] = [];
    const gate = new RawApprovalGate({ projectId: "p", cwd: "/work/proj", onRender: () => {}, onRememberFolder: (f: string) => folders.push(f) });
    const p = gate.request(req);
    gate.feedBytes("a");
    gate.feedBytes("f");
    assert.equal(gate.isOpen, true);
    gate.feedBytes("y");
    assert.equal(await p, "allow");
    assert.deepEqual(folders, []);
  });
});
