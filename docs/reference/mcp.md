# The MCP contract

`lykos mcp` serves Lykos as an MCP worker over standard IO. This file is the contract: what a caller may
send, what it gets back, and how the server and the process behind each call talk. Decisions:
ADR-0036 and
ADR-0038 (amended by ADR-0056: `ok` now needs a passing verification). Source:
`lykos/delegate/mcp-server.ts` (the surface), `lykos/delegate/session-protocol.ts` (the wire),
`lykos/delegate/session-process.ts` (the runner) and `lykos/cli/session-child.ts` (the child).

Register it with a client: `claude mcp add lykos -- npx -y lykos mcp`. The client starts the server in the
project's directory, which is the workspace its calls run against.

## What a call does

Each call runs a **delegated session**: an ordinary Lykos session (its tools, gate, extensions,
mechanisms, ledger and credential pool) started in a `lykos session-child` process of its own. The server
runs no session itself. A session that crashes or hangs cannot take the server or another call down, and
two concurrent calls are two processes.

A call is the same session `lykos run` starts. Both build it through
`sessionInput` in `lykos/cli/run.ts`.

## Tools

`lykos mcp` exposes four asynchronous orchestration tools (`lykos_start`, `lykos_status`, `lykos_steer`, `lykos_stop`), dynamically discovered specialist tools (`lykos_<name>`), and four framed aliases (`lykos_implement`, `lykos_refactor`, `lykos_debug`, `lykos_review`), where an alias claimed by a specialist is that specialist's tool.

### Asynchronous Tools (T223)

Orchestrators can run sessions concurrently without blocking by using `lykos_start` and monitoring them with `lykos_status`:

- **`lykos_start`**: Starts an asynchronous Lykos session in the background and returns immediately with `{ session_id, state: "running", specialist }`. Requires `specialist` and `brief`. Request parameters (`tool`, `label`, `mode: "auto"`) and unframed prompt assembly align directly with pure specialist tools.
- **`lykos_status`**: Polls or waits on one or more sessions. Accepts either `session_id` (single string) or `session_ids` (array of strings). Accepts `wait_seconds` (0 to 300) to block until sessions finish or ask a question. If `any: true` is set, returns as soon as any requested session finishes or enters the `waiting` state; otherwise waits until all requested sessions finish or the timeout expires. Returns an array of `{ session_id, state, elapsed_seconds, turns, last_tool, cost_usd, unpriced_calls, question, result? }`. `state` is one of `"running"`, `"waiting"`, `"stopped"`, `"done"`, or `"error"`. Metrics (`turns`, `cost_usd`, `unpriced_calls`, `last_tool`) are read from the ledger; `cost_usd` is null when every call is unpriced or no ledger exists, and `unpriced_calls` is the count of unpriced calls (0 when all calls are priced; null only when the ledger is unreadable). Both `cost_usd` and `unpriced_calls` are computed directly from the `calls` table so a pre-L3 row's 0 cannot leak through and a live session gets the count too. When a session stops or completes, `result` carries its full result object conforming to the T220 result contract. Unknown session IDs return an error naming the unknown ID.
- **`lykos_steer`**: Delivers a steering message into an active session's running loop via `AgentSession.steer`. Requires `session_id` and `message`. If the session is currently in the `waiting` state, `message` answers the pending question: the session transitions back to `"running"`, `question` is cleared to null, and execution resumes. Refused with an error if the session is unknown or has already ended/stopped; the refusal explicitly explains that an ended session must be continued by resuming with `session_id`.
- **`lykos_stop`**: Aborts a running or waiting session gracefully, waiting up to 10 seconds for the runner to resolve before returning `{ session_id, state: "stopped" }`. It records the session in the ledger as stopped and resumable (`resumable = 1`, `notes = "stopped: lykos_stop"`), leaving already-ended rows untouched. Any held tree locks (`write_in_place`) are released. The session's result (retrievable via `lykos_status`) conforms to the T220 result contract: `outcome` is in the closed set (`unverified`, `ok`, `disputed`, `error`, `needs_answer`), `verification` is populated, and `next` does not recommend `review_or_accept` without passing verification.

**Server Lifetime**: A started session dies with its server. When the MCP server closes or shuts down, all live sessions (both background and blocking) are aborted, marked stopped in the ledger with reason `"stopped: server shutdown"`, marked resumable, and any held locks are released.

