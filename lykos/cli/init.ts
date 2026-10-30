// `lykos init` — scaffold .lykos/ in the current project (T3.5.3).

import { writeResolvedConfigCache } from "../config/cache.js";
import { loadConfig } from "../config/load.js";
import { scaffoldLykosDir } from "../config/scaffold.js";
import { resolveProject } from "../session/identity.js";
import { stdoutWrite } from "../tui/io-mode.js";

export function runInit(cwd: string): number {
  const result = scaffoldLykosDir(cwd);
  writeResolvedConfigCache(cwd, loadConfig({ cwd }).resolved);
  for (const path of result.created) {
    stdoutWrite(`created  ${path}\n`);
  }
  for (const path of result.skipped) {
    stdoutWrite(`exists   ${path} (left unchanged)\n`);
  }

  const project = resolveProject(cwd);
  stdoutWrite(
    project.created
      ? `registered project ${project.id} in ~/.lykos/projects.json\n`
      : `project ${project.id} already registered in ~/.lykos/projects.json\n`,
  );

  if (result.created.length === 0) {
    stdoutWrite("\n.lykos/ already fully scaffolded — nothing to do.\n");
  } else {
    stdoutWrite(`\n.lykos/ ready. Commit config.yaml, agents/, and memory/.\n`);
  }
  return 0;
}
