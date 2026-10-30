// `lykos budget` — T12 (docs/09-phase1-tasks.md). `show` is a formatter over
// two things that already exist: `loadConfig()`'s resolved budget section
// (config/load.ts) and today's actual spend (`.lykos/today.json`, the same
// fast cache T7's kill switch itself reads before every gated call — this
// command makes that number visible, not a new one). `set` writes into the
// project layer (`.lykos/config.yaml`), validating first so an invalid cap
// can never reach disk for `guardToolCall` to silently misinterpret.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig, projectConfigPath } from "../config/load.js";
import { defaultLedgerPath } from "../ledger/ledger.js";
import { readTodayRollup } from "../ledger/live.js";
import { stdoutWrite } from "../tui/io-mode.js";
import type { BudgetConfig, OnExceed } from "../config/types.js";

const BUDGET_KEYS = ["per_run_usd", "per_day_usd", "on_exceed", "max_concurrent_delegates"] as const;
export type BudgetKey = (typeof BUDGET_KEYS)[number];

const ON_EXCEED_VALUES: OnExceed[] = ["stop", "downgrade", "prompt"];

export function isBudgetKey(key: string): key is BudgetKey {
  return (BUDGET_KEYS as readonly string[]).includes(key);
}

export type ParsedBudgetValue =
  | { ok: true; value: BudgetConfig[BudgetKey] }
  | { ok: false; error: string };

/**
 * Validates and coerces a raw CLI string into the right type for `key`,
 * refusing anything `guardToolCall` (ledger/budget.ts) would silently
 * misinterpret: a negative cap, a non-integer concurrency limit, or an
 * `on_exceed` value outside the three documented ones. Zero IS valid for
 * the two USD caps — that's exactly what T7's own kill-switch acceptance
 * script sets to force an immediate trip, a real, intentional use.
 */
export function parseBudgetValue(key: BudgetKey, raw: string): ParsedBudgetValue {
  if (key === "on_exceed") {
    if (!ON_EXCEED_VALUES.includes(raw as OnExceed)) {
      return { ok: false, error: `on_exceed must be one of: ${ON_EXCEED_VALUES.join(", ")} (got "${raw}")` };
    }
    return { ok: true, value: raw as OnExceed };
  }

  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return { ok: false, error: `"${raw}" is not a number` };
  }
  if (n < 0) {
    return { ok: false, error: `${key} must be >= 0 (got ${n})` };
  }
  if (key === "max_concurrent_delegates") {
    if (!Number.isInteger(n) || n < 1) {
      return { ok: false, error: `max_concurrent_delegates must be a positive integer (got ${raw})` };
    }
  }
  return { ok: true, value: n };
}

/**
 * Rewrites one scalar value inside `config.yaml`'s `budget:` block, touching
 * only that single line rather than a full parse-then-restringify. Spiked
 * with the `yaml` package's own `Document.setIn()` first and found it
 * reformats the WHOLE file on every write (alignment spacing collapsed,
 * `[project, global]` becomes `[ project, global ]`) — that would make every
 * `budget set` produce unrelated diff noise in a file `05-cli-and-config.md`
 * §1 documents as committed project knowledge. Same reasoning T10 already
 * applied to agent frontmatter: a targeted edit, not a round trip.
 */
export function setBudgetValueInConfig(raw: string, key: BudgetKey, value: string): string {
  const lines = raw.split(/\r?\n/);
  const blockStart = lines.findIndex((l) => /^budget:\s*$/.test(l));
  if (blockStart === -1) {
    const sep = raw.length > 0 && !raw.endsWith("\n") ? "\n" : "";
    return `${raw}${sep}\nbudget:\n  ${key}: ${value}\n`;
  }

  let blockEnd = lines.length;
  for (let i = blockStart + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    if (/^\S/.test(line)) {
      blockEnd = i;
      break;
    }
  }

  const keyLineRe = new RegExp(
    `^(?<indent>\\s*)${key}:(?<afterColon>\\s*)(?<value>\\S+)(?<beforeComment>\\s*)(?<comment>#.*)?$`,
  );
  for (let i = blockStart + 1; i < blockEnd; i++) {
    const m = keyLineRe.exec(lines[i]!);
    if (m?.groups) {
      const { indent, afterColon, beforeComment, comment } = m.groups;
      lines[i] = `${indent}${key}:${afterColon}${value}${beforeComment ?? ""}${comment ?? ""}`;
      return lines.join("\n");
    }
  }

  lines.splice(blockStart + 1, 0, `  ${key}: ${value}`);
  return lines.join("\n");
}

export function runBudgetShow(cwd: string): number {
  const { resolved } = loadConfig({ cwd });
  const budget = resolved.budget;
  const ledgerPath =
    resolved.telemetry.ledger === ".lykos/ledger.db" ? defaultLedgerPath(cwd) : resolved.telemetry.ledger;
  const rollup = readTodayRollup(ledgerPath);

  stdoutWrite("lykos budget\n");
  stdoutWrite("─".repeat(40) + "\n");
  stdoutWrite(`per_run_usd               $${budget.per_run_usd.toFixed(2)}\n`);
  stdoutWrite(`per_day_usd               $${budget.per_day_usd.toFixed(2)}\n`);
  stdoutWrite(`on_exceed                 ${budget.on_exceed}\n`);
  stdoutWrite(`max_concurrent_delegates  ${budget.max_concurrent_delegates}\n`);

  stdoutWrite("\ntoday\n");
  if (!rollup) {
    stdoutWrite("  no sessions recorded yet — spend today is $0.00\n");
    return 0;
  }
  const remaining = budget.per_day_usd - rollup.spentUsd;
  stdoutWrite(`  spent      $${rollup.spentUsd.toFixed(4)}  (${rollup.sessions} sessions, ${rollup.successes} success)\n`);
  stdoutWrite(
    remaining > 0
      ? `  remaining  $${remaining.toFixed(4)} before the day cap trips\n`
      : `  remaining  $0.0000 — day cap already reached; further gated calls will be blocked (T7)\n`,
  );
  return 0;
}

export function runBudgetSet(cwd: string, key: string, rawValue: string | undefined): number {
  if (!isBudgetKey(key)) {
    process.stderr.write(`lykos budget set: unknown key "${key}". Valid keys: ${BUDGET_KEYS.join(", ")}\n`);
    return 1;
  }
  if (rawValue === undefined) {
    process.stderr.write(`lykos budget set: expected a value, e.g. \`lykos budget set ${key} 1.5\`\n`);
    return 1;
  }
  const parsed = parseBudgetValue(key, rawValue);
  if (!parsed.ok) {
    process.stderr.write(`lykos budget set: ${parsed.error} — nothing written\n`);
    return 1;
  }

  const path = projectConfigPath(cwd);
  if (!existsSync(path)) {
    process.stderr.write(`lykos budget set: no ${path} — run \`lykos init\` first\n`);
    return 1;
  }

  const raw = readFileSync(path, "utf8");
  const updated = setBudgetValueInConfig(raw, key, String(parsed.value));
  writeFileSync(path, updated, "utf8");

  stdoutWrite(`${key} set to ${parsed.value} in ${path}\n`);
  return 0;
}
