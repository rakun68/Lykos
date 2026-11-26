# Lykos — agent orientation

Read this before proposing or writing anything. It links; it does not restate.

Maintainers keep the plan, decisions and findings outside the repository. If
`../Lykos_Dev/AGENTS.md` exists, read it too: it takes precedence over this file.

---

## What Lykos is

A coding agent, a fork of Pi, in TypeScript on Node, with a SQLite ledger. It runs
**standalone**, as an **MCP worker** under an orchestrator, and, later, **under human supervision**
through a desktop application. The interface today is the terminal: `lykos-tui`, a Rust client in `crates/`.

**A fork of Pi, said once.** Its engine is Pi `v1.6.1`, renamed to Lykos's own and tracked upstream
only on the maintainer's word ([ADR-0065](docs/adr/0065-lykos-is-a-fork-of-pi.md)). `LICENSE-PI` and one
line of `README.md` name Pi; nothing else does. Until P23 lands, the engine is still the npm package.

**Nothing it runs is ever deleted.** Every task is archived and every conversation is resumable.

**Priority order:** strength first, then speed and cost, then customization, user experience,
lightweightness, memory and collaboration.

---

## Where things are

| | |
| --- | --- |
| [lykos/](lykos/) | **Source tree**: `tools/`, `session/`, `gate/`, `loop/`, `ledger/`, `surface/` (the line session's output), `server/`, `cli/` adapters |
| [docs/reference/](docs/reference/) | Reference specifications: CLI and config, MCP, sessions, specialists, telemetry, UI |
| [docs/adr/](docs/adr/) | Decisions. Authoritative when a doc disagrees with one |
| [GLOSSARY.md](GLOSSARY.md) | The glossary. Use its words |

---

## The rules

**1. Check the premise against source at the moment you build it**, not at the moment it was
written. A claim about the runtime is only as good as the last time somebody read the runtime.

**2. Before building a mechanism, read the engine's source.** It may already ship it. Read source,
never a summary of it. Other projects' source trees never enter this repository: they carry their own
licences. The one exception is the Pi fork, under `LICENSE-PI`.

**3. Adopt what installs; reimplement what does not.** Read the source before depending on
anything, and never delegate what Lykos must own: the gate, model policy, the MCP contract, the
archive.

**4. Never fabricate a number.** No evidence means "unmeasured", never an estimate. **An agent's
self-report never counts as success**: only a verification command or a human. **Nothing is
backfilled.**

**5. Prices come from primary provider documentation only.** Never from memory.

**6. Measurement never gates a change.** A change lands on its demonstration. Nothing is deleted on
a date or a threshold. **The one exception is the TUI and the desktop app** (rule 10): a change that
makes either slower or heavier fails unless the maintainer accepts the trade.

**7. The engine changes only through the upstream script and its patch series** (`scripts/upstream/`,
ADR-0065), so the next upstream import still merges. Pi community extensions load through
`compat/pi-extensions.ts`, the one module that may name Pi.

**8. Runtime state lives in `.lykos/`, never `.pi/`**, and **stdout belongs to the transport in MCP
mode**: one place decides the IO mode, every writer asks it.

**9. Nothing enters the frozen head unless it is fixed for the whole session.**

**10. The TUI and the desktop app are the fastest and lightest there are.** Speed and footprint come
before features and looks; every change is measured, never estimated, and nothing slower or heavier
ships without the maintainer's yes ([ADR-0063](docs/adr/0063-the-tui-and-desktop-app-are-new-rust-clients-built-to-be-the-fastest.md),
[ADR-0064](docs/adr/0064-the-p5-tui-copies-opencode-on-a-local-engine-server-and-speed-gates-it.md)).

---

## Code quality

**Type every value.** Use the exported type by name, or `unknown` narrowed where it is read. `any`
is a last resort that carries a comment saying why nothing else compiles.

**Import types at the top of the file.** Type positions name an imported type, never
`import("x").T`. A runtime `await import()` stays where it defers loading for startup speed.

**Read a dependency's types in `node_modules`** before writing code against it.

**Search before writing a helper.** Extend the existing one; two implementations of one operation
is a bug even when both work.

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
