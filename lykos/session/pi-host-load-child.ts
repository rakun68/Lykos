// Child process for `config/pi-host.test.ts` (P14 ticket 08, plan D6.2/D6.3):
// one real Lykos session boot — the real `DefaultResourceLoader`, the real
// `createAgentSession`, a real extension load — in a process whose home has
// no `~/.pi/agent`, so the parent can prove the session starts, the extension
// under the pi-host loads, and nothing under the home's `.pi` is touched.
//
// It runs in its own process for two reasons: `PI_CODING_AGENT_DIR` is
// process-wide, and `os.homedir()` must answer with a throwaway home.
//
// Before anything imports Pi, every synchronous and promise-based `fs` read
// the loader could use is wrapped, and `syncBuiltinESMExports()` makes the
// wrapped functions what later `import { … } from "node:fs"` bindings see.
// Any path under `<home>/.pi` is recorded. Then it does exactly what
// `lykos/cli.ts` does before dispatch (`adoptPiHost` + `ensurePiHost`) and
// boots.
//
// env: LYKOS_PROBE_HOME, LYKOS_PROBE_WORKSPACE, LYKOS_PROBE_RESULT (JSON out),
//      LYKOS_PI_HOST_DIR, plus whatever PI_CODING_AGENT_DIR the parent passed.

import { createRequire, syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const fs = require("node:fs") as typeof import("node:fs");
const fsp = require("node:fs/promises") as typeof import("node:fs/promises");

const home = process.env.LYKOS_PROBE_HOME;
const workspace = process.env.LYKOS_PROBE_WORKSPACE;
const resultPath = process.env.LYKOS_PROBE_RESULT;
if (!home || !workspace || !resultPath) {
  process.stderr.write("pi-host-load-child: LYKOS_PROBE_HOME, LYKOS_PROBE_WORKSPACE and LYKOS_PROBE_RESULT are required\n");
  process.exit(2);
}

const norm = (p: string): string => resolve(p).replace(/\\/g, "/").toLowerCase();
const legacyRoot = `${norm(join(home, ".pi"))}`;
const touchedLegacy: string[] = [];
const watch = (arg: unknown): void => {
  if (typeof arg !== "string" && !(arg instanceof URL)) return;
  const p = norm(arg instanceof URL ? arg.pathname.replace(/^\/([A-Za-z]:)/, "$1") : arg);
  if (p === legacyRoot || p.startsWith(`${legacyRoot}/`)) touchedLegacy.push(p);
};

const SYNC = [
  "existsSync",
  "statSync",
  "lstatSync",
  "readFileSync",
  "readdirSync",
  "realpathSync",
  "openSync",
  "accessSync",
  "mkdirSync",
  "writeFileSync",
  "stat",
  "lstat",
  "readFile",
  "readdir",
  "access",
  "open",
] as const;
const fsAny = fs as unknown as Record<string, (...args: unknown[]) => unknown>;
for (const name of SYNC) {
  const original = fsAny[name];
  if (typeof original !== "function") continue;
  fsAny[name] = function (this: unknown, ...args: unknown[]) {
    watch(args[0]);
    return original.apply(this, args);
  };
}
const fspAny = fsp as unknown as Record<string, (...args: unknown[]) => unknown>;
for (const name of ["stat", "lstat", "readFile", "readdir", "access", "open", "realpath", "mkdir", "writeFile"]) {
  const original = fspAny[name];
  if (typeof original !== "function") continue;
  fspAny[name] = function (this: unknown, ...args: unknown[]) {
    watch(args[0]);
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();

// What `lykos/cli.ts` does before dispatch, verbatim.
const { adoptPiHost, ensurePiHost } = await import("../config/pi-host.js");
const piHost = adoptPiHost(process.env);
ensurePiHost({ dir: piHost });

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
const { createLykosModelRuntime } = await import("./model-runtime.js");
const { boot } = await import("./boot.js");
const { SHIPPED_DEFAULTS } = await import("../config/defaults.js");
const { AutoApproveGate } = await import("../gate/approval.js");

// The runtime every Lykos session builds; its credential store is the parent's
// tmp LYKOS_CREDENTIALS_DB, and `models.json` defaults to `getAgentDir()`.
const modelRuntime = await createLykosModelRuntime({ providers: {} });
const model = {
  id: "stub",
  name: "stub",
  provider: "lykos-probe",
  api: "anthropic-messages",
  baseUrl: "http://127.0.0.1:9",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8000,
  maxTokens: 1000,
};

const booted = await boot({
  cwd: workspace,
  config: { ...SHIPPED_DEFAULTS, extensions: [{ name: "lykos-probe-ext", version: "1.0.0" }] },
  model: model as never,
  modelRuntime,
  gate: new AutoApproveGate(),
  ledgerPath: ":memory:",
  modelSpec: "lykos-probe/stub",
});

const result = {
  sessionStarted: typeof booted.session.sessionId === "string" && booted.session.sessionId.length > 0,
  envAgentDir: process.env.PI_CODING_AGENT_DIR,
  getAgentDir: getAgentDir(),
  hostExtensionsLoaded: booted.hostExtensions.loaded.map((e) => e.name),
  hostExtensionsMissing: booted.hostExtensions.missing.map((e) => e.name),
  touchedLegacy: [...new Set(touchedLegacy)],
};
fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
try {
  booted.session.dispose?.();
} catch {
  // Tearing down is not what is under test.
}
process.exit(0);
