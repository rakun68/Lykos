// Specialists review follow-up — the two findings the /code-review spec axis
// raised against tickets 02 and 04.
//
// F1: `config/pi-preset-export.ts` existed but nothing called it, so ticket
// 02's "a Lykos specialist file is valid input to Pi's preset extension for
// those five" was unmet in practice — the file Pi reads was never produced.
// These tests drive the real command and then assert the artefact is what
// Pi's own `loadPresets()` expects: one JSON object keyed by specialist name.
//
// F2: a mid-session switch reported `instructions` as changed when the value
// never reaches the running session. Covered in `specialist-switch.test.ts`.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { resetIoMode } from "../tui/io-mode.js";
import { runSpecialistExportPi, runSpecialistList, runSpecialistShow } from "./specialist.js";
import { applySpecialist } from "../session/specialist-apply.js";
import { PONYTAIL_HEADING } from "../session/ponytail-head.js";
import { runPrompt } from "./prompt.js";
import { resolveStandaloneTools } from "../tools.js";

function withCapturedStdout<T>(fn: () => T): { result: T; out: string } {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    out += s;
    return true;
  };
  try {
    return { result: fn(), out };
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
}

function withCapturedStderr<T>(fn: () => T): { result: T; err: string } {
  const original = process.stderr.write.bind(process.stderr);
  let err = "";
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    err += s;
    return true;
  };
  try {
    return { result: fn(), err };
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
}

async function withCapturedStdoutAsync<T>(fn: () => Promise<T>): Promise<{ result: T; out: string }> {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    out += s;
    return true;
  };
  try {
    return { result: await fn(), out };
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
}

