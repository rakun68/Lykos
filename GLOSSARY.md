# Lykos

A coding agent built on the Pi runtime. It runs standalone, as a worker under another agent, and
under a desktop supervisor. Pi is its substrate.

## Language

### Customization

**Specialist**:
A named, file-backed bundle of nineteen settings that reconfigures how the agent approaches a class
of work, and says how it wants to be applied. The same file configures the session a person drives and the agent a coordinator delegates
to, so there is no second place that decides what a delegate may hold. An agent picks a specialist
for the subagent it spawns; a person picks one for the session in front of them.
_Avoid_: preset, profile, mode, persona, configuration bundle, wolf

**Primary specialist**:
A specialist the user switches to in their own session, as opposed to one only an agent spawns for a
subagent. Plan and Build are primary.
_Avoid_: agent, main mode

**Pack**:
A group of specialists running together as delegates of one coordinator. The collective noun, and
the one place the project's wolf metaphor survives in the vocabulary.
_Avoid_: swarm, fleet, roster, team

**Skill**:
A markdown procedure encoding one habit, loaded on demand and costing no tool schema. A specialist
references skills; it does not contain them.
_Avoid_: playbook, workflow, recipe, macro

**Resident tool**:
A tool whose schema rides every request in a session. The complement is a mounted tool.
_Avoid_: active tool, loaded tool, hop-0 tool

**Mounted tool**:
A tool the model reaches through the transport by name rather than through a schema of its own. It
is in the registry and fully callable; what it does not do is cost prompt tokens when unused. A
specialist moves a tool between resident and mounted.
_Avoid_: available tool, lazy tool, deferred tool, dropped tool

**Transport**:
The dispatch path that carries a mounted tool's call, through two resident tools: `tool_search`
returns a mounted tool's full schema, and `tool_call` validates and executes it. A fetched schema
arrives as a tool result at the message tail; the provider tool list never changes mid-session.
_Avoid_: router, proxy, gateway, dispatcher

**Stream rule**:
A file-backed rule matched against the model's own output as it streams, which either injects
guidance at the moment the offending text appears or aborts the turn. Selected by a specialist. Not a
rule in `AGENTS.md`'s sense.
_Avoid_: rule (unqualified), lint, guardrail, policy, TTSR

**Hook**:
A named interception on one of the agent's events, returning continue, deny, note, or rewrite. A
rewritten tool argument is re-classified by the gate before it runs.
_Avoid_: callback, middleware, interceptor, plugin

**Lykos extension**:
An extension written against Lykos's own API, which covers moments Pi has no concept of. Distinct
from a Pi extension, which Lykos loads unchanged through its declaration surface.
_Avoid_: plugin, addon

**Default extension**:
An extension, Pi or Lykos, that ships inside Lykos and uses only an API a third party could use. Its
entry in the extension list is its only switch: most ship listed (on), and one may ship unlisted
(off until a project lists it, ADR-0028). Its name carries the `lykos-` prefix. The gate is never one.
_Avoid_: built-in, core feature, bundled plugin

**Permission mode**:
What the agent may do without asking, chosen by the user: Manual, Accept Edits or Auto. It belongs
to the user, never to a specialist, and is remembered per project.
_Avoid_: interaction mode, approval mode, safety level, plan mode

**Path rule**:
An allow, ask or deny decision for reading or writing paths that match a pattern. A deny always wins.
_Avoid_: permission rule (unqualified), ACL, ignore file

**Secret path**:
A path no tool may read or write in any mode, such as an env file or `~/.ssh`.
_Avoid_: sensitive file, private path

**Protected path**:
A path the agent may read but must always ask to write, such as `.git` or `.lykos`, because tools and
Lykos itself trust what is in it.
_Avoid_: system path, locked path

**Output style**:
A file of instructions about how the agent writes its replies, separate from what work it does.
_Avoid_: persona, tone, verbosity setting

**Head block**:
One named, frozen segment of the system prompt that Lykos owns, assembled in a fixed order at
session boot and never mutated afterwards.
_Avoid_: prompt section, system message, preamble

**Layer**:
One source of configuration values in the fixed precedence chain: defaults, global, project, specialist,
environment, flags. Each resolved value records the layer it came from.
_Avoid_: scope, tier, override level

**Prefix break**:
A change to the assembled system prompt after boot, which costs a full cache write on every
subsequent call. Switching specialists mid-session does not cause one.
_Avoid_: cache miss, prompt invalidation

### The agent and its interface

**TUI**:
The terminal interface: the full-screen surface and the append-only HUD behind one seam. It is the
only interface the product ships; the desktop supervisor is planned and will be a second adapter,
not a replacement.
_Avoid_: UI (unqualified), desktop app, frontend

**Gate**:
The decision point governing what the agent may do without asking. Approval, risk tiers, the
permission mode and path rules are its parts.
_Avoid_: permission system, firewall, guardrail

**Containment**:
The boundary a session's commands run inside, which a session requests rather than a property of one
hop. The session itself stays outside it. Distinct from the gate, which decides what is allowed;
containment decides what is possible.
_Avoid_: sandbox (unqualified), isolation, jail, container

**Containment floor**:
The lowest containment level (`off` < `auto` < `required`) that user or project config allows a
session to ask for. A request below it is refused, and a request for `auto` that finds no runtime
counts as `off`.
_Avoid_: minimum containment, policy (the config key is spelled `containment.minimum`; say floor everywhere else)

**Delegated session**:
A session started by another agent through MCP or `lykos run`. It is an ordinary session, and its
caller chooses its containment. Each MCP call runs one in a process of its own, and a later call can
continue it by its session id.
_Avoid_: worker, delegate, worker run, sandbox run, delegated run

