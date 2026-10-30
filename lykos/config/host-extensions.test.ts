// T97.2 / T97.3 / T97.4 — the host half of T29's declaration surface.
//
// T29 resolved declarations against the container. `session/session.ts` booted the
// standalone agent with `noExtensions: true` and no `additionalExtensionPaths`,
// so the shape a human actually drives loaded nothing a user declared. These
// tests pin the three properties that correction has to keep:
//
//   1. the host declares WHAT, never WHERE — the path is recomputed per machine
//   2. a declared package that is not installed is REPORTED, never skipped
//   3. declaration order survives, because declaration order is load order

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  hostExtensionNotice,
  hostExtensionPath,
  resolveExtensions,
  resolveHostExtensions,
} from "./extensions.js";
import { reconcileHostExtensions } from "../cli/doctor.js";

const DECLARED = [
  { name: "pi-cache-optimizer", version: "2.8.6", scope: ["hop0"] },
  { name: "pi-hashline-edit", version: "0.8.3", scope: ["hop0"] },
];

function resolved() {
  const r = resolveExtensions(DECLARED);
  assert.deepEqual(r.errors, [], "fixture should be a valid declaration");
  return r.extensions;
}

describe("hostExtensionPath (T97.2)", () => {
  it("mirrors the container layout under the host's own agent dir", () => {
    assert.equal(
      hostExtensionPath("/home/me/.pi/agent", "pi-hashline-edit"),
      "/home/me/.pi/agent/npm/node_modules/pi-hashline-edit",
    );
  });

  it("tolerates a trailing separator rather than emitting a doubled one", () => {
    assert.equal(hostExtensionPath("/a/b/", "x"), "/a/b/npm/node_modules/x");
    assert.equal(hostExtensionPath("C:\\Users\\me\\.pi\\agent\\", "x"), "C:\\Users\\me\\.pi\\agent/npm/node_modules/x");
  });

  it("never returns the container's own absolute root — the host recomputes it", () => {
    const p = hostExtensionPath("/home/me/.pi/agent", "pi-cache-optimizer");
    assert.ok(!p.startsWith("/home/node/"), "host path leaked the retired container's extension root");
  });
});

describe("resolveHostExtensions (T97.2, T97.3)", () => {
  it("loads what is present and keeps declaration order, which is load order", () => {
    const r = resolveHostExtensions(resolved(), "/agent", () => true);
    assert.deepEqual(
      r.loaded.map((e) => e.name),
      ["pi-cache-optimizer", "pi-hashline-edit"],
    );
    assert.deepEqual(r.paths, [
      "/agent/npm/node_modules/pi-cache-optimizer",
      "/agent/npm/node_modules/pi-hashline-edit",
    ]);
    assert.deepEqual(r.missing, []);
  });

  it("reports a declared-but-absent package instead of silently skipping it", () => {
    const r = resolveHostExtensions(resolved(), "/agent", (p) => p.endsWith("pi-cache-optimizer"));
    assert.deepEqual(
      r.loaded.map((e) => e.name),
      ["pi-cache-optimizer"],
    );
    assert.deepEqual(
      r.missing.map((e) => e.name),
      ["pi-hashline-edit"],
      "a missing declaration must survive into `missing`, not vanish",
    );
    assert.equal(r.paths.length, 1, "a missing package must not reach additionalExtensionPaths");
  });

  it("today's real host state — nothing installed — yields no paths and two reports", () => {
    const r = resolveHostExtensions(resolved(), "/agent", () => false);
    assert.deepEqual(r.paths, []);
    assert.equal(r.missing.length, 2);
  });

  it("a non-hop0 declaration is not loaded onto the hop-0 surface", () => {
    const r = resolveExtensions([{ name: "pi-hashline-edit", version: "0.8.3", scope: ["somespecialist"] }]);
    const host = resolveHostExtensions(r.extensions, "/agent", () => true);
    assert.deepEqual(host.loaded, []);
    assert.deepEqual(host.missing, [], "a scoped-out extension is neither loaded nor missing — it does not apply");
  });

  it("no declarations is silent, not a warning", () => {
    const r = resolveHostExtensions([], "/agent", () => false);
    assert.equal(hostExtensionNotice(r), undefined);
  });
});

describe("hostExtensionNotice (T97.3)", () => {
  it("names the missing packages and says the session runs without them", () => {
    const notice = hostExtensionNotice(resolveHostExtensions(resolved(), "/agent", () => false));
    assert.ok(notice !== undefined);
    assert.match(notice, /pi-hashline-edit@0\.8\.3/);
    assert.match(notice, /NOT INSTALLED/);
    assert.match(notice, /runs without them/);
  });

  it("reports the loaded set with exact versions, so the line is auditable", () => {
    const notice = hostExtensionNotice(resolveHostExtensions(resolved(), "/agent", () => true));
    assert.ok(notice !== undefined);
    assert.match(notice, /pi-cache-optimizer@2\.8\.6/);
    assert.ok(!/NOT INSTALLED/.test(notice), "nothing is missing, so nothing should be reported missing");
  });
});

describe("reconcileHostExtensions (T97.4)", () => {
  it("warns rather than fails, because the session still starts", () => {
    const checks = reconcileHostExtensions({ extensions: resolved() }, "/agent", () => false);
    assert.equal(checks.filter((c) => c.status === "fail").length, 0, "a host gap is not a broken configuration");
    const warn = checks.find((c) => c.status === "warn");
    assert.ok(warn, "a missing host install must be reported");
    assert.match(warn.label, /sessions run from \/agent/);
  });

  it("reports ok per package once the host actually has them", () => {
    const checks = reconcileHostExtensions({ extensions: resolved() }, "/agent", () => true);
    assert.equal(checks.length, 2);
    assert.ok(checks.every((c) => c.status === "ok"));
  });
});
