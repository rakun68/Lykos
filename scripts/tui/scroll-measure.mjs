// Scrolls a 10,000-message transcript in a real pty and holds each frame's time against the speed gate's frame
// limit (P5 #44: "scrolling a 10,000-message transcript stays within the frame-time limit").
//
//   cargo build --release -p lykos-tui && node scripts/tui/scroll-measure.mjs [binary] [--messages N] [--frames N]
//
// `--diff N` scrolls the diff viewer on an N-line patch instead (P5 #46: "a 5,000-line diff opens and scrolls within
// the frame-time limit"); the first frame of each run, which lays the patch out, is reported apart as `openMs`.
// `--cols N` sets the width (120 by default); past 120 the session sidebar shows beside the transcript, and
// `--no-sidebar` saves it hidden first, so the two runs give the sidebar's cost.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { key, readLimits } from "./gate.mjs";
import { TuiSession, percentile } from "./harness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? Number(argv.splice(i, 2)[1]) : fallback;
};
const messages = opt("--messages", 10000);
const frames = opt("--frames", 600);
const diffLines = opt("--diff", 0);
const cols = opt("--cols", 120);
const noSidebar = argv.includes("--no-sidebar");
if (noSidebar) argv.splice(argv.indexOf("--no-sidebar"), 1);
const binary = resolve(argv[0] ?? join(root, "target", "release", process.platform === "win32" ? "lykos-tui.exe" : "lykos-tui"));
const dir = mkdtempSync(join(tmpdir(), "lykos-tui-scroll-"));
if (noSidebar) writeFileSync(join(dir, "state.json"), JSON.stringify({ sidebar: "hide" }));
const times = [];
const opens = [];
try {
  for (let run = 0; run < 3; run++) {
    const out = join(dir, `frames-${run}.txt`);
    const what = diffLines > 0 ? { BENCH_DIFF: String(diffLines) } : { BENCH_SCROLL: String(messages) };
    const s = new TuiSession(binary, [], { cols, rows: 40, env: { BENCH_STREAM: String(frames), ...what, BENCH_OUT: out, LYKOS_TUI_DIR: dir } });
    await s.waitFor(() => s.exit !== null, 120000);
    await s.close();
    const ms = readFileSync(out, "utf8").split("\n").filter(Boolean).map((us) => Number(us) / 1000);
    if (diffLines > 0) opens.push(ms.shift());
    times.push(...ms);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const entry = readLimits()[key(binary)]?.metrics?.frameMs;
const p50 = percentile(times, 50);
const subject = { cols, sidebar: !noSidebar && cols > 120, ...(diffLines > 0 ? { diffLines, openMs: opens } : { messages }) };
const result = { ...subject, frames: times.length, frameMs: { p50, p95: percentile(times, 95), max: Math.max(...times) }, limit: entry ? entry.limit + entry.tolerance : null };
console.log(JSON.stringify(result, null, 2));
if (entry && p50 > entry.limit + entry.tolerance) {
  console.log(`FAIL scrolling p50 ${p50} ms is over the frame limit ${entry.limit} + ${entry.tolerance} ms`);
  process.exit(1);
}
console.log(entry ? "ok   within the frame limit" : "no frame limit recorded for this binary");
