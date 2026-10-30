// S0 — the terminal agent UI (docs/07-ui-and-hud.md family A, T37).
// Pure renderer: ConversationView → string. Never computes, never writes
// to the ledger (docs/07 §1.1, T37 acceptance). The HUD line is
// renderTriadLine() over the same ViewModel S1/S2 already draw.
//
// No framework. Layout primitives live in format.ts / theme/resolve.ts.
// This file is the renderer core T37.3 budgets at ~400 lines.

import { truncate } from "../format.js";
import type { ResolvedTheme } from "../theme/resolve.js";
import { style } from "../theme/resolve.js";
import { GLYPHS } from "../theme/types.js";
import type { OutcomeView, ViewModel } from "../types.js";
import { renderTriadLine } from "./line.js";

export interface DiffLine {
  kind: "add" | "del" | "ctx" | "hunk";
  text: string;
}

export interface DiffView {
  path: string;
  lines: DiffLine[];
}

export interface ToolBlock {
  name: string;
  summary: string;
  state: "running" | "ok" | "error";
  diff?: DiffView;
  resultPreview?: string;
}

export interface ApprovalView {
  kind: string;
  summary: string;
  detail: string;
  /** The full request body (a command, a patch) when there is one distinct from `detail` — 2026-09-02 round three, item 12: the thing being approved has to be readable in the prompt itself. */
  body?: string;
  /** Set once the gate has answered, so the block stays in scrollback as a record instead of a question nobody can still answer. */
  decision?: "allow" | "allow-always" | "allow-folder" | "deny";
  /**
   * How many MORE approval requests are waiting behind this one — 2026-09-02
   * round five, item 8: "It should be single approval message showing at a
   * time with a small text below telling how many approval message more are
   * there." Absent (never 0) when nothing is queued, so a renderer's
   * `if (view.queued)` check needs no separate zero-check.
   */
  queued?: number;
  /** T211: set when the approval is for a protected write (only session allow is offered). */
  protected?: boolean;
  /** T212: set when the approval is for a bash path ask (offers allow once and deny only). */
  bashPathAsk?: boolean;
}

export interface HeaderView {
  model: string;
  sessionId: string;
  cwd: string;
  /** Ticket 04: the active specialist, when one is selected. Absent means no specialist — every existing caller of this header keeps its exact output. */
  specialist?: string;
}

export type ConversationBlock =
  | { kind: "header"; header: HeaderView }
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; tool: ToolBlock }
  | { kind: "approval"; approval: ApprovalView }
  | { kind: "system"; text: string }
  | { kind: "hud" }
  | { kind: "outcome"; outcome: OutcomeView };

export interface ConversationView {
  blocks: ConversationBlock[];
  hud: ViewModel | null;
  toolsCollapsed: boolean;
  thinkingCollapsed: boolean;
}

export interface ConversationRenderOptions {
  width: number;
  theme: ResolvedTheme;
}

export const S0_HELP = [
  "commands",
  "  /help /hotkeys     this list",
  "  /session           id, model, turns, tokens",
  "  /copy              copy the last answer to the clipboard",
  "  /compact [hint]    compact context now",
  "  /followup <text>   queue a follow-up (delivered when idle)",
  "  /verbose           expand folded blocks, and show each tool's raw result",
  "  /thinking          show/hide reasoning blocks",
  "  /effort [level]    reasoning effort: off minimal low medium high xhigh max",
  "  /usage             tokens, cache and spend for this session (free)",
  "  /context           what is occupying the context window (free)",
  "  /mode [name]       interaction mode: manual accept-edits auto (free)",
  "  /permissions [cmd] view or adjust permissions: mode, outside rules, extra dirs, approvals",
  "  /resume            continue an earlier session — it becomes this session again (free)",
  "  /rename [name]     name this session; with no name, report the one it has (free)",
  "  /close-session     close this session and move it to Closed (free)",
  "  /exit /quit        end the session",
  "  /model [name]      switch model for this session (next call may pay a cold prefix)",
  "  /specialist [name]    list specialists, or switch to one (records a prefix break)",
  "  /output-style [name]  list output styles, or switch to one (in stream)",
  "  /login <provider> [--api-key]   add a credential to the provider's pool (free)",
  "  /credential [label|auto]   list the pool, pin one credential to this session, or unpin (free)",
  "  /new               refused — would rewrite the cache prefix; start a new session",
  "  /<skill>           run a discovered skill, e.g. /handoff (/skill:<name> if a command shadows it)",
  "  !cmd               run locally, send output to the model",
  "  !!cmd              run locally, keep output out of context",
  "  line ending in \\   continue on the next line",
  "keys",
  "  Enter              send (or steer, if a turn is running)",
  "  Ctrl-C             copy the selection; with none, abort the turn, then the session",
  // Everything below needs raw mode, so it is the full-screen surface only
  // — the append-only renderer runs under readline and has no key decoder
  // of its own. Listed anyway, and labelled, rather than kept in two
  // divergent help texts.
  "keys (full-screen only)",
  "  Shift-Enter        newline (Alt-Enter, or a trailing \\, where the terminal cannot report it)",
  "  Tab                accept the highlighted completion; Up/Down move it",
  "  Ctrl-A             select all      Shift-arrows  extend the selection",
  "  Ctrl-C/X/V         copy / cut / paste            double-click  select a word",
  "  Ctrl-Z / Ctrl-Y    undo / redo",
  // Round thirteen, item 3: Lykos holds mouse tracking, so a plain drag
  // never reaches the terminal's own selection. Both ways out are named
  // here, since a gesture nobody is told about is not a feature.
  "  Shift-Tab          cycle primary specialists",
  "  Shift-drag         select with the terminal itself (Lykos holds the mouse otherwise)",
  "  click to copy      the hint under an answer copies that answer's source text",
  "  Ctrl-Backspace     delete the word behind the cursor (Ctrl-W does the same)",
  "  Alt-Left           the session browser",
  "  Ctrl-Left          move a word left (Ctrl-Right moves right; Home/End reach the line ends)",
  "  PgUp/PgDn, wheel   scroll the transcript",
].join("\n");

