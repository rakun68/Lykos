import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { assembleBootHead, detectVolatile, fingerprintHead, parseBootFields, HEAD_FIELD_ORDER, HeadContract, type BootArtifacts } from "./head-contract.js";

const FROZEN: BootArtifacts = {
  cwd: "/work",
  platform: "linux",
  project: "Lykos",
  gitHeadAtBoot: "deadbeefcafebabe",
  toolNames: ["read", "grep", "find", "ls"],
};

function fullPrompt(bootHead: string, extra = ""): string {
  return `You are a coding agent.\n${bootHead}${extra}`;
}

describe("assembleBootHead (T17.1 deterministic assembly)", () => {
  it("emits fields in the documented HEAD_FIELD_ORDER and nothing else", () => {
    const text = assembleBootHead(FROZEN);
    const keys = text
      .split("\n")
      .filter((line) => line.includes(": "))
      .map((line) => line.slice(0, line.indexOf(":")));
    assert.deepEqual(keys, [...HEAD_FIELD_ORDER]);
    assert.equal(keys[0], "cwd");
    assert.equal(keys[keys.length - 1], "tools");
  });

  it("is byte-identical across repeated calls with the same frozen inputs", () => {
    assert.equal(assembleBootHead(FROZEN), assembleBootHead({ ...FROZEN, toolNames: [...FROZEN.toolNames] }));
  });

  it("preserves caller tool order — it does not sort", () => {
    const reversed = assembleBootHead({ ...FROZEN, toolNames: ["ls", "find", "grep", "read"] });
    assert.match(reversed, /tools: ls,find,grep,read/);
    assert.equal(reversed.includes("tools: read,grep,find,ls"), false);
  });

  it("contains no clock, no git-status, no session-overview", () => {
    const text = assembleBootHead(FROZEN);
    assert.deepEqual(detectVolatile(text), []);
    assert.equal(/\d{4}-\d{2}-\d{2}T/.test(text), false);
    assert.equal(text.includes("git status"), false);
    assert.equal(text.includes("<session-overview"), false);
  });

  it("renders an empty tool list as the stable '(pi-default)' token, not a missing line", () => {
    const text = assembleBootHead({ ...FROZEN, toolNames: [] });
    assert.match(text, /tools: \(pi-default\)$/m);
  });

});

describe("fingerprintHead", () => {
  it("is SHA-256 of systemPrompt + NUL + toolNames joined by comma", () => {
    const prompt = "hello";
    const tools = ["read", "bash"];
    const expected = createHash("sha256").update(prompt).update("\0").update("read,bash").digest("hex");
    assert.equal(fingerprintHead(prompt, tools), expected);
  });

  it("changes when tool order changes even if the set is the same", () => {
    const prompt = "same";
    const a = fingerprintHead(prompt, ["read", "edit"]);
    const b = fingerprintHead(prompt, ["edit", "read"]);
    assert.notEqual(a, b);
  });

  it("changes when the system prompt changes and tools do not", () => {
    const tools = ["read"];
    assert.notEqual(fingerprintHead("a", tools), fingerprintHead("b", tools));
  });
});

describe("detectVolatile", () => {
  it("flags the <session-overview> churn T16.1 found in the wild", () => {
    assert.deepEqual(detectVolatile("<session-overview>\ngit log excerpt\n</session-overview>"), [
      "session-overview",
    ]);
  });

  it("flags an ISO timestamp and a live git status/branch line", () => {
    const text = "now: 2026-08-29T13:04:00Z\nran git status\nran git branch --show-current";
    const kinds = detectVolatile(text);
    assert.ok(kinds.includes("timestamp"));
    assert.ok(kinds.includes("git-status"));
    assert.ok(kinds.includes("git-branch"));
  });

  it("does not flag a frozen git SHA in the boot block", () => {
    assert.deepEqual(detectVolatile(assembleBootHead(FROZEN)), []);
  });

  it("flags the test-only [lykos-volatile …] injector", () => {
    assert.ok(detectVolatile("head\n[lykos-volatile 1719900000000]\n").includes("lykos-volatile-inject"));
  });
});

describe("parseBootFields", () => {
  it("round-trips assembleBootHead and returns null when the block is missing", () => {
    const text = assembleBootHead(FROZEN);
    assert.deepEqual(parseBootFields(`preamble\n${text}\n`), {
      cwd: "/work",
      platform: "linux",
      project: "Lykos",
      git_head: "deadbeefcafebabe",
      tools: "read,grep,find,ls",
    });
    assert.equal(parseBootFields("no boot block here"), null);
  });
});

