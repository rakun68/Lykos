// T150: `lykos-continuation` driven through a fake `pi.on`, the pattern the
// harness extension tests use. The end-to-end proof — a boundary crossed into a
// successor — is `cli/scripted-context-strategy.test.ts`.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import lykosContinuation from "./lykos-continuation.js";
import {
  CONTINUATION_ENTRY_TYPE,
  CONTINUATION_POLICY_ENV,
  continuationFromEntries,
  decodeContinuationPolicyEnv,
  encodeContinuationPolicyEnv,
} from "../../loop/continuation.js";

type Handler = (event: unknown, ctx: unknown) => void;

function load(policy: string | undefined): { handlers: Map<string, Handler>; entries: Array<{ type: string; customType: string; data: unknown }> } {
  if (policy === undefined) delete process.env[CONTINUATION_POLICY_ENV];
  else process.env[CONTINUATION_POLICY_ENV] = policy;
  const handlers = new Map<string, Handler>();
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  lykosContinuation({
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
  } as never);
  return { handlers, entries };
}

function ctx(tokens: number | null, contextWindow: number, aborted: { n: number }): unknown {
  return { getContextUsage: () => ({ tokens, contextWindow, percent: null }), abort: () => (aborted.n += 1), model: undefined };
}

describe("lykos-continuation (T150)", () => {
  afterEach(() => {
    delete process.env[CONTINUATION_POLICY_ENV];
  });

  it("stops once, at the threshold, and records the crossing", () => {
    const { handlers, entries } = load(encodeContinuationPolicyEnv({ enabled: true, threshold: 0.8 }));
    const turnEnd = handlers.get("turn_end");
    assert.ok(turnEnd);
    const aborted = { n: 0 };
    turnEnd({}, ctx(79, 100, aborted));
    assert.equal(aborted.n, 0);
    turnEnd({}, ctx(81, 100, aborted));
    turnEnd({}, ctx(90, 100, aborted));
    assert.equal(aborted.n, 1);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.customType, CONTINUATION_ENTRY_TYPE);
    assert.deepEqual(continuationFromEntries(entries), { tokens: 81, contextWindow: 100 });
  });

  it("does nothing when the usage is unknown", () => {
    const { handlers, entries } = load(encodeContinuationPolicyEnv({ enabled: true, threshold: 0.1 }));
    const aborted = { n: 0 };
    handlers.get("turn_end")!({}, ctx(null, 100, aborted));
    assert.equal(aborted.n, 0);
    assert.equal(entries.length, 0);
  });

  it("registers nothing when another strategy is active, or with no policy at all", () => {
    assert.equal(load(encodeContinuationPolicyEnv({ enabled: false, threshold: 0.8 })).handlers.size, 0);
    assert.equal(load(undefined).handlers.size, 0);
    assert.equal(load("not json").handlers.size, 0);
  });

  it("decodes only a well-formed policy", () => {
    assert.deepEqual(decodeContinuationPolicyEnv('{"enabled":true,"threshold":0.5}'), { enabled: true, threshold: 0.5 });
    assert.equal(decodeContinuationPolicyEnv('{"enabled":"yes","threshold":0.5}'), null);
    assert.equal(continuationFromEntries([{ type: "custom", customType: "other", data: {} }]), undefined);
  });
});
