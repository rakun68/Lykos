import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { killProcessTree } from "../tools/job-runner.js";
import { osProcessAlive, waitForOsProcess } from "../tools/process-probe.js";
import {
  builtinHooks,
  spawnHookCommand,
  candidateBodies,
  detectSecrets,
  HookRegistry,
  hookFailureNotice,
  hookRejectionNotice,
  protectedPathReason,
  protectedPathsHook,
  resolveHookDecls,
  secretsHook,
  type Hook,
  type HookCommandRunner,
} from "./hooks.js";

const ctx = (over: Record<string, unknown> = {}) => ({ cwd: "/repo", ...over });

describe("HookRegistry", () => {
  it("runs hooks for its event only", async () => {
    const registry = new HookRegistry();
    const fired: string[] = [];
    const hook = (name: string, event: Hook["event"]): Hook => ({
      name,
      event,
      run: () => {
        fired.push(name);
        return { action: "continue" };
      },
    });
    registry.register(hook("a", "pre_tool"));
    registry.register(hook("b", "post_tool"));
    await registry.run("pre_tool", ctx());
    assert.deepEqual(fired, ["a"]);
  });

  it("narrows by tool when the hook names tools", async () => {
    const registry = new HookRegistry();
    let ran = 0;
    registry.register({
      name: "writes-only",
      event: "pre_tool",
      tools: ["write"],
      run: () => {
        ran += 1;
        return { action: "continue" };
      },
    });
    await registry.run("pre_tool", ctx({ toolName: "read" }));
    assert.equal(ran, 0);
    await registry.run("pre_tool", ctx({ toolName: "write" }));
    assert.equal(ran, 1);
  });

  it("stops at the first deny and reports which hook denied", async () => {
    const registry = new HookRegistry();
    let secondRan = false;
    registry.register({ name: "first", event: "pre_tool", run: () => ({ action: "deny", reason: "no" }) });
    registry.register({
      name: "second",
      event: "pre_tool",
      run: () => {
        secondRan = true;
        return { action: "continue" };
      },
    });
    const result = await registry.run("pre_tool", ctx());
    assert.deepEqual(result.denied, { hook: "first", reason: "no" });
    assert.equal(secondRan, false, "a call that is not going to happen must not run more policies");
  });

  it("collects notes in registration order", async () => {
    const registry = new HookRegistry();
    registry.register({ name: "one", event: "post_tool", run: () => ({ action: "note", note: "n1" }) });
    registry.register({ name: "two", event: "post_tool", run: () => ({ action: "note", note: "n2" }) });
    const result = await registry.run("post_tool", ctx());
    assert.deepEqual(result.notes.map((n) => n.note), ["n1", "n2"]);
    assert.equal(registry.counters.notes, 2);
  });

  it("skips a hook that throws rather than taking the session with it", async () => {
    const registry = new HookRegistry();
    registry.register({
      name: "broken",
      event: "pre_tool",
      run: () => {
        throw new Error("policy is broken");
      },
    });
    registry.register({ name: "fine", event: "pre_tool", run: () => ({ action: "note", note: "ok" }) });
    const result = await registry.run("pre_tool", ctx());
    assert.equal(result.denied, undefined);
    assert.deepEqual(result.notes.map((n) => n.note), ["ok"]);
  });

  // P10.9 (ticket 21, D3) — defect D12. Skipping was always right; leaving no
  // evidence was not.
  it("counts a throwing hook as having RUN, so it is not mistaken for one that never matched", async () => {
    const registry = new HookRegistry();
    registry.register({
      name: "broken",
      event: "pre_tool",
      run: () => {
        throw new Error("policy is broken");
      },
    });
    registry.register({
      name: "never-matches",
      event: "pre_tool",
      tools: ["write"],
      run: () => ({ action: "continue" }),
    });
    await registry.run("pre_tool", ctx({ toolName: "read" }));
    assert.equal(registry.counters.runs["broken"], 1, "it ran");
    assert.equal(registry.counters.runs["never-matches"], undefined, "it did not");
  });

  it("records the hook, the event and the message of every failure", async () => {
    const registry = new HookRegistry();
    registry.register({
      name: "broken",
      event: "post_tool",
      run: () => {
        throw new Error("policy is broken");
      },
    });
    await registry.run("post_tool", ctx());
    await registry.run("post_tool", ctx());
    assert.equal(registry.counters.failures, 2);
    assert.equal(registry.counters.failuresByHook["broken"], 2);
    assert.deepEqual(registry.counters.lastFailure, {
      hook: "broken",
      event: "post_tool",
      message: "policy is broken",
    });
    const notice = hookFailureNotice(registry.counters);
    assert.match(notice ?? "", /broken \(2\)/);
    assert.match(notice ?? "", /policy is NOT running/);
  });

  it("says nothing about failures when there were none", async () => {
    const registry = new HookRegistry();
    registry.register({ name: "fine", event: "turn_start", run: () => ({ action: "continue" }) });
    await registry.run("turn_start", ctx());
    assert.equal(registry.counters.failures, 0);
    assert.equal(hookFailureNotice(registry.counters), undefined);
  });

  it("counts runs per hook, so an unused policy is visible", async () => {
    const registry = new HookRegistry();
    registry.register({ name: "counted", event: "turn_start", run: () => ({ action: "continue" }) });
    await registry.run("turn_start", ctx());
    await registry.run("turn_start", ctx());
    assert.equal(registry.counters.runs["counted"], 2);
  });

  it("knows whether an event has any hook at all, so a caller can skip the work", () => {
    const registry = new HookRegistry();
    assert.equal(registry.has("pre_tool"), false);
    registry.register({ name: "x", event: "pre_tool", run: () => ({ action: "continue" }) });
    assert.equal(registry.has("pre_tool"), true);
  });
});

