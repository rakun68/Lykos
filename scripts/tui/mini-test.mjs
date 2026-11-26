// Drives `lykos-tui --mini` in a real pty against the real engine server and its scripted session child
// (P5 #44): the shell's rows stay, the entry splash and every finished row go into the terminal's scrollback once,
// in order, the footer holds the prompt, and the exit splash says how to continue.
//
//   cargo build --release -p lykos-tui && node scripts/tui/mini-test.mjs [binary]
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
const state = mkdtempSync(join(tmpdir(), "lykos-tui-state-"));
const env = {
  LYKOS_ENGINE_DIR: engine,
  LYKOS_TUI_DIR: state,
  LYKOS_SERVE_CMD: JSON.stringify([process.execPath, "--import", tsx, join(root, "lykos/cli.ts"), "serve", "--idle", "2"]),
  LYKOS_ENGINE_CHILD: JSON.stringify({ command: process.execPath, args: ["--import", tsx, join(root, "lykos/server/scripted-child.fixture.ts")] }),
};

const s = new TuiSession(binary, ["--cwd", work, "--trust-workspace", "--mini"], { cols: 80, rows: 16, env, scrollback: 1000 });
const step = async (name, test, timeout = 20000) => {
  try {
    await s.waitFor(test, timeout);
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}\n--- all ---\n${s.all()}`);
    throw e;
  }
};
const submit = async (text) => {
  s.write(text);
  await s.waitFor(() => s.screen().includes(text), 10000);
  await s.idle(150);
  s.press("enter");
};
try {
  await step("the entry splash and the prompt draw", () => s.all().includes("▪ lykos mini") && s.screen().includes("Ask anything"), 10000);
  await step("connected", () => s.screen().includes(work.slice(-20)), 30000);
  // The rows above the prompt box: what was printed, not the footer.
  const printed = () => {
    const all = s.all().split("\n");
    return all.slice(0, Math.max(0, all.findLastIndex((l) => l.includes("Ask anything")) - 1));
  };
  const is = (i) => (l) => l.includes(`prompt number ${i}`) && !l.includes(`prompt number ${i}0`);
  const n = 8;
  for (let i = 1; i <= n; i++) {
    await submit(`prompt number ${i}`);
    await step(`reply ${i} is printed`, () => printed().filter(is(i)).length >= 2, 20000);
  }
  await submit("tool");
  await step("a tool turn folds into its activity line", () => s.all().includes("read the readme") && /\+ 1 read/.test(s.all()));
  await s.idle(300);
  const all = s.all().split("\n");
  for (let i = 1; i <= n; i++) {
    const rows = all.filter(is(i));
    assert.equal(rows.length, 2, `prompt ${i} and its echo, each once:\n${s.all()}`);
  }
  const order = [...Array(n).keys()].map((i) => all.findIndex((l) => l.includes(`prompt number ${i + 1}`)));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "in order");
  assert.ok(all.length > s.rows, "the transcript went into the scrollback");
  assert.ok(s.screen().includes("Ask anything"), "the footer stays under it");
  console.log("ok   every row printed once, in order, the footer under them");
  s.press("ctrl+c");
  await step("exit splash", () => s.all().includes("Continue lykos-tui --mini -s ledger-1"), 10000);
  console.log(s.all().split("\n").slice(-4).join("\n"));
} finally {
  await s.close();
  // The engine server holds the workspace until it idles out (`--idle 2`).
  await new Promise((r) => setTimeout(r, 3000));
  for (const d of [work, state, engine]) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
