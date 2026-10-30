import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ASK_DEFAULT_RULE,
  buildAskTool,
  newAskState,
  parseAskAnswer,
  renderAskPrompt,
  TerminalAsk,
  type AskRequest,
} from "./ask.js";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { measureToolset } from "../ledger/tool-schema.js";

const here = dirname(fileURLToPath(import.meta.url));

const req = (over: Partial<AskRequest> = {}): AskRequest => ({
  question: "Which store should the queue use?",
  assumption: "SQLite, like the ledger",
  options: ["SQLite", "a JSON file"],
  ...over,
});

const call = async (tool: ReturnType<typeof buildAskTool>, params: unknown) =>
  (await (tool as unknown as {
    execute: (id: string, p: unknown) => Promise<{ content: Array<{ text: string }>; details?: Record<string, unknown> }>;
  }).execute("call-1", params));

describe("parseAskAnswer", () => {
  it("selects an option by number, the cheapest thing to type", () => {
    assert.equal(parseAskAnswer("2", req()), "a JSON file");
  });

  it("takes free text verbatim, because the human's own phrasing is worth more", () => {
    assert.equal(parseAskAnswer("neither — use the ledger table", req()), "neither — use the ledger table");
  });

  it("treats an out-of-range number as free text rather than guessing", () => {
    assert.equal(parseAskAnswer("9", req()), "9");
  });

  it("treats an empty line as accepting the assumption, which is not the same as no answer", () => {
    assert.equal(parseAskAnswer("   ", req()), "SQLite, like the ledger");
  });

  it("returns null only when there was genuinely no answer", () => {
    assert.equal(parseAskAnswer(null, req()), null);
  });
});

describe("renderAskPrompt", () => {
  it("numbers the options and says what an empty answer accepts", () => {
    const text = renderAskPrompt(req());
    assert.match(text, /1\. SQLite/);
    assert.match(text, /2\. a JSON file/);
    assert.match(text, /Empty accepts: SQLite, like the ledger/);
  });

  it("handles a free-text question with no options", () => {
    const text = renderAskPrompt(req({ options: [] }));
    assert.ok(!text.includes("1."));
    assert.match(text, /Empty accepts:/);
  });
});

describe("the ask tool", () => {
  it("returns the human's answer and counts it", async () => {
    const state = newAskState();
    const tool = buildAskTool({ state, askHuman: async () => "2" });
    const result = await call(tool, { question: "which?", assumption: "SQLite", options: ["SQLite", "JSON"] });
    assert.equal(result.content[0]!.text, "JSON");
    assert.deepEqual(state, { asked: 1, answered: 1, unanswered: 0 });
  });

  it("never blocks a session with nobody watching — it returns an instruction", async () => {
    const state = newAskState();
    const tool = buildAskTool({ state, askHuman: async () => null });
    const result = await call(tool, { question: "which?", assumption: "SQLite" });
    assert.match(result.content[0]!.text, /Proceed on your stated assumption/);
    assert.match(result.content[0]!.text, /Your assumption: SQLite/);
    assert.equal(result.details?.answered, false);
    assert.deepEqual(state, { asked: 1, answered: 0, unanswered: 1 });
  });

  it("treats a broken channel as an absent human rather than failing the turn", async () => {
    const state = newAskState();
    const tool = buildAskTool({
      state,
      askHuman: async () => {
        throw new Error("readline closed");
      },
    });
    const result = await call(tool, { question: "which?", assumption: "SQLite" });
    assert.match(result.content[0]!.text, new RegExp(ASK_DEFAULT_RULE.slice(0, 30)));
    assert.equal(state.unanswered, 1);
  });

  it("records the question and answer for the transcript, but only when answered", async () => {
    const recorded: Array<[string, string]> = [];
    const answered = buildAskTool({
      state: newAskState(),
      askHuman: async () => "SQLite",
      record: (q, a) => void recorded.push([q, a]),
    });
    await call(answered, { question: "which?", assumption: "JSON" });
    const unanswered = buildAskTool({
      state: newAskState(),
      askHuman: async () => null,
      record: (q, a) => void recorded.push([q, a]),
    });
    await call(unanswered, { question: "which?", assumption: "JSON" });
    assert.deepEqual(recorded, [["which?", "SQLite"]]);
  });

  it("requires an assumption in its schema — that is what makes asking safe", () => {
    const tool = buildAskTool({ state: newAskState(), askHuman: async () => null }) as unknown as {
      parameters: { required?: string[] };
    };
    // typebox marks non-Optional properties required; `options` is the only
    // optional one.
    const required = tool.parameters.required ?? [];
    assert.ok(required.includes("assumption"), `required was ${JSON.stringify(required)}`);
    assert.ok(required.includes("question"));
    assert.ok(!required.includes("options"));
  });
});