**Async Tool Clash Rule**: If a project defines a subagent specialist whose tool name matches one of the async tools (`lykos_start`, `lykos_status`, `lykos_steer`, `lykos_stop` — e.g. a specialist named `start`, `status`, `steer`, or `stop`), the built-in async tool wins the name and the colliding specialist is skipped with a warning emitted to stderr.

**Specialist Tool Sanitization and Collision Rule**: Specialist names are sanitized to valid MCP tool names (`specialistToolName`). When multiple specialists produce identical tool names after sanitization, one deterministic winner is selected: an exact raw match for the sanitized tool suffix wins first; otherwise alphabetical precedence by specialist name (`localeCompare`) decides, keeping collision losers silent.

### Concurrency and Locks

- **`mcp.max_sessions`**: The maximum number of concurrent live sessions (both running and waiting background sessions from `lykos_start`, and blocking calls). Defaults to `4`. Can be configured in project or global `config.yaml` under `mcp.max_sessions`. Any attempt to start a session when live sessions equal or exceed this cap is blocked, naming the currently running session IDs.
- **`mcp.ask_timeout`**: Timeout in seconds for questions asked via `ask_coordinator` (T224). Defaults to `600`. When a background session remains in `waiting` past `ask_timeout`, the server sends the decide-alone notice (`lykos: coordinator ask timed out; decide alone: proceed with what you have or give_up`), transitions the session back to `running`, and records the question in `unanswered_questions`. In a blocking MCP call, any question asked by the session is immediately answered with the decide-alone notice and recorded in `unanswered_questions`.
- **`mcp.warm_pool`**: The number of pre-spawned `lykos session-child` worker processes kept idle to eliminate cold start latency (T226, ADR-0053). Defaults to `2`. Configurable in project or global `config.yaml` under `mcp.warm_pool`. A value of `0` disables pooling and spawns each child on demand. Pre-spawned children are keyed by `(workspace, trustSource)`. When `lykos mcp` starts, it pre-warms the pool if the workspace is already trusted; otherwise, the first call warms it. When an idle child is claimed by a call, the pool asynchronously refills. Dead idle children are purged without looping. When the MCP server shuts down, all idle children are terminated.
- **`write_in_place` tree lock**: Only one `write_in_place` session may run on a canonical workspace tree at any time. Any conflicting session is blocked with a message naming the session holding the lock. Read-only sessions bypass the lock. The lock is released immediately when the session ends or is stopped.

### Specialists and Roles

Specialists with `role: primary` (such as `plan` and `build`) are omitted from the MCP tool list. A specialist marked `read_only: true` (e.g. `explore` or `review`) runs on the read-only child path: its tools are restricted to `read`, `grep`, `find`, and `ls` regardless of additions, its workspace mount is read-only, and mutating operations are denied. Writing specialists write on a worktree and `lykos/` branch of their own.

Specialist tool descriptions are drawn from the winning specialist file (fallback: `"Run the <name> specialist as a Lykos session."`), explaining containment, branching/read-only behavior, and session continuation (`session_id`). Pure specialist tools are never marked deprecated.

Prompt assembly for specialist tools passes `brief` unframed, appending `\n\nConstraints:\n<constraints>` when constraints are provided.

### Deprecated framed aliases and alias clashes

The four earlier framed tools (`lykos_implement`, `lykos_refactor`, `lykos_debug`, `lykos_review`) remain available as deprecated aliases for this release:
- `lykos_implement`: Framed implementation alias, deprecated in favor of `lykos_implementer` or `lykos_general`.
- `lykos_refactor`: Framed refactoring alias, deprecated in favor of `lykos_general`.
- `lykos_debug`: Framed diagnosis alias, deprecated in favor of `lykos_general`.
- `lykos_review`: Serves as both the framed alias and the tool for the `review` specialist. It retains its read-only floor, uses the winning review file's description, and accepts `model` for this release.

**Alias clash rule:** When a specialist's tool name matches an alias (e.g. `lykos_review`), the specialist's tool wins with no deprecation note, keeping the alias input schema for this release.

### Inputs

Specialist tools (`lykos_<name>`) accept seven inputs: `brief`, `constraints`, `budget`, `containment`, `session_id`, `write_in_place`, and `base`. They take no `model`, `provider`, or `specialist` inputs. The deprecated framed aliases additionally accept `model`, `specialist`, and `scope`.

