// The bus two agents in one session family send messages over.
//
// **Why it exists.** Lykos spawns subagents, and the only channel between a
// parent and a child is the child's final answer. A child that learns
// something the parent needs has nowhere to put it until it finishes, and a
// parent that wants to tell a running child one more fact has nothing but
// `steer_subagent`. This is the missing wire.
//
// **THE BUS IS OWNED BY A SESSION FAMILY, NEVER BY THIS MODULE (D2).** A bus
// hung off a process-global singleton is the same mistake a module-level job
// registry would be and it fails in the same way: two
// unrelated sessions share one process in every MCP worker and in every test
// file, and a process-global bus lets one of them read the other's mail,
// broadcast into the other's conversation, and see the other's roster. So
// there is no module-level state in this file at all — a `PeerBus` is created
// where a session family is created (`session/boot.ts`, beside the
// `SpawnContext`) and handed down to each child that family spawns. A session
// that never spawns is a family of one, with a bus nobody else is in.
//
// **A MESSAGE IS DATA (D3).** Nothing here injects, interrupts, revives, or
// wakes anything. A message becomes one entry in the recipient's mailbox and
// reaches the model only when the model asks for it, as the CONTENT of a tool
// result with its sender named — exactly the standing a `read` result has. The
// tool's description says so in a sentence, because the recipient has to treat
// a peer's words as a peer's words rather than as an instruction from the
// human. The reference's "messaging a parked agent revives it" is deliberately
// not ported: a message that can restart an agent is an instruction with
// authority, whatever it says in its body.
//
// **DELIVERY REPORTS FAILURE (D4).** `send` to a name nobody holds, or to one
// whose agent has finished, is a failure that names the peer and lists who is
// live. It is never queued for a recipient that cannot arrive and it is never
// reported as a success — a send that silently vanishes is worse than no
// mailbox, because the sender goes on believing it was heard.
//
// **A WAIT LEAVES NOTHING BEHIND (D5).** Every parked waiter holds a timer and
// both are released together, on every path: a message, the timeout, an abort,
// the waiter's own agent leaving, and the moment the last peer that could have
// sent it anything leaves. That last one is why `wait` cannot hang past the
// end of a family: when nobody can send, every waiter is released immediately
// rather than burning its timeout on an empty room.

import { randomBytes } from "node:crypto";

/** How many messages one mailbox holds before the oldest are dropped. Matches the reference's cap. */
export const MAILBOX_CAP = 100;

/** How long `wait` blocks when the caller does not say. */
export const PEER_WAIT_DEFAULT_MS = 60_000;

/**
 * The ceiling on a `wait`. There is deliberately no "wait forever": the
 * reference spells `0` as indefinite, and an indefinite wait is a hang with a
 * nicer name — the session cannot be ended, the turn cannot be costed, and the
 * timer outlives whatever asked for it.
 */
export const PEER_WAIT_MAX_MS = 600_000;

/** The name the root of a family joins under when nobody chose one. */
export const DEFAULT_PEER_NAME = "main";

export interface PeerMessage {
  id: string;
  /** The peer that sent it. Always a real member's name, never caller-supplied. */
  from: string;
  /** The name it was addressed to: a peer, or `all` for a broadcast. */
  to: string;
  body: string;
  sentAt: string;
}

export type PeerStatus = "live" | "finished";

export interface PeerState {
  name: string;
  status: PeerStatus;
  joinedAt: string;
  /** When the agent finished. Nothing is ever removed from the roster — a finished peer is still a name that existed. */
  leftAt?: string;
}

/** Why one recipient of one `send` did or did not get it. */
export interface DeliveryReceipt {
  to: string;
  delivered: boolean;
  /** Set when `delivered` is false. The recipient-shaped half of D4. */
  reason?: "unknown" | "finished" | "self";
}

export interface SendReport {
  /** True when at least one recipient actually received it. */
  ok: boolean;
  receipts: DeliveryReceipt[];
  /** The live names at the moment of the send, so a failure can list them (D4). */
  live: string[];
}

export interface InboxResult {
  messages: PeerMessage[];
  /** D6: false means the messages were left where they were. */
  drained: boolean;
  /** How many were dropped at the cap since the last read. */
  dropped: number;
}

export type WaitOutcome =
  | { outcome: "message"; message: PeerMessage; waitedMs: number }
  | { outcome: "timeout"; waitedMs: number }
  | { outcome: "no-peers"; waitedMs: number }
  | { outcome: "aborted"; waitedMs: number };

export interface WaitOpts {
  /** Clamped to [0, PEER_WAIT_MAX_MS]. 0 checks the mailbox and returns. */
  timeoutMs?: number;
  /** Only accept a message from this peer. */
  from?: string;
  signal?: AbortSignal;
}

interface Waiter {
  from: string | undefined;
  /** Hands a message to the parked call. Called at most once; the bus removes the waiter first. */
  deliver: (message: PeerMessage) => void;
  /** Ends the wait with `no-peers` because nobody is left who could send to it. */
  release: () => void;
}

