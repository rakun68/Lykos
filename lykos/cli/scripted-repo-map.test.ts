// P4 T148: `lykos-repo-map`, the first default extension, proven through the
// scripted-model session (T142's seam). What is checked is what the model was
// sent and what the ledger recorded — the outline appears once, the system
// prompt is byte-identical on every model call, and (T158, ADR-0028) its entry
// in `extensions:` is its only switch: it ships unlisted, and flags.retrieval
// does nothing either way.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REPO_MAP_HEADING } from "../context/repo-map.js";
import { defaultExtensionVersion } from "../extensions/defaults/index.js";
import { call, reply, runScriptedSession, say, type ModelContext } from "./scripted-session.js";

const FILES = {
  "package.json": "{}\n",
  "src/index.ts": "export const one = 1;\n",
  "src/util.ts": "export const two = 2;\n",
  "docs/readme.md": "# docs\n",
};

/** A three-call script: read, edit, finish — so the prompt is sent three times. */
const SCRIPT = [
  reply(call("read", { path: "src/util.ts" })),
  reply(call("write", { path: "src/util.ts", content: "export const two = 3;\n" })),
  reply(say("done")),
];

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function prompts(sent: ModelContext[]): string[] {
  return sent.map((c) => c.systemPrompt ?? "");
}

/** The shipped `extensions:` list plus the repo map — the list replaces, it does not merge. */
const LISTED = [
  "extensions:",
  "  - { name: pi-cache-optimizer, version: 2.8.6 }",
  "  - { name: pi-hashline-edit, version: 0.8.3 }",
  `  - { name: lykos-repo-map, version: ${defaultExtensionVersion()} }`,
  `  - { name: lykos-continuation, version: ${defaultExtensionVersion()} }`,
  `  - { name: lykos-self-compact, version: ${defaultExtensionVersion()} }`,
  "",
].join("\n");

describe("lykos-repo-map (T148; T158: the extension list is its only switch)", () => {
  it("listed: the outline is in the prompt once, and the prompt is identical on every model call", async () => {
    const run = await runScriptedSession({
      files: FILES,
      // T158: no other setting. `flags.retrieval: false` is written to prove it no longer matters.
      config: `${LISTED}flags:\n  retrieval: false\n`,
      script: SCRIPT,
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);

    const sent = prompts(run.sent);
    assert.equal(sent.length, 3);
    assert.equal(occurrences(sent[0]!, REPO_MAP_HEADING), 1, "the outline appears exactly once");
    assert.match(sent[0]!, /src\/\s+index\.ts/);
    for (const p of sent) assert.equal(p, sent[0], "the system prompt never changes mid-session");
    // Frozen: the edit to src/util.ts did not rebuild it — and nothing could, since the bytes match.

    const row = run.session();
    assert.equal(row.flag_retrieval, 1, "the ledger records that a map rode the head");
    assert.ok(Number(row.repo_map_tokens) > 0);
    assert.equal(row.repo_map_tracked, 5, "four fixture files plus .gitignore");
    assert.match(run.show(), /lykos-repo-map/, "`lykos show` names it among the loaded extensions");
  });

  it("the shipped config adds no repo map, and flags.retrieval does not turn it on", async () => {
    const run = await runScriptedSession({ files: FILES, config: "flags:\n  retrieval: true\n", script: SCRIPT });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    for (const p of prompts(run.sent)) assert.equal(occurrences(p, REPO_MAP_HEADING), 0);
    const row = run.session();
    assert.equal(row.flag_retrieval, 0);
    assert.equal(row.repo_map_tokens, 0);
    assert.doesNotMatch(run.show(), /lykos-repo-map/, "not declared, so not loaded");
  });

  it("with no configuration at all: off", async () => {
    const run = await runScriptedSession({ files: FILES, script: SCRIPT });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    for (const p of prompts(run.sent)) assert.equal(occurrences(p, REPO_MAP_HEADING), 0);
    assert.equal(run.session().flag_retrieval, 0);
  });
});
