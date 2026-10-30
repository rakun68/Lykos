// T217: Output styles tests (ADR-0045) — validation, volatile rejection, formatting, and switcher.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  createOutputStyleSwitcher,
  discoverOutputStyles,
  formatOutputStyleList,
  OutputStyleNotFoundError,
  OutputStyleValidationError,
  projectOutputStylesDir,
  resolveOutputStyle,
} from "./output-styles.js";

const cleanups: Array<() => void> = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-output-styles-test-"));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors in tests
    }
  });
  return dir;
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe("output styles validation and switcher", () => {
  it("rejects volatile content with OutputStyleValidationError naming the volatile parts", () => {
    const cwd = tmp();
    const globalDir = tmp();
    const projectDir = projectOutputStylesDir(cwd);
    mkdirSync(projectDir, { recursive: true });

    writeFileSync(
      join(projectDir, "bad.md"),
      "Keep answers brief. Note: time is 2026-10-19T10:00:00, check git status first.\n",
    );

    assert.throws(
      () => resolveOutputStyle("bad", cwd, globalDir),
      (err: unknown) => {
        assert.ok(err instanceof OutputStyleValidationError);
        assert.match((err as Error).message, /timestamp/);
        assert.match((err as Error).message, /git-status/);
        return true;
      },
    );
  });

  it("formatOutputStyleList marks the active style with asterisk", () => {
    const cwd = tmp();
    const globalDir = tmp();
    const projectDir = projectOutputStylesDir(cwd);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "concise.md"), "Be concise.\n");

    const styles = discoverOutputStyles(cwd, globalDir);
    const formatted = formatOutputStyleList(styles, "concise");
    assert.match(formatted, /\* concise \(project\)/);
    assert.match(formatted, /default \(shipped\)/);
    assert.match(formatted, /minimal \(shipped\)/);
  });

  it("createOutputStyleSwitcher switches style and returns report, rejects unknown", () => {
    const cwd = tmp();
    const globalDir = tmp();
    const projectDir = projectOutputStylesDir(cwd);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "terse.md"), "Terse.\n");

    const switcher = createOutputStyleSwitcher({ cwd, globalDir, initialOutputStyleName: "default" });
    assert.equal(switcher.currentOutputStyleName(), "default");

    const listReport = switcher.listOutputStyles();
    assert.match(listReport, /\* default \(shipped\)/);
    assert.match(listReport, /terse \(project\)/);

    const switchRes = switcher.switchOutputStyle("terse");
    assert.equal(switchRes.ok, true);
    assert.equal(switcher.currentOutputStyleName(), "terse");
    if (switchRes.ok) {
      assert.match(switchRes.report, /output style is now "terse"/);
    }
    const notice = switcher.takeOutputStyleNotice();
    assert.ok(notice !== undefined);
    assert.match(notice, /Output style is now "terse"/);
    assert.match(notice, /Terse\./);
    // Notice is single-consumption
    assert.equal(switcher.takeOutputStyleNotice(), undefined);

    const badSwitch = switcher.switchOutputStyle("nonexistent");
    assert.equal(badSwitch.ok, false);
    if (!badSwitch.ok) {
      assert.match(badSwitch.message, /no output style named "nonexistent"/);
    }
  });

  it("throws OutputStyleNotFoundError when resolving an unknown style", () => {
    const cwd = tmp();
    const globalDir = tmp();
    assert.throws(
      () => resolveOutputStyle("nonexistent", cwd, globalDir),
      (err: unknown) => {
        assert.ok(err instanceof OutputStyleNotFoundError);
        assert.match((err as Error).message, /no output style named "nonexistent"/);
        return true;
      },
    );
  });
});
