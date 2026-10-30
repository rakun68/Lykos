import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectColorCapability, detectGlyphSet, resolveTheme, style } from "./resolve.js";

describe("detectColorCapability", () => {
  it("honours NO_COLOR unconditionally, even over an explicit flag", () => {
    const cap = detectColorCapability({
      env: { NO_COLOR: "1" },
      isTTY: true,
      colorFlag: "always",
    });
    assert.equal(cap, "none");
  });

  it("falls back to none for TERM=dumb", () => {
    assert.equal(detectColorCapability({ env: { TERM: "dumb" }, isTTY: true }), "none");
  });

  it("assumes colour on a non-TTY when the caller says so (S1)", () => {
    const cap = detectColorCapability({
      env: { COLORTERM: "truecolor" },
      isTTY: false,
      assumeColorWhenNotTty: true,
    });
    assert.equal(cap, "truecolor");
  });

  it("treats a non-TTY with no override as none", () => {
    const cap = detectColorCapability({ env: {}, isTTY: false });
    assert.equal(cap, "none");
  });

  it("detects truecolor from COLORTERM", () => {
    assert.equal(
      detectColorCapability({ env: { COLORTERM: "truecolor" }, isTTY: true }),
      "truecolor",
    );
  });

  it("falls back to ansi16 with no other signal on a TTY", () => {
    assert.equal(detectColorCapability({ env: {}, isTTY: true }), "ansi16");
  });

  it("treats WT_SESSION (Windows Terminal) as truecolor even with no COLORTERM/TERM", () => {
    assert.equal(
      detectColorCapability({ env: { WT_SESSION: "abc-123" }, isTTY: true }),
      "truecolor",
    );
  });

  it("treats TERM_PROGRAM=vscode as truecolor even with no COLORTERM/TERM", () => {
    assert.equal(
      detectColorCapability({ env: { TERM_PROGRAM: "vscode" }, isTTY: true }),
      "truecolor",
    );
  });

  it("COLORTERM still wins over WT_SESSION when both are present (no conflict, but explicit beats inferred)", () => {
    assert.equal(
      detectColorCapability({ env: { WT_SESSION: "abc", COLORTERM: "truecolor" }, isTTY: true }),
      "truecolor",
    );
  });
});

describe("detectGlyphSet", () => {
  it("defaults to unicode", () => {
    assert.equal(detectGlyphSet({ LANG: "en_US.UTF-8" }), "unicode");
  });

  it("selects ascii for LYKOS_ASCII=1", () => {
    assert.equal(detectGlyphSet({ LYKOS_ASCII: "1", LANG: "en_US.UTF-8" }), "ascii");
  });

  it("selects ascii for a non-UTF-8 locale", () => {
    assert.equal(detectGlyphSet({ LANG: "C" }), "ascii");
  });
});

describe("resolveTheme / style", () => {
  it("emits no escape codes for the none capability", () => {
    const theme = resolveTheme("rose-pine-moon", "none", "unicode");
    assert.equal(style("$0.038", "spend", theme), "$0.038");
  });

  it("emits a truecolor escape matching the palette hex for spend", () => {
    const theme = resolveTheme("rose-pine-moon", "truecolor", "unicode");
    const styled = style("$0.038", "spend", theme);
    // rose-pine-moon's gold is #f6c177 -> rgb(246,193,119)
    assert.equal(styled, "\x1b[38;2;246;193;119m$0.038\x1b[0m");
  });

  it("uses the ansi16 palette regardless of the requested palette name", () => {
    const theme = resolveTheme("catppuccin-mocha", "ansi16", "unicode");
    const styled = style("x", "danger", theme);
    assert.equal(styled, "\x1b[31mx\x1b[0m"); // ansi16.danger = "red" = 31
  });
});
