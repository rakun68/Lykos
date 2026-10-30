import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeRediscovery, normalizeCommand, REDISCOVERY_VERSION } from "./rediscovery.js";

const bash = (command: string, state = "ok") => ({ name: "bash", state, args: { command } });
const read = (path: string) => ({ name: "read", state: "ok", args: { path } });

const session = (id: string, startedUtc: string, toolCalls: ReturnType<typeof bash>[] | unknown[]) => ({
  sessionId: id,
  startedUtc,
  toolCalls: toolCalls as Array<{ name?: string; state?: string; args?: unknown }>,
});

describe("normalizeCommand (T66)", () => {
  it("strips a leading cd and collapses whitespace, so the same question asked twice matches", () => {
    assert.equal(
      normalizeCommand("cd /c/Workspace/Projects/Lykos && grep -rn  'x'   docs/"),
      "grep -rn 'x' docs/",
    );
    assert.equal(normalizeCommand("  ls   docs  "), "ls docs");
  });

  it("leaves a command with no cd prefix alone", () => {
    assert.equal(normalizeCommand("git log --oneline -5"), "git log --oneline -5");
  });
});

describe("computeRediscovery (T66)", () => {
  it("is 0 on a single session — the first session to touch anything discovers, never rediscovers", () => {
    const r = computeRediscovery([session("s1", "2026-09-01T00:00:00Z", [read("a.ts"), read("a.ts"), bash("ls")])]);
    assert.equal(r.rate, 0);
    assert.equal(r.rediscoveredExploreCalls, 0);
    assert.equal(r.exploreCalls, 3);
    // Within-session repetition is not rediscovery: memory across sessions is
    // what Phase 10 would buy, and re-reading a file you are editing is not it.
    assert.equal(r.files.repeatReads, 0);
  });

  it("counts a file read again in a later session", () => {
    const r = computeRediscovery([
      session("s1", "2026-09-01T00:00:00Z", [read("lykos/session/session.ts")]),
      session("s2", "2026-09-02T00:00:00Z", [read("lykos/session/session.ts")]),
    ]);
    assert.equal(r.files.repeatReads, 1);
    assert.equal(r.files.repeated, 1);
    assert.equal(r.files.distinct, 1);
    assert.equal(r.rate, 0.5); // 1 of 2 exploration calls
    assert.deepEqual(r.files.top[0]?.sessions, ["s1", "s2"]);
  });

  it("counts a command re-run verbatim in a later session, cd prefix and spacing ignored", () => {
    const r = computeRediscovery([
      session("s1", "2026-09-01T00:00:00Z", [bash("grep -rn foo lykos/")]),
      session("s2", "2026-09-02T00:00:00Z", [bash("cd /repo && grep -rn  foo   lykos/")]),
    ]);
    assert.equal(r.commands.repeatRuns, 1);
    assert.equal(r.commands.distinct, 1);
    assert.equal(r.rate, 0.5);
  });

  it("counts a call once even when both its file and its command repeat", () => {
    const r = computeRediscovery([
      session("s1", "2026-09-01T00:00:00Z", [{ name: "read", state: "ok", args: { path: "a.ts", command: "read a.ts" } }]),
      session("s2", "2026-09-02T00:00:00Z", [{ name: "read", state: "ok", args: { path: "a.ts", command: "read a.ts" } }]),
    ]);
    assert.equal(r.rediscoveredExploreCalls, 1);
    assert.equal(r.rate, 0.5);
  });

  it("orders by start time, not by array order — a late-arriving row cannot invert causality", () => {
    const r = computeRediscovery([
      session("later", "2026-09-05T00:00:00Z", [read("a.ts")]),
      session("earlier", "2026-09-01T00:00:00Z", [read("a.ts")]),
    ]);
    assert.deepEqual(r.files.top[0]?.sessions, ["earlier", "later"]);
    assert.equal(r.files.repeatReads, 1);
  });

  it("tracks a repeated failure separately — the signal failed-approaches.md exists for", () => {
    const r = computeRediscovery([
      session("s1", "2026-09-01T00:00:00Z", [bash("npm run build", "error")]),
      session("s2", "2026-09-02T00:00:00Z", [bash("npm run build", "error")]),
    ]);
    assert.equal(r.errors.repeatFailures, 1);
    assert.equal(r.errors.distinct, 1);
    // The failing build is not exploration, so it does not move the headline rate.
    assert.equal(r.exploreCalls, 0);
    assert.equal(r.rate, null);
  });

  it("does not treat a successful call as a repeated failure", () => {
    const r = computeRediscovery([
      session("s1", "2026-09-01T00:00:00Z", [bash("npm test", "error")]),
      session("s2", "2026-09-02T00:00:00Z", [bash("npm test", "ok")]),
    ]);
    assert.equal(r.errors.repeatFailures, 0);
    assert.equal(r.errors.totalFailures, 1);
  });

  it("attributes bash exploration to the command signal, never guessing a file out of it", () => {
    const r = computeRediscovery([
      session("s1", "2026-09-01T00:00:00Z", [bash("sed -n '1,40p' docs/02-plan.md")]),
      session("s2", "2026-09-02T00:00:00Z", [read("docs/02-plan.md")]),
    ]);
    // Deliberately NOT counted as a repeated file: extracting paths out of
    // arbitrary shell is unreliable, and undercounting is the safe direction.
    assert.equal(r.files.repeatReads, 0);
    assert.equal(r.files.distinct, 1);
    assert.equal(r.commands.distinct, 1);
  });

  it("ignores edits and test runs — only exploration can rediscover", () => {
    const r = computeRediscovery([
      session("s1", "2026-09-01T00:00:00Z", [{ name: "edit", state: "ok", args: { path: "a.ts" } }]),
      session("s2", "2026-09-02T00:00:00Z", [{ name: "edit", state: "ok", args: { path: "a.ts" } }, bash("npm test")]),
    ]);
    assert.equal(r.exploreCalls, 0);
    assert.equal(r.rate, null);
    assert.equal(r.files.totalReads, 0);
  });

  it("counts exploring sessions, not all sessions", () => {
    const r = computeRediscovery([
      session("s1", "2026-09-01T00:00:00Z", []),
      session("s2", "2026-09-02T00:00:00Z", [read("a.ts")]),
    ]);
    assert.equal(r.sessions, 2);
    assert.equal(r.exploringSessions, 1);
  });

  it("is null, not zero, when nothing explored at all", () => {
    const r = computeRediscovery([session("s1", "2026-09-01T00:00:00Z", [])]);
    assert.equal(r.rate, null);
    assert.equal(r.files.rate, null);
    assert.equal(r.commands.rate, null);
    assert.equal(r.version, REDISCOVERY_VERSION);
  });

  it("ranks the most-repeated targets first", () => {
    const r = computeRediscovery([
      session("s1", "2026-09-01T00:00:00Z", [read("hot.ts"), read("cold.ts")]),
      session("s2", "2026-09-02T00:00:00Z", [read("hot.ts")]),
      session("s3", "2026-09-03T00:00:00Z", [read("hot.ts"), read("cold.ts")]),
    ]);
    assert.equal(r.files.top[0]?.target, "hot.ts");
    assert.equal(r.files.top[0]?.sessions.length, 3);
    assert.equal(r.files.top[1]?.target, "cold.ts");
    assert.equal(r.files.repeatReads, 3); // hot in s2 and s3, cold in s3
  });
});
