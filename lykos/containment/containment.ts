// Containment: where a session's commands run.
//
// A contained session starts one long-lived container, mounts the workspace at
// `/work`, and hands the session a `ProjectExecutor` (tools/executor.ts) whose
// processes are `exec`s into it. Nothing outside this module starts, execs in,
// or removes a container. The session itself stays on the host: only the
// commands the model or the project chose run inside (ADR-0036).
//
// The level is a request: `off` runs on this machine, `required` refuses to
// start without a runtime, and `auto` uses a runtime when one answers and says
// so when it falls back. What was asked and what happened are both returned as
// a `ContainmentRecord`, which the ledger keeps.
//
// The boundary: inside the container `.git`, `.lykos/` and `.pi/` are
// read-only in every mode (a command cannot plant a hook or rewrite Lykos's own
// state that the host would later run or trust), files matching
// the shipped secret patterns plus `containment.secret_paths` read as empty, and a command's environment is a
// small fixed base plus `containment.env_allowlist`, never this machine's.
//
// Paths: the workspace maps to `/work`. The model only ever sees host paths, so
// a command's text and cwd are translated on the way in and its output on the
// way out (paths.ts, T174).

import { EventEmitter } from "node:events";
import { PassThrough, Transform, type Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { ContainmentConfig } from "../config/types.js";
import {
  collectPathRules,
  containmentPathPlan,
  matchesRule,
  shippedPathRules,
  type ContainmentPathPlan,
  type PathContext,
  type PathRule,
} from "../gate/path-rules.js";
import { exitCodeOfSignal, localExecutor, type ExecChild, type ExecSpawnOptions, type ProjectExecutor } from "../tools/executor.js";
import { lykosVersion } from "../version.js";
import { ImageResolutionError, resolveImage } from "./image.js";
import { pathTranslator, WORKSPACE_IN_CONTAINER, type PathTranslator } from "./paths.js";
import { cliRuntime, containerPathOf, type ContainerRuntimeDriver, type MountMode, type NetworkMode, type RuntimeName } from "./runtime.js";

export type ContainmentLevel = "off" | "auto" | "required";

/** What the ledger keeps about a session's containment. */
export interface ContainmentRecord {
  /** The level the session asked for. */
  requested: ContainmentLevel;
  /** `off` when the commands ran on this machine, whatever was asked; otherwise the level that was met. */
  used: ContainmentLevel;
  /** Present only when a container was used. */
  runtime?: RuntimeName;
  runtimeVersion?: string;
  image?: string;
  network?: NetworkMode;
  mount?: MountMode;
}

export interface Containment {
  /** The executor the session's tools run commands through. */
  executor: ProjectExecutor;
  record: ContainmentRecord;
  /** One line to show the person when the request was not met in full (`auto` with no runtime). */
  notice?: string;
  /** Removes the container. Safe to call more than once. */
  dispose(): Promise<void>;
}

export interface StartContainmentInput {
  config: ContainmentConfig;
  /** The host directory mounted at `/work`. */
  workspace: string;
  /** Path rules in force. When passed, `plan` is derived from them; otherwise `shippedPathRules()` and `config.secret_paths` are used. */
  rules?: readonly PathRule[];
  /** Pre-calculated containment path plan. */
  plan?: ContainmentPathPlan;
  /** The session the commands belong to: it labels the container (`lykos.session`). Absent, the container carries no session label. */
  sessionId?: string;
  /** Default `rw`. */
  mount?: MountMode;
  /** The runtimes to consider, in preference order. Default: Podman, then Docker. Tests pass stand-ins. */
  drivers?: readonly ContainerRuntimeDriver[];
  /** The Dockerfile for the default image. Default: the one Lykos ships. */
  dockerfile?: string;
  /** Progress lines (an image build can take minutes). */
  log?: (line: string) => void;
  /** Default 120 000. A start that takes longer is abandoned and its container removed. */
  startupTimeoutMs?: number;
  /**
   * T180: the floor in force (`containment.minimum`) and the file that set it. A level below it is refused
   * before this is called; what only this can know is that an `auto` which finds no runtime has become `off`.
   */
  minimum?: { level: ContainmentLevel; source: string };
  /** The environment `containment.env_allowlist` names are read from. Default: this process's. */
  hostEnv?: NodeJS.ProcessEnv;
  /**
   * T184: `workspace` is a git worktree. Its `.git` is a file naming a host path the container cannot see, so the
   * main repository's git directory is mounted read-only at `GIT_COMMON_IN_CONTAINER` and the container's git is
   * pointed at the worktree's own directory inside it through the environment: reads work, writes fail.
   */
  gitWorktree?: { commonDir: string; gitDir: string };
}

/** The session asked for containment and cannot have it. The message says why. */
export class ContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainmentError";
  }
}

