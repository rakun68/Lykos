// T217 (issue #72, ADR-0045): output styles.
// Output styles are Markdown files defining instructions on how the agent
// writes its replies (brevity, formatting, tone), separate from specialists
// which define capabilities, tools, and what work to do.
//
// Discovery precedence: shipped < global < project.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectVolatile } from "../session/head-contract.js";

export type OutputStyleSource = "shipped" | "global" | "project";

export interface DiscoveredOutputStyle {
  name: string;
  source: OutputStyleSource;
  path: string;
}

export interface ResolvedOutputStyle {
  name: string;
  source: OutputStyleSource;
  text: string;
  path: string;
}

export const OUTPUT_STYLE_HEADING = "## lykos-output-style";

export function shippedOutputStylesDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "output-styles");
}

export function projectOutputStylesDir(cwd: string): string {
  return join(cwd, ".lykos", "output-styles");
}

export function globalOutputStylesDir(globalDir: string): string {
  return join(globalDir, "output-styles");
}

export function defaultGlobalDir(): string {
  return join(homedir(), ".lykos");
}

function listMarkdownNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    const entries = readdirSync(dir);
    const names: string[] = [];
    for (const entry of entries) {
      if (entry.endsWith(".md")) {
        const full = join(dir, entry);
        try {
          if (statSync(full).isFile()) {
            names.push(entry.slice(0, -3));
          }
        } catch {
          // Ignore unreadable files
        }
      }
    }
    return names;
  } catch {
    return [];
  }
}

/**
// Discovers output styles across shipped, global, and project sources.
// Precedence per name: shipped < global < project.
*/
export function discoverOutputStyles(
  cwd: string,
  globalDir: string = defaultGlobalDir(),
  shippedDir: string = shippedOutputStylesDir(),
): DiscoveredOutputStyle[] {
  const globalDirPath = globalOutputStylesDir(globalDir);
  const projectDirPath = projectOutputStylesDir(cwd);
  const byName = new Map<string, DiscoveredOutputStyle>();

  for (const name of listMarkdownNames(shippedDir)) {
    byName.set(name, {
      name,
      source: "shipped",
      path: join(shippedDir, `${name}.md`),
    });
  }

  for (const name of listMarkdownNames(globalDirPath)) {
    byName.set(name, {
      name,
      source: "global",
      path: join(globalDirPath, `${name}.md`),
    });
  }

  for (const name of listMarkdownNames(projectDirPath)) {
    byName.set(name, {
      name,
      source: "project",
      path: join(projectDirPath, `${name}.md`),
    });
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export class OutputStyleNotFoundError extends Error {
  constructor(name: string, available: readonly string[]) {
    const list = available.length > 0 ? available.join(", ") : "(none discovered)";
    super(`lykos: no output style named "${name}" — available output styles: ${list}`);
    this.name = "OutputStyleNotFoundError";
  }
}

export class OutputStyleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputStyleValidationError";
  }
}

/**
 * Resolves an output style by name, checking project, global, then shipped.
 * Throws OutputStyleNotFoundError if not found, or OutputStyleValidationError
 * if volatile content is detected.
 */
export function resolveOutputStyle(
  name: string,
  cwd: string,
  globalDir: string = defaultGlobalDir(),
  shippedDir: string = shippedOutputStylesDir(),
): ResolvedOutputStyle {
  const projectPath = join(projectOutputStylesDir(cwd), `${name}.md`);
  const globalPath = join(globalOutputStylesDir(globalDir), `${name}.md`);
  const shippedPath = join(shippedDir, `${name}.md`);

  let targetPath: string | undefined;
  let source: OutputStyleSource | undefined;

  if (existsSync(projectPath)) {
    targetPath = projectPath;
    source = "project";
  } else if (existsSync(globalPath)) {
    targetPath = globalPath;
    source = "global";
  } else if (existsSync(shippedPath)) {
    targetPath = shippedPath;
    source = "shipped";
  }

  if (targetPath === undefined || source === undefined) {
    const available = discoverOutputStyles(cwd, globalDir, shippedDir).map((s) => s.name);
    throw new OutputStyleNotFoundError(name, available);
  }

  const text = readFileSync(targetPath, "utf8");
  const volatile = detectVolatile(text);
  if (volatile.length > 0) {
    throw new OutputStyleValidationError(
      `lykos: output style "${name}" is invalid — contains volatile content (${volatile.join(", ")})`,
    );
  }

  return {
    name,
    source,
    text,
    path: targetPath,
  };
}

/**
 * Returns the stream notice text naming the switched output style.
 */
export function outputStyleSwitchNotice(name: string): string {
  return `Output style is now "${name}".`;
}

/**
 * Assembles the system prompt head block for an output style.
 */
export function assembleOutputStyleHead(text: string): string {
  return [OUTPUT_STYLE_HEADING, text].join("\n");
}

/**
 * Formats the output styles discovered into a readable list, marking the active one.
 */
export function formatOutputStyleList(styles: readonly DiscoveredOutputStyle[], active: string | undefined): string {
  if (styles.length === 0) {
    return "lykos: no output styles discovered — add one at .lykos/output-styles/<name>.md (project) or <globalDir>/output-styles/<name>.md (global)";
  }
  const lines = styles.map((p) => {
    const marker = p.name === active ? "* " : "  ";
    return `${marker}${p.name} (${p.source})`;
  });
  return ["lykos: available output styles (* = active)", ...lines].join("\n");
}

/**
 * Returns names of discovered styles for completion.
 */
export function outputStyleNamesFor(cwd: string, globalDir: string, shippedDir: string = shippedOutputStylesDir()): string[] {
  return discoverOutputStyles(cwd, globalDir, shippedDir).map((p) => p.name);
}

export interface OutputStyleSwitcher {
  currentOutputStyleName: () => string;
  listOutputStyles: () => string;
  switchOutputStyle: (name: string) => { ok: true; report: string } | { ok: false; message: string };
  takeOutputStyleNotice: () => string | undefined;
}

export function createOutputStyleSwitcher(opts: {
  cwd: string;
  globalDir?: string;
  shippedDir?: string;
  initialOutputStyleName?: string;
}): OutputStyleSwitcher {
  const globalDir = opts.globalDir ?? join(homedir(), ".lykos");
  let currentStyle = opts.initialOutputStyleName ?? "default";
  let pendingNotice: string | undefined;

  return {
    currentOutputStyleName: () => currentStyle,
    listOutputStyles: () => {
      const styles = discoverOutputStyles(opts.cwd, globalDir, opts.shippedDir);
      return formatOutputStyleList(styles, currentStyle);
    },
    switchOutputStyle: (name: string) => {
      try {
        const resolved = resolveOutputStyle(name, opts.cwd, globalDir, opts.shippedDir);
        currentStyle = name;
        const notice = outputStyleSwitchNotice(name);
        pendingNotice = resolved.text.trim().length > 0 ? `${notice}\n\n${resolved.text}` : notice;
        return { ok: true, report: `lykos: output style is now "${name}"` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
    takeOutputStyleNotice: () => {
      const notice = pendingNotice;
      pendingNotice = undefined;
      return notice;
    },
  };
}
