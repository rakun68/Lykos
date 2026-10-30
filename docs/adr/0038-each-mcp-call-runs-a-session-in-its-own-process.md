# Each MCP call runs a delegated session in a process of its own

**Amended by [ADR-0053](0053-mcp-calls-reuse-a-warm-engine.md)** (a warm engine) **and
ADR-0056**
(a tool per specialist, asynchronous calls, the result contract; the additive-only rule breaks once).

Decided by the maintainer on 2026-10-10, while building the MCP boundary. **Amends
ADR-0036,** which
said "one `lykos` child process per call" in a few lines and left the protocol, the session id, progress
and trust to the build. This fixes them.

## The decision

**`lykos mcp` runs no session itself.** Each tool call starts `lykos session-child`, a process of its
own, and waits for its result. The server keeps the MCP surface, the trust gate and the mapping between a
call and a session request. The session is exactly the one `lykos run` starts: both build it through
`sessionInput` in `lykos/cli/run.ts`.

- **The runner is the seam.** `createMcpServer` takes a `SessionRunner`. Production starts a process;
  tests inject a stand-in.
- **The child is `node` on Lykos's entry script,** never a `.cmd` shim: `dist/cli.js` when built, `cli.ts`
  under tsx in a checkout.
- **The wire is JSON Lines.** One `request` line on the child's stdin. On its stdout, `progress` lines and
  then one `result` line. Nothing else is written to the child's stdout: the child hands the real stdout to
  the protocol and sends every other write to stderr. The parent parses stdout, never forwards it, and
  relays stderr to its own stderr. `docs/reference/mcp.md` is the contract.
- **Every call returns a session id,** and a later call passes it as `session_id` to continue that
  session the way `lykos resume` does: same id, same task, the earlier turns replayed.
- **Progress is a heartbeat,** a `session starting` line and then an elapsed-time line every 15 seconds, plus, on a continuation, one line saying what the replayed context is, sent by the child and turned by the server into MCP
  `notifications/progress` for a client that gave a progress token. It exists so a long call is not
  aborted by the client's 30-minute stdio limit.
- **A crash is a result.** A child that exits, is killed or never answers yields an `error` outcome with
  its exit and the tail of its stderr. The server and every other call are untouched. When the client
  cancels a call or goes away, its process is stopped.
- **The contract changes only by adding optional fields.** Inputs gain `containment`, `session_id` and
  `write_in_place`. Results gain `containment`, `runtime`, `branch`, `commits` and `skipped_extensions`.
  The four tool names, `brief` as the one required input, and the existing result fields are unchanged.
- **Trust is a claim, checked again.** The server passes how it established trust as
  `LYKOS_TRUST_SOURCE`. The child reads the user trust store itself, so the claim can pass the gate as
  `flag` and can never produce `stored`: only the store trusts a project's own binaries
  (old issue 24).
- **The floor holds across the boundary.** The child loads the user and project config itself, so
  `containment.minimum` binds a call exactly as it binds `lykos run`, and a request below it is refused
  before the session boots.

- **io-mode owns the child's stdout.** `protocol` is an io mode, like `mcp` and `piped`: `claimProtocolStream`
  in `lykos/tui/io-mode.ts` holds the real stdout, returns the writer for frames, and routes every other
  write to stderr. The child asks io-mode; it patches no stream itself (CLAUDE.md rule 8).
- **A review cannot change the tree.** The child runs `lykos_review` with `readOnly: true`, the path
  read-only children use, so every layer applies: the tool list is cut to `READ_ONLY_CHILD_TOOLS` after
  config `tools_add`, specialists and extension tools have been merged, the read-only gate refuses a
  mutating call, and the harness blocks it. It holds no `edit`, `write`, `bash`, `powershell` or `commit` on
  its wire, and does not rely on the gate alone, which would stop holding when #37 gives an MCP call a way
  to approve. A top-level session may now be read-only; that was a child-only rule. A read-only session also runs without self-compact (`selfCompact.enabled` is off for any read-only session, because the cut removes `self_compact`), so a long review relies on Pi's own compaction.
- **An MCP continuation is the caller's confirmation.** Resume asks a person to confirm a paid context.
  Over MCP there is none, so the child runs resume with `yes: true`, and passing `session_id` is the
  confirmation. The progress line says the replayed context's size and price are unmeasured: resume's own
  figure is a characters/4 estimate priced as if it were fact, and 0 when it has nothing to estimate from,
  and neither is a measurement. The real cost is in the ledger once the first call is recorded.
- **A failed call carries the session id when a session exists.** `RunStandaloneTaskResult`'s `error`
  variant has an optional `sessionId`, set once the session had a ledger row and a transcript. `blocked` is
  decided before boot and has none.

## Why

A session that runs inside the server can crash it, hang it, and write into the MCP transport's stdout,
which carries the JSON-RPC stream (CLAUDE.md rule 8). Two calls would share a process, a working directory
and an event loop. A process per call makes the isolation structural instead of a discipline every
writer has to keep, and it is the shape ADR-0036
settled on. Building the session from the one function `lykos run` uses keeps the CLI and MCP from
diverging (spec #22 story 74).

## Options considered

- **Host sessions in the server process.** Rejected, as ADR-0036 already did: one crash or stray
  write takes down every caller.
- **A long-lived worker pool.** Rejected: a pool shares state between callers and needs its own recycling
  rules. The cost it saves, process start, is small against a session.
- **Progress from the session's event stream.** Not done: the engine exposes no event hook to a one-shot
  caller, and the keepalive is what the client limit needs. Per-turn milestones can be added to the same
  `progress` frame later without changing the protocol.
- **Trust in the request body.** Rejected: a request is data the parent built from a caller's input. Trust
  travels in the environment as a claim and is checked against the store in the child.

## Consequences

- `lykos/delegate/session-protocol.ts` (the frames and the runner type), `session-process.ts` (the
  production runner) and `lykos/cli/session-child.ts` (the child) are new. `lykos session-child` is an
  internal command, not listed for people to use.
- `branch`, `skipped_extensions` and the effect of `write_in_place` arrive with the worktree and the
  trust-skipped-extension work. (Amended 2026-10-11, #36: `skipped_extensions` is now produced, on `ok`,
  `blocked` and `error` results. Until the worktree work a session wrote in the caller's own tree and the
  fields were defined but never reported.)
- A delegated session with no TTY and no `--yes` refuses gated writes. An MCP call is no different, and
  is not made ungated to avoid it (#37).
- The old `runTask` path and `docker/sandbox-run.mjs` are no longer reached from `lykos mcp`. Deleting
  them is #38.
