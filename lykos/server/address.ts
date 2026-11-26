/**
 * Where the engine server listens and the key that proves a client is the same user (P5 #35, ADR-0064 decision 1).
 *
 * One server per user: the address and the key both live under the user's run directory, `~/.lykos/run`, or
 * `LYKOS_ENGINE_DIR` (tests, and a second server for one user). Windows listens on a named pipe whose name is a
 * hash of that directory; Linux on a Unix socket inside it. The directory is 0700 and the key file 0600 on Linux;
 * on Windows the key file is given an owner-only ACL when it is created. The key is what refuses another
 * account: a named pipe's default ACL lets other users open it for reading, and the handshake asks every client to
 * prove it read this file.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface EngineAddress {
  /** The run directory: the key file, the server's log, and on Linux the socket. */
  dir: string;
  /** What `net.createServer().listen()` and `net.connect()` take. */
  path: string;
  keyPath: string;
  logPath: string;
}

export function engineDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LYKOS_ENGINE_DIR;
  return resolve(override !== undefined && override !== "" ? override : join(homedir(), ".lykos", "run"));
}

export function engineAddress(dir: string = engineDir(), platform: NodeJS.Platform = process.platform): EngineAddress {
  const path =
    platform === "win32"
      ? `\\\\.\\pipe\\lykos-engine-${createHash("sha256").update(dir.toLowerCase()).digest("hex").slice(0, 16)}`
      : join(dir, "engine.sock");
  return { dir, path, keyPath: join(dir, "engine.key"), logPath: join(dir, "engine.log") };
}

/** Creates the run directory owner-only, or tightens it when it is not. */
export function ensureEngineDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32" && (statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/** The 32-byte key, created on first use. A key file anyone else can read is refused: it would prove nothing. */
export function readOrCreateKey(address: EngineAddress): Buffer {
  ensureEngineDir(address.dir);
  // On Windows a key outside the profile (whose ACL already keeps other users out) may have been left with an
  // inherited ACL, or put there by someone else: one that is not owner-only is replaced, so no one else knows it.
  // Inside the profile this costs nothing; outside it, one icacls run.
  if (process.platform === "win32" && existsSync(address.keyPath) && !isInside(address.keyPath, homedir()) && !aclIsOwnerOnly(address.keyPath)) {
    rmSync(address.keyPath, { force: true });
  }
  if (!existsSync(address.keyPath)) {
    // Written whole under a private name, then linked into place: a client never reads a half-written key, and
    // of two servers started at once the second link fails and both use the first key.
    const tmp = `${address.keyPath}.${process.pid}.tmp`;
    // A file of this name is a dead server's whose pid this one reused: no live process owns it.
    rmSync(tmp, { force: true });
    try {
      writeFileSync(tmp, "", { mode: 0o600, flag: "wx" });
      // Windows ignores the mode: the file inherits its directory's ACL, which outside the profile (a
      // LYKOS_ENGINE_DIR under C:\Workspace, say) can let every signed-in user read it. Owner-only before the key is in it.
      if (process.platform === "win32") ownerOnly(tmp);
      writeFileSync(tmp, randomBytes(32).toString("hex"));
      linkSync(tmp, address.keyPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  if (process.platform !== "win32" && (statSync(address.keyPath).mode & 0o077) !== 0) {
    throw new Error(`${address.keyPath} is readable by other users; it must be 0600`);
  }
  const key = Buffer.from(readFileSync(address.keyPath, "utf8").trim(), "hex");
  if (key.length !== 32) throw new Error(`${address.keyPath} does not hold a 32-byte key`);
  return key;
}

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Whether a Windows file's ACL is one entry, not inherited, for the current user. icacls prints the path, then one
 * "<account>:<rights>" entry per line, then a summary line.
 */
export function aclIsOwnerOnly(path: string): boolean {
  const entries = execFileSync("icacls", [path], { encoding: "utf8", windowsHide: true })
    .replace(path, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.includes(":("));
  const only = entries[0];
  return entries.length === 1 && only !== undefined && only.split(":(")[0]?.split("\\").at(-1) === userInfo().username && !only.includes("(I)");
}

/** Replaces a Windows file's ACL with one entry: full control for the current user. */
function ownerOnly(path: string): void {
  execFileSync("icacls", [path, "/inheritance:r", "/grant:r", `${userInfo().username}:F`], { stdio: "ignore", windowsHide: true });
}
