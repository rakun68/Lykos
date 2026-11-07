// Contained runs in a temporary worktree (T254, T234). The seal's red check and the claim checks run a project's tests
// in a worktree made for the run; with containment on, the worktree is mounted into a container and the commands run
// there. One place makes that mount, so the two cannot disagree about it.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ContainmentConfig } from "../config/types.js";
import type { Containment } from "../containment/containment.js";
import type { ContainmentChoice } from "../delegate/session-protocol.js";
import { gitExec } from "./git.js";

export interface WorktreeContainmentInput {
  /** The temporary worktree the commands run in. */
  worktreeDir: string;
  /** The level asked for. `off` is not started here: the caller runs on the host. */
  level: ContainmentChoice;
  config: ContainmentConfig;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

/** Starts containment over a worktree. The result's `record.used` says what was met: `auto` with no runtime is `off`. */
export async function startWorktreeContainment(input: WorktreeContainmentInput): Promise<Containment> {
  const { startContainment } = await import("../containment/containment.js");
  let gitWorktree: { commonDir: string; gitDir: string } | undefined;
  const gitFilePath = join(input.worktreeDir, ".git");
  if (existsSync(gitFilePath) && statSync(gitFilePath).isFile()) {
    const gitContent = readFileSync(gitFilePath, "utf8").trim();
    const match = gitContent.match(/^gitdir:\s*(.+)$/);
    if (match && match[1]) {
      const commonOut = gitExec(["rev-parse", "--git-common-dir"], input.worktreeDir, input.env);
      const commonDir = resolve(input.worktreeDir, commonOut);
      gitWorktree = { commonDir, gitDir: resolve(input.worktreeDir, match[1]) };
    }
  }
  return startContainment({
    config: input.config.level === input.level ? input.config : { ...input.config, level: input.level },
    workspace: input.worktreeDir,
    ...(gitWorktree !== undefined ? { gitWorktree } : {}),
    hostEnv: input.env,
    log: input.log,
  });
}
