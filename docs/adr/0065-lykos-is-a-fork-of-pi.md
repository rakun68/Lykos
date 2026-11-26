# Lykos is a fork of Pi

Decided by the maintainer in the P23 grill of 2026-11-26 (Q1–Q14), spec #60. **Supersedes
[ADR-0027](0027-pis-agent-directory-is-generated-under-lykos.md).** The fork point is Pi
(`earendil-works/pi`) tag `v1.6.1`, commit `ef4a1cfcca62b77ad3558337ff3e1c7f6beeadfe`, 2026-11-25, MIT,
Copyright (c) 2025 Mario Zechner.

## The decisions

**1. Lykos is a fork of Pi, and says so once.** Pi's engine packages become Lykos source. `LICENSE-PI`
carries Pi's MIT notice, and one line of `README.md` says Lykos is a fork of Pi `v1.6.1`. Nothing else
names Pi: code, paths, environment variables, package names, settings and docs are Lykos's own.

**2. Upstream is tracked, and imported only on the maintainer's word (Q11, Q14).** An `upstream` branch
receives each imported Pi tag unmodified. A script in `scripts/upstream/` drops, renames and patches it,
and the result merges into Lykos. Nothing runs the script on a schedule or on a release: Lykos may sit
several Pi releases behind. No pull request is sent to Pi.

**3. Pi's layout, Lykos's names (Q1, Q2).** The fork keeps Pi's `packages/` layout as npm workspaces
named `@lykos/*`, so an import merges cleanly. The rename is mechanical and idempotent. No
`@earendil-works/*` dependency remains.

**4. Dropped on every import (Q6).** Self-update, the installer, the share viewer, Pi's CLI `main`, and
every `pi.dev` endpoint. No Lykos code calls a Pi server.

**5. The TUI library and interactive mode stay, unloaded (Q6b).** Removing them would mean Lykos-only
edits to about 40 core files and a conflict on most imports, and would change the extension API. A
small Lykos **patch series** makes their imports lazy instead.

**6. Pi community extensions keep working (Q5).** One module, `compat/pi-extensions.ts`, reads the `"pi"`
package manifest key beside `"lykos"` and keeps the `@earendil-works/pi-*` and `@mariozechner/pi-*`
import aliases. These are the only Pi strings left in code.

**7. One home per level (Q3, Q4, Q8).** The engine's project files live in `.lykos/` and its user files
in `~/.lykos/`. `~/.lykos/pi-host/` migrates there automatically, and `lykos doctor` reports what moved
and any leftover `.pi/`. Lykos never reads or writes `.pi/` or `~/.pi/`. The `.pi/**` gate and commit
guards stay, protecting a Pi install beside Lykos (Q7).

**8. `config.yaml` is the only settings file (Q13).** It feeds the engine through a custom settings
storage. `settings.json`, `mcp.json` and `keybindings.json` are never read or written.

**9. Overlaps are decided by measurement (Q14).** Where the engine and Lykos both have a feature, both
run on the same tasks and the stronger one runs. Until a measurement decides, Lykos's own runs. Engine
built-ins with no Lykos counterpart stay off. Nothing is deleted.

**10. Order and tests (Q9).** Lykos moves to Pi `1.6.1` on npm before the fork is imported, so an
upgrade break never mixes with a rename break. Pi's tests come with the fork and run as
`npm run test:engine`; both suites pass before an import lands.

## Why

ADR-0027 kept Pi as a dependency for its extension community and moved Pi's user state under
`~/.lykos/pi-host/`. That left Lykos reading a project's `.pi/` through Pi's loader, running an engine it
could not change, and translating at a boundary whose adapters were a large share of its config code.
The maintainer wants Lykos to own its runtime and to run beside an installed Pi without either touching
the other.

**Rejected: rename the config folder through Pi's own `piConfig` and `PI_PACKAGE_DIR`.** It removes `.pi`
without forking, but leaves every other Pi name and the dependency in place.

**Rejected: a hard fork with no upstream.** Lykos would maintain every provider and model update alone.
Pi shipped 25 releases between `0.84.3` and `1.6.1`.

## Consequences

`AGENTS.md` rules 2, 3, 7 and 8 and the line "Not a fork of Pi" change in this repository and in the
maintainers' folder. The rule that other projects' source never enters this repository gains one
exception: the fork, under `LICENSE-PI`.

Every Pi import changes Lykos's code only through the script and the patch series. A patch that no
longer applies stops the import and is fixed by hand.
