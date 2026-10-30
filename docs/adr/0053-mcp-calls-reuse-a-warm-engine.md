# MCP calls reuse a warm engine

Decided by the maintainer on 2026-10-25. **Amends [ADR-0038](0038-each-mcp-call-runs-a-session-in-its-own-process.md).**

## The decision

**An MCP call does not pay a cold process start.** Today each call starts `lykos session-child` and
waits for it. That is replaced by either a pool of warm session processes or a resident engine that the
MCP server talks to, the same seam ADR-0046 plans for the
TUI. Which of the two is decided when the work is opened, from measurements.

- **What stays from ADR-0038:** one session is isolated from another, the wire to the session is the
  same, and the session is exactly the one `lykos run` starts.
- **The evidence:** cold start for one MCP call, measured before and after. It is unmeasured today.

## Why

Speed ranks second (ADR-0047), and a
coordinator that fans out pays the cold start once per call. Node's own start is about 42 ms and the
`yaml` import about 120 ms, before Pi boots.

## Amended 2026-10-25 (T226)

**The warm pool won.** A resident engine was considered and rejected in favor of a
process-level warm pool of pre-spawned `lykos session-child` processes (`createWarmPool`).

The warm pool was chosen over a resident engine because it provides:
- **Cleaner containment and isolation:** each process serves exactly one session and exits, avoiding
  any memory or state bleed across tasks, and cleanly preserving OS/container containment boundaries.
  Idle processes are keyed by `(workspace, trustSource)`.
- **Zero wire changes:** the stdin/stdout JSON-lines protocol and framing remain byte-for-byte identical.
- **Minimal config surface:** a single `mcp.warm_pool` integer setting (default 2, 0 disables).
- **Targeted latency reduction:** the module graph loading (~7.6 s built, ~65% of the 11.9 s cold start)
  was what dominated; the request-dependent ~4.2 s (trust, worktree, config, extensions, head assembly)
  does not dominate once the module graph is warm, running in under a second built (~861 ms).
- **Maturity boundary:** preloading config, extensions, or boot state into idle workers is out of scope
  for now, preserving strict per-session isolation without premature state caching.

### Before and after

Measured on the maintainer's Windows 10 machine, 10 sequential calls each, pool of 2. Median (min–max), ms from the moment the call is made.

| | before, built | after, built | before, tsx | after, tsx |
| --- | --- | --- | --- | --- |
| first frame | 7725 (6762–8450) | 5 (4–6) | 9041 (6951–15223) | 5 (4–20) |
| **first model request** | **11944 (10473–12945)** | **2495 (2387–3021)** | **17671 (14896–26795)** | **4528 (4362–5294)** |
| result | 13433 (11935–15608) | 3585 (3378–4441) | 19355 (16165–29758) | 5461 (5259–6186) |

Idle children are keyed by workspace and trust source, both fixed when the child spawns, which is
what keeps the request line byte for byte the cold path's. The request-dependent part (trust,
worktree, config, extensions, head) is not preloaded; preloading it is a later maturity step.
