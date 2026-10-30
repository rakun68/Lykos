import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ApprovalDeniedError, buildBashOperations, buildEditOperations, buildWriteOperations, type ApprovalRequest } from "../../gate/approval.js";
import { resolveTheme } from "../theme/resolve.js";
import { approvalViewFor, RawApprovalGate, type ApprovalView } from "./approval-modal.js";
import { renderScreenBlock } from "./blocks.js";

const mono = resolveTheme("mono", "none", "unicode");
const color = resolveTheme("rose-pine-moon", "truecolor", "unicode");

function req(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return { kind: "write", summary: "write 12 bytes", detail: "/proj/hello.txt", ...overrides };
}

function render(view: ApprovalView, width = 40, expanded = false): string[] {
  return renderScreenBlock({ id: "a", kind: "approval", approval: view }, { width, theme: mono, expanded });
}

describe("T49.1 (2026-09-02 item 11): the approval prompt is a block in the chat, not a takeover of the screen", () => {
  it("shows the action, the target, the body and the keys", () => {
    const lines = render(approvalViewFor(req({ body: "hello\nworld" })));
    assert.ok(lines.some((l) => /approval/.test(l) && /write/.test(l)), "names the action");
    assert.ok(lines.some((l) => l.includes("write 12 bytes")), "names the target");
    assert.ok(lines.some((l) => l.includes("hello")), "shows the body");
    // The four key hints pack greedily onto as few lines as fit the width
    // (blocks.ts's `packKeyPills`), so at 40 columns they wrap onto two —
    // joined back together here since this test cares that all four
    // survive, not which line each landed on.
    const keys = lines.filter((l) => /\[y\]|\[n\]|\[a\]|\[Esc\]/.test(l)).join(" ");
    assert.match(keys, /\[y\] allow once/);
    assert.match(keys, /\[n\] deny/);
    assert.match(keys, /\[a\] always/);
    assert.match(keys, /\[Esc\] deny/);
  });

  it("is bounded: a 500-line body does not produce a 500-line block, and says how much is folded", () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const lines = render(approvalViewFor(req({ body: big })));
    assert.ok(lines.length < 40, `a 500-line body rendered ${lines.length} rows`);
    assert.ok(lines.some((l) => /more lines/.test(l)), "names what is hidden rather than truncating silently");
  });

  it("/verbose expands it — the folded body is reachable, never lost", () => {
    const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const lines = render(approvalViewFor(req({ body: big })), 40, true);
    assert.ok(lines.some((l) => l.includes("line 499")), "the last body line is reachable when expanded");
  });

  it("an answered prompt records its decision instead of still asking", () => {
    const lines = render({ ...approvalViewFor(req()), decision: "deny" });
    assert.ok(lines.some((l) => l.includes("denied")));
    assert.ok(!lines.some((l) => l.includes("[y]")), "the keys are gone once there is nothing left to press");
  });

  it("every row is tinted across the full width under a colour theme, and emits no escapes under mono", () => {
    const width = 40;
    const tinted = renderScreenBlock({ id: "a", kind: "approval", approval: approvalViewFor(req()) }, { width, theme: color });
    assert.ok(tinted.every((l) => /\x1b\[48;2;/.test(l)), "every row carries a background");
    for (const line of render(approvalViewFor(req()), width)) {
      assert.doesNotMatch(line, /\x1b/, "mono must emit no escape at all");
    }
  });
});

