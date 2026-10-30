# A preset is a configuration layer between project and environment

The configuration loader already resolves values through a fixed chain of named layers and records
which layer each value came from. Rather than treating a preset as a separate concept applied after
resolution, a preset becomes a sixth layer in that chain: defaults, global, project, **preset**,
environment, flags.

A preset beats project configuration because the user selected it explicitly for this session. A
command-line flag beats a preset, which matches Pi's own precedence rule and lets someone override
one setting without editing or forking the preset.

## Consequences

The layer-name vocabulary is a closed union, so adding one member gives every existing consumer that
reports provenance the new layer for free, and a person can always see whether a value came from a
preset, from the project, or from a flag.

Precedence is expensive to change once presets exist in the wild, which is why it is recorded here
rather than left to the implementation.

## Status

Amended by ADR-0007: the layer is named for the **profile**. Its position in the chain and the
precedence argument are unchanged.
