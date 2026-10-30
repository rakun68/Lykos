// `lykos init` — writes docs/05-cli-and-config.md §1's .lykos/ layout.
// Never overwrites a file that already exists: init has to be safe to
// re-run (e.g. after `lykos agents` adds a role) without clobbering
// project memory someone already wrote into.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_YAML = `version: 1

# Providers and credential SOURCES, translated into Pi's models.json at
# session start (docs/13-model-access.md D3.0a). Lykos never relocates,
# rewrites, or reads out of ~/.pi/agent/auth.json — it only declares what
# should exist. \`auth\` names the route, recorded per call as calls.auth_mode.
# \`source\` is \`$ENV_VAR\` or \`!command\`, never a literal key.
# \`priced: true\` is a claim that rates AND cache semantics are verified in
# prices.yaml; the ledger still consults the table and records \`unpriced\`
# if the claim is a lie (T36 / D3.0c).
providers:
  deepseek:
    auth: api_key
    priced: true             # rates AND cache semantics verified in prices.yaml
  # anthropic:
  #   auth: oauth_subscription  # Pi /login; priced calls record api_list, not plan_credit
  #   priced: true

models:
  # Lykos declares the default per role. The caller may override per call,
  # and both are recorded.
  default: deepseek-v4-flash
  roles:
    worker:  deepseek-v4-flash
    scout:   deepseek-v4-flash
    watcher: deepseek-v4-flash

budget:
  per_run_usd: 0.50
  per_day_usd: 2.00
  on_exceed: stop            # stop | downgrade | prompt
  max_concurrent_delegates: 3

telemetry:
  hud: true
  ledger: .lykos/ledger.db
  prices: builtin            # or a path to override

# Mechanism toggles. Recorded on every session so on/off comparisons across
# real work are possible.
flags:
  delegation: true
  retrieval: false
  proactive_compaction: true
  routing: false
  draft_verify: false
  cache_stable_head: true
  output_diet: true          # T23: YAGNI/one-liner rule. Budget/cheap-worker
                              # presets keep this on; a stronger preset sets
                              # it false in its own lykos_flags overlay.

# threshold: a share of the model context window (default 0.80) — where
# continuation stops and what the context-budget notice names. Recorded on the
# session.
# T188: supersede_reads overwrites an earlier read of a file once a newer read
# of it exists; drop_useless overwrites a result its tool flagged as saying
# nothing. Both are cache-guarded (see docs/reference/cli-and-config.md).
# T190: method_order is the compaction methods in the order they are tried, each
# falling through to the next when it fails or has nothing to give: note (the
# agent's own self_compact note), handoff (a side call with no tools that writes
# the note), shake (drops tool results, no model call), summary (Pi's own
# summary, always the end). Unknown names are ignored.
compaction:
  threshold: 0.80
  supersede_reads: true
  drop_useless: true
  method_order: [note, handoff, shake, summary]

# T99 (Phase 12): the post-edit feedback loop -- the biggest gap the strength
# audit found. Between \`edit\` returning ok and the model deciding it is done,
# Lykos used to learn nothing at all. This runs one command after every
# SUCCESSFUL write or edit and appends its failure to the tool result the
# model is already reading. It registers no tool and adds nothing to hop-0.
#
# Leave \`command\` empty and it is discovered from the project: an \`npm run
# typecheck\` script if there is one, else \`npx tsc --noEmit\` for a TypeScript
# project. A project where neither exists gets no loop, silently, which is
# what every session had before T99.
#
# Do NOT put the test suite here. A typecheck is seconds and answers "is this
# coherent"; a test run is minutes and answers "is this correct", which is a
# question worth asking once per task -- that is \`todo\`'s per-item verify
# command and T100's gate, not this.
feedback:
  enabled: true
  command: ""                # empty means: discover one from the project
  timeout_seconds: 120
  max_output_bytes: 4000     # head and tail; the failing line is usually last
  slow_disable_seconds: 45   # a check this slow switches itself off and says so

