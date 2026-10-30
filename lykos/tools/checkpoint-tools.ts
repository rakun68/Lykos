// The two tools that name a point worth returning to, and nothing else.
//
// **T104'S RULE IS UNCHANGED, AND IT IS THE WHOLE DESIGN (D1).**
// `loop/checkpoint.ts` says it in one sentence: "an agent that can rewind its
// own work is an agent that can erase the evidence of what it did, and this
// project's first rule about its own archive is that nothing it runs is ever
// deleted." What this ticket adds is NAMING, not acting. The model may say
// "this point is worth coming back to" and "I think we should come back to it";
// a human moves the tree, with `lykos rewind <n>` or the TUI's rewind picker,
// which are the only two callers `restoreCheckpoint` has ever had.
//
// **THE RULE IS STRUCTURAL, ON `memory-tools.ts`'s TERMS.** `CheckpointView`
// below is everything these two definitions are handed, and it has exactly one
// member: `list`. `createCheckpoint` and `restoreCheckpoint` both exist in
// `loop/checkpoint.ts`, are both exported, and are both absent from this
// module — not imported, not re-exported, not reachable. "No tool can move the
// working tree" is therefore a fact about what these definitions are handed
// rather than a rule somebody has to remember, and `checkpoint-tools.test.ts`
// asserts it by trying it against a real git repository with real changes in
// it and then checking the bytes on disk.
//
// **THE PROPOSAL SHAPE IS NOT `exit_plan`'s, AND THAT IS DELIBERATE.** D1 says
// `rewind` asks "exactly as `exit_plan` does", and `exit_plan` asks through a
// callback the interactive session supplies. The callback shape was rejected
// here, under D1's own instruction to change the shape rather than the rule,
// for two reasons. First, the only thing a human could answer "yes" to is a
// restore, and wiring an approval callback whose approval is then honoured by
// somebody else is a promise this tool cannot keep — a `true` coming back
// would have to be ignored, which is worse than not asking. Second, a callback
// that no production caller supplies is decorative, and CLAUDE.md is explicit
// that a guard with nothing to guard is exactly that. So the proposal is
// RECORDED in session state and the model is handed the command a human runs.
// The human decides by running it or not, which is the same decision, made in
// the place that can actually carry it out.
//
// **These tools do not prune conversation context.** A `rewind` that branched
// the session tree and replaced the live message array with a summary is ruled
// out by AGENTS.md rule 9 — the head is frozen for the session, and
// a tool that rewrites the message array behind a frozen prefix invalidates the
// prompt cache for the whole conversation. Lykos's checkpoints are the git ones
// T104 built; naming one is what these tools add. The context-pruning half is not built, is not pretended to
// exist, and the result text never claims a rewind happened.
//
// **THE SCHEMA TAX, RECORDED AT THE MOMENT THE TOOLS ARE ADDED (AGENTS.md rule
// 3): these two ride NO request.** Both mounted with `hidden` prompt presence
// (D9), reached through `tool_call`. The measured numbers are asserted in
// `checkpoint-tools.test.ts`.

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
// READ-ONLY, and the import list is load-bearing: `createCheckpoint` and
// `restoreCheckpoint` are exported from the same module and are deliberately
// not named here. A test asserts this file's source mentions neither.
import { listCheckpoints, shortHash, type CheckpointEntry } from "../loop/checkpoint.js";

export const CHECKPOINT_TOOL_NAME = "checkpoint";
export const REWIND_TOOL_NAME = "rewind";

/** The pair, in the order the plan builds them. Exported so the registration site cannot drift from this module. */
export const CHECKPOINT_TOOL_NAMES = [CHECKPOINT_TOOL_NAME, REWIND_TOOL_NAME] as const;

/** How many marks one session keeps. A session that has named forty points has named none. */
export const CHECKPOINT_MARK_CAP = 50;

/** One label, flattened and capped: it is printed in a list a human skims. */
export const CHECKPOINT_LABEL_MAX_CHARS = 120;

/**
 * Everything these two definitions may do to the checkpoint machinery, and
 * deliberately nothing more.
 *
 * There is ONE member and it reads. What is ABSENT is the load-bearing part:
 * no `create`, so no tool can write a checkpoint (T104); no `restore`, so no
 * tool can move the working tree (D1). Both exist in `loop/checkpoint.ts` and
 * both are reachable from `cli/rewind.ts` and `tui/interactive-surface.ts`,
 * where a human is the one typing.
 */
