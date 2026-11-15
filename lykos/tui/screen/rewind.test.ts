import assert from "node:assert/strict";
import test from "node:test";
import { RewindOverlay, renderRewind, type RewindState } from "./rewind.js";
import type { RewindPoint } from "../../session/rewind.js";
import { resolveTheme } from "../theme/resolve.js";

const monoTheme = resolveTheme("mono", "none", "unicode");

const points: RewindPoint[] = [
  { text: "first: change a", turn: 0 },
  { text: "second: change b", turn: 2 },
  { text: "third: change c", turn: 4 },
];

function overlay() {
  let rendered = "";
  let closed = 0;
  const o = new RewindOverlay({
    onRender: (state: RewindState) => {
      rendered = renderRewind(state, { width: 80, height: 12, theme: monoTheme }).join("\n");
    },
    onClose: () => {
      closed += 1;
    },
  });
  const keys = (bytes: string) => {
    o.feedBytes(bytes);
    o.flushPending();
  };
  return { o, keys, rendered: () => rendered, closed: () => closed };
}

test("T263: the picker opens on the latest prompt; Enter offers the restores, and Enter takes the highlighted one", async () => {
  const p = overlay();
  const chosen = p.o.open(12, points);
  assert.match(p.rendered(), /› .*third: change c/);
  p.keys("\r");
  assert.match(p.rendered(), /code and conversation/);
  assert.match(p.rendered(), /conversation only/);
  assert.match(p.rendered(), /code only/);
  p.keys("\r");
  assert.deepEqual(await chosen, { index: 2, restore: "both" });
  assert.equal(p.o.isOpen, false);
  assert.equal(p.closed(), 1);
});

test("T263: arrows choose the prompt, a digit chooses the restore", async () => {
  const p = overlay();
  const chosen = p.o.open(12, points);
  p.keys("\x1b[A");
  p.keys("\r");
  p.keys("3");
  assert.deepEqual(await chosen, { index: 1, restore: "code" });
});

test("T263: Esc on the restores goes back to the prompts; Esc there cancels and changes nothing", async () => {
  const p = overlay();
  const chosen = p.o.open(12, points);
  p.keys("\r");
  p.keys("\x1b");
  assert.match(p.rendered(), /third: change c/);
  assert.doesNotMatch(p.rendered(), /conversation only/);
  p.keys("\x1b");
  assert.equal(await chosen, undefined);
  assert.equal(p.o.isOpen, false);
});

test("T265: summarize from here asks for an optional note; Enter sends it with the choice", async () => {
  const p = overlay();
  const chosen = p.o.open(12, points);
  p.keys("\x1b[A");
  p.keys("\r");
  assert.match(p.rendered(), /summarize from here/);
  p.keys("4");
  assert.match(p.rendered(), /add context for the summary \(optional\)/);
  p.keys("keep b");
  p.keys("\x7f");
  p.keys("B");
  assert.match(p.rendered(), /keep B/);
  p.keys("\r");
  assert.deepEqual(await chosen, { index: 1, restore: "summarize", note: "keep B" });
});

test("T265: an empty note is no note; Esc on the note goes back to the restores", async () => {
  const p = overlay();
  const chosen = p.o.open(12, points);
  p.keys("\r");
  p.keys("4");
  assert.match(p.rendered(), /add context/);
  p.keys("x");
  p.keys("\x1b");
  assert.match(p.rendered(), /conversation only/);
  p.keys("4");
  assert.doesNotMatch(p.rendered(), /: x/, "the note starts empty again");
  p.keys("\r");
  assert.deepEqual(await chosen, { index: 2, restore: "summarize" });
});
