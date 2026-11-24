// `lykos` opens lykos-tui (P5 #52), as an installed package runs it: `node dist/cli.js` with no arguments, its own
// server command, the workspace trust asked on the terminal first. `lykos run --interactive` in a
// terminal opens it too (P5 #55: the old TUI is gone).
//
//   npm run build && node scripts/tui/launch-test.mjs
//
// The binary is the one `lykos` finds (LYKOS_TUI_BIN, target/release, or vendor/tui from npm install). Sessions run
// on the scripted child, so no model is called; HOME is a temporary directory.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { TuiSession } from "./harness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsx = import.meta.resolve("tsx", pathToFileURL(join(root, "package.json")).href);
const dirs = ["home", "engine", "state", "work"].map((d) => mkdtempSync(join(tmpdir(), `lykos-launch-${d}-`)));
const [home, engine, state, work] = dirs;
const env = {
  HOME: home,
  USERPROFILE: home,
  LYKOS_ENGINE_DIR: engine,
  LYKOS_TUI_DIR: state,
  LYKOS_ENGINE_CHILD: JSON.stringify({ command: process.execPath, args: ["--import", tsx, join(root, "lykos/server/scripted-child.fixture.ts")] }),
  LYKOS_SERVE_CMD: "",
  LYKOS_TRUST_WORKSPACE: "",
};
const cli = join(root, "dist", "cli.js");
// A git repository with a commit: the project identity a stored trust is found by.
for (const args of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]]) execFileSync("git", args, { cwd: work });
// The server the launcher starts exits as soon as the TUI quits, so the workspace can be removed.
mkdirSync(join(home, ".lykos"), { recursive: true });
writeFileSync(join(home, ".lykos", "config.yaml"), "tui:\n  server_idle_seconds: 0\n");
const stopped = async () => {
  const log = join(engine, "engine.log");
  for (let waited = 0; waited < 20000; waited += 250) {
    if (existsSync(log) && / stopped\s*$/.test(readFileSync(log, "utf8"))) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, 500));
};
let s;
const step = async (name, test, timeout = 30000) => {
  try {
    await s.waitFor(test, timeout);
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n${s.screen()}`);
    throw e;
  }
};
const quit = async () => {
  s.press("ctrl+c");
  await new Promise((r) => setTimeout(r, 200));
  s.press("ctrl+c");
};
try {
  s = new TuiSession(process.execPath, [cli], { cols: 100, rows: 30, cwd: work, env });
  await step("lykos asks to trust the workspace", () => s.screen().includes("Trust workspace"));
  s.write("y\r");
  await step("then opens lykos-tui", () => s.screen().includes("Ask anything"));
  s.write("hello");
  await step("keys reach the TUI, not the trust prompt", () => s.screen().includes("hello"));
  s.press("enter");
  await step("a session starts on the server lykos-tui started", () => s.screen().split("hello").length > 2 && !s.screen().includes("untrusted"));
  await quit();
  await step("quitting the TUI ends lykos", () => s.exit !== null);
  console.log(`ok   exit code ${s.exit?.exitCode}`);
  await s.close();
  await stopped();

  s = new TuiSession(process.execPath, [cli], { cols: 100, rows: 30, cwd: work, env });
  await step("a trusted workspace opens straight away", () => s.screen().includes("Ask anything"));
  await quit();
  await step("and quits", () => s.exit !== null);
  await s.close();
  await stopped();

  s = new TuiSession(process.execPath, [cli, "run", "--interactive"], { cols: 100, rows: 30, cwd: work, env });
  await step("lykos run --interactive opens lykos-tui", () => s.screen().includes("Ask anything"), 60000);
  await quit();
  await step("and quits", () => s.exit !== null);
  await s.close();
  await stopped();
} finally {
  await s?.close();
  await new Promise((r) => setTimeout(r, 1500));
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
