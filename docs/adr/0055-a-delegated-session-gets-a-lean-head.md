# A delegated session gets a lean head

Decided by the maintainer on 2026-10-25. **Amends ADR-0029
and [ADR-0002](0002-ponytail-is-the-default-system-prompt.md)** for delegated sessions only.

## The decision

**A delegated session starts with a smaller frozen head than a session a person drives.** Every
delegated call pays for its head in tokens and latency, and a delegated session has one task and no
person to serve. What the lean head drops (uncapped skills, the ponytail ladder, other text) is decided
when the work is opened, from the measured head size of each part.

- A specialist can still ask for anything the lean head drops.
- A session a person drives is unchanged.

## Why

Speed and cost rank second (ADR-0047),
and delegation is how Lykos delivers its strength.

## Amended 2026-10-25 (T227)

Measured before the build (744 of 36,753 measured characters for a delegated
implementer in this repository), no skill body is in any head: Pi's `<available_skills>` listing
already carries name, description and location only, and skill bodies are loaded on request with
`read` or the `skill` tool. The ponytail ladder has no levels to trim, and ADR-0002's trial measured
the injected ladder lowering cost.

A delegated session drops the `## lykos-plan-against-skill` block whole (the plan guidance and every
loaded skill's extracted steps), because a delegated session has no human to present a plan to.
Everything else is kept byte for byte.

**Opt-in:** A specialist can ask for the block back by naming skills in its existing `skills:` field.
Its delegated head then carries the `lykos-plan-against-skill` block for exactly the skills named in
the resolved roster.

