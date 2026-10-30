import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

// `recordOutcome` added by T52: it is the writer `outcome = 'success'` finally
// has, and the session-end block that collects the answer lives under
// lykos/tui/. That the mutation goes through the CLI (07-ui-and-hud.md §1.1,
// unchanged by Phase 3.5) is exactly the kind of rule that decays into a
// comment nobody reads, so it is scanned for instead of trusted.
const WRITE_APIS =
  /\b(startSession|recordCall|endSession|recordOutcome|ingestDelegateSnapshot|openLedger|Ledger\.open)\s*\(/;

export function findLedgerWriteViolations(files: Map<string, string>): string[] {
  const hits: string[] = [];
  for (const [path, src] of files) {
    src.split("\n").forEach((line, i) => {
      if (line.trim().startsWith("//")) return;
      if (WRITE_APIS.test(line)) hits.push(`${path}:${i + 1}: ${line.trim()}`);
    });
  }
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("T37: S0 performs zero writes to the ledger", () => {
  it("no file under lykos/tui/ calls a ledger writer", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)));
    const files = walk(root);
    const contents = new Map(files.map((f) => [relative(root, f), readFileSync(f, "utf8")]));
    assert.deepEqual(findLedgerWriteViolations(contents), [], "S0/UI wrote to the ledger");
  });

  it("the matcher catches a planted writer — both directions (T17's rule)", () => {
    const hits = findLedgerWriteViolations(new Map([["fake.ts", "ledger.startSession({ brief: \"x\" })\n// startSession(\n"]]));
    assert.equal(hits.length, 1);
    assert.match(hits[0]!, /fake\.ts:1/);
  });
});
