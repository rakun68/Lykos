// A stand-in container runtime for the scripted-model seam.
//
// It starts nothing. Each operation containment asks of a runtime (probe,
// image, start, exec, remove) is recorded and answered from a script, so a
// test can say which commands reached the container, what the container was
// asked to be, and what was left behind afterwards. The routing under test is
// the real one: the session's executor is the real container executor, talking
// to this driver instead of to Docker.

import { unwrapExec } from "../containment/containment.js";
import type {
  ContainerExecRequest,
  ContainerRuntimeDriver,
  ContainerSpec,
  ListedContainer,
  RuntimeName,
} from "../containment/runtime.js";
import type { ExecChild } from "../tools/executor.js";
import { FakeChild, type ScriptedProcess } from "./scripted-executor.js";

/** One thing the session asked of the runtime. */
export type RuntimeOperation =
  | { op: "probe" }
  | { op: "imageExists"; tag: string }
  | { op: "build"; tag: string; dockerfile: string; context: string }
  | { op: "start"; spec: ContainerSpec; id: string }
  | { op: "exec"; id: string; command: string[]; cwd: string; env: Record<string, string> }
  | { op: "remove"; id: string }
  | { op: "checkOwnership"; id: string };

export interface StandInRuntime {
  driver: ContainerRuntimeDriver;
  /** Everything asked of the runtime, in order. */
  operations: RuntimeOperation[];
  /** Containers started and not yet removed. */
  running(): string[];
  /** Stops a container without the session asking, as an out-of-memory kill or `docker kill` would. No operation is recorded. */
  crash(id: string): void;
  /** Image tags the runtime has built or was given. */
  images: Set<string>;
  /** Containers that already existed before the session, as a crashed earlier run would have left them. */
  leftover: ListedContainer[];
}

export interface StandInRuntimeOptions {
  name?: RuntimeName;
  /** Default true. False makes `probe` say the runtime does not answer. */
  available?: boolean;
  version?: string;
  /** How a command run inside the container behaves. Default: exit 0, no output. */
  respond?: (command: string[], cwd: string) => ScriptedProcess | undefined;
  /** `startContainer` never settles until aborted, as a hung runtime would. */
  hangOnStart?: boolean;
  /** The runtime's ownership preflight fails with this message, as on a machine where the container's user is not the host's. */
  ownershipError?: string;
}

export function standInRuntime(opts: StandInRuntimeOptions = {}): StandInRuntime {
  const name = opts.name ?? "podman";
  const operations: RuntimeOperation[] = [];
  const running = new Set<string>();
  const images = new Set<string>();
  const leftover: ListedContainer[] = [];
  let next = 0;

  const driver: { -readonly [K in keyof ContainerRuntimeDriver]: ContainerRuntimeDriver[K] } = {
    name,
    async probe() {
      operations.push({ op: "probe" });
      return opts.available === false
        ? { available: false, reason: `${name} is not installed` }
        : { available: true, version: opts.version ?? "5.0.0" };
    },
    async imageExists(tag) {
      operations.push({ op: "imageExists", tag });
      return images.has(tag);
    },
    async buildImage(tag, dockerfile, context) {
      operations.push({ op: "build", tag, dockerfile, context });
      images.add(tag);
    },
    async startContainer(spec, signal) {
      if (opts.hangOnStart === true) {
        // The container exists from the moment the runtime accepts the command, before it reports back.
        running.add(spec.name);
        await new Promise<void>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
      const id = `stand-in-${(next += 1)}`;
      operations.push({ op: "start", spec, id });
      running.add(id);
      return id;
    },
    exec(id, request: ContainerExecRequest): ExecChild {
      const command = unwrapExec(request.argv) ?? [...request.argv];
      operations.push({ op: "exec", id, command, cwd: request.cwd, env: { ...request.env } });
      return new FakeChild(opts.respond?.(command, request.cwd) ?? {});
    },
    async isRunning(id) {
      return running.has(id);
    },
    async removeContainer(idOrName) {
      operations.push({ op: "remove", id: idOrName });
      running.delete(idOrName);
      const at = leftover.findIndex((c) => c.id === idOrName);
      if (at >= 0) leftover.splice(at, 1);
    },
    async listContainers() {
      return [...leftover];
    },
  };
  if (opts.ownershipError !== undefined) {
    driver.checkOwnership = async (id) => {
      operations.push({ op: "checkOwnership", id });
      throw new Error(opts.ownershipError);
    };
  }
  return { driver, operations, running: () => [...running], crash: (id) => void running.delete(id), images, leftover };
}
