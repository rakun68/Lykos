// Block taxonomy: thinking versus speech, and everything else.
//
// The transparency requirement: a person must be able to tell, at a
// glance and without reading the words, which part of the screen is the
// model *reasoning* and which part is the model *talking to them*. Today's
// append-only renderer (renderers/conversation.ts) collapses thinking by
// default and renders it `faint` when shown — indistinguishable in
// *structure* from anything else. This file gives each of the eight block
// kinds its own structural treatment for the full-screen surface's
// scrollback (T43 holds the blocks; this file turns one block into the
// lines T43 wraps and caches).
//
// T44.2: colour is never the only carrier of a distinction. Every block
// below emits a literal, non-colour marker — a label, a glyph, or a
// border character — so the surface stays unambiguous with every escape
// code stripped (NO_COLOR, TERM=dumb, a monochrome terminal).

import { extractDiff, renderApprovalBlock, renderOutcomeLine, type ApprovalView, type DiffView } from "../renderers/conversation.js";
import { style, withBackground, type ResolvedTheme } from "../theme/resolve.js";
import { GLYPHS, type SemanticToken } from "../theme/types.js";
import { fmtDuration, fmtTokens, fmtUsd, truncate } from "../format.js";
import type { OutcomeView } from "../types.js";
import { wrapPlain, type ClickRegion, type ScrollbackBlock } from "./scrollback.js";
import { renderMarkdownLines, extractLinks } from "./markdown.js";
import { visibleWidth, stripAnsi } from "./frame.js";
import { renderBashLines, renderDiffLines, type BashBlockInfo, type FoldState } from "./diff.js";
import { stringWidth } from "../width.js";
import { contextSegment } from "../renderers/line.js";
import type { TaskItem } from "../../tools.js";

export { extractDiff };
export type { DiffView };

/** One coloured run of a system message. `text` is what a plain surface prints; `token` is how the full-screen one paints it. */
export interface SystemPart {
  text: string;
  token: SemanticToken;
}

export interface ScreenToolInfo {
  name: string;
  summary: string;
  state: "running" | "ok" | "error";
}

export type ScreenBlock =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "thinking"; text: string }
  /** `streaming` is set while deltas are still arriving — it suppresses the click-to-copy hint, which would otherwise flicker its way down the screen under a half-written sentence (round thirteen, item 3). */
  | { id: string; kind: "speech"; text: string; streaming?: boolean }
  | { id: string; kind: "tool"; tool: ScreenToolInfo }
  | { id: string; kind: "diff"; diff: DiffView; fold?: FoldState }
  | { id: string; kind: "bash"; bash: BashBlockInfo }
  | { id: string; kind: "approval"; approval: ApprovalView }
  | { id: string; kind: "system"; text: string; parts?: readonly SystemPart[] }
  | { id: string; kind: "outcome"; outcome: OutcomeView }
  | { id: string; kind: "read"; path: string }
  | { id: string; kind: "resources"; resources: ScreenResourcesInfo }
  | { id: string; kind: "stats"; stats: TurnStatsView }
  | { id: string; kind: "tasks"; items: readonly TaskItem[] }
  | { id: string; kind: "followup"; text: string };

/**
 * What actually loaded for this session — real counts from
 * `bootStandaloneSession()`, not a guess. `extensions` is honestly empty
 * on every standalone session today: `session/session.ts`'s own comment
 * notes T29's host-side extension declaration was never ported onto this
 * path ("it still carries zero third-party extensions, honestly").
 */
export interface ScreenResourcesInfo {
  contextEnabled: boolean;
  contextFiles: string[];
  contextTokens: number;
  skills: string[];
  extensions: string[];
}

/**
 * One completed turn's own numbers — 2026-09-02 round eight, item 2: "Add
 * total seconds thought, context fill up and money used, token read token
 * write cache... at the end of each message." Everything here is a
 * pass-through of what the session and the ledger's own pricing already
 * computed (`fullscreen-ui.ts`'s `endTurn`), never a UI-invented figure —
 * `elapsedSeconds` is the one exception, and it is an honest wall-clock
 * stopwatch (writeUser to endTurn) rather than anything claiming to be
 * exclusively reasoning time, since nothing in this system currently
 * separates the two (`docs/14-performance.md`: `latency_ms`/`ttft_ms`
 * still have no writer).
 */
