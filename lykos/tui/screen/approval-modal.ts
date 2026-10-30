// The approval prompt: the safety-critical task of this phase.
//
// `gate/approval.ts`'s `ApprovalGate` is the boundary that makes host-side
// standalone shippable at all (16-standalone-execution-shape.md, T30.2).
// `TerminalApprovalGate` reads a line from a shared `readline` source; raw
// mode has no such source, so this file re-implements the gate on T46.1's
// key decoder instead — and a gate that misreads a keystroke can approve a
// write the user meant to deny, which is why every non-`y`/`a` input path
// is proven, not assumed, to produce anything other than `allow`.
//
// **It is no longer a modal.** T49 painted it as a full-screen overlay
// (`ScreenPipeline.setOverlay`) on the reasoning that the prompt should be
// "the loudest thing on screen." In use that meant a one-line `bash`
// approval blanked the whole terminal and took every bit of context with
// it — 2026-09-02 round three, item 11: "I dont like approval message
// taking up all the screen... show it up inside the chat, make the color
// noticeable and make the options noticeable too." So this file now emits
// an `ApprovalView` and the caller renders it as a scrollback block
// (`blocks.ts`'s `renderApproval`), tinted `modalBg` across its full width
// with the keys spelled out. Loud is a background colour, not a takeover.
//
// What did NOT change: T49.2's decision table (`y` allow, `a`
// allow-always, `n`/Escape/Ctrl-C deny, Enter and every unrecognised key
// ignored), T49.3's scope clamp, and T49.4's denial-as-outcome. This file
// renders a decision; it does not participate in making one.

import { folderOfPath, type ApprovalDecision, type ApprovalGate, type ApprovalRequest } from "../../gate/approval.js";
import type { ApprovalMetrics } from "../../gate/approval-metrics.js";
import type { ApprovalView } from "../renderers/conversation.js";
import { KeyDecoder, type FeedOptions, type KeyEvent } from "./input.js";
import type { ClickAction } from "./scrollback.js";
import {
  DEFAULT_INTERACTION_MODE,
  decideForMode,
  nextMode,
  type GatedAction,
  type InteractionMode,
  type ModeDecision,
} from "../../gate/modes.js";

export type { ApprovalView };

/** The view for one request, before any decision has been made. */
export function approvalViewFor(req: ApprovalRequest): ApprovalView {
  const isBashPathAsk = req.kind === "bash" && req.pathAsk !== undefined;
  return {
    kind: req.kind,
    summary: req.summary,
    detail: req.detail,
    ...(req.body !== undefined ? { body: req.body } : {}),
    ...(req.pathAsk?.protected ? { protected: true } : {}),
    ...(isBashPathAsk ? { bashPathAsk: true } : {}),
  };
}

/**
 * How long the gate refuses a REPEAT of the same decision key — the
 * key-repeat guard (2026-09-02 round six, item 3: "Make that even if the
 * user press Y and does not unpress, it will only allow one approval, only
 * when the user lift up his hand and press again it will approve the
 * next").
 *
 * Holding a key produces a stream of ordinary bytes: this terminal is
 * entered with Kitty flag 1 (disambiguate escape codes) only, NOT flag 2
 * (report event types), so there is no key-release event to wait for and
 * an auto-repeated `y` is byte-for-byte identical to a second deliberate
 * press. What distinguishes them is timing — repeats arrive every 30-60ms,
 * a deliberate second press does not — so the guard is a window, and every
 * ignored repeat RESTARTS it, which is what makes holding the key down
 * forever approve exactly one request rather than one per window.
 *
 * 500ms is deliberately generous: the cost of being wrong in the
 * permissive direction is approving a command nobody read, and the cost of
 * being wrong in the strict direction is pressing `y` again.
 */
export const APPROVAL_KEY_REPEAT_GUARD_MS = 500;

/** `RawApprovalGateOptions.advanceTimeoutMs`'s default: long enough for a real command to finish and print, short enough that a lost `advance()` is a pause and not a hang. */
export const DEFAULT_ADVANCE_TIMEOUT_MS = 30_000;
/**
 * T131: the modes moved to `gate/modes.ts`, which owns the policy as a pure
 * function. This alias is kept so the many call sites naming the old type
 * keep compiling; the VALUES it accepts changed completely, and `ask` in
 * particular now means read-only rather than "prompt for everything".
 */