describe("T49.2: RawApprovalGate — safe keys only, everything else ignored", () => {
  it("y resolves allow", async () => {
    const gate = new RawApprovalGate({ onRender: () => {} });
    const p = gate.request(req());
    gate.feedBytes("y");
    assert.equal(await p, "allow");
  });

  it("a resolves allow-always", async () => {
    const gate = new RawApprovalGate({ onRender: () => {} });
    const p = gate.request(req());
    gate.feedBytes("a");
    assert.equal(await p, "allow-always");
  });

  it("n resolves deny", async () => {
    const gate = new RawApprovalGate({ onRender: () => {} });
    const p = gate.request(req());
    gate.feedBytes("n");
    assert.equal(await p, "deny");
  });

  it("Escape resolves deny", async () => {
    const gate = new RawApprovalGate({ onRender: () => {} });
    const p = gate.request(req());
    gate.feedBytes("\x1b");
    gate.flushPending();
    assert.equal(await p, "deny");
  });

  it("Enter alone does nothing — no input path produces allow except y and a", async () => {
    const gate = new RawApprovalGate({ onRender: () => {} });
    const p = gate.request(req());
    gate.feedBytes("\r");
    gate.flushPending(); // the idle gap a real session's router always provides
    assert.equal(gate.isOpen, true, "Enter must not resolve the prompt");
    gate.feedBytes("y");
    assert.equal(await p, "allow");
  });

  it("every unmapped key is ignored: letters, digits, control codes, arrows, tab", async () => {
    const gate = new RawApprovalGate({ onRender: () => {} });
    const p = gate.request(req());
    // T210: `f` ("allow this folder") is a mapped key now, so it is no longer noise.
    const noise = "bcdeghijklmopqrstuvwxz0123456789\t\x01\x02\x1b[A\x1b[B\x1b[C\x1b[D";
    gate.feedBytes(noise);
    assert.equal(gate.isOpen, true, "none of the noise bytes may resolve the prompt");
    gate.feedBytes("y");
    assert.equal(await p, "allow");
  });

  it("f answers allow-folder, and F too (T210)", async () => {
    for (const key of ["f", "F"]) {
      const gate = new RawApprovalGate({ onRender: () => {}, onRememberFolder: () => {} });
      const p = gate.request(req());
      gate.feedBytes(key);
      assert.equal(await p, "allow-folder");
    }
  });

  it("protected requests offer only session allow and ignore always/folder (T211)", async () => {
    const protectedReq: ApprovalRequest = {
      kind: "write",
      summary: "write .git/config",
      detail: "/work/proj/.git/config",
      pathAsk: { rule: ".git/**", protected: true },
    };

    const lines = renderScreenBlock(
      { id: "a", kind: "approval", approval: approvalViewFor(protectedReq) },
      { width: 120, theme: mono },
    );
    const keys = lines.join("\n");
    assert.doesNotMatch(keys, /\[a\] always/);
    assert.doesNotMatch(keys, /\[f\] allow folder/);

    for (const click of [
      { key: "f", decision: "allow-folder" as const },
      { key: "a", decision: "allow-always" as const },
    ]) {
      const folders: string[] = [];
      const gate = new RawApprovalGate({
        projectId: "p",
        cwd: "/work/proj",
        onRender: () => {},
        onRememberFolder: (f) => folders.push(f),
        resolveClick: () => ({ kind: "approvalKey", ...click }),
      });
      const p = gate.request(protectedReq);
      gate.feedBytes("\x1b[<0;1;1M");
      const decision = await p;
      assert.deepEqual(folders, []);
      assert.notEqual(decision, "allow-always");
      assert.notEqual(decision, "allow-folder");
    }
  });

  it("bash path ask requests offer allow once and ignore always/folder (T212)", async () => {
    const bashReq: ApprovalRequest = {
      kind: "bash",
      summary: "run command",
      detail: "cat /etc/hosts",
      pathAsk: { rule: "outside the project directory" },
    };

    const lines = renderScreenBlock(
      { id: "a", kind: "approval", approval: approvalViewFor(bashReq) },
      { width: 120, theme: mono },
    );
    const keys = lines.join("\n");
    assert.match(keys, /\[y\] allow once/);
    assert.doesNotMatch(keys, /\[a\] always/);
    assert.doesNotMatch(keys, /\[f\] allow folder/);

    let resolved = false;
    const gate = new RawApprovalGate({
      projectId: "p",
      cwd: "/work/proj",
      onRender: () => {},
    });
    const p = gate.request(bashReq).then((r) => {
      resolved = true;
      return r;
    });
    gate.feedBytes("a");
    await new Promise((r) => setImmediate(r));
    assert.equal(resolved, false);

    gate.feedBytes("f");
    await new Promise((r) => setImmediate(r));
    assert.equal(resolved, false);

    gate.feedBytes("y");
    const dec = await p;
    assert.equal(dec, "allow");
  });

  it("uppercase Y/N/A also work (a real terminal doesn't guarantee case)", async () => {
    const gate = new RawApprovalGate({ onRender: () => {} });
    const p = gate.request(req());
    gate.feedBytes("Y");
    assert.equal(await p, "allow");
  });

  it("close() denies a prompt torn down mid-session", async () => {
    const gate = new RawApprovalGate({ onRender: () => {} });
    const p = gate.request(req());
    gate.close();
    assert.equal(await p, "deny");
  });

  it("Ctrl-C denies rather than being ignored — the only way to cancel a pending approval, since routeStdin() sends bytes here exclusively while the prompt is open", async () => {
    const gate = new RawApprovalGate({ onRender: () => {} });
    const p = gate.request(req());
    gate.feedBytes("\x03");
    assert.equal(await p, "deny");
  });
});

