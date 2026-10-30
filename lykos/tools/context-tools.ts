// The three tools that depend on nothing outside this session.
//
// **ONE MODULE, THREE DEFINITIONS**, on `memory-tools.ts`'s terms: three files
// for three tools over one piece of session state would put `context_notes`
// and `goal` in different files for no reason either of them cares about, and
// would copy the dependency object twice.
//
// **`context_notes` IS SESSION STATE, NOT THE TRANSCRIPT AND NOT MEMORY (D2).**
// A small keyed store that survives turns inside one session and dies with it.
// It is NOT `.lykos/memory/` — proposing something durable is `retain`, which
// queues a line for a human to accept, and conflating the two would give the
// model two ways to say different things. So this writes no file, reaches no
// gate and outlives nothing: `SessionScratch` below is a plain object created
// once per `loadTools()` call, which is once per session, and when the session
// object is dropped the notes are dropped with it. The result text says so in
// a sentence the model reads, every time, because a model that believes it has
// written something down permanently and has not is the same failure `retain`
// spends a paragraph avoiding.
//
// D2 asks for a keyed store, capped at 16384 UTF-8 bytes over the whole store,
// so twenty minutes of unrelated findings do not have to be rewritten as one
// blob to add a line. What is NOT here is a context projection: Lykos's head is frozen for the session (AGENTS.md rule 9), so a
// notebook that edited the system prompt mid-session would invalidate the
// prompt cache on every write. The model reads its notes back by calling this
// tool, which costs one tool result instead of the whole conversation's cache.
//
// **`goal` AND `think` ARE HIDDEN (D6).** Mounted with `hidden` prompt
// presence, reached through `tool_call`, and absent from
// `assembleMountedCatalogHead()` — which is the catalog listing the model
// reads — because that block only renders `named` and `full` entries.
//
// **`think` IS HANDED NOTHING, AND THAT IS THE POINT (D6).** It produces no
// side effect at all: it exists so a deliberation turn is expressible as a
// call rather than as a comment inside some other tool's arguments. So
// `buildThinkTool()` takes no options — not even a counter, because a counter
// is a side effect and D6 says there are none. "This tool changes nothing" is
// therefore a fact about what the definition is handed rather than a rule
// somebody has to remember, and `context-tools.test.ts` asserts it by trying.
//
// **THE SCHEMA TAX, RECORDED AT THE MOMENT THE TOOLS ARE ADDED (AGENTS.md rule
// 3): these three ride NO request.** All mounted with `hidden` prompt presence
// (D9), reached through `tool_call`. The measured numbers are asserted in
// `context-tools.test.ts`, so a description that doubles the bill fails a test
// rather than passing silently.

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export const CONTEXT_NOTES_TOOL_NAME = "context_notes";
export const GOAL_TOOL_NAME = "goal";
export const THINK_TOOL_NAME = "think";

/** The three, in the order the plan builds them. Exported so the registration site cannot drift from this module. */
export const CONTEXT_TOOL_NAMES = [CONTEXT_NOTES_TOOL_NAME, GOAL_TOOL_NAME, THINK_TOOL_NAME] as const;

/**
 * The whole store's cap, in UTF-8 bytes. A starting value, unmeasured.
 */
export const CONTEXT_NOTES_MAX_BYTES = 16_384;

/** How many distinct keys the store holds. A store with two hundred keys is a filesystem, and this is not one. */
export const CONTEXT_NOTES_MAX_KEYS = 32;

/** One key. Lower-case, so `Findings` and `findings` cannot become two notes the model believes are one. */
export const CONTEXT_NOTE_KEY_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** The standing objective, flattened to one line and capped. A goal that is a page is a plan, and the plan belongs in `todo`. */
export const GOAL_MAX_CHARS = 2000;

/**
 * Everything `context_notes` and `goal` may touch, and deliberately nothing
 * more.
 *
 * What is ABSENT is the load-bearing part: there is no path, no writer and no
 * store handle on it, so no tool in this module can put a note anywhere that
 * survives the process (D2). `retain` is how something durable is proposed,
 * and it queues for a human. `think` is not handed even this.
 */
