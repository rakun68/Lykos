# Lykos — Specialist Reference

**Companion to:** `docs/reference/cli-and-config.md`,
`docs/adr/0015-profile-vocabulary-is-fifteen-fields.md`,
`docs/adr/0023-the-specialist-vocabulary-is-seventeen-fields.md`
**Status:** Living reference specification for specialists and the boot-freeze discipline.

> **Part built.** T214 (2026-10-20) replaced the specialist `mode` field with `read_only` and added `role`
>. The permission mode is the
> user's, never a specialist's.
> T216 shipped the library as Plan, Build, Explore, General and Review. Specialist text moving out of the head
> into the stream is still to land.

**Two names this document used to carry are gone.** A "preset" is a specialist
(ADR-0001 named the mechanism before the word
settled), and the separate "specialist" — an agent definition that was a preset plus a file format —
was collapsed into the one concept by
ADR-0007, the file format having been the only
difference. That one concept was called a profile until
ADR-0020 reverted the name to **specialist**, leaving the
collapse itself untouched. There is one vocabulary and one file.

---

## 0. Principles: curation, not a second engine

Specialists compose with Pi's native agent and extension models rather than inventing a parallel
runtime.

A specialist is a **YAML file named for the specialist**, discovered from three layers, nearest first:

| Layer | Path |
| --- | --- |
| Project | `.lykos/specialists/<name>.yaml` |
| Global | `<globalDir>/specialists/<name>.yaml` |
| Shipped | `lykos/specialists/<name>.yaml` |

A nearer layer overrides a shipped specialist of the same name. **Shipped files are never edited in
place** — overriding one means copying it to the project or global directory and editing the copy
.

A specialist resolves as the sixth configuration layer at boot. Naming one that does not exist, or one
whose file is invalid, fails before a model call, a ledger row, or a session boot.

---

## 1. The specialist vocabulary

**Nineteen fields**, fixed by ADR-0023,
ADR-0037 and ADR-0043 (amending ADR-0015). The table is the count;
anything quoting a number quotes this table or quotes no number.

### 1.1 Pi-compatible fields (5)

| Field | Meaning |
| --- | --- |
| `provider` | Which provider serves the session (`deepseek`, `anthropic`, …) |
| `model` | Which model, and the fallback if unavailable |
| `thinkingLevel` | Reasoning effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) |
| `tools` | The active tool set, replacing the default. Stated positively, never by subtraction |
| `instructions` | Text injected into the system prompt |

These five translate into Pi's own `Preset` shape and are written to `.pi/presets.json` by
`lykos specialist export-pi` — translation at the boundary, never a patch to Pi. A specialist's `provider:` is accepted when the provider is in `providers:`, has its env var set, or has a `lykos login` in the pool.

### 1.2 Lykos-owned fields (14)

| Field | Meaning |
| --- | --- |
| `read_only` | When `true`, every write and edit is refused and read-only commands run, whatever the permission mode. The permission mode belongs to the user and is not a specialist field |
| `role` | `primary` (the user switches to it, and Shift+Tab cycles it; omitted from `lykos mcp`), `subagent` (only an agent spawns it, exposed via `lykos mcp` as `lykos_<name>`) or `all`, the default (available to both) |
| `skills` | Which skills load for this session. A delegated session's head carries the plan-against-skill block only for skills the specialist names in `skills:`. |
| `feedback` | Whether the post-edit feedback loop runs |
| `gate` | Whether the verification gate runs at session end |
| `tools_add` | Tools to make resident on top of the default set |
| `tools_remove` | Tools to drop from the resident set |
| `description` | One line, shown when listing and read by a coordinator choosing a delegate |
| `prompt_mode` | Whether instructions append to or replace the default prompt head (`append` or `override`) |
| `tools_mode` | Whether disallowed tools are kept in request or removed (`append` or `override`) |
| `rules` | Which **stream rules** load for this session (lands with P11) |
| `delegate` | Whether this specialist may configure a delegated agent. When false, spawning as a subagent is refused. **No tool ceiling** — the specialist's own tool set is the answer, and containment does the limiting |
| `containment` | Where this specialist's commands run: `level` (`off`, `auto`, `required`), `network` (`open`, `none`) and `image`, each optional. Unset means no opinion: project config, global config, then the default decide. A coordinator's stated level overrides it |
| `memory` | Which memory backend this specialist uses. Local by default; an embeddings backend is a value here rather than a prohibition |

`rules` and `memory` are **inert until their phases land**. `delegate` is enforced at spawn time: a specialist declaring `delegate: false` declines to configure a delegated agent. No shipped specialist sets an inert field,
and a test asserts that, so none of them changes behaviour today.

### 1.3 The instructions block and the ponytail ladder

`instructions` is injected into the system prompt. By default it sits alongside Ponytail's minimalism
ladder; a specialist setting `prompt_mode: override` (or using the older marker `<!-- lykos:replace-ponytail -->`)
replaces the ladder instead of joining it. `lykos prompt --show --specialist <name>` prints the head a
session would actually receive, including which of the two happened.

