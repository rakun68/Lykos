# Upstream Pi Import Pipeline

Lykos forks Pi (`earendil-works/pi`) and tracks upstream only on the maintainer's word ([ADR-0065](../../docs/adr/0065-lykos-is-a-fork-of-pi.md)). Every change to the engine packages under `packages/` flows through this directory and its patch series — never hand-edit files in `packages/`, because hand edits are overwritten on the next import.

## Layout

- `import-tag.mjs` — Copies the 8 closure packages (`coding-agent`, `agent`, `ai`, `schema`, `telemetry`, `codemode`, `mcp`, `tui`) and `LICENSE` (as `LICENSE-PI`) from a Pi git checkout at a tag onto the local `upstream` branch, unmodified and byte-identical.
- `verify-import.mjs` — Verifies that a git ref (default: `upstream`) matches the Pi tag file-for-file and blob-for-blob under `packages/` and `LICENSE-PI`.
- `sync.mjs` — Turns the `upstream` branch (or a Pi checkout + tag) into Lykos source under `packages/`:
  1. Optionally updates `upstream` from `--pi-repo` and `--tag`.
  2. Restores `packages/` and `LICENSE-PI` cleanly from `upstream` (preserving hydrated model data under `packages/ai/src/providers/data/`).
  3. Drops self-update, installer, share viewer, Pi's CLI `main`, docs/examples/changelogs, and their tests.
  4. Mechanically renames Pi package names (`@earendil-works/pi-*` → `@lykos/*`), paths (`~/.pi/agent` → `~/.lykos`, `.pi` → `.lykos`), env vars (`PI_*` → `LYKOS_*`), `piConfig` → `lykosConfig`, filenames, identifiers, and strings.
  5. Applies every `*.patch` in `scripts/upstream/patches/` in sorted order. If a patch fails to apply, the run stops immediately and names the failing patch.
  6. Runs `verify-clean.mjs` to assert zero remaining matches for `\.pi\b`, `~/\.pi`, `\bPI_[A-Z]`, `@earendil-works`, `@mariozechner`, `pi\.dev`, `\bpi\b`, or `π` (with explicit allowlists only for JavaScript `Math.PI` and LaTeX Greek `\pi`/`π`).
- `verify-clean.mjs` — Standalone clean-tree verifier run automatically at the end of `sync.mjs`.
- `patches/` — Ordered unified diff patches (`0001-*.patch`, ...) applied after the mechanical drop and rename.

## How to run

### Re-run on the current `upstream` branch (idempotent)

```bash
node scripts/upstream/sync.mjs
```

### Import a new Pi tag (only on the maintainer's word)

```bash
# 1. Fetch and check out the tag in ../Lykos_Dev/references/pi
git -C ../Lykos_Dev/references/pi fetch --tags
git -C ../Lykos_Dev/references/pi checkout vX.Y.Z

# 2. Import onto `upstream`, drop, rename, patch, and verify
node scripts/upstream/sync.mjs --pi-repo ../Lykos_Dev/references/pi --tag vX.Y.Z

# 3. Verify the unmodified `upstream` branch matches the tag byte for byte
node scripts/upstream/verify-import.mjs --pi-repo ../Lykos_Dev/references/pi --tag vX.Y.Z --ref upstream

# 4. Install, build, and test
npm install
npm run build
npm run test:engine
```

## Fixing a failing patch

If `sync.mjs` stops with `Patch failed to apply: scripts/upstream/patches/<name>.patch`:

1. Inspect the hunk in `scripts/upstream/patches/<name>.patch` against the renamed file in `packages/`.
2. Update the patch file (or regenerate it with `git diff -- packages/` against the pre-patch state).
3. Re-run `node scripts/upstream/sync.mjs` twice and confirm both runs succeed and produce byte-identical trees.
