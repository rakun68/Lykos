// `memory/` — the memory domain (markdown store, parsing, file ops, and the
// proposal queue).
//
// The CLI adapters live in `cli/memory.ts` and `cli/memory-propose.ts`; head
// assembly, the head view and `tools/memory-tools.ts` import from here.
//
// ADR-0017 removed the mistakes-only scope restriction this module was built
// under. What it kept is the part with teeth: a model PROPOSES and a human
// ACCEPTS, and an entry is invalidated rather than deleted. Both survive in
// code rather than in prose — `proposeMemory` is the only write a tool can
// reach, and `isEntryValid` is what "invalidated" means.

export {
  MEMORY_FILES,
  MEMORY_SCOPES,
  isMemoryFile,
  isMemoryScope,
  isEntryValid,
  parseMemoryEntries,
  renderEntryMeta,
  renderMemoryEntry,
  splitEntryMeta,
  type MemoryEntry,
  type MemoryFile,
  type MemoryMeta,
  type MemoryScope,
} from "./memory/entries.js";

export { memoryFilePath } from "./memory/paths.js";

export {
  appendMemoryEntry,
  invalidateMemoryEntry,
  removeMemoryEntry,
  type AppendOptions,
  type InvalidateResult,
  type RemoveResult,
} from "./memory/store.js";

export {
  acceptProposal,
  DEFAULT_PROMOTE_AFTER,
  normalizeLesson,
  proposalSeenCount,
  proposedPath,
  proposeMemory,
  readProposals,
  type AcceptResult,
  type ProposeOptions,
  type ProposeResult,
} from "./memory/proposals.js";
