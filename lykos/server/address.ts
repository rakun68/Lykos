/**
 * Where the engine server listens and the key that proves a client is the same user (P5 #35, ADR-0064 decision 1).
 *
 * One server per user: the address and the key both live under the user's run directory, `~/.lykos/run`, or
 * `LYKOS_ENGINE_DIR` (tests, and a second server for one user). Windows listens on a named pipe whose name is a
 * hash of that directory; Linux on a Unix socket inside it. The directory is 0700 and the key file 0600 on Linux;
 * on Windows both sit in the user's profile, which other accounts cannot read. The key is what refuses another
 * account: a named pipe's default ACL lets other users open it for reading, and the handshake asks every client to
 * prove it read this file.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
  if (!existsSync(address.keyPath)) {
    try {
      writeFileSync(address.keyPath, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
    } catch (err) {
      // Two clients started at once: the other one wrote it first, and that key is the one.
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  if (process.platform !== "win32" && (statSync(address.keyPath).mode & 0o077) !== 0) {
    throw new Error(`${address.keyPath} is readable by other users; it must be 0600`);
  }
  const key = Buffer.from(readFileSync(address.keyPath, "utf8").trim(), "hex");
  if (key.length !== 32) throw new Error(`${address.keyPath} does not hold a 32-byte key`);
  return key;
}
