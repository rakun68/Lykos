# The glossary is `GLOSSARY.md`

Decided by the maintainer on 2026-10-08, while updating the installed `mattpocock/skills` to their
latest versions.

## The decision

**The project glossary moves from `CONTEXT.md` to `GLOSSARY.md`, unchanged in content.**

- Upstream `mattpocock/skills` renamed the file in `domain-modeling`, `tdd` and the
  `setup-matt-pocock-skills` templates, and `CONTEXT-FORMAT.md` became `GLOSSARY-FORMAT.md`.
- Every live reference follows: `CLAUDE.md`, `AGENTS.md`, `docs/agents/domain.md` (regenerated from
  the updated template), `docs/reference/extension-policy.md`, the `implementer` agent, and four
  source comments in `lykos/`.
- ADRs are records of their time and keep saying `CONTEXT.md`. Read it
  as `GLOSSARY.md`.

## Options considered

- **Keep `CONTEXT.md` and add a `GLOSSARY.md` that points to it.** Rejected: a skill that reads
  `GLOSSARY.md` gets a pointer instead of the terms, and `domain-modeling` could start writing terms
  into the pointer file.
- **Keep the old versions of the three skills.** Rejected: every later update brings the conflict
  back, and the three skills fall behind the rest.

## Consequences

- The skills find the glossary again: before this, an updated skill looked for `GLOSSARY.md`, found
  nothing, and skipped the project's vocabulary.
- An older copy of a skill or a prompt that names `CONTEXT.md` now names a missing file. Fix it
  where it is found.
