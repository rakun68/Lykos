# Shipped profiles are a bundled, lowest-precedence discovery source

The profile library ships five authored profiles, and
they must be both **selectable by name with zero user configuration** (`lykos run --profile minimal`)
and **copyable as a starting point** (spec stories 2 and 23). The existing discovery sources —
project `.lykos/profiles/<name>.yaml` and global `<globalDir>/profiles/<name>.yaml` — are both
user-owned, so neither can carry the library without a first-run copy step.

**The library lives in the package, not in any user directory.** The five files ship at
`<lykos>/profiles/` (next to `config/`), resolved via `config/profiles.ts`'s `shippedProfilesDir()`.
Profile discovery now reads three sources, and precedence by name is **shipped < global < project**:
a project profile overrides a global one, and both override the shipped file. This keeps the spec's
"my project's profiles override the global ones by name" (story 19) intact and adds the shipped
library as the lowest rung underneath it.

## Consequences

The shipped files are never the place an override is written. Copying one into the project or global
directory and editing the copy is the supported path; the shipped file itself is only ever replaced
by a release.

Future work that grows the surface must honor the same rung. When the tool catalog grows to
roughly thirty tools, the restrictive shipped profiles (`plan`, `review`, `explore`) state their tools
positively, so a newly landed tool never silently joins a read-only profile. The precedence is
recorded here for the same reason [ADR-0004](0004-a-preset-is-a-configuration-layer.md) records the
layer chain: precedence is expensive to change once profiles exist in the wild, so it is not left to
the implementation.
