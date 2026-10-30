import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseInteractiveInput } from "../s0.js";
import { resolveTheme } from "../theme/resolve.js";
import {
  COMMAND_REGISTRY,
  completeArgument,
  completeCommand,
  completePath,
  completionWindow,
  fuzzyMatchFiles,
  listProjectFiles,
  renderCompletionPopup,
  type CostClass,
} from "./completion.js";
import { setSpecialistNames } from "../commands.js";

const mono = resolveTheme("mono", "none", "unicode");
const color = resolveTheme("rose-pine-moon", "truecolor", "unicode");

describe("T47.1/T47.4: the command registry is complete and real", () => {
  it("every command has a cost class", () => {
    for (const c of COMMAND_REGISTRY) {
      assert.ok(["local", "costed", "refused"].includes(c.costClass), `${c.name} is missing a class`);
    }
  });

  it("every slash command in the registry is actually recognised by parseInteractiveInput — a registry entry cannot lie about a command that doesn't exist", () => {
    for (const c of COMMAND_REGISTRY) {
      if (!c.name.startsWith("/")) continue;
      if (c.costClass === "refused") continue; // refused commands are recognised-and-rejected, not routed to the model either way
      const parsed = parseInteractiveInput(c.name);
      assert.notEqual(parsed.kind, "prompt", `${c.name} is in the registry but parseInteractiveInput doesn't recognise it — it would silently cost tokens`);
    }
  });

  it("refused commands are recognised as refusals, not sent to the model", () => {
    assert.equal(parseInteractiveInput("/model").kind, "refuse-model");
    assert.equal(parseInteractiveInput("/new").kind, "refuse-model");
  });

  it("ticket 04: /specialist is local, not refused — bare lists, a name switches", () => {
    const specialistCmd = COMMAND_REGISTRY.find((c) => c.name === "/specialist")!;
    assert.equal(specialistCmd.costClass, "local");
    assert.equal(parseInteractiveInput("/specialist").kind, "specialist-list");
    assert.equal(parseInteractiveInput("/specialist deliberate").kind, "specialist-switch");
  });

  it("ticket 04: the composer completes /specialist <name> from the discovered roster", () => {
    setSpecialistNames(["deliberate", "explore", "minimal"]);
    try {
      const candidates = completeArgument("/specialist", "");
      assert.deepEqual(candidates.map((c) => c.label).sort(), ["deliberate", "explore", "minimal"]);
      assert.deepEqual(completeArgument("/specialist", "de").map((c) => c.label), ["deliberate"]);
    } finally {
      setSpecialistNames([]);
    }
  });

  it("/compact is costed — the one people get wrong", () => {
    const compact = COMMAND_REGISTRY.find((c) => c.name === "/compact")!;
    assert.equal(compact.costClass, "costed");
  });

  it("/compact offers the compaction methods as its first argument (T191)", () => {
    assert.deepEqual(completeArgument("/compact", "").map((c) => c.label), ["handoff", "shake"]);
    assert.deepEqual(completeArgument("/compact", "sh").map((c) => c.label), ["shake"]);
  });

  it("!cmd is costed and !!cmd is local — the distinction that already exists and is currently invisible", () => {
    const bang = COMMAND_REGISTRY.find((c) => c.name === "!cmd")!;
    const bangbang = COMMAND_REGISTRY.find((c) => c.name === "!!cmd")!;
    assert.equal(bang.costClass, "costed");
    assert.equal(bangbang.costClass, "local");
  });
});

describe("T47.3: command completion — `/` at position 0", () => {
  it("filters by prefix", () => {
    const results = completeCommand("/co").map((c) => c.label);
    assert.ok(results.includes("/copy"));
    assert.ok(results.includes("/compact"));
    assert.ok(!results.includes("/help"));
  });

  it("an empty query after `/` returns every slash command", () => {
    const results = completeCommand("/");
    assert.equal(results.length, COMMAND_REGISTRY.filter((c) => c.name.startsWith("/")).length);
  });
});

