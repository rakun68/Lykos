// T267: a session's conversation as Markdown, for `/export [file]` and
// `lykos export <session> [file]` (docs/reference/sessions-and-archive.md).
//
// It reads the transcript, never the live process, so a session that ended
// (or was killed) exports the same way a running one does. What it renders is
// the conversation a person had: prompts, steers, answers, tool calls with
// their results, and errors. Bookkeeping lines (usage, turn markers,
// compaction, prune) and the model's reasoning are left out: `lykos show` is
// the reader for those.
//
// Prompts and answers are already Markdown, written by a person or the model,
// so they go in as they are. Tool arguments and results are fenced, and each
// fence is one backtick longer than the longest run inside it, so a result
// that itself contains a fence cannot close the export's fence early.

import {
  readSessionMeta,
  readTranscript,
  transcriptFilePath,
  type TranscriptEventInput,
} from "./transcript.js";

/** A fence that outlasts every backtick run in `body`. */
function fenced(body: string, info = ""): string {
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  const text = body.endsWith("\n") ? body : `${body}\n`;
  return `${fence}${info}\n${text}${fence}\n`;
}

/** A tool result as text: Pi's `{ content: [...] }` blocks joined, anything else as JSON. */
function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  const content = (result as { content?: unknown } | null)?.content;
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        const b = block as { type?: unknown; text?: unknown; mimeType?: unknown };
        if (b.type === "text" && typeof b.text === "string") return b.text;
        if (b.type === "image") return `[image${typeof b.mimeType === "string" ? ` ${b.mimeType}` : ""}]`;
        return JSON.stringify(block);
      })
      .join("\n");
  }
  return JSON.stringify(result, null, 2) ?? "";
}

function eventMarkdown(event: TranscriptEventInput): string | null {
  switch (event.kind) {
    case "user_message":
      return `## Prompt\n\n${event.text}\n`;
    case "steer":
      return `## ${event.mode === "follow_up" ? "Follow-up" : "Steer"}\n\n${event.text}\n`;
    case "assistant_message":
      return `## Answer\n\n${event.text}\n`;
    case "tool_call": {
      const repeat = event.repeat_count !== undefined && event.repeat_count > 1 ? ` (${event.repeat_count} times)` : "";
      let out = `### Tool call: \`${event.name}\`${repeat}\n\n`;
      if (event.args !== undefined) out += fenced(JSON.stringify(event.args, null, 2), "json");
      // A snapshot transcript folds the result into its call; a stream one writes it as its own line.
      if (event.result !== undefined) out += `\n#### Result: \`${event.name}\` (${event.state})\n\n${fenced(resultText(event.result))}`;
      return out;
    }
    case "tool_result":
      return `#### Result: \`${event.name}\` (${event.state})\n\n${event.result === undefined ? "(no result recorded)\n" : fenced(resultText(event.result))}`;
    case "error":
      return `> **Error:** ${event.message}\n`;
    case "resume":
      return `*Resumed from session ${event.from}.*\n`;
    default:
      return null;
  }
}

/**
 * The session's conversation as Markdown, read from its transcript.
 * `transcriptPath` defaults to where the session's own writer puts it; an
 * archived (`.gz`) transcript is read the same way.
 */
export function sessionMarkdown(
  ledgerPath: string,
  sessionId: string,
  transcriptPath: string = transcriptFilePath(ledgerPath, sessionId),
): string {
  const { events } = readTranscript(transcriptPath);
  const meta = readSessionMeta(ledgerPath, sessionId);
  const header = [`# Session ${sessionId}`, ""];
  if (meta?.model) header.push(`- Model: ${meta.model}`);
  if (meta?.startedUtc) header.push(`- Started: ${meta.startedUtc}`);
  if (header.length > 2) header.push("");
  const blocks = events.map(eventMarkdown).filter((block): block is string => block !== null);
  return `${header.join("\n")}\n${blocks.join("\n")}`;
}
