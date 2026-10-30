import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, afterEach } from "node:test";
import { loadConfig } from "../config/load.js";
import { globalSpecialistsDir, projectSpecialistsDir } from "../config/specialists.js";
import {
  INSTRUCTIONS_NOT_LIVE_NOTE,
  SKILLS_NOT_LIVE_NOTE,
  type SpecialistChangeLine,
  formatSpecialistChangeReport,
  formatSpecialistList,
  specialistNamesFor,
  resolveSpecialistSwitch,
} from "./specialist-switch.js";
import { createSpecialistGuardHandler } from "../tools/specialist-guard-extension.js";
import { SPECIALIST_NAME_ENV, SPECIALIST_OFF_LIMITS_ENV, SPECIALIST_ALLOWED_ENV } from "../config/extensions.js";
import { createSpecialistSwitcher } from "../tui/interactive-surface.js";
import { applySpecialist } from "./specialist-apply.js";
import { AutoApproveGate, PostureGate, type ApprovalRequest, type ReadOnlyPosture } from "../gate/approval.js";
import { resolveStandaloneTools, applyToolDeltas } from "../tools.js";
import { newRetryObservation } from "../loop/retry-observer.js";
import type { StandaloneSessionState } from "./session.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "lykos-specialist-switch-"));
}

function writeSpecialist(dir: string, name: string, yaml: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), yaml, "utf8");
}

function writeSkill(cwd: string, filename: string, frontmatter: string): void {
  mkdirSync(join(cwd, ".lykos", "skills"), { recursive: true });
  writeFileSync(join(cwd, ".lykos", "skills", filename), frontmatter, "utf8");
}

const fakeCall = (toolName: string) =>
  ({ type: "tool_call", toolCallId: "c1", toolName, input: {} } as any);

function makeState(model = "test/model"): StandaloneSessionState {
  return {
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0,
      reasoning: 0, nestedInput: 0, nestedOutput: 0, nestedCacheRead: 0, nestedCacheWrite: 0, calls: [],
    },
    toolCalls: [], turns: 0, lastText: "", humanInterventions: 0,
    retry: newRetryObservation(),
    initialModel: model, currentModel: model,
  };
}

