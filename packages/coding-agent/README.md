<p align="center">
  <a href="https://lykos.local">
    <img alt="Lykos logo" src="https://lykos.local/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@lykos/coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@lykos/coding-agent?style=flat-square&logo=npm&logoColor=white" /></a>
</p>

> New issues and PRs from new contributors are closed automatically. Maintainers review closed submissions daily. See [CONTRIBUTING.md](https://github.com/rakun68/Lykos/blob/main/CONTRIBUTING.md).

# Lykos

Lykos is a minimal, extensible agent harness that you can make your own.

Adapt Lykos to your workflows, not the other way around. Customize Lykos with [extensions](docs/extensions.md), [skills](docs/skills.md), [prompt templates](docs/prompt-templates.md), and [themes](docs/themes.md). Bundle them as [Lykos packages](docs/packages.md) and share via npm or git.

Lykos ships with powerful defaults but skips features like sub-agents and plan mode. Ask Lykos to build what you want, or install a package that does it your way.

Use Lykos [interactively](docs/usage.md), automate it in [print or JSON mode](docs/cli.md), control it over [RPC](docs/rpc.md), or build apps with the [Lykos TypeScript SDK](docs/sdk.md). See [OpenClaw](https://github.com/OpenClaw/OpenClaw) for a real-world integration.

## Getting started

Install the command-line interface:

```bash
curl -fsSL https://lykos.local/install.sh | sh
```

On Windows:

```shell
powershell -c "irm https://lykos.local/install.ps1 | iex"
```

The installer pins all dependencies and updates Lykos with `lykos update`. Alternatively, install directly with npm, which does not pin transitive dependencies:

```bash
npm install -g --ignore-scripts @lykos/coding-agent
```

Lykos requires Node.js 22.19 or newer. The macOS, Linux, and Windows installers can install it if needed. Lykos does not require dependency lifecycle scripts for a normal npm installation.

On macOS and Linux, Nix users can install the latest release with `nix profile add github:earendil-works/lykos/stable`. See the [quickstart](docs/quickstart.md#1-install-lykos) for updating and pinning releases.

Start Lykos in the directory where you want it to work:

```bash
cd /path/to/project
lykos
```

For a built-in AI provider, run `/login` inside Lykos to connect a subscription or API key. Then give Lykos a task.

See the [documentation](docs/index.md) for full setup and usage instructions.

## Share your OSS coding agent sessions

If you use Lykos for open source work, please share your coding agent sessions.

Public OSS session data helps improve models, prompts, tools, and evaluations using real development workflows.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/lykos-share-hf`](https://github.com/badlogic/lykos-share-hf) using a Hugging Face account and the Hugging Face CLI.

- [Demo video](https://x.com/badlogicgames/status/2041151967695634619) on how to publish Lykos sessions
- Published Lykos development sessions: [`badlogicgames/lykos-mono` on Hugging Face](https://huggingface.co/datasets/badlogicgames/lykos-mono).

## Development

Clone the repository, install its dependencies, and run Lykos from source:

```bash
git clone https://github.com/rakun68/Lykos
cd lykos
npm install --ignore-scripts
./lykos-test.sh
```

`lykos-test.sh` can be called from any directory and preserves the caller's working directory.

Before submitting changes, run:

```bash
npm run check
./test.sh
```

Read [CONTRIBUTING.md](https://github.com/rakun68/Lykos/blob/main/CONTRIBUTING.md) before opening an issue or pull request. It defines the contribution gate, issue quality bar, and required checks. Read [AGENTS.md](https://github.com/rakun68/Lykos/blob/main/AGENTS.md) for repository-specific implementation, testing, dependency, and release rules.

## License

MIT
