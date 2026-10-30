# Architecture decisions

Each record states one decision, why it was made, and what it rules out. A record is never
rewritten: a later one amends or supersedes it. Numbers have gaps, and code comments may cite a
number that is not published here.

- [0002](0002-ponytail-is-the-default-system-prompt.md) The ponytail ruleset is the default system-prompt content
- [0003](0003-preset-vocabulary-is-fixed-at-nine-fields.md) A preset has a fixed vocabulary of nine fields
- [0004](0004-a-preset-is-a-configuration-layer.md) A preset is a configuration layer between project and environment
- [0007](0007-one-concept-called-profile.md) One concept called profile, replacing preset and specialist
- [0008](0008-two-independent-extension-surfaces.md) Two independent extension surfaces, not a wrapper
- [0009](0009-sixteen-resident-tools.md) Sixteen resident tools, reversing the earlier surface trim
- [0015](0015-profile-vocabulary-is-fifteen-fields.md) The profile vocabulary is fifteen fields, and the count was wrong before this decision
- [0016](0016-embeddings-are-a-profile-choice.md) Embeddings are a profile choice, not a global prohibition
- [0019](0019-shipped-profiles-are-a-bundled-lowest-precedence-source.md) Shipped profiles are a bundled, lowest-precedence discovery source
- [0020](0020-the-word-is-specialist.md) The word is specialist, and it names the same one concept
- [0023](0023-the-specialist-vocabulary-is-seventeen-fields.md) The specialist vocabulary is seventeen fields
- [0027](0027-pis-agent-directory-is-generated-under-lykos.md) Pi's agent directory is generated under `~/.lykos`
- [0028](0028-a-default-extension-may-ship-off-and-its-list-entry-is-its-only-switch.md) A default extension may ship off, and its list entry is its only switch
- [0030](0030-a-failed-gate-reruns-its-failed-test-files-once.md) A failed gate reruns its failed test files once
- [0032](0032-the-glossary-is-glossary-md.md) The glossary is `GLOSSARY.md`
- [0035](0035-core-for-primitives-and-boundaries-extensions-for-policy.md) Core for primitives and boundaries, extensions for policy
- [0037](0037-a-specialist-may-carry-containment.md) A specialist may carry containment, and the vocabulary is eighteen fields
- [0038](0038-each-mcp-call-runs-a-session-in-its-own-process.md) Each MCP call runs a delegated session in a process of its own
- [0044](0044-specialist-text-lives-in-the-stream.md) A session's head is neutral, and specialist text lives in the message stream
- [0048](0048-a-sandbox-for-every-subagent-is-a-feature-and-off-by-default.md) A sandbox for every subagent is a feature, and it is off by default
- [0053](0053-mcp-calls-reuse-a-warm-engine.md) MCP calls reuse a warm engine
- [0055](0055-a-delegated-session-gets-a-lean-head.md) A delegated session gets a lean head
- [0057](0057-auto-runs-the-sessions-own-verification-command.md) Auto runs the session's own verification command