describe("RawApprovalGate — the prompt is re-rendered with its decision, on the same id, for every resolution path", () => {
  it("fires onRender twice with one id: the question, then the answer", async () => {
    for (const [label, decision, feed] of [
      ["y", "allow", (g: RawApprovalGate) => g.feedBytes("y")],
      ["n", "deny", (g: RawApprovalGate) => g.feedBytes("n")],
      ["a", "allow-always", (g: RawApprovalGate) => g.feedBytes("a")],
      ["Escape", "deny", (g: RawApprovalGate) => g.feedBytes("\x1b")],
      ["Ctrl-C", "deny", (g: RawApprovalGate) => g.feedBytes("\x03")],
    ] as const) {
      const seen: Array<{ id: string; view: ApprovalView }> = [];
      const gate = new RawApprovalGate({ onRender: (id, view) => seen.push({ id, view }) });
      const p = gate.request(req());
      assert.equal(seen.length, 1, `${label}: the question renders once, immediately`);
      assert.equal(seen[0]!.view.decision, undefined, `${label}: no decision before one is made`);
      feed(gate);
      if (label === "Escape") gate.flushPending();
      await p;
      assert.equal(seen.length, 2, `${label}: the decision re-renders it`);
      assert.equal(seen[1]!.id, seen[0]!.id, `${label}: same id, so the caller updates in place`);
      assert.equal(seen[1]!.view.decision, decision, `${label}: the decision is recorded on the block`);
    }
  });

  it("a stray key after resolution renders nothing further", async () => {
    let renders = 0;
    const gate = new RawApprovalGate({ onRender: () => (renders += 1) });
    const p = gate.request(req());
    gate.feedBytes("y");
    await p;
    gate.feedBytes("y"); // no pending request — must be a no-op
    assert.equal(renders, 2);
  });
});

describe("2026-09-02 item 11: PgUp/PgDn scroll the transcript, since the prompt itself no longer scrolls", () => {
  it("forwards both to the caller and never resolves the prompt", async () => {
    const scrolls: string[] = [];
    const gate = new RawApprovalGate({ onRender: () => {}, onScroll: (a) => scrolls.push(a) });
    const p = gate.request(req({ body: "a\nb\nc" }));
    gate.feedBytes("\x1b[5~");
    gate.feedBytes("\x1b[6~");
    assert.deepEqual(scrolls, ["pageUp", "pageDown"]);
    assert.equal(gate.isOpen, true, "scrolling is not a decision");
    gate.feedBytes("n");
    await p;
  });
});

/**
 * T210: the path rules are loaded before a request reaches the gate, and that load is asynchronous
 * (the config module is imported on demand), so a test waits for the prompt to be open instead of
 * assuming it opened in the same tick.
 */
async function promptOpen(gate: RawApprovalGate): Promise<void> {
  for (let i = 0; i < 500 && !gate.isOpen; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(gate.isOpen, true, "the prompt never opened");
}

describe("T49: the existing approval flows work with RawApprovalGate standing in for ScriptedGate", () => {
  it("buildWriteOperations — allow writes the real file, deny leaves nothing on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t49-write-"));
    try {
      const allowGate = new RawApprovalGate({ onRender: () => {} });
      const target = join(dir, "hello.txt");
      const writeOp = buildWriteOperations(dir, allowGate);
      const write = writeOp.writeFile(target, "hi");
      await promptOpen(allowGate);
      allowGate.feedBytes("y");
      await write;
      assert.equal(readFileSync(target, "utf8"), "hi");

      const denyGate = new RawApprovalGate({ onRender: () => {} });
      const target2 = join(dir, "second.txt");
      const writeOp2 = buildWriteOperations(dir, denyGate);
      const write2 = writeOp2.writeFile(target2, "hi");
      await promptOpen(denyGate);
      denyGate.feedBytes("n");
      await assert.rejects(write2, ApprovalDeniedError);
      assert.equal(existsSync(target2), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Reversed by T131's follow-up: this asserted that `authorize()`
  // short-circuited on a kind-wide `alwaysAllowed` set, which is exactly the
  // line that took the interaction mode out of the decision. Every request
  // reaches the gate now; in Auto the gate itself allows a write without
  // prompting, which is where that convenience properly lives.
  it("buildEditOperations — a second edit still reaches the gate, which decides it by mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t49-edit-"));
    try {
      const gate = new RawApprovalGate({ onRender: () => {} });
      const ops = buildEditOperations(dir, gate);
      const target = join(dir, "f.txt");
      const first = ops.writeFile(target, "v1");
      await promptOpen(gate);
      gate.feedBytes("a");
      await first;
      assert.equal(readFileSync(target, "utf8"), "v1");

      // Auto mode is where "no further prompt" belongs: the gate allows a
      // write itself, without a keystroke and without anything in front of it.
      gate.setMode("auto");
      await ops.writeFile(target, "v2");
      assert.equal(readFileSync(target, "utf8"), "v2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("buildBashOperations — deny never runs the command", async () => {
    const gate = new RawApprovalGate({ onRender: () => {} });
    const ops = buildBashOperations(process.cwd(), gate);
    const run = ops.exec("echo should-not-run", process.cwd(), { onData: () => {} });
    await promptOpen(gate);
    gate.feedBytes("n");
    await assert.rejects(run, ApprovalDeniedError);
  });
});
