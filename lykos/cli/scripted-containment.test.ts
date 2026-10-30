// A standalone session can run its commands in a container.
//
// Seam 1 of the spec: a scripted session with a stand-in runtime. The routing
// is the real one, the runtime behind it records instead of starting anything.
// The live half (a real Docker, a real Podman) is containment/live.test.ts.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { startContainment, defaultImageTag, ContainmentError } from "../containment/containment.js";
import { standInRuntime, type RuntimeOperation } from "./scripted-container.js";
import { AutoApproveGate } from "../gate/approval.js";
import { runInteractiveStandaloneSession, type LineSource } from "../session/interactive.js";
import { openLedgerSync } from "../ledger/use.js";
import { call, reply, runScriptedSession, say, SCRIPTED_MODEL, scriptedWorld } from "./scripted-session.js";

class Lines implements LineSource {
  constructor(private readonly lines: string[]) {}
  async next(): Promise<string | null> {
    return this.lines.shift() ?? null;
  }
  close(): void {
    this.lines.length = 0;
  }
}

const QUIET = `feedback:\n  enabled: false\ngate:\n  enabled: false\n`;
const config = (containment: string): string => `${QUIET}containment:\n${containment}`;

/** A command that leaves `LOCAL-<name>` behind if it is run for real on this machine. */
const canary = (name: string): string => `node -e "require('fs').writeFileSync('LOCAL-${name}','x')"`;

const execs = (ops: RuntimeOperation[]) => ops.filter((o): o is Extract<RuntimeOperation, { op: "exec" }> => o.op === "exec");

