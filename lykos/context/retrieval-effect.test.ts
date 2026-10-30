import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseMapFiles, retrievalEffect, RETRIEVAL_EFFECT_VERSION } from "./retrieval-effect.js";
import { rankDirectories, renderRepoMap } from "./repo-map.js";

const MAP = [
  "## lykos-repo-map",
  "12 tracked files. Directories most likely to matter first; within each, entry points first.",
  "This is a map, not an index. It is frozen for this session and does not reflect edits made during it.",
  "./  README.md package.json",
  "lykos/session/  session.ts approval.ts (+4 more)",
  "docs/  02-plan.md",
  "4 more files not listed here — use bash (ls, grep, rg) to reach them.",
].join("\n");

const read = (path: string) => ({ name: "read", state: "ok", args: { path } });
const bash = (command: string) => ({ name: "bash", state: "ok", args: { command } });
const edit = (path: string, state = "ok") => ({ name: "edit", state, args: { path } });

describe("parseMapFiles (T70)", () => {
  it("reconstructs repo-relative paths from the rendered map", () => {
    const named = parseMapFiles(MAP);
    assert.ok(named.has("README.md"));
    assert.ok(named.has("package.json"));
    assert.ok(named.has("lykos/session/session.ts"));
    assert.ok(named.has("docs/02-plan.md"));
  });

  it("does NOT credit the map for what it dropped", () => {
    const named = parseMapFiles(MAP);
    // `(+4 more)` and the overflow footer name nothing. Counting them would
    // let the map take credit for every file it failed to surface, which
    // would make editedMissed a metric that can never fire.
    // Five names appear on the three directory lines. The `(+4 more)` and
    // the "4 more files not listed here" footer contribute nothing.
    assert.equal(named.size, 5);
    for (const v of named) assert.equal(v.includes("more"), false);
  });

  it("returns nothing for text that is not a map", () => {
    assert.equal(parseMapFiles("").size, 0);
    assert.equal(parseMapFiles("## lykos-memory\n- [a] x").size, 0);
  });

  it("round-trips a map this repo's own renderer produced", () => {
    const rendered = renderRepoMap(
      rankDirectories([{ path: "src/index.ts", churn: 0 }, { path: "src/a.ts", churn: 0 }], 6),
      2,
      1500,
    );
    const named = parseMapFiles(rendered.text);
    assert.ok(named.has("src/index.ts"));
    assert.ok(named.has("src/a.ts"));
  });
});

describe("retrievalEffect (T70)", () => {
  it("counts an edit the map surfaced", () => {
    const e = retrievalEffect(MAP, [edit("lykos/session/session.ts")]);
    assert.equal(e.editedCovered, 1);
    assert.equal(e.editedMissed, 0);
  });

  it("counts an edit the map MISSED — problems/06's warning signal", () => {
    const e = retrievalEffect(MAP, [edit("lykos/tools/spawn.ts")]);
    assert.equal(e.editedCovered, 0);
    assert.equal(e.editedMissed, 1);
    // Inspectable, not just a count: a bare number cannot be investigated.
    assert.deepEqual(e.missedPaths, ["lykos/tools/spawn.ts"]);
  });

  it("counts a read of a file the map already named — a read the map should have prevented", () => {
    const e = retrievalEffect(MAP, [read("lykos/session/session.ts")]);
    assert.equal(e.exploreCovered, 1);
    assert.equal(e.exploreUncovered, 0);
  });

  it("counts a search for something the map did not name", () => {
    const e = retrievalEffect(MAP, [bash("grep -rn thing lykos/ledger/")]);
    assert.equal(e.exploreCovered, 0);
    assert.equal(e.exploreUncovered, 1);
  });

  it("recognises a bash command naming a mapped path", () => {
    const e = retrievalEffect(MAP, [bash("sed -n '1,40p' lykos/session/session.ts")]);
    assert.equal(e.exploreCovered, 1);
  });

  it("counts a file edited twice only once", () => {
    const e = retrievalEffect(MAP, [edit("lykos/tools/spawn.ts"), edit("lykos/tools/spawn.ts")]);
    assert.equal(e.editedMissed, 1);
  });

  it("ignores a failed edit — it does not establish the file mattered", () => {
    const e = retrievalEffect(MAP, [edit("wrong.ts", "error")]);
    assert.equal(e.editedMissed, 0);
    assert.equal(e.editedCovered, 0);
  });

  it("is empty when no map was injected — no map is not the same as a map that covered nothing", () => {
    const e = retrievalEffect("", [edit("a.ts"), read("b.ts")]);
    assert.equal(e.mapNamed.size, 0);
    assert.equal(e.editedMissed, 0);
    assert.equal(e.exploreUncovered, 0);
    assert.equal(e.version, RETRIEVAL_EFFECT_VERSION);
  });

  it("is empty when the session made no tool call", () => {
    const e = retrievalEffect(MAP, []);
    assert.equal(e.exploreCovered, 0);
    assert.equal(e.editedCovered, 0);
  });

  it("normalises separators so a Windows edit matches a mapped path", () => {
    const e = retrievalEffect(MAP, [{ name: "edit", state: "ok", args: { path: "lykos\\session\\session.ts" } }]);
    assert.equal(e.editedCovered, 1);
  });

  it("does not count edits as exploration or exploration as edits", () => {
    const e = retrievalEffect(MAP, [read("README.md"), edit("README.md")]);
    assert.equal(e.exploreCovered, 1);
    assert.equal(e.editedCovered, 1);
  });
});
