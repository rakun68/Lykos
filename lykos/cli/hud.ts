// `lykos hud` — the two embedded-HUD surfaces (docs/07-ui-and-hud.md, T4.3/
// T4.4): `--statusline` is S1 (Claude Code's status line, stdout, reads
// Claude Code's own stdin JSON); the default is S2 (the stderr HUD fallback
// for a host with no status line). Both are readers only — zero API calls,
// zero writes (§8).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collect, type ClaudeCodeStatuslineInput } from "../tui/collect.js";
import { derive } from "../tui/derive.js";
import { setIoMode, stdoutWrite } from "../tui/io-mode.js";
import { renderJson } from "../tui/renderers/json.js";
import { renderStderrLine } from "../tui/renderers/stderr.js";
import { renderStatusline } from "../tui/renderers/statusline.js";
import { detectColorCapability, detectGlyphSet, resolveTheme, type ColorFlag } from "../tui/theme/resolve.js";
import type { ResolvedConfig } from "../config/types.js";

export interface RunHudOptions {
  cwd: string;
  resolved: ResolvedConfig;
  statusline: boolean;
  json: boolean;
  sessionId: string | null;
  colorFlag?: ColorFlag;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  /** stdin, already read — only meaningful with --statusline. */
  stdin?: string;
}

/**
 * Deliberately not `ledger/ledger.js`'s `defaultLedgerPath()`: that
 * module imports `better-sqlite3` at the top level (a native module load
 * measured at ~60-100ms), and this path never opens the ledger — it only
 * reads the small JSON caches in live.ts. Duplicated one-line join rather
 * than pulling in a dependency this path does not use.
 */
function ledgerPathFor(cwd: string, resolved: ResolvedConfig): string {
  return resolved.telemetry.ledger === ".lykos/ledger.db"
    ? join(cwd, ".lykos", "ledger.db")
    : resolved.telemetry.ledger;
}

function readStatuslineInput(stdin: string | undefined): ClaudeCodeStatuslineInput | undefined {
  if (!stdin || stdin.trim() === "") return undefined;
  try {
    return JSON.parse(stdin) as ClaudeCodeStatuslineInput;
  } catch {
    return undefined;
  }
}

export function runHud(opts: RunHudOptions): number {
  const { resolved } = opts;
  const ledgerPath = ledgerPathFor(opts.cwd, resolved);
  // T32: both --json and --statusline are machine output consumed by
  // another process (07-ui-and-hud.md §1.3) -- `piped`, never `standalone`.
  if (opts.json || opts.statusline) setIoMode("piped");

  const statuslineInput = opts.statusline ? readStatuslineInput(opts.stdin) : undefined;

  const snapshot = collect({
    ledgerPath,
    sessionId: opts.sessionId,
    config: resolved,
    ...(statuslineInput !== undefined ? { statuslineInput } : {}),
  });
  const vm = derive(snapshot);

  if (opts.json) {
    stdoutWrite(renderJson(vm) + "\n");
    return 0;
  }

  const capability = detectColorCapability({
    env: opts.env,
    isTTY: opts.isTTY,
    assumeColorWhenNotTty: opts.statusline, // S1's stdout is captured, not a TTY (§1.3)
    ...(opts.colorFlag !== undefined ? { colorFlag: opts.colorFlag } : {}),
  });
  const glyphs = resolved.ui.glyphs === "unicode" ? detectGlyphSet(opts.env) : resolved.ui.glyphs;
  const theme = resolveTheme(resolved.ui.theme, capability, glyphs, { cwd: opts.cwd });

  if (opts.statusline) {
    const width = Number(opts.env.COLUMNS) || 100; // §1.3: from $COLUMNS, not a TTY query
    const output = renderStatusline(vm, {
      width,
      theme,
      meta: {
        parentModelName: null,
        delegateModelName: snapshot.run?.lastCall?.model ?? null,
        delegateCalls: snapshot.run?.totals.calls ?? 0,
      },
      format: resolved.ui.statusline.format,
      delegateLine: resolved.ui.statusline.delegate_line,
    });
    stdoutWrite(output + "\n");
    return 0;
  }

  const line = renderStderrLine(vm, { theme });
  process.stderr.write(line + "\n");
  return 0;
}

export function readStdinSync(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}
