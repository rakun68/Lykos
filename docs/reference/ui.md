# Lykos — Terminal User Interface Reference

**Companion to:** `docs/reference/cli-and-config.md`
**Status:** Living reference specification for the terminal UI and HUD components.

---

## 0. UI Architecture

Lykos provides a zero-dependency, pure Node terminal user interface operating across three levels:

1. **Inline HUD (`lykos hud`):** A lightweight single-line or two-line status banner drawn during
   plain streaming execution.
2. **Full-screen Interactive Surface (`lykos run --interactive`):** An alternate-screen terminal
   application with a dedicated multi-line composer, scrollback transcript, interactive approval
   modal, and slash command dispatcher.
3. **Live Watch Surface (`lykos watch`):** A multi-panel dashboard monitoring in-flight or
   historical sessions.

P5 replaces the full-screen surface with a Rust client (`crates/tui`, ADR-0063) on the engine
server (`lykos serve`, [engine-server.md](engine-server.md)). The client crate `crates/client`
connects to it, starts it when none answers, and rebuilds each session from its event stream.

---

## 1. Themes & Color Resolution

The UI themes are purely declarative palettes defined in `lykos/tui/theme/palettes.ts`.
Themes provide semantic color tokens (`primary`, `secondary`, `accent`, `muted`, `success`,
`warning`, `error`, `border`, `bg`, etc.).

- **Default Theme:** `sky` (cool cyan/blue accents on dark background).
- **Available Themes:** `sky`, `rose-pine`, `nord`, `dracula`, `gruvbox`, `tokyo-night`, `catppuccin`, `mono`.
- **Color Mode (`ui.color`):**
  - `auto`: Emits ANSI sequences if stdout is a TTY and `NO_COLOR` is absent.
  - `always`: Forces ANSI formatting.
  - `never`: Strips all color sequences (honored automatically when `NO_COLOR` environment variable is set).

---

## 2. Full-Screen Interactive Surface

The full-screen interface uses standard VT escape sequences to claim the alternate screen buffer
(`\x1b[?1049h`), installing a stderr sink so asynchronous diagnostics do not corrupt rendering.

### 2.1 Composer & Input Controls
The input composer is a multi-line buffer with word-wrapping and bracketed paste handling:

| Keybinding | Action |
|---|---|
| `Enter` | Submit current prompt (or insert newline if unclosed block) |
| `Shift+Enter` | Insert literal newline |
| `Shift+Tab` | Cycle primary specialists; queues the specialist stream message for the next turn (ADR-0044) |
| `Ctrl+Up` | Recall previous prompt from `.lykos/history.json` |
| `Ctrl+Down` | Recall next prompt from `.lykos/history.json` |
| `Ctrl+R` | Interactive prefix-filtered history search |
| `Shift+Tab` | Reserved (no longer cycles modes; reserved for specialist cycling in T216) |
| `PgUp` / `PgDn` | Scroll transcript viewport up/down |
| Mouse Wheel | Scroll transcript viewport smoothly |
| `Escape` | Dismiss completion popup or cancel search |
| `Esc Esc` | On an empty input, `/rewind` (T263) |

### 2.2 Built-in Slash Commands
Commands are dispatched locally without incurring LLM turns:

- `/help`: Show available slash commands.
- `/mode [name]`: Show current permission mode (bare) or switch active permission mode (`<manual|accept-edits|auto>`).
- `/permissions [subcommand]`: Inspect or adjust remembered project permissions. Bare shows active mode, outside rules, extra allowed directories, remembered approvals, and path rules command enforcement status (`path rules: enforced for file tools; commands <enforced|best effort>`).
  - `/permissions mode <manual|accept-edits|auto>`: Switch and persist the project's permission mode.
  - `/permissions outside <read|write> <ask|allow|deny>`: Set rule for access outside project directory.
  - `/permissions dir <add|remove> <path>`: Add or remove an extra allowed directory.
  - `/permissions revoke <pattern|all>`: Revoke remembered command approvals.
- `/model <provider/model>`: Switch active model for the remainder of the session (advisory: next turn may pay for cold prefix).
- `/effort <off|low|mid|max>`: Adjust reasoning effort level and composer border hue.
- `/session`: Display current session ID, token totals, and running cost.
- `/rewind`: Pick an earlier prompt, then restore code and conversation, conversation only, or code only, or summarize from here (or cancel). Summarize asks for an optional note ("add context for the summary (optional)"; Enter with none, Esc back) and makes one model call; the prompt and the turns after it become one summary in context, the files untouched (T265). A conversation rewind or a summarize puts the prompt back in the input box; nothing is deleted and there is no redo (`sessions-and-archive.md` §2.2.1). A resumed session lists its prompts from before the resume too; rewinding the conversation to one ends the session and resumes it from its transcript there, same id, the prompt in the input box; summarize is refused for those (T264). Refused while a turn runs.
- `/export [file]`: Write this session's conversation as Markdown to `file` (relative to the working directory), or with no file put it on the clipboard through OSC 52. Read from the transcript (sessions-and-archive §2.4). A session too large for the terminal's clipboard is refused with a message, never claimed as copied; the file form still works.
- `/output-style [name]`: List available output styles (bare) or switch active output style in stream (`<name>`).
- `/fork`: End this session and continue in a copy of it, a new session forked from it at its last turn; the turns a rewind undid are not copied, and this session is kept as it is (`sessions-and-archive.md` §2.1.1; T266). Refused while a turn runs.
- `/close-session`: Mark current session closed and exit.
- `/new`: Start a fresh session.
- `/skill:<name>`: Load and invoke a specific registered skill.

