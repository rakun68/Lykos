import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CHECKPOINT_REF, createCheckpoint, listCheckpoints, type CheckpointEntry } from "../loop/checkpoint.js";
import {
  CHECKPOINT_DESCRIPTION,
  CHECKPOINT_MARK_CAP,
  CHECKPOINT_PARAMETERS,
  CHECKPOINT_TOOL_NAME,
  CHECKPOINT_TOOL_NAMES,
  LOCAL_CHECKPOINT_VIEW,
  NOTHING_MOVED_NOTICE,
  REWIND_DESCRIPTION,
  REWIND_PARAMETERS,
  REWIND_TOOL_NAME,
  buildCheckpointTool,
  buildCheckpointTools,
  buildRewindTool,
  newCheckpointProposalState,
  resolveRewindTarget,
  rewindCommandFor,
} from "./checkpoint-tools.js";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { measureToolset } from "../ledger/tool-schema.js";
import { riskForTool, tierForTool } from "./tool-risk.js";
import { DEFAULT_RESIDENT_TOOLS, MOUNTED_TOOLS, RUNTIME_AVAILABLE_TOOLS, TOOL_REGISTRY } from "./tool-surface.js";

const here = dirname(fileURLToPath(import.meta.url));

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

/**
 * A REAL repository with REAL checkpoints in it. The thing under test is an
 * absence — that no call through these tools can move the tree — and CLAUDE.md
 * is explicit that a guard is tested against the real input, not a stand-in. A
 * faked view would only prove that a fake was not called.
 */
function repo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "lykos-ckpt-tools-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q", ".");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(dir, "a.txt"), "original\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const status = (dir: string) => execFileSync("git", ["status", "--short"], { cwd: dir, encoding: "utf8" });
const refAt = (dir: string) =>
  execFileSync("git", ["rev-parse", "--verify", "--quiet", CHECKPOINT_REF], { cwd: dir, encoding: "utf8" }).trim();

/** Every tracked and untracked file's bytes, so "the tree did not move" is a statement about content, not about git's opinion. */
function treeBytes(dir: string): string {
  const out: string[] = [];
  const walk = (at: string, prefix: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".git") continue;
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else out.push(`${prefix}${entry.name}=${readFileSync(full, "utf8")}`);
    }
  };
  walk(dir, "");
  return out.join("\n");
}

