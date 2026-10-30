// `lykos mcp` — T15 (docs/09-phase1-tasks.md). What an orchestrator registers
// instead of the raw `pi` server:
//
//   claude mcp add lykos -- npx -y lykos mcp
//
// "stdout belongs to the transport in MCP mode" (CLAUDE.md): from the
// moment `StdioServerTransport` connects, stdout is the SDK's JSON-RPC
// stream and nothing else may write to it. T181: this process runs no
// session. Each tool call starts a `lykos session-child` process
// (delegate/session-process.ts) whose stdout is parsed as the JSON-lines
// protocol and never forwarded, and whose stderr is relayed to this
// process's stderr. docs/reference/mcp.md is the contract.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "../delegate/mcp-server.js";
import { setIoMode } from "../tui/io-mode.js";

export async function runMcp(cwd: string, version: string): Promise<number> {
  // T32: declared before the transport connects, so any writer elsewhere in
  // the process that reaches stdoutWrite() during this session throws
  // instead of writing a byte into the JSON-RPC stream.
  setIoMode("mcp");
  const server = createMcpServer({ workspace: cwd, version });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await server.pool?.shutdown();
    } catch {}
    try {
      await server.close();
    } catch {}
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  // Never resolves under normal operation — the process exits when stdin
  // closes (the transport's own `onclose` triggers process teardown) or on
  // a signal. Returning a Promise that only rejects keeps main()'s
  // `Promise<number>` contract honest without a fake resolved exit code.
  return new Promise<number>((_resolve, reject) => {
    transport.onclose = () => void shutdown();
    transport.onerror = (err) => reject(err);
  });
}