export interface SessionScratch {
  /** Key to text. Insertion-ordered, which is the order `list` prints. */
  notes: Map<string, string>;
  /** The session's standing objective, or undefined when nobody has set one. */
  goal?: string;
  /** When it was set, so a stale goal is visible as stale. */
  goalSetAt?: string;
  /** Notes written, notes read, goals set, goals read. The "did anyone ever use this?" counters rule 5 asks for. */
  writes: number;
  reads: number;
  goalSets: number;
  goalReads: number;
}

export function newSessionScratch(): SessionScratch {
  return { notes: new Map(), writes: 0, reads: 0, goalSets: 0, goalReads: 0 };
}

export interface ContextToolsOpts {
  scratch: SessionScratch;
  /** Injectable clock, so a test can assert a timestamp. */
  now?: () => Date;
}

function text(s: string) {
  return [{ type: "text" as const, text: s }];
}

/**
 * One result shape for every branch, for `memory-tools.ts`'s reason: under
 * `exactOptionalPropertyTypes` TypeScript will not unify differently shaped
 * `details` objects on its own, and naming the shape once is cheaper than a
 * cast per branch — and it keeps `isError` from being forgotten on a refusal.
 */
interface ContextToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: Record<string, unknown>;
}

function out(body: string, details: Record<string, unknown>): ContextToolResult {
  return { content: text(body), details };
}

function refuse(body: string, details: Record<string, unknown>): ContextToolResult {
  return { content: text(body), isError: true, details };
}

/** UTF-8, not characters: the cap is a byte cap and a multi-byte note that measured under it in characters would blow past it on the wire. */
export function storeBytes(notes: ReadonlyMap<string, string>): number {
  let total = 0;
  for (const [key, value] of notes) total += Buffer.byteLength(key, "utf8") + Buffer.byteLength(value, "utf8");
  return total;
}

// ------------------------------------------------------------ context_notes

/**
 * The sentence D2 is about. Exported, and asserted verbatim by the test, so a
 * later edit that means well cannot soften it into "saved".
 */
export const SCRATCHPAD_NOTICE =
  "These notes live in this session and die with it: they are not memory, not the transcript and not a file. " +
  "Nothing here survives the session ending, and nothing here is ever injected into a prompt. If a fact should " +
  "outlive this session, propose it with retain — a human accepts that, and only then does Lykos know it.";

export const CONTEXT_NOTES_DESCRIPTION =
  "A scratchpad this session owns: what you want to remember for the next twenty minutes without spending the " +
  "context window on it. Call with no arguments to list every note; with `note` alone to read one; with `note` " +
  "and `text` to write or replace one; with `note` and `drop: true` to remove one. Notes survive turns and die " +
  "with the session — they are not memory, not a file and never injected into a prompt, so use retain for " +
  `anything that should outlive this session. At most ${CONTEXT_NOTES_MAX_KEYS} notes and ` +
  `${CONTEXT_NOTES_MAX_BYTES} bytes in total; a write that would pass either is refused rather than silently ` +
  "truncated. A key is lower-case letters, digits, `-` and `_`.";

export const CONTEXT_NOTES_PARAMETERS = Type.Object({
  note: Type.Optional(
    Type.String({ description: "The note's key, e.g. `api-shape`. Omit to list every note." }),
  ),
  text: Type.Optional(
    Type.String({ description: "The note's whole contents, replacing whatever was there. Omit to read." }),
  ),
  drop: Type.Optional(Type.Boolean({ description: "Remove this note instead of reading or writing it." })),
});

function renderStore(scratch: SessionScratch): string {
  if (scratch.notes.size === 0) return "No notes in this session yet.";
  const lines: string[] = [
    `${scratch.notes.size} note${scratch.notes.size === 1 ? "" : "s"}, ` +
      `${storeBytes(scratch.notes)} of ${CONTEXT_NOTES_MAX_BYTES} bytes used:`,
  ];
  for (const [key, value] of scratch.notes) lines.push(`\n[${key}]\n${value}`);
  return lines.join("\n");
}

