// T168 (ADR-0031, decisions 8–10) — Lykos's own `edit`: Pi's exact text
// replacement, plus `replaceAll`, plus the `old_string` argument shape.
//
// **Why Lykos owns it at all.** Pi's `edit` cannot say "every occurrence", and
// a rename is the commonest multi-site change there is: without `replaceAll`
// the model sends one edit per site and pays for a unique `oldText` at each.
// Everything else about Pi's tool is right and is kept — the schema
// (`{path, edits: [{oldText, newText}]}`), BOM and line-ending handling, the
// exact-then-normalized match, uniqueness, overlap and no-change errors with
// Pi's own wording, the one-line result, and the `details` the interface
// renders. `tools/edit-match.ts` is the port of Pi's matching and carries the
// provenance, because Pi does not export it. The two things Lykos takes from
// Pi's exports are `withFileMutationQueue` (same-file calls are serialised
// exactly as Pi's are) and `generateDiffString` / `generateUnifiedPatch` (the
// `details` the renderer consumes).
//
// **What this replaces.** From P10.3 until T168 this file was an anchored,
// line-numbered editor that addressed lines inside a content-hashed snapshot.
// Pi's `read` printed no line numbers, an edit returned no fresh ones, and the
// model counted by hand: in the P4 demonstration runs 3 of 6 post-edit checks
// failed in both, and run 1's first edit deleted `loadPrices`. Every edit in
// those runs was a tool-level success, so `loop/edit-retry.ts` read zero
// failures. ADR-0031 records why one text-replacement mode with a numbered
// `read` is the answer, and why there is no second mode.
//
// **Gated exactly as before.** The write goes through `buildEditOperations()`,
// the same `EditOperations` Pi's gated edit was built with: the same
// `authorize()` call, the same `{ kind: "edit" }` operation, the same scope
// clamp and risk tier, with the whole new file as the approval body. A tool
// does not become cheaper to approve by being rewritten. The tool keeps the
// name `edit` and the argument `path`, which is what the post-edit loop, the
// checkpoint hook, the session gate, `edited_files`, `computeHitQuality` and
// `isFileChangingCall` all key on.
//
// **Renderers are Pi's.** The definition is spread from
// `createEditToolDefinition`, so `renderCall` and `renderResult` are Pi's, and
// they read `details.diff` and `details.firstChangedLine`, which this tool sets
// in the same shape. Lykos's own interface (`tui/`) reads the call's
// `edits[].oldText`/`newText` and the result's text. One exception: Pi's
// `renderCall` previews the diff with Pi's own matcher, which knows no
// `replaceAll` and would show a valid rename as a red "Found N occurrences"
// until the result arrived. A call with `replaceAll` gets no preview, and
// the result's real diff is shown when it lands.
//
// **`edit.require_read` (T168 part B, decision 11).** When the session's
// `FileReadRecord` says reads are required, the file's bytes are checked against
// the record right after they are read and BEFORE any matching, so an unread or
// changed file is rejected with nothing written and, above all, before the
// approval gate is asked: the gate sits inside `ops.writeFile`, which a rejected
// call never reaches. A rejection is an ordinary thrown error, which Pi turns
// into an error tool result the model can recover from by reading. After a
// successful write the record is updated to the bytes just written, so the
// model's own consecutive edits to a file pass without a re-read. The record is
// per session (`tools/read-record.ts`) and is passed in `EditToolOpts` beside
// `gate` and `denials`.

import { isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  createEditToolDefinition,
  generateDiffString,
  generateUnifiedPatch,
  withFileMutationQueue,
  type EditToolDetails,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { buildEditOperations, type ApprovalGate, type DenialLog } from "../gate/approval.js";
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  normalizeToLF,
  prepareEditArguments,
  restoreLineEndings,
  splitBom,
  type TextEdit,
} from "./edit-match.js";
import { REQUIRE_READ_SENTENCE, type FileReadRecord } from "./read-record.js";

