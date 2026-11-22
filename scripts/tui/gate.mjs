// The TUI speed gate (P5 ticket #34, ADR-0064 decision 4, rule 6's exception): a change that makes the TUI slower
// or heavier fails, unless the maintainer accepts the trade.
//
//   node scripts/tui/gate.mjs <binary> --init [--samples 3]           first limits, and the noise, from real runs
//   node scripts/tui/gate.mjs <binary>                                 measure, compare, exit 1 on a regression
//   node scripts/tui/gate.mjs <binary> --accept --by NAME --reason WHY measure, and record the result as the limit
//
// Limits live in bench/tui-limits.json, per binary name and platform. Each metric's tolerance is the noise measured
// at --init (the spread across samples) or the measuring clock's resolution, whichever is larger; never a guess.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { measure } from "./measure.mjs";

const LIMITS = process.env.LYKOS_TUI_LIMITS ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "bench", "tui-limits.json");

/** The six numbers the gate holds, read from a measurement. Lower is better for every one. */
export const METRICS = {
  startupMs: (m) => m.startupMs.p50,
  keystrokeMs: (m) => m.keystrokeMs.p50,
  frameMs: (m) => m.frameMs.p50,
  idleCpuMsPerSec: (m) => m.idleCpuMsPerSec.p50,
  peakMemoryBytes: (m) => m.peakMemoryBytes.p50,
  binaryBytes: (m) => m.binaryBytes,
};

/**
 * The resolution of what measures each metric, below which a difference cannot be told from none. Idle CPU is read
 * from the OS's CPU-time counter over a 3 s window: Windows counts in 15.625 ms ticks, Linux in 1/CLK_TCK (10 ms).
 */
const RESOLUTION = {
  idleCpuMsPerSec: process.platform === "win32" ? 15.625 / 3 : 10 / 3,
  binaryBytes: 0,
};

export function readLimits(path = LIMITS) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
}

export function key(binary) {
  return `${basename(binary).replace(/\.exe$/, "")}@${process.platform}-${process.arch}`;
}

/** Each metric against its limit: `ok` while the value is at most the limit plus its tolerance. */
export function compare(measured, entry) {
  return Object.entries(METRICS).map(([name, read]) => {
    const value = read(measured);
    const { limit, tolerance } = entry.metrics[name];
    return { name, value, limit, tolerance, ok: value <= limit + tolerance };
  });
}

function fmt(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(3);
}

function table(rows) {
  const lines = rows.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(16)} ${fmt(r.value).padStart(12)}  limit ${fmt(r.limit).padStart(12)} + ${fmt(r.tolerance)}`);
  return lines.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const binary = resolve(argv[0]);
  const ready = opt("--ready") ?? "READY";
  const runs = Number(opt("--runs") ?? 5);
  const limits = readLimits();
  const k = key(binary);

  if (argv.includes("--init")) {
    const samples = [];
    for (let i = 0; i < Number(opt("--samples") ?? 3); i++) samples.push(await measure(binary, { ready, runs }));
    const metrics = {};
    for (const [name, read] of Object.entries(METRICS)) {
      const values = samples.map(read);
      const spread = Math.max(...values) - Math.min(...values);
      metrics[name] = { limit: Math.max(...values), tolerance: Math.max(spread, RESOLUTION[name] ?? 0), samples: values };
    }
    limits[k] = { metrics, history: [{ at: new Date().toISOString(), event: "init", by: opt("--by") ?? "first measurement", reason: `${samples.length} samples of ${runs} runs` }] };
    writeFileSync(LIMITS, `${JSON.stringify(limits, null, 2)}\n`);
    console.log(`limits for ${k} written from ${samples.length} samples`);
    console.log(table(compare(samples.at(-1), limits[k])));
    return 0;
  }

  const entry = limits[k];
  if (entry === undefined) {
    console.error(`no limits for ${k}: run with --init first`);
    return 2;
  }
  const measured = await measure(binary, { ready, runs });
  const rows = compare(measured, entry);
  console.log(`${k}\n${table(rows)}`);

  if (argv.includes("--accept")) {
    const by = opt("--by");
    const reason = opt("--reason");
    if (!by || !reason) {
      console.error("--accept needs --by and --reason: the trade is the maintainer's, and it is recorded");
      return 2;
    }
    const changed = {};
    for (const r of rows) {
      if (r.value !== entry.metrics[r.name].limit) changed[r.name] = { from: entry.metrics[r.name].limit, to: r.value };
      entry.metrics[r.name].limit = r.value;
    }
    entry.history.push({ at: new Date().toISOString(), event: "accept", by, reason, changed });
    writeFileSync(LIMITS, `${JSON.stringify(limits, null, 2)}\n`);
    console.log(`accepted by ${by}: ${reason}`);
    return 0;
  }
  const failed = rows.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(`\nslower or heavier: ${failed.map((r) => r.name).join(", ")}. A trade needs the maintainer's --accept.`);
    return 1;
  }
  return 0;
}

if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) process.exit(await main());
