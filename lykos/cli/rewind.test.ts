// T165: what `lykos rewind`'s positional argument names. The restores
// themselves are proven through the scripted session in checkpoint-turns.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRewindTarget } from "./rewind.js";

describe("parseRewindTarget (T165)", () => {
  it("reads a short number as an index", () => {
    assert.deepEqual(parseRewindTarget("0"), { index: 0 });
    assert.deepEqual(parseRewindTarget("12"), { index: 12 });
  });

  it("reads hex of at least four characters as a hash prefix", () => {
    assert.deepEqual(parseRewindTarget("abcd"), { hash: "abcd" });
    assert.deepEqual(parseRewindTarget("1a2B3c4d"), { hash: "1a2B3c4d" });
  });

  it("leaves a long run of digits to be resolved against the ref, since it could be either", () => {
    assert.deepEqual(parseRewindTarget("12345678"), { indexOrHash: "12345678" });
  });

  it("refuses anything else, and lists nothing when given nothing", () => {
    assert.equal(parseRewindTarget(undefined), null);
    for (const raw of ["-1", "abc", "HEAD", "1.5", "g123"]) {
      assert.ok("error" in (parseRewindTarget(raw) ?? {}), raw);
    }
  });
});
