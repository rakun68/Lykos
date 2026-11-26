// P5 #53: the rule `lykos/surface/s0-writes.test.ts` holds for the old TUI, held for the new one. lykos-tui and its
// client (`crates/tui`, `crates/client`) never open the ledger, and never make a number out of the server's
// numbers: each usage figure is shown as it came, only formatted. Scanned, not trusted.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const LEDGER = /\b(rusqlite|sqlite|ledger\.db)\b/i;
/** The usage fields the server sends (`UsageData` in `crates/client/src/protocol.rs`). */
const FIELDS = "run_usd|today_usd|cache_hit_ratio|context_tokens|context_window|context_percent|fresh|cache_read|cache_write|output|reasoning|calls";
/** One usage field combined with another by arithmetic: a derived number. */
const DERIVED = new RegExp(`\\.(?:${FIELDS})\\b[^;\\n]*?[-+*/]\\s*[\\w.()]*\\.(?:${FIELDS})\\b`);

export function findInterfaceViolations(files: Map<string, string>): string[] {
  const hits: string[] = [];
  for (const [path, src] of files) {
    src.split("\n").forEach((line, i) => {
      if (line.trim().startsWith("//")) return;
      if (LEDGER.test(line)) hits.push(`${path}:${i + 1}: opens the ledger: ${line.trim()}`);
      if (DERIVED.test(line)) hits.push(`${path}:${i + 1}: derives a number: ${line.trim()}`);
    });
  }
  return hits;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith(".rs") || entry === "Cargo.toml") out.push(full);
  }
  return out;
}

describe("P5 #53: lykos-tui neither writes the ledger nor derives a number", () => {
  it("no file of crates/tui or crates/client opens the ledger or combines two usage figures", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const files = ["crates/tui", "crates/client"].flatMap((d) => walk(join(root, d)));
    assert.ok(files.length > 10, "the crates were found");
    const contents = new Map(files.map((f) => [relative(root, f), readFileSync(f, "utf8")]));
    assert.deepEqual(findInterfaceViolations(contents), []);
  });

  it("the matcher catches a planted reader and a planted derivation, and passes formatting", () => {
    const hits = findInterfaceViolations(
      new Map([
        ["a.rs", "use rusqlite::Connection;\n// rusqlite in a comment\n"],
        ["b.rs", "let pct = u.context_tokens.unwrap() / u.context_window.unwrap();\nlet hit = t.cache_read / (t.fresh + t.cache_read);\n"],
        ["c.rs", "format!(\"{}%\", (u.cache_hit_ratio.unwrap() * 100.0).round())\nformat!(\"{:.1}k\", t.fresh / 1_000.0)\n"],
      ]),
    );
    assert.equal(hits.length, 3, hits.join("\n"));
    assert.match(hits[0]!, /a\.rs:1: opens the ledger/);
    assert.match(hits[1]!, /b\.rs:1: derives/);
    assert.match(hits[2]!, /b\.rs:2: derives/);
  });
});