describe("containment (T173)", () => {
  it("with level required, bash runs inside the container and not on this machine", async () => {
    const runtime = standInRuntime({
      respond: (command) => (command.join(" ").includes("echo from-container") ? { stdout: "from-container\n" } : undefined),
    });
    let seen = "";
    const s = await runScriptedSession({
      config: config("  level: required\n"),
      extra: { containmentDrivers: [runtime.driver] },
      script: [
        reply(call("bash", { command: canary("bash") }), call("bash", { command: "echo from-container" })),
        (context) => {
          seen = JSON.stringify(context.messages.at(-1));
          return reply(say("done"));
        },
      ],
    });
    assert.equal(s.result.status, "ok", JSON.stringify(s.result));

    const ran = execs(runtime.operations).map((o) => o.command);
    assert.deepEqual(ran, [["bash", "-c", canary("bash")], ["bash", "-c", "echo from-container"]]);
    assert.equal(existsSync(join(s.workspace, "LOCAL-bash")), false, "the canary ran on this machine");
    assert.match(seen, /from-container/, "the model saw the container's output");

    // The workspace is what the container was given, at /work, and a command starts there.
    const start = runtime.operations.find((o) => o.op === "start");
    assert.equal(start?.op === "start" && start.spec.mount, "rw");
    assert.equal(execs(runtime.operations).every((o) => o.cwd === "/work"), true);
  });

  it("the gate's test command and the post-edit check run in the container too", async () => {
    const runtime = standInRuntime();
    const s = await runScriptedSession({
      files: { "notes.txt": "draft\n" },
      config:
        `feedback:\n  command: ${JSON.stringify(canary("post-edit"))}\n` +
        `gate:\n  command: ${JSON.stringify(canary("gate"))}\n` +
        `containment:\n  level: required\n`,
      extra: { containmentDrivers: [runtime.driver] },
      script: [reply(call("write", { path: "notes.txt", content: "final\n" })), reply(say("done"))],
    });
    assert.equal(s.result.status, "ok", JSON.stringify(s.result));
    const ran = execs(runtime.operations).map((o) => o.command.at(-1));
    assert.ok(ran.includes(canary("post-edit")), "post-edit check");
    assert.ok(ran.includes(canary("gate")), "gate command");
    assert.equal(s.file("notes.txt"), "final\n", "the file tools still write on the host");
    for (const name of ["post-edit", "gate"]) assert.equal(existsSync(join(s.workspace, `LOCAL-${name}`)), false, name);
  });

  it("with no runtime, required refuses at boot with a clear error and starts no session", async () => {
    const runtime = standInRuntime({ available: false });
    const s = await runScriptedSession({
      config: config("  level: required\n"),
      extra: { containmentDrivers: [runtime.driver] },
      script: [reply(say("never reached"))],
    });
    assert.equal(s.result.status, "error");
    assert.match(s.result.status === "error" ? s.result.message : "", /containment\.level is "required" but no container runtime is available \(podman: podman is not installed\)/);
    assert.equal(s.modelCalls, 0, "the model was never asked");
    assert.deepEqual(runtime.operations.map((o) => o.op), ["probe"], "nothing was built or started");
  });

  it("with no runtime, off (the default) runs on this machine and never looks for one", async () => {
    const runtime = standInRuntime({ available: false });
    const s = await runScriptedSession({
      config: QUIET,
      extra: { containmentDrivers: [runtime.driver] },
      script: [reply(call("bash", { command: canary("off") })), reply(say("done"))],
    });
    assert.equal(s.result.status, "ok", JSON.stringify(s.result));
    assert.equal(existsSync(join(s.workspace, "LOCAL-off")), true, "off runs commands here");
    assert.deepEqual(runtime.operations, [], "off does not probe a runtime");
  });

  it("with no runtime, auto runs here and says so", async () => {
    const runtime = standInRuntime({ available: false });
    const s = await runScriptedSession({
      config: config("  level: auto\n"),
      extra: { containmentDrivers: [runtime.driver] },
      script: [reply(call("bash", { command: canary("auto") })), reply(say("done"))],
    });
    assert.equal(s.result.status, "ok", JSON.stringify(s.result));
    assert.equal(existsSync(join(s.workspace, "LOCAL-auto")), true);
    assert.match(s.stderr, /containment\.level is "auto" and no container runtime is available/);
    assert.equal(s.session().containment_requested, "auto");
    assert.equal(s.session().containment_used, "off");
  });

  it("the container is removed when the session ends", async () => {
    const runtime = standInRuntime();
    const s = await runScriptedSession({
      config: config("  level: required\n"),
      extra: { containmentDrivers: [runtime.driver] },
      script: [reply(call("bash", { command: "true" })), reply(say("done"))],
    });
    assert.equal(s.result.status, "ok", JSON.stringify(s.result));
    assert.deepEqual(runtime.running(), []);
    assert.equal(runtime.operations.filter((o) => o.op === "start").length, 1, "one container for the whole session");
  });

  it("network and resource settings reach the runtime", async () => {
    const runtime = standInRuntime();
    await runScriptedSession({
      config: config("  level: required\n  network: none\n  memory: 1g\n  cpus: '1'\n"),
      extra: { containmentDrivers: [runtime.driver] },
      script: [reply(say("done"))],
    });
    const start = runtime.operations.find((o) => o.op === "start");
    assert.ok(start?.op === "start");
    assert.equal(start.spec.network, "none");
    assert.equal(start.spec.memory, "1g");
    assert.equal(start.spec.cpus, "1");
  });

  it("the ledger records level requested and used, runtime, image, network and mount, and lykos show prints them", async () => {
    const runtime = standInRuntime({ name: "docker", version: "27.1.0" });
    const contained = await runScriptedSession({
      config: config("  level: required\n"),
      extra: { containmentDrivers: [runtime.driver] },
      script: [reply(say("done"))],
    });
    const row = contained.session();
    assert.equal(row.containment_requested, "required");
    assert.equal(row.containment_used, "required");
    assert.equal(row.container_runtime, "docker");
    assert.equal(row.container_runtime_version, "27.1.0");
    assert.equal(row.container_image, defaultImageTag());
    assert.equal(row.container_network, "open");
    assert.equal(row.container_mount, "rw");
    assert.match(contained.show(), new RegExp(`contained  required  docker 27\\.1\\.0  image ${defaultImageTag().replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}  network=open mount=rw`));

    const plain = await runScriptedSession({ config: QUIET, script: [reply(say("done"))] });
    const plainRow = plain.session();
    assert.equal(plainRow.containment_requested, "off");
    assert.equal(plainRow.containment_used, "off");
    for (const column of ["container_runtime", "container_runtime_version", "container_image", "container_network", "container_mount"]) {
      assert.equal(plainRow[column], null, column);
    }
    assert.match(plain.show(), /contained  off\n/);
  });

  it("lykos show's where line agrees with the containment record", async () => {
    const runtime = standInRuntime({ name: "docker", version: "27.1.0" });
    const contained = await runScriptedSession({
      config: config("  level: required\n"),
      extra: { containmentDrivers: [runtime.driver] },
      script: [reply(say("done"))],
    });
    const where = /^ where .*$/m.exec(contained.show())?.[0] ?? "";
    assert.match(where, /commands in docker/);
    assert.ok(where.includes(`image ${defaultImageTag()}`), where);
    assert.doesNotMatch(where, /none - host/);

    const plain = await runScriptedSession({ config: QUIET, script: [reply(say("done"))] });
    assert.match(/^ where .*$/m.exec(plain.show())?.[0] ?? "", /image \(none - host\)/);
  });
});

