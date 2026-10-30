import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applySpecialist,
  type ApplySpecialistInput,
  type PromptMode,
  type ToolsMode,
  type SpecialistContext,
} from "./specialist-apply.js";

function getModelCase(ctx: SpecialistContext, i: number) {
  if (ctx !== "subagent") {
    return i % 2 === 0
      ? { specialistProvider: "p", specialistModel: "m", expectedModel: "p/m", expectedModelSource: "specialist" as const }
      : {};
  }
  const parentModel = "parent/m";
  switch (i % 9) {
    case 0: return { callerModel: "c/m", delegateModel: "specialist", parentModel, specialistProvider: "p", specialistModel: "m", expectedModel: "c/m", expectedModelSource: "caller_override" as const };
    case 1: return { callerModel: "c/m", delegateModel: "parent", parentModel, expectedModel: "c/m", expectedModelSource: "caller_override" as const };
    case 2: return { callerModel: "c/m", delegateModel: "named/m", parentModel, expectedModel: "c/m", expectedModelSource: "caller_override" as const };
    case 3: return { delegateModel: "specialist", parentModel, specialistProvider: "p", specialistModel: "m", expectedModel: "p/m", expectedModelSource: "specialist" as const };
    case 4: return { delegateModel: "specialist", parentModel, expectedModel: parentModel, expectedModelSource: "config_default" as const };
    case 5: return { parentModel, specialistProvider: "p", specialistModel: "m", expectedModel: "p/m", expectedModelSource: "specialist" as const };
    case 6: return { parentModel, expectedModel: parentModel, expectedModelSource: "config_default" as const };
    case 7: return { delegateModel: "parent", parentModel, specialistProvider: "p", specialistModel: "m", expectedModel: parentModel, expectedModelSource: "config_default" as const };
    default: return { delegateModel: "named/m", parentModel, specialistProvider: "p", specialistModel: "m", expectedModel: "named/m", expectedModelSource: "config_default" as const };
  }
}

