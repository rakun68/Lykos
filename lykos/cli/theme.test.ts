import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SHIPPED_DEFAULTS } from "../config/defaults.js";
import { resetIoMode, setIoMode } from "../tui/io-mode.js";
import { loadPalette } from "../tui/theme/load.js";
import { runThemeEject, runThemePreview } from "./theme.js";

function capture(fn: () => number): { code: number; out: string } {
  setIoMode("standalone");
  const chunks: string[] = [];
  const realWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = fn();
    return { code, out: chunks.join("") };
  } finally {
    process.stdout.write = realWrite;
    resetIoMode();
  }
}

describe("T51.1: `lykos theme preview` shows every token, including the new ones", () => {
  const NEW_TOKENS = ["thinking", "speech", "costed", "local", "added", "removed", "modalBg"];

  for (const name of ["rose-pine", "rose-pine-moon", "rose-pine-dawn", "catppuccin-mocha", "catppuccin-latte"]) {
    it(`${name} lists all seven new tokens`, () => {
      const { code, out } = capture(() =>
        runThemePreview(
          { cwd: process.cwd(), resolved: SHIPPED_DEFAULTS, env: { COLORTERM: "truecolor" }, isTTY: false, colorFlag: "always" },
          name,
        ),
      );
      assert.equal(code, 0);
      assert.match(out, /tokens:/);
      for (const token of NEW_TOKENS) {
        assert.match(out, new RegExp(`\\b${token}\\b`), `${name} preview is missing the "${token}" token`);
      }
    });
  }

  it("an unknown theme still fails cleanly (unrelated to the token listing)", () => {
    const { code } = capture(() =>
      runThemePreview({ cwd: process.cwd(), resolved: SHIPPED_DEFAULTS, env: {}, isTTY: false }, "does-not-exist"),
    );
    assert.equal(code, 1);
  });
});

describe("T51.6 (2026-09-02): `lykos theme eject` writes a real, editable .lykos/themes/<name>.yaml", () => {
  it("writes a file that extends the base palette, with every token commented out at its resolved hex", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lykos-theme-eject-"));
    try {
      const { code, out } = capture(() =>
        runThemeEject({ cwd, resolved: SHIPPED_DEFAULTS, env: {}, isTTY: false }, "sky", "mine"),
      );
      assert.equal(code, 0);
      const path = join(cwd, ".lykos", "themes", "mine.yaml");
      assert.ok(existsSync(path));
      assert.match(out, /wrote/);
      const content = readFileSync(path, "utf8");
      assert.match(content, /extends: sky/);
      const skyPalette = loadPalette("sky");
      assert.match(content, new RegExp(`# accent: "${skyPalette.tokens.accent}"`));
      // A commented line, not a live one — eject never activates the theme by itself.
      assert.doesNotMatch(content, /^accent:/m);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing theme file", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lykos-theme-eject-"));
    try {
      runThemeEject({ cwd, resolved: SHIPPED_DEFAULTS, env: {}, isTTY: false }, "sky", "mine");
      const { code } = capture(() => runThemeEject({ cwd, resolved: SHIPPED_DEFAULTS, env: {}, isTTY: false }, "sky", "mine"));
      assert.equal(code, 1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("defaults the base to the resolved config's active theme and the name to 'custom'", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lykos-theme-eject-"));
    try {
      const code = runThemeEject({ cwd, resolved: { ...SHIPPED_DEFAULTS, ui: { ...SHIPPED_DEFAULTS.ui, theme: "sky" } }, env: {}, isTTY: false });
      assert.equal(code, 0);
      const content = readFileSync(join(cwd, ".lykos", "themes", "custom.yaml"), "utf8");
      assert.match(content, /extends: sky/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
