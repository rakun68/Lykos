// T122: a human-only checkpoint picker. It deliberately owns no git logic;
// the caller supplies the list and the restore action, keeping rewind out of
// the agent tool surface.

import { KeyDecoder, type FeedOptions, type KeyEvent } from "./input.js";
import { style, withBackground, type ResolvedTheme } from "../theme/resolve.js";
import { visibleWidth } from "./frame.js";
import type { CheckpointEntry } from "../../loop/checkpoint.js";

export interface RewindState {
  entries: CheckpointEntry[];
  cursor: number;
  confirming: boolean;
}

export interface RewindOverlayOptions {
  load(): CheckpointEntry[];
  onRender(state: RewindState, height: number): void;
  onClose(): void;
  onRestore(index: number): void;
}

export class RewindOverlay {
  private readonly decoder = new KeyDecoder();
  private readonly opts: RewindOverlayOptions;
  private state: RewindState | null = null;
  private height = 24;

  constructor(opts: RewindOverlayOptions) {
    this.opts = opts;
  }

  get isOpen(): boolean {
    return this.state !== null;
  }

  open(height: number): void {
    if (this.state) return;
    this.height = Math.max(6, height);
    this.state = { entries: this.opts.load(), cursor: 0, confirming: false };
    this.render();
  }

  close(): void {
    if (!this.state) return;
    this.state = null;
    this.decoder.flush();
    this.opts.onClose();
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

  private handleKey(event: KeyEvent): void {
    const state = this.state;
    if (!state) return;
    if (event.type === "escape") {
      if (state.confirming) {
        this.state = { ...state, confirming: false };
        this.render();
      } else this.close();
      return;
    }
    if (event.type === "arrow" && (event.dir === "up" || event.dir === "down")) {
      const delta = event.dir === "up" ? -1 : 1;
      this.state = {
        ...state,
        cursor: Math.max(0, Math.min(Math.max(0, state.entries.length - 1), state.cursor + delta)),
      };
      this.render();
      return;
    }
    if (event.type === "pageUp" || event.type === "pageDown") {
      const delta = event.type === "pageUp" ? -Math.max(1, this.height - 5) : Math.max(1, this.height - 5);
      this.state = {
        ...state,
        cursor: Math.max(0, Math.min(Math.max(0, state.entries.length - 1), state.cursor + delta)),
      };
      this.render();
      return;
    }
    if (event.type === "char" && state.confirming && /^[yn]$/i.test(event.value)) {
      if (event.value.toLowerCase() === "y" && state.entries[state.cursor]) {
        const index = state.cursor;
        this.close();
        this.opts.onRestore(index);
      } else {
        this.state = { ...state, confirming: false };
        this.render();
      }
      return;
    }
    if (event.type === "enter" && !event.alt && !event.ctrl && !event.shift) {
      if (state.entries.length === 0) return;
      this.state = { ...state, confirming: true };
      this.render();
    }
  }

  private render(): void {
    if (this.state) this.opts.onRender(this.state, this.height);
  }
}

export function renderRewind(state: RewindState, opts: { width: number; height: number; theme: ResolvedTheme }): string[] {
  const lines = [
    style("rewind — human checkpoint picker", "accent", opts.theme),
    style("↑/↓ choose · Enter review · y restore · n/Esc cancel · Esc back", "dim", opts.theme),
  ];
  if (state.entries.length === 0) lines.push(style("no checkpoints yet — they are taken at the start of each turn", "dim", opts.theme));
  for (const [index, entry] of state.entries.entries()) {
    const marker = index === state.cursor ? "› " : "  ";
    const label = `${index}  ${entry.at}  ${entry.label}`;
    const line = `${marker}${label}`;
    lines.push(index === state.cursor ? withBackground(line, "completionBg", opts.theme, visibleWidth(line), opts.width) : line);
  }
  if (state.confirming) {
    lines.push("");
    lines.push(style(`restore checkpoint ${state.cursor}? This first checkpoints your current work and leaves extra files untouched. [y/N]`, "warn", opts.theme));
  }
  while (lines.length < opts.height) lines.push("");
  return lines.slice(0, opts.height);
}
