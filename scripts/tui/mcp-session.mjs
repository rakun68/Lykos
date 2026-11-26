// A session in lykos-tui, driven only through a TUI-testing MCP server (P5 #56): what a person does first, checked by
// what the screen shows. The MCP server is tui-mcp (github.com/nvms/tui-mcp, MIT), which runs the program in a real
// pty (node-pty) and reads the screen from a terminal emulator (xterm-headless); its screenshot tool is for looking
// at the visuals, and this script uses only its text tools.
//
//   npm run build && node scripts/tui/mcp-session.mjs
//
// TUI_MCP names the server's entry file (`.../tui-mcp/src/server.js`); without it, `npx -y tui-mcp@1.2.3` runs it.
// Sessions run on the scripted child, so no model is called; HOME is a temporary directory.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsx = import.meta.resolve("tsx", pathToFileURL(join(root, "package.json")).href);
const dirs = ["home", "engine", "state", "work"].map((d) => mkdtempSync(join(tmpdir(), `lykos-mcp-${d}-`)));
const [home, engine, state, work] = dirs;
for (const args of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]]) execFileSync("git", args, { cwd: work });
mkdirSync(join(home, ".lykos"), { recursive: true });
writeFileSync(join(home, ".lykos", "config.yaml"), "tui:\n  server_idle_seconds: 0\n");
const env = {
  HOME: home,
  USERPROFILE: home,
  LYKOS_ENGINE_DIR: engine,
  LYKOS_TUI_DIR: state,
  LYKOS_ENGINE_CHILD: JSON.stringify({ command: process.execPath, args: ["--import", tsx, join(root, "lykos/server/scripted-child.fixture.ts")] }),
  LYKOS_SERVE_CMD: "",
  LYKOS_TRUST_WORKSPACE: "",
  // A build of the TUI elsewhere, when the one in target/ is held by a running TUI.
  ...(process.env.LYKOS_TUI_BIN ? { LYKOS_TUI_BIN: process.env.LYKOS_TUI_BIN } : {}),
};

const server = process.env.TUI_MCP
  ? { command: process.execPath, args: [process.env.TUI_MCP] }
  : { command: process.platform === "win32" ? "npx.cmd" : "npx", args: ["-y", "tui-mcp@1.2.3"] };
const client = new Client({ name: "lykos-mcp-session", version: "1" });
await client.connect(new StdioClientTransport({ ...server, stderr: "ignore" }));

/** Calls a tool; its text, or a thrown error with it when the tool says it failed. */
async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.map((c) => c.text ?? "").join("");
  if (r.isError) throw new Error(`${name}: ${text}`);
  return text;
}

