/**
 * `lykos serve` and `lykos server-session` (P5 #35). The first runs the engine server for this user; the second is
 * one of its session children and is never typed by hand.
 */
import { loadConfig } from "../config/load.js";
import { stderrWrite } from "../tui/io-mode.js";

export async function runServe(cwd: string, args: string[]): Promise<number> {
  let idleSeconds: number;
  const flag = args.indexOf("--idle");
  if (flag >= 0) {
    idleSeconds = Number(args[flag + 1]);
    if (!Number.isInteger(idleSeconds) || idleSeconds < 0) {
      stderrWrite("lykos serve: --idle takes a whole number of seconds\n");
      return 1;
    }
  } else {
    idleSeconds = loadConfig({ cwd }).resolved.tui.server_idle_seconds;
  }
  const { EngineServer } = await import("../server/server.js");
  // Tests only: a scripted session child in place of `lykos server-session`, as {command, args}.
  const child = process.env.LYKOS_ENGINE_CHILD ? (JSON.parse(process.env.LYKOS_ENGINE_CHILD) as { command: string; args: string[] }) : undefined;
  const server = new EngineServer({ idleSeconds, ...(child !== undefined ? { child } : {}) });
  try {
    await server.listen();
  } catch (err) {
    // Two clients that found no server both start one: the second finds the first listening and leaves it be.
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") return 0;
    stderrWrite(`lykos serve: ${(err as Error).message}\n`);
    return 1;
  }
  const done = new Promise<void>((resolve) => {
    const stop = (): void => void server.stop("signal").then(resolve);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    const timer = setInterval(() => {}, 1 << 30);
    void server.exited.then(() => {
      clearInterval(timer);
      resolve();
    });
  });
  await done;
  return 0;
}

export async function runServerSession(): Promise<number> {
  if (process.send === undefined) {
    stderrWrite("lykos server-session: started by the engine server only\n");
    return 1;
  }
  const { runSessionChild } = await import("../server/session-child.js");
  const sendToServer = process.send.bind(process);
  process.once("disconnect", () => {
    // The server is gone: the session's teardown runs (archive, ledger), with a deadline for one that hangs.
    setTimeout(() => process.exit(1), 30_000).unref();
  });
  const code = await runSessionChild(
    (msg) => {
      if (process.connected) sendToServer(msg);
    },
    (fn) => {
      process.on("message", fn as (m: unknown) => void);
      process.once("disconnect", () => fn({ kind: "close" }));
    },
  );
  process.disconnect?.();
  return code;
}