# T100 (Phase 12): the mechanical verification gate -- D6.2's free gate,
# named twice in CLAUDE.md as the cheapest available writer of
# outcome='success' and unbuilt through two phases. It runs ONCE per editing
# session, after the ledger row is closed, and its exit code decides. It
# costs zero tokens.
#
# It cannot record a success no command produced: cli/verify.ts stays the one
# writer, outcome_source is verification_command, and agent_claim is not
# reachable from this path at all.
#
# When the gate produces a verdict, the session-end question is not asked --
# an exit code is a better answer than a recollection, and asking afterwards
# would let an opinion overwrite a fact. The question survives for every case
# the gate cannot answer: no test script, a read-only session, a command that
# would not start.
#
# Empty \`command\` means: discover one from the project (an \`npm test\` script),
# which is the same answer the session-end question offers, deliberately.
gate:
  enabled: true
  command: ""
  timeout_seconds: 900
  gate_read_only_sessions: false   # grading a read-only session says more about the repo than the session
  # T167 (ADR-0030): when the command fails, rerun ONLY the failed test files,
  # once. A test that passes on rerun is a flaky test: it is named in the
  # ledger, \`lykos show\` and \`lykos doctor\`, and the verdict is success --
  # unless the session edited that test's file, which stays fail. The command
  # is derived when the test script is a \`node --test\` or \`tsx --test\` run.
  rerun_failures: true
  rerun_command: ""                # e.g. "npx vitest run {files}"; {files} is the failed files

# T168 (ADR-0031): \`edit\` and \`write\` to an existing file are rejected, with
# nothing written, unless this session has read it (a partial read counts) and
# it has not changed since that read or since the last \`edit\`/\`write\` here.
# A new file needs no read. Off by default; uncomment to turn it on.
# edit:
#   require_read: true

# T150: what a session does as its context window fills. Exactly one runs,
# and Pi's own compaction stays underneath all of them as the last resort.
#   self-compact  the agent writes a note to self and compacts (default; until
#                 it is built this falls back to pi, and the session says so)
#   continue      lykos-continuation stops at compaction.threshold and a fresh
#                 session continues from disk (task list, checkpoint, gate)
#   pi            Pi's own compaction only
context_strategy: self-compact

# T151: self-compact's thresholds, by the model's context-window tier. A window
# uses the largest tier at or below it; below the smallest, self-compact is
# off. Token counts are decimal ("64k" = 64000). Uncomment to change: tiers
# replaces the whole shipped table (smallest first; a larger tier may never
# compact earlier), and the overrides sit on top — a specialist's beats a
# model's. The notice and warning texts can be replaced by
# .lykos/prompts/self-compact/notice.md and warning.md.
# self_compact:
#   tiers:
#     - { window: 64k,  notice: 24k,  warning: 32k,  cutoff: 44k }
#     - { window: 128k, notice: 30k,  warning: 60k,  cutoff: 90k }
#     - { window: 200k, notice: 50k,  warning: 100k, cutoff: 135k }
#     - { window: 256k, notice: 60k,  warning: 120k, cutoff: 160k }
#     - { window: 400k, notice: 90k,  warning: 180k, cutoff: 240k }
#     - { window: 500k, notice: 120k, warning: 240k, cutoff: 310k }
#     - { window: 1M,   notice: 120k, warning: 240k, cutoff: 320k }
#     - { window: 2M,   notice: 120k, warning: 240k, cutoff: 320k }
#   models:
#     deepseek/deepseek-v4-flash: { notice: 30k, warning: 60k, cutoff: 90k }
#   specialists:
#     minimal: { notice: 20k, warning: 40k, cutoff: 60k }
#   keep_recent_tokens: 20000   # recent context every compaction keeps (Pi's default)

# T109: the cap for context_strategy: continue. A continuation starts another
# paid session; the gate and the persisted task list decide whether it fires,
# and max is a hard cap, defaulting to one successor session.
continuation:
  max: 1

# T149: the setting of the lykos-reviewer default extension (the reviewer
# that did not write the code): one read-only child session after the gate,
# on a session that edited files. OFF by default because it is an extra paid
# call. Runs on the session's own model unless model names another
# (e.g. "deepseek/deepseek-v4-flash"). Removing lykos-reviewer from
# lykos_extensions switches it off too.
reviewer:
  enabled: false
  model: ""

