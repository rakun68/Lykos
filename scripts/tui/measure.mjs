// Measures a TUI binary in a real pty: startup to first frame, keystroke-to-screen latency, frame time while
// streaming, idle CPU, peak memory and binary size (P5 ticket #33; the speed gate, #34, runs it).
//
// Usage: node scripts/tui/measure.mjs <binary> [--ready TEXT] [--runs N] [--json] [-- args...]
// The binary draws TEXT once it is ready, puts typed characters on screen, and with BENCH_STREAM=<frames> and
// BENCH_OUT=<file> streams that many frames and writes each frame's time in microseconds, one per line.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TuiSession, percentile, processStats } from "./harness.mjs";

export async function measure(binary, { ready = "READY", runs = 5, args = [], env = {}, cols = 120, rows = 40, keystrokes = 60, streamFrames = 600 } = {}) {
  const startups = [];
  const latencies = [];
  const idle = [];
  const peaks = [];
  for (let run = 0; run < runs; run++) {
    const s = new TuiSession(binary, args, { cols, rows, env });
    const at = await s.waitFor(ready, 15000);
    startups.push(at - s.spawnedAt);
    await s.idle(200);
    const alphabet = "abcdefghijklmnopqrstuvwxyz";
    let typed = "";
    for (let i = 0; i < keystrokes; i++) {
      const ch = alphabet[(i * 7 + run) % alphabet.length];
      typed += ch;
      const want = typed.slice(-30);
      const sent = performance.now();
      s.write(ch);
      const seen = await s.waitFor(() => s.screen().includes(want), 5000);
      latencies.push(seen - sent);
      await new Promise((r) => setTimeout(r, 5));
    }
    await s.idle(300);
    const before = processStats(s.pid);
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 3000));
    const after = processStats(s.pid);
    idle.push(((after.cpuMs - before.cpuMs) / (performance.now() - t0)) * 1000);
    peaks.push(after.peakBytes);
    await s.close();
  }
  const dir = mkdtempSync(join(tmpdir(), "lykos-measure-"));
  const frames = [];
  try {
    for (let run = 0; run < Math.max(1, Math.min(runs, 3)); run++) {
      const out = join(dir, `frames-${run}.txt`);
      const s = new TuiSession(binary, args, { cols, rows, env: { ...env, BENCH_STREAM: String(streamFrames), BENCH_OUT: out } });
      await s.waitFor(() => s.exit !== null, 60000);
      frames.push(...readFileSync(out, "utf8").split("\n").filter(Boolean).map((us) => Number(us) / 1000));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return {
    binary,
    platform: `${process.platform}-${process.arch}`,
    runs,
    startupMs: { p50: percentile(startups, 50), max: Math.max(...startups) },
    keystrokeMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), n: latencies.length },
    frameMs: { p50: percentile(frames, 50), p95: percentile(frames, 95), n: frames.length },
    idleCpuMsPerSec: { p50: percentile(idle, 50), max: Math.max(...idle) },
    peakMemoryBytes: { p50: percentile(peaks, 50), max: Math.max(...peaks) },
    binaryBytes: statSync(binary).size,
  };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/").replace(/^\//, "")}`) {
  const argv = process.argv.slice(2);
  const dash = argv.indexOf("--");
  const own = dash === -1 ? argv : argv.slice(0, dash);
  const args = dash === -1 ? [] : argv.slice(dash + 1);
  const opt = (name, fallback) => (own.includes(name) ? own[own.indexOf(name) + 1] : fallback);
  const binary = resolve(own[0]);
  const result = await measure(binary, { ready: opt("--ready", "READY"), runs: Number(opt("--runs", 5)), args });
  if (own.includes("--json")) console.log(JSON.stringify(result));
  else console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
