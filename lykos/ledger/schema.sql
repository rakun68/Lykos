-- Lykos ledger schema
--
-- Append-only. Corrections are new rows, never UPDATEs to existing ones.
-- With no benchmark budget this database is the project's only evidence,
-- so it records failures and abandonments as faithfully as successes.
--
-- Apply with:  sqlite3 .lykos/ledger.db < lykos/ledger/schema.sql

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- sessions — one row per run of a task
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id                    TEXT PRIMARY KEY,
  -- Soft FK on a ledger created before T8: SQLite cannot ALTER a FK
  -- constraint onto a column that already exists, so task_id is enforced
  -- only on ledgers whose sessions table was created fresh with this clause.
  task_id               TEXT REFERENCES tasks(id),
  started_utc           TEXT NOT NULL,          -- ISO 8601, UTC always
  ended_utc             TEXT,
  -- T128/T129: NULL means the close/delete mechanism predates this session.
  closed_utc            TEXT,
  deleted_utc           TEXT,
  browser_fanout_ms     INTEGER,
  browser_projects_scanned INTEGER,
  browser_rows_returned INTEGER,
  harness_commit        TEXT NOT NULL,          -- which LYKOS build produced
                                                -- these numbers, NOT the
                                                -- project's own commit (see
                                                -- git_commit below)

  -- T8 identity: project -> task -> session -> call (docs/08 §1).
  project_id            TEXT REFERENCES projects(id),
  parent_session_id     TEXT REFERENCES sessions(id),  -- set when this
                                                -- session IS a subagent
  resumed_from          TEXT REFERENCES sessions(id),  -- set when this
                                                -- session continues another
  continuations_used    INTEGER,               -- T109: boundaries crossed
                                                -- for this task; NULL before T109
  git_commit            TEXT,                   -- the PROJECT's working tree
                                                -- at session start, for
                                                -- resume-safety checks (§5)
  git_dirty             INTEGER DEFAULT 0,
  agent_role            TEXT,                   -- worker | scout | watcher |
                                                -- subagent | ...
  -- T119: the model the session started on. Per-call `calls.model` remains
  -- authoritative after a user switch.
  model                 TEXT,
  model_switches        INTEGER,
  model_path            TEXT,
  -- Profiles ticket 04: the profile the session started on stays in
  -- `profile` above (T23.3's column); a mid-session `/profile <name>` switch
  -- is counted and pathed here, the same shape model_switches/model_path
  -- already use for `/model`.
  profile_switches      INTEGER,
  profile_path          TEXT,
  -- T117: stored decision, one-run flag, or interactive prompt.
  trust_source          TEXT CHECK (trust_source IN ('stored','flag','prompt')),
  -- T35.3: who chose `model`. config_default | caller_override | profile.
  -- NULL on every session that ran before this column — not backfilled,
  -- because a guessed source is indistinguishable from data.
  -- ADR-0020 renamed the concept from profile to specialist and this constraint
  -- was left behind, so `SessionModelSource` typed 'specialist' while SQLite
  -- accepted only 'profile': any session that booted on a specialist's declared
  -- model failed to ingest with a CHECK violation. A ledger created before this
  -- line changed keeps the old constraint, because SQLite cannot alter one in
  -- place; the type is the enforcement that works everywhere.
  model_source          TEXT CHECK (model_source IN
                          ('config_default','caller_override','specialist')),
  -- T23.3: which capability profile this session ran under (budget |
  -- cheap_worker | stronger | deliberate | ...). Full per-profile resolution
  -- is Phase 8; today only the hop-0 worker exists, which IS the budget
  -- preset. NULL until profiles land rather than a guessed value.
  profile               TEXT,
  -- T31.1/T31.2 (docs/15-phase3-tasks.md): which of Lykos's own execution
  -- paths produced this session, and where it ran. Unordered with T33/T34 --
  -- a session written before this column exists can never be attributed
  -- retroactively (13-model-access.md §5.3's argument, applied again).
  execution_shape       TEXT CHECK (execution_shape IN
                          ('mcp_worker','cli_delegate','standalone','subagent')),
  runtime               TEXT CHECK (runtime IN ('container','host')),

  -- Transcript pointer (T9). NULL until transcript capture writes it.
  transcript_path       TEXT,
  transcript_sha256     TEXT,
  transcript_bytes      INTEGER,
  archive_state         TEXT,                   -- 'live' | 'recent' |
                                                -- 'archived' (docs/08 §3);
                                                -- NULL until T9/lykos archive
  -- T53 (docs/19-phase4-tasks.md): where this session's transcript came
  -- from. 'stream' = written live off the agent's own event stream and
  -- therefore replayable as a conversation; 'snapshot' = the historical
  -- terminal-snapshot subset (no user messages), which can be read but never
  -- resumed as a conversation. NULL on every session that ran before this
  -- column and NOT backfilled -- a guessed capture mode would be
  -- indistinguishable from a recorded one, and T56 refuses on it either way.
  capture_mode          TEXT,
  resumable             INTEGER DEFAULT 1,
  not_resumable_reason  TEXT,

  brief                 TEXT,
  difficulty_estimate   INTEGER,                -- 1-5, recorded BEFORE the outcome
                                                -- is known; worthless if set after
  -- Outcome. `outcome_source` is what stands between this ledger and a system
  -- that grades its own homework: 'agent_claim' is recorded but NEVER counted
  -- as success.
  outcome               TEXT CHECK (outcome IN ('success','fail','abandoned')),
  outcome_source        TEXT CHECK (outcome_source IN
                          ('verification_command','human','agent_claim')),
  verification_cmd      TEXT,
  verification_output   TEXT,
  -- T144: the exit code the verification command returned, beside the
  -- outcome derived from it, so "the outcome came from an exit code" can be
  -- checked rather than trusted. NULL when no command ran -- never 0, which
  -- would read as "passed". recordOutcome() refuses a code that disagrees
  -- with the outcome.
  verification_exit_code INTEGER,

  -- T173: containment. What the session asked of it and what it got; the
  -- container_* columns are NULL when its commands ran on the host. NULL in
  -- all of them is a session from before T173. Added to older ledgers by the
  -- add-if-missing list in ledger.ts.
  containment_requested     TEXT,
  containment_used          TEXT,
  container_runtime         TEXT,
  container_runtime_version TEXT,
  container_image           TEXT,
  container_network         TEXT,
  container_mount           TEXT,

  total_cost_usd        REAL,
  unpriced_calls        INTEGER,
  total_avoided_usd     REAL,                   -- MODELLED, not measured

  turns                 INTEGER DEFAULT 0,
  tool_calls            INTEGER DEFAULT 0,
  compactions           INTEGER DEFAULT 0,
  escalations           INTEGER DEFAULT 0,
  human_interventions   INTEGER DEFAULT 0,

  -- Mechanism flags, for the toggle-based evaluation in docs/03-telemetry.md §7.
  -- Without these, on/off comparisons across real work are impossible.
  flag_retrieval            INTEGER DEFAULT 0,
  flag_proactive_compaction INTEGER DEFAULT 0,
  flag_routing              INTEGER DEFAULT 0,
  flag_draft_verify         INTEGER DEFAULT 0,
  flag_delegation           INTEGER DEFAULT 0,
  flag_cache_stable_head    INTEGER DEFAULT 0,   -- T17: the cache-stable head contract is in force
  flag_trimmed_tool_surface INTEGER DEFAULT 0,   -- T20: hop-0 allowlist is D2.3 (read/bash/edit/write)
  flag_prompt_diet          INTEGER DEFAULT 0,   -- T21: lean prompt diet (AGENTS.md + live tool-result cap)
  flag_output_diet          INTEGER DEFAULT 0,   -- T23: YAGNI/one-liner rule was in the frozen head
  -- T65 (docs/20-phase9-tasks.md, problems/09 mitigation 1): a memory block
  -- was frozen into this session's head. DEFAULT 0 is correct here and only
  -- here: no session before T65 injected memory, because nothing read the
  -- files at all. The counts below have no DEFAULT, for the usual reason --
  -- "injected 0 tokens" and "never measured" are different answers.
  flag_memory_inject        INTEGER DEFAULT 0,
  -- WHICH entries were injected. Without this a memory-caused failure is
  -- unattributable, which is the failure mode that makes memory rot
  -- undiagnosable rather than merely present. Ids are the 8-hex handles
  -- `lykos memory` already assigns, so a row here points at a line in a file
  -- the maintainer can open and edit.
  memory_injected_ids       TEXT,      -- JSON array of entry ids, in injection order
  memory_inject_tokens      INTEGER,   -- estimated tokens of the whole block, heading included
  memory_entries_available  INTEGER,   -- entries that existed across the configured scopes
  memory_entries_skipped    INTEGER,   -- entries that did not fit the cap; the store-pressure signal
  -- T69 (docs/20-phase9-tasks.md): the repo map frozen into the head, and
  -- what it cost. No DEFAULT: a pre-T69 session did not measure a map, which
  -- is a different answer from "had a map of 0 tokens". flag_retrieval, which
  -- has existed since T8 with NO WRITER AT ALL, finally gets one here -- and
  -- it is true only when a map actually rode the head, never merely when the
  -- feature was configured on.
  repo_map_tokens           INTEGER,
  repo_map_files            INTEGER,   -- files named in the rendered map
  repo_map_dropped          INTEGER,   -- tracked files the cap could not fit
  repo_map_tracked          INTEGER,   -- tracked files in the repo
  -- T70: did the map surface what the session went on to need?
  --
  -- map_edited_missed is problems/06's early-warning signal verbatim -- "any
  -- task where the agent edited a file that retrieval did not surface" -- and
  -- is the closest thing to a correctness test retrieval has. A map that
  -- misses the file you change is not merely useless: problems/06 calls
  -- confidently wrong retrieval WORSE than no retrieval, because exploration
  -- at least self-corrects.
  --
  -- map_explore_covered counts reads of files the map had ALREADY named --
  -- every one is a read the map was supposed to prevent and did not. High
  -- while the map is on means the map is pure cost.
  --
  -- No DEFAULT: a session with no map has no coverage, which is a different
  -- answer from a map that covered nothing.
  map_edited_covered        INTEGER,
  map_edited_missed         INTEGER,
  map_missed_paths          TEXT,      -- JSON array, so the signal is inspectable
  map_explore_covered       INTEGER,
  map_explore_uncovered     INTEGER,

  -- T19: the compaction share in force this session (default 0.80). Recorded
  -- so later --compare is not confounded by a setting nobody remembers.
  compaction_threshold      REAL,

  -- T21.4: exploration tool-calls counted at ingest from the snapshot trace.
  --
  -- T63 (docs/20-phase9-tasks.md §2) REDEFINED what this counts, and the
  -- redefinition is the whole reason Phase 9 opened with a measurement task.
  -- The v1 definition was the tool names read/grep/find/ls with bash
  -- excluded, on the reasoning that bash also runs tests -- but T20 had
  -- already moved grep/find/ls ONTO bash, so from Phase 2 onward the counter
  -- saw only `read`. Over the archive it undercounted by ~4.6x. v3 classifies
  -- each bash command by its command word and keeps shell quoting intact
  -- during redirect analysis (lykos/loop/exploration.ts).
  --
  -- Rows are NOT backfilled. explore_metric_version says which definition a
  -- row was written under: NULL or 1 = v1, 2 = v2, 3 = v3. Never compare
  -- across them.
  explore_tool_calls        INTEGER DEFAULT 0,
  explore_metric_version    INTEGER,
  -- Result bytes returned BY those calls, and by every tool call in the
  -- session. The share is the quotient (v_exploration), and it is the number
  -- T67's gate reads: a bare count hides a `head -5` behind a recursive grep.
  -- NULL, not 0, on any row written before v3 -- 0 would be a claim.
  explore_result_bytes      INTEGER,
  tool_result_bytes         INTEGER,
  -- JSON {search,read,history,inspect} -> {calls,bytes}. Recorded because
  -- "exploration" has two defensible definitions: everything read-only, or
  -- only the file-finding a repo map could replace. `git log` is orienting,
  -- not file-finding. T67 must be able to apply either; neither is chosen here.
  explore_breakdown         TEXT,

  -- T64 (docs/20-phase9-tasks.md §5, problems/06 mitigation 2): hit quality,
  -- computed from the session's own answer key -- the files it actually
  -- edited. first_touch_rank is how many exploration calls had happened when
  -- the session first READ a file it went on to edit; 1 means it went
  -- straight there, high means it read a lot of wrong files first.
  --
  -- blind_edits is separated out and EXCLUDED from the rank mean. A `write`
  -- of a brand-new file was never "found", and scoring it rank 0 would make
  -- hit quality look perfect for free.
  --
  -- These are NOT written into retrieval_hit_quality. That column means "did
  -- retrieval's returned set contain the edited files", and there is no
  -- retrieval yet; a number in it now would be a claim about a mechanism
  -- that does not exist. This is the pre-retrieval baseline it will be
  -- compared against.
  edited_files              TEXT,      -- JSON [{path, rank|null, blind}]
  edited_file_count         INTEGER,
  blind_edits               INTEGER,
  first_touch_rank          REAL,      -- mean over the files that WERE read first; NULL when none were
  hit_quality               REAL,      -- share of edited files read before being edited
  hit_quality_version       INTEGER,
  -- T24.3: edit-retry rate, the prerequisite metric for T24's adoption
  -- decision. All three counted at ingest from the same snapshot trace
  -- explore_tool_calls reads. edit_retry_count is a subset of
  -- edit_error_count -- a retry needs a recoverable path on both calls, an
  -- error does not. See lykos/loop/edit-retry.ts.
  edit_tool_calls           INTEGER DEFAULT 0,
  edit_error_count          INTEGER DEFAULT 0,
  edit_retry_count          INTEGER DEFAULT 0,

  -- T83: Pi's own transient-failure retry (429/5xx/socket), observed rather
  -- than built -- it is enabled by default one layer down (3 attempts,
  -- 2000ms base) and Lykos recorded none of it until now. No DEFAULT: a row
  -- that predates the observer ran with the same retry active and simply did
  -- not measure it, which is not the same answer as "nothing retried".
  -- retries_exhausted > 0 on a failed session means the provider, not the work.
  -- T89: model switches forced by an unreachable provider, `from>to` per
  -- switch. A session carrying this spans more than one price basis, and
  -- `lykos cost` must never sum across price bases.
  model_fallbacks           TEXT,

  -- T132 (docs/28-phase17-tasks.md): the loader surface. Situational tools
  -- are registered but left OUT of the boot allowlist, and the agent
  -- activates them by name mid-session. Off by default, enabled per
  -- session, so the mechanism can be compared against real work.
  --
  -- tool_loader_path is DERIVED, NOT OBSERVED, and is named the way
  -- avoided_basis is: Pi exposes no signal for which representation it
  -- used, so Lykos reads the session's model against the support matrix in
  -- Pi 0.84.3's docs/extensions.md ('native_deferred' preserves the cached
  -- prefix; 'fallback' invalidates it once at activation). WITHOUT THIS
  -- COLUMN A COLD PREFIX ON A CHEAP MODEL IS UNEXPLAINABLE and looks like
  -- the T17 cache-stable head failing for a reason that has nothing to do
  -- with it -- DeepSeek, this project's target tier, is on the fallback
  -- path.
  --
  -- No DEFAULT anywhere: NULL is every session that had no loader at all,
  -- and 0 activations with enabled=1 is the answer the kill criterion
  -- reads -- the mechanism was there and nothing ever used it.
  tool_loader_enabled       INTEGER,
  tool_loader_path          TEXT,      -- native_deferred | fallback; derived, see above
  tool_loader_deferred      TEXT,      -- JSON array: names held back at boot
  tool_loader_activated     TEXT,      -- JSON array: names activated, in order asked for
  tool_loader_activations   INTEGER,   -- loader calls that changed the active set
  -- The arithmetic that catches a loader costing more than it saves. Both
  -- measured with the existing schema helpers; recording 0 for a deferred
  -- tool would be the self-flattering arithmetic `avoided` exists to stop.
  tool_loader_tokens        INTEGER,   -- the loader's OWN schema, resident every request
  tool_loader_deferred_tokens INTEGER, -- what the deferred schemas would have cost every request

  -- T111.1 (docs/28-phase17-tasks.md): bytes this session spilled to its
  -- artifacts/ directory. T9.4 has written those files since Phase 0 and
  -- nothing ever counted them. NO DEFAULT: NULL means the session had no
  -- transcript writer able to observe a spill (every pre-T111 row, and the
  -- container path), which is a different answer from 0 -- a session that
  -- ran with the writer and never produced an oversized result.
  -- v_cost_per_successful_task sums this to the task.
  artifact_bytes            INTEGER,

  -- T111.2 (docs/28-phase17-tasks.md): approval friction, by T107's risk
  -- tier and by T131's interaction mode. This is the pair that makes the
  -- tier table a mechanism rather than a rename. NO DEFAULT on any of them:
  -- NULL means no gate observed this session (an MCP worker, a subagent, a
  -- --yes run), and 0 means the gate ran and never had to ask.
  --
  -- The three counts are deliberately not two. approvals_requested is the
  -- friction number -- a prompt actually put to a human. approvals_denied is
  -- the subset of those the human answered no to. approvals_auto_denied is
  -- the mode refusing outright with nobody asked, which is NOT friction:
  -- Plan mode denying a write is Plan mode working, and folding it into the
  -- friction number would report the policy as a cost.
  approvals_requested       INTEGER,
  approvals_denied          INTEGER,
  approvals_auto_denied     INTEGER,
  approvals_by_tier         TEXT,      -- JSON, keyed by risk tier
  approvals_by_mode         TEXT,      -- JSON, keyed by interaction mode; without it a count measures the maintainer's mode choice

  -- T111.3 (docs/28-phase17-tasks.md): the observable substrate for tool
  -- selection. THERE IS DELIBERATELY NO "ACCURACY" COLUMN HERE AND ADDING
  -- ONE IS A MISTAKE: there is no ground truth for "the right tool", so any
  -- automated proxy is a model judging a model -- agent_claim wearing a
  -- metric's clothes, which outcome_source already refuses for success.
  -- Raw counts only; a rate is derived and belongs to the reader.
  -- tool_switch_same_target counts adjacent calls where the tool changed
  -- and the target did not. Its dominant shape is read-then-edit on one
  -- file, which is normal work -- this is EVIDENCE ABOUT tool selection,
  -- not a defect count. NO DEFAULT: NULL is every pre-T111 row.
  tool_call_counts          TEXT,      -- JSON {tool: calls}
  tool_error_counts         TEXT,      -- JSON {tool: errored calls}; a tool absent here never errored
  tool_adjacent_pairs       INTEGER,   -- pairs where both sides had a resolvable target: the denominator
  tool_switch_same_target   INTEGER,
  -- D26: the same dispatches as tool_call_counts, keyed by the tool a
  -- transport call resolved to (tool_call naming lsp counts as lsp). The two
  -- columns describe one set of events and are never summed. NO DEFAULT.
  actual_tool_call_counts   TEXT,      -- JSON {tool: calls}

  -- T110 (docs/28-phase17-tasks.md): the reviewer that did not write the code.
  -- P4 T149: nothing writes these any more — the reviewer is the
  -- `lykos-reviewer` extension and records in `extension_counters`. Kept, not
  -- dropped, because they are the record of every T110 run.
  -- One read-only scout, once, at the end, against a diff.
  -- NO DEFAULT: NULL means the session ran before T110 or without a reviewer;
  -- 0 findings with invocations=1 means the reviewer ran and found nothing.
  reviewer_invocations      INTEGER,
  reviewer_findings_count   INTEGER,
  reviewer_model            TEXT,

  -- T105 (docs/24 §2.9): the hook surface -- five events, three outcomes
  -- (continue / deny / note), built-in policies plus whatever config.yaml
  -- declares. hook_denials counts tool calls REFUSED before they ran, which
  -- is the number that says whether a deterministic policy is doing anything
  -- at all. No DEFAULT: a pre-T105 session had no hooks, which is not the
  -- same as hooks that never fired.
  hooks_registered          INTEGER,
  hook_denials              INTEGER,
  hook_notes                INTEGER,

  -- T104 (docs/24 §2.8): turn checkpoints -- a git commit on a scratch ref
  -- (refs/lykos/checkpoints) taken at the start of every turn whose tree
  -- differs from the last one. Never the branch, never HEAD, never the
  -- user's index. NULL means the session had no checkpointing at all (not a
  -- git repository); 0 means it had one and nothing changed all session.
  checkpoints_written       INTEGER,

  -- T103 (docs/24 §2.10): agent -> human clarification. Misalignment is the
  -- failure mode where a cheap model's cost is unbounded -- it builds the
  -- wrong thing completely and the ledger records a full task -- so one round
  -- trip at the moment of uncertainty is the cheapest correction in the
  -- system. ask_unanswered is the honest half: the tool never blocks, so a
  -- question nobody answered still let the session continue on its own
  -- stated assumption. No DEFAULT: NULL means the session had no human
  -- channel at all (one-shot, MCP worker, subagent), which is a different
  -- answer from a channel the model never used.
  ask_calls                 INTEGER,
  ask_answered              INTEGER,
  ask_unanswered            INTEGER,

  -- T102 (docs/24 §2.5): the skills roster. Pi already ships the mechanism --
  -- name, description and location in the head, body loaded on demand with
  -- the `read` tool, so it costs ZERO tool schema. What is recorded here is
  -- what §2.5 asked to be measured: the roster size (the denominator), which
  -- skills were actually read, and what the roster cost the head. A roster
  -- offered and never read is store pressure, exactly as T76 found for
  -- memory entries. No DEFAULT: a pre-T102 session had no roster at all.
  skills_available          INTEGER,
  skills_invoked            TEXT,      -- JSON array of skill names, first-read order
  skill_reads               INTEGER,   -- total reads including re-reads
  skills_head_tokens        INTEGER,   -- what the roster costs EVERY request this session

  -- T99 (docs/24 §2.1): the post-edit feedback loop -- the project's own
  -- check, run after every successful write or edit, with its failure
  -- appended to the tool result the model is already reading. No DEFAULT:
  -- a pre-T99 session had no loop at all, which is a different answer from
  -- a loop that was on and never had an edit to check. post_edit_command is
  -- recorded because "runs = 0" means one thing with a command and another
  -- without one. post_edit_disabled_reason is set when the loop switched
  -- ITSELF off -- too slow, timed out, or a command that could not start.
  post_edit_command         TEXT,
  post_edit_runs            INTEGER,
  post_edit_failures        INTEGER,
  post_edit_passes          INTEGER,
  post_edit_ms              INTEGER,   -- wall time the loop itself cost
  post_edit_disabled_reason TEXT,

  -- T98 (docs/27-phase12-tasks.md): the session-owned task list. No DEFAULT
  -- on any of them, the same rule as the retry and stagnation columns above:
  -- a session that ran before the list existed had no list at all, which is
  -- a different answer from "the tool was on the surface and never called".
  -- task_list_calls = 0 is that second answer and is worth recording, since
  -- Phase 12's evaluation is "did this fire at all" rather than a ledger
  -- number.
  task_list_calls           INTEGER,
  task_list_created         INTEGER,
  task_list_completed       INTEGER,
  task_list_open            INTEGER,   -- still outstanding when the session ended
  task_list_reminders       INTEGER,   -- T98.4: unseen-list nudges appended to a tool result
  -- T100: times the gate REFUSED a done because the item's verify command
  -- failed, and items whose command actually passed. The first is the
  -- mechanism catching an agent that reports success by default; the second
  -- is the evidence a step-level success is allowed to rest on.
  task_gate_refusals        INTEGER,
  task_items_verified       INTEGER,

  -- T85: the stagnation brake -- N consecutive identical failing calls on one
  -- target. No DEFAULT: a session that ran before the brake existed is not the
  -- same as one where the brake ran and never fired.
  stagnation_trips          INTEGER,
  stagnation_key            TEXT,

  retry_starts              INTEGER,
  retries_recovered         INTEGER,
  retries_exhausted         INTEGER,
  retry_max_attempt         INTEGER,
  retry_last_error          TEXT,
  -- T21.3: JSON array of {name, kind, bytes} frozen into the head, or NULL.
  context_files             TEXT,

  -- T29.4 (docs/10-phase2-tasks.md, lykos/config/extensions.ts): which
  -- third-party extensions this session actually declared, in declaration
  -- order -- the same order `extensionSetKey()` hashes over, since a
  -- different load order is a different configuration. NULL when nothing
  -- was declared (every ledger before T29, and every hop-0 default today).
  extensions                TEXT,                  -- JSON array of {name, version}, declaration order
  extension_set             TEXT,                  -- extensionSetKey() handle; 'none' for an empty set
  -- T29.3: the schema-tax delta an extension's tools add beyond Pi's own
  -- four built-ins (piDefaultBaseline(), 711 tokens per T20). The SHARE is
  -- that delta over BILLED input (fresh + cache_read) -- the same denominator
  -- v_schema_tax.share_of_prompt uses, and the one problems/14's ~10% kill
  -- line is stated in. Share of the tool schema instead would sit near 75%
  -- on pi-subagents alone and trip on every session, meaning nothing.
  -- Both columns are NULL together, never a partial number, whenever
  -- measureToolset(activeTools) hits a tool name the catalog doesn't know.
  extension_schema_tokens   INTEGER,
  extension_schema_share    REAL,

  notes                 TEXT
);