export type PermissionMode = InteractionMode;

export interface RawApprovalGateOptions {
  /**
   * T111.2: approval friction, counted by tier and by mode. Omitted → the
   * session records NULL rather than zeros, which is the difference between
   * "no gate ran here" and "the gate ran and never had to ask".
   */
  metrics?: ApprovalMetrics;
  /**
   * T131: a request the mode refused outright, with the reason. The caller
   * writes it into the tool result so the model learns the rule rather than
   * retrying against it, and shows it in the transcript so a refusal is never
   * silent.
   */
  onDenied?: (req: ApprovalRequest, reason: string) => void;
  /**
   * T131: the user answered "always" — remember these command patterns for
   * this project. Never called for a destructive command; see
   * `gate/command-safety.ts`.
   */
  onRemember?: (patterns: readonly string[]) => void;
  /**
   * T210: the user answered "f" (allow folder) — remember this folder as an extra directory.
   */
  onRememberFolder?: (folder: string) => void;
  projectId?: string;
  cwd?: string;
  verifyCommand?: string | undefined;
  /**
   * Called when the prompt opens and again once it is answered, with the
   * same `id` both times — so the caller pushes a block the first time and
   * updates it in place the second, leaving the decision in scrollback
   * rather than erasing the question.
   */
  onRender: (id: string, view: ApprovalView) => void;
  /**
   * PgUp/PgDn while the prompt is open. The prompt itself no longer
   * scrolls — it is a bounded block in the transcript, and `/verbose`
   * expands a long body — so these scroll the transcript, which is what a
   * user reaching for them while deciding actually wants: the code above
   * the request.
   */
  onScroll?: (action: "pageUp" | "pageDown" | "wheelUp" | "wheelDown") => void;
  /**
   * Ctrl-C: cancel the whole turn, not just this one prompt (2026-09-02
   * round six, item 1 — "i have to Ctrl C to get out"). With a queue
   * behind the visible prompt, a Ctrl-C that denied only the current
   * request left every queued one still to answer, so the escape hatch
   * needed as many presses as there were pending approvals and did not
   * feel like an escape hatch at all.
   */
  onInterrupt?: () => void;
  /** Injectable for tests — the key-repeat guard is the only thing that reads a clock. */
  now?: () => number;
  /**
   * Hold the next queued prompt back until the caller says the previous
   * decision's work is on screen (2026-09-02 round seven, item 4).
   *
   * Without it the transcript interleaves wrongly: approving the first of
   * two queued commands promotes the second IMMEDIATELY, so its prompt is
   * pushed while the first command is still running and the first
   * command's output then lands underneath it. The maintainer wrote the
   * resulting order out by hand: "Approval message 1: accepted / Approval
   * message 2: accepted / Some text from approval message 1 / Some text
   * from approval message 2". With it, the order is the one a person
   * reads: decide, see what that decision did, decide the next thing.
   *
   * The caller calls `advance()` when the work lands. `advanceTimeoutMs`
   * is the watchdog that makes a missed call cosmetic rather than fatal:
   * a queued approval that is never promoted is a hung turn, which is the
   * exact failure this surface has spent three rounds closing, so the
   * queue ALWAYS moves eventually whether or not anyone tells it to.
   */
  deferAdvance?: boolean;
  /** How long `deferAdvance` waits for `advance()` before promoting anyway. Generous on purpose: a long command should not lose the ordering, and a lost `advance()` must not lose the turn. */
  advanceTimeoutMs?: number;
  /**
   * Resolves a raw mouse click's frame position — normally `ScreenPipeline.
   * actionAt()` — 2026-09-02 round nine, item 3. While this gate is open it
   * is the ONLY thing `routeStdin()` delivers mouse bytes to (this file's
   * own module doc), so a click anywhere in the frame, not just on this
   * prompt's own pills, has to be resolved here or it goes nowhere.
   */
  resolveClick?: (row: number, col: number) => ClickAction | null;
  /** The pointer moved with no button held — see `RawLineSource`'s option of the same name. */
  onHover?: (row: number, col: number) => void;
  /** What a resolved click means, for every `ClickAction` kind this gate does not interpret itself (everything but `approvalKey`, which `handleKey`'s own mouse case applies directly via the guarded `decide()`). */
  onAction?: (action: ClickAction) => void;
}

