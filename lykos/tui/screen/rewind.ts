// T263 (was T122's checkpoint picker): the full-screen rewind picker. Esc Esc
// on an empty input and `/rewind` open it over the session's earlier prompts;
// Enter on one offers what to restore. It owns no git and no session logic:
// it resolves with the choice and `session/rewind.ts` carries it out, so
// rewind stays a human action and never reaches the agent's tool surface.
// T265: summarize from here takes an optional note, typed on a third stage.

import { KeyDecoder, type FeedOptions, type KeyEvent } from "./input.js";
import { style, withBackground, type ResolvedTheme } from "../theme/resolve.js";
import { visibleWidth } from "./frame.js";
import {
  REWIND_RESTORES,
  rewindPointLabel,
  SUMMARIZE_NOTE_PROMPT,
  type RewindChoice,
  type RewindPoint,
} from "../../session/rewind.js";

export interface RewindState {
  points: readonly RewindPoint[];
  /** The highlighted prompt. */
  cursor: number;
  /** Choosing a prompt, then what to restore from before it; for a summarize, then its note. */
  stage: "prompt" | "restore" | "note";
  /** The highlighted restore, into `REWIND_RESTORES`. */
  restoreCursor: number;
  /** T265: the summarize note typed so far. */
  note: string;
}

export interface RewindOverlayOptions {
  onRender(state: RewindState, height: number): void;
  onClose(): void;
}

export class RewindOverlay {
  private readonly decoder = new KeyDecoder();
  private readonly opts: RewindOverlayOptions;
  private state: RewindState | null = null;
  private resolve: ((choice: RewindChoice | undefined) => void) | null = null;
  private height = 24;

  constructor(opts: RewindOverlayOptions) {
    this.opts = opts;
  }

  get isOpen(): boolean {
    return this.state !== null;
  }

  /** Opens on the latest prompt. Resolves with the choice, or undefined when cancelled. */
  open(height: number, points: readonly RewindPoint[]): Promise<RewindChoice | undefined> {
    this.finish(undefined);
    this.height = Math.max(6, height);
    this.state = { points, cursor: Math.max(0, points.length - 1), stage: "prompt", restoreCursor: 0, note: "" };
    const chosen = new Promise<RewindChoice | undefined>((resolve) => {
      this.resolve = resolve;
    });
    this.render();
    return chosen;
  }

  /** Cancels, if open. */
  close(): void {
    this.finish(undefined);
  }

  setHeight(height: number): void {
    this.height = Math.max(6, height);
    if (this.state) this.render();
  }

  feedBytes(chunk: string, opts?: FeedOptions): void {
    for (const event of this.decoder.feed(chunk, opts)) this.handleKey(event);
  }

  flushPending(): void {
    for (const event of this.decoder.flush()) this.handleKey(event);
  }

  private finish(choice: RewindChoice | undefined): void {
    if (!this.state) return;
    this.state = null;
    this.decoder.flush();
    const resolve = this.resolve;
    this.resolve = null;
    this.opts.onClose();
    resolve?.(choice);
  }

  private handleKey(event: KeyEvent): void {
    const state = this.state;
    if (!state) return;
    if (state.stage === "note") {
      this.handleNoteKey(state, event);
      return;
    }
    if (event.type === "escape") {
      if (state.stage === "restore") {
        this.state = { ...state, stage: "prompt" };
        this.render();
      } else this.finish(undefined);
      return;
    }
    if (event.type === "arrow" && (event.dir === "up" || event.dir === "down")) {
      const delta = event.dir === "up" ? -1 : 1;
      this.state =
        state.stage === "prompt"
          ? { ...state, cursor: clamp(state.cursor + delta, state.points.length) }
          : { ...state, restoreCursor: clamp(state.restoreCursor + delta, REWIND_RESTORES.length) };
      this.render();
      return;
    }
    if ((event.type === "pageUp" || event.type === "pageDown") && state.stage === "prompt") {
      const step = Math.max(1, this.height - 5);
      this.state = { ...state, cursor: clamp(state.cursor + (event.type === "pageUp" ? -step : step), state.points.length) };
      this.render();
      return;
    }
    if (event.type === "char" && state.stage === "restore" && /^[1-9]$/.test(event.value)) {
      const index = Number(event.value) - 1;
      if (REWIND_RESTORES[index] !== undefined) this.choose({ ...state, restoreCursor: index });
      return;
    }
    if (event.type === "enter" && !event.alt && !event.ctrl && !event.shift) {
      if (state.points.length === 0) return;
      if (state.stage === "prompt") {
        this.state = { ...state, stage: "restore", restoreCursor: 0 };
        this.render();
      } else {
        this.choose(state);
      }
    }
  }

