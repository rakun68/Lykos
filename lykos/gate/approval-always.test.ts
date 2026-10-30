// T131 follow-up — the `allow-always` bypass, found independently by both
// review axes on 2026-09-08.
//
// `authorize()` used to short-circuit on `alwaysAllowed.has(req.kind)`
// BEFORE calling `gate.request()`. Because the interaction mode lives inside
// the gate, that short-circuit did not merely widen one approval — it took
// the mode out of the decision entirely. One `a` answered to `npm test`
// marked the whole `bash` KIND allowed for the rest of the process, so every
// later command ran unasked: destructive ones, and ones issued after
// switching to Ask or Plan, which are supposed to be read-only. The same
// held for `write`/`edit`, which made Plan and Ask writable.
//
// These tests exist so that specific shape cannot come back.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  ApprovalDeniedError,
  buildBashOperations,
  buildEditOperations,
  buildWriteOperations,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
} from "./approval.js";

/** Records every request it is asked about, and answers from a script. */
class ScriptedGate implements ApprovalGate {
  readonly seen: ApprovalRequest[] = [];
  constructor(private readonly answers: ApprovalDecision[]) {}
  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.seen.push(req);
    return Promise.resolve(this.answers.shift() ?? "deny");
  }
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lykos-always-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("allow-always never takes the gate out of the loop", () => {
  it("still asks about the NEXT bash command, so a later destructive one can be refused", async () => {
    const gate = new ScriptedGate(["allow-always", "deny"]);
    const ops = buildBashOperations(root, gate);

    await ops.exec("echo one", root, { onData: () => {} });
    await assert.rejects(
      () => ops.exec("echo two", root, { onData: () => {} }),
      ApprovalDeniedError,
      "an always-allow on one command must not pre-approve every later one",
    );
    assert.equal(gate.seen.length, 2, "the gate saw both commands");
    assert.equal(gate.seen[1]?.detail, "echo two");
  });

  it("still asks about the NEXT write, so a mode change can refuse it", async () => {
    const gate = new ScriptedGate(["allow-always", "deny"]);
    const ops = buildWriteOperations(root, gate);

    await ops.writeFile(join(root, "a.txt"), "x");
    await assert.rejects(() => ops.writeFile(join(root, "b.txt"), "y"), ApprovalDeniedError);
    assert.equal(gate.seen.length, 2);
  });

  it("still asks about the NEXT edit", async () => {
    const gate = new ScriptedGate(["allow-always", "deny"]);
    const ops = buildEditOperations(root, gate);

    await ops.writeFile(join(root, "a.txt"), "x");
    await assert.rejects(() => ops.writeFile(join(root, "a.txt"), "y"), ApprovalDeniedError);
    assert.equal(gate.seen.length, 2);
  });

  it("does not leak across tool kinds either — an allowed bash never approves a write", async () => {
    const gate = new ScriptedGate(["allow-always", "deny"]);
    const bash = buildBashOperations(root, gate);
    const write = buildWriteOperations(root, gate);

    await bash.exec("echo one", root, { onData: () => {} });
    await assert.rejects(() => write.writeFile(join(root, "a.txt"), "x"), ApprovalDeniedError);
  });

  it("treats allow-always as allow for the request that answered it", async () => {
    const gate = new ScriptedGate(["allow-always"]);
    const ops = buildBashOperations(root, gate);
    await ops.exec("echo ok", root, { onData: () => {} });
    assert.equal(gate.seen.length, 1);
  });

  it("asks the gate about a path outside the root, and a refusal there still refuses (T210)", async () => {
    const gate = new ScriptedGate(["deny"]);
    const ops = buildWriteOperations(root, gate);
    const target = join(tmpdir(), "outside-the-root.txt");
    await assert.rejects(() => ops.writeFile(target, "x"), ApprovalDeniedError);
    assert.equal(gate.seen.length, 1, "outside the root now asks instead of being refused outright");
    assert.equal(existsSync(target), false);
  });

  it("a deny rule still refuses a path outside the root without ever asking (T210)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "lykos-t210-always-outside-"));
    try {
      mkdirSync(join(root, ".lykos"), { recursive: true });
      writeFileSync(join(root, ".lykos", "config.yaml"), `path_rules:
  write:
    '${outside.split("\\").join("/")}/**': deny
`);
      const gate = new ScriptedGate(["allow"]);
      const ops = buildWriteOperations(root, gate);
      await assert.rejects(() => ops.writeFile(join(outside, "x.txt"), "x"), ApprovalDeniedError);
      assert.equal(gate.seen.length, 0, "a deny is never a question");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