### 1.4 Tool restriction and tools_mode

A specialist that removes or excludes tools makes the agent unable to use them. Under both `append`
and `override` modes, a call to a disallowed tool is refused at dispatch, with an actionable error
naming the specialist that disallowed it. Refusals are recorded in the ledger.

- `tools_mode: append` (default): The tool list in the request is unchanged (preserving schemas and
  prefix cache), and the off-limits notice is stated to the model. In a driven session that notice
  rides in the stream message; in a
  subagent it is a head block. Calls to off-limit tools are refused at dispatch either way.
- `tools_mode: override`: Disallowed tools are removed from the request entirely, reducing token
  cost. Calls to disallowed tools remain refused if emitted.

The difference between the two is token cost and clarity, never safety: both modes enforce the
restriction.

---

## 2. The boot-freeze discipline

System prompts, rules and tool schemas ride in the prompt head block, and prefix caching keys off a
byte-identical prefix from turn to turn.

> **A specialist's instructions and skills are resolved at session boot and frozen. Changing either
> requires a new session.**

### 2.1 What a mid-session switch does and does not change

`/specialist <name>` resolves the named specialist against the same layer stack the session booted under
and reports every field that differs. **The report describes the resolved config, not what was
applied** — these are not the same set:

| Applied live | Not applied live |
| --- | --- |
| `thinkingLevel` | `model` / `provider` — keeps running model (ADR-0021) |
| `read_only` posture ceiling | `instructions` in a subagent — they are in its head |
| Off-limit restrictions (via guard) | `skills` — frozen at boot |
| `instructions`, off-limits notice and permission mode, as a stream message | |
| | Tool list in request — held still for prefix cache (ADR-0021) |

Two consequences worth stating plainly, because both are easy to misread:

1. **The prompt prefix and tool list stay byte-identical.** A switch always appends and keeps the running
   model (ADR-0021). The request's tool list is not mutated via `setActiveToolsByName()`, preserving
   the prompt cache and thinking blocks. Instead, disallowed tools become off limits and are refused
   at dispatch by the specialist guard. The switch report includes notices indicating any off-limit
   tools, preferred models not adopted, and inactive prompt overrides.
2. **`read_only` applies live on both surfaces.** When switching to a specialist with `read_only: true`,
   the gate's read-only posture ceiling tightens immediately so that non-read actions are denied;
   switching to a writing specialist lifts the ceiling so that actions are governed by the user's
   active interaction mode.

**Where specialist text lives (T215, ADR-0044).** A session a person drives boots with
`neutralHead: true`: the head and the request's tool list are byte-identical whichever specialist
started it, and carry no specialist block, off-limits notice or mode text. `boot()` returns
`specialistMessage`, built by `specialistStreamMessage` (`lykos/session/specialist-stream.ts`), and
the interactive loop sends it ahead of the first user turn through the same queued-notice path as the
mode and output-style notices. `/specialist <name>` and the Shift+Tab cycle queue a new message
that opens "The instructions of specialist `<previous>` no longer apply.", then the new name, its
instructions, off-limits notice, the narrowed tool set if any, and the permission mode. A mode change
still sends its own notice. `lykos prompt --show --specialist <name>` prints the neutral head and,
in a separate "specialist stream message" section, the message the session would send; with
`--context subagent` it prints the head a subagent gets.

### 2.2 Permission gating is independent of the tool surface

A read-only specialist is read-only twice over: its `tools` list omits the writing tools, and `read_only: true`
imposes a ceiling at the approval gate that no interaction mode can lift.
`decideForMode(mode, action, allowed, { readOnly })` in `gate/modes.ts` is the whole policy — when `readOnly` is true,
every non-read action is denied outright, and remembered approvals cannot lift it. Reads and read-only commands
continue to run.

---

## 3. The shipped library

Seven specialists, discoverable by name with no configuration
.

| Name | Role | Shape |
| --- | --- | --- |
| `plan` | primary | Read-only planning |
| `build` | primary | The default. Small, well-understood changes: the Ponytail ladder, low thinking, the post-edit feedback loop and the verification gate |
| `explore` | subagent | Read-only orientation in an unfamiliar codebase |
| `general` | subagent | A general helper for a side task |
| `review` | subagent | Reviewing a change it did not write |
| `test-writer` | subagent | Writes failing tests and stubs, then commits them without implementing |
| `implementer` | subagent | Makes sealed tests pass without modifying them, reporting wrong tests with dispute_test |

A session started without `--specialist` runs `build`. `minimal` became an output style
. `deliberate` and `scout` are deleted. Switching specialists live applies
`read_only`: a read-only specialist tightens the ceiling, and one that is not read-only lifts it, so a
switch from `plan` to a writing specialist leaves the session governed by the user's permission mode alone.
