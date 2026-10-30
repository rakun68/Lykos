# Lykos — Prefix Control Surface & Head Stability

**Companion to:** `docs/reference/telemetry.md`
**Status:** Living reference specification for prefix stability, frozen-head contracts, and drift detection.

---

## 0. The Prefix Stability Principle

In Anthropic, DeepSeek, and modern LLM providers, prompt caching depends upon an exact, byte-identical
prefix from turn to turn.

> **Nothing enters the system prompt head block unless it is fixed for the entire session.**

Any mutation to the head — changing clock timestamps, dynamic git churn status, shifting memory
summaries, or reordered tool lists — forces a full cache write and cold prefix evaluation on every
turn, destroying the economic advantage of prompt caching.

---

## 1. Head Assembly Order

The prompt prefix is assembled once at session boot via `appendSystemPromptOverride`:

1. **System Identity & Environment:** Static system instructions and runtime contract.
2. **Repository Instructions:** `CLAUDE.md` and `AGENTS.md` context files.
3. **Preset Instructions:** Static instructions defined by the active preset (e.g. ponytail).
4. **Output Diet:** Static guidelines eliminating conversational preamble and conversational filler.
5. **Tool Schemas:** Deterministically sorted OpenAI-compatible function definitions.

Volatile context (current turn state, command output, user prompts) enters solely through user turns
and message history, preserving the prefix invariant.

---

## 2. Head Drift Detection (`calls.prefix_fingerprint`)

Lykos observes and verifies prefix stability in real-time:
- **`prefix_fingerprint`:** SHA-256 hash computed directly from the live `AgentSession` system prompt
  and active tool names on each assistant turn.
- **`v_head_drift`:** SQL view identifying calls where `prefix_fingerprint` changed mid-session,
  immediately surfacing extensions or hooks that inject volatile content.
- **The frozen tool list (T154).** The `## lykos-head` block's `tools:` line and the head contract's
  drift baseline are both the session's **final** tool list — the one `createSession` receives,
  after mounted tools are stripped, resident Lykos-extension tools and admitted Pi-extension tools
  are added, read-only filtering runs, and any name nothing defines is dropped (Pi drops it too). So
  the head names exactly the tools on the wire: a session with no human channel is never told it has
  `ask` or `exit_plan`. The head is rendered while Pi's resource loader reloads, after every
  extension has registered, and the list is computed once and reused, so the head and the wire
  cannot disagree. `lykos head-drift (…): changed field(s): toolNames` on stderr therefore means the
  tool list really changed mid-session (an extension calling `setActiveTools`, say), not that the
  baseline was taken too early.