export const EDIT_TOOL_NAME = "edit";

/**
 * The model-facing contract. Exported so `ledger/tool-catalog.ts` can be
 * asserted equal to it rather than re-typed next to it — a catalog entry that
 * drifts from the tool mis-prices the tax for every session, silently. The
 * first three sentences are Pi's own.
 */
export const EDIT_DESCRIPTION =
  "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping " +
  "region of the original file. If two changes affect the same block or nearby lines, merge them into one edit " +
  "instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes. " +
  "To replace every occurrence of a text (a rename), set replaceAll on that entry: it matches exact text only and " +
  "fails if the text is not there. oldText is the file's text as it is, never read's line-number prefix.";

export const EDIT_PARAMETERS = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({
        description:
          "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call. With replaceAll it may occur any number of times, but at least once.",
      }),
      newText: Type.String({ description: "Replacement text for this targeted edit." }),
      replaceAll: Type.Optional(
        Type.Boolean({
          description:
            "Replace every exact occurrence of oldText instead of requiring it to be unique. Exact match only; an error if there is none.",
        }),
      ),
    }),
    {
      description:
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
    },
  ),
});

export const EDIT_PROMPT_SNIPPET =
  "Make precise file edits with exact text replacement, including multiple disjoint edits in one call";

/** Pi's four guidelines, then Lykos's two. */
export const EDIT_PROMPT_GUIDELINES: readonly string[] = [
  "Use edit for precise changes (edits[].oldText must match exactly)",
  "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
  "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
  "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
  "Use replaceAll on an entry to rename or replace every occurrence of a text in one edit, instead of one edit per site.",
  "Never put read's line numbers, or the tab after them, in oldText or newText: they are not in the file.",
];

export interface EditToolOpts {
  cwd: string;
  gate: ApprovalGate;
  denials?: DenialLog;
  /** T168 part B: this session's read record. Absent, nothing is checked or kept. */
  reads?: FileReadRecord;
}

/**
 * Pi's `resolveToCwd`, which it does not export: unicode spaces folded, a
 * leading `@` stripped, Git Bash / MSYS / WSL drive paths on Windows,
 * `~`, `file://`, then resolved against the session's cwd. Without it the
 * same `path` would name one file for `read` and another for `edit`.
 */
