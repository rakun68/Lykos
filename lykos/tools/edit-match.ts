// T168 (ADR-0031) — exact text replacement for `edit`: Pi's matching, plus `replaceAll`.
//
// **Provenance.** `normalizeForFuzzyMatch`, `fuzzyFindText`, the replacement
// planner, `applyReplacementsPreservingUnchangedLines`, the `normalizeToLF` /
// `restoreLineEndings` / `detectLineEnding` trio and every error sentence are a
// port of `dist/core/tools/edit-diff.js` in `@earendil-works/pi-coding-agent`
// 0.84.3 (MIT, Mario Zechner; the package ships no LICENSE file, its
// `package.json` says `"license": "MIT"`). Pi does not export any of them — it
// exports only `generateDiffString` and `generateUnifiedPatch` — and
// "translate at the boundary, never patch Pi" (AGENTS.md rule 7) rules out
// importing from `dist/`, so this is a copy. The copy exists so that `edit` can
// carry one thing Pi's does not (`replaceAll`) while behaving identically to it
// in every other case; `edit-match.test.ts` pins that behaviour case by case.
// When Pi is upgraded, diff this file against its `edit-diff.js` first.
//
// **What is Lykos's own.** The `replaceAll` flag, and the rules around it:
//
// - An entry with `replaceAll` is matched EXACTLY, with no fuzzy fallback.
//   Fuzzy matching decides which text the model meant when it mis-transcribed
//   whitespace or a quote; a rename has no such doubt, and "every occurrence"
//   of text that is only approximately there is not a thing the tool can say
//   truthfully.
// - Zero exact occurrences is an error, never a quiet no-op.
// - Every occurrence is a separate replacement, so the overlap rule applies to
//   it against every other entry exactly as it does between Pi's entries.
// - A call cannot mix a `replaceAll` entry with an entry that needed the fuzzy
//   fallback. Fuzzy matching runs the whole file through
//   `normalizeForFuzzyMatch`, which is not length-preserving, so a position an
//   exact scan finds in the original file is not a position in the normalized
//   one, and translating between the two would be a guess. The call is
//   refused with an instruction to split it; nothing is written.

export type LineEnding = "\n" | "\r\n";

/** One replacement as the model sent it. */
export interface TextEdit {
  oldText: string;
  newText: string;
  /** Replace every exact occurrence of `oldText`, not one unique one. */
  replaceAll?: boolean;
}

export function detectLineEnding(content: string): LineEnding {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1) return "\n";
  if (crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: LineEnding): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/** Split a leading UTF-8 byte order mark from decoded text. Pi's `splitBom`, which it does not export. */
export function splitBom(content: string): { bom: string; text: string } {
  return content.startsWith("﻿") ? { bom: "﻿", text: content.slice(1) } : { bom: "", text: content };
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * trailing whitespace stripped per line, smart quotes to ASCII, Unicode
 * dashes to a hyphen, special Unicode spaces to a regular space. Leading
 * indentation is NOT normalized, so a tab reproduced as spaces still misses.
 */
export function normalizeForFuzzyMatch(text: string): string {
  return (
    text
      .normalize("NFKC")
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .replace(/[‘’‚‛]/g, "'")
      .replace(/[“”„‟]/g, '"')
      .replace(/[‐‑‒–—―−]/g, "-")
      .replace(/[  -   　]/g, " ")
  );
}

interface Span {
  start: number;
  end: number;
}

interface Replacement {
  /** Index into the call's `edits[]`, for error messages. */
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
}

function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

function getLineSpans(content: string): Span[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function getReplacementLineRange(lines: Span[], replacement: Replacement): { startLine: number; endLine: number } {
  const replacementStart = replacement.matchIndex;
  const replacementEnd = replacement.matchIndex + replacement.matchLength;
  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (replacementStart >= line.start && replacementStart < line.end) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) throw new Error("Replacement range is outside the base content.");
  let endLine = startLine;
  while (endLine < lines.length && lines[endLine]!.end < replacementEnd) endLine++;
  if (endLine >= lines.length) throw new Error("Replacement range is outside the base content.");
  return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: readonly Replacement[], offset = 0): string {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i]!;
    const matchIndex = replacement.matchIndex - offset;
    result = result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
  }
  return result;
}

/**
 * Apply replacements matched against `baseContent` to `originalContent` while
 * preserving unchanged line blocks from the original. `baseContent` is a
 * normalized view of the original: each replacement is widened to the lines it
 * touches, those lines are rewritten from the normalized base, and every other
 * line is copied back from the original, so a fuzzy edit does not rewrite the
 * whitespace of lines it never touched.
 */
export function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: readonly Replacement[],
): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    throw new Error("Cannot preserve unchanged lines because the base content has a different line count.");
  }
  const groups: { startLine: number; endLine: number; replacements: Replacement[] }[] = [];
  const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
  for (const replacement of sortedReplacements) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
      continue;
    }
    groups.push({ ...range, replacements: [replacement] });
  }
  let originalLineIndex = 0;
  let result = "";
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join("");
    const groupStartOffset = baseLines[group.startLine]!.start;
    const groupEndOffset = baseLines[group.endLine - 1]!.end;
    result += applyReplacements(baseContent.slice(groupStartOffset, groupEndOffset), group.replacements, groupStartOffset);
    originalLineIndex = group.endLine;
  }
  result += originalLines.slice(originalLineIndex).join("");
  return result;
}