describe("applySpecialist", () => {
  const promptModes: (PromptMode | undefined)[] = [undefined, "append", "override"];
  const toolsModes: (ToolsMode | undefined)[] = [undefined, "append", "override"];
  const contexts: SpecialistContext[] = ["session-start", "switch", "subagent"];

  interface MatrixCase {
    prompt_mode?: PromptMode;
    tools_mode?: ToolsMode;
    context: SpecialistContext;
    promptMode: PromptMode;
    toolsMode: ToolsMode;
    replacesDefaultHead: boolean;
    noticeCount: number;
    requestToolNames: string[];
    offLimitToolNames: string[];
    hasOffLimitsPromptPart: boolean;
    tools: { name: string; disposition: "resident" | "off"; inRequest: boolean }[];
    callerModel?: string;
    delegateModel?: string;
    parentModel?: string;
    specialistProvider?: string;
    specialistModel?: string;
    expectedModel?: string;
    expectedModelSource?: "config_default" | "caller_override" | "specialist";
  }

  const cases: MatrixCase[] = [];
  let subagentIndex = 0;
  let nonSubagentIndex = 0;

  for (const pm of promptModes) {
    for (const tm of toolsModes) {
      for (const ctx of contexts) {
        const expectedToolsMode: ToolsMode = tm ?? "append";
        let expectedPromptMode: PromptMode;
        let expectedReplacesDefaultHead: boolean;
        let expectedNoticeCount: number;

        if (ctx === "switch") {
          expectedPromptMode = "append";
          expectedReplacesDefaultHead = false;
          expectedNoticeCount = pm === "override" ? 1 : 0;
        } else {
          expectedPromptMode = pm ?? "append";
          expectedReplacesDefaultHead = expectedPromptMode === "override";
          expectedNoticeCount = 0;
        }

        const expectedOffLimitToolNames = ["grep"];
        const expectedRequestToolNames = expectedToolsMode === "override" ? ["read"] : ["read", "grep"];
        const expectedHasOffLimitsPromptPart = expectedToolsMode === "append";
        const expectedTools = [
          { name: "read", disposition: "resident" as const, inRequest: true },
          { name: "grep", disposition: "off" as const, inRequest: expectedToolsMode !== "override" },
        ];

        cases.push({
          ...(pm !== undefined ? { prompt_mode: pm } : {}),
          ...(tm !== undefined ? { tools_mode: tm } : {}),
          context: ctx,
          promptMode: expectedPromptMode,
          toolsMode: expectedToolsMode,
          replacesDefaultHead: expectedReplacesDefaultHead,
          noticeCount: expectedNoticeCount,
          requestToolNames: expectedRequestToolNames,
          offLimitToolNames: expectedOffLimitToolNames,
          hasOffLimitsPromptPart: expectedHasOffLimitsPromptPart,
          tools: expectedTools,
          ...getModelCase(ctx, ctx === "subagent" ? subagentIndex++ : nonSubagentIndex++),
        });
      }
    }
  }

  it("drives every combination of prompt_mode, tools_mode and context from a single cases array (27 cases)", () => {
    assert.equal(cases.length, 27);
    for (const tc of cases) {
      const input: ApplySpecialistInput = {
        name: "test-specialist",
        specialist: {
          ...(tc.prompt_mode !== undefined ? { prompt_mode: tc.prompt_mode } : {}),
          ...(tc.tools_mode !== undefined ? { tools_mode: tc.tools_mode } : {}),
          ...(tc.specialistProvider !== undefined ? { provider: tc.specialistProvider } : {}),
          ...(tc.specialistModel !== undefined ? { model: tc.specialistModel } : {}),
        },
        context: tc.context,
        defaultToolNames: ["read", "grep"],
        specialistToolNames: ["read"],
        ...(tc.callerModel !== undefined ? { callerModel: tc.callerModel } : {}),
        ...(tc.delegateModel !== undefined ? { delegateModel: tc.delegateModel } : {}),
        ...(tc.parentModel !== undefined ? { parentModel: tc.parentModel } : {}),
      };

      const result = applySpecialist(input);

      assert.equal(
        result.promptMode,
        tc.promptMode,
        `promptMode mismatch for ${JSON.stringify(tc)}`
      );
      assert.equal(
        result.toolsMode,
        tc.toolsMode,
        `toolsMode mismatch for ${JSON.stringify(tc)}`
      );
      assert.equal(
        result.replacesDefaultHead,
        tc.replacesDefaultHead,
        `replacesDefaultHead mismatch for ${JSON.stringify(tc)}`
      );
      assert.equal(
        result.notices.length,
        tc.noticeCount,
        `noticeCount mismatch for ${JSON.stringify(tc)}`
      );
      assert.deepEqual(
        result.requestToolNames,
        tc.requestToolNames,
        `requestToolNames mismatch for ${JSON.stringify(tc)}`
      );
      assert.deepEqual(
        result.offLimitToolNames,
        tc.offLimitToolNames,
        `offLimitToolNames mismatch for ${JSON.stringify(tc)}`
      );
      assert.equal(
        Boolean(result.offLimitsPromptPart),
        tc.hasOffLimitsPromptPart,
        `hasOffLimitsPromptPart mismatch for ${JSON.stringify(tc)}`
      );
      assert.deepEqual(
        result.tools,
        tc.tools,
        `tools mismatch for ${JSON.stringify(tc)}`
      );
      assert.equal(
        result.model,
        tc.expectedModel,
        `model mismatch for ${JSON.stringify(tc)}`
      );
      assert.equal(
        result.modelSource,
        tc.expectedModelSource,
        `modelSource mismatch for ${JSON.stringify(tc)}`
      );
    }
  });

  it("is a pure function (identical output, no input mutation)", () => {
    const defaultTools = ["read", "grep", "write"];
    const specialistTools = ["read", "grep"];
    const input: ApplySpecialistInput = {
      name: "pure-test",
      specialist: {
        instructions: "Follow instructions.",
        prompt_mode: "override",
        tools_mode: "append",
        provider: "anthropic",
        model: "claude-sonnet-5",
      },
      context: "session-start",
      defaultToolNames: defaultTools,
      specialistToolNames: specialistTools,
    };

    const first = applySpecialist(input);
    const second = applySpecialist(input);

    assert.deepEqual(first, second);
    assert.deepEqual(defaultTools, ["read", "grep", "write"]);
    assert.deepEqual(specialistTools, ["read", "grep"]);
  });

  it("handles input with no specialist defined", () => {
    const res = applySpecialist({
      context: "session-start",
      defaultToolNames: ["read", "grep"],
    });
    assert.equal(res.promptMode, "append");
    assert.equal(res.toolsMode, "append");
    assert.equal(res.replacesDefaultHead, false);
    assert.deepEqual(res.requestToolNames, ["read", "grep"]);
    assert.deepEqual(res.offLimitToolNames, []);
    assert.equal(res.model, undefined);
    assert.deepEqual(res.notices, []);
  });

  it("maps specialistToolNames when provided, falling back to defaultToolNames", () => {
    const withSpecialistAppend = applySpecialist({
      context: "session-start",
      defaultToolNames: ["read", "grep", "write"],
      specialistToolNames: ["read"],
    });
    assert.deepEqual(withSpecialistAppend.requestToolNames, ["read", "grep", "write"]);
    assert.deepEqual(withSpecialistAppend.offLimitToolNames, ["grep", "write"]);
    assert.deepEqual(withSpecialistAppend.tools, [
      { name: "read", disposition: "resident", inRequest: true },
      { name: "grep", disposition: "off", inRequest: true },
      { name: "write", disposition: "off", inRequest: true },
    ]);
    assert.ok(withSpecialistAppend.offLimitsPromptPart !== undefined);

    const withSpecialistOverride = applySpecialist({
      context: "session-start",
      specialist: { tools_mode: "override" },
      defaultToolNames: ["read", "grep", "write"],
      specialistToolNames: ["read"],
    });
    assert.deepEqual(withSpecialistOverride.requestToolNames, ["read"]);
    assert.deepEqual(withSpecialistOverride.offLimitToolNames, ["grep", "write"]);
    assert.deepEqual(withSpecialistOverride.tools, [
      { name: "read", disposition: "resident", inRequest: true },
      { name: "grep", disposition: "off", inRequest: false },
      { name: "write", disposition: "off", inRequest: false },
    ]);
    assert.equal(withSpecialistOverride.offLimitsPromptPart, undefined);

    const withoutSpecialistTools = applySpecialist({
      context: "session-start",
      defaultToolNames: ["read", "grep", "write"],
    });
    assert.deepEqual(withoutSpecialistTools.requestToolNames, ["read", "grep", "write"]);
    assert.deepEqual(withoutSpecialistTools.tools, [
      { name: "read", disposition: "resident", inRequest: true },
      { name: "grep", disposition: "resident", inRequest: true },
      { name: "write", disposition: "resident", inRequest: true },
    ]);
    assert.deepEqual(withoutSpecialistTools.offLimitToolNames, []);
    assert.equal(withoutSpecialistTools.offLimitsPromptPart, undefined);
  });

  it("D6: produces no off-limits prompt part when nothing is disallowed", () => {
    const res = applySpecialist({
      context: "session-start",
      defaultToolNames: ["read", "grep"],
      specialistToolNames: ["read", "grep"],
    });
    assert.equal(res.offLimitsPromptPart, undefined);
    assert.deepEqual(res.offLimitToolNames, []);
  });

  it("resolves model to provider/model when both present, otherwise undefined", () => {
    const full = applySpecialist({
      context: "session-start",
      defaultToolNames: ["read"],
      specialist: {
        provider: "anthropic",
        model: "claude-sonnet-5",
      },
    });
    assert.equal(full.model, "anthropic/claude-sonnet-5");

    const partialProvider = applySpecialist({
      context: "session-start",
      defaultToolNames: ["read"],
      specialist: {
        provider: "anthropic",
      },
    });
    assert.equal(partialProvider.model, undefined);

    const partialModel = applySpecialist({
      context: "session-start",
      defaultToolNames: ["read"],
      specialist: {
        model: "claude-sonnet-5",
      },
    });
    assert.equal(partialModel.model, undefined);
  });

  it("resolves the delegate's model in one table: argument, then setting, then parent", () => {
    // The whole precedence order in one place, because three call sites with
    // their own copy of it is the failure this band's architecture exists to
    // prevent. `spawn.ts` composes nothing; it reads `app.model`.
    const withModel = { provider: "anthropic", model: "claude-sonnet-5" } as const;
    const SPECIALIST_MODEL = "anthropic/claude-sonnet-5";
    const PARENT = "deepseek/deepseek-v4-flash";

    const cases: Array<{
      why: string;
      specialist?: { provider?: string; model?: string };
      callerModel?: string;
      delegateModel?: string;
      model: string | undefined;
      source: string | undefined;
    }> = [
      {
        why: "an explicit argument wins over the configured default",
        specialist: withModel,
        callerModel: "openai/gpt-5-preview",
        delegateModel: "parent",
        model: "openai/gpt-5-preview",
        source: "caller_override",
      },
      {
        why: "setting `specialist` uses the specialist's declared model",
        specialist: withModel,
        delegateModel: "specialist",
        model: SPECIALIST_MODEL,
        source: "specialist",
      },
      {
        why: "setting `parent` uses the spawning session's model",
        specialist: withModel,
        delegateModel: "parent",
        model: PARENT,
        source: "config_default",
      },
      {
        why: "a named model id wins over the specialist's own",
        specialist: withModel,
        delegateModel: "groq/llama-4-scout",
        model: "groq/llama-4-scout",
        source: "config_default",
      },
      {
        why: "a specialist declaring no model inherits the parent's rather than erroring",
        delegateModel: "specialist",
        model: PARENT,
        source: "config_default",
      },
      {
        why: "the shipped default is `specialist`, so an unset setting behaves as one",
        specialist: withModel,
        model: SPECIALIST_MODEL,
        source: "specialist",
      },
    ];

    for (const c of cases) {
      const app = applySpecialist({
        context: "subagent",
        defaultToolNames: ["read"],
        parentModel: PARENT,
        ...(c.specialist !== undefined ? { specialist: c.specialist } : {}),
        ...(c.callerModel !== undefined ? { callerModel: c.callerModel } : {}),
        ...(c.delegateModel !== undefined ? { delegateModel: c.delegateModel } : {}),
      });
      assert.equal(app.model, c.model, c.why);
      assert.equal(app.modelSource, c.source, `${c.why} (source)`);
    }
  });

  it("the delegate's model order applies only to a delegate", () => {
    // Changing a child's model is free — a fresh request has no prefix to
    // protect. Changing a running session's is not, and a switch must never do
    // it silently, so neither `callerModel` nor the configured default may leak
    // into the other two contexts.
    for (const context of ["session-start", "switch"] as const) {
      const app = applySpecialist({
        context,
        defaultToolNames: ["read"],
        parentModel: "deepseek/deepseek-v4-flash",
        callerModel: "openai/gpt-5-preview",
        delegateModel: "groq/llama-4-scout",
        specialist: { provider: "anthropic", model: "claude-sonnet-5" },
      });
      assert.equal(app.model, "anthropic/claude-sonnet-5", `${context} reports the specialist's own model`);
    }
  });

  it("emits expected notice under switch context when prompt_mode is override", () => {
    const res = applySpecialist({
      name: "reviewer",
      context: "switch",
      defaultToolNames: ["read"],
      specialist: {
        prompt_mode: "override",
      },
    });
    assert.equal(res.promptMode, "append");
    assert.equal(res.replacesDefaultHead, false);
    assert.equal(res.notices.length, 1);
    assert.equal(
      res.notices[0],
      'specialist "reviewer" declares prompt_mode: override \u2014 the override is NOT active in this session; the head is frozen at boot. Use \x2fclear to adopt it wholly.'
    );
  });

  it("D1: tools_remove moves a tool to mounted for both append and override modes", () => {
    for (const tools_mode of ["append", "override"] as const) {
      const res = applySpecialist({
        context: "session-start",
        defaultToolNames: ["read", "write", "bash"],
        specialist: {
          tools_mode,
          tools_remove: ["bash"],
        },
      });
      assert.deepEqual(
        res.requestToolNames,
        tools_mode === "override" ? ["read", "write"] : ["read", "write", "bash"],
      );
      assert.deepEqual(res.offLimitToolNames, ["bash"]);
      assert.equal(res.offLimitsPromptPart !== undefined, tools_mode === "append");
      assert.equal(res.tools.find((t) => t.name === "bash")?.disposition, "mounted");
      assert.equal(res.tools.find((t) => t.name === "bash")?.inRequest, tools_mode !== "override");
      assert.equal(res.tools.find((t) => t.name === "read")?.disposition, "resident");
      assert.equal(res.tools.find((t) => t.name === "read")?.inRequest, true);
      assert.ok(res.notices.some((n) => n.includes("genuinely removes capability")));
    }
  });

  it("D1: tools_add moves a mounted tool to resident for both append and override modes", () => {
    for (const tools_mode of ["append", "override"] as const) {
      const res = applySpecialist({
        context: "session-start",
        defaultToolNames: ["read", "write"],
        specialist: {
          tools_mode,
          tools_add: ["agent"],
        },
      });
      assert.deepEqual(res.requestToolNames, ["read", "write", "agent"]);
      assert.deepEqual(res.offLimitToolNames, []);
      assert.equal(res.tools.find((t) => t.name === "agent")?.disposition, "resident");
      assert.equal(res.tools.find((t) => t.name === "agent")?.inRequest, true);
    }
  });

  it("D3: tools_add cannot resurrect an off tool", () => {
    const res = applySpecialist({
      context: "session-start",
      defaultToolNames: ["read", "write"],
      specialist: {
        tools_add: ["subagent_workflow"],
      },
    });
    assert.deepEqual(res.requestToolNames, ["read", "write"]);
    assert.equal(res.tools.find((t) => t.name === "subagent_workflow"), undefined);
  });
});
