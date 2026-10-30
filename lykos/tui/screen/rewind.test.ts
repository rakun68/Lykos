import assert from "node:assert/strict";
import test from "node:test";
import { RewindOverlay, renderRewind } from "./rewind.js";
import type { CheckpointEntry } from "../../loop/checkpoint.js";
import { resolveTheme } from "../theme/resolve.js";

const monoTheme = resolveTheme("mono", "none", "unicode");

const entries: CheckpointEntry[] = [
  { commit: "abcdef012345", label: "turn 2", at: "2026-09-07T00:00:00.000Z", index: 0 },
];

test("T122 requires explicit confirmation before restoring a checkpoint", () => {
  let restored: number | undefined;
  let rendered = "";
  const overlay = new RewindOverlay({
    load: () => entries,
    onRender: (state) => { rendered = renderRewind(state, { width: 80, height: 8, theme: monoTheme }).join("\n"); },
    onClose: () => undefined,
    onRestore: (index) => { restored = index; },
  });
  overlay.open(8);
  overlay.feedBytes("\r");
  overlay.flushPending();
  assert.match(rendered, /\[y\/N\]/);
  assert.equal(restored, undefined);
  overlay.feedBytes("y");
  assert.equal(restored, 0);
});