describe("TerminalAsk", () => {
  it("serializes concurrent questions so one typed line cannot answer two", async () => {
    const answers = ["first answer", "second answer"];
    let waiting = 0;
    let maxWaiting = 0;
    const gate = new TerminalAsk(
      async () => {
        waiting += 1;
        maxWaiting = Math.max(maxWaiting, waiting);
        await new Promise((r) => setTimeout(r, 5));
        waiting -= 1;
        return answers.shift() ?? null;
      },
      { write: () => undefined },
    );
    const [a, b] = await Promise.all([gate.ask(req()), gate.ask(req())]);
    assert.equal(maxWaiting, 1, "only one read may be outstanding at a time");
    assert.equal(a, "first answer");
    assert.equal(b, "second answer");
  });

  it("hands the question to the UI when one is wired, instead of writing it itself", async () => {
    const seen: AskRequest[] = [];
    let written = "";
    const gate = new TerminalAsk(
      async () => "ok",
      { write: (c: string) => void (written += c) },
      (r) => void seen.push(r),
    );
    await gate.ask(req());
    assert.equal(seen.length, 1);
    assert.equal(written, "", "the UI renders it; the gate must not also print it");
  });
});

describe("the schema tax, recorded at the moment the tool is added (rule 3)", () => {
  it("prices ask rather than making the toolset NULL", () => {
    const withAsk = measureToolset(["read", "bash", "edit", "write", "ask"]);
    assert.equal(withAsk.complete, true);
    const without = measureToolset(["read", "bash", "edit", "write"]);
    const delta = (withAsk.tokens ?? 0) - (without.tokens ?? 0);
    assert.ok(delta > 0, "the tool has to cost something");
    // §2.10 calls it "one small schema". Measured: 165 tokens on the
    // pi_estimateTokens_chars/4 basis, against 711 for Pi's own four
    // built-ins and 7453 for the single SubagentWorkflow description T20
    // dropped. The bound is deliberately close to the measured value so that
    // growing this description is a decision somebody has to make rather
    // than something that happens.
    assert.ok(delta < 200, `ask cost ${delta} tokens, which is past its recorded budget`);
  });

  it("keeps the catalog's wire description identical to the tool's own", () => {
    const tool = buildAskTool({ state: newAskState(), askHuman: async () => null }) as unknown as {
      description: string;
    };
    // The catalog spells the em-dashes as hyphens (it is a wire snapshot of
    // ASCII JSON), so compare the shape rather than byte-for-byte.
    assert.equal(TOOL_CATALOG.ask!.description.replace(/-/g, "—"), tool.description.replace(/-/g, "—"));
  });
});

// ---------------------------------------------------------------------------
// P10.6 (ticket 20, D8): what the contract review closed, and
// what it deliberately did NOT build.
// ---------------------------------------------------------------------------