describe("the model sees only host paths (T174)", () => {
  const toolText = (message: unknown): string => (message as { content: Array<{ text: string }> }).content[0]?.text ?? "";
  const OUTSIDE = process.platform === "win32" ? "C:/Elsewhere/notes.txt" : "/elsewhere/notes.txt";

  it("a host path in a command reaches the container as /work, and /work in the output reaches the model as the host path", async () => {
    const runtime = standInRuntime({
      respond: (command) =>
        command.at(-1)?.startsWith("cat ")
          ? { stdout: "hello\n", stderr: "see /work/src/a.ts:3 and /usr/lib/x and /workspace/y\n" }
          : undefined,
    });
    let workspace = "";
    let seen = "";
    const s = await runScriptedSession({
      files: { "src/a.ts": "x\n" },
      config: config("  level: required\n"),
      setup: (w) => (workspace = w),
      extra: { containmentDrivers: [runtime.driver] },
      script: [
        () => reply(call("bash", { command: `cat ${join(workspace, "src", "a.ts")}; echo ${OUTSIDE}` })),
        (context) => {
          seen = toolText(context.messages.at(-1));
          return reply(say("done"));
        },
      ],
    });
    assert.equal(s.result.status, "ok", JSON.stringify(s.result));
    assert.deepEqual(execs(runtime.operations).map((o) => o.command.at(-1)), [`cat /work/src/a.ts; echo ${OUTSIDE}`]);
    assert.ok(seen.includes(`see ${join(workspace, "src", "a.ts")}:3 and /usr/lib/x and /workspace/y`), seen);
    assert.ok(!seen.includes("/work/src"), seen);
  });

  it("a program's arguments and working directory map too, and a Windows-style workspace maps in every drive-letter form", async () => {
    const runtime = standInRuntime({ respond: () => ({ stdout: "ok /work/lib/x.js\n" }) });
    const ws = process.platform === "win32" ? "C:\\Users\\dev\\proj" : "/home/dev/proj";
    const c = await startContainment({ config: { level: "required" }, workspace: ws, drivers: [runtime.driver] });
    const child = c.executor.spawn("node", [join(ws, "lib", "x.js")], { cwd: join(ws, "lib") });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    await new Promise((done) => child.once("close", done));
    const ran = execs(runtime.operations).at(-1);
    assert.deepEqual(ran?.command, ["node", "/work/lib/x.js"]);
    assert.equal(ran?.cwd, "/work/lib");
    assert.equal(out, `ok ${join(ws, "lib", "x.js")}\n`);
    await c.dispose();
  });
});

