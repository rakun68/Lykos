import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_COMMANDS,
  allCommands,
  findCommand,
  isOwnedName,
  resolveSkillName,
  setSkillCommands,
  slashCandidates,
} from "./commands.js";
import { S0_HELP } from "./renderers/conversation.js";

beforeEach(() => setSkillCommands([]));

describe("the built-in table", () => {
  it("gives every command a cost class and a description", () => {
    for (const c of BUILTIN_COMMANDS) {
      assert.ok(["local", "costed", "refused"].includes(c.costClass), `${c.name} needs a real cost class`);
      assert.ok(c.description.length > 0, `${c.name} needs a description`);
    }
  });

  it("carries the commands that used to dispatch without ever completing", () => {
    // The drift this module exists to end: /rename and /name were handled by
    // the parser and absent from the completion registry, so they could be
    // typed but never discovered.
    for (const name of ["/rename", "/name"]) {
      assert.ok(
        BUILTIN_COMMANDS.some((c) => c.name === name),
        `${name} dispatches, so it must complete`,
      );
    }
  });

  it("has no duplicate names", () => {
    const names = BUILTIN_COMMANDS.map((c) => c.name);
    assert.equal(new Set(names).size, names.length);
  });
});

describe("skill commands", () => {
  it("are absent until something registers them", () => {
    assert.equal(slashCandidates().some((c) => c.name === "/handoff"), false);
  });

  it("appear in completion once registered, as bare names", () => {
    setSkillCommands([
      { name: "handoff", description: "compact the conversation into a handoff" },
      { name: "grill-me", description: "interview the user relentlessly" },
    ]);
    const names = slashCandidates().map((c) => c.name);
    assert.ok(names.includes("/handoff"), "the exact case the request named");
    assert.ok(names.includes("/grill-me"));
  });

  it("are marked as skill-sourced, so the popup can say where they came from", () => {
    setSkillCommands([{ name: "handoff", description: "d" }]);
    assert.equal(findCommand("/handoff")?.source, "skill");
    assert.equal(findCommand("/help")?.source, "builtin");
  });

  it("cost something — a skill body is read and acted on", () => {
    setSkillCommands([{ name: "handoff", description: "d" }]);
    assert.equal(findCommand("/handoff")?.costClass, "costed");
  });

  it("can be replaced wholesale, so a re-scan never leaves stale entries", () => {
    setSkillCommands([{ name: "handoff", description: "d" }]);
    setSkillCommands([{ name: "other", description: "d" }]);
    const names = slashCandidates().map((c) => c.name);
    assert.equal(names.includes("/handoff"), false);
    assert.ok(names.includes("/other"));
  });
});

describe("collisions with built-ins", () => {
  beforeEach(() => setSkillCommands([{ name: "help", description: "a skill that shadows nothing" }]));

  it("let the built-in win the bare name", () => {
    assert.equal(findCommand("/help")?.source, "builtin");
  });

  it("still offer the skill under its /skill: form", () => {
    const names = slashCandidates().map((c) => c.name);
    assert.ok(names.includes("/skill:help"), "a shadowed skill stays reachable");
    assert.equal(names.filter((n) => n === "/help").length, 1, "and the bare name is listed once");
  });
});

describe("resolveSkillName", () => {
  it("accepts the explicit /skill: form for any registered skill", () => {
    setSkillCommands([{ name: "handoff", description: "d" }]);
    assert.equal(resolveSkillName("skill:handoff"), "handoff");
  });

  it("accepts the bare name when no built-in claims it", () => {
    setSkillCommands([{ name: "handoff", description: "d" }]);
    assert.equal(resolveSkillName("handoff"), "handoff");
  });

  it("refuses a bare name a built-in owns, so /help never becomes a skill", () => {
    setSkillCommands([{ name: "help", description: "d" }]);
    assert.equal(resolveSkillName("help"), undefined);
    assert.equal(resolveSkillName("skill:help"), "help", "but the explicit form still reaches it");
  });

  it("is undefined for a skill nobody registered", () => {
    assert.equal(resolveSkillName("nope"), undefined);
    assert.equal(resolveSkillName("skill:nope"), undefined);
  });

  it("is case-insensitive, like the rest of the command surface", () => {
    setSkillCommands([{ name: "Handoff", description: "d" }]);
    assert.equal(resolveSkillName("handoff"), "Handoff");
  });
});

describe("isOwnedName", () => {
  it("is true for a built-in and for a registered skill", () => {
    setSkillCommands([{ name: "handoff", description: "d" }]);
    assert.equal(isOwnedName("help"), true);
    assert.equal(isOwnedName("handoff"), true);
    assert.equal(isOwnedName("skill:handoff"), true);
  });

  it("is false for a typo, which is what makes an unknown command visible", () => {
    assert.equal(isOwnedName("hlep"), false);
  });
});

