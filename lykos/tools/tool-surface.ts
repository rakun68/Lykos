// T20 — tool-surface audit and trim
// (`docs/10-phase2-tasks.md`, `02-plan.md` §4 D2.3).
//
// Trim, do not rewrite. Removing a tool from the hop-0 surface is in
// scope; optimising an existing Pi tool is not (AGENTS.md rule 3).
// Lykos owns the allowlist passed to `createAgentSession`; Pi keeps the
// implementations.
//
// T20.1 (measure the tax) is T4.1: `calls.tool_schema_tokens`,
// `v_schema_tax.share_of_prompt`, `schemaShareOfPrompt()`, `lykos cost`.
// This module does not rebuild that path. It is the trim (T20.2) and the
// keep-or-reconsider of `@tintinweb/pi-subagents` against the same number
// (T20.3).
//
// The surface is the `tools` array passed to the session, a caller-ordered allowlist.
//
// Ticket 01 & 02 (P10.1): residency and prompt presence replace lifecycle.
// TOOL_REGISTRY below is the one place keyed by tool name; everything else
// in this file is derived from it.
//
// D1: The resolved session surface is byte-identical to before this change.
// Tools marked resident whose implementations land in later tickets
// (powershell, grep, glob) must not enter the request until wired.
// tool_search and tool_call are wired (P10.2). RUNTIME_AVAILABLE_TOOLS
// makes availability explicit.
import {
  PI_DEFAULT_PLUS_SUBAGENTS,
  measureSpecialist,
  measureToolset,
  type ToolSchemaMeasurement,
} from "../ledger/tool-schema.js";
import { PI_READ_ROW, TOOL_CATALOG } from "../ledger/tool-catalog.js";
// Type-only, and it must stay type-only: `tool-risk.ts` imports this
// module's `REGISTRY_TOOL_RISKS` as a value, so a value import back would be a
// runtime cycle. `import type` is erased, so there is none.
import type { ToolRisk } from "./tool-risk.js";

/**
 * Where a tool sits relative to the hop-0 allowlist:
 * - "worker": always on hop-0 (the surviving four).
 * - "host": on hop-0 only when the caller opts into subagents.
 * - "dropped": never on hop-0; `rationale` is the cause, not a justification.
 */
export type ToolResidency = "resident" | "mounted" | "off";
export type PromptPresence = "full" | "named" | "hidden";

export interface ToolRegistryEntry {
  name: string;
  residency: ToolResidency;
  promptPresence: PromptPresence;
  /**
   * One line. For "worker"/"host" this is why the schema is allowed to ride
   * every hop-0 request; for "dropped" it is why it is not on the surface.
   */
  rationale: string;
  /**
   * T107: what class of action a call to this tool performs. Required, not
   * optional — an unannotated tool is an unreviewed tool, and a field the
   * type system lets you forget is one nobody fills in. The table that says
   * *why this tool is here* now also says *what it may do*.
   *
   * Declared for dropped tools too. They are real tools with real risk and
   * a specialist could put one back on a surface; a tier that only exists for
   * the tools currently allowed would have to be invented at exactly the
   * moment someone is widening the surface.
   */
  risk: ToolRisk;
  /**
   * P4 T143: whether a successful call changes a file in the working tree.
   * THE declaration — the post-edit loop, the gate's "did this session edit"
   * test and the edit counters all read it, through `toolChangesFiles`, so a
   * new edit tool cannot be seen by one of them and missed by another.
   *
   * `true` means every call; `{ action: [...] }` means only calls whose
   * `action` argument is one of those (`lsp`: `rename` writes, the six read
   * actions do not). Absent means no. A command-running tool (`bash`, `hub`,
   * `eval`) is absent deliberately: what a command line does to the tree is
   * not knowable from the call, and the post-edit loop never ran after one.
   * `tool-surface.test.ts` fails when a new write-tier row has not been
   * classified one way or the other.
   */
  changesFiles?: FileChange;
}

/** See `ToolRegistryEntry.changesFiles`. */
export type FileChange = true | { readonly action: readonly string[] };

