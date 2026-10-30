import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GITIGNORE_LINES, scaffoldLykosDir } from "./scaffold.js";

describe("scaffoldLykosDir", () => {
  it("creates config.yaml, agents/, memory/, and .gitignore on a clean directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-scaffold-"));
    const result = scaffoldLykosDir(dir);

    assert.equal(result.skipped.length, 0);
    // T102 added the first shipped skill and T101 the second, so the file
    // count moved 5 -> 7; T141 deleted T101's structural-search skill (the
    // `ast_grep` and `ast_edit` tools do its job), so it was 6; T205 added
    // the sealed-tdd skill, so it is 7.
    assert.equal(result.created.length, 9); // 7 files + the .claude/settings.json statusLine + .gitignore
    for (const rel of [
      ".lykos/config.yaml",
      ".lykos/agents/scout.md",
      ".lykos/agents/watcher.md",
      ".lykos/skills/finishing-work.md",
      ".lykos/skills/sealed-tdd.md",
      ".lykos/memory/gotchas.md",
      ".lykos/memory/failed-approaches.md",
      ".claude/settings.json",
      ".gitignore",
    ]) {
      assert.ok(existsSync(join(dir, rel)), `expected ${rel} to exist`);
    }
    const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.statusLine.command, "lykos hud --statusline");
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    for (const line of GITIGNORE_LINES) assert.ok(gitignore.includes(line), `expected .gitignore to include ${line}`);
  });

  it("never overwrites a file a user already edited", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-scaffold-"));
    scaffoldLykosDir(dir);
    const gotchasPath = join(dir, ".lykos", "memory", "gotchas.md");
    writeFileSync(gotchasPath, "# my own notes\n");

    const result = scaffoldLykosDir(dir);
    assert.equal(result.created.length, 0);
    assert.equal(result.skipped.length, 9);
    assert.equal(readFileSync(gotchasPath, "utf8"), "# my own notes\n");
  });

  it("appends missing entries to an existing .gitignore without disturbing what's already there", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-scaffold-"));
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n.lykos/ledger.db\n");

    const result = scaffoldLykosDir(dir);

    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.ok(gitignore.includes("node_modules/"));
    for (const line of GITIGNORE_LINES) assert.ok(gitignore.includes(line));
    // .lykos/ledger.db was already present — the appended block adds only
    // what was missing, so it must not appear a second time.
    assert.equal(gitignore.split(/\r?\n/).filter((l) => l === ".lykos/ledger.db").length, 1);
    assert.ok(result.created.some((c) => c.includes(".gitignore") && c.includes("6 Lykos")));
    // #47: nothing generates `.pi/agents/` any more, so there is nothing there to ignore.
    assert.ok(!gitignore.includes(".pi/agents/"));

    const second = scaffoldLykosDir(dir);
    assert.ok(second.skipped.some((s) => s.includes(".gitignore")));
  });

  it("merges statusLine into an existing .claude/settings.json without touching other keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-scaffold-"));
    const claudeDir = join(dir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ theme: "dark" }));

    scaffoldLykosDir(dir);

    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    assert.equal(settings.theme, "dark");
    assert.equal(settings.statusLine.command, "lykos hud --statusline");
  });

  it("leaves an existing statusLine alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-scaffold-"));
    const claudeDir = join(dir, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, "settings.json"), JSON.stringify({ statusLine: { command: "my-own-thing" } }));

    const result = scaffoldLykosDir(dir);

    const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
    assert.equal(settings.statusLine.command, "my-own-thing");
    assert.ok(result.skipped.some((s) => s.includes("statusLine")));
  });

  it("leaves containment.level unset, so a delegated session defaults to off (T180, T219)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-scaffold-"));
    scaffoldLykosDir(dir);
    const { loadConfig } = await import("./load.js");
    const { layers } = loadConfig({ cwd: dir, globalDir: join(dir, "no-global"), env: {} });
    assert.equal(layers.find((l) => l.name === "project")?.value.containment?.level, undefined);
  });
});
