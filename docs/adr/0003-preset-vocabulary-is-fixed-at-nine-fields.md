# A preset has a fixed vocabulary of nine fields

**Amended, and the count in between was misstated.**
[ADR-0007](0007-one-concept-called-profile.md) collapsed the specialist into the profile and the
field list grew; the documents said twelve while the table listed fourteen.
[ADR-0015](0015-profile-vocabulary-is-fifteen-fields.md) corrects that and adds `rules`, taking the
real count to fifteen. The bar for a sixteenth is unchanged.

A preset declares at most nine settings: the five Pi's own preset format already carries — provider,
model, thinking level, tools, instructions — plus four Lykos owns because Pi has no equivalent:
interaction mode, skills, post-edit feedback, and the verification gate. The alternative was an open
key-value bag, which would have made presets uncomparable, untestable, and a second configuration
format competing with the existing one.

Keeping the first five wire-compatible means a Lykos preset is readable by Pi's own preset extension
for the fields they share, so choosing Lykos does not lock a user in.

## Consequences

A preset that needs a tenth field is a request to widen the vocabulary, recorded once as an issue.
That is how the project finds out what the list is actually missing, rather than guessing now.

Every field is optional, and an absent field means "inherit from the layer below" rather than "reset
to default" — so a preset that only changes the instructions does not have to restate the model.

## Status

Amended by ADR-0007: the concept is a **profile**, not a preset, and the vocabulary is now twelve
fields — the nine below plus `description`, a reserved `delegate`, and a reserved per-profile
memory. `tools` keeps the runtime's replace semantics and gains Lykos-only `tools_add` and
`tools_remove`, so a file written for the runtime still means what it meant there.