/** The one place keyed by tool name that says which tools ride hop-0 and why. */
export const TOOL_REGISTRY: readonly ToolRegistryEntry[] = [
  {
    name: "read",
    residency: "resident",
    promptPresence: "full",
    rationale: "The worker has to see files. Pi's read with every text line numbered (T168, ADR-0031); the rest is Pi's.",
    risk: { tier: "read", idempotent: true, openWorld: false },
  },
  {
    name: "bash",
    residency: "resident",
    promptPresence: "full",
    rationale:
      "Command execution, tests, and anything that is not a file read or write.",
    // The only command-derived tier in the codebase. `hard-write` is what a
    // command the classifier cannot place gets ("ordinary"), so the declared
    // fallback and the mapping agree rather than being two different answers.
    risk: { tier: "hard-write", tierDerivedFrom: "command", idempotent: false, openWorld: true },
  },
  {
    name: "edit",
    residency: "resident",
    promptPresence: "full",
    rationale: "The worker has to change existing files. Pi's semantics, plus replaceAll (T168, ADR-0031): Lykos's own over Pi's matching.",
    // Not idempotent: an edit matches text that its own first application removes.
    risk: { tier: "soft-write", idempotent: false, openWorld: false },
    changesFiles: true,
  },
  {
    name: "write",
    residency: "resident",
    promptPresence: "full",
    rationale: "The worker has to create files. Pi ships this; we do not rewrite it.",
    risk: { tier: "soft-write", idempotent: true, openWorld: false },
    changesFiles: true,
  },
  {
    name: "commit",
    residency: "resident",
    promptPresence: "full",
    rationale:
      "A contained session cannot write .git, so the model records its work through the host (T179, P15). Resident when the session can write and the folder is a repository: a read-only child and a folder without git are not given it.",
    // Asked at `edit`'s tier (`authorizeCommit`). Not idempotent: a second call
    // commits whatever changed since. Not openWorld: it touches only the
    // local repository, and no remote.
    risk: { tier: "soft-write", idempotent: false, openWorld: false },
  },
  {
    name: "agent",
    residency: "mounted",
    promptPresence: "named",
    rationale:
      "Specialists are configuration. Hop-0 has to be able to spawn them; the schema is the price of that.",
    // A child is an unbounded amount of someone else's work, on its own budget.
    risk: { tier: "hard-write", idempotent: false, openWorld: true },
  },
  {
    name: "get_subagent_result",
    residency: "mounted",
    promptPresence: "named",
    rationale:
      "A background Agent's completion notice is a preview. Retrieving the result is how hop-1 spend becomes a summary instead of a guess.",
    risk: { tier: "read", idempotent: true, openWorld: false },
  },
  {
    name: "steer_subagent",
    residency: "mounted",
    promptPresence: "named",
    rationale:
      "In-process steering is why Pi was the base runtime. Mid-run redirect beats abort-and-rebrief; the schema is small next to Agent.",
    // Writes nothing itself, and redirects a running child into arbitrary work.
    risk: { tier: "hard-write", idempotent: false, openWorld: true },
  },
  {
    name: "grep",
    residency: "resident",
    promptPresence: "full",
    rationale: "Fast regex search across files. Planned resident search tool.",
    risk: { tier: "read", idempotent: true, openWorld: false },
  },
  {
    name: "find",
    residency: "mounted",
    promptPresence: "hidden",
    rationale: "File discovery by pattern and attribute. Planned mounted search tool.",
    risk: { tier: "read", idempotent: true, openWorld: false },
  },
  {
    name: "ls",
    residency: "mounted",
    promptPresence: "hidden",
    rationale: "Directory listing with metadata. Planned mounted inspection tool.",
    risk: { tier: "read", idempotent: true, openWorld: false },
  },
  {
    name: "powershell",
    residency: "resident",
    promptPresence: "full",
    rationale: "Windows host shell. Planned resident execution tool.",
    // A shell, and deliberately NOT command-derived: the one classifier
    // parses POSIX shell, and teaching it PowerShell syntax to tier this
    // dropped tool would be the second opinion T107.4 forbids. It gets the
    // fail-closed answer instead.
    risk: { tier: "hard-write", idempotent: false, openWorld: true },
  },
  {
    name: "subagent_workflow",
    residency: "off",
    promptPresence: "hidden",
    rationale:
      "T4.1: 7453 of the 8164-token pi-subagents catalog is this one description. Phase 6 orchestration, not daily hop-0 work. Keep the extension; drop this tool from the allowlist.",
    risk: { tier: "hard-write", idempotent: false, openWorld: true },
  },
  {
    name: "glob",
    residency: "resident",
    promptPresence: "full",
    rationale: "Fast file matching by glob pattern. Planned resident search tool.",
    risk: { tier: "read", idempotent: true, openWorld: false },
  },
  {
    name: "ast_grep",
    residency: "mounted",
    promptPresence: "hidden",
    rationale: "Structural search across syntax trees. Powerful and occasional, so it is reached through tool_call rather than priced on every request.",
    risk: { tier: "read", idempotent: true, openWorld: false },
  },
  {
    name: "ast_edit",
    residency: "mounted",
    promptPresence: "hidden",
    // Not idempotent: a rewrite whose replacement still matches its own
    // pattern applies again on the next call, and one that does not match
    // afterwards changes nothing the second time — neither answer is "the
    // same state", so it is declared the way `edit` is.
    rationale: "Structural syntax-tree rewrite. Powerful and occasional, so it is reached through tool_call rather than priced on every request.",
    risk: { tier: "soft-write", idempotent: false, openWorld: false },
    changesFiles: true,
  },
  {
    name: "lsp",
    residency: "mounted",
    promptPresence: "hidden",
    rationale:
      "Compiler-accurate navigation, diagnostics and rename. Powerful and occasional, so it is reached through tool_call rather than priced on every request. The READ actions are the common case, but the tier below is the CEILING this tool can reach, not its average: `rename` writes.",
    // P10.4 (ticket 15, D6) — a correction, not a redesign. This row said
    // `read`, which is true of definition, references, hover, symbols,
    // diagnostics and status and false of `rename`, which rewrites every
    // reference to a symbol across every file. A declared tier that is wrong
    // for one action is precisely the unenforced invariant CLAUDE.md warns
    // this project keeps rediscovering, so the row declares the highest tier
    // any of its actions reaches. There is deliberately no second row for the
    // read half: two rows for one tool would be two answers to "what may this
    // do", and the wrong one would be the one a specialist restriction read.
    //
    // Not idempotent, for `edit`'s reason: a rename's second application
    // finds nothing left to rename, so calling it twice is not "the same
    // state" in the sense this field means. Not openWorld: the server is a
    // local child process started from a configured command, it reads the
    // project and answers about it, and it is never handed model-supplied
    // arguments.
    risk: { tier: "soft-write", idempotent: false, openWorld: false },
    changesFiles: { action: ["rename"] },
  },
  // P10.6 (ticket 19, D10): `eval` and `github` moved off→mounted with
  // `hidden` presence, on the same terms as `lsp`, `hub` and the memory five.
  // Mounted rather than resident for the reason those were: both are
  // occasional, and two more schemas on every request of every session would
  // be paid by every session that never calls either.
  {
    name: "eval",
    residency: "mounted",
    promptPresence: "hidden",
    rationale:
      "Persistent evaluation cell whose state survives calls, in a child process of its own. Occasional, so it is reached through tool_call rather than priced on every request.",
    // Arbitrary code, which is `bash`'s ceiling. Deliberately NOT
    // command-derived: a JavaScript cell is not a shell line, and the one
    // classifier in this codebase parses POSIX shell. The declared tier is
    // the answer instead, which is the same call `powershell` makes.
    risk: { tier: "hard-write", idempotent: false, openWorld: true },
  },
  {
    name: "github",
    residency: "mounted",
    promptPresence: "hidden",
    rationale:
      "Forge operations through the gh command line: repositories, files, issues, code search, Actions runs, and the three pull-request writes other people can see. Occasional, so it is reached through tool_call rather than priced on every request.",
    // The CEILING, as `lsp`'s row explains: six of the nine operations are
    // network reads and would be `read`, and `pr_create`/`pr_checkout`/
    // `pr_push` are outward-facing writes. One row, the highest tier any
    // action reaches — two rows for one tool would be two answers to "what
    // may this do", and the wrong one would be the one a specialist
    // restriction read. The per-operation distinction is made where it can be
    // enforced: `github.ts` asks the gate at the `read` tier for the six and
    // at this tier for the three.
    risk: { tier: "hard-write", idempotent: false, openWorld: true },
  },
  {
    name: "hub",
    residency: "mounted",
    promptPresence: "hidden",
    rationale:
      "Background jobs and the peer mailbox: start a command that outlives a foreground timeout, read its log while it runs, kill it and everything it started, and send a message to another agent of this session family. Powerful and occasional, so it is reached through tool_call rather than priced on every request.",
    // P10.5 (ticket 16, D8/D10): `hard-write` was already the declared tier
    // and it is still the right one — `start` runs an arbitrary command line
    // through a shell, which is `bash`'s ceiling, and `bash` is the only
    // command-derived row in this table. This one is NOT command-derived,
    // deliberately: the tier is a property of the tool, and `hub`'s other
    // three ops carry no command at all for a classifier to read. The command
    // itself is still classified — `hub start` reaches the gate as a `bash`
    // operation and `tierForAction` runs `classifyCommandRisk` on it there,
    // which is the one place that question has ever been answered.
    risk: { tier: "hard-write", idempotent: false, openWorld: true },
  },
  // P10.6 (ticket 20, D9): the nine this ticket built, all moved off→mounted
  // with `hidden` presence, on the same terms as `lsp`, `hub`, the memory five
  // and ticket 19's pair. Mounted rather than resident for the reason those
  // were: each is occasional, and nine more schemas on every request of every
  // session would be paid in full by every session that calls none of them.
  // `todo` and `ask` are the two this ticket leaves resident, because a
  // checklist the model has to discover is a checklist it stops keeping.
  {
    name: "checkpoint",
    residency: "mounted",
    promptPresence: "hidden",
    rationale:
      "Name the current point as one worth returning to, against the checkpoint Lykos already took at turn start. Occasional, so it is reached through tool_call rather than priced on every request. It writes nothing: T104's rule that only a human moves the tree is unchanged.",
    // `read` and not `soft-write`, and this is a CORRECTION of the placeholder
    // row rather than a redesign: the tool reads the checkpoint list and
    // appends a label to session state, which dies with the session. It writes
    // no file, creates no checkpoint and cannot restore one — `checkpoint-
    // tools.ts` is handed a view with a single `list` member and nothing else.
    // Declaring `soft-write` would have been declaring a capability the module
    // structurally does not have.
    risk: { tier: "read", idempotent: false, openWorld: false },
  },
  {
    name: "rewind",
    residency: "mounted",
    promptPresence: "hidden",
    rationale:
      "Propose returning the working tree to an earlier checkpoint and hand back the command a human runs. Occasional, so it is reached through tool_call rather than priced on every request. It moves nothing: the proposal is recorded and a human decides.",
    // Same correction, and the same reason. The placeholder said `soft-write`
    // for a tool that was going to restore files; this one cannot, so the tier
    // that describes it is the one for reading a list and recording a
    // proposal.
    risk: { tier: "read", idempotent: false, openWorld: false },
  },
  {
    name: "context_notes",
    residency: "mounted",
    promptPresence: "hidden",
    rationale:
      "A keyed scratchpad that survives turns within one session and dies with it. Occasional, so it is reached through tool_call rather than priced on every request. It is session state, not memory and not a file.",
    // `read` rather than `soft-write` for the correction above's reason: there
    // is no file. `memory-tools.ts`'s `retain` is `soft-write` precisely
    // because it writes `proposed.md`; this writes a Map that the process
    // forgets.
    risk: { tier: "read", idempotent: false, openWorld: false },
  },
  {
    name: "new_context",
    residency: "mounted",
    promptPresence: "hidden",
    rationale:
      "Run exploratory work as an isolated child session and return only its conclusion, so a long exploration is not re-sent on every later request. Occasional, so it is reached through tool_call rather than priced on every request.",
    // `Agent`'s tier, because it IS `Agent`'s machinery: a child is an
    // unbounded amount of someone else's work on its own budget, and the
    // default specialist being read-only is a default rather than a ceiling.
    risk: { tier: "hard-write", idempotent: false, openWorld: true },
  },
  {
    name: "manage_skill",
    residency: "mounted",
    promptPresence: "hidden",
    rationale:
      "Create, update or remove a skill in .lykos/skills/, which changes what every later session is offered. Occasional, so it is reached through tool_call rather than priced on every request. Every action asks a human, showing them the whole file.",
    risk: { tier: "soft-write", idempotent: false, openWorld: false },
  },
  {
    name: "skill",
    residency: "mounted",
    promptPresence: "hidden",
    rationale:
      "Load a skill's procedure by name instead of by a read of the path the prompt printed. Occasional, so it is reached through tool_call rather than priced on every request. The old path still resolves; this removes the indirection, not the route.",
    // P10.6 (ticket 20, D4) — a CORRECTION, on the same terms as P10.4's `lsp`
    // row. This said `hard-write`/open-world while it was an unbuilt
    // placeholder. The tool reads one file inside the project and returns its
    // text; the `read` tool does the same thing to the same file and is tiered
    // `read`. Leaving the placeholder would have made the new path strictly
    // harder to reach than the one it replaces, which is the opposite of the
    // point, and would have been a declared tier wrong for every action the
    // tool has. What the model then DOES with the procedure is gated on the
    // tools it uses to do it, exactly as it is today.
    risk: { tier: "read", idempotent: true, openWorld: false },
  },
  // P10.8 (ticket 23, D9/D10): off→mounted with `hidden` presence, on the same
  // terms as `lsp`, `hub`, the memory five and the session nine. Mounted rather
  // than resident because a scan is occasional — it is the call before a commit
  // that touches configuration, not a call on every turn — and one more schema
  // on every request of every session would be paid by every session that
  // never scans anything.
  {
    name: "security_scan",
    residency: "mounted",
    promptPresence: "hidden",
    rationale:
      "Deterministic static scan for credentials, catastrophic shell shapes and key files git is not ignoring, over the rule sets the secrets hook and the gate already own. Occasional, so it is reached through tool_call rather than priced on every request. No network, no model: it matches a fixed rule set and records what matched.",
    // P10.8 (ticket 23, D9) — a CORRECTION of the placeholder row, on the same
    // terms as `lsp`'s, `skill`'s and `checkpoint`'s. This said `read` and
    // `idempotent: true` while it was unbuilt, and neither is true of what was
    // built: the tool WRITES a scan record under `.lykos/security/`, and a
    // second scan writes a second record rather than leaving the same state.
    //
    // `soft-write` and not `hard-write` for `retain`'s reason: the only file it
    // can write is its own record under `.lykos/`, which no prompt is ever
    // assembled from and which touches nothing in the working tree. Not
    // openWorld: no socket, no spawn, no model — the rule set is fixed in
    // source and the only inputs are files inside the scope.
    risk: { tier: "soft-write", idempotent: false, openWorld: false },
  },
  // P10.7 (ticket 12, D10): the web pair, off→RESIDENT with `full` presence —
  // the first tools since P10.4 to move the resident surface, and the first
  // this phase has made resident rather than mounted. The reason is the
  // ticket's own first sentence: these are the two absences a person notices
  // within an hour, and a model that has to discover a web fetcher through
  // `tool_search` is a model that answers from training data about a library
  // that shipped a major version last month. Everything mounted since P10.4 is
  // occasional; these two are not.
  {
    name: "web_search",
    residency: "resident",
    promptPresence: "full",
    rationale:
      "Search the web through the configured provider and return titles, URLs and the provider's snippets. Resident because a model that must discover how to search will answer from memory instead.",
    // `read`, and open-world: it reads someone else's index over the network
    // and writes nothing. Not idempotent — the web moves under the same query.
    risk: { tier: "read", idempotent: false, openWorld: true },
  },
  {
    name: "web_fetch",
    residency: "resident",
    promptPresence: "full",
    rationale:
      "Read one web page as markdown, refusing private addresses on every hop. Resident for web_search's reason: the pair is only useful together, and a search whose results cannot be read is a list of URLs.",
    risk: { tier: "read", idempotent: false, openWorld: true },
  },
  {
    name: "yield",
    residency: "mounted",
    promptPresence: "hidden",
    rationale:
      "Hand a result back, checked against the output schema the caller asked for; a mismatch returns the schema to the model rather than being repaired downstream. Occasional, so it is reached through tool_call rather than priced on every request.",
    risk: { tier: "read", idempotent: true, openWorld: false },
  },
  {
    name: "goal",
    residency: "mounted",
    promptPresence: "hidden",
    rationale:
      "Set or read the session's standing objective. Occasional, so it is reached through tool_call rather than priced on every request, and hidden from the mounted catalog the prompt renders (D6).",
    // `read`, for `context_notes`'s reason: the objective is session state that
    // dies with the session, not a file. The placeholder said `soft-write`
    // when it was going to be one.
    risk: { tier: "read", idempotent: false, openWorld: false },
  },
  {
    name: "think",
    residency: "mounted",
    promptPresence: "hidden",
    rationale:
      "One deliberation turn with no effect of any kind. Reached through tool_call and hidden from the mounted catalog the prompt renders (D6); its definition is handed nothing, so there is nothing it could change.",
    risk: { tier: "read", idempotent: true, openWorld: false },
  },
  // P10.6 (ticket 18, D8): the five memory tools, all moved off→mounted with
  // `hidden` presence. Mounted rather than resident is the right answer for
  // the same reason it was for `lsp` and `hub` — memory is occasional, and
  // five schemas on every request of every session would be the most
  // expensive thing on the wire for the least-used capability.
  {
    name: "retain",
    residency: "mounted",
    promptPresence: "hidden",
    rationale:
      "Propose a memory candidate for human acceptance. Occasional, so it is reached through tool_call rather than priced on every request. It writes only the proposal queue, which no prompt is assembled from.",
    // `soft-write` and not `read`, deliberately: it writes a file. It is the
    // WEAK tier and not `hard-write` because the only file it can write is
    // `.lykos/memory/proposed.md`, which nothing injects and a human has to
    // act on before it means anything. Not idempotent: proposing the same
    // lesson twice is the repetition gate counting to two, which is a
    // different state and the whole point of the queue.
    risk: { tier: "soft-write", idempotent: false, openWorld: false },
  },
  {
    name: "recall",
    residency: "mounted",
    promptPresence: "hidden",
    rationale:
      "Query accepted memories from the local markdown store. Occasional, so it is reached through tool_call rather than priced on every request.",
    risk: { tier: "read", idempotent: true, openWorld: false },
  },
  {
    name: "reflect",
    residency: "mounted",
    promptPresence: "hidden",
    rationale:
      "Report counts, the newest titles and the pending proposals without reading the store into context. Occasional, so it is reached through tool_call rather than priced on every request.",
    risk: { tier: "read", idempotent: true, openWorld: false },
  },
  {
    name: "memory_edit",
    residency: "mounted",
    promptPresence: "hidden",
    rationale:
      "Invalidate or amend an accepted memory entry by identifier. Occasional, so it is reached through tool_call rather than priced on every request. It never deletes: the superseded line stays where it was.",
    // Rewrites a line in a real memory file, so this is the highest tier the
    // five reach. Not idempotent for `edit`'s reason: the second call finds
    // an entry that is already invalid and changes nothing, which is not "the
    // same state" in the sense this field means.
    risk: { tier: "soft-write", idempotent: false, openWorld: false },
  },
  {
    name: "learn",
    residency: "mounted",
    promptPresence: "hidden",
    rationale:
      "Propose a memory from a human's correction, with the exchange attached as provenance. Occasional, so it is reached through tool_call rather than priced on every request. Same queue as retain, same human acceptance.",
    risk: { tier: "soft-write", idempotent: false, openWorld: false },
  },
  {
    name: "todo",
    residency: "resident",
    promptPresence: "full",
    rationale: "Track task list and status. Lykos resident tool.",
    risk: { tier: "soft-write", idempotent: true, openWorld: false },
  },
  {
    name: "ask",
    residency: "resident",
    promptPresence: "full",
    rationale: "Ask the user a question when input is needed. Lykos resident tool.",
    risk: { tier: "read", idempotent: false, openWorld: true },
  },
  {
    name: "exit_plan",
    residency: "resident",
    promptPresence: "full",
    rationale: "Present finished plan and ask to begin execution. Lykos resident tool.",
    risk: { tier: "read", idempotent: true, openWorld: false },
  },
  {
    name: "tool_search",
    residency: "resident",
    promptPresence: "full",
    rationale: "Search mounted tools by name or description and return matching schemas. Planned P10 transport tool.",
    risk: { tier: "read", idempotent: true, openWorld: false },
  },
  {
    name: "tool_call",
    residency: "resident",
    promptPresence: "full",
    rationale: "Execute a mounted tool through the transport wire. Planned P10 transport tool.",
    risk: { tier: "hard-write", idempotent: false, openWorld: true },
  },
  {
    name: "ask_coordinator",
    residency: "resident",
    promptPresence: "full",
    rationale: "Ask the coordinator a question in delegated sessions (T224).",
    risk: { tier: "read", idempotent: false, openWorld: true },
  },
  {
    name: "give_up",
    residency: "resident",
    promptPresence: "full",
    rationale: "Yield and request coordinator intervention in delegated sessions (T224).",
    risk: { tier: "read", idempotent: true, openWorld: false },
  },
];

