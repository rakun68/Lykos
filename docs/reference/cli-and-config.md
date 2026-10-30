# Lykos — CLI & Configuration Reference

**Companion to:** `docs/reference/telemetry.md`
**Status:** Living reference specification for the CLI and configuration system.

---

## 0. Filesystem & State Layout

Lykos stores all local runtime state inside `.lykos/` at the repository root and `~/.lykos/` globally.
It never writes its own state to `.pi/`.

```text
~/.lykos/
  config.yaml                  User global configuration overrides
  projects.json                Registry of known projects and roots

.lykos/                        Project-local state (gitignored except tracked policies)
  config.yaml                  Project configuration overrides
  ledger.db                    SQLite telemetry ledger (WAL mode)
  today.json                   Ephemeral daily spend cache
  history.json                 Interactive composer prompt history
  memory/
    failed-approaches.md       Active human-accepted mistake memories
    proposals.jsonl            Agent-proposed memory queue
  sessions/<session-id>/
    meta.json                  Session metadata, runtime, and git state
    transcript.jsonl           Append-only event transcript
    live.json                  Live heartbeat and spend snapshot
    artifacts/                 Spilled outputs, diffs, and verification logs
```

---

## 1. CLI Commands

The `lykos` executable provides the following commands:

| Command | Purpose |
|---|---|
| `init` | Initialize `.lykos/` in current directory and register in `~/.lykos/projects.json` |
| `doctor` | Local verification of declared extensions, auth, ledger, and configuration, and of the container runtime containment would use: each candidate's version, and whether the first that answers can start a container with memory and cpu limits using the arguments a session uses (a runtime that is absent is a warning, a failure under `containment.level: required`; an invalid `containment.runtime` is a failing check). On Windows a Podman machine that is rootless or not on the `cgroupfs` manager gets the fix printed (T178; containers/podman#29749, microsoft/WSL#41492). It fails with "git is not installed" when no `git` binary is on `PATH`, since checkpoints, project identity, the repo map and `commit` all need one (T170, T179). It also reports, among other things, how many flaky tests the session gate has recorded (a warning, never a failure; T167) |
| `run <prompt>` | Execute a prompt as a delegated session (flags: `--interactive`, `--yes`, `--model`, `--tools`, `--budget`, `--containment off|auto|required`, `--network open|none`, `--mode manual|accept-edits|auto`, `--in-place`, `--task`, `--specialist`, `--output-style`, `--subagents`, `--trust-workspace`). A delegated session is the standalone session (same boot, gate, extensions, P4 mechanisms, ledger and credential pool) whose containment defaults to `off`; the `--interactive` conversation defaults to `off`. Containment resolves from `--containment`, the specialist, project config, user config, then that default (the parent session joins after the argument with `spawn`, T182, #35). A level below `containment.minimum` is refused before boot, naming the floor and the file that set it. The output ends with the level used and the runtime (`containment: auto in docker 29.6.2, image ...`, or `containment: off (commands ran on this machine)`). `--shape` is retired (T185, #38): it is refused with a message pointing here, and `--containment off` is what `--shape standalone` did. `--containment` and `--network` are refused by `--interactive` (exit 1), which takes `containment.level` and `containment.network` from config. A delegated session runs in an explicit permission mode (`--mode`, default `auto`: `manual`, `accept-edits`, `auto`; ADR-0041). A read-only session (e.g. `readOnly: true` or review specialist) gets a read-only mount. `auto` approves its writes with nobody to ask, because the session works on a worktree and `lykos/` branch of its own (T184, #37): the output names the branch and its commits, and the caller's tree is not touched. `--in-place` writes in the caller's tree instead. Outside a git repository a writing session is refused unless `--in-place` is set, which writes with no commits. An MCP call starts the same session with the mode its tool names (`docs/reference/mcp.md`). `--in-place` is refused by `--interactive` (which operates on the working tree directly). `--mode` is accepted with `--interactive` and persists as the project's permission mode (ADR-0041). `lykos init` leaves `containment.level` unset; a project that already carries `level: off` keeps it only when the user store trusts the project (#49), and otherwise a delegated session ignores it and keeps the level the user's layers give (the delegated default `auto` when they name none). The task can also come from `@path` files (each added as Pi's `<file name="…">` block) and piped stdin (read for a lone `-`, or when stdin is a pipe and nothing else gave a task), in the order stdin, files, argument; after `--` the next argument is the task verbatim. On Windows a multi-line task goes in as `@task.md`: a `.cmd` launcher (`npm run`, `npx`, `lykos.cmd`) cuts an argument at its first newline and drops the rest (`lykos/cli/brief.ts`) |
| `mcp` | Start Lykos as an MCP worker server over standard IO. Each tool call runs a delegated session (the one `lykos run` starts) in a `lykos session-child` process of its own, so a crash or a stray write cannot reach the server or its stdout. The four tools keep their names and `brief`; inputs gain `containment`, `session_id` and `write_in_place`, results gain `containment`, `runtime`, `branch`, `commits`, `write_in_place`, `note`, `skipped_extensions` and `denied`; progress streams as MCP notifications. [mcp.md](mcp.md) is the contract |
| `session-child` | Internal: the process one MCP call runs in. It reads one JSON request line on stdin and subsequent steer lines, and writes JSON progress, question, and result lines on stdout. Not for typing; started by `lykos mcp` |
| `show <session-id>` | Print or inspect an archived session transcript, with the gate's command, verdict, exit code, the flaky tests its rerun found (and whether the session edited their file) and a bounded output excerpt, which credential served the session's calls per provider (`pool credential <label>`, or `no pool credential (<auth mode>)` for a key from outside Lykos's pool, from the ledger's `calls` rows; `--json` carries `credentials`; T186), the commits the session made through `commit` (short id, subject and file count, `files unmeasured` where the count could not be taken; `--json` carries `commits` with the id as recorded - the full id, or the abbreviated one git printed when the full one could not be read - the message and files changed or null; T179), and the turns that changed files with the checkpoint before each (a turn with none is flagged missing; a delegated session's removed worktree falls back to the repository holding the ledger, where the checkpoint ref lives); each post-edit run with the text the model saw on failure; the `edit` tool's calls, successes and failures with the post-edit failures per successful edit (`edit calls`), and its failures by reason (`edit fails`: `not_found`, `not_unique`, `overlap`, `unread`, `stale`, `other`, the non-zero ones; `unmeasured` where the transcript cannot say, T168); seal events from the session and its child sessions (`--json` carries `seal_events`); and the task list as the session left it |
| `resume <session-id>` | Resume an existing session, continuing its conversation transcript |
| `sessions` | Interactive session picker / listing |
| `task [subcommand]` | List, show, or close project tasks (`lykos task list`, `lykos task close`) |
| `search <query>` | Substring search across archived session transcripts |
| `archive` | Compress historical sessions past retention hint |
| `verify` | Run configured gate verification command and record outcome |
| `extensions [list\|install]` | `list` shows every extension declared in `extensions:` and `lykos_extensions:`, which list it came from, its version, whether it is installed on this host, and whether it is a default extension shipped inside Lykos. `install` installs every declared-but-missing one at its exact version into the Pi host directory; defaults are never installed, and a second run does nothing |
| `rewind` | Git checkpoint inspection and rollback; each checkpoint is listed with its hash and the session and turn it belongs to. `lykos rewind <hash>` restores by any unambiguous hash prefix of at least 4 characters; `lykos rewind <n>` by index (0 is the newest), which shifts as checkpoints are written. An unknown or ambiguous hash restores nothing |
| `seal [subcommand]` | Sealed TDD operations: `key init` (generate Ed25519 keypair, commit public key at `.lykos/seals/keys/<key_id>.pub`, save private key to `~/.lykos/seal-keys/<key_id>.pem`), `create [<commit>] [--branch <name>]` (verify all sealed tests fail with assertion failures in clean worktree using detected reporter adapter (`node:test`, `vitest`, or the weaker exit-code fallback), prune merged seal files whose seal commit is reachable from base and supersede active seals in history whose tests changed, commit `.lykos/seals/<branch>.json`, record ledger event), `status [--branch <name>] [--json]` (verify active seals against committed public keys and check for staleness/tampering), `verify [--branch <name>] [--commit <sha>]` (verify active seals via git and signature checks only, exit non-zero on tampering, and record verified/tampered ledger event), and `hook install` (install or update a Git `pre-push` hook running `lykos seal verify` for every pushed ref without overwriting custom hooks) |
| `cost` | Rollup and analysis of session costs (`--since`, `--compare`, `--by`) |
| `tools` | Tool registry, measured schema cost and measured dispatch counts (`--since`). Reports only — it demotes nothing, and a window with no data reads `unmeasured` rather than `0` |
| `hud` | Render one-shot HUD statusline or diagnostics (`hud --statusline`) |
| `watch` | Terminal full-screen monitoring surface |
| `theme` | Preview and inspect terminal UI color themes |
| `agents` | List or inspect specialist agent markdown definitions |
| `export claude [--global]` | Export exposed specialists as Claude Code agents: writes a marked Haiku shim per specialist whose effective role is subagent or all (an absent role means all; project beating user beating shipped; only primary is hidden) to `<agents>/lykos-<name>.md`, delegating to MCP tool `mcp__lykos__lykos_<name>` and returning the tool's result unchanged. Specialist names are sanitized to MCP tool names (`specialistToolName`); when multiple specialists sanitize to the same tool name, exact raw name matching the sanitized suffix wins first, otherwise alphabetical precedence (`localeCompare`), keeping collision losers silent. Specialists colliding with reserved async tools (`lykos_start`, `lykos_status`, `lykos_steer`, `lykos_stop`) are omitted with a warning to stderr matching `lykos mcp`. Project scope writes to `<cwd>/.claude/agents/` and adds `mcpServers.lykos` to `<cwd>/.mcp.json` (preserving other entries, creating if missing, refusing unparseable JSON without overwriting). `--global` writes to `~/.claude/agents/`, never touches `~/.claude.json` or project files, and prints the user-scope `claude mcp add` command. An unmarked `lykos-*.md` file is never overwritten (refused, named on stderr, exit 1 while writing remaining files) and never deleted. Re-running regenerates marked files from current specialists and prunes stale marked shims whose specialist is no longer exposed (including now-ineligible reserved tools) |
| `budget [show\|set]` | Show current caps or set cap values in `.lykos/config.yaml` |
| `memory [list\|add\|forget]` | Manage project mistake memory entries |
| `prompt --show` | Display the assembled system prompt head block and tool schemas (flags: `--specialist`, `--output-style`, `--context`, `--tools`, `--subagents`, `--json`); also prints the specialist stream message in its own labelled section (ADR-0044) |
| `version` / `--version` | Print Lykos version and pinned Pi runtime version |
| `help` / `-h` | Display usage and command help |

---

## 2. Configuration Precedence

Configuration resolves across six distinct layers (evaluated in ascending order):

1. **Shipped Defaults:** Compiled in `lykos/config/defaults.ts`.
2. **Global Config:** `~/.lykos/config.yaml`.
3. **Project Config:** `.lykos/config.yaml`.
4. **Specialist Config:** Selected specialist layer (instructions, read_only, tool limits).
5. **Environment Variables:** Documented override variables.
6. **CLI Flags:** Explicit command-line arguments.

For `containment.image` only, the global image does not rank by layer: it sits below the project's
`.devcontainer/devcontainer.json` (specialist, project config, devcontainer, global config, default).

Sections are merged **key-by-key**. A higher layer that specifies `budget.per_run_usd` leaves the lower
layer's `budget.per_day_usd` intact rather than wiping the section.

### 2.1 Output Styles Precedence (ADR-0045)

Output styles resolve independently of `config.yaml`, discovered by filename (`<name>.md`):

1. **Shipped:** `lykos/output-styles/<name>.md` (compiled into `dist/output-styles/`).
2. **Global:** `<globalDir>/output-styles/<name>.md` (default: `~/.lykos/output-styles/`).
3. **Project:** `.lykos/output-styles/<name>.md`.

Precedence is `shipped < global < project`. The active output style is named by `output_style` in `config.yaml`, overridden by `--output-style <name>` on `lykos run` and `lykos prompt`, or switched mid-session via `/output-style [name]`.

### 2.2 Permissions and Permission Modes (ADR-0041, ADR-0057, T209)

Permission modes (`manual`, `accept-edits`, `auto`) persist per project in `~/.lykos/permissions.json` (keyed by project ID).
On first run for a project, the permission mode defaults to **Manual**.

- **Manual**: runs reads without asking; asks before edits, writes, and commands.
- **Accept Edits**: runs reads, file writes, edits, and file operations (`mkdir`, `touch`, `mv`, `cp`) without asking; asks before removals and commands.
- **Auto**: runs reads, file writes, edits, read-only commands, the session's own non-destructive verification command (ADR-0057), and remembered patterns without asking; asks once before other ordinary commands to offer remembering the pattern; always asks before destructive commands.

**Permission modes cannot be set in `config.yaml`**. Setting `mode` or `permissions.mode` in global or project `config.yaml` is rejected during configuration loading with an error directing the user to `/permissions` or `--mode`.

In interactive sessions, the `/permissions` slash command (and `/mode`) manages project permissions:
- `/permissions`: bare shows the live mode, outside access rules, extra allowed directories, remembered command approvals, and path rules enforcement status (`path rules: enforced for file tools; commands <enforced|best effort>`).
- `/permissions mode <manual|accept-edits|auto>`: set and persist the project's permission mode.
- `/permissions outside <read|write> <ask|allow|deny>`: set and persist rule for access outside project root.
- `/permissions dir <add|remove> <path>`: add or remove an extra allowed directory for this project.
- `/permissions revoke <pattern|all>`: revoke remembered command approvals for this project.
- `Shift+Tab` is reserved and no longer cycles modes (reserved for specialist cycling in T216).

---

## 3. Configuration Keys (`config.yaml`)

```yaml
version: "0.1.0"

# Third-party Pi extension declarations
extensions:
  - name: "pi-cache-optimizer"
    version: "2.8.6"
    scope: ["hop0"]
  - name: "lykos-repo-map"     # a default extension: ships in Lykos, at its version; omit it to switch it off
    version: "0.0.1"
  - name: "lykos-continuation" # a default extension: the `continue` context strategy (extension-policy.md §4)
    version: "0.0.1"
  - name: "lykos-self-compact" # a default extension: the `self-compact` context strategy (extension-policy.md §4)
    version: "0.0.1"

# Lykos extension declarations (T147) — packages written against Lykos's own
# extension API (docs/reference/extension-policy.md §3). Same entry shape and
# rules as `extensions:`: exact versions, order is load order, a layer that sets
# the list replaces it. Shipped with the default `lykos-reviewer` (T149); a list
# without it switches the reviewer off.
lykos_extensions:
  - name: "lykos-reviewer"     # a default extension: ships in Lykos, at its version
    version: "0.0.1"
  - name: "my-lykos-ext"
    version: "1.0.0"
    scope: ["hop0"]           # optional, default [hop0]

# Providers configuration
providers:
  deepseek:
    auth_mode: "api_key"
  anthropic:
    auth_mode: "api_key"

# Models and routing defaults
models:
  default: "deepseek/deepseek-v4-flash"
  roles:
    scout: "deepseek/deepseek-v4-flash"
    worker: "deepseek/deepseek-v4-pro"
  fallback: []

# Spending limits
budget:
  per_run_usd: 0.50
  per_day_usd: 5.00
  max_concurrent_delegates: 3
  on_exceed: "stop"           # "stop" | "warn" | "downgrade"

# Telemetry destinations
telemetry:
  hud: true
  ledger: ".lykos/ledger.db"
  prices: "builtin"

# Architectural mechanism flags
flags:
  delegation: true
  retrieval: false            # the setting of the lykos-repo-map default extension (extension-policy.md §4)
  proactive_compaction: true
  routing: false
  draft_verify: false
  cache_stable_head: true
  output_diet: true

# Compaction settings. `threshold` is a share of the model's context window:
# where `continue` stops and what the context-budget notice names. The old
# snip knobs (`snip_after_turns`, `snip_max_bytes`) are gone: the host's
# snip-then-prune module was deleted (backlog X1) and the delegate container
# that still read them is deleted with the rest of the old path (T185).
# `supersede_reads` overwrites an earlier `read` result that a newer read of the
# same file has made stale (a selector-free read supersedes a ranged one, never
# the reverse); `drop_useless` overwrites a result whose tool flagged it useless
# (`details.useless: true`; `lsp` sets it on an empty lookup). Both are on by
# default and prompt-cache-guarded: a result is rewritten only when at most
# 8 000 tokens follow it, or once the last model response is older than the
# cache retention plus a minute's margin. Retention: 5 minutes on the Anthropic
# api and 1 hour elsewhere; with `PI_CACHE_RETENTION=long`, 1 hour on Anthropic
# and 24 hours elsewhere. The rules run in the `lykos-prune` default extension:
# its entry in `extensions:` is its only on/off switch. See ADR-0039.
# `method_order` is the compaction methods in the order they are tried when a
# compaction runs, each falling through to the next when it fails or has nothing
# to give: `note` (the compaction an agent's `self_compact` note asked for),
# `handoff` (a side call, with no tools and the live turn's cache key, that
# writes the note from the template when Pi compacts and the agent left none),
# `shake` (drops old tool results, no model call) and `summary` (Pi's own
# summary, always the end whether listed or not). Unknown names are ignored,
# with a line on stderr. It runs in `lykos-self-compact`, so it applies where
# self-compact is the active context strategy. See ADR-0040.
compaction:
  threshold: 0.8
  supersede_reads: true
  drop_useless: true
  method_order: [note, handoff, shake, summary]

# Repository map retrieval
retrieval:
  repo_map:
    max_tokens: 1500
    max_files_per_dir: 6

# Post-edit feedback loop
feedback:
  enabled: true
  command: ""                 # auto-discovered if empty (e.g. npm run typecheck)
  timeout_seconds: 120
  max_output_bytes: 4000
  slow_disable_seconds: 45

# Verification gate (outcome='success' writer)
gate:
  enabled: true
  command: ""                 # auto-discovered if empty (e.g. npm test)
  timeout_seconds: 900        # T176: a run past it is killed (SIGTERM) and recorded as fail, exit code 143, never NULL
  gate_read_only_sessions: false
  rerun_failures: true        # T167, ADR-0030: rerun only the failed test files, once; false turns it off
  rerun_command: ""           # e.g. "npx vitest run {files}"; empty derives one from a node/tsx --test script

# Skills. No cap by default (ADR-0029): set max: N to load only the first N discovered
skills:
  enabled: true

# T217 (ADR-0045): output style name ("default", "minimal", etc.)
output_style: "default"

# T168 (ADR-0031): one editor, exact text replacement, and `read` numbers every line. `edit.mode` was
# removed; a config that still sets it fails to load, naming the key. The one key left:
edit:
  require_read: false         # true: `edit` and `write` to an existing file are rejected unless this
                              # session has read it (a partial read counts) and it has not changed since
                              # that read or since the session's own last edit/write of it. A new file is
                              # exempt. Rejected before the approval gate, with nothing written. Must be
                              # a boolean. No specialist key: specialists inherit it.

# Web search provider (P10.7, ticket 24). Shipped as `auto`, which needs no key:
#   1. brave       — only if BRAVE_SEARCH_API_KEY is set
#   2. perplexity  — only if a Perplexity key is in the credential pool or PERPLEXITY_API_KEY
#   3. exa         — Exa's hosted MCP endpoint, https://mcp.exa.ai/mcp; keyless,
#                    or with EXA_API_KEY if that is set
#   4. duckduckgo  — DuckDuckGo's no-JS results page, https://html.duckduckgo.com/html/
# A backend that fails (network error, timeout, non-2xx, a challenge page, zero
# usable results, or a gate denial) hands the query to the next; the result
# says which backend answered ("via exa"), and if all fail it lists each
# one's reason. Every host is put to the gate as a network read before it is
# contacted. Results are titles, URLs and snippets only — nothing is summarised.
# `auto` has no endpoint or key variable of its own; `endpoint` and `key_env`
# apply to an explicit provider — "brave", "perplexity", "exa" or "duckduckgo" —
# which uses only that backend. An explicit brave or perplexity with no key
# answers with a sentence naming these settings and sends nothing, as before.
# The key itself is never written here, only the name of the variable that holds it.
web:
  search:
    provider: "auto"          # "auto" | "brave" | "perplexity" | "exa" | "duckduckgo"
    endpoint: ""              # explicit provider only; e.g. "https://api.search.brave.com/res/v1/web/search"
    key_env: ""               # explicit provider only; e.g. "BRAVE_SEARCH_API_KEY"

# The context strategy (T150): what a session does as its window fills.
# Exactly one runs; Pi's own compaction stays underneath all three as the last
# resort (it fires at contextWindow - reserveTokens, Pi's own setting).
#   self-compact  the agent writes its own note to self and compacts (the
#                 default, and this repository's). Needs lykos-self-compact
#                 declared. Gauge (T151) and handoff (T152): past the cutoff
#                 only the self_compact tool runs; it saves the note, compacts
#                 once the turn ends, and returns the note word for word.
#                 `/self-compact` asks for it now. Below the smallest tier of
#                 self_compact.tiers it is off: `pi`, said.
#   continue      the lykos-continuation default extension stops the session at
#                 compaction.threshold; if the gate is not green, the task list
#                 has open items and the session moved, a fresh session
#                 continues from disk. Needs lykos-continuation declared, or
#                 it falls back to `pi` and says so.
#   pi            Pi's own compaction only.
# An unknown value also falls back to `pi` and says so.
context_strategy: "self-compact"

# self-compact's thresholds (T151), by the model's context-window tier: a
# window uses the largest tier at or below it; below the smallest, self-compact
# is off. Token counts are integers or decimal "64k" / "1M" strings. Validated
# at startup whatever the strategy: rows smallest window first, notice <
# warning < cutoff <= window in every row, and no larger tier compacting earlier
# than a smaller one — a wrong value refuses the session, naming itself.
# `tiers` replaces the whole table when a layer sets it; `models` (keyed
# "provider/model" or the bare id) and `specialists` (keyed by name) merge by
# key and each take a whole notice/warning/cutoff triple. A specialist's beats
# a model's, which beats the tier. Every shipped value is unmeasured.
# At the notice, warning and cutoff lines the next model call carries one
# message of guidance, dropped after that call; .lykos/prompts/self-compact/
# notice.md, warning.md and cutoff.md (project, then home) replace the shipped
# text, with {tokens} {window} {tier} {notice} {warning} {cutoff} filled in;
# command.md replaces what /self-compact sends ({request} is what was typed
# after it). The agent's `context_usage` tool reports tokens, window, tier and
# thresholds. Past the cutoff every tool but `self_compact` is refused with a
# reason naming it. A failed compaction is retried (3 attempts in a row); a
# cancelled one, or one that failed every attempt, keeps the note and is tried
# again at the next idle moment. Each attempt is a row in the ledger's
# `compactions` table (telemetry.md §2.1).
self_compact:
  tiers:
    - { window: 64k,  notice: 24k,  warning: 32k,  cutoff: 44k }
    - { window: 128k, notice: 30k,  warning: 60k,  cutoff: 90k }
    - { window: 200k, notice: 50k,  warning: 100k, cutoff: 135k }
    - { window: 256k, notice: 60k,  warning: 120k, cutoff: 160k }
    - { window: 400k, notice: 90k,  warning: 180k, cutoff: 240k }
    - { window: 500k, notice: 120k, warning: 240k, cutoff: 310k }
    - { window: 1M,   notice: 120k, warning: 240k, cutoff: 320k }
    - { window: 2M,   notice: 120k, warning: 240k, cutoff: 320k }
  models: {}
  specialists: {}
  # How much recent context every compaction keeps behind the summary and the
  # note, in tokens (a positive count, "20k" allowed). 20000 is Pi's
  # default. Passed to Pi's compaction settings for the session as
  # an override — nothing is written under .pi/. Only while self-compact is the
  # active strategy.
  keep_recent_tokens: 20000

# The cap for context_strategy: continue — successor sessions per task. (The
# old `continuation.enabled` switch is gone; `context_strategy` chooses.)
continuation:
  max: 1

# The setting of the lykos-reviewer default extension (T149): one read-only
# child session after the gate, on a session that edited files. Off by
# default; model "" means the reviewed session's own model. Its runs, model and
# findings are in the ledger (extension_counters + the child session) and in
# `lykos show`.
reviewer:
  enabled: false
  model: ""

# Path rules (T210, issue #66, ADR-0042): unified access table across host and container.
# Access categories are `read` and `write`. Decisions are `allow`, `ask`, or `deny`.
# Precedence: deny > ask > allow, independent of declaration order.
# Secret paths are denied for both read and write everywhere:
#   - In workspace: `*.env`, `*.env.*` (except `*.env.example`), `.npmrc`, `*.pem`, `*.key`, `id_*`
#   - In home: `~/.ssh/**`, `~/.aws/**`, `~/.gnupg/**`, `~/.netrc`, `~/.docker/config.json`, `~/.config/gh/**`, `~/.lykos/credentials.db*`
# Protected writes (e.g. `.git/**`, `.config/git/**`, `.vscode/**`, `.idea/**`, `.husky/**`,
# `.cargo/**`, `.devcontainer/**`, `.yarn/**`, `.mvn/**`, `.lykos/**`, `.pi/**`,
# `.github/workflows/**`, `~/.lykos/**`) always prompt for human approval (offering only
# session allow) and cannot be pre-approved by `allow` rules, extra directories, or remembered approvals.
# Exceptions to protected writes: Lykos worktrees (`~/.lykos/worktrees/**`) and memory files
# (`~/.lykos/memory/**`, `.lykos/memory/**`).
# Negations (!pattern) cancel a rule from the same file/source only.
# An untrusted project's allow rules are ignored, but its ask and deny rules apply.
# Outside the workspace, reads and writes default to `ask` unless configured.
# Shape: `path_rules: { read: { "<pattern>": allow|ask|deny }, write: { ... }, remove: [...] }`.
# Layers are read global (`~/.lykos/config.yaml`) then project (`.lykos/config.yaml`); a rule
# from either layer applies, and a deny in any of them wins. Project `allow` rules are read only
# when the project is trusted. Shipped default rules can be removed only via `remove: [...]` in
# global config (`~/.lykos/config.yaml`); if specified in project config, `remove` is ignored and
# a warning is printed to stderr.
# Containment uses the same unified path rules: secret patterns are shadowed as empty files/tmpfs,
# and protected directories are mounted read-only.
# Patterns are gitignore-style globs, matched against the requested path and its
# realpath (so a symlink into a denied path is denied); `~` is home; Windows and POSIX paths both
# match. Every file tool (read, write, edit, the search tools, ast_edit, lsp) consults these rules.
# A denied call returns a result naming the rule, e.g. "denied: secret path `~/.ssh/**`", and
# retrying is pointless. A path outside the project directory asks through the approval gate; on
# the prompt, `[f]` ("allow this folder") adds the folder to the project's extra directories
# (`~/.lykos/permissions.json`, per project), so the next access there does not ask.
# A path ask reaches a person in every permission mode (Auto and remembered command approvals do
# not answer it); with no one to ask (`--yes`, a read-only child) it is a denial that names the rule.
# Path rules also reach recognized file commands in `bash` and `powershell` (T212, ADR-0042):
# operands of `cat`, `head`, `tail`, `sed` (read; `sed -i` writes), `tee` (write), and PowerShell
# aliases `Get-Content`/`gc`/`type` (read) and `Set-Content`/`sc`/`Add-Content`/`ac`/`Out-File` (write),
# as well as `>`, `>>` (write), and `<` (read) redirect targets across all shell segments.
# Heredocs (`<<`, `<<-`) have their bodies ignored as commands; here-strings (`<<<`) and fd redirects
# (`2>&1`, `>&2`) are not paths; commands Lykos cannot inspect into (`grep -r`, `node script.js`) contribute nothing.
# Shell comments name nothing, and `<<` inside `$((...))` is arithmetic, not a heredoc. A segment containing a
# backslash is read twice, as bash and with the backslash literal (PowerShell and Windows paths), and both readings
# are checked. A write cmdlet's path is its first positional operand (or `-Path`/`-FilePath`); the data is not a path.
# A bash write into `.git` is a protected ask like the file tools', no longer a hard deny.
# Strictest named path wins (deny > ask > allow): a command naming a denied path refuses with that rule;
# a command naming an ask path prompts the human with allow once and deny only (no "always", no "allow folder").
# Containment guarantees full enforcement (`enforced`), while host execution runs best-effort scanning (`best effort`);
# `/permissions` reports `path rules: enforced for file tools; commands <enforced|best effort>`.
path_rules:
  read:
    "secrets/**": "deny"
    "docs/**": "allow"
  write:
    "dist/**": "deny"
    "build/**": "ask"
  # remove:
  #   - "*.pem"
  #   - "~/.docker/config.json"

# Containment (T173, spec #22, ADR-0036): where the session's commands run. The
# session itself stays on this machine; `bash`, `powershell`, `eval`, background
# jobs, the post-edit check, the gate's test command and shell hooks run in one
# long-lived Docker or Podman container with the project mounted at /work. The
# file tools, checkpoints, `lsp`, `gh` and `commit` stay on the host. `commit` (T179) is the
# one way a contained session records a commit: `.git` is read-only in the container, so
# the host commits, through the protected git helper (hooks and fsmonitor off), asking the
# way `edit` asks. It is offered only in a git repository; a folder without one, or a machine
# without git, has no `commit` and the session's one notice says so.
# With no paths it commits the workspace's changes (not the repository above it) and never
# `.lykos/` or `.pi/`; it is absent from a surface without `edit` or `write`.
#   level: off       commands run here (default)
#          auto      a container when a runtime answers; otherwise run here and say so
#          required  refuse to start when no runtime answers
#   minimum: a floor on level (off < auto < required), T180. Read from ~/.lykos/config.yaml and
#     .lykos/config.yaml only; the higher of the two applies, so a project cannot lower the user's.
#     A specialist, an environment variable or a flag cannot set it. A request below it, from
#     `--containment`, a specialist or a config level, is refused before boot, naming the floor and
#     the file. An `auto` that finds no runtime counts as `off`, so under a floor of `auto` or
#     `required` it refuses too. Unset or `off` is no floor.
#   A delegated session whose project the user store does not trust (#49) ignores a project
#     `level` below what the user's layers give (`off` when none names one), and the project's
#     `hooks[].command`, `feedback.command`, `gate.command`, `gate.rerun_command`, `lsp.servers.*`
#     and `eval.python`; it lists each in `skipped_extensions`. `--containment` and ~/.lykos/config.yaml
#     can still choose `off`. Trusting the project (the trust prompt) restores them.
#   runtime: auto prefers Podman when both answer; docker / podman forces one.
#   network: none is the runtime's no-network mode.
# The first contained session builds a toolchain image (Node, git, Python,
# common Unix tools) from the Dockerfile Lykos ships, tagged by a hash of that
# file; a changed Dockerfile is a new tag and a rebuild. Each session records
# the level asked and used, runtime and version, image, network and mount in the
# ledger (sessions.containment_*, container_*), and `lykos show` prints them.
# The model names host paths; they reach the container as /work paths, and /work
# paths in a command's output come back as host paths.
# T174b: a Windows host path in quotes cannot be told from text by its letters,
# so the command around it decides. The target of a redirection and a quoted
# argument of a file command (the FILE_COMMANDS set in
# lykos/containment/paths.ts) is a path, even through a one-letter folder
# (`"C:\ws\new dir\a"`). Every quoted string after printf or echo -e, and the
# message after -m, -am or --message of git, is text and is left whole, with or
# without a space and wherever a path sits in it. Plain echo, and any other
# command, is not text: a quoted string with a space there is a path unless it
# holds a lone escape letter (`\n`, `\t`) and no folder below the workspace
# exists on the host, and then only its start is translated. -m is a message
# only where git's subcommand (the first word that is not an option of git's own
# or the value of one in GIT_VALUE_OPTIONS in lykos/containment/paths.ts) is
# commit, tag, merge or stash. It still goes wrong where: free text
# after plain echo or an unlisted command is translated when its escape is not a
# lone letter (`echo "C:\ws\out.txt done\nnext"` becomes
# `"/work/out.txt done/nnext"`); a path in an unquoted word of a text line; a
# path is quoted for a command not in the list and holds a new folder named a,
# b, f, n, r, t, v or 0 (read as an escape); a message flag of another tool (gh,
# hg) or `git commit -F` is not text; a command built by `eval`, a variable or
# a function shows no name; the quote scan does not know here-documents or
# `$(...)`, and a stray apostrophe in unquoted text can shift which strings it
# pairs.
# T211: callers that parse container output directly and never show it to the
# model (e.g. the sealed test runner) request untranslated output (`containerPaths: true`)
# so that host path translation (such as Windows backslashes) does not break JSON strings.
# T176: a container is labelled lykos.owner (the pid), lykos.session and
# lykos.version, and every start removes containers whose owning process is gone.
# A container that stops under a session is replaced before the next command,
# which carries one note saying so. A command killed by a signal reports it and
# a non-zero code, and the gate records it as a failure. A start that takes more
# than two minutes is abandoned and its container removed.
containment:
  level: off
  minimum: off
  runtime: auto
  network: open
  memory: 4g
  cpus: "2"
  # T175: a command gets a small fixed environment, never this machine's. Name
  # the variables it may also receive. Secret paths from path_rules (shipped defaults:
  # *.env, *.env.* except *.env.example, .npmrc, *.pem, *.key, id_*) always read as empty
  # inside the container; secret_paths adds additional secret patterns into the unified table.
  # Setting env_allowlist replaces its list.
  env_allowlist: []
  secret_paths: []
  # T177: the image the commands run in. Unset, the project's
  # .devcontainer/devcontainer.json names it (an "image", or a build.dockerfile
  # with its context, built through the runtime on each start so its layer
  # cache decides what changed), then the global config's image, and without
  # any the toolchain image above runs. A project's containment.image beats
  # the devcontainer; a specialist's beats that. A devcontainer.json that is
  # not valid JSON, or a Dockerfile or context outside the project, stops the
  # session with an error rather than falling back.
  # Cost of building on each start: the whole build context is sent every time
  # (add a .dockerignore, especially with "context": ".."); a build that needs
  # the network can fail where a cached image would have run; and when the
  # Dockerfile changes, the old lykos/devcontainer:<hash> image is left behind
  # (remove it with `docker rmi` or `podman rmi`).
  # image: ""
  # containment.global_image is reserved for the loader (it holds the global
  # config's image); a file that sets it fails to load.
  # Also: .git, .lykos and .pi are read-only inside the container in every mode.

# Interception hooks
hooks: []

# Mistake memory policy
memory:
  enabled: true
  scope: ["project", "global"]
  max_inject_tokens: 500

# Sealed TDD (T195, T198)
seal:
  base: "master"              # target base branch (defaults to repository default branch)
  test_command: "node --import tsx --test {files}" # command template with {files} placeholder (vitest: "npx vitest run --reporter=json {files}")
  test_globs:                 # test file patterns included in seal
    - "**/*.test.*"
    - "**/*.spec.*"
    - "test/**"
    - "tests/**"
    - "**/__tests__/**"
  run_globs:                  # test file patterns executed by runner
    - "**/*.test.*"
    - "**/*.spec.*"
    - "**/*_test.*"
    - "**/test_*.*"
  always_sealed:              # auxiliary patterns always sealed with tests
    - "vitest.config.*"
    - "vitest.setup.*"
    - "jest.config.*"
    - ".mocharc*"
    - "**/fixtures/**"
    - "**/__fixtures__/**"
    - "**/__snapshots__/**"
  writers:                    # specialists permitted to create seals and write sealed tests
    - "test-writer"
  enforce_for:                # specialists forbidden from modifying sealed tests
    - "implementer"
  weakening_patterns:         # additional literal substrings scanned for test weakening outside seal
    - "FORCE_PASS"
  resolver: "test-writer"     # specialist resolving test disputes ("test-writer" in standalone, caller/orchestrator in delegated mode)
  escalate_after: 1           # cycles before escalating dispute to orchestrator

# MCP worker server settings (T223, T224, T226)
mcp:
  max_sessions: 4             # Maximum concurrent live sessions served by `lykos mcp` (default: 4)
  ask_timeout: 600            # Seconds before a waiting question times out and decides alone (default: 600)
  warm_pool: 2                # Pre-spawned session-child processes per workspace and trust source (default: 2; 0 disables; costs K idle node processes per workspace and trust source)
                              # Measured 2026-10-26, Windows host, built dist, Node 24.11.1, 30 s idle, 6 children: 126.5-127.6 MB working set, 94.9-96.4 MB private each

# Terminal user interface
ui:
  theme: "sky"                # "sky" | "mono" | "rose-pine" | "nord" | ...
  color: "auto"               # "auto" | "always" | "never"
  glyphs: "unicode"           # "unicode" | "ascii"
  show_avoided: false
  statusline_refresh_hint: 2
  hud:
    enabled: true
    format: "{status} {tokens} | {context} | {cost}"
    delegate_line: true
    max_lines: 2
    show_avoided: false
  statusline:
    enabled: true
    format: "{model} {context} | {cost} | {rate_limits}"
    delegate_line: true
    refresh_hint: 2
  watch:
    panels: ["now", "cost", "tokens", "context", "health", "session"]
    refresh_hz: 4
  footer: true
  completion_position: "above"
  tool_result_preview: false
  tool_wait_limit_seconds: 300
```

---

### 3.1 The gate's rerun of failed test files (T167, ADR-0030)

When the session gate's command exits non-zero, the gate reads its output for failed test files and
reruns **only those**, **once**. It happens at the session gate only: the post-edit loop, per-item
`verify` and `lykos verify` do not rerun.

| Rerun result | Verdict |
|---|---|
| Exits 0, and no flaky test is in a file the session edited | `success`; the flaky tests are named |
| Exits 0, and a flaky test is in a file the session edited | `fail`; the flaky tests are named, marked edited |
| Fails again, or could not start | `fail`; the first verdict stands |
| Not run (below) | the first verdict stands |

**No rerun happens when:** `gate.rerun_failures` is `false`; the output names no failed test file; a
failed test's file is not in the project; the reporter's summary (`ℹ fail N`, `ℹ cancelled N`; tap:
`# fail N`, `# cancelled N`) is unreadable or counts more failed and cancelled tests than were parsed
(a test that failed only because a `t.test` subtest did is counted but not listed, so it is
refused); or there is no command to rerun with.

**A rerun clears the failure only if its own summary shows it:** `tests >= 1`, `fail 0`,
`cancelled 0` and at least as many passes as failed tests. A rerun that exits 0 but ran nothing is
a failed rerun: `fail`, no flaky rows.

**What is parsed.** The failed tests of node:test's *spec* reporter (what `npm test` prints off a
terminal on Node 24): the `failing tests:` section's `test at <path>:<line>:<col>` line followed by
`✖ <name> (<ms>)`, with `\` or `/` separators, absolute or relative to the project. A file that
crashed before running a test is listed with its own path as the name. The *tap* reporter is read too
(`not ok N - name` with `location:`; a parent that failed only because a subtest did is skipped). Any
other reporter reruns nothing.

**The rerun command**, in order:

1. `gate.rerun_command`, with `{files}` replaced by the failed files (each quoted if it needs it). It
   must contain `{files}`; a config without it fails to load.
2. Derived from the gate command's script. `npm test` and `npm run test` mean `package.json`'s `test`
   script, and any other gate command is its own script. It is derivable only when it is **one plain
   `node --test` or `tsx --test` invocation** (optionally `npx tsx --test`). The runner and every flag,
   with its value (`--import tsx`, `--test-concurrency=4`, `--test-reporter spec`), are kept in order;
   every other argument (the script's file globs and directories) is dropped; the failed files are
   appended. `tsx` runs as `npx --no-install tsx`. This repository's `tsx --test "lykos/**/*.test.ts"`
   becomes `npx --no-install tsx --test lykos/tools/lsp.test.ts`. Refused: `&&`, `;`, pipes, redirects,
   an environment prefix, `--watch`, `--eval`, a runner other than node and tsx, and a script with no
   `--test`.
3. Neither: no rerun.

The on-screen line says when a rerun happened and names the flaky tests. A flaky test counts as
"edited" when its file is among the paths the session's trace edited (the paths `edited_files` is
written from, a directory covering every file under it); an edit made through `bash` is not in them.

---

### 3.2 Sealed TDD configuration (T195)

Configured under the `seal:` key in `config.yaml`:

- `base`: Base branch for calculating `merge-base(HEAD, base)`. If omitted or empty, dynamically resolves in order: `refs/remotes/origin/HEAD`, git config `init.defaultBranch`, local `master`, local `main`, or fallback `"master"`.
- `test_command`: Shell command template used to execute sealed tests during `lykos seal create`. Must contain `{files}` placeholder. Default: `node --import tsx --test {files}`. Adapters are detected from the command template: `node:test` (for templates running `node ... --test`, `tsx --test`, or `node --import tsx --test`), `vitest` (for vitest templates, e.g. `npx vitest run --reporter=json {files}`), or exit-code fallback (`exit`) for unsupported runners. When contained, structured adapters (`node:test`, `vitest`) request untranslated output (`containerPaths: true`) from the executor because translating `/work` paths to Windows host paths injects raw backslashes into JSON strings and breaks parsing (T211, issue #79); exit-code mode keeps output translated because its text reaches the model.
- `test_globs`: List of glob patterns matching test files (defaults: `**/*.test.*`, `**/*.spec.*`, `test/**`, `tests/**`, `**/__tests__/**`).
- `run_globs`: List of glob patterns matching test files to execute in runner during red checks and gate green runs (defaults: `**/*.test.*`, `**/*.spec.*`, `**/*_test.*`, `**/test_*.*`). Sealed files not matching `run_globs` (such as fixtures, helpers, and snapshots) stay sealed but are not executed as test suites.
- `always_sealed`: List of glob patterns for non-test files that are sealed alongside tests whenever present (defaults: `vitest.config.*`, `vitest.setup.*`, `jest.config.*`, `.mocharc*`, `**/fixtures/**`, `**/__fixtures__/**`, `**/__snapshots__/**`).
- `writers`: List of specialist names permitted to create seals and author sealed tests (defaults: `["test-writer"]`). When no active seal exists, specialists in `writers` are allowed the resolved `test_command` template on test files without asking.
- `enforce_for`: List of specialist names for which seals are enforced, vetoing modifications to sealed paths (defaults: `["implementer"]`). Specialists in `enforce_for` are allowed `dispute_test` from `lykos-seal` without asking in all non-plan permission modes.
- `weakening_patterns`: List of additional literal substrings scanned for test weakening in non-sealed files modified outside the seal (in diff from seal commit). The scan always checks the shipped defaults (`.skip(`, `.only(`, `xit(`, `process.env.VITEST`, `process.env.NODE_TEST_CONTEXT`, and `NODE_ENV === "test"`, `NODE_ENV === 'test'`, `NODE_ENV == "test"`, `NODE_ENV == 'test'`) plus whatever `weakening_patterns` resolves to. Config keeps list-replace semantics across layers, and the shipped default patterns cannot be removed through config (removing the `lykos-seal` extension is the off switch).
- `resolver`: Specialist or role tasked with resolving test disputes (defaults to `"test-writer"` in standalone mode, caller/orchestrator in delegated mode; explicit config overrides either mode).
- `escalate_after`: Number of dispute cycles before escalating to human or parent orchestrator (defaults: `1`).

Sealing also supports hook enforcement and history pruning (T200, T212):
- `lykos seal hook install`: Installs or updates a Git `pre-push` hook (`git rev-parse --git-path hooks`) running `lykos seal verify`. The hook reads pushed ref lines from stdin (`<local ref> <local sha> <remote ref> <remote sha>`), skips deletions, and verifies every pushed ref by its local SHA (via `lykos seal verify --commit <sha>`) rather than only the checked-out HEAD. If a custom pre-push hook already exists, Lykos prepends/appends its block delimited by markers (`# --- lykos seal hook begin ---`), preserving existing hook behaviour and ensuring idempotence.
- Merged seal pruning: `lykos seal create` deletes the seal files (`.lykos/seals/<branch>.json`) of branches whose seal commit is reachable from the target branch's base (`isAncestor(sealCommit, base)`), while keeping unmerged and active seals. Pruned seal deletions are staged and included in the same signed seal commit created for the new branch.
- Reseal and superseding (T212): A seal made on a branch of its own supersedes the active seals it was made from when tests they pin were modified, keeping every path they sealed. Their seal files are pruned in the new seal commit so only the new seal remains active; an active seal whose tests were not changed stays active.

### 3.3 Delegated seal allowance (T199, T208)

In delegated and standalone sessions, `SealAllowanceGate` allows test execution and dispute operations without human confirmation when `lykos-seal` is active:
- **Test command allowance**: In every permission mode except plan (`manual`, `accept-edits`, `auto`), specialists in `seal.writers` and `seal.enforce_for` may execute test commands matching the seal template. When active seals exist, the allowance matches any active seal's recorded `test_command` template filled with test files matching `test_globs`. When no active seal exists, specialists in `seal.writers` are allowed the resolved `seal.test_command` template from configuration (enforced non-writers still require an active seal).
- **Single-command PowerShell support**: Shell requests with `shell: "powershell"` are matched under the same token rules as `bash`. The line must be a single command: compound separators, pipelines, redirects, backticks, dollar signs, and newlines (`/[;|>&<`$\r\n]/`) outside matched tokens are forbidden.
- **Dispute tool allowance**: Specialists in `seal.enforce_for` are allowed the `dispute_test` tool from `lykos-seal` without asking in every permission mode except plan. No other extension tool gains an allowance.

## 4. Environment Variables

### 4.1 Config Layer Overrides (`envLayer`)
These environment variables participate in the standard config precedence hierarchy:
- `LYKOS_MODEL_DEFAULT`: Sets `models.default`.
- `LYKOS_BUDGET_PER_RUN_USD`: Sets `budget.per_run_usd`.
- `LYKOS_BUDGET_PER_DAY_USD`: Sets `budget.per_day_usd`.
- `LYKOS_LEDGER_PATH`: Sets `telemetry.ledger`.
- `LYKOS_HUD`: Enables/disables live HUD boolean.
- `LYKOS_UI_THEME`: Overrides `ui.theme`.
- `NO_COLOR`: Disables color rendering (`ui.color = "never"`).
- `LYKOS_COMPACTION_THRESHOLD`: Overrides `compaction.threshold`.

### 4.2 Runtime & Boundary Environment Variables
- `LYKOS_IO_MODE`: Forces IO mode (`standalone`, `mcp`, `piped`).
- `LYKOS_TRUST_SOURCE`: Set by `lykos mcp` for each `session-child` it starts: how the server established trust (`stored`, `flag` or `prompt`). A claim only: the child checks the user trust store itself, so it can pass the gate as `flag` and never upgrades to `stored` ([mcp.md](mcp.md#trust)).
- `LYKOS_SESSION_PROGRESS_MS`: The heartbeat interval, in milliseconds, of an MCP call's progress notifications (default 15000).
- `LYKOS_TRUST_WORKSPACE`: If `1`, a headless run passes the trust gate for this run without writing the store. It never authorises running a workspace's own binaries or loading its own extensions in a delegated session: only the user-level trust store does (see [lsp.md](lsp.md#trust-and-workspace-binaries-t171)). A project already in the store reports `stored` even with this set.
- `PI_CODING_AGENT_DIR`: Root for Pi packages and agent definitions.
- `DEEPSEEK_API_KEY`: API credential for DeepSeek provider.
- `ANTHROPIC_API_KEY`: API credential for Anthropic provider.
- `TERM`: Terminal capability detection.
