// Where a delegated session's work lands.
//
// Seam: the real session engine (`runStandaloneTask`) and the real work-target code `lykos run` and
// the MCP child share (`withWorkTarget`), against a scripted model and a stand-in container runtime.
// The repository, the worktree and the branch are real git. What a caller sees is checked from the
// outside: its tree, `git branch`, the worktree directory, and the result.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { InteractionMode } from "../gate/modes.js";
import type { TrustSource } from "../gate/trust.js";
import { withWorkTarget, type WorkReport } from "../delegate/work-target.js";
import { runStandaloneTask, type RunStandaloneTaskResult } from "../session/session.js";
import { standInRuntime } from "./scripted-container.js";
import { call, captureStdout, lastToolResult, mounted, reply, say, SCRIPTED_MODEL, scriptedPiHost, scriptedWorld, type ScriptStep } from "./scripted-session.js";
import { runShow } from "./show.js";

const QUIET = `feedback:\n  enabled: false\ngate:\n  enabled: false\n`;
const FILES = { "src/a.ts": "export const a = 1;\n" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});
const worktreesRoot = (): string => {
  const d = mkdtempSync(join(tmpdir(), "lykos-wt-root-"));
  roots.push(d);
  return d;
};

async function delegate(opts: {
  script: ScriptStep[];
  mode?: InteractionMode;
  readOnly?: boolean;
  writeInPlace?: boolean;
  repo?: boolean;
  sessionId?: string;
  config?: string;
  subagents?: boolean;
  /** How the project was trusted. A project's own extensions load only when the user store trusts it (T183). */
  trustSource?: TrustSource;
  /** Runs once the project exists, before the call. */
  prepare?: (workspace: string) => void;
}) {
  const world = await scriptedWorld({ files: FILES, config: opts.config ?? QUIET, script: opts.script, ...(opts.repo !== undefined ? { repo: opts.repo } : {}) });
  opts.prepare?.(world.workspace);
  const runtime = standInRuntime();
  const root = worktreesRoot();
  const sessionId = opts.sessionId ?? "sess-1";
  const mode = opts.mode ?? "auto";
  const run = await withWorkTarget(
    {
      workspace: world.workspace,
      interactionMode: mode,
      sessionId,
      worktreesRoot: root,
      ...(opts.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
      ...(opts.writeInPlace !== undefined ? { writeInPlace: opts.writeInPlace } : {})
    },
    (target) =>
      runStandaloneTask({
        workspace: world.workspace,
        ledgerPath: world.ledgerPath,
        prompt: "Do the scripted task.",
        model: SCRIPTED_MODEL,
        nativeProviders: [world.provider],
        delegated: true,
        interactionMode: mode,
        sessionId,
        containmentLevel: "auto",
        containmentDrivers: [runtime.driver],
        ...(opts.readOnly !== undefined ? { readOnly: opts.readOnly } : {}),
        ...(opts.subagents === true ? { subagents: true } : {}),
        ...(opts.trustSource !== undefined ? { trustSource: opts.trustSource } : {}),
        ...target,
      }),
  );
  const starts = runtime.operations.flatMap((op) => (op.op === "start" ? [op.spec] : []));
  return { world, runtime, root, sessionId, run, starts, worktree: join(root, "proj-id-unknown") };
}

const writeAndCommit = (path = "src/a.ts", content = "export const a = 2;\n"): ScriptStep[] => [
  reply(call("write", { path, content })),
  reply(call("commit", { message: "Change a" })),
  reply(say("done")),
];

function resultOf(run: Awaited<ReturnType<typeof delegate>>["run"]): { result: RunStandaloneTaskResult; work: WorkReport } {
  if (!run.ok) throw new Error(run.message);
  return { result: run.value, work: run.work };
}

describe("a writing delegated session works on its own worktree and branch (T184, stories 42-45)", () => {
  it("leaves the caller's tree untouched and returns a branch whose commits hold the work", async () => {
    const d = await delegate({ script: writeAndCommit(), mode: "auto" });
    const { result, work } = resultOf(d.run);
    assert.equal(result.status, "ok", JSON.stringify(result));
    const ws = d.world.workspace;

    assert.equal(work.branch, "lykos/sess-1");
    assert.deepEqual(work.commits?.map((c) => c.subject), ["Change a"]);
    assert.equal(work.inPlace, undefined);
    assert.equal(readFileSync(join(ws, "src", "a.ts"), "utf8"), "export const a = 1;\n", "the caller's file is as it was");
    assert.equal(git(ws, "status", "--porcelain"), "", "the caller's tree is clean");
    assert.equal(git(ws, "rev-parse", "--abbrev-ref", "HEAD"), "main", "the caller's branch did not move");
    assert.equal(git(ws, "show", "lykos/sess-1:src/a.ts"), "export const a = 2;", "the work is on the branch");
    assert.equal(result.status === "ok" ? result.sessionId : "", "sess-1", "the session carries the id the branch is named from");
  });

  it("removes the worktree when the call ends and keeps the branch", async () => {
    const d = await delegate({ script: writeAndCommit(), mode: "auto" });
    resultOf(d.run);
    const listed = git(d.world.workspace, "worktree", "list", "--porcelain");
    assert.equal(listed.includes("sess-1"), false, "git lists no worktree");
    const spec = d.starts[0]!;
    assert.equal(existsSync(spec.workspace), false, "the directory the container was given is gone");
    assert.ok(spec.workspace.startsWith(d.root), "it was under the worktrees root, outside the project");
    assert.match(git(d.world.workspace, "branch", "--list", "lykos/sess-1"), /lykos\/sess-1/);
  });

  it("`lykos show` still finds each turn's checkpoint once the worktree is gone", async () => {
    const d = await delegate({ script: writeAndCommit(), mode: "auto" });
    resultOf(d.run);
    assert.equal(existsSync(d.starts[0]!.workspace), false, "the worktree the session ran in is gone");
    const shown = captureStdout("lykos show", () => runShow(d.world.ledgerPath, d.sessionId, {}));
    assert.match(shown, /edits\s+1 turn\(s\) changed files; every one has a checkpoint/);
    assert.match(shown, /turn 0 {2}src\/a\.ts {2}checkpoint [0-9a-f]{8}/);
  });

  it("mounts the worktree at /work with the main repository's git directory read-only beside it", async () => {
    const d = await delegate({ script: writeAndCommit(), mode: "auto" });
    resultOf(d.run);
    const spec = d.starts[0]!;
    assert.equal(spec.mount, "rw");
    assert.notEqual(spec.workspace, d.world.workspace, "the container works on the worktree, not the caller's tree");
    assert.deepEqual(spec.readonlyMounts?.map((m) => m.target), ["/lykos-git"]);
    assert.equal(spec.readonlyMounts?.[0]?.source.replaceAll("\\", "/").endsWith("/.git"), true, spec.readonlyMounts?.[0]?.source);
  });

  it("the interaction mode is the one input that decides: `auto` writes with nobody to ask, `manual` is refused by the gate", async () => {
    let refusal: ReturnType<typeof lastToolResult> | undefined;
    const manual = await delegate({
      mode: "manual",
      script: [
        reply(call("write", { path: "src/a.ts", content: "export const a = 9;\n" })),
        (context) => {
          refusal = lastToolResult(context);
          return reply(say("could not"));
        },
      ],
    });
    resultOf(manual.run);
    assert.equal(refusal?.isError, true, "a gated write with no one to ask is refused");
    assert.deepEqual(resultOf(manual.run).work.commits ?? [], []);
    assert.equal(git(manual.world.workspace, "branch", "--list", "lykos/*").includes("sess-1"), true, "the branch exists even when the session did nothing");
  });
});

describe("what the session sees and keeps while it works in a worktree (T184 review)", () => {
  it("session_end sees the worktree's changes, and a memory proposal is kept at the project's root after the worktree is gone", async () => {
    const seen = join(worktreesRoot(), "session-end.json");
    const pkg = join(scriptedPiHost(), "npm", "node_modules", "wt-probe");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "wt-probe", version: "1.0.0", lykos: { extensions: ["./main.js"] } }));
    writeFileSync(
      join(pkg, "main.js"),
      `import { writeFileSync } from "node:fs";
export default { name: "wt-probe", register(api) { api.on("session_end", (end) => { writeFileSync(${JSON.stringify(seen)}, JSON.stringify(end.diff.files.map((f) => f.path))); }); } };
`,
    );
    // The probe is the project's own extension, so the project is trusted in the user store, as a caller who wants it loaded has it.
    const d = await delegate({
      mode: "auto",
      trustSource: "stored",
      config: `${QUIET}lykos_extensions:\n  - name: wt-probe\n    version: 1.0.0\n`,
      script: [
        reply(call("write", { path: "src/a.ts", content: "export const a = 4;\n" })),
        reply(mounted("retain", { memory: "The worktree is removed with the call, so state kept there is lost." })),
        reply(say("done")),
      ],
    });
    const { result, work } = resultOf(d.run);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.deepEqual(JSON.parse(readFileSync(seen, "utf8")), ["src/a.ts"], "session_end's diff is the worktree's, where the work is");
    const proposals = join(d.world.workspace, ".lykos", "memory", "proposed.md");
    assert.match(readFileSync(proposals, "utf8"), /state kept there is lost/, "the proposal is at the project's root");
    assert.equal(existsSync(d.starts[0]!.workspace), false, "and the worktree it would have been lost with is gone");
    assert.equal(work.branch !== undefined, true);
  });
});

