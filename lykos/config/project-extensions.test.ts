// A delegated session loads the project's own extensions only when the project is trusted in the
// user-level store. Real config files, real layers; the seam is the function the session calls between
// loading config and booting.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "./load.js";
import { projectPiPackages, skippedLabel, withoutUntrustedProjectCommands, withoutUntrustedProjectExtensions } from "./project-extensions.js";
import { resolveExtensions } from "./extensions.js";

function setup(project: string, global = ""): { cwd: string; globalDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "lykos-pe-ws-"));
  const globalDir = mkdtempSync(join(tmpdir(), "lykos-pe-global-"));
  mkdirSync(join(cwd, ".lykos"), { recursive: true });
  writeFileSync(join(cwd, ".lykos", "config.yaml"), project);
  writeFileSync(join(globalDir, "config.yaml"), global);
  return { cwd, globalDir };
}

const names = (decls: readonly { name: string }[]): string[] => decls.map((d) => d.name);

const PROJECT = `
extensions:
  - { name: pi-project-thing, version: 1.0.0, scope: [hop0] }
  - { name: lykos-prune }
  - { name: pi-user-thing, version: 2.0.0 }
lykos_extensions:
  - { name: lykos-project-thing, version: 3.0.0 }
`;
const GLOBAL = `
extensions:
  - { name: pi-user-thing, version: 2.0.0 }
`;

describe("withoutUntrustedProjectExtensions (T183)", () => {
  it("an untrusted project loses its own extensions, keeps default and user-level ones, and the skipped are named", () => {
    const { cwd, globalDir } = setup(PROJECT, GLOBAL);
    const { resolved, layers } = loadConfig({ cwd, globalDir, env: {} });
    const out = withoutUntrustedProjectExtensions({ config: resolved, layers, cwd, trusted: false });
    assert.deepEqual(names(out.config.extensions), ["lykos-prune", "pi-user-thing"]);
    assert.deepEqual(names(out.config.lykos_extensions), []);
    assert.deepEqual(out.skipped.map(skippedLabel), ["pi-project-thing@1.0.0", "lykos-project-thing@3.0.0"]);
    assert.deepEqual(resolveExtensions(out.config.extensions).errors, []);
  });

  it("a trusted project loads the same session whole and skips nothing", () => {
    const { cwd, globalDir } = setup(PROJECT, GLOBAL);
    const { resolved, layers } = loadConfig({ cwd, globalDir, env: {} });
    const out = withoutUntrustedProjectExtensions({ config: resolved, layers, cwd, trusted: true });
    assert.deepEqual(names(out.config.extensions), ["pi-project-thing", "lykos-prune", "pi-user-thing"]);
    assert.deepEqual(names(out.config.lykos_extensions), ["lykos-project-thing"]);
    assert.deepEqual(out.skipped, []);
  });

  it("shipped default extensions stay when the project declares nothing", () => {
    const { cwd, globalDir } = setup("", "");
    const { resolved, layers } = loadConfig({ cwd, globalDir, env: {} });
    const out = withoutUntrustedProjectExtensions({ config: resolved, layers, cwd, trusted: false });
    assert.deepEqual(out.config.extensions, resolved.extensions);
    assert.deepEqual(out.config.lykos_extensions, resolved.lykos_extensions);
    assert.deepEqual(out.skipped, []);
    assert.ok(resolved.lykos_extensions.length > 0, "the shipped defaults are really there");
  });
});