export interface TurnStatsView {
  elapsedSeconds: number;
  costUsd: number;
  /** Fresh input, output, cache read and cache write — four numbers, never combined (CLAUDE.md's cache-tokens trap). */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Null when the context window is not known — `contextSegment()`'s own placeholder handles that, same as the footer. */
  context: { usedTokens: number; totalTokens: number | null; pct: number | null } | null;
}

export interface ScreenBlockRenderOptions {
  width: number;
  theme: ResolvedTheme;
  /** `/verbose`: render folded blocks (long diffs, long command output, a long approval body) whole. Off by default - a 2000-line diff is not what anyone wants between two sentences. */
  expanded?: boolean;
}

/**
 * A full-width blank row tinted with `bgToken`, not a bare empty string.
 * 2026-09-02 UI feedback: "if something has background color, one line
 * below and above it should also be wrapped in a background color" — the
 * leading/trailing blank around a user/thinking/read block previously
 * used a plain `""`, which reads as the block's tint stopping one line
 * short of where it visually should. Under a capability with no
 * background support (mono/none), `withBackground()` returns its input
 * unchanged, so this degrades back to a genuinely empty line — no escape
 * leaks under NO_COLOR.
 */
function bgBlankLine(width: number, bgToken: SemanticToken, theme: ResolvedTheme): string {
  return withBackground("", bgToken, theme, 0, width);
}

/**
 * One `userBg` row per wrapped line, with the same `> ` marker as the
 * composer. No blank slab above or below: the empty rows were eating the transcript.
 */
function renderUser(text: string, opts: ScreenBlockRenderOptions): string[] {
  const { width, theme } = opts;
  const wrapped = wrapPlain(text, Math.max(1, width - 2));
  return wrapped.map((l, i) => {
    const prefix = i === 0 ? "> " : "  ";
    const inner = `${style(prefix, "accent", theme)}${style(l, "text", theme)}`;
    return withBackground(inner, "userBg", theme, prefix.length + l.length, width);
  });
}

/**
 * A one-line `│ Thinking` header and an indented body. The old full-width
 * `thinkingBg` slab read as a second conversation. The `│` prefix is the
 * non-colour marker (T44.2).
 */
function renderThinking(text: string, opts: ScreenBlockRenderOptions): string[] {
  const { theme } = opts;
  const g = GLYPHS[theme.glyphs];
  const header = style(`${g.vbar} Thinking`, "thinking", theme);
  const bodyWidth = Math.max(1, opts.width - 2);
  const lines = renderMarkdownLines(text, bodyWidth, theme, "thinking").map(({ styled }) => `  ${styled}`);
  return [header, ...lines];
}

/**
 * T51.3, matching Pi's own presentation (2026-09-01 UI feedback: "when Pi
 * read, it show an entire line with blank line above and beneath too with
 * green background, i like this, adopt this"). One full-width `readBg`
 * line per read call, replacing what used to be a generic multi-line JSON
 * "system" preview (see `renderSystem`'s doc — that preview is what was
 * producing the repeated ⚡ markers the same feedback flagged as too much
 * emoji for one tool call).
 */
function renderRead(path: string, opts: ScreenBlockRenderOptions): string[] {
  const { width, theme } = opts;
  const label = ` ${truncate(`read ${path}`, Math.max(1, width - 1), theme.glyphs === "ascii")}`;
  const line = withBackground(style(label, "text", theme), "readBg", theme, label.length, width);
  const blank = bgBlankLine(width, "readBg", theme);
  return [blank, line, blank];
}

/**
 * The bracketed `[Context]` / `[Skills]` / `[Extensions]` startup panel Pi
 * itself shows (2026-09-01 UI feedback: "Pi shows context, skills,
 * extensions, really useful, add this"). Pushed once at fullscreen boot
 * (`session/interactive.ts`), never updated — the counts are a boot-time
 * fact, not a live gauge the footer already owns.
 */
