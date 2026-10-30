import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PONYTAIL_REPLACE_MARKER } from "../session/ponytail-head.js";
import { TOOL_RISKS } from "../tools.js";
import { isInteractionMode } from "../gate/modes.js";
import { loadConfig } from "./load.js";
import {
  discoverSpecialists,
  globalSpecialistsDir,
  isReservedAsyncTool,
  resolveSpecialistToolWinners,
  resolveToolCollision,
  SPECIALIST_FIELD_NAMES,
  SpecialistNotFoundError,
  SpecialistValidationError,
  projectSpecialistsDir,
  resolveSpecialistLayer,
  shippedSpecialistsDir,
} from "./specialists.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "lykos-specialists-"));
}

function writeSpecialist(dir: string, name: string, yaml: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), yaml, "utf8");
}

/** Specialists ticket 05: writes a real skill under `<cwd>/.lykos/skills/`. */
function writeSkill(cwd: string, filename: string, frontmatter: string): void {
  mkdirSync(join(cwd, ".lykos", "skills"), { recursive: true });
  writeFileSync(join(cwd, ".lykos", "skills", filename), frontmatter, "utf8");
}

describe("resolveSpecialistLayer", () => {
  it("discovers and resolves a global-only specialist", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(globalSpecialistsDir(globalDir), "deliberate", "instructions: Weigh alternatives before committing.\n");

    const layer = resolveSpecialistLayer("deliberate", cwd, globalDir);
    assert.equal(layer.name, "specialist");
    assert.equal(layer.present, true);
    assert.equal(layer.value.instructions, "Weigh alternatives before committing.");
    assert.equal(layer.path, join(globalSpecialistsDir(globalDir), "deliberate.yaml"));
  });

  it("discovers and resolves a project-only specialist", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "minimal", "instructions: Do the smallest thing that works.\n");

    const layer = resolveSpecialistLayer("minimal", cwd, globalDir);
    assert.equal(layer.present, true);
    assert.equal(layer.value.instructions, "Do the smallest thing that works.");
    assert.equal(layer.path, join(projectSpecialistsDir(cwd), "minimal.yaml"));
  });

  it("a specialist defined in both locations resolves to the project's version", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(globalSpecialistsDir(globalDir), "review", "instructions: global version\n");
    writeSpecialist(projectSpecialistsDir(cwd), "review", "instructions: project version\n");

    const layer = resolveSpecialistLayer("review", cwd, globalDir);
    assert.equal(layer.value.instructions, "project version");
    assert.equal(layer.path, join(projectSpecialistsDir(cwd), "review.yaml"));
  });

  it("a specialist declaring only instructions carries nothing else — inheriting the rest is the caller's job", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "explore", "instructions: Search and read; touch nothing.\n");

    const layer = resolveSpecialistLayer("explore", cwd, globalDir);
    assert.deepEqual(Object.keys(layer.value), ["instructions"]);
  });

  it("throws SpecialistNotFoundError naming the specialists that DO exist", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(globalSpecialistsDir(globalDir), "minimal", "instructions: a\n");
    writeSpecialist(projectSpecialistsDir(cwd), "plan", "instructions: b\n");

    assert.throws(
      () => resolveSpecialistLayer("typo", cwd, globalDir),
      (err: unknown) => {
        assert.ok(err instanceof SpecialistNotFoundError);
        assert.match((err as Error).message, /typo/);
        assert.match((err as Error).message, /minimal/);
        assert.match((err as Error).message, /plan/);
        return true;
      },
    );
  });

  it("throws SpecialistNotFoundError with an honest empty list when nothing is discoverable", () => {
    const cwd = tmp();
    const globalDir = tmp();
    // Ticket 07: isolate the shipped library so "nothing discoverable" is
    // actually true of the project and global sources.
    assert.throws(() => resolveSpecialistLayer("anything", cwd, globalDir, tmp()), /none discovered/);
  });

  it("rejects volatile instructions at load, naming the volatile content", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(
      projectSpecialistsDir(cwd),
      "bad",
      'instructions: "Current time is 2026-09-10T12:00:00, run git status first."\n',
    );

    assert.throws(
      () => resolveSpecialistLayer("bad", cwd, globalDir),
      (err: unknown) => {
        assert.ok(err instanceof SpecialistValidationError);
        assert.match((err as Error).message, /timestamp/);
        assert.match((err as Error).message, /git-status/);
        return true;
      },
    );
  });

  it("discoverSpecialists lists every name from both locations, deduplicated and sorted", () => {
    const cwd = tmp();
    const globalDir = tmp();
    // Ticket 07: isolate the shipped library so this test stays about the
    // global + project split only.
    const shipped = tmp();
    writeSpecialist(globalSpecialistsDir(globalDir), "minimal", "instructions: a\n");
    writeSpecialist(globalSpecialistsDir(globalDir), "review", "instructions: b\n");
    writeSpecialist(projectSpecialistsDir(cwd), "review", "instructions: c\n");
    writeSpecialist(projectSpecialistsDir(cwd), "explore", "instructions: d\n");

    const names = discoverSpecialists(cwd, globalDir, shipped).map((p) => p.name);
    assert.deepEqual(names, ["explore", "minimal", "review"]);
  });

  it("discoverSpecialists surfaces each specialist's description", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "review", "description: no writes, review only\ninstructions: a\n");
    writeSpecialist(projectSpecialistsDir(cwd), "explore", "instructions: b\n");

    const byName = new Map(discoverSpecialists(cwd, globalDir).map((p) => [p.name, p.description]));
    assert.equal(byName.get("review"), "no writes, review only");
    assert.equal(byName.get("explore"), undefined);
  });
});

