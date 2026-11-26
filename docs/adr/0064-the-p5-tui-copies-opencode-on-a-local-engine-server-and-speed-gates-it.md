# The P5 TUI copies OpenCode on a local engine server, and speed gates it

Decided by the maintainer in the P5 grill of 2026-11-23 (Q1–Q11). **Amends
[ADR-0063](0063-the-tui-and-desktop-app-are-new-rust-clients-built-to-be-the-fastest.md)** (when the old
TUI goes) and **reverses P22's decision 4** (no redo). OpenCode was read at `anomalyco/opencode`
`4332e24` (2026-11-22, MIT), in the maintainer's reference trees.

## The decisions

**1. A local engine server (Q1).** The engine runs as a local server that the TUI, and later the
desktop app, connect to. It listens on a named pipe on Windows and a Unix socket on Linux, open only to
the user's account: no network port. A client starts it when none is running. OpenCode's Rust client
works the same way against its TypeScript server, over HTTP.

**2. It outlives the TUI for a while (Q4).** After the last client disconnects and no session runs, the
server waits an idle time from config, then exits. `0` exits at once.

**3. Every session is on it (Q6).** Sessions started over MCP and by `lykos run` move onto the server
in P5, after the TUI works, so the TUI can watch and steer them live.

**4. Speed and footprint gate the TUI and the desktop app (Q3).** They are the exception to rule 6:
a change that makes either slower or heavier on startup, keystroke-to-screen latency, frame time, idle
CPU, memory or binary size fails, unless the maintainer accepts the trade. The limits come from the first
real measurements, never from a guess.

**5. P5 closes on two things (Q5).** A person who has used OpenCode completes a session in the new TUI
without asking where anything is; and, measured on the same Windows and Linux machines, the new TUI
matches or beats OpenCode's TUI and the baseline agents' TUIs on startup, keystroke-to-screen latency,
idle CPU and memory.

**6. OpenCode's features first, then the old TUI's (Q7).** Every built-in OpenCode TUI action is
copied, with these changes:

- **Variants are thinking effort**: `variant.cycle` and `variant.list` cycle and list the effort.
- **Delete is archive**: nothing Lykos runs is deleted.
- **Redo is kept (Q10)**: the undone branch is in the archive already, so redo brings it back, code
  and conversation. P22's decision 4 is reversed.
- **Share is not copied**: OpenCode removed it.
- **TUI plugins wait (Q11)** for a later phase that designs them around Lykos's extensions and rule 10;
  OpenCode runs TypeScript plugins on a Bun process and Luau plugins, a second runtime P5 does not ship.

The prompt box is a real text editor; nothing else is a must-have before OpenCode parity. The old TUI's
features (live cost, the cache gauge, the gate's verdict, seal events, permission modes, specialists,
output styles, credentials, handoff and self-compact, the browser overlay) come after.

**7. The old TUI goes with its last wanted feature (Q9).** `lykos/tui/` stays, behind `lykos
--old-tui` once the new TUI is the default, until every old feature the P5 spec lists is in the new one.
It is removed in the commit that lands the last of them. P5 itself closes on decision 5.

**8. Terminals (Q8).** Windows Terminal, GNOME Terminal, kitty, WezTerm and Alacritty must work,
inside tmux and over SSH too. The legacy Windows console runs on a best effort, and no path is slowed
to support it.

**9. Decided without the maintainer**, because none changes what a user sees: the renderer (ratatui,
OpenTUI's Rust crate, or Lykos's own) is chosen by benchmark in P5's first ticket; key bindings live in
the existing project and global config layers and show where each came from; the desktop app's stack is
P6's.

## What it rules out

- A network port, or an engine reachable by another account or a web page.
- A TUI or desktop change that ships slower or heavier than the last measurement without the
  maintainer's yes.
- Removing the old TUI while a feature the spec lists exists only there.
- A second plugin runtime inside the TUI in P5.