/**
 * P4 T143: file-changing tools a Pi package registers that this table has no
 * row for — the multi-edit and patch tools some edit extensions ship. They
 * were in the post-edit loop's own list before the declaration moved here,
 * and a tool this project does not own still changes the tree when it runs.
 */
export const PACKAGE_FILE_CHANGING_TOOLS: readonly string[] = ["multi_edit", "apply_patch"];

const FILE_CHANGES: ReadonlyMap<string, FileChange> = new Map([
  ...TOOL_REGISTRY.filter((e) => e.changesFiles !== undefined).map((e) => [e.name, e.changesFiles!] as const),
  ...PACKAGE_FILE_CHANGING_TOOLS.map((name) => [name, true] as const),
]);

/**
 * T156: the result-details key an extension tool's gated wrapper sets on a
 * call that changed files — every successful call of a tool that declared
 * `changesFiles`, and any call of one that did not whose git working tree
 * moved. Carried on the call's own result rather than in a process-wide table
 * of tool names, so two sessions in one process (an MCP worker, a parent and
 * its child) can never see each other's extensions' declarations.
 */
export const FILES_CHANGED_DETAIL = "lykosFilesChanged";

/** T156: did this result say its call changed files (`FILES_CHANGED_DETAIL`)? */
export function resultSaysFilesChanged(result: unknown): boolean {
  if (result === null || typeof result !== "object") return false;
  const details = (result as { details?: unknown }).details;
  return details !== null && typeof details === "object" && (details as Record<string, unknown>)[FILES_CHANGED_DETAIL] === true;
}