  /** The highlighted restore: done, or for a summarize, on to its note. */
  private choose(state: RewindState): void {
    const restore = REWIND_RESTORES[state.restoreCursor]!.restore;
    if (restore === "summarize") {
      this.state = { ...state, stage: "note", note: "" };
      this.render();
    } else this.finish({ index: state.cursor, restore });
  }

  /** T265: the note is one line of text; Enter sends it (empty is no note), Esc goes back to the restores. */
  private handleNoteKey(state: RewindState, event: KeyEvent): void {
    if (event.type === "escape") {
      this.state = { ...state, stage: "restore", note: "" };
      this.render();
    } else if (event.type === "enter" && !event.alt && !event.ctrl && !event.shift) {
      const note = state.note.trim();
      this.finish({ index: state.cursor, restore: "summarize", ...(note !== "" ? { note } : {}) });
    } else if (event.type === "backspace") {
      this.state = { ...state, note: [...state.note].slice(0, -1).join("") };
      this.render();
    } else if (event.type === "char" || event.type === "paste") {
      const text = event.type === "char" ? event.value : event.text;
      this.state = { ...state, note: state.note + text.replace(/[\r\n]+/g, " ") };
      this.render();
    }
  }

  private render(): void {
    if (this.state) this.opts.onRender(this.state, this.height);
  }
}

function clamp(value: number, length: number): number {
  return Math.max(0, Math.min(Math.max(0, length - 1), value));
}

export function renderRewind(state: RewindState, opts: { width: number; height: number; theme: ResolvedTheme }): string[] {
  const highlight = (line: string) => withBackground(line, "completionBg", opts.theme, visibleWidth(line), opts.width);
  const lines = [style("rewind — go back to before an earlier prompt", "accent", opts.theme)];
  if (state.stage === "prompt") {
    lines.push(style("↑/↓ choose · Enter choose what to restore · Esc cancel", "dim", opts.theme));
    for (const [index, point] of state.points.entries()) {
      const line = `${index === state.cursor ? "› " : "  "}${index + 1}  ${rewindPointLabel(point, Math.max(20, opts.width - 24))}`;
      lines.push(index === state.cursor ? highlight(line) : line);
    }
  } else if (state.stage === "note") {
    const point = state.points[state.cursor];
    lines.push(style("type a note, or none · Enter summarize · Esc back", "dim", opts.theme));
    if (point !== undefined) lines.push(`from: ${rewindPointLabel(point, Math.max(20, opts.width - 30))}`);
    lines.push(`${SUMMARIZE_NOTE_PROMPT}: ${state.note}█`);
    lines.push("");
    lines.push(
      style(
        "That prompt and every turn after it become one summary the model is sent instead; the turns stay in the transcript, and the files are not touched.",
        "dim",
        opts.theme,
      ),
    );
  } else {
    const point = state.points[state.cursor];
    lines.push(style(`↑/↓ or 1-${REWIND_RESTORES.length} choose · Enter restore · Esc back`, "dim", opts.theme));
    if (point !== undefined) lines.push(`before: ${rewindPointLabel(point, Math.max(20, opts.width - 30))}`);
    for (const [index, r] of REWIND_RESTORES.entries()) {
      const line = `${index === state.restoreCursor ? "› " : "  "}${index + 1}  ${r.label}`;
      lines.push(index === state.restoreCursor ? highlight(line) : line);
    }
    lines.push("");
    lines.push(
      style(
        "Nothing is deleted: the current tree is checkpointed first, files the checkpoint lacks stay, and undone turns stay in the transcript.",
        "dim",
        opts.theme,
      ),
    );
  }
  while (lines.length < opts.height) lines.push("");
  return lines.slice(0, opts.height);
}