export interface CheckpointView {
  /** The points a human could return to, newest first. Empty when the workspace is not a git repository. */
  list: (cwd: string) => CheckpointEntry[];
}

/** The real view. A test passes its own, pointed at a temporary repository. */
export const LOCAL_CHECKPOINT_VIEW: CheckpointView = {
  list: (cwd) => listCheckpoints({ cwd }),
};

/** A point the model said was worth returning to. */
export interface CheckpointMark {
  label: string;
  why?: string;
  /** ISO 8601, when the model named it. */
  at: string;
  /** The checkpoint that was newest when the mark was made, so the label refers to a real point rather than a feeling. */
  commit?: string;
}

/** A return the model asked a human for. Recorded, never carried out. */
export interface RewindProposal {
  /** What the model found, and why it thinks going back is right. */
  report: string;
  /** The checkpoint it proposes returning to, as it stood when the proposal was made. */
  commit?: string;
  index?: number;
  label?: string;
  at: string;
}

export interface CheckpointProposalState {
  marks: CheckpointMark[];
  returns: RewindProposal[];
  /** Marks refused because the cap was reached. Counted so "the model stopped marking" and "the cap ate them" are different answers. */
  markRefusals: number;
}

export function newCheckpointProposalState(): CheckpointProposalState {
  return { marks: [], returns: [], markRefusals: 0 };
}

export interface CheckpointToolsOpts {
  cwd: string;
  state: CheckpointProposalState;
  /** Omitted, the real read-only view. Injected by every test. */
  view?: CheckpointView;
  /** Injectable clock, so a test can assert a timestamp. */
  now?: () => Date;
}

function text(s: string) {
  return [{ type: "text" as const, text: s }];
}

interface CheckpointToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: Record<string, unknown>;
}

function flatten(raw: string, cap: number): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

/**
 * The sentence D1 is about. Exported, and asserted verbatim by the test, so a
 * later edit that means well cannot soften it into "restored".
 *
 * It is in the RESULT and not only in the description for `hub`'s reason: the
 * description is read once at the top of a session, and this is read at the
 * moment the model is deciding what to tell the human it just did.
 */
export const NOTHING_MOVED_NOTICE =
  "NOTHING WAS MOVED. No file changed, no checkpoint was written and the working tree is exactly as you left it. " +
  "These tools can only name a point and ask; only a human can return the tree to one. Do not tell anyone the " +
  "work was reverted — say you proposed it, and say what you would do instead if they decline.";

/**
 * How a human carries out a proposal. One line, and it is the same command `lykos rewind` documents.
 * T165: by hash, because the index shifts with every checkpoint written after the proposal.
 */
export function rewindCommandFor(entry: CheckpointEntry): string {
  return `lykos rewind ${shortHash(entry.commit)}`;
}

/** One checkpoint as these tools print it. Deliberately the same columns `renderCheckpointList` uses, minus the padding a tool result does not need. */
function describeEntry(entry: CheckpointEntry): string {
  return `${entry.index}  ${entry.commit.slice(0, 8)}  ${entry.at}  ${entry.label}`;
}

function noCheckpointsNotice(): string {
  return (
    "This workspace has no checkpoints to name. They are written at the start of each turn of a Lykos session in " +
    "a git repository, so a workspace that is not a repository — or a session that has not taken a turn yet — has " +
    "none. Nothing was changed."
  );
}

// --------------------------------------------------------------- checkpoint

export const CHECKPOINT_DESCRIPTION =
  "Name the point you are at as one worth coming back to, before you start something that might not work. This " +
  "WRITES NOTHING: Lykos already takes a checkpoint of the working tree at the start of every turn, and this " +
  "attaches your label to the most recent one so a human reading the list later knows which point you meant and " +
  "why. It does not create a checkpoint, does not touch any file, and does not move the working tree — no tool " +
  "can, and this one least of all. Pair it with rewind, which proposes coming back to a point you named; a human " +
  "decides whether the tree actually moves.";

export const CHECKPOINT_PARAMETERS = Type.Object({
  label: Type.String({
    description: "A short name for this point, e.g. `before the registry rewrite`. This is what a human reads in the list.",
  }),
  why: Type.Optional(
    Type.String({ description: "Why this point is worth returning to — what you are about to try, and what could go wrong." }),
  ),
});