describe("T47.3: file completion — `@`, respecting .gitignore, fuzzy-matched", () => {
  function project(): string {
    const dir = mkdtempSync(join(tmpdir(), "lykos-completion-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "left-pad"), { recursive: true });
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "");
    writeFileSync(join(dir, "src", "header.ts"), "");
    writeFileSync(join(dir, "node_modules", "left-pad", "index.js"), "");
    writeFileSync(join(dir, "dist", "bundle.js"), "");
    writeFileSync(join(dir, ".gitignore"), "dist\n");
    return dir;
  }

  it("respects .gitignore and always skips node_modules", () => {
    const files = listProjectFiles(project());
    assert.ok(files.includes("src/index.ts"));
    assert.ok(!files.some((f) => f.startsWith("node_modules/")));
    assert.ok(!files.some((f) => f.startsWith("dist/")));
  });

  it("fuzzy-matches a subsequence, tightest cluster first", () => {
    const files = ["src/header.ts", "src/index.ts", "src/handlers/edit.ts"];
    const results = fuzzyMatchFiles(files, "hdr");
    assert.equal(results[0], "src/header.ts");
  });

  it("completePath returns file candidates", () => {
    const results = completePath(project(), "index");
    assert.ok(results.every((r) => r.kind === "file"));
    assert.ok(results.some((r) => r.label === "src/index.ts"));
  });

  it("@ completion over a large synthetic set returns in well under 50ms", () => {
    const files = Array.from({ length: 5000 }, (_, i) => `src/module-${i}/file-${i}.ts`);
    const start = performance.now();
    fuzzyMatchFiles(files, "mod42");
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 50, `fuzzy match over 5000 files took ${elapsed}ms`);
  });
});

describe("T47.2: colour by cost class, with a non-colour marker too", () => {
  it("every class carries a distinct literal marker under NO_COLOR", () => {
    const candidates = [
      { label: "/help", kind: "command" as const, costClass: "local" as CostClass },
      { label: "/compact", kind: "command" as const, costClass: "costed" as CostClass },
      { label: "/specialist", kind: "command" as const, costClass: "refused" as CostClass },
    ];
    const lines = renderCompletionPopup(candidates, { width: 60, theme: mono });
    assert.ok(!lines[0]!.includes("$") && !lines[0]!.includes("×"));
    assert.ok(lines[1]!.includes("$"));
    assert.ok(lines[2]!.includes("×"));
  });

  it("the legend line names all three classes", () => {
    const lines = renderCompletionPopup([{ label: "/help", kind: "command", costClass: "local" }], { width: 60, theme: mono });
    assert.match(lines.at(-1)!, /local/);
    assert.match(lines.at(-1)!, /costed/);
    assert.match(lines.at(-1)!, /refused/);
  });
});

describe("T47.3: the popup renders correctly with 1, 8, and 200 candidates", () => {
  for (const n of [1, 8, 200]) {
    it(`${n} candidates`, () => {
      const candidates = Array.from({ length: n }, (_, i) => ({ label: `/cmd${i}`, kind: "command" as const, costClass: "local" as CostClass }));
      const lines = renderCompletionPopup(candidates, { width: 60, theme: color, maxVisible: 10 });
      const expectedRows = Math.min(n, 10) + (n > 10 ? 1 : 0) + 1; // + overflow row + legend
      assert.equal(lines.length, expectedRows);
    });
  }
});

describe("2026-09-02 item 5: a five-row window with the pointer pinned to the middle", () => {
  const candidates = Array.from({ length: 12 }, (_, i) => ({ label: `/cmd${i}`, kind: "command" as const, costClass: "local" as CostClass }));

  it("shows five rows plus the counter and legend once the list is longer than the window", () => {
    const lines = renderCompletionPopup(candidates, { width: 60, theme: color, selected: 0 });
    assert.equal(lines.length, 5 + 2);
  });

  it("pins the window to the top for the first two candidates", () => {
    for (const selected of [0, 1, 2]) {
      const { start } = completionWindow(12, selected, 5);
      assert.equal(start, Math.max(0, selected - 2));
    }
  });

  it("scrolls the list under a pointer that stays on the middle row", () => {
    for (const selected of [3, 4, 8, 9]) {
      const { start } = completionWindow(12, selected, 5);
      assert.equal(selected - start, 2, `selected ${selected} sits on the third visible row`);
    }
  });

  it("pins the window to the bottom for the last two candidates", () => {
    for (const selected of [10, 11]) {
      const { start, end } = completionWindow(12, selected, 5);
      assert.equal(end, 12);
      assert.equal(start, 7);
    }
  });

  it("wrapping from the first candidate to the last shows the end of the list", () => {
    // RawLineSource cycles the INDEX; the window follows it to the bottom.
    const { start, end } = completionWindow(12, 11, 5);
    assert.equal(start, 7);
    assert.equal(end, 12);
  });

  it("a list shorter than the window is shown whole with no counter row", () => {
    const short = candidates.slice(0, 3);
    const lines = renderCompletionPopup(short, { width: 60, theme: color, selected: 1 });
    assert.equal(lines.length, 3 + 1, "three candidates plus the legend, no counter");
  });
});
