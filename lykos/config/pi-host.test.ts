// P14 ticket 08 (ADR-0027): Pi's agent directory is the generated
// `~/.lykos/pi-host/`. D6.1 here in-process; D6.2 and D6.3 against a real
// session load in a child process with a throwaway home, because both the
// home and `PI_CODING_AGENT_DIR` are process-wide.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adoptPiHost,
  ensurePiHost,
  legacyPiAgentPackages,
  piHostDir,
  piHostSettings,
  renderPiHostSettings,
} from "./pi-host.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("P14 ticket 08 D1: piHostDir", () => {
  it("defaults under homedir()/.lykos/pi-host, never ~/.pi", () => {
    const dir = piHostDir({});
    assert.equal(dir, join(homedir(), ".lykos", "pi-host"));
    assert.ok(!dir.includes(`${join(".pi", "agent")}`), dir);
  });

  it("honours LYKOS_PI_HOST_DIR and ignores an inherited PI_CODING_AGENT_DIR", () => {
    const override = join(tmpdir(), "lykos-pi-host-x");
    assert.equal(piHostDir({ LYKOS_PI_HOST_DIR: override, PI_CODING_AGENT_DIR: "/elsewhere" }), override);
    assert.equal(piHostDir({ PI_CODING_AGENT_DIR: "/elsewhere" }), join(homedir(), ".lykos", "pi-host"));
    assert.equal(piHostDir({ LYKOS_PI_HOST_DIR: "" }), join(homedir(), ".lykos", "pi-host"), "empty is unset");
  });

  it("adoptPiHost sets PI_CODING_AGENT_DIR over an inherited value, on the env it is given", () => {
    const override = join(tmpdir(), "lykos-pi-host-y");
    const env: NodeJS.ProcessEnv = { LYKOS_PI_HOST_DIR: override, PI_CODING_AGENT_DIR: "/home/me/.pi/agent" };
    assert.equal(adoptPiHost(env), override);
    assert.equal(env.PI_CODING_AGENT_DIR, override);
  });
});

