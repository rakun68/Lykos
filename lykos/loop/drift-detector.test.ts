import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  announceHeadDrift,
  cacheHitRatioBelowPhase2Floor,
  formatHeadDriftLog,
  HEAD_DRIFT_LOG_PREFIX,
  MULTI_TURN_MIN_CALLS,
  namedDriftFields,
  observeAndAnnounce,
  PHASE2_CACHE_HIT_THRESHOLD,
} from "./drift-detector.js";
import {
  assembleBootHead,
  HEAD_FIELD_ORDER,
  HeadContract,
  type BootArtifacts,
} from "../session/head-contract.js";

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

function captureLines(fn: (write: (line: string) => void) => void): string[] {
  const lines: string[] = [];
  fn((line) => {
    lines.push(line);
  });
  return lines;
}

describe("PHASE2_CACHE_HIT_THRESHOLD", () => {
  it("is the Phase 2 exit criterion of ~80%", () => {
    assert.equal(PHASE2_CACHE_HIT_THRESHOLD, 0.8);
    assert.equal(MULTI_TURN_MIN_CALLS, 2);
  });
});

describe("formatHeadDriftLog / namedDriftFields (T18.1)", () => {
  it("names volatile:lykos-volatile-inject for the T17 injector, not merely that the prefix changed", () => {
    const c = new HeadContract();
    const { bootHead } = c.boot(FROZEN);
    c.observe(fullPrompt(bootHead), FROZEN.toolNames);
    const drifted = c.observe(fullPrompt(bootHead, "\n[lykos-volatile 1719900000000]"), FROZEN.toolNames);
    assert.equal(drifted.changed, true);
    const fields = namedDriftFields(drifted);
    assert.ok(fields.includes("volatile:lykos-volatile-inject"));
    const line = formatHeadDriftLog(drifted);
    assert.match(line, /volatile:lykos-volatile-inject/);
    assert.equal(line.startsWith(HEAD_DRIFT_LOG_PREFIX), true);
    assert.equal(/prefix changed\s*$/m.test(line), false);
    assert.match(line, /not rebuilding the head \(T18\.3\)/);
  });

  it("names cwd when only the cwd line in the boot block changed", () => {
    const c = new HeadContract();
    const { bootHead } = c.boot(FROZEN);
    c.observe(fullPrompt(bootHead), FROZEN.toolNames);
    const mutated = bootHead.replace("cwd: /work", "cwd: /elsewhere");
    const drifted = c.observe(fullPrompt(mutated), FROZEN.toolNames);
    assert.equal(drifted.changed, true);
    assert.ok(drifted.driftedFields.includes("cwd"));
    assert.equal(drifted.driftedFields.includes("bootHead"), false);
    assert.match(formatHeadDriftLog(drifted), /\bcwd\b/);
  });

  it("names toolNames when tools are re-sorted", () => {
    const c = new HeadContract();
    const { bootHead } = c.boot(FROZEN);
    c.observe(fullPrompt(bootHead), FROZEN.toolNames);
    const drifted = c.observe(fullPrompt(bootHead), ["ls", "find", "grep", "read"]);
    assert.ok(namedDriftFields(drifted).includes("toolNames"));
    assert.match(formatHeadDriftLog(drifted), /toolNames/);
  });

  it("falls back to systemPrompt when the hash moved with no attributable field", () => {
    const c = new HeadContract();
    const { bootHead } = c.boot(FROZEN);
    c.observe(fullPrompt(bootHead), FROZEN.toolNames);
    const drifted = c.observe(fullPrompt(bootHead, "\nA harmless extra sentence."), FROZEN.toolNames);
    assert.equal(drifted.changed, true);
    assert.deepEqual(namedDriftFields(drifted), ["systemPrompt"]);
    assert.match(formatHeadDriftLog(drifted), /systemPrompt/);
  });
});

describe("announceHeadDrift / observeAndAnnounce (T18.1, T18.3)", () => {
  it("writes exactly one line on mismatch and none on a stable follow-up", () => {
    const c = new HeadContract();
    const { bootHead } = c.boot(FROZEN);
    const stable = fullPrompt(bootHead);
    const firstLines = captureLines((write) => observeAndAnnounce(c, stable, FROZEN.toolNames, write));
    assert.deepEqual(firstLines, []);
    const volatile = fullPrompt(bootHead, "\n[lykos-volatile 1]");
    const driftLines = captureLines((write) => observeAndAnnounce(c, volatile, FROZEN.toolNames, write));
    assert.equal(driftLines.length, 1);
    assert.match(driftLines[0]!, /volatile:lykos-volatile-inject/);
    const again = captureLines((write) => observeAndAnnounce(c, volatile, FROZEN.toolNames, write));
    assert.deepEqual(again, []);
  });

  it("does not call rebase or rewrite the frozen boot block after logging", () => {
    const c = new HeadContract();
    const { bootHead } = c.boot(FROZEN);
    c.observe(fullPrompt(bootHead), FROZEN.toolNames);
    const drifted = c.observe(fullPrompt(bootHead, "\n[lykos-volatile 1]"), FROZEN.toolNames);
    announceHeadDrift(drifted, () => {
      /* captured */
    });
    assert.throws(() => c.rebase({ ...FROZEN, cwd: "/repaired" }), /rebase\(\) refused/);
    assert.throws(() => c.boot({ ...FROZEN, cwd: "/repaired" }), /already booted/);
    const again = c.observe(fullPrompt(bootHead, "\n[lykos-volatile 1]"), FROZEN.toolNames);
    assert.equal(again.changed, false);
    assert.equal(again.fingerprint, drifted.fingerprint);
  });

  it("returns false and writes nothing when the fingerprint did not change", () => {
    const lines = captureLines((write) => {
      const announced = announceHeadDrift(
        { fingerprint: "abc", changed: false, driftedFields: [], volatile: [] },
        write,
      );
      assert.equal(announced, false);
    });
    assert.deepEqual(lines, []);
  });
});

describe("cacheHitRatioBelowPhase2Floor (T18.2)", () => {
  it("is true only for multi-turn sessions strictly below the floor", () => {
    assert.equal(cacheHitRatioBelowPhase2Floor(0, 1), false);
    assert.equal(cacheHitRatioBelowPhase2Floor(0, 2), true);
    assert.equal(cacheHitRatioBelowPhase2Floor(0.79, 2), true);
    assert.equal(cacheHitRatioBelowPhase2Floor(0.8, 2), false);
    assert.equal(cacheHitRatioBelowPhase2Floor(0.9, 6), false);
    assert.equal(cacheHitRatioBelowPhase2Floor(null, 6), false);
    assert.equal(cacheHitRatioBelowPhase2Floor(0, 0), false);
  });
});
