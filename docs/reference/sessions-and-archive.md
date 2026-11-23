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
2. The transcript's active branch — without the turns a rewind undid, a summarize's summary in
   place of the turns it summarized (§2.2.1) — is replayed into `createAgentSession` context, after
   the ordinary frozen head, up to the last turn (T264; before it, a resume replayed every turn).
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

A turn number is the parent's transcript's own (§2.2): since T264 it names one turn across the
parent's processes, and the fork's own turns are numbered after the parent's highest. A fork from
before T264 keeps the number it recorded, which in a resumed parent can name more than one turn.

### 2.2 Turns, Edits and Checkpoints
A stream transcript marks the start of every model turn with a `turn_start` event whose `turn` is
counted from 0 across the whole session (Pi's own turn index restarts at each prompt), and since
T264 across its processes: a resumed process starts one past the highest turn in the transcript, so
a turn number names one turn of the session. A transcript from before T264 counts each process from
0 again and is not renumbered. Since T264 `turn_start` also carries the `checkpoint` holding the tree
the turn started from (the one taken then, or the ref's tip when nothing had changed), and a
`user_message` with a notice put before the prompt carries the prompt as typed in `typed`. A
`tool_result` for a successful file-changing call — by the tool registry's one declaration — carries
`changes_files: true` and, when the call named one, the `path` it changed.

Checkpoints are commits on `refs/lykos/checkpoints`, taken at the start of each turn whose tree
differs from the last checkpoint. Each records its session and turn in its own commit message as
the trailers `Lykos-Session:` and `Lykos-Turn:`, using the same turn count as the transcript. A turn
that starts on an unchanged tree writes no commit then; if it goes on to change a file, it gets one
before that first file-changing call, holding the tree it started from. A checkpoint without the
trailers — `lykos rewind --now`, a rewind's own safety checkpoint, and every checkpoint written
before P4 — lists and restores exactly as before, with its session shown as not recorded.

A checkpoint holds the working tree as `git add -A` sees it, without Lykos's runtime state: the
transcripts in `.lykos/sessions/`, the ledger, the history and the other paths `lykos init` puts in
`.gitignore`, whether or not the repository ignores them. A restore never writes those paths, even
from a checkpoint taken before this rule that holds them, and never reports them as extras. Without
it, a code rewind in a repository `lykos init` never ran in wrote the transcript back to the
rewound turn and lost the undone branch.

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
- **Nothing is deleted.** `/rewind` has no redo; `/redo` takes back `/undo`s only (below). The transcript gets a `rewind` event (what was
  restored, the prompt, `to_turn`, `undone_turns`, `checkpoint`, `safety_checkpoint`; for a
  summarize, `restore: "summarize"`, `summarized_turns`, `note` and `summary`); the undone or
  summarized turns stay in the transcript before it and their calls stay in the ledger and in the
  session's cost. `lykos show` prints each rewind and the undone branch's, or the summarized turns',
  turns and prompts (`--json`: `rewinds`, with `undone` or `summarized`). The session keeps its id
  and its row.

**Undo and redo (P5 #42).** `/undo` (OpenCode's `session.undo`, `<leader>u` in `lykos-tui`) is a
rewind to before the last prompt, code and conversation, or the conversation alone when the session
takes no checkpoints; its `rewind` event has `undo: true` and the prompt goes back in the input box.
Each `/undo` goes one prompt further back. `/redo` (`<leader>r`) takes back every undo since the
last prompt at once, as OpenCode clears its whole revert: the tree from the first undo's safety
checkpoint (the current tree checkpointed first, `before redo`), the conversation by moving Pi's
leaf back, since the undone entries are still in Pi's tree. It writes a `redo` event (`undos`,
`checkpoint`, `safety_checkpoint`, `redone_turns`), and the active branch is again what it was
before the first undo. A prompt sent after an undo ends the chain and `/redo` refuses, as OpenCode's
does; so does any other rewind. A chain from before a resume is read from the transcript: the redo
is written and the session rebuilt from it, as a rewind past a resume is. `lykos show` prints an
undo as `undo` and a redo as `redo`.

**Past a resume (T264).** A resumed session's picker lists the prompts from before the resume too,
read from its transcript's active branch, then its own. Choosing one of those rebuilds the session
from its transcript: the code is restored as above, from the checkpoint its `turn_start` recorded;
the `rewind` event is written (its `to_turn` cuts the active branch there); the session ends as
`/exit` ends it and is resumed through `lykos resume`'s own preflight, under the same id and row, with
the ordinary frozen head and the active branch replayed after it, and the prompt in the input box.
Code only rebuilds nothing. Summarize from here is refused for those prompts: Pi's summarizer reads
Pi's session tree, which holds only this process's turns. In a transcript from before T264, a turn
whose number a later process used again is not offered, nor is a code restore for a turn whose
`turn_start` recorded no checkpoint; nothing is backfilled.

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

**Server sessions (P5 #35).** A session the new TUI opens runs under the engine server, one
`lykos server-session` child each ([engine-server.md](engine-server.md) §3). It is the same
interactive session, with the same ledger row and archive; only its approvals, questions and
output travel over the server's protocol. A server that exits closes its idle sessions, and each
is resumable like any other.

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