export function buildCheckpointTool(opts: CheckpointToolsOpts): ToolDefinition {
  const view = opts.view ?? LOCAL_CHECKPOINT_VIEW;
  return defineTool({
    name: CHECKPOINT_TOOL_NAME,
    label: "Checkpoint",
    description: CHECKPOINT_DESCRIPTION,
    promptSnippet: "Name a point worth coming back to (writes nothing)",
    promptGuidelines: [
      "Naming a point is not saving one. Never say work was checkpointed because this returned successfully.",
    ],
    parameters: CHECKPOINT_PARAMETERS,
    async execute(_id, params): Promise<CheckpointToolResult> {
      const state = opts.state;
      const label = flatten(params.label ?? "", CHECKPOINT_LABEL_MAX_CHARS);
      if (label === "") {
        return {
          content: text("lykos checkpoint: `label` is empty. An unnamed point is exactly the thing this tool exists to avoid."),
          isError: true,
          details: { marked: false, reason: "empty_label" },
        };
      }
      if (state.marks.length >= CHECKPOINT_MARK_CAP) {
        state.markRefusals += 1;
        return {
          content: text(
            `lykos checkpoint: this session has already named ${CHECKPOINT_MARK_CAP} points, which is the cap. ` +
              "Nothing was changed. A session with fifty named points has named none; propose a return to one of " +
              "them with rewind, or carry on.",
          ),
          isError: true,
          details: { marked: false, reason: "cap", cap: CHECKPOINT_MARK_CAP },
        };
      }

      const entries = view.list(opts.cwd);
      const newest = entries[0];
      const why = params.why === undefined ? undefined : flatten(params.why, 400);
      const mark: CheckpointMark = {
        label,
        at: (opts.now?.() ?? new Date()).toISOString(),
        ...(why !== undefined && why !== "" ? { why } : {}),
        ...(newest !== undefined ? { commit: newest.commit } : {}),
      };
      state.marks.push(mark);

      const body =
        newest === undefined
          ? `Marked "${label}".\n\n${noCheckpointsNotice()}\n\n${NOTHING_MOVED_NOTICE}`
          : `Marked "${label}" against checkpoint ${newest.commit.slice(0, 8)} — ${newest.label} (${newest.at}).\n` +
            `A human can return the tree there with \`${rewindCommandFor(newest)}\`; propose it with rewind.` +
            `\n\n${NOTHING_MOVED_NOTICE}`;
      return {
        content: text(body),
        details: {
          marked: true,
          label,
          marks: state.marks.length,
          moved: false,
          ...(newest !== undefined ? { commit: newest.commit, index: newest.index } : { checkpoints: 0 }),
        },
      };
    },
  }) as ToolDefinition;
}

// ------------------------------------------------------------------- rewind

export const REWIND_DESCRIPTION =
  "Propose returning the working tree to an earlier point, and say what you found that makes that the right " +
  "move. This MOVES NOTHING and cannot: it records the proposal and hands back the one command a human runs to " +
  "carry it out. Say the proposal out loud in your next message — a human who never sees it never acts on it. " +
  "`to` is a label you gave checkpoint, or a checkpoint number from the list; omit it for the point you named " +
  "most recently. If the human declines, carry on from where you are; nothing has changed either way.";

export const REWIND_PARAMETERS = Type.Object({
  report: Type.String({
    description: "What you found and why going back beats going on. This is what the human decides on.",
  }),
  to: Type.Optional(
    Type.String({ description: "A label you gave checkpoint, or a checkpoint number. Omit for the point you named most recently." }),
  ),
});

/**
 * Resolves what the model asked to return to, against the checkpoints that
 * exist right now.
 *
 * A mark is resolved by its COMMIT and not by the index it had when it was
 * made, because every later turn takes another checkpoint and pushes every
 * index down by one. Resolving by index would silently send a human to a
 * different point than the model meant — the failure mode this whole file is
 * about, arriving by arithmetic instead.
 */