let id;
let failed = false;
const step = async (name, run) => {
  try {
    await run();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}: ${e.message}\n${id ? await call("snapshot", { sessionId: id }).catch(() => "") : ""}`);
    throw e;
  }
};
const waitText = (pattern, timeout = 30000) => call("wait_for_text", { sessionId: id, pattern, timeout });
const screen = () => call("snapshot", { sessionId: id });

try {
  // The command a person types: `lykos`, in a repository it has not trusted yet.
  await step("lykos starts and asks to trust the workspace", async () => {
    id = JSON.parse(await call("launch", { command: `${process.platform === "win32" ? "node.exe" : "node"} ${join(root, "dist", "cli.js").replace(/\\/g, "/")}`, cols: 120, rows: 36, cwd: work, env })).sessionId;
    await waitText("Trust workspace");
  });
  await step("y trusts it and opens the prompt box", async () => {
    await call("send_text", { sessionId: id, text: "y\r" });
    await waitText("Ask anything");
  });
  await step("before any prompt, the metadata row names the default specialist and effort (#58 item 10)", async () => {
    await waitText("Build · ");
  });
  await step("a slash lists commands in a window with a count of the rest (#58 item 1)", async () => {
    await call("send_text", { sessionId: id, text: "/" });
    await waitText("↑ [0-9]+  ↓ [0-9]+");
    await call("send_keys", { sessionId: id, keys: "Down" });
    await call("send_keys", { sessionId: id, keys: "Escape" });
    await call("send_keys", { sessionId: id, keys: "Backspace" });
  });
  await step("/connect before any session lists every provider from the engine server", async () => {
    await call("send_text", { sessionId: id, text: "/connect" });
    await call("wait_for_idle", { sessionId: id, timeout: 3000 });
    await call("send_keys", { sessionId: id, keys: "Enter" });
    await waitText("Add a custom provider");
    await waitText("API key");
  });
  await step("its first row opens the custom provider popup, every field at once", async () => {
    await call("send_keys", { sessionId: id, keys: "Enter" });
    await waitText("Base URL");
    await waitText("Save to");
    await call("send_keys", { sessionId: id, keys: "Escape" });
  });
  await step("the skill list works before any session, from the engine server", async () => {
    await call("send_keys", { sessionId: id, keys: "Ctrl+P" });
    await call("send_text", { sessionId: id, text: "skills" });
    await call("wait_for_idle", { sessionId: id, timeout: 3000 });
    await call("send_keys", { sessionId: id, keys: "Enter" });
    await waitText("No skills in|/skill:");
    await call("send_keys", { sessionId: id, keys: "Escape" });
  });
  await step("a provider search that matches nothing says No match, never loading", async () => {
    await call("send_text", { sessionId: id, text: "/connect" });
    await call("wait_for_idle", { sessionId: id, timeout: 3000 });
    await call("send_keys", { sessionId: id, keys: "Enter" });
    await waitText("Add a custom provider");
    await call("send_text", { sessionId: id, text: "zzqqxx" });
    await waitText("No match");
    if ((await screen()).includes("Loading")) throw new Error("it still says loading");
    await call("send_keys", { sessionId: id, keys: "Escape" });
  });
  await step("anthropic signs in with a browser or an API key, google-antigravity with a browser, in a few words", async () => {
    await call("send_text", { sessionId: id, text: "/connect" });
    await call("wait_for_idle", { sessionId: id, timeout: 3000 });
    await call("send_keys", { sessionId: id, keys: "Enter" });
    await waitText("Add a custom provider");
    await call("send_text", { sessionId: id, text: "anthropic" });
    await waitText("browser · API key");
    for (let i = 0; i < 9; i++) await call("send_keys", { sessionId: id, keys: "Backspace" });
    await call("send_text", { sessionId: id, text: "antigravity" });
    await waitText("google-antigravity +browser");
    await call("send_keys", { sessionId: id, keys: "Escape" });
  });
  await step("/login opens its sign-in popup at once and starts no session", async () => {
    // A provider the runtime does not know: the server's sign-in fails before any browser opens.
    await call("send_text", { sessionId: id, text: "/login nowhere-provider" });
    await call("wait_for_idle", { sessionId: id, timeout: 3000 });
    await call("send_keys", { sessionId: id, keys: "Enter" });
    await waitText("Sign in to nowhere-provider");
    await waitText("unknown provider");
    await call("send_keys", { sessionId: id, keys: "Escape" });
    if ((await screen()).includes("Build · Scripted")) throw new Error("a session started");
  });
  await step("a command before any session sets what the next one starts with, and starts none", async () => {
    await call("send_text", { sessionId: id, text: "/compact" });
    await call("wait_for_idle", { sessionId: id, timeout: 3000 });
    await call("send_keys", { sessionId: id, keys: "Enter" });
    await waitText("needs a conversation");
    if ((await screen()).includes("Build · Scripted")) throw new Error("a session started");
  });
  await step("the model list opens before any session: a section per connected provider, or how to connect one", async () => {
    await call("send_text", { sessionId: id, text: "/model" });
    await call("wait_for_idle", { sessionId: id, timeout: 3000 });
    await call("send_keys", { sessionId: id, keys: "Enter" });
    await waitText("Select model");
    await waitText("No provider connected: /connect adds one|Select models…");
    await call("send_keys", { sessionId: id, keys: "Escape" });
  });
  await step("a typed prompt is sent with Enter and answered", async () => {
    await call("send_text", { sessionId: id, text: "hello through the mcp" });
    await waitText("hello through the mcp");
    await call("send_keys", { sessionId: id, keys: "Enter" });
    await waitText("hello through the mcp[\\s\\S]*hello through the mcp");
  });
  await step("model, context and effort are on screen once the session runs", async () => {
    // The model's name arrives with the session the engine server starts.
    // #58 item 3: the specialist, then the model's display name.
    await waitText("Build · Scripted");
  });
  await step("ctrl+p opens the palette of every action", async () => {
    await call("send_keys", { sessionId: id, keys: "Ctrl+P" });
    await waitText("Exit the application");
    // #58 items 6 and 11: a search box, and the slash commands in a group of their own.
    await waitText("Search commands");
    await call("wait_for_idle", { sessionId: id, timeout: 3000 });
  });
  await step("typing filters the palette", async () => {
    await call("send_text", { sessionId: id, text: "model" });
    await waitText("[Mm]odel");
    await call("wait_for_idle", { sessionId: id, timeout: 3000 });
    if ((await screen()).includes("Exit the application")) throw new Error("the palette was not filtered");
  });
  await step("escape closes it, and the prompt box is back", async () => {
    await call("send_keys", { sessionId: id, keys: "Escape" });
    await call("wait_for_idle", { sessionId: id, timeout: 3000 });
    const s = await screen();
    if (!s.includes("hello through the mcp")) throw new Error("the transcript is gone");
  });
  await step("a setting in the palette changes in place and the palette stays", async () => {
    await call("send_keys", { sessionId: id, keys: "Ctrl+P" });
    await call("send_text", { sessionId: id, text: "verbosity" });
    await waitText("Verbosity: ");
    const before = (await screen()).match(/Verbosity: (\w+)/)[1];
    await call("send_keys", { sessionId: id, keys: "Enter" });
    await call("wait_for_idle", { sessionId: id, timeout: 3000 });
    const after = (await screen()).match(/Verbosity: (\w+)/)?.[1];
    if (!after || after === before) throw new Error(`verbosity ${before} -> ${after}`);
    await call("send_keys", { sessionId: id, keys: "Left" });
    await waitText(`Verbosity: ${before}`);
    await call("send_keys", { sessionId: id, keys: "Escape" });
  });
  await step("skills are one palette row that opens their own list", async () => {
    await call("send_keys", { sessionId: id, keys: "Ctrl+P" });
    await call("send_text", { sessionId: id, text: "skills" });
    await call("wait_for_idle", { sessionId: id, timeout: 3000 });
    await call("send_keys", { sessionId: id, keys: "Enter" });
    await waitText("Search skills");
    await call("send_keys", { sessionId: id, keys: "Escape" });
  });
  await step("/help lists the keys", async () => {
    await call("send_text", { sessionId: id, text: "/help" });
    await call("wait_for_idle", { sessionId: id, timeout: 3000 });
    await call("send_keys", { sessionId: id, keys: "Enter" });
    await waitText("[Cc]trl\\+[Pp]");
    await call("send_keys", { sessionId: id, keys: "Escape" });
  });
  await step("/context opens its window and the session fills it by part", async () => {
    await call("send_text", { sessionId: id, text: "/context" });
    await call("wait_for_idle", { sessionId: id, timeout: 3000 });
    await call("send_keys", { sessionId: id, keys: "Enter" });
    await waitText("Estimated usage by category");
    await waitText("Free space");
    await call("send_keys", { sessionId: id, keys: "Escape" });
  });
  await step("/connect lists providers under a row to add a custom one", async () => {
    await call("send_text", { sessionId: id, text: "/connect" });
    await call("wait_for_idle", { sessionId: id, timeout: 3000 });
    await call("send_keys", { sessionId: id, keys: "Enter" });
    await waitText("Add a custom provider");
    await call("send_keys", { sessionId: id, keys: "Escape" });
  });
  await step("ctrl+c twice quits lykos, the first one says so (#58 item 5)", async () => {
    await call("send_keys", { sessionId: id, keys: "Ctrl+C" });
    await waitText("again to exit");
    await new Promise((r) => setTimeout(r, 200));
    await call("send_keys", { sessionId: id, keys: "Ctrl+C" });
    await call("wait_for_exit", { sessionId: id, timeout: 20000 });
  });
} catch {
  // Reported by the step.
} finally {
  await client.close().catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (e) {
      // A server that has not exited yet holds the workspace open; the directory is the OS's temp, so it is left.
      console.log(`left ${d}: ${e.code}`);
    }
  }
}
process.exit(failed ? 1 : 0);