function renderResources(info: ScreenResourcesInfo, opts: ScreenBlockRenderOptions): string[] {
  const { width, theme } = opts;
  // Item 6's indent rule: column 0 stays blank on every row of this panel.
  const lines: string[] = [""];
  const sections: Array<[string, string[]]> = [
    [
      "Context",
      info.contextEnabled
        ? info.contextFiles.length > 0
          ? [`${info.contextFiles.join(", ")} · ${fmtTokens(info.contextTokens)} tokens`]
          : ["(no context files found)"]
        : ["(off — LYKOS_PROMPT_DIET=0)"],
    ],
    ["Skills", info.skills],
    ["Extensions", info.extensions.length > 0 ? info.extensions : ["(none — standalone execution has no extension surface yet)"]],
  ];
  sections.forEach(([title, body], i) => {
    lines.push(` ${style(`[${title}]`, "dim", theme)}`);
    const rows = body.length > 0 ? body : ["(none)"];
    for (const row of rows) lines.push(`   ${style(truncate(row, Math.max(1, width - 3), theme.glyphs === "ascii"), "text", theme)}`);
    if (i < sections.length - 1) lines.push("");
  });
  lines.push("");
  return lines;
}

/**
 * T51: "normal tone" (T44.1) now means the dedicated `speech` token rather
 * than the terminal's unstyled default — themeable like everything else,
 * still no box.
 *
 * 2026-09-02 UI feedback, item 6: "at the start of each answer, add a
 * single dot so it marks that is the answer of the prompt. Indent each line with a space, so the first position of each
 * line is either blank or a mark." Speech was the one block kind rendering
 * flush at column 0 with no marker of its own — every other kind already
 * opened with `> `, `│ `, `◆ `, `⚡ `, or a diff's `+`/`-`. One `●` on the
 * first line, two spaces of indent on every continuation line, so the
 * left-hand column reads as a spine of markers rather than a ragged edge,
 * and the body wraps two columns narrower to pay for it.
 */
function renderSpeech(text: string, opts: ScreenBlockRenderOptions, streaming: boolean): string[] {
  const { theme } = opts;
  const g = GLYPHS[theme.glyphs];
  const body = renderMarkdownLines(text, Math.max(1, opts.width - 2), theme, "speech");
  const lines = body.map((l, i) => (i === 0 ? `${style(g.bullet, "accent", theme)} ${l.styled}` : `  ${l.styled}`));
  // Round thirteen, item 3. Only on a finished answer with something in
  // it: a streaming block is re-rendered on every delta, and a hint that
  // appeared under a half-written sentence would flicker down the screen
  // for the whole turn. `streaming` is set by the caller that knows.
  if (streaming || text.trim().length === 0) return lines;
  // Text only, no glyph: every glyph in `GLYPHS` is already some block
  // kind's own structural marker (T44.2 — a ◆ here made a speech block
  // indistinguishable from a tool line with colour stripped, which the
  // block suite caught immediately). The underline is what says clickable,
  // exactly as it does for a fold hint.
  lines.push(`  ${underline(style(COPY_MARKER, "faint", theme), theme)}${style(`   ${SELECT_HINT}`, "faint", theme)}`);
  return lines;
}

function renderTool(tool: ScreenToolInfo, opts: ScreenBlockRenderOptions): string[] {
  const { theme } = opts;
  const g = GLYPHS[theme.glyphs];
  const status = tool.state === "running" ? style("…", "dim", theme) : tool.state === "ok" ? style(g.check, "ok", theme) : style(g.warnGlyph, "danger", theme);
  const marker = style(g.diamond, "delegate", theme);
  const painted = style(tool.name, "delegate", theme);
  const name = theme.capability === "none" ? painted : `\x1b[1m${painted}`;
  const summary = tool.summary.length > 0 ? `  ${style(`(${tool.summary})`, "dim", theme)}` : "";
  return [`${marker} ${name}${summary}  ${status}`];
}

/**
 * The approval prompt, in the transcript rather than over it - 2026-09-02
 * round three, item 11: "I dont like approval message taking up all the
 * screen, maybe just give it a different background color and it show it up
 * inside the chat, make the color noticeable and make the options
 * noticeable too."
 *
 * It used to be a full-screen overlay (`ScreenPipeline.setOverlay`), which
 * meant a one-line `bash` approval blanked the entire terminal and the
 * command being approved lost every bit of its context. As a block it sits
 * where it happened, keeps the conversation above it readable - which is
 * most of what someone needs in order to decide - and stays in scrollback
 * afterwards with the decision recorded on it.
 *
 * Every row carries the `modalBg` tint at full strength (the loudest
 * background in the palette, and the token T51.1 declared for exactly this
 * and then could not paint) and the keys are spelled out with each letter
 * in `warn` against the body's `text`, so the choices are findable with no
 * colour at all.
 */
