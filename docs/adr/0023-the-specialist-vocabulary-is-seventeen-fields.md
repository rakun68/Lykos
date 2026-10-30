# The specialist vocabulary is seventeen fields

**Amended by [ADR-0037](0037-a-specialist-may-carry-containment.md),** which adds an eighteenth field, `containment`.

**Amended again by ADR-0043,** which removes `mode` and adds `read_only` and `role`. The count is nineteen.

**Amends [ADR-0015](0015-profile-vocabulary-is-fifteen-fields.md),** which fixed the profile count at fifteen.

**The count is seventeen.** Fifteen that already existed, plus `prompt_mode` and `tools_mode`.

## The two new fields

- **`prompt_mode`** (`"append" | "override"`, defaulting to `"append"`): allows a specialist's instructions
  to replace the default prompt head (the ponytail ruleset ladder) rather than being appended after it.
  As established in ADR-0021,
  `override` is primarily a delegation-shaped capability: a subagent begins with a clean transcript, no
  cached prefix, and no bound thinking blocks, so replacing the prompt head costs nothing. In contrast,
  a mid-session switch always appends to keep the provider prefix cache intact and avoid invalidating
  thinking blocks.

- **`tools_mode`** (`"append" | "override"`, defaulting to `"append"`): prepares for tool restriction enforcement.
  As established in ADR-0022, residency and
  prompt presence are separate decisions. In `append` mode, resident tools remain in the request while
  disallowed tools are marked `off` at dispatch; in `override` mode, disallowed tools are dropped from the
  request schema entirely. In this ticket, `tools_mode` is accepted, validated, and declared inert until
  ticket 02 wires its enforcement mechanism.

## The seventeen fields

The complete closed vocabulary consists of:

1. `provider` (Pi wire-compatible)
2. `model` (Pi wire-compatible)
3. `thinkingLevel` (Pi wire-compatible)
4. `tools` (Pi wire-compatible)
5. `instructions` (Pi wire-compatible)
6. `mode` (Lykos-owned)
7. `skills` (Lykos-owned)
8. `feedback` (Lykos-owned)
9. `gate` (Lykos-owned)
10. `tools_add` (Lykos-owned)
11. `tools_remove` (Lykos-owned)
12. `description` (Lykos-owned)
13. `prompt_mode` (Lykos-owned, new in this decision)
14. `tools_mode` (Lykos-owned, new in this decision)
15. `rules` (Lykos-owned)
16. `delegate` (Lykos-owned)
17. `memory` (Lykos-owned)

## Why the count is fixed by decision record

ADR-0003 and ADR-0015 established that an open key-value bag makes specialists uncomparable, untestable,
and a second configuration language competing with the existing one. ADR-0015 was written precisely because
prose and reference tables had drifted in earlier documentation (claiming twelve fields while enumerating
fourteen). Fixing the count by an explicit decision record ensures that the runtime (`SPECIALIST_FIELD_NAMES`),
the test harness (`SPEC_TABLE_FIELDS`), and the reference documentation (`docs/reference/specialists.md`)
agree on the exact number. Any eighteenth field must earn an ADR.

## Consequences

- `SPECIALIST_FIELD_NAMES` in `lykos/config/specialists.ts` has exactly seventeen elements.
- `tools_mode` is registered in `INERT_FIELDS` and produces an informative notice until ticket 02.
- `applySpecialist` in `lykos/session/specialist-apply.ts` is the single seam deciding what a specialist
  means across `session-start`, `switch`, and `subagent` contexts.