describe("P14 ticket 08 D1/D3: ensurePiHost", () => {
  it("creates the directory and writes the generated settings, idempotently", () => {
    const root = tmp("lykos-pi-host-");
    try {
      const dir = join(root, "nested", "pi-host");
      const first = ensurePiHost({ dir });
      assert.equal(first.written, true);
      assert.equal(first.settingsPath, join(dir, "settings.json"));
      assert.equal(readFileSync(first.settingsPath, "utf8"), renderPiHostSettings());
      const mtime = statSync(first.settingsPath).mtimeMs;

      const second = ensurePiHost({ dir });
      assert.equal(second.written, false, "unchanged content is not rewritten");
      assert.equal(statSync(first.settingsPath).mtimeMs, mtime);

      // A setting Pi (or a person) saved into it is replaced by the generated file.
      writeFileSync(first.settingsPath, JSON.stringify({ retry: { enabled: false } }));
      assert.equal(ensurePiHost({ dir }).written, true);
      assert.equal(readFileSync(first.settingsPath, "utf8"), renderPiHostSettings());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("generates no packages list and no retry block (Pi would npm-install a listed package; Pi's retry defaults stay Pi's)", () => {
    const settings = piHostSettings() as Record<string, unknown>;
    assert.deepEqual(settings, {});
    assert.equal("packages" in settings, false);
    assert.equal("retry" in settings, false);
    assert.equal(renderPiHostSettings(), "{}\n");
  });
});

describe("P14 ticket 08 D4: legacy ~/.pi/agent packages, presence only", () => {
  it("lists package directory names, scoped ones expanded, and is undefined when the directory is absent", () => {
    const home = tmp("lykos-legacy-home-");
    try {
      assert.equal(legacyPiAgentPackages(home), undefined);
      const nm = join(home, ".pi", "agent", "npm", "node_modules");
      mkdirSync(join(nm, "@tintinweb", "pi-subagents"), { recursive: true });
      mkdirSync(join(nm, "pi-cache-optimizer"), { recursive: true });
      mkdirSync(join(nm, ".bin"), { recursive: true });
      writeFileSync(join(nm, ".package-lock.json"), "{}");
      const found = legacyPiAgentPackages(home);
      assert.equal(found?.dir, nm);
      assert.deepEqual(found?.names, ["@tintinweb/pi-subagents", "pi-cache-optimizer"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("P14 ticket 08 D6.2/D6.3: a real session load with ~/.pi/agent absent", () => {
  it("starts, loads the extension installed under the pi-host, never touches <home>/.pi, and Pi's getAgentDir() agrees", async () => {
    const root = tmp("lykos-pi-host-load-");
    try {
      const home = join(root, "home");
      const workspace = join(root, "workspace");
      const pihost = join(root, "pi-host");
      mkdirSync(home, { recursive: true });
      mkdirSync(workspace, { recursive: true });
      // The extension, installed where host install puts it: <pi-host>/npm/node_modules/<name>.
      const pkg = join(pihost, "npm", "node_modules", "lykos-probe-ext");
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({ name: "lykos-probe-ext", version: "1.0.0", pi: { extensions: ["./index.ts"] } }),
      );
      const marker = join(root, "probe-loaded.json");
      writeFileSync(
        join(pkg, "index.ts"),
        [
          'import { writeFileSync } from "node:fs";',
          'import { getAgentDir } from "@earendil-works/pi-coding-agent";',
          "export default function probe(pi: { registerCommand?: (name: string, def: unknown) => void }) {",
          `  writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ getAgentDir: getAgentDir(), env: process.env.PI_CODING_AGENT_DIR }));`,
          '  pi.registerCommand?.("lykos-probe", { description: "probe", handler: async () => {} });',
          "}",
          "",
        ].join("\n"),
      );
      const resultPath = join(root, "result.json");
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        // The old default, inherited: ADR-0027 says Lykos overrides it.
        PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
        LYKOS_PI_HOST_DIR: pihost,
        LYKOS_CREDENTIALS_DB: join(root, "credentials.db"),
        LYKOS_PROBE_HOME: home,
        LYKOS_PROBE_WORKSPACE: workspace,
        LYKOS_PROBE_RESULT: resultPath,
        PI_OFFLINE: "1",
      };
      const child = spawn(
        process.execPath,
        ["--import", "tsx", join(repoRoot, "lykos", "session", "pi-host-load-child.ts")],
        { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      let output = "";
      child.stdout!.on("data", (c: Buffer) => (output += c.toString()));
      child.stderr!.on("data", (c: Buffer) => (output += c.toString()));
      const code = await new Promise<number | null>((res, rej) => {
        child.on("error", rej);
        child.on("exit", res);
      });
      assert.equal(code, 0, `child failed:\n${output}`);

      const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
        sessionStarted: boolean;
        envAgentDir: string;
        getAgentDir: string;
        hostExtensionsLoaded: string[];
        hostExtensionsMissing: string[];
        touchedLegacy: string[];
      };
      assert.equal(result.sessionStarted, true, output);
      // D6.3: the process variable and Pi's own resolver both answer the pi-host.
      assert.equal(result.envAgentDir, pihost);
      assert.equal(resolve(result.getAgentDir), resolve(pihost));
      // The extension loaded — by its own side effect, not by Lykos's resolution saying so.
      assert.deepEqual(result.hostExtensionsLoaded, ["lykos-probe-ext"]);
      assert.ok(existsSync(marker), `the probe extension never ran:\n${output}`);
      const seen = JSON.parse(readFileSync(marker, "utf8")) as { getAgentDir: string; env: string };
      assert.equal(resolve(seen.getAgentDir), resolve(pihost), "an extension calling getAgentDir() gets the pi-host");
      assert.equal(seen.env, pihost);
      // Nothing under the home's .pi was read or created.
      assert.deepEqual(result.touchedLegacy, [], "a path under <home>/.pi was touched");
      assert.equal(existsSync(join(home, ".pi")), false, "<home>/.pi was created");
      // The pi-host got its generated settings file.
      assert.equal(readFileSync(join(pihost, "settings.json"), "utf8"), renderPiHostSettings());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
