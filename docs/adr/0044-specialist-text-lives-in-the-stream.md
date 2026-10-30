# A session's head is neutral, and specialist text lives in the message stream

Decided by the maintainer on 2026-10-19 and 2026-10-20, to fix a failed
demonstration. **Amends ADR-0021**,
whose rule it applies to the session's first specialist as well as to later ones.

## The decision

**In a session a person drives, the frozen head carries no text that depends on a specialist or a
permission mode.** A specialist's instructions, its off-limits notice and the current permission
mode reach the model as a message in the stream:

- once when the session starts, for the specialist it starts under
- again at every switch, opening with an explicit line that the previous specialist's instructions
  no longer apply

**The request's tool list is fixed for the session and is not narrowed by the starting specialist.**
It carries the default tool set, so a session that starts under Plan can still edit after a switch to
Build. A specialist's narrower set is enforced at dispatch through the tool's `off` state and
`read_only`, and stated in the stream, which is ADR-0021's tools-append rule applied from the first
turn.

**A subagent is unchanged.** It never switches, so its specialist may still put its text in the head
and use prompt and tools override, as ADR-0021 allows.

## Why

On 2026-10-16 `npm run phase2:live` switched from `plan` to `minimal` and the model kept planning.
The switch changed the tools, but Plan's instructions were in the frozen head and stayed there. The
switch could only add a notice behind them, and the model followed the head. With Shift+Tab making
Plan to Build the most common action in a session (ADR-0043), that path has to work every time.

## Options considered

- **Keep the head as it is and add a stronger revoking notice at each switch.** Rejected: the plan
  text stays in the prefix for the whole session, and the model can drift back to it.
- **Rebuild the head at each switch.** Rejected for the reasons in ADR-0021: every switch would be a
  full cache write, and on models whose thinking blocks are bound to the prefix it invalidates them
  or is refused.

## Consequences

- The stream carries more tokens: a specialist's instructions are sent once per start and once per
  switch, behind the cached prefix.
- The Ponytail ladder is Build's instructions, so it reaches the model through the stream at session
  start. [ADR-0002](0002-ponytail-is-the-default-system-prompt.md)'s evidence was that the ladder
  works when injected and not when installed passively. A stream message is still injected, so the
  decision stands. Whether the effect holds in the stream is unmeasured.
- `lykos prompt --show --specialist <name>` shows the neutral head and, separately, the stream
  message the specialist would add.
- The demonstration checks the ledger, not the switch report: an `edit` call succeeded after the switch and
  the file changed.
