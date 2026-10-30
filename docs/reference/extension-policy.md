# Lykos — Extension Policy and Intake Bar

**Companion to:** `docs/reference/cli-and-config.md`
**Status:** Living reference specification for evaluating, adopting, and scoping extensions.

---

## 0. Extension Principles

Lykos composes existing Pi runtime extensions where they fit, acting as:
1. **A measurement layer:** Tracking token throughput, cache utilization, and counterfactuals.
2. **A curation:** An opinionated, measured bundle.
3. **A policy layer:** Enforcing budgets, specialist defaults, and safety clamps.
4. **A contract:** Providing the MCP worker surface.

The risk of composing extensions is bloat: unnecessary schemas, unstable prompt prefixes, and hidden maintenance burdens. All third-party candidates must clear the six-point intake bar.

---

## 1. The Six-Point Intake Bar

An extension is adopted only if it clears **all** six criteria:

1. **Does not do something Lykos must own:** Measurement, budgets, model policy, and the MCP contract stay strictly in Lykos. An extension that computes cost is a reference to read, never a dependency to adopt.
2. **Known and acceptable schema cost:** Tool schemas reside in every request. An extension's resident schema tokens must be measured against the baseline hop-0 surface.
3. **Does not destabilize the cache prefix:** An extension must not inject dynamic timestamps, changing memory blocks, or reordered tools into the system prompt prefix.
4. **Can be scoped per role:** Specialist specialists require different tool surfaces. An extension that cannot be filtered or isolated per agent is disqualified.
5. **Maintained and appropriately licensed:** Pinned dependencies with verified open-source licenses and active upstream maintenance.
6. **Earns its place with a number:** A candidate must demonstrate empirical utility in real sessions via `lykos cost --compare` before being retained.

---

## 2. Adopted Extensions

- `@tintinweb/pi-subagents`: Subagent spawning and capability isolation.
- `pi-cache-optimizer`: Cache-stable prompt mutation and key stabilization (pinned v2.8.6).
- `pi-hashline-edit` (0.8.3, MIT): per-line `LINE#HASH:content` anchors, registering its own `read` and
  `edit` under Pi's tool names. **Not shipped, and never loaded (T168, ADR-0031).** Lykos has one editor:
  `read` numbers every line and `edit` is exact text replacement with `replaceAll`, both registered
  under the same two names. The extension is out of the shipped list and the scaffold, and boot drops
  it from a config that still declares it, with a one-line notice on stderr naming the ADR — see
  `withoutHashlineEdit()` in `lykos/config/extensions.ts`. It was rejected as an opt-in too. Re-adding
  line-anchored editing is a WISHLIST entry, to be revisited when the edit-failure count shows replace
  doing badly on a model Lykos uses.

---

**A declared Pi extension's tools reach the model (T155).** Pi drops any tool whose name is not on
the session's `tools:` allowlist, so an extension's `registerTool` would otherwise do nothing.
Declaring a Pi extension is consent for all of its tools: at boot, after Pi's resource loader has
loaded the declared extensions (each registers its tools while loading), every tool they registered
is admitted, in load order, to the one final tool list — so it is on the wire, in the frozen head's
`tools:` line and in the drift baseline alike. A read-only child still keeps only its read tools.
An extension switched off in config is not loaded and contributes nothing; one that loads inert
(`lykos-self-compact` under another strategy) registers nothing. A tool registered after boot
still has to pass the same allowlist, so the tool list never changes mid-session.

## 3. The Lykos Extension API

`lykos/extensions/api.ts`. Two surfaces, not a wrapper: Pi extensions keep loading through the
declaration path in `lykos/config/extensions.ts`, unchanged. The host exposes Lykos lifecycle events
and a pre-dispatch `tool_call` veto handler (mirroring Pi's `tool_call` event to allow extensions
like `lykos-seal` to veto operations before execution).