/**
 * Whether a successful call to `name` with `args` changes a file. `name` is
 * the tool's own name, not the `tool_call` transport's: `isFileChangingCall`
 * in `tool-call.ts` unwraps the transport first, and that is the function the
 * loop, the gate and the counters call.
 */
export function toolChangesFiles(name: string | undefined, args?: unknown): boolean {
  if (name === undefined) return false;
  const decl = FILE_CHANGES.get(name);
  if (decl === undefined) return false;
  if (decl === true) return true;
  const action =
    args !== null && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>).action : undefined;
  return typeof action === "string" && decl.action.includes(action);
}

/** Every tool name with any file-changing call, for listings and tests. */
export function fileChangingToolNames(): string[] {
  return [...FILE_CHANGES.keys()];
}

export const AGENT_TOOL_NAME = "agent" as const;
export const SUBAGENT_WORKFLOW_TOOL = "subagent_workflow" as const;

/** Pi's registered spellings. An allowlist that still says these is the same tool. */
const LEGACY_TOOL_NAMES: Readonly<Record<string, string>> = {
  Agent: AGENT_TOOL_NAME,
  SubagentWorkflow: SUBAGENT_WORKFLOW_TOOL,
};

export function canonicalToolName(name: string): string {
  return LEGACY_TOOL_NAMES[name] ?? name;
}

