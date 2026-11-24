// `terminal.suspend` on Linux (P5 #48): the TUI runs as a job of an interactive bash, ctrl+z stops it and bash
// takes the terminal, `fg` brings it back drawn again. A job shell is needed: the kernel discards SIGTSTP sent to an
// orphaned process group, which is what the TUI is when a pty starts it directly.
//
//   cargo build --release -p lykos-tui && node scripts/tui/suspend-test.mjs [binary]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TuiSession } from "./harness.mjs";

if (process.platform === "win32") {
  console.log("skip: terminal.suspend is not bound on Windows");
  process.exit(0);
}
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolve(process.argv[2] ?? join(root, "target", "release", "lykos-tui"));
const tsx = import.meta.resolve("tsx", pathToFileURL(join(root, "package.json")).href);
const engine = mkdtempSync(join(tmpdir(), "lykos-tui-engine-"));
const work = mkdtempSync(join(tmpdir(), "lykos-tui-work-"));
const state = mkdtempSync(join(tmpdir(), "lykos-tui-state-"));
const env = {
  LYKOS_ENGINE_DIR: engine,
  LYKOS_TUI_DIR: state,
  LYKOS_SERVE_CMD: JSON.stringify([process.execPath, "--import", tsx, join(root, "lykos/cli.ts"), "serve", "--idle", "0"]),
  LYKOS_ENGINE_CHILD: JSON.stringify({ command: process.execPath, args: ["--import", tsx, join(root, "lykos/server/scripted-child.fixture.ts")] }),
  PS1: "job-shell$ ",
};
const s = new TuiSession("bash", ["--norc", "--noprofile", "-i"], { cols: 100, rows: 30, cwd: work, env });
const step = async (name, test, timeout = 20000) => {
  try {
    await s.waitFor(test, timeout);
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n${s.screen()}`);
    throw e;
  }
};
try {
  await step("bash is ready", () => s.screen().includes("job-shell$"));
  s.write(`'${binary}' --cwd '${work}' --trust-workspace\r`);
  await step("the TUI starts", () => s.screen().includes("Ask anything"));
  s.press("ctrl+z");
  await step("ctrl+z gives the terminal back to bash", () => /Stopped/.test(s.screen()) && !s.screen().includes("Ask anything"));
  s.write("fg\r");
  await step("fg brings the TUI back, drawn again", () => s.screen().includes("Ask anything"));
  s.press("ctrl+c");
  await new Promise((r) => setTimeout(r, 200));
  s.press("ctrl+c");
  await step("it quits to bash", () => s.screen().includes("job-shell$") && !s.screen().includes("Ask anything"));
  s.write("exit\r");
  await step("bash exits", () => s.exit !== null);
} finally {
  await s.close();
  await new Promise((r) => setTimeout(r, 1000));
  for (const dir of [work, state, engine]) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
