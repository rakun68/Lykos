// T148: default extensions resolve from Lykos's own package, and only there.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LykosExtensionHost } from "../api.js";
import { AutoApproveGate } from "../../gate/approval.js";
import { loadLykosExtensions } from "../load.js";
import { describe, it } from "node:test";
import { SHIPPED_DEFAULTS } from "../../config/defaults.js";
import { resolveExtensions, resolveHostExtensions } from "../../config/extensions.js";
import {
  DEFAULT_EXTENSION_PREFIX,
  DEFAULT_EXTENSIONS,
  defaultExtensionPath,
  defaultExtensionVersion,
  REPO_MAP_EXTENSION,
  REVIEWER_EXTENSION,
} from "./index.js";

const AGENT_DIR = "/nowhere/pi-host";

describe("default extensions (T148)", () => {
  it("every one carries the lykos- prefix and has an entry file in this package", () => {
    for (const ext of DEFAULT_EXTENSIONS) {
      assert.ok(ext.name.startsWith(DEFAULT_EXTENSION_PREFIX), ext.name);
      const path = defaultExtensionPath(ext.name, defaultExtensionVersion(), ext.kind);
      assert.ok(path !== undefined && existsSync(path), `${ext.name} resolves to a file that exists`);
    }
  });

  it("T158: lykos-repo-map ships off — not in the shipped list — and the gate is not a default extension", () => {
    // ADR-0028: a default extension may ship off unless listed; its entry is its only switch.
    assert.equal(SHIPPED_DEFAULTS.extensions.find((e) => e.name === REPO_MAP_EXTENSION), undefined);
    for (const e of SHIPPED_DEFAULTS.extensions.filter((d) => d.name.startsWith("lykos-"))) {
      assert.equal(e.version, defaultExtensionVersion(), e.name);
    }
    assert.ok(!DEFAULT_EXTENSIONS.some((e) => /gate/.test(e.name)));
  });

  it("resolves from the package, never from the machine's install tree", () => {
    const { extensions } = resolveExtensions([{ name: REPO_MAP_EXTENSION, version: defaultExtensionVersion() }]);
    const host = resolveHostExtensions(extensions, AGENT_DIR, existsSync);
    assert.equal(host.missing.length, 0);
    assert.equal(host.loaded[0]?.path, defaultExtensionPath(REPO_MAP_EXTENSION, defaultExtensionVersion()));
    assert.ok(!host.paths[0]!.startsWith(AGENT_DIR));
  });

  it("another version, or the other list, resolves like any third-party package", () => {
    const other = resolveExtensions([{ name: REPO_MAP_EXTENSION, version: "9.9.9" }]).extensions;
    assert.equal(resolveHostExtensions(other, AGENT_DIR, existsSync).missing.length, 1);
    const same = resolveExtensions([{ name: REPO_MAP_EXTENSION, version: defaultExtensionVersion() }]).extensions;
    assert.equal(resolveHostExtensions(same, AGENT_DIR, existsSync, "lykos").missing.length, 1, "a Pi extension is not a Lykos one");
  });

});

describe("the first Lykos-kind default extension (T149)", () => {
  it("the shipped lykos_extensions list declares lykos-reviewer at the package version", () => {
    const decl = SHIPPED_DEFAULTS.lykos_extensions.find((e) => e.name === REVIEWER_EXTENSION);
    assert.equal(decl?.version, defaultExtensionVersion());
  });

  it("resolves from the package in the lykos list only, and loads into a host from that file", async () => {
    const { extensions } = resolveExtensions([{ name: REVIEWER_EXTENSION, version: defaultExtensionVersion() }]);
    assert.equal(resolveHostExtensions(extensions, AGENT_DIR, existsSync, "pi").missing.length, 1, "a Lykos extension is not a Pi one");
    const host = resolveHostExtensions(extensions, AGENT_DIR, existsSync, "lykos");
    assert.equal(host.missing.length, 0);
    assert.ok(!host.loaded[0]!.path.startsWith(AGENT_DIR));
    const ext = new LykosExtensionHost({ cwd: process.cwd(), gate: new AutoApproveGate() });
    const prior = process.env.LYKOS_REVIEWER_POLICY;
    process.env.LYKOS_REVIEWER_POLICY = JSON.stringify({ enabled: true, model: "" });
    try {
      const report = await loadLykosExtensions(ext, host.loaded);
      assert.deepEqual(report, { loaded: [REVIEWER_EXTENSION], failed: [] });
      assert.equal(ext.listenerCount("session_end"), 1);
    } finally {
      if (prior === undefined) delete process.env.LYKOS_REVIEWER_POLICY;
      else process.env.LYKOS_REVIEWER_POLICY = prior;
    }
  });

  it("from dist/ too: the built .js loads, once `npm run build` has produced it", async (t) => {
    const built = join(process.cwd(), "dist", "extensions", "defaults", "lykos-reviewer.js");
    if (!existsSync(built)) {
      t.skip("dist/ not built");
      return;
    }
    const ext = new LykosExtensionHost({ cwd: process.cwd(), gate: new AutoApproveGate() });
    const report = await loadLykosExtensions(ext, [{ name: REVIEWER_EXTENSION, version: defaultExtensionVersion(), path: built }]);
    assert.deepEqual(report, { loaded: [REVIEWER_EXTENSION], failed: [] });
  });
});