/**
 * One dim, single-line summary after every completed turn — see
 * `TurnStatsView`'s own doc for what's in it and why. It rides the same
 * `toScrollbackBlock()` trailing-blank-row convention every other block
 * kind does, which is what puts the required blank line between the
 * agent's own reply and this line for free (2026-09-02 round eight, item
 * 2's own "There should be a blank line between the things that we just
 * add with the answer message of the agent").
 */
function renderStats(stats: TurnStatsView, opts: ScreenBlockRenderOptions): string[] {
  const { theme } = opts;
  const g = GLYPHS[theme.glyphs];
  const ascii = theme.glyphs === "ascii";
  const parts = [
    fmtDuration(stats.elapsedSeconds),
    fmtUsd(stats.costUsd),
    // `g.write` (✎) is East Asian Ambiguous, same as `g.warnGlyph` — round
    // four, item 9 fixed the identical bleed on the footer's own cache-write
    // segment with a trailing space, and this line (new in round eight)
    // shipped without it: "the pencil emoji is overlapping with the number
    // zero" (round nine, item 1). `g.arrowUp`/`g.arrowDown`/`g.bolt` are not
    // ambiguous-width and correctly need none.
    `${g.arrowUp}${fmtTokens(stats.tokens.input)} ${g.arrowDown}${fmtTokens(stats.tokens.output)} ${g.bolt}${fmtTokens(stats.tokens.cacheRead)} ${g.write} ${fmtTokens(stats.tokens.cacheWrite)}`,
    contextSegment(stats.context, "full", ascii),
  ];
  return [style(parts.join(`  ${g.vbar}  `), "faint", theme)];
}

function renderApproval(approval: ApprovalView, opts: ScreenBlockRenderOptions): string[] {
  const { width, theme } = opts;
  const g = GLYPHS[theme.glyphs];
  const tint = (inner: string) => withBackground(inner, "modalBg", theme, visibleWidth(inner), width);
  const rows: string[] = [tint("")];
  rows.push(tint(`${style(`${g.warnGlyph} approval`, "danger", theme)}  ${style(approval.kind, "warn", theme)}`));
  for (const line of wrapPlain(approval.summary, Math.max(1, width - 2))) {
    rows.push(tint(`  ${style(line, "text", theme)}`));
  }
  const body = approval.body ?? approval.detail;
  if (body) {
    const bodyLines = wrapPlain(body, Math.max(1, width - 4));
    const foldable = bodyLines.length > APPROVAL_BODY_LINES;
    const shown = opts.expanded ? bodyLines : bodyLines.slice(0, APPROVAL_BODY_LINES);
    for (const line of shown) rows.push(tint(`  ${style(g.vbar, "border", theme)} ${style(line, "dim", theme)}`));
    const hidden = bodyLines.length - shown.length;
    if (hidden > 0) {
      rows.push(tint(`  ${underline(style(`... ${hidden} more lines - click, or /verbose, to expand`, "faint", theme), theme)}`));
    } else if (foldable && opts.expanded) {
      rows.push(tint(`  ${underline(style("click, or /verbose, to collapse", "faint", theme), theme)}`));
    }
  }
  if (approval.decision) {
    const token = approval.decision === "deny" ? "danger" : "ok";
    rows.push(tint(`  ${style(DECISION_LABEL[approval.decision], token, theme)}`));
  } else {
    for (const line of packKeyPills(width - 2, theme, approval.protected, approval.bashPathAsk)) rows.push(tint(`  ${line}`));
  }
  // 2026-09-02 round five, item 8: "It should be single approval message
  // showing at a time with a small text below telling how many approval
  // message more are there." `approval-modal.ts`'s queue is what makes
  // "single at a time" true; this is the "how many more" half. It rides on
  // the DECIDED block too since round seven, because `deferAdvance` holds
  // the next prompt back until the approved command's output has landed
  // (item 4) and a gap with nothing saying "more are coming" reads as the
  // queue having been swallowed.
  if (approval.queued) {
    rows.push(tint(`  ${style(`+${approval.queued} more approval${approval.queued === 1 ? "" : "s"} waiting`, "faint", theme)}`));
  }
  rows.push(tint(""));
  return rows;
}

