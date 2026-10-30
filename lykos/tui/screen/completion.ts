// Tab completion, coloured by what it costs.
//
// The genuinely Lykos-shaped requirement: a cost-aware agent should never
// make the user guess which of its own commands costs money. T47.1's
// registry is the single place that decision gets made — every command
// Lykos actually recognises (checked against `parseInteractiveInput()`
// behaviourally in completion.test.ts, not just listed here) carries a
// `local` / `costed` / `refused` class, and T47.4's own test walks the
// registry so a command added later without a class fails loudly instead
// of silently defaulting to looking free.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { style, withBackground, type ResolvedTheme } from "../theme/resolve.js";
import { GLYPHS } from "../theme/types.js";
import { truncate } from "../format.js";
import { visibleWidth } from "./frame.js";
import { BUILTIN_COMMANDS, INPUT_PREFIXES, findCommand, slashCandidates, type CommandSource, type CommandSpec as CommandLike, type CostClass } from "../commands.js";

// T131: the registry moved to `tui/commands.ts` so that dispatch and
// completion read one source, and so that skills — discovered per project at
// boot — can be added to it at runtime. What remains here is presentation.
export type { CostClass, CommandSpec as CommandInfo } from "../commands.js";

/**
 * Back-compatible view of the old flat table: the built-ins plus the
 * classification-only prefix rows (`!cmd`, `!!cmd`, `prompt`). Skills are
 * deliberately NOT here — this is the static surface, and anything wanting
 * the live one calls `slashCandidates()`.
 */
export const COMMAND_REGISTRY: readonly CommandLike[] = [
  ...BUILTIN_COMMANDS,
  ...INPUT_PREFIXES.map((p) => ({ ...p, source: "builtin" as const })),
];

export interface Candidate {
  /** What gets inserted when this candidate is chosen. */
  label: string;
  kind: "command" | "file" | "argument";
  costClass?: CostClass;
  description?: string;
  /** T131: where a command came from, so a skill-sourced `/handoff` is visibly not a built-in. P10.9 added "extension", T163 "pi-extension", for the same reason. */
  source?: CommandSource;
  /** T163: the extension that registered it, for an extension or Pi-extension command. */
  extension?: string;
}

/** T47.3: `/` at position 0 completes commands, cycled by prefix. */
export function completeCommand(query: string): Candidate[] {
  const q = query.toLowerCase();
  return slashCandidates(query)
    .filter((c) => c.name.toLowerCase().startsWith(q))
    .map((c) => ({
      label: c.name,
      kind: "command" as const,
      costClass: c.costClass,
      description: c.description,
      source: c.source,
      ...(c.extension !== undefined ? { extension: c.extension } : {}),
    }));
}

/**
 * The argument list for `/cmd <partial>`, filtered by what has been typed.
 *
 * A command with no `args` in the registry returns nothing at all rather
 * than falling back to file completion: `/effort src/` is not a path, and a
 * popup full of filenames under a command that takes a closed vocabulary is
 * worse than no popup.
 */
export function completeArgument(command: string, query: string): Candidate[] {
  const info = findCommand(command);
  if (!info?.args) return [];
  const q = query.toLowerCase();
  return info.args
    .filter((a) => a.toLowerCase().startsWith(q))
    .map((a) => ({ label: a, kind: "argument" as const, costClass: info.costClass, description: `${info.name} ${a}` }));
}

const DEFAULT_IGNORE = [".git", "node_modules", ".lykos"];

function parseGitignore(content: string): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("!"));
}

function loadIgnorePatterns(root: string): string[] {
  const patterns = [...DEFAULT_IGNORE];
  const gitignorePath = join(root, ".gitignore");
  if (existsSync(gitignorePath)) {
    try {
      patterns.push(...parseGitignore(readFileSync(gitignorePath, "utf8")));
    } catch {
      // A .gitignore Lykos can't read still leaves the sane defaults above.
    }
  }
  return patterns;
}

/** Minimal glob-to-regex: `*` -> any run of non-slash chars, `?` -> one char. Not a full gitignore implementation (no `!` negation, no `**`) — named here rather than silently wrong. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

function isIgnored(relPath: string, patterns: readonly string[]): boolean {
  const segments = relPath.split("/");
  const base = segments[segments.length - 1]!;
  return patterns.some((raw) => {
    const p = raw.replace(/\/$/, "");
    if (p.includes("/")) return globToRegExp(p).test(relPath);
    return globToRegExp(p).test(base) || segments.some((s) => globToRegExp(p).test(s));
  });
}

/** T47.3: `@` completion source, respecting `.gitignore`, capped rather than walking the whole tree unbounded. */
export function listProjectFiles(root: string, cap = 5000): string[] {
  const patterns = loadIgnorePatterns(root);
  const out: string[] = [];
  const stack: string[] = [""];
  while (stack.length > 0 && out.length < cap) {
    const relDir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (out.length >= cap) break;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (isIgnored(rel, patterns)) continue;
      if (entry.isDirectory()) stack.push(rel);
      else if (entry.isFile()) out.push(rel);
    }
  }
  return out;
}

