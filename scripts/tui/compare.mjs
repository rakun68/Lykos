// Measures lykos-tui against other agents' TUIs on this machine (P5 #56, the demonstration): startup to an input box,
// keystroke-to-screen latency, idle CPU and memory, each TUI in a real pty with nothing sent to a model.
//
//   npm run build && node scripts/tui/compare.mjs [--launch exe|command] [--runs 5] [--only lykos-tui,opencode] [--json]
//
// Every number is the whole process tree the TUI starts (lykos-tui and the engine server it starts; OpenCode and the
// server it starts), summed: a TUI that splits its work across processes is charged for all of them. Startup is the
// time from spawn to the input box on screen. Keystroke latency is from writing one character to seeing the last
// characters typed on screen. Idle CPU is CPU time over a 3 s window after typing settles, in ms per second. Memory is
// the tree's working set (RSS) at idle, and the sum of each process's peak.
//
// The TUIs are found where they install; one that is not installed is reported as `unmeasured`, never estimated.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TuiSession, percentile } from "./harness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const win = process.platform === "win32";

/** The first file of `paths` that exists. */
const first = (...paths) => paths.find((p) => p && existsSync(p));

/** The newest `codex.exe` under Codex's Windows install. */
function codexExe() {
  const dir = join(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin");
  if (!existsSync(dir)) return undefined;
  const found = readdirSync(dir)
    .map((d) => join(dir, d, "codex.exe"))
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return found[0];
}

function onPath(name) {
  try {
    const out = execFileSync(win ? "where" : "which", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split(/\r?\n/).find(Boolean);
  } catch {
    return undefined;
  }
}

/** Claude Code's own session markers would change what a child Claude Code draws; a measured one starts clean. */
const cleanEnv = () => Object.fromEntries(Object.keys(process.env).filter((k) => k.startsWith("CLAUDE")).map((k) => [k, undefined]));

/** lykos-tui's own binary, found as `lykos` finds it (`lykos/cli/tui.ts`). */
function lykosTui() {
  const exe = win ? "lykos-tui.exe" : "lykos-tui";
  return first(process.env.LYKOS_TUI_BIN, join(root, "target", "release", exe), join(root, "vendor", "tui", `${process.platform}-${process.arch}`, exe));
}

/** A command as a person types it, run by the platform's shell: what is on PATH, shims and launchers included. */
const typed = (line) => (win ? { command: "cmd.exe", args: ["/d", "/s", "/c", line] } : { command: "/bin/sh", args: ["-c", line] });

/**
 * The TUIs, each launched one of two ways. `exe`: the TUI's own executable, as each install runs it in the end (the
 * other agents' commands are shims or launchers that start one). `command`: the command a person types, through the
 * shell, so every shim and launcher is counted.
 */
export function targets(launch = "exe") {
  const npmGlobal = win ? join(process.env.APPDATA ?? "", "npm", "node_modules") : "/usr/local/lib/node_modules";
  // A fresh engine directory: the server this run starts is the one measured, never one already running.
  const fresh = () => ({ LYKOS_ENGINE_DIR: mkdtempSync(join(tmpdir(), "lykos-compare-engine-")) });
  const all = [
    {
      name: "lykos-tui",
      exe: { command: lykosTui(), args: ["--cwd", root, "--trust-workspace"] },
      typed: "lykos",
      ready: "Ask anything",
      // The other TUIs are already trusted in this repository; lykos is told so, not asked. Run as its binary, it starts
      // its engine server as `lykos` tells it to: this Node and this checkout's CLI.
      env: { LYKOS_TRUST_WORKSPACE: "1", LYKOS_SERVE_CMD: JSON.stringify([process.execPath, join(root, "dist", "cli.js"), "serve"]) },
      fresh,
    },
    {
      name: "opencode",
      exe: {
        command: first(
          join(npmGlobal, "opencode-ai", "node_modules", `opencode-${win ? "windows" : process.platform}-${process.arch}`, "bin", win ? "opencode.exe" : "opencode"),
          onPath("opencode"),
        ),
        args: [],
      },
      typed: "opencode",
      ready: "Ask anything",
    },
    {
      name: "claude-code",
      exe: { command: first(join(homedir(), ".local", "bin", win ? "claude.exe" : "claude"), onPath("claude")), args: [] },
      typed: "claude",
      ready: /^❯/m,
      env: cleanEnv(),
    },
    {
      name: "codex",
      // The Windows build's background server does not start under a pty here; it says to pass --no-daemon.
      exe: { command: win ? codexExe() : onPath("codex"), args: win ? ["--no-daemon"] : [] },
      typed: win ? "codex --no-daemon" : "codex",
      ready: "Ask Codex to do anything",
    },
  ];
  return all.map((t) => {
    const how = launch === "command" ? { ...typed(t.typed), present: onPath(t.typed.split(" ")[0]) !== undefined } : { ...t.exe, present: t.exe.command !== undefined };
    return { ...t, ...how, launch };
  });
}

/** Every process as {pid, ppid, cpuMs, rss, peak}. */
function processes() {
  if (win) {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $([double]$_.KernelModeTime + [double]$_.UserModeTime) $($_.WorkingSetSize) $($_.PeakWorkingSetSize)\" }",
      ],
      { encoding: "utf8", maxBuffer: 1 << 24 },
    );
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [pid, ppid, cpu100ns, rss, peakKb] = l.trim().split(/\s+/).map(Number);
        return { pid, ppid, cpuMs: cpu100ns / 1e4, rss, peak: peakKb * 1024 };
      });
  }
  const hz = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
  const out = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const status = readFileSync(`/proc/${d}/status`, "utf8");
      const kb = (name) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(status)?.[1] ?? 0) * 1024;
      out.push({ pid: Number(d), ppid: Number(f[1]), cpuMs: ((Number(f[11]) + Number(f[12])) * 1000) / hz, rss: kb("VmRSS"), peak: kb("VmHWM") });
    } catch {
      // The process ended between the listing and the read.
    }
  }
  return out;
}

