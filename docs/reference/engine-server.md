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
| `session.start` | `{cwd, model?, mode?, autoApprove?, trust?, origin?, resume?, fork?}` | `SessionSummary`. An untrusted workspace is refused unless `trust: true`. `resume` (a ledger session id) continues it as `lykos resume` does, `fork` as `lykos resume --fork`; a preflight that needs agreement asks it as a `question` request. A resume of a ledger session already open, or being opened, is refused |
| `session.prompt` | `{session, text}` | `{ok: true}` |
| `session.interrupt` | `{session}` | `{ok: true}` |
| `session.answer` | `{session, requestId, answer}` | `{ok: true}`: answers an approval or a question |
| `session.close` | `{session}` | `{ok: true}` |
| `session.aside` | `{session, text}` | `{answer, model}`: a side question (`/btw`) answered from the session's context with no tools. It enters no transcript and no turn; its call is in the session's usage and its ledger row has `phase` `aside` |
| `session.options` | `{session}` | `{model, models: [{provider, id, name, contextWindow, reasoning}], effort, efforts, specialist, specialists: [{name, description}], providers: [{name, auth, reach, reason}]}`: what the TUI's lists show, from the session's own runtime. `models` are those with auth; `effort` is null where the model has none; `providers` is the `lykos providers` matrix |
| `config.keybinds` | `{cwd}` | `{keybinds: {<action>: {value, source}}, colors: {<role>: {value, source}}, defaults?: {model, effort, specialist}}`: each action's `tui.keybinds` value and each role's `tui.colors` value from the last config layer that names it, and that layer (`project (path)`); `defaults` is what a new session in `cwd` starts with (#58), left out when it cannot be resolved. Keybinds are not validated against the action table: the TUI owns it |
| `sessions.history` | `{cwd, all?, archived?}` | `{rows: [{id, title, startedUtc, endedUtc, model, parentSessionId, forkedFrom, resumedFrom, depth, archived, resumable, costUsd, projectPath, projectName}], live: {<ledger id>: <server id>}, delegated: {<ledger id>: {owner, state, startedAt, specialist}}}`: the project's ledger sessions, newest first and nested; every registered project's with `all`; archived ones only with `archived` (P5 #42). `delegated` holds the cwd's project's MCP (`owner: "mcp"`) and `lykos run` (`"run"`) sessions that are `running` or `waiting`; one not yet in `rows` is added to them (P5 #51) |
| `session.watch` | `{cwd, id}` | `SessionSummary` (`origin` `mcp` or `run`) of a delegated session of the cwd's project, shown, not owned (P5 #51). Its owner keeps running it; the server reads its owner row and live transcript every 250 ms and sends them as the session's events. `session.prompt` steers it as `lykos steer` does, `session.interrupt` stops it as `lykos stop` does, `session.close` ends the watch only. Side questions, options and jobs are refused. A second watch of the id answers the same session; an id with no owner row is refused. A watched session does not keep the server up |
| `session.rename` | `{cwd, ledgerSessionId, title}` | `{ok: true}`: the ledger's brief, and a live session's `title` |
| `session.archive` | `{cwd, ledgerSessionId}` | `{ok: true}`: OpenCode's delete, as an archive. A live session is closed first. `sessions.archived_utc` is set; the row and transcript stay, `lykos session --all` lists it, and a resume clears it |
| `session.export` | `{cwd, ledgerSessionId, file?}` | `{markdown, path?}`: `lykos export`'s Markdown, written to `file` (relative to `cwd`) when one is named |
| `session.move` | `{session, cwd}` | `SessionSummary` of the session continued in `cwd`: the live one is closed and resumed there, same ledger session, writing the ledger it started with. Refused while a turn runs or a request is open, and, before the session closes, when `cwd` is not a directory or not trusted |
| `worktree.list` | `{cwd}` | `[{path, branch, head, main, sessions}]`: the repository's worktrees, the main checkout first; `sessions` when a live session runs in it |
| `worktree.create` | `{cwd, name}` | `{path, branch, head, main}`: a worktree at `~/.lykos/worktrees/<project id>/<name>` on the branch `lykos/<name>` |
| `worktree.remove` | `{cwd, path}` | `{removed, savedUncommitted, saved?, note?}`: uncommitted work is committed onto the branch and ignored files the sessions wrote are archived beside it, then the worktree is removed. The branch stays. Only a worktree Lykos made is removed: under `~/.lykos/worktrees/<project id>/` on a `lykos/` branch. Refused for the main checkout, a detached or other worktree, and while a session runs there or in a directory under it, here or in another process (its lock is held) |
| `vcs.diff` | `{cwd, mode}` | `{base?, branch?, files: [{file, status, additions, deletions, patch}]}`: the repository's changes, 12 lines of context. `branch` is everything since the merge base with the default branch (the remote's HEAD, else `init.defaultBranch`, else `main`, else `master`), untracked files included; `committed` only what is committed since it; `working` what is not committed, against `HEAD`. Before the first commit, the untracked files. A binary file, or an untracked one over 1 MiB, has an empty `patch` |
| `session.job.logs` | `{session, jobId, offset?}` | `{text, nextOffset, size}`: a background job's log from byte `offset`, at most 40,000 bytes; without `offset`, its last 40,000 bytes |
| `session.job.stop` | `{session, jobId}` | `{status}`: kills the job's process tree (`taskkill /T /F` on Windows, the process group elsewhere) and waits for it to exit |
| `session.background` | `{session}` | `{jobs: [id]}`: moves the shell calls holding the turn to the background. Each becomes a job, its output goes to the job's log, it is no longer timed, and the tool call ends with a notice naming the job |
| `subscribe` | `{sessions?, after?: {<id>: seq}}` | `{sessions: SessionSummary[]}`, then the replay |

### 2.3 Events

`{event, session, seq, data}`. `seq` counts from 1 for each session and has no gaps. The server
keeps every event of a live session. A `subscribe` replays what came after each `after` seq (all of
it when absent), then streams. A client applies an event only when its `seq` is one past the last it
applied, so an overlapping replay changes nothing and a gap waits.

`data.type`: `session.status` (with the whole `SessionSummary`), `message.user`, `message.followup`,
`message.delta`, `thinking.delta`, `message.end`, `tool.start`, `tool.end` (preview capped at 8 KB,
`diff?` for a file change), `request`, `request.resolved`, `usage`, `system` (a notice line, compaction
among them), `turn.end` and `commands` (the slash commands the session runs, `{name, description, source}`,
sent once it has booted: what a client completes `/` from) and `prompt.set` (`{text}`: a prompt an undo or a
rewind put back, for the client's prompt) and `jobs` (`{jobs: [{id, command, status, startedAt, exitCode?}], foreground: [{id, command}]}`, whole, whenever a job or a running shell call starts or ends). The types
are `lykos/server/protocol.ts`; `crates/client/src/protocol.rs` mirrors them, and reads a type it
does not know as `Unknown`.

`SessionSummary`: `{id, cwd, status, model, title, startedAt, origin, ledgerSessionId}`. `status` is
`starting`, `idle`, `running`, `waiting` (a request is open) or `closed`. `title` is the first
prompt. `origin` is who started it: `tui`, or for a watched session its owner, `mcp` or `run`.

`UsageData` (the `usage` event): `{model, effort, contextTokens, contextWindow, contextPercent, runUsd,
todayUsd, cacheHitRatio, calls, tokens, cache, alerts, outcome}`, read from Pi and the ledger as the old
TUI's HUD reads them (`deriveHud`). `tokens` is `{fresh, cacheRead, cacheWrite, output, reasoning}`;
`cache` is the model in use's provider-backed reading, `{model, cachedTokens, writtenTokens, ageSeconds,
pct, status}` or null; `alerts` is `[{id, severity, message, remedy}]`; `outcome` is `{value, source,
verified}` or null, `verified` only for a verification command or a human. A client formats them and
derives nothing from them (P5 #53, scanned by `lykos/server/tui-scan.test.ts`).

---

## 3. Sessions

Each session runs in its own `lykos server-session` child, spawned with an IPC channel: the same
interactive session `lykos run --interactive` runs without a terminal, with its approvals and questions sent as `request` events and
answered by `session.answer`. Its ledger row and archive are written exactly as that session's are. Interaction modes apply
through `ModeGate` (`lykos/gate/mode-gate.ts`), as the old TUI's gate applied them (P5 #55).
When the server goes away the child closes its session (archive and ledger), with a 30 s deadline.
A session in one of Lykos's worktrees (`~/.lykos/worktrees/`) writes the main checkout's ledger, so
removing the worktree takes none of its sessions with it. `/fork` and a rewind or redo past the
process continue in the same child, through a resume, as `lykos run` continues them.

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