// Specialists ticket 02 (ADR-0015): the remaining fourteen fields.
describe("resolveSpecialistLayer (ticket 02: the remaining fourteen fields)", () => {
  // Spec, "The shape of a specialist": "at most fifteen fields ... The count is
  // corrected here". Read from the spec's own table, not from this module's
  // constant, so the two cannot silently agree with each other while both
  // being wrong.
  const SPEC_TABLE_FIELDS = [
    "provider",
    "model",
    "thinkingLevel",
    "tools",
    "instructions",
    "read_only",
    "role",
    "skills",
    "feedback",
    "gate",
    "tools_add",
    "tools_remove",
    "description",
    "prompt_mode",
    "tools_mode",
    "rules",
    "delegate",
    "memory",
    "containment",
  ];

  it("the implemented field count equals the spec table's count (nineteen)", () => {
    assert.equal(SPEC_TABLE_FIELDS.length, 19);
    assert.equal(SPECIALIST_FIELD_NAMES.length, 19);
    assert.deepEqual([...SPECIALIST_FIELD_NAMES].sort(), [...SPEC_TABLE_FIELDS].sort());
  });

  it("every live field resolves through the specialist layer", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(
      projectSpecialistsDir(cwd),
      "full",
      [
        "provider: anthropic",
        "model: claude-sonnet-5",
        "thinkingLevel: high",
        "tools: [read, grep]",
        "instructions: Deliberate fully.",
        "read_only: false",
        "skills: [reviewer]",
        "feedback: { enabled: false }",
        "gate: { enabled: false }",
        "tools_add: [bash]",
        "tools_remove: [write]",
        "description: full-coverage test specialist",
      ].join("\n") + "\n",
    );
    // ticket 05: a roster entry must exist on disk, so the "full" specialist's
    // `skills: [reviewer]` needs a real skill file to resolve.
    writeSkill(cwd, "reviewer.md", "---\nname: reviewer\ndescription: review only\n---\n# review\n");

    const layer = resolveSpecialistLayer("full", cwd, globalDir);
    assert.equal(layer.value.provider, "anthropic");
    assert.equal(layer.value.model, "claude-sonnet-5");
    assert.equal(layer.value.thinkingLevel, "high");
    assert.deepEqual(layer.value.tools, ["read", "grep"]);
    assert.equal(layer.value.instructions, "Deliberate fully.");
    assert.equal(layer.value.readOnly, false);
    assert.deepEqual(layer.value.skills, { roster: ["reviewer"] });
    assert.deepEqual(layer.value.feedback, { enabled: false });
    assert.deepEqual(layer.value.gate, { enabled: false });
    assert.deepEqual(layer.value.tools_add, ["bash"]);
    assert.deepEqual(layer.value.tools_remove, ["write"]);
    assert.equal(layer.value.description, "full-coverage test specialist");
  });

  it("a specialist declaring only some fields inherits the rest — only the declared keys appear", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "partial", "model: claude-sonnet-5\ndescription: model only\n");

    const layer = resolveSpecialistLayer("partial", cwd, globalDir);
    assert.deepEqual(Object.keys(layer.value).sort(), ["description", "model"]);
  });

  it("tools_mode sets layer.value.tools_mode and does not produce an inert notice", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "tm", "tools_mode: override\n");
    const layer = resolveSpecialistLayer("tm", cwd, globalDir);
    assert.equal(layer.value.tools_mode, "override");
    assert.equal(layer.notices, undefined);
  });

  it("inert fields (rules, memory) produce notices; delegate and tools_mode do not", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "inert", "rules: [one]\ndelegate: true\nmemory: file\ntools_mode: append\n");
    const layer = resolveSpecialistLayer("inert", cwd, globalDir);
    assert.equal(layer.notices?.length, 2);
    assert.ok(layer.notices?.some((n) => n.includes('"rules"')));
    assert.ok(!layer.notices?.some((n) => n.includes('"delegate"')));
    assert.ok(layer.notices?.some((n) => n.includes('"memory"')));
    assert.ok(!layer.notices?.some((n) => n.includes('"tools_mode"')));
  });

  it("rejects a field outside the fifteen, naming it", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "typo", "toolz: [read]\n");

    assert.throws(
      () => resolveSpecialistLayer("typo", cwd, globalDir),
      (err: unknown) => {
        assert.ok(err instanceof SpecialistValidationError);
        assert.match((err as Error).message, /unknown field "toolz"/);
        return true;
      },
    );
  });

  it("rejects an unknown tool name in `tools`, naming it", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "bad-tool", "tools: [read, nonexistent_tool]\n");

    assert.throws(
      () => resolveSpecialistLayer("bad-tool", cwd, globalDir),
      (err: unknown) => {
        assert.ok(err instanceof SpecialistValidationError);
        assert.match((err as Error).message, /nonexistent_tool/);
        return true;
      },
    );
  });

  it("rejects an unknown tool name in `tools_add`", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "bad-add", "tools_add: [not_a_real_tool]\n");

    assert.throws(() => resolveSpecialistLayer("bad-add", cwd, globalDir), SpecialistValidationError);
  });

  it("rejects an off tool in `tools_add`, naming the tool and stating its residency (D3)", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "bad-resurrect", "tools_add: [SubagentWorkflow]\n");

    assert.throws(
      () => resolveSpecialistLayer("bad-resurrect", cwd, globalDir),
      (err: unknown) => {
        assert.ok(err instanceof SpecialistValidationError);
        assert.ok((err as Error).message.includes("subagent_workflow"));
        assert.ok((err as Error).message.includes("off"));
        return true;
      },
    );
  });

  it("rejects an unknown tool name in `tools_remove`", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "bad-remove", "tools_remove: [not_a_real_tool]\n");

    assert.throws(() => resolveSpecialistLayer("bad-remove", cwd, globalDir), SpecialistValidationError);
  });

  it("a plain `tools` list still replaces the resident set entirely (no add/remove semantics)", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "readonly", "tools: [read, grep, ls]\n");

    const layer = resolveSpecialistLayer("readonly", cwd, globalDir);
    assert.deepEqual(layer.value.tools, ["read", "grep", "ls"]);
    assert.equal(layer.value.tools_add, undefined);
    assert.equal(layer.value.tools_remove, undefined);
  });

  it("notices when tools_remove genuinely removes capability (P10 has not landed)", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "trimmed", "tools_remove: [write]\n");

    const layer = resolveSpecialistLayer("trimmed", cwd, globalDir);
    assert.ok(layer.notices?.some((n) => /tools_remove/.test(n) && /genuinely removes capability/.test(n)));
  });

  it("a file setting mode fails naming read_only (T214, ADR-0043)", () => {
    const cwd = tmp();
    const globalDir = tmp();
    for (const mode of ["yolo", "manual", "auto", "plan", "ask"]) {
      writeSpecialist(projectSpecialistsDir(cwd), `mode-${mode}`, `mode: ${mode}\n`);
      assert.throws(
        () => resolveSpecialistLayer(`mode-${mode}`, cwd, globalDir),
        (err: unknown) => {
          assert.ok(err instanceof SpecialistValidationError);
          assert.match((err as Error).message, /read_only/);
          return true;
        },
      );
    }
  });

  it("accepts boolean read_only and rejects non-boolean", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "ro-true", "read_only: true\n");
    const l1 = resolveSpecialistLayer("ro-true", cwd, globalDir);
    assert.equal(l1.value.readOnly, true);

    writeSpecialist(projectSpecialistsDir(cwd), "ro-false", "read_only: false\n");
    const l2 = resolveSpecialistLayer("ro-false", cwd, globalDir);
    assert.equal(l2.value.readOnly, false);

    writeSpecialist(projectSpecialistsDir(cwd), "ro-bad", "read_only: yes\n");
    assert.throws(
      () => resolveSpecialistLayer("ro-bad", cwd, globalDir),
      (err: unknown) => {
        assert.ok(err instanceof SpecialistValidationError);
        assert.match((err as Error).message, /read_only/);
        return true;
      },
    );
  });

  it("a specialist that only sets instructions does not restate or change the model", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "prose-only", "instructions: Write plainly.\n");

    const layer = resolveSpecialistLayer("prose-only", cwd, globalDir);
    assert.equal(layer.value.model, undefined);
    assert.equal(layer.value.provider, undefined);
  });

  it("accepts, validates and does not merge the inert fields, and notices rules and memory", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(
      projectSpecialistsDir(cwd),
      "future",
      ["rules: [no-console-log]", "delegate: true", "memory: embeddings"].join("\n") + "\n",
    );

    const layer = resolveSpecialistLayer("future", cwd, globalDir);
    // Inert: never merged into the ConfigFile value ticket 02 hands to the loader.
    assert.equal((layer.value as Record<string, unknown>).rules, undefined);
    assert.equal((layer.value as Record<string, unknown>).delegate, undefined);
    assert.equal((layer.value as Record<string, unknown>).memory, undefined);
    // But validated and reported: rules and memory warn; delegate is live (ticket 04) so no warning.
    assert.ok(layer.notices?.some((n) => n.includes('"rules"') && n.includes("P11")));
    assert.ok(!layer.notices?.some((n) => n.includes('"delegate"')));
    assert.ok(layer.notices?.some((n) => n.includes('"memory"') && n.includes("P10")));
  });

  it("rejects a malformed inert field's type", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "bad-rules", "rules: not-a-list\n");

    assert.throws(() => resolveSpecialistLayer("bad-rules", cwd, globalDir), SpecialistValidationError);
  });

  it("rejects an unrecognised thinkingLevel", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "bad-effort", "thinkingLevel: ludicrous\n");

    assert.throws(() => resolveSpecialistLayer("bad-effort", cwd, globalDir), SpecialistValidationError);
  });

  it("accepts a valid prompt_mode (append and override), while omitted stays undefined", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "app", "prompt_mode: append\n");
    writeSpecialist(projectSpecialistsDir(cwd), "over", "prompt_mode: override\n");
    writeSpecialist(projectSpecialistsDir(cwd), "omit", "description: test\n");

    const appLayer = resolveSpecialistLayer("app", cwd, globalDir);
    assert.equal(appLayer.value.prompt_mode, "append");

    const overLayer = resolveSpecialistLayer("over", cwd, globalDir);
    assert.equal(overLayer.value.prompt_mode, "override");

    const omitLayer = resolveSpecialistLayer("omit", cwd, globalDir);
    assert.equal(omitLayer.value.prompt_mode, undefined);
  });

  it("rejects an invalid prompt_mode, naming the field and the bad value", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "bad-mode", "prompt_mode: invalid-value\n");

    assert.throws(
      () => resolveSpecialistLayer("bad-mode", cwd, globalDir),
      (err: unknown) => {
        assert.ok(err instanceof SpecialistValidationError);
        assert.match(err.message, /prompt_mode "invalid-value" is not one of: append, override/);
        return true;
      },
    );
  });

  it("accepts a valid tools_mode, sets it on layer.value, and rejects an invalid tools_mode", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "tools-mode-val", "tools_mode: override\n");
    writeSpecialist(projectSpecialistsDir(cwd), "bad-tools-mode", "tools_mode: bogus\n");

    const layer = resolveSpecialistLayer("tools-mode-val", cwd, globalDir);
    assert.equal(layer.value.tools_mode, "override");
    assert.equal(layer.notices, undefined);

    assert.throws(
      () => resolveSpecialistLayer("bad-tools-mode", cwd, globalDir),
      (err: unknown) => {
        assert.ok(err instanceof SpecialistValidationError);
        assert.match(err.message, /tools_mode "bogus" is not one of: append, override/);
        return true;
      },
    );
  });
});