**Worktree**:
In a delegated session, the checkout Lykos makes outside the project for one writing call, on a
`lykos/` branch named from the session id. It is removed when the call ends and the branch stays.
_Avoid_: sandbox copy, scratch checkout, clone

**Write in place**:
The caller's opt-in for a delegated session to write in the caller's own tree, on no branch of its
own. Outside a git repository it is the only way a writing session runs, and then it makes no commits.
_Avoid_: unsafe mode, direct write

**Session id**:
The id every delegated session returns, which a later call passes to continue that session.
_Avoid_: run id, job id, thread id

**Coordinator**:
The agent that delegates to Lykos and acts on what comes back: another agent, or
Lykos itself. It answers a delegated session's questions and rules on its disputes.
_Avoid_: orchestrator, caller (except for the MCP client), parent, lead

**Result contract**:
What a delegated session returns, built from evidence the harness collected rather than from the
model's own account, so a coordinator can act on it without reading the transcript. The model's
text rides along and counts as a self-report.
_Avoid_: worker result, report, summary

**Loop**:
The agent's working cycle on a real task, off which the strength mechanisms hang: post-edit
feedback, checkpoints, continuation, the reviewer.
_Avoid_: engine, pipeline, harness

**Context strategy**:
The one setting that decides what a session does as its context window fills: self-compact,
continuation, or Pi's own compaction. Exactly one runs; Pi's compaction stays underneath as the last resort.
_Avoid_: compaction mode, overflow policy

**Self-compact**:
The context strategy in which the agent, warned as its window fills, writes its own note to self and
compacts its history, getting the note back unchanged. The session continues; nothing restarts.
_Avoid_: auto-compact, summarize, handoff (unqualified)

**Prune**:
Overwriting an earlier tool result in what the model is sent with a short notice, because a newer
result has made it stale (a superseded read) or its tool judged it said nothing (a useless result).
Decided once, recorded, and applied to every later request; the transcript keeps the original.
_Avoid_: snip, trim, truncate (the byte cap on a fresh result is a different thing)

**Compaction method**:
One of the ways a compaction can be done, tried in a configured order until one works: the agent's own
note, a handoff written by a side call, a shake, or Pi's summary. A method that fails falls through to
the next; Pi's summary is always last.
_Avoid_: compaction mode, compaction strategy (that is the context strategy)

**Shake**:
A compaction method that drops the text of old tool results from what the model is sent, with no model
call, because the agent can run the tool again. Decided once, recorded, and applied to every later request.
_Avoid_: prune (a prune is every-turn and cache-guarded; a shake is a compaction and is not)

**Continuation**:
The context strategy that ends the session at the boundary and starts a successor from a handoff.
_Avoid_: restart, rollover

### Measurement and record

**Ledger**:
The SQLite database recording every session and every model call. It is written by the product and
never by an agent.
_Avoid_: telemetry store, metrics database, analytics

**Session**:
One continuous run of the agent. A resume continues the session it names rather than creating a new
one.
_Avoid_: conversation, run, thread

**Seal**:
The record that freezes a test writer's failing tests, plus the test harness, against later change on
a branch. It lives in the branch's signed seal file under `.lykos/seals/`, and it holds only if the
signature verifies and `git diff` from the seal commit over the sealed paths stays empty (ADR-0034).
_Avoid_: lock, test firewall (the problem it solves), freeze

**Dispute**:
An implementer's claim that a sealed test is wrong, filed with `dispute_test` instead of an edit and
decided by the test writer, the orchestrator or a human. An upheld dispute leads to a reseal.
_Avoid_: test change request, objection, override

**Veto**:
The refusal of a tool call before execution by a Lykos extension (e.g. `lykos-seal` vetoing edits or writes to sealed paths). Unlike a gate denial which prompts or enforces permission modes, a veto unconditionally blocks the action and logs a vetoed event.
_Avoid_: rejection, denial, block (unqualified)

**Gate check**:
A block-only verification check contributed by a Lykos extension (e.g. `lykos-seal`), executed after the verification command or at session end. A gate check can turn an outcome from success to fail or block a passing local run, but cannot turn a failure into success.
_Avoid_: test runner, post-hook, gate interceptor

**Green run**:
The execution of sealed test files in a clean checkout of HEAD during the verification gate, confirming that the implementer's committed changes pass the frozen test suite without relying on uncommitted working tree modifications.
_Avoid_: verify run, test pass, second run

**Weakening scan**:
A gate check run by `lykos-seal` at session end that scans added lines in non-sealed files since the seal commit for forbidden patterns (e.g. `.skip(`, `.only(`, `xit(`, or test environment checks) that would bypass tests.
_Avoid_: lint check, anti-cheat, leak scan

**Verified success**:
A session outcome written by a verification command or by a human. An agent's own report of success
is never one.
_Avoid_: completion, pass, done

**Kill criterion**:
A dated condition under which a mechanism was deleted rather than disabled. Removed by ADR-0049; none
is armed, and a manual retrospective decides removals.
_Avoid_: sunset, deprecation, feature flag cleanup

**Demonstration**:
The named, checkable thing a phase must show working before it closes. It replaces the ledger
thresholds that five consecutive phases closed without meeting.
_Avoid_: exit criterion, acceptance gate, success metric

### Model access

**Credential**:
One API key or one OAuth account, for one provider. One email holding two subscriptions is two
credentials.
_Avoid_: account, key, login, auth

**Credential pool**:
Every credential Lykos holds for one provider.
_Avoid_: keyring, account list, auth store

**Rotation**:
Switching a session's active credential to another in the same pool after the active one fails.
_Avoid_: failover, key cycling, fallback (unqualified)

**Cooldown**:
A span during which a credential is skipped, set when it hits a rate or usage limit.
_Avoid_: block, ban, backoff
