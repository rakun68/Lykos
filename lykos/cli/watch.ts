// `lykos watch` — S3 (docs/07-ui-and-hud.md §4.1, T38). Depth on demand for
// one project: live.json first, ledger fallback for finished sessions. Read-
// only — never opens Ledger.open() (migrations write).

import { join } from "node:path";
import { collect } from "../tui/collect.js";
import { derive } from "../tui/derive.js";
import { setIoMode, stdoutWrite } from "../tui/io-mode.js";
import { renderJson } from "../tui/renderers/json.js";
import {
  DEFAULT_WATCH_PANELS,
  renderWatchFrame,
  type WatchPanel,
} from "../tui/renderers/watch.js";
import { findDefaultSessionId, readChildSessions, resolveSessionSnapshot } from "../tui/session-snapshot.js";
import { ensureBuiltinSegments } from "../tui/segments/builtin.js";
import { validateFormat } from "../tui/segments/registry.js";
import { detectColorCapability, detectGlyphSet, resolveTheme, type ColorFlag } from "../tui/theme/resolve.js";
import type { ResolvedConfig } from "../config/types.js";
import type { LiveSnapshot } from "../ledger/live.js";
import type { RunSnapshot } from "../tui/types.js";

export interface RunWatchOptions {
  cwd: string;
  resolved: ResolvedConfig;
  sessionId: string | null;
  json: boolean;
  /** Print one frame and exit — tests and pipes. */
  once: boolean;
  colorFlag?: ColorFlag;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  /** Injected clock / sleep for tests. */
  sleepMs?: (ms: number) => Promise<void>;
  /** Cap the interactive loop (tests). */
  maxFrames?: number;
}

function ledgerPathFor(cwd: string, resolved: ResolvedConfig): string {
  return resolved.telemetry.ledger === ".lykos/ledger.db"
    ? join(cwd, ".lykos", "ledger.db")
    : resolved.telemetry.ledger;
}

function liveToRun(snap: LiveSnapshot): RunSnapshot {
  return {
    sessionId: snap.sessionId,
    brief: snap.brief,
    startedUtc: snap.startedUtc,
    heartbeatUtc: snap.heartbeatUtc,
    endedUtc: snap.endedUtc,
    outcome: snap.outcome,
    outcomeSource: snap.outcomeSource,
    totals: snap.totals,
    lastCall: snap.lastCall,
  };
}

function parsePanels(raw: string[] | undefined): WatchPanel[] {
  if (!raw || raw.length === 0) return DEFAULT_WATCH_PANELS;
  const allowed = new Set<string>(DEFAULT_WATCH_PANELS);
  // delegates is optional in the default list but valid.
  allowed.add("delegates");
  const out: WatchPanel[] = [];
  for (const name of raw) {
    if (!allowed.has(name)) {
      throw new Error(
        `lykos watch: unknown panel "${name}". Known: ${[...allowed].sort().join(", ")}`,
      );
    }
    out.push(name as WatchPanel);
  }
  return out;
}

function clearScreen(): void {
  stdoutWrite("\x1b[2J\x1b[H");
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function runWatch(opts: RunWatchOptions): Promise<number> {
  ensureBuiltinSegments();
  const hudFormat = opts.resolved.ui.hud.format;
  const statusFormat = opts.resolved.ui.statusline.format;
  validateFormat(hudFormat);
  validateFormat(statusFormat);

  const ledgerPath = ledgerPathFor(opts.cwd, opts.resolved);
  if (opts.json) setIoMode("piped");

  const sessionId = opts.sessionId ?? findDefaultSessionId(ledgerPath);
  if (!sessionId) {
    process.stderr.write("lykos watch: no sessions found (run a task first, or pass --session <id>)\n");
    return 1;
  }

  const capability = detectColorCapability({
    env: opts.env,
    isTTY: opts.isTTY && !opts.json,
    ...(opts.colorFlag !== undefined ? { colorFlag: opts.colorFlag } : {}),
  });
  const glyphs =
    opts.resolved.ui.glyphs === "unicode" ? detectGlyphSet(opts.env) : opts.resolved.ui.glyphs;
  const theme = resolveTheme(opts.resolved.ui.theme, capability, glyphs, { cwd: opts.cwd });
  const panels = parsePanels(opts.resolved.ui.watch.panels);
  const hz = Math.max(1, Math.min(10, opts.resolved.ui.watch.refresh_hz || 4));
  const intervalMs = Math.floor(1000 / hz);
  const sleep = opts.sleepMs ?? defaultSleep;

  let paused = false;
  let focused: WatchPanel | null = null;
  let frames = 0;
  let quit = false;

  const onKey = (buf: Buffer): void => {
    const ch = buf.toString("utf8");
    if (ch === "q" || ch === "\u0003") {
      quit = true;
      return;
    }
    if (ch === "p") {
      paused = !paused;
      return;
    }
    const idx = "1234567".indexOf(ch);
    if (idx !== -1 && panels[idx]) focused = panels[idx]!;
  };

  const interactive = !opts.once && !opts.json && opts.isTTY && process.stdin.isTTY;
  if (interactive) {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.on("data", onKey);
  }

  try {
    while (!quit) {
      if (!paused || frames === 0) {
        const resolved = resolveSessionSnapshot(ledgerPath, sessionId);
        if (!resolved) {
          process.stderr.write(`lykos watch: session "${sessionId}" not found in live.json or ledger\n`);
          return 1;
        }
        const snapshot = collect({
          ledgerPath,
          sessionId,
          config: opts.resolved,
          runOverride: liveToRun(resolved.snapshot),
          children: readChildSessions(ledgerPath, sessionId),
        });
        const vm = derive(snapshot);

        if (opts.json) {
          stdoutWrite(renderJson(vm) + "\n");
          return 0;
        }

        const width = Number(opts.env.COLUMNS) || process.stdout.columns || 80;
        const height = Number(opts.env.LINES) || process.stdout.rows || 40;
        const frame = renderWatchFrame(vm, {
          width,
          height,
          theme,
          panels,
          source: resolved.source,
          focused,
          paused,
        });
        if (interactive) clearScreen();
        stdoutWrite(frame + (opts.once || !interactive ? "\n" : "\n"));
      }

      frames += 1;
      if (opts.once || opts.json) return 0;
      if (opts.maxFrames !== undefined && frames >= opts.maxFrames) return 0;
      await sleep(intervalMs);
    }
  } finally {
    if (interactive) {
      process.stdin.setRawMode?.(false);
      process.stdin.off("data", onKey);
      process.stdin.pause();
    }
  }
  return 0;
}
