# A specialist may carry containment, and the vocabulary is eighteen fields

**Amended by ADR-0043,** which takes the count to nineteen.

Decided by the maintainer on 2026-10-09, while building image resolution
(old issue 30). **Amends
[ADR-0023](0023-the-specialist-vocabulary-is-seventeen-fields.md),** which closed the specialist
vocabulary at seventeen and said any eighteenth field must earn an ADR.

## The decision

**The count is eighteen.** The eighteenth field is `containment`, a Lykos-owned object with three
optional sub-keys:

- `level`: `off`, `auto` or `required`
- `network`: `open` or `none`
- `image`: the container image the specialist's commands run in

**Unset means the specialist has no opinion.** A specialist that omits `containment`, or a sub-key of
it, leaves that setting to project config, then global config, then the shipped default. No specialist
shipped today sets it.

**A coordinator's decision beats the specialist's.** When a coordinator delegates to a
specialist and states a containment level, that argument overrides the specialist's field. The full
order is the one spec #22 fixes: the call's argument, the parent session, the specialist, project
config, global config, the default. Resolving the argument and the parent is #33 and #35; a standalone
session, which has neither, resolves the specialist onward.

## Why

ADR-0036 makes containment a
property a caller requests, and spec stories 36, 64 and 65 want a specialist to carry a default for
it: a reviewer that needs no network, a Python specialist that needs a different toolchain image.
Without a field, every such preference would be repeated in each call or pushed into project config,
which a specialist shared across projects cannot own.

## Options considered

- **Carry it on an existing field.** Rejected: no existing field is about where commands run, and
  overloading `gate` or `tools` would make the same word mean two things.
- **Three flat fields (`containment_level`, `containment_network`, `containment_image`).**
  Rejected: it would take the count to twenty and spread one concern across three vocabulary
  entries. The project config already groups the same keys under `containment`; the specialist
  mirrors it, so a specialist's value is a `ConfigFile` partial like every other.

## Consequences

- `SPECIALIST_FIELD_NAMES` in `lykos/config/specialists.ts` has eighteen elements.
- A specialist's `containment` resolves into the specialist configuration layer, which sits after
  global and project config, so a set sub-key beats them and an unset one falls through.
- The image for a session resolves in this order: the specialist's `containment.image`, project config,
  the project's `.devcontainer/devcontainer.json`, global config, then the shipped default.
- `containment.image` exists in project and global config too, so the same key names the image at every
  layer.
- A session's containment is chosen when it starts. Switching specialists mid-session does not move
  its commands into or out of a container.
