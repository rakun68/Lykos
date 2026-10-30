import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { commandSpan } from "./composer.js";
import { setSkillCommands } from "../commands.js";
import { renderComposer } from "./composer.js";
import { LineEditor } from "../editor.js";
import { resolveTheme } from "../theme/resolve.js";

beforeEach(() => setSkillCommands([]));

describe("commandSpan", () => {
  it("finds nothing in ordinary prose", () => {
    assert.equal(commandSpan("what does this repo do?"), null);
    assert.equal(commandSpan(""), null);
  });

  it("does not fire on a slash that is not at the start", () => {
    assert.equal(commandSpan(" /help"), null, "a leading space means it is prose");
    assert.equal(commandSpan("see src/help.ts"), null);
  });

  it("does not fire on a bare slash, before anything is typed", () => {
    assert.equal(commandSpan("/"), null);
  });

  it("marks a free built-in with the local token", () => {
    assert.deepEqual(commandSpan("/help"), { start: 0, end: 5, token: "local" });
  });

  it("marks a command that spends money with the costed token", () => {
    assert.deepEqual(commandSpan("/compact"), { start: 0, end: 8, token: "costed" });
  });

  it("marks a refused command with the danger token", () => {
    // Ticket 04: `/specialist` is no longer refused (it lists/switches); `/new`
    // still is — a head rewrite the interface refuses outright.
    assert.equal(commandSpan("/new")?.token, "danger");
  });

  it("marks a local command like /specialist with the local token", () => {
    assert.equal(commandSpan("/specialist budget")?.token, "local");
  });

  it("covers only the command word, not its arguments", () => {
    assert.deepEqual(commandSpan("/effort max"), { start: 0, end: 7, token: "local" });
  });

  it("warns on a command nobody owns, so a typo is visible before Enter", () => {
    assert.deepEqual(commandSpan("/hlep"), { start: 0, end: 5, token: "warn" });
    assert.equal(commandSpan("/nonsense arg")?.token, "warn");
  });

  it("recognises a skill command once one is registered", () => {
    assert.equal(commandSpan("/handoff")?.token, "warn", "unknown until registered");
    setSkillCommands([{ name: "handoff", description: "d" }]);
    assert.deepEqual(commandSpan("/handoff"), { start: 0, end: 8, token: "costed" });
  });

  it("is case-insensitive, matching the parser", () => {
    assert.equal(commandSpan("/HELP")?.token, "local");
  });
});

describe("renderComposer with a command on the first line", () => {
  const theme = resolveTheme("rose-pine", "truecolor", "unicode");

  function render(text: string): string {
    const editor = new LineEditor();
    editor.insertText(text);
    return renderComposer(editor.state, theme, 60).lines.join("\n");
  }

  it("emits a different escape for a command than for prose", () => {
    const command = render("/help");
    const prose = render("xhelp");
    assert.notEqual(command, prose, "a command must not render identically to text");
    assert.ok(command.includes("\x1b["), "the command carries an SGR sequence");
  });

  it("emits a different escape for a costed command than a local one", () => {
    assert.notEqual(render("/help"), render("/compact").replace("compact", "help   ").trimEnd());
  });

  it("still renders the command text verbatim", () => {
    // Whatever styling is applied, the characters the user typed survive.
    const stripped = render("/compact now").replace(/\x1b\[[0-9;]*m/g, "");
    assert.ok(stripped.includes("/compact now"));
  });

  it("adds no escapes at all under the none capability", () => {
    const mono = resolveTheme("rose-pine", "none", "ascii");
    const editor = new LineEditor();
    editor.insertText("/compact");
    const out = renderComposer(editor.state, mono, 60).lines.join("\n");
    assert.equal(out.includes("\x1b["), false, "NO_COLOR keeps the composer escape-free");
  });
});