interface QueueEntry {
  req: ApprovalRequest;
  id: string;
  resolve: (d: ApprovalDecision) => void;
  /**
   * T131: the mode's verdict for THIS request, carried per entry rather than
   * in one field on the gate. `request()` is reentrant — a turn that runs two
   * bash commands at once produces two overlapping calls before either
   * resolves — so a single `pendingDecision` field would let one request's
   * "always" remember the other request's patterns.
   */
  decision: ModeDecision;
}

/**
 * T49: the raw-mode `ApprovalGate`. `request()` renders the prompt and
 * resolves only on `y` (allow), `a` (allow-always), `n` or Escape (deny —
 * T49.2's safe default), or `close()` (deny, for a session tearing down
 * mid-prompt). Enter alone does nothing and every other key is ignored —
 * "an unrecognised key is ignored rather than treated as consent."
 *
 * **Reentrant since 2026-09-02, round five.** Pi runs a model's parallel
 * tool calls concurrently, and each one's `authorize()` call awaits its
 * own `gate.request()` independently — so a turn that asks to run two
 * bash commands at once produces TWO overlapping `request()` calls before
 * either resolves. The single-slot design this replaced (`currentReq`/
 * `currentId`/`pendingResolve`, one field each) could not represent that:
 * a second `request()` call silently overwrote the first's fields, which
 * meant the first request's `resolve` closure was still sitting inside a
 * `Promise` nobody could ever settle — the tool call awaiting it hung
 * forever, and with it the whole turn, because Pi cannot finish a turn
 * with an outstanding tool call. That is exactly what "big bug: after
 * asking my agent some questions... they think but I see no reply" and
 * "There are two approval showing at the same time but I can only accept
 * one, the one showing first does not get to pick allow or anything" were
 * — two symptoms of the one orphaned-promise cause, item 1 and item 8 of
 * that round's report, and the maintainer's own guess for item 10 ("nothing
 * happens when i type... Maybe its because the first approval message is
 * still pending") landed on the same root cause a third time.
 *
 * The fix is a real queue: only ONE entry is ever the live `current` one —
 * shown, and the only one `handleKey` can resolve — and every later
 * `request()` while one is already showing is pushed onto `queue` instead
 * of clobbering it. Every queued entry's `resolve` is preserved and WILL
 * be called, in order, as each current one is decided; none is ever
 * dropped. The current block also shows how many more are waiting
 * (`ApprovalView.queued`), so a queued-but-invisible decision doesn't read
 * as the interface having silently swallowed a request.
 */
export class RawApprovalGate implements ApprovalGate {
  private readonly decoder = new KeyDecoder();
  private readonly opts: RawApprovalGateOptions;
  private current: QueueEntry | null = null;
  private readonly queue: QueueEntry[] = [];
  private seq = 0;
  private readonly now: () => number;
  /** The last decision key accepted or refused as a repeat, and when — see `APPROVAL_KEY_REPEAT_GUARD_MS`. */
  private lastKey: string | null = null;
  private lastKeyAt = -Infinity;
  /** True between a decision and the `advance()` (or watchdog) that promotes the next queued prompt. See `deferAdvance`. */
  private awaitingAdvance = false;
  private advanceTimer: ReturnType<typeof setTimeout> | null = null;
  private permissionMode: InteractionMode = DEFAULT_INTERACTION_MODE;
  /** T131: the project's remembered command approvals. Only Auto consults it — see `decideForMode`. */
  private allowlist: ReadonlySet<string> = new Set();
  verifyCommand?: string | undefined;

  constructor(opts: RawApprovalGateOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.verifyCommand = opts.verifyCommand;
  }

  get isOpen(): boolean {
    return this.current !== null;
  }

  /** For tests and callers that want to show "N more pending" elsewhere without waiting for the next render. */
  get queuedCount(): number {
    return this.queue.length;
  }

  get mode(): InteractionMode {
    return this.permissionMode;
  }

  /** Replace the remembered approvals, e.g. after one is added by answering "always". */
  setAllowlist(allow: ReadonlySet<string>): void {
    this.allowlist = allow;
  }