/** The label every Lykos container carries; its value is the pid of the process that owns it. */
export const OWNER_LABEL = "lykos.owner";
/** The session a container serves, and the Lykos version that started it. Both are for the person reading `ps`. */
export const SESSION_LABEL = "lykos.session";
export const VERSION_LABEL = "lykos.version";
const LEVELS: readonly ContainmentLevel[] = ["off", "auto", "required"];
/** Read-only in the container in every mount mode. Lykos's own state and the repository's, which host tools execute or trust. */
export const PROTECTED_DIRS: readonly string[] = containmentPathPlan(shippedPathRules()).protectedDirs;
/** Directories the secret scan does not enter: a repository's own storage and installed packages are not the project's secrets. */
const SCAN_SKIP = new Set([".git", "node_modules"]);

/** Where the main repository's git directory is mounted when the workspace is a worktree. */
export const GIT_COMMON_IN_CONTAINER = "/lykos-git";

/** The worktree's own git directory, as the container sees it. */
export function worktreeGitDirInContainer(worktree: { commonDir: string; gitDir: string }): string {
  const rel = relative(resolve(worktree.commonDir), resolve(worktree.gitDir)).split(sep).join("/");
  return rel === "" ? GIT_COMMON_IN_CONTAINER : `${GIT_COMMON_IN_CONTAINER}/${rel}`;
}

export function shippedDockerfile(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "image", "Dockerfile");
}

/** `lykos/toolchain:<first 12 hex of sha256(Dockerfile bytes)>`: a changed Dockerfile is a different image. */
export function defaultImageTag(dockerfile: string = shippedDockerfile()): string {
  const hash = createHash("sha256").update(readFileSync(dockerfile)).digest("hex").slice(0, 12);
  return `lykos/toolchain:${hash}`;
}

function resolveLevel(config: ContainmentConfig): ContainmentLevel {
  const level = config.level ?? "off";
  if (!LEVELS.includes(level)) {
    throw new ContainmentError(`lykos: containment.level must be one of ${LEVELS.join(", ")}; got ${JSON.stringify(level)}`);
  }
  return level;
}

function resolveNetwork(config: ContainmentConfig): NetworkMode {
  const network = config.network ?? "open";
  if (network !== "open" && network !== "none") {
    throw new ContainmentError(`lykos: containment.network must be open or none; got ${JSON.stringify(network)}`);
  }
  return network;
}

export function candidateDrivers(config: ContainmentConfig, injected: readonly ContainerRuntimeDriver[] | undefined): ContainerRuntimeDriver[] {
  const wanted = config.runtime ?? "auto";
  if (wanted !== "auto" && wanted !== "docker" && wanted !== "podman") {
    throw new ContainmentError(`lykos: containment.runtime must be auto, docker or podman; got ${JSON.stringify(wanted)}`);
  }
  // Podman first: when both answer and nothing is configured, it is the one that needs no root daemon.
  const all = injected ?? [cliRuntime("podman"), cliRuntime("docker")];
  return wanted === "auto" ? [...all] : all.filter((d) => d.name === wanted);
}

