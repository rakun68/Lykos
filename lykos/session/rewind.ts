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
// SUMMARIZE FROM HERE (T265) is the conversation rewind with Pi's branch
// summarizer: `navigateTree(target, { summarize, customInstructions })` writes
// the turns from the prompt onward as one summary at the prompt's parent, so
// the next request carries the turns before it verbatim, then the summary. The
// person's note is the summarizer's `customInstructions`. Lykos's own
// compaction (`session.compact`, under `lykos-self-compact`) is not the carrier:
// it cuts from the end of the context by `keep_recent_tokens`, keeping the
// newest turns, and takes no chosen prompt to cut at. The summarizer's call
// reaches the ledger as a `compaction` call (`onSummarizerCall`), so it is a
// `calls` row of phase `compact`; the files are not touched.
//
// PAST A RESUME (T264): a resumed session's earlier turns arrived as one
// replayed message, so Pi's tree has no entry to move to. Its earlier prompts
// come from the transcript's active branch instead (`earlierPrompts`), and the
// picker lists them before this process's own. Choosing one writes the rewind
// event, restores the code as above, and asks for a rebuild: the loop ends the
// session as `/exit` does and `lykos resume` reopens it, same id, ordinary
// frozen head, the active branch — which the event has cut at that prompt —
// replayed after it, and the prompt in the input box. Summarize from here does
// not reach past a resume: Pi's summarizer reads Pi's tree, which does not
// hold those turns.
//
// UNDO AND REDO (P5 #42, OpenCode `session.undo` and `session.redo`): undo is a
// rewind of code and conversation to before the last prompt, its event marked
// `undo`; each undo goes one prompt further back. Redo takes back every undo
// since the last prompt at once, as OpenCode clears its whole revert: the tree
// from the first undo's safety checkpoint, the conversation by moving Pi's leaf
// back to where it was (the undone entries are still in Pi's tree). A prompt
// sent after an undo ends the chain, and redo then refuses, as OpenCode's does.
// Past a rebuild the chain is the transcript's (`pendingUndos`): the redo event
// is written and the session rebuilt, since the active branch honours it.

import { createCheckpoint, restoreCheckpointByHash, shortHash } from "../loop/checkpoint.js";
import type { TranscriptRecord } from "./replay.js";
import type { RedoEvent, RewindEvent } from "./transcript.js";

/** What is put back: both, the conversation alone, or the files alone; or the conversation from the prompt on, summarized. */
export type RewindRestore = "both" | "conversation" | "code" | "summarize";

/** What a rewind picker chose. `index` is 0-based into the points it was shown. */
export interface RewindChoice {
  index: number;
  restore: RewindRestore;
  /** T265: with `summarize`, the person's note to the summarizer; absent when none was typed. */
  note?: string;
}

/** The restores a picker offers, in the order it numbers them. */
export const REWIND_RESTORES: ReadonlyArray<{ restore: RewindRestore; label: string }> = [
  { restore: "both", label: "code and conversation" },
  { restore: "conversation", label: "conversation only" },
  { restore: "code", label: "code only" },
  { restore: "summarize", label: "summarize from here" },
];

/** T265: what a picker asks once summarize is chosen; an empty answer is no note. */
export const SUMMARIZE_NOTE_PROMPT = "add context for the summary (optional)";

/** The slice of Pi's `Usage` (pi-ai, a dependency of Pi's, not of Lykos's) a summarizer call reports. */
export interface SummarizerUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  reasoning?: number;
  cost?: { total?: number };
}

/** T265: one summarizer call, as the ledger takes it. */
export interface SummarizerCall {
  usage: SummarizerUsage;
  /** From the request to the summary, the tree move included. */
  latencyMs: number;
}

/** The slice of Pi's session entries a rewind reads. */
interface BranchEntry {
  id: string;
  type: string;
  message?: { role?: string };
}