describe("P10.6 D1: checkpoint and rewind cannot move the working tree", () => {
  // THE TEST THAT TRIES. A real repository, a real checkpoint with the old
  // content in it, a real modification after it, and then every call these two
  // tools accept — including the ones that name the exact checkpoint holding
  // the old bytes. If either tool could restore anything, `a.txt` would come
  // back as "original" and this would fail.
  it("tries to move the tree through both tools, against a real repository, and cannot", async () => {
    const { dir, cleanup } = repo();
    try {
      const first = createCheckpoint({ cwd: dir }, "before turn 0");
      assert.equal(first.status, "created");

      // The damage a rewind would undo.
      writeFileSync(join(dir, "a.txt"), "rewritten by the agent\n");
      writeFileSync(join(dir, "b.txt"), "a file the checkpoint never had\n");
      const second = createCheckpoint({ cwd: dir }, "before turn 1");
      assert.equal(second.status, "created");

      const bytesBefore = treeBytes(dir);
      const statusBefore = status(dir);
      const refBefore = refAt(dir);
      const countBefore = listCheckpoints({ cwd: dir }).length;
      assert.equal(countBefore, 2);

      const state = newCheckpointProposalState();
      const checkpoint = buildCheckpointTool({ cwd: dir, state });
      const rewind = buildRewindTool({ cwd: dir, state });

      await call(checkpoint, { label: "before the rewrite", why: "about to try something" });
      // Every addressing mode, including the one that names the checkpoint
      // holding the original bytes by number.
      await call(rewind, { report: "the rewrite was wrong", to: "1" });
      await call(rewind, { report: "the rewrite was wrong", to: "0" });
      await call(rewind, { report: "the rewrite was wrong", to: "before the rewrite" });
      await call(rewind, { report: "the rewrite was wrong" });
      // And the shapes a confused model might send.
      await call(rewind, { report: "go back", to: "99" });
      await call(rewind, { report: "go back", to: "HEAD" });
      await call(checkpoint, { label: "" });

      assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "rewritten by the agent\n");
      assert.equal(treeBytes(dir), bytesBefore, "no byte of the working tree may change");
      assert.equal(status(dir), statusBefore, "git status must be byte-identical");
      assert.equal(refAt(dir), refBefore, "the checkpoint ref must not move — no tool may write a checkpoint either");
      assert.equal(listCheckpoints({ cwd: dir }).length, countBefore);
    } finally {
      cleanup();
    }
  });

  // The reason the test above cannot succeed, stated as a property rather than
  // as a result: the definitions are handed one function and it reads.
  it("is handed a view with exactly one member, and that member reads", () => {
    assert.deepEqual(Object.keys(LOCAL_CHECKPOINT_VIEW), ["list"]);
    assert.equal("restore" in LOCAL_CHECKPOINT_VIEW, false);
    assert.equal("create" in LOCAL_CHECKPOINT_VIEW, false);
    const { dir, cleanup } = repo();
    try {
      const listed: CheckpointEntry[] = LOCAL_CHECKPOINT_VIEW.list(dir);
      assert.deepEqual(listed, []);
    } finally {
      cleanup();
    }
  });

  it("never names restoreCheckpoint or createCheckpoint anywhere in the module", () => {
    const source = readFileSync(join(here, "checkpoint-tools.ts"), "utf8");
    // The comment block explains the absence, so the check is on CODE: split
    // off the leading comment and assert the identifiers appear in neither
    // an import nor a call.
    const code = source.slice(source.indexOf("import { Type }"));
    assert.equal(/\brestoreCheckpoint\s*\(/.test(code), false);
    assert.equal(/\bcreateCheckpoint\s*\(/.test(code), false);
    const imported = /import\s*\{([^}]*)\}\s*from\s*"\.\.\/loop\/checkpoint\.js"/.exec(code)?.[1];
    assert.ok(imported, "the module must import from loop/checkpoint.js by name, not by namespace");
    assert.equal(imported.includes("restoreCheckpoint"), false);
    assert.equal(imported.includes("createCheckpoint"), false);
    assert.equal(imported.includes("listCheckpoints"), true);
  });

  it("says NOTHING WAS MOVED in every result a human might be told about", async () => {
    const { dir, cleanup } = repo();
    try {
      createCheckpoint({ cwd: dir }, "before turn 0");
      const state = newCheckpointProposalState();
      const marked = await call(buildCheckpointTool({ cwd: dir, state }), { label: "here" });
      const proposed = await call(buildRewindTool({ cwd: dir, state }), { report: "go back" });
      assert.ok(marked.text.includes(NOTHING_MOVED_NOTICE));
      assert.ok(proposed.text.includes(NOTHING_MOVED_NOTICE));
      assert.equal(marked.details.moved, false);
      assert.equal(proposed.details.moved, false);
      assert.equal(proposed.details.awaitingHuman, true);
    } finally {
      cleanup();
    }
  });
});

