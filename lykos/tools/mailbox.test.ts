import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoApproveGate } from "../gate/approval.js";
import { loadTools } from "./session-tools.js";
import {
  DEFAULT_PEER_NAME,
  MAILBOX_CAP,
  PEER_WAIT_MAX_MS,
  PeerBus,
  newPeerFamily,
  type PeerMailbox,
} from "./mailbox.js";

// ---------------------------------------------------------------------------
// D2: the bus belongs to a session family, and nothing reaches across two
// ---------------------------------------------------------------------------
//
// This is the first test in the file because it is the decision the ticket
// turns on. The reference implementation's bus is a process-global singleton;
// this one is not, and "not" has to be provable rather than asserted in a
// comment.

describe("P10.5 D2: two session families cannot see each other's mailboxes", () => {
  it("a send in one family reaches nothing in the other, even with identical names", () => {
    const familyA = new PeerBus();
    const familyB = new PeerBus();
    const mainA = familyA.join("main");
    const scoutA = familyA.join("scout");
    const mainB = familyB.join("main");
    const scoutB = familyB.join("scout");
    // Same names in both. If the bus were module-level, these would be one
    // roster of two and the send below would be seen twice.
    assert.deepEqual([mainA.name, scoutA.name], ["main", "scout"]);
    assert.deepEqual([mainB.name, scoutB.name], ["main", "scout"]);

    const report = mainA.send("scout", "family A only");
    assert.equal(report.ok, true);

    assert.deepEqual(
      scoutA.inbox().messages.map((m) => m.body),
      ["family A only"],
    );
    assert.deepEqual(scoutB.inbox().messages, [], "family B's scout saw family A's mail");
    assert.deepEqual(mainB.inbox().messages, []);
  });

  it("neither family's roster mentions the other's members", () => {
    const familyA = new PeerBus();
    const familyB = new PeerBus();
    familyA.join("main");
    familyA.join("scout");
    const mainB = familyB.join("main");
    familyB.join("watcher");

    assert.deepEqual(familyA.liveNames().sort(), ["main", "scout"]);
    assert.deepEqual(familyB.liveNames().sort(), ["main", "watcher"]);
    assert.equal(familyA.has("watcher"), false);
    assert.equal(familyB.has("scout"), false);
    assert.deepEqual(
      mainB.livePeers(),
      ["watcher"],
      "family B listed a peer that belongs to family A",
    );
  });

  it("a send addressed to a name that only exists in the other family fails as unknown", () => {
    const familyA = new PeerBus();
    const familyB = new PeerBus();
    const mainA = familyA.join("main");
    familyB.join("watcher");

    const report = mainA.send("watcher", "across the wall");
    assert.equal(report.ok, false);
    assert.deepEqual(report.receipts, [{ to: "watcher", delivered: false, reason: "unknown" }]);
  });

  it("a broadcast stops at the family boundary", () => {
    const familyA = new PeerBus();
    const familyB = new PeerBus();
    const mainA = familyA.join("main");
    const scoutA = familyA.join("scout");
    const scoutB = familyB.join("scout");

    const report = mainA.send("all", "everyone in MY family");
    assert.equal(report.ok, true);
    assert.deepEqual(report.receipts, [{ to: "scout", delivered: true }]);
    assert.equal(scoutA.inbox().messages.length, 1);
    assert.equal(scoutB.inbox().messages.length, 0);
  });

  it("a wait in one family is not satisfied by a send in the other", async () => {
    const familyA = new PeerBus();
    const familyB = new PeerBus();
    const mainA = familyA.join("main");
    familyA.join("scout"); // so A's wait has a possible sender and actually parks
    const mainB = familyB.join("main");
    const scoutB = familyB.join("scout");

    const waiting = mainA.wait({ timeoutMs: 150 });
    scoutB.send("main", "B's business");
    const outcome = await waiting;
    assert.equal(outcome.outcome, "timeout");
    assert.deepEqual(
      mainB.inbox().messages.map((m) => m.body),
      ["B's business"],
      "the message went somewhere other than its own family",
    );
    assert.equal(familyA.waiterCount(), 0);
  });

  // The decision is only worth anything if the WIRING matches it. Two
  // `loadTools()` calls are two sessions in one process, which is exactly the
  // MCP-worker case, and the mailboxes they hand their `hub` tools must be
  // different objects on different buses.
  it("two loadTools() calls — two sessions in one process — get different buses", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-mailbox-"));
    try {
      const deps = { cwd: dir, gate: new AutoApproveGate(), modelProvider: "", modelId: "" };
      const one = loadTools(["read"], deps);
      const two = loadTools(["read"], deps);
      assert.notEqual(one.mailbox, two.mailbox);
      assert.notEqual(one.mailbox.bus, two.mailbox.bus);
      assert.equal(one.mailbox.name, DEFAULT_PEER_NAME);
      assert.equal(two.mailbox.name, DEFAULT_PEER_NAME);
      // Same name, and still no reachability: session one's bus has never
      // heard of anyone but itself.
      assert.deepEqual(one.mailbox.livePeers(), []);
      assert.deepEqual(two.mailbox.livePeers(), []);
      const report = one.mailbox.send("main", "hello, other session");
      assert.equal(report.ok, false);
      assert.deepEqual(report.receipts, [{ to: "main", delivered: false, reason: "self" }]);
      assert.equal(two.mailbox.inbox().messages.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

// ---------------------------------------------------------------------------
// Joining, naming and the roster
// ---------------------------------------------------------------------------

describe("P10.5: joining a family", () => {
  it("mints a unique name per member rather than sharing a mailbox", () => {
    const bus = new PeerBus();
    assert.equal(bus.join("scout").name, "scout");
    assert.equal(bus.join("scout").name, "scout-2");
    assert.equal(bus.join("scout").name, "scout-3");
  });

  it("normalises a label into something a model can retype", () => {
    const bus = new PeerBus();
    assert.equal(bus.join("Code Reviewer!").name, "code-reviewer");
    assert.equal(bus.join("   ").name, "agent");
  });

  it("a solo family is a family of one, with no peers and nothing shared", () => {
    const solo = newPeerFamily();
    assert.equal(solo.name, DEFAULT_PEER_NAME);
    assert.deepEqual(solo.livePeers(), []);
    assert.equal(solo.live, true);
  });

  it("keeps a finished member on the roster — nothing is ever deleted", () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    const scout = bus.join("scout");
    scout.leave();
    assert.deepEqual(main.livePeers(), []);
    const roster = bus.roster();
    assert.deepEqual(
      roster.map((r) => [r.name, r.status]),
      [
        ["main", "live"],
        ["scout", "finished"],
      ],
    );
    assert.ok(roster[1]!.leftAt !== undefined);
  });

  it("leave is idempotent, because the spawn and the child's own teardown both call it", () => {
    const bus = new PeerBus();
    const scout = bus.join("scout");
    scout.leave();
    const first = bus.roster()[0]!.leftAt;
    scout.leave();
    assert.equal(bus.roster()[0]!.leftAt, first);
    assert.equal(scout.live, false);
  });
});

// ---------------------------------------------------------------------------
// D4: delivery reports failure
// ---------------------------------------------------------------------------

describe("P10.5 D4: delivery is honest about failure", () => {
  it("a send to a live peer arrives, named by its sender", () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    const scout = bus.join("scout");
    const report = main.send("scout", "look at src/index.ts");
    assert.equal(report.ok, true);
    assert.deepEqual(report.receipts, [{ to: "scout", delivered: true }]);
    const got = scout.inbox();
    assert.equal(got.messages.length, 1);
    const message = got.messages[0]!;
    assert.equal(message.from, "main");
    assert.equal(message.to, "scout");
    assert.equal(message.body, "look at src/index.ts");
    assert.match(message.id, /^msg-[0-9a-f]{6}$/);
    assert.ok(!Number.isNaN(Date.parse(message.sentAt)));
  });

  it("a send to an unknown peer fails and lists who is live", () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    bus.join("scout");
    const report = main.send("ghost", "hello?");
    assert.equal(report.ok, false);
    assert.deepEqual(report.receipts, [{ to: "ghost", delivered: false, reason: "unknown" }]);
    assert.deepEqual(report.live.sort(), ["main", "scout"]);
  });

  it("a send to a finished peer fails rather than queueing for nobody", () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    const scout = bus.join("scout");
    scout.leave();
    const report = main.send("scout", "are you there");
    assert.equal(report.ok, false);
    assert.deepEqual(report.receipts, [{ to: "scout", delivered: false, reason: "finished" }]);
    assert.equal(bus.read("scout").messages.length, 0, "it was queued for an agent that cannot read it");
  });

  it("a send to yourself is refused", () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    const report = main.send("main", "note to self");
    assert.equal(report.ok, false);
    assert.deepEqual(report.receipts, [{ to: "main", delivered: false, reason: "self" }]);
  });

  it("a broadcast reaches every live peer but the sender, and reports each", () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    const scout = bus.join("scout");
    const watcher = bus.join("watcher");
    const gone = bus.join("gone");
    gone.leave();

    const report = main.send("all", "stop what you are doing");
    assert.equal(report.ok, true);
    assert.deepEqual(report.receipts, [
      { to: "scout", delivered: true },
      { to: "watcher", delivered: true },
    ]);
    assert.equal(scout.inbox().messages[0]!.to, "all");
    assert.equal(watcher.inbox().messages.length, 1);
    assert.equal(main.inbox().messages.length, 0, "the sender got its own broadcast");
  });

  it("a broadcast with nobody live is a failure, not a silent success", () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    const scout = bus.join("scout");
    scout.leave();
    const report = main.send("all", "anyone?");
    assert.equal(report.ok, false);
    assert.deepEqual(report.receipts, []);
    assert.deepEqual(report.live, ["main"]);
  });
});

