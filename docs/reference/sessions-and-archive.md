# Lykos — Sessions, Archive, & Execution Shape

**Companion to:** `docs/reference/telemetry.md`
**Status:** Living reference specification for session lifecycle, transcript storage, resumption, and the execution engine.

---

## 0. Permanent Archival Principle

> **Nothing Lykos runs is ever deleted. Every session is archived, and every conversation is resumable.**

Deleting a conversation through the CLI or UI (`lykos session` delete) removes only the local
human-readable transcript payload; the accounting row, token counts, and spend records remain in
`.lykos/ledger.db`.

---

## 1. Identity Hierarchy

Work and cost are tracked across four explicit levels:

```text
project          a git repository or directory root (survives rename/move)
  task           a person's goal (e.g. "implement feature X") spanning sessions
    session      one continuous execution of the agent loop
      call       one model request/response round-trip
```

- **Project:** Identified by git remote URL or root path + first commit SHA. Recorded in `~/.lykos/projects.json`.
- **Task:** The unit of human intent. Multiple sessions join under one `task_id` so that
  **cost per successful task** reflects the total investment across attempts.
- **Session:** One continuous run. When resumed, **it continues the named session**; it does not
  fork or create a duplicate session row. A fork (§2.1.1) is the one way to make a new row from a
  session: on purpose, and on the same task.
- **Call:** An individual model inference round-trip recording input/output/cache tokens, duration,
  TTFT, and cost.

---

## 2. Transcript & Session Storage

Session payloads live outside SQLite as filesystem artifacts under `.lykos/sessions/<session-id>/`:

```text
.lykos/sessions/<session-id>/
  meta.json          Session contract (v2): model, agent, task, git commit, dirty flag
  transcript.jsonl   Append-only event stream (user, assistant, turn_start, tool_call, tool_result, usage)
  live.json          Ephemeral status snapshot: heartbeat, spend (null until a call is recorded), `turns` ended
  tasks.json         The task list as its last change left it, each item with its state
  post-edit.jsonl    One line per post-edit run: command, verdict, exit code, and the text the model saw
  artifacts/         Spilled tool outputs, diffs, and verification artifacts
```