/** The slice of Pi's `AgentSession` a rewind needs; the real class satisfies it. */
export interface RewindableSession {
  readonly sessionManager?: { getLeafId(): string | null; getBranch(): BranchEntry[]; getEntry?(id: string): BranchEntry | undefined };
  navigateTree?(
    targetId: string,
    options?: { summarize?: boolean; customInstructions?: string },
  ): Promise<{ cancelled: boolean; editorText?: string; summaryEntry?: { summary: string; usage?: SummarizerUsage } }>;
}

/** Where the rewind is written down. */
export interface RewindRecorder {
  rewind?(event: Omit<RewindEvent, "kind">): void;
  redo?(event: Omit<RedoEvent, "kind">): void;
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
  /** T264: the conversation went back past this process's own prompts; the session is rebuilt from its transcript. */
  rebuild?: true;
  /** The checkpoint holding the tree just before the code was restored; absent when it was not. */
  safety?: string;
}

/** P5 #42: the undos since the last prompt, as a transcript has them; what a redo past a rebuild takes back. */
export interface PendingUndos {
  count: number;
  /** The first code-moving undo's safety checkpoint: the tree before the chain. Absent when none moved the code. */
  safety?: string;
}

/** What one live undo replaced: put back by a redo. */
interface UndoRecord {
  leaf: string | null;
  prompts: PromptRecord[];
  lastTurn: number | undefined;
  lastCheckpoint: string | undefined;
  safety: string | undefined;
}

/** T264: a prompt from before this process, as the transcript's active branch has it. */
export interface EarlierPrompt {
  text: string;
  /** The session-wide turn it started. */
  turn: number;
  /** The checkpoint its first turn started from, as the transcript recorded it; absent before T264. */
  checkpoint?: string;
}

interface PromptRecord extends RewindPoint {
  /** Pi's leaf just before the prompt was sent; null at the root. */
  leafBefore: string | null | undefined;
  /** The checkpoint holding the tree the prompt's first turn started from. */
  checkpoint: string | undefined;
}

export class LiveRewind {
  private readonly prompts: PromptRecord[] = [];
  private earlier: EarlierPrompt[] = [];
  private lastTurn: number | undefined;
  private lastCheckpoint: string | undefined;
  /** T264: the last turn before this process; undefined when there was none. */
  private turnBefore: number | undefined;
  private readonly summarizerListeners = new Set<(call: SummarizerCall) => void>();
  /** P5 #42: this process's undos since the last prompt, oldest first. */
  private undos: UndoRecord[] = [];
  /** P5 #42: the undos a rebuilt or resumed session's transcript ends with. */
  private undosBefore: PendingUndos | undefined;

  /** `cwd` is the repository the session checkpoints; undefined when it takes none, and code cannot be restored. */
  constructor(private readonly cwd: string | undefined) {}

  /** The harness, at every turn start. The first turn after a prompt is that prompt's. */
  turnStarted(turn: number, checkpoint: string | undefined): void {
    this.lastTurn = turn;
    this.lastCheckpoint = checkpoint;
    const latest = this.prompts[this.prompts.length - 1];
    if (latest !== undefined && latest.turn === undefined) {
      latest.turn = turn;
      latest.checkpoint = checkpoint;
    }
  }

  /** T264: the checkpoint turn `turn` started from, while it is the latest; the transcript writes it on its `turn_start`. */
  checkpointOf(turn: number): string | undefined {
    return turn === this.lastTurn ? this.lastCheckpoint : undefined;
  }

  /** T264: a resumed session's prompts from before this process, and the turn it starts at. */
  continues(plan: { earlierPrompts?: readonly EarlierPrompt[]; firstTurn?: number; undos?: PendingUndos }): void {
    this.earlier = [...(plan.earlierPrompts ?? [])];
    this.undosBefore = plan.undos;
    this.turnBefore = plan.firstTurn !== undefined && plan.firstTurn > 0 ? plan.firstTurn - 1 : undefined;
  }

  /** The loop, just before it sends a prompt the person typed. */
  promptSent(session: RewindableSession, text: string): void {
    this.undos = [];
    this.undosBefore = undefined;
    this.prompts.push({ text, turn: undefined, leafBefore: session.sessionManager?.getLeafId(), checkpoint: undefined });
  }