/**
 * The four key hints, greedily packed onto as few lines as fit `maxWidth` —
 * a plain join overran 40 columns (T50.2's frame budget), which either
 * `withBackground` would have left unclipped (it pads short lines, it does
 * not truncate long ones) or the frame writer would have clipped blind,
 * cutting a key hint off mid-word. Wrapping by whole pill is the one option
 * that keeps every hint intact at every width this project supports.
 *
 * The gutter between pills widened from 3 to 5 columns in round five, item
 * 11 ("make their spacing a little bit further so it avoid misclicks") —
 * ahead of, and independent from, actually making them clickable (see that
 * item's own note in DECISIONS.md for what full click support still needs
 * and why it isn't in this round).
 */
const PILL_GUTTER = "     ";

function packKeyPills(maxWidth: number, theme: ResolvedTheme, isProtected?: boolean, isBashPathAsk?: boolean): string[] {
  const pills = (
    isBashPathAsk
      ? [
          ["y", "allow once"],
          ["n", "deny"],
          ["Esc", "deny"],
        ]
      : isProtected
        ? [
            ["y", "allow for this session"],
            ["n", "deny"],
            ["Esc", "deny"],
          ]
        : [
            ["y", "allow once"],
            ["n", "deny"],
            ["a", "always"],
            ["f", "allow folder"],
            ["Esc", "deny"],
          ]
  ).map(([k, label]) => ({
    plain: `[${k}] ${label}`,
    // Only the bracket itself is the click target (`PILL_RE` above matches
    // just `[y]`/`[n]`/`[a]`/`[f]`/`[Esc]`, not the label after it) — underlining
    // exactly that, and nothing more, keeps the affordance honest about
    // what actually responds to a click.
    styled: `${underline(style(`[${k}]`, "warn", theme), theme)} ${style(label!, "text", theme)}`,
  }));
  const lines: string[] = [];
  let plain = "";
  let styled = "";
  for (const pill of pills) {
    const candidate = plain.length === 0 ? pill.plain : `${plain}${PILL_GUTTER}${pill.plain}`;
    if (plain.length === 0 || stringWidth(candidate) <= maxWidth) {
      plain = candidate;
      styled = styled.length === 0 ? pill.styled : `${styled}${PILL_GUTTER}${pill.styled}`;
    } else {
      lines.push(styled);
      plain = pill.plain;
      styled = pill.styled;
    }
  }
  if (plain.length > 0) lines.push(styled);
  return lines;
}

/** Enough to judge a command or a patch hunk without the prompt swallowing the screen again; `/verbose` shows the rest. */
const APPROVAL_BODY_LINES = 24;

const DECISION_LABEL: Record<NonNullable<ApprovalView["decision"]>, string> = {
  allow: "allowed once",
  "allow-always": "allowed for this session",
  "allow-folder": "allowed folder",
  deny: "denied",
};

/**
 * Machinery, not conversation — a leading marker makes that legible with
 * zero colour. Only the FIRST wrapped line carries the ⚡ marker;
 * continuation lines get plain indentation instead. A multi-line JSON tool
 * preview used to stamp every single wrapped line with its own bolt glyph
 * (flagged 2026-09-01 as "use less emoji") — one marker per block reads
 * the same under NO_COLOR and stops a ten-line preview from looking like
 * ten separate system events.
 */
