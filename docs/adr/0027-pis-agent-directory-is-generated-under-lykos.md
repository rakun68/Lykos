# Pi's agent directory is generated under `~/.lykos`

Decided with the maintainer on 2026-09-23. This extends rule 8 ("runtime state lives in `.lykos/`,
never `.pi/`") to the user-level directory Pi reads.

## The decision

**Pi's `agentDir` is `~/.lykos/pi-host/`, a directory Lykos generates.**
- **Where it is passed:** to `DefaultResourceLoader`, and to `createAgentSession` through an explicit
  `SettingsManager`.
- **Environment:** it is set as `PI_CODING_AGENT_DIR` for the process, so an extension that calls Pi's
  `getAgentDir()` gets the same answer.
- **Contents:** host extensions install under it. Its settings file is generated from Lykos's own
  configuration.

**Pi stays for its extension community.** It also keeps the agent loop, HTTP and Radius login.
Replacing the loop would mean reimplementing Pi's whole extension API to keep community extensions
working, which defeats the reason Pi stays. That goes to WISHLIST.

## Why

Before this, Lykos passed Pi no `agentDir` and no `SettingsManager`. Pi therefore read
`~/.pi/agent/settings.json`, skills, prompts, themes and the extension install directory on its own
default (`lykos/session/boot.ts`, `lykos/extensions/host-install.ts`). That left user-level state
Lykos depends on in a directory Lykos does not own.

**Rejected: keep `~/.pi/agent` as the extension home.** It is the simplest option and every
community extension assumes it. The cost is that Lykos's behaviour would depend on a directory any
other Pi install on the machine also writes to.

## Consequences

An extension that hardcodes `~/.pi` instead of calling `getAgentDir()` does not find its files. That
is recorded against the extension. Lykos does not write into `~/.pi` to accommodate it. Whether any
widely used extension does this is to be read from source before the move lands.

Workspace `.pi/agents/` and `.pi/presets.json` stay only where a Pi load still requires them, and
remain generated from `.lykos/` (rule 7).