describe("lykos specialist — the command-line surface", () => {
  let root: string;
  let cwd: string;
  let globalDir: string;

  beforeEach(() => {
    resetIoMode();
    root = mkdtempSync(join(tmpdir(), "lykos-specialist-cli-"));
    cwd = join(root, "project");
    globalDir = join(root, "global");
    mkdirSync(join(cwd, ".lykos", "specialists"), { recursive: true });
    mkdirSync(join(globalDir, "specialists"), { recursive: true });
  });

  afterEach(() => {
    resetIoMode();
    rmSync(root, { recursive: true, force: true });
  });

  test("list reports each specialist's one-line description", () => {
    writeFileSync(
      join(cwd, ".lykos", "specialists", "plan.yaml"),
      'description: read-only planning\ninstructions: Plan first.\n',
      "utf8",
    );
    const { result, out } = withCapturedStdout(() => runSpecialistList(cwd, globalDir));
    assert.equal(result, 0);
    assert.match(out, /plan — read-only planning/);
  });

  test("list says so when nothing is discovered, rather than printing an empty roster", () => {
    // Ticket 07: isolate the shipped library — "nothing discovered" is now
    // only reachable when the project, global AND shipped sources are empty.
    const shipped = join(root, "no-shipped");
    const { result, out } = withCapturedStdout(() => runSpecialistList(cwd, globalDir, shipped));
    assert.equal(result, 0);
    assert.match(out, /no specialists discovered/);
  });

  // F1: the checkbox this closes. Before this command existed the translator
  // was unreachable, so `.pi/presets.json` was never written and Pi could not
  // read a Lykos specialist at all.
  test("export-pi writes the file Pi's preset extension actually reads", () => {
    writeFileSync(
      join(cwd, ".lykos", "specialists", "deliberate.yaml"),
      [
        "description: full reasoning effort",
        "provider: anthropic",
        "model: claude-opus-5",
        "thinkingLevel: high",
        "tools:",
        "  - read",
        "  - grep",
        "instructions: Weigh alternatives before committing.",
        "",
      ].join("\n"),
      "utf8",
    );

    // Ticket 07: isolate the shipped library so this asserts the project's
    // specialist alone, not the bundled five.
    const shipped = join(root, "no-shipped");
    const { result } = withCapturedStdout(() => runSpecialistExportPi(cwd, globalDir, shipped));
    assert.equal(result, 0);

    // Pi's `loadPresets()` reads `<cwd>/.pi/presets.json` as a map of
    // name -> preset. Assert that exact shape, not our own.
    const raw = readFileSync(join(cwd, ".pi", "presets.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(parsed), ["deliberate"]);
    assert.deepEqual(parsed.deliberate, {
      provider: "anthropic",
      model: "claude-opus-5",
      thinkingLevel: "high",
      tools: ["read", "grep"],
      instructions: "Weigh alternatives before committing.",
    });
  });

  test("export-pi carries only the five shared fields, never a Lykos-only one", () => {
    writeFileSync(
      join(cwd, ".lykos", "specialists", "review.yaml"),
      [
        "description: reviewer, no writes",
        "instructions: Report, do not fix.",
        "read_only: true",
        "gate:",
        "  enabled: false",
        "",
      ].join("\n"),
      "utf8",
    );

    withCapturedStdout(() => runSpecialistExportPi(cwd, globalDir));
    const parsed = JSON.parse(readFileSync(join(cwd, ".pi", "presets.json"), "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    assert.deepEqual(Object.keys(parsed.review ?? {}), ["instructions"]);
    for (const lykosOnly of ["read_only", "gate", "description", "tools_add", "tools_remove"]) {
      assert.equal(lykosOnly in (parsed.review ?? {}), false, `${lykosOnly} must not reach Pi's format`);
    }
  });

  test("a project specialist beats a global one of the same name in the export", () => {
    writeFileSync(join(globalDir, "specialists", "plan.yaml"), "model: global-model\n", "utf8");
    writeFileSync(join(cwd, ".lykos", "specialists", "plan.yaml"), "model: project-model\n", "utf8");
    withCapturedStdout(() => runSpecialistExportPi(cwd, globalDir));
    const parsed = JSON.parse(readFileSync(join(cwd, ".pi", "presets.json"), "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    assert.equal(parsed.plan?.model, "project-model");
  });

  test("show prints per-tool disposition in three named groups (resident, mounted, off)", () => {
    writeFileSync(
      join(cwd, ".lykos", "specialists", "focus.yaml"),
      ["prompt_mode: override", "tools_mode: override", "provider: anthropic", "model: claude-opus-5", "tools:", "  - read", "  - grep", "instructions: Focus.", ""].join("\n"),
      "utf8",
    );
    const shipped = join(root, "no-shipped");
    const { result, out } = withCapturedStdout(() => runSpecialistShow(cwd, "focus", { globalDir, shippedDir: shipped }));
    assert.equal(result, 0);
    assert.match(out, /^specialist: focus$/m);
    assert.match(out, /^prompt_mode: override$/m);
    assert.match(out, /^tools_mode: override$/m);
    assert.match(out, /^model: anthropic\/claude-opus-5$/m);
    assert.match(out, /^  resident: grep, read$/m);
    assert.ok(out.includes("  mounted: (none — P10.1)"));
    // Everything resident that this specialist did NOT ask for. P10.4 made
    // `glob` and `powershell` resident, so both join the off list for a
    // specialist whose `tools:` names only `read` and `grep` — which is the
    // point of `tools_mode: override` and of the `off` state itself: a tool
    // absent from a list is still callable by a model that remembers it, and
    // `off` is what makes the restriction real.
    //
    // P10.7 (ticket 12) made `web_search` and `web_fetch` resident, so both
    // join the same list for the same reason: a specialist that named neither
    // must not be able to reach the internet by remembering a tool name.
    const offLine = out.split(/\r?\n/).find((l) => l.startsWith("  off: "));
    assert.notEqual(offLine, undefined, "show printed no off line at all");
    assert.deepEqual(
      offLine!.slice("  off: ".length).split(", "),
      ["ask", "bash", "commit", "edit", "exit_plan", "glob", "powershell", "todo", "tool_call", "tool_search", "web_fetch", "web_search", "write"],
    );
  });

  test("an overriding specialist prints a prompt without the default ruleset block under subagent, and WITH it under switch", async () => {
    writeFileSync(
      join(cwd, ".lykos", "specialists", "overrider.yaml"),
      "prompt_mode: override\ninstructions: Custom instructions.\n",
      "utf8",
    );
    const subRes = await withCapturedStdoutAsync(() => runPrompt(cwd, { specialist: "overrider", context: "subagent" }));
    assert.equal(subRes.result, 0);
    assert.ok(!subRes.out.includes(PONYTAIL_HEADING), "subagent context drops ponytail ruleset when prompt_mode is override");

    const switchRes = await withCapturedStdoutAsync(() => runPrompt(cwd, { specialist: "overrider", context: "switch" }));
    assert.equal(switchRes.result, 0);
    assert.ok(switchRes.out.includes(PONYTAIL_HEADING), "switch context retains ponytail ruleset when prompt_mode is override");

    const showSwitch = withCapturedStdout(() => runSpecialistShow(cwd, "overrider", { globalDir, shippedDir: join(root, "no-shipped"), context: "switch" }));
    assert.equal(showSwitch.result, 0);
    assert.match(showSwitch.out, /the override is NOT active in this session/);
  });

  test("show produces byte-identical output on repeat invocations", () => {
    writeFileSync(
      join(cwd, ".lykos", "specialists", "repeatable.yaml"),
      "instructions: Deterministic show test.\n",
      "utf8",
    );
    const shipped = join(root, "no-shipped");
    const run1 = withCapturedStdout(() => runSpecialistShow(cwd, "repeatable", { globalDir, shippedDir: shipped }));
    const run2 = withCapturedStdout(() => runSpecialistShow(cwd, "repeatable", { globalDir, shippedDir: shipped }));
    assert.equal(run1.result, 0);
    assert.equal(run2.result, 0);
    assert.equal(run1.out, run2.out);
  });

  test("show omits the off-limits section when a specialist disallows nothing", () => {
    writeFileSync(
      join(cwd, ".lykos", "specialists", "all-allowed.yaml"),
      "instructions: Disallow nothing.\n",
      "utf8",
    );
    const shipped = join(root, "no-shipped");
    const { result, out } = withCapturedStdout(() => runSpecialistShow(cwd, "all-allowed", { globalDir, shippedDir: shipped }));
    assert.equal(result, 0);
    assert.ok(out.includes("  resident:"));
    assert.ok(out.includes("  mounted: (none — P10.1)"));
    assert.ok(!out.includes("  off:"));
  });

  test("show produces clean error listing available specialists when the name is unknown (L1)", () => {
    writeFileSync(
      join(cwd, ".lykos", "specialists", "known.yaml"),
      "instructions: A known specialist.\n",
      "utf8",
    );
    const shipped = join(root, "no-shipped");
    const { result, err } = withCapturedStderr(() =>
      runSpecialistShow(cwd, "nonexistent", { globalDir, shippedDir: shipped }),
    );
    assert.equal(result, 1);
    assert.ok(err.includes('no specialist named "nonexistent"'));
    assert.ok(err.includes("known"));
  });

  test("printed dispositions equal applySpecialist's own tools and offLimitToolNames for the same input", () => {
    writeFileSync(
      join(cwd, ".lykos", "specialists", "honesty.yaml"),
      ["prompt_mode: override", "tools_mode: override", "tools:", "  - read", "  - grep", "instructions: Test honesty.", ""].join("\n"),
      "utf8",
    );
    const shipped = join(root, "no-shipped");
    const { result, out } = withCapturedStdout(() => runSpecialistShow(cwd, "honesty", { globalDir, shippedDir: shipped }));
    assert.equal(result, 0);

    const defaultToolNames = resolveStandaloneTools({ isChild: false });
    const app = applySpecialist({
      name: "honesty",
      specialist: { prompt_mode: "override", tools_mode: "override", instructions: "Test honesty." },
      context: "session-start",
      defaultToolNames,
      specialistToolNames: ["read", "grep"],
    });

    const expectedResident = [...new Set(app.tools.filter((t) => t.disposition === "resident").map((t) => t.name))].sort().join(", ");
    const expectedOff = [...new Set(app.tools.filter((t) => t.disposition === "off").map((t) => t.name))].sort().join(", ");

    assert.ok(out.includes("  resident: " + expectedResident));
    assert.ok(out.includes("  off: " + expectedOff));
    assert.deepEqual(
      app.tools.filter((t) => t.disposition === "off").map((t) => t.name).sort(),
      [...app.offLimitToolNames].sort(),
    );
  });

  test("show displays mounted tools and notice when tools_remove is used", () => {
    writeFileSync(
      join(cwd, ".lykos", "specialists", "remover.yaml"),
      ["tools_remove:", "  - bash", "instructions: Remove bash.", ""].join("\n"),
      "utf8",
    );
    const shipped = join(root, "no-shipped");
    const { result, out } = withCapturedStdout(() => runSpecialistShow(cwd, "remover", { globalDir, shippedDir: shipped }));
    assert.equal(result, 0);
    assert.ok(out.includes("  mounted: bash"));
    assert.ok(out.includes("genuinely removes capability this session"));
  });
});
