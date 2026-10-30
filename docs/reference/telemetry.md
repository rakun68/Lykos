# Lykos — Telemetry & Cost Indicator Spec

**Companion to:** `docs/reference/sessions-and-archive.md`
**Status:** Living reference specification. Ledger (`lykos/ledger/ledger.ts`), live telemetry (`lykos/ledger/live.ts`), and session summary + rollups (`lykos cost`) implemented.

---

## 0. Telemetry Principles

Lykos has no benchmark budget. There are no paid baseline runs or artificial benchmark suites.
Measurement is built directly into ordinary agent execution.

> **Record enough per call that the counterfactual is computable, and every real task becomes a free measurement.**

1. **The indicator is a product feature, not instrumentation.** It runs always, in normal use, at zero API cost.
2. **Savings are computed inline, not by comparison runs.** For most Lykos mechanisms, "what would this have cost otherwise?" is derivable from token counts and prices.
3. **What cannot be derived stays honestly unmeasured.** Levers with no arithmetic counterfactual are marked `unmeasured`, never guessed.

---

## 1. The Three Surfaces

Telemetry appears across three coordinated surfaces:

| Surface | Job | When |
|---|---|---|
| **Live HUD** | Shows real-time spend, cache hit rates, and token throughput | Continuously during execution |
| **Session Summary** | Summarizes turn metrics and costs upon run completion | End of every run |
| **Ledger** | Accumulates permanent, append-only history in SQLite | Persistent across all sessions |

### 1.1 Live HUD

A statusline updated per turn:

```text
◆ lykos  turn 14  │  ↑42.1k ↓3.8k  ⚡38.4k cached (91%)  │  6 tools  │  2m 41s  │  $0.0384
```

- **turn**: Model round-trips so far.
- **↑ / ↓**: Cumulative input / output tokens.
- **⚡ cached**: Cache-read tokens and the cache hit ratio.
- **tools**: Tool calls issued.
- **elapsed**: Wall time.
- **cost**: Running total in USD.

Extended delegate line when a subagent is active:

```text
◆ lykos  turn 14  │  ↑42.1k ↓3.8k  ⚡38.4k (91%)  │  $0.0384
└─ scout(deepseek)  ↑31.2k ↓0.4k  $0.0021  │  parent context saved: ~30.8k (~$0.09)
```

### 1.2 Session Summary

Printed at the end of every run:

```text
─────────────────────────────────────────────────────────────
  turn: 18         calls: 21       tools: 14       time: 4m 12s
  tokens:          ↑ 84.2k         ↓ 6.1k          ⚡ 76.8k (91.2% cached)
  spend:           $0.0521         (frontier direct would have been ~$0.48)
  avoided:         ~$0.43          [model routing: $0.34, cache: $0.09]
─────────────────────────────────────────────────────────────
```

---

## 2. The Ledger Schema

The ledger lives in `.lykos/ledger.db` as SQLite in WAL mode.