# T173: where this session's commands run. The session itself stays on this
# machine; bash, eval, background jobs, the post-edit check and the gate's test
# command run in a Docker or Podman container with the project at /work.
#   off       run commands here (default)
#   auto      use a container runtime when one answers; say so and run here when none does
#   required  refuse to start without one
# runtime: auto prefers Podman when both answer. network: none cuts the
# container off. The first contained session builds a toolchain image (Node,
# git, Python, common Unix tools) from a Dockerfile Lykos ships.
containment:
  # level is unset on purpose: the default is off (T219, #75). Write a level
  # here only to pin it for all sessions.
  # level: off
  # T180: a floor on the level (off < auto < required), read from this file and
  # ~/.lykos/config.yaml only; the higher of the two applies. A session that asks
  # for less is refused before it boots, and an auto that finds no runtime counts
  # as off. Unset or off is no floor.
  # minimum: required
  runtime: auto
  network: open
  memory: 4g
  cpus: "2"
  # T175: a command gets a small fixed environment, never this machine's. Name
  # the variables it may also receive. Files matching .env*, .npmrc, *.pem, *.key
  # and id_* always read as empty inside the container; secret_paths adds your
  # own patterns to those ('*' and '?' only; a pattern with a '/' matches from
  # the project root). Setting env_allowlist replaces its list.
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
  # (remove it with docker rmi or podman rmi).
  # image: ""

# T105 (Phase 12): project hooks -- a deterministic policy as a COMMAND
# rather than as prompt text. Five events: session_start, turn_start,
# pre_tool, post_tool, session_end. A non-zero exit denies the call (on
# pre_tool) or annotates it (everywhere else), and whatever the command
# printed is what the model is told.
#
# Two built-in policies are CODE, not config, and are deliberately not listed
# here: an agent may never write to .lykos/ledger.db or into the session
# archive -- the measurement layer and the archive are not the agent's to
# edit -- and a write whose content looks like a credential is flagged.
# Flagged, not blocked: that pattern also matches a fixture and a doc example,
# and blocking on a heuristic with false positives is a detector that cries
# wolf.
#
# The context reaches the command as ENVIRONMENT: LYKOS_HOOK_EVENT,
# LYKOS_HOOK_TOOL, LYKOS_HOOK_PATH. Never as arguments -- a path the model
# chose, pasted into a shell argument, is an injection surface.
#
# Empty by default. Example:
#   hooks:
#     - event: pre_tool
#       tools: [write, edit]
#       command: test "$LYKOS_HOOK_PATH" != "package-lock.json"
hooks: []

memory:
  enabled: true
  scope: [project, global]
  max_inject_tokens: 500     # memory that bloats the prompt defeats its purpose

# T69 (Phase 9): the repo map. Parameters only -- the switch is listing
# lykos-repo-map in extensions: below (ADR-0028); it ships unlisted because
# T67's gate returned HOLD on 30 exploration calls and 0 file edits.
# Turning it on is a deliberate act. flags.retrieval no longer
# controls it. Above ~2000 tokens the map IS the context pollution it exists
# to remove; the default sits under that on purpose.
retrieval:
  repo_map:
    max_tokens: 1500
    max_files_per_dir: 6

# T29: published third-party Pi extensions, declared rather than hardcoded.
# "lykos extensions install" is the installation surface; this list is the
# ACTIVATION surface -- which of them a session loads, in what order.
# "lykos doctor" reconciles the two and warns on a declaration not installed.
# Versions are EXACT, never a range: a floating version is a silent
# change to both the head and the tool surface (docs/reference/extension-policy.md
# bar 5). Order is load order. Removing an entry removes the extension.
# This list REPLACES the shipped one, so it names the shipped defaults too.
# A default extension (lykos-*) ships inside Lykos and takes no version: it is
# always the build that came with this Lykos.
extensions:
  - name: pi-cache-optimizer
    version: 2.8.6
    scope: [hop0]
  # - name: lykos-repo-map   # ADR-0028: off unless listed; uncomment to turn on
  - name: lykos-continuation # T150: the "continue" context strategy
  - name: lykos-self-compact # T151: the "self-compact" strategy, the default
  - name: lykos-prune        # T188: overwrite superseded reads and useless results (compaction.supersede_reads / drop_useless)

ui:
  theme: sky                 # shipped palette | user theme in .lykos/themes/ | auto
  color: auto                # auto | always | never | 16 | 256 | truecolor
  glyphs: unicode            # unicode | ascii | nerdfont
  show_avoided: false        # live avoided invites gaming your own metric
  statusline_refresh_hint: 2 # seconds, written into .claude/settings.json
  hud:
    format: "{status} {tokens} | {context} | {cost}"
  statusline:
    format: "{model} {context} | {cost} | {rate_limits}"
  watch:
    panels: [now, cost, tokens, context, health, session]
    refresh_hz: 4
  footer: true               # the full-screen surface's always-on ledger row
`;

const SCOUT_AGENT_MD = `---
name: scout
model: deepseek-v4-flash
tools: read, grep, glob
extensions: false
allowed_subagents: none
memory: project
inherit_context: false
---