function renderSystem(text: string, opts: ScreenBlockRenderOptions, parts?: readonly SystemPart[]): string[] {
  const { width, theme } = opts;
  const g = GLYPHS[theme.glyphs];
  // A message whose own colours carry meaning (the effort ladder, item 7)
  // hands in `parts` instead of a flat string. Until 2026-09-02 round ten
  // every caller of `parts` was genuinely one line, so joining them into a
  // single array element was safe. The footer glossary (round nine, item
  // 4) was the first caller to put several ROWS in one call, each row
  // separated by a "\n" inside a part's own text — joined the same way,
  // that left literal "\n" BYTES inside one terminal cell's content. A
  // bare LF moves the cursor down without a carriage return, so every row
  // after the first landed one column further right than the last,
  // walking the message down and right across whatever the screen already
  // had painted there, including the composer's own top border (round
  // ten, item 1's "override on the top bar of prompt chat box") — and
  // leaving fragments of whatever WAS on those rows still visible past
  // wherever the walk stopped writing. Splitting on "\n" here, into one
  // array element per row, is what every other renderer already does;
  // this branch just never had more than one row to worry about before.
  if (parts && parts.length > 0) {
    const rows: SystemPart[][] = [[]];
    for (const part of parts) {
      const segments = part.text.split("\n");
      segments.forEach((seg, i) => {
        if (seg.length > 0) rows[rows.length - 1]!.push({ text: seg, token: part.token });
        if (i < segments.length - 1) rows.push([]);
      });
    }
    if (rows[rows.length - 1]!.length === 0) rows.pop();
    return rows.map((row, i) => {
      const styled = row.map((p) => style(p.text, p.token, theme)).join("");
      return `${style(i === 0 ? `${g.bolt} ` : "  ", "dim", theme)}${styled}`;
    });
  }
  const wrapped = wrapPlain(text, Math.max(1, width - 2));
  return wrapped.map((l, i) => style(i === 0 ? `${g.bolt} ${l}` : `  ${l}`, "dim", theme));
}

function renderOutcome(outcome: OutcomeView, theme: ResolvedTheme): string[] {
  return [renderOutcomeLine(outcome, theme)];
}

function renderTasks(items: readonly TaskItem[], opts: ScreenBlockRenderOptions): string[] {
  const lines = [style("tasks", "accent", opts.theme)];
  if (items.length === 0) return [...lines, style("  (no tasks)", "faint", opts.theme)];
  for (const item of items) {
    const marker = item.status === "done" ? "✓" : item.status === "in_progress" ? "▶" : item.status === "dropped" ? "×" : "·";
    lines.push(style(`  ${marker} ${item.id}. ${item.text}`, item.status === "done" ? "dim" : "text", opts.theme));
  }
  return lines;
}

export function renderScreenBlock(block: ScreenBlock, opts: ScreenBlockRenderOptions): string[] {
  switch (block.kind) {
    case "user":
      return renderUser(block.text, opts);
    case "thinking":
      return renderThinking(block.text, opts);
    case "speech":
      return renderSpeech(block.text, opts, block.streaming ?? false);
    case "tool":
      return renderTool(block.tool, opts);
    case "diff":
      return renderDiffLines(block.diff, {
        width: opts.width,
        theme: opts.theme,
        fold: { ...(block.fold ?? {}), ...(opts.expanded ? { expanded: true } : {}) },
      });
    case "bash":
      return renderBashLines(block.bash, opts);
    case "approval":
      return renderApproval(block.approval, opts);
    case "system":
      return renderSystem(block.text, opts, block.parts);
    case "outcome":
      return renderOutcome(block.outcome, opts.theme);
    case "read":
      return renderRead(block.path, opts);
    case "resources":
      return renderResources(block.resources, opts);
    case "stats":
      return renderStats(block.stats, opts);
    case "tasks":
      return renderTasks(block.items, opts);
    case "followup":
      return renderSystem(`follow-up queued: ${block.text}`, opts);
  }
}

/**
 * One plain, untinted blank row appended after every block in the
 * transcript — 2026-09-02 UI feedback, item 1: "right now there is no
 * spacing between thoughts, user prompts and real answer of model or with
 * loading text, add a blank line between them."
 *
 * It lives HERE rather than inside each `render*()` function for two
 * reasons. The tinted blanks `renderUser`/`renderThinking`/`renderRead`
 * already emit are part of those blocks' own backgrounds — they make the
 * tint stop one row clear of the text, which is a different job from
 * separating one block from the next, and a tinted row butting straight
 * against the next block's tinted row is exactly what read as "no
 * spacing." And putting it in one place means a block kind added later
 * cannot forget it. The trailing separator on the LAST block is what
 * gives the status line (and, at rest, the composer) its own blank row
 * above, which is the "or with loading text" half of the same request.
 */
