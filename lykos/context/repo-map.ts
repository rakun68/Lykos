// T69 — the repo map (`docs/20-phase9-tasks.md` §5, `02-plan.md` §11 Tier 1).
//
// **Built on instruction, not on evidence.** T67's gate returned HOLD — 30
// exploration calls and 0 file edits in the whole archive — and the
// maintainer directed the phase to continue anyway. So this ships OFF by
// default behind `flags.retrieval` (already `false` in `config.yaml`), and
// `DECISIONS.md` 2026-09-03 "T67" arms a kill criterion dated 2026-11-03.
// Rule 4 is not suspended because a build was instructed: this mechanism
// starts with no number and has to earn one.
//
// **Tier 1 only, and deliberately less than Tier 1 allows.** `problems/06`
// defines Tier 1 as repo map + file/symbol index + structured ripgrep +
// entry-point ranking. This is the repo map and the entry-point ranking and
// nothing else. `problems/06`'s own open question is *"how much of the
// benefit comes purely from the repo map — a single cached overview of
// structure — versus from query-time retrieval at all?"*, and the only way
// to answer it is to ship the map alone and look. A symbol index is a
// tree-sitter dependency and per-language work; that is Tier 2 and it does
// not begin until this is measured and found insufficient.
//
// **No model call, and no new tool schema.** The map is one frozen block in
// the head, not a tool the model calls — so it costs zero schema tokens, and
// T68's central finding (that `pi-fovea` would add ~797 schema tokens, +112%
// on a 711-token surface) does not apply to it. The cost is exactly the
// block's own tokens, once per session at cache-write rates and thereafter
// at cache-read.
//
// **Five rules, four of them inherited:**
//
//   1. **Frozen for the session** (T17). Built at boot, closed over, never
//      regenerated. It therefore does NOT update when the agent edits a
//      file — which is correct: the agent knows what it just changed, and a
//      block that changed mid-session would break the prefix on every call
//      and cost more than the exploration it replaces.
//   2. **Invalidated by content, not by clock.** The cache key is the git
//      HEAD plus a hash of the tracked file list. Harvested from `pi-fovea`
//      (`docs/21-pi-fovea-intake.md` §1 Q4): an edit from `bash`, from a
//      subagent, or from the user's editor has to look the same as an edit
//      from the `edit` tool, and only content hashing gives that.
//   3. **A hard token cap, enforced here.** `problems/06` mitigation 3, and
//      its early-warning signal is explicit: a map averaging more than
//      ~2,000 tokens has failed, because at that size it IS the context
//      pollution retrieval exists to remove. The default cap is 1,500.
//   4. **Truncation names what it dropped.** Also from `pi-fovea`: an
//      overflow footer that says how many entries were omitted is strictly
//      better than a silent cap, because the model can then ask rather than
//      assume it saw everything.
//   5. **`git ls-files` is the file source.** Deterministic, already
//      respects `.gitignore`, needs no walker and no new dependency, and is
//      the same set of files the maintainer means by "the repo". A repo with
//      no git gets no map rather than a guessed one.

import { hostGit } from "../git/host-git.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { estimateTokensChars4 } from "../ledger/tool-schema.js";

export const REPO_MAP_HEADING = "## lykos-repo-map";

/** `problems/06`'s early-warning signal is 2,000 tokens. The default sits below it on purpose. */
export const DEFAULT_MAX_TOKENS = 1500;
export const DEFAULT_MAX_FILES_PER_DIR = 6;
/** Bounded so the churn signal cannot turn boot into a git history walk. */
export const CHURN_COMMITS = 300;

export interface RepoMapPolicy {
  enabled: boolean;
  maxTokens: number;
  maxFilesPerDir: number;
}

export function resolveRepoMapPolicy(
  config: { enabled?: boolean; max_tokens?: number; max_files_per_dir?: number } | undefined,
): RepoMapPolicy {
  const cap = config?.max_tokens;
  const perDir = config?.max_files_per_dir;
  return {
    // T158 (ADR-0028): the caller decides from whether `lykos-repo-map` is
    // declared — the extension list is the only switch, so there is no
    // environment override any more (`LYKOS_REPO_MAP` is not read).
    enabled: config?.enabled === true,
    maxTokens: typeof cap === "number" && cap > 0 ? Math.floor(cap) : DEFAULT_MAX_TOKENS,
    maxFilesPerDir: typeof perDir === "number" && perDir > 0 ? Math.floor(perDir) : DEFAULT_MAX_FILES_PER_DIR,
  };
}

export interface RepoFile {
  path: string;
  /** Commits touching this file in the last CHURN_COMMITS commits. 0 when unknown. */
  churn: number;
}

