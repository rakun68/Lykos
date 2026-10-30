# A sandbox for every subagent is a feature, and it is off by default

Decided by the maintainer on 2026-10-25. Confirms the default in `lykos/config/defaults.ts`
(`containment.level: "off"`, T173) against the new claim that Lykos offers a sandbox per subagent.

## The decision

**Any session or subagent can run its commands in its own sandbox. None does unless asked.**

- **A specialist can carry its own containment**, as [ADR-0037](0037-a-specialist-may-carry-containment.md)
  already allows, so each subagent can be sandboxed differently.
- **The default stays `off`** for standalone and for delegated sessions, MCP included. Making it a
  selling point does not make it always on.
- **Containment stays Docker or Podman** (ADR-0036).
  A lighter OS-native tier (Seatbelt, bubblewrap or Landlock, a Windows equivalent) is deferred until
  everything else in Lykos is mature. It is recorded in `WISHLIST.md` as W25.

## Options considered

- **Default containment on for MCP calls when a runtime is installed.** Rejected: the sandbox is a
  feature a caller chooses, not a default.
- **Build the native tier now**, for speed and lightweightness. Deferred, not rejected.
