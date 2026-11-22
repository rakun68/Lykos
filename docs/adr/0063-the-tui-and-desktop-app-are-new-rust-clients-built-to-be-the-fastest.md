# The TUI and the desktop app are new Rust clients, built to be the fastest

Decided by the maintainer on 2026-11-23, opening P5. **Amends [ADR-0046](0046-the-tui-is-a-client-of-the-engine.md)
and [ADR-0052](0052-rust-where-a-profile-names-the-hot-path.md)**: the TUI's stack is chosen now, by the
maintainer, not from measured startup and frame times.

## The decision

**1. Rust, for both.** The terminal interface (P5) and the desktop app (P6) are written in Rust. They
support Linux and Windows. macOS is deferred until the maintainer has a Mac to test on: nothing is
built or claimed for it before then.

**2. The engine stays on Node** (ADR-0052). Both apps are clients of it, as ADR-0046 decided. How they
connect is decided in P5's grill and recorded in a later ADR.

**3. Copy OpenCode first, then make it ours.** The new TUI does what OpenCode's TUI does, read from
OpenCode's source at its head when P5 starts, and is tweaked toward Lykos's own design after it works.
Behaviour and layout are copied; no OpenCode code enters this repository (rule 2). It has, at least:

- **Ctrl+P** opens a palette listing every action the TUI can take.
- **The chat sits in one large box.**
- **The model, the context window and its use, and the reasoning effort** are always on screen.
- **Every key binding can be changed** by the user.

**Where Lykos is better: the prompt box is a real text editor**, as the current TUI's is: cursor
movement, selection, undo, long pastes.

**4. A hard rule: the fastest, lightest TUI.** Speed and footprint come before features and looks in
every TUI decision. Every corner is optimized; the source of the fastest open-source terminal apps is
read for how they do it; an inefficient TUI is never shipped. Startup time, keystroke-to-screen
latency, frame time, idle CPU, memory and binary size are measured, never estimated (rule 4). The
desktop app follows the same rule.

**5. The current TUI is replaced, not ported.** `lykos/tui/` stays usable until the new TUI passes
P5's demonstration, and is then removed in P5. Anything outside rendering that lives there now, such
as the IO-mode decision MCP mode depends on (rule 8), moves to the engine first.

**6. Separate packages, one repository.** The Rust apps live in a Cargo workspace beside the Node
package: a shared client crate (the connection to the engine and the view-models both apps read), the
TUI, and the desktop app. Each ships as its own prebuilt binary per platform, so no user needs a Rust
toolchain (ADR-0052). `lykos` with no arguments starts the new TUI once it replaces the old one.

## Why

The maintainer ranks the TUI's speed and footprint above everything else in it. Rust gives direct
control over allocation, rendering and startup, and one language for the TUI and the desktop app lets
them share the client and its view-models (P6's soft dependency on P5). OpenCode is the bar ADR-0046
already named; copying it first means the design starts from a working layout instead of a blank page.

## What it rules out

- A port of the current TUI, or a TUI in TypeScript.
- Building or claiming macOS support before it can be tested on a Mac.
- A TUI change that makes it slower or heavier without a measurement showing the trade and a reason.
- Copying OpenCode's code: its behaviour is read from source, then written here.