describe("protected paths", () => {
  it("refuses a write to the ledger — the one that matters most", () => {
    const why = protectedPathReason("/repo/.lykos/ledger.db");
    assert.match(String(why), /measurement layer/);
    assert.ok(protectedPathReason(".lykos/ledger.db-wal"));
    assert.ok(protectedPathReason(".lykos/ledger.db-journal"));
  });

  it("refuses a write into the session archive", () => {
    assert.ok(protectedPathReason(".lykos/sessions"));
    assert.ok(protectedPathReason(".lykos/sessions/abc/transcript.jsonl"));
  });

  it("leaves .git to the path-rule gate for the file tools and for bash alike (ADR-0042, T212)", async () => {
    assert.equal(protectedPathReason(".git/config"), undefined);
    for (const [toolName, input] of [
      ["write", { path: "/repo/.git/config" }],
      ["bash", { command: "echo x > .git/config" }],
      ["bash", { command: "tee .git/config" }],
    ] as const) {
      const r = await protectedPathsHook().run({ event: "pre_tool", cwd: "/repo", toolName, input });
      assert.equal(r.action, "continue", `${toolName} ${JSON.stringify(input)}`);
    }
    const ledger = await protectedPathsHook().run({ event: "pre_tool", cwd: "/repo", toolName: "bash", input: { command: "echo x > .lykos/ledger.db" } });
    assert.equal(ledger.action, "deny");
  });

  it("allows ordinary project files, including other things under .lykos", () => {
    assert.equal(protectedPathReason("lykos/session/session.ts"), undefined);
    assert.equal(protectedPathReason(".lykos/config.yaml"), undefined);
    assert.equal(protectedPathReason(".lykos/skills/finishing-work.md"), undefined);
    assert.equal(protectedPathReason(undefined), undefined);
  });

  it("denies rather than asks, with a reason that says what to do instead", async () => {
    const hook = protectedPathsHook();
    const outcome = await hook.run({
      event: "pre_tool",
      cwd: "/repo",
      toolName: "write",
      input: { path: "/repo/.lykos/ledger.db" },
    });
    assert.equal(outcome.action, "deny");
    assert.match((outcome as { reason: string }).reason, /let a human do it/);
  });

  it("is not consulted for a read — this rule is about writing", () => {
    assert.deepEqual(protectedPathsHook().tools, ["write", "edit", "multi_edit", "apply_patch", "bash"]);
  });

  it("sees protected paths in a real bash tool call", async () => {
    const outcome = await protectedPathsHook().run({
      event: "pre_tool",
      cwd: "/repo",
      toolName: "bash",
      input: { command: "sqlite3 .lykos/ledger.db 'UPDATE calls SET cost_usd = 0'" },
    });
    assert.equal(outcome.action, "deny");
    assert.match((outcome as { reason: string }).reason, /measurement layer/);
  });

  it("covers shell redirections and a session directory itself", async () => {
    for (const command of ['printf x >".lykos/ledger.db-journal"', "mkdir .lykos/sessions"]) {
      const outcome = await protectedPathsHook().run({
        event: "pre_tool",
        cwd: "/repo",
        toolName: "bash",
        input: { command },
      });
      assert.equal(outcome.action, "deny", command);
    }
  });
});