export function resolveRewindTarget(
  state: CheckpointProposalState,
  entries: readonly CheckpointEntry[],
  raw: string | undefined,
): { entry?: CheckpointEntry; mark?: CheckpointMark; error?: string } {
  const asked = raw?.trim();

  if (asked !== undefined && asked !== "" && /^\d+$/.test(asked)) {
    const index = Number(asked);
    const entry = entries[index];
    if (entry === undefined) {
      return {
        error:
          entries.length === 0
            ? noCheckpointsNotice()
            : `lykos rewind: there is no checkpoint ${index}; this workspace has ${entries.length} (0 is the most recent). Nothing was changed.`,
      };
    }
    return { entry };
  }

  const mark =
    asked !== undefined && asked !== ""
      ? [...state.marks].reverse().find((m) => m.label.toLowerCase() === asked.toLowerCase())
      : state.marks[state.marks.length - 1];

  if (asked !== undefined && asked !== "" && mark === undefined) {
    return {
      error:
        `lykos rewind: no point named ${JSON.stringify(asked)} in this session. ` +
        (state.marks.length === 0
          ? "This session has named none — name one with checkpoint, or pass a checkpoint number."
          : `What you named: ${state.marks.map((m) => JSON.stringify(m.label)).join(", ")}.`) +
        " Nothing was changed.",
    };
  }

  if (mark === undefined) {
    // No mark and none asked for: the most recent checkpoint is the honest
    // default, because it is the point the last turn began at.
    const entry = entries[0];
    if (entry === undefined) return { error: noCheckpointsNotice() };
    return { entry };
  }

  const entry = mark.commit === undefined ? undefined : entries.find((e) => e.commit === mark.commit);
  if (entry === undefined) {
    return {
      mark,
      error:
        `lykos rewind: "${mark.label}" was named against a checkpoint this workspace no longer lists, so there is ` +
        "nothing to propose returning to. Nothing was changed. Pass a checkpoint number from the list instead.",
    };
  }
  return { entry, mark };
}

export function buildRewindTool(opts: CheckpointToolsOpts): ToolDefinition {
  const view = opts.view ?? LOCAL_CHECKPOINT_VIEW;
  return defineTool({
    name: REWIND_TOOL_NAME,
    label: "Rewind",
    description: REWIND_DESCRIPTION,
    promptSnippet: "Propose returning the tree to an earlier point (moves nothing)",
    promptGuidelines: [
      "Proposing a return is not performing one. Never say work was reverted because this returned successfully.",
    ],
    parameters: REWIND_PARAMETERS,
    async execute(_id, params): Promise<CheckpointToolResult> {
      const state = opts.state;
      const report = (params.report ?? "").trim();
      if (report === "") {
        return {
          content: text(
            "lykos rewind: `report` is empty. The report is the whole of what a human decides on — a proposal with " +
              "no reasoning is a proposal nobody can weigh. Nothing was changed.",
          ),
          isError: true,
          details: { proposed: false, moved: false, reason: "empty_report" },
        };
      }

      const entries = view.list(opts.cwd);
      const target = resolveRewindTarget(state, entries, params.to);
      if (target.error !== undefined) {
        return {
          content: text(`${target.error}\n\n${NOTHING_MOVED_NOTICE}`),
          isError: true,
          details: { proposed: false, moved: false, checkpoints: entries.length },
        };
      }
      const entry = target.entry!;

      const proposal: RewindProposal = {
        report,
        commit: entry.commit,
        index: entry.index,
        at: (opts.now?.() ?? new Date()).toISOString(),
        ...(target.mark !== undefined ? { label: target.mark.label } : {}),
      };
      state.returns.push(proposal);

      const named = target.mark === undefined ? "" : ` — the point you named "${target.mark.label}"`;
      const body = [
        `Proposed returning the working tree to checkpoint ${entry.index}${named}:`,
        `  ${describeEntry(entry)}`,
        "",
        `Your report: ${report}`,
        "",
        `A human carries this out with \`${rewindCommandFor(entry)}\`, which checkpoints the current state ` +
          "first so the return is itself undoable. Tell them the proposal and the reason in your next message; " +
          "they may say no, and if they do, continue from where you are.",
        "",
        NOTHING_MOVED_NOTICE,
      ].join("\n");

      return {
        content: text(body),
        details: {
          proposed: true,
          moved: false,
          awaitingHuman: true,
          command: rewindCommandFor(entry),
          index: entry.index,
          commit: entry.commit,
          ...(target.mark !== undefined ? { label: target.mark.label } : {}),
          proposals: state.returns.length,
        },
      };
    },
  }) as ToolDefinition;
}

/** Both, over one read-only view and one piece of session state. The order is `CHECKPOINT_TOOL_NAMES`. */
export function buildCheckpointTools(opts: CheckpointToolsOpts): ToolDefinition[] {
  return [buildCheckpointTool(opts), buildRewindTool(opts)];
}
