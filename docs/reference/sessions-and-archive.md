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
  fork or create a duplicate session row.
- **Call:** An individual model inference round-trip recording input/output/cache tokens, duration,
  TTFT, and cost.

---

## 2. Transcript & Session Storage

Session payloads live outside SQLite as filesystem artifacts under `.lykos/sessions/<session-id>/`:

```text
.lykos/sessions/<session-id>/
  meta.json          Session contract (v2): model, agent, task, git commit, dirty flag
  transcript.jsonl   Append-only event stream (user, assistant, turn_start, tool_call, tool_result, usage)
  live.json          Ephemeral status snapshot updated during active turns
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

### 2.3 Archival and Compression (`lykos archive`)
Historical transcripts are compressed to `.gz` in place after passing the configured retention
period. Compression preserves the uncompressed SHA-256 byte hash in the ledger to guarantee
tamper-evident auditability. A compressed session is decompressed transparently on read.

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
