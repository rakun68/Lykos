# One concept called profile, replacing preset and specialist

The glossary carried two terms — a **preset** configuring a session, and a **specialist** as an agent
definition for multi-agent work — and they turned out to describe the same file: a name, a system
prompt, skills, tools, a model, and later its own memory. We collapsed them into one concept called
**profile**.

The word was the maintainer's own, reached for unprompted while describing the specialist idea, and
it matches both the runtime's own preset format and the shape other harnesses ship.

## Consequences

The pack phase stops being a second mechanism. A roster of specialists becomes profiles pointed at
delegated agents, which makes that phase a delivery target for something the customization phase
already builds — a materially smaller project than the plan previously described.

The profile format reserves a `delegate` field, documented and inert, so the file that configures a
session today is the same file that configures a delegated agent later without a format change.

## Status

Supersedes the preset/specialist split in ADR-0003 and ADR-0004, whose substance is unchanged apart
from the name.
