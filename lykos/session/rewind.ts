// T263: rewind a live interactive session — code, conversation, or both — to
// before one of its earlier prompts (spec #25, decisions 1, 2, 4, 5).
//
// The person does this, never the agent: the loop calls it from `/rewind` and
// Esc Esc, and there is no tool for it, for the reason `cli/rewind.ts` gives.
//
// CONVERSATION is Pi's own tree: `navigateTree` to the prompt's user message
// moves the leaf to its parent and leaves every entry where it was. What
// follows is an undone branch: still in Pi's tree for this process, still in
// the transcript, its calls still in the ledger. There is no redo.
//
// CODE is the whole tree from the turn checkpoint the prompt's first turn
// started from — shell edits included, because a checkpoint is the tree, not a
// list of tool edits. The harness says which checkpoint that is at every turn
// start (`onTurnStart`): the one it wrote, or the ref's tip when nothing had
// changed. The restore is `lykos rewind`'s own, so the current tree is
// checkpointed first and a file the checkpoint did not have is reported, not
// deleted.
//
// Only prompts of this process are reachable; earlier ones (a resume's replay)
// are T264.

import { createCheckpoint, restoreCheckpointByHash, shortHash } from "../loop/checkpoint.js";
import type { RewindEvent } from "./transcript.js";

/** What is put back: both, the conversation alone, or the files alone. */
export type RewindRestore = "both" | "conversation" | "code";

/** What a rewind picker chose. `index` is 0-based into the points it was shown. */
export interface RewindChoice {
  index: number;
  restore: RewindRestore;
}

/** The restores a picker offers, in the order it numbers them. */
export const REWIND_RESTORES: ReadonlyArray<{ restore: RewindRestore; label: string }> = [
  { restore: "both", label: "code and conversation" },
  { restore: "conversation", label: "conversation only" },
  { restore: "code", label: "code only" },
];

/** The slice of Pi's session entries a rewind reads. */
interface BranchEntry {
  id: string;
  type: string;
  message?: { role?: string };
}

/** The slice of Pi's `AgentSession` a rewind needs; the real class satisfies it. */
export interface RewindableSession {
  readonly sessionManager?: { getLeafId(): string | null; getBranch(): BranchEntry[] };
  navigateTree?(targetId: string): Promise<{ cancelled: boolean; editorText?: string }>;
}

/** Where the rewind is written down. */
export interface RewindRecorder {
  rewind?(event: Omit<RewindEvent, "kind">): void;
}

/** One earlier prompt the picker offers. */
export interface RewindPoint {
  /** The prompt as the person typed it — what goes back in the input box. */
  text: string;
  /** The session-wide turn it started; undefined if no turn started. */
  turn: number | undefined;
}

export interface RewindReport {
  ok: boolean;
  /** What to tell the person, one line each. */
  lines: string[];
  /** The prompt to put back in the input box: set when the conversation was rewound. */
  inputText?: string;
}

interface PromptRecord extends RewindPoint {
  /** Pi's leaf just before the prompt was sent; null at the root. */
  leafBefore: string | null | undefined;
  /** The checkpoint holding the tree the prompt's first turn started from. */
  checkpoint: string | undefined;
}

export class LiveRewind {
  private readonly prompts: PromptRecord[] = [];
  private lastTurn: number | undefined;

  /** `cwd` is the repository the session checkpoints; undefined when it takes none, and code cannot be restored. */
  constructor(private readonly cwd: string | undefined) {}

  /** The harness, at every turn start. The first turn after a prompt is that prompt's. */
  turnStarted(turn: number, checkpoint: string | undefined): void {
    this.lastTurn = turn;
    const latest = this.prompts[this.prompts.length - 1];
    if (latest !== undefined && latest.turn === undefined) {
      latest.turn = turn;
      latest.checkpoint = checkpoint;
    }
  }

  /** The loop, just before it sends a prompt the person typed. */
  promptSent(session: RewindableSession, text: string): void {
    this.prompts.push({ text, turn: undefined, leafBefore: session.sessionManager?.getLeafId(), checkpoint: undefined });
  }

  /** The prompts still on the conversation, oldest first. */
  points(): readonly RewindPoint[] {
    return this.prompts.map(({ text, turn }) => ({ text, turn }));
  }

