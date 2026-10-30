// `lykos agents` — T11 (docs/09-phase1-tasks.md). Shares `parseAgentFile()`
// with `config/generate-agents.ts` rather than writing a second parser, and
// reads `.lykos/agents/` directly — the committed source of truth. (T10 also
// generated a `.pi/agents/` copy for the retired delegate container; that
// generator was removed in #47.)

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAgentFile } from "../config/generate-agents.js";
import { stdoutWrite } from "../tui/io-mode.js";

export interface AgentListing {
  name: string;
  model: string | null;
  tools: string | null;
}

function listAgentFiles(agentsDir: string): string[] {
  if (!existsSync(agentsDir)) return [];
  return readdirSync(agentsDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

export function loadAgentListing(agentsDir: string): AgentListing[] {
  const listings: AgentListing[] = [];
  for (const entry of listAgentFiles(agentsDir)) {
    const name = entry.slice(0, -".md".length);
    const raw = readFileSync(join(agentsDir, entry), "utf8");
    const parsed = parseAgentFile(raw);
    listings.push({
      name,
      model: typeof parsed?.frontmatter.model === "string" ? parsed.frontmatter.model : null,
      tools: typeof parsed?.frontmatter.tools === "string" ? parsed.frontmatter.tools : null,
    });
  }
  return listings;
}

export function runAgentsList(agentsDir: string): number {
  const listings = loadAgentListing(agentsDir);
  if (listings.length === 0) {
    stdoutWrite(
      `no agent definitions at ${agentsDir} — run \`lykos init\` to scaffold the defaults (scout, watcher).\n`,
    );
    return 0;
  }

  stdoutWrite(`lykos agents — ${agentsDir}\n`);
  stdoutWrite("─".repeat(48) + "\n");
  const nameWidth = Math.max(...listings.map((l) => l.name.length), 4);
  const modelWidth = Math.max(...listings.map((l) => (l.model ?? "?").length), 5);
  for (const l of listings) {
    stdoutWrite(
      `${l.name.padEnd(nameWidth)}  ${(l.model ?? "?").padEnd(modelWidth)}  ${l.tools ?? "(no tools: line)"}\n`,
    );
  }
  return 0;
}

export function runAgentsShow(agentsDir: string, name: string): number {
  const path = join(agentsDir, `${name}.md`);
  if (!existsSync(path)) {
    process.stderr.write(`lykos agents show: no agent named "${name}" at ${path}\n`);
    return 1;
  }
  stdoutWrite(readFileSync(path, "utf8"));
  return 0;
}