**Ten lifecycle events**, the moments Pi has no concept of: `post_edit_check`, `verification_verdict`,
`specialist_switch`, `budget_threshold`, `checkpoint_written`, `memory_injected`,
`approval_decided`, `task_list_changed`, `credential_rotated`, `session_end`. Each fires from the one place that
already computed its payload. `verification_verdict` carries `status`, `outcome`, `command` and `exitCode` (the gate command's own exit code), and, when the gate reran its failed test files (T167, ADR-0030), `rerun: { command, exitCode, flakyTests }` — the rerun's exit code and the tests that failed then passed, each `{ file, name, editedBySession }`. `flakyTests` is empty when the rerun failed too, and a flaky test with `editedBySession` is why `outcome` can be `fail` beside a rerun that passed. `credential_rotated` carries provider, from-label, to-label and
reason, never a secret (P14 ticket 06). A handler may return a promise; a rejection counts as a
failure like a throw.

**`session_end` (P4 T149)** fires once per top-level session, after the gate, from the session
owner (`session/session.ts`, `session/interactive.ts`). It carries the session id and model, how
the run ended (`done` / `aborted` / `error`), whether it changed a file (the gate's own test), the
gate's verdict in `verification_verdict`'s shape (`skipped` with a reason when the gate did not
run), a diff summary against the commit the session booted on (per-file `+`/`-` counts and a
bounded unified diff, untracked files included, `.lykos/` excluded), and the rendered task list.
It is delivered with `emitAndWait`: each handler is awaited in turn, so one can run a child
session. A child session fires none; its parent's covers the task.

**Three capabilities beside the events (P4 T149, T162):**

- `runChildSession({ prompt, model, label?, writable?, specialist? })` (P4 T149, T204) runs a
  child session and returns its final text (`ok`), or `blocked` / `error` / `unavailable` with a
  message — it never throws. The child is a real session with its own ledger row (`parent_session_id`
  the parent, `agent_role` `specialist ?? extension:<declared name>`). By default, it runs a
  **read-only child session**: read-only is enforced by the session, not asked of the model; its
  tools are cut to `read`, `grep`, `find`, `ls` (Pi's own read-only planner set); its gate is
  `ReadOnlyGate`, which refuses every non-read action whatever `--yes` said; the harness blocks on
  Pi's `tool_call` any call that changes a file or whose tier is not `read`, including a tool a Pi
  package registered; and it takes no checkpoints. When `writable` is true (T204), it runs a
  writable child gated as a spawned specialist under `specialist` (defaulting to `test-writer`),
  requiring a parent approval gate and inheriting the parent's read-only posture. A child session's
  extensions cannot start another (`unavailable`). Each call-time layer is proven alone against a
  real `write` (T161): a test-only boot option (`BootDeps.readOnlyChildTest`, which no configuration
  key, CLI flag or extension API reaches) puts `write` on the child's list and switches off either the
  harness, leaving the gate to refuse, or the gate, leaving the harness to. The gate's refusal says it
  is the read-only gate's rule, never that a human declined.
- `recordCounter(name, by = 1)` adds to the extension's own lower_snake_case counter for this
  session; the counters are written to the ledger's `extension_counters` under the extension's
  declared name at the session's end and printed by `lykos show`. A bad name or a negative or
  fractional amount throws and is counted as the extension's failure.
- `reportAtSessionEnd(text)` (T162) queues a short report for the person. When the session ends it
  is printed right after the gate's verdict — on stderr in a standalone run, in the conversation in
  the terminal UI — as `<declared name>: <text>`, later lines indented, in the order reports were
  made. Nothing is printed for an extension that made none. It is for a few lines; the full text
  belongs where `lykos show` reads it. Empty text throws. A child session's reports are not
  printed: its parent's end is the one the person sees.

**Registrations**: a tool, a slash command, or a gate check. A registered tool is a registry row with a
residency, a prompt presence and a risk tier, and it reaches `authorize()` like every other tool —
an extension hands over a function, never a tool definition, so there is no shape it can return
that skips the gate. **The tier an extension declares is a declaration a human can see, not a
promise the system trusts:** it is shown as extension-declared wherever it is rendered, and the gate
treats every extension tool as `hard-write`.

**Gate check contribution seam (T201, issue #56)**: an extension registers a gate check via
`api.registerGateCheck(check)`. The session gate runs every registered check after its own command
(and at session end for every session on a branch with an active seal, even if changes came only
through `bash`). A check handler receives context including session ID, cwd, ledger path, command outcome,
executor, and boot commit, and returns pass or block with a reason (`{ pass: true }` or `{ block: true, reason }`).
**The seam is block-only**: a block turns success into failure and records the reason in the ledger. A check
can never produce success: `runVerify` stays the only writer of `outcome = 'success'`.

**A tool that changes files (T156)** declares `changesFiles: true`. Its calls are then edits exactly
as a built-in's are: the post-edit loop runs after each, the gate grades the session, and the edit
counters and `edited_files` count it. A tool that declares nothing is still caught: its gated wrapper
takes the git working tree's fingerprint (tracked plus untracked-but-not-ignored, through a scratch
index) before and after the call. Either way the verdict rides the call's own result
(`details.lykosFilesChanged: true`), which `isFileChangingCall` reads — never a process-wide table
of tool names, so two sessions in one process cannot see each other's extensions. An undeclared
tool that wrote nothing is not counted. Outside a git repository an undeclared tool's calls cannot
be checked and are not counted; the session says so once, naming the tool. The turn's checkpoint is
taken before any Lykos extension tool's call, declared or not, as before any built-in edit.

**A throwing extension is reported and counted, not swallowed** — its name, the event and the
message, on a counter the session prints at the end.

**Registering an interface surface is designed for and refuses.** The entry point exists so that
adding it later is additive; an extension that can draw interface is an extension that can break a
product surface.

**The escape hatch: anything this API does not cover, write a Pi extension and Lykos will load it.**

### Declaring a Lykos extension in `config.yaml`

`lykos_extensions:` (T147, backlog D25) is the Pi list's twin: the same `{ name, version, scope }`
entries, validated by the same `resolveExtensions` (exact version, legal package name, no
duplicates, order is load order), resolved to the same `<pi-host>/npm/node_modules/<name>`,
reported by the same stderr notice when declared but absent (`lykos extensions DECLARED BUT NOT
INSTALLED on this host: …`), reconciled by `lykos doctor`, and installed by the host install path
below. `lykos/extensions/load.ts` is the only new part:

- **Entry**, Pi's rule with Pi's key swapped for ours: `package.json` `"lykos": { "extensions":
  ["./main.js"] }`, else `index.ts`, else `index.js`. One package can carry a Pi half under `"pi"`
  and a Lykos half under `"lykos"`.
- **Export**: the module's default export is either `register(api)` or an object with
  `register(api)`. The declared name, not anything the module says, is the extension's name on the
  host and in the failure count.
- **Import** is native `import()`, so ship `.js`: Node does not strip types under `node_modules`.
- **When**: at boot, straight after the extension host exists and before the first event fires or
  the tool list is assembled. A resident tool joins the boot tool array; a mounted one (the
  default) is reachable through `tool_call`. Neither changes mid-session.
- **Failure**: no entry file, an import that throws, or an export that is not an extension is
  recorded on the host's failure ledger (site `load`), printed at session end, and the session
  carries on with the extensions after it.

Only standalone and interactive sessions run the Lykos extension host; the delegate container does
not load this list.

### Installing a declared extension on the host

The declaration surface resolves paths per machine and reports a declared-but-missing package;
installation was the container image's job and the machine a person sits at has no image.
`lykos/extensions/host-install.ts` closes that gap: it runs the image's own
`npm install --prefix <agent dir>/npm --no-fund --no-audit <name>@<version>`, against this
machine's agent directory rather than the container path, at the declaration's exact version, and
it fails loudly — a zero exit that left the package absent is reported as a failure, not a success.

Its caller is `lykos extensions install` (T164). It installs every declared-but-missing hop-0
extension from both lists, `extensions:` first, each in declaration order, and stops at the first
failure; a second run with nothing missing runs nothing. A default extension at Lykos's own version
is never installed — it resolves inside the package — while the same name pinned at another version
is an ordinary package and installs like one. `lykos extensions list` prints every declared
extension with the list it came from, its version, whether it is installed on this host, and
whether it is a default. The session-start notice and `lykos doctor`'s missing-extension rows name
`lykos extensions install`. Nothing ever installs on its own.

---

## 4. Default Extensions

A **default extension** (see `GLOSSARY.md`) ships inside Lykos's own package, carries the `lykos-`
prefix, uses only an API a third party could use, and is switched only by its entry in the extension
list, like any other extension (ADR-0028). Most are declared in the shipped configuration; one may
ship off — absent from the shipped list — until a project lists it. The gate is never one. They live in `lykos/extensions/defaults/`; the table in
`index.ts` names each one and the API it is written against (`pi` or `lykos`).

**Declared, and removed, the ordinary way.** A default Pi extension is an entry in the shipped
`extensions:` list at **Lykos's own package version**. Switching it off is writing an `extensions:`
list without it, exactly as for a third-party package; the list replaces, it does not merge. A
default extension's entry may **omit `version`**, which means the build that ships with this Lykos
— so a project's list keeps loading it across a Lykos upgrade. Every other entry still needs an
exact version. `lykos init` scaffolds a list that names the shipped defaults this way, with
`lykos-repo-map` commented out.

**Resolved from the package.** `resolveHostExtensions` asks `defaultExtensionPath` first: a
declaration naming a default extension, at the package version, in the list its API belongs to,
resolves to the file inside Lykos (`.ts` in the source tree, `.js` in `dist/`, which `npm run
build` emits). Anything else — including the same name pinned at another version — resolves to the
machine's install tree like any package, so a separately published build can still be pinned on
purpose. A default extension runs on the host with the session; only its commands run in the
container (ADR-0036).

### `lykos-repo-map`

The T69 repo map, moved out of the head blocks into a Pi extension
(`lykos/extensions/defaults/lykos-repo-map.ts`). It uses Pi's public `before_agent_start` hook to
append the outline to the assembled system prompt — the same mechanism as Pi's
`examples/extensions/claude-rules.ts` — plus `appendEntry` to record what it added, which is what
the ledger's `repo_map_*` columns and `flag_retrieval` now read. The map is built once, on the
first model request, and the same bytes are appended on every later one, so the prompt never
changes mid-session and stays cacheable. It is appended last, after every Lykos head block. Outside a git repository, or on a machine without
git, the map is empty: it is built from `git ls-files`, run through the host git helper with hooks and
fsmonitor off (T170), and the session prints one notice saying which of the two it is.

It **ships off** (ADR-0028, T158): it is not in the shipped `extensions:` list, and its entry in a
project's list is its only switch — listed, it adds the map; unlisted, it is not loaded.
`flags.retrieval` no longer controls it and `LYKOS_REPO_MAP` is not read. Its parameters stay under
`retrieval.repo_map`, handed to it by `LYKOS_REPO_MAP_POLICY` at boot. This repository lists it in
`.lykos/config.yaml`; because the list replaces rather than merges, that list names the shipped
extensions too.

### `lykos-reviewer`

The T110 reviewer that did not write the code, now a **Lykos** extension
(`lykos/extensions/defaults/lykos-reviewer.ts`), declared in the shipped `lykos_extensions:` list
and written only against `session_end`, `runChildSession`, `recordCounter` and
`reportAtSessionEnd` — it imports nothing
from Lykos's session, gate or ledger. On `session_end` for a session that finished and edited
files, it runs one read-only child session whose whole input is the diff, the task list and the
gate's verdict (never the parent's transcript), counts the `FINDING:` lines it returns, and records
`invocations`, `findings` and `failures`; when it declines to run it records why
(`skipped_no_edits`, `skipped_no_diff`, `skipped_unfinished`). It is advisory: it runs after the
gate, and the API has no way to write an outcome. `lykos show <session>` prints whether it ran, on
which model, and the child's findings. At the session's end, right after the gate's verdict, it
reports the number of findings and the first three (with the `lykos show` command for the rest),
that it found nothing, or in one line why it did not run — including, on an edited session, that
its setting is off. The old in-core path (`loop/reviewer.ts`) is deleted.

Its setting is `reviewer: { enabled, model }`, handed to it by `LYKOS_REVIEWER_POLICY` at boot;
`model` empty means the reviewed session's own model. Shipped **off**; this repository turns it on
in `.lykos/config.yaml`. Switched off by the setting or by a `lykos_extensions:` list without it.
Pi's own `examples/extensions/subagent` ships a reviewer agent too, but as a separate `pi` process
with `bash` on its surface — which can write — so it is not read-only and is not adopted.

### `lykos-continuation`

The T109 continuation, moved out of the `lykos-harness` inline extension into a Pi extension
(`lykos/extensions/defaults/lykos-continuation.ts`). It is the `continue` value of the **context
strategy** (`context_strategy`, `lykos/loop/context-strategy.ts`), and it is declared everywhere
but inert unless that strategy is the active one — exactly one strategy runs in a session. On Pi's
public `turn_end` it reads `ctx.getContextUsage()` (the watch Pi's own
`examples/extensions/trigger-compact.ts` uses); once the share reaches `compaction.threshold` it
records the crossing with `appendEntry` and calls `ctx.abort()`, before Pi's next request and
before Pi's own threshold compaction. Whether a successor starts is still the session owner's call
(`decideContinuation`: the gate, the persisted task list, `continuation.max`, and the stagnation
brake), because an extension cannot start a session; the owner reads the crossing back from the
session's entries. Its policy crosses to it by `LYKOS_CONTINUATION_POLICY` at boot.

Pi's compaction is never switched off by any strategy. If `continue` is chosen but this extension is
not declared, or `self-compact` is chosen without `lykos-self-compact` declared (or on a model below
its smallest tier), the session falls back to `pi` and prints one line saying so. Pi's `examples/extensions/handoff.ts` is the nearest thing Pi ships; it
hands off by a model-written summary on a human's command, where continuation hands off from disk
facts at a measured threshold, so it is not adopted.

### `lykos-self-compact`

The `self-compact` value of the context strategy (`lykos/extensions/defaults/lykos-self-compact.ts`,
pure rules in `lykos/loop/self-compact.ts`). **Part 1, the gauge (T151)**: the agent sees its own
context filling. On Pi's public `context` event — which hands an extension the messages of one
provider request and uses what it returns for that request only — it reads `ctx.getContextUsage()`
and `ctx.model`, looks up the thresholds (`self_compact.tiers`, then a `models` override, then a
`specialists` override), and when the window first reaches the notice or the warning line it
appends one message of guidance to that call. The message is never appended to the session, so the
history and the cached prefix are untouched (CLAUDE.md rule 9); a fall in usage (a compaction)
re-arms the lines. The cutoff line gets one message too, saying only `self_compact` runs now. Its
prompts are read from `.lykos/prompts/self-compact/` (project, then home) and default to shipped text.

**Part 2, the handoff (T152).** `self_compact({ note })` records the note with `appendEntry` and the
turn that called it ends at `turn_end` (`ctx.abort()`, as continuation does), so no further model
call is made on the full context. At `agent_settled` the extension compacts through `ctx.compact()`
(Pi's summariser, told the note will follow) and then sends the note back with `pi.sendMessage` as
a custom message whose second text block is the note byte for byte; that message starts the next
turn. Past the cutoff a `tool_call` handler refuses every other tool with a reason naming
`self_compact`. A failed compaction is retried up to three times in a row; a cancelled one, or one
that failed every attempt, leaves the note pending for the next idle moment; one Pi declines as
unnecessary ("Nothing to compact") ends the handoff by returning the note. **`/self-compact`**
(`pi.registerCommand`) asks the agent to write its note and compact now, or retries a pending
compaction; in the TUI it is typed like any prompt and Pi dispatches it (it is not offered by Tab).

**The note has fixed sections (T189).** The note is written under six `##` headings, a handoff
document: Goal, Constraints & Preferences, Progress (Done, In Progress,
Pending), Key Decisions, Critical Context, Next Steps. `loop/self-compact-template.ts` owns the list,
the skeleton and the full handoff prompt (instructions plus skeleton) that the side call loads; the
warning, cutoff and command prompts and the tool descriptions are built from it. A note missing
sections is never refused: it is saved and returned word for word, and its handoff record carries
`missing_sections`, the names of the sections no heading in it matches (exact name, case and heading
level ignored). The field is absent when none is missing.

**Resume.** The host copies every record to `self-compact.jsonl` in the session directory as it is
appended (Pi's `entry_appended`). `lykos resume` re-appends an unfinished handoff to the resumed
session's entries before its first turn; the extension finds it with `getEntries()` and returns the
note once, with the first message, recording it `delivered` (`via: "resume"`) so a later resume
does not return it again. The resumed context is rebuilt from disk, so no compaction is run or
recorded for it. The delivered note is also a `self_compact_note` transcript event, which a replay
carries unclipped.

**The ledger.** Each compaction attempt — the handoff's, and Pi's own while this strategy is active
— is a record the host writes to the `compactions` table at the session's end (telemetry.md §2.1).

It registers two tools with Pi's `registerTool`, **`self_compact`** (above) and **`context_usage`** (no arguments; returns tokens,
window, percent, tier, the thresholds and where they came from, and the level). Pi drops any tool
whose name is not on the session's `tools:` allowlist; both reach the model through the general
admission of every declared Pi extension's tools (§2, T155) — there is no by-name case — and `ledger/tool-catalog.ts`
carries both schemas so the schema tax stays measured. Its policy crosses by `LYKOS_SELF_COMPACT_POLICY`;
it is enabled only when `self-compact` is the active strategy of a top-level session on a model whose
window reaches the smallest tier, and otherwise loads inert with no handler and no tool.

It is the shipped default strategy and this repository's (`.lykos/config.yaml`); the gauge and the
full handoff cycle are proven through the scripted-model session (`cli/scripted-self-compact.test.ts`,
`cli/scripted-self-compact-handoff.test.ts`). The table is
validated at every startup regardless of strategy, and a wrong value refuses the session by name.
The design follows `disler/self-compact-pi-agent` (no code copied); Lykos takes its thresholds from
a tier table in `config.yaml` rather than a flat percentage.

### `lykos-seal`

The sealed TDD default extension (`lykos/extensions/defaults/lykos-seal.ts`, ADR-0034, T199, T208).
It hooks pre-dispatch tool calls to veto edits to sealed test files by specialists in
`seal.enforce_for`.

Through `SealAllowanceGate` (T199, T208), it allows test execution and dispute operations without human confirmation:
- In all permission modes except plan, specialists in `seal.writers` and `seal.enforce_for` are allowed the test command matching the active seal's recorded template on test files.
- When no active seal exists, specialists in `seal.writers` are allowed the resolved `seal.test_command` template from configuration.
- Single-command PowerShell requests are allowed under the same token rules as Bash (rejecting command separators, pipelines, redirects, backticks, or subexpressions).
- Specialists in `seal.enforce_for` are allowed the `dispute_test` tool from `lykos-seal` in all non-plan modes.