/**
 * What the retired third-party Pi delegate server (ADR-0036) registered when
 * its `tools` argument was OMITTED. It is the hop-0 surface T20 replaced — the
 * "before" side of that trim's measured number — and it is not Pi's
 * `createAgentSession` default, which is read/bash/edit/write.
 *
 * P10.4 (ticket 13, D6) re-examined this and the reasoning survives, though
 * the name does not read the way the plan assumed: these four are not "tools
 * Lykos omits from the delegate", they were the four that arrived when Lykos
 * named none. Nothing consumes the list at runtime, and its only reader is
 * `omitToolsMeasurement()`, which prices that historical before-state for
 * `lykos cost`.
 *
 * So the fact that three of the four are now Lykos-owned wrappers changes
 * nothing here: the list describes a retired third-party server's behaviour,
 * not Lykos's surface, and editing it to track Lykos's tools would silently
 * rewrite a recorded measurement into something that was never measured
 * (AGENTS.md rule 4).
 */
export const PI_DELEGATE_OMIT_TOOLS = ['read', 'grep', 'find', 'ls'] as const;

export const LYKOS_TOOL_NAMES = [
  'todo',
  'ask',
  'exit_plan',
  'tool_search',
  'tool_call',
  'ask_coordinator',
  'give_up',
] as const;

