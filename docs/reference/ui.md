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
- `/rewind`: Pick an earlier prompt, then restore code and conversation, conversation only, or code only, or summarize from here (or cancel). Summarize asks for an optional note ("add context for the summary (optional)"; Enter with none, Esc back) and makes one model call; the prompt and the turns after it become one summary in context, the files untouched (T265). A conversation rewind or a summarize puts the prompt back in the input box; nothing is deleted and `/rewind` has no redo (`sessions-and-archive.md` §2.2.1). A resumed session lists its prompts from before the resume too; rewinding the conversation to one ends the session and resumes it from its transcript there, same id, the prompt in the input box; summarize is refused for those (T264). Refused while a turn runs.
- `/undo`, `/redo`: Undo the last prompt, code and conversation, the prompt back in the input box; each `/undo` goes one further. `/redo` takes back every undo since the last prompt at once and is refused once a prompt has been sent (OpenCode `session.undo`, `session.redo`; P5 #42, `sessions-and-archive.md` §2.2.1). Refused while a turn runs.
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

- **Completion:** `/` at the start of the prompt lists the TUI's own commands, then the session's
  (from its `commands` event); `@` at the start or after a space lists the workspace's files
  (`git ls-files -co --exclude-standard`, else a walk capped at 20,000 that skips dot directories,
  `node_modules` and `target`). Up, Down, `Ctrl+P`, `Ctrl+N` move; `Tab` inserts; `Enter` runs a TUI
  command and inserts anything else; `Esc` hides. A picked image file becomes an image chip.
- **Chips:** a paste of 3 lines or more, or over 150 characters, is one `[Pasted ~N lines]` chip,
  sent expanded. Pasting the same text again right after it, or clicking it, expands it in place.
- **Queue:** `Ctrl+X Enter` queues the prompt; it shows as `queued: ...` and goes when the session is
  idle. `Enter` while a turn runs sends the prompt at once as a steer.
- **History:** the workspace's `.lykos/history.json`, the last 500 prompts, shared by every TUI in it.
- **Stash:** `~/.lykos/tui/prompt-stash.jsonl` (or `$LYKOS_TUI_DIR`), the last 50.

TUI commands: `/btw <question>` (asks aside: the answer opens in a dialog, `c` copies it, `Esc`
closes; the transcript is untouched), `/editor`, `/images`, `/queue` (`Ctrl+U` takes a queued prompt
back into the box, `Ctrl+D` deletes it), `/stash`, `/stash list` (`Enter` restores, `Ctrl+D`
deletes), `/stash pop`.

| Key | Action |
| --- | --- |
| `Enter` | Submit. Before a session is up, the prompt waits and shows as `queued` |
| `Shift+Enter`, `Ctrl+Enter`, `Alt+Enter`, `Ctrl+J` | New line |
| `Ctrl+X` then, within 2 s, `Enter` / `E` / `I` / `Q` | Queue the prompt / open `$VISUAL` or `$EDITOR` / the images / the queue |
| `Esc`, then `Esc` within 5 s | Interrupt the running turn |
| `Ctrl+C` | Copy the selection; else clear the prompt; on an empty prompt, quit |
| `Ctrl+D` | Delete forward; on an empty prompt, quit |
| `Left`, `Right`, `Ctrl+B`, `Ctrl+F`; with `Shift` to select | Move a character |
| `Up`, `Down` | Move a row; at the first row, the start, then the previous prompt (`Down` mirrors) |
| `Ctrl+Up`, `Ctrl+Down` | Previous, next prompt |
| `Ctrl+R` | Search the history by what is typed, newest first; again for the next, `Enter` submits, `Esc` keeps |
| `Home`, `End`, `Ctrl+A`, `Ctrl+E`; `Alt+A`, `Alt+E` | Line start, end; visual row start, end (`Shift` selects) |
| `Shift+Home`, `Shift+End`, `Super+A`, triple click | Select to the start, to the end, all |
| `Alt+F`, `Alt+B`, `Ctrl+Right`, `Ctrl+Left` | Word forward, back (`Shift` selects) |
| `Alt+D`, `Ctrl+Delete`; `Ctrl+W`, `Ctrl+Backspace`, `Alt+Backspace` | Delete a word forward; back |
| `Ctrl+K`, `Ctrl+U`, `Ctrl+Shift+D` | Delete to the line end, to the line start, the line |
| `Ctrl+X` (with a selection), `Ctrl+V` | Cut, paste what was cut or copied |
| `Ctrl+Z`, `Ctrl+-`; `Ctrl+Y`, `Ctrl+.`, `Ctrl+Shift+Z` | Undo; redo (200 steps, at most 16 MiB) |
| Click, drag, double click | Place the cursor, select, select a word |
| `PageUp`, `PageDown`, `Ctrl+Alt+B`, `Ctrl+Alt+F`, mouse wheel | Scroll the transcript a page |
| `Ctrl+Alt+Y`, `Ctrl+Alt+E`; `Ctrl+Alt+U`, `Ctrl+Alt+D` | Scroll a line; half a page |
| `Ctrl+G`, `Alt+Home`; `Ctrl+Alt+G` | Oldest, newest |
| `Ctrl+P` | The command palette |
| `Ctrl+H` | Delete a word back, as `Ctrl+W` |

Copying writes OSC 52, so it reaches the system clipboard where the terminal allows it.

**Keybinds (#39).** Every key above is an action with an id, named as OpenCode's `config/keybind.ts`
names it (`input.undo`, `session.page.up`, `prompt.autocomplete.next`), plus Lykos's own
(`prompt.copy`, `prompt.cut`, `prompt.history.search`, `dialog.close`, `aside.copy`). The table is
in `crates/tui/src/keymap.rs`. `tui.keybinds` in any config layer rebinds an action:

```yaml
tui:
  keybinds:
    leader: ctrl+o              # the leader; default ctrl+x
    app.exit: ctrl+q            # a key list: "a,b"
    input.undo: [ctrl+z, alt+u] # or a list of keys
    session.aside: <leader>b    # <leader> then a key
    input.redo: none            # "none" or false unbinds
```

The last layer to name an action wins. A key reads `ctrl+`, `alt+`, `shift+`, `super+` before a key
name (`return`, `escape`, `pageup`, `a`, `-`). An unknown action or a key that does not parse is
skipped, and the TUI says so in a notice. Where two actions share a key, the first that applies
runs: `Ctrl+C` copies a selection, else clears the prompt, else quits.

`Ctrl+P` opens the palette: every action of the App, Session, Agent, System, Prompt and Input groups, with its keys
and, where it is not a default, the layer that set it. Typing filters it by title, group and id
(the title weighted twice); `Enter` runs the selected action. `/help` lists every key of every
group and the layer that set it.

Where the keybinds differ from OpenCode on purpose:

- Lykos's defaults are this table's: `app.exit` has no `<leader>q` (that is the queue), and the
  input actions keep the readline keys of section 2.1 (`Ctrl+A` line start, `Ctrl+Z` undo).
- A value is a string or a list of strings; OpenCode's key stroke objects are not read.
- The palette has no category headers and no suggested section, and leaves out the palette itself.
- OpenCode's help dialog only points at the palette; Lykos's lists every key.
- The keys inside the images list (`Left`, `Right`), the aside dialog (`j`, `k`, `q`), the history
  search and the answer digits are fixed.

**Lists and dialogs (#41).** OpenCode's model, variant, agent, theme and provider dialogs, and its
status and debug dialogs. A list opens on the row in use (marked `●`), typing filters it, `Enter`
chooses. The lists come from the session (`session.options`, [engine-server.md](engine-server.md)),
asked for when it boots and each time a list opens; a choice goes to the session as its slash
command, so it takes effect on the next request.

| Key | Command | Action |
| --- | --- | --- |
| `Ctrl+X M` | `/models`, `/model` | The models: Favorites, Recent, then each provider; `Ctrl+F` favorites the row, `Ctrl+A` the providers, `Ctrl+U` usage. Sends `/model provider/id` |
| `F2`, `Shift+F2` | | Next, previous recently used model |
| `Ctrl+T` | `/effort` | Next thinking effort, wrapping; `/effort` lists them. Sends `/effort level` |
| `Ctrl+X A`, `Shift+Tab` | `/agents`, `/specialist` | The primary specialists; `Shift+Tab` the next. Sends `/specialist name` |
| | `/themes` | The themes, previewed under the cursor; `Esc` puts back the one open before |
| | `/connect`, `/login` | The providers and whether Lykos reaches each; a browser sign-in sends `/login name`, an API key points to `lykos login name --api-key` |
| `Ctrl+X S` | `/status` | Engine server, session, model, effort, specialist, theme, MCP servers |
| | `/mcps` | MCP servers |
| | `/debug` | Version, OS, terminal, session id, model; `c` copies |

`model.cycle_favorite`, `variant.list`, `usage.show`, `theme.switch_mode` and the rest have no key
by default; the palette runs them. With an argument, `/model`, `/effort`, `/specialist` and `/login`
go to the session as before. Six themes: `sky` (the default), `rose-pine`, `rose-pine-moon`,
`rose-pine-dawn`, `catppuccin-mocha`, `catppuccin-latte`; the mode switch goes to the other of a
dark and light pair. The theme, the last 10 models (newest first) and the favorites are kept in
`~/.lykos/tui/state.json` (or `$LYKOS_TUI_DIR`).

Where the lists differ from OpenCode on purpose:

- Thinking effort replaces variants, and its cycle wraps with no "default" step.
- Primary specialists replace agents.
- Before a session exists the lists are empty: they come from the session's own runtime.
- The model list shows no usage limits; the usage dialog shows Lykos's own cost and cache figures.
- No variant list follows a model choice.
- Six palettes, no `ansi16` or `mono`, and no `theme.mode.lock`; `ui.theme` in config is not read.
- A Lykos session connects to no MCP servers, so both dialogs say so.
- An API key is never typed into the TUI.
- The debug dialog has no date row.
- `/usage` and `/thinking` stay the session's commands.

**Sessions and tabs (#42).** OpenCode's session list, tabs, timeline and session actions. The list,
rename, archive, export and worktrees go to the engine server (`sessions.history`, `session.rename`,
`session.archive`, `session.export`, `session.move`, `worktree.*`,
[engine-server.md](engine-server.md)); fork, compact, undo and redo go to the session as `/fork`,
`/compact`, `/undo` and `/redo` (section 2.2).

| Key | Action |
| --- | --- |
| `Ctrl+X N` | New session: the home screen; the next prompt starts it in a new tab |
| `Ctrl+X L`; `Ctrl+O` | The session list of this project; of every project |
| `Alt+Up`, `Alt+Down`, `Ctrl+Shift+Tab`, `Ctrl+Tab` | Previous, next tab, wrapping |
| `Alt+Shift+Up`, `Alt+Shift+Down` | Previous, next unread tab: a session whose turn ended out of sight |
| `Ctrl+X W`; `Ctrl+Shift+T` | Close the tab (the session keeps running on the server); reopen the last closed, where it was |
| `Ctrl+X 1` to `Ctrl+X 0`, `Ctrl+1` to `Ctrl+0` | Tab 1 to 10 |
| `Ctrl+X G` | The timeline: the session's prompts, newest first; `Enter` scrolls to one |
| `Ctrl+X C`; `Ctrl+X U`; `Ctrl+X R` | Compact; undo the last prompt, back into the box; redo |
| `Ctrl+X X` | Export: P22's Markdown, as `lykos export` writes it, to `session-<id>.md` in the workspace |

TUI commands: `/sessions` (bare `/resume` too) the list, `/open` every project's, `/timeline`,
`/worktrees`; bare `/new` and `/rename` run the TUI's, and with an argument go to the session.

The session list shows root sessions that are not archived: Pinned first, then by the UTC day they
started (`Today`, else the date), newest first, the one shown marked `●` and a pinned one `*`.
Typing filters by title. `Enter` shows the session's tab when it runs here, and resumes it otherwise
(the resume's preflight question shows as a request). `Ctrl+D` twice archives it: the ledger row and
transcript stay, `lykos session --all` lists it, and a resume clears the archive. `Ctrl+R` renames it,
`Ctrl+F` pins it (kept in `state.json`), `Ctrl+A` switches between this project and every project.

Manage workspaces (`/worktrees`) lists the
project's worktrees. `Enter` or `Ctrl+M` moves the session there: it closes and resumes in that
directory under the same ledger session. `Ctrl+A` creates a worktree, at
`~/.lykos/worktrees/<project id>/<name>` on the branch `lykos/<name>`; `Ctrl+D` twice removes one,
committing work left in it onto its branch first; `Ctrl+R` refreshes. A worktree session writes the
main checkout's ledger, so removing the worktree leaves its sessions listed and resumable.
`session.cd` moves the session to a directory typed in.

No key by default, the palette runs them: rename, fork, copy the transcript (Markdown), copy the
session id, manage workspaces, change directory, tab history back and forward, and the parent and
child sessions (`session.parent`, `session.child.first`, `.next`, `.previous`, from the ledger's
parent links).

Where sessions and tabs differ from OpenCode on purpose:

- Delete archives; nothing is deleted.
- Fork forks at the current point (P22's `/fork`), not from a chosen message.
- Worktrees are on a `lykos/<name>` branch, not detached, and removal commits what was left in them.
- The parent and child keys (OpenCode's arrows) and tab history forward (`Ctrl+I`, which a terminal
  sends as `Tab`) are unbound; `session.rename` has no key in the prompt, where `Ctrl+R` searches
  history.
- The session list groups by UTC day and shows the start time; there is no server-side search and
  no quick-switch slots (they share `Ctrl+X 1` to `9` with the tabs).
- Export writes Markdown only, to the workspace, named after the session; there are no export options.
- The timeline shows no times: the transcript keeps none per message.
- Closing a tab leaves its session running until the server's idle timeout.

Where it differs from OpenCode on purpose: the context use is always on screen rather than in a
sidebar, the metadata row has no specialist name, the footer shows the
workspace without its git branch (reading it would cost a process at startup), and
`--trust-workspace` replaces a trust dialog until the dialogs land (#46). In the prompt:

- `Ctrl+X` cuts when text is selected, and is the leader otherwise.
- `Ctrl+R` searches the history, as the old TUI did, where OpenCode renames the session.
- `Home` and `End` are line start and end; OpenCode's are buffer start and end.
- `Ctrl+A` is line start, so select all is `Super+A` or a triple click.
- `Enter` steers a running turn even with prompts queued; only `Ctrl+X Enter` queues.
- `/images` lists the attached images by path, without a pixel preview, to keep the binary small.
- `/btw` takes its question on the command line; there is no question dialog.
- On Windows, ConPTY drops the bracketed-paste markers, so keys that arrive together (two or more
  already waiting, then gaps under 15 ms) are read as one paste and its returns as newlines.
- Undo keeps at most 16 MiB of snapshots, so a large paste cannot hold memory without bound.

1 MB in the prompt (in-process, release build, 2026-11-23, Windows 10:
`cargo test --release -p lykos-tui -- --ignored --nocapture one_megabyte`): a keystroke's handling
and frame take 12 us at the median with the paste as a chip, and 6.93 ms (p95 10.57 ms) with it
expanded into the buffer. End to end in a pty on Linux (`node scripts/tui/paste-measure.mjs`,
podman, 2026-11-23), keystroke to screen at the median: 10.84 ms with no paste, 10.66 ms with the
chip, 10.60 ms with 1 MB of text; the paste reaches the screen as a chip in 40 ms.

Speed (rule 10): `node scripts/tui/gate.mjs target/release/lykos-tui.exe --ready "Ask anything"`
holds startup, keystroke latency, frame time, idle CPU, peak memory and binary size against
`bench/tui-limits.json`. `node scripts/tui/tui-test.mjs` drives it end to end in a pty against the
real server and the scripted session child.
