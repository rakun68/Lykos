import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from "../gate/approval.js";
import { discoverSkills, lykosSkillsDir } from "../session/skills.js";
import {
  MANAGE_SKILL_ACTIONS,
  MANAGE_SKILL_DESCRIPTION,
  MANAGE_SKILL_PARAMETERS,
  MANAGE_SKILL_TOOL_NAME,
  SKILL_DESCRIPTION,
  SKILL_MAX_BYTES,
  SKILL_PARAMETERS,
  SKILL_TOOL_NAME,
  SKILL_TOOL_NAMES,
  buildManageSkillTool,
  buildSkillTool,
  buildSkillTools,
  escapesSkillsRoot,
  normalizeSkillName,
  renderSkillFile,
  sanitizeSkillDescription,
  skillFilePath,
  stripFrontmatter,
} from "./skill-tools.js";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { measureToolset } from "../ledger/tool-schema.js";
import { riskForTool, tierForTool } from "./tool-risk.js";
import { DEFAULT_RESIDENT_TOOLS, MOUNTED_TOOLS, RUNTIME_AVAILABLE_TOOLS, TOOL_REGISTRY } from "./tool-surface.js";

async function call(
  tool: { execute: (...args: never[]) => unknown },
  args: Record<string, unknown>,
): Promise<{ text: string; details: Record<string, unknown>; isError: boolean }> {
  const result = (await (tool.execute as unknown as (
    id: string,
    params: unknown,
  ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown>; isError?: boolean }>)(
    "call-1",
    args,
  )) as { content: Array<{ text: string }>; details: Record<string, unknown>; isError?: boolean };
  return {
    text: result.content.map((c) => c.text).join("\n"),
    details: result.details,
    isError: result.isError === true,
  };
}

/** Records what the human was shown, so "the approval body is the whole file" is an assertion rather than a claim. */
class RecordingGate implements ApprovalGate {
  readonly seen: ApprovalRequest[] = [];
  constructor(private readonly answer: ApprovalDecision = "allow") {}
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.seen.push(req);
    return this.answer;
  }
}