// Specialists ticket 05: a skill named by a specialist but absent from disk is
// reported at selection time, naming it — never silently half-applied.
describe("resolveSpecialistLayer (ticket 05: specialist-referenced skills)", () => {
  it("rejects a skill named by the specialist but absent from disk, naming it", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "review", "skills: [reviewer]\n");

    assert.throws(
      () => resolveSpecialistLayer("review", cwd, globalDir),
      (err: unknown) => {
        assert.ok(err instanceof SpecialistValidationError);
        assert.match((err as Error).message, /reviewer/);
        assert.match((err as Error).message, /not found on disk/);
        return true;
      },
    );
  });

  it("lists the skills that DO exist in the not-found message, honestly naming none when there are none", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "review", "skills: [ghost]\n");

    assert.throws(
      () => resolveSpecialistLayer("review", cwd, globalDir),
      (err: unknown) => {
        assert.match((err as Error).message, /available skills: \(none\)/);
        return true;
      },
    );
  });

  it("resolves a skill that exists on disk, comparing against the loader's frontmatter name", () => {
    const cwd = tmp();
    const globalDir = tmp();
    // The file is `a.md` but its frontmatter name is `alpha` — the roster must
    // reference `alpha`, exactly as the loader derives it.
    writeSkill(cwd, "a.md", "---\nname: alpha\ndescription: does alpha\n---\n# body\n");
    writeSpecialist(projectSpecialistsDir(cwd), "review", "skills: [alpha]\n");

    const layer = resolveSpecialistLayer("review", cwd, globalDir);
    assert.deepEqual(layer.value.skills, { roster: ["alpha"] });
  });

  it("a specialist declaring an empty skills list resolves to an empty roster without error", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "bare", "skills: []\n");

    const layer = resolveSpecialistLayer("bare", cwd, globalDir);
    assert.deepEqual(layer.value.skills, { roster: [] });
  });

  it("still rejects a non-list skills value", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "bad", "skills: not-a-list\n");

    assert.throws(() => resolveSpecialistLayer("bad", cwd, globalDir), SpecialistValidationError);
  });
});

