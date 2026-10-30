// The twelfth 2026-09-02 UI feedback round, three numbered items, one
// describe each.
//
// Item 3 is the third consecutive round on paste, and this round found two
// further causes that had nothing to do with the key decoding round eleven
// fixed:
//
//  - a Windows console synthesizes pasted characters as key records with
//    virtual key 0, so a pasted carriage return arrived as `Uc` 13 with no
//    `VK_RETURN` — which `decodeWin32Record` dropped outright as a control
//    character, deleting every line break in the paste; and
//  - `RawLineSource.submit()` translated a multi-line buffer into the
//    backslash-continuation protocol, which `runInteractiveLoop`
//    reassembles as `pending + line` with NO separator — so whatever
//    survived the decoder was flattened into one run-on line on its way to
//    the model.
//
// Both are asserted here at the level they broke: the decoder, the line
// source, and the shape of the string a caller of `next()` actually gets.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeyDecoder, decodeWin32Record } from "./input.js";
import { RawLineSource } from "./raw-line-source.js";
import { S0_HELP } from "../renderers/conversation.js";
import { SHIPPED_DEFAULTS } from "../../config/defaults.js";
import { loadConfig } from "../../config/load.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A resolved config with `flags` as the only layer over the shipped defaults — an empty temp dir for cwd/global so no real config.yaml can leak in. */
function withUi(ui: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "lykos-ui-cfg-"));
  try {
    return loadConfig({ cwd: dir, globalDir: dir, env: {}, flags: { ui } }).resolved;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** One win32-input-mode record: `CSI Vk;Sc;Uc;Kd;Cs;Rc _`, key-down, no modifiers. */
function win32(vk: number, uc: number): string {
  return `\x1b[${vk};0;${uc};1;0;1_`;
}

/**
 * What a Windows console actually emits for PASTED text in
 * win32-input-mode: every character synthesized, so `Vk` is 0 even for the
 * carriage returns. A typed Enter carries `VK_RETURN` (13); a pasted one
 * does not, and that difference is the whole bug.
 */
function win32SynthesizedPaste(text: string): string {
  let out = "";
  for (const ch of text) out += win32(0, ch.codePointAt(0)!);
  return out;
}

describe("round twelve, item 3: a pasted line break survives all the way to the model", () => {
  it("a synthesized carriage-return record (Vk 0, Uc 13) decodes as Enter instead of being dropped", () => {
    assert.deepEqual(decodeWin32Record(0, 13, true, 0), { type: "enter" });
    assert.deepEqual(decodeWin32Record(0, 10, true, 0), { type: "enter" });
    // Unchanged: a record with no character and no mapped key is still
    // nothing at all — that is the modifier-on-its-own case.
    assert.equal(decodeWin32Record(0, 0, true, 0), null);
  });

  it("a synthesized paste keeps every line break — before this round they vanished and the lines ran together", () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.feed(win32SynthesizedPaste("one\rtwo\rthree")), [{ type: "paste", text: "one\ntwo\nthree" }]);
  });

  it("the composer holds one line per pasted line, not one flattened line", () => {
    const src = new RawLineSource();
    src.feedBytes(win32SynthesizedPaste("alpha\rbeta\rgamma"));
    assert.deepEqual(src.editorState.lines, ["alpha", "beta", "gamma"]);
  });

  it("submitting a multi-line buffer delivers ONE entry with real newlines", async () => {
    const src = new RawLineSource();
    const pending = src.next();
    src.feedBytes("\x1b[200~first\nsecond\nthird\x1b[201~");
    src.feedBytes("\r");
    src.flushPending(); // the idle gap a real session's router always provides
    assert.equal(await pending, "first\nsecond\nthird");
  });

  it("the old backslash-continuation form is gone — nothing queued ends in a stray backslash", async () => {
    const src = new RawLineSource();
    const pending = src.next();
    src.feedBytes("\x1b[200~one\ntwo\x1b[201~\r");
    src.flushPending(); // the idle gap a real session's router always provides
    const line = await pending;
    assert.equal(line?.includes("\\"), false, `a queued line still carries the continuation marker: ${JSON.stringify(line)}`);
    // And nothing else is waiting behind it — the whole buffer was one entry.
    let second: string | null | undefined;
    void src.next().then((v) => (second = v));
    await new Promise((r) => setImmediate(r));
    assert.equal(second, undefined, "a second queued entry means the buffer was split again");
    src.close();
  });

  it("a single-line submit is completely unchanged", async () => {
    const src = new RawLineSource();
    const pending = src.next();
    src.feedBytes("just one line\r");
    src.flushPending(); // the idle gap a real session's router always provides
    assert.equal(await pending, "just one line");
  });
});

describe("round twelve, item 1: the raw tool-result JSON line is off by default", () => {
  it("ui.tool_result_preview defaults to false", () => {
    assert.equal(SHIPPED_DEFAULTS.ui.tool_result_preview, false);
  });

  it("a config file can turn it back on", () => {
    assert.equal(withUi({ tool_result_preview: true }).ui.tool_result_preview, true);
  });

  it("/verbose's help line says it is the session-level way to see them", () => {
    const line = S0_HELP.split("\n").find((l) => l.includes("/verbose"))!;
    assert.match(line, /raw result/);
  });
});

describe("round twelve, item 2: a running tool says what is being waited on", () => {
  it("ui.tool_wait_limit_seconds defaults to five minutes and is configurable", () => {
    assert.equal(SHIPPED_DEFAULTS.ui.tool_wait_limit_seconds, 300);
    assert.equal(withUi({ tool_wait_limit_seconds: 45 }).ui.tool_wait_limit_seconds, 45);
    // 0 is a real value, not a missing one: it means "show elapsed, name
    // no limit". A `??` merge that treated it as absent would silently
    // reinstate the default.
    assert.equal(withUi({ tool_wait_limit_seconds: 0 }).ui.tool_wait_limit_seconds, 0);
  });
});