describe("the secrets check", () => {
  it("recognises the shapes that matter", () => {
    assert.deepEqual(detectSecrets("AKIAIOSFODNN7EXAMPLE"), ["AWS access key id"]);
    assert.deepEqual(detectSecrets("-----BEGIN RSA PRIVATE KEY-----"), ["private key block"]);
    assert.deepEqual(detectSecrets("token=ghp_abcdefghijklmnopqrstuvwxyz0123"), ["GitHub token"]);
    assert.deepEqual(detectSecrets("nothing to see"), []);
  });

  it("NOTES rather than denies, because the patterns have false positives", async () => {
    // A redaction test, a doc example and a fixture all contain credential
    // shapes on purpose. Blocking on a heuristic is T90's crying-wolf
    // detector with a worse consequence.
    const outcome = await secretsHook().run({
      event: "pre_tool",
      cwd: "/repo",
      toolName: "write",
      input: { path: "a.ts", content: "const k = 'AKIAIOSFODNN7EXAMPLE';" },
    });
    assert.equal(outcome.action, "note");
    assert.match((outcome as { note: string }).note, /fixture or an example/);
  });

  it("says nothing about a clean write", async () => {
    const outcome = await secretsHook().run({
      event: "pre_tool",
      cwd: "/repo",
      toolName: "write",
      input: { path: "a.ts", content: "export const x = 1;" },
    });
    assert.equal(outcome.action, "continue");
  });

  // Regression: the body of an edit is nested
  // inside an array, so the old top-level lookup could never see it and this
  // hook had never once fired on an edit.
  it("sees a credential inside an edit's edits[] entry", async () => {
    const outcome = await secretsHook().run({
      event: "pre_tool",
      cwd: "/repo",
      toolName: "edit",
      input: {
        path: "a.ts",
        edits: [{ oldText: "const k = '';", newText: "const k = '-----BEGIN RSA PRIVATE KEY-----';" }],
      },
    });
    assert.equal(outcome.action, "note");
    assert.match((outcome as { note: string }).note, /private key block/);
  });

  it("sees a credential in a LATER entry, not just the first", async () => {
    const outcome = await secretsHook().run({
      event: "pre_tool",
      cwd: "/repo",
      toolName: "edit",
      input: {
        path: "a.ts",
        edits: [
          { oldText: "x = 0", newText: "export const x = 1;" },
          { oldText: "y = 0", newText: "" },
          { oldText: "z = 0", newText: "token=ghp_abcdefghijklmnopqrstuvwxyz0123" },
        ],
      },
    });
    assert.equal(outcome.action, "note");
    assert.match((outcome as { note: string }).note, /GitHub token/);
  });

  it("sees a credential in a top-level new_string too", async () => {
    // T168 accepts `old_string`/`new_string` and converts it, but the hook sees the call as the model sent it.
    const outcome = await secretsHook().run({
      event: "pre_tool",
      cwd: "/repo",
      toolName: "edit",
      input: { path: "a.ts", old_string: "const k = '';", new_string: "const k = 'AKIAIOSFODNN7EXAMPLE';" },
    });
    assert.equal(outcome.action, "note");
    assert.match((outcome as { note: string }).note, /AWS access key id/);
  });

  it("names each credential shape once, however many entries carry it", async () => {
    const outcome = await secretsHook().run({
      event: "pre_tool",
      cwd: "/repo",
      toolName: "edit",
      input: {
        path: "a.ts",
        edits: [
          { oldText: "a = 0", newText: "a = 'AKIAIOSFODNN7EXAMPLE'" },
          { oldText: "b = 0", newText: "b = 'AKIAIOSFODNN7EXAMPLE'" },
        ],
      },
    });
    assert.equal(outcome.action, "note");
    assert.equal((outcome as { note: string }).note.match(/AWS access key id/g)?.length, 1);
  });

  it("still says nothing about a clean edit", async () => {
    const outcome = await secretsHook().run({
      event: "pre_tool",
      cwd: "/repo",
      toolName: "edit",
      input: { path: "a.ts", edits: [{ oldText: "export const x = 0;", newText: "export const x = 1;" }] },
    });
    assert.equal(outcome.action, "continue");
  });
});

