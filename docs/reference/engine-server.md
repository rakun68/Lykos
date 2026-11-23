# The engine server

`lykos serve` runs every interactive session for one user and serves them to clients: the new TUI
(`crates/tui`), later the desktop app, and the TypeScript client the tests use. One server per user.
A client starts it when none answers. Decided in [ADR-0064](../adr/0064-the-p5-tui-copies-opencode-on-a-local-engine-server-and-speed-gates-it.md)
decision 1. Source: `lykos/server/`, the Rust client `crates/client/`.

---

## 1. Address and key

| | Windows | Linux |
| --- | --- | --- |
| Run directory | `LYKOS_ENGINE_DIR`, else `~/.lykos/run` | same, created `0700` |
| Address | named pipe `\\.\pipe\lykos-engine-<h>`, where `h` is the first 16 hex characters of `sha256(lowercase(run dir))` | `<run dir>/engine.sock` |
| Key | `<run dir>/engine.key`: 64 hex characters (32 bytes), given an owner-only ACL when created | same, `0600`; a key file others can read is refused |
| Log | `<run dir>/engine.log`: the server's lines and every session child's output | same, `0600` |

The key is what refuses another account. A named pipe's default ACL lets other users open it, so
every client proves it read the key before the server answers anything.

A second server on the same address finds the first one answering and exits 0. A stale Unix
socket with nothing behind it is removed.

---

## 2. The wire

NDJSON: one JSON object per line, in both directions.

### 2.1 Handshake

| Step | From | Message |
| --- | --- | --- |
| 1 | client | `{type: "hello", protocol, client, nonce}` |
| 2 | server | `{type: "challenge", nonce, proof}`: `proof = HMAC-SHA256(key, "server:" + client nonce)` |
| 3 | client | `{type: "auth", proof}`: `HMAC-SHA256(key, "client:" + server nonce)` |
| 4 | server | `{type: "welcome", protocol, server, pid}` or `{type: "refused", reason, message}` |

`reason` is `protocol` or `auth`. A protocol refusal names both versions: "the server speaks
protocol 1; this client speaks 0". The client checks the server's proof too, so a process squatting
on the address cannot pose as the server. Each step has a 5 s deadline.

`PROTOCOL_VERSION` is 1.

### 2.2 Requests

`{id, method, params}` answered by `{id, result}` or `{id, error: {message}}`.

| Method | Params | Result |
| --- | --- | --- |
| `server.info` | | `{protocol, pid, startedAt, idleSeconds, clients, sessions}` (counts) |
| `server.shutdown` | | `{stopping: true}`; every connection is closed, every session child told to close |
| `server.disconnect` | | `{closed}`: closes every connection except this one (tests drive reconnection with it) |
| `sessions.list` | | `SessionSummary[]` |
| `session.start` | `{cwd, model?, mode?, autoApprove?, trust?, origin?}` | `SessionSummary`. An untrusted workspace is refused unless `trust: true` |
| `session.prompt` | `{session, text}` | `{ok: true}` |
| `session.interrupt` | `{session}` | `{ok: true}` |
| `session.answer` | `{session, requestId, answer}` | `{ok: true}`: answers an approval or a question |
| `session.close` | `{session}` | `{ok: true}` |
| `subscribe` | `{sessions?, after?: {<id>: seq}}` | `{sessions: SessionSummary[]}`, then the replay |

### 2.3 Events

`{event, session, seq, data}`. `seq` counts from 1 for each session and has no gaps. The server
keeps every event of a live session. A `subscribe` replays what came after each `after` seq (all of
it when absent), then streams. A client applies an event only when its `seq` is one past the last it
applied, so an overlapping replay changes nothing and a gap waits.

`data.type`: `session.status` (with the whole `SessionSummary`), `message.user`, `message.followup`,
`message.delta`, `thinking.delta`, `message.end`, `tool.start`, `tool.end` (preview capped at 8 KB,
`diff?` for a file change), `request`, `request.resolved`, `usage`, `system` (a notice line, compaction
among them) and `turn.end`. The types
are `lykos/server/protocol.ts`; `crates/client/src/protocol.rs` mirrors them, and reads a type it
does not know as `Unknown`.

`SessionSummary`: `{id, cwd, status, model, title, startedAt, origin, ledgerSessionId}`. `status` is
`starting`, `idle`, `running`, `waiting` (a request is open) or `closed`. `title` is the first
prompt.

---

## 3. Sessions

Each session runs in its own `lykos server-session` child, spawned with an IPC channel: the same
interactive session the old TUI runs, with its approvals and questions sent as `request` events and
answered by `session.answer`. Its ledger row and archive are written exactly as the old TUI's are.
When the server goes away the child closes its session (archive and ledger), with a 30 s deadline.

---

## 4. When it exits

- With no client connected and no session `starting`, `running` or `waiting`, it waits
  `tui.server_idle_seconds` (default 60) and exits. Idle sessions are closed on the way out.
- Before its first client connects it waits at least 30 s, whatever the idle time, so the client
  that started it has time to connect.
- On `server.shutdown`, SIGINT or SIGTERM.

The default is a choice made from two measurements on Windows (2026-11-23): a cold start, spawn to
the first welcome, takes 98 ms (median of 10, max 113; measured 2026-11-23 on Windows 10), and an idle server holds 58 MiB. Starting
again is cheap and staying up is not, so 60 s covers closing and reopening the TUI and little else.
The measuring scripts are not committed: time a built `lykos serve --idle 0` from spawn to its first
welcome, and read the working set of one left idle.

---

## 5. Environment

| Variable | Read by | Meaning |
| --- | --- | --- |
| `LYKOS_ENGINE_DIR` | server, clients | The run directory. A second directory is a second server |
| `LYKOS_SERVE_CMD` | Rust client | The command that starts a server, as a JSON array. Default `cmd /d /c lykos serve` on Windows, `lykos serve` elsewhere |
| `LYKOS_ENGINE_CHILD` | server (tests only) | A scripted session child in place of `lykos server-session`, as JSON `{command, args}` |
| `LYKOS_RECORD_EVENTS` | `lykos/server/session-child.test.ts` | Rewrites `crates/client/tests/fixtures/session.ndjson` from a real session |

The Rust client starts the server detached from its terminal: on Windows in a new process group with
no window, elsewhere in its own process group.

---

## 6. Tests

- `node --import tsx --test lykos/server/*.test.ts`: the handshake, ordering, replay, trust, idle
  rules and key permissions against a scripted child, and one real session against a fake model.
- `cargo test -p lykos-client`: the store against the recorded session.
- `node scripts/tui/client-test.mjs`: the Rust client against the real server: start, reuse, a
  dropped connection replayed, and an old protocol refused.
