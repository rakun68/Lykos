// The four gated shadows of Pi's write/edit/bash/powershell. Operations stay
// in `gate/approval.ts` (the gate); this module owns the tool definitions that
// shadow the built-ins so every mutating call goes through that gate.

import { readFile } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createPowerShellToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
  buildBashOperations,
  buildEditOperations,
  buildPowerShellOperations,
  buildWriteOperations,
  type ApprovalGate,
  type DenialLog,
  type ShellOperationsOpts,
} from "../gate/approval.js";
import { REQUIRE_READ_SENTENCE, type FileReadRecord } from "./read-record.js";

export const POWERSHELL_TOOL_NAME = "powershell";

/**
 * T168 part B (`edit.require_read`): `write`'s operations, with the read record
 * in front of the approval gate.
 *
 * Pi's write calls `operations.writeFile(path, content)` inside the file's
 * mutation queue, and `buildWriteOperations`' `writeFile` is where the gate is
 * asked. The check runs here, one step ahead of it, so a write that is going to
 * be rejected never reaches the human as a question, and it runs under the same
 * queue as the write, so a concurrent `edit` of the file cannot slip between the
 * check and the write. A file that does not exist is new and exempt. Anything
 * else that stops the file being read (a directory, a permission) is left for
 * the write itself to report in its own words.
 */
function recordedWriteOperations(inner: WriteOperations, reads: FileReadRecord, cwd: string): WriteOperations {
  return {
    ...inner,
    async writeFile(absolutePath, content) {
      if (reads.requireRead) {
        let current: Buffer | undefined;
        try {
          current = await readFile(absolutePath);
        } catch {
          current = undefined;
        }
        if (current !== undefined) {
          const rel = relative(cwd, absolutePath);
          reads.check(absolutePath, current, rel === "" || rel.startsWith("..") || isAbsolute(rel) ? absolutePath : rel);
        }
      }
      await inner.writeFile(absolutePath, content);
      reads.noteWritten(absolutePath, content);
    },
  };
}

/**
 * The gated tool definitions. There is no shared always-allow set: T131's follow-up removed it, because it sat in front of the gate and therefore in front of the interaction mode. See `authorize()`. The remaining sharing is the
 * life of the session — `write`/`edit`/`bash` are each their own "always
 * allow" scope (T34.2: session-scoped, per tool). Pass as `customTools` to
 * `createAgentSession`/`CreateAgentSessionOptions`; each name shadows the
 * matching built-in.
 *
 * P10.4 (ticket 13, D3): `powershell` joined this list rather than getting a
 * module of its own. It is a shell; it belongs beside the other shell, built
 * the same way, from operations that differ only in which child process Pi
 * spawns. It was dropped early on because "the sandbox is Linux" — but the
 * machine the maintainer actually works on is Windows, and the reasoning
 * never covered the host path.
 */
export function buildGatedTools(
  cwd: string,
  gate: ApprovalGate,
  denials?: DenialLog,
  opts: ShellOperationsOpts & { reads?: FileReadRecord | undefined } = {},
): ToolDefinition<any, any, any>[] {
  const reads = opts.reads;
  const write = createWriteToolDefinition(cwd, {
    operations:
      reads !== undefined
        ? recordedWriteOperations(buildWriteOperations(cwd, gate, denials), reads, cwd)
        : buildWriteOperations(cwd, gate, denials),
  });
  return [
    // Pi's own description, byte for byte, unless `edit.require_read` is on.
    reads?.requireRead === true ? { ...write, description: `${write.description}${REQUIRE_READ_SENTENCE}` } : write,
    createEditToolDefinition(cwd, { operations: buildEditOperations(cwd, gate, denials) }),
    createBashToolDefinition(cwd, { operations: buildBashOperations(cwd, gate, denials, opts) }),
    createPowerShellToolDefinition(cwd, {
      operations: buildPowerShellOperations(cwd, gate, denials, opts),
    }),
  ];
}