Read-only exploration. Find files, locate symbols, answer "where is X" and
"which files reference Y". Never edit, write, or commit — that boundary is
enforced by \`tools:\` above, not by asking nicely in this prompt
(docs/01-idea.md §5: restrictions must be framework-enforced).

Return a compact summary: the files and line ranges that matter, and a short
answer to what was asked. Do not return full file contents unless the calling
worker explicitly asked for them — the whole point of this role is that the
worker pays for a summary, not for the exploration.
`;

const WATCHER_AGENT_MD = `---
name: watcher
model: deepseek-v4-flash
tools: read, grep, glob, bash
extensions: false
allowed_subagents: none
memory: project
inherit_context: false
---

Run verification: tests, linters, type checks, or a reproduction of a
reported bug. Never modify implementation or test files — that boundary is
enforced by \`tools:\` above (read/grep/glob/bash only, no write or edit).

Return the outcome plainly (pass/fail) plus only the failing output, not the
full log. \`outcome_source: agent_claim\` is never trusted as success
(AGENTS.md rule 6) — the calling worker still needs the exit code or the
actual failing assertion, not this agent's opinion that things went fine.
`;

const GOTCHAS_MD = `# Project gotchas

Non-obvious constraints and traps discovered while working in this repo.
Not a place for facts retrieval could regenerate — file locations, function
names, module structure. The test (DECISIONS.md, 2026-08-28): would
rediscovering this cost more than one cheap search? If not, it does not
belong here.
`;

const FAILED_APPROACHES_MD = `# Failed approaches

Things tried and abandoned, and why, so the same dead end is not paid for
twice. One entry per approach: what was tried, what happened, what to do
instead.
`;

/**
 * docs/reference/cli-and-config.md §0: gitignore ledger.db, sessions/, cache/.
 * `.lykos/session/` carries T9's transcripts — redacted, but still real
 * conversation content — so this is not optional the way a stray cache
 * file would be. Exported so `lykos doctor` can assert the same list
 * (T9.2) rather than keeping its own copy that could drift from this one.
 */
export const GITIGNORE_LINES = [
  ".lykos/ledger.db",
  // SQLite in WAL mode keeps these beside the database while it is open (T179: `commit` stages
  // everything it may, so a runtime file left unignored would be committed).
  ".lykos/ledger.db-wal",
  ".lykos/ledger.db-shm",
  ".lykos/session/",
  ".lykos/cache/",
  ".lykos/today.json",
  ".lykos/resolved-config.json",
];

export interface ScaffoldResult {
  created: string[];
  skipped: string[];
}

function writeIfAbsent(path: string, content: string, result: ScaffoldResult): void {
  if (existsSync(path)) {
    result.skipped.push(path);
    return;
  }
  writeFileSync(path, content, "utf8");
  result.created.push(path);
}

/**
 * Writes (or merges) the `statusLine` block into .claude/settings.json
 * (docs/07-ui-and-hud.md §1.3: "lykos init should offer to write the
 * statusLine block... discovering this surface by reading a document is the
 * difference between a feature and a feature nobody enables"). Only adds the
 * key when it is absent — an existing statusLine (the user's own, or a
 * previous run's) is left alone, and any other settings in the file survive
 * untouched.
 */
function scaffoldClaudeStatusline(dir: string, result: ScaffoldResult): void {
  const settingsDir = join(dir, ".claude");
  const settingsPath = join(settingsDir, "settings.json");
  mkdirSync(settingsDir, { recursive: true });

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    } catch {
      result.skipped.push(`${settingsPath} (not valid JSON — statusLine not added)`);
      return;
    }
  }

  if (settings.statusLine !== undefined) {
    result.skipped.push(`${settingsPath} statusLine (already set, left unchanged)`);
    return;
  }

  settings.statusLine = {
    type: "command",
    command: "lykos hud --statusline",
    padding: 0,
  };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  result.created.push(`${settingsPath} statusLine`);
}

/**
 * Appends any Lykos runtime-state lines missing from `dir/.gitignore`,
 * creating the file if it doesn't exist. Never rewrites or reorders
 * existing content — only lines not already present (by exact match) are
 * added, so a hand-edited .gitignore is never clobbered.
 */
