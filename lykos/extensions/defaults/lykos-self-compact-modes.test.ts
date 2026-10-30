// `/compact <method>` at `lykos-self-compact`'s own seam, driven through a fake
// `pi.on` as `lykos-self-compact.test.ts` does. The end-to-end proof, through
// the interactive session and the ledger, is
// `cli/scripted-compact-modes.test.ts`.

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";
import lykosSelfCompact from "./lykos-self-compact.js";
import { encodeSelfCompactPolicyEnv, SELF_COMPACT_POLICY_ENV, validateSelfCompactConfig } from "../../loop/self-compact.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

const TABLE = validateSelfCompactConfig({ models: { "p/m": { notice: 100, warning: 200, cutoff: 300 } } });
const entries: unknown[] = [];
const tools = new Map<string, { name: string; execute: (...a: unknown[]) => Promise<unknown> }>();

function load(policy: Parameters<typeof encodeSelfCompactPolicyEnv>[0]): Map<string, Handler> {
  process.env[SELF_COMPACT_POLICY_ENV] = encodeSelfCompactPolicyEnv(policy);
  const handlers = new Map<string, Handler>();
  lykosSelfCompact({
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    registerTool: (tool: { name: string; execute: (...a: unknown[]) => Promise<unknown> }) => void tools.set(tool.name, tool),
    registerCommand: () => undefined,
    appendEntry: (_type: string, data: unknown) => void entries.push(data),
    sendMessage: () => undefined,
  } as never);
  return handlers;
}

const text = (n: number) => "w".repeat(n * 4);
const msg = (id: string, parentId: string | null, message: object) => ({ type: "message", id, parentId, timestamp: "2026-10-11T00:00:00.000Z", message });
const call = (id: string) => ({
  role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: id } }], api: "x", provider: "p", model: "m",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "toolUse", timestamp: 1,
});
const result = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: text(10_000) }], isError: false, timestamp: 1 });
const user = (n: number) => ({ role: "user", content: [{ type: "text", text: text(n) }], timestamp: 1 });

/** A branch whose first two reads fall outside the recent tail, so a shake finds something; `small` has nothing to drop. */
function session(small = false) {
  const current = small
    ? [msg("u0", null, user(10)), msg("u1", "u0", user(10))]
    : [
        msg("u0", null, user(10)), msg("ca", "u0", call("a")), msg("ra", "ca", result("a")),
        msg("cb", "ra", call("b")), msg("rb", "cb", result("b")), msg("u1", "rb", user(17_000)),
      ];
  const notices: string[] = [];
  const c = {
    cwd: tmpdir(),
    hasUI: true,
    ui: { notify: (m: string) => notices.push(m) },
    model: { provider: "p", id: "m", contextWindow: 128_000 },
    getContextUsage: () => ({ tokens: 1, contextWindow: 128_000, percent: null }),
    sessionManager: { getEntries: () => current, getBranch: () => current, getLeafId: () => "u1" },
  };
  return { c, notices };
}

const manual = (customInstructions: string | undefined) => ({
  type: "session_before_compact",
  preparation: { tokensBefore: 50_000, firstKeptEntryId: "u1" },
  customInstructions,
  reason: "manual",
  willRetry: false,
  signal: new AbortController().signal,
});
const rows = () => entries.filter((e) => (e as { kind?: string }).kind === "compaction") as Array<Record<string, unknown>>;
const shakes = () => entries.filter((e) => (e as { tool_call_ids?: string[] }).tool_call_ids !== undefined);
const failed = { type: "session_compact_failed", reason: "manual", aborted: true };

