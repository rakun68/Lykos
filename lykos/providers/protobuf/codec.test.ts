// The protobuf wire codec.
//
// Written from the wire format; not recorded against a live account.
// The schemas, values and the one wire fixture ([0x08, 0x2a, 0x10, 0x07]) are
// that file's; the assertions are rewritten for node:test.

import assert from "node:assert/strict";
import { it } from "node:test";
import { decodeJsonValue, encodeJsonValue, type JsonValue, type MessageCodec, type ProtoMessage, pb } from "./codec.js";

interface Envelope extends ProtoMessage {
  enabled?: boolean;
  choice: { case: undefined; value?: undefined } | { case: "text"; value: string };
}

const EnvelopeSchema = pb<Envelope>("test.Envelope", [
  { no: 1, name: "enabled", kind: "bool", optional: true },
  {
    kind: "oneof",
    name: "choice",
    variants: [{ no: 2, name: "text", kind: "string" }],
  },
]);

interface Counter extends ProtoMessage {
  value: number;
}

const CounterSchema = pb<Counter>("test.Counter", [{ no: 1, name: "value", kind: "int32" }]);

interface Node extends ProtoMessage {
  label: string;
  child?: Node;
}

const NodeSchema: MessageCodec<Node> = pb<Node>("test.Node", [
  { no: 1, name: "label", kind: "string" },
  { no: 2, name: "child", kind: "message", T: () => NodeSchema },
]);

interface StringMap extends ProtoMessage {
  entries: Record<string, string>;
}

const StringMapSchema = pb<StringMap>("test.StringMap", [{ no: 1, name: "entries", kind: "map", K: "string", V: "string" }]);

it("preserves selected oneofs and explicit optional defaults", () => {
  const decoded = EnvelopeSchema.decode(EnvelopeSchema.encode({ enabled: false, choice: { case: "text", value: "hello" } }));
  assert.equal(decoded.enabled, false);
  assert.deepEqual(decoded.choice, { case: "text", value: "hello" });
  assert.deepEqual(EnvelopeSchema.toJson(decoded), { enabled: false, text: "hello" });
});

it("retains unknown wire fields while re-encoding a message", () => {
  const input = new Uint8Array([0x08, 0x2a, 0x10, 0x07]);
  assert.deepEqual(CounterSchema.encode(CounterSchema.decode(input)), input);
  assert.equal(CounterSchema.decode(input).value, 42);
});

it("round-trips JSON values with empty struct keys", () => {
  const value: JsonValue = { "": ["kept", { nested: true }], count: 1 };
  assert.deepEqual(decodeJsonValue(encodeJsonValue(value)), value);
});

it("resolves recursive static message descriptors on demand", () => {
  const decoded = NodeSchema.decode(NodeSchema.encode({ label: "root", child: { label: "child", child: { label: "leaf" } } }));
  assert.equal(decoded.child?.child?.label, "leaf");
});

it("round-trips a map whose key is __proto__ without prototype pollution", () => {
  const entries = JSON.parse('{"__proto__":"polluted","safe":"ok"}') as Record<string, string>;
  const decoded = StringMapSchema.decode(StringMapSchema.encode({ entries }));
  assert.equal(Object.getPrototypeOf(decoded.entries), null);
  assert.deepEqual(Object.keys(decoded.entries).sort(), ["__proto__", "safe"]);
  assert.equal(Reflect.get(decoded.entries, "__proto__"), "polluted");
  assert.equal(decoded.entries.safe, "ok");
  const json = StringMapSchema.toJson(decoded) as { entries: Record<string, string> };
  assert.deepEqual(Object.keys(json.entries).sort(), ["__proto__", "safe"]);
});