export const RUNTIME_AVAILABLE_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'bash',
  'edit',
  'write',
  'commit',
  'agent',
  'get_subagent_result',
  'steer_subagent',
  'todo',
  'ask',
  'exit_plan',
  'tool_search',
  'tool_call',
  // P10.4 (ticket 13): the five this ticket wired. Each is a Pi definition
  // registered by `loadTools()` — `grep` with the snapshot tag, `glob` as
  // Pi's `find` under a second name, `powershell` through the approval gate,
  // and `find`/`ls` mounted for `tool_call`. They enter this set at the
  // moment they became reachable and not before: that is the whole job of
  // this set, which is why the registry declared them long before today.
  'grep',
  'glob',
  'powershell',
  'find',
  'ls',
  // P10.4 (ticket 14, D8): the two structural tools. Both mounted with
  // `hidden` presence, so they are registered definitions off the wire and
  // `tool_call` is the only way in — which is what the transport is for.
  // They enter this set at the moment they became reachable and not before.
  'ast_grep',
  'ast_edit',
  // P10.4 (ticket 15, D9): the language-server client. Mounted with `hidden`
  // presence, so its schema is off the wire and `tool_call` is the only way
  // in. It enters this set at the moment it became reachable and not before.
  'lsp',
  // P10.5 (ticket 16, D10): the background shell. Mounted with `hidden`
  // presence on the same terms as `lsp` — its schema is off the wire and
  // `tool_call` is the only way in. It enters this set at the moment it
  // became reachable and not before.
  'hub',
  // P10.6 (ticket 18, D8): the five memory tools. Mounted with `hidden`
  // presence on the same terms as `lsp` and `hub` — their schemas are off the
  // wire and `tool_call` is the only way in. They enter this set at the moment
  // they became reachable and not before.
  'retain',
  'recall',
  'reflect',
  'memory_edit',
  'learn',
  // P10.6 (ticket 19, D10): the forge tool and the evaluation cell. Mounted
  // with `hidden` presence on the same terms as `lsp` and `hub` — their
  // schemas are off the wire and `tool_call` is the only way in. They enter
  // this set at the moment they became reachable and not before.
  'eval',
  'github',
  // P10.6 (ticket 20, D9): the nine session and context tools. Mounted with
  // `hidden` presence on the same terms as `lsp`, `hub` and the memory five —
  // their schemas are off the wire and `tool_call` is the only way in. They
  // enter this set at the moment they became reachable and not before.
  'checkpoint',
  'rewind',
  'context_notes',
  'new_context',
  'manage_skill',
  'skill',
  'yield',
  'goal',
  'think',
  // P10.7 (ticket 12, D10): the web pair. RESIDENT with `full` presence,
  // unlike everything above them since P10.4 — their schemas ride every
  // request and the model is told about them in the prompt. They enter this
  // set at the moment they became reachable and not before.
  'web_search',
  'web_fetch',
  // P10.8 (ticket 23, D10): the deterministic scanner. Mounted with `hidden`
  // presence on the same terms as `lsp` and `hub` — its schema is off the wire
  // and `tool_call` is the only way in. It enters this set at the moment it
  // became reachable and not before.
  'security_scan',
]);