// The shipped specialist library. Seven authored YAML specialists ship with the package and are
// selectable by name with zero user configuration, overridable by a project
// or global specialist of the same name.
describe("the shipped specialist library (ticket 07)", () => {
  const SHIPPED_NAMES = ["build", "explore", "general", "implementer", "plan", "review", "test-writer"];

  function emptyWorkspace(): { cwd: string; globalDir: string } {
    return { cwd: tmp(), globalDir: tmp() };
  }

  it("ships all seven specialists, discoverable with no project or global config", () => {
    const { cwd, globalDir } = emptyWorkspace();
    const locations = discoverSpecialists(cwd, globalDir);
    assert.deepEqual(locations.map((l) => l.name), SHIPPED_NAMES);
    for (const loc of locations) {
      assert.ok(loc.shippedPath, `shipped specialist "${loc.name}" must carry a shippedPath`);
      assert.ok(loc.shippedPath!.endsWith(`${loc.name}.yaml`));
    }
  });

  it("every shipped specialist resolves and carries a one-line description", () => {
    const { cwd, globalDir } = emptyWorkspace();
    for (const name of SHIPPED_NAMES) {
      const layer = resolveSpecialistLayer(name, cwd, globalDir);
      assert.equal(layer.present, true);
      const description = layer.value.description;
      assert.equal(typeof description, "string", `"${name}" must declare a description`);
      assert.ok(!description!.includes("\n"), `"${name}" description must be one line`);
    }
  });

  it("every shipped specialist validates against the nineteen-field vocabulary, with no notices", () => {
    const { cwd, globalDir } = emptyWorkspace();
    for (const name of SHIPPED_NAMES) {
      // `resolveSpecialistLayer` throws on an unknown field, an unknown tool, an
      // unknown mode, or a bad thinkingLevel — resolving is the validation.
      // No `notices` means no inert field (`rules`/`delegate`/`memory`) and no
      // `tools_remove`, both of which produce a notice at selection time.
      const layer = resolveSpecialistLayer(name, cwd, globalDir);
      assert.equal(layer.notices, undefined, `"${name}" must not set an inert field or use tools_remove`);
    }
  });

  it("no shipped specialist sets an inert field (rules, delegate, memory)", () => {
    const { cwd, globalDir } = emptyWorkspace();
    for (const name of SHIPPED_NAMES) {
      const layer = resolveSpecialistLayer(name, cwd, globalDir);
      const value = layer.value as Record<string, unknown>;
      assert.equal(value.rules, undefined, `"${name}" must not set rules`);
      assert.equal(value.delegate, undefined, `"${name}" must not set delegate`);
      assert.equal(value.memory, undefined, `"${name}" must not set memory`);
      const raw = readFileSync(layer.path!, "utf8");
      assert.doesNotMatch(raw, /^\s*(rules|delegate|memory)\s*:/m, `"${name}" file must not set an inert field`);
    }
  });

  it("each restrictive specialist lists its tools positively, never by subtraction", () => {
    const { cwd, globalDir } = emptyWorkspace();
    for (const name of ["plan", "review", "explore"]) {
      const layer = resolveSpecialistLayer(name, cwd, globalDir);
      assert.ok(Array.isArray(layer.value.tools), `"${name}" must list its tools positively`);
      assert.equal(layer.value.tools_remove, undefined, `"${name}" must not use tools_remove`);
      assert.equal(layer.value.tools_add, undefined, `"${name}" must not use tools_add`);
      for (const tool of layer.value.tools!) {
        assert.ok(tool in TOOL_RISKS, `"${name}" names a tool unknown to TOOL_RISKS: ${tool}`);
      }
    }
  });

  it("each restrictive specialist's surface is read/search only, with a read-only mode as the enforcement", () => {
    const { cwd, globalDir } = emptyWorkspace();
    const expected = {
      plan: { readOnly: true, tools: ["read", "bash"] },
      review: { readOnly: true, tools: ["read", "bash"] },
      explore: { readOnly: true, tools: ["read", "bash"] },
    } as const;
    for (const [name, want] of Object.entries(expected)) {
      const layer = resolveSpecialistLayer(name, cwd, globalDir);
      assert.equal(layer.value.readOnly, want.readOnly, `"${name}" readOnly`);
      assert.deepEqual(layer.value.tools, [...want.tools], `"${name}" tools`);
    }
  });

  it("every shipped mode is a real interaction mode and every thinkingLevel is valid", () => {
    const { cwd, globalDir } = emptyWorkspace();
    const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    for (const name of SHIPPED_NAMES) {
      const layer = resolveSpecialistLayer(name, cwd, globalDir);
      if (layer.value.mode !== undefined) {
        assert.ok(isInteractionMode(layer.value.mode), `"${name}" mode ${layer.value.mode} is not an interaction mode`);
      }
      if (layer.value.thinkingLevel !== undefined) {
        assert.ok(levels.includes(layer.value.thinkingLevel), `"${name}" thinkingLevel ${layer.value.thinkingLevel} is not valid`);
      }
    }
  });

  it("build keeps the ponytail ladder (no replace marker)", () => {
    const { cwd, globalDir } = emptyWorkspace();
    const build = resolveSpecialistLayer("build", cwd, globalDir);
    assert.ok(
      build.value.instructions === undefined || !build.value.instructions.startsWith(PONYTAIL_REPLACE_MARKER),
      "build must keep the ponytail ladder (no replace marker)",
    );
  });

  it("build is the default shape: low deliberation, feedback and gate on", () => {
    const { cwd, globalDir } = emptyWorkspace();
    const build = resolveSpecialistLayer("build", cwd, globalDir);
    assert.equal(build.value.thinkingLevel, "low");
    assert.deepEqual(build.value.feedback, { enabled: true });
    assert.deepEqual(build.value.gate, { enabled: true });
  });

  it("a project specialist overrides the shipped one by name", () => {
    const { cwd, globalDir } = emptyWorkspace();
    writeSpecialist(projectSpecialistsDir(cwd), "build", "instructions: my own version\n");
    const layer = resolveSpecialistLayer("build", cwd, globalDir);
    assert.equal(layer.value.instructions, "my own version");
    assert.equal(layer.path, join(projectSpecialistsDir(cwd), "build.yaml"));
  });

  it("a global specialist overrides the shipped one by name", () => {
    const { cwd, globalDir } = emptyWorkspace();
    writeSpecialist(globalSpecialistsDir(globalDir), "plan", "instructions: global plan\n");
    const layer = resolveSpecialistLayer("plan", cwd, globalDir);
    assert.equal(layer.value.instructions, "global plan");
    assert.equal(layer.path, join(globalSpecialistsDir(globalDir), "plan.yaml"));
  });

  it("loadConfig resolves each shipped name with no project or global config", () => {
    const { cwd, globalDir } = emptyWorkspace();
    for (const name of SHIPPED_NAMES) {
      const { resolved } = loadConfig({ cwd, globalDir, env: {}, specialistName: name });
      assert.equal(resolved.description !== undefined, true, `"${name}" must resolve through loadConfig`);
    }
    assert.equal(loadConfig({ cwd, globalDir, env: {}, specialistName: "build" }).resolved.thinkingLevel, "low");
  });

  it("shippedSpecialistsDir points at the package's own specialists directory", () => {
    const { cwd, globalDir } = emptyWorkspace();
    // The seven shipped files live exactly where `shippedSpecialistsDir` says.
    const names = discoverSpecialists(cwd, globalDir, shippedSpecialistsDir()).map((p) => p.name);
    assert.deepEqual(names, SHIPPED_NAMES);
  });
});