describe("the container boundary (T175)", () => {
  const startSpec = (runtime: ReturnType<typeof standInRuntime>) => {
    const op = runtime.operations.find((o) => o.op === "start");
    assert.ok(op?.op === "start", "a container was started");
    return op.spec;
  };
  const relPaths = (workspace: string, paths: readonly string[]): string[] =>
    paths.map((p) => relative(workspace, p).split("\\").join("/")).sort();

  it(".git, .lykos and .pi are protected in the container when they exist, and only then", async () => {
    const runtime = standInRuntime();
    const s = await runScriptedSession({
      files: { ".git/config": "[core]\n", ".pi/settings.json": "{}\n", "src/a.ts": "x\n" },
      config: config("  level: required\n"),
      extra: { containmentDrivers: [runtime.driver] },
      script: [reply(say("done"))],
    });
    const spec = startSpec(runtime);
    const protectedRel = relPaths(s.workspace, spec.protect);
    assert.ok(protectedRel.includes(".git") && protectedRel.includes(".pi"), protectedRel.join());
    assert.deepEqual(protectedRel.filter((p) => ![".git", ".lykos", ".pi"].includes(p)), []);
    assert.equal(spec.mount, "rw", "the workspace is writable, so the protection is what keeps these read-only");
  });

  it("files matching the deny list are shadowed by empty mounts; others, and installed packages, are not", async () => {
    const runtime = standInRuntime();
    const s = await runScriptedSession({
      files: {
        ".env": "TOKEN=1\n",
        ".env.local": "TOKEN=2\n",
        ".npmrc": "//registry:_authToken=x\n",
        "config/prod.pem": "key\n",
        "deploy/id_rsa": "key\n",
        "src/main.ts": "ok\n",
        "node_modules/pkg/.env": "not ours\n",
      },
      config: config("  level: required\n"),
      extra: { containmentDrivers: [runtime.driver] },
      script: [reply(say("done"))],
    });
    const spec = startSpec(runtime);
    assert.deepEqual(relPaths(s.workspace, spec.shadows.map((x) => x.path)), [".env", ".env.local", ".npmrc", "config/prod.pem", "deploy/id_rsa"]);
    assert.equal(s.file(".env"), "TOKEN=1\n", "the host's own copy is untouched");
  });

  it("the deny list is configurable: a project's patterns add to the shipped ones", async () => {
    const runtime = standInRuntime();
    const s = await runScriptedSession({
      files: { ".env": "a\n", "private/prod.json": "b\n", "private/readme.md": "c\n", "other/prod.json": "d\n" },
      config: config("  level: required\n  secret_paths: ['private/*.json']\n"),
      extra: { containmentDrivers: [runtime.driver] },
      script: [reply(say("done"))],
    });
    assert.deepEqual(relPaths(s.workspace, startSpec(runtime).shadows.map((x) => x.path)), [".env", "private/prod.json"]);
  });

  it("a shadowed file and a shadowed directory are told apart, and nothing from this machine backs them", async () => {
    const runtime = standInRuntime();
    const dir = mkdtempSync(join(tmpdir(), "lykos-boundary-"));
    writeFileSync(join(dir, ".env"), "TOKEN=1\n");
    mkdirSync(join(dir, "keys.pem"));
    writeFileSync(join(dir, "keys.pem", "inner.txt"), "secret\n");
    const c = await startContainment({ config: { level: "required" }, workspace: dir, drivers: [runtime.driver] });
    const { shadows } = startSpec(runtime);
    assert.deepEqual(
      shadows.map((x) => [relPaths(dir, [x.path])[0], x.dir]).sort(),
      [[".env", false], ["keys.pem", true]],
    );
    assert.equal(shadows.every((x) => Object.keys(x).sort().join() === "dir,path"), true, "no host source path is involved");
    await c.dispose();
  });


  it("a command's environment is the fixed base plus the allowlisted names, never the host's", async () => {
    const runtime = standInRuntime();
    process.env.LYKOS_T175_ALLOWED = "yes";
    process.env.LYKOS_T175_SECRET = "hunter2";
    try {
      await runScriptedSession({
        config: config("  level: required\n  env_allowlist: [LYKOS_T175_ALLOWED, LYKOS_T175_ABSENT]\n"),
        extra: { containmentDrivers: [runtime.driver] },
        script: [reply(call("bash", { command: "env" })), reply(say("done"))],
      });
    } finally {
      delete process.env.LYKOS_T175_ALLOWED;
      delete process.env.LYKOS_T175_SECRET;
    }
    const env = execs(runtime.operations).at(0)?.env;
    assert.ok(env, "a command reached the container");
    assert.equal(env.LYKOS_T175_ALLOWED, "yes", "an allowlisted name that the host has is passed");
    assert.equal("LYKOS_T175_ABSENT" in env, false, "an allowlisted name the host lacks is not invented");
    assert.equal("LYKOS_T175_SECRET" in env, false);
    assert.equal("PATH" in env, false, "the host's PATH is not forwarded; the image has its own");
    assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
    assert.equal(env.HOME, "/tmp");
  });

  it("a container whose files would not belong to the host user is refused at start, and removed", async () => {
    const runtime = standInRuntime({ ownershipError: "a file written in the container is owned by uid 0" });
    await assert.rejects(
      startContainment({ config: { level: "required" }, workspace: tmpdir(), drivers: [runtime.driver] }),
      (err: unknown) => err instanceof ContainmentError && /owned by uid 0/.test(err.message),
    );
    assert.deepEqual(runtime.running(), [], "the container that failed the check is gone");
  });

  it("a read-only workspace is not asked for an ownership check, since nothing is written", async () => {
    const runtime = standInRuntime({ ownershipError: "would fail" });
    const c = await startContainment({ config: { level: "required" }, workspace: tmpdir(), mount: "ro", drivers: [runtime.driver] });
    await c.dispose();
    assert.equal(runtime.operations.some((o) => o.op === "checkOwnership"), false);
  });
});