/** `[y]`/`[n]`/`[a]`/`[Esc]` — the literal pill text `packKeyPills()` builds — mapped to what clicking each one means. `"n"` and `"Esc"` share a decision (T49.2: both deny) but keep their own debounce key, matching `RawApprovalGate`'s existing per-KEY guard rather than per-decision. */
const PILL_KEY_TO_ACTION: Record<string, { key: string; decision: "allow" | "deny" | "allow-always" | "allow-folder" }> = {
  y: { key: "y", decision: "allow" },
  n: { key: "n", decision: "deny" },
  a: { key: "a", decision: "allow-always" },
  f: { key: "f", decision: "allow-folder" },
  Esc: { key: "escape", decision: "deny" },
};
const PILL_RE = /\[(y|n|a|f|Esc)\]/g;
const LINK_MARKER_RE = /\[(\d+)\]/g;
/** Shared by every fold-hint string this file and `diff.ts` emit — see each site's own comment for why "to expand" specifically. */
const FOLD_HINT_MARKER = "to expand";
/** The other half of a fold hint, once `/verbose` (or a click) has already expanded a block — round ten, item 5: "There is show more but not any show less button." */
const FOLD_COLLAPSE_MARKER = "to collapse";
/**
 * The click-to-copy hint under an answer — 2026-09-02 round thirteen,
 * item 3: "user cannot copy texts from the answer of the agent."
 *
 * They cannot, and it is Lykos's own doing: the full-screen surface holds
 * mouse tracking (`?1000h`/`?1002h`/`?1003h`), so the terminal forwards
 * every press to us instead of running its own selection. Most terminals
 * let a Shift-held drag bypass that — which the hotkey list now says out
 * loud — but a gesture nobody is told about is not a feature, and Shift
 * selection copies what is on SCREEN: wrapped, indented, with the bullet
 * and any `[n]` link markers baked in. This copies the block's own SOURCE
 * text instead, which is what a reader pasting an answer somewhere else
 * actually wants.
 */
const COPY_MARKER = "click to copy";

/**
 * T131: the OTHER way out, named beside the first.
 *
 * Round thirteen built `Shift-drag` into the hotkey list and stopped there,
 * on the reasoning that a gesture nobody is told about is not a feature. It
 * is still not a feature if the only place it is told is a help screen
 * nobody opens while trying to copy something. This puts it where the
 * problem is actually felt — under the answer the reader is trying to
 * select — and the two are complementary rather than redundant: the click
 * copies the whole answer's SOURCE text, the drag selects an arbitrary
 * PART of what is on screen. Neither substitutes for the other, which is
 * exactly why both need naming.
 */
const SELECT_HINT = "shift-drag to select";

/**
 * A persistent underline — never a hover state. True hover needs
 * continuous mouse-motion tracking (`?1003h`), which round nine rejected
 * as an unproven, whole-terminal traffic cost; round ten asked the same
 * question a second time ("make buttons highlight... giving background
 * color + change font color or adding underline is the best option") and
 * named underline itself as an acceptable answer. So every clickable
 * marker is underlined ALL the time, the same way a terminal hyperlink or
 * a GUI button's border says "this responds to a click" before the
 * pointer ever reaches it — no live cursor position needed. Not gated by
 * theme capability: `markdown.ts`'s bold/italic/strike SGR codes already
 * aren't either, only colour tokens are (T44.2's rule is about colour
 * never being the ONLY carrier of a distinction — but capability `"none"`
 * (`TERM=dumb`, non-TTY, explicit `NO_COLOR`) is a stricter, separate rule
 * this codebase already enforces everywhere: under it, nothing emits ANY
 * escape code at all, `style()`'s own colour included (`resolve.ts`'s
 * `prefixFor` returns `""` for that capability). `underline()` has to
 * match that or it becomes the one place `NO_COLOR`/`TERM=dumb` still
 * leaks raw bytes onto a terminal that asked for none.
 */
const UNDERLINE_ON = "\x1b[4m";
const UNDERLINE_OFF = "\x1b[24m";
function underline(text: string, theme: ResolvedTheme): string {
  if (theme.capability === "none") return text;
  return `${UNDERLINE_ON}${text}${UNDERLINE_OFF}`;
}

