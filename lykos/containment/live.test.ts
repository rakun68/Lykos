// The live-runtime suite.
//
// Everything here runs against a real container runtime, once per runtime this
// machine has, and each runtime that is absent is skipped with the reason it
// gave. A runtime that answers `probe` is expected to work: a failure here is
// containment being broken, not the machine being unfit.
//
// Every check that something is blocked has a positive control beside it (a
// write in /work succeeds, the open network reaches out), so a container that
// is simply broken cannot pass by doing nothing.
//
// The first run builds the default toolchain image, which pulls a base image
// and installs packages; later runs find it by its tag and reuse it.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { OWNER_LABEL, startContainment, type Containment } from "./containment.js";
import { createCommandRunner } from "../loop/post-edit.js";
import { runVerificationCommand, runVerify } from "../session/verify-outcome.js";
import { Ledger } from "../ledger/ledger.js";
import { lykosVersion } from "../version.js";
import type { ContainmentConfig } from "../config/types.js";
import { cliRuntime, type ContainerRuntimeDriver, type RuntimeName } from "./runtime.js";
import { defaultImageTag } from "./containment.js";
import { acquireWorktree } from "../git/worktree.js";

const TEN_MINUTES = 10 * 60_000;

interface RunResult {
  exitCode: number | null;
  output: string;
}