  /** T265: told of each summarizer call a summarize makes. Returns the unsubscribe. */
  onSummarizerCall(listener: (call: SummarizerCall) => void): () => void {
    this.summarizerListeners.add(listener);
    return () => this.summarizerListeners.delete(listener);
  }

  /** The prompts still on the conversation, oldest first: T264's from before this process, then its own. */
  points(): readonly RewindPoint[] {
    return [...this.earlier, ...this.prompts].map(({ text, turn }) => ({ text, turn }));
  }

  /**
   * Rewinds to before prompt `index` (0-based, as `points()` lists them). Nothing is deleted.
   * `note` is a summarize's instructions to the summarizer.
   */
  async rewind(
    session: RewindableSession,
    index: number,
    restore: RewindRestore,
    recorder?: RewindRecorder,
    note?: string,
    undo = false,
  ): Promise<RewindReport> {
    // Any other rewind ends an undo chain: a redo would put back what it did not take.
    if (!undo) {
      this.undos = [];
      this.undosBefore = undefined;
    }
    if (index < this.earlier.length) return this.rewindEarlier(index, restore, recorder, undo);
    const live = index - this.earlier.length;
    const prompt = this.prompts[live];
    if (prompt === undefined) return { ok: false, lines: [`lykos: no prompt ${index + 1} to rewind to`] };
    const code = restore === "both" || restore === "code";
    const conversation = restore !== "code";
    const summarize = restore === "summarize";
    const lines: string[] = [];

    // Everything that can refuse is checked before anything moves.
    let target: string | undefined;
    if (conversation) {
      target = userEntryAfter(session, prompt.leafBefore);
      if (target === undefined || session.navigateTree === undefined) {
        return { ok: false, lines: ["lykos: this session cannot rewind its conversation; nothing was changed"] };
      }
    }
    const refused = code ? this.codeRefusal(prompt.checkpoint) : undefined;
    if (refused !== undefined) return refused;

    let safety: string | undefined;
    if (code) {
      const restored = this.restoreCode(prompt.checkpoint!, index, lines);
      if (typeof restored !== "string") return restored;
      safety = restored;
    }

    const range =
      prompt.turn !== undefined && this.lastTurn !== undefined && this.lastTurn >= prompt.turn
        ? ([prompt.turn, this.lastTurn] as [number, number])
        : undefined;
    const turns = range === undefined ? "its turns" : range[0] === range[1] ? `turn ${range[0]}` : `turns ${range[0]}-${range[1]}`;
    let inputText: string | undefined;
    let summary: string | undefined;
    if (conversation) {
      const started = Date.now();
      let moved: Awaited<ReturnType<NonNullable<RewindableSession["navigateTree"]>>>;
      try {
        // A summarize goes to the entry before the prompt, not the prompt's own: Pi summarizes what lies
        // after the target, so only then is the prompt itself in the summary. The leaf lands in the same
        // place either way. A prompt at the root has no entry before it, and its own text is left out.
        moved = summarize
          ? await session.navigateTree!(prompt.leafBefore ?? target!, {
              summarize: true,
              ...(note !== undefined ? { customInstructions: note } : {}),
            })
          : await session.navigateTree!(target!);
      } catch (err) {
        // Pi moves the leaf only once it has the summary, so a failed summarizer changed nothing.
        if (!summarize) throw err;
        lines.push(`lykos: summarize failed — ${err instanceof Error ? err.message : String(err)}; the conversation is unchanged`);
        return { ok: false, lines };
      }
      if (moved.cancelled) {
        lines.push(`lykos: the ${summarize ? "summarize" : "conversation rewind"} was cancelled; the conversation is unchanged`);
        return { ok: false, lines };
      }
      if (summarize) {
        const usage = moved.summaryEntry?.usage;
        if (usage !== undefined) {
          const call = { usage, latencyMs: Date.now() - started };
          for (const listener of this.summarizerListeners) listener(call);
        }
        summary = moved.summaryEntry?.summary;
        lines.push(
          summary !== undefined
            ? `summarized the conversation from prompt ${index + 1}: ${turns} are one summary in context and stay in the transcript; the files are as they were`
            : `rewound the conversation to before prompt ${index + 1} with no summary (nothing to summarize); ${turns} stay in the transcript`,
        );
      } else {
        lines.push(`rewound the conversation to before prompt ${index + 1}; ${turns} stay in the transcript as an undone branch`);
      }
      this.prompts.length = live;
      inputText = prompt.text;
    }

    recorder?.rewind?.({
      restore,
      prompt: prompt.text,
      ...(prompt.turn !== undefined ? { to_turn: prompt.turn } : {}),
      ...(conversation && !summarize && range !== undefined ? { undone_turns: range } : {}),
      ...(summarize && range !== undefined ? { summarized_turns: range } : {}),
      ...(summarize && note !== undefined ? { note } : {}),
      ...(summary !== undefined ? { summary } : {}),
      ...(code ? { checkpoint: prompt.checkpoint! } : {}),
      ...(safety !== undefined ? { safety_checkpoint: safety } : {}),
      ...(undo ? { undo: true as const } : {}),
    });
    return { ok: true, lines, ...(inputText !== undefined ? { inputText } : {}), ...(safety !== undefined ? { safety } : {}) };
  }

