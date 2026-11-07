// Confirmed quiescence (T256, ADR-0060 amended 2026-10-31): the one answer to "is everything this session started
// gone". It reads the session's owner row and its process records and asks the OS about each:
//   - the owner, while the session is live in its row (an owner that finished it may live on, owning others);
//   - the session child (`child`), every guard (`guard`) and the tree each guard's command started;
//   - every container (`container`), found by the session label, since killing the exec client does not stop
//     the command inside: a container counts until it is removed by name.
// `unknown` never counts as gone. A record proven gone is marked ended, so the next read skips it.

import { SESSION_LABEL } from "../containment/containment.js";
import { cliRuntime, type ContainerRuntimeDriver, type RuntimeName } from "../containment/runtime.js";
import type { Ledger, ProcessRecordRow } from "../ledger/ledger.js";
import { isLive, ownerRow } from "../delegate/ownership.js";
import { findGuardedProcesses } from "./guard.js";
import { liveness, type Liveness, type ProcessIdentity } from "./identity.js";

export type QuiescenceKind = "owner" | "child" | "guard" | "command" | "container";

/** Something the session started that is not proven gone. */
export interface NotStopped {
  kind: QuiescenceKind;
  /** The OS pid; absent for a container, or for a guard's tree the OS would not list. */
  pid?: number;
  /** A container's id. */
  container?: string;
  liveness: Exclude<Liveness, "dead">;
}

export interface Quiescence {
  /** True only when every part is proven gone. */
  quiet: boolean;
  notStopped: NotStopped[];
}

export type ContainerDriver = Pick<ContainerRuntimeDriver, "listContainers" | "removeContainer">;

export interface QuiescenceDeps {
  livenessOf?: (identity: ProcessIdentity) => Liveness;
  /** A guard's command tree; undefined when the OS will not say. */
  treeOf?: (guard: { pid: number; recordedAt: number }) => number[] | undefined;
  driverFor?: (runtime: RuntimeName) => ContainerDriver;
  /** Remove the session's containers by name before counting them. Default false: only report. */
  stopContainers?: boolean;
  /**
   * T232: the caller is the session's own process, confirming at the end of its run that what the session started is
   * gone. The owner row (live until the run ends) and the records that are the caller itself are not "something the
   * session started"; `ignoreRecord` names the others to leave out (the container the verification still runs in).
   */
  ignoreOwner?: boolean;
  ignoreRecord?: (record: ProcessRecordRow) => boolean;
}

const RUNTIMES: readonly string[] = ["docker", "podman"];

/** The `container` record's `command` names the runtime. */
export function containerRecordCommand(runtime: RuntimeName): string {
  return runtime;
}

async function sessionContainers(driver: ContainerDriver, sessionId: string): Promise<string[] | undefined> {
  try {
    return (await driver.listContainers(SESSION_LABEL)).filter((c) => c.labels[SESSION_LABEL] === sessionId).map((c) => c.id);
  } catch {
    return undefined;
  }
}

/** Whether everything `sessionId` started is gone. Fail-closed: `unknown` is never gone. */
export async function confirmQuiescence(ledger: Ledger, sessionId: string, deps: QuiescenceDeps = {}): Promise<Quiescence> {
  const livenessOf = deps.livenessOf ?? ((identity: ProcessIdentity) => liveness(identity));
  const treeOf = deps.treeOf ?? ((guard: { pid: number; recordedAt: number }) => findGuardedProcesses(guard));
  const driverFor = deps.driverFor ?? ((runtime: RuntimeName) => cliRuntime(runtime));
  const notStopped: NotStopped[] = [];

  const owner = ownerRow(ledger, sessionId);
  if (deps.ignoreOwner !== true && owner !== undefined && isLive(owner.state)) {
    const state = owner.owner_pid === process.pid ? "alive" : livenessOf({ pid: owner.owner_pid, recordedAt: owner.owner_recorded_at_ms });
    if (state !== "dead") notStopped.push({ kind: "owner", pid: owner.owner_pid, liveness: state });
  }

  const records = ledger.processRecords(sessionId).filter((r) => r.ended_at === null && deps.ignoreRecord?.(r) !== true);
  for (const record of records) {
    const gone = await recordGone(record, sessionId, { livenessOf, treeOf, driverFor, stop: deps.stopContainers === true }, notStopped);
    if (gone) ledger.endProcess(record.id);
  }
  return { quiet: notStopped.length === 0, notStopped };
}

interface Readers {
  livenessOf: (identity: ProcessIdentity) => Liveness;
  treeOf: (guard: { pid: number; recordedAt: number }) => number[] | undefined;
  driverFor: (runtime: RuntimeName) => ContainerDriver;
  stop: boolean;
}

/** Pushes what of `record` is not proven gone; true when all of it is. */
async function recordGone(record: ProcessRecordRow, sessionId: string, r: Readers, out: NotStopped[]): Promise<boolean> {
  if (record.kind === "container") {
    if (!RUNTIMES.includes(record.command)) {
      out.push({ kind: "container", liveness: "unknown" });
      return false;
    }
    const driver = r.driverFor(record.command as RuntimeName);
    let ids = await sessionContainers(driver, sessionId);
    if (r.stop && ids !== undefined && ids.length > 0) {
      for (const id of ids) await driver.removeContainer(id).catch(() => {});
      ids = await sessionContainers(driver, sessionId);
    }
    if (ids === undefined) {
      out.push({ kind: "container", liveness: "unknown" });
      return false;
    }
    for (const id of ids) out.push({ kind: "container", container: id, liveness: "alive" });
    return ids.length === 0;
  }

  const identity = { pid: record.pid, recordedAt: record.recorded_at_ms };
  const state = r.livenessOf(identity);
  const kind: QuiescenceKind = record.kind === "guard" ? "guard" : "child";
  if (state !== "dead") out.push({ kind, pid: record.pid, liveness: state });
  if (record.kind !== "guard") return state === "dead";

  // A guard killed outright leaves its command: the tree counts until it is gone too.
  const tree = r.treeOf(identity);
  if (tree === undefined) {
    out.push({ kind: "command", liveness: "unknown" });
    return false;
  }
  const commands = tree.filter((pid) => pid !== record.pid);
  for (const pid of commands) out.push({ kind: "command", pid, liveness: "alive" });
  return state === "dead" && commands.length === 0;
}
