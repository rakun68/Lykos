# Sixteen resident tools, reversing the earlier surface trim

**Superseded by ADR-0014.** The count is no longer
sixteen and residency is no longer the only way a tool reaches the model. The registry structure and
the default/available labels this decision introduced survive; the membership and the count do not.

An earlier phase trimmed the tool surface to four built-ins, dropping `grep`, `find`, `ls` and
`powershell` on the grounds that a dedicated schema rides every turn for work the shell already does.
That was correct under the cost thesis. The thesis changed, and the trim is reversed: sixteen tools
are resident by default, and every tool the product knows about lives in one registry that records
whether it is **default** or **available**.

A profile moves a tool between the two for one session, so a lean surface remains available to anyone
who wants one — the runtime's per-turn dynamic loading makes that real rather than notional.

## Consequences

The added schema cost is **recorded by the existing instrument, not estimated**. That instrument was
built to answer exactly this question, and a reversal argued rather than measured would waste it.

Three of the trim's recorded rationales become false statements and are deleted rather than marked
historical. One of them was already false: `powershell` was dropped because "the sandbox is Linux",
and the shape a person actually drives is a Windows machine. That rationale was true for the
container hop and was never re-checked when the standalone shape arrived — the same failure the
project's first rule exists to prevent.

The registry's structure survives intact; only its labels and its membership change. That it did
survive is the sign the trim was built well.
