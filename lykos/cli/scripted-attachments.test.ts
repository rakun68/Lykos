// T268 (spec #25, decision 7): `@path` in a `lykos run` prompt attaches the file. The brief is built the way
// `lykos run` builds it (`resolveRunBrief`), and a real session on the scripted model is what receives it.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { parseRunBriefArgs, resolveRunBrief } from "./brief.js";
import { refuseImages } from "../session/session.js";
import { reply, runScriptedSession, say, type ModelContext } from "./scripted-session.js";

/** The first user message the model was sent, as its content parts. */
function firstUser(context: ModelContext): Array<{ type: string; text?: string; mimeType?: string; data?: string }> {
  const user = context.messages.find((m) => m.role === "user");
  assert.ok(user, "the model was sent a user message");
  return typeof user.content === "string" ? [{ type: "text", text: user.content }] : (user.content as Array<{ type: string }>);
}

/** A real one-pixel RGBA PNG, built from its chunks. */
function png1x1(): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))), chunk("IEND", Buffer.alloc(0))]);
}

/** `lykos run <args>`'s brief, from a folder holding the files it names. */
async function briefFor(args: string[], files: Record<string, string | Buffer>) {
  const dir = mkdtempSync(join(tmpdir(), "lykos-attach-"));
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
  const r = await resolveRunBrief(parseRunBriefArgs(args), { cwd: dir, stdinIsTTY: true, readStdin: async () => "" });
  assert.ok("brief" in r, JSON.stringify(r));
  return r;
}

describe("@path attachments reach the model (T268)", () => {
  it('`lykos run "explain @a.ts"` sends the file\'s contents with the prompt', async () => {
    const { brief, images } = await briefFor(["explain @a.ts"], { "a.ts": "export const answer = 42;\n" });
    const run = await runScriptedSession({ prompt: brief, extra: { images }, script: [reply(say("it exports 42"))] });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    const text = firstUser(run.sent[0]!).map((p) => p.text ?? "").join("");
    assert.match(text, /explain @a\.ts/);
    assert.match(text, /<file name="[^"]*a\.ts">\nexport const answer = 42;\n/);
  });

  it("an @-mentioned PNG reaches a model that takes images as an image part", async () => {
    const { brief, images } = await briefFor(["what is in @shot.png"], { "shot.png": png1x1() });
    const run = await runScriptedSession({ prompt: brief, extra: { images }, script: [reply(say("a pixel"))] });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    const parts = firstUser(run.sent[0]!);
    const image = parts.find((p) => p.type === "image");
    assert.ok(image, `an image part was sent: ${JSON.stringify(parts.map((p) => p.type))}`);
    assert.equal(image.mimeType, "image/png");
    assert.deepEqual(Buffer.from(image.data!, "base64").subarray(1, 4).toString("ascii"), "PNG");
  });

  it("a model without image input refuses with a message naming the model and the image, before any model call", async () => {
    const { brief, images } = await briefFor(["what is in @shot.png"], { "shot.png": png1x1() });
    const run = await runScriptedSession({ prompt: brief, extra: { images }, modelInput: ["text"], script: [reply(say("never"))] });
    assert.equal(run.result.status, "error");
    assert.match(run.result.status === "error" ? run.result.message : "", /faux\/scripted-1 takes no image input.*shot\.png/);
    assert.equal(run.modelCalls, 0);
  });
});

describe("the image guard a model fallback goes through too (review finding 3)", () => {
  const image = { path: "shot.png", mimeType: "image/png", data: "" };
  it("refuses a model without image input, naming it and the image, and passes one with it or no images", () => {
    assert.equal(refuseImages({ provider: "p", id: "text-only", input: ["text"] }, [image]), "p/text-only takes no image input, so shot.png cannot be attached");
    assert.equal(refuseImages({ provider: "p", id: "seer", input: ["text", "image"] }, [image]), undefined);
    assert.equal(refuseImages({ provider: "p", id: "text-only", input: ["text"] }, undefined), undefined);
    assert.equal(refuseImages({ provider: "p", id: "text-only", input: ["text"] }, []), undefined);
  });
});
