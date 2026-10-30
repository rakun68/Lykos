# The word is specialist, and it names the same one concept

**Supersedes [ADR-0007](0007-one-concept-called-profile.md)** on the name only. That decision
collapsed two words — a **preset** configuring a session and a **specialist** defining an agent for
multi-agent work — into one concept, on the finding that they described the same file. The finding
holds and is not reopened here. One file still configures both the session a person drives and the
agent a coordinator delegates to. Only the word changes: the concept is called a **specialist**.

## Why the name reverts

ADR-0007 chose "profile" for two reasons. It was the maintainer's own word, reached for unprompted,
and it matched the runtime's preset format and the shape other harnesses ship. Both were true.

What changed is the primary use. When ADR-0007 was written, the file's main job was to reconfigure
the session in front of a person, and "profile" describes a configuration bundle well. The design
settled in the phase 10 discussion makes the file's main job something else: **an agent picks a
specialist for the subagent it is about to spawn**. A name chosen by an agent for a job wants to say
what the thing is for, and "specialist" says it where "profile" does not.

The deciding test was how each word reads in the places a user actually meets it — validation errors,
file paths, and the refusal a gate prints. `No such specialist: scout` explains itself to somebody
who has never read these documents. `No such profile: scout` invites the question of whose profile it
is.

**`Agent` was rejected.** It is the most overloaded word in this project: Pi's `Agent()` API, the
`Agent` tool, subagents, generated `.pi/agents/` definitions, and Lykos itself. A configuration file
called an agent cannot be told apart from the thing that runs it.

**`Wolf` was considered seriously and rejected.** Lykos means wolf, and **pack** is already this
project's collective noun for its agents. The metaphor fits. It was rejected because the
word appears in error messages, validation output and in files shared between users, where a name
that needs its joke explained is a cost paid by every reader. **Pack survives as the collective**: a
specialist belongs to a pack.

## Consequences

**`specialist` leaves the `_Avoid_` list in `CONTEXT.md` and `profile` joins it.** The glossary
carries one word for this concept, as it did before.

**The rename reaches the on-disk layout.** Specialists are discovered from
`.lykos/specialists/<name>.yaml`, `<globalDir>/specialists/` and `lykos/specialists/`. A
`profiles/` directory at any of those layers is still read, with a deprecation notice naming the new
path, so configuration written while the word was "profile" keeps working.

**History is not rewritten.** ADR-0003, ADR-0004, ADR-0007, ADR-0015, ADR-0016 and ADR-0019 keep
their filenames and their text, including the word "profile", because an ADR records what was decided
when it was decided. Living documents — the glossary, the reference specifications, the plan,
the findings, and the open specs — are swept. This follows the project's standing rule that nothing
is backfilled.