export function resolveEditPath(given: string, cwd: string): string {
  let p = given.replace(/[  -   　]/g, " ");
  if (p.startsWith("@")) p = p.slice(1);
  if (process.platform === "win32" && p.startsWith("/") && !p.startsWith("//") && !p.includes("\\")) {
    const m = p.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (m) p = `${m[1]!.toUpperCase()}:\\${m[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (p === "~") p = homedir();
  else if (p.startsWith("~/") || (process.platform === "win32" && p.startsWith("~\\"))) p = resolve(homedir(), p.slice(2));
  if (/^file:\/\//.test(p)) p = fileURLToPath(p);
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

interface EditInput {
  path: string;
  edits: TextEdit[];
}

function validateEditInput(input: { path: string; edits?: unknown }): EditInput {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
  }
  return { path: input.path, edits: input.edits as TextEdit[] };
}

/** Does the call ask for `replaceAll`, in either argument shape? Pi's preview cannot render it. */
export function hasReplaceAll(args: unknown): boolean {
  if (typeof args !== "object" || args === null) return false;
  const a = args as { edits?: unknown; replace_all?: unknown; replaceAll?: unknown };
  if (a.replace_all === true || a.replaceAll === true) return true;
  return Array.isArray(a.edits) && a.edits.some((e) => typeof e === "object" && e !== null && (e as { replaceAll?: unknown }).replaceAll === true);
}

/** The result sentence: Pi's, unless a `replaceAll` entry made the count something other than the number of entries. */
export function successText(path: string, edits: number, replacements: number, anyReplaceAll: boolean): string {
  if (!anyReplaceAll) return `Successfully replaced ${edits} block(s) in ${path}.`;
  const noun = replacements === 1 ? "occurrence" : "occurrences";
  if (edits === 1) return `Successfully replaced ${replacements} ${noun} in ${path}.`;
  return `Successfully replaced ${replacements} ${noun} across ${edits} edits in ${path}.`;
}

export function buildEditTool(opts: EditToolOpts): ToolDefinition {
  // The same operations object Pi's gated edit was built with: one approval
  // path, one scope clamp, one place that records a denial.
  const ops = buildEditOperations(opts.cwd, opts.gate, opts.denials);
  const base = createEditToolDefinition(opts.cwd, { operations: ops }) as unknown as ToolDefinition;

  return {
    ...base,
    name: EDIT_TOOL_NAME,
    // Byte-identical to `EDIT_DESCRIPTION` unless `edit.require_read` is on, so
    // the pinned tool-schema figures describe the default session exactly.
    description: opts.reads?.requireRead === true ? `${EDIT_DESCRIPTION}${REQUIRE_READ_SENTENCE}` : EDIT_DESCRIPTION,
    promptSnippet: EDIT_PROMPT_SNIPPET,
    promptGuidelines: [...EDIT_PROMPT_GUIDELINES],
    parameters: EDIT_PARAMETERS,
    prepareArguments: prepareEditArguments,
    renderCall(args: unknown, theme: unknown, context: { argsComplete: boolean }) {
      const render = base.renderCall as (args: unknown, theme: unknown, context: unknown) => unknown;
      return render(args, theme, hasReplaceAll(args) ? { ...context, argsComplete: false } : context);
    },
    async execute(_toolCallId: string, input: { path: string; edits?: unknown }, signal?: AbortSignal) {
      const { path, edits } = validateEditInput(input);
      const absolutePath = resolveEditPath(path, opts.cwd);
      return withFileMutationQueue(absolutePath, async () => {
        // Do not reject from an abort event listener here: that would release the
        // mutation queue while an in-flight filesystem operation may still finish.
        const throwIfAborted = (): void => {
          if (signal?.aborted) throw new Error("Operation aborted");
        };
        throwIfAborted();

        try {
          await ops.access(absolutePath);
        } catch (error) {
          throwIfAborted();
          const errorMessage = error instanceof Error && "code" in error ? `Error code: ${(error as { code?: string }).code}` : String(error);
          throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
        }
        throwIfAborted();

        const rawBytes = await ops.readFile(absolutePath);
        throwIfAborted();
        // Before matching, before the approval gate, before any write.
        opts.reads?.check(absolutePath, rawBytes, path);
        const rawContent = rawBytes.toString("utf-8");

        // Strip the BOM before matching: the model will not include an invisible one in oldText.
        const { bom, text: content } = splitBom(rawContent);
        const originalEnding = detectLineEnding(content);
        const normalizedContent = normalizeToLF(content);
        const applied = applyEditsToNormalizedContent(normalizedContent, edits, path);
        throwIfAborted();

        const finalContent = bom + restoreLineEndings(applied.newContent, originalEnding);
        await ops.writeFile(absolutePath, finalContent);
        // The file now holds exactly what was written, which the model has seen in the diff it asked for.
        opts.reads?.noteWritten(absolutePath, finalContent);
        throwIfAborted();

        const diffResult = generateDiffString(applied.baseContent, applied.newContent);
        const patch = generateUnifiedPatch(path, applied.baseContent, applied.newContent);
        const details: EditToolDetails = {
          diff: diffResult.diff,
          patch,
          ...(diffResult.firstChangedLine !== undefined ? { firstChangedLine: diffResult.firstChangedLine } : {}),
        };
        return {
          content: [
            {
              type: "text" as const,
              text: successText(path, edits.length, applied.replacements, applied.anyReplaceAll),
            },
          ],
          details,
        };
      });
    },
  } as unknown as ToolDefinition;
}