// ADR-0020 renamed the on-disk directory from `profiles/` to `specialists/`.
// P2 shipped the old name days before the rename, so the old name is still read.
describe("the pre-ADR-0020 profiles/ directory", () => {
  it("is read when it is the only directory present", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(join(cwd, ".lykos", "profiles"), "legacy", "instructions: from the old directory\n");
    const layer = resolveSpecialistLayer("legacy", cwd, globalDir);
    assert.equal(layer.value.instructions, "from the old directory");
  });

  it("loses to the new directory when both exist", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(join(cwd, ".lykos", "profiles"), "both", "instructions: old\n");
    writeSpecialist(projectSpecialistsDir(cwd), "both", "instructions: new\n");
    const layer = resolveSpecialistLayer("both", cwd, globalDir);
    assert.equal(layer.value.instructions, "new");
  });

  it("is read at the global layer too", () => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(join(globalDir, "profiles"), "globallegacy", "instructions: global old\n");
    const layer = resolveSpecialistLayer("globallegacy", cwd, globalDir);
    assert.equal(layer.value.instructions, "global old");
  });
});

// T177 (ADR-0037): the eighteenth field, `containment`.
describe("a specialist's containment (T177, ADR-0037)", () => {
  const project = (yaml: string, projectConfig?: string) => {
    const cwd = tmp();
    const globalDir = tmp();
    writeSpecialist(projectSpecialistsDir(cwd), "boxed", yaml);
    if (projectConfig !== undefined) {
      mkdirSync(join(cwd, ".lykos"), { recursive: true });
      writeFileSync(join(cwd, ".lykos", "config.yaml"), projectConfig);
    }
    return { cwd, globalDir };
  };

  it("sets the level, the network and the image over project config", () => {
    const { cwd, globalDir } = project(
      "containment:\n  level: required\n  network: none\n  image: python:3.12\n",
      "containment:\n  level: off\n  network: open\n  image: node:22\n",
    );
    const { resolved } = loadConfig({ cwd, globalDir, env: {}, specialistName: "boxed" });
    assert.equal(resolved.containment.level, "required");
    assert.equal(resolved.containment.network, "none");
    assert.equal(resolved.containment.image, "python:3.12");
  });

  it("unset means no opinion: a sub-key the specialist omits falls through to project config", () => {
    const { cwd, globalDir } = project("containment:\n  network: none\n", "containment:\n  level: auto\n  image: node:22\n");
    const { resolved } = loadConfig({ cwd, globalDir, env: {}, specialistName: "boxed" });
    assert.equal(resolved.containment.network, "none");
    assert.equal(resolved.containment.level, "auto");
    assert.equal(resolved.containment.image, "node:22");
  });

  it("a specialist without the field leaves containment as the config set it", () => {
    const { cwd, globalDir } = project("description: nothing about containment\n", "containment:\n  level: required\n");
    assert.equal(loadConfig({ cwd, globalDir, env: {}, specialistName: "boxed" }).resolved.containment.level, "required");
  });

  for (const [what, yaml, message] of [
    ["a level that is not one of the three", "containment:\n  level: sometimes\n", /level/],
    ["a network that is not open or none", "containment:\n  network: host\n", /network/],
    ["an empty image", 'containment:\n  image: ""\n', /image/],
    ["a key containment does not have", "containment:\n  runtime: docker\n", /runtime/],
    ["the loader-reserved global_image", "containment:\n  global_image: sneaky:1\n", /global_image/],
    ["a containment that is not an object", "containment: required\n", /containment/],
  ] as const) {
    it(`rejects ${what}, naming it`, () => {
      const { cwd, globalDir } = project(yaml);
      assert.throws(() => resolveSpecialistLayer("boxed", cwd, globalDir), (err: unknown) => {
        assert.ok(err instanceof SpecialistValidationError);
        assert.match((err as Error).message, message);
        return true;
      });
    });
  }
});

