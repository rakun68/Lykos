// T180: the floor's arithmetic and the result line, below the session seam.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { firstPositional, RUN_VALUED_FLAGS } from "../cli/args.js";
import { loadConfig } from "../config/load.js";
import { containmentFloor, formatContainmentResult, resolveContainmentRequest } from "./request.js";

function world(user?: string, project?: string) {
  const root = mkdtempSync(join(tmpdir(), "lykos-floor-"));
  const globalDir = join(root, "global");
  const cwd = join(root, "project");
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(join(cwd, ".lykos"), { recursive: true });
  if (user !== undefined) writeFileSync(join(globalDir, "config.yaml"), user);
  if (project !== undefined) writeFileSync(join(cwd, ".lykos", "config.yaml"), project);
  return { cwd, globalDir, userPath: join(globalDir, "config.yaml"), projectPath: join(cwd, ".lykos", "config.yaml") };
}

describe("containment.minimum (T180)", () => {
  it("is off, which is no floor, until a file sets it", () => {
    const w = world();
    const { resolved, layers } = loadConfig({ cwd: w.cwd, globalDir: w.globalDir, env: {} });
    assert.equal(resolved.containment.minimum, "off");
    assert.equal(containmentFloor(resolved, layers), undefined);
  });

  it("is the higher of the user's and the project's, and names the file that set the winner", () => {
    const w = world("containment:\n  minimum: required\n", "containment:\n  minimum: auto\n");
    const { resolved, layers } = loadConfig({ cwd: w.cwd, globalDir: w.globalDir, env: {} });
    assert.deepEqual(containmentFloor(resolved, layers), { level: "required", source: w.userPath });
    const swapped = world("containment:\n  minimum: auto\n", "containment:\n  minimum: required\n");
    const loaded = loadConfig({ cwd: swapped.cwd, globalDir: swapped.globalDir, env: {} });
    assert.deepEqual(containmentFloor(loaded.resolved, loaded.layers), { level: "required", source: swapped.projectPath });
  });

  it("a flag cannot raise or lower it: only the two files are read", () => {
    const w = world("containment:\n  minimum: auto\n");
    const { resolved } = loadConfig({ cwd: w.cwd, globalDir: w.globalDir, env: {}, flags: { containment: { minimum: "off" } } });
    assert.equal(resolved.containment.minimum, "auto");
  });

  it("a level at or above the floor is allowed, and one below is refused naming where it came from", () => {
    const w = world(undefined, "containment:\n  minimum: auto\n  level: off\n");
    const { resolved, layers } = loadConfig({ cwd: w.cwd, globalDir: w.globalDir, env: {} });
    const refused = resolveContainmentRequest({ config: resolved, layers, delegated: true });
    assert.equal(refused.ok, false);
    assert.ok(!refused.ok && refused.message.includes(`"off" (from ${w.projectPath})`), !refused.ok ? refused.message : "");
    const raised = loadConfig({ cwd: w.cwd, globalDir: w.globalDir, env: {}, flags: { containment: { level: "required" } } });
    assert.equal(resolveContainmentRequest({ config: raised.resolved, layers: raised.layers, delegated: true }).ok, true);
  });
});

describe("the containment line of a result (T180)", () => {
  it("names the level used and the runtime", () => {
    assert.equal(
      formatContainmentResult({ requested: "auto", used: "auto", runtime: "podman", runtimeVersion: "5.1.0", image: "lykos/toolchain:abc" }),
      "containment: auto in podman 5.1.0, image lykos/toolchain:abc",
    );
  });
  it("says so when an auto fell back", () => {
    assert.match(formatContainmentResult({ requested: "auto", used: "off" }), /off \(requested auto; no container runtime was available/);
  });
});

describe("lykos run's flags (T180)", () => {
  it("--containment and --network consume their value, so it is not taken for the brief", () => {
    assert.equal(firstPositional(["--containment", "required", "--network", "none", "fix the bug"], RUN_VALUED_FLAGS), "fix the bug");
  });
});