describe("HeadContract (T17.2 boot-once, T17.3 append-only)", () => {
  it("boot then two identical observes: fingerprint matches, changed is false after the first", () => {
    const c = new HeadContract();
    const { bootHead } = c.boot(FROZEN);
    const prompt = fullPrompt(bootHead);
    const first = c.observe(prompt, FROZEN.toolNames);
    const second = c.observe(prompt, FROZEN.toolNames);
    assert.equal(first.changed, false);
    assert.equal(second.changed, false);
    assert.equal(first.fingerprint, second.fingerprint);
    assert.deepEqual(first.driftedFields, []);
    assert.deepEqual(second.driftedFields, []);
  });

  it("a deliberately-injected volatile string in the head changes the fingerprint (negative direction)", () => {
    const c = new HeadContract();
    const { bootHead } = c.boot(FROZEN);
    const stable = fullPrompt(bootHead);
    const first = c.observe(stable, FROZEN.toolNames);
    const drifted = c.observe(fullPrompt(bootHead, `\n[lykos-volatile ${Date.now()}]`), FROZEN.toolNames);
    assert.equal(first.changed, false);
    assert.equal(drifted.changed, true);
    assert.notEqual(drifted.fingerprint, first.fingerprint);
    assert.ok(drifted.driftedFields.includes("volatile:lykos-volatile-inject"));
    assert.ok(drifted.volatile.includes("lykos-volatile-inject"));
  });

  it("re-sorted tools change the fingerprint and name the field", () => {
    const c = new HeadContract();
    const { bootHead } = c.boot(FROZEN);
    const prompt = fullPrompt(bootHead);
    c.observe(prompt, FROZEN.toolNames);
    const reordered = c.observe(prompt, ["ls", "find", "grep", "read"]);
    assert.equal(reordered.changed, true);
    assert.ok(reordered.driftedFields.includes("toolNames"));
  });

  it("dropping the boot block from the prompt names bootHead", () => {
    const c = new HeadContract();
    const { bootHead } = c.boot(FROZEN);
    c.observe(fullPrompt(bootHead), FROZEN.toolNames);
    const gone = c.observe("You are a coding agent.\n", FROZEN.toolNames);
    assert.equal(gone.changed, true);
    assert.ok(gone.driftedFields.includes("bootHead"));
  });

  it("a changed cwd line names cwd, not a generic bootHead", () => {
    const c = new HeadContract();
    const { bootHead } = c.boot(FROZEN);
    c.observe(fullPrompt(bootHead), FROZEN.toolNames);
    const mutated = bootHead.replace("cwd: /work", "cwd: /elsewhere");
    const drifted = c.observe(fullPrompt(mutated), FROZEN.toolNames);
    assert.equal(drifted.changed, true);
    assert.ok(drifted.driftedFields.includes("cwd"));
    assert.equal(drifted.driftedFields.includes("bootHead"), false);
  });

  it("refuses a second boot() — that would regenerate the head mid-session", () => {
    const c = new HeadContract();
    c.boot(FROZEN);
    assert.throws(() => c.boot({ ...FROZEN, cwd: "/elsewhere" }), /already booted/);
  });

  it("refuses rebase() — T17.3 append-only, no silent rebuild", () => {
    const c = new HeadContract();
    c.boot(FROZEN);
    assert.throws(() => c.rebase({ ...FROZEN, project: "other" }), /rebase\(\) refused/);
  });

  it("refuses to boot a block that already contains volatile content", () => {
    const c = new HeadContract();
    assert.throws(
      () => c.boot({ ...FROZEN, cwd: "/work at 2026-08-29T13:04:00Z" }),
      /volatile content/,
    );
  });

  it("observe() before boot() is an error, not a guessed fingerprint", () => {
    const c = new HeadContract();
    assert.throws(() => c.observe("x", ["read"]), /observe\(\) before boot\(\)/);
  });

  it("a third stable observe after the volatile one still reports the new fingerprint, not a repair", () => {
    // T18 logs the field name; T17/T18 must not auto-repair. The contract
    // records drift and continues with whatever the head actually is.
    const c = new HeadContract();
    const { bootHead } = c.boot(FROZEN);
    c.observe(fullPrompt(bootHead), FROZEN.toolNames);
    const volatilePrompt = fullPrompt(bootHead, "\n[lykos-volatile 1]");
    const drifted = c.observe(volatilePrompt, FROZEN.toolNames);
    const again = c.observe(volatilePrompt, FROZEN.toolNames);
    assert.equal(drifted.changed, true);
    assert.equal(again.changed, false);
    assert.equal(again.fingerprint, drifted.fingerprint);
  });
});