describe("P10.6 D8: the ask contract", () => {
  it("refuses an empty question and an empty assumption without asking anybody", async () => {
    for (const [params, reason] of [
      [{ question: "   ", assumption: "SQLite" }, "empty_question"],
      [{ question: "which?", assumption: "  " }, "empty_assumption"],
    ] as Array<[Record<string, unknown>, string]>) {
      const state = newAskState();
      let asked = 0;
      const tool = buildAskTool({
        state,
        askHuman: async () => {
          asked += 1;
          return "yes";
        },
      });
      const result = await call(tool, params);
      assert.equal((result as { isError?: boolean }).isError, true, reason);
      assert.equal(result.details?.reason, reason);
      assert.equal(asked, 0, "nobody was asked, so nothing could have been answered");
      assert.deepEqual(state, { asked: 0, answered: 0, unanswered: 0 });
    }
  });

  it("says where the answer came from, so an accepted assumption is not read as a choice", async () => {
    const picked = await call(
      buildAskTool({ state: newAskState(), askHuman: async () => "2" }),
      { question: "which?", assumption: "SQLite", options: ["SQLite", "JSON"] },
    );
    assert.equal(picked.details?.source, "option");
    assert.equal(picked.details?.option, 2);
    assert.equal(picked.details?.answer, "JSON");

    const typed = await call(
      buildAskTool({ state: newAskState(), askHuman: async () => "neither, use the ledger" }),
      { question: "which?", assumption: "SQLite", options: ["SQLite", "JSON"] },
    );
    assert.equal(typed.details?.source, "free_text");

    // The human SAW the question and pressed enter. That is not the same
    // event as nobody being there, and the details now say which it was.
    const accepted = await call(
      buildAskTool({ state: newAskState(), askHuman: async () => "" }),
      { question: "which?", assumption: "SQLite" },
    );
    assert.equal(accepted.details?.source, "assumption");
    assert.equal(accepted.details?.answered, true);

    const nobody = await call(
      buildAskTool({ state: newAskState(), askHuman: async () => null }),
      { question: "which?", assumption: "SQLite" },
    );
    assert.equal(nobody.details?.source, "none");
    assert.equal(nobody.details?.answered, false);
    assert.equal(nobody.details?.asked, true);
  });

  it("carries the question and the options back in the details", async () => {
    const result = await call(
      buildAskTool({ state: newAskState(), askHuman: async () => "1" }),
      { question: "which store?", assumption: "SQLite", options: ["SQLite", " ", "JSON"] },
    );
    assert.equal(result.details?.question, "which store?");
    // An empty option is dropped rather than offered as a blank line.
    assert.deepEqual(result.details?.options, ["SQLite", "JSON"]);
    assert.equal(result.details?.assumption, "SQLite");
  });

  // The other half of D8: the rich rendering is P5 and must not appear here.
  it("builds none of P5's rich rendering — the schema is still the same three fields", () => {
    const tool = buildAskTool({ state: newAskState(), askHuman: async () => null });
    const params = tool.parameters as unknown as { required?: string[]; properties: Record<string, unknown> };
    assert.deepEqual(Object.keys(params.properties), ["question", "assumption", "options"]);
    assert.deepEqual(params.required, ["question", "assumption"]);
    // `options` is an array of bare strings, not of {label, description, preview}.
    assert.deepEqual((params.properties.options as { items: unknown }).items, { type: "string" });

    // Asserted against the wire schema and the model-facing description
    // rather than against the file, because the file legitimately NAMES these
    // features in the comment that records why they are not built here.
    const onTheWire = `${JSON.stringify(tool.parameters)}\n${(tool as unknown as { description: string }).description}`;
    for (const p5 of ["questions", "recommended", "preview", "multi", "timedOut", "timeout", "header"]) {
      assert.equal(onTheWire.includes(p5), false, `${p5} is P5 rendering and must not be on ask's wire shape yet`);
    }
    assert.ok(readFileSync(join(here, "ask.ts"), "utf8").includes("CONTRACT ONLY"), "the comparison section is recorded");
  });

  it("did not move the wire shape, so the catalog row and the tax are unchanged", () => {
    const tool = buildAskTool({ state: newAskState(), askHuman: async () => null }) as unknown as {
      description: string;
    };
    // The catalog row spells two dashes as hyphens; the assertion is on the
    // rest, which is what would move if a parameter had been added.
    assert.equal(TOOL_CATALOG.ask!.description.replace(/-/g, "—"), tool.description.replace(/-/g, "—"));
    const priced = measureToolset(["read", "bash", "edit", "write", "ask"]);
    assert.equal(priced.complete, true);
  });
});