/** The tree under `pid`, summed. */
export function treeStats(pid) {
  const all = processes();
  const kids = new Map();
  for (const p of all) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p]);
  const inTree = [];
  const queue = all.filter((p) => p.pid === pid);
  while (queue.length) {
    const p = queue.shift();
    inTree.push(p);
    for (const k of kids.get(p.pid) ?? []) if (!inTree.includes(k) && k.pid !== p.pid) queue.push(k);
  }
  return {
    processes: inTree.length,
    cpuMs: inTree.reduce((s, p) => s + p.cpuMs, 0),
    rss: inTree.reduce((s, p) => s + p.rss, 0),
    peak: inTree.reduce((s, p) => s + p.peak, 0),
  };
}

/** Kills the tree under `pid`: closing the pty leaves a TUI's own children (a server) running. */
function killTree(pid) {
  try {
    if (win) execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

export async function measureTui(t, { runs = 5, keystrokes = 40, cols = 120, rows = 40 } = {}) {
  const startups = [];
  const latencies = [];
  const idle = [];
  const rss = [];
  const peaks = [];
  const procs = [];
  for (let run = 0; run < runs; run++) {
    const extra = t.fresh?.() ?? {};
    const s = new TuiSession(t.command, t.args, { cols, rows, cwd: root, env: { ...t.env, ...extra } });
    try {
      const at = await s.waitFor(t.ready, 60000);
      startups.push(at - s.spawnedAt);
      await s.idle(500, 15000);
      const alphabet = "abcdefghijklmnopqrstuvwxyz";
      let typed = "";
      for (let i = 0; i < keystrokes; i++) {
        const ch = alphabet[(i * 7 + run) % alphabet.length];
        typed += ch;
        const want = typed.slice(-12);
        const sent = performance.now();
        s.write(ch);
        const seen = await s.waitFor(() => s.screen().includes(want), 5000);
        latencies.push(seen - sent);
        await new Promise((r) => setTimeout(r, 20));
      }
      await s.idle(500, 15000);
      const before = treeStats(s.pid);
      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, 3000));
      const after = treeStats(s.pid);
      idle.push(((after.cpuMs - before.cpuMs) / (performance.now() - t0)) * 1000);
      rss.push(after.rss);
      peaks.push(after.peak);
      procs.push(after.processes);
    } finally {
      killTree(s.pid);
      await s.close().catch(() => {});
      for (const dir of Object.values(extra)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  }
  return {
    name: t.name,
    platform: `${process.platform}-${process.arch}`,
    runs,
    processes: Math.max(...procs),
    startupMs: { p50: percentile(startups, 50), max: Math.max(...startups) },
    keystrokeMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), n: latencies.length },
    idleCpuMsPerSec: { p50: percentile(idle, 50), max: Math.max(...idle) },
    rssBytes: { p50: percentile(rss, 50), max: Math.max(...rss) },
    peakBytes: { p50: percentile(peaks, 50), max: Math.max(...peaks) },
  };
}

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/").replace(/^\//, "")}`) {
  const argv = process.argv.slice(2);
  const opt = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
  const only = opt("--only", "")?.split(",").filter(Boolean);
  const launch = opt("--launch", "exe");
  const results = [];
  for (const t of targets(launch)) {
    if (only.length && !only.includes(t.name)) continue;
    if (!t.command || t.present === false) {
      results.push({ name: t.name, platform: `${process.platform}-${process.arch}`, unmeasured: "not installed" });
      continue;
    }
    try {
      results.push(await measureTui(t, { runs: Number(opt("--runs", 5)) }));
    } catch (e) {
      results.push({ name: t.name, platform: `${process.platform}-${process.arch}`, unmeasured: String(e.message).split("\n")[0] });
    }
    console.error(JSON.stringify(results.at(-1)));
  }
  if (argv.includes("--json")) console.log(JSON.stringify(results, null, 2));
  else {
    const mb = (b) => (b / 1048576).toFixed(1);
    console.log("TUI          startup p50   key p50/p95      idle CPU ms/s   RSS MB   peak MB   procs");
    for (const r of results) {
      if (r.unmeasured) console.log(`${r.name.padEnd(12)} unmeasured: ${r.unmeasured}`);
      else
        console.log(
          `${r.name.padEnd(12)} ${r.startupMs.p50.toFixed(0).padStart(8)} ms  ${r.keystrokeMs.p50.toFixed(1).padStart(6)}/${r.keystrokeMs.p95.toFixed(1).padEnd(7)} ms  ${r.idleCpuMsPerSec.p50.toFixed(1).padStart(10)}     ${mb(r.rssBytes.p50).padStart(7)}  ${mb(r.peakBytes.p50).padStart(7)}   ${r.processes}`,
        );
    }
  }
  process.exit(0);
}
