# Lykos

> **Status: under active development.** Lykos is pre-release (0.0.1). Features are incomplete,
> commands and configuration may change without notice, and some providers are untested against
> live accounts. Use it on code you have committed, and expect rough edges.

Lykos is a coding agent for the terminal, built on the [Pi](https://github.com/earendil-works/pi)
runtime. It is built to be delegated to: an orchestrator hands it a task, and Lykos does the work
behind an approval gate, records every model call, and reports what it verified.

- **Made for orchestrator–worker workflows.** Over MCP, an orchestrator starts sessions without
  waiting (`lykos_start`), checks on them (`lykos_status`), steers or stops them, and gets a result
  that separates what was verified from what is only the agent's claim.
- **Fast to answer.** A warm pool of session processes serves MCP calls without a cold start, and
  rarely used tools stay out of the prompt until searched.
- **Efficient with tokens.** The prompt prefix stays byte-identical for the whole session so
  provider caches keep hitting, and long sessions are pruned and compacted in place.
- **Accountable.** Every call lands in a SQLite ledger with its tokens, cache reads and writes, and
  cost, so spend is a query rather than a guess.
- **Customizable.** Specialists, skills, extensions, permission rules and models are set in YAML,
  per user or per project.

It runs three ways:

- **Standalone**, as a full-screen terminal UI or a one-shot task runner.
- **As an MCP worker** under an orchestrating agent, which calls Lykos specialists as its own tools.
- **Under human supervision** through a desktop app. Not built yet.

## Features

- **An approval gate by default.** Three permission modes (`manual`, `accept-edits`, `auto`),
  remembered per project, plus path rules where deny always wins. Secret files and `.git/` are
  protected out of the box.
- **Specialists.** Named bundles of model, tools, skills, prompt and permissions: `plan`, `build`,
  `explore`, `general`, `review`, `test-writer`, `implementer`, or your own in YAML. Switch mid-session.
- **A full tool set.** Hash-anchored `edit`, `grep`, `glob`, `ast_grep` / `ast_edit`, an `lsp`
  client, background jobs (`hub`), `web_search` (keyless by default) and `web_fetch`, `github`,
  `eval`, memory tools and `security_scan`. Rarely used tools stay out of the prompt until searched.
- **A ledger.** Every model call is recorded in SQLite with its tokens, cache reads and writes, and
  cost. `lykos show`, `lykos cost` and `lykos tools` read it.
- **Nothing is deleted.** Every session is archived and resumable. Checkpoints let you rewind the
  working tree to any turn without touching your branch.
- **Sealed TDD.** A test writer's failing tests are signed; an implementer cannot change them, only
  dispute them.
- **Questions go up, not out.** A delegated session asks its coordinator, not a terminal nobody is
  watching, and the coordinator answers or rules on disputes.
- **Model access.** Pools of API keys and OAuth logins per provider, with rotation and cooldown when
  a credential hits its limit.
- **Optional containment.** Run a session's commands inside Docker or Podman. Off unless you ask.
- **Memory.** The agent may propose a lesson; only you accept it.

## Requirements

- Node.js 22 or newer
- git
- Docker or Podman, only if you want containment

Lykos is developed on Windows. Other platforms are less tested.

## Install

Lykos is not on npm yet. Install from source:

```bash
git clone https://github.com/rakun68/Lykos.git
cd Lykos
npm install
npm run build
npm link
```

`npm link` puts the `lykos` command on your `PATH`. Check the install:

```bash
lykos --version
```

## Quick start

In the project you want to work on:

```bash
lykos init
```

This creates `.lykos/config.yaml`. The default model is DeepSeek. Give Lykos a key, either through
the `DEEPSEEK_API_KEY` environment variable or its credential store (the key is read from stdin):

```bash
lykos login deepseek --api-key
```

For OAuth providers, run `lykos login <provider>`. Then check the setup:

```bash
lykos doctor
```

Start the terminal UI:

```bash
lykos
```

Or run one task and exit:

```bash
lykos run "add a --verbose flag to the CLI and a test for it"
```

A task run this way works on a branch and worktree of its own, so your working tree is not touched.

## Common commands

| Command | What it does |
| --- | --- |
| `lykos` | Start the terminal UI |
| `lykos run "<task>"` | Run one task (`--specialist`, `--model`, `--mode`, `--containment`) |
| `lykos resume [<session>]` | Continue an earlier session, or pick one |
| `lykos show <session>` | Replay a session: edits, checks, checkpoints, cost |
| `lykos rewind [<checkpoint>]` | Restore the working tree to a turn checkpoint |
| `lykos cost` | Spend from the ledger |
| `lykos login` / `logout` / `usage` | Manage credentials and see usage windows |
| `lykos specialist list` | List the specialists available here |
| `lykos memory` | Review proposed and accepted memories |
| `lykos mcp` | Serve Lykos as an MCP worker over stdio |
| `lykos --help` | Every command and flag |

## Use Lykos as an MCP worker

Any MCP client can run `lykos mcp` over stdio. To register Lykos for a project:

```bash
lykos export claude
```

This adds `lykos` to the project's `.mcp.json` and writes one agent file per Lykos specialist. The
orchestrator can then call `lykos_<specialist>` tools, or start sessions in the background with
`lykos_start` and follow them with `lykos_status`. The contract is in
[docs/reference/mcp.md](docs/reference/mcp.md).

## Configuration

Configuration is layered: shipped defaults, then `~/.lykos/config.yaml`, then the project's
`.lykos/config.yaml`, then the specialist, environment variables and flags. Runtime state lives in
`.lykos/`; `lykos init` adds the ledger, sessions and cache to your `.gitignore`. The keys are in
[docs/reference/cli-and-config.md](docs/reference/cli-and-config.md).

## Documentation

- [docs/reference/](docs/reference/): CLI and configuration, the terminal UI, sessions and archive,
  specialists, model access, the MCP contract, the ledger
- [docs/adr/](docs/adr/): architecture decisions and why they were made
- [GLOSSARY.md](GLOSSARY.md): the project's terms
- [AGENTS.md](AGENTS.md): orientation for contributors and coding agents

## Coming next

- **Rust where it counts.** Rewriting hot-path modules in Rust for startup time and speed.
- **Detaching from Pi.** Lykos becomes its own fork of Pi rather than depending on it. It runs
  alongside an existing Pi install and no longer needs a `.pi/` directory.
- **Lykos orchestrating Lykos.** Running a task, then a whole phase of tickets, through review
  cycles from the CLI.
- **A rebuilt terminal UI** with a command palette, model picker and inline diffs, then a desktop
  supervisor.

## License

[MIT](LICENSE). Some files contain copied MIT-licensed code: see [docs/copied-code.md](docs/copied-code.md).
