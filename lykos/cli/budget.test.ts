import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isBudgetKey, parseBudgetValue, runBudgetSet, runBudgetShow, setBudgetValueInConfig } from "./budget.js";
import { writeTodayRollup } from "../ledger/live.js";

const CONFIG_YAML = `version: 1

budget:
  per_run_usd: 0.50
  per_day_usd: 2.00
  on_exceed: stop            # stop | downgrade | prompt
  max_concurrent_delegates: 3
`;

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-budgetcli-"));
  mkdirSync(join(dir, ".lykos"), { recursive: true });
  writeFileSync(join(dir, ".lykos", "config.yaml"), CONFIG_YAML, "utf8");
  return dir;
}

function capture(streamName: "stdout" | "stderr", fn: () => number): { code: number; text: string } {
  const chunks: string[] = [];
  const stream = process[streamName];
  const original = stream.write.bind(stream);
  stream.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof stream.write;
  try {
    const code = fn();
    return { code, text: chunks.join("") };
  } finally {
    stream.write = original;
  }
}

describe("isBudgetKey", () => {
  it("accepts exactly the four BudgetConfig fields", () => {
    assert.equal(isBudgetKey("per_run_usd"), true);
    assert.equal(isBudgetKey("per_day_usd"), true);
    assert.equal(isBudgetKey("on_exceed"), true);
    assert.equal(isBudgetKey("max_concurrent_delegates"), true);
    assert.equal(isBudgetKey("not_a_field"), false);
  });
});

describe("parseBudgetValue", () => {
  it("accepts a non-negative number for the two USD caps, including zero", () => {
    assert.deepEqual(parseBudgetValue("per_day_usd", "1.5"), { ok: true, value: 1.5 });
    assert.deepEqual(parseBudgetValue("per_day_usd", "0"), { ok: true, value: 0 });
  });

  it("refuses a negative cap", () => {
    const result = parseBudgetValue("per_run_usd", "-1");
    assert.equal(result.ok, false);
  });

  it("refuses a non-numeric value for a USD field", () => {
    const result = parseBudgetValue("per_run_usd", "banana");
    assert.equal(result.ok, false);
  });

  it("requires max_concurrent_delegates to be a positive integer", () => {
    assert.equal(parseBudgetValue("max_concurrent_delegates", "3").ok, true);
    assert.equal(parseBudgetValue("max_concurrent_delegates", "0").ok, false);
    assert.equal(parseBudgetValue("max_concurrent_delegates", "2.5").ok, false);
  });

  it("only accepts the three documented on_exceed values", () => {
    assert.deepEqual(parseBudgetValue("on_exceed", "stop"), { ok: true, value: "stop" });
    assert.equal(parseBudgetValue("on_exceed", "ignore").ok, false);
  });
});

describe("setBudgetValueInConfig", () => {
  it("changes only the target line — every other line byte-identical, including alignment and comments", () => {
    const updated = setBudgetValueInConfig(CONFIG_YAML, "per_day_usd", "1.5");
    const before = CONFIG_YAML.split("\n");
    const after = updated.split("\n");
    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i++) {
      if (before[i]!.includes("per_day_usd")) {
        assert.equal(after[i], "  per_day_usd: 1.5");
      } else {
        assert.equal(after[i], before[i]);
      }
    }
  });

  it("preserves a trailing comment's exact text when replacing the value", () => {
    const updated = setBudgetValueInConfig(CONFIG_YAML, "on_exceed", "prompt");
    const line = updated.split("\n").find((l) => l.includes("on_exceed"));
    assert.equal(line, "  on_exceed: prompt            # stop | downgrade | prompt");
  });

  it("inserts the key if the budget: block exists but doesn't have it yet", () => {
    const noKey = "budget:\n  per_run_usd: 0.5\n\ntelemetry:\n  hud: true\n";
    const updated = setBudgetValueInConfig(noKey, "per_day_usd", "2");
    assert.match(updated, /budget:\n {2}per_day_usd: 2\n {2}per_run_usd: 0\.5/);
  });

  it("appends a budget: block if none exists at all", () => {
    const updated = setBudgetValueInConfig("version: 1\n", "per_day_usd", "2");
    assert.match(updated, /budget:\n {2}per_day_usd: 2/);
  });
});