describe("a subagent of a worktree session (T184 review)", () => {
  it("works on the worktree and keeps its memory proposal at the project's root, where the parent's goes", async () => {
    const d = await delegate({
      mode: "auto",
      subagents: true,
      prepare: (workspace) => {
        mkdirSync(join(workspace, ".lykos", "specialists"), { recursive: true });
        writeFileSync(join(workspace, ".lykos", "specialists", "noter.yaml"), "description: writes a memory proposal\ntools_add: [retain]\n");
      },
      script: [
        reply(mounted("agent", { prompt: "note something down", description: "note something", subagent_type: "noter" })),
        reply(mounted("retain", { memory: "A subagent's proposal must outlive the worktree it ran in." })),
        reply(say("child done")),
        reply(say("done")),
      ],
    });
    const { result } = resultOf(d.run);
    assert.equal(result.status, "ok", JSON.stringify(result));
    const spawned = result.status === "ok" ? result.snapshot.toolCalls?.[0]?.result : undefined;
    assert.match(JSON.stringify(spawned), /\(noter\) finished/, "the subagent ran, as the specialist the project defines");
    const proposals = join(d.world.workspace, ".lykos", "memory", "proposed.md");
    assert.match(readFileSync(proposals, "utf8"), /outlive the worktree/, "the proposal is at the project's root");
    assert.equal(existsSync(d.starts[0]!.workspace), false, "and the worktree it would have been lost with is gone");
  });
});