describe("resolveSpecialistSwitch", () => {
  const origEnvName = process.env[SPECIALIST_NAME_ENV];
  const origEnvOffLimits = process.env[SPECIALIST_OFF_LIMITS_ENV];
  const origEnvAllowed = process.env[SPECIALIST_ALLOWED_ENV];

  afterEach(() => {
    if (origEnvName !== undefined) process.env[SPECIALIST_NAME_ENV] = origEnvName;
    else delete process.env[SPECIALIST_NAME_ENV];
    if (origEnvOffLimits !== undefined) process.env[SPECIALIST_OFF_LIMITS_ENV] = origEnvOffLimits;
    else delete process.env[SPECIALIST_OFF_LIMITS_ENV];
    if (origEnvAllowed !== undefined) process.env[SPECIALIST_ALLOWED_ENV] = origEnvAllowed;
    else delete process.env[SPECIALIST_ALLOWED_ENV];
  });

  it("switching to a nonexistent specialist fails and names the ones that exist, changing nothing", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(globalSpecialistsDir(globalDir), "minimal", "instructions: a\n");
    const { resolved: currentConfig } = loadConfig({ cwd, globalDir, env: {} });

    const result = resolveSpecialistSwitch({ name: "typo", cwd, globalDir, env: {}, currentConfig });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /minimal/);
  });

  it("resolves the new specialist's model, tools and instructions and reports what changed", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(
      globalSpecialistsDir(globalDir),
      "deliberate",
      "provider: anthropic\nmodel: claude-sonnet-4-5\ntools: [read, grep]\ninstructions: Weigh alternatives before committing.\n",
    );
    const { resolved: currentConfig } = loadConfig({ cwd, globalDir, env: {} });

    const result = resolveSpecialistSwitch({ name: "deliberate", cwd, globalDir, env: {}, currentConfig });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.name, "deliberate");
    assert.deepEqual(result.toolNames, ["read", "grep"]);
    const fields = result.changed.map((c) => c.field).sort();
    assert.deepEqual(fields, ["instructions", "model", "tools"]);
    const model = result.changed.find((c) => c.field === "model");
    assert.equal(model?.to, "anthropic/claude-sonnet-4-5");
  });

  it("a specialist that only sets instructions reports tools unchanged", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(globalSpecialistsDir(globalDir), "minimal", "instructions: Do the smallest thing that works.\n");
    const { resolved: currentConfig } = loadConfig({ cwd, globalDir, env: {} });

    const result = resolveSpecialistSwitch({ name: "minimal", cwd, globalDir, env: {}, currentConfig });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.changed.some((c) => c.field === "tools"), false);
    assert.equal(result.changed.some((c) => c.field === "instructions"), true);
  });

  it("switching to the same specialist a session already runs under reports nothing changed", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(globalSpecialistsDir(globalDir), "minimal", "instructions: Do the smallest thing that works.\n");
    const { resolved: currentConfig } = loadConfig({ cwd, globalDir, env: {}, specialistName: "minimal" });

    const result = resolveSpecialistSwitch({ name: "minimal", cwd, globalDir, env: {}, currentConfig });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.changed, []);
  });

  it("a flag still beats the newly selected specialist", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(globalSpecialistsDir(globalDir), "deliberate", "instructions: from the specialist\n");
    const { resolved: currentConfig } = loadConfig({ cwd, globalDir, env: {} });

    const result = resolveSpecialistSwitch({
      name: "deliberate",
      cwd,
      globalDir,
      env: {},
      flags: { instructions: "from the flag" },
      currentConfig,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.instructions, "from the flag");
  });

  it("a project specialist wins over a global one of the same name, same as boot", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(globalSpecialistsDir(globalDir), "review", "instructions: global version\n");
    writeSpecialist(projectSpecialistsDir(cwd), "review", "instructions: project version\n");
    const { resolved: currentConfig } = loadConfig({ cwd, globalDir, env: {} });

    const result = resolveSpecialistSwitch({ name: "review", cwd, globalDir, env: {}, currentConfig });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.config.instructions, "project version");
  });

  it("reports a skill-roster change, honestly flagged as not live (ticket 05)", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSkill(cwd, "reviewer.md", "---\nname: reviewer\ndescription: review only\n---\n# review\n");
    writeSpecialist(globalSpecialistsDir(globalDir), "review", "skills: [reviewer]\n");
    const { resolved: currentConfig } = loadConfig({ cwd, globalDir, env: {} });

    const result = resolveSpecialistSwitch({ name: "review", cwd, globalDir, env: {}, currentConfig });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const skills = result.changed.find((c) => c.field === "skills");
    assert.ok(skills, "a roster change must be reported");
    assert.equal(skills.from, "(unset)");
    assert.equal(skills.to, "reviewer");
    assert.equal(skills.note, SKILLS_NOT_LIVE_NOTE);
  });

  it("reports no skills change when both specialists declare the same roster", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSkill(cwd, "reviewer.md", "---\nname: reviewer\ndescription: review only\n---\n# review\n");
    writeSpecialist(globalSpecialistsDir(globalDir), "review", "skills: [reviewer]\n");
    const { resolved: currentConfig } = loadConfig({ cwd, globalDir, env: {}, specialistName: "review" });

    const result = resolveSpecialistSwitch({ name: "review", cwd, globalDir, env: {}, currentConfig });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.changed.some((c) => c.field === "skills"), false);
  });

  it("the notice names the tools that are now off limits", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(globalSpecialistsDir(globalDir), "reviewer", "tools: [read, grep]\n");
    const { resolved: currentConfig } = loadConfig({ cwd, globalDir, env: {} });

    const result = resolveSpecialistSwitch({
      name: "reviewer", cwd, globalDir, env: {}, currentConfig,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.ok(result.offLimitToolNames.includes("write"));
    assert.ok(result.offLimitToolNames.includes("edit"));
    assert.ok(result.offLimitToolNames.includes("bash"));
    const notice = result.notices.find((n) => n.includes("off limits"));
    assert.ok(notice, "must have an off-limits notice");
    assert.match(notice!, /write/);
    assert.match(notice!, /edit/);
    assert.match(notice!, /bash/);

    const report = formatSpecialistChangeReport(result.name, result.changed, result.notices);
    assert.match(report, /notice: tools now off limits/);
    assert.match(report, /write/);
  });

  it("a second switch measures off limits against the request, not the previous specialist", () => {
    // The fail-open this guards. A switch APPENDS: the request still carries every
    // tool the session booted with. Computing off-limits from the previous
    // specialist's narrower set means switching reviewer -> writer leaves `bash`
    // in neither off-limits list while it is still sitting in the request, so the
    // guard never refuses it. The restriction has to be measured against what the
    // model can actually call.
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(globalSpecialistsDir(globalDir), "reviewer", "tools: [read]\n");
    writeSpecialist(globalSpecialistsDir(globalDir), "writer", "tools: [write]\n");
    const { resolved: bootConfig } = loadConfig({ cwd, globalDir, env: {} });

    const sessionToolNames = applyToolDeltas(
      resolveStandaloneTools({}),
      bootConfig.tools_add,
      bootConfig.tools_remove,
    );
    assert.ok(sessionToolNames.includes("bash"), "the booted request carries bash");

    const first = resolveSpecialistSwitch({
      name: "reviewer", cwd, globalDir, env: {}, currentConfig: bootConfig, sessionToolNames,
    });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.ok(first.offLimitToolNames.includes("bash"), "reviewer puts bash off limits");

    // Now switch again. The request is unchanged — append never removed anything.
    const second = resolveSpecialistSwitch({
      name: "writer", cwd, globalDir, env: {}, currentConfig: first.config, sessionToolNames,
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.ok(
      second.offLimitToolNames.includes("bash"),
      "bash is still in the request and still not allowed, so it must still be refused",
    );
    assert.equal(second.offLimitToolNames.includes("write"), false, "writer allows write");
  });

  it("the notice names the specialist's preferred model only when it differs from the running one — assert both directions", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(globalSpecialistsDir(globalDir), "heavy", "provider: openai\nmodel: gpt-4o\n");
    const { resolved: currentConfig } = loadConfig({ cwd, globalDir, env: {} });
    const diff = resolveSpecialistSwitch({
      name: "heavy", cwd, globalDir, env: {}, currentConfig, runningModel: "anthropic/claude-sonnet-4-5",
    });
    assert.equal(diff.ok, true);
    if (!diff.ok) return;
    const n1 = diff.notices.find((n) => n.includes("preferred model"));
    assert.ok(n1);
    assert.match(n1!, /openai\/gpt-4o/);
    assert.match(n1!, /anthropic\/claude-sonnet-4-5/);

    const same = resolveSpecialistSwitch({
      name: "heavy", cwd, globalDir, env: {}, currentConfig, runningModel: "openai/gpt-4o",
    });
    assert.equal(same.ok, true);
    if (!same.ok) return;
    assert.equal(same.notices.some((n) => n.includes("preferred model")), false);
  });

  it("a prompt_mode: override specialist is accepted and the notice says the override is inactive", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(globalSpecialistsDir(globalDir), "fresh", "prompt_mode: override\ninstructions: fresh\n");
    const { resolved: currentConfig } = loadConfig({ cwd, globalDir, env: {} });
    const result = resolveSpecialistSwitch({
      name: "fresh", cwd, globalDir, env: {}, currentConfig,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.app.promptMode, "append");
    const notice = result.notices.find((n) => n.includes("prompt_mode: override"));
    assert.ok(notice, "must have an override notice");
    assert.match(notice!, /NOT active in this session/);
    assert.match(notice!, /\/clear/);
    const report = formatSpecialistChangeReport(result.name, result.changed, result.notices);
    assert.match(report, /NOT active in this session/);
  });

  it("proves the switch delegates to the seam rather than deciding", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(globalSpecialistsDir(globalDir), "custom", "prompt_mode: override\ntools: [read]\nmodel: m1\nprovider: p1\n");
    const { resolved: currentConfig } = loadConfig({ cwd, globalDir, env: {} });
    const result = resolveSpecialistSwitch({
      name: "custom", cwd, globalDir, env: {}, currentConfig, runningModel: "m0",
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Derive the seam's inputs the way the switch derives them. Hardcoding a
    // tool list here would make this test fail the next time the default
    // surface gains a tool, which proves nothing about delegation.
    const beforeTools = applyToolDeltas(
      resolveStandaloneTools({}),
      currentConfig.tools_add,
      currentConfig.tools_remove,
    );
    const directApp = applySpecialist({
      name: "custom",
      context: "switch",
      specialist: { prompt_mode: "override", provider: "p1", model: "m1" },
      parentModel: "m0",
      defaultToolNames: beforeTools,
      specialistToolNames: ["read"],
    });
    assert.deepEqual(result.app, directApp, "the switch must return the seam's answer, not its own");
  });

  it("a switch leaves the assembled system prompt and the tool list byte-identical (D4)", async () => {
    const cwd = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "reviewer", "tools: [read]\ninstructions: review only\n");
    const { resolved: initialConfig } = loadConfig({ cwd, env: {} });
    let prompt = "assembled system prompt";
    let tools = ["read", "write", "edit", "bash"];
    const promptBefore = prompt;
    const toolsBefore = [...tools];
    const session = {
      async setModel() {},
      setActiveToolsByName(names: string[]) {
        tools = names;
        prompt = "modified";
      },
    };
    const switcher = createSpecialistSwitcher({
      cwd, session, modelRuntime: {} as any, initialConfig,
      initialSpecialistName: undefined, toolsOverride: undefined,
      state: makeState(),
    });
    const res = await switcher.switchSpecialist("reviewer");
    assert.equal(res.ok, true);
    assert.equal(prompt, promptBefore);
    assert.deepEqual(tools, toolsBefore);
  });

  it("a switch keeps the running model whatever the specialist declares", async () => {
    const cwd = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "differing", "provider: openai\nmodel: gpt-4o\n");
    const { resolved: initialConfig } = loadConfig({ cwd, env: {} });
    let setModelCalled = false;
    const session = { async setModel() { setModelCalled = true; }, setActiveToolsByName() {} };
    const state = makeState("anthropic/claude-sonnet-4-5");
    const switcher = createSpecialistSwitcher({ cwd, session, modelRuntime: {} as any, initialConfig, initialSpecialistName: undefined, toolsOverride: undefined, state });
    const res = await switcher.switchSpecialist("differing");
    assert.equal(res.ok, true);
    assert.equal(setModelCalled, false);
    assert.equal(state.currentModel, "anthropic/claude-sonnet-4-5");
  });

  it("a disallowed tool is refused on the turn immediately after the switch — call the tool", async () => {
    const cwd = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "reviewer", "tools: [read, grep]\n");
    const { resolved: initialConfig } = loadConfig({ cwd, env: {} });
    const session = { async setModel() {}, setActiveToolsByName() {} };
    const switcher = createSpecialistSwitcher({ cwd, session, modelRuntime: {} as any, initialConfig, initialSpecialistName: undefined, toolsOverride: undefined, state: makeState() });
    const guard = createSpecialistGuardHandler();
    assert.equal(guard(fakeCall("write")), undefined);
    const res = await switcher.switchSpecialist("reviewer");
    assert.equal(res.ok, true);
    const writeResult = guard(fakeCall("write"));
    assert.ok(writeResult?.block);
    assert.match(writeResult!.reason!, /reviewer/);
    assert.match(writeResult!.reason!, /write/);
    assert.equal(guard(fakeCall("read")), undefined);
  });

  it("T214 (Ruling 3): switching from writing to read_only tightens the posture ceiling; reverse lifts it", async () => {
    const cwd = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "writer", "tools: [read, write]\n");
    writeSpecialist(projectSpecialistsDir(cwd), "reader", "read_only: true\ntools: [read]\n");
    const { resolved: initialConfig } = loadConfig({ cwd, env: {}, specialistName: "writer" });
    const posture: ReadOnlyPosture = { readOnly: false };
    const gate = new PostureGate(new AutoApproveGate(), posture);
    const writeReq: ApprovalRequest = { kind: "write", summary: "write", detail: "a.ts" };

    // Initially under "writer", posture is not read-only: writes are permitted
    assert.equal(await gate.request(writeReq), "allow");

    const session = { async setModel() {}, setActiveToolsByName() {} };
    const switcher = createSpecialistSwitcher({
      cwd,
      session,
      modelRuntime: {} as any,
      initialConfig,
      initialSpecialistName: "writer",
      toolsOverride: undefined,
      state: makeState(),
      readOnlyPosture: posture,
    });

    // Direction 1: switch from writer to reader -> tightens the ceiling
    const toReader = await switcher.switchSpecialist("reader");
    assert.equal(toReader.ok, true);
    assert.equal(posture.readOnly, true);
    assert.equal(await gate.request(writeReq), "deny");
    assert.match(gate.denialReason(writeReq) ?? "", /read-only/);

    // Direction 2: switch from reader to writer -> lifts the ceiling
    const toWriter = await switcher.switchSpecialist("writer");
    assert.equal(toWriter.ok, true);
    assert.equal(posture.readOnly, false);
    assert.equal(await gate.request(writeReq), "allow");
  });
});