interface FuzzyMatch {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
}

/** Find `oldText` in `content`, trying an exact match first and then a match in fuzzy-normalized space. */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatch {
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false };
  }
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
  if (fuzzyIndex === -1) return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false };
  // Offsets are in normalized space; the caller works in normalized content.
  return { found: true, index: fuzzyIndex, matchLength: fuzzyOldText.length, usedFuzzyMatch: true };
}

/**
 * Pi counts occurrences in fuzzy-normalized space even when the match itself
 * was exact, so a text that occurs once exactly and once with different
 * trailing whitespace is "not unique". Kept, because the two tools must agree.
 */
function countOccurrences(content: string, oldText: string): number {
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  return fuzzyContent.split(fuzzyOldText).length - 1;
}

/** Every non-overlapping exact occurrence of `needle`, left to right. `needle` is never empty here. */
function exactOccurrences(content: string, needle: string): number[] {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const at = content.indexOf(needle, from);
    if (at === -1) return found;
    found.push(at);
    from = at + needle.length;
  }
}

// The leading words of three failures, shared with `tools/edit-failure.ts` so the
// classifier `lykos show` uses matches the very strings thrown here rather than
// a second copy of them. The classifier's tests also drive the real errors.
/** A single-edit call's not-found error opens with this, then the path. */
export const NOT_FOUND_SINGLE_PREFIX = "Could not find the exact text in ";
/** A multi-edit call's not-found error opens with this, then the index. */
export const NOT_FOUND_MULTI_PREFIX = "Could not find edits[";
/** Between the two indices (and before the path) in an overlap error. */
export const OVERLAP_MARKER = " overlap in ";
/** Opens a not-unique error: `Found 3 occurrences of ...`. */
export function occurrencesPrefix(occurrences: number): string {
  return `Found ${occurrences} occurrences of `;
}

function notFoundError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `${NOT_FOUND_SINGLE_PREFIX}${path}. The old text must match exactly including all whitespace and newlines.`,
    );
  }
  return new Error(
    `${NOT_FOUND_MULTI_PREFIX}${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
  );
}

function duplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `${occurrencesPrefix(occurrences)}the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
    );
  }
  return new Error(
    `${occurrencesPrefix(occurrences)}edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
  );
}

function emptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
  if (totalEdits === 1) return new Error(`oldText must not be empty in ${path}.`);
  return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function noChangeError(path: string, totalEdits: number): Error {
  if (totalEdits === 1) {
    return new Error(
      `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
    );
  }
  return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/** Lykos's own: a `replaceAll` entry whose text is not in the file exactly. Pi's sentence, plus the reason there is no fuzzy retry. */
function replaceAllNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
  const base = notFoundError(path, editIndex, totalEdits).message;
  return new Error(`${base} replaceAll matches exact text only, with no whitespace or quote folding.`);
}

export interface AppliedEdits {
  /** The LF-normalized original, which `generateDiffString` compares `newContent` to. */
  baseContent: string;
  newContent: string;
  /** Replacements made, counting every occurrence a `replaceAll` entry hit. */
  replacements: number;
  /** Occurrences hit per entry, in `edits[]` order: 1 for a plain entry. */
  perEdit: number[];
  /** Whether any entry carried `replaceAll`, which is what changes the shape of the result sentence. */
  anyReplaceAll: boolean;
}

/**
 * Apply one or more replacements to LF-normalized content. Every entry is
 * matched against the same original content, and the replacements are then
 * applied back to front so offsets stay stable. If a plain entry needed the
 * fuzzy fallback, the operation runs in fuzzy-normalized space and overlays
 * those line-level changes onto the original, so unchanged lines keep their
 * bytes.
 */
