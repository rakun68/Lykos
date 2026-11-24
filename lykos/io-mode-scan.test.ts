// "a rule nobody can violate accidentally is worth more than a rule everybody
// agrees with." This is that rule, mechanical rather than remembered: every
// `.ts` file in the package except io-mode.ts itself is scanned for a direct
// `process.stdout.write(` call, and the build fails the moment a new one
// appears anywhere else.
//
// Scope, stated rather than silent: `*-acceptance.ts` scripts are excluded.
// They run standalone via `npm run x:live`, invoked directly with `tsx`,
// never through `cli.ts`'s command dispatch -- they can never execute under
// `lykos mcp`'s stdio transport, so a direct write in one of them cannot
// corrupt an MCP session the way a write in a real CLI command could.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * A CALL (`process.stdout.write(...)`), never an ASSIGNMENT
 * (`process.stdout.write = ...`) — `doctor.ts`'s `--bench-ui` harness
 * legitimately swaps the function out for a no-op to measure render speed
 * without terminal I/O overhead. That is test scaffolding around the real
 * stream, not a write to it, and flagging it would make the rule the kind
 * everyone learns to ignore.
 */
export function findStdoutWriteViolations(files: Map<string, string>): string[] {
  const violations: string[] = [];
  for (const [path, content] of files) {
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      const isCall = /process\.stdout\.write\s*\(/.test(line);
      const isAssignment = /process\.stdout\.write\s*=/.test(line);
      if (isCall && !isAssignment) {
        violations.push(`${path}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  return violations;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.endsWith(".test.ts")) continue;
    if (entry.endsWith("-acceptance.ts")) continue;
    if (entry === "io-mode.ts") continue; // the one legitimate call site
    out.push(full);
  }
  return out;
}

describe("T32.2: no direct process.stdout.write outside io-mode.ts", () => {
  it("the real package tree has zero violations", () => {
    const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
    const files = walk(packageRoot);
    const contents = new Map(files.map((f) => [relative(packageRoot, f), readFileSync(f, "utf8")]));
    const violations = findStdoutWriteViolations(contents);
    assert.deepEqual(violations, [], `found direct process.stdout.write calls:\n${violations.join("\n")}`);
  });

  it("the matcher DOES catch a deliberately introduced violation — both directions demonstrated (T17's rule)", () => {
    const violations = findStdoutWriteViolations(
      new Map([["fake/new-command.ts", 'export function bad() { process.stdout.write("oops\\n"); }']]),
    );
    assert.equal(violations.length, 1);
    assert.match(violations[0]!, /fake\/new-command\.ts:1/);
  });

  it("does not flag an assignment (doctor.ts's --bench-ui stub-swap), only a call", () => {
    const violations = findStdoutWriteViolations(
      new Map([["fake/bench.ts", "process.stdout.write = (() => true) as typeof process.stdout.write;"]]),
    );
    assert.deepEqual(violations, []);
  });
});