export const DEFAULT_RESIDENT_TOOLS: readonly string[] = TOOL_REGISTRY
  .filter(
    (e) =>
      e.residency === 'resident' &&
      !LYKOS_TOOL_NAMES.includes(e.name as (typeof LYKOS_TOOL_NAMES)[number]) &&
      RUNTIME_AVAILABLE_TOOLS.has(e.name),
  )
  .map((e) => e.name);

/** Every wired mounted tool: off the wire, registered as a definition, reachable through `tool_call`. */
export const MOUNTED_TOOLS: readonly string[] = TOOL_REGISTRY
  .filter((e) => e.residency === 'mounted' && RUNTIME_AVAILABLE_TOOLS.has(e.name))
  .map((e) => e.name);

/**
 * The mounted tools the subagent opt-in puts on the allowlist — the host trio.
 *
 * P10.4 (ticket 13) made the distinction load-bearing. `find` and `ls` are
 * mounted too, and they must NOT ride the allowlist when a caller asks for
 * subagents: they are mounted precisely so their schemas stay off the wire,
 * and `tool_call` is how they are reached. The registry already separates
 * the two cases in `promptPresence` — `named` for the trio the prompt
 * introduces, `hidden` for the tools it does not mention — so that is the
 * filter, rather than a second hand-kept list of three names.
 */
