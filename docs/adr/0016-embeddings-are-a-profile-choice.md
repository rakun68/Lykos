# Embeddings are a profile choice, not a global prohibition

`CLAUDE.md` rule 9 read "**No embeddings**", and `WISHLIST.md` recorded the reasoning as "not a budget
call any more — the industry moved to search". As a global rule it prohibited a whole retrieval class
in every session regardless of what that session was for, which is the shape of a decision that
belongs in a profile.

**Rule 9's embeddings half is deleted.** A memory or retrieval backend that uses embeddings is
selected by a profile's `memory` field, alongside the local backends, and a session that does not
select one carries none of the cost. The other half of rule 9 — nothing enters the frozen head unless
it is fixed for the whole session — is untouched and remains a global invariant.

## Consequences

The embeddings-backed memory tools become buildable rather than rejected. They do not land with the
rest of the memory surface: `retain`, `recall` and `reflect` over a local backend are a tool-shaped
problem and land with the tool catalog, while an embeddings backend is an infrastructure-shaped one — a model, a
vector store, an index — and lands after. The `memory` field carries the backend name from the first
day so the later addition changes a value and not a schema.

A profile that selects an embeddings backend pays for it in dependencies at session boot, and the
ledger records that cost the way it records any other. The rule this replaces asserted the answer;
the field measures it.
