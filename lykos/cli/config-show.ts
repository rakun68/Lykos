// `lykos config roles` (T239): each role, the model it runs on, and the layer that set it.

import { loadConfig } from "../config/load.js";
import { roleMappings, type RoleMapping } from "../config/roles.js";
import { stdoutWrite } from "../tui/io-mode.js";

export function configRoles(cwd: string, opts: { globalDir?: string; env?: NodeJS.ProcessEnv } = {}): RoleMapping[] {
  const { resolved, layers } = loadConfig({ cwd, ...(opts.globalDir !== undefined ? { globalDir: opts.globalDir } : {}), ...(opts.env !== undefined ? { env: opts.env } : {}) });
  return roleMappings(resolved.models.roles, layers);
}

export function runConfigRoles(cwd: string, json: boolean): number {
  const mappings = configRoles(cwd);
  if (json) {
    stdoutWrite(`${JSON.stringify(mappings, null, 2)}\n`);
    return 0;
  }
  const roleWidth = Math.max(4, ...mappings.map((m) => m.role.length));
  const modelWidth = Math.max(5, ...mappings.map((m) => m.model.length));
  stdoutWrite(`${"role".padEnd(roleWidth)}  ${"model".padEnd(modelWidth)}  source\n`);
  for (const m of mappings) {
    stdoutWrite(`${m.role.padEnd(roleWidth)}  ${m.model.padEnd(modelWidth)}  ${m.source}\n`);
  }
  stdoutWrite("\nA role named after a specialist is that specialist's model, below --model and the specialist file's own.\n");
  return 0;
}