/**
 * The click-region half of `ScrollbackBlock.regionsFor` — 2026-09-02 round
 * nine, item 3: "make clicking hovering buttons with mouse possible,"
 * naming approval buttons and a message's expand/collapse as two of the
 * things that should be. This is a POST-HOC scan over lines
 * `renderScreenBlock()` already produced, not a second, richer return type
 * threaded through every renderer — `renderApproval`/`renderDiffLines`/
 * `renderBashLines`/`renderThinking`/`renderSpeech` all keep their plain
 * `string[]` contract, used by many other call sites and tests, completely
 * unchanged.
 *
 * That trade only works because every clickable thing this function looks
 * for is a literal, predictable marker already in the rendered text:
 *  - An approval's `[y]`/`[n]`/`[a]`/`[Esc]` pills — `packKeyPills()`'s own
 *    output, which only ever appears on the ONE row of an undecided
 *    approval block, so no decision-state check is needed to avoid a false
 *    match on a resolved one (`DECISION_LABEL`'s text has no brackets).
 *  - A fold hint containing `FOLD_HINT_MARKER` — the whole line is the
 *    click target, and it fires `/verbose`'s own global toggle rather than
 *    a genuinely independent per-block fold, which every fold-hint string
 *    already told the reader was a keyboard command; this just adds a
 *    second way to reach it.
 *  - A link's `[n]` marker (`markdown.ts`'s `extractLinks()`), bounds-
 *    checked against that SPECIFIC block's own link count so an unrelated
 *    "[3]" a model happens to type in prose with no real links nearby
 *    cannot match anything.
 *
 * Column offsets are plain-text string indices, which are visible-column
 * indices for exactly the same reason `frame.ts`'s own `visibleWidth()`
 * strips ANSI first: every marker scanned for here is pure ASCII with
 * nothing but spaces before it on its own line.
 */
function computeClickRegions(block: ScreenBlock, lines: readonly string[]): Array<ClickRegion[] | undefined> | undefined {
  if (block.kind !== "approval" && block.kind !== "diff" && block.kind !== "bash" && block.kind !== "speech" && block.kind !== "thinking") {
    return undefined;
  }
  const links = block.kind === "speech" || block.kind === "thinking" ? extractLinks(block.text) : null;
  let any = false;
  const out = lines.map((line): ClickRegion[] | undefined => {
    const plain = stripAnsi(line);
    const regions: ClickRegion[] = [];
    if (block.kind === "approval") {
      PILL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = PILL_RE.exec(plain))) {
        const mapped = PILL_KEY_TO_ACTION[m[1]!];
        if (!mapped) continue;
        regions.push({ colStart: m.index, colEnd: m.index + m[0]!.length, action: { kind: "approvalKey", ...mapped } });
      }
    }
    if (links && links.length > 0) {
      LINK_MARKER_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = LINK_MARKER_RE.exec(plain))) {
        const n = Number(m[1]);
        if (n < 1 || n > links.length) continue; // out of range for THIS block — not one of its own links
        regions.push({ colStart: m.index, colEnd: m.index + m[0]!.length, action: { kind: "openLink", url: links[n - 1]! } });
      }
    }
    if (plain.includes(FOLD_HINT_MARKER) || plain.includes(FOLD_COLLAPSE_MARKER)) {
      regions.push({ colStart: 0, colEnd: plain.length, action: { kind: "toggleVerbose" } });
    }
    // Round thirteen, item 3: the hint row under a finished answer copies
    // the block's own source text — not the wrapped, bulleted, `[n]`-
    // annotated version on screen, which is what a terminal's own
    // selection would give.
    if (block.kind === "speech" && plain.includes(COPY_MARKER)) {
      const at = plain.indexOf(COPY_MARKER);
      regions.push({
        colStart: Math.max(0, at - 2),
        colEnd: at + COPY_MARKER.length,
        action: { kind: "copyText", text: block.text, label: "answer" },
      });
    }
    if (regions.length === 0) return undefined;
    any = true;
    return regions;
  });
  return any ? out : undefined;
}

export function toScrollbackBlock(block: ScreenBlock, theme: ResolvedTheme, expanded = false): ScrollbackBlock {
  return {
    id: block.id,
    render: (width: number) => [...renderScreenBlock(block, { width, theme, expanded }), ""],
    regionsFor: (lines) => computeClickRegions(block, lines),
  };
}
