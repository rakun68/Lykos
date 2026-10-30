// The ported Cursor declarations round-trip through the codec.
//
// Not recorded against a live account.
// The byte fixtures ([0x62, 0x02, 0x0a, 0x00] and its payload [0x02, 0x0a, 0x00]) and the frame
// shapes (text delta, turn ended, a `readArgs` exec request, a Connect end-stream error with a
// `google.rpc.ErrorInfo` detail) are those files'.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create, fromBinary, toBinary } from "../protobuf/codec.js";
import {
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  InteractionQuerySchema,
  InteractionUpdateSchema,
  ReadArgsSchema,
  TextDeltaUpdateSchema,
  TurnEndedUpdateSchema,
} from "./proto.js";
import { CONNECT_END_STREAM_FLAG, frameConnectMessage, parseConnectEndStream } from "./stream.js";

function unframe(frame: Buffer): { flags: number; body: Uint8Array } {
  const length = frame.readUInt32BE(1);
  assert.equal(frame.length, 5 + length);
  return { flags: frame[0]!, body: frame.subarray(5, 5 + length) };
}

describe("Cursor protocol declarations (D1, D6.1)", () => {
  it("keeps an interaction-query variant the schema does not name, byte for byte", () => {
    const idOnly = toBinary(InteractionQuerySchema, create(InteractionQuerySchema, { id: 21 }));
    const unknownVariant = new Uint8Array([0x62, 0x02, 0x0a, 0x00]); // field 12, LEN 2: approved {}
    const raw = new Uint8Array(idOnly.length + unknownVariant.length);
    raw.set(idOnly, 0);
    raw.set(unknownVariant, idOnly.length);

    const decoded = fromBinary(InteractionQuerySchema, raw);
    assert.equal(decoded.id, 21);
    assert.equal(decoded.query.case, undefined);
    assert.deepEqual(decoded.$unknown, [{ no: 12, wireType: 2, data: new Uint8Array([0x02, 0x0a, 0x00]) }]);
    assert.deepEqual(toBinary(InteractionQuerySchema, decoded), raw);
  });

  it("round-trips the terminal-error server frames", () => {
    const text = create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(InteractionUpdateSchema, { message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "hello" }) } }),
      },
    });
    const ended = create(AgentServerMessageSchema, {
      message: {
        case: "interactionUpdate",
        value: create(InteractionUpdateSchema, { message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) } }),
      },
    });
    const read = create(AgentServerMessageSchema, {
      message: {
        case: "execServerMessage",
        value: create(ExecServerMessageSchema, {
          id: 1,
          execId: "exec-final",
          message: { case: "readArgs", value: create(ReadArgsSchema, { path: "/tmp/final", toolCallId: "call-final" }) },
        }),
      },
    });

    for (const message of [text, ended, read]) {
      const { flags, body } = unframe(frameConnectMessage(toBinary(AgentServerMessageSchema, message)));
      assert.equal(flags, 0);
      const back = fromBinary(AgentServerMessageSchema, body);
      assert.deepEqual(toBinary(AgentServerMessageSchema, back), toBinary(AgentServerMessageSchema, message));
    }

    const back = fromBinary(AgentServerMessageSchema, toBinary(AgentServerMessageSchema, read));
    assert.equal(back.message.case, "execServerMessage");
    if (back.message.case !== "execServerMessage") return;
    assert.equal(back.message.value.execId, "exec-final");
    const m = back.message.value.message;
    assert.equal(m.case, "readArgs");
    if (m.case === "readArgs") {
      assert.equal(m.value.path, "/tmp/final");
      assert.equal(m.value.toolCallId, "call-final");
    }
  });

  it("parses the Connect end-stream errors", () => {
    const frame = (error: unknown): Uint8Array =>
      unframe(frameConnectMessage(Buffer.from(JSON.stringify({ error }), "utf8"), CONNECT_END_STREAM_FLAG)).body;

    assert.equal(parseConnectEndStream(frame({ code: "unavailable", message: "post-turn connect failure" }))?.message,
      "Connect error unavailable: post-turn connect failure");
    const detailed = parseConnectEndStream(
      frame({ code: "invalid_argument", message: "Error", details: [{ type: "google.rpc.ErrorInfo", value: "quota exceeded for request field tools" }] }),
    );
    assert.equal(detailed?.message, "Connect error invalid_argument: Error [details: google.rpc.ErrorInfo: quota exceeded for request field tools]");
    assert.equal(parseConnectEndStream(Buffer.from("{}")), null, "an end-stream without an error is clean");
  });
});