export function renderOutcomeLine(outcome: OutcomeView, theme: ResolvedTheme): string {
  const g = GLYPHS[theme.glyphs];
  if (outcome.value === "success" && !outcome.verified) {
    return style(`${g.check} success (unverified)`, "warn", theme);
  }
  if (outcome.value === "success") {
    return style(`${g.check} success`, "ok", theme);
  }
  if (outcome.value === "abandoned") {
    return style(`${g.warnGlyph} abandoned`, "warn", theme);
  }
  return style(`${g.warnGlyph} ${outcome.value}`, "danger", theme);
}

export function renderApprovalBlock(approval: ApprovalView, theme: ResolvedTheme): string {
  const g = GLYPHS[theme.glyphs];
  const title = style(`approval  ${approval.kind}`, "warn", theme);
  const summary = style(approval.summary, "text", theme);
  const detail = style(approval.body ?? approval.detail, "dim", theme);
  const last = approval.decision
    ? style(`decision: ${approval.decision}`, approval.decision === "deny" ? "danger" : "ok", theme)
    : style(
        approval.bashPathAsk
          ? "[y] allow once   [n] deny"
          : approval.protected
            ? "[y] allow for this session   [n] deny"
            : "[y] once   [n] deny   [a] always this tool",
        "dim",
        theme,
      );
  return `${g.diamond} ${title}\n  ${summary}\n  ${detail}\n  ${last}`;
}

export function parseUnifiedDiff(path: string, patch: string, maxLines = 40): DiffView {
  const lines: DiffLine[] = [];
  for (const raw of patch.split("\n")) {
    if (lines.length >= maxLines) break;
    if (raw.startsWith("@@")) lines.push({ kind: "hunk", text: raw });
    else if (raw.startsWith("+") && !raw.startsWith("+++")) lines.push({ kind: "add", text: raw.slice(1) });
    else if (raw.startsWith("-") && !raw.startsWith("---")) lines.push({ kind: "del", text: raw.slice(1) });
    else if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("diff ")) continue;
    else if (raw.length > 0) lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw });
  }
  return { path, lines };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Pull a display-oriented diff out of an edit/write tool's args and result. */
export function extractDiff(name: string, args: unknown, result: unknown): DiffView | undefined {
  const rec = asRecord(result);
  const details = rec ? asRecord(rec.details) : null;
  const patch =
    (typeof rec?.diff === "string" ? rec.diff : undefined) ??
    (typeof rec?.patch === "string" ? rec.patch : undefined) ??
    (typeof details?.diff === "string" ? details.diff : undefined) ??
    (typeof details?.patch === "string" ? details.patch : undefined);
  const arg = asRecord(args);
  const path = typeof arg?.path === "string" ? arg.path : name;
  if (typeof patch === "string" && (patch.includes("\n+") || patch.includes("\n-") || patch.startsWith("@@"))) {
    return parseUnifiedDiff(path, patch);
  }
  const edits = Array.isArray(arg?.edits) ? arg.edits : null;
  if (edits && edits.length > 0) {
    const lines: DiffLine[] = [];
    for (const e of edits) {
      const ed = asRecord(e);
      if (!ed) continue;
      const oldText = typeof ed.oldText === "string" ? ed.oldText : "";
      const newText = typeof ed.newText === "string" ? ed.newText : "";
      for (const l of oldText.split("\n")) lines.push({ kind: "del", text: l });
      for (const l of newText.split("\n")) lines.push({ kind: "add", text: l });
    }
    return { path, lines: lines.slice(0, 40) };
  }
  if (name === "write" && typeof arg?.content === "string") {
    const lines: DiffLine[] = arg.content
      .split("\n")
      .slice(0, 20)
      .map((text) => ({ kind: "add" as const, text }));
    return { path, lines };
  }
  return undefined;
}

