// T254 (spec decision 10): the seal from a task's `sealed:` list, made before any model runs.
//
// The coordinator's sealed tests, as they are in the coordinator's tree, are committed on the session's branch
// directly over the base: that commit is the writer commit. `seal create` then seals exactly those paths, and its
// red check runs at the writer commit in a temporary worktree. The outcome decides whether the model runs:
//   - `failing`, `failing-exit-only` (the weaker guarantee): sealed, the session runs;
//   - `passing`: a sealed test already passes, so the spec asks for nothing: WEAK-SPEC, `next answer_spec`;
//   - `error`: the tests could not be run: `fix_environment`, with the output.
// `red: false` skips the check, and the seal records that it did (`red_check: "skipped"`).
//
// `resealAt` is `continue --reseal <commit>` (R9): a sealed file the coordinator corrected on the branch is sealed
// again at that commit, which advances the branch's active seal.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { repoPath } from "../delegate/claims.js";
import type { ContainmentChoice } from "../delegate/session-protocol.js";
import { sealCreate, type SealCreateResult } from "./create.js";
import { fallbackGitIdentity, getBranchOrNull, gitExec, resolveHead, resolveRef } from "./git.js";
import type { RedOutcome } from "./runner.js";

export interface SealFromSpecInput {
  /** The coordinator's tree, where the sealed files are read from. */
  workspace: string;
  /** The session's checkout, on its own branch made from the base. */
  worktree: string;
  /** The task's `sealed:` paths, relative to the workspace. */
  paths: readonly string[];
  /** The task's `red:`. */
  red: boolean;
  base?: string | undefined;
  sessionId?: string | undefined;
  ledgerPath?: string | undefined;
  containmentLevel?: ContainmentChoice | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  homeDir?: string | undefined;
}

export interface SpecSeal {
  ok: boolean;
  red?: RedOutcome | "skipped" | undefined;
  writerCommit?: string | undefined;
  sealCommit?: string | undefined;
  /** What the coordinator reads when it is not ok. */
  message?: string | undefined;
  passing?: string[] | undefined;
  output?: string | undefined;
}

function fromCreate(res: SealCreateResult, writerCommit: string | undefined): SpecSeal {
  if (res.ok) return { ok: true, red: res.red, writerCommit, sealCommit: res.sealCommit };
  const message =
    res.red === "passing"
      ? `the sealed tests already pass, so the spec asks for nothing (WEAK-SPEC): ${(res.passing ?? []).join("; ")}`
      : (res.errors ?? ["seal creation refused"]).join("\n");
  return { ok: false, red: res.red, writerCommit, message, ...(res.passing !== undefined ? { passing: res.passing } : {}), ...(res.output !== undefined ? { output: res.output } : {}) };
}

/** Commits the sealed files on the session's branch as the writer commit, then seals them. */
export async function sealFromSpec(input: SealFromSpecInput): Promise<SpecSeal> {
  const env: NodeJS.ProcessEnv = { ...(input.env ?? process.env), ...fallbackGitIdentity(input.worktree) };
  const branch = getBranchOrNull(input.worktree, env);
  if (branch === null) return { ok: false, message: "sealed: the session has no branch of its own to seal (write_in_place cannot carry sealed tests)" };
  // A sealed path names a file in the repository: never one outside it, absolute, or in `.git`.
  const checked = input.paths.map((p) => repoPath(p, "sealed path"));
  const refused = checked.flatMap((c) => (c.ok ? [] : [c.message]));
  if (refused.length > 0) return { ok: false, message: `sealed: ${refused.join("; ")}` };
  const paths = checked.flatMap((c) => (c.ok ? [c.path] : []));
  const missing = paths.filter((p) => !existsSync(join(input.workspace, p)));
  if (missing.length > 0) return { ok: false, message: `sealed: not found in the workspace: ${missing.join(", ")}` };
  for (const p of paths) {
    const from = join(input.workspace, p);
    const to = join(input.worktree, p);
    if (existsSync(to) && readFileSync(to).equals(readFileSync(from))) continue;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  let writerCommit: string;
  try {
    gitExec(["add", "--", ...paths], input.worktree, env);
    // Over the base, even when the files are already there: the writer commit is the one the seal names.
    gitExec(["commit", "--allow-empty", "--no-verify", "-m", `sealed: ${paths.join(", ")}`], input.worktree, env);
    writerCommit = resolveHead(input.worktree, env);
  } catch (err) {
    return { ok: false, message: `sealed: could not commit the sealed tests: ${err instanceof Error ? err.message : String(err)}` };
  }
  const res = await sealCreate({
    cwd: input.worktree,
    branch,
    paths,
    red: input.red,
    creator: "coordinator",
    ...(input.base !== undefined ? { base: input.base } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.ledgerPath !== undefined ? { ledgerPath: input.ledgerPath } : {}),
    ...(input.containmentLevel !== undefined ? { containmentLevel: input.containmentLevel } : {}),
    ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
    env,
  });
  return fromCreate(res, writerCommit);
}

export interface ResealInput {
  /** The session's checkout, on its branch. */
  worktree: string;
  /** The commit that corrects the sealed file: the branch's tip. */
  commit: string;
  base?: string | undefined;
  sessionId?: string | undefined;
  ledgerPath?: string | undefined;
  containmentLevel?: ContainmentChoice | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  homeDir?: string | undefined;
}

/** R9: seals the branch again at `commit`, which advances its active seal. */
export async function resealAt(input: ResealInput): Promise<SpecSeal> {
  const env: NodeJS.ProcessEnv = { ...(input.env ?? process.env), ...fallbackGitIdentity(input.worktree) };
  const branch = getBranchOrNull(input.worktree, env);
  if (branch === null) return { ok: false, message: "reseal: the session has no branch of its own" };
  const sha = resolveRef(input.commit, input.worktree, env);
  if (!sha) return { ok: false, message: `reseal: "${input.commit}" does not resolve to a commit` };
  if (sha !== resolveHead(input.worktree, env)) return { ok: false, message: `reseal: ${input.commit} is not the tip of ${branch}; commit the correction on the branch first` };
  const res = await sealCreate({
    cwd: input.worktree,
    branch,
    targetCommit: sha,
    creator: "coordinator",
    ...(input.base !== undefined ? { base: input.base } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.ledgerPath !== undefined ? { ledgerPath: input.ledgerPath } : {}),
    ...(input.containmentLevel !== undefined ? { containmentLevel: input.containmentLevel } : {}),
    ...(input.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
    env,
  });
  return fromCreate(res, sha);
}