/** Subsequence fuzzy match: every query character must appear in order; a lower score (tighter clustering) sorts first. Null when the query does not match at all. */
function fuzzyScore(text: string, query: string): number | null {
  if (query.length === 0) return 0;
  let ti = 0;
  let qi = 0;
  let score = 0;
  let lastMatch = -1;
  while (ti < text.length && qi < query.length) {
    if (text[ti] === query[qi]) {
      if (lastMatch !== -1) score += ti - lastMatch - 1;
      lastMatch = ti;
      qi += 1;
    }
    ti += 1;
  }
  return qi === query.length ? score : null;
}

export function fuzzyMatchFiles(files: readonly string[], query: string, limit = 20): string[] {
  if (query.length === 0) return files.slice(0, limit);
  const q = query.toLowerCase();
  const scored: Array<{ file: string; score: number }> = [];
  for (const file of files) {
    const score = fuzzyScore(file.toLowerCase(), q);
    if (score !== null) scored.push({ file, score });
  }
  scored.sort((a, b) => a.score - b.score || a.file.length - b.file.length);
  return scored.slice(0, limit).map((s) => s.file);
}

export function completePath(root: string, query: string, limit = 20): Candidate[] {
  const files = listProjectFiles(root);
  return fuzzyMatchFiles(files, query, limit).map((f) => ({ label: f, kind: "file" as const }));
}

/**
 * T47.3's trigger rule: `/` only completes at column 0; `@` completes the
 * token it starts, wherever the cursor is.
 */
export function complete(root: string, lineText: string, cursorCol: number): Candidate[] {
  const before = lineText.slice(0, cursorCol);
  if (before.startsWith("/")) {
    const space = before.indexOf(" ");
    if (space === -1) return completeCommand(before);
    // An `@token` inside a command's arguments is still a path — `/followup
    // @src/x.ts` has to complete the same way a bare prompt does.
    const at = before.lastIndexOf("@");
    if (at > space) return completePath(root, before.slice(at + 1));
    // Otherwise the FIRST argument, and only while the cursor is still
    // inside it: `/effort ma|` completes, `/effort max something|` does not.
    const rest = before.slice(space + 1);
    if (rest.includes(" ")) return [];
    return completeArgument(before.slice(0, space), rest);
  }
  const at = before.lastIndexOf("@");
  if (at !== -1) return completePath(root, before.slice(at + 1));
  return [];
}

// --- T47.2: colour by cost class, with a non-colour marker too ---

// T51: dedicated local/costed tokens rather than borrowing ok/spend — refused
// keeps "danger" since T51.1 named no separate token for it.
function costToken(cls: CostClass): "local" | "costed" | "danger" {
  return cls === "local" ? "local" : cls === "costed" ? "costed" : "danger";
}

/** The literal marker each class carries even under NO_COLOR — colour is never the only signal (T44.2's rule, reused here). */
function costMarker(cls: CostClass): string {
  return cls === "local" ? "" : cls === "costed" ? "$" : "×";
}

export interface CompletionPopupOptions {
  width: number;
  theme: ResolvedTheme;
  /** Rows of candidates shown at once. Five by default (2026-09-02 UI feedback, item 5). */
  maxVisible?: number;
  /** Index into `candidates` that is currently highlighted (Tab cycles it). */
  selected?: number;
}

/**
 * The scrolling window, item 5 of the 2026-09-02 UI feedback: "I want there
 * is 5 commands showing at a time and the pointer is always at the middle
 * (third spot) unless it reaches the top or the bottom… the list cycles and
 * move, not the pointer."
 *
 * So the window start is the selection minus half a window, clamped to the
 * document — which is exactly "pointer pinned to the middle row, list
 * scrolling underneath it" everywhere except the first and last two
 * candidates, where clamping pins the window instead and the pointer moves
 * within it. Cycling itself is not here: `RawLineSource.moveCompletionSelection`
 * already wraps the index modulo the candidate count, so stepping up from
 * the first candidate lands on the last and this function then clamps the
 * window to the bottom of the list, which is the requested behaviour.
 *
 * Exported for its own test: the off-by-one at each end of the list is the
 * part worth asserting directly rather than through rendered strings.
 */