describe("allCommands", () => {
  it("is the union both completion and dispatch read", () => {
    setSkillCommands([{ name: "handoff", description: "d" }]);
    const all = allCommands();
    assert.ok(all.some((c) => c.name === "/help"));
    assert.ok(all.some((c) => c.name === "/handoff"));
  });
});

describe("the help text cannot become a third registry", () => {
  it("names no command the registry does not have", () => {
    // S0_HELP is hand-written prose, and hand-written prose about a command
    // list is exactly what `OWNED` and `COMMAND_REGISTRY` were. This binds it.
    const mentioned = [...S0_HELP.matchAll(/^\s{2}(\/[a-z-]+)/gm)].map((m) => m[1]!);
    assert.ok(mentioned.length > 5, "the help text should mention commands at all");
    for (const name of mentioned) {
      assert.ok(findCommand(name), `${name} is in /help but not in the command registry`);
    }
  });

  it("mentions every built-in a user can usefully type", () => {
    // Aliases are exempt: /hotkeys, /quit and /name are second names for
    // commands the help already lists under their primary name.
    const aliases = new Set(["/hotkeys", "/quit", "/name"]);
    for (const c of BUILTIN_COMMANDS) {
      if (aliases.has(c.name)) continue;
      assert.ok(S0_HELP.includes(c.name), `${c.name} dispatches and completes but /help never mentions it`);
    }
  });
});

describe("slashCandidates(query)", () => {
  it("offers the /skill: form for a non-colliding skill once /skill: is typed", () => {
    setSkillCommands([{ name: "handoff", description: "d" }]);
    assert.equal(slashCandidates().some((c) => c.name === "/skill:handoff"), false, "not carried unprompted");
    assert.ok(
      slashCandidates("/skill:").some((c) => c.name === "/skill:handoff"),
      "but offered the moment it is asked for",
    );
  });

  it("does not duplicate a colliding skill, which is already listed that way", () => {
    setSkillCommands([{ name: "help", description: "d" }]);
    const names = slashCandidates("/skill:").map((c) => c.name);
    assert.equal(names.filter((n) => n === "/skill:help").length, 1);
  });
});

describe("T163: every registered command is completable, or its conflict is reported", () => {
  it("holds across all four sources, including collisions between them", async () => {
    const { commandConflicts, setExtensionCommands, setPiExtensionCommands, slashCandidates, isOwnedName } = await import(
      "./commands.js"
    );
    const { parseInteractiveInput } = await import("./s0.js");
    const skills = [{ name: "handy" }, { name: "shared" }];
    const lykos = [
      { name: "lykos-hello", description: "", extension: "demo-lykos" },
      { name: "help", description: "", extension: "demo-lykos" },
      { name: "shared", description: "", extension: "demo-lykos" },
      { name: "both", description: "", extension: "demo-lykos" },
    ];
    const pi = [
      { name: "self-compact", description: "", extension: "lykos-self-compact" },
      { name: "dup:1", description: "", extension: "a" },
      { name: "dup:2", description: "", extension: "b" },
      { name: "mode", description: "", extension: "pi-x" },
      { name: "handy", description: "", extension: "pi-x" },
      { name: "both", description: "", extension: "pi-x" },
    ];
    setSkillCommands(skills);
    setExtensionCommands(lykos);
    setPiExtensionCommands(pi);
    try {
      const offered = new Set(slashCandidates().map((c) => c.name));
      const conflicts = commandConflicts().join("\n");
      const registered = [
        ...skills.map((s) => ["skill", s.name] as const),
        ...lykos.map((c) => ["Lykos extension", c.name] as const),
        ...pi.map((c) => ["Pi extension", c.name] as const),
      ];
      for (const [source, name] of registered) {
        const reported = new RegExp(`/${name.replace(/[:]/g, "\\$&")} from the ${source}`).test(conflicts);
        const completable = offered.has(`/${name}`);
        assert.ok(completable || reported, `/${name} (${source}) is neither completable nor reported`);
      }
      // A completable Pi command is owned (no typo marker) and is sent to Pi to run.
      assert.ok(offered.has("/self-compact") && isOwnedName("self-compact"));
      assert.deepEqual(parseInteractiveInput("/self-compact keep it"), { kind: "prompt", text: "/self-compact keep it" });
      assert.ok(offered.has("/dup:1") && offered.has("/dup:2"), "Pi's own suffixed duplicates are both offered");
      assert.match(conflicts, /\/mode from the Pi extension pi-x is shadowed by the built-in/);
      assert.match(conflicts, /\/handy from the Pi extension pi-x is shadowed by a skill/);
      assert.match(conflicts, /\/both from the Pi extension pi-x is shadowed by a Lykos extension command/);
      assert.match(conflicts, /\/help from the Lykos extension demo-lykos is shadowed by the built-in/);
      assert.match(conflicts, /\/shared from the Lykos extension demo-lykos is shadowed by the skill shared/);
    } finally {
      setExtensionCommands([]);
      setPiExtensionCommands([]);
    }
  });
});
