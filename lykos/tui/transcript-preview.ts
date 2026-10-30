// Preview rendering is a TUI concern; sessions owns the transcript data and
// asks this boundary for the pixel-shaped blocks.
export { transcriptEventsToBlocks } from "./screen/transcript-blocks.js";
export type { ScreenBlock } from "./screen/blocks.js";