export function completionWindow(total: number, selected: number, maxVisible: number): { start: number; end: number } {
  const size = Math.max(1, Math.min(maxVisible, total));
  if (total <= size) return { start: 0, end: total };
  const sel = selected < 0 ? 0 : Math.min(selected, total - 1);
  const before = Math.floor((size - 1) / 2);
  const start = Math.max(0, Math.min(sel - before, total - size));
  return { start, end: start + size };
}

/**
 * T47.3: a legend line names the classes; the list itself never exceeds
 * `maxVisible` rows. The counter line underneath names what is hidden on
 * BOTH sides now that the window scrolls (it used to say "+N more" and
 * only ever meant "below", which was wrong the moment the window could
 * start anywhere but 0).
 */
/** `CompletionPopupOptions.maxVisible`'s default — exported so `raw-line-source.ts` can recompute the SAME window `completionWindow()` produced for whatever this function last rendered, to map a click's row back to a candidate index without the two ever drifting apart (2026-09-02 round nine, item 3). */
export const DEFAULT_COMPLETION_MAX_VISIBLE = 5;

export function renderCompletionPopup(candidates: readonly Candidate[], opts: CompletionPopupOptions): string[] {
  const { width, theme } = opts;
  const max = Math.max(1, opts.maxVisible ?? DEFAULT_COMPLETION_MAX_VISIBLE);
  const g = GLYPHS[theme.glyphs];
  // Every row is tinted `completionBg` across the FULL width — 2026-09-02
  // round three, item 4: "add a background color (different from other
  // background colors) for tab completer. This way it is easier to
  // distinguish the tab completer with the chat." Under the mono/none
  // capability `withBackground` returns its input untouched, so a NO_COLOR
  // session still gets the same rows with no escapes at all.
  const tint = (line: string) => withBackground(line, "completionBg", theme, visibleWidth(line), width);
  if (candidates.length === 0) return [tint(style("  no matches", "dim", theme))];

  const selected = opts.selected ?? -1;
  const { start, end } = completionWindow(candidates.length, selected, max);
  const lines = candidates.slice(start, end).map((c, i) => {
    const idx = start + i;
    const marker = c.costClass ? costMarker(c.costClass) : "";
    const tone = c.costClass ? costToken(c.costClass) : "text";
    const prefix = idx === selected ? `${g.diamond} ` : "  ";
    const label = c.costClass === "refused" ? strike(c.label) : c.label;
    const described = [sourceLabel(c), c.description].filter((d) => d !== undefined && d.length > 0).join("  ");
    const desc = described ? style(`  ${truncate(described, Math.max(4, width - c.label.length - 6), theme.glyphs === "ascii")}`, "dim", theme) : "";
    // Every row here is a click target (a click selects and accepts it,
    // same as Tab does for the highlighted one) — underlined the same way
    // as every other clickable marker in this round, so the popup reads as
    // a list of buttons rather than plain text (round ten, item 4).
    return tint(`${prefix}${underline(style(`${marker}${marker ? " " : ""}${label}`, tone, theme), theme)}${desc}`);
  });
  const above = start;
  const below = candidates.length - end;
  if (above > 0 || below > 0) {
    lines.push(tint(style(`  ${g.arrowUp}${above}  ${g.arrowDown}${below}  (${selected + 1}/${candidates.length})`, "faint", theme)));
  }
  lines.push(tint(style(`  local ${g.check}  costed $  refused ${g.warnGlyph}`, "faint", theme)));
  return lines;
}

/** T163: where a command came from, shown on its row. Undefined for anything that is not a command. */
export function sourceLabel(c: Pick<Candidate, "kind" | "source" | "extension">): string | undefined {
  if (c.kind !== "command" || c.source === undefined) return undefined;
  if (c.source === "extension") return `[lykos ext${c.extension !== undefined ? ` ${c.extension}` : ""}]`;
  if (c.source === "pi-extension") return `[pi ext${c.extension !== undefined ? ` ${c.extension}` : ""}]`;
  return `[${c.source}]`;
}

function strike(text: string): string {
  return [...text].map((c) => `${c}̶`).join("");
}

/** A persistent (not hover-triggered) underline marking a candidate row as clickable — see `blocks.ts`'s own `underline()` for why capability `"none"` (`TERM=dumb`, `NO_COLOR`) emits nothing. Defined locally rather than imported, matching this codebase's existing per-file convention for standalone SGR codes (`markdown.ts`'s `BOLD_ON`/`ITALIC_ON`/`STRIKE_ON`). */
const UNDERLINE_ON = "\x1b[4m";
const UNDERLINE_OFF = "\x1b[24m";
function underline(text: string, theme: ResolvedTheme): string {
  if (theme.capability === "none") return text;
  return `${UNDERLINE_ON}${text}${UNDERLINE_OFF}`;
}