describe("checkpoint names a point", () => {
  it("attaches the label to the newest checkpoint and records it in session state", async () => {
    const { dir, cleanup } = repo();
    try {
      createCheckpoint({ cwd: dir }, "before turn 0");
      const newest = listCheckpoints({ cwd: dir })[0]!;
      const state = newCheckpointProposalState();
      const tool = buildCheckpointTool({ cwd: dir, state, now: () => new Date("2026-09-21T09:00:00.000Z") });

      const result = await call(tool, { label: "  before   the rewrite  ", why: "about to try the registry" });
      assert.equal(result.isError, false);
      assert.equal(result.details.marked, true);
      assert.equal(result.details.commit, newest.commit);
      assert.ok(result.text.includes(rewindCommandFor(newest)));

      assert.equal(state.marks.length, 1);
      assert.deepEqual(state.marks[0], {
        label: "before the rewrite",
        at: "2026-09-21T09:00:00.000Z",
        why: "about to try the registry",
        commit: newest.commit,
      });
    } finally {
      cleanup();
    }
  });

  it("marks a workspace with no checkpoints and says why there is nothing to attach to", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-nogit-tools-"));
    try {
      const state = newCheckpointProposalState();
      const result = await call(buildCheckpointTool({ cwd: dir, state }), { label: "here" });
      assert.equal(result.isError, false);
      assert.equal(result.details.checkpoints, 0);
      assert.ok(result.text.includes("no checkpoints"));
      assert.equal(state.marks.length, 1);
      assert.equal(state.marks[0]!.commit, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses an empty label and refuses past the mark cap, changing nothing either time", async () => {
    const state = newCheckpointProposalState();
    const tool = buildCheckpointTool({ cwd: process.cwd(), state, view: { list: () => [] } });
    assert.equal((await call(tool, { label: "   " })).isError, true);
    assert.equal(state.marks.length, 0);

    for (let i = 0; i < CHECKPOINT_MARK_CAP; i++) {
      assert.equal((await call(tool, { label: `mark ${i}` })).isError, false, `mark ${i}`);
    }
    const over = await call(tool, { label: "one too many" });
    assert.equal(over.isError, true);
    assert.equal(over.details.reason, "cap");
    assert.equal(state.marks.length, CHECKPOINT_MARK_CAP);
    assert.equal(state.markRefusals, 1);
  });
});

describe("rewind proposes a return", () => {
  const entries: CheckpointEntry[] = [
    { commit: "cccc0000", at: "2026-09-21T12:00:00Z", label: "before turn 2", index: 0 },
    { commit: "bbbb0000", at: "2026-09-21T11:00:00Z", label: "before turn 1", index: 1 },
    { commit: "aaaa0000", at: "2026-09-21T10:00:00Z", label: "before turn 0", index: 2 },
  ];
  const view = { list: () => entries };

  it("refuses an empty report, because the report is what a human decides on", async () => {
    const state = newCheckpointProposalState();
    const result = await call(buildRewindTool({ cwd: ".", state, view }), { report: "  " });
    assert.equal(result.isError, true);
    assert.equal(result.details.proposed, false);
    assert.equal(state.returns.length, 0);
  });

  it("resolves a checkpoint number, and hands back the command a human runs", async () => {
    const state = newCheckpointProposalState();
    const result = await call(buildRewindTool({ cwd: ".", state, view }), { report: "the approach was wrong", to: "2" });
    assert.equal(result.isError, false);
    assert.equal(result.details.index, 2);
    assert.equal(result.details.commit, "aaaa0000");
    assert.equal(result.details.command, "lykos rewind aaaa0000");
    assert.equal(state.returns.length, 1);
  });

  // The arithmetic this resolution exists to avoid: a mark made at index 0
  // must still resolve to the SAME COMMIT after two more turns pushed it down.
  it("resolves a named point by its commit, not by the index it had when it was named", () => {
    const state = newCheckpointProposalState();
    state.marks.push({ label: "the good one", at: "2026-09-21T10:00:01Z", commit: "aaaa0000" });
    const resolved = resolveRewindTarget(state, entries, "the good one");
    assert.equal(resolved.error, undefined);
    assert.equal(resolved.entry?.commit, "aaaa0000");
    assert.equal(resolved.entry?.index, 2, "the index moved and the commit did not");
  });

  it("falls back to the most recently named point, then to the newest checkpoint", () => {
    const state = newCheckpointProposalState();
    assert.equal(resolveRewindTarget(state, entries, undefined).entry?.index, 0);
    state.marks.push({ label: "one", at: "t", commit: "bbbb0000" });
    state.marks.push({ label: "two", at: "t", commit: "aaaa0000" });
    assert.equal(resolveRewindTarget(state, entries, undefined).entry?.commit, "aaaa0000");
  });

  it("names what exists when the label, the number or the commit is unknown", () => {
    const state = newCheckpointProposalState();
    state.marks.push({ label: "one", at: "t", commit: "bbbb0000" });
    assert.match(resolveRewindTarget(state, entries, "nine")!.error!, /no point named/);
    assert.match(resolveRewindTarget(state, entries, "9")!.error!, /no checkpoint 9/);
    assert.match(resolveRewindTarget(state, [], "0")!.error!, /no checkpoints/);

    const stale = newCheckpointProposalState();
    stale.marks.push({ label: "gone", at: "t", commit: "deadbeef" });
    assert.match(resolveRewindTarget(stale, entries, "gone")!.error!, /no longer lists/);
  });
});

describe("buildCheckpointTools", () => {
  it("builds the pair in the documented order", () => {
    const tools = buildCheckpointTools({ cwd: ".", state: newCheckpointProposalState(), view: { list: () => [] } });
    assert.deepEqual(
      tools.map((t) => t.name),
      [...CHECKPOINT_TOOL_NAMES],
    );
    assert.deepEqual([...CHECKPOINT_TOOL_NAMES], [CHECKPOINT_TOOL_NAME, REWIND_TOOL_NAME]);
  });
});

// ---------------------------------------------------------------------------
// D9: mounted, hidden, in the catalog, measured
// ---------------------------------------------------------------------------

describe("P10.6 D9: the registry, the catalog and the measured tax", () => {
  it("both are mounted, hidden and runtime-available, and neither is resident", () => {
    for (const name of CHECKPOINT_TOOL_NAMES) {
      const row = TOOL_REGISTRY.find((e) => e.name === name);
      assert.ok(row, `${name} has no registry row`);
      assert.equal(row.residency, "mounted", name);
      assert.equal(row.promptPresence, "hidden", name);
      assert.equal(RUNTIME_AVAILABLE_TOOLS.has(name), true, name);
      assert.equal(MOUNTED_TOOLS.includes(name), true, name);
      assert.equal(DEFAULT_RESIDENT_TOOLS.includes(name), false, name);
    }
  });

  // The declared tier has to match what the tool can actually do, and what
  // these can do is read a list. The placeholder rows said `soft-write` for
  // tools that were going to restore files; these cannot.
  it("declares read, because neither writes anything anywhere", () => {
    for (const name of CHECKPOINT_TOOL_NAMES) assert.equal(tierForTool(name), "read", name);
    assert.deepEqual(riskForTool(CHECKPOINT_TOOL_NAME), { tier: "read", idempotent: false, openWorld: false });
    assert.deepEqual(riskForTool(REWIND_TOOL_NAME), { tier: "read", idempotent: false, openWorld: false });
  });

  it("every catalog row equals its live definition, description and parameters both", () => {
    const rows: Array<[string, string, unknown]> = [
      [CHECKPOINT_TOOL_NAME, CHECKPOINT_DESCRIPTION, CHECKPOINT_PARAMETERS],
      [REWIND_TOOL_NAME, REWIND_DESCRIPTION, REWIND_PARAMETERS],
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
  it("costs 480 tokens if the pair ever goes resident, and 0 today", () => {
    const each: Record<string, [number, number]> = { checkpoint: [250, 1001], rewind: [231, 926] };
    for (const [name, [tokens, bytes]] of Object.entries(each)) {
      const m = measureToolset([name]);
      assert.equal(m.complete, true, name);
      assert.equal(m.tokens, tokens, name);
      assert.equal(m.bytes, bytes, name);
    }
    const pair = measureToolset([...CHECKPOINT_TOOL_NAMES]);
    assert.equal(pair.tokens, 480);
    assert.equal(pair.bytes, 1926);
    // P10.7 (ticket 12): 1423 until this line was last touched, and 2062 now.
    // The resident total MOVED for the first time since P10.4, because
    // `web_search` (314 alone) and `web_fetch` (326 alone) were made RESIDENT
    // rather than mounted — 639 together, since array wrapping means the pair
    // is not the sum of the two. Nothing about this file's tool moved; this
    // line prices the surface it is being compared against.
    assert.equal(measureToolset(DEFAULT_RESIDENT_TOOLS).tokens, 2255);
  });

  // The registration site, and the structural rule at it: what `loadTools`
  // hands these two is a view that reads. If a later edit passed it a restore
  // function, the first assertion below would still pass and the ones in the
  // first describe of this file would fail — which is the order you want.
  it("registers both through loadTools, so tool_call can reach them", async () => {
    const { loadTools } = await import("./session-tools.js");
    const loaded = loadTools([], {
      cwd: process.cwd(),
      gate: { request: async () => "allow" } as never,
      modelProvider: "",
      modelId: "",
    });
    for (const name of CHECKPOINT_TOOL_NAMES) {
      assert.ok(loaded.customTools.some((t) => t.name === name), `${name} is not registered`);
      assert.equal(loaded.activeToolNames.includes(name), false, `${name} must stay off the wire`);
    }
    assert.deepEqual(loaded.checkpointProposals, { marks: [], returns: [], markRefusals: 0 });
    loaded.lsp.shutdownAll();
    await loaded.jobs.stopAll();
    await loaded.evalRuntimes.disposeAll();
  });
});