describe("candidateBodies (defect D6)", () => {
  it("finds a top-level write body", () => {
    assert.deepEqual(candidateBodies({ path: "a.ts", content: "hello" }), ["hello"]);
  });

  it("finds every body in an array argument, in order", () => {
    assert.deepEqual(
      candidateBodies({ edits: [{ oldText: "a", newText: "one" }, { oldText: "b" }, { oldText: "c", newText: "two" }] }),
      ["one", "two"],
    );
  });

  it("ignores non-objects and non-strings rather than throwing on them", () => {
    assert.deepEqual(candidateBodies({ edits: [null, 7, "raw", { newText: 3 }, { newText: "ok" }] }), ["ok"]);
  });

  it("does not descend past one level of array", () => {
    // Bounded on purpose: model-supplied JSON is untrusted input, and every
    // shape this hook covers is a flat list of flat records.
    assert.deepEqual(candidateBodies({ outer: [{ inner: [{ text: "deep" }] }] }), []);
  });
});

describe("resolveHookDecls", () => {
  const runner =
    (result: { exitCode: number | null; output?: string; problem?: string }): HookCommandRunner =>
    () => ({
      exitCode: result.exitCode,
      output: result.output ?? "",
      ...(result.problem !== undefined ? { problem: result.problem } : {}),
    });

  it("rejects a malformed declaration with a reason instead of skipping it silently", () => {
    const resolved = resolveHookDecls([
      { event: "pre_tool", command: "true" },
      { command: "true" } as never,
      { event: "pre_tool", command: "  " },
    ]);
    assert.equal(resolved.hooks.length, 1);
    assert.equal(resolved.rejected.length, 2);
    assert.match(hookRejectionNotice(resolved)!, /hooks\[1\]: event must be one of/);
    assert.match(hookRejectionNotice(resolved)!, /hooks\[2\]: a hook needs a command/);
  });

  it("says nothing when everything loaded", () => {
    assert.equal(hookRejectionNotice(resolveHookDecls([{ event: "post_tool", command: "true" }])), undefined);
  });

  it("denies a pre_tool call when the command exits non-zero", async () => {
    const [hook] = resolveHookDecls(
      [{ event: "pre_tool", command: "check" }],
      runner({ exitCode: 1, output: "not on this branch" }),
    ).hooks;
    const outcome = await hook!.run({ event: "pre_tool", cwd: "/repo", toolName: "write" });
    assert.equal(outcome.action, "deny");
    assert.equal((outcome as { reason: string }).reason, "not on this branch");
  });

  it("annotates rather than denies when the hook is declared non-blocking", async () => {
    const [hook] = resolveHookDecls(
      [{ event: "pre_tool", command: "check", blocking: false }],
      runner({ exitCode: 1, output: "just so you know" }),
    ).hooks;
    const outcome = await hook!.run({ event: "pre_tool", cwd: "/repo", toolName: "write" });
    assert.equal(outcome.action, "note");
  });

  it("annotates on post_tool, where there is nothing left to deny", async () => {
    const [hook] = resolveHookDecls(
      [{ event: "post_tool", command: "check" }],
      runner({ exitCode: 3, output: "lint failed" }),
    ).hooks;
    const outcome = await hook!.run({ event: "post_tool", cwd: "/repo", toolName: "edit" });
    assert.equal(outcome.action, "note");
    assert.equal((outcome as { note: string }).note, "lint failed");
  });

  it("never denies because a hook command could not start", async () => {
    // A typo in config.yaml must not stop the agent from working.
    const [hook] = resolveHookDecls(
      [{ event: "pre_tool", command: "nope" }],
      runner({ exitCode: null, problem: "spawn ENOENT" }),
    ).hooks;
    const outcome = await hook!.run({ event: "pre_tool", cwd: "/repo", toolName: "write" });
    assert.equal(outcome.action, "note");
    assert.match((outcome as { note: string }).note, /failed to run/);
  });

  it("passes the context as environment, never as shell arguments", async () => {
    let seenEnv: NodeJS.ProcessEnv = {};
    let seenCommand = "";
    const [hook] = resolveHookDecls([{ event: "pre_tool", command: "check" }], (command, _cwd, _t, env) => {
      seenCommand = command;
      seenEnv = env;
      return { exitCode: 0, output: "" };
    }).hooks;
    await hook!.run({
      event: "pre_tool",
      cwd: "/repo",
      toolName: "write",
      // A path built by the model. As an argument this would be an injection
      // surface; as an environment variable it is inert.
      input: { path: "a.ts; rm -rf /" },
    });
    assert.equal(seenCommand, "check", "the command must be passed through unchanged");
    assert.equal(seenEnv["LYKOS_HOOK_PATH"], "a.ts; rm -rf /");
    assert.equal(seenEnv["LYKOS_HOOK_TOOL"], "write");
  });
});

