// T209 / ADR-0041 — the /permissions command.
//
// Inspects and adjusts the persistent permission settings remembered per project:
// mode, outside path rules, extra directories, and command approvals.

import { isAbsolute, resolve } from "node:path";
import { pathRuleEnforcement } from "./bash-paths.js";
import { MODE_INFO, parseInteractionMode, type InteractionMode } from "./modes.js";
import {
  clearAllow,
  forgetAllow,
  forgetExtraDir,
  loadPermissions,
  rememberExtraDir,
  rememberMode,
  rememberOutside,
  type PermissionsOptions,
} from "./permissions.js";

export interface PermissionsCommandContext {
  projectId: string;
  opts?: PermissionsOptions | undefined;
  liveMode?: InteractionMode | undefined;
  /** The project directory a relative `dir` path is resolved against; defaults to the process cwd. */
  cwd?: string | undefined;
  /** T212: whether commands run in a container (enforced) or on host (best effort). */
  contained?: boolean | undefined;
}

export interface PermissionsCommandResult {
  ok: boolean;
  report: string;
  mode?: InteractionMode | undefined;
}

const USAGE =
  "usage: /permissions [mode <manual|accept-edits|auto> | outside <read|write> <allow|ask|deny> | dir <add|remove> <path> | revoke <pattern>]";

export function runPermissionsCommand(
  args: string,
  ctx: PermissionsCommandContext,
): PermissionsCommandResult {
  const trimmed = args.trim();

  if (trimmed.length === 0) {
    const perms = loadPermissions(ctx.projectId, ctx.opts);
    const mode = ctx.liveMode ?? perms.mode ?? "manual";
    const modeLabel = MODE_INFO[mode]?.label ?? mode;
    const lines: string[] = [
      `permission mode: ${modeLabel}`,
      `outside rules: read ${perms.outside.read}, write ${perms.outside.write}`,
      `extra directories: ${perms.extraDirs.length > 0 ? perms.extraDirs.join(", ") : "(none)"}`,
      `remembered approvals: ${perms.allow.size > 0 ? [...perms.allow].join(", ") : "(none)"}`,
      `path rules: enforced for file tools; commands ${pathRuleEnforcement(ctx.contained ?? false)}`,
    ];
    return { ok: true, report: lines.join("\n") };
  }

  const spaceIdx = trimmed.indexOf(" ");
  const subcommand = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  switch (subcommand) {
    case "mode": {
      if (rest.length === 0) {
        return { ok: false, report: USAGE };
      }
      const parsed = parseInteractionMode(rest);
      if (!parsed.ok) {
        return { ok: false, report: parsed.error };
      }
      rememberMode(ctx.projectId, parsed.mode, ctx.opts);
      return {
        ok: true,
        report: `permission mode is now ${MODE_INFO[parsed.mode].label} — ${MODE_INFO[parsed.mode].description}`,
        mode: parsed.mode,
      };
    }
    case "outside": {
      if (rest.length === 0) {
        return { ok: false, report: USAGE };
      }
      const parts = rest.split(/\s+/);
      if (parts.length !== 2) {
        return { ok: false, report: USAGE };
      }
      const [access, decision] = parts;
      if (access !== "read" && access !== "write") {
        return { ok: false, report: USAGE };
      }
      if (decision !== "allow" && decision !== "ask" && decision !== "deny") {
        return { ok: false, report: USAGE };
      }
      rememberOutside(ctx.projectId, access, decision, ctx.opts);
      return {
        ok: true,
        report: `outside ${access} is now ${decision}`,
      };
    }
    case "dir": {
      if (rest.length === 0) {
        return { ok: false, report: USAGE };
      }
      const dirSpace = rest.indexOf(" ");
      if (dirSpace === -1) {
        return { ok: false, report: USAGE };
      }
      const action = rest.slice(0, dirSpace).trim();
      const typed = rest.slice(dirSpace + 1).trim();
      if (typed.length === 0) {
        return { ok: false, report: USAGE };
      }
      // Path rules compare extra directories as absolute paths, so a relative one is resolved here.
      const path = isAbsolute(typed) ? typed : resolve(ctx.cwd ?? process.cwd(), typed);
      if (action === "add") {
        rememberExtraDir(ctx.projectId, path, ctx.opts);
        return {
          ok: true,
          report: `added extra directory: ${path}`,
        };
      } else if (action === "remove") {
        forgetExtraDir(ctx.projectId, path, ctx.opts);
        return {
          ok: true,
          report: `removed extra directory: ${path}`,
        };
      } else {
        return { ok: false, report: USAGE };
      }
    }
    case "revoke": {
      if (rest.length === 0) {
        return { ok: false, report: USAGE };
      }
      if (rest === "all") {
        clearAllow(ctx.projectId, ctx.opts);
        return {
          ok: true,
          report: "revoked approval for: all",
        };
      }
      forgetAllow(ctx.projectId, rest, ctx.opts);
      return {
        ok: true,
        report: `revoked approval for: ${rest}`,
      };
    }
    default: {
      return { ok: false, report: USAGE };
    }
  }
}