export function buildContextNotesTool(opts: ContextToolsOpts): ToolDefinition {
  return defineTool({
    name: CONTEXT_NOTES_TOOL_NAME,
    label: "Context notes",
    description: CONTEXT_NOTES_DESCRIPTION,
    promptSnippet: "Keep notes that survive a turn but are not the transcript",
    parameters: CONTEXT_NOTES_PARAMETERS,
    async execute(_id, params): Promise<ContextToolResult> {
      const scratch = opts.scratch;
      const key = params.note?.trim();

      if (key === undefined || key === "") {
        scratch.reads += 1;
        return out(`${renderStore(scratch)}\n\n${SCRATCHPAD_NOTICE}`, {
          op: "list",
          notes: [...scratch.notes.keys()],
          bytes: storeBytes(scratch.notes),
        });
      }
      if (!CONTEXT_NOTE_KEY_PATTERN.test(key)) {
        return refuse(
          `lykos context_notes: ${JSON.stringify(key)} is not a usable key. A key is lower-case letters, digits, ` +
            "`-` and `_`, starts with a letter or digit, and is at most 64 characters.",
          { op: "reject", reason: "bad_key", note: key },
        );
      }

      if (params.drop === true) {
        const existed = scratch.notes.delete(key);
        if (!existed) {
          return refuse(
            `lykos context_notes: there is no note ${JSON.stringify(key)} to drop. ` +
              (scratch.notes.size === 0
                ? "This session has written none."
                : `What exists: ${[...scratch.notes.keys()].join(", ")}.`),
            { op: "drop", note: key, dropped: false },
          );
        }
        scratch.writes += 1;
        return out(`Dropped ${JSON.stringify(key)}. ${scratch.notes.size} note(s) left.`, {
          op: "drop",
          note: key,
          dropped: true,
          remaining: scratch.notes.size,
        });
      }

      if (params.text === undefined) {
        const value = scratch.notes.get(key);
        if (value === undefined) {
          return refuse(
            `lykos context_notes: no note ${JSON.stringify(key)}. ` +
              (scratch.notes.size === 0
                ? "This session has written none. Pass `text` to write this one."
                : `What exists: ${[...scratch.notes.keys()].join(", ")}.`),
            { op: "read", note: key, found: false },
          );
        }
        scratch.reads += 1;
        return out(`[${key}]\n${value}`, { op: "read", note: key, found: true });
      }

      // A write is validated against the caps BEFORE anything changes, so a
      // refused write leaves the store exactly as it was rather than dropping
      // the old note and failing to store the new one.
      const value = params.text;
      const isNew = !scratch.notes.has(key);
      if (isNew && scratch.notes.size >= CONTEXT_NOTES_MAX_KEYS) {
        return refuse(
          `lykos context_notes: this session already holds ${CONTEXT_NOTES_MAX_KEYS} notes, which is the cap. ` +
            "Drop one you no longer need, or fold several into one note.",
          { op: "write", note: key, written: false, reason: "key_cap" },
        );
      }
      const projected =
        storeBytes(scratch.notes) -
        (isNew ? 0 : Buffer.byteLength(key, "utf8") + Buffer.byteLength(scratch.notes.get(key)!, "utf8")) +
        Buffer.byteLength(key, "utf8") +
        Buffer.byteLength(value, "utf8");
      if (projected > CONTEXT_NOTES_MAX_BYTES) {
        return refuse(
          `lykos context_notes: that write would take the store to ${projected} bytes and the cap is ` +
            `${CONTEXT_NOTES_MAX_BYTES}. Nothing was written and nothing was truncated. Shorten the note, or ` +
            "drop one you no longer need.",
          { op: "write", note: key, written: false, reason: "byte_cap", projected },
        );
      }

      scratch.notes.set(key, value);
      scratch.writes += 1;
      return out(
        `${isNew ? "Wrote" : "Replaced"} ${JSON.stringify(key)} (${Buffer.byteLength(value, "utf8")} bytes). ` +
          `${scratch.notes.size} note(s), ${storeBytes(scratch.notes)} of ${CONTEXT_NOTES_MAX_BYTES} bytes used.` +
          `\n\n${SCRATCHPAD_NOTICE}`,
        { op: "write", note: key, written: true, replaced: !isNew, bytes: storeBytes(scratch.notes) },
      );
    },
  }) as ToolDefinition;
}

// --------------------------------------------------------------------- goal

export const GOAL_DESCRIPTION =
  "The session's standing objective — the one sentence that says what all of this is for. Call with no " +
  "arguments to read it back, or with `goal` to set it. Setting it replaces whatever was there; there is one " +
  "objective, not a stack. It is session state, so it dies with the session, and it is never injected into a " +
  "prompt: reading it is a call. Use it when a long session has drifted and you need to check what you were " +
  "actually asked for. The steps to get there are todo's job, not this one.";