describe("spawnHookCommand (D21)", () => {
  it("a timeout kills the command's grandchild, not only the shell", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-hook-kill-"));
    const grandPidFile = join(dir, "grand.pid");
    writeFileSync(
      join(dir, "grandchild.js"),
      `require('fs').writeFileSync(${JSON.stringify(grandPidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`,
      "utf8",
    );
    writeFileSync(
      join(dir, "child.js"),
      `require('child_process').spawn(process.execPath, [${JSON.stringify(join(dir, "grandchild.js"))}], { stdio: 'ignore' });\nsetInterval(() => {}, 1000);\n`,
      "utf8",
    );
    const readPid = (): number | undefined => {
      try {
        const n = Number(readFileSync(grandPidFile, "utf8").trim());
        return Number.isInteger(n) && n > 0 ? n : undefined;
      } catch {
        return undefined;
      }
    };

    const pending = spawnHookCommand(`node ${JSON.stringify(join(dir, "child.js"))}`, dir, 3000, {});
    let grandPid: number | undefined;
    const deadline = Date.now() + 20_000;
    while (grandPid === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      grandPid = readPid();
    }
    assert.ok(grandPid !== undefined, "the grandchild started");
    assert.equal(await osProcessAlive(grandPid), true, "grandchild is alive before the timeout");

    try {
      const result = await pending;
      assert.match(String(result.problem), /timeout after/);
      assert.equal(result.exitCode, null);
      assert.equal(await waitForOsProcess(grandPid, false), false, "the hook timeout left its grandchild running");
    } finally {
      await killProcessTree(grandPid);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe("builtinHooks", () => {
  it("ships the protected-path rule first, so a deny beats a note", () => {
    const names = builtinHooks().map((h) => h.name);
    assert.deepEqual(names, ["lykos:protected-paths", "lykos:secrets"]);
  });
});
