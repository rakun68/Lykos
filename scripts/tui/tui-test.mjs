// Drives the built TUI in a real pty against the real TypeScript engine server and its scripted session child
// (P5 #37): a prompt starts a session and its reply streams in; Esc twice interrupts; ctrl+c quits.
//
//   cargo build --release -p lykos-tui && node scripts/tui/tui-test.mjs [binary]
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TuiSession } from "./harness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolve(process.argv[2] ?? join(root, "target", "release", process.platform === "win32" ? "lykos-tui.exe" : "lykos-tui"));
const tsx = import.meta.resolve("tsx", pathToFileURL(join(root, "package.json")).href);
const engine = mkdtempSync(join(tmpdir(), "lykos-tui-engine-"));
const work = mkdtempSync(join(tmpdir(), "lykos-tui-work-"));
const env = {
  LYKOS_ENGINE_DIR: engine,
  LYKOS_SERVE_CMD: JSON.stringify([process.execPath, "--import", tsx, join(root, "lykos/cli.ts"), "serve", "--idle", "2"]),
  LYKOS_ENGINE_CHILD: JSON.stringify({ command: process.execPath, args: ["--import", tsx, join(root, "lykos/server/scripted-child.fixture.ts")] }),
};

const s = new TuiSession(binary, ["--cwd", work, "--trust-workspace"], { cols: 100, rows: 30, env });
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
  await step("the home screen draws at once", () => s.screen().includes("Ask anything"), 5000);
  await step("the footer shows the workspace once connected", () => s.screen().includes(work.slice(-20)), 30000);
  s.write("hello there");
  await step("typed text is in the prompt box", () => s.screen().includes("hello there"));
  s.press("enter");
  // The scripted child echoes the prompt back as the reply, so it shows twice: the user row and the reply.
  await step("the prompt starts a session and its reply streams in", () => s.screen().split("hello there").length - 1 >= 2);
  await step("the session goes idle", () => s.screen().includes(work.slice(-20)) && !s.screen().includes("esc interrupt"));
  s.write("tool");
  s.press("enter");
  await step("a tool call shows with its icon", () => s.screen().includes("→ read README.md"));
  await step("model, effort and context use update", () => s.screen().includes("faux/scripted · high") && s.screen().includes("12,345 tokens · 6% used"));
  s.write("hold");
  s.press("enter");
  await step("a running turn offers esc interrupt", () => s.screen().includes("esc interrupt"));
  s.press("esc");
  await step("the first esc arms", () => s.screen().includes("esc again to interrupt"));
  s.press("esc");
  await step("the second esc interrupts", () => s.screen().includes("interrupted"));
  s.write("bye");
  await step("bye is typed", () => s.screen().includes("bye"));
  // One key at a time, as a person types: ConPTY delivers only the first of two ctrl+c bytes sent together.
  s.press("ctrl+c");
  await step("ctrl+c clears the prompt", () => !s.screen().includes("bye"));
  s.press("ctrl+c");
  const quitAt = performance.now();
  await step("a second ctrl+c quits", () => s.exit !== null, 30000);
  console.log(`exit after ${Math.round(performance.now() - quitAt)} ms`);
  assert.equal(s.exit.exitCode ?? s.exit, 0);
} finally {
  if (s.exit === null) await s.close();
  await new Promise((r) => setTimeout(r, 3000));
  rmSync(work, { recursive: true, force: true });
  rmSync(engine, { recursive: true, force: true });
}
