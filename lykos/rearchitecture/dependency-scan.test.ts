import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  assertGreenRules,
  DEPENDENCY_RULES,
  formatViolation,
  resolveImportPath,
  scanFile,
  scanProductionRoot,
  scanSources,
  violationsForRule,
} from "./dependency-scan.js";

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "dependency-violations");

describe("P0.5 dependency scan against the target map", () => {
  it("encodes all six rules with per-rule pending state naming the green ticket", () => {
    assert.equal(DEPENDENCY_RULES.length, 6);
    const byId = Object.fromEntries(DEPENDENCY_RULES.map((r) => [r.id, r]));
    assert.equal(byId["no-domain-imports-cli"]?.status, "green");
    assert.equal(byId["no-domain-imports-cli"]?.greenTicket, undefined);
    assert.equal(byId["tui-through-agent-ui-seam"]?.status, "green");
    assert.equal(byId["tui-through-agent-ui-seam"]?.greenTicket, undefined);
    assert.equal(byId["only-ledger-opens-database"]?.status, "green");
    assert.equal(byId["only-ledger-opens-database"]?.greenTicket, undefined);
    assert.equal(byId["only-boundary-names-pi-paths"]?.status, "green");
    assert.equal(byId["only-boundary-names-pi-paths"]?.greenTicket, undefined);
    assert.equal(byId["no-core-directory"]?.status, "green");
    assert.equal(byId["no-core-directory"]?.greenTicket, undefined);
    assert.equal(byId["only-pi-host-names-home-pi-agent"]?.status, "green");
    assert.equal(byId["only-pi-host-names-home-pi-agent"]?.greenTicket, undefined);
  });

  it("resolves relative import edges for rule checks", () => {
    assert.equal(resolveImportPath("session/memory-head.ts", "../cli/memory.js"), "cli/memory.ts");
    assert.equal(resolveImportPath("session/interactive.ts", "../tui/screen/browser.js"), "tui/screen/browser.ts");
  });

  it("reports a deliberate fixture violation with file, import and rule name", () => {
    const fixture = readFileSync(join(FIXTURE_ROOT, "domain-imports-cli.ts"), "utf8");
    const hits = scanFile("session/planted.ts", fixture);
    const hit = hits.find((v) => v.rule === "no-domain-imports-cli");
    assert.ok(hit);
    assert.equal(hit?.file, "session/planted.ts");
    assert.equal(hit?.import, "../cli/memory.js");
    assert.equal(hit?.rule, "no-domain-imports-cli");
    assert.match(formatViolation(hit!), /session\/planted\.ts.*no-domain-imports-cli/);
  });

  it("fixture tree: each rule is triggered by a planted violation", () => {
    const files = new Map<string, string>([
      ["core/cli-import.ts", readFileSync(join(FIXTURE_ROOT, "domain-imports-cli.ts"), "utf8")],
      ["core/tui-screen.ts", readFileSync(join(FIXTURE_ROOT, "tui-screen-import.ts"), "utf8")],
      ["cli/opens-ledger.ts", readFileSync(join(FIXTURE_ROOT, "ledger-open.ts"), "utf8")],
      ["gate/names-pi.ts", readFileSync(join(FIXTURE_ROOT, "pi-path.ts"), "utf8")],
      ["core/exists.ts", readFileSync(join(FIXTURE_ROOT, "core-exists.ts"), "utf8")],
    ]);
    const hits = scanSources(files);
    assert.ok(hits.some((v) => v.rule === "no-domain-imports-cli" && v.import === "../cli/memory.js"));
    assert.ok(hits.some((v) => v.rule === "tui-through-agent-ui-seam" && v.import === "../tui/screen/browser.js"));
    assert.ok(hits.some((v) => v.rule === "only-ledger-opens-database"));
    assert.ok(hits.some((v) => v.rule === "only-boundary-names-pi-paths"));
    assert.ok(hits.some((v) => v.rule === "no-core-directory"));
  });

  it("the real lykos tree keeps rule 4 green", () => {
    const lykosRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const violations = scanProductionRoot(lykosRoot);
    const rule4 = violationsForRule(violations, "only-boundary-names-pi-paths");
    assert.deepEqual(
      rule4,
      [],
      rule4.length > 0 ? `rule 4 regressions:\n${rule4.map(formatViolation).join("\n")}` : undefined,
    );
  });

  it("the real lykos production tree keeps rule 1 green", () => {
    const lykosRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const violations = scanProductionRoot(lykosRoot);
    const rule1 = violationsForRule(violations, "no-domain-imports-cli");
    assert.deepEqual(
      rule1,
      [],
      rule1.length > 0 ? `rule 1 regressions:\n${rule1.map(formatViolation).join("\n")}` : undefined,
    );
  });

  it("P14 ticket 08 (D1): only config/pi-host.ts may build ~/.pi/agent; the container path and comments may name it", () => {
    // The exact line five modules carried before ADR-0027.
    const planted = [
      'const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");',
      'const legacy = join(homedir(), ".pi/agent", "npm");',
    ].join("\n");
    const hits = violationsForRule(scanFile("session/boot.ts", planted), "only-pi-host-names-home-pi-agent");
    assert.deepEqual(
      hits.map((v) => v.line),
      [1, 2],
    );
    assert.deepEqual(scanFile("config/pi-host.ts", planted), [], "the resolver is the one place allowed to");
    const allowed = [
      'export const CONTAINER_AGENT_DIR = "/home/node/.pi/agent";',
      '// was join(homedir(), ".pi", "agent") before ADR-0027',
      ' * falls back to join(homedir(), ".pi", "agent") when unset',
      'const label = "packages under ~/.pi/agent are no longer loaded";',
    ].join("\n");
    assert.deepEqual(violationsForRule(scanFile("cli/doctor.ts", allowed), "only-pi-host-names-home-pi-agent"), []);
  });

  it("the real lykos production tree keeps the pi-host rule green", () => {
    const lykosRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const hits = violationsForRule(scanProductionRoot(lykosRoot), "only-pi-host-names-home-pi-agent");
    assert.deepEqual(hits, [], hits.length > 0 ? hits.map(formatViolation).join("\n") : undefined);
  });

  it("the real lykos production tree passes all six dependency rules", () => {
    const lykosRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const violations = scanProductionRoot(lykosRoot);
    assert.deepEqual(
      violations,
      [],
      violations.length > 0 ? `dependency violations:\n${violations.map(formatViolation).join("\n")}` : undefined,
    );
    assertGreenRules(violations);
    for (const rule of DEPENDENCY_RULES) {
      assert.equal(rule.status, "green", `${rule.id} is green after ticket 07`);
      assert.equal(rule.greenTicket, undefined);
    }
  });
});