  /** P5 #42: OpenCode `session.undo`: the code and the conversation back to before the last prompt. */
  async undo(session: RewindableSession, recorder?: RewindRecorder): Promise<RewindReport> {
    const points = this.points();
    if (points.length === 0) return { ok: false, lines: ["lykos: nothing to undo"] };
    const index = points.length - 1;
    const prompt = index < this.earlier.length ? this.earlier[index]! : this.prompts[index - this.earlier.length]!;
    // As OpenCode reverts the conversation where it has no snapshot of the files.
    const code = this.cwd !== undefined && prompt.checkpoint !== undefined;
    const before: Omit<UndoRecord, "safety"> = {
      leaf: session.sessionManager?.getLeafId() ?? null,
      prompts: [...this.prompts],
      lastTurn: this.lastTurn,
      lastCheckpoint: this.lastCheckpoint,
    };
    const report = await this.rewind(session, index, code ? "both" : "conversation", recorder, undefined, true);
    if (report.ok && report.rebuild !== true) this.undos.push({ ...before, safety: report.safety });
    return report;
  }

  /**
   * P5 #42: OpenCode `session.redo`: every undo since the last prompt taken back, the files and the conversation
   * where they were before the first. Refused once a prompt has been sent since.
   */
  async redo(session: RewindableSession, recorder?: RewindRecorder): Promise<RewindReport> {
    if (this.undosBefore !== undefined) return this.redoEarlier(this.undosBefore, recorder);
    const first = this.undos[0];
    if (first === undefined) return { ok: false, lines: ["lykos: nothing to redo — no undo since the last prompt"] };
    const entry = first.leaf === null ? undefined : session.sessionManager?.getEntry?.(first.leaf);
    if (
      session.navigateTree === undefined ||
      entry === undefined ||
      (entry.type === "message" && entry.message?.role === "user") ||
      entry.type === "custom_message"
    ) {
      return { ok: false, lines: ["lykos: this session cannot redo its conversation; nothing was changed"] };
    }
    const code = this.undos.find((u) => u.safety !== undefined)?.safety;
    const lines: string[] = [];
    let safety: string | undefined;
    if (code !== undefined) {
      const restored = this.restoreTree(code, "before redo", lines);
      if (typeof restored !== "string") return restored;
      safety = restored;
    }
    await session.navigateTree(first.leaf!);
    const back = first.prompts.slice(this.prompts.length);
    const from = back[0]?.turn;
    const range =
      from !== undefined && first.lastTurn !== undefined && first.lastTurn >= from ? ([from, first.lastTurn] as [number, number]) : undefined;
    const count = this.undos.length;
    this.prompts.length = 0;
    this.prompts.push(...first.prompts);
    this.lastTurn = first.lastTurn;
    this.lastCheckpoint = first.lastCheckpoint;
    this.undos = [];
    lines.push(
      `redid ${count === 1 ? "the undo" : `${count} undos`}: the conversation${code !== undefined ? " and the files are back where they were" : " is back where it was"}`,
    );
    recorder?.redo?.({
      undos: count,
      ...(code !== undefined ? { checkpoint: code } : {}),
      ...(safety !== undefined ? { safety_checkpoint: safety } : {}),
      ...(range !== undefined ? { redone_turns: range } : {}),
    });
    return { ok: true, lines, ...(safety !== undefined ? { safety } : {}) };
  }

