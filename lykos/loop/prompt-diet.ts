// T21 — prompt diet: lean, not short (`docs/10-phase2-tasks.md`,
// `02-plan.md` §4 D2.2).
//
// The rule is not "make the prompt smaller." Content that prevents a search
// belongs in the cached head (cache-read rates). Content the model will
// rediscover anyway does not belong at all.
//
//   T21.1  Rules stated once. A frozen diet block in appendSystemPrompt,
//          closed over at boot, never restated on follow_up. Unchanged
//          file content is stubbed at tool_result time so a second read
//          of the same bytes never enters history.
//   T21.2  Tight tool-result formatting. Byte caps with an explicit
//          `[lykos-trunc:]` marker, applied on Pi's documented
//          `tool_result` hook as the result is produced — not on the
//          `context` hook, which would rewrite already-cached messages
//          (T19: that busts the prefix T17 just stabilised). Pi tools
//          are not rewritten (AGENTS.md rule 3).
//   T21.3  AGENTS.md is first-class alongside CLAUDE.md. Pi 0.84.3's
//          loadContextFileFromDir is XOR per directory (first of
//          AGENTS.override.md / AGENTS.md / CLAUDE.md). This walk loads
//          both AGENTS.md and CLAUDE.md when both exist. Frozen at boot
//          via agentsFilesOverride. No new tool.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** Tighter than Pi's built-in 50KB live cap; larger than T19's 16KB stale snip. */
export const DEFAULT_TOOL_RESULT_MAX_BYTES = 32_768;

export const DIET_HEADING = "## lykos-diet";

export const TRUNC_MARKER_PREFIX = "[lykos-trunc:";

/**
 * T23 — output diet: a required default on budget/cheap-worker presets, not
 * a global rule (`docs/10-phase2-tasks.md`, `02-plan.md` §4 D2.2's output
 * half). Kept as its own frozen block, separate from T21's `## lykos-diet`:
 * that block states *format* rules true for every specialist; this one states
 * a *behavioural* rule that is not, and a preset that disables output_diet
 * still gets the format discipline. One line, nothing else — no hooks, no
 * intensity modes, no decision ladder (DECISIONS.md 2026-08-29, "the
 * lazy senior developer" review).
 *
 * **Specialists ticket 03**: this block's original text — "Follow YAGNI
 * principles, and one-liner solutions." — restated exactly what the
 * `## lykos-ponytail` block's rungs 1 and 6 now say (`session/ponytail-head.ts`),
 * and the spec is explicit that nothing may be stated twice between the two.
 * The ponytail block is the one sourced verbatim from an external project and
 * carries the fuller, authoritative statement, so the duplicate was removed
 * from HERE rather than from ponytail's text. This block keeps its heading
 * and its `LYKOS_OUTPUT_DIET` flag (so a session's ledger record of whether
 * output diet was in force is unaffected) but no longer restates content the
 * ponytail block already owns.
 */
export const OUTPUT_DIET_HEADING = "## lykos-output-diet";

export function assembleOutputDietHead(): string {
  return [
    OUTPUT_DIET_HEADING,
    "YAGNI and one-line-solution rules live in the ponytail block; not restated here.",
  ].join("\n");
}

export function outputDietEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LYKOS_OUTPUT_DIET !== "0";
}

/**
 * T63 removed `EXPLORATION_TOOL_NAMES` and `countExplorationToolCalls` from
 * this module. The reasoning recorded here — "bash is deliberately absent:
 * after T20 it also runs tests and git, so counting it as exploration would
 * confound the proxy" — had the fact right and the conclusion backwards.
 * T20 moved grep/find/ls *onto* bash, so excluding bash did not avoid a
 * confound; it deleted the measurement. See `lykos/loop/exploration.ts`,
 * which classifies bash by command word instead, and keeps the v1 name list
 * as `EXPLORATION_TOOL_NAMES_V1` so `explore_metric_version = 1` still means
 * something specific.
 */

export type ContextFileKind = "AGENTS.override.md" | "AGENTS.md" | "CLAUDE.md";

export interface ContextFile {
  path: string;
  content: string;
  kind: ContextFileKind;
  bytes: number;
}

export interface ContextFileMeta {
  path: string;
  name: string;
  kind: ContextFileKind;
  bytes: number;
}

export interface DietPolicy {
  enabled: boolean;
  toolResultMaxBytes: number;
}

export interface ToolResultEvent {
  toolName: string;
  input?: unknown;
  content?: unknown;
  details?: unknown;
  isError?: boolean;
}

export interface DietToolResult {
  content: unknown;
  details?: unknown;
  truncated: boolean;
  unchanged: boolean;
  originalBytes: number;
  keptBytes: number;
}

/**
 * T21.1: the lean rules, stated once, frozen at boot. No cwd, no clock, no
 * git — those already live in the T17 boot block. Context-file bodies go
 * through Pi's `<project_context>` via agentsFilesOverride, not here.
 */
export function assembleDietHead(): string {
  return [
    DIET_HEADING,
    "Rules live in this head and in <project_context>. Do not restate them.",
    "Do not resend unchanged file content; cite the path.",
    "Tool results may be truncated; a [lykos-trunc:] marker means the body is incomplete.",
  ].join("\n");
}