### 2.3 Tab Completion of Slash Commands
`/` then `Tab` offers every slash command the session can run, from one list built the way Claude
Code builds its own (`src/commands.ts` `getCommands`: every source merged into one list, each
command carrying where it came from). The sources, in the order a colliding word is dispatched:

1. **Skills** (`[skill]`) — every skill discovered under `.lykos/skills/`; one whose name a built-in
   owns is offered as `/skill:<name>`.
2. **Lykos extension commands** (`[lykos ext <name>]`) — registered with `registerCommand` on the
   Lykos extension API.
3. **Built-ins** (`[builtin]`).
4. **Pi extension commands** (`[pi ext <name>]`) — registered through Pi's `pi.registerCommand`,
   such as `/self-compact`, read from Pi's extension runner when the session boots. Typing one sends
   it to Pi, which runs it. Two Pi extensions registering the same word are both offered, under
   Pi's own names (`/foo:1`, `/foo:2`).

A command whose word an earlier source already owns can be typed but never runs, so it is not
offered; instead the session prints one line naming it, the extension that registered it, and what
runs in its place (`lykos: /help from the Pi extension demo is shadowed by the built-in /help; …`).
No registered command is dropped silently.

---

## 3. Interaction Modes & The Approval Modal

Permission modes persist per project in `~/.lykos/permissions.json` (keyed by project ID) and default to
**Manual** on first run (ADR-0041). Permission modes cannot be configured in `config.yaml`.
Modes can be viewed or changed live with `/mode` or `/permissions mode <name>` (or `--mode` on startup).
`Shift+Tab` is reserved and no longer cycles modes.

The approval modal pauses the session loop when a tool request requires human consent:

| Mode | Reads | Writes / Edits | Safe Bash (`npm test`) | Destructive Bash (`rm -rf`) |
|---|---|---|---|---|
| **Manual** | Silent allow | Always prompts | Always prompts | Always prompts |
| **Accept Edits** | Silent allow | Silent allow (reads, writes, edits, mkdir, touch, mv, cp) | Prompts (file removals, other commands) | Always prompts |
| **Auto** | Silent allow | Silent allow | Silent allow for read-only commands, session verification command (ADR-0057), and remembered patterns; prompts once for ordinary work | Always prompts (un-allowlistable) |

When prompted, answers are:
- `y` (or `yes`): Allow this single execution.
- `n` (or `no`): Deny execution.
- `a` (or `always`): Allow and remember the command pattern (`npm test`) for this project session. Destructive commands cannot be allowlisted.

---

## 4. Watch Panels (`lykos watch`)

`lykos watch` renders a real-time multi-panel dashboard over active or recent sessions.

- **Default Panels:** `["now", "cost", "tokens", "context", "health", "session"]`
- **Default Refresh Rate:** 4 Hz (`refresh_hz: 4`).
- **Panel Definitions:**
  - `now`: Elapsed time, active tool name, running phase.
  - `cost`: Run spend, today spend, and headroom against budget caps.
  - `tokens`: Fresh input, cache read, cache write, and output token counters.
  - `context`: Token usage gauge against provider window limits.
  - `health`: Tool schema overhead and prefix stability indicators.
  - `session`: Session ID, task ID, agent, and model specifications.

---

## 5. The Rust TUI (`lykos-tui`, P5)

`crates/tui` builds `lykos-tui`. It draws its first frame before it connects, then connects to the
engine server on a thread, starting one when none answers ([engine-server.md](engine-server.md)).
It sleeps while nothing on screen moves and draws only after a key, an event or a spinner tick.
Its layout and keys follow OpenCode's TUI at `4332e24`, read from source; each place in the code
names the file.

- **Home screen:** the logo and the prompt box centred, the box at most 75 columns wide, the
  workspace in the bottom row. The first prompt starts a server session with origin `tui`.
- **Session screen:** the transcript in one bordered box titled with the session's title, newest at
  the bottom, and the prompt box under it. User messages sit on a raised background behind a bar;
  tool calls show an icon (`→` read, `←` write or edit, `✱` search, `%` web, `$` shell, `⚙` other;
  a spinner while running, `✗` on failure).
- **Prompt box:** a bar in the accent colour (gold while a turn runs), the input, then the model and
  the thinking effort (`model · effort`, the effort in bold gold). Under it, the footer: the spinner
  and `esc interrupt` (`esc again to interrupt` once armed) while a turn runs, else the workspace;
  on the right, `N tokens · P% used` from the last `usage` event.

| Key | Action |
| --- | --- |
| `Enter` | Submit. While a session starts, the prompt waits and shows as `queued` |
| `Shift+Enter`, `Ctrl+Enter`, `Alt+Enter`, `Ctrl+J` | New line |
| `Esc`, then `Esc` within 5 s | Interrupt the running turn |
| `Ctrl+C` | Clear the prompt; on an empty prompt, quit |
| `Ctrl+D` | Quit on an empty prompt |
| `PageUp`, `PageDown`, mouse wheel | Scroll the transcript |
| `Ctrl+G`, `Ctrl+Alt+G` | Oldest, newest |

Where it differs from OpenCode on purpose: the context use is always on screen rather than in a
sidebar, the metadata row has no agent name (Lykos has no agents to switch), the footer shows the
workspace without its git branch (reading it would cost a process at startup), and
`--trust-workspace` replaces a trust dialog until the dialogs land (#46).

Speed (rule 10): `node scripts/tui/gate.mjs target/release/lykos-tui.exe --ready "Ask anything"`
holds startup, keystroke latency, frame time, idle CPU, peak memory and binary size against
`bench/tui-limits.json`. `node scripts/tui/tui-test.mjs` drives it end to end in a pty against the
real server and the scripted session child.
