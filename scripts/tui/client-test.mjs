// Runs crates/client's tests against the real TypeScript engine server (P5 #35): sets LYKOS_SERVE_CMD to this
// checkout's `lykos serve` under tsx, and LYKOS_ENGINE_CHILD to the scripted session child.
//
//   node scripts/tui/client-test.mjs
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsx = import.meta.resolve("tsx", pathToFileURL(join(root, "package.json")).href);
const node = (script) => [process.execPath, "--import", tsx, join(root, script)];
const env = {
  ...process.env,
  LYKOS_SERVE_CMD: JSON.stringify([...node("lykos/cli.ts"), "serve", "--idle", "5"]),
  LYKOS_ENGINE_CHILD: JSON.stringify({ command: process.execPath, args: ["--import", tsx, join(root, "lykos/server/scripted-child.fixture.ts")] }),
};
const r = spawnSync("cargo", ["test", "-p", "lykos-client", "--", "--nocapture"], { cwd: root, env, stdio: "inherit" });
process.exit(r.status ?? 1);
