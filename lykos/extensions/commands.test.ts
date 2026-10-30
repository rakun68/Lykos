// A registered slash command appears and runs.
//
// It lives beside the API rather than in `tui/commands.test.ts` because it is
// an assertion about the seam between the two: the host holds the handler, the
// command surface holds the name, and neither half on its own is the feature.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from "../gate/approval.js";
import {
  allCommands,
  isOwnedName,
  resolveExtensionCommandName,
  setExtensionCommands,
  setSkillCommands,
  slashCandidates,
} from "../tui/commands.js";
import { parseInteractiveInput } from "../tui/s0.js";
import { LykosExtensionHost } from "./api.js";

class NoGate implements ApprovalGate {
  async request(_req: ApprovalRequest): Promise<ApprovalDecision> {
    return "allow";
  }
}

beforeEach(() => {
  setSkillCommands([]);
  setExtensionCommands([]);
});

function hostWithCommands(): LykosExtensionHost {
  const host = new LykosExtensionHost({ cwd: process.cwd(), gate: new NoGate() });
  host.install({
    name: "acme",
    register: (api) => {
      api.registerCommand({ name: "acme", description: "do acme things", run: (args) => `acme ran with "${args}"` });
      // A name a built-in already owns. It is registered on the host — the
      // host is not the thing that resolves collisions — and the command
      // surface is where it loses.
      api.registerCommand({ name: "help", description: "acme's own help", run: () => "acme help" });
    },
  });
  return host;
}

describe("P10.9 D5 a registered slash command appears", () => {
  it("joins the one list completion and dispatch both read", () => {
    const host = hostWithCommands();
    setExtensionCommands(host.commands());
    const spec = allCommands().find((c) => c.name === "/acme");
    assert.ok(spec, "/acme is offered");
    assert.equal(spec?.source, "extension");
    assert.equal(spec?.extension, "acme");
    assert.equal(spec?.description, "do acme things");
    assert.ok(slashCandidates().some((c) => c.name === "/acme"));
    assert.equal(isOwnedName("acme"), true, "and is not posted to the model as prose");
  });

  it("a built-in still wins a bare name", () => {
    const host = hostWithCommands();
    setExtensionCommands(host.commands());
    assert.equal(resolveExtensionCommandName("help"), undefined);
    assert.equal(parseInteractiveInput("/help").kind, "help");
    // And the shadowed one is not offered under a name it cannot have.
    const helps = allCommands().filter((c) => c.name === "/help");
    assert.equal(helps.length, 1);
    assert.equal(helps[0]?.source, "builtin");
  });

  it("disappears when the roster is replaced, rather than lingering", () => {
    const host = hostWithCommands();
    setExtensionCommands(host.commands());
    assert.ok(allCommands().some((c) => c.name === "/acme"));
    setExtensionCommands([]);
    assert.ok(!allCommands().some((c) => c.name === "/acme"));
    assert.equal(parseInteractiveInput("/acme").kind, "prompt");
  });
});

describe("P10.9 D5 a registered slash command runs", () => {
  it("parses to an extension-command with its arguments and reaches the handler", async () => {
    const host = hostWithCommands();
    setExtensionCommands(host.commands());
    const parsed = parseInteractiveInput("/acme one two");
    assert.deepEqual(parsed, { kind: "extension-command", command: "acme", args: "one two" });
    assert.equal(parsed.kind, "extension-command");
    if (parsed.kind !== "extension-command") return;
    assert.equal(await host.runCommand(parsed.command, parsed.args), 'acme ran with "one two"');
  });

  it("carries no arguments as an empty string rather than as undefined", async () => {
    const host = hostWithCommands();
    setExtensionCommands(host.commands());
    const parsed = parseInteractiveInput("/acme");
    assert.deepEqual(parsed, { kind: "extension-command", command: "acme", args: "" });
    assert.equal(await host.runCommand("acme", ""), 'acme ran with ""');
  });
});