function renderDiff(diff: DiffView, opts: ConversationRenderOptions): string {
  const { width, theme } = opts;
  const ascii = theme.glyphs === "ascii";
  const g = GLYPHS[theme.glyphs];
  const path = style(truncate(diff.path, Math.max(8, width - 4), ascii), "accent", theme);
  const rows = [`  ${g.corner} ${path}`];
  for (const line of diff.lines) {
    if (line.kind === "hunk") {
      rows.push(style(`  ${truncate(line.text, width - 2, ascii)}`, "faint", theme));
      continue;
    }
    const mark = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
    const token = line.kind === "add" ? "ok" : line.kind === "del" ? "danger" : "dim";
    rows.push(style(`  ${mark}${truncate(line.text, width - 3, ascii)}`, token, theme));
  }
  return rows.join("\n");
}

function renderTool(tool: ToolBlock, opts: ConversationRenderOptions, collapsed: boolean): string {
  const { width, theme } = opts;
  const ascii = theme.glyphs === "ascii";
  const g = GLYPHS[theme.glyphs];
  const status =
    tool.state === "running" ? style("…", "dim", theme) : tool.state === "ok" ? style(g.check, "ok", theme) : style(g.warnGlyph, "danger", theme);
  const name = style(tool.name, "delegate", theme);
  const summary = style(truncate(tool.summary, Math.max(8, width - tool.name.length - 8), ascii), "dim", theme);
  const head = `${g.diamond} ${name}  ${summary}  ${status}`;
  if (collapsed) return head;
  const parts = [head];
  if (tool.diff) parts.push(renderDiff(tool.diff, opts));
  else if (tool.resultPreview) {
    for (const line of tool.resultPreview.split("\n").slice(0, 8)) {
      parts.push(style(`  ${truncate(line, width - 2, ascii)}`, "dim", theme));
    }
  }
  return parts.join("\n");
}

function renderHeader(header: HeaderView, opts: ConversationRenderOptions): string {
  const { width, theme } = opts;
  const ascii = theme.glyphs === "ascii";
  const g = GLYPHS[theme.glyphs];
  const product = style("lykos", "accent", theme);
  const model = style(header.model, "text", theme);
  const id = style(truncate(header.sessionId, 12, ascii), "faint", theme);
  // Ticket 04: "the active specialist is displayed continuously in the
  // interface." Appended only when set, so a session with none prints the
  // exact line it always has.
  const specialist = header.specialist ? `  ${style(`specialist:${header.specialist}`, "faint", theme)}` : "";
  const line1 = `${product}  ${model}  ${id}${specialist}`;
  const hints = style("/help  Ctrl-C abort  /exit", "dim", theme);
  const cwd = style(truncate(header.cwd, Math.max(8, width - 2), ascii), "faint", theme);
  return `${line1}\n${g.hbar.repeat(Math.min(width, 40))}\n${cwd}\n${hints}`;
}

export function renderBlock(block: ConversationBlock, opts: ConversationRenderOptions, view: ConversationView): string {
  const { width, theme } = opts;
  const ascii = theme.glyphs === "ascii";
  switch (block.kind) {
    case "header":
      return renderHeader(block.header, opts);
    case "user":
      // Mirrors screen/blocks.ts's renderUser(): a blank line for breathing
      // room, then the same accent `>` prompt marker composer.ts uses for
      // the live input row — no separate "you" label, so a submitted
      // message reads as an echo of what was typed rather than a caption.
      return `\n${style("> ", "accent", theme)}${block.text}`;
    case "assistant":
      return block.text;
    case "thinking":
      if (view.thinkingCollapsed) return "";
      return style(truncate(block.text, width, ascii), "faint", theme);
    case "tool":
      return renderTool(block.tool, opts, view.toolsCollapsed && !block.tool.diff);
    case "approval":
      return renderApprovalBlock(block.approval, theme);
    case "system":
      return style(block.text, "dim", theme);
    case "hud":
      return view.hud ? renderTriadLine(view.hud, { width, theme }) : "";
    case "outcome":
      return renderOutcomeLine(block.outcome, theme);
  }
}

/**
 * Full-screen snapshot of S0. `text` is what a TTY would have printed;
 * `viewModel` is the HUD ViewModel the triad line drew — `--json` emits it
 * so the UI is testable with no terminal (docs/07 §1.2).
 */
export function renderS0(view: ConversationView, opts: ConversationRenderOptions): { text: string; viewModel: ViewModel | null } {
  const parts: string[] = [];
  for (const block of view.blocks) {
    const rendered = renderBlock(block, opts, view);
    if (rendered) parts.push(rendered);
  }
  if (view.hud && !view.blocks.some((b) => b.kind === "hud")) {
    parts.push(renderTriadLine(view.hud, { width: opts.width, theme: opts.theme }));
  }
  return { text: parts.join("\n"), viewModel: view.hud };
}

