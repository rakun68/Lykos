// T239: the P18 roles run as specialists on Boxie's models; a reviewer of the implementer's family resolves to
// its alternate; `lykos config roles` shows each role's model and the layer that set it.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { configRoles } from "../cli/config-show.js";
import { resolveBootModel } from "./providers.js";
import { SHIPPED_DEFAULTS } from "./defaults.js";
import { loadConfig } from "./load.js";
import { resolveSpecialist } from "./specialists.js";
import { modelFamily, P18_ROLES, reviewerRole, sessionRoleModel } from "./roles.js";

function sandbox(projectYaml?: string, globalYaml?: string): { cwd: string; globalDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "lykos-t239-"));
  const globalDir = join(mkdtempSync(join(tmpdir(), "lykos-t239-home-")), ".lykos");
  mkdirSync(globalDir, { recursive: true });
  if (projectYaml !== undefined) {
    mkdirSync(join(cwd, ".lykos"), { recursive: true });
    writeFileSync(join(cwd, ".lykos", "config.yaml"), projectYaml);
  }
  if (globalYaml !== undefined) writeFileSync(join(globalDir, "config.yaml"), globalYaml);
  return { cwd, globalDir };
}

const BOXIE = {
  implement: "omniroute/antigravity/gemini-3.8-flash-high",
  quick: "opencode/deepseek-v4.1-flash-free",
  "review-both": "omniroute/deepseek/deepseek-flash-high",
};

describe("T239: each role runs as a specialist on its Boxie model", () => {
  for (const role of P18_ROLES) {
    it(`${role} is a shipped specialist and boots on ${BOXIE[role]}`, () => {
      const { cwd, globalDir } = sandbox();
      const spec = resolveSpecialist(role, cwd, globalDir);
      assert.equal(spec.file.model, undefined, "the file names no model of its own, so its role's applies");
      const { resolved } = loadConfig({ cwd, globalDir, env: {} });
      const roleModel = sessionRoleModel(resolved.models.roles, role);
      const boot = resolveBootModel({ defaultModel: resolved.models.default, ...(roleModel !== undefined ? { roleModel } : {}) });
      assert.equal(boot.spec, BOXIE[role]);
      assert.ok(resolved.models.roles[`${role}-alt`], `${role} has an alternate`);
    });
  }

  it("a specialist with no role of its name keeps the worker model", () => {
    assert.equal(sessionRoleModel(SHIPPED_DEFAULTS.models.roles, "explore"), SHIPPED_DEFAULTS.models.roles.worker);
    assert.equal(sessionRoleModel(SHIPPED_DEFAULTS.models.roles, undefined), SHIPPED_DEFAULTS.models.roles.worker);
  });

  it("the caller's model still wins over the role's", () => {
    const boot = resolveBootModel({ callerModel: "deepseek/deepseek-v4-pro", defaultModel: "x", roleModel: BOXIE.implement });
    assert.equal(boot.spec, "deepseek/deepseek-v4-pro");
  });
});

describe("T239: a reviewer of the implementer's family resolves to its alternate", () => {
  const roles = SHIPPED_DEFAULTS.models.roles;

  it("review-both on DeepSeek reviewing DeepSeek's code becomes review-both-alt", () => {
    const choice = reviewerRole(roles, "review-both", "omniroute/deepseek/deepseek-flash-max");
    assert.equal(choice.role, "review-both-alt");
    assert.equal(choice.model, roles["review-both-alt"]);
    assert.match(choice.reason ?? "", /deepseek/);
  });

  it("another family keeps review-both", () => {
    assert.equal(reviewerRole(roles, "review-both", BOXIE.implement).role, "review-both");
  });

  it("an alternate of the same family is no help: the main role stays", () => {
    assert.equal(reviewerRole({ "review-both": "deepseek/a", "review-both-alt": "deepseek/b" }, "review-both", "deepseek/c").role, "review-both");
  });

  it("families come from the vendor, not the router", () => {
    assert.equal(modelFamily("omniroute/antigravity/claude-opus-4-6-thinking"), "anthropic");
    assert.equal(modelFamily("opencode/deepseek-v4.1-flash-free"), "deepseek");
    assert.equal(modelFamily("omniroute/antigravity/gemini-3.8-flash-high"), "google");
    assert.equal(modelFamily("cx/gpt-5.5"), "openai");
  });
});

describe("T239: lykos config roles shows the mapping and where each value came from", () => {
  it("defaults, a global override and a project override each name their layer", () => {
    const { cwd, globalDir } = sandbox('models:\n  roles:\n    quick: "deepseek/deepseek-v4-flash"\n', 'models:\n  roles:\n    implement: "anthropic/claude-sonnet-4-5"\n');
    const byRole = new Map(configRoles(cwd, { globalDir, env: {} }).map((m) => [m.role, m]));
    assert.equal(byRole.get("review-both")?.source, "defaults");
    assert.equal(byRole.get("implement")?.model, "anthropic/claude-sonnet-4-5");
    assert.match(byRole.get("implement")?.source ?? "", /^global \(/);
    assert.equal(byRole.get("quick")?.model, "deepseek/deepseek-v4-flash");
    assert.match(byRole.get("quick")?.source ?? "", /^project \(/);
  });
});
