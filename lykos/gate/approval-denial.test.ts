import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { ApprovalDeniedError, DenialLog, buildBashOperations, buildWriteOperations } from "./approval.js";
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from "./approval.js";

class FixedGate implements ApprovalGate {
  constructor(private readonly decision: ApprovalDecision) {}
  async request(_req: ApprovalRequest): Promise<ApprovalDecision> {
    return this.decision;
  }
}

const CWD = resolve(tmpdir(), "lykos-t87-repo");
const INSIDE = join(CWD, "x.ts");
const OUTSIDE = resolve(tmpdir(), "lykos-t87-elsewhere", "x.ts");

/** A project deny rule for writes under `target`, written where the loader reads it. */
function writeDenyRule(root: string, target: string): void {
  mkdirSync(join(root, ".lykos"), { recursive: true });
  writeFileSync(join(root, ".lykos", "config.yaml"), `path_rules:
  write:
    '${target.split("\\").join("/")}/**': deny
`);
}

async function denialFrom(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof ApprovalDeniedError, `expected a denial, got ${String(err)}`);
    return (err as Error).message;
  }
  assert.fail("expected the operation to be refused");
}

describe("T87 refusal messages are written for the model", () => {
  it("a path denied by a rule says the rule and that retrying is pointless (T210)", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-t210-denial-root-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "lykos-t210-denial-elsewhere-"));
    try {
      writeDenyRule(root, elsewhere);
      const denials = new DenialLog();
      const ops = buildWriteOperations(root, new FixedGate("allow"), denials);
      const msg = await denialFrom(() => ops.writeFile(join(elsewhere, "x.ts"), "x"));
      assert.ok(msg.includes("denied"), msg);
      assert.ok(msg.includes("do not retry this path"), "the model must learn the retry is futile");
      assert.ok(!msg.includes("T30.2"), "internal task IDs are noise the model cannot act on");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("an out-of-root path with no rule asks, and a human refusal is a choice (T210)", async () => {
    const denials = new DenialLog();
    const ops = buildWriteOperations(CWD, new FixedGate("deny"), denials);
    const msg = await denialFrom(() => ops.writeFile(OUTSIDE, "x"));
    assert.ok(msg.includes("declined"), msg);
    assert.equal(denials.userRejected, 1);
  });

  it("a human refusal says it is a choice, and names the target", async () => {
    const denials = new DenialLog();
    const ops = buildWriteOperations(CWD, new FixedGate("deny"), denials);
    const msg = await denialFrom(() => ops.writeFile(INSIDE, "x"));
    assert.ok(msg.includes("declined"));
    assert.ok(msg.includes("a choice, not a failure"));
    assert.ok(msg.includes(INSIDE), "the model has to know WHICH target was refused");
    assert.ok(msg.includes("different approach"));
  });

  it("counts the two refusal kinds separately", async () => {
    const denials = new DenialLog();
    const root = mkdtempSync(join(tmpdir(), "lykos-t210-count-root-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "lykos-t210-count-elsewhere-"));
    try {
      writeDenyRule(root, elsewhere);
      const allow = buildWriteOperations(root, new FixedGate("allow"), denials);
      const deny = buildWriteOperations(CWD, new FixedGate("deny"), denials);
      await denialFrom(() => allow.writeFile(join(elsewhere, "x.ts"), "x"));
      await denialFrom(() => deny.writeFile(INSIDE, "x"));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
    assert.equal(denials.outOfRoot, 1);
    assert.equal(denials.userRejected, 1);
    assert.equal(denials.total, 2);
    assert.ok(denials.last?.includes("user_rejected"));
  });

  it("counts a refused bash command too", async () => {
    const denials = new DenialLog();
    const ops = buildBashOperations(CWD, new FixedGate("deny"), denials);
    const msg = await denialFrom(() => ops.exec("rm -rf /", CWD, { onData: () => {} }));
    assert.ok(msg.includes("declined"));
    assert.equal(denials.userRejected, 1);
  });

  it("allows normally when the gate allows, and counts nothing", async () => {
    const denials = new DenialLog();
    const dir = mkdtempSync(join(tmpdir(), "lykos-t87-"));
    try {
      const ops = buildWriteOperations(dir, new FixedGate("allow"), denials);
      await ops.writeFile(join(dir, "ok.txt"), "hello");
      assert.equal(denials.total, 0, "an allowed action is not an intervention");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
