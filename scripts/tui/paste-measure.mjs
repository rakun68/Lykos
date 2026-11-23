// Measures editing with a 1 MB paste in the prompt (P5 #38): keystroke-to-screen latency with the paste as one
// chip, then with the chip expanded into 1 MB of text in the buffer, against a box with no paste. Prints p50 and p95
// in milliseconds. Linux only in practice: ConPTY drops the paste markers and delivers about one key event per 0.5 ms.
//
//   cargo build --release -p lykos-tui && node scripts/tui/paste-measure.mjs [binary]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TuiSession } from "./harness.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const binary = resolve(process.argv[2] ?? join(root, "target", "release", process.platform === "win32" ? "lykos-tui.exe" : "lykos-tui"));
const engine = mkdtempSync(join(tmpdir(), "lykos-paste-engine-"));
// No server: the home screen and its prompt box are what is measured.
const env = { LYKOS_ENGINE_DIR: engine, LYKOS_SERVE_CMD: JSON.stringify(["lykos-no-such-command"]), LYKOS_TUI_DIR: engine };
const line = "0123456789 the quick brown fox jumps over the lazy dog 0123456789\n";
const big = line.repeat(Math.ceil((1 << 20) / line.length)).slice(0, 1 << 20);
const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))];

async function keystrokes(s, n) {
  const out = [];
  let typed = "";
  for (let i = 0; i < n; i++) {
    const ch = "abcdefghijklmnopqrstuvwxyz"[(i * 7) % 26];
    typed += ch;
    const want = typed.slice(-20);
    const sent = performance.now();
    s.write(ch);
    out.push((await s.waitFor(() => s.screen().includes(want), 10000)) - sent);
    await new Promise((r) => setTimeout(r, 5));
  }
  return out;
}

const s = new TuiSession(binary, ["--cwd", engine], { cols: 120, rows: 40, env });
try {
  await s.waitFor("Ask anything", 15000);
  const base = await keystrokes(s, 40);
  console.log(`keystroke, no paste: p50 ${percentile(base, 50).toFixed(2)} ms, p95 ${percentile(base, 95).toFixed(2)} ms`);
  s.press("ctrl+c");
  await s.waitFor(() => s.screen().includes("Ask anything"), 10000);
  const t0 = performance.now();
  s.write(`\x1b[200~${big}\x1b[201~`);
  await s.waitFor(() => s.screen().includes("[Pasted ~"), 60000);
  console.log(`paste of ${big.length} bytes to its chip on screen: ${Math.round(performance.now() - t0)} ms`);
  s.write(" ");
  const chip = await keystrokes(s, 40);
  console.log(`keystroke with the chip: p50 ${percentile(chip, 50).toFixed(2)} ms, p95 ${percentile(chip, 95).toFixed(2)} ms`);
  // Pasting the same text right after its chip expands it (OpenCode `pasteInputText`): first back up to the chip.
  s.write("\x1b[H");
  await s.idle(200);
  s.write("\x1b[F");
  await s.idle(200);
  s.press("ctrl+u");
  await s.waitFor(() => !s.screen().includes("[Pasted ~"), 10000);
  const t1 = performance.now();
  s.write(`\x1b[200~${big}\x1b[201~`);
  await s.waitFor(() => s.screen().includes("[Pasted ~"), 60000);
  s.write(`\x1b[200~${big}\x1b[201~`);
  await s.waitFor(() => !s.screen().includes("[Pasted ~") && s.screen().includes("lazy dog"), 60000);
  console.log(`expanded into the buffer: ${Math.round(performance.now() - t1)} ms`);
  // A new line, so what is typed next is not wrapped across rows: alt+return.
  s.write("\x1b\r");
  await s.idle(200);
  const text = await keystrokes(s, 40);
  console.log(`keystroke with 1 MB of text: p50 ${percentile(text, 50).toFixed(2)} ms, p95 ${percentile(text, 95).toFixed(2)} ms`);
} finally {
  await s.close();
  await new Promise((r) => setTimeout(r, 1000));
  rmSync(engine, { recursive: true, force: true });
}