export const GOAL_PARAMETERS = Type.Object({
  goal: Type.Optional(
    Type.String({ description: "The objective, in one sentence. Omit to read the current one." }),
  ),
});

export function buildGoalTool(opts: ContextToolsOpts): ToolDefinition {
  return defineTool({
    name: GOAL_TOOL_NAME,
    label: "Goal",
    description: GOAL_DESCRIPTION,
    promptSnippet: "Set or read the session's standing objective",
    parameters: GOAL_PARAMETERS,
    async execute(_id, params): Promise<ContextToolResult> {
      const scratch = opts.scratch;
      const raw = params.goal;

      if (raw === undefined || raw.trim() === "") {
        scratch.goalReads += 1;
        if (scratch.goal === undefined) {
          return out(
            "No objective has been set for this session. Set one with `goal`, or work from what you were asked " +
              "for directly — an unset objective is not a problem, it is the default.",
            { op: "read", set: false },
          );
        }
        return out(`${scratch.goal}\n\n(Set at ${scratch.goalSetAt}.)`, {
          op: "read",
          set: true,
          goal: scratch.goal,
          setAt: scratch.goalSetAt,
        });
      }

      // One line, for `retain`'s reason: a model handed a free-text field will
      // eventually send a paragraph, and an objective that is a paragraph is
      // a plan nobody can check against.
      const flat = raw.replace(/\s+/g, " ").trim();
      if (flat.length > GOAL_MAX_CHARS) {
        return refuse(
          `lykos goal: that objective is ${flat.length} characters and the cap is ${GOAL_MAX_CHARS}. Nothing was ` +
            "set. An objective is one sentence; the steps belong in todo.",
          { op: "set", set: false, reason: "too_long", length: flat.length },
        );
      }
      const previous = scratch.goal;
      scratch.goal = flat;
      scratch.goalSetAt = (opts.now?.() ?? new Date()).toISOString();
      scratch.goalSets += 1;
      return out(
        (previous === undefined
          ? `Objective set: ${flat}`
          : `Objective replaced.\nWas: ${previous}\nNow: ${flat}`) +
          "\n\nThis lives in the session and dies with it; it is not memory and no prompt is assembled from it.",
        { op: "set", set: true, goal: flat, ...(previous !== undefined ? { previous } : {}) },
      );
    },
  }) as ToolDefinition;
}

// -------------------------------------------------------------------- think

/**
 * What a `think` call returns. Exported and asserted verbatim, because the
 * whole contract of this tool is that the answer is always this and nothing
 * else ever happens.
 */
export const THINK_ACKNOWLEDGEMENT =
  "Noted. Nothing was changed, stored or run — this tool exists so a deliberation turn is a call you can make " +
  "rather than something you have to smuggle into another tool's arguments. Carry on.";

export const THINK_DESCRIPTION =
  "Think out loud for one turn without doing anything. It has no effect of any kind: nothing is stored, nothing " +
  "is run, no file is touched and no state moves — the call and your reasoning are in the transcript and that is " +
  "all. Use it to work through a decision before acting on it, or to set out the options when the next step is " +
  "not obvious. Do not use it to report progress; that is what your message to the human is for.";

export const THINK_PARAMETERS = Type.Object({
  thought: Type.String({ description: "The reasoning itself. Written for you, not as a status update." }),
});

/**
 * D6: no options, so there is nothing this definition could mutate even if a
 * later edit tried. The absence of a parameter here is the enforcement.
 */
export function buildThinkTool(): ToolDefinition {
  return defineTool({
    name: THINK_TOOL_NAME,
    label: "Think",
    description: THINK_DESCRIPTION,
    promptSnippet: "Deliberate for one turn without doing anything",
    parameters: THINK_PARAMETERS,
    async execute(): Promise<ContextToolResult> {
      return { content: text(THINK_ACKNOWLEDGEMENT), details: { changed: false } };
    },
  }) as ToolDefinition;
}

/** All three, over one piece of session state (and, for `think`, none at all). The order is `CONTEXT_TOOL_NAMES`. */
export function buildContextTools(opts: ContextToolsOpts): ToolDefinition[] {
  return [buildContextNotesTool(opts), buildGoalTool(opts), buildThinkTool()];
}