### 2.1 Core Tables
- `projects`: Registered repositories (`id`, `name`, `root_path`, `first_commit_sha`).
- `tasks`: Human-level task goals (`id`, `project_id`, `state`, `created_utc`, `closed_utc`). `state` is `open`, `done`, `abandoned`, or `disputed` (T203).
- `sessions`: One continuous execution loop (`id`, `task_id`, `project_id`, `parent_session_id`, `resumed_from`, `runtime`, `execution_shape`, `agent`, `model`, `auth_mode`, `closed_utc`, `outcome`, `outcome_source`, `verification_cmd`, `verification_output`, `verification_exit_code`, `containment_requested`, `containment_used`, `container_runtime`, `container_runtime_version`, `container_image`, `container_network`, `container_mount`, `total_cost_usd`, `unpriced_calls`). Containment (T173): the level the session asked for and the level it got (`off` when its commands ran on the host, whatever was asked), then the runtime, its version, the image, the network mode and the mount mode when a container was used; the `container_*` columns are NULL for a host session and every column is NULL for a session before T173. The gate's exit code is stored beside the outcome it decided and must agree with it (0 is `success`, anything else `fail`); it is NULL, never 0, when no verification command ran.
  - `total_cost_usd` and `unpriced_calls` (L3, issue #93 item 3): `unpriced_calls` counts calls with `cost_usd` NULL. `total_cost_usd` is the sum of priced calls, or NULL when every call was unpriced (never a silent $0); 0 means 0 calls spent nothing (a measurement). For a partly priced session, `total_cost_usd` records the priced sum with `unpriced_calls > 0` beside it. Rows written before L3 are not backfilled: they keep their existing `total_cost_usd` (an all-unpriced old row stays 0) and get `unpriced_calls NULL` (meaning "pre-L3, unknown", distinct from 0 which means all calls were priced).
  - The edit counters `edit_tool_calls`, `edit_error_count` and `edit_retry_count` (T24.3) count the `edit` tool only: its calls, its failed calls, and its calls on a path whose previous `edit` failed. Since T168 (ADR-0031) that tool is exact text replacement, so a failure is an `oldText` that was not found, not unique or overlapping, a `replaceAll` that found nothing, or a declined approval; before it, the tool was the anchored editor, and the counters were never reset, so rows of different periods are not comparable. They deliberately exclude `ast_edit` and `lsp` rename, which also change files but match a pattern or a symbol rather than text the model copied, so `lykos cost`'s "edit-retry rate" line is the `edit` retry rate, not a rate over every file-changing tool. T168 part B adds no ledger column: `lykos show` reads the per-call outcome and error text from the transcript's `tool_result` events and the post-edit record, classifies each failed `edit` call into `not_found`, `not_unique`, `overlap`, `unread`, `stale` or `other` (`tools/edit-failure.ts`), and prints the failures by reason and the post-edit failures per successful edit (failed post-edit runs over successful file-changing calls); `--json` carries them as `strength.edits`. A transcript that cannot say prints `unmeasured`, and nothing is backfilled.
  - Retrospective hit quality (T64) is `edited_files` (JSON: each edited file's `path`, the `rank` of the exploration call that first read it, and `blind` when it was never read first), `edited_file_count`, `blind_edits`, `first_touch_rank`, `hit_quality` and `hit_quality_version`. An edit is whatever the tool registry declares file-changing (version 2, P4 T143). **Version 3 (T159):** for `ast_edit` and an `lsp` rename, the edited files are the ones the tool's result says it changed (`details.changedFiles`), not its arguments — before, a rewrite over `src/*.ts` recorded `src/*.ts`, and a rename recorded only the file it was called on. A call that changed nothing records nothing. A trace whose result does not carry the list (an older session, or a result spilled to an artifact stub) falls back to the arguments. Rows of different versions are not comparable; existing ledger rows keep the version they were written with.
  - Git unavailable (T170, spec #22 stories 80, 81): a top-level standalone session that boots where git cannot be used appends `git: not-a-repo` (the folder is not inside a repository) or `git: git-missing` (no `git` binary on `PATH`) to `sessions.notes`, joined to the other notes with `; `. A session with a repository writes nothing, so a missing note means git worked. Both states run with checkpoints and the repo map off and without the `commit` tool (T179; it is not offered to the model), so `checkpoints_written` stays NULL; the note is what tells the two causes apart, and the same words ("not a git repository", "git is not installed") are the one notice the session prints. Nothing is backfilled: an earlier session carries neither note.
- `calls`: Granular model invocations (`id`, `session_id`, `turn_index`, `provider`, `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, `price_basis`, `ttft_ms`, `duration_ms`).
- `denials`: Log of approval gate and scope clamp rejections.
- `compactions` (P4 T152): one row per compaction **attempt** while the `self-compact` context strategy is active — `id` (the extension's record id, so a second ingest adds nothing), `session_id`, `ts_utc`, `strategy` (the active context strategy), `trigger` (`agent` or `command` for a self-compact handoff; `manual`, `pi-threshold` or `pi-overflow` for Pi's own compaction underneath), `handoff_id`, `attempt`, `model` (`provider/model`), `tier` (e.g. `128k`), `context_window`, `tokens_before` (the context measured when the attempt started), `tokens_after` (Pi's estimate after a success, else NULL), `result` (`ok` / `failed` / `cancelled`) and `error`. Written when the session ends, from the records `lykos-self-compact` appended; the summariser call's cost is its `calls` row (`phase = compact`). A new table: earlier sessions have no rows and none are backfilled. Under the `continue` and `pi` strategies nothing writes it. T190 adds `method` (`note`, `handoff`, `shake` or `summary`, Pi's own summary), `fell_through` (JSON: each method tried before it, `{method, reason}`) and the compaction's own model call as the provider reported it — `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` and `cache_write_1h_tokens` (the one-hour part of the write, priced differently), mirroring the `calls` row, cache read and cache write apart; 0 for `shake`, which makes no call, NULL when Pi's summariser reported none. `tokens_after` is an estimate (Pi's chars/4 of the rebuilt context; for `shake`, `tokens_before` less the estimate of what it dropped). Rows from before T190 have all of these NULL.
- `prunes` (T188, spec #15, ADR-0039): one row per prune pass `lykos-prune` made — `id` (the record's own, so a second ingest adds nothing), `session_id`, `ts_utc`, `superseded` (results overwritten as superseded reads), `useless` (results overwritten as flagged useless), `tokens_saved` (**estimated** at Pi's chars/4 as the results' size less the notice's; never a measurement) and `reason` (`tail`: at most 8 000 tokens followed every result rewritten, so the cache re-write was small; `idle`: the last model response was older than the cache retention). Written the moment the prune is made (as `commits` are), so a killed session keeps its rows; `session_id` is therefore not a foreign key. The transcript carries the same decision as a `prune` event naming the tool calls. A new table: earlier sessions have no rows and none are backfilled. Cache read and cache write per call are on the `calls` rows as ever (findings §1.3), so a prune's effect on the cache is read there, not stored twice.
- `flaky_tests` (T167, ADR-0030): one row per test that failed in the session gate's run and passed when only its file was rerun — `session_id`, `ts_utc`, `test_file` (relative, `/`), `test_name` (as the reporter printed it; a file that failed as a whole is named by its path), `edited_by_session` (1 when the session edited that file, which keeps the verdict `fail`), `first_exit_code`, `rerun_exit_code` (0 by construction) and `rerun_command`. Written in the same transaction as the session's outcome, by `recordOutcome`, and only when the rerun exited 0; a rerun that failed again names none. `sessions.verification_exit_code` stays the gate command's own exit code, so a `success` can sit beside a non-zero one **only** when a cleared rerun carries it (the ledger refuses it otherwise); `verification_output` holds the first run's output, then the rerun's. `lykos show` prints a session's rows in its gate section and `lykos doctor` counts them. Nothing is backfilled: a session before T167 has none.
- `commits` (T179, spec #22 story 24): one row per commit a session made through the `commit` tool — `session_id`, `sha` (the full id from `git rev-parse`, or, when that could not be read, the abbreviated id `git commit` itself printed, stored as is; a commit whose id could not be read at all has no row and the tool result says so), `ts_utc`, `subject` (the first line of the message), `message`, `files_changed` (NULL when the count could not be taken, which `lykos show` prints as `files unmeasured`; never a guess) and `scope` (`paths` when the call named files, `all` when it committed every change); primary key (`session_id`, `sha`). The row is written **the moment the commit is made**, not at the session's end. A `sessions` row is written by ingest at the end, so a session that is killed has none, and `commits.session_id` is therefore not a foreign key: a killed session's commits are still here, found by selecting from `commits`, although `lykos show` cannot open a session that has no `sessions` row. A write at the session's end repeats the session's log and adds nothing. The message passes through the same secret redaction as `sessions.brief`. "Every change" means the workspace (not the repository above it) and never `.lykos/` or `.pi/`, whatever `.gitignore` says. It is the one place commits are recorded: a commit made some other way (`bash`, outside the container) is not a row. `lykos show` lists a session's rows. A new table: earlier sessions have none and none is backfilled from the repository's history.
- `extension_counters` (P4 T149): a Lykos extension's own counters per session (`session_id`, `extension`, `name`, `value`), keyed by the name the extension was **declared** by in `config.yaml`. Written once when the session ends, from `recordCounter` calls; a counter never recorded has no row (absent, never zero), and nothing is backfilled. `lykos-reviewer` writes `invocations`, `findings`, `failures` and `skipped_no_edits` / `skipped_no_diff` / `skipped_unfinished`; its model is its read-only child session's own row (`parent_session_id` the reviewed session, `agent_role` `extension:lykos-reviewer`) and its findings are that child's final text in its transcript. `lykos show <session>` prints all three in its strength section. The older `sessions.reviewer_*` columns hold the T110 reviewer's runs and are no longer written; the phase-17 report counts both.
- `seal_events` (T195, T203): sealed TDD lifecycle events (`id`, `session_id`, `ts`, `branch`, `kind`, `paths`, `creator`, `specialist`, `detail`). `kind` indicates the seal action: `created` (seal created on branch), `verified` (seal verified intact), `tampered` (sealed test modified), `vetoed` (mutation on sealed path blocked by gate), `bash-warned` (bash touched sealed path), `rejected` (seal verification rejected or key invalid), `failed` (verification command failed), `not collected` (test results could not be collected), `disputed` (disputed test outcome recorded), `weakened` (sealed test assertions weakened), `tamper_attempted` (denied tool attempt on sealed path), `dispute filed` (agent filed dispute against test), `dispute escalated` (dispute escalated for review), `dispute upheld` (dispute upheld by coordinator), or `dispute rejected` (dispute rejected by coordinator). `paths` stores a JSON list of sealed paths. `detail` carries JSON metadata (`tests`, `key_id`, `writer_commit`, veto/warning details, dispute reason and evidence, or denied tool attempt details). `session_id` links to the executing session or is NULL when executed directly via CLI.

---

## 3. Counterfactual Formulas

### 3.1 Cache Avoided Cost
Cache savings are calculated per call using the exact model rates resolved for that call:
$$\text{Avoided}_{\text{cache}} = \left(\text{tokens}_{\text{cache\_read}} \times (R_{\text{input}} - R_{\text{cache\_read}})\right) - \left(\text{tokens}_{\text{cache\_write}} \times \text{Premium}_{\text{write}}\right)$$
Anthropic assesses a write premium ($1.25\times$ to $2\times$ input), making unread writes a negative avoided cost. DeepSeek has zero write premium.

### 3.2 Model Delegation Avoided Cost
When a specialist subagent executes bounded work:
$$\text{Avoided}_{\text{delegation}} = (\text{tokens}_{\text{child\_consumed}} \times R_{\text{parent}}) - \text{Cost}_{\text{child\_actual}}$$
