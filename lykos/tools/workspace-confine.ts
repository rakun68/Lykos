// The host file tools stay inside the workspace.
//
// **Why it exists.** In a contained session a command runs in a container and
// can write anything in the workspace mount, including a symlink. The file tools
// run on the HOST, so a link planted from the container (`ln -s ~/.lykos/
// credentials.db notes.txt`) makes a host `read` or `write` land on a file the
// container could never reach itself. Lexical checks do not see this: the path
// `notes.txt` is inside the workspace, and only following the link says
// otherwise. So every path a file tool is given is resolved through the
// filesystem (`realpath`, symlinks and junctions followed) and compared with the
// workspace's own resolved root. This holds at every containment level: with
// `off` the model can make the same link with `ln` and the same tools follow it.
//
// **A path that does not exist yet** (a `write` creating a file, or a glob) is
// resolved through its nearest existing ancestor, with the rest appended. A new
// file under a symlinked directory is exactly as outside as an existing one, and
// `linkdir/*.ts` is judged by `linkdir`.
//
// **Where it sits.** One wrapper around a tool's `execute`, applied to the
// definitions `loadTools()` returns, so the tools themselves stay Pi's. The
// wrapper throws before the inner `execute` runs, which is before the approval
// gate is asked: a call that is going to be refused never reaches the human as
// a question.
//
// **What it does not cover.** `bash` and the other command tools (the container
// is their boundary), and a file tool's own later walk of a directory it was
// pointed at: `grep` and `find` use ripgrep and fd, which do not follow symlinks
// unless asked, so naming a directory is the point at which a link is crossed.

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  ApprovalDeniedError,
  folderOfPath,
  pathDenialMessage,
  projectIdForCwd,
  resolvePathRulesAndContext,
  type ApprovalGate,
} from "../gate/approval.js";
import { decidePath, type PathAccess } from "../gate/path-rules.js";
import { rememberExtraDir } from "../gate/permissions.js";
import { resolveEditPath } from "./edit.js";

/** The deepest existing ancestor of `absolute`, resolved, with the missing tail put back. */
function realpathOfNearest(absolute: string): string {
  let existing = absolute;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    tail.unshift(parse(existing).base);
    existing = parent;
  }
  let real: string;
  try {
    real = realpathSync.native(existing);
  } catch {
    // A component that cannot be read: use what the path says, so the
    // comparison still happens and is not skipped.
    real = existing;
  }
  return tail.length === 0 ? real : join(real, ...tail);
}

function insideRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || !(rel.startsWith("..") || isAbsolute(rel));
}

/** Every path-like argument a file tool was given, by the parameter names the file tools use. */
function pathsOf(params: unknown): string[] {
  if (params === null || typeof params !== "object") return [];
  const p = params as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ["path", "file"]) if (typeof p[key] === "string" && p[key] !== "") out.push(p[key] as string);
  if (Array.isArray(p["paths"])) for (const v of p["paths"]) if (typeof v === "string" && v !== "") out.push(v);
  return out;
}

/** The tools that write; every other confined tool reads. */
const WRITE_TOOLS = new Set(["write", "edit", "ast_edit"]);

/**
 * Wrap a file tool so each path it names goes through `decidePath` (T210).
 * A deny refuses with the rule named. An ask goes to the approval gate for a
 * reading tool; a writing tool asks in its own gated write, which sees the
 * same verdict, so it is not asked twice. "Allow this folder" is remembered
 * for the project, so the next path there does not ask.
 */
export function confineToWorkspace(tool: ToolDefinition, cwd: string, gate?: ApprovalGate): ToolDefinition {
  const inner = tool.execute.bind(tool);
  const access: PathAccess = WRITE_TOOLS.has(tool.name) ? "write" : "read";
  return {
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      for (const given of pathsOf(params)) {
        const target = realpathOfNearest(resolveEditPath(given, cwd));
        const { rules, ctx: pathCtx } =
          gate?.pathRules !== undefined && gate?.pathContext !== undefined
            ? { rules: gate.pathRules, ctx: gate.pathContext }
            : await resolvePathRulesAndContext(cwd);
        // The requested path and its realpath: a deny on either wins.
        const requested = decidePath(resolveEditPath(given, cwd), access, rules, pathCtx);
        const resolved = decidePath(target, access, rules, pathCtx);
        const verdict = requested.decision === "deny" ? requested : resolved;
        if (verdict.decision === "deny") {
          if (gate && "denied" in gate && Array.isArray((gate as any).denied)) {
            (gate as any).denied.push({
              kind: access === "write" ? tool.name : "read",
              summary: `${tool.name} ${given}`,
              detail: target,
              rule: verdict.rule ?? "outside the project directory",
            });
          }
          throw new ApprovalDeniedError(pathDenialMessage(given, verdict.reason));
        }
        if (access === "write" || (requested.decision !== "ask" && resolved.decision !== "ask")) continue;
        if (gate === undefined) {
          throw new ApprovalDeniedError(`lykos: ${target} is outside the allowed folders and there is no one to ask.`);
        }
        const asked = requested.decision === "ask" ? requested : resolved;
        const decision = await gate.request({
          kind: "read",
          summary: `${tool.name} ${given}`,
          detail: target,
          pathAsk: { rule: asked.rule ?? "outside the project directory" },
        });
        if (decision === "allow-folder") {
          try {
            rememberExtraDir(projectIdForCwd(cwd), folderOfPath(target));
          } catch {
            // Best effort: this call was allowed; the next one may ask again.
          }
        } else if (decision !== "allow" && decision !== "allow-always") {
          throw new ApprovalDeniedError(`lykos: read of ${target} was declined`);
        }
      }
      return inner(toolCallId, params, signal, onUpdate, ctx);
    },
  } as ToolDefinition;
}

/** Whether `path`, symlinks followed, lies inside the workspace at `cwd`. */
export function isInsideWorkspace(cwd: string, path: string): boolean {
  return insideRoot(realpathOfNearest(resolve(cwd)), realpathOfNearest(resolve(path)));
}
