import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideRenderMode, type FallbackDecisionInput } from "./fallback.js";

function input(overrides: Partial<FallbackDecisionInput> = {}): FallbackDecisionInput {
  return { ioMode: "standalone", isTTY: true, vtSupported: true, noFullscreen: false, ...overrides };
}

describe("T50.1: the fallback ladder — one row per condition", () => {
  it("every condition met: fullscreen", () => {
    assert.equal(decideRenderMode(input()).mode, "fullscreen");
  });

  it("mcp mode: append-only (T32)", () => {
    const d = decideRenderMode(input({ ioMode: "mcp" }));
    assert.equal(d.mode, "append-only");
    assert.match(d.reason, /mcp/);
  });

  it("piped mode: append-only", () => {
    assert.equal(decideRenderMode(input({ ioMode: "piped" })).mode, "append-only");
  });

  it("no TTY on stdout: append-only", () => {
    const d = decideRenderMode(input({ isTTY: false }));
    assert.equal(d.mode, "append-only");
    assert.match(d.reason, /not a TTY/);
  });

  it("TERM=dumb: append-only, even with a TTY and VT support otherwise true", () => {
    const d = decideRenderMode(input({ term: "dumb" }));
    assert.equal(d.mode, "append-only");
    assert.match(d.reason, /TERM=dumb/);
  });

  it("VT not supported: append-only", () => {
    const d = decideRenderMode(input({ vtSupported: false }));
    assert.equal(d.mode, "append-only");
    assert.match(d.reason, /VT support/);
  });

  it("--no-fullscreen: append-only even when every other condition allows fullscreen", () => {
    const d = decideRenderMode(input({ noFullscreen: true }));
    assert.equal(d.mode, "append-only");
    assert.match(d.reason, /--no-fullscreen/);
  });

  it("--no-fullscreen wins over every other reason, checked first", () => {
    const d = decideRenderMode(input({ noFullscreen: true, ioMode: "mcp", isTTY: false, vtSupported: false, term: "dumb" }));
    assert.match(d.reason, /--no-fullscreen/);
  });

  it("a non-standalone io mode is caught even with a real TTY and VT support (a piped lykos mcp session with a TTY behind it, say)", () => {
    const d = decideRenderMode(input({ ioMode: "mcp", isTTY: true, vtSupported: true }));
    assert.equal(d.mode, "append-only");
  });
});