  /** P5 #42: a redo of undos from before this process: the event is written and the session rebuilt from it. */
  private redoEarlier(chain: PendingUndos, recorder: RewindRecorder | undefined): RewindReport {
    const lines: string[] = [];
    let safety: string | undefined;
    if (chain.safety !== undefined) {
      if (this.cwd === undefined) {
        return { ok: false, lines: ["lykos: this session takes no checkpoints, so its code cannot be redone; nothing was changed"] };
      }
      const restored = this.restoreTree(chain.safety, "before redo", lines);
      if (typeof restored !== "string") return restored;
      safety = restored;
    }
    this.undosBefore = undefined;
    lines.push(`redid ${chain.count === 1 ? "the undo" : `${chain.count} undos`}; rebuilding the session from its transcript, as \`lykos resume\` does`);
    recorder?.redo?.({
      undos: chain.count,
      ...(chain.safety !== undefined ? { checkpoint: chain.safety } : {}),
      ...(safety !== undefined ? { safety_checkpoint: safety } : {}),
    });
    return { ok: true, lines, rebuild: true, inputText: "", ...(safety !== undefined ? { safety } : {}) };
  }

  /** Restores the whole tree from `checkpoint` after a safety checkpoint labelled `label`, whose hash it returns. */
  private restoreTree(checkpoint: string, label: string, lines: string[]): string | RewindReport {
    const before = createCheckpoint({ cwd: this.cwd! }, label);
    if (before.status === "skipped") return { ok: false, lines: [`lykos: redo failed — ${before.reason}; nothing was changed`] };
    const restored = restoreCheckpointByHash({ cwd: this.cwd! }, checkpoint);
    if (restored.status === "error") return { ok: false, lines: [`lykos: redo failed — ${restored.message}; nothing was changed`] };
    lines.push(`restored the code from checkpoint ${shortHash(restored.commit)}`);
    lines.push(`  the tree you had is checkpoint ${shortHash(before.commit)} — \`lykos rewind ${shortHash(before.commit)}\` puts it back`);
    if (restored.extras.length > 0) {
      lines.push(`  ${restored.extras.length} file(s) the checkpoint did not have were left in place: ${restored.extras.join(", ")}`);
    }
    return before.commit;
  }

  /**
   * T264: rewinds to before a prompt from before this process. The code is restored here, as for this
   * process's own; the conversation is the transcript's, so the event that cuts it is written and the
   * session asks to be rebuilt from it.
   */
  private rewindEarlier(index: number, restore: RewindRestore, recorder: RewindRecorder | undefined, undo = false): RewindReport {
    const prompt = this.earlier[index]!;
    if (restore === "summarize") {
      return {
        ok: false,
        lines: [
          "lykos: summarize from here reaches only the prompts sent since this session was resumed; " +
            "rewind the conversation to that prompt instead; nothing was changed",
        ],
      };
    }
    const code = restore !== "conversation";
    const conversation = restore !== "code";
    const refused = code ? this.codeRefusal(prompt.checkpoint) : undefined;
    if (refused !== undefined) return refused;
    const lines: string[] = [];
    let safety: string | undefined;
    if (code) {
      const restored = this.restoreCode(prompt.checkpoint!, index, lines);
      if (typeof restored !== "string") return restored;
      safety = restored;
    }
    const last = this.lastTurn ?? this.turnBefore;
    const range = last !== undefined && last >= prompt.turn ? ([prompt.turn, last] as [number, number]) : undefined;
    if (conversation) {
      const turns = range === undefined ? "its turns" : range[0] === range[1] ? `turn ${range[0]}` : `turns ${range[0]}-${range[1]}`;
      lines.push(
        `rewound the conversation to before prompt ${index + 1}, from before this session was resumed; ${turns} stay in the transcript as an undone branch`,
      );
      lines.push("  rebuilding the session from its transcript there, as `lykos resume` does");
    }
    recorder?.rewind?.({
      restore,
      prompt: prompt.text,
      to_turn: prompt.turn,
      ...(conversation && range !== undefined ? { undone_turns: range } : {}),
      ...(code ? { checkpoint: prompt.checkpoint! } : {}),
      ...(safety !== undefined ? { safety_checkpoint: safety } : {}),
      ...(undo ? { undo: true as const } : {}),
    });
    return {
      ok: true,
      lines,
      ...(conversation ? { inputText: prompt.text, rebuild: true as const } : {}),
      ...(safety !== undefined ? { safety } : {}),
    };
  }

