// Process identity (T257, ADR-0060 amended 2026-10-31: fail-closed).
//
// A process is recorded as its pid plus the time the record was written, and the record is written only
// while the process lives, after it started. Later, "the same process" means a live process with that pid
// that was created before the record. A live process with that pid created after the record is a reused
// pid: the recorded process is gone. The creation time is read from the OS on demand: /proc on Linux, `ps`
// on macOS, CIM on Windows.
//
// A zombie (exited, its status not yet read) is not live. `dead` only when no live process has the recorded identity. Anything that cannot be decided (the creation
// time cannot be read, a query fails) is `unknown`, never `dead`: a caller that would take over a session
// from a dead owner must never do it on a guess.
//
// Clock resolution never makes a live process look reused. Linux's boot time is whole seconds and macOS's
// `lstart` is whole seconds, both truncated, so the computed creation time is never later than the real one,
// and the real one is before the record.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export type Liveness = "alive" | "dead" | "unknown";

export interface ProcessIdentity {
  pid: number;
  /** When the record was written, epoch milliseconds, while the process was alive. */
  recordedAt: number;
}

/** The creation time of a live process, epoch ms; `null` when no process has that pid; `undefined` when it cannot be read. */
export type CreationTime = number | null | undefined;

export interface IdentityDeps {
  platform?: NodeJS.Platform;
  /** `process.kill(pid, 0)`: throws ESRCH when there is no such process, EPERM when there is one we may not signal. */
  signalZero?: (pid: number) => void;
  /** Reads the creation time; tests pass a stand-in. */
  createdAt?: (pid: number) => CreationTime;
}

/** True, false, or undefined when the OS will not say. */
export function pidExists(pid: number, signalZero: (pid: number) => void = (p) => process.kill(p, 0)): boolean | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    signalZero(pid);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return undefined;
  }
}

let linuxBootMs: number | undefined;
let linuxTicksPerSecond: number | undefined;

function linuxCreatedAt(pid: number): CreationTime {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (err) {
    return (err as { code?: string }).code === "ENOENT" ? null : undefined;
  }
  // The command name is in parentheses and may contain spaces; fields resume after the last ')'.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  // A zombie has exited; only its exit status waits to be read.
  if (fields[0] === "Z") return null;
  // starttime is field 22 overall: the 20th after the name (state is the 1st).
  const ticks = Number(fields[19]);
  if (!Number.isFinite(ticks)) return undefined;
  if (linuxBootMs === undefined) {
    try {
      const btime = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1];
      if (btime === undefined) return undefined;
      linuxBootMs = Number(btime) * 1000;
    } catch {
      return undefined;
    }
  }
  if (linuxTicksPerSecond === undefined) {
    try {
      const hz = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
      if (!Number.isFinite(hz) || hz <= 0) return undefined;
      linuxTicksPerSecond = hz;
    } catch {
      return undefined;
    }
  }
  return linuxBootMs + Math.floor((ticks * 1000) / linuxTicksPerSecond);
}

function macCreatedAt(pid: number): CreationTime {
  let out: string;
  try {
    out = execFileSync("ps", ["-o", "stat=", "-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch (err) {
    // ps exits 1 with no output when there is no such process.
    return (err as { status?: number }).status === 1 ? null : undefined;
  }
  if (out === "") return null;
  const [state = "", ...rest] = out.split(/\s+/);
  // A zombie has exited; only its exit status waits to be read.
  if (state.startsWith("Z")) return null;
  const ms = Date.parse(rest.join(" "));
  return Number.isFinite(ms) ? ms : undefined;
}

function windowsCreatedAt(pid: number): CreationTime {
  const script =
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop; ` +
    `if ($null -eq $p) { 'none' } else { $p.CreationDate.ToUniversalTime().ToString('o') }`;
  let out: string;
  try {
    out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      timeout: 15_000,
    }).trim();
  } catch {
    return undefined;
  }
  if (out === "none") return null;
  const ms = Date.parse(out);
  return Number.isFinite(ms) ? ms : undefined;
}

/** The OS creation time of `pid`, read now. */
export function processCreatedAt(pid: number, platform: NodeJS.Platform = process.platform): CreationTime {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (platform === "linux") return linuxCreatedAt(pid);
  if (platform === "darwin") return macCreatedAt(pid);
  if (platform === "win32") return windowsCreatedAt(pid);
  return undefined;
}

/** Whether the recorded process is still alive. Fail-closed: `dead` only when it is decided. */
export function liveness(identity: ProcessIdentity, deps: IdentityDeps = {}): Liveness {
  const exists = pidExists(identity.pid, deps.signalZero);
  if (exists === false) return "dead";
  if (exists === undefined) return "unknown";
  const created = (deps.createdAt ?? ((pid: number) => processCreatedAt(pid, deps.platform)))(identity.pid);
  if (created === null) return "dead";
  if (created === undefined) return "unknown";
  return created <= identity.recordedAt ? "alive" : "dead";
}