// ---------------------------------------------------------------------------
// D6: peek or drain
// ---------------------------------------------------------------------------

describe("P10.5 D6: inbox peeks or drains", () => {
  it("drains by default and says so", () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    const scout = bus.join("scout");
    scout.send("main", "one");
    scout.send("main", "two");
    const first = main.inbox();
    assert.equal(first.drained, true);
    assert.deepEqual(first.messages.map((m) => m.body), ["one", "two"]);
    assert.deepEqual(main.inbox().messages, []);
  });

  it("peek leaves the messages in place and says so", () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    const scout = bus.join("scout");
    scout.send("main", "still here");
    const peeked = main.inbox({ peek: true });
    assert.equal(peeked.drained, false);
    assert.deepEqual(peeked.messages.map((m) => m.body), ["still here"]);
    assert.deepEqual(main.inbox({ peek: true }).messages.map((m) => m.body), ["still here"]);
    assert.equal(main.inbox().drained, true);
    assert.deepEqual(main.inbox().messages, []);
  });

  it("holds MAILBOX_CAP messages and reports how many older ones it dropped", () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    const scout = bus.join("scout");
    for (let i = 0; i < MAILBOX_CAP + 3; i += 1) scout.send("main", `m${i}`);
    const got = main.inbox();
    assert.equal(got.messages.length, MAILBOX_CAP);
    assert.equal(got.dropped, 3);
    assert.equal(got.messages[0]!.body, "m3");
    assert.equal(main.inbox().dropped, 0, "the drop count resets with the drain");
  });
});