`lykos show <session>` reads its strength lines from these two files and the session's ledger
row, and recomputes nothing: each post-edit run with its command, pass or fail, exit code and, on
failure, the exact note appended to the model's tool result; and the task list as it stood at the
session's end. A loop that was off or never fired, and a list that was never used, read `did not
run`. A session that predates the per-run record shows only the ledger's run and failure counts.

### 2.1 Resumption Semantics
Invoking `lykos resume <session-id>` continues the designated session directly:
1. `meta.json` is validated to ensure workspace and git commit coherence.
2. The transcript is replayed into `createAgentSession` context up to the last turn.
3. Subsequent turns append new events directly to `transcript.jsonl`.
4. Subsequent model calls record to the existing session in `.lykos/ledger.db`.

**On disk first (T238).** The session's ledger row is written at boot, before anything runs (the
*boot row*: model, flags, specialist, model path, execution shape); ingest at the end finalises it on
the same task. A session killed before its ingest is therefore a row: findable, resumable once its transcript has
its first record (one killed between the boot row and the brief has no transcript, and resume refuses
it as `transcript file missing`), its usage `unknown` (no `calls` rows, `total_cost_usd` NULL, `live.json` cost null), never $0.

A tool call's start record carries the runtime's `tool_call_id` and is written before the tool runs;
its `tool_result` names the same id. On resume, a start with no result is replayed as
`interrupted: outcome unknown`, and nothing reruns by itself. When the earlier run did not end
cleanly (killed, or a call with no result), a `recovery` event is written after the resume marker:
`git status --short`, `git diff --stat` and the ids of the interrupted calls. The replay ends with
the same text.

Reopening a transcript drops a partial trailing record (a process killed mid-write) and continues
the turn index and the artifact numbering. Because a resume continues the same transcript, a
resumed run killed before its own ingest leaves the file longer than its recorded hash: the resume
check verifies the recorded first `transcript_bytes` bytes and warns that what follows is
unverified. A change inside the hashed part is still refused.

### 2.1.1 Forking a Session (`/fork`, `lykos resume <id> --fork`)
A fork copies a session at its current point into a new session and continues there (T266). The
parent's row and transcript are left exactly as they were: it is not reopened, and nothing is
written to its transcript.

- `/fork` in an interactive session ends it the way `/exit` does (finalised, its numbers written),
  then forks it; `lykos resume <id> --fork` forks an ended session. Both run the resume preflight
  on the parent, show what the replay costs, and ask unless `--yes`.
- The fork is a new row: its own id, `forked_from` the parent's id and `forked_from_turn` the
  parent's last turn the copy carries, the parent's `task_id` (so the task's cost sums both), the
  same working directory, the parent's task list and tool surface.
- **The copy is the active branch**: the parent's transcript without the turns a conversation
  rewind undid (§2.2.1). Those records are copied into the fork's own transcript, each at its
  original time, ahead of a `resume` marker with `from` the parent and `fork: { turn }`; the
  parent's `usage` and `outcome` lines are not copied, as they belong to its calls and its row. The
  fork's transcript therefore reads like a resumed one, and resuming or forking the fork replays the
  conversation it was copied from. The same branch is replayed after the head as one custom
  message, as a resume does (§2.1).
- `lykos sessions` nests the fork under its parent and says `forked from <id> at turn <n>`;
  `lykos show` prints `forked from <id> at turn <n>` (`--json`: `forked_from`, `forked_from_turn`).

A turn number is the parent's transcript's own (§2.2), counted afresh by each process, so after a
resume the same number can name an earlier process's turn too.

### 2.2 Turns, Edits and Checkpoints
A stream transcript marks the start of every model turn with a `turn_start` event whose `turn` is
counted from 0 across the whole session (Pi's own turn index restarts at each prompt). A
`tool_result` for a successful file-changing call — by the tool registry's one declaration — carries
`changes_files: true` and, when the call named one, the `path` it changed.

Checkpoints are commits on `refs/lykos/checkpoints`, taken at the start of each turn whose tree
differs from the last checkpoint. Each records its session and turn in its own commit message as
the trailers `Lykos-Session:` and `Lykos-Turn:`, using the same turn count as the transcript. A turn
that starts on an unchanged tree writes no commit then; if it goes on to change a file, it gets one
before that first file-changing call, holding the tree it started from. A checkpoint without the
trailers — `lykos rewind --now`, a rewind's own safety checkpoint, and every checkpoint written
before P4 — lists and restores exactly as before, with its session shown as not recorded.

`lykos show <session>` lists the turns that changed files, the files, and the checkpoint taken
before each (read from the repository named in `meta.json`), and flags a turn with none as
`MISSING`. A transcript with no `turn_start` markers predates them and says so. `lykos rewind`
prints each checkpoint's session and turn beside its label.

Checkpoints are named by hash wherever a command is printed to be copied — `lykos show`, the
listing, a restore's undo line, and the command the `rewind` tool proposes — because an index
shifts every time a new checkpoint is written. `lykos rewind <hash>` accepts any prefix of at
least 4 hex characters that names exactly one checkpoint on the ref; an unknown or ambiguous prefix
is refused and restores nothing, not even the safety checkpoint. An index still works. A run of 4
or more digits is read as a hash when one matches, and refused when it is also a different
checkpoint's index.

### 2.2.1 Rewinding a Live Session (`/rewind`, Esc Esc)
In an interactive session, `/rewind` (or Esc Esc on an empty input, on the full-screen surface)
lists the session's earlier prompts. The chosen one offers: code and conversation, conversation
only, code only, summarize from here, or cancel. Only the person can rewind; there is no tool for it.

- **Conversation** moves Pi's session tree back to before that prompt (`navigateTree`), and the
  prompt goes back in the input box (the append-only surface, which has no input box, prints it).
  The next prompt is answered from that point: the model is not sent the undone turns.
- **Code** restores the whole tree, shell edits included, from the checkpoint holding the tree the
  prompt's first turn started from: the one taken then, or the ref's tip when nothing had changed.
  The current tree is checkpointed first (`before rewind to <hash>`, listed by `lykos rewind`), and
  a file the checkpoint did not have is reported and left in place, as `lykos rewind` does.
- **Summarize from here** (T265) asks for an optional note, then replaces that prompt and every
  turn after it, in context, with one summary: the next request carries the turns before the
  prompt verbatim, then the summary. The summary is Pi's branch summary (`navigateTree` with
  `summarize`, from the entry just before the prompt so the prompt itself is summarized), and the
  note is its `customInstructions` (Pi adds it as "Additional focus"). Lykos's own compaction is not
  used: it keeps the newest turns and summarizes the oldest, with no prompt to cut at. The
  summarizer's call is a `calls` row of phase `compact`, as a compaction's is, and in the session's
  cost; it writes no `compactions` row. The prompt goes back in the input box, as Claude Code does,
  and the files are not touched. A summarizer that fails changes nothing.
- **Nothing is deleted and there is no redo.** The transcript gets a `rewind` event (what was
  restored, the prompt, `to_turn`, `undone_turns`, `checkpoint`, `safety_checkpoint`; for a
  summarize, `restore: "summarize"`, `summarized_turns`, `note` and `summary`); the undone or
  summarized turns stay in the transcript before it and their calls stay in the ledger and in the
  session's cost. `lykos show` prints each rewind and the undone branch's, or the summarized turns',
  turns and prompts (`--json`: `rewinds`, with `undone` or `summarized`). The session keeps its id
  and its row.

Only prompts sent by the running process are offered; a resumed session's replayed turns are not
(T264). Resuming a session replays its whole transcript, undone turns included.

### 2.3 Archival and Compression (`lykos archive`)
Historical transcripts are compressed to `.gz` in place after passing the configured retention
period. Compression preserves the uncompressed SHA-256 byte hash in the ledger to guarantee
tamper-evident auditability. A compressed session is decompressed transparently on read.

### 2.4 Export as Markdown (`lykos export <session>`, `/export`)
`lykos export <session> [file]` and `/export [file]` render a session's conversation as Markdown,
read from its transcript, so an ended, killed or archived session exports the same as a live one.
The export holds the prompts, steers and follow-ups, the answers, every tool call with its
arguments and its result, errors, and a resume marker. Usage lines, turn markers, compaction,
prune and shake records and the model's reasoning are left out; `lykos show` reads those.
Prompts and answers go in as written. Tool arguments (as JSON) and results are fenced, each fence
one backtick longer than the longest backtick run inside it, so content holding its own fence
cannot close the export's. With no file, `lykos export` prints to stdout and `/export` copies to
the clipboard. The session is found by id or unique id prefix, as `lykos resume` finds it.

### 2.5 Attachments (`@path` in a `lykos run` prompt)
An `@path` written in a `lykos run` prompt (at its start or after whitespace; `@"a b.md"` for a
name with a space) attaches the file to the brief, as an `@path` argument does: a text file as
Pi's `<file name="<absolute path>">` block before the prompt, an image (PNG, JPEG, GIF, WebP,
resized to the inline limit by Pi's `resizeImage`) as an image part of the first message, named
by an empty block in the text. The mention stays in the prompt. Its path is resolved the way the
file tools resolve one, relative to the workspace, which is the path the interactive `@`
completion inserts, and judged by the workspace's path rules: a deny refuses it, and a path that
would ask (outside the workspace) is refused, since a one-shot run has nobody to ask. A missing
path is an error naming it; a prompt after `--` is verbatim and attaches nothing, which is how
`@types/node` is written in one. Trailing sentence punctuation (`@a.ts,`) is not part of the path. A session whose model
does not declare image input (`input` without `image`) refuses an image before it starts, naming
the model and the file. The brief, attachments included, is the session's first message in its
transcript; images travel to the session child in the request's `cli.images`.

---

## 3. Standalone Execution Shape

Lykos runs in-process on Node using Pi's `@earendil-works/pi-coding-agent` SDK directly via
`createAgentSession()`.

### 3.1 Zero Patches to Pi
The standalone engine runs without monkey-patching Pi or runtime internals:
- **Streaming & Events:** Subscribes to `AgentSessionEvent` for real-time tokens and tool events.
- **Token Accounting:** Extracts input, output, `cacheRead`, and `cacheWrite` counts directly from
  event usage blocks, re-priced strictly against Lykos's authoritative `prices.yaml`.
- **Prompt Injection:** Assembles system prompt blocks via `appendSystemPromptOverride` and
  `agentsFilesOverride`.
- **Tool Allowlist:** Passes exact tool names via `CreateAgentSessionOptions.tools`.

### 3.2 Pluggable Safety Seams
Pi provides pluggable operations (`WriteOperations`, `EditOperations`, `BashOperations`) designed
for remote execution. Lykos uses these operations as safety boundaries:
1. **Scope Clamp:** The operations wrapper checks that all file paths resolve under the project root
   directory (`isWithinRoot`). Out-of-root accesses are rejected immediately without prompting.
2. **Approval Gate:** In-root mutations and shell commands route to `ApprovalGate.request()`,
   evaluating permissions against the active interaction mode (Auto, Manual, Plan, Ask).

### 3.3 First-Class Subagents
Standalone subagents are spawned in-process by invoking `createAgentSession` recursively. Each child
receives its own dedicated `session_id`, transcript file, and ledger row, inheriting the child's
declared tool surface and ensuring complete transparency and resumption.