/** Runs `command` through the contained executor's bash, the way the `bash` tool does. */
async function bash(c: Containment, workspace: string, command: string, opts: { timeout?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
  let output = "";
  const result = await c.executor.shellOperations("bash").exec(command, workspace, {
    onData: (d) => (output += d.toString("utf8")),
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  return { exitCode: result.exitCode, output };
}

const RUNTIMES: RuntimeName[] = ["podman", "docker"];

for (const name of RUNTIMES) {
  const driver = cliRuntime(name);
  const probed = await driver.probe();
  const skip = probed.available ? false : `${name} is not available on this machine: ${probed.reason}`;

  describe(`live containment on ${name}${probed.available ? ` ${probed.version}` : ""}`, { skip, timeout: TEN_MINUTES }, () => {
    const roots: string[] = [];
    const open: Containment[] = [];

    const workspace = (): string => {
      const dir = mkdtempSync(join(tmpdir(), "lykos-live-"));
      roots.push(dir);
      return dir;
    };
    const start = async (dir: string, config: Pick<ContainmentConfig, "network" | "image" | "secret_paths" | "env_allowlist" | "memory" | "cpus"> = {}, mount?: "rw" | "ro", drivers: readonly ContainerRuntimeDriver[] = [driver], gitWorktree?: { commonDir: string; gitDir: string }) => {
      const c = await startContainment({
        config: { level: "required", runtime: name, ...config },
        workspace: dir,
        drivers,
        ...(mount !== undefined ? { mount } : {}),
        ...(gitWorktree !== undefined ? { gitWorktree } : {}),
        log: (line) => process.stderr.write(`${line}\n`),
      });
      open.push(c);
      return c;
    };

    before(async () => {
      // Builds the image if this machine does not have it yet, so the tests below time only what they test.
      const warm = await start(workspace());
      await warm.dispose();
    });

    after(async () => {
      for (const c of open) await c.dispose();
      for (const dir of roots) rmSync(dir, { recursive: true, force: true });
    });

    it("runs a command in /work, writes through the mount, and the toolchain is there", async () => {
      const dir = workspace();
      writeFileSync(join(dir, "seen.txt"), "from the host\n");
      const c = await start(dir);
      const r = await bash(c, dir, "pwd && cat seen.txt && echo made > made.txt && node --version && git --version && python3 --version");
      assert.equal(r.exitCode, 0, r.output);
      // `pwd` prints /work in the container; the model is shown the host path (T174).
      assert.ok(r.output.startsWith(`${dir}\nfrom the host\n`), r.output);
      assert.match(r.output, /v\d+\.\d+\.\d+/);
      assert.match(r.output, /git version/);
      assert.match(r.output, /Python 3/);
      // The positive control for everything below: a write inside /work reaches the host.
      assert.equal(readFileSync(join(dir, "made.txt"), "utf8"), "made\n");
    });

    it("a command's cwd is the workspace-relative directory, and exit codes come back", async () => {
      const dir = workspace();
      mkdirSync(join(dir, "sub"));
      const c = await start(dir);
      const where = await bash(c, join(dir, "sub"), "pwd");
      assert.equal(where.output.trim(), join(dir, "sub"));
      assert.equal((await bash(c, dir, "exit 7")).exitCode, 7);
      assert.equal((await bash(c, dir, "true")).exitCode, 0);
    });

    it("host paths in a command reach the container as /work paths, and /work paths in its output come back as host paths (T174)", async () => {
      const dir = workspace();
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "sub", "f.txt"), "named by host path\n");
      const c = await start(dir);
      const host = (rel: string): string => join(dir, rel).replaceAll("\\", "/");
      // Every command names the file by host path; only the translation lets the container find it, and `readlink -f`
      // answers with the /work path the container knows it by. A path outside the workspace is left alone.
      const r = await bash(c, dir, `cat ${host("sub/f.txt")} && readlink -f ${host("sub/f.txt")} && echo ${host("..")}/elsewhere`);
      assert.equal(r.exitCode, 0, r.output);
      assert.deepEqual(r.output.trim().split("\n"), ["named by host path", join(dir, "sub", "f.txt"), `${host("..")}/elsewhere`]);
      // An error message names the container's path; the model reads the host's.
      const missing = await bash(c, dir, `cat ${host("sub/missing.txt")}`);
      assert.notEqual(missing.exitCode, 0);
      assert.ok(missing.output.includes(join(dir, "sub", "missing.txt")), missing.output);
      assert.ok(!missing.output.includes("/work"), missing.output);
    });

    it("only /work is shared with the host: a file written elsewhere in the container is not on the host", async () => {
      const dir = workspace();
      const c = await start(dir);
      const r = await bash(c, dir, "echo inside > /tmp/not-shared.txt && echo shared > shared.txt && ls /work");
      assert.equal(r.exitCode, 0, r.output);
      assert.equal(existsSync(join(dir, "shared.txt")), true, "positive control: /work is shared");
      assert.equal(existsSync(join(dir, "not-shared.txt")), false);
      assert.deepEqual(r.output.trim().split("\n").sort(), ["shared.txt"]);
    });

    it("the host environment does not reach the container", async () => {
      const dir = workspace();
      process.env.LYKOS_LIVE_SECRET = "hunter2-should-not-cross";
      try {
        const c = await start(dir);
        const r = await bash(c, dir, "env");
        assert.equal(r.exitCode, 0);
        assert.match(r.output, /^HOME=/m, "positive control: the container has an environment of its own");
        assert.doesNotMatch(r.output, /LYKOS_LIVE_SECRET|hunter2/);
      } finally {
        delete process.env.LYKOS_LIVE_SECRET;
      }
    });

    it("network none cuts the container off, and open reaches out", async () => {
      const reach = `node -e "const s=require('net').connect(443,'1.1.1.1');s.setTimeout(4000);s.on('connect',()=>{console.log('reached');process.exit(0)});s.on('timeout',()=>process.exit(2));s.on('error',()=>process.exit(3))"`;
      const openDir = workspace();
      const control = await bash(await start(openDir, { network: "open" }), openDir, reach);
      assert.match(control.output, /reached/, "positive control: the open network reaches out");

      const dir = workspace();
      const none = await start(dir, { network: "none" });
      const blocked = await bash(none, dir, reach);
      assert.notEqual(blocked.exitCode, 0, "none must block egress");
      assert.doesNotMatch(blocked.output, /reached/);
      assert.equal(none.record.network, "none");
    });

    it("a read-only mount refuses writes that a read-write mount allows", async () => {
      const dir = workspace();
      writeFileSync(join(dir, "a.txt"), "a\n");
      const ro = await start(dir, {}, "ro");
      const refused = await bash(ro, dir, "echo x > b.txt");
      assert.notEqual(refused.exitCode, 0);
      assert.equal(existsSync(join(dir, "b.txt")), false);
      assert.equal((await bash(ro, dir, "cat a.txt")).output, "a\n", "positive control: it can still read");
    });

    it("a command that is aborted is stopped inside the container and reports failure, never success", async () => {
      const dir = workspace();
      const c = await start(dir);
      // The pattern's `[1]` keeps pgrep from matching the very command line that carries it.
      const running_ = "sleep 31719";
      const probe = `pgrep -f 'sleep 3171[9]' >/dev/null && echo yes || echo no`;
      const abort = new AbortController();
      const running = bash(c, dir, running_, { signal: abort.signal });

      // Positive control: the command really is running in there before it is stopped.
      const deadline = Date.now() + 15_000;
      let seen = false;
      while (!seen && Date.now() < deadline) {
        seen = (await bash(c, dir, probe)).output.trim() === "yes";
        if (!seen) await new Promise((r) => setTimeout(r, 250));
      }
      assert.equal(seen, true, "the command never started");

      const began = Date.now();
      abort.abort();
      await assert.rejects(running, /aborted/);
      assert.ok(Date.now() - began < 10_000, "abort did not return promptly");

      // Gone from inside the container, not merely abandoned by the client.
      let gone = false;
      for (let i = 0; i < 20 && !gone; i++) {
        gone = (await bash(c, dir, probe)).output.trim() === "no";
        if (!gone) await new Promise((r) => setTimeout(r, 250));
      }
      assert.equal(gone, true, "the aborted command is still running in the container");
    });

    it("a timeout stops the command and rejects; a killed child closes with its signal and no exit code", async () => {
      const dir = workspace();
      const c = await start(dir);
      await assert.rejects(bash(c, dir, "sleep 300", { timeout: 1 }), /timeout:1/);

      const child = c.executor.spawn("sleep 300", [], { cwd: dir, shell: true });
      const closed = new Promise<[number | null, NodeJS.Signals | null]>((done) => child.once("close", (code, signal) => done([code, signal])));
      await new Promise((r) => setTimeout(r, 500));
      child.kill("SIGKILL");
      const [code, signal] = await closed;
      assert.equal(code, null, "a killed command has no exit code to mistake for success");
      assert.equal(signal, "SIGKILL");
    });

    it("the container is removed at the end of the session", async () => {
      const dir = workspace();
      const c = await start(dir);
      const mine = (await driver.listContainers(OWNER_LABEL)).filter((x) => x.labels[OWNER_LABEL] === String(process.pid));
      assert.ok(mine.length >= 1, "positive control: it is listed while the session runs");
      const before_ = mine.length;
      await c.dispose();
      const after_ = (await driver.listContainers(OWNER_LABEL)).filter((x) => x.labels[OWNER_LABEL] === String(process.pid));
      assert.equal(after_.length, before_ - 1);
      await c.dispose(); // twice is not an error
    });

    it("a container left by a process that no longer exists is removed at the next start", async () => {
      const dir = workspace();
      const orphan = await driver.startContainer({
        name: `lykos-live-orphan-${process.pid}`,
        image: defaultImageTag(),
        labels: { [OWNER_LABEL]: "2147483646" },
        workspace: dir,
        mount: "ro",
        network: "none",
        memory: "256m",
        cpus: "1",
        protect: [],
        shadows: [],
      });
      assert.ok((await driver.listContainers(OWNER_LABEL)).some((x) => orphan.startsWith(x.id) || x.id.startsWith(orphan.slice(0, 12))), "positive control: the orphan exists");
      await start(workspace());
      assert.equal(
        (await driver.listContainers(OWNER_LABEL)).some((x) => orphan.startsWith(x.id) || x.id.startsWith(orphan.slice(0, 12))),
        false,
        "the orphan survived",
      );
    });

    it("the default image is reused, not rebuilt, on a later start", async () => {
      let builds = 0;
      const counting: ContainerRuntimeDriver = {
        ...driver,
        buildImage: async (...args) => {
          builds += 1;
          return driver.buildImage(...args);
        },
      };
      assert.equal(await driver.imageExists(defaultImageTag()), true, "positive control: the image exists");
      const c = await start(workspace(), {}, undefined, [counting]);
      assert.equal(builds, 0);
      assert.equal(c.record.image, defaultImageTag());
    });

    // ---- T176: containers never leak, a killed command never reads as success

    const labelsOf = (id: string): Record<string, string> => {
      const inspected = spawnSync(name, ["inspect", "--format", "{{json .Config.Labels}}", id], { encoding: "utf8" });
      assert.equal(inspected.status, 0, inspected.stderr);
      return JSON.parse(inspected.stdout) as Record<string, string>;
    };
    const idOf = (c: Containment): string => c.executor.name.split(":")[1] ?? "";
    /** Ids of the containers any Lykos process owns on this runtime, running or not. */
    const lykosContainers = async (): Promise<string[]> => (await driver.listContainers(OWNER_LABEL)).map((x) => x.id).sort();

    it("a container is labelled with its session and Lykos's version", async () => {
      const dir = workspace();
      const c = await startContainment({
        config: { level: "required", runtime: name },
        workspace: dir,
        sessionId: "live-session-label",
        drivers: [driver],
      });
      open.push(c);
      const labels = labelsOf(idOf(c));
      assert.equal(labels["lykos.session"], "live-session-label");
      assert.equal(labels["lykos.version"], lykosVersion());
      assert.equal(labels[OWNER_LABEL], String(process.pid));
    });

    it("a container left by a Lykos process that was killed is removed by the next session's start", async () => {
      const dir = workspace();
      const marker = join(workspace(), "started");
      const child = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "live-orphan-child.ts"), name, dir, "killed-session", marker], {
        stdio: ["ignore", "ignore", "inherit"],
      });
      const deadline = Date.now() + 120_000;
      while (!existsSync(marker) && Date.now() < deadline && child.exitCode === null) await new Promise((r) => setTimeout(r, 200));
      assert.equal(existsSync(marker), true, "the child never started its container");

      const mine = (await lykosContainers()).filter((id) => id !== "");
      const orphan = (await driver.listContainers(OWNER_LABEL)).find((x) => x.labels[OWNER_LABEL] === String(child.pid));
      assert.ok(orphan, `positive control: the child's container is listed (${mine.length} Lykos containers)`);

      const closed = new Promise<void>((done) => child.once("close", () => done()));
      child.kill("SIGKILL");
      await closed;
      assert.ok(
        (await driver.listContainers(OWNER_LABEL)).some((x) => x.id === orphan.id),
        "positive control: killing the process left its container running",
      );

      await start(workspace());
      assert.equal(
        (await driver.listContainers(OWNER_LABEL)).some((x) => x.id === orphan.id),
        false,
        "the orphan of a killed process survived the next start",
      );
    });

    it("a container killed under the session is replaced by the next command, which tells the model once", async () => {
      const dir = workspace();
      const c = await startContainment({ config: { level: "required", runtime: name }, workspace: dir, sessionId: "live-crash", drivers: [driver] });
      open.push(c);
      const first = idOf(c);
      assert.equal((await bash(c, dir, "echo kept > kept.txt && echo alive")).output, "alive\n", "positive control: it runs before the crash");

      const killed = spawnSync(name, ["kill", first], { encoding: "utf8" });
      assert.equal(killed.status, 0, killed.stderr);

      const after = await bash(c, dir, "cat kept.txt && echo $PWD");
      assert.equal(after.exitCode, 0, after.output);
      // `$PWD` is /work inside; the model is shown the host path (T174). The note, written by Lykos, is not translated.
      assert.ok(after.output.startsWith(`kept\n${dir}\n\nlykos: the container `), after.output);
      assert.match(after.output, /had stopped.*fresh one/s);
      const replacement = idOf(c);
      assert.notEqual(replacement, first);
      assert.equal(labelsOf(replacement)["lykos.session"], "live-crash", "the replacement is labelled like the original");

      assert.equal((await bash(c, dir, "echo quiet")).output, "quiet\n", "the note is told once");
      const left = (await driver.listContainers(OWNER_LABEL)).filter((x) => first.startsWith(x.id) || x.id.startsWith(first));
      assert.deepEqual(left, [], "the dead container was removed");
    });

    it("a command killed by SIGKILL inside the container is a failure, never exit 0", async () => {
      const dir = workspace();
      const c = await start(dir);
      const killed = await bash(c, dir, "kill -9 $$");
      // Killed from inside, the exec client can only report the shell's 128+9.
      assert.equal(killed.exitCode, 137);
      assert.equal((await bash(c, dir, "true")).exitCode, 0, "positive control: an ordinary command exits 0");

      // Killed from outside, the child closes with the signal and the verification and bash paths name it.
      const child = c.executor.spawn("sleep 31723", [], { cwd: dir, shell: true });
      const closed = new Promise<[number | null, NodeJS.Signals | null]>((done) => child.once("close", (code, signal) => done([code, signal])));
      await new Promise((r) => setTimeout(r, 1000));
      child.kill("SIGKILL");
      assert.deepEqual(await closed, [null, "SIGKILL"]);
      const run = await runVerificationCommand("kill -9 $$", dir, 60_000, c.executor);
      assert.equal(run.exitCode, 137, "a command that killed itself is still a failure");
    });

    it("a post-edit style timeout stops the command inside the container and reports a problem", async () => {
      const dir = workspace();
      const c = await start(dir);
      const probe = `pgrep -f 'sleep 3172[1]' >/dev/null && echo yes || echo no`;
      const run = await createCommandRunner(c.executor)("sleep 31721", dir, 1500);
      assert.match(run.problem ?? "", /timed out/);
      let gone = false;
      for (let i = 0; i < 20 && !gone; i++) {
        gone = (await bash(c, dir, probe)).output.trim() === "no";
        if (!gone) await new Promise((r) => setTimeout(r, 250));
      }
      assert.equal(gone, true, "the timed-out command is still running in the container");
    });

    it("a verification command killed by a signal is a failure that names it", async () => {
      const dir = workspace();
      const c = await start(dir);
      // The gate's own timeout stops a run that would not finish; the run is a failure that names the signal, never NULL.
      const run = await runVerificationCommand("sleep 31722", dir, 1500, c.executor);
      assert.equal(run.signal, "SIGTERM");
      assert.equal(run.exitCode, 143);
      assert.equal(run.spawnError, undefined);
      assert.match(run.output, /timed out after 1.5s \(SIGTERM\)/);

      const ledgerPath = join(workspace(), "ledger.db");
      const ledger = Ledger.open(ledgerPath);
      const id = ledger.startSession({ brief: "t176", harnessCommit: "test", executionShape: "standalone" });
      ledger.endSession({ id });
      ledger.close();
      const result = await runVerify(id, { ledgerPath, cwd: dir, answer: { kind: "command", cmd: "sleep 31722" }, timeoutMs: 1500, executor: c.executor });
      assert.equal(result.status === "recorded" && result.outcome, "fail");
      assert.equal(result.status === "recorded" && result.run?.signal, "SIGTERM");
      const check = Ledger.open(ledgerPath);
      try {
        const row = check.db.prepare("SELECT outcome, verification_exit_code FROM sessions WHERE id = ?").get(id) as { outcome: string; verification_exit_code: number | null };
        assert.deepEqual({ ...row }, { outcome: "fail", verification_exit_code: 143 });
      } finally {
        check.close();
      }
    });

    it("a start that goes past its timeout leaves no container behind", async () => {
      const before_ = await lykosContainers();
      await assert.rejects(
        startContainment({ config: { level: "required", runtime: name }, workspace: workspace(), drivers: [driver], startupTimeoutMs: 1 }),
        /did not start within 1ms/,
      );
      // A runtime may finish creating what the client abandoned a moment after the client is gone.
      await new Promise((r) => setTimeout(r, 4000));
      assert.deepEqual(await lykosContainers(), before_);
    });

    // ---- T175: the boundary holds ------------------------------------------

    /** A workspace with a real repository, a commit, and the Lykos and Pi state directories. */
    const repoWorkspace = (): string => {
      const dir = workspace();
      const git = (...args: string[]) =>
        execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" });
      git("init", "-q");
      writeFileSync(join(dir, "tracked.txt"), "one\n");
      git("add", "tracked.txt");
      git("commit", "-q", "-m", "first commit");
      mkdirSync(join(dir, ".lykos"));
      mkdirSync(join(dir, ".pi"));
      writeFileSync(join(dir, ".lykos", "state.txt"), "state\n");
      return dir;
    };
    const head = (dir: string): string => execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();

    it(".git, .lykos and .pi cannot be written from inside, while the rest of the workspace can", async () => {
      const dir = repoWorkspace();
      const config = readFileSync(join(dir, ".git", "config"), "utf8");
      const c = await start(dir);

      const control = await bash(c, dir, "echo ok > ok.txt");
      assert.equal(control.exitCode, 0, control.output);
      assert.equal(readFileSync(join(dir, "ok.txt"), "utf8"), "ok\n", "positive control: a workspace file is written");

      for (const [command, check] of [
        ["echo '#!/bin/sh' > .git/hooks/pre-commit", () => assert.equal(existsSync(join(dir, ".git", "hooks", "pre-commit")), false, "hook planted")],
        ["echo '[core]' >> .git/config", () => assert.equal(readFileSync(join(dir, ".git", "config"), "utf8"), config, "git config rewritten")],
        ["echo x > .lykos/ledger.db", () => assert.equal(existsSync(join(dir, ".lykos", "ledger.db")), false)],
        ["echo x >> .lykos/state.txt", () => assert.equal(readFileSync(join(dir, ".lykos", "state.txt"), "utf8"), "state\n")],
        ["echo x > .pi/settings.json", () => assert.equal(existsSync(join(dir, ".pi", "settings.json")), false)],
        ["rm -rf .git/hooks", () => assert.equal(existsSync(join(dir, ".git", "hooks")), true)],
      ] as const) {
        const r = await bash(c, dir, command);
        assert.notEqual(r.exitCode, 0, `${command} should fail: ${r.output}`);
        check();
      }
    });

    it("git status, diff and log work inside, and a git write fails with a message that names commit", async () => {
      const dir = repoWorkspace();
      writeFileSync(join(dir, "tracked.txt"), "one\ntwo\n");
      const before = head(dir);
      const c = await start(dir);

      const log = await bash(c, dir, "git log --oneline");
      assert.equal(log.exitCode, 0, log.output);
      assert.match(log.output, /first commit/, "positive control: the repository is readable");
      const status = await bash(c, dir, "git status --short");
      assert.equal(status.exitCode, 0, status.output);
      assert.match(status.output, /tracked\.txt/);
      const diff = await bash(c, dir, "git diff");
      assert.equal(diff.exitCode, 0, diff.output);
      assert.match(diff.output, /\+two/);

      for (const command of ["git add tracked.txt", "git commit -am second", "git -C . commit -am second", "git reset --hard"]) {
        const r = await bash(c, dir, command);
        assert.notEqual(r.exitCode, 0, command);
        assert.match(r.output, /commit tool/, `${command}: ${r.output}`);
      }
      assert.equal(head(dir), before, "the repository is unchanged");

      // The wrapper is only the message: the mount refuses the write whichever git runs.
      const direct = await bash(c, dir, "/usr/bin/git -c user.name=x -c user.email=x@x commit -qam second");
      assert.notEqual(direct.exitCode, 0);
      assert.equal(head(dir), before);
    });

    // T184: a worktree's `.git` is a file naming a host path, so the main repository's git directory is mounted
    // read-only and git is pointed at it through the environment.
    it("git status and log work inside a worktree, and a git write fails while a workspace write succeeds", async () => {
      const main = repoWorkspace();
      const root = workspace();
      const lease = acquireWorktree({ workspace: main, projectId: "live", sessionId: "s1", root });
      try {
        writeFileSync(join(lease.path, "tracked.txt"), "one\ntwo\n");
        const c = await start(lease.path, {}, "rw", [driver], { commonDir: lease.commonDir, gitDir: lease.gitDir });

        const control = await bash(c, lease.path, "echo ok > ok.txt");
        assert.equal(control.exitCode, 0, control.output);
        assert.equal(readFileSync(join(lease.path, "ok.txt"), "utf8"), "ok\n", "positive control: a worktree file is written");

        const log = await bash(c, lease.path, "git log --oneline");
        assert.equal(log.exitCode, 0, log.output);
        assert.match(log.output, /first commit/, "positive control: history is readable");
        const status = await bash(c, lease.path, "git status --short");
        assert.equal(status.exitCode, 0, status.output);
        assert.match(status.output, /tracked\.txt/);
        const branch = await bash(c, lease.path, "git rev-parse --abbrev-ref HEAD");
        assert.equal(branch.output.trim(), "lykos/s1");

        const before = head(lease.path);
        const direct = await bash(c, lease.path, "/usr/bin/git -c user.name=x -c user.email=x@x commit -qam second");
        assert.notEqual(direct.exitCode, 0, direct.output);
        assert.equal(head(lease.path), before, "the write did not land");
      } finally {
        for (const c of open.splice(0)) await c.dispose();
        lease.release();
      }
    });

    it("a file matching the deny list reads empty inside while an ordinary file reads its content", async () => {
      const dir = workspace();
      mkdirSync(join(dir, "config"));
      writeFileSync(join(dir, ".env"), "TOKEN=hunter2\n");
      writeFileSync(join(dir, "config", "server.pem"), "-----BEGIN-----\n");
      writeFileSync(join(dir, "plain.txt"), "visible\n");
      const c = await start(dir);

      const plain = await bash(c, dir, "cat plain.txt");
      assert.equal(plain.output, "visible\n", "positive control: an ordinary file reads its content");
      for (const secret of [".env", "config/server.pem"]) {
        const r = await bash(c, dir, `cat ${secret} | wc -c`);
        assert.equal(r.output.trim(), "0", `${secret} is not empty inside`);
        // A file shadow is the runtime's /dev/null: a write is discarded rather than refused, and must not reach the host file.
        await bash(c, dir, `echo overwritten > ${secret}`);
        assert.equal((await bash(c, dir, `cat ${secret} | wc -c`)).output.trim(), "0", `${secret} gained content inside`);
      }
      assert.equal(readFileSync(join(dir, ".env"), "utf8"), "TOKEN=hunter2\n", "the host's file is untouched");
    });

    it("the deny list is the project's to add to", async () => {
      const dir = workspace();
      writeFileSync(join(dir, ".env"), "shipped pattern\n");
      writeFileSync(join(dir, "vault.json"), "now secret\n");
      const c = await start(dir, { secret_paths: ["vault.json"] });
      assert.equal((await bash(c, dir, "cat .env | wc -c")).output.trim(), "0", "the shipped patterns still apply");
      assert.equal((await bash(c, dir, "cat vault.json | wc -c")).output.trim(), "0");
    });

    it("an environment variable outside the allowlist is absent and one inside it is present", async () => {
      const dir = workspace();
      process.env.LYKOS_LIVE_ALLOWED = "allowed-value";
      process.env.LYKOS_LIVE_OTHER = "other-value";
      try {
        const c = await start(dir, { env_allowlist: ["LYKOS_LIVE_ALLOWED"] });
        const r = await bash(c, dir, "env");
        assert.equal(r.exitCode, 0);
        assert.match(r.output, /^LYKOS_LIVE_ALLOWED=allowed-value$/m, "positive control: an allowed name arrives");
        assert.doesNotMatch(r.output, /LYKOS_LIVE_OTHER|other-value/);
      } finally {
        delete process.env.LYKOS_LIVE_ALLOWED;
        delete process.env.LYKOS_LIVE_OTHER;
      }
    });

    it("memory and CPU caps are applied and read back from inside the container", async () => {
      const read = (c: Containment, dir: string) =>
        bash(
          c,
          dir,
          "cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes; " +
            "cat /sys/fs/cgroup/cpu.max 2>/dev/null || echo \"$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us) $(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us)\"",
        );
      const parse = (output: string) => {
        const [memory, cpu] = output.trim().split("\n");
        const [quota, period] = (cpu ?? "").split(" ").map(Number);
        return { memory: Number(memory), cpus: (quota ?? NaN) / (period ?? NaN) };
      };
      const dir = workspace();
      const defaults = await start(dir);
      const d = await read(defaults, dir);
      assert.equal(d.exitCode, 0, d.output);
      assert.deepEqual(parse(d.output), { memory: 4 * 1024 ** 3, cpus: 2 }, `defaults: ${d.output}`);

      const custom = await start(dir, { memory: "512m", cpus: "1" });
      const r = await read(custom, dir);
      assert.deepEqual(parse(r.output), { memory: 512 * 1024 ** 2, cpus: 1 }, `custom: ${r.output}`);
    });

    it("nothing outside the workspace is mounted: no path under the home directory but the project's own", async () => {
      const dir = repoWorkspace();
      writeFileSync(join(dir, ".env"), "x\n");
      const c = await start(dir);
      const id = c.executor.name.split(":")[1] ?? "";
      const inspected = spawnSync(name, ["inspect", "--format", "{{json .Mounts}}", id], { encoding: "utf8" });
      assert.equal(inspected.status, 0, inspected.stderr);
      const mounts = JSON.parse(inspected.stdout) as { Source: string; Destination: string }[];
      assert.ok(mounts.length >= 4, `positive control: the workspace, .git, .lykos, .pi and the shadow are mounted (${mounts.length})`);
      // Podman on Windows reports sources as /mnt/c/Users/...; compare in one notation.
      const normalised = (p: string) => p.replace(/\\/g, "/").replace(/^([a-z]):/i, "/mnt/$1").toLowerCase();
      const home = normalised(homedir());
      const project = normalised(dir);
      const under = (p: string, root: string) => p === root || p.startsWith(`${root}/`);
      for (const m of mounts) {
        assert.ok(m.Destination === "/work" || m.Destination.startsWith("/work/"), `${m.Destination} is outside /work`);
        const source = normalised(m.Source);
        if (under(source, project)) continue;
        assert.equal(under(source, home), false, `${m.Source} is under the home directory and is not the project`);
      }
      assert.ok(mounts.some((m) => m.Destination === "/work/.env"), "positive control: the secret is shadowed");
    });

    it(
      "files a command writes belong to the host user",
      { skip: typeof process.getuid === "function" ? false : "the host has no uid to compare against (Windows maps ownership itself)" },
      async () => {
        const dir = workspace();
        const c = await start(dir);
        assert.equal((await bash(c, dir, "touch owned.txt")).exitCode, 0);
        assert.equal(statSync(join(dir, "owned.txt")).uid, process.getuid!());
      },
    );

    // T177: the project's devcontainer decides the image, against a real runtime.
    it("a devcontainer's image runs the commands, and a file its Dockerfile COPYs is picked up when it changes", async () => {
      const toolchain = defaultImageTag();
      const named = workspace();
      mkdirSync(join(named, ".devcontainer"));
      writeFileSync(join(named, ".devcontainer", "devcontainer.json"), `// comments and trailing commas
{ "image": "${toolchain}", }
`);
      const byName = await start(named);
      assert.equal(byName.record.image, toolchain);
      assert.equal((await bash(byName, named, "node --version")).exitCode, 0);

      const built = workspace();
      mkdirSync(join(built, ".devcontainer"));
      writeFileSync(join(built, ".devcontainer", "devcontainer.json"), '{ "build": { "dockerfile": "Dockerfile" } }');
      writeFileSync(join(built, ".devcontainer", "Dockerfile"), `FROM ${toolchain}
COPY marker.txt /marker.txt
`);
      writeFileSync(join(built, ".devcontainer", "marker.txt"), "from-the-devcontainer\n");
      let tag: string | undefined;
      try {
        const first = await start(built);
        tag = first.record.image;
        assert.match(tag ?? "", /^lykos\/devcontainer:[0-9a-f]{12}$/);
        const seen = await bash(first, built, "cat /marker.txt");
        assert.equal(seen.output.trim(), "from-the-devcontainer", seen.output);

        // A file the Dockerfile COPYs changes: the same tag, rebuilt, now holding the new content.
        writeFileSync(join(built, ".devcontainer", "marker.txt"), "changed\n");
        const second = await start(built);
        assert.equal(second.record.image, tag, "the Dockerfile and context are unchanged, so the tag is too");
        assert.equal((await bash(second, built, "cat /marker.txt")).output.trim(), "changed");
      } finally {
        if (tag !== undefined) {
          for (const c of open.splice(0)) await c.dispose();
          spawnSync(name, ["rmi", "-f", tag]);
        }
      }
    });
  });
}
