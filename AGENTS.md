# Lykos — agent orientation

Read this before proposing or writing anything. It links; it does not restate.

Maintainers keep the plan, decisions and findings outside the repository. If
`../Lykos_Dev/AGENTS.md` exists, read it too: it takes precedence over this file.

---

## What Lykos is

A coding agent built on the Pi runtime, in TypeScript on Node, with a SQLite ledger. It runs
**standalone**, as an **MCP worker** under an orchestrator, and, later, **under human supervision**
through a desktop application. The interface today is the terminal: the TUI in `lykos/tui/`.

**What it is not.** Not a fork of Pi: translate at the boundary.

**Nothing it runs is ever deleted.** Every task is archived and every conversation is resumable.

**Priority order:** strength first, then speed and cost, then customization, user experience,
lightweightness, memory and collaboration.

---

## Where things are

| | |
| --- | --- |
| [lykos/](lykos/) | **Source tree**: `tools/`, `session/`, `gate/`, `loop/`, `ledger/`, `tui/` (pixels only), `cli/` adapters |
| [docs/reference/](docs/reference/) | Reference specifications: CLI and config, MCP, sessions, specialists, telemetry, UI |
| [docs/adr/](docs/adr/) | Decisions. Authoritative when a doc disagrees with one |
| [GLOSSARY.md](GLOSSARY.md) | The glossary. Use its words |

---

## The rules

**1. Check the premise against source at the moment you build it**, not at the moment it was
written. A claim about the runtime is only as good as the last time somebody read the runtime.

**2. Before building a mechanism, read `examples/extensions/` in the installed Pi package.** Pi
may already ship it. Read source, never a summary of it. Other projects' source trees never enter
this repository: they carry their own licences.

**3. Adopt what installs; reimplement what does not.** Read the source before depending on
anything, and never delegate what Lykos must own: the gate, model policy, the MCP contract, the
archive.

**4. Never fabricate a number.** No evidence means "unmeasured", never an estimate. **An agent's
self-report never counts as success**: only a verification command or a human. **Nothing is
backfilled.**

**5. Prices come from primary provider documentation only.** Never from memory.

**6. Measurement never gates a change.** A change lands on its demonstration. Nothing is deleted on
a date or a threshold.

**7. Translate at the boundary; never patch Pi.** Where an extension expects a Pi path, generate that
content from Lykos's own.

**8. Runtime state lives in `.lykos/`, never `.pi/`**, and **stdout belongs to the transport in MCP
mode**: one place decides the IO mode, every writer asks it.

**9. Nothing enters the frozen head unless it is fixed for the whole session.**

---

## Traps

**A guard that is never given anything to guard is decorative.** When you build a guard, test it
against the real input, not a stand-in.

**The ledger records cache read and cache write separately per call.** `avoided` is a model, never
a measurement, and a gateway's model name is not an endpoint.

**`npm test` writes the user's `~/.lykos/projects.json`.** Back it up before a full run.

---

## Git

Commit every change, with a message that says what and why. Per-developer agent configuration
(`.claude/`, `.lykos/`, `.mcp.json`) is ignored and stays out of commits.
