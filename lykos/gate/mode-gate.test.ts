// P5 #55: the interaction modes the old full-screen gate applied, now in front of the gate lykos-tui's session
// asks through. The asker here is a script; `path-ask.test.ts` drives the real `TerminalApprovalGate`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApprovalMetrics } from "./approval-metrics.js";
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from "./approval.js";
import { ModeGate } from "./mode-gate.js";

function asker(answers: ApprovalDecision[]): ApprovalGate & { asked: ApprovalRequest[] } {
  const asked: ApprovalRequest[] = [];
  return {
    asked,
    request: async (req) => {
      asked.push(req);
      return answers.shift() ?? "deny";
    },
  };
}

const bash = (command: string): ApprovalRequest => ({ kind: "bash", summary: command, detail: command });
const write: ApprovalRequest = { kind: "write", summary: "write a.txt", detail: "/w/a.txt" };

describe("P5 #55 ModeGate", () => {
  it("Accept Edits allows a write without asking", async () => {
    const human = asker([]);
    const gate = new ModeGate(human);
    gate.setMode("accept-edits");
    assert.equal(await gate.request(write), "allow");
    assert.equal(human.asked.length, 0);
  });

  it("Manual asks for a write, and the human's answer stands", async () => {
    const human = asker(["allow"]);
    const gate = new ModeGate(human);
    gate.setMode("manual");
    assert.equal(await gate.request(write), "allow");
    assert.equal(human.asked.length, 1);
  });

  it("'always' on a command remembers its patterns, and a remembered command runs in Auto without asking", async () => {
    const human = asker(["allow-always"]);
    const remembered: string[] = [];
    const gate = new ModeGate(human, { onRemember: (p) => remembered.push(...p) });
    gate.setMode("auto");
    assert.equal(await gate.request(bash("git push origin main")), "allow-always", "Auto asks for a push it has not been told to remember");
    assert.ok(remembered.length > 0, "patterns were remembered");
    gate.setAllowlist(new Set(remembered));
    assert.equal(await gate.request(bash("git push origin main")), "allow");
    assert.equal(human.asked.length, 1);
  });

  it("'always' on a destructive command runs it once and remembers nothing", async () => {
    const human = asker(["allow-always"]);
    const remembered: string[] = [];
    const gate = new ModeGate(human, { onRemember: (p) => remembered.push(...p) });
    gate.setMode("manual");
    assert.equal(await gate.request(bash("rm -rf build")), "allow");
    assert.deepEqual(remembered, []);
  });

  it("counts every decision by mode, and a human's no as a human denial", async () => {
    const metrics = new ApprovalMetrics();
    const gate = new ModeGate(asker(["deny"]), { metrics });
    gate.setMode("manual");
    await gate.request(write);
    assert.equal(metrics.totals.requested, 1);
    assert.equal(metrics.totals.denied, 1);
    assert.match(metrics.serializeByMode(), /"manual"/);
  });
});