-- ---------------------------------------------------------------------------
-- memory_eligibility -- T76 (docs/23-phase10-tasks.md): one row per memory
-- entry per session, whatever happened to it.
--
-- sessions.memory_injected_ids records what WAS injected. This records what
-- was eligible and did not make it, which is the difference between an entry
-- nobody wanted and an entry that never got a chance: assembleMemoryHead
-- stops at the first entry that does not fit, and file order is priority
-- order, so an entry below the cap boundary stays never-injected forever
-- however good it is.
--
-- Dead weight is therefore computed as
--   entries with 0 rows in state 'injected' AND >0 rows overall
-- and it is a PRESSURE SIGNAL, never on its own an eviction verdict
-- (docs/22-memory-and-retrieval-source-review.md 11.8).
--
-- Append-only like everything else here: a re-run of a session writes new
-- rows under a new session id and never updates these.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_eligibility (
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  entry_id    TEXT NOT NULL,           -- the 8-hex handle in the markdown file
  scope       TEXT NOT NULL,           -- project | global
  file        TEXT NOT NULL,           -- gotchas | failed-approaches
  -- T79 widened this to include 'stale': a memory whose declared dependency
  -- paths no longer all exist is held back rather than injected, and that is
  -- a third outcome, not a variety of the other two.
  state       TEXT NOT NULL CHECK (state IN ('injected','skipped_cap','stale')),
  position    INTEGER NOT NULL,        -- 0-based priority, which IS file order
  tokens      INTEGER NOT NULL,        -- estimated tokens of the rendered line
  PRIMARY KEY (session_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_eligibility_entry ON memory_eligibility(entry_id);

-- ---------------------------------------------------------------------------
-- rediscovery_annotations -- T80 (docs/23-phase10-tasks.md): a HUMAN saying
-- "I worked that out again".
--
-- T66 measures exact repeats: the same path read, the same command re-run,
-- the same failure twice. Memory is scoped to gotchas and failed approaches
-- (DECISIONS.md 2026-08-28), and a lesson of that kind, when re-derived,
-- leaves no repeated tool call at all -- two different commands can reach
-- the same conclusion. So the instrument cannot see most of the market the
-- scope decision permits, and this table is the cheapest honest signal for
-- the part it misses.
--
-- author is CHECKed to 'human' and nothing else. An agent reports success by
-- default and is not a reliable narrator of its own work; an agent that
-- could manufacture the evidence for memory's value would. Same rule as
-- outcome_source, same enforcement.
--
-- It is a LOWER BOUND, never a rate: the maintainer annotates only what they
-- notice. Every report reading this must say so.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rediscovery_annotations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_utc            TEXT NOT NULL,
  session_id        TEXT REFERENCES sessions(id),   -- where it was re-derived
  source_session_id TEXT REFERENCES sessions(id),   -- where it was first learned
  lesson            TEXT NOT NULL,
  would_have_helped INTEGER,                        -- 1 | 0 | NULL (not answered)
  calls_spent       INTEGER,                        -- tool calls burned re-deriving it
  author            TEXT NOT NULL CHECK (author IN ('human'))
);

-- ---------------------------------------------------------------------------
-- extension_counters
--
-- A Lykos extension's own numbers, per session, under the name it was
-- DECLARED by in config.yaml (a module cannot rename itself out of its
-- record). Written once, when the session ends, from what the extension
-- recorded through `recordCounter`. A counter never recorded has no row —
-- absent is not zero. Nothing is backfilled: a session before T149 has none.
--
-- `lykos-reviewer` writes `invocations`, `findings`, `failures` and
-- `skipped_*` here; its model and its findings are its child session's own
-- row (parent_session_id, agent_role 'extension:lykos-reviewer') and
-- transcript. The sessions.reviewer_* columns predate this and are kept as
-- the record of the T110 reviewer; nothing writes them any more.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS extension_counters (
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  extension   TEXT NOT NULL,
  name        TEXT NOT NULL,
  value       INTEGER NOT NULL CHECK (value >= 0),
  PRIMARY KEY (session_id, extension, name)
);

-- ---------------------------------------------------------------------------
-- compactions — P4 T152 (spec story 54): one row per compaction ATTEMPT while
-- the self-compact context strategy is active: the agent's own handoffs
-- (trigger 'agent' or 'command') and Pi's compaction underneath it
-- ('manual', 'pi-threshold', 'pi-overflow'). A failed or cancelled attempt is
-- a row too, because the retry is the thing being measured. What the
-- summariser call cost is the matching `calls` row (phase 'compact'); this
-- table says why it ran, on which tier, and whether it worked, so the tier
-- table's defaults can be corrected from use. A new table: no earlier
-- session has a row, and none is backfilled. `id` is the extension's record
-- id, so ingesting a session twice adds nothing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compactions (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id),
  ts_utc          TEXT NOT NULL,
  strategy        TEXT NOT NULL,              -- the active context strategy
  trigger         TEXT NOT NULL CHECK (trigger IN
                    ('agent','command','manual','pi-threshold','pi-overflow')),
  handoff_id      TEXT,                       -- NULL on Pi's own compactions
  attempt         INTEGER NOT NULL DEFAULT 1,
  model           TEXT,                       -- provider/model
  tier            TEXT,                       -- self-compact tier, e.g. '128k'
  context_window  INTEGER,
  tokens_before   INTEGER,                    -- context measured at the attempt
  -- Pi's chars/4 estimate of the context after a Pi-started compaction or the
  -- note's; for 'shake' it is `tokens_before` (measured) less the chars/4
  -- estimate of what was dropped. An estimate either way, never a measurement.
  tokens_after    INTEGER,
  result          TEXT NOT NULL CHECK (result IN ('ok','failed','cancelled')),
  error           TEXT,
  -- T190 (spec #15): the chain. `method` is the one that ran ('note',
  -- 'handoff', 'shake', 'summary' = Pi's own summary); `fell_through` is a JSON
  -- array of {method, reason[, usage]}, in the order tried, for the methods
  -- before it (a side call that failed or wrote nothing carries its usage:
  -- it was paid for, and its `calls` row is written from the same report).
  -- The usage columns MIRROR the `calls` row of the compaction's own model call
  -- (`calls` stays the place cost is summed; these put the split on the row
  -- that says why the call ran): input, output, cache read, cache write, and
  -- the part of the write that was a one-hour write, which is priced
  -- differently. 0 for shake, which makes no call; NULL
  -- when the provider reported none (Pi's summariser sometimes; only Anthropic
  -- reports the one-hour split). All NULL on a row written before the chain;
  -- nothing is backfilled.
  -- `method` has a CHECK like `trigger` and `result`. The insert is OR IGNORE,
  -- so a value the CHECK refuses loses the whole row; the type in
  -- loop/compaction-chain.ts is what keeps that from happening.
  method                TEXT CHECK (method IS NULL OR method IN ('note','handoff','shake','summary')),
  fell_through          TEXT,
  input_tokens          INTEGER,
  output_tokens         INTEGER,
  cache_read_tokens     INTEGER,
  cache_write_tokens    INTEGER,
  cache_write_1h_tokens INTEGER
);

-- ---------------------------------------------------------------------------
-- prunes — T188 (spec #15): one row per prune pass `lykos-prune` made, the
-- overwriting of superseded reads and flagged-useless results with a notice.
-- `tokens_saved` is Pi's chars/4 estimate of what the overwritten results
-- weighed less the notice -- an estimate, never a measurement (AGENTS.md rule
-- 4). `reason` says which side of the cache guard the pass fell on: 'tail'
-- (at most 8 000 tokens followed every result it rewrote, so the cache re-write
-- was small) or 'idle' (the last model response was older than the cache
-- retention, so the cache had expired). A new table: no earlier session has a
-- row, and none is backfilled. `id` is the record's own id, so ingesting a
-- session twice adds nothing. Like `commits`, a row is written the moment the
-- prune is made, before the session's own row exists (ingest runs at the end),
-- so a killed session keeps its prunes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prunes (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,              -- NOT a foreign key: the row is written when the prune is made
  ts_utc        TEXT NOT NULL,
  superseded    INTEGER NOT NULL,           -- results overwritten as superseded reads
  useless       INTEGER NOT NULL,           -- results overwritten as flagged useless
  tokens_saved  INTEGER NOT NULL,           -- estimated, chars/4
  reason        TEXT NOT NULL CHECK (reason IN ('tail','idle'))
);

-- ---------------------------------------------------------------------------
-- flaky_tests — T167 (spec #18, ADR-0030): a test that failed in the session
-- gate's run and PASSED when only its file was rerun, once. One row per such
-- test per session. It is written in the same transaction as the session's
-- outcome, by the one writer (`recordOutcome`), and only when the rerun exited
-- 0 — a rerun that failed again names nothing, because it proves nothing about
-- which tests were flaky. `edited_by_session` is 1 when the session edited that
-- test's file, which is the case that keeps the verdict `fail` (a session must
-- not pass by writing a test that sometimes passes). `lykos doctor` counts
-- these rows; `lykos show` prints a session's. Nothing is backfilled: a
-- session before T167 has none, and run 2 of the P4 demonstration stays `fail`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS flaky_tests (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT NOT NULL REFERENCES sessions(id),
  ts_utc            TEXT NOT NULL,
  test_file         TEXT NOT NULL,              -- relative to the project, forward slashes
  test_name         TEXT NOT NULL,              -- as the reporter printed it; a whole-file failure is the file's name
  edited_by_session INTEGER NOT NULL CHECK (edited_by_session IN (0, 1)),
  first_exit_code   INTEGER,                    -- the gate command's exit code
  rerun_exit_code   INTEGER,                    -- the rerun's (0, by construction)
  rerun_command     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_flaky_tests_session ON flaky_tests(session_id);

-- ---------------------------------------------------------------------------
-- commits — T179 (spec #22 story 24): one row per commit a session made
-- through the `commit` tool, the one place commits happen. A row is written the
-- moment the commit is made, not at the session's end: `sessions` rows are
-- written by ingest at the end, so a session that is killed has none, and a
-- foreign key would refuse the commits of exactly that session. `sha` is the full
-- commit id from `git rev-parse`, or, when that could not be read, the
-- abbreviated id `git commit` itself printed, stored as is (`git show` resolves
-- either); a commit whose id could not be read at all has no row, and
-- `files_changed` is NULL when it could not be counted, never a guess; `scope` is 'paths' when
-- the call named files and 'all' when it committed every change. Keyed (session, sha) so the
-- end-of-session backstop write adds nothing. The message passes through the same
-- secret redaction `sessions.brief` does. A new table: no earlier session has
-- a row, and none is backfilled from the repository's history.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS commits (
  session_id    TEXT NOT NULL,              -- NOT a foreign key: see above
  sha           TEXT NOT NULL,
  ts_utc        TEXT NOT NULL,
  subject       TEXT NOT NULL,              -- the first line of the message
  message       TEXT NOT NULL,
  files_changed INTEGER,                    -- NULL = unmeasured: no id to count them from
  scope         TEXT NOT NULL CHECK (scope IN ('paths','all')),
  PRIMARY KEY (session_id, sha)
);

-- ---------------------------------------------------------------------------
-- seal_events — T195: sealed TDD events (created, verified, vetoed, etc.).
-- `session_id` is nullable TEXT with no foreign key (NULL when creator is 'cli').
-- `creator` records 'cli' or the session id.
-- `paths` is JSON array of sealed paths.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS seal_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,
  session_id  TEXT,
  creator     TEXT NOT NULL,
  specialist  TEXT,
  branch      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  paths       TEXT NOT NULL,
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS idx_seal_events_branch ON seal_events(branch);
CREATE INDEX IF NOT EXISTS idx_seal_events_session ON seal_events(session_id);

-- ---------------------------------------------------------------------------
-- calls — one row per model call, at any depth
--
-- Hop topology (DECISIONS.md, 2026-08-28): orchestrator <-> worker <-> subagent.
-- `parent_call_id` and `hop` make per-hop delegation accounting possible, which
-- is what lets the second hop justify itself independently of the first.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calls (
  id                    TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES sessions(id),
  parent_call_id        TEXT REFERENCES calls(id),
  hop                   INTEGER NOT NULL DEFAULT 0,  -- 0=worker, 1=subagent, ...
  ts_utc                TEXT NOT NULL,

  agent                 TEXT NOT NULL,          -- worker | scout | watcher | ...
  phase                 TEXT,                   -- plan|explore|implement|verify|
                                                -- compact|route|draft|verify_draft
  provider              TEXT NOT NULL,
  model                 TEXT NOT NULL,
  model_version         TEXT,

  -- Token accounting. cache_read AND cache_write are both required: read is
  -- what §4.2 prices, write is the premium that offsets it, and the HUD's cache
  -- hit ratio needs read to exist at all. If pi.events reports write only,
  -- capture these beneath Pi at the provider layer rather than accepting NULLs.
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens    INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens      INTEGER NOT NULL DEFAULT 0,

  -- T25.1/T25.2 (docs/13-model-access.md §5): how this call was authenticated
  -- and what the dollar figure means. Both always written by recordCall()
  -- (defaulting to the only route Lykos exercises before Phase 3's provider
  -- layer: 'api_key' / 'api_list') so a call can never land ambiguous.
  auth_mode             TEXT,                   -- api_key | oauth_subscription |
                                                -- vendor_cli | cloud_provider |
                                                -- gateway | unknown
  price_basis           TEXT,                   -- api_list | plan_credit | unpriced
  -- P14.6 ticket 06: the non-secret label (an account email, `key#2`) of the
  -- Lykos credential that served this call, so a reader knows which
  -- subscription or key paid. Never a key or token. NULL when no Lykos
  -- credential served the call (an ambient env var, a compaction or a
  -- delegate row), and on every row written before this ticket: no such row
  -- knows its credential, so the column is deliberately NOT backfilled.
  credential_label      TEXT,
  -- price_version and cost_usd are nullable ONLY for price_basis='unpriced'
  -- rows: tokens are still recorded, the dollar figure is NEVER invented
  -- (AGENTS.md rule 4). Every other row still gets both computed as before.
  price_version         TEXT,                   -- FK into prices.yaml `version`
  rate_window           TEXT,                   -- 'peak' | 'off_peak' | NULL.
                                                -- DeepSeek swings 2x; without
                                                -- this the same work looks twice
                                                -- as expensive on alternate days
  cost_usd              REAL,
  recosted              INTEGER NOT NULL DEFAULT 0,

  latency_ms            INTEGER,
  ttft_ms               INTEGER,
  turn_index            INTEGER,
  retries               INTEGER DEFAULT 0,
  error                 TEXT,

  tool_name             TEXT,
  wire_tool_name        TEXT,
  tool_result_bytes     INTEGER,
  tool_result_truncated INTEGER DEFAULT 0,
  -- T107.5: the risk tier this call's tool carries
  -- ('read'|'soft-write'|'hard-write'|'destructive', tools/tool-risk.ts), so
  -- T111 can count approvals BY TIER instead of estimating them. NO DEFAULT
  -- and never backfilled: NULL means "not knowable on this row", which
  -- covers every pre-T107 row and, deliberately, every `bash` row -- a
  -- shell call's tier is a function of the command, and the command is not
  -- on this row. Recording the declared fallback there would be a guess
  -- wearing a measurement's clothes.
  risk_tier             TEXT,

  retrieval_calls       INTEGER DEFAULT 0,
  retrieval_hit_quality REAL,

  context_before        INTEGER,
  context_after         INTEGER,
  compaction_triggered  INTEGER DEFAULT 0,
  -- T19: snip then prune token reductions on the compaction call, recorded
  -- before the summariser runs. NULL on non-compaction rows.
  snip_tokens_removed   INTEGER,
  prune_tokens_removed  INTEGER,

  -- Routing. model_source records who chose: 'role_default' vs 'caller_override'.
  -- The override log is the future router's training data (DECISIONS.md).
  router_decision       TEXT,
  router_features_json  TEXT,
  router_confidence     REAL,
  model_switched        INTEGER DEFAULT 0,
  -- Profiles ticket 04: true on the first call after a `/profile <name>`
  -- switch, mirroring model_switched. The switch also rebuilds the tool
  -- surface (`setActiveToolsByName`), which is what makes it a genuine
  -- prefix break under the head contract (docs/reference/prefix-control.md)
  -- rather than a label with nothing behind it.
  profile_switched      INTEGER DEFAULT 0,
  model_source          TEXT CHECK (model_source IN
                          ('role_default','caller_override','budget_downgrade')),

  verdict               TEXT CHECK (verdict IN
                          ('skipped','accepted','enhanced','n/a')),
  draft_used            INTEGER DEFAULT 0,

  -- Counterfactual accounting (docs/03-telemetry.md §4). MODELLED, not measured.
  -- avoided_basis names the assumption; a NULL avoided_usd is a CORRECT answer
  -- for mechanisms with no arithmetic counterfactual (retrieval, harness).
  -- Negative values are real and must be preserved: they are cost inversions.
  avoided_usd           REAL,
  avoided_basis         TEXT,

  -- Delegation specifics for §4.1
  child_input_tokens    INTEGER,
  summary_tokens        INTEGER,
  briefing_tokens       INTEGER,
  handoff_loss          INTEGER DEFAULT 0,      -- parent had to re-ask

  -- T4.1 tool-schema tax. NULL tokens means unknown (catalog miss or
  -- activeTools absent) — never store 0 for "we didn't measure". 0 is a
  -- known-empty tool set. Basis names the estimator (Pi's chars/4), never
  -- billed. Hash is of the canonical wire JSON and is what T4.2 asserts.
  tool_schema_tokens    INTEGER,
  tool_schema_bytes     INTEGER,
  tool_count            INTEGER,
  tool_schema_hash      TEXT,
  tool_schema_basis     TEXT,
  tool_names            TEXT,                   -- JSON array, API order
  prefix_changed        INTEGER,                -- T4.2: 1 if hash differs from previous call in session

  -- T16.2 (docs/10-phase2-tasks.md, docs/11-prefix-control-surface.md): the
  -- REAL request head, not the T4.1 catalog reconstruction above. SHA-256 of
  -- `session.agent.state.systemPrompt` + the session's active tool names, read
  -- host-side from the live AgentSession the engine already holds
  -- in-process — the exact
  -- content Pi assembled, not an estimate of what it might have assembled.
  -- NULL whenever the engine couldn't read session state (defensive;
  -- never a guessed value). hop 0 only: a hop-1 hop's head belongs to a
  -- session Lykos does not hold a live reference to (docs/08 §1.1).
  prefix_fingerprint         TEXT,
  prefix_fingerprint_source  TEXT,               -- names the read, e.g. 'pi_delegate_mcp_worker_host_state'
  prefix_fingerprint_changed INTEGER             -- 1 if it differs from the previous call in this session
);

CREATE INDEX IF NOT EXISTS idx_calls_session  ON calls(session_id);
CREATE INDEX IF NOT EXISTS idx_calls_parent   ON calls(parent_call_id);
CREATE INDEX IF NOT EXISTS idx_calls_ts       ON calls(ts_utc);
CREATE INDEX IF NOT EXISTS idx_calls_model    ON calls(provider, model);
CREATE INDEX IF NOT EXISTS idx_sessions_start ON sessions(started_utc);

-- ---------------------------------------------------------------------------
-- projects — a repository. Survives being renamed or moved (T8,
-- docs/08-sessions-and-archive.md §1). One project's worth of rows lives
-- here per ledger; ~/.lykos/projects.json (lykos/sessions/identity.ts) is
-- the cross-project registry this table is mirrored from.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
  id                    TEXT PRIMARY KEY,
  root_path             TEXT NOT NULL,
  git_remote            TEXT,
  first_commit          TEXT,
  name                  TEXT,
  created_utc           TEXT NOT NULL,
  last_seen_utc         TEXT
);

-- ---------------------------------------------------------------------------
-- tasks — one thing a person asked for. Spans resumptions (T8). Cost per
-- successful task (below) sums every session belonging to one of these, so
-- a task resumed four times is one expensive task, not four cheap ones.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL REFERENCES projects(id),
  brief                 TEXT NOT NULL,
  created_utc           TEXT NOT NULL,
  state                 TEXT CHECK (state IN ('open','done','abandoned','disputed')),
  difficulty_estimate   INTEGER          -- recorded at start, before the outcome
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);

-- ---------------------------------------------------------------------------
-- price_versions — provenance for every pricing change
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS price_versions (
  version               TEXT PRIMARY KEY,
  applied_utc           TEXT NOT NULL,
  source_checked        TEXT NOT NULL,
  note                  TEXT
);

-- ---------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------
-- ledger.ts applySchema() splits this file on the "-- Views" heading above:
-- tables + indexes first, then ALTER for additive columns, then these views.
-- Do not rename that heading. CREATE VIEW that selects T4.1 columns cannot
-- run before the ALTER on an existing ledger.

-- The project's headline metric. Needs no counterfactual and no assumptions:
-- dollars actually spent, divided by tasks actually finished. When this and the
-- modelled avoided figures disagree, THIS one wins.
--
-- T8.4: this used to group sessions by day, which let a task resumed four
-- times look like four cheap tasks instead of one expensive one. It now
-- groups by TASK and sums every session belonging to it — worse and correct.
-- A session with no task_id (a pre-T8 row, or a hop-1 session — see
-- v_delegation_by_hop for those) is outside a task and outside this view;
-- it still counts in v_cache_health and the plain per-session totals.
CREATE VIEW IF NOT EXISTS v_cost_per_successful_task AS
SELECT
  t.id                                                  AS task_id,
  t.project_id                                          AS project_id,
  t.brief                                                AS brief,
  COUNT(s.id)                                            AS sessions,
  SUM(s.outcome = 'success')                             AS successes,
  SUM(s.outcome = 'fail')                                AS failures,
  SUM(s.outcome = 'abandoned')                            AS abandoned,
  ROUND(SUM(s.total_cost_usd), 4)                        AS spent_usd,
  ROUND(SUM(s.total_cost_usd) / NULLIF(SUM(s.outcome = 'success'), 0), 4)
                                                          AS cost_per_success,
  -- T111.1: artifact bytes per TASK, which is the unit the metric is named
  -- in. Bytes are not dollars, so this sum is unaffected by the price-basis
  -- rule that governs every column above it -- and for the same reason it
  -- is never presented as cost.
  SUM(s.artifact_bytes)                                   AS artifact_bytes
FROM tasks t
JOIN sessions s ON s.task_id = t.id
GROUP BY t.id
ORDER BY MAX(s.started_utc) DESC;

-- Cache health. A hit ratio that fails to climb over a long session means the
-- prefix contract is broken, and every measurement is distorted until it is fixed.
CREATE VIEW IF NOT EXISTS v_cache_health AS
SELECT
  session_id,
  model,
  MAX(COALESCE((SELECT model_switches FROM sessions s WHERE s.id = calls.session_id), 0)) AS model_switches,
  SUM(input_tokens)                                    AS input_tokens,
  SUM(cache_read_tokens)                               AS cache_read,
  SUM(cache_write_tokens)                              AS cache_write,
  ROUND(1.0 * SUM(cache_read_tokens)
        / NULLIF(SUM(input_tokens + cache_read_tokens), 0), 3)
                                                       AS hit_ratio
FROM calls
GROUP BY session_id, model;

-- Cost inversions: the cases that quietly eat the savings. RLM-Cascade found
-- these in production; they will occur here too.
CREATE VIEW IF NOT EXISTS v_cost_inversions AS
SELECT id, session_id, agent, model, verdict, avoided_usd, avoided_basis, ts_utc
FROM calls
WHERE avoided_usd IS NOT NULL AND avoided_usd < 0
ORDER BY avoided_usd ASC;

-- Tool-schema tax per session. Share is of billed input-side tokens
-- (fresh + cache-read). NULL schema tokens are excluded from the average
-- so an unmeasured call cannot pull the tax down to look cheaper.
CREATE VIEW IF NOT EXISTS v_schema_tax AS
SELECT
  session_id,
  COUNT(*)                                             AS calls,
  SUM(tool_schema_tokens IS NOT NULL)                  AS measured_calls,
  ROUND(AVG(tool_schema_tokens), 1)                    AS avg_schema_tokens,
  ROUND(1.0 * SUM(tool_schema_tokens)
        / NULLIF(SUM(CASE WHEN tool_schema_tokens IS NOT NULL
                          THEN input_tokens + cache_read_tokens END), 0), 3)
                                                       AS share_of_prompt
FROM calls
GROUP BY session_id;

-- T4.2: calls whose tool-schema hash was not identical to the previous
-- call in the same session. A broken prefix contract, or an extension
-- that quietly reordered/added tools, shows up here the day it happens.
CREATE VIEW IF NOT EXISTS v_prefix_breaks AS
SELECT id, session_id, turn_index, ts_utc, tool_schema_hash, tool_names
FROM calls
WHERE prefix_changed = 1
ORDER BY ts_utc;

-- T16.2/T18: calls whose REAL observed head (system prompt + active tools,
-- read from host-side session state) changed from the previous call in the
-- same session. Unlike v_prefix_breaks (catalog reconstruction of tool
-- schemas only), this catches system-prompt drift too -- the volatile
-- per-turn content (git log, cwd status, journal counters) T17 exists to
-- eliminate. Empty on any ledger before T16.2 was deployed.
CREATE VIEW IF NOT EXISTS v_head_drift AS
SELECT id, session_id, turn_index, ts_utc, prefix_fingerprint
FROM calls
WHERE prefix_fingerprint_changed = 1
ORDER BY ts_utc;

-- Per-hop delegation economics. If hop 1 pays and hop 2 does not, the roster
-- flattens to a single level.
CREATE VIEW IF NOT EXISTS v_delegation_by_hop AS
SELECT
  hop,
  COUNT(*)                                             AS calls,
  SUM(child_input_tokens)                              AS child_input,
  SUM(summary_tokens)                                  AS returned,
  SUM(briefing_tokens)                                 AS briefing,
  SUM(handoff_loss)                                    AS handoff_losses,
  ROUND(SUM(avoided_usd), 4)                           AS avoided_usd,
  ROUND(SUM(cost_usd), 4)                              AS spent_usd
FROM calls
WHERE child_input_tokens IS NOT NULL
GROUP BY hop;

-- T63 (docs/20-phase9-tasks.md §5): the exploration share, per session.
--
-- Only v3 rows appear. A v1 row's explore_tool_calls counted a different
-- thing and its byte columns were never written, so including it would
-- average two incompatible definitions into one number -- exactly the
-- "backfill by arithmetic" this phase forbids. `sessions_v1` in the summary
-- view below says how many rows are being left out, so the exclusion is
-- visible rather than silent.
--
-- share is NULL when the session ran no tool at all. That is not 0%: a
-- session with no tool calls has no exploration share, and calling it zero
-- would drag the fleet average toward a claim the data does not support.
CREATE VIEW IF NOT EXISTS v_exploration AS
SELECT
  s.id                                                 AS session_id,
  s.task_id                                            AS task_id,
  s.started_utc                                        AS started_utc,
  s.execution_shape                                    AS execution_shape,
  s.tool_calls                                         AS tool_calls,
  s.explore_tool_calls                                 AS explore_calls,
  s.explore_result_bytes                               AS explore_bytes,
  s.tool_result_bytes                                  AS tool_bytes,
  ROUND(1.0 * s.explore_result_bytes
        / NULLIF(s.tool_result_bytes, 0), 3)           AS share,
  s.explore_breakdown                                  AS breakdown
FROM sessions s
WHERE s.explore_metric_version = 3;

-- The one row T67 reads. Bytes are summed before dividing, so a
-- twelve-byte session cannot weigh as much as a twelve-kilobyte one --
-- an average of per-session shares would let it.
CREATE VIEW IF NOT EXISTS v_exploration_summary AS
SELECT
  (SELECT COUNT(*) FROM sessions
    WHERE COALESCE(explore_metric_version, 1) = 1)     AS sessions_v1,
  (SELECT COUNT(*) FROM sessions
    WHERE explore_metric_version = 2)                  AS sessions_v2,
  COUNT(*)                                             AS sessions_v3,
  SUM(tool_calls)                                      AS tool_calls,
  SUM(explore_calls)                                   AS explore_calls,
  SUM(explore_bytes)                                   AS explore_bytes,
  SUM(tool_bytes)                                      AS tool_bytes,
  ROUND(1.0 * SUM(explore_bytes)
        / NULLIF(SUM(tool_bytes), 0), 3)               AS share
FROM v_exploration;