export interface RankedFile extends RepoFile {
  score: number;
}

export interface DirEntry {
  dir: string;
  files: RankedFile[];
  totalFiles: number;
  /** Files not listed because of maxFilesPerDir. */
  omitted: number;
  score: number;
}

export interface RepoMap {
  text: string;
  tokens: number;
  /** Files represented in the rendered text. */
  files: number;
  /** Tracked files the render could not fit, for any reason. */
  dropped: number;
  /** How many whole directories fell off the token budget. Diagnostic only. */
  droppedDirs: number;
  /** Total tracked files. */
  tracked: number;
  /** HEAD + file-list hash. The cache key, and the invalidation signal. */
  sourceHash: string;
  enabled: boolean;
}

export function emptyRepoMap(enabled: boolean): RepoMap {
  return { text: "", tokens: 0, files: 0, dropped: 0, droppedDirs: 0, tracked: 0, sourceHash: "", enabled };
}

/**
 * Filenames that are where a reader starts. Ranked above everything else in
 * their directory regardless of size or churn — `problems/06`'s "entry-point
 * ranking", done with a list of names rather than an import graph, which is
 * Tier 2 and not begun.
 */
const ENTRY_POINT_NAMES = new Set([
  "index",
  "main",
  "app",
  "cli",
  "mod",
  "server",
  "init",
  "readme",
  "package.json",
  "cargo.toml",
  "go.mod",
  "pyproject.toml",
  "makefile",
  "dockerfile",
]);

/** Directories that exist but are not where anyone starts reading. Ranked last, never dropped first. */
const LOW_INTEREST_DIRS = /(^|\/)(node_modules|dist|build|out|vendor|\.git|coverage|fixtures?|__snapshots__)(\/|$)/;

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}

function stem(name: string): string {
  const i = name.indexOf(".");
  return (i > 0 ? name.slice(0, i) : name).toLowerCase();
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : ".";
}

const TEST_FILE = /(^|[./-])(test|tests|spec|__tests__)([./-]|$)/i;

/**
 * A file's rank within its directory. Deterministic and explainable — every
 * term is a fact about the path or about git, never a model's opinion.
 */
export function scoreFile(file: RepoFile): number {
  const name = baseName(file.path);
  let score = 0;
  if (ENTRY_POINT_NAMES.has(stem(name)) || ENTRY_POINT_NAMES.has(name.toLowerCase())) score += 100;
  // Churn is the one real relevance signal available without parsing: files
  // that changed recently are the files about to change again. Capped so a
  // single hot file cannot outrank an entry point.
  score += Math.min(file.churn, 40);
  // Shallow files are more likely to be the way in.
  score += Math.max(0, 12 - file.path.split("/").length * 3);
  // A test file is real, and it is not where you start reading.
  if (TEST_FILE.test(name)) score -= 25;
  if (LOW_INTEREST_DIRS.test(file.path)) score -= 200;
  return score;
}

/** Group into directories, rank within each, and rank the directories themselves. */
export function rankDirectories(files: ReadonlyArray<RepoFile>, maxFilesPerDir: number): DirEntry[] {
  const byDir = new Map<string, RankedFile[]>();
  for (const file of files) {
    const ranked: RankedFile = { ...file, score: scoreFile(file) };
    const list = byDir.get(dirOf(file.path));
    if (list) list.push(ranked);
    else byDir.set(dirOf(file.path), [ranked]);
  }

  const entries: DirEntry[] = [];
  for (const [dir, all] of byDir) {
    all.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const kept = all.slice(0, maxFilesPerDir);
    entries.push({
      dir,
      files: kept,
      totalFiles: all.length,
      omitted: all.length - kept.length,
      // A directory is worth what its best file is worth, plus a little for
      // size — so a large directory of low-value files does not outrank the
      // one containing the entry point.
      score: (kept[0]?.score ?? 0) + Math.min(all.length, 10),
    });
  }
  entries.sort((a, b) => b.score - a.score || a.dir.localeCompare(b.dir));
  return entries;
}

/**
 * Render under the cap, dropping whole directories from the bottom.
 *
 * Never truncates a line, and never emits a heading with no content: a
 * half-rendered structure is worse than no structure, because the model
 * cannot tell which half it got.
 */