// ---------------------------------------------------------------------------
// D5: wait, and its endings
// ---------------------------------------------------------------------------

describe("P10.5 D5: wait distinguishes its endings and leaves nothing behind", () => {
  it("returns the message that arrives while it is parked", async () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    const scout = bus.join("scout");
    const waiting = main.wait({ timeoutMs: 5000 });
    setTimeout(() => scout.send("main", "found it"), 10);
    const outcome = await waiting;
    assert.equal(outcome.outcome, "message");
    assert.equal(outcome.outcome === "message" && outcome.message.body, "found it");
    assert.equal(outcome.outcome === "message" && outcome.message.from, "scout");
    assert.equal(bus.waiterCount(), 0);
  });

  it("a message taken by a parked wait is not also left in the inbox", async () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    const scout = bus.join("scout");
    const waiting = main.wait({ timeoutMs: 5000 });
    scout.send("main", "exactly once");
    await waiting;
    assert.deepEqual(main.inbox().messages, []);
  });

  it("returns a message already queued, without blocking", async () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    const scout = bus.join("scout");
    scout.send("main", "sent before the wait");
    const outcome = await main.wait({ timeoutMs: PEER_WAIT_MAX_MS });
    assert.equal(outcome.outcome, "message");
    assert.equal(outcome.waitedMs, 0);
    assert.equal(bus.waiterCount(), 0);
  });

  it("times out as its own outcome, not as a message and not as an error", async () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    bus.join("scout");
    const outcome = await main.wait({ timeoutMs: 60 });
    assert.equal(outcome.outcome, "timeout");
    assert.ok(outcome.waitedMs >= 0);
    assert.equal(bus.waiterCount(), 0);
  });

  it("with no live peers it returns immediately rather than burning the timeout", async () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    const scout = bus.join("scout");
    scout.leave();
    const started = Date.now();
    const outcome = await main.wait({ timeoutMs: PEER_WAIT_MAX_MS });
    assert.equal(outcome.outcome, "no-peers");
    assert.ok(Date.now() - started < 1000, "it blocked on an empty room");
    assert.equal(bus.waiterCount(), 0);
  });

  it("a queued message beats the empty room — a finished peer's mail is still mail", async () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    const scout = bus.join("scout");
    scout.send("main", "last words");
    scout.leave();
    const outcome = await main.wait({ timeoutMs: 50 });
    assert.equal(outcome.outcome, "message");
    assert.equal(outcome.outcome === "message" && outcome.message.body, "last words");
  });

  it("the last peer leaving releases a parked wait instead of leaving it to its timer", async () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    const scout = bus.join("scout");
    const started = Date.now();
    const waiting = main.wait({ timeoutMs: PEER_WAIT_MAX_MS });
    setTimeout(() => scout.leave(), 10);
    const outcome = await waiting;
    assert.equal(outcome.outcome, "no-peers");
    assert.ok(Date.now() - started < 5000);
    assert.equal(bus.waiterCount(), 0);
  });

  it("a waiter's own agent leaving ends its wait", async () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    bus.join("scout");
    const waiting = main.wait({ timeoutMs: PEER_WAIT_MAX_MS });
    setTimeout(() => main.leave(), 10);
    assert.equal((await waiting).outcome, "no-peers");
    assert.equal(bus.waiterCount(), 0);
  });

  it("from restricts which sender satisfies the wait", async () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    const scout = bus.join("scout");
    const watcher = bus.join("watcher");
    const waiting = main.wait({ timeoutMs: 5000, from: "watcher" });
    scout.send("main", "not the one you asked for");
    watcher.send("main", "the one you asked for");
    const outcome = await waiting;
    assert.equal(outcome.outcome === "message" && outcome.message.body, "the one you asked for");
    // The unmatched message was queued, not dropped.
    assert.deepEqual(main.inbox().messages.map((m) => m.from), ["scout"]);
    assert.equal(bus.waiterCount(), 0);
  });

  it("from a peer that is not live returns no-peers immediately", async () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    const scout = bus.join("scout");
    bus.join("watcher");
    scout.leave();
    const outcome = await main.wait({ timeoutMs: PEER_WAIT_MAX_MS, from: "scout" });
    assert.equal(outcome.outcome, "no-peers");
    assert.equal(bus.waiterCount(), 0);
  });

  it("a zero timeout checks the mailbox and returns", async () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    bus.join("scout");
    const outcome = await main.wait({ timeoutMs: 0 });
    assert.equal(outcome.outcome, "timeout");
    assert.equal(outcome.waitedMs, 0);
    assert.equal(bus.waiterCount(), 0);
  });

  it("an abort ends the wait as its own outcome, and unparks it", async () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    bus.join("scout");
    const controller = new AbortController();
    const waiting = main.wait({ timeoutMs: PEER_WAIT_MAX_MS, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    assert.equal((await waiting).outcome, "aborted");
    assert.equal(bus.waiterCount(), 0);
  });

  it("an already-aborted signal never parks anything", async () => {
    const bus = new PeerBus();
    const main = bus.join("main");
    bus.join("scout");
    const controller = new AbortController();
    controller.abort();
    assert.equal((await main.wait({ signal: controller.signal })).outcome, "aborted");
    assert.equal(bus.waiterCount(), 0);
  });

  it("every member leaving leaves no waiter and no timer behind", async () => {
    const bus = new PeerBus();
    const members: PeerMailbox[] = [bus.join("main"), bus.join("scout"), bus.join("watcher")];
    const waits = members.map((m) => m.wait({ timeoutMs: PEER_WAIT_MAX_MS }));
    for (const m of members) m.leave();
    const outcomes = await Promise.all(waits);
    assert.deepEqual(outcomes.map((o) => o.outcome), ["no-peers", "no-peers", "no-peers"]);
    assert.equal(bus.waiterCount(), 0);
  });
});