describe("how skipped extensions are named (T183)", () => {
  it("name@version, and the bare name when there is no version", () => {
    assert.equal(skippedLabel({ kind: "extension", name: "a", version: "1.0.0" }), "a@1.0.0");
    assert.equal(skippedLabel({ kind: "extension", name: "a", version: undefined }), "a");
    assert.equal(skippedLabel({ kind: "extension", name: "a", version: "" }), "a");
    assert.equal(skippedLabel({ kind: "provider-command", provider: "p", field: "credential" }), "provider p: !command credential");
    assert.equal(skippedLabel({ kind: "provider-command", provider: "p", field: { header: "h" } }), "provider p: !command header h");
    assert.match(skippedLabel({ kind: "pi-package", source: "npm:x" }), /^pi package npm:x \(install withheld/);
  });

  it("reads the packages a project's .pi/settings.json lists, strings and objects, and nothing from a missing or broken file", () => {
    const { cwd } = setup("");
    assert.deepEqual(projectPiPackages(cwd), []);
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:foo@1.0.0", { source: "git:github.com/x/y" }, 3, {}] }));
    assert.deepEqual(projectPiPackages(cwd), [{ kind: "pi-package", source: "npm:foo@1.0.0" }, { kind: "pi-package", source: "git:github.com/x/y" }]);
    writeFileSync(join(cwd, ".pi", "settings.json"), "{ not json");
    assert.deepEqual(projectPiPackages(cwd), []);
  });
});

describe("withoutUntrustedProjectCommands (T183, SP7)", () => {
  const PROJECT_PROVIDERS = `
providers:
  deepseek:
    auth: api_key
    source: "!echo stolen"
  mine:
    auth: gateway
    source: $MY_KEY
    headers: { x-token: "!echo hdr", x-plain: fixed }
`;
  const GLOBAL_PROVIDERS = `
providers:
  anthropic:
    auth: api_key
    source: "!pass show anthropic"
`;

  it("an untrusted project's !command credential and header are dropped and named; $ENV and literal values and the user's own !command stay", () => {
    const { cwd, globalDir } = setup(PROJECT_PROVIDERS, GLOBAL_PROVIDERS);
    const { resolved, layers } = loadConfig({ cwd, globalDir, env: {} });
    const out = withoutUntrustedProjectCommands({ config: resolved, layers, cwd, trusted: false });
    assert.equal(out.config.providers.deepseek?.source, undefined);
    assert.equal(out.config.providers.mine?.source, "$MY_KEY");
    assert.deepEqual(out.config.providers.mine?.headers, { "x-plain": "fixed" });
    assert.equal(out.config.providers.anthropic?.source, "!pass show anthropic");
    assert.deepEqual(out.skipped.map(skippedLabel), ["provider deepseek: !command credential", "provider mine: !command header x-token"]);
  });

  it("a trusted project keeps everything", () => {
    const { cwd, globalDir } = setup(PROJECT_PROVIDERS, GLOBAL_PROVIDERS);
    const { resolved, layers } = loadConfig({ cwd, globalDir, env: {} });
    const out = withoutUntrustedProjectCommands({ config: resolved, layers, cwd, trusted: true });
    assert.equal(out.config.providers.deepseek?.source, "!echo stolen");
    assert.deepEqual(out.skipped, []);
  });

  it("a later non-project layer that re-declares the provider keeps its own !command; the project's is not blamed for it", () => {
    const { cwd, globalDir } = setup(PROJECT_PROVIDERS, GLOBAL_PROVIDERS);
    const { resolved, layers } = loadConfig({ cwd, globalDir, env: {} });
    const userSpecialist = mkdtempSync(join(tmpdir(), "lykos-pe-spec-"));
    const overridden = {
      ...resolved,
      providers: {
        ...resolved.providers,
        deepseek: { ...resolved.providers.deepseek!, source: "!pass show deepseek" },
        mine: { ...resolved.providers.mine!, headers: { ...resolved.providers.mine!.headers, "x-token": "!pass show hdr" } },
      },
    };
    const withUser = [...layers, { name: "specialist", path: join(userSpecialist, "s.md"), value: { providers: { deepseek: { source: "!pass show deepseek" }, mine: { headers: { "x-token": "!pass show hdr" } } } } }] as unknown as typeof layers;
    const out = withoutUntrustedProjectCommands({ config: overridden, layers: withUser, cwd, trusted: false });
    assert.equal(out.config.providers.deepseek?.source, "!pass show deepseek");
    assert.equal(out.config.providers.mine?.headers?.["x-token"], "!pass show hdr");
    assert.deepEqual(out.skipped, []);
  });

  it("a later user layer that declares exactly the project's !command is still the user's: it stays and is not reported", () => {
    const { cwd, globalDir } = setup(PROJECT_PROVIDERS, GLOBAL_PROVIDERS);
    const { resolved, layers } = loadConfig({ cwd, globalDir, env: {} });
    const userSpecialist = mkdtempSync(join(tmpdir(), "lykos-pe-spec-"));
    const entry = { auth: "api_key", source: "!echo stolen" };
    const mineEntry = { auth: "gateway", source: "$MY_KEY", headers: { "x-token": "!echo hdr", "x-plain": "fixed" } };
    const withUser = [...layers, { name: "specialist", path: join(userSpecialist, "s.md"), value: { providers: { deepseek: entry, mine: mineEntry } } }] as unknown as typeof layers;
    const out = withoutUntrustedProjectCommands({ config: resolved, layers: withUser, cwd, trusted: false });
    assert.equal(out.config.providers.deepseek?.source, "!echo stolen");
    assert.equal(out.config.providers.mine?.headers?.["x-token"], "!echo hdr");
    assert.deepEqual(out.skipped, []);
  });
});
