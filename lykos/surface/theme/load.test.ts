import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadPalette } from "./load.js";
import { detectColorCapability, resolveTheme, style } from "./resolve.js";

describe("user themes", () => {
  it("loads a project theme that extends a shipped palette and overrides spend", () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-theme-"));
    mkdirSync(join(root, ".lykos", "themes"), { recursive: true });
    writeFileSync(
      join(root, ".lykos", "themes", "hot-spend.yaml"),
      [
        "name: hot-spend",
        "extends: rose-pine-moon",
        "source: test",
        "checked: 2026-09-01",
        "tokens:",
        '  spend: "#ff0000"',
      ].join("\n"),
      "utf8",
    );
    const palette = loadPalette("hot-spend", { cwd: root }, { fallback: false });
    assert.equal(palette.tokens.spend, "#ff0000");
    // inherited
    assert.equal(palette.tokens.cache, "#9ccfd8");

    const theme = resolveTheme("hot-spend", "truecolor", "unicode", { cwd: root });
    assert.equal(style("$1", "spend", theme), "\x1b[38;2;255;0;0m$1\x1b[0m");
  });

  it("NO_COLOR still wins over a user theme", () => {
    const cap = detectColorCapability({
      env: { NO_COLOR: "1", LYKOS_UI_THEME: "hot-spend" },
      isTTY: true,
      colorFlag: "always",
    });
    assert.equal(cap, "none");
    const theme = resolveTheme("hot-spend", cap, "unicode");
    assert.equal(style("$1", "spend", theme), "$1");
  });

  it("throws on an unknown theme when fallback is off", () => {
    assert.throws(() => loadPalette("does-not-exist", { cwd: tmpdir() }, { fallback: false }), /no theme named/);
  });
});

describe("T51.1/T51.3: the new full-screen tokens are real palette data, not a patch", () => {
  it("a user theme can override a new token (thinking) and it takes effect everywhere that token is read", () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-theme-"));
    mkdirSync(join(root, ".lykos", "themes"), { recursive: true });
    writeFileSync(
      join(root, ".lykos", "themes", "hot-thinking.yaml"),
      ["name: hot-thinking", "extends: rose-pine-moon", "source: test", "checked: 2026-09-01", "tokens:", '  thinking: "#00ff00"'].join("\n"),
      "utf8",
    );
    const palette = loadPalette("hot-thinking", { cwd: root }, { fallback: false });
    assert.equal(palette.tokens.thinking, "#00ff00");
    // every other new token is still inherited from the parent, not blanked out
    assert.equal(palette.tokens.speech, "#e0def4");

    const theme = resolveTheme("hot-thinking", "truecolor", "unicode", { cwd: root });
    assert.equal(style("reasoning...", "thinking", theme), "\x1b[38;2;0;255;0mreasoning...\x1b[0m");
  });

  it("a user theme can override userBg/thinkingBg/readBg — added to types.ts 2026-09-01 but missed in SEMANTIC_TOKENS until 2026-09-02", () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-theme-"));
    mkdirSync(join(root, ".lykos", "themes"), { recursive: true });
    writeFileSync(
      join(root, ".lykos", "themes", "custom-bg.yaml"),
      ["name: custom-bg", "extends: sky", "source: test", "checked: 2026-09-02", "tokens:", '  userBg: "#112233"'].join("\n"),
      "utf8",
    );
    const palette = loadPalette("custom-bg", { cwd: root }, { fallback: false });
    assert.equal(palette.tokens.userBg, "#112233");
  });

  it("a theme file setting an unrecognised token key fails validation, naming the key and the file", () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-theme-"));
    mkdirSync(join(root, ".lykos", "themes"), { recursive: true });
    const path = join(root, ".lykos", "themes", "typo.yaml");
    writeFileSync(path, ["name: typo", "extends: rose-pine-moon", "tokens:", '  thnking: "#00ff00"'].join("\n"), "utf8");
    assert.throws(() => loadPalette("typo", { cwd: root }, { fallback: false }), (err: unknown) => {
      assert.match((err as Error).message, /unknown token "thnking"/);
      assert.match((err as Error).message, /typo\.yaml/);
      return true;
    });
  });

  it("every shipped palette defines every one of the seven new tokens with a non-undefined value", async () => {
    const { SHIPPED_PALETTES } = await import("./palettes.js");
    const newTokens = ["thinking", "speech", "costed", "local", "added", "removed", "modalBg"] as const;
    for (const [name, palette] of Object.entries(SHIPPED_PALETTES)) {
      for (const token of newTokens) {
        assert.notEqual(palette.tokens[token], undefined, `${name} is missing token "${token}"`);
      }
    }
  });
});