export function applyEditsToNormalizedContent(
  normalizedContent: string,
  edits: readonly TextEdit[],
  path: string,
): AppliedEdits {
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
    replaceAll: edit.replaceAll === true,
  }));
  const total = normalizedEdits.length;

  for (let i = 0; i < total; i++) {
    if (normalizedEdits[i]!.oldText.length === 0) throw emptyOldTextError(path, i, total);
  }

  const initialMatches = normalizedEdits.map((edit) => (edit.replaceAll ? undefined : fuzzyFindText(normalizedContent, edit.oldText)));
  const usedFuzzyMatch = initialMatches.some((match) => match?.usedFuzzyMatch === true);
  const anyReplaceAll = normalizedEdits.some((edit) => edit.replaceAll);
  if (usedFuzzyMatch && anyReplaceAll) {
    const fuzzyIndex = initialMatches.findIndex((match) => match?.usedFuzzyMatch === true);
    throw new Error(
      `edits[${fuzzyIndex}] in ${path} only matches after whitespace or quote folding, and a call cannot mix that with a replaceAll edit. ` +
        `Copy edits[${fuzzyIndex}].oldText exactly as it appears in the file, or send the replaceAll edit in its own call. Nothing was written.`,
    );
  }
  const replacementBaseContent = usedFuzzyMatch ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;

  const matched: Replacement[] = [];
  const perEdit: number[] = [];
  for (let i = 0; i < total; i++) {
    const edit = normalizedEdits[i]!;
    if (edit.replaceAll) {
      const at = exactOccurrences(replacementBaseContent, edit.oldText);
      if (at.length === 0) throw replaceAllNotFoundError(path, i, total);
      for (const matchIndex of at) {
        matched.push({ editIndex: i, matchIndex, matchLength: edit.oldText.length, newText: edit.newText });
      }
      perEdit.push(at.length);
      continue;
    }
    const matchResult = fuzzyFindText(replacementBaseContent, edit.oldText);
    if (!matchResult.found) throw notFoundError(path, i, total);
    const occurrences = countOccurrences(replacementBaseContent, edit.oldText);
    if (occurrences > 1) throw duplicateError(path, i, total, occurrences);
    matched.push({ editIndex: i, matchIndex: matchResult.index, matchLength: matchResult.matchLength, newText: edit.newText });
    perEdit.push(1);
  }

  matched.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matched.length; i++) {
    const previous = matched[i - 1]!;
    const current = matched[i]!;
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}]${OVERLAP_MARKER}${path}. Merge them into one edit or target disjoint regions.`,
      );
    }
  }

  const baseContent = normalizedContent;
  const newContent = usedFuzzyMatch
    ? applyReplacementsPreservingUnchangedLines(normalizedContent, replacementBaseContent, matched)
    : applyReplacements(replacementBaseContent, matched);
  if (baseContent === newContent) throw noChangeError(path, total);

  return { baseContent, newContent, replacements: matched.length, perEdit, anyReplaceAll };
}

// ---------------------------------------------------------------------------
// Argument shapes
// ---------------------------------------------------------------------------

function isSingleEditInput(value: unknown): value is { oldText: string; newText: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const edit = value as Record<string, unknown>;
  return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

const OLD_STRING_KEYS = ["old_string", "new_string", "replace_all"] as const;

/**
 * Pi's `prepareEditArguments`, extended with the `old_string` argument shape
 * (ADR-0031 decision 10).
 *
 * Pi's repairs, verbatim in effect: `edits` sent as a JSON string, `edits` sent
 * as one edit object rather than an array, and a top-level `oldText`/`newText`
 * pair folded into `edits`. Lykos's: top-level `old_string` / `new_string` /
 * `replace_all` becomes ONE `edits[]` entry, and `file_path` (another
 * name for `path`) fills `path` when `path` is absent.
 *
 * The schema the model is shown never changes — this runs between the model's
 * arguments and the validator, so a model that has been trained on the
 * `old_string` shape and sends it gets the edit it asked for, and one that
 * reads the schema sends `edits[]`.
 *
 * Mixing the two shapes throws. Folding one into the other would be a guess
 * about which the model meant, and an edit applied on a guess is the one
 * failure a retry cannot undo.
 */
export function prepareEditArguments(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const args = input as Record<string, unknown>;

  const claudeKeys = OLD_STRING_KEYS.filter((k) => args[k] !== undefined);
  if (claudeKeys.length > 0) {
    const piKeys = ["edits", "oldText", "newText"].filter((k) => args[k] !== undefined);
    if (piKeys.length > 0) {
      throw new Error(
        `edit was given both the old_string shape (${claudeKeys.join(", ")}) and the edits[] shape (${piKeys.join(", ")}). ` +
          `Use one: either { path, edits: [{ oldText, newText, replaceAll? }] } or { path, old_string, new_string, replace_all? }.`,
      );
    }
    if (typeof args.old_string !== "string" || typeof args.new_string !== "string") {
      throw new Error("edit needs both old_string and new_string as strings when it is given the old_string shape.");
    }
    if (args.replace_all !== undefined && typeof args.replace_all !== "boolean") {
      throw new Error("edit's replace_all must be true or false.");
    }
    const { old_string, new_string, replace_all, ...rest } = args;
    const entry: Record<string, unknown> = { oldText: old_string, newText: new_string };
    if (replace_all === true) entry.replaceAll = true;
    const out: Record<string, unknown> = { ...rest, edits: [entry] };
    if (out.path === undefined && typeof out.file_path === "string") {
      out.path = out.file_path;
      delete out.file_path;
    }
    return out;
  }

  // Some models send edits as a JSON string instead of an array, or a single
  // edit object instead of a one-element array.
  if (typeof args.edits === "string") {
    try {
      const parsed: unknown = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
      else if (isSingleEditInput(parsed)) args.edits = [parsed];
    } catch {
      // Left as it was; the validator reports it.
    }
  } else if (isSingleEditInput(args.edits)) {
    args.edits = [args.edits];
  }

  const legacy = args as { oldText?: unknown; newText?: unknown; edits?: unknown };
  if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") return args;
  const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
  edits.push({ oldText: legacy.oldText, newText: legacy.newText });
  const { oldText: _oldText, newText: _newText, ...rest } = legacy as Record<string, unknown>;
  return { ...rest, edits };
}
