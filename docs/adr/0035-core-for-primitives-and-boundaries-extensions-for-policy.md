# Core for primitives and boundaries, extensions for policy

Decided by the maintainer on 2026-10-08.

## The decision

**Every feature is placed by one test: does it lose anything by being removable?**

- **Built in** when other features build on it, or when it only works from a built-in position:
  the host side of the container boundary, the verification gate, the MCP contract, or a command
  that must run with no session.
- **An extension** when it is self-contained policy that works just as well as a removable
  extension. It ships as a default extension under
  [ADR-0028](0028-a-default-extension-may-ship-off-and-its-list-entry-is-its-only-switch.md), so it
  is configurable and its list entry is its only switch.
- **Split** when a feature has both halves. The primitive goes in core and the policy goes in the
  extension.

**A core seam that an extension uses to touch the verification gate is block-only.** An extension
may add a check that keeps a session from success. It can never grant success. The one-writer rule
for `outcome = 'success'` (`gate/verify-gate.ts`) is unchanged, so extensions can only make the gate
stricter.

**Behaviour in core that a project did not ask for is a no-op.** The host-side seal check acts only
when the branch has a seal file under `.lykos/seals/`. Such a feature is as removable as an extension.

## Options considered

- **Ship every new feature as an extension.** Rejected: a CLI used from CI has no session to load an
  extension into. (At the time, the delegated container also ran no extension host,
  old issue 16. ADR-0036 removes that reason
  but not the CLI one.)
- **Build everything into core.** Rejected: policy in core cannot be removed or replaced, and the
  maintainer wants workflows to stay swappable.
- **Let an extension write the gate's verdict.** Rejected: an agent's or extension's claim is never
  a verified success.

## Consequences

- **The split.**
  - Core: the `tool_call` veto event, the block-only gate seam, the `lykos/seal/` module with its
    reporter adapters, the `lykos seal` CLI and the MCP changes. The container runtime selection
    moved to the delegated-run work under ADR-0036.
  - The `lykos-seal` extension: its config, the veto, the `bash` warning, the gate check, the
    weakening scan, `dispute_test` and dispute routing.
  - Default files: the starter specialists and skill.
- **The veto event is a primitive.** A wider hook bus extends it rather than adding a second
  one.