interface Member {
  state: PeerState;
  queue: PeerMessage[];
  dropped: number;
  waiters: Set<Waiter>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function mintMessageId(): string {
  return `msg-${randomBytes(3).toString("hex")}`;
}

/** Names are addressed by the model, so they are kept to what a model can retype without quoting. */
function sanitizeLabel(label: string): string {
  const cleaned = label.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned === "" ? "agent" : cleaned.slice(0, 40);
}

/**
 * One session family's mailboxes.
 *
 * Created per family and passed in, never reached for from module scope (D2).
 * Everything a tool needs is on `PeerMailbox`, the per-member handle `join`
 * returns; the bus itself is the thing a parent hands to a child.
 */
export class PeerBus {
  private readonly members = new Map<string, Member>();

  /**
   * Register a live member and return its handle.
   *
   * The name is derived from `label` and made unique within this bus, because
   * two `scout` children are the ordinary case and a mailbox two agents share
   * is not a mailbox. The caller is told the name it got by reading
   * `mailbox.name` — it never gets to assert one.
   */
  join(label: string = DEFAULT_PEER_NAME): PeerMailbox {
    const base = sanitizeLabel(label);
    let name = base;
    for (let n = 2; this.members.has(name); n += 1) name = `${base}-${n}`;
    this.members.set(name, {
      state: { name, status: "live", joinedAt: nowIso() },
      queue: [],
      dropped: 0,
      waiters: new Set(),
    });
    return new PeerMailbox(this, name);
  }

  /** Every member this family has ever had, finished ones included. Nothing is deleted. */
  roster(): PeerState[] {
    return [...this.members.values()].map((m) => ({ ...m.state }));
  }

  /** The names that can receive a message right now. */
  liveNames(): string[] {
    return [...this.members.values()].filter((m) => m.state.status === "live").map((m) => m.state.name);
  }

  isLive(name: string): boolean {
    return this.members.get(name)?.state.status === "live";
  }

  has(name: string): boolean {
    return this.members.has(name);
  }

  /** Parked waiters across the whole family. A test asserts this is 0 when the family is done. */
  waiterCount(): number {
    let total = 0;
    for (const m of this.members.values()) total += m.waiters.size;
    return total;
  }

  /**
   * Deliver one message, and report per recipient what happened (D4).
   *
   * `to` is either a member's name or `all`. A broadcast reaches every LIVE
   * member except the sender; it is not an error that a finished member misses
   * it, but a direct send to one is, because the sender named that agent and
   * has to know it was not there.
   */
  send(from: string, to: string, body: string): SendReport {
    const live = this.liveNames();
    if (to === "all") {
      const recipients = live.filter((n) => n !== from);
      const receipts = recipients.map((n) => this.deliverTo(from, to, n, body));
      return { ok: receipts.some((r) => r.delivered), receipts, live };
    }
    if (to === from) {
      return { ok: false, receipts: [{ to, delivered: false, reason: "self" }], live };
    }
    const member = this.members.get(to);
    if (member === undefined) {
      return { ok: false, receipts: [{ to, delivered: false, reason: "unknown" }], live };
    }
    if (member.state.status !== "live") {
      return { ok: false, receipts: [{ to, delivered: false, reason: "finished" }], live };
    }
    const receipt = this.deliverTo(from, to, to, body);
    return { ok: receipt.delivered, receipts: [receipt], live };
  }

  private deliverTo(from: string, addressedTo: string, recipient: string, body: string): DeliveryReceipt {
    const member = this.members.get(recipient);
    if (member === undefined) return { to: recipient, delivered: false, reason: "unknown" };
    if (member.state.status !== "live") return { to: recipient, delivered: false, reason: "finished" };
    const message: PeerMessage = {
      id: mintMessageId(),
      from,
      to: addressedTo,
      body,
      sentAt: nowIso(),
    };
    // A parked `wait` takes the message instead of the queue, so exactly one
    // reader ever sees it: handing it to both would make `wait` followed by
    // `inbox` report the same message twice.
    for (const waiter of member.waiters) {
      if (waiter.from !== undefined && waiter.from !== from) continue;
      member.waiters.delete(waiter);
      waiter.deliver(message);
      return { to: recipient, delivered: true };
    }
    member.queue.push(message);
    while (member.queue.length > MAILBOX_CAP) {
      member.queue.shift();
      member.dropped += 1;
    }
    return { to: recipient, delivered: true };
  }

  /** D6: read the mailbox, draining it unless asked to peek. */
  read(name: string, opts: { peek?: boolean } = {}): InboxResult {
    const member = this.members.get(name);
    if (member === undefined) return { messages: [], drained: false, dropped: 0 };
    const messages = [...member.queue];
    const dropped = member.dropped;
    if (opts.peek !== true) {
      member.queue.length = 0;
      member.dropped = 0;
    }
    return { messages, drained: opts.peek !== true, dropped };
  }

