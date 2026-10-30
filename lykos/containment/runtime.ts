// The container runtime Lykos drives: Docker or Podman, through their CLI.
//
// Neither runtime's SDK is a dependency (spec #22). A `ContainerRuntimeDriver`
// is the narrow set of things containment needs from a runtime, and it is the
// seam a test replaces: `cli/scripted-container.ts` implements it without
// starting anything, and the live suite runs the real one against whichever
// runtimes this machine has. The two runtimes share one implementation because
// their CLIs agree on everything used here; only the name and the user-mapping
// flags differ.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ExecChild } from "../tools/executor.js";

export type RuntimeName = "docker" | "podman";

export type MountMode = "rw" | "ro";
export type NetworkMode = "open" | "none";

/** Everything needed to start one session's container. */
export interface ContainerSpec {
  /** Unique, so a container that hung while starting can still be removed by name. */
  name: string;
  image: string;
  labels: Record<string, string>;
  /** Host path mounted at `/work`. */
  workspace: string;
  mount: MountMode;
  network: NetworkMode;
  memory: string;
  cpus: string;
  /**
   * Host paths inside the workspace that are read-only in the container
   * whatever the workspace mount is (`.git`, `.lykos`, `.pi`).
   */
  protect: readonly string[];
  /**
   * Host paths inside the workspace that the container sees as empty. A file
   * is covered by the runtime's own /dev/null, a directory by an empty tmpfs,
   * both read-only, so nothing from this machine is mounted for them.
   */
  shadows: readonly { path: string; dir: boolean }[];
  /**
   * Host directories mounted read-only at a path of their own in the container. A session working on a worktree
   * has its main repository's version-control directory here, so container tools can read history.
   */
  readonlyMounts?: readonly { source: string; target: string }[];
}

/** Where a host path inside the workspace is in the container, or undefined when it is outside the workspace. */
export function containerPathOf(workspace: string, hostPath: string): string | undefined {
  const rel = relative(resolve(workspace), resolve(hostPath));
  if (rel === "") return "/work";
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return `/work/${rel.split(sep).join("/")}`;
}

export interface ContainerExecRequest {
  /** Program and arguments, run inside the container. */
  argv: readonly string[];
  /** A path inside the container. */
  cwd: string;
  env: Readonly<Record<string, string>>;
}

export interface ListedContainer {
  id: string;
  labels: Record<string, string>;
}

export interface ContainerRuntimeDriver {
  readonly name: RuntimeName;
  /** The health check: does this runtime answer, and what version is it? */
  probe(): Promise<{ available: true; version: string } | { available: false; reason: string }>;
  imageExists(tag: string): Promise<boolean>;
  buildImage(tag: string, dockerfile: string, context: string, signal?: AbortSignal): Promise<void>;
  /** Starts the container with an idle process and returns its id. */
  startContainer(spec: ContainerSpec, signal?: AbortSignal): Promise<string>;
  exec(id: string, request: ContainerExecRequest): ExecChild;
  /** Is the container still running? False when it has stopped or is gone. Asked before every command. */
  isRunning(id: string): Promise<boolean>;
  /** Removes by id or name; removing what is already gone is not an error. */
  removeContainer(idOrName: string): Promise<void>;
  /** Containers carrying the label key, running or not. */
  listContainers(labelKey: string): Promise<ListedContainer[]>;
  /**
   * Writes a file in `/work` from inside the container and checks the host
   * sees it owned by the host user; throws, saying what it found, when it is
   * not. A runtime that maps ownership itself (Windows) has nothing to check.
   * Optional: a stand-in that starts nothing has no files to own.
   */
  checkOwnership?(id: string, workspace: string): Promise<void>;
  /**
   * Starts and removes a throwaway container with a memory and cpu limit using
   * the arguments a session's container is started with, to find out whether
   * this runtime can. Never pulls or builds: `untested` when `image` is not
   * present locally. Optional for the same reason as above.
   */
  limitedStart?(image: string): Promise<LimitedStart>;
  /** What Podman reports about the machine it drives (doctor's WSL diagnosis). Podman only. */
  hostInfo?(): Promise<{ rootless: boolean; cgroupManager: string } | undefined>;
}

export type LimitedStart = { status: "ok" } | { status: "failed"; reason: string } | { status: "untested"; reason: string };

interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: readonly string[], signal?: AbortSignal): Promise<Finished> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, ...(signal ? { signal } : {}) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function must(what: string, r: Finished): string {
  if (r.code !== 0) throw new Error(`${what} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/** The host user's ids where the host has them (Linux, macOS); undefined on Windows, where the runtime's own mapping applies. */
function hostUser(): { uid: number; gid: number } | undefined {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return undefined;
  return { uid: process.getuid(), gid: process.getgid() };
}

function containerRunArgs(name: RuntimeName, spec: ContainerSpec): string[] {
  const user = hostUser();
  return [
    "run",
    "-d",
    "--init",
    "--name",
    spec.name,
    ...Object.entries(spec.labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
    "-v",
    `${spec.workspace}:/work${spec.mount === "ro" ? ":ro" : ""}`,
    // Nested over the workspace mount, so they stay read-only when it is read-write.
    ...[
      ...spec.protect.map((p) => ({ target: p, mount: (t: string) => `type=bind,source=${p},target=${t},readonly` })),
      ...spec.shadows.map((s) => ({
        target: s.path,
        mount: (t: string) => (s.dir ? `type=tmpfs,target=${t},readonly` : `type=bind,source=/dev/null,target=${t},readonly`),
      })),
    ].flatMap(({ target, mount }) => {
      const inside = containerPathOf(spec.workspace, target);
      // --mount rather than -v: a Windows drive letter's colon is not a field separator there.
      return inside === undefined || inside === "/work" ? [] : ["--mount", mount(inside)];
    }),
    ...(spec.readonlyMounts ?? []).flatMap((m) => ["--mount", `type=bind,source=${m.source},target=${m.target},readonly`]),
    "-w",
    "/work",
    "--memory",
    spec.memory,
    "--cpus",
    spec.cpus,
    ...(spec.network === "none" ? ["--network", "none"] : []),
    ...(user !== undefined
      ? [...(name === "podman" ? ["--userns=keep-id"] : []), "--user", `${user.uid}:${user.gid}`]
      : []),
    spec.image,
    "sleep",
    "infinity",
  ];
}

/** How long doctor waits on any one runtime call before calling the runtime wedged. */
const PROBE_TIMEOUT_MS = 60_000;

export function cliRuntime(name: RuntimeName): ContainerRuntimeDriver {
  const bin = name;
  return {
    name,

    async probe() {
      try {
        // The server's version, not `--version`: asking the daemon (or Podman's machine) proves it answers, where the flag only proves a binary exists.
        const r = await run(bin, ["version", "--format", "{{.Server.Version}}"]);
        if (r.code !== 0) return { available: false, reason: (r.stderr || r.stdout).trim().split("\n")[0] ?? "version failed" };
        const version = r.stdout.trim();
        return version === "" ? { available: false, reason: "no server version reported" } : { available: true, version };
      } catch (err) {
        return { available: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },

    async imageExists(tag) {
      return (await run(bin, ["image", "inspect", tag])).code === 0;
    },

    async buildImage(tag, dockerfile, context, signal) {
      must(`${name} build ${tag}`, await run(bin, ["build", "-t", tag, "-f", dockerfile, context], signal));
    },

    async startContainer(spec, signal) {
      const args = containerRunArgs(name, spec);
      return must(`${name} run`, await run(bin, args, signal)).trim();
    },

    exec(id, request) {
      const args = [
        "exec",
        "-i",
        "-w",
        request.cwd,
        ...Object.entries(request.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        id,
        ...request.argv,
      ];
      return spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    },

    async checkOwnership(id, workspace) {
      const user = hostUser();
      if (user === undefined) return;
      const file = `.lykos-ownership-${randomUUID()}`;
      const host = join(workspace, file);
      try {
        must(`${name} exec touch`, await run(bin, ["exec", "-w", "/work", id, "touch", file]));
        let uid: number;
        try {
          uid = statSync(host).uid;
        } catch {
          throw new Error("a file written in /work by the container did not appear in the workspace on this machine");
        }
        if (uid !== user.uid) {
          throw new Error(
            `a file written in the container is owned by uid ${uid} on this machine, not ${user.uid}; the container's user does not map to yours (${name === "podman" ? "check that rootless Podman supports --userns=keep-id" : "check the Docker daemon's user-namespace remapping"})`,
          );
        }
      } finally {
        rmSync(host, { force: true });
      }
    },

    async limitedStart(image) {
      // The same arguments a session's container is started with, at the same kind of limits, so a pass here holds for a session.
      // Every call below can hang on a wedged machine, so each is bounded like the start itself.
      const present = await run(bin, ["image", "inspect", image], AbortSignal.timeout(PROBE_TIMEOUT_MS)).then((r) => r.code === 0, () => false);
      if (!present) {
        return { status: "untested", reason: "the default image is not built yet (it is built on first use)" };
      }
      const workspace = mkdtempSync(join(tmpdir(), "lykos-doctor-"));
      const spec: ContainerSpec = {
        name: `lykos-doctor-${randomUUID().slice(0, 12)}`,
        image,
        labels: {},
        workspace,
        mount: "ro",
        network: "open",
        memory: "64m",
        cpus: "1",
        protect: [],
        shadows: [],
      };
      try {
        await this.startContainer(spec, AbortSignal.timeout(PROBE_TIMEOUT_MS));
        return { status: "ok" };
      } catch (err) {
        return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
      } finally {
        await run(bin, ["rm", "-f", spec.name], AbortSignal.timeout(PROBE_TIMEOUT_MS)).catch(() => {});
        rmSync(workspace, { recursive: true, force: true });
      }
    },

    async hostInfo() {
      if (name !== "podman") return undefined;
      const r = await run(bin, ["info", "--format", "{{.Host.Security.Rootless}} {{.Host.CgroupManager}}"], AbortSignal.timeout(PROBE_TIMEOUT_MS)).catch(() => undefined);
      const [rootless, cgroupManager] = r?.code === 0 ? r.stdout.trim().split(/\s+/) : [];
      return rootless === undefined || cgroupManager === undefined ? undefined : { rootless: rootless === "true", cgroupManager };
    },

    async isRunning(id) {
      const r = await run(bin, ["inspect", "--format", "{{.State.Running}}", id]);
      return r.code === 0 && r.stdout.trim() === "true";
    },

    async removeContainer(idOrName) {
      await run(bin, ["rm", "-f", idOrName]);
    },

    async listContainers(labelKey) {
      const r = await run(bin, ["ps", "-a", "--filter", `label=${labelKey}`, "--format", `{{.ID}}\t{{.Label "${labelKey}"}}`]);
      if (r.code !== 0) return [];
      return r.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((line) => {
          const [id, value] = line.split("\t");
          return { id: id ?? "", labels: { [labelKey]: value ?? "" } };
        });
    },
  };
}
