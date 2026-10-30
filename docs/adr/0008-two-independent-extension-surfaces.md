# Two independent extension surfaces, not a wrapper

Lykos loads Pi extensions unchanged, and separately offers its own API for the moments Pi has no
concept of — a post-edit check result, a verification gate verdict, a profile switch, a budget
threshold crossed. The two surfaces do not layer: nothing in Lykos mirrors Pi's event types.

The alternative considered was a wrapper exposing all of Pi's 34 events plus Lykos's own, so an
extension author never touches Pi's types. That was rejected because it is a second API to keep in
sync with a dependency Lykos does not control, and because it buys ergonomics rather than capability.

## Consequences

A Pi release cannot break a Lykos extension by changing an event's shape, because no Lykos extension
sees a Pi event. Unknown Pi events pass through untouched, so a new Pi capability is usable the day
it ships without a Lykos release.

The runtime stays pinned exactly and a version bump is a task with its own verification, rather than
something a compatibility table absorbs.

The documented escape hatch is one sentence: anything the Lykos API does not cover, write a Pi
extension, and Lykos will load it.

One correction this ADR records, because it was believed and was wrong: Lykos's hook surface exposes
five events and Pi's exposes thirty-four, so Lykos's vocabulary was a **subset**, not a superset. What
Lykos actually adds is that its hooks are declared in configuration rather than written in
TypeScript — a superset in ergonomics, not in coverage.
