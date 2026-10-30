# The profile vocabulary is fifteen fields, and the count was wrong before this decision

**Amends [ADR-0003](0003-preset-vocabulary-is-fixed-at-nine-fields.md),** which fixed the count so
that a profile could not grow into a second configuration language.

**The stated count was wrong.** The specification said twelve and enumerated fourteen: five
wire-compatible with Pi, six Lykos-owned, a description, and two reserved. Its prose said "four Lykos
owns" while its own table listed six — `tools_add` and `tools_remove` were added when the resident set
grew and the sentence above the table was never updated. The plan repeated the wrong
number. This is exactly the failure the project's first rule exists to prevent: a claim checked once
and then carried, and a decision whose whole purpose is to hold a count is worthless if the count is
not the real one.

**The count is fifteen.** Fourteen that already existed, plus `rules`.

A **stream rule** matches the model's own output as it streams and either injects guidance or aborts
the turn. Which rules load is a per-class-of-work decision by construction: a rule that should
interrupt during a review is wrong during exploration. That is the definition of a profile setting,
and expressing it through the existing `skills` field would overload a field that means something
else. Its value is a list of stream-rule names, resolved from the same layered discovery `skills`
uses.

## Consequences

The bar for a sixteenth field is unchanged and is now enforceable, because the count it is measured
against is the one in the table. Any document quoting the number quotes the table or does not quote a
number.

The `memory` field stops being reserved and inert. It names a memory backend, which is what makes
[ADR-0016](0016-embeddings-are-a-profile-choice.md) a value change rather than a schema change later.

The `delegate` field loses the "tool ceiling" half of its meaning. A delegated agent is configured by
a profile, and a profile already carries its own tool set, so there is no second place deciding what
a delegate may hold. Containment does the limiting
(ADR-0018).

## Status

Amended by [ADR-0023](0023-the-specialist-vocabulary-is-seventeen-fields.md): the count is
**seventeen**. `prompt_mode` and `tools_mode` join the vocabulary, each `append | override` and each
defaulting to `append`. They are what let a specialist say how it wants to be applied rather than
only what it contains — whether its instructions replace the default head or follow it, and whether
the tools it disallows are named in the prompt or removed from the request. The bar this decision
sets for a new field is unchanged, and the count is still fixed by the table rather than by prose.