describe("containment in an interactive session (T173)", () => {
  const run = async (containment: string, runtime: ReturnType<typeof standInRuntime>, script: Parameters<typeof scriptedWorld>[0]["script"]) => {
    const world = await scriptedWorld({ config: config(containment), script });
    const result = await runInteractiveStandaloneSession({
      workspace: world.workspace,
      ledgerPath: world.ledgerPath,
      model: SCRIPTED_MODEL,
      nativeProviders: [world.provider],
      lineSource: new Lines(["go", "/exit"]),
      approvalGate: new AutoApproveGate(),
      containmentDrivers: [runtime.driver],
    });
    world.check();
    return { world, result };
  };
  const row = (world: { ledgerPath: string }): Record<string, unknown> => {
    const ledger = openLedgerSync(world.ledgerPath);
    try {
      return ledger.db.prepare("SELECT * FROM sessions ORDER BY started_utc DESC LIMIT 1").get() as Record<string, unknown>;
    } finally {
      ledger.close();
    }
  };

  it("required runs bash in the container, records it, and removes the container", async () => {
    const runtime = standInRuntime();
    const { world, result } = await run("  level: required\n", runtime, [reply(call("bash", { command: canary("tui") })), reply(say("done"))]);
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.deepEqual(execs(runtime.operations).map((o) => o.command), [["bash", "-c", canary("tui")]]);
    assert.equal(existsSync(join(world.workspace, "LOCAL-tui")), false, "ran on this machine");
    assert.deepEqual(runtime.running(), []);
    const r = row(world);
    assert.equal(r.containment_requested, "required");
    assert.equal(r.containment_used, "required");
    assert.equal(r.container_runtime, "podman");
    assert.equal(r.container_image, defaultImageTag());
  });

  it("required with no runtime refuses before the model is asked", async () => {
    const runtime = standInRuntime({ available: false });
    const { world, result } = await run("  level: required\n", runtime, [reply(say("never"))]);
    assert.equal(result.status, "error");
    assert.match(result.status === "error" ? result.message : "", /"required" but no container runtime is available/);
    assert.equal(world.modelCalls(), 0);
  });

  it("off records off/off and auto without a runtime runs here", async () => {
    const off = await run("  level: off\n", standInRuntime(), [reply(say("done"))]);
    assert.equal(row(off.world).containment_requested, "off");
    assert.equal(row(off.world).containment_used, "off");
    const auto = await run("  level: auto\n", standInRuntime({ available: false }), [reply(call("bash", { command: canary("auto-tui") })), reply(say("done"))]);
    assert.equal(existsSync(join(auto.world.workspace, "LOCAL-auto-tui")), true);
    assert.equal(row(auto.world).containment_used, "off");
    assert.equal(row(auto.world).containment_requested, "auto");
  });
});