describe("lykos-self-compact: /compact <method> (T191)", () => {
  afterEach(() => {
    delete process.env[SELF_COMPACT_POLICY_ENV];
    entries.length = 0;
  });

  it("`shake` runs shake alone, ahead of the configured order, and the row says so", async () => {
    // The configured order would try the note and the side call first; the override skips them.
    const handlers = load({ enabled: true, table: TABLE, methodOrder: ["note", "handoff", "shake", "summary"] });
    const { c } = session();
    const out = await handlers.get("session_before_compact")!(manual("shake"), c);
    assert.deepEqual(out, { cancel: true });
    assert.equal(shakes().length, 1);
    const [row] = rows();
    assert.equal(row?.method, "shake");
    assert.equal(row?.trigger, "manual");
    assert.equal(row?.result, "ok");
    assert.deepEqual(row?.fell_through, [], "nothing was tried before it");
    await handlers.get("session_compact_failed")!(failed, c);
    assert.equal(rows().length, 1, "Pi's cancelled compaction is not a second row");
  });

  it("`shake` also runs when the configured order leaves shake out", async () => {
    const handlers = load({ enabled: true, table: TABLE, methodOrder: ["summary"] });
    const out = await handlers.get("session_before_compact")!(manual("Shake"), session().c);
    assert.deepEqual(out, { cancel: true });
    assert.equal(rows()[0]?.method, "shake");
  });

  it("`shake` with nothing worth dropping does not fall through to a summary: it is a recorded failure", async () => {
    const handlers = load({ enabled: true, table: TABLE });
    const { c, notices } = session(true);
    const out = await handlers.get("session_before_compact")!(manual("shake"), c);
    assert.deepEqual(out, { cancel: true }, "no model call was asked for, so none is made");
    const [row] = rows();
    assert.equal(row?.method, "shake");
    assert.equal(row?.result, "failed");
    assert.match(String(row?.error), /no tool result outside the recent tail/);
    assert.equal(shakes().length, 0);
    assert.match(notices.join("\n"), /no tool result outside the recent tail/);
    await handlers.get("session_compact_failed")!(failed, c);
    assert.equal(rows().length, 1, "the cancellation that follows is not a second row");
  });

  it("`shake <text>` is rejected with a message: nothing is shaken, summarised or recorded", async () => {
    const handlers = load({ enabled: true, table: TABLE });
    const { c, notices } = session();
    const out = await handlers.get("session_before_compact")!(manual("shake keep the auth work"), c);
    assert.deepEqual(out, { cancel: true });
    assert.match(notices.join("\n"), /\/compact shake takes no focus text/);
    assert.equal(shakes().length, 0);
    await handlers.get("session_compact_failed")!(failed, c);
    assert.equal(rows().length, 0, "a refused command is not a compaction");
  });

  it("focus text with no method name behaves as before: the configured order, not an override", async () => {
    // Shake would run if the text were taken as a method; Pi's summary is chosen because it is not.
    const handlers = load({ enabled: true, table: TABLE, methodOrder: ["summary"] });
    const out = await handlers.get("session_before_compact")!(manual("keep the auth work"), session().c);
    assert.equal(out, undefined, "Pi's summary compacts");
    assert.equal(shakes().length, 0);
  });

  it("a named method wins over a pending agent note for a manual run: the name is never passed to Pi as focus", async () => {
    const handlers = load({ enabled: true, table: TABLE });
    const { c } = session();
    await tools.get("self_compact")!.execute("id", { note: "## Goal\nkeep going" }, undefined, undefined, c);
    const out = await handlers.get("session_before_compact")!(manual("shake"), c);
    assert.deepEqual(out, { cancel: true }, "shake ran; Pi's summariser was not left to compact with 'shake' as its focus");
    assert.equal(shakes().length, 1);
    assert.equal(rows()[0]?.method, "shake");
  });

  it("a pending note still owns a compaction that names no method", async () => {
    const handlers = load({ enabled: true, table: TABLE });
    const { c } = session();
    await tools.get("self_compact")!.execute("id", { note: "## Goal\nkeep going" }, undefined, undefined, c);
    assert.equal(await handlers.get("session_before_compact")!(manual("keep the auth work"), c), undefined);
    assert.equal(shakes().length, 0);
  });

  it("an automatic compaction never reads an override", async () => {
    const handlers = load({ enabled: true, table: TABLE, methodOrder: ["summary"] });
    const out = await handlers.get("session_before_compact")!({ ...manual("shake"), reason: "threshold" }, session().c);
    assert.equal(out, undefined);
  });
});