  /** Rewinds to before prompt `index` (0-based, as `points()` lists them). Nothing is deleted. */
  async rewind(session: RewindableSession, index: number, restore: RewindRestore, recorder?: RewindRecorder): Promise<RewindReport> {
    const prompt = this.prompts[index];
    if (prompt === undefined) return { ok: false, lines: [`lykos: no prompt ${index + 1} to rewind to`] };
    const code = restore !== "conversation";
    const conversation = restore !== "code";
    const lines: string[] = [];

    // Everything that can refuse is checked before anything moves.
    let target: string | undefined;
    if (conversation) {
      target = userEntryAfter(session, prompt.leafBefore);
      if (target === undefined || session.navigateTree === undefined) {
        return { ok: false, lines: ["lykos: this session cannot rewind its conversation; nothing was changed"] };
      }
    }
    if (code && (this.cwd === undefined || prompt.checkpoint === undefined)) {
      return {
        ok: false,
        lines: [
          this.cwd === undefined
            ? "lykos: this session takes no checkpoints (not a git repository), so its code cannot be rewound; nothing was changed"
            : "lykos: no checkpoint holds the tree from before that prompt; nothing was changed",
        ],
      };
    }

    let safety: string | undefined;
    if (code) {
      // The safety checkpoint is taken here rather than left to the restore, which
      // writes none when the tree is already checkpointed: either way the person is
      // told which checkpoint holds the tree they had.
      const before = createCheckpoint({ cwd: this.cwd! }, `before rewind to ${shortHash(prompt.checkpoint!)}`);
      if (before.status === "skipped") return { ok: false, lines: [`lykos: rewind failed — ${before.reason}; nothing was changed`] };
      safety = before.commit;
      const restored = restoreCheckpointByHash({ cwd: this.cwd! }, prompt.checkpoint!);
      if (restored.status === "error") return { ok: false, lines: [`lykos: rewind failed — ${restored.message}; nothing was changed`] };
      lines.push(`rewound the code to checkpoint ${shortHash(restored.commit)}, from before prompt ${index + 1}`);
      lines.push(`  the tree you had is checkpoint ${shortHash(safety)} — \`lykos rewind ${shortHash(safety)}\` puts it back`);
      if (restored.extras.length > 0) {
        lines.push(`  ${restored.extras.length} file(s) the checkpoint did not have were left in place: ${restored.extras.join(", ")}`);
      }
    }

    let inputText: string | undefined;
    if (conversation) {
      const moved = await session.navigateTree!(target!);
      if (moved.cancelled) {
        lines.push("lykos: the conversation rewind was cancelled; the conversation is unchanged");
        return { ok: false, lines };
      }
      const undone =
        prompt.turn !== undefined && this.lastTurn !== undefined && this.lastTurn >= prompt.turn
          ? prompt.turn === this.lastTurn
            ? `turn ${prompt.turn}`
            : `turns ${prompt.turn}-${this.lastTurn}`
          : "its turns";
      lines.push(`rewound the conversation to before prompt ${index + 1}; ${undone} stay in the transcript as an undone branch`);
      this.prompts.length = index;
      inputText = prompt.text;
    }

    recorder?.rewind?.({
      restore,
      prompt: prompt.text,
      ...(prompt.turn !== undefined ? { to_turn: prompt.turn } : {}),
      ...(conversation && this.lastTurn !== undefined && prompt.turn !== undefined && this.lastTurn >= prompt.turn
        ? { undone_turns: [prompt.turn, this.lastTurn] as [number, number] }
        : {}),
      ...(code ? { checkpoint: prompt.checkpoint! } : {}),
      ...(safety !== undefined ? { safety_checkpoint: safety } : {}),
    });
    return { ok: true, lines, ...(inputText !== undefined ? { inputText } : {}) };
  }
}

/** How a picker shows one prompt: its first line, clipped, and the turn it started. */
export function rewindPointLabel(point: RewindPoint, width = 72): string {
  const first = point.text.split("\n")[0] ?? "";
  const more = first.length > width || point.text.includes("\n");
  const text = `${first.slice(0, width)}${more ? "…" : ""}`;
  return point.turn !== undefined ? `${text}  (turn ${point.turn})` : text;
}

/** The first user message on the current branch after `leafBefore`: the prompt's own entry. */
function userEntryAfter(session: RewindableSession, leafBefore: string | null | undefined): string | undefined {
  const manager = session.sessionManager;
  if (manager === undefined || leafBefore === undefined) return undefined;
  const branch = manager.getBranch();
  const start = leafBefore === null ? 0 : branch.findIndex((e) => e.id === leafBefore) + 1;
  if (start === 0 && leafBefore !== null) return undefined;
  return branch.slice(start).find((e) => e.type === "message" && e.message?.role === "user")?.id;
}