export const MOUNTED_SUBAGENT_TOOLS: readonly string[] = TOOL_REGISTRY
  .filter(
    (e) => e.residency === 'mounted' && e.promptPresence === 'named' && RUNTIME_AVAILABLE_TOOLS.has(e.name),
  )
  .map((e) => e.name);

export const REGISTRY_OFF_TOOLS: readonly string[] = TOOL_REGISTRY
  .filter((e) => e.residency === 'off')
  .map((e) => e.name);

export const REGISTRY_TOOL_RISKS: Readonly<Record<string, ToolRisk>> = Object.fromEntries(
  TOOL_REGISTRY.filter((e) => !LYKOS_TOOL_NAMES.includes(e.name as (typeof LYKOS_TOOL_NAMES)[number])).map((e) => [e.name, e.risk]),
);

export interface ResolveResidentToolsOpts {
  subagents?: boolean;
}

export function resolveResidentTools(opts: ResolveResidentToolsOpts = {}): string[] {
  if (opts.subagents) return [...DEFAULT_RESIDENT_TOOLS, ...MOUNTED_SUBAGENT_TOOLS];
  return [...DEFAULT_RESIDENT_TOOLS];
}

export interface ResolveSessionToolsOpts {
  tools?: readonly string[];
  subagents?: boolean;
}

export function resolveSessionTools(opts: ResolveSessionToolsOpts = {}): string[] {
  if (opts.tools !== undefined) return [...opts.tools];
  return resolveResidentTools({ subagents: opts.subagents === true });
}

export function matchesDocumentedSurface(names: readonly string[] | undefined): boolean {
  if (names === undefined) return false;
  const resident = resolveResidentTools();
  const withHost = resolveResidentTools({ subagents: true });
  return namesEqual(names, resident) || namesEqual(names, withHost);
}

function namesEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function workerSurfaceMeasurement(): ReturnType<typeof measureSpecialist> {
  return measureSpecialist(DEFAULT_RESIDENT_TOOLS);
}

// Priced with Pi's own `read` row, not the live one: this is the recorded before-state of what
// the retired Pi delegate server registered when `tools` was omitted, and that package's `read` carried no
// numbering sentence (T168). The figure is unchanged by this ticket, deliberately.
export function omitToolsMeasurement(): ReturnType<typeof measureSpecialist> {
  return measureSpecialist(PI_DELEGATE_OMIT_TOOLS, { ...TOOL_CATALOG, read: PI_READ_ROW });
}

export function workerPlusHostMeasurement(): ReturnType<typeof measureSpecialist> {
  return measureSpecialist(resolveResidentTools({ subagents: true }));
}

export function fullSubagentsMeasurement(): ReturnType<typeof measureSpecialist> {
  return measureSpecialist(PI_DEFAULT_PLUS_SUBAGENTS);
}

export function workflowOnlyMeasurement(): ToolSchemaMeasurement {
  return measureToolset([SUBAGENT_WORKFLOW_TOOL]);
}
