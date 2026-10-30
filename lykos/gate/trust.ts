// T117/T118 (docs/29-phase35-second-pass-tasks.md §3).
//
// Trust is resolved before config, skills, extensions, hooks, or context files
// are loaded.  The registry identity is the key, so moving a checkout keeps
// its decision while two unrelated checkouts never share one.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { resolveProject } from "../session/identity.js";

export type TrustSource = "stored" | "flag" | "prompt";

/**
 * Only the user-level store trusts a project's own code and binaries (project extensions, `lsp`). `stored` is a
 * store entry, and `prompt` counts because answering the trust prompt writes the store. `flag` is a one-run
 * override that passes the trust gate and nothing more; an absent source (a library caller, a test) is not
 * trust either.
 */
export function isStoreTrusted(source: TrustSource | undefined): boolean {
  return source === "stored" || source === "prompt";
}

interface TrustFile {
  version: 1;
  projects: Record<string, { trustedUtc: string }>;
}

export class WorkspaceTrustError extends Error {
  readonly workspace: string;

  constructor(workspace: string) {
    super(
      `workspace is not trusted: ${workspace}. Run lykos in this folder and answer the trust prompt, ` +
        "or pass --trust-workspace (or LYKOS_TRUST_WORKSPACE=1 for headless/MCP runs).",
    );
    this.name = "WorkspaceTrustError";
    this.workspace = workspace;
  }
}

export function defaultTrustPath(globalDir = join(homedir(), ".lykos")): string {
  return join(globalDir, "trust.json");
}

function readTrust(path: string): TrustFile {
  if (!existsSync(path)) return { version: 1, projects: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TrustFile>;
    return {
      version: 1,
      projects: parsed.projects && typeof parsed.projects === "object" ? parsed.projects : {},
    };
  } catch {
    return { version: 1, projects: {} };
  }
}

function writeTrust(path: string, trust: TrustFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(trust, null, 2)}\n`, "utf8");
}

export interface EnsureTrustOptions {
  workspace: string;
  /** Explicit per-run trust. Never writes trust.json. */
  trustWorkspace?: boolean;
  /** A prompt is allowed only when this is true. */
  interactive?: boolean;
  registryPath?: string;
  trustPath?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

export interface TrustDecision {
  projectId: string;
  source: TrustSource;
}

/** Check whether a workspace is trusted without prompting. */
export function isWorkspaceTrusted(workspace: string, opts?: { trustPath?: string; registryPath?: string }): boolean {
  try {
    const project = resolveProject(workspace, opts?.registryPath ? { registryPath: opts.registryPath } : {});
    const path = opts?.trustPath ?? defaultTrustPath();
    const trust = readTrust(path);
    return Boolean(trust.projects[project.id]) || process.env.LYKOS_TRUST_WORKSPACE === "1";
  } catch {
    return false;
  }
}

/**
 * Resolve the project identity and then establish trust.  No workspace
 * content is loaded before this returns.  A denied/non-interactive request
 * throws instead of entering a restricted mode: every session is comparable
 * only when it has the same trust boundary.
 */
export async function ensureWorkspaceTrust(opts: EnsureTrustOptions): Promise<TrustDecision> {
  const project = resolveProject(opts.workspace, opts.registryPath ? { registryPath: opts.registryPath } : {});
  // The store is read first: a project the user already trusted reports `stored`
  // even when the one-run flag is also set. The flag passes this gate and nothing
  // more; only the store trusts a project's own binaries (`lsp`, T171).
  const path = opts.trustPath ?? defaultTrustPath();
  const trust = readTrust(path);
  if (trust.projects[project.id]) return { projectId: project.id, source: "stored" };
  if (opts.trustWorkspace === true || process.env.LYKOS_TRUST_WORKSPACE === "1") {
    return { projectId: project.id, source: "flag" };
  }

  if (opts.interactive !== true) throw new WorkspaceTrustError(opts.workspace);

  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stderr;
  const answer = await readOneLine(input, output, `Trust workspace ${opts.workspace}? [y/N] `);
  if (!/^\s*y(?:es)?\s*$/i.test(answer ?? "")) throw new WorkspaceTrustError(opts.workspace);

  trust.projects[project.id] = { trustedUtc: new Date().toISOString() };
  writeTrust(path, trust);
  return { projectId: project.id, source: "prompt" };
}

function readOneLine(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  prompt: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    output.write(prompt);
    let data = "";
    const onData = (chunk: Buffer | string) => {
      data += String(chunk);
      const end = data.search(/\r?\n/);
      if (end < 0) return;
      cleanup();
      resolve(data.slice(0, end));
    };
    const onEnd = () => {
      cleanup();
      resolve(data.length > 0 ? data : null);
    };
    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
    };
    input.on("data", onData);
    input.on("end", onEnd);
  });
}
