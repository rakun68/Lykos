/**
 * What fills a session's context window, part by part: `/context`'s report and the TUI's Context window.
 *
 * One number is measured: Pi's `getContextUsage()` total, which is what Pi compacts against. Every part is an
 * estimate at 4 characters per token, and a surface that shows one says so. The system prompt holds the memory files
 * and the skill list, so those two are taken out of it rather than counted twice. Before the first answer Pi has no
 * total, and the messages are then estimated from their text.
 */
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

/** A tool as the context counts it: what the provider is sent for it. */
export type ContextTool = Pick<ToolInfo, "name" | "description" | "parameters">;

export interface ContextPart {
  name: string;
  /** Estimated. */
  tokens: number;
  /** How many things the part holds: tools, files, skills, messages. */
  count?: number;
  /** Each file's share, for the memory files. */
  items?: Array<{ name: string; tokens: number }>;
}

export interface ContextBreakdown {
  model: string | null;
  window: number | null;
  /** Pi's total; null before the first answer and right after a compaction. */
  measured: number | null;
  parts: ContextPart[];
}

export interface ContextSources {
  model: string | null;
  systemPrompt: string;
  tools: readonly ContextTool[];
  contextFiles: ReadonlyArray<{ name: string; bytes: number }>;
  /** The skill list's share of the system prompt (`skillsHeadCost`). */
  skillTokens: number;
  skillCount: number;
  messages: readonly unknown[];
  usage: { tokens: number | null; contextWindow: number } | undefined;
}

const estimate = (chars: number): number => Math.ceil(chars / 4);

/** The tool schemas as one serialised list: the closest the host gets to what the provider is sent. */
export function toolTokens(tools: readonly ContextTool[]): number {
  return estimate(tools.reduce((n, t) => n + JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length, 0));
}

/** What every call carries before any message: the system prompt and the tool schemas, estimated. */
export function headTokens(systemPrompt: string, tools: readonly ContextTool[]): number {
  return estimate(systemPrompt.length) + toolTokens(tools);
}

/** A message's text, whatever its shape: its content when it has one, else the whole of it. */
function messageChars(message: unknown): number {
  const content = message !== null && typeof message === "object" && "content" in message ? (message as { content: unknown }).content : message;
  return typeof content === "string" ? content.length : (JSON.stringify(content) ?? "").length;
}

export function contextBreakdown(src: ContextSources): ContextBreakdown {
  const prompt = estimate(src.systemPrompt.length);
  const items = src.contextFiles.map((f) => ({ name: f.name, tokens: estimate(f.bytes) }));
  const memory = Math.min(
    prompt,
    items.reduce((n, f) => n + f.tokens, 0),
  );
  const skills = Math.min(prompt - memory, src.skillTokens);
  const tools = toolTokens(src.tools);
  const measured = src.usage?.tokens ?? null;
  const messages =
    measured !== null ? Math.max(0, measured - prompt - tools) : estimate(src.messages.reduce<number>((n, m) => n + messageChars(m), 0));
  return {
    model: src.model,
    window: src.usage?.contextWindow ?? null,
    measured,
    parts: [
      { name: "System prompt", tokens: prompt - memory - skills },
      { name: "Tools", tokens: tools, count: src.tools.length },
      { name: "Memory files", tokens: memory, count: items.length, items },
      { name: "Skills", tokens: skills, count: src.skillCount },
      { name: "Messages", tokens: messages, count: src.messages.length },
    ],
  };
}