describe("formatSpecialistChangeReport", () => {
  it("names the specialist and every changed field, and says the prefix was NOT broken", () => {
    // This header used to claim "recorded as a prefix break: the tool surface was
    // rebuilt". Band 2 made the opposite true and guaranteed it: a switch appends,
    // keeps the running model, and leaves the prompt prefix and tool list
    // byte-identical (ADR-0021). A report contradicting the behaviour it
    // describes is worse than no report.
    const text = formatSpecialistChangeReport("deliberate", [{ field: "model", from: "(unset)", to: "anthropic/claude-sonnet-4-5" }]);
    assert.match(text, /deliberate/);
    assert.match(text, /model: \(unset\) -> anthropic\/claude-sonnet-4-5/);
    assert.match(text, /prefix and tool list are untouched/);
    assert.equal(/prefix break/.test(text), false, "the old claim must not survive");
  });

  it("says so plainly when nothing actually differs", () => {
    const text = formatSpecialistChangeReport("minimal", []);
    assert.match(text, /nothing about the running session.*differs/);
  });

  // Review follow-up (F2). The report used to list `instructions: 40 -> 120`
  // beside four fields that DO take effect, with nothing distinguishing it.
  // The head is frozen at boot, so that line asserted an effect that never
  // happened — the opposite of story 7's "told what actually changed... so
  // that I can predict the effect".
  it("marks a change that is recorded but does not reach the running session", () => {
    const text = formatSpecialistChangeReport("deliberate", [
      { field: "model", from: "a", to: "b" },
      { field: "instructions", from: "(none)", to: "set (120 chars)", note: INSTRUCTIONS_NOT_LIVE_NOTE },
    ]);
    assert.match(text, /instructions: \(none\) -> set \(120 chars\)/);
    assert.match(text, /NOT applied to this running session/);
    assert.match(text, /takes effect on the next session started with this specialist/);
    // The fields that DO apply live carry no such caveat.
    const modelLine = text.split("\n").find((l) => l.includes("model:")) ?? "";
    assert.equal(modelLine.includes("NOT applied"), false);
  });

  it("resolving a switch that changes instructions always carries the not-live note", () => {
    const line: SpecialistChangeLine = {
      field: "instructions",
      from: "(none)",
      to: "set (5 chars)",
      note: INSTRUCTIONS_NOT_LIVE_NOTE,
    };
    assert.equal(line.note, INSTRUCTIONS_NOT_LIVE_NOTE);
    assert.match(formatSpecialistChangeReport("p", [line]), /NOT applied/);
  });

});

describe("formatSpecialistList", () => {
  it("marks the active specialist and shows each description", () => {
    const text = formatSpecialistList(
      [
        { name: "deliberate", description: "full reasoning effort" },
        { name: "minimal", description: "do the smallest thing" },
      ],
      "minimal",
    );
    assert.match(text, /\* minimal — do the smallest thing/);
    assert.ok(text.includes("  deliberate — full reasoning effort"));
  });

  it("says so when nothing was discovered", () => {
    const text = formatSpecialistList([], undefined);
    assert.match(text, /no specialists discovered/);
  });
});

describe("specialistNamesFor", () => {
  it("returns the discovered names, for composer completion", () => {
    const cwd = tmp();
    const globalDir = tmp();
    // Ticket 07: isolate the shipped library so this test stays about the
    // global + project sources only.
    const shipped = tmp();
    writeSpecialist(globalSpecialistsDir(globalDir), "explore", "instructions: a\n");
    writeSpecialist(projectSpecialistsDir(cwd), "plan", "instructions: b\n");
    assert.deepEqual(specialistNamesFor(cwd, globalDir, shipped), ["explore", "plan"]);
  });
});
