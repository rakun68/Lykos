// One owner of stdout. CLAUDE.md states the rule as a standing constraint --
// "stdout belongs to the transport in MCP mode ... one place decides which IO
// mode a process is in, and every writer asks it" -- but until this file,
// nothing implemented it: every CLI module called `process.stdout.write`
// directly, and the only reason `lykos mcp` was never corrupted is that no
// writer happened to run while it served. T33 (the in-process loop) and T37
// (the terminal agent UI) both add a writer to a process that may be either
// shape, so this is the last comfortable moment to build the owner.
//
// Four modes, not two, because `piped` has its own documented constraint
// that `mcp` doesn't share: `lykos hud --statusline` (07-ui-and-hud.md §1.3
// S1) is machine output consumed by Claude Code's status line, and its
// stdout must never carry ANSI colour or cursor control even though writing
// to it is otherwise perfectly safe.
export type IoMode = "standalone" | "mcp" | "piped" | "protocol";

let current: IoMode | undefined;

/**
 * Declare the process's IO mode. Call once, as early as possible in the
 * entrypoint that knows its own shape -- `lykos mcp` calls this with "mcp"
 * before `StdioServerTransport` connects, `lykos hud --statusline` calls it
 * with "piped". Every other command leaves the mode to be resolved lazily
 * from the environment on first use.
 */
export function setIoMode(mode: IoMode): void {
  current = mode;
}

/** Test-only: forget a mode set by setIoMode() or resolved from the environment. */
export function resetIoMode(): void {
  releaseProtocolStream();
  current = undefined;
}

/**
 * `protocol` mode (T181): this process's stdout is a JSON-lines stream to the
 * process that started it (`lykos session-child`), and io-mode owns it. The
 * real stdout is held here and reached only through the writer this returns;
 * every other write, a `stdoutWrite` from a writer that asks the mode or a raw
 * `process.stdout.write` from code that does not (an extension's
 * `console.log`, a dependency's banner), is routed to stderr. That makes
 * stdout's owner this module in every mode, rather than the caller patching
 * the stream itself.
 */
let protocolRestore: (() => void) | undefined;

export function claimProtocolStream(): { write: (text: string) => void; flush: () => Promise<void> } {
  releaseProtocolStream();
  const real = process.stdout.write;
  const bound = real.bind(process.stdout) as (chunk: string, cb?: () => void) => boolean;
  const toStderr = process.stderr.write.bind(process.stderr) as (...a: unknown[]) => boolean;
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => toStderr(chunk, ...rest)) as typeof process.stdout.write;
  protocolRestore = () => {
    process.stdout.write = real;
  };
  current = "protocol";
  return {
    write: (text) => void bound(text),
    // A pipe's write can be asynchronous and the process exits right after the last line: wait for it to leave.
    flush: () => new Promise<void>((resolve) => void bound("", () => resolve())),
  };
}

function releaseProtocolStream(): void {
  protocolRestore?.();
  protocolRestore = undefined;
}

/**
 * The resolved mode, computed once and cached. `LYKOS_IO_MODE` is the
 * explicit override tests and tooling can set; production code should prefer setIoMode() called from the entrypoint
 * that actually knows its shape. With neither, TTY-ness decides between
 * `standalone` (a person is watching a terminal) and `piped` (stdout is
 * redirected or captured) -- `mcp` is never the silent default, because
 * guessing a process INTO the mode that forbids stdout would hide the bug
 * this module exists to catch, not surface it.
 */
export function getIoMode(): IoMode {
  if (current) return current;
  const override = process.env.LYKOS_IO_MODE;
  if (override === "standalone" || override === "mcp" || override === "piped") {
    current = override;
    return current;
  }
  current = process.stdout.isTTY ? "standalone" : "piped";
  return current;
}

/**
 * The one function every writer in the package calls instead of
 * `process.stdout.write`. Throws in `mcp` mode rather than writing a byte
 * that would corrupt the JSON-RPC stream -- a thrown error surfaces
 * immediately at the call site that got this wrong; a written byte surfaces
 * as a mysteriously broken MCP client three files away.
 */
/**
 * Where diagnostics go while a full-screen surface owns the terminal.
 *
 * 2026-09-02, item 2 of the UI report: typing `/specialist` printed its
 * refusal twice and left the second copy smeared across the composer's
 * bottom rule for the rest of the session. Both halves were the same
 * mistake — `process.stderr.write` writing straight to a terminal that is
 * in the alternate buffer with a frame diff painting over it. Those bytes
 * are not part of any `Frame`, so `FrameWriter` neither draws nor erases
 * them: they sit wherever the cursor happened to be until something else
 * overwrites that exact row.
 *
 * `stdout` already had an owner (this module's whole point); stderr did
 * not, because until the full-screen surface existed nothing was hurt by
 * writing to it. Now something is. A full-screen caller installs a sink
 * for the span it owns the terminal, and every diagnostic in the package
 * routes through `stderrWrite` instead of `process.stderr` — the same
 * "one place decides, every writer asks" shape, one stream over.
 */
type StderrSink = (text: string) => void;
let stderrSink: StderrSink | undefined;

/** Install a sink for the duration a full-screen surface owns the terminal. Returns the uninstaller; call it before anything prints normally again. */
export function setStderrSink(sink: StderrSink): () => void {
  const previous = stderrSink;
  stderrSink = sink;
  return () => {
    stderrSink = previous;
  };
}

/**
 * The one function every diagnostic writer calls instead of
 * `process.stderr.write`. With no sink installed this is exactly
 * `process.stderr.write` and nothing about a non-full-screen session
 * changes.
 */
export function stderrWrite(text: string): void {
  if (stderrSink) {
    stderrSink(text);
    return;
  }
  process.stderr.write(text);
}

export function stdoutWrite(text: string): void {
  const mode = getIoMode();
  if (mode === "protocol") {
    // stdout carries frames and only frames; anything a writer says goes where a person can read it.
    process.stderr.write(text);
    return;
  }
  if (mode === "mcp") {
    throw new Error(
      "lykos: attempted to write to stdout while in mcp mode -- stdout is the JSON-RPC " +
        "transport and nothing else may write to it (CLAUDE.md, docs/15-phase3-tasks.md T32)",
    );
  }
  process.stdout.write(text);
}