export function resolveDietPolicy(input: { enabled?: unknown; toolResultMaxBytes?: unknown } = {}): DietPolicy {
  const enabled = input.enabled === false || input.enabled === 0 || input.enabled === "0" ? false : true;
  return {
    enabled,
    toolResultMaxBytes: positiveInt(input.toolResultMaxBytes, DEFAULT_TOOL_RESULT_MAX_BYTES),
  };
}

function positiveInt(value: unknown, fallback: number): number {
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Prefix of `text` whose UTF-8 encoding is at most `maxBytes`, never splitting a code point. */
export function utf8Prefix(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString("utf8");
}

/** Suffix of `text` whose UTF-8 encoding is at most `maxBytes`. */
export function utf8Suffix(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString("utf8");
}

export function truncationMarker(keptBytes: number, totalBytes: number): string {
  return `${TRUNC_MARKER_PREFIX} kept ${keptBytes} of ${totalBytes} bytes]`;
}

export function unchangedMarker(path: string): string {
  return `${TRUNC_MARKER_PREFIX} unchanged; identical to earlier read of ${path}]`;
}

function truncKind(name: string): "head" | "tail" | "both" {
  // T84: command output gets "both", not "tail". The tail carries the
  // summary and the exit status; the head carries which command ran and the
  // first error. Reads and searches keep "head" — a file's beginning is
  // where its imports and signatures are, and its end rarely explains it.
  return name === "bash" || name === "powershell" ? "both" : "head";
}

/**
 * T84: the live tool-result cap, resolved from the environment in ONE place.
 * `head-view.ts` (what `lykos prompt --show` prints) and `session/session.ts`
 * (what actually clamps) must never disagree about this number — a reported
 * cap that is not the enforced cap is worse than no report at all.
 */
export function toolResultMaxBytesFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.LYKOS_TOOL_RESULT_MAX_BYTES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TOOL_RESULT_MAX_BYTES;
}

/**
 * Cap a tool-result body. `kind` "head" keeps the start (reads, search);
 * "tail" keeps the end (logs, command output); "both" keeps each end with
 * the middle elided (T84). The marker is always explicit — a silent partial
 * is the failure T21.2 exists to prevent.
 */
export function capToolResultText(
  text: string,
  maxBytes: number,
  kind: "head" | "tail" | "both" = "head",
): {
  text: string;
  truncated: boolean;
  originalBytes: number;
  keptBytes: number;
} {
  const originalBytes = utf8ByteLength(text);
  if (maxBytes <= 0 || originalBytes <= maxBytes) {
    return { text, truncated: false, originalBytes, keptBytes: originalBytes };
  }
  // T84: "both" keeps the start AND the end with the middle elided. Neither
  // one-sided mode is right for a long command: a head-only cut throws away
  // the failure summary and the exit status, and a tail-only cut throws away
  // which command ran and the first error — which is usually the real one,
  // every later error being its consequence. Splitting the budget costs
  // nothing extra and stops the model reasoning from half the evidence.
  if (kind === "both") {
    const headBytes = Math.floor(maxBytes / 2);
    const tailBytes = maxBytes - headBytes;
    const head = utf8Prefix(text, headBytes);
    const tail = utf8Suffix(text, tailBytes);
    const keptBytes = utf8ByteLength(head) + utf8ByteLength(tail);
    const marker = truncationMarker(keptBytes, originalBytes);
    return { text: `${head}\n${marker}\n${tail}`, truncated: true, originalBytes, keptBytes };
  }
  const kept = kind === "tail" ? utf8Suffix(text, maxBytes) : utf8Prefix(text, maxBytes);
  const keptBytes = utf8ByteLength(kept);
  const marker = truncationMarker(keptBytes, originalBytes);
  const body = kind === "tail" ? `${marker}\n${kept}` : `${kept}\n${marker}`;
  return { text: body, truncated: true, originalBytes, keptBytes };
}

export function toolResultText(event: ToolResultEvent): string {
  const content = event.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
        parts.push((block as { text: string }).text);
      }
    }
    if (parts.length > 0) return parts.join("");
  }
  const details = event.details;
  if (details && typeof details === "object" && typeof (details as { output?: unknown }).output === "string") {
    return (details as { output: string }).output;
  }
  return "";
}

function setToolResultText(event: ToolResultEvent, text: string): { content: unknown; details?: unknown } {
  const content = [{ type: "text", text }];
  const details = event.details;
  if (details && typeof details === "object" && !Array.isArray(details) && "output" in details) {
    return { content, details: { ...(details as Record<string, unknown>), output: text } };
  }
  return { content, ...(details !== undefined ? { details } : {}) };
}

function readPathFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const rec = input as Record<string, unknown>;
  for (const key of ["path", "file", "target"]) {
    const v = rec[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Session-local diet for live tool results (T21.1 unchanged-file + T21.2 cap).
 * Applied once as the result is produced, so the truncated form is what
 * gets cached. Does not mutate earlier messages.
 */
export class ToolResultDiet {
  private readonly maxBytes: number;
  private readonly seenReads = new Map<string, string>();
  truncatedResults = 0;
  unchangedStubs = 0;

  constructor(maxBytes: number = DEFAULT_TOOL_RESULT_MAX_BYTES) {
    this.maxBytes = maxBytes;
  }

  apply(event: ToolResultEvent): DietToolResult {
    const original = toolResultText(event);
    const originalBytes = utf8ByteLength(original);
    const path = event.toolName === "read" ? readPathFromInput(event.input) : undefined;
    if (path && originalBytes > 0) {
      const hash = contentHash(original);
      const prev = this.seenReads.get(path);
      if (prev === hash) {
        const stub = unchangedMarker(path);
        this.unchangedStubs += 1;
        const patched = setToolResultText(event, stub);
        return {
          content: patched.content,
          ...(patched.details !== undefined ? { details: patched.details } : {}),
          truncated: true,
          unchanged: true,
          originalBytes,
          keptBytes: utf8ByteLength(stub),
        };
      }
      this.seenReads.set(path, hash);
    }
    const capped = capToolResultText(original, this.maxBytes, truncKind(event.toolName));
    if (capped.truncated) this.truncatedResults += 1;
    const patched = setToolResultText(event, capped.text);
    return {
      content: patched.content,
      ...(patched.details !== undefined ? { details: patched.details } : {}),
      truncated: capped.truncated,
      unchanged: false,
      originalBytes: capped.originalBytes,
      keptBytes: capped.keptBytes,
    };
  }
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function readContextFile(path: string, kind: ContextFileKind): ContextFile | null {
  try {
    const content = stripBom(readFileSync(path, "utf8"));
    return { path, content, kind, bytes: utf8ByteLength(content) };
  } catch {
    return null;
  }
}

function realPathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * One directory's context files. Pi 0.84.3 picks the first of
 * AGENTS.override.md / AGENTS.md / AGENTS.MD / CLAUDE.md / CLAUDE.MD.
 * T21.3 loads AGENTS.md and CLAUDE.md both, when both exist.
 * AGENTS.override.md still replaces the other two in that directory.
 */
export function loadContextFilesFromDir(dir: string): ContextFile[] {
  const override = join(dir, "AGENTS.override.md");
  if (isFile(override)) {
    const file = readContextFile(override, "AGENTS.override.md");
    return file ? [file] : [];
  }
  const out: ContextFile[] = [];
  const seenKinds = new Set<ContextFileKind>();
  for (const [name, kind] of [
    ["AGENTS.md", "AGENTS.md"],
    ["AGENTS.MD", "AGENTS.md"],
    ["CLAUDE.md", "CLAUDE.md"],
    ["CLAUDE.MD", "CLAUDE.md"],
  ] as const) {
    const path = join(dir, name);
    if (!isFile(path)) continue;
    if (seenKinds.has(kind)) continue;
    if (out.some((f) => realPathOr(f.path) === realPathOr(path))) continue;
    const file = readContextFile(path, kind);
    if (file) {
      seenKinds.add(kind);
      out.push(file);
    }
  }
  return out;
}

export interface IngestContextFilesOpts {
  cwd: string;
  /** Pi's agent dir (the Lykos pi-host, ADR-0027; `config/pi-host.ts`). Global AGENTS.md lives here. */
  agentDir?: string;
}

/**
 * Walk matching Pi's loadProjectContextFiles: global agentDir first, then
 * ancestors from filesystem root toward cwd. Per directory, T21.3's AND
 * rather than Pi's XOR. Identical bodies across the walk are kept once
 * (T21.1: do not restate). Contents are whatever is on disk at the call —
 * the caller freezes the result at boot (T17.2).
 */
export function ingestContextFiles(opts: IngestContextFilesOpts): ContextFile[] {
  const cwd = resolve(opts.cwd);
  const out: ContextFile[] = [];
  const seenPaths = new Set<string>();
  const seenHashes = new Set<string>();

  const consider = (files: ContextFile[]) => {
    for (const file of files) {
      const real = realPathOr(file.path);
      if (seenPaths.has(real)) continue;
      const hash = contentHash(file.content);
      if (seenHashes.has(hash)) continue;
      seenPaths.add(real);
      seenHashes.add(hash);
      out.push(file);
    }
  };

  if (opts.agentDir) consider(loadContextFilesFromDir(resolve(opts.agentDir)));

  const stack: string[] = [];
  let current = cwd;
  while (true) {
    stack.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (let i = stack.length - 1; i >= 0; i--) consider(loadContextFilesFromDir(stack[i]!));

  return out;
}

export function contextFileMeta(files: readonly ContextFile[]): ContextFileMeta[] {
  return files.map((f) => ({ path: f.path, name: basename(f.path), kind: f.kind, bytes: f.bytes }));
}

/** Shape DefaultResourceLoader.agentsFilesOverride consumes. */
export function toAgentsFiles(files: readonly ContextFile[]): Array<{ path: string; content: string }> {
  return files.map((f) => ({ path: f.path, content: f.content }));
}

export function dietEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LYKOS_PROMPT_DIET !== "0";
}