| Field | Type | Supported Tools | |
| --- | --- | --- | --- |
| `brief` | string | All | **Required.** The task. |
| `constraints` | string | All | Added to the prompt after the brief. |
| `budget` | number | All | Per-run USD cap for this call. |
| `containment` | `off` \| `auto` \| `required` | All | Where the session's commands run. Absent: `off`, unless the specialist or config names a level. A level below the user's or project's `containment.minimum` is refused before the session boots. |
| `session_id` | string | All | Continue that earlier session instead of starting one. Takes the `sessionId` of a previous result. |
| `write_in_place` | boolean | All | Opt in to writing in the caller's own tree instead of on a branch of its own. Ignored by read-only specialists. See [Where a writing call's work lands](#where-a-writing-calls-work-lands). |
| `base` | string | All | The branch a new worktree starts from. Ignored when `session_id` is given. Defaults to HEAD. |
| `scope` | string[] | Deprecated aliases only | Optional list of glob patterns for repo-relative paths the change is expected to touch. A changed file outside scope raises an `OUT-OF-SCOPE` flag. |
| `model` | string | Deprecated aliases only | `provider/model` override. Ignored on pure specialist tools. |
| `specialist` | string | Deprecated aliases only | Specialist role to run. Ignored on pure specialist tools. `lykos_implement` with no specialist defaults to `implementer` when starting from a branch with an active seal, and `build` otherwise. An explicit specialist always wins. |

Only `brief` is required.

### Results

The tool result's text is one JSON object. `isError` is set only when `outcome` is `blocked` or `error` (not for `ok`, `disputed`, or `unverified`).

```json
{ "outcome": "ok", "answer": "...", "sessionId": "01a1...", "containment": "auto", "runtime": "docker",
  "commits": [{ "sha": "…", "subject": "…" }] }
```

| Field | |
| --- | --- |
| `outcome` | `ok`, `disputed` (run failed only on tests disputed/parked during the session), `unverified` (session finished with no verification command), `needs_answer` (session called `give_up` because a decision is required to proceed), `blocked` (refused before running: untrusted workspace, spend cap) or `error` (failed verification, runner error, or tampered seal). |
| `answer` | `ok`, `disputed`, or `unverified`: the session's final text, read from the session file's last assistant message. |
| `answer_is_self_report` | `true` whenever `answer` is present: text from an assistant turn is an agent's self-report and never counts as success on its own. |
| `question` | `needs_answer`: the specific question that caused the session to give up and must be answered to proceed. |
| `unanswered_questions` | `[string]`. Questions asked via `ask_coordinator` that timed out past `mcp.ask_timeout` (or were asked during a blocking call) and were answered with the decide-alone notice. Present when non-empty. |
| `reason` | `blocked`: why. |
| `message` | `error`: why, including a crashed child's exit and the tail of its stderr, or verification failure message. |
| `refusals` | `error`: refusal reasons when seal creation was refused on a test writer run. |
| `sessionId` | Present on every `ok`, `unverified` and `needs_answer`, and on an `error` whenever a session existed when it failed (a ledger row and a transcript), or the call was continuing one. A `blocked` call has none: it is refused before a session boots. Pass it as `session_id` to continue. |
| `verification` | Outcome of the verification command: `{ command, exit, outcome, output_tail }`. `command` is the command string or `null`; `exit` is the numeric exit code or `null`; `outcome` is `passed` (ledger outcome `success` and source `verification_command`), `failed` (verification command ran and failed), or `unverified`; `output_tail` is the trailing output (clamped to at most 2000 characters). Present whenever a session existed; omitted on calls refused before session boot. |
| `diff_stat` | Diff statistics against starting HEAD: `{ `files_changed`, `insertions`, `deletions` }`. Omitted when there is no branch and no in-place write. |
| `flags` | Session flags raised during the run: `[{ `flag`, `detail`, `files` }]`. Absent when no flags fire. A flag sets `next` to `inspect_flags`. Contains at most one entry per flag kind:<br>- `OUT-OF-SCOPE`: changed files outside the provided `scope` input (repo-relative, forward slashes, matched using `matchAnyGlob`); the server's seal commit is not counted. The flag's `files` lists every changed file outside scope; `detail` describes the count.<br>- `MISREPORT`: fires when the model's `answer` contradicts the evidence: (1) `verification` outcome is `failed` and `answer` claims tests pass (matching `/\b(all )?tests? (now )?(pass|passed|passing)\b/i`, `/\bgreen\b/i`, or `/\bverification (passed|passes|succeeded)\b/i`); (2) `answer` contains a hex commit sha (matching `/\b[0-9a-f]{7,40}\b/i` with at least one digit) that is not a prefix of any sha in `commits` and does not resolve to a commit in the workspace repository (`git cat-file -e <sha>^{commit}`). The flag's `detail` names the sha. |
| `next` | Recommended next action for the coordinator: a token from the closed set (first match wins in precedence order): <br>- `fix_environment`: when `outcome` is `blocked` or an unended runner error occurred.<br>- `inspect_seal`: when `seal` status is `tampered` or `tamper_attempted`.<br>- `resolve_test_dispute`: when `outcome` is `disputed`.<br>- `answer_question`: when the run is paused awaiting an answer.<br>- `inspect_flags`: when session flags were raised.<br>- `review_or_accept`: when a seal was `created` by the session (red verification is expected there).<br>- `continue_with_failure`: when `verification` outcome is `failed`.<br>- `run_verification`: when `outcome` is `unverified` or verification is missing.<br>- `review_or_accept`: when verification `passed` and the seal is `intact`. |
| `containment` | The level the session **used** (`off`, `auto`, `required`). `auto` that found no runtime reports `off`. Present on `ok`, `disputed` and `error` outcomes where containment was realized. |
| `runtime` | `docker` or `podman`, when commands ran in a container. Present on `ok`, `disputed` and `error` outcomes where a container was used. |
| `branch` | The `lykos/` branch the work is on. Present on every `ok` that wrote on a worktree, and, with `commits`, on a `blocked` or `error` whose branch holds commits. Absent when the session wrote in place or did not write. |
| `commits` | `[{ sha, subject }]`. On a branch: every commit on it the caller's HEAD did not have when the call began, newest first, including the ones earlier calls on the session made. Writing in place: the commits the session made through `commit`, oldest first. Omitted when there are none. |
| `write_in_place` | `true` when the session wrote in the caller's own tree. |
| `note` | What the caller should know about where the work is: what writing in place gave up (no branch, or no repository and so no commits), or changes the session left uncommitted that were committed onto the branch so they were not lost. |
| `skipped_extensions` | Everything withheld from a project that is not trusted in the user store, as a list of strings. Each is one of these forms: `name@version` for a project extension (the bare name when it has no version); `provider <name>: !command credential` or `provider <name>: !command header <key>` for a `!command` the project declared on a provider (the user's own `!command` is not listed and stays); `pi package <source> (install withheld; ...)` for a package in the project's `.pi/settings.json`; and, from #49, a project config command or level: `project hooks[0] (post_tool): command withheld`, `project feedback.command withheld` (likewise `gate.command`, `gate.rerun_command`, `eval.python`), `project lsp.servers.<name>: command withheld`, `project post-edit check "<command>" (discovered from the project) withheld`, `project gate check "<command>" (discovered from the project) withheld (commands run on the host)`, `project containment.level: <asked> withheld (kept <level>)`. Present on `ok`, `blocked` and `error` results when something was skipped. |
| `denied` | `[{ kind, detail, rule }]`. Any action that would prompt an interactive user for approval is denied in a delegated session (nobody is there to ask) and recorded here with the rule or mode tier that refused it. Present on `ok` and `error` outcomes where a gate ran; omitted when empty. |
| `seal` | Seal verification or creation report: `{ status, paths, contained, attempts, disputes }`. `status` is `created` (after a `seal.writers` specialist committed tests), `intact`, `tampered` (paths lists modified sealed paths), `tamper_attempted` (when denied actions touched sealed paths), or `none` (when seal files exist in the repo but not on this branch). `attempts` lists `[{ tool, detail, paths }]` of denied modifications touching sealed paths. `disputes` lists parked/disputed tests. Present whenever seal files exist in the repository; omitted when the repo has no seal files. |
| `disputes` | `[{ test: { file, describe, name }, reason, evidence, status }]`. Tests parked via `dispute_test` during the run. `status` describes the dispute's resolution: `"open"` (parked and awaiting resolution), `"escalated"` (escalated to parent session or orchestrator), `"upheld"` (resolved and sealed test updated), or `"rejected"` (reviewed and test confirmed correct). Present whenever seal files exist in the repository; omitted when the repo has no seal files. |

The optional fields are omitted, not null, when they do not apply. A caller written before they existed
sees `outcome`, `answer` and `sessionId` as it always did.

### Delegated Session Tools (T224)

When Lykos runs as a delegated session under MCP (`session-child`), two resident tools are available to communicate with the coordinator:

- **`ask_coordinator`**: `{ question: string }`. Asks the coordinator one specific question when a choice would change what is built. Pauses the session and puts it into the `waiting` state until answered via `lykos_steer`. Blank or whitespace-only questions are refused with an error. If `mcp.ask_timeout` expires before an answer arrives (or immediately if running in a blocking MCP call), the session is instructed to decide alone with available information, and the question is recorded in `unanswered_questions`.
- **`give_up`**: `{ question: string }`. Ends the session immediately without further model calls, producing outcome `needs_answer` and next token `answer_question`. Blank or whitespace-only questions are refused with an error. Continuing the session with `session_id` and the coordinator's answer in the `brief` resumes work.

Both tools are non-mutating and remain available in read-only sessions and when custom tool lists are configured.

### Where a writing call's work lands

The permission mode and posture decide: `lykos_implement`, `lykos_refactor` and `lykos_debug`
run in `auto`, which writes and approves its own writes because nobody is there to ask; `lykos_review`
runs as a read-only session (`readOnly: true`, specialist `review`), which does not write. `lykos run` takes permission
modes through `--mode` (`manual`, `accept-edits`, `auto`; ADR-0041) and defaults to `auto`.

- **A writing mode** works on its own worktree and a `lykos/<session id>` branch, never in the caller's
  tree. The worktree is at `~/.lykos/worktrees/<project id>/<session id>`, made under a lock through the
  protected git helper, and is removed when the call ends. The branch is never deleted. Changes the
  session left uncommitted are committed onto the branch before the worktree goes. Files the session wrote that git ignores (logs and reports included) are copied to `~/.lykos/worktrees/<project id>/<session id>.ignored` first, and the result `note` names that directory. Dependency and build caches (`node_modules`, `__pycache__`, `.venv`, `.tox`, `*.egg-info`, and `dist`/`build`/`target`/`out`/`coverage` at the root or a package root) are not saved, and the note names which were left out. If git cannot list the ignored files, the worktree is kept and the note says so. The container mounts
  the worktree at `/work` with the main repository's git directory read-only beside it, so `git status`,
  `diff` and `log` work inside. The worktree starts from the caller's HEAD (or `base` when specified): uncommitted changes in the
  caller's tree are not in it.
- **The project's own Pi settings, skills and prompts** that git does not track (`.pi/`, `.lykos/skills`, `.lykos/prompts`) are copied into the worktree, so the session sees what it would in place. Config, the ledger and trust stay at the project's root.
- **A continuation** (`session_id`) recreates the worktree from the branch and adds commits to it. A session id returned by a context-limit successor reaches the same branch. Two
  calls on one session cannot hold the worktree at once: the second is refused with an `error`.
- **`write_in_place`** writes in the caller's tree. There is no branch; the result has
  `write_in_place: true` and a `note`.
- **Without a repository** (no git, or a folder that is not one) a writing call is refused before a
  session starts, naming `write_in_place`. With it the session writes in place with no commits and no
  `commit` tool, and the `note` says so. A repository with no commit yet is refused too: there is
  nothing to branch from.
- **A read-only session** (`readOnly: true`, e.g. `lykos_review`) gets a read-only mount and needs no worktree or git.

### Continuing a session

`session_id` continues the way `lykos resume` does: the same session id and task, the earlier turns
replayed, and the new brief run as the next message. A session id that does not exist, or one `lykos
resume` would refuse, returns `error` with the reason resume gave and starts nothing.

Resume's paid-context confirmation is skipped: over MCP there is no one to ask, so passing `session_id` is
the caller's confirmation (ADR-0038).

## Progress

A client that sends a progress token with the call gets MCP `notifications/progress`: `progress` counts up
from 1, and `message` says what happened: `session starting`, then `session running, Ns elapsed` at the
heartbeat interval (15 seconds by default, `LYKOS_SESSION_PROGRESS_MS` to change it). A continuation first
says `continuing session: the replayed context's size and price are unmeasured ...`. Resume's own figure is
a characters/4 estimate, so none is reported; the real cost is in the ledger once the first call is recorded. Progress keeps a
long call from reaching a client's 30-minute stdio abort. A client that sends no token gets none.

## Cancelling and Server Lifetime

When the client cancels a call, the call's process is stopped (aborted through its signal).

When the server closes or shuts down:
- The runner process for each live session is aborted (via `AbortController.abort()`).
- Each live session's state is marked `stopped`.
- Any session with an open row in the ledger is recorded as stopped and resumable (`resumable = 1`, `notes = "stopped: server shutdown"`), leaving already-ended rows untouched.
- Any held tree locks (`write_in_place`) are freed.

## Trust

The server checks the workspace is trusted before starting a process, and a workspace that is not is
`blocked`. It passes how it established trust to the child as `LYKOS_TRUST_SOURCE`. That is a claim: the
child reads the user trust store itself, so the claim can let a project the store does not hold through
the gate as `flag` and cannot make it `stored`. Only `stored` (or `prompt`, an answer given in the trust
prompt) trusts a project's own code: its `lsp` binaries and its own extensions. `flag` passes the gate and
nothing more, so for a project the store does not hold the session skips the extensions declared in the
project's `.lykos/config.yaml` and hides its `.pi/settings.json` from Pi (so a `packages` entry there is
never installed), and the result lists them in `skipped_extensions`. Default extensions and the user's own
extensions load either way. A project `!command` credential or header in the provider config is dropped the same way, since Pi runs
it on the host. The project config's own command fields go the same way (#49): `hooks[].command`,
`feedback.command` (and the post-edit check Lykos would find in `package.json`), `gate.command`,
`gate.rerun_command`, the gate's `npm test` found in `package.json` (only when the session runs on the host; in a container it stays), every `lsp.servers.*` entry the project declared, and `eval.python` are ignored
in favour of what the user's and shipped layers give, and a project `containment.level` below what the
user's layers resolve to (`off` when none names one) is ignored. The caller's `containment` argument
and the user's own config are not the project's and still apply. A child spawned by an untrusted delegated session is held to the same rules. An untrusted delegated session also loses what Pi gates on project trust: the project's
`.pi/skills`, `.pi/prompts`, `.pi/themes`, `.agents/skills`, and its `SYSTEM.md` and `APPEND_SYSTEM.md`.
Pi packages listed in the project's `.pi/settings.json` are named as `pi package ... (install withheld)`:
a delegated session never loads Pi packages (it boots Pi with `noExtensions`), so trusting the project
lets Pi install them but does not load them. The trust check uses the project's root, not the worktree a
writing session works in (#36).

## The wire between the server and the child

For anyone writing a runner or reading a transcript. UTF-8 JSON Lines: one object per line, `\n`
terminated.

The server starts `node <entry script> session-child` with the workspace as its working directory
(`dist/cli.js` built, `cli.ts` under tsx in a checkout; never a `.cmd` shim, which cmd.exe would cut at a
newline), then:

1. **Server to child, on stdin: one `request` line,** then stdin stays open. Subsequent lines sent to stdin deliver steering messages as JSON lines:

   ```json
   {"type":"steer","message":"focus on the failing test case"}
   ```

   ```json
   {"version":1,"tool":"lykos_implement","workspace":"/p","prompt":"…","label":"lykos_implement",
    "model":"p/m","budgetUsd":0.5,"containment":"required","newSessionId":"…","sessionId":"…","writeInPlace":true}
   ```

   `version`, `tool`, `workspace`, `prompt` and `label` are required; for a new session, the server mints a unique identifier and sends it as `newSessionId`. Continuations send `sessionId` and omit `newSessionId`. The rest are omitted when unset.
2. **Child to server, on stdout: `progress` lines, then one `result` line.**

   ```json
   {"type":"progress","message":"session running, 15s elapsed"}
   {"type":"result","result":{"outcome":"ok","answer":"…","sessionId":"…"}}
   ```

   `result` carries the object a tool result carries. The child exits after it.
3. **stderr** is free text. The server relays it to its own stderr and keeps the tail for a crash report.

Rules:

- **stdout carries the protocol and nothing else.** `lykos/tui/io-mode.ts` owns it (`protocol` mode): it
  hands the child the writer for frames and sends any other write (a `console.log`, a dependency banner) to
  stderr. A stdout line that is not a frame is
  ignored by the server and kept for the crash report.
- **The server never forwards the child's stdout.** In MCP mode its own stdout belongs to the transport.
- **No result is an error.** A child that exits, is killed, or never writes a `result` produces an
  `error` outcome naming the exit code or signal and the tail of its stderr.
- **A child whose stdin closes after the request is read stops.** It does not run on as an orphan.
- **After the `result` line the server closes the child's stdin,** and kills a child still alive five
  seconds later.

## What a call does not do yet

- A child does not yet inherit a parent session's containment level (#35).