describe("write_in_place (T184, story 48)", () => {
  it("changes the caller's tree directly, on no branch of its own, and says so", async () => {
    const d = await delegate({ script: writeAndCommit(), mode: "auto", writeInPlace: true });
    const { result, work } = resultOf(d.run);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(readFileSync(join(d.world.workspace, "src", "a.ts"), "utf8"), "export const a = 2;\n");
    assert.equal(work.branch, undefined);
    assert.equal(work.inPlace, true);
    assert.match(work.note ?? "", /write_in_place/);
    assert.equal(git(d.world.workspace, "branch", "--list", "lykos/*"), "", "no branch was made");
    assert.equal(git(d.world.workspace, "log", "-1", "--format=%s"), "Change a", "the commit is on the caller's branch");
    assert.equal(d.starts[0]!.workspace, d.world.workspace, "the container mounts the caller's tree");
    assert.equal(d.starts[0]!.readonlyMounts, undefined);
  });
});

describe("without a repository (T184, stories 77-79)", () => {
  it("a writing call refuses, naming write_in_place, and starts no session", async () => {
    const d = await delegate({ script: [reply(say("never"))], mode: "auto", repo: false });
    const message = d.run.ok ? "" : d.run.message;
    assert.equal(d.run.ok, false);
    assert.match(message, /write_in_place/);
    assert.match(message, /not a git repository/);
    assert.equal(d.world.modelCalls(), 0, "no model call was made");
    assert.equal(d.runtime.operations.filter((o) => o.op === "start").length, 0, "no container was started");
  });

  it("write_in_place lets it write there, with no commit tool, and the result says what was given up", async () => {
    const d = await delegate({
      mode: "auto",
      repo: false,
      writeInPlace: true,
      script: [reply(call("write", { path: "src/a.ts", content: "export const a = 3;\n" })), reply(say("done"))],
    });
    const { result, work } = resultOf(d.run);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.equal(readFileSync(join(d.world.workspace, "src", "a.ts"), "utf8"), "export const a = 3;\n");
    assert.equal(work.inPlace, true);
    assert.equal(work.branch, undefined);
    assert.equal(work.commits, undefined);
    assert.match(work.note ?? "", /no commits/);
    assert.equal(d.world.sent[0]!.tools?.some((t) => t.name === "commit"), false, "the model is not offered a commit it cannot make");
  });

  it("a read-only call proceeds: no worktree, no git needed, a read-only mount", async () => {
    const d = await delegate({ readOnly: true, repo: false, script: [reply(call("read", { path: "src/a.ts" })), reply(say("looked"))] });
    const { result, work } = resultOf(d.run);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.deepEqual(work, {});
    const wire = (d.world.sent[0]!.tools ?? []).map((t) => t.name);
    assert.ok(wire.every((n) => ["read", "grep", "find", "ls"].includes(n)), wire.join(","));
    assert.equal(d.starts[0]!.mount, "ro");
    assert.equal(d.starts[0]!.workspace, d.world.workspace);
  });

  it("a read-only call in a repository has a read-only mount and no worktree either", async () => {
    const d = await delegate({ readOnly: true, script: [reply(say("looked"))] });
    resultOf(d.run);
    assert.equal(d.starts[0]!.mount, "ro");
    assert.equal(git(d.world.workspace, "branch", "--list", "lykos/*"), "");
    assert.equal(git(d.world.workspace, "worktree", "list").split("\n").length, 1);
  });
});
