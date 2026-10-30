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
- `/output-style [name]`: List available output styles (bare) or switch active output style in stream (`<name>`).
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