function scaffoldGitignore(dir: string, result: ScaffoldResult): void {
  const path = join(dir, ".gitignore");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const existingLines = new Set(existing.split("\n").map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !existingLines.has(l));
  if (missing.length === 0) {
    if (existing.length > 0) result.skipped.push(`${path} (Lykos runtime-state entries already present)`);
    return;
  }
  const separator = existing.length > 0 ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
  writeFileSync(path, `${existing}${separator}# Lykos runtime state — never commit\n${missing.join("\n")}\n`, "utf8");
  result.created.push(`${path} (added ${missing.length} Lykos runtime-state ${missing.length === 1 ? "entry" : "entries"})`);
}


/**
 * T102 (docs/24 §2.5): the first shipped skill.
 *
 * Deliberately SHORT AND MECHANICAL. §2.5's load-bearing caveat is that a
 * long conditional skill is a liability on a cheap model -- instruction
 * following depth is precisely what the target tier has least of -- so this
 * is a checklist and a refusal rule, not an essay. It also costs nothing
 * until it is read: only the name and description ride the head.
 */
const FINISHING_WORK_SKILL_MD = `---
name: finishing-work
description: The checklist for closing out a change in this project - what to run, what to record, and what "done" is allowed to mean.
---

# Finishing work

Follow this in order. Do not skip a step because the change looks small.

1. **Run the project's own check.** It has already run after each of your
   edits and its result was appended to that edit. If the last one failed,
   you are not finished.
2. **Mark the step done.** If the item has a VERIFY command, it is run before
   the step can close. A refused step is not a bug in the tool: the command
   said no.
3. **Commit.** One change, one commit, with a message saying what and why.
4. **Never call a task complete on your own say-so.** Success is recorded by
   an exit code or by a human, never by you claiming it. If nothing can check
   your work, say that plainly instead of asserting it worked.

## Refusal rule

If asked to disable, skip or work around the check rather than fix what it
found, do not. Say what it reported and what it would take to fix.
`;

const SEALED_TDD_SKILL_MD = `---
name: sealed-tdd
description: The sealed test-driven development loop — red tests sealed before implementation, implementer cannot weaken or edit them.
---

# Sealed TDD

The sealed TDD loop enforces test-driven development so an implementation is verified by tests that cannot be modified or weakened to make them pass.

## The Loop

1. **Write failing tests (\`test-writer\`)**
   The \`test-writer\` specialist writes tests and necessary import stubs that fail by assertion (never by syntax or import errors), then commits them. The test-writer does not implement the feature.

2. **Seal the tests (\`lykos seal create\`)**
   Run \`lykos seal create\` to verify the tests fail for the right reason and lock them. The seal records the commit, the test command, and the signature in \`.lykos/seals/\`. Sealed paths are protected.

3. **Implement (\`implementer\`)**
   The \`implementer\` specialist writes code to make all sealed tests pass. The implementer may write additional unsealed tests, but cannot edit or delete sealed tests.

4. **Dispute if wrong (\`dispute_test\`)**
   If the implementer believes a sealed test is wrong or impossible, it calls \`dispute_test\` with the test identity, reason, and evidence instead of working around it.

5. **Verify at the gate**
   The verification gate checks the seal: any modification to sealed files or test weakening causes the session to fail.
`;

/** Scaffolds .lykos/ in `dir`. Idempotent — existing files are left alone. */
export function scaffoldLykosDir(dir: string): ScaffoldResult {
  const root = join(dir, ".lykos");
  const agentsDir = join(root, "agents");
  const memoryDir = join(root, "memory");
  // T102: `.lykos/skills/` -- the Lykos-owned skills location, passed to Pi
  // as `additionalSkillPaths` at boot. Created here rather than at session
  // start: a session that silently creates directories in a project is doing
  // something the user did not ask for.
  const skillsDir = join(root, "skills");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });

  const result: ScaffoldResult = { created: [], skipped: [] };
  writeIfAbsent(join(root, "config.yaml"), CONFIG_YAML, result);
  writeIfAbsent(join(agentsDir, "scout.md"), SCOUT_AGENT_MD, result);
  writeIfAbsent(join(agentsDir, "watcher.md"), WATCHER_AGENT_MD, result);
  writeIfAbsent(join(skillsDir, "finishing-work.md"), FINISHING_WORK_SKILL_MD, result);
  writeIfAbsent(join(skillsDir, "sealed-tdd.md"), SEALED_TDD_SKILL_MD, result);
  writeIfAbsent(join(memoryDir, "gotchas.md"), GOTCHAS_MD, result);
  writeIfAbsent(join(memoryDir, "failed-approaches.md"), FAILED_APPROACHES_MD, result);
  scaffoldClaudeStatusline(dir, result);
  scaffoldGitignore(dir, result);
  return result;
}