  setMode(mode: InteractionMode): void {
    this.permissionMode = mode;
    this.render();
  }

  setVerifyCommand(command?: string): void {
    this.verifyCommand = command;
  }

  cycleMode(): InteractionMode {
    const next = nextMode(this.permissionMode);
    this.setMode(next);
    return next;
  }

  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    // T131: the whole policy is one pure function in `gate/modes.ts`. This
    // used to be two inline branches here, which meant the only way to learn
    // what a mode permitted was to read a UI file and the only way to test it
    // was to drive a renderer.
    // P10.4 (ticket 13): a `powershell` request arrives as `kind: "bash"` —
    // same summary, same detail, same session scope — but it must NOT become
    // a `bash` action here, because that is the arm `tierForAction` runs the
    // POSIX command classifier on. `req.shell` is the discriminator; see the
    // field's own comment in `gate/approval.ts`.
    const action: GatedAction =
      req.kind === "bash"
        ? req.shell === "powershell"
          ? { kind: "powershell" }
          : { kind: "bash", command: req.detail }
        : { kind: req.kind };
    let decision = decideForMode(this.permissionMode, action, this.allowlist, {
      verifyCommand: this.verifyCommand,
    });
    // T210/T211: a path rule's ask reaches the person in every mode. A mode's "allow" (Auto's, or a
    // remembered command approval) is turned into a prompt that offers no "always"; a deny stays.
    // For protected writes, it is ask in every mode, offering only session allow.
    if (req.pathAsk !== undefined && (decision.verdict === "allow" || req.pathAsk.protected)) {
      decision = { ...decision, verdict: "ask", offerAlways: false, patterns: [] };
    }
    // T111.2: every decision, counted at the one place the mode and the
    // tier are both in hand. `calls.risk_tier` cannot answer this — a bash
    // row records no tier there because the usage row carries no command
    // (DECISIONS.md 2026-09-08), which is exactly why the count lives here.
    this.opts.metrics?.record(this.permissionMode, decision.tier, decision.verdict);
    if (decision.verdict === "allow") return Promise.resolve("allow");
    if (decision.verdict === "deny") {
      this.opts.onDenied?.(req, decision.reason ?? "denied by the current interaction mode");
      return Promise.resolve("deny");
    }
    return new Promise((resolve) => {
      // Everything goes through the queue, including the first request, so
      // FIFO order holds even when a new request arrives during the
      // `deferAdvance` gap: promoting it straight to `current` there would
      // jump it ahead of whatever is already waiting.
      this.queue.push({ req, id: `approval-${this.seq++}`, resolve, decision });
      // A repaint of the CURRENT prompt when one is already showing, so
      // "+N more" stays accurate the moment a second request arrives
      // rather than only updating on the next keystroke.
      if (this.current === null && !this.awaitingAdvance) this.promoteNext();
      else this.render();
    });
  }

  /**
   * "The previous decision's work is on screen; show the next prompt."
   * A no-op unless `deferAdvance` is set and a decision is actually
   * waiting, so a caller can wire it to a broad signal (any tool
   * finishing) without having to know which one it was.
   */
  advance(): void {
    if (!this.awaitingAdvance) return;
    this.clearAdvanceTimer();
    this.awaitingAdvance = false;
    this.promoteNext();
  }

  feedBytes(chunk: string, opts?: FeedOptions): void {
    for (const ev of this.decoder.feed(chunk, opts)) this.handleKey(ev);
  }

  flushPending(): void {
    for (const ev of this.decoder.flush()) this.handleKey(ev);
  }

  /**
   * Torn down mid-session — every pending request is denied, current AND
   * queued alike, rather than only the one on screen. Leaving queued
   * entries unresolved would recreate the exact hang this round's rewrite
   * exists to close, just via a different door (session teardown instead
   * of a second concurrent request).
   *
   * Deliberately NOT built on `resolve()`: that method advances the queue
   * and re-renders the next entry as a fresh, still-open prompt — exactly
   * the behaviour a normal decision wants and teardown does not. Calling
   * it here would pull the next queued entry into `this.current`, leave it
   * showing "open" after this method returns, and never reach it in
   * `denyAll()`'s loop (it would already have been shifted out of `queue`).
   */
  close(): void {
    this.denyAll();
  }

  private handleKey(ev: KeyEvent): void {
    if (!this.current) return;
    switch (ev.type) {
      case "char": {
        const c = ev.value.toLowerCase();
        const isBashPathAsk = this.current.req.kind === "bash" && this.current.req.pathAsk !== undefined;
        if (c === "y") this.decide("y", "allow");
        else if (c === "a" && !this.current.req.pathAsk?.protected && !isBashPathAsk) this.decide("a", "allow-always");
        else if (c === "f" && !this.current.req.pathAsk?.protected && !isBashPathAsk) this.decide("f", "allow-folder");
        else if (c === "n") this.decide("n", "deny");
        // every other character: ignored, per T49.2.
        break;
      }
      case "escape":
        this.decide("escape", "deny");
        break;
      case "ctrl":
        // Ctrl-C cancels everything rather than denying one: this prompt is
        // the only thing routeStdin() delivers bytes to while it's open
        // (this file's module doc), so RawLineSource's onInterrupt/
        // session.abort() path never even sees a Ctrl-C typed here — and
        // with a queue behind the visible prompt, denying one at a time was
        // not an exit.
        if (ev.key === "c" && this.guard("ctrl-c")) {
          this.denyAll();
          this.opts.onInterrupt?.();
        }
        break;
      case "pageUp":
        this.opts.onScroll?.("pageUp");
        break;
      case "pageDown":
        this.opts.onScroll?.("pageDown");
        break;
      // The transcript stays scrollable while a prompt is open (2026-09-02
      // round six, item 1: "i cannot scroll or type"). Typing genuinely
      // must not reach the composer while a decision is outstanding, but
      // READING the code above the request is most of what deciding
      // consists of — and the wheel was being decoded and dropped here,
      // which is what made an open prompt feel like a frozen terminal.
      case "wheel":
        if (!ev.ctrl) this.opts.onScroll?.(ev.dir === "up" ? "wheelUp" : "wheelDown");
        break;
      case "arrow":
        if (ev.dir === "up") this.opts.onScroll?.("wheelUp");
        else if (ev.dir === "down") this.opts.onScroll?.("wheelDown");
        break;
      // 2026-09-02 round nine, item 3: while a prompt is open, EVERY mouse
      // event routes here (this file's own module doc) — including a
      // click on an approval's own `[y]`/`[n]`/`[a]`/`[Esc]` pills, but
      // also a click on a fold hint or a link sitting in the transcript
      // ABOVE this prompt, which this class has no idea how to render but
      // still has to let through. `approvalKey` is handled directly (the
      // SAME guarded `decide()` a keyboard press uses, so a rapid
      // double-click cannot double-fire a decision); everything else
      // bubbles up via `onAction` for `session/interactive.ts` to interpret.
      case "mouse":
        // Hover, round eleven item 1. While this gate is open it owns
        // stdin outright, so the pointer's position reaches the pipeline
        // through here or not at all — an approval's own pills are the
        // buttons the request is most obviously about, and they would be
        // the one place hover did not work if this case were left out.
        if (ev.action === "move") {
          this.opts.onHover?.(ev.row, ev.col);
          break;
        }
        if (ev.action === "down" && ev.button === 0 && this.opts.resolveClick) {
          const action = this.opts.resolveClick(ev.row, ev.col);
          if (action?.kind === "approvalKey") this.decide(action.key, action.decision);
          else if (action) this.opts.onAction?.(action);
        }
        break;
      // "enter" and everything else (tab, other ctrl+*, unmapped escapes)
      // are deliberately no-ops — T49.2: "Enter alone does nothing... an
      // unrecognised key is ignored rather than treated as consent."
      default:
        break;
    }
  }

  /**
   * The key-repeat guard (`APPROVAL_KEY_REPEAT_GUARD_MS`). Returns true
   * when `key` may act. A repeat of the SAME key inside the window is
   * refused and restarts the window; a DIFFERENT key acts immediately,
   * because "y then n" is a person changing their mind and no keyboard
   * auto-repeats into a different character.
   */
  private guard(key: string): boolean {
    const at = this.now();
    if (this.lastKey === key && at - this.lastKeyAt < APPROVAL_KEY_REPEAT_GUARD_MS) {
      this.lastKeyAt = at;
      return false;
    }
    this.lastKey = key;
    this.lastKeyAt = at;
    return true;
  }

  private decide(key: string, decision: ApprovalDecision): void {
    if (!this.guard(key)) return;
    if (this.current?.req.pathAsk?.protected) {
      if (decision === "allow-always" || decision === "allow-folder" || key === "a" || key === "f") {
        this.resolve("allow");
        return;
      }
    }
    // T111.2: a human answering no to a prompt. Recorded here, on the
    // keystroke path, and deliberately NOT in `denyAll()` — a teardown
    // denies every pending request, and counting those as refusals would
    // report a closed terminal as the human rejecting the work.
    if (decision === "deny" && this.current) {
      this.opts.metrics?.recordHumanDenial(this.permissionMode, this.current.decision.tier);
    }
    if (decision === "allow-folder") {
      const entry = this.current;
      if (entry) {
        const folder = folderOfPath(entry.req.detail);
        // Remembering is the caller's (`authorize`, the confine), which knows the project's cwd.
        this.opts.onRememberFolder?.(folder);
      }
    }
    if (decision === "allow-always") {
      const entry = this.current;
      // "Always" on a request the mode marked un-rememberable (a destructive
      // command) is treated as a plain allow: it runs this once and is not
      // written to the store. Silently downgrading beats both refusing the
      // keystroke and remembering `rm -rf`.
      if (entry && entry.decision.offerAlways === true) {
        const patterns = entry.decision.patterns ?? [];
        if (patterns.length > 0) this.opts.onRemember?.(patterns);
      } else {
        this.resolve("allow");
        return;
      }
    }
    this.resolve(decision);
  }

  /** Every pending request denied in one pass — teardown (`close()`) and Ctrl-C share it. */
  private denyAll(): void {
    this.clearAdvanceTimer();
    this.awaitingAdvance = false;
    const entries: QueueEntry[] = [];
    if (this.current) entries.push(this.current);
    entries.push(...this.queue.splice(0));
    this.current = null;
    for (const entry of entries) {
      this.opts.onRender(entry.id, { ...approvalViewFor(entry.req), decision: "deny" });
      entry.resolve("deny");
    }
  }

  private resolve(decision: ApprovalDecision): void {
    const entry = this.current;
    if (!entry) return;
    this.current = null;
    // The answered prompt stays on screen as a record of what was decided,
    // rather than vanishing the moment the key lands. It keeps carrying
    // the waiting count while `deferAdvance` holds the next one back, so
    // the gap never reads as the queue having been swallowed.
    this.opts.onRender(entry.id, {
      ...approvalViewFor(entry.req),
      decision,
      ...(this.queue.length > 0 ? { queued: this.queue.length } : {}),
    });
    entry.resolve(decision);
    // Advance the queue AFTER resolving the decided one, so a caller that
    // reacts to the resolution (starting the next tool call, say) sees a
    // consistent `isOpen` at the moment its own promise settles rather than
    // one that flipped straight back to `true` mid-callback.
    if (this.queue.length === 0) return;
    if (!this.opts.deferAdvance) {
      this.promoteNext();
      return;
    }
    this.awaitingAdvance = true;
    this.clearAdvanceTimer();
    const timer = setTimeout(() => {
      this.advanceTimer = null;
      this.awaitingAdvance = false;
      this.promoteNext();
    }, this.opts.advanceTimeoutMs ?? DEFAULT_ADVANCE_TIMEOUT_MS);
    // Never hold the process open on this timer alone: it is a safety net,
    // not work.
    (timer as { unref?: () => void }).unref?.();
    this.advanceTimer = timer;
  }

  private promoteNext(): void {
    const next = this.queue.shift();
    if (!next) return;
    this.current = next;
    this.render();
  }

  private clearAdvanceTimer(): void {
    if (this.advanceTimer !== null) {
      clearTimeout(this.advanceTimer);
      this.advanceTimer = null;
    }
  }

  private render(): void {
    if (!this.current) return;
    const view = approvalViewFor(this.current.req);
    this.opts.onRender(this.current.id, this.queue.length > 0 ? { ...view, queued: this.queue.length } : view);
  }
}