/** The workspace's files and directories that match the deny list, outermost first. Symlinks are not followed or shadowed. */
function findSecrets(
  workspace: string,
  patterns: readonly string[],
  exceptions: readonly string[] = [],
): { path: string; dir: boolean }[] {
  if (patterns.length === 0) return [];
  // Matched as the container sees it: a POSIX path under the workspace root, so a Windows host's
  // backslashes never reach matchesRule (which takes the name after the last "/").
  const pathCtx: PathContext = { cwd: "/work", home: "/home", extraDirs: [], outside: { read: "ask", write: "ask" } };
  const found: { path: string; dir: boolean }[] = [];
  const walk = (dir: string, relDir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      const full = join(dir, entry.name);
      const inContainer = `${pathCtx.cwd}/${rel}`;
      const isSecret = patterns.some((p) => matchesRule(p, inContainer, pathCtx));
      const isExempt = exceptions.some((p) => matchesRule(p, inContainer, pathCtx));
      if (isSecret && !isExempt) found.push({ path: full, dir: entry.isDirectory() });
      else if (entry.isDirectory() && !SCAN_SKIP.has(entry.name)) walk(full, rel);
    }
  };
  walk(workspace, "");
  return found;
}

function protectedPaths(workspace: string, dirs: readonly string[] = PROTECTED_DIRS): string[] {
  return dirs.map((name) => join(workspace, name)).filter((p) => {
    try {
      lstatSync(p);
      return true;
    } catch {
      return false;
    }
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Removes the containers earlier runs left behind: those whose owning process is gone. */
async function removeOrphans(driver: ContainerRuntimeDriver): Promise<void> {
  for (const c of await driver.listContainers(OWNER_LABEL)) {
    const pid = Number(c.labels[OWNER_LABEL]);
    if (!Number.isInteger(pid) || !isAlive(pid)) await driver.removeContainer(c.id);
  }
}

export async function startContainment(input: StartContainmentInput): Promise<Containment> {
  const requested = resolveLevel(input.config);
  const network = resolveNetwork(input.config);
  if (requested === "off") return { executor: localExecutor, dispose: async () => {}, record: { requested, used: "off" } };

  const failures: string[] = [];
  let driver: ContainerRuntimeDriver | undefined;
  let version = "";
  for (const candidate of candidateDrivers(input.config, input.drivers)) {
    const probed = await candidate.probe();
    if (probed.available) {
      driver = candidate;
      version = probed.version;
      break;
    }
    failures.push(`${candidate.name}: ${probed.reason}`);
  }

  if (driver === undefined) {
    const why = failures.length > 0 ? ` (${failures.join("; ")})` : ` (${input.config.runtime ?? "auto"} is not installed)`;
    if (requested === "required") {
      throw new ContainmentError(`lykos: containment.level is "required" but no container runtime is available${why}`);
    }
    if (input.minimum !== undefined) {
      throw new ContainmentError(
        `lykos: containment.minimum is "${input.minimum.level}" (set in ${input.minimum.source}) and no container runtime is available${why}; ` +
          `an "auto" that falls back to this machine counts as "off", which is below it`,
      );
    }
    return {
      executor: localExecutor,
      dispose: async () => {},
      record: { requested, used: "off" },
      notice: `lykos: containment.level is "auto" and no container runtime is available${why}; commands run on this machine`,
    };
  }

  const dockerfile = input.dockerfile ?? shippedDockerfile();
  let resolved;
  try {
    resolved = resolveImage({
      configured: input.config.image,
      globalImage: input.config.global_image,
      workspace: input.workspace,
      defaultImage: { tag: defaultImageTag(dockerfile), dockerfile },
    });
  } catch (err) {
    if (err instanceof ImageResolutionError) throw new ContainmentError(err.message);
    throw err;
  }
  const image = resolved.image;
  const mount: MountMode = input.mount ?? "rw";
  const workspace = resolve(input.workspace);

  await removeOrphans(driver);
  // A named image is the runtime's to find or pull. The default image is built once, by its content tag. A devcontainer's Dockerfile is built on every start and left to the runtime's layer cache (see `alwaysBuild`).
  if (resolved.build !== undefined && (resolved.alwaysBuild === true || !(await driver.imageExists(image)))) {
    input.log?.(
      resolved.alwaysBuild === true
        ? `lykos: building the container image ${image} from the devcontainer with ${driver.name} (unchanged layers are reused)`
        : `lykos: building the container image ${image} with ${driver.name} (first use)`,
    );
    await driver.buildImage(image, resolved.build.dockerfile, resolved.build.context);
  }

  const planCtx: PathContext = { cwd: workspace, home: homedir(), extraDirs: [], outside: { read: "ask", write: "ask" } };
  // Unified containment path plan from path rules, respecting shipped rules, user config, and secret_paths.
  const plan: ContainmentPathPlan =
    input.plan ??
    (input.rules !== undefined
      ? (() => {
          let rules = input.rules;
          if (input.config.secret_paths && input.config.secret_paths.length > 0) {
            const existingPatterns = new Set(rules.map((r) => r.pattern));
            const extra = input.config.secret_paths.filter((p) => !existingPatterns.has(p));
            if (extra.length > 0) {
              const added: PathRule[] = extra.flatMap((pattern) => [
                { pattern, decision: "deny" as const, access: "read" as const, source: "config" },
                { pattern, decision: "deny" as const, access: "write" as const, source: "config" },
              ]);
              rules = [...rules, ...added];
            }
          }
          return containmentPathPlan(rules, planCtx);
        })()
      : containmentPathPlan(
          collectPathRules(
            { global: input.config.secret_paths !== undefined ? { secret_paths: input.config.secret_paths } : {} },
            false,
          ),
          planCtx,
        ));

  const timeoutMs = input.startupTimeoutMs ?? 120_000;
  const labels: Record<string, string> = {
    [OWNER_LABEL]: String(process.pid),
    ...(input.sessionId !== undefined ? { [SESSION_LABEL]: input.sessionId } : {}),
    [VERSION_LABEL]: lykosVersion(),
  };

  /** Starts a container for this session and checks it is usable. A failure leaves nothing behind. */
  const launch = async (): Promise<string> => {
    const name = `lykos-${randomUUID().slice(0, 12)}`;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    let id: string;
    try {
      id = await driver.startContainer(
        {
          name,
          image,
          labels,
          workspace,
          mount,
          network,
          memory: input.config.memory ?? "4g",
          cpus: input.config.cpus ?? "2",
          protect: protectedPaths(workspace, plan.protectedDirs),
          ...(input.gitWorktree !== undefined
            ? { readonlyMounts: [{ source: resolve(input.gitWorktree.commonDir), target: GIT_COMMON_IN_CONTAINER }] }
            : {}),
          // Looked for again: a replacement should hide a secret the session has written since the first start.
          shadows: findSecrets(workspace, plan.secretPatterns, plan.secretExceptions),
        },
        abort.signal,
      );
    } catch (err) {
      // A start that hung or failed may have created the container before it did; remove it by the name we chose.
      await driver.removeContainer(name).catch(() => {});
      const reason = abort.signal.aborted ? `did not start within ${timeoutMs}ms` : err instanceof Error ? err.message : String(err);
      throw new ContainmentError(`lykos: the ${driver.name} container ${reason}`);
    } finally {
      clearTimeout(timer);
    }

    // A container whose user is not ours would leave root-owned files in the workspace. Refuse it now, not after the first write.
    if (mount === "rw" && driver.checkOwnership !== undefined) {
      try {
        await driver.checkOwnership(id, workspace);
      } catch (err) {
        await driver.removeContainer(id).catch(() => {});
        throw new ContainmentError(`lykos: the ${driver.name} container cannot be used: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return id;
  };

  const container = new SessionContainer(driver, await launch(), launch);
  return {
    executor: containerExecutor(container, workspace, containerEnv(input.config, input.hostEnv ?? process.env, input.gitWorktree)),
    record: { requested, used: requested, runtime: driver.name, runtimeVersion: version, image, network, mount },
    dispose: () => container.dispose(),
  };
}

/**
 * The container a session's commands run in, and the one place that notices it
 * has stopped. A container can die under a session (out of memory, `docker
 * kill`, a runtime restart); the next command finds it stopped, starts a
 * replacement with the same labels. The model is told once: the note waits for
 * the next command whose output the model reads (`bash`, `powershell`), so a
 * hook, the post-edit check or the gate cannot swallow it. Commands that start
 * together share one check and one replacement.
 */
class SessionContainer {
  private disposed = false;
  private inflight: Promise<string> | undefined;
  private pendingNote: string | undefined;

  constructor(
    readonly driver: ContainerRuntimeDriver,
    private id: string,
    private readonly launch: () => Promise<string>,
  ) {}

  get current(): string {
    return this.id;
  }

  /** The id a command should run in, replacing the container first when it has stopped. */
  ready(): Promise<string> {
    this.inflight ??= this.check().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  /** The replacement note, once, for a command the model reads the output of. */
  takeNote(): string | undefined {
    const note = this.pendingNote;
    this.pendingNote = undefined;
    return note;
  }

  private async check(): Promise<string> {
    if (this.disposed) throw new ContainmentError("lykos: the session's container has been removed");
    if (await this.driver.isRunning(this.id)) return this.id;
    await this.driver.removeContainer(this.id).catch(() => {});
    this.id = await this.launch();
    // Disposed while the replacement started: nothing is left to use it.
    if (this.disposed) {
      await this.driver.removeContainer(this.id).catch(() => {});
      throw new ContainmentError("lykos: the session's container has been removed");
    }
    this.pendingNote = REPLACED_NOTE;
    return this.id;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.inflight?.catch(() => {});
    await this.driver.removeContainer(this.id);
  }
}

const REPLACED_NOTE =
  "lykos: the container this session's commands run in had stopped, so a fresh one was started before this command. " +
  "Files in /work are as they were; anything installed or left running outside /work, and earlier background processes, are gone.\n";

// ---------------------------------------------------------------------------
// The container as an executor
// ---------------------------------------------------------------------------

/** What a command may see of this machine's environment: nothing but these. */
const BASE_ENV = {
  LANG: "C.UTF-8",
  TERM: "dumb",
  HOME: "/tmp",
  // .git is read-only in here: git must not try to refresh the index, and must trust a /work it cannot see the owner of.
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "safe.directory",
  GIT_CONFIG_VALUE_0: "/work",
} as const;

/** The environment every command in the container gets: the base, then the allowlisted names this machine has. PATH is the image's own. */
function containerEnv(
  config: ContainmentConfig,
  host: NodeJS.ProcessEnv,
  worktree?: { commonDir: string; gitDir: string },
): Record<string, string> {
  const env: Record<string, string> = { ...BASE_ENV };
  if (worktree !== undefined) {
    // The worktree's `.git` file names a host path; the read-only mount of the main git directory is where git reads from here.
    env.GIT_DIR = worktreeGitDirInContainer(worktree);
    env.GIT_WORK_TREE = WORKSPACE_IN_CONTAINER;
    env.GIT_CONFIG_COUNT = "2";
    env.GIT_CONFIG_KEY_1 = "safe.directory";
    env.GIT_CONFIG_VALUE_1 = GIT_COMMON_IN_CONTAINER;
  }
  for (const name of config.env_allowlist ?? []) {
    const value = host[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function containerCwd(workspace: string, cwd: string | undefined): string {
  return (cwd === undefined ? undefined : containerPathOf(workspace, cwd)) ?? WORKSPACE_IN_CONTAINER;
}

/**
 * A command wrapped so it can be stopped: it becomes the leader of a session of
 * its own (`setsid -w`, which this exec still waits for), so `$$` in the inner
 * shell is the group id, and that id is written to `pidFile`.
 * The command is run, not exec'd, because `setsid -w` reports a signalled child as the bare signal number (9, not 137), which the shell inside turns back into the 128+n a shell reports.
 */
function wrapExec(pidFile: string, argv: readonly string[]): string[] {
  return ["setsid", "-w", "sh", "-c", 'echo $$ >"$1"; shift; "$@"; exit $?', "sh", pidFile, ...argv];
}

/** The command a wrapped exec runs; undefined for an exec that is not one (the one that stops a command). */
export function unwrapExec(argv: readonly string[]): string[] | undefined {
  return argv[0] === "setsid" ? argv.slice(7) : undefined;
}

/** Output with `/work` paths turned into host paths, a piece at a time. */
function hostPathsIn(source: Readable | null, paths: PathTranslator): Readable | null {
  if (source === null) return null;
  const decoder = new StringDecoder("utf8");
  const stream = paths.hostStream();
  const out = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      done(null, stream.write(decoder.write(chunk)));
    },
    flush(done) {
      done(null, stream.write(decoder.end()) + stream.end());
    },
  });
  source.pipe(out);
  return out;
}

/** Resolves once everything the stream will say has been handed to whoever reads it. */
function settled(stream: Readable | null): Promise<void> {
  if (stream === null || stream.readableEnded) return Promise.resolve();
  return new Promise((done) => {
    stream.once("end", done);
    stream.once("close", done);
    // Nobody reading means nothing to wait for: the data is buffered, not lost.
    if (stream.readableFlowing !== true) setImmediate(done);
  });
}

/**
 * One `exec` into the container, behaving as a child process.
 *
 * The exec cannot start until the container is known to be running, and that
 * check is asynchronous while `spawn` is not, so the streams are ours and are
 * connected to the exec once it exists.
 *
 * Killing the `docker exec` client does not stop what it started inside, so
 * the command runs as the leader of its own process group, records that group's
 * id in a file, and `kill` signals the group from a second exec. A command that
 * was killed reports the signal and no exit code, never exit 0.
 */
class ContainerChild extends EventEmitter implements ExecChild {
  readonly pid = undefined;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  private killedBy: NodeJS.Signals | undefined;
  private inner: ExecChild | undefined;
  private ranIn: string | undefined;
  private closed = false;
  /** Written after the command's output: the bash tool keeps the tail of a long output, so a note placed first would be cut. */
  private note: string | undefined;
  private readonly pidFile = `/tmp/lykos-exec-${randomUUID()}.pid`;

  constructor(
    private readonly container: SessionContainer,
    private readonly argv: readonly string[],
    private readonly cwd: string,
    private readonly paths: PathTranslator,
    private readonly env: Readonly<Record<string, string>>,
    /** Its output goes to the model as a tool result, so it may carry the replacement note. */
    private readonly modelFacing: boolean,
    private readonly containerPaths = false,
  ) {
    super();
    void this.begin();
  }

  private async begin(): Promise<void> {
    let id: string;
    try {
      id = await this.container.ready();
    } catch (err) {
      this.settle(() => this.emit("error", err));
      return;
    }
    // Killed before it started: there is nothing in the container to stop.
    if (this.killedBy !== undefined) return this.finish(null);
    if (this.modelFacing) this.note = this.container.takeNote();

    const inner = this.container.driver.exec(id, { argv: wrapExec(this.pidFile, this.argv.map((a) => this.paths.toContainer(a))), cwd: this.cwd, env: this.env });
    this.inner = inner;
    this.ranIn = id;
    // Not ended by the pipe: `finish` appends the note, then ends them.
    const out = this.containerPaths ? inner.stdout : hostPathsIn(inner.stdout, this.paths);
    const err = this.containerPaths ? inner.stderr : hostPathsIn(inner.stderr, this.paths);
    out?.pipe(this.stdout, { end: false });
    err?.pipe(this.stderr, { end: false });
    if (inner.stdin !== null) this.stdin.pipe(inner.stdin);
    inner.once("error", (err) => this.settle(() => this.emit("error", err)));
    // The command's last words (and any the path translation held back) come before it is reported done.
    inner.once("close", (code, signal) => void Promise.all([settled(out), settled(err)]).then(() => this.finish(code, signal)));
  }

  private finish(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (!this.closed && this.note !== undefined) {
      this.stdout.write(`\n${this.note}`);
      this.note = undefined;
    }
    // A kill we made is reported as the signal that was asked for, whatever the exec client itself exited with.
    if (this.killedBy !== undefined) this.settle(() => this.emit("close", null, this.killedBy));
    else this.settle(() => this.emit("close", code, signal));
  }

  private settle(emit: () => void): void {
    if (this.closed) return;
    this.closed = true;
    this.stdout.end();
    this.stderr.end();
    emit();
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.closed) return false;
    this.killedBy ??= typeof signal === "string" ? signal : "SIGTERM";
    const inner = this.inner;
    const id = this.ranIn;
    if (inner === undefined || id === undefined) return true; // `begin` sees killedBy and never starts it
    const sig = this.killedBy.replace(/^SIG/, "");
    const stop = this.container.driver.exec(id, {
      // dash's kill takes `-s NAME -- -PGID`, and refuses `-NAME -PGID`.
      argv: ["sh", "-c", `p=$(cat "$1" 2>/dev/null) && [ -n "$p" ] && kill -s ${sig} -- -"$p"`, "sh", this.pidFile],
      cwd: WORKSPACE_IN_CONTAINER,
      env: this.env,
    });
    stop.stdout?.resume();
    stop.stderr?.resume();
    const finish = () => inner.kill("SIGKILL");
    // A command that ignores the signal must not hold the session: the client goes after a moment either way.
    const fallback = setTimeout(finish, 3000);
    fallback.unref();
    stop.once("close", () => {
      clearTimeout(fallback);
      setTimeout(finish, 500).unref();
    });
    stop.once("error", () => {});
    return true;
  }
}

function containerExecutor(container: SessionContainer, workspace: string, env: Readonly<Record<string, string>>): ProjectExecutor {
  const paths = pathTranslator(workspace);
  const start = (argv: readonly string[], cwd: string | undefined, modelFacing = false, containerPaths = false): ExecChild =>
    new ContainerChild(container, argv, containerCwd(workspace, cwd), paths, env, modelFacing, containerPaths);
  return {
    get name() {
      return `${container.driver.name}:${container.current.slice(0, 12)}`;
    },
    spawn: (command: string, args: readonly string[], options: ExecSpawnOptions) =>
      start(options.shell === true ? ["sh", "-c", command] : [command, ...args], options.cwd, false, options.containerPaths ?? false),
    shellOperations: (shell): BashOperations => ({
      async exec(command, cwd, { onData, signal, timeout }) {
        if (signal?.aborted) throw new Error("aborted");
        const child = start(shell === "bash" ? ["bash", "-c", command] : ["pwsh", "-NoProfile", "-Command", command], cwd, true);
        let timedOut = false;
        const timer =
          timeout !== undefined
            ? setTimeout(() => {
                timedOut = true;
                child.kill("SIGKILL");
              }, timeout * 1000)
            : undefined;
        const onAbort = () => child.kill("SIGKILL");
        signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        try {
          const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
            child.once("error", fail);
            child.once("close", (code, sig) => done({ code, signal: sig }));
          });
          if (signal?.aborted) throw new Error("aborted");
          if (timedOut) throw new Error(`timeout:${timeout}`);
          if (ended.code !== null) return { exitCode: ended.code };
          // Killed by a signal. The bash tool reads a null exit code as success, so say what happened and give a code that is not 0.
          onData(Buffer.from(`\n[killed by ${ended.signal ?? "a signal"}]\n`));
          return { exitCode: exitCodeOfSignal(ended.signal) };
        } finally {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        }
      },
    }),
  };
}
