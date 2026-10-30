// T127: the preview and the live session share this event-to-block boundary.
// `cli/show` intentionally remains a raw diagnostic reader and is not used.

import type { TranscriptEventRecord, TranscriptEventInput } from "../../session/transcript.js";
import type { ScreenBlock } from "./blocks.js";

export interface TranscriptBlocks {
  blocks: ScreenBlock[];
  unsupported: string[];
}

export function transcriptEventsToBlocks(
  events: readonly (TranscriptEventRecord & TranscriptEventInput)[],
): TranscriptBlocks {
  const blocks: ScreenBlock[] = [];
  const unsupported = new Set<string>();
  let index = 0;
  for (const event of events) {
    const id = `preview-${index++}`;
    switch (event.kind) {
      case "user_message":
      case "steer":
        blocks.push({ id, kind: "user", text: event.text });
        break;
      case "assistant_message":
        blocks.push({ id, kind: "speech", text: event.text });
        break;
      case "thinking":
        blocks.push({ id, kind: "thinking", text: event.text });
        break;
      case "tool_call":
        blocks.push({
          id,
          kind: "tool",
          tool: { name: event.name, summary: event.name, state: event.state === "error" ? "error" : event.state === "running" ? "running" : "ok" },
        });
        break;
      case "tool_result":
        blocks.push({ id, kind: "tool", tool: { name: event.name, summary: event.name, state: event.state } });
        break;
      case "error":
        blocks.push({ id, kind: "system", text: event.message });
        break;
      case "compaction":
        blocks.push({ id, kind: "system", text: `compaction ${event.phase}${event.reason ? ` — ${event.reason}` : ""}` });
        break;
      default:
        unsupported.add(event.kind);
        break;
    }
  }
  return { blocks, unsupported: [...unsupported].sort() };
}