describe("runBudgetShow", () => {
  it("prints the resolved caps and reports zero spend when there's no today.json", () => {
    const dir = tempProject();
    const { code, text } = capture("stdout", () => runBudgetShow(dir));
    assert.equal(code, 0);
    assert.match(text, /per_run_usd\s+\$0\.50/);
    assert.match(text, /per_day_usd\s+\$2\.00/);
    assert.match(text, /no sessions recorded yet/);
  });

  it("shows today's real spend and remaining headroom against the cap", () => {
    const dir = tempProject();
    const ledgerPath = join(dir, ".lykos", "ledger.db");
    writeTodayRollup(ledgerPath, {
      schemaVersion: 1,
      date: "2026-08-29",
      spentUsd: 0.5,
      sessions: 2,
      successes: 1,
      updatedUtc: new Date().toISOString(),
    });
    const { text } = capture("stdout", () => runBudgetShow(dir));
    assert.match(text, /spent\s+\$0\.5000/);
    assert.match(text, /remaining\s+\$1\.5000/);
  });

  it("reports zero remaining once the day cap is already reached", () => {
    const dir = tempProject();
    const ledgerPath = join(dir, ".lykos", "ledger.db");
    writeTodayRollup(ledgerPath, {
      schemaVersion: 1,
      date: "2026-08-29",
      spentUsd: 5,
      sessions: 4,
      successes: 4,
      updatedUtc: new Date().toISOString(),
    });
    const { text } = capture("stdout", () => runBudgetShow(dir));
    assert.match(text, /day cap already reached/);
  });
});

describe("runBudgetSet", () => {
  it("writes a valid value into the project config.yaml, preserving other keys and comments", () => {
    const dir = tempProject();
    const { code, text } = capture("stdout", () => runBudgetSet(dir, "per_day_usd", "1.5"));
    assert.equal(code, 0);
    assert.match(text, /per_day_usd set to 1\.5/);

    const raw = readFileSync(join(dir, ".lykos", "config.yaml"), "utf8");
    assert.match(raw, /per_day_usd:\s*1\.5/);
    assert.match(raw, /per_run_usd:\s*0\.5/); // untouched
    assert.match(raw, /stop \| downgrade \| prompt/); // comment survives

    const shown = capture("stdout", () => runBudgetShow(dir));
    assert.match(shown.text, /per_day_usd\s+\$1\.50/);
  });

  it("refuses an unknown key and writes nothing", () => {
    const dir = tempProject();
    const before = readFileSync(join(dir, ".lykos", "config.yaml"), "utf8");
    const { code, text } = capture("stderr", () => runBudgetSet(dir, "not_a_real_key", "5"));
    assert.equal(code, 1);
    assert.match(text, /unknown key/);
    assert.equal(readFileSync(join(dir, ".lykos", "config.yaml"), "utf8"), before);
  });

  it("refuses an invalid value and writes nothing", () => {
    const dir = tempProject();
    const before = readFileSync(join(dir, ".lykos", "config.yaml"), "utf8");
    const { code } = capture("stderr", () => runBudgetSet(dir, "per_day_usd", "-3"));
    assert.equal(code, 1);
    assert.equal(readFileSync(join(dir, ".lykos", "config.yaml"), "utf8"), before);
  });

  it("fails clearly when .lykos/config.yaml doesn't exist yet", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-budgetcli-noinit-"));
    const { code, text } = capture("stderr", () => runBudgetSet(dir, "per_day_usd", "1"));
    assert.equal(code, 1);
    assert.match(text, /lykos init/);
  });
});