function workspace(): { cwd: string; cleanup: () => void } {
  const cwd = mkdtempSync(join(tmpdir(), "lykos-skills-"));
  mkdirSync(lykosSkillsDir(cwd), { recursive: true });
  return { cwd, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

describe("P10.6 D4: manage_skill writes into .lykos/skills and nowhere else", () => {
  it("creates a skill Pi's own loader then discovers, under the one location", async () => {
    const { cwd, cleanup } = workspace();
    try {
      const gate = new RecordingGate();
      const tool = buildManageSkillTool({ cwd, gate });
      const result = await call(tool, {
        action: "create",
        name: "Release-Checklist ",
        description: "Use before tagging a release.",
        body: "1. Run the suite.\n2. Update the changelog.",
      });

      assert.equal(result.isError, false);
      assert.equal(result.details.name, "release-checklist");
      const path = skillFilePath(cwd, "release-checklist");
      assert.equal(result.details.path, path);
      assert.equal(existsSync(path), true);
      assert.equal(path.startsWith(lykosSkillsDir(cwd)), true, "there is one skills location and this is it");

      // Pi's loader, not a second derivation: the roster is what the prompt
      // would be built from.
      const discovered = discoverSkills(cwd);
      assert.deepEqual(
        discovered.map((s) => s.name),
        ["release-checklist"],
      );
      assert.equal(discovered[0]!.description, "Use before tagging a release.");

      // The human saw the whole file.
      assert.equal(gate.seen.length, 1);
      assert.equal(gate.seen[0]!.kind, "write");
      assert.equal(gate.seen[0]!.body, readFileSync(path, "utf8"));
    } finally {
      cleanup();
    }
  });

  it("generates the frontmatter and never takes it from the body", async () => {
    const { cwd, cleanup } = workspace();
    try {
      const tool = buildManageSkillTool({ cwd, gate: new RecordingGate() });
      await call(tool, {
        action: "create",
        name: "sneaky",
        description: "The real one.",
        body: "---\nname: not-sneaky\ndescription: injected\n---\n\nthe procedure",
      });
      const content = readFileSync(skillFilePath(cwd, "sneaky"), "utf8");
      assert.equal(content.startsWith("---\nname: sneaky\ndescription: The real one.\n---\n"), true);
      assert.deepEqual(
        discoverSkills(cwd).map((s) => [s.name, s.description]),
        [["sneaky", "The real one."]],
      );
    } finally {
      cleanup();
    }
  });

  it("create refuses to write over an existing skill and update refuses to invent one", async () => {
    const { cwd, cleanup } = workspace();
    try {
      const tool = buildManageSkillTool({ cwd, gate: new RecordingGate() });
      await call(tool, { action: "create", name: "one", description: "d", body: "b" });
      const before = readFileSync(skillFilePath(cwd, "one"), "utf8");

      const again = await call(tool, { action: "create", name: "one", description: "d2", body: "b2" });
      assert.equal(again.isError, true);
      assert.equal(again.details.error, "exists");
      assert.equal(readFileSync(skillFilePath(cwd, "one"), "utf8"), before);

      const missing = await call(tool, { action: "update", name: "two", description: "d", body: "b" });
      assert.equal(missing.isError, true);
      assert.equal(missing.details.error, "not_found");
      assert.ok(missing.text.includes("one"), "the refusal names what exists");
      assert.equal(existsSync(skillFilePath(cwd, "two")), false);
    } finally {
      cleanup();
    }
  });

  it("updates in place and deletes the whole skill directory, with the human shown what goes", async () => {
    const { cwd, cleanup } = workspace();
    try {
      const gate = new RecordingGate();
      const tool = buildManageSkillTool({ cwd, gate });
      await call(tool, { action: "create", name: "one", description: "d", body: "first" });
      await call(tool, { action: "update", name: "one", description: "d", body: "second" });
      assert.ok(readFileSync(skillFilePath(cwd, "one"), "utf8").includes("second"));

      const deleted = await call(tool, { action: "delete", name: "one" });
      assert.equal(deleted.isError, false);
      assert.equal(deleted.details.deleted, true);
      assert.equal(existsSync(skillFilePath(cwd, "one")), false);
      assert.equal(existsSync(join(lykosSkillsDir(cwd), "one")), false);
      assert.deepEqual(discoverSkills(cwd), []);

      const deleteRequest = gate.seen.at(-1)!;
      assert.equal(deleteRequest.kind, "edit");
      assert.ok(deleteRequest.body!.includes("second"), "the human sees what is being removed");
    } finally {
      cleanup();
    }
  });

  it("a declined approval writes nothing and deletes nothing", async () => {
    const { cwd, cleanup } = workspace();
    try {
      const deny = new RecordingGate("deny");
      const tool = buildManageSkillTool({ cwd, gate: deny });
      const created = await call(tool, { action: "create", name: "one", description: "d", body: "b" });
      assert.equal(created.isError, true);
      assert.equal(existsSync(skillFilePath(cwd, "one")), false);

      // And a delete that is declined leaves the skill in place.
      const allow = buildManageSkillTool({ cwd, gate: new RecordingGate() });
      await call(allow, { action: "create", name: "one", description: "d", body: "b" });
      const refused = await call(tool, { action: "delete", name: "one" });
      assert.equal(refused.isError, true);
      assert.equal(existsSync(skillFilePath(cwd, "one")), true);
    } finally {
      cleanup();
    }
  });

  it("refuses a bad action, a bad name, an empty description, an empty body and an oversized file", async () => {
    const { cwd, cleanup } = workspace();
    try {
      const gate = new RecordingGate();
      const tool = buildManageSkillTool({ cwd, gate });
      const cases: Array<[Record<string, unknown>, string]> = [
        [{ action: "rename", name: "one", description: "d", body: "b" }, "unknown_action"],
        [{ action: "create", name: "Not A Name", description: "d", body: "b" }, "bad_name"],
        [{ action: "create", name: "../escape", description: "d", body: "b" }, "bad_name"],
        [{ action: "create", name: "one", description: "   ", body: "b" }, "empty_description"],
        [{ action: "create", name: "one", description: "d", body: "   " }, "empty_body"],
        [{ action: "create", name: "one", description: "d", body: "x".repeat(SKILL_MAX_BYTES) }, "too_large"],
      ];
      for (const [args, error] of cases) {
        const result = await call(tool, args);
        assert.equal(result.isError, true, JSON.stringify(args));
        assert.equal(result.details.error, error, JSON.stringify(args));
      }
      assert.equal(gate.seen.length, 0, "nothing reached the gate, so nothing could have been written");
      assert.deepEqual(discoverSkills(cwd), []);
    } finally {
      cleanup();
    }
  });
});

describe("P10.6 D4: skill invokes by name, and the old path still works", () => {
  it("returns the procedure, and a read of the same file returns the same bytes", async () => {
    const { cwd, cleanup } = workspace();
    try {
      const manage = buildManageSkillTool({ cwd, gate: new RecordingGate() });
      const skill = buildSkillTool({ cwd, gate: new RecordingGate() });
      await call(manage, {
        action: "create",
        name: "release-checklist",
        description: "Use before tagging a release.",
        body: "1. Run the suite.\n2. Update the changelog.",
      });

      const invoked = await call(skill, { name: "release-checklist" });
      assert.equal(invoked.isError, false);
      assert.ok(invoked.text.includes("1. Run the suite."));
      assert.ok(invoked.text.includes("2. Update the changelog."));

      // THE OLD PATH (D4). The prompt prints `<location>` and tells the model
      // to read it; that file is still there and still holds the procedure.
      const loaded = discoverSkills(cwd)[0]!;
      const viaRead = readFileSync(loaded.filePath, "utf8");
      assert.equal(loaded.filePath, invoked.details.path);
      assert.equal(stripFrontmatter(viaRead), viaRead.slice(viaRead.indexOf("1. Run the suite.")));
      assert.ok(viaRead.includes("1. Run the suite."), "reading the file still resolves the same procedure");
      assert.ok(invoked.text.includes(stripFrontmatter(viaRead).trim()));
    } finally {
      cleanup();
    }
  });

  it("matches a name case-insensitively but prefers an exact hit", async () => {
    const roster = [
      { name: "alpha", description: "a", filePath: "/nowhere/alpha.md" },
      { name: "Beta", description: "b", filePath: "/nowhere/beta.md" },
    ];
    const skill = buildSkillTool({ cwd: ".", gate: new RecordingGate(), discover: () => roster });
    const miss = await call(skill, { name: "BETA" });
    // The file does not exist, which is how we know WHICH roster row was
    // chosen without needing one on disk.
    assert.equal(miss.details.name, "Beta");
    assert.equal(miss.details.error, "unreadable");
  });

  it("names the roster when the skill is not in it, and says a missing one is missing everywhere", async () => {
    const skill = buildSkillTool({
      cwd: ".",
      gate: new RecordingGate(),
      discover: () => [{ name: "alpha", description: "a", filePath: "/nowhere/alpha.md" }],
    });
    const result = await call(skill, { name: "gamma" });
    assert.equal(result.isError, true);
    assert.equal(result.details.error, "not_found");
    assert.deepEqual(result.details.exists, ["alpha"]);

    const empty = await call(skill, { name: "   " });
    assert.equal(empty.details.error, "empty_name");
  });
});

describe("skill-tools helpers", () => {
  it("normalizes and validates a name the way the reference does", () => {
    assert.equal(normalizeSkillName("  Release-Checklist "), "release-checklist");
    assert.equal(escapesSkillsRoot(process.cwd(), "ordinary"), false);
  });

  it("sanitizes a description to one safe line", () => {
    assert.equal(sanitizeSkillDescription("  two\nlines with <angle> and `tick`  "), "two lines with angle and tick");
    assert.equal(sanitizeSkillDescription("a~~~b"), "a~b");
  });

  it("renders and strips frontmatter symmetrically", () => {
    const file = renderSkillFile("one", "does a thing", "  the body  ");
    assert.equal(file, "---\nname: one\ndescription: does a thing\n---\n\nthe body\n");
    assert.equal(stripFrontmatter(file), "the body\n");
    assert.equal(stripFrontmatter("no frontmatter here"), "no frontmatter here");
  });

  it("refuses a skill directory that is a link out of the root", () => {
    const { cwd, cleanup } = workspace();
    try {
      const outside = join(cwd, "outside");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "SKILL.md"), "---\nname: linked\ndescription: d\n---\n\nbody\n");
      let linked = false;
      try {
        // A junction, because a Windows symlink needs a privilege an ordinary
        // test run does not have. If even this is unavailable the check is
        // skipped rather than asserted against a directory that is not
        // actually a link — and the skip is reported, never silent.
        symlinkSync(outside, join(lykosSkillsDir(cwd), "linked"), "junction");
        linked = true;
      } catch {
        linked = false;
      }
      assert.equal(escapesSkillsRoot(cwd, "ordinary"), false);
      if (linked) assert.equal(escapesSkillsRoot(cwd, "linked"), true);
      else process.stderr.write("skill-tools.test.ts: this host would not create a junction; the escape check was not exercised\n");
    } finally {
      cleanup();
    }
  });

  it("builds the pair in the documented order", () => {
    const tools = buildSkillTools({ cwd: ".", gate: new RecordingGate(), discover: () => [] });
    assert.deepEqual(
      tools.map((t) => t.name),
      [...SKILL_TOOL_NAMES],
    );
    assert.deepEqual([...SKILL_TOOL_NAMES], [MANAGE_SKILL_TOOL_NAME, SKILL_TOOL_NAME]);
    assert.deepEqual([...MANAGE_SKILL_ACTIONS], ["create", "update", "delete"]);
  });
});