export function renderRepoMap(entries: ReadonlyArray<DirEntry>, tracked: number, maxTokens: number): RepoMap {
  const map = emptyRepoMap(true);
  map.tracked = tracked;
  if (entries.length === 0) return map;

  const header = [
    REPO_MAP_HEADING,
    `${tracked} tracked files. Directories most likely to matter first; within each, entry points first.`,
    "This is a map, not an index. It is frozen for this session and does not reflect edits made during it.",
  ].join("\n");
  const headerTokens = estimateTokensChars4(header);
  if (headerTokens >= maxTokens) {
    map.dropped = tracked;
    return map;
  }

  // The overflow footer's budget is RESERVED before any line is laid out.
  // Without this the footer is the first thing that does not fit, so the
  // "name what you dropped" rule failed in exactly the case it exists for:
  // a map so large it had to drop something. Found by its own test.
  const footerText = `${tracked} more files not listed here — use bash (ls, grep, rg) to reach them.`;
  const footerBudget = estimateTokensChars4(`
${footerText}`);
  const lineBudget = Math.max(headerTokens, maxTokens - footerBudget);

  const lines: string[] = [];
  let tokens = headerTokens;
  let shown = 0;
  let droppedDirs = 0;

  for (const entry of entries) {
    const names = entry.files.map((f) => baseName(f.path)).join(" ");
    const suffix = entry.omitted > 0 ? ` (+${entry.omitted} more)` : "";
    const line = `${entry.dir}/  ${names}${suffix}`;
    const cost = estimateTokensChars4(`\n${line}`);
    if (tokens + cost > lineBudget) {
      droppedDirs += 1;
      continue;
    }
    lines.push(line);
    tokens += cost;
    shown += entry.files.length;
  }

  if (lines.length === 0) {
    map.dropped = tracked;
    return map;
  }

  // T68's harvested rule: name what was dropped rather than truncating
  // silently, so the model asks instead of assuming it saw everything.
  const hidden = tracked - shown;
  if (hidden > 0) {
    // Fits by construction: `hidden <= tracked`, so this line is never longer
    // than the one whose budget was reserved above.
    lines.push(`${hidden} more files not listed here — use bash (ls, grep, rg) to reach them.`);
  }

  map.text = [header, ...lines].join("\n");
  map.tokens = estimateTokensChars4(map.text);
  map.files = shown;
  // `hidden` already covers everything not rendered, whether it was cut by
  // maxFilesPerDir or by a whole directory falling off the token budget.
  // droppedDirs is counted only so the reason is available to a caller.
  map.dropped = hidden;
  map.droppedDirs = droppedDirs;
  return map;
}

function git(cwd: string, args: string[], timeoutMs = 4000): string | null {
  // T170: through the host git helper. `raw` because `ls-files -z` is
  // NUL-separated and a path may end in whitespace.
  const run = hostGit(args, cwd, { timeoutMs, raw: true });
  return run.ok ? run.stdout : null;
}

/**
 * Paths that are Lykos's own runtime state rather than the user's code.
 * Excluded from the map entirely — not merely ranked low.
 *
 * Found twice. First by this module's own test: the map's cache lives at
 * `.lykos/cache/repo-map.json`, so on a repo that tracks `.lykos/` the map
 * listed itself, and each rebuild changed the file list that keys the
 * rebuild. A map that is an input to itself is a bug, not a low-value entry.
 *
 * Then by running it against this repository, which is why the pattern is
 * not anchored at the root: `lykos_testing_env/.lykos/session/` holds one
 * directory per archived test session, and every one of them rendered as an
 * identical `live.json meta.json summary.txt transcript.jsonl` line. Sixteen
 * lines of the map were session archive. **Any `.lykos` directory is Lykos's
 * own state, at any depth.**
 */
const LYKOS_STATE = /(^|\/)\.lykos(\/|$)/;

/** Tracked files, per git. Null when this is not a git repository — no map is better than a guessed one. */
export function trackedFiles(cwd: string): string[] | null {
  const out = git(cwd, ["ls-files", "-z"]);
  if (out === null) return null;
  return out.split("\0").filter((p) => p.length > 0 && !LYKOS_STATE.test(p));
}

/** Commits touching each path over the last `CHURN_COMMITS` commits. Empty on any failure. */
export function fileChurn(cwd: string, limit = CHURN_COMMITS): Map<string, number> {
  const churn = new Map<string, number>();
  const out = git(cwd, ["log", `-n${limit}`, "--name-only", "--pretty=format:", "--no-merges"], 6000);
  if (out === null) return churn;
  for (const line of out.split("\n")) {
    const path = line.trim();
    if (path.length === 0) continue;
    churn.set(path, (churn.get(path) ?? 0) + 1);
  }
  return churn;
}

/**
 * HEAD plus a hash of the tracked file list. Rule 2: content, not clock.
 *
 * The file LIST changes when files are added, removed or renamed; HEAD
 * changes when anything is committed. Between the two, every change that
 * alters the map's own content invalidates it — and edits to a file's
 * *contents* correctly do not, because the map does not show contents.
 */
