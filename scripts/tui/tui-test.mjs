// Drives the built TUI in a real pty against the real TypeScript engine server and its scripted session child
// (P5 #37, #38): a prompt starts a session and its reply streams in; Esc twice interrupts; `/` and `@` complete;
// a queued prompt waits for the turn; /btw answers aside; stash and history recall; sessions and tabs (#42);
// ctrl+c quits.
//
//   cargo build --release -p lykos-tui && node scripts/tui/tui-test.mjs [binary]
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
writeFileSync(join(work, "notes.md"), "# notes\n");
const env = {
  LYKOS_ENGINE_DIR: engine,
  LYKOS_TUI_DIR: state,
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
// On Windows a run of keys that arrive together is a paste, and a return inside it is a newline: wait for the
// text before the return, as a person does.
const type = async (text) => {
  for (const k of text) {
    s.write(k);
    await new Promise((r) => setTimeout(r, 30));
  }
};
const key = async (...keys) => {
  for (const k of keys) {
    s.press(k);
    await new Promise((r) => setTimeout(r, 60));
  }
};
const submit = async (text) => {
  s.write(text);
  await s.waitFor(() => s.screen().includes(text), 10000);
  await s.idle(150);
  s.press("enter");
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
  await submit("tool");
  await step("a tool call folds into its activity line at low verbosity", () => s.screen().includes("+ 1 read"));
  // The palette's verbosity entry: low, medium, high, and back to low.
  const verbosity = async (now) => {
    await key("ctrl+p");
    await type("verbosity");
    await step(`the palette offers Verbosity: ${now}`, () => s.screen().includes(`Verbosity: ${now}`));
    await key("enter");
  };
  await verbosity("Low");
  await verbosity("Medium");
  await step("a tool call shows with its icon at high verbosity", () => s.screen().includes("→ read README.md"));
  await verbosity("High");
  await step("back to low", () => s.screen().includes("+ 1 read"));
  await step("model, effort and context use update", () => s.screen().includes("faux/scripted · high") && s.screen().includes("12,345 tokens · 6% used"));
  await submit("hold");
  await step("a running turn offers esc interrupt", () => s.screen().includes("esc interrupt"));
  s.press("esc");
  await step("the first esc arms", () => s.screen().includes("esc again to interrupt"));
  s.press("esc");
  await step("the second esc interrupts", () => s.screen().includes("interrupted"));
  await submit("ask");
  await step("a question shows with its options", () => s.screen().includes("which?") && s.screen().includes("1 a"));
  s.write("1");
  await step("an option's key answers it", () => !s.screen().includes("which?") && !s.screen().includes("esc interrupt"));
  await type("/sk");
  await step("/ completes the session's commands", () => s.screen().includes("/skill:tdd"));
  s.press("tab");
  await step("tab inserts the command", () => s.screen().includes("/skill:tdd ") && !s.screen().includes("tests first"));
  s.press("ctrl+c");
  await type("see @no");
  await step("@ completes files", () => s.screen().includes("notes.md"));
  s.press("enter");
  await step("enter inserts the file", () => s.screen().includes("see @notes.md"));
  s.press("ctrl+c");
  await submit("hold");
  await step("a turn runs", () => s.screen().includes("esc interrupt"));
  s.write("later");
  s.press("ctrl+x");
  s.press("enter");
  await step("leader enter queues the prompt", () => s.screen().includes("queued: later"));
  await submit("release");
  await step("the queued prompt goes once the turn ends", () => !s.screen().includes("queued: later") && s.screen().split("later").length - 1 >= 2);
  await step("idle again", () => !s.screen().includes("esc interrupt"));
  await submit("/btw why?");
  await step("/btw answers in a dialog", () => s.screen().includes("aside: why?"));
  s.press("esc");
  await step("esc closes it, and the aside is not in the transcript", () => !s.screen().includes("aside: why?"));
  s.press("up");
  await step("up recalls the last prompt", () => s.screen().includes("/btw why?"));
  s.press("ctrl+c");
  s.write("keep");
  s.press("home");
  await type("/stash");
  s.press("enter");
  await step("/stash empties the box", () => !s.screen().includes("keep"));
  await type("/stash pop");
  await step("the menu offers it", () => s.screen().includes("Pop the last stashed prompt"));
  // Apart: an esc and a return in one read are alt+return.
  s.press("esc");
  await step("esc hides the menu", () => !s.screen().includes("Pop the last stashed prompt"));
  s.press("enter");
  await step("/stash pop brings it back", () => s.screen().includes("keep") && !s.screen().includes("/stash"));
  s.press("ctrl+c");
  // Sessions and tabs (P5 #42): a new session opens the home screen, its first prompt opens a second tab, the
  // tabs switch, the session list opens, and a closed tab's neighbour shows.
  const top = () => s.screen().split("\n")[0];
  await key("ctrl+x", "n");
  await step("a new session opens the home screen", () => s.screen().includes("Ask anything") && !s.screen().includes("hello there"));
  await submit("second session");
  await step("its first prompt opens a second tab", () => /1 .+2 /.test(top()));
  s.write("\x1b[1;3A");
  await step("alt+up shows the first tab", () => s.screen().includes("hello there"));
  await key("ctrl+x", "l");
  await step("the session list opens", () => s.screen().includes("Sessions  Search sessions"));
  s.press("esc");
  await step("esc closes it", () => !s.screen().includes("Search sessions"));
  await key("ctrl+x", "w");
  await step("closing the tab shows its neighbour", () => !/1 .+2 /.test(top()) && s.screen().includes("second session"));
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
  await s.close();
  await new Promise((r) => setTimeout(r, 3000));
  rmSync(work, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
  rmSync(engine, { recursive: true, force: true });
}
