// Scan test: no non-test.ts file under lykos/ has auth.json in a string literal.

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const lykosRoot = resolve(here, "..");

function walkTsFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkTsFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      results.push(full);
    }
  }
  return results;
}

function stripComments(content: string): string {
  // Strip block comments first, then line comments
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("auth.json scan (D7.7)", () => {
  it("no non-test .ts file under lykos/ has auth.json in a string literal", () => {
    const files = walkTsFiles(lykosRoot);
    const literalPattern = /["'`][^"'`]*auth\.json/;
    const violations: Array<{ file: string; line: number; text: string }> = [];

    for (const file of files) {
      const relative = file.replace(/\\/g, "/").slice(lykosRoot.replace(/\\/g, "/").length + 1);
      const raw = readFileSync(file, "utf8");
      const stripped = stripComments(raw);
      const lines = stripped.split("\n");

      lines.forEach((line, idx) => {
        if (literalPattern.test(line)) {
          violations.push({ file: relative, line: idx + 1, text: line.trim() });
        }
      });
    }

    assert.deepEqual(
      violations,
      [],
      violations.length > 0
        ? `Found auth.json inside string literals in non-test files:\n${violations.map((v) => `${v.file}:${v.line} ${v.text}`).join("\n")}`
        : undefined,
    );
  });
});
