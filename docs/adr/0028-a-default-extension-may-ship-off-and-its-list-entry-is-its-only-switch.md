# A default extension may ship off, and its list entry is its only switch

Decided with the maintainer on 2026-09-29. Amends
the earlier specification's "appears in the configuration defaults" and
the "on unless configuration turns it off" half of `CONTEXT.md`'s *Default extension*.

## The decision

**A default extension may ship off: absent from the shipped `extensions:` (or `lykos_extensions:`)
list, so it loads only where a project lists it.** Whether it ships on or off, **its entry in that
list is its only switch.**
- **Listed**, it loads and does its work. **Unlisted**, it is not loaded and does nothing.
- **No second switch.** No separate flag or environment variable turns it on or off. A default
  extension may still have *settings* — parameters, or a model — but none of them decides whether
  it runs.
- **Names and versions.** It still ships inside Lykos's package, carries the `lykos-` prefix,
  resolves from the package at Lykos's own version, and uses only an API a third party could use.

`lykos-repo-map` is the first default extension to ship off:
- It leaves the shipped list.
- `flags.retrieval` stops controlling it.
- The `LYKOS_REPO_MAP=0` environment override is removed.
- Its parameters stay under `retrieval.repo_map`.
- This repository lists it in `.lykos/config.yaml`.

## Why

A third-party extension has exactly one switch, its entry in the list. `lykos-repo-map` had two:
- **The list entry**: it was declared by default.
- **`flags.retrieval`**: it defaulted to false.

So by default it was loaded yet did nothing, and turning it on meant finding the second switch.
Turning it off could be done either way. A default extension exists to be indistinguishable from a
third-party one ("uses only an API a third party could use"), and a hidden second switch is exactly
the difference a third party does not get.

**Rejected: keep it in the shipped list and switched by `flags.retrieval`.** This keeps the global
default unchanged, but at the cost of the two-switch problem above. It is also the reason `lykos
prompt --show` had to reason about both switches at once.

**Rejected: ship it on.** T67's gate returned HOLD on the repo map (unmeasured benefit, a head block
every session pays for). Shipping it on would change every project's prompt.

## Consequences

A project turns the map on by writing its `extensions:` list with `lykos-repo-map` in it. The list
replaces rather than merges, so that list must also name every other extension the project wants.
A default extension's entry may omit `version` (it then means the build shipped with this Lykos),
so such a list does not have to be edited when Lykos's version changes; a pinned default at a
version Lykos no longer ships would silently stop loading from the package.

`flags.retrieval` is read by nothing now. It stays accepted so existing configurations still load.
The ledger's `flag_retrieval` column is unaffected: it has always recorded whether a map actually
rode the head, not the configuration.

A default extension that ships **on** is removed exactly as before: write the list without it.