describe("the default image (T173)", () => {
  const dockerfile = (text: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-dockerfile-"));
    const path = join(dir, "Dockerfile");
    writeFileSync(path, text);
    return path;
  };
  const start = (runtime: ReturnType<typeof standInRuntime>, file: string) =>
    startContainment({ config: { level: "required" }, workspace: tmpdir(), drivers: [runtime.driver], dockerfile: file });
  const builds = (runtime: ReturnType<typeof standInRuntime>) => runtime.operations.filter((o) => o.op === "build");

  it("is built once on first use and reused, and a changed Dockerfile is a new tag and a rebuild", async () => {
    const runtime = standInRuntime();
    const file = dockerfile("FROM scratch\n# one\n");

    const first = await start(runtime, file);
    await first.dispose();
    assert.equal(builds(runtime).length, 1, "built on first use");

    const second = await start(runtime, file);
    await second.dispose();
    assert.equal(builds(runtime).length, 1, "reused, not rebuilt");

    const changed = dockerfile("FROM scratch\n# two\n");
    assert.notEqual(defaultImageTag(file), defaultImageTag(changed));
    const third = await start(runtime, changed);
    await third.dispose();
    assert.equal(builds(runtime).length, 2, "a changed Dockerfile rebuilds");
    assert.deepEqual(
      builds(runtime).map((o) => o.op === "build" && o.tag),
      [defaultImageTag(file), defaultImageTag(changed)],
    );
  });

  it("the tag is the same for the same bytes wherever the file lives", () => {
    assert.equal(defaultImageTag(dockerfile("FROM scratch\n")), defaultImageTag(dockerfile("FROM scratch\n")));
    assert.match(defaultImageTag(), /^lykos\/toolchain:[0-9a-f]{12}$/);
  });
});

describe("container lifecycle (T173)", () => {
  it("removes containers left by a run that no longer exists, and keeps one whose owner is alive", async () => {
    const runtime = standInRuntime();
    runtime.leftover.push(
      { id: "orphan", labels: { "lykos.owner": "2147483646" } },
      { id: "live", labels: { "lykos.owner": String(process.pid) } },
    );
    const c = await startContainment({ config: { level: "required" }, workspace: tmpdir(), drivers: [runtime.driver] });
    const removed = runtime.operations.filter((o) => o.op === "remove").map((o) => o.op === "remove" && o.id);
    assert.deepEqual(removed, ["orphan"]);
    await c.dispose();
  });

  it("a start that hangs is abandoned and the container it was starting is removed", async () => {
    const runtime = standInRuntime({ hangOnStart: true });
    await assert.rejects(
      startContainment({ config: { level: "required" }, workspace: tmpdir(), drivers: [runtime.driver], startupTimeoutMs: 50 }),
      (err: unknown) => err instanceof ContainmentError && /did not start within 50ms/.test(err.message),
    );
    assert.deepEqual(runtime.running(), [], "nothing is left running");
  });

  it("auto prefers the first runtime that answers, so Podman before Docker by default", async () => {
    const podman = standInRuntime({ name: "podman" });
    const docker = standInRuntime({ name: "docker" });
    const c = await startContainment({ config: { level: "required" }, workspace: tmpdir(), drivers: [podman.driver, docker.driver] });
    assert.equal(c.record.runtime, "podman");
    assert.deepEqual(docker.operations, [], "docker was never asked");
    await c.dispose();

    const forced = await startContainment({
      config: { level: "required", runtime: "docker" },
      workspace: tmpdir(),
      drivers: [podman.driver, docker.driver],
    });
    assert.equal(forced.record.runtime, "docker");
    await forced.dispose();
  });
});
