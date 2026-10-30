// Parses `.lykos/agents/*.md` (T10, T11's `lykos agents`).
//
// T10 also generated `<workspace>/.pi/agents/*.md` from these files for the
// `pi-subagents` extension inside the retired delegate container.
// `generateAgentFiles()` had no caller after #38 deleted that path and was
// removed in #47. The parser is still how `lykos agents` reads a definition.

export type AgentFrontmatterValue = string | boolean;

export interface ParsedAgentFile {
  /** Frontmatter lines exactly as they appeared, in original order — never reformatted. */
  frontmatterLines: string[];
  /** Everything after the closing `---`, verbatim (including its leading blank line, if any). */
  body: string;
  /** Parsed view for reading (T11's `lykos agents` needs this); not used to rewrite the file. */
  frontmatter: Record<string, AgentFrontmatterValue>;
}

const FRONTMATTER_LINE = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/;

/**
 * Splits a `.lykos/agents/*.md` file into its frontmatter and body. Returns
 * null for a file with no `---`-delimited frontmatter block — skipped by the
 * caller with a warning rather than guessed at, since a malformed source
 * file is a real authoring mistake, not something to paper over silently.
 */
export function parseAgentFile(raw: string): ParsedAgentFile | null {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (closeIdx < 0) return null;

  const frontmatterLines = lines.slice(1, closeIdx);
  const body = lines.slice(closeIdx + 1).join("\n");

  const frontmatter: Record<string, AgentFrontmatterValue> = {};
  for (const line of frontmatterLines) {
    const m = FRONTMATTER_LINE.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const value = m[2]!.trim();
    frontmatter[key] = value === "true" ? true : value === "false" ? false : value;
  }
  return { frontmatterLines, body, frontmatter };
}