export function sourceHash(cwd: string, files: ReadonlyArray<string>): string {
  const head = git(cwd, ["rev-parse", "HEAD"])?.trim() ?? "no-git";
  return createHash("sha256").update(head).update("\0").update(files.join("\0")).digest("hex").slice(0, 16);
}

export function cachePath(cwd: string): string {
  return join(cwd, ".lykos", "cache", "repo-map.json");
}

interface CachedMap {
  sourceHash: string;
  maxTokens: number;
  maxFilesPerDir: number;
  map: RepoMap;
}

/**
 * The one entry point session boot uses: read the cache, rebuild if the
 * source hash or the policy changed, freeze.
 *
 * The cache is a convenience, never a correctness dependency — a corrupt or
 * unreadable cache file rebuilds rather than throws, and a rebuild is one
 * `git ls-files` plus one bounded `git log`.
 */
export function buildRepoMap(cwd: string, policy: RepoMapPolicy): RepoMap {
  if (!policy.enabled) return emptyRepoMap(false);
  const files = trackedFiles(cwd);
  if (files === null || files.length === 0) return emptyRepoMap(true);

  const hash = sourceHash(cwd, files);
  const path = cachePath(cwd);
  if (existsSync(path)) {
    try {
      const cached = JSON.parse(readFileSync(path, "utf8")) as CachedMap;
      if (
        cached.sourceHash === hash &&
        cached.maxTokens === policy.maxTokens &&
        cached.maxFilesPerDir === policy.maxFilesPerDir &&
        typeof cached.map?.text === "string"
      ) {
        return cached.map;
      }
    } catch {
      // Fall through to a rebuild. A cache that cannot be read is not an error.
    }
  }

  const churn = fileChurn(cwd);
  const entries = rankDirectories(
    files.map((p) => ({ path: p, churn: churn.get(p) ?? 0 })),
    policy.maxFilesPerDir,
  );
  const map = renderRepoMap(entries, files.length, policy.maxTokens);
  map.sourceHash = hash;

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ sourceHash: hash, maxTokens: policy.maxTokens, maxFilesPerDir: policy.maxFilesPerDir, map }),
      "utf8",
    );
  } catch {
    // An unwritable cache costs a rebuild next session and nothing else.
  }
  return map;
}

// ---------------------------------------------------------------------------
// T148 — the map as the `lykos-repo-map` default extension.
//
// The map is no longer a Lykos head block. It is added by a Pi extension
// (`extensions/defaults/lykos-repo-map.ts`) through Pi's public
// `before_agent_start` hook, so everything below is the boundary between that
// extension and the session that loads it: the policy travels in by one env
// var, and what the extension added travels out as one custom session entry.
// ---------------------------------------------------------------------------

/** The resolved `RepoMapPolicy`, as JSON, for the extension to read at load. */
export const REPO_MAP_POLICY_ENV = "LYKOS_REPO_MAP_POLICY";

/** `customType` of the session entry the extension appends once, recording what it added. */
export const REPO_MAP_ENTRY_TYPE = "lykos-repo-map";

export function encodeRepoMapPolicyEnv(policy: RepoMapPolicy): string {
  return JSON.stringify(policy);
}

/** Null on anything malformed — the extension then falls back to its own default. */
export function decodeRepoMapPolicyEnv(raw: string | undefined): RepoMapPolicy | null {
  if (raw === undefined || raw === "") return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (typeof p.enabled !== "boolean" || typeof p.maxTokens !== "number" || typeof p.maxFilesPerDir !== "number") {
      return null;
    }
    return { enabled: p.enabled, maxTokens: p.maxTokens, maxFilesPerDir: p.maxFilesPerDir };
  } catch {
    return null;
  }
}

/**
 * What the session recorded about its map: the one `REPO_MAP_ENTRY_TYPE`
 * entry, read back, never recomputed. No entry means the extension was not
 * loaded or its setting was off, and the answer is an empty, disabled map.
 */
export function repoMapFromEntries(entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>): RepoMap {
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== REPO_MAP_ENTRY_TYPE) continue;
    const d = entry.data as Partial<RepoMap> | undefined;
    if (d === undefined || typeof d.text !== "string") continue;
    return {
      ...emptyRepoMap(d.enabled === true),
      text: d.text,
      tokens: d.tokens ?? 0,
      files: d.files ?? 0,
      dropped: d.dropped ?? 0,
      droppedDirs: d.droppedDirs ?? 0,
      tracked: d.tracked ?? 0,
      sourceHash: d.sourceHash ?? "",
    };
  }
  return emptyRepoMap(false);
}