// ---------------------------------------------------------------------------
// D9: mounted, hidden, in the catalog, measured
// ---------------------------------------------------------------------------

describe("P10.6 D9: the registry, the catalog and the measured tax", () => {
  it("both are mounted, hidden and runtime-available, and neither is resident", () => {
    for (const name of SKILL_TOOL_NAMES) {
      const row = TOOL_REGISTRY.find((e) => e.name === name);
      assert.ok(row, `${name} has no registry row`);
      assert.equal(row.residency, "mounted", name);
      assert.equal(row.promptPresence, "hidden", name);
      assert.equal(RUNTIME_AVAILABLE_TOOLS.has(name), true, name);
      assert.equal(MOUNTED_TOOLS.includes(name), true, name);
      assert.equal(DEFAULT_RESIDENT_TOOLS.includes(name), false, name);
    }
  });

  // D4's correction, pinned. `skill` returns the text of a file inside the
  // project; the `read` tool does the same to the same file at the `read`
  // tier, and D4 keeps that route working — so a `hard-write` `skill` would
  // have been strictly harder to reach than the path it replaces.
  it("skill declares read and manage_skill declares soft-write", () => {
    assert.equal(tierForTool(SKILL_TOOL_NAME), "read");
    assert.deepEqual(riskForTool(SKILL_TOOL_NAME), { tier: "read", idempotent: true, openWorld: false });
    assert.equal(tierForTool(MANAGE_SKILL_TOOL_NAME), "soft-write");
    assert.deepEqual(riskForTool(MANAGE_SKILL_TOOL_NAME), { tier: "soft-write", idempotent: false, openWorld: false });
  });

  it("every catalog row equals its live definition, description and parameters both", () => {
    const rows: Array<[string, string, unknown]> = [
      [MANAGE_SKILL_TOOL_NAME, MANAGE_SKILL_DESCRIPTION, MANAGE_SKILL_PARAMETERS],
      [SKILL_TOOL_NAME, SKILL_DESCRIPTION, SKILL_PARAMETERS],
    ];
    for (const [name, description, parameters] of rows) {
      const row = TOOL_CATALOG[name];
      assert.ok(row, `${name} has no catalog row`);
      assert.equal(row.name, name);
      assert.equal(row.source, "lykos");
      assert.equal(row.description, description);
      assert.deepEqual(row.parameters, JSON.parse(JSON.stringify(parameters)));
    }
  });

  // Measured with `measureToolset` on SCHEMA_TOKENS_BASIS, 2026-09-21.
  it("costs 538 tokens if the pair ever goes resident, and 0 today", () => {
    const each: Record<string, [number, number]> = { manage_skill: [368, 1478], skill: [170, 681] };
    for (const [name, [tokens, bytes]] of Object.entries(each)) {
      const m = measureToolset([name]);
      assert.equal(m.complete, true, name);
      assert.equal(m.tokens, tokens, name);
      assert.equal(m.bytes, bytes, name);
    }
    const pair = measureToolset([...SKILL_TOOL_NAMES]);
    assert.equal(pair.tokens, 538);
    assert.equal(pair.bytes, 2158);
    // P10.7 (ticket 12): 1423 until this line was last touched, and 2062 now.
    // The resident total MOVED for the first time since P10.4, because
    // `web_search` (314 alone) and `web_fetch` (326 alone) were made RESIDENT
    // rather than mounted — 639 together, since array wrapping means the pair
    // is not the sum of the two. Nothing about this file's tool moved; this
    // line prices the surface it is being compared against.
    assert.equal(measureToolset(DEFAULT_RESIDENT_TOOLS).tokens, 2255);
  });

  it("registers both through loadTools, so tool_call can reach them", async () => {
    const { loadTools } = await import("./session-tools.js");
    const loaded = loadTools([], {
      cwd: process.cwd(),
      gate: { request: async () => "allow" } as never,
      modelProvider: "",
      modelId: "",
    });
    for (const name of SKILL_TOOL_NAMES) {
      assert.ok(loaded.customTools.some((t) => t.name === name), `${name} is not registered`);
      assert.equal(loaded.activeToolNames.includes(name), false, `${name} must stay off the wire`);
    }
    loaded.lsp.shutdownAll();
    await loaded.jobs.stopAll();
    await loaded.evalRuntimes.disposeAll();
  });
});