  /** The first queued message matching `from`, removed from the queue. */
  takeNext(name: string, from?: string): PeerMessage | undefined {
    const member = this.members.get(name);
    if (member === undefined) return undefined;
    const index = member.queue.findIndex((m) => from === undefined || m.from === from);
    if (index < 0) return undefined;
    return member.queue.splice(index, 1)[0];
  }

  /**
   * Who could still send a message to `name` (optionally: only `from`).
   *
   * D5 is this function: a wait whose answer here is empty cannot ever be
   * satisfied, so it returns now rather than at the end of its timeout.
   */
  possibleSenders(name: string, from?: string): string[] {
    if (from !== undefined) return this.isLive(from) && from !== name ? [from] : [];
    return this.liveNames().filter((n) => n !== name);
  }

  park(name: string, waiter: Waiter): void {
    this.members.get(name)?.waiters.add(waiter);
  }

  unpark(name: string, waiter: Waiter): void {
    this.members.get(name)?.waiters.delete(waiter);
  }

  /**
   * Mark a member finished. Idempotent, because both the spawn that created a
   * child and the child's own teardown call it and neither may depend on the
   * other having run first.
   *
   * Every waiter that can no longer be satisfied is released here rather than
   * left to its timer: the member's own (it is not listening any more) and
   * every other member's whose last possible sender just left.
   */
  leave(name: string): void {
    const member = this.members.get(name);
    if (member === undefined || member.state.status === "finished") return;
    member.state.status = "finished";
    member.state.leftAt = nowIso();
    for (const waiter of [...member.waiters]) {
      member.waiters.delete(waiter);
      waiter.release();
    }
    for (const other of this.members.values()) {
      if (other.state.status !== "live") continue;
      for (const waiter of [...other.waiters]) {
        if (this.possibleSenders(other.state.name, waiter.from).length > 0) continue;
        other.waiters.delete(waiter);
        waiter.release();
      }
    }
  }
}

/**
 * One agent's seat on the bus.
 *
 * This is the whole surface `hub` talks to: the tool never learns another
 * member's queue exists, and it cannot name itself as somebody else, because
 * `from` is this handle's own name rather than a parameter.
 */
export class PeerMailbox {
  constructor(
    readonly bus: PeerBus,
    readonly name: string,
  ) {}

  get live(): boolean {
    return this.bus.isLive(this.name);
  }

  /** Who else is live right now. */
  livePeers(): string[] {
    return this.bus.liveNames().filter((n) => n !== this.name);
  }

  /** Everyone this family has had, this agent included. */
  roster(): PeerState[] {
    return this.bus.roster();
  }

  send(to: string, body: string): SendReport {
    return this.bus.send(this.name, to, body);
  }

  inbox(opts: { peek?: boolean } = {}): InboxResult {
    return this.bus.read(this.name, opts);
  }

  leave(): void {
    this.bus.leave(this.name);
  }

  /**
   * Block until a message arrives, or until the wait ends some other way.
   *
   * The four endings are values, not prose (D5), so the model can branch on
   * `outcome` without reading a sentence. Nothing is left behind on any of
   * them: the timer is cleared, the waiter is unparked and the abort listener
   * is removed in one `finish`, whichever path reached it first.
   */
  async wait(opts: WaitOpts = {}): Promise<WaitOutcome> {
    const started = Date.now();
    const queued = this.bus.takeNext(this.name, opts.from);
    if (queued !== undefined) return { outcome: "message", message: queued, waitedMs: 0 };
    if (opts.signal?.aborted === true) return { outcome: "aborted", waitedMs: 0 };
    // D5: an empty room ends the wait now. Checked AFTER the queue, because a
    // message a finished peer already sent is still a message.
    if (this.bus.possibleSenders(this.name, opts.from).length === 0) {
      return { outcome: "no-peers", waitedMs: 0 };
    }
    const ms = Math.min(Math.max(0, Math.floor(opts.timeoutMs ?? PEER_WAIT_DEFAULT_MS)), PEER_WAIT_MAX_MS);
    if (ms === 0) return { outcome: "timeout", waitedMs: 0 };

    return await new Promise<WaitOutcome>((resolve) => {
      let settled = false;
      const finish = (outcome: WaitOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.bus.unpark(this.name, waiter);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const waiter: Waiter = {
        from: opts.from,
        deliver: (message) => finish({ outcome: "message", message, waitedMs: Date.now() - started }),
        release: () => finish({ outcome: "no-peers", waitedMs: Date.now() - started }),
      };
      const onAbort = (): void => finish({ outcome: "aborted", waitedMs: Date.now() - started });
      const timer = setTimeout(() => finish({ outcome: "timeout", waitedMs: Date.now() - started }), ms);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.bus.park(this.name, waiter);
    });
  }
}

/** A family of one: the bus a session creates when it did not inherit one. */
export function newPeerFamily(label: string = DEFAULT_PEER_NAME): PeerMailbox {
  return new PeerBus().join(label);
}