describe("specialist tool collision resolution and reserved async tools", () => {
  it("recognizes the four reserved async tools", () => {
    for (const name of ["lykos_start", "lykos_status", "lykos_steer", "lykos_stop"]) {
      assert.equal(isReservedAsyncTool(name), true, `${name} must be reserved`);
    }
    assert.equal(isReservedAsyncTool("lykos_implementer"), false);
  });

  it("resolveToolCollision prefers exact raw name match, then alphabetical", () => {
    const exact = resolveToolCollision([{ name: "foo_bar" }, { name: "foo~bar" }]);
    assert.equal(exact.name, "foo_bar");

    const alpha = resolveToolCollision([{ name: "foo bar" }, { name: "foo~bar" }]);
    assert.equal(alpha.name, "foo bar");
  });

  it("resolveSpecialistToolWinners groups and filters primary and unreadable", () => {
    const winners = resolveSpecialistToolWinners([
      { name: "foo_bar", role: "subagent", description: "winner" },
      { name: "foo~bar", role: "subagent", description: "loser" },
      { name: "build", role: "primary" },
      { name: "broken", unreadable: true },
    ]);
    assert.equal(winners.size, 1);
    assert.equal(winners.get("lykos_foo_bar")?.name, "foo_bar");
    assert.equal(winners.get("lykos_foo_bar")?.description, "winner");
  });
});
