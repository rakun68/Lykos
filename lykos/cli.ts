#!/usr/bin/env node
// Entry point for the `lykos` binary. T3.5.3: `init` and `cost` are the two
// Phase 0 deliverables; `doctor` is T3.5.4; `hud` is T4.3/T4.4. Everything
// else in docs/05-cli-and-config.md §4 (`run`, `agents`, `budget`, `memory`,
// `mcp`) is Phase 1.
//
// Every command's implementation is imported dynamically, on demand, rather
// than statically at the top of this file. `config/load.ts` imports the
// `yaml` package, which alone costs ~120ms to import (DECISIONS.md
// 2026-08-29) — a static top-level import would force every command,
// including `hud`'s S1 status-line path (budgeted at p95 < 50ms including
// node start, docs/07-ui-and-hud.md §8), to pay that cost before `main()`
// even runs.

// ADR-0027: a tiny module (node:fs, node:os, node:path only), so the static
// import costs nothing on the hot path.
import { adoptPiHost, ensurePiHost } from "./config/pi-host.js";
import { stderrWrite } from "./tui/io-mode.js";
import { findCommand, usageText } from "./cli/commands.js";

/** Set by a command that must end by draining the event loop rather than `process.exit` (`usage --refresh`). */
let exitByDraining = false;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const cwd = process.cwd();

  // ADR-0027 (P14 ticket 08, D2): Pi's agent directory is the Lykos pi-host,
  // decided once for the whole process and BEFORE any command imports Pi.
  // Pi's `getAgentDir()` reads `PI_CODING_AGENT_DIR` on every call and caches
  // nothing (`dist/config.js`), so an extension asking it later agrees with
  // the `agentDir` `session/boot.ts` passes explicitly. Set even over an
  // inherited value; `LYKOS_PI_HOST_DIR` is the only override. Every command
  // that builds a session in this process — the TUI, `run`, `resume`, `mcp`
  // — dispatches from here, so they all inherit it.
  const piHost = adoptPiHost(process.env);
  // The generated settings file is written only by the commands that build a
  // Pi session (bare `lykos`, `run`, `resume`, `mcp`). Everything else — `hud`
  // on the S1 hot path, `usage`, `doctor` — pays for the variable only and
  // never writes into the home.
  if (command === undefined || command === "run" || command === "resume" || command === "mcp" || command === "session-child") {
    try {
      ensurePiHost({ dir: piHost });
    } catch (err) {
      stderrWrite(
        `lykos: could not prepare Pi's agent directory ${piHost}: ${(err as Error).message} — sessions run on Pi's defaults\n`,
      );
    }
  }

  // `usage()` has claimed since Phase 1 that "`lykos` with no args starts the
  // standalone terminal UI"; nothing implemented it, so a bare `lykos`
  // answered `unknown command "undefined"`. Found 2026-09-07 while looking
  // into UI feedback item 3, which begins "if we just start lykos".
  if (command === undefined) {
    const { runRun, askOutcomeFromEnv } = await import("./cli/run.js");
    return runRun(cwd, undefined, { interactive: true, askOutcome: askOutcomeFromEnv() });
  }

  const cmd = findCommand(command);
  if (!cmd) {
    process.stderr.write(`lykos: unknown command "${command}"\n\n`);
    process.stderr.write(usageText());
    return 1;
  }

  return await cmd.run(rest, {
    cwd,
    setExitByDraining: () => {
      exitByDraining = true;
    },
  });
}

main(process.argv.slice(2)).then((code) => {
  if (exitByDraining) process.exitCode = code;
  else process.exit(code);
});
