// Which of a project's own command fields, and which of its containment levels, an untrusted delegated session
// ignores. Real config files and real layers; the seam is the pair of functions the session calls between
// loading config and booting. The session-level proof that nothing runs is in
// cli/scripted-untrusted-project-commands.test.ts.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "./load.js";
import { skippedLabel, withoutUntrustedProjectContainmentLowering, withoutUntrustedProjectHostCommands } from "./project-extensions.js";

function setup(project: string, global = ""): { cwd: string; globalDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "lykos-phc-ws-"));
  const globalDir = mkdtempSync(join(tmpdir(), "lykos-phc-global-"));
  mkdirSync(join(cwd, ".lykos"), { recursive: true });
  writeFileSync(join(cwd, ".lykos", "config.yaml"), project);
  writeFileSync(join(globalDir, "config.yaml"), global);
  return { cwd, globalDir };
}

const PROJECT_COMMANDS = `
hooks:
  - { event: pre_tool, command: "echo project" }
feedback: { command: "echo pe" }
gate: { command: "echo g", rerun_command: "echo r {files}" }
lsp:
  servers:
    typescript: { command: ./evil-ls, extensions: [".ts"] }
    extra: { command: ./other-ls, extensions: [".x"] }
eval: { python: ./py }
`;
const USER_COMMANDS = `
hooks:
  - { event: post_tool, command: "echo user" }
feedback: { command: "echo user-pe" }
gate: { command: "echo user-g" }
eval: { python: python3 }
`;

describe("withoutUntrustedProjectHostCommands (T194)", () => {
  it("falls back to the user's value per field, and a shipped lsp server the project re-declared comes back", () => {
    const { cwd, globalDir } = setup(PROJECT_COMMANDS, USER_COMMANDS);
    const { resolved, layers } = loadConfig({ cwd, globalDir, env: {} });
    const out = withoutUntrustedProjectHostCommands({ config: resolved, layers, cwd, trusted: false });
    assert.deepEqual(out.config.hooks, [{ event: "post_tool", command: "echo user" }]);
    assert.equal(out.config.feedback.command, "echo user-pe");
    assert.equal(out.config.gate.command, "echo user-g");
    assert.equal(out.config.gate.rerun_command, "");
    assert.equal(out.config.eval.python, "python3");
    assert.equal(out.config.lsp.servers.typescript?.command, "typescript-language-server");
    assert.equal(out.config.lsp.servers.extra, undefined);
    assert.deepEqual(out.skipped.map(skippedLabel), [
      "project hooks[0] (pre_tool): command withheld",
      "project feedback.command withheld",
      "project gate.command withheld",
      "project gate.rerun_command withheld",
      "project lsp.servers.typescript: command withheld",
      "project lsp.servers.extra: command withheld",
      "project eval.python withheld",
    ]);
  });

  it("a trusted project keeps every field; an untrusted project that sets none loses nothing", () => {
    const { cwd, globalDir } = setup(PROJECT_COMMANDS, USER_COMMANDS);
    const { resolved, layers } = loadConfig({ cwd, globalDir, env: {} });
    const kept = withoutUntrustedProjectHostCommands({ config: resolved, layers, cwd, trusted: true });
    assert.equal(kept.config, resolved);
    assert.deepEqual(kept.skipped, []);
    const empty = setup("", USER_COMMANDS);
    const loaded = loadConfig({ cwd: empty.cwd, globalDir: empty.globalDir, env: {} });
    const out = withoutUntrustedProjectHostCommands({ config: loaded.resolved, layers: loaded.layers, cwd: empty.cwd, trusted: false });
    assert.deepEqual(out.config, loaded.resolved);
    assert.deepEqual(out.skipped, []);
  });

  it("a later layer that is not the project's wins the field, so the project's value is not in force and is not reported", () => {
    const { cwd, globalDir } = setup(PROJECT_COMMANDS, "");
    const { resolved, layers } = loadConfig({ cwd, globalDir, env: {}, flags: { gate: { command: "echo caller" } } });
    const out = withoutUntrustedProjectHostCommands({ config: resolved, layers, cwd, trusted: false });
    assert.equal(out.config.gate.command, "echo caller");
    assert.ok(!out.skipped.map(skippedLabel).includes("project gate.command withheld"));
  });

  it("an empty project value is not a command and is left alone", () => {
    const { cwd, globalDir } = setup('gate: { command: "" }\nfeedback: { command: "  " }\nhooks: []\n', USER_COMMANDS);
    const { resolved, layers } = loadConfig({ cwd, globalDir, env: {} });
    const out = withoutUntrustedProjectHostCommands({ config: resolved, layers, cwd, trusted: false });
    assert.deepEqual(out.skipped, []);
    assert.equal(out.config.gate.command, "");
  });
});

describe("withoutUntrustedProjectContainmentLowering (T194)", () => {
  it("a project level below the user's is removed from the layers and the config; a raise or a tie is kept", () => {
    const user = setup("containment: { level: off }\n", "containment: { level: auto }\n");
    const lowered = loadConfig({ cwd: user.cwd, globalDir: user.globalDir, env: {} });
    const out = withoutUntrustedProjectContainmentLowering({ config: lowered.resolved, layers: lowered.layers, cwd: user.cwd, trusted: false });
    assert.equal(out.config.containment.level, "auto");
    assert.equal(out.layers.find((l) => l.name === "project")?.value.containment?.level, undefined);
    assert.deepEqual(out.skipped.map(skippedLabel), ["project containment.level: off withheld (kept auto)"]);

    for (const [project, global] of [["required", "auto"], ["auto", "auto"]] as const) {
      const w = setup(`containment: { level: ${project} }\n`, `containment: { level: ${global} }\n`);
      const l = loadConfig({ cwd: w.cwd, globalDir: w.globalDir, env: {} });
      const same = withoutUntrustedProjectContainmentLowering({ config: l.resolved, layers: l.layers, cwd: w.cwd, trusted: false });
      assert.equal(same.config, l.resolved);
      assert.deepEqual(same.skipped, []);
    }
  });

  it("a caller's flag and a trusted project are never touched", () => {
    const w = setup("containment: { level: off }\n", "");
    const flagged = loadConfig({ cwd: w.cwd, globalDir: w.globalDir, env: {}, flags: { containment: { level: "off" } } });
    assert.deepEqual(withoutUntrustedProjectContainmentLowering({ config: flagged.resolved, layers: flagged.layers, cwd: w.cwd, trusted: false }).skipped, []);
    const plain = loadConfig({ cwd: w.cwd, globalDir: w.globalDir, env: {} });
    assert.deepEqual(withoutUntrustedProjectContainmentLowering({ config: plain.resolved, layers: plain.layers, cwd: w.cwd, trusted: true }).skipped, []);
    // T219: with no user config, default is off; project level: off equals floor off and is not withheld
    assert.deepEqual(withoutUntrustedProjectContainmentLowering({ config: plain.resolved, layers: plain.layers, cwd: w.cwd, trusted: false }).skipped, []);
  });

  it("skippedLabel formats gate discovery with host command notice (T219)", () => {
    assert.equal(
      skippedLabel({ kind: "gate-discovery", command: "npm test" }),
      'project gate check "npm test" (discovered from the project) withheld (commands run on the host)',
    );
  });
});