  /** Why the code cannot be rewound to `checkpoint`; undefined when it can. */
  private codeRefusal(checkpoint: string | undefined): RewindReport | undefined {
    if (this.cwd !== undefined && checkpoint !== undefined) return undefined;
    return {
      ok: false,
      lines: [
        this.cwd === undefined
          ? "lykos: this session takes no checkpoints (not a git repository), so its code cannot be rewound; nothing was changed"
          : "lykos: no checkpoint holds the tree from before that prompt; nothing was changed",
      ],
    };
  }

  /** Restores the tree from `checkpoint` after a safety checkpoint, whose hash it returns; a refusal when either fails. */
  private restoreCode(checkpoint: string, index: number, lines: string[]): string | RewindReport {
    // The safety checkpoint is taken here rather than left to the restore, which
    // writes none when the tree is already checkpointed: either way the person is
    // told which checkpoint holds the tree they had.
    const before = createCheckpoint({ cwd: this.cwd! }, `before rewind to ${shortHash(checkpoint)}`);
    if (before.status === "skipped") return { ok: false, lines: [`lykos: rewind failed — ${before.reason}; nothing was changed`] };
    const restored = restoreCheckpointByHash({ cwd: this.cwd! }, checkpoint);
    if (restored.status === "error") return { ok: false, lines: [`lykos: rewind failed — ${restored.message}; nothing was changed`] };
    lines.push(`rewound the code to checkpoint ${shortHash(restored.commit)}, from before prompt ${index + 1}`);
    lines.push(`  the tree you had is checkpoint ${shortHash(before.commit)} — \`lykos rewind ${shortHash(before.commit)}\` puts it back`);
    if (restored.extras.length > 0) {
      lines.push(`  ${restored.extras.length} file(s) the checkpoint did not have were left in place: ${restored.extras.join(", ")}`);
    }
    return before.commit;
  }
}

/**
 * T264: the prompts on an active branch (`activeBranch`) that started a turn, with the turn and the checkpoint
 * it started from. A transcript from before T264 numbers each process's turns from 0, and nothing is
 * renumbered: where a number repeats, only its latest turn is one a rewind can name, so the earlier ones are
 * left out.
 */
export function earlierPrompts(branch: readonly TranscriptRecord[]): EarlierPrompt[] {
  const latest = new Map<number, number>();
  branch.forEach((r, i) => {
    if (r.kind === "turn_start") latest.set(r.turn, i);
  });
  const out: EarlierPrompt[] = [];
  let pending: string | undefined;
  branch.forEach((r, i) => {
    if (r.kind === "user_message") pending = r.typed ?? r.text;
    else if (r.kind === "turn_start" && pending !== undefined) {
      if (latest.get(r.turn) === i) out.push({ text: pending, turn: r.turn, ...(r.checkpoint !== undefined ? { checkpoint: r.checkpoint } : {}) });
      pending = undefined;
    }
  });
  return out;
}

/**
 * The index in `points` of the prompt typed as `text`, `nth` such prompts back from the last (0 is the last): how a
 * client that shows the conversation names a prompt it was clicked on. Undefined when there is no such prompt.
 */
export function promptIndex(points: readonly RewindPoint[], text: string, nth: number): number | undefined {
  const want = text.trim();
  const hits = points.flatMap((p, i) => (p.text.trim() === want ? [i] : []));
  return hits[hits.length - 1 - nth];
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
