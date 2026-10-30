// Standalone demo of the full-screen surface — a static-content sanity
// check, separate from the real thing. `lykos run --interactive` (or bare
// `lykos`) now drives the actual full-screen surface for real, gated by
// `session/interactive.ts`'s `decideRenderMode()` (T50.1) — that is what to
// run to try it for real. This script still has a purpose: it exercises
// the SAME render pipeline (T41's terminal, T50.4's ScreenPipeline) with
// no model call, no ledger, and no network — the fastest way to check
// "does raw mode even work on my terminal" before trying a real session.
//
//   npx tsx lykos/tui/screen/demo.ts
//
// It enters the real alternate screen (T41), paints one of every block
// kind (T44/T45) plus the footer (T42/T48), and restores the terminal
// cleanly on any key, Ctrl-C, or a crash. No session that built this
// pipeline had a real TTY to verify raw-mode behaviour against — this and
// a real `lykos` session are both that verification, run by a person.

import { ScreenTerminal } from "./terminal.js";
import { ScreenPipeline } from "./pipeline.js";
import { detectColorCapability, detectGlyphSet, resolveTheme } from "../theme/resolve.js";
import { setIoMode, stdoutWrite } from "../io-mode.js";
import { derive } from "../derive.js";
import type { Snapshot } from "../types.js";

setIoMode("standalone");

function demoViewModel() {
  const snap: Snapshot = {
    now: new Date(),
    run: {
      sessionId: "demo-session",
      brief: "full-screen surface demo",
      startedUtc: new Date(Date.now() - 90_000).toISOString(),
      heartbeatUtc: new Date().toISOString(),
      endedUtc: null,
      outcome: null,
      outcomeSource: null,
      totals: { costUsd: 0.038, input: 42100, output: 3800, cacheRead: 38400, cacheWrite: 2100, reasoning: 0, calls: 4 },
      lastCall: {
        tsUtc: new Date().toISOString(),
        agent: "worker",
        phase: "implement",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        contextBefore: 50000,
        contextAfter: 52000,
        toolSchemaTokens: 4200,
        toolCount: 8,
        prefixChanged: false,
      },
    },
    today: { date: new Date().toISOString().slice(0, 10), spentUsd: 0.41, sessions: 3, successes: 2 },
    budget: { perRunUsd: 0.5, perDayUsd: 2.0, onExceed: "stop" },
    parentContext: null,
    rateLimits: null,
    delegateContextTokens: 1_000_000,
  };
  return derive(snap);
}

async function main(): Promise<void> {
  if (!process.stdout.isTTY) {
    process.stderr.write("lykos ui demo: stdout is not a TTY — run this in a real interactive terminal.\n");
    process.exitCode = 1;
    return;
  }

  const term = new ScreenTerminal();
  const capability = detectColorCapability({ env: process.env, isTTY: true });
  const glyphs = detectGlyphSet(process.env);
  const theme = resolveTheme("rose-pine-moon", capability, glyphs);

  await term.run(async () => {
    const size = term.size();
    const pipeline = new ScreenPipeline({
      width: size.columns,
      height: size.rows,
      theme,
      header: {
        product: "LYKOS",
        version: "0.0.1",
        model: "deepseek-v4-flash",
        cwd: process.cwd(),
        branch: null,
        sessionId: "demo-session",
        executionShape: "standalone",
      },
      sink: { write: (text: string) => stdoutWrite(text) },
    });

    const stopResize = term.onResize((newSize) => pipeline.resize(newSize.columns, newSize.rows));

    pipeline.pushBlock({ id: "1", kind: "user", text: "show me what the new full-screen surface looks like" });
    pipeline.pushBlock({ id: "2", kind: "thinking", text: "the user wants a demo of every block kind at once, so build one of each and paint the frame" });
    pipeline.pushBlock({ id: "3", kind: "speech", text: "Here is every block kind the full-screen surface can draw, plus the always-on ledger footer below." });
    pipeline.pushBlock({ id: "4", kind: "tool", tool: { name: "Edit", summary: "lykos/tui/screen/demo.ts", state: "ok" } });
    pipeline.pushBlock({
      id: "5",
      kind: "diff",
      diff: {
        path: "lykos/tui/screen/demo.ts",
        lines: [
          { kind: "hunk", text: "@@ -1,2 +1,3 @@" },
          { kind: "ctx", text: "unchanged context line" },
          { kind: "del", text: "const old = 1;" },
          { kind: "add", text: "const updated = 2;" },
        ],
      },
    });
    pipeline.pushBlock({ id: "6", kind: "bash", bash: { command: "npm test", output: "871 passing", exitCode: 0, sendToModel: true } });
    pipeline.pushBlock({ id: "7", kind: "approval", approval: { kind: "write", summary: "demo.ts", detail: "12 lines" } });
    pipeline.pushBlock({ id: "8", kind: "system", text: "compacting..." });
    pipeline.pushBlock({
      id: "9",
      kind: "outcome",
      outcome: { value: "success", source: "verification_command", verified: true },
    });

    pipeline.setViewModel(demoViewModel());
    pipeline.setComposerLines(["> press any key to exit — nothing here is wired to a real session"]);
    pipeline.flush();

    await new Promise<void>((resolve) => {
      process.stdin.once("data", () => resolve());
    });

    stopResize();
    pipeline.stop();
  });
}

main().catch((err) => {
  process.stderr.write(`lykos ui demo: ${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
});
