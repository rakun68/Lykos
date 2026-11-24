/**
 * MCP and `lykos run` sessions in the TUI (P5 #51). A delegated session keeps running in the process that owns it,
 * an MCP server or `lykos run`: its owner row, its tree lock and recovery stay as the delegation core keeps them
 * (T243, T246). The engine server reads what that core writes, the owner row and the live transcript, and turns it
 * into the events a server session sends, so the TUI lists the session, shows it as it runs, steers it as `lykos
 * steer` does and stops it as `lykos stop` does.
 *
 * Loaded when first used, so the server starts without the delegation core and the old TUI's renderers.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { ledgerViews, steerElsewhere, stopElsewhere } from "../delegate/mcp-server.js";
import type { SessionView } from "../delegate/ownership.js";
import { defaultLedgerPath } from "../ledger/ledger.js";
import type { TranscriptRecord } from "../session/replay.js";
import { transcriptFilePath } from "../session/transcript.js";
import { TranscriptEvents } from "./transcript-events.js";
import type { DelegatedInfo, EventData, SessionStatus } from "./protocol.js";
import type { FromChild, ToChild } from "./session-child.js";

/** How often a watch reads the owner row and the transcript: `lykos wait` reads the ledger every 250 ms. */
const POLL_MS = 250;

/** The project's delegated sessions that run now, by ledger session id. */
export function delegatedLive(workspace: string): Record<string, DelegatedInfo> {
  const out: Record<string, DelegatedInfo> = {};
  for (const v of ledgerViews(workspace)) {
    if (v.state === "running" || v.state === "waiting") out[v.session_id] = { owner: v.owner, state: v.state, startedAt: v.started_at, specialist: v.specialist };
  }
  return out;
}

/** Whether the project's ledger has a delegated session `id`, and its owner. */
export function delegatedView(workspace: string, id: string): SessionView | undefined {
  return ledgerViews(workspace, [id])[0];
}

export interface WatchOptions {
  /** The project the delegation core keeps the session in: its ledger holds the owner row and the transcript. */
  workspace: string;
  id: string;
  /** What a session child would send the server. */
  onMessage: (msg: FromChild) => void;
  /** Called once, when the watch ends. */
  onExit: () => void;
  pollMs?: number;
}

/**
 * One watched session, in the server's place for a session child: it takes the messages a child takes and answers
 * with the ones a child sends.
 */
export class DelegatedWatch {
  connected = true;
  private readonly path: string;
  private offset = 0;
  private partial = "";
  private readonly events = new TranscriptEvents((data) => this.emit(data));
  private state: SessionView["state"] | "missing" | undefined;
  private question: string | null = null;
  private timer: NodeJS.Timeout | undefined;
  private polling = false;

  constructor(private readonly opts: WatchOptions) {
    this.path = transcriptFilePath(defaultLedgerPath(opts.workspace), opts.id);
  }

  start(): void {
    this.poll();
    if (this.connected) this.timer = setInterval(() => this.poll(), this.opts.pollMs ?? POLL_MS);
  }

  send(msg: ToChild): boolean {
    if (!this.connected) return false;
    switch (msg.kind) {
      case "prompt": {
        const r = steerElsewhere(this.opts.workspace, this.opts.id, msg.text);
        this.system(r?.steered === true ? `steer sent: the session reads it at its next step` : `not steered: the session is ${r?.state ?? "gone"}`);
        return true;
      }
      case "interrupt":
        this.system("stop asked, as lykos stop asks it");
        void stopElsewhere(this.opts.workspace, this.opts.id).then(
          (r) => this.system(`stopped: the session is ${r?.state ?? "gone"}`),
          (err: unknown) => this.system(`could not stop it: ${err instanceof Error ? err.message : String(err)}`),
        );
        return true;
      case "aside":
      case "options":
      case "job":
        this.opts.onMessage({ kind: msg.kind, id: msg.id, error: "a watched session takes no side questions, options or jobs: its owner runs it" });
        return true;
      case "answer":
        this.system("a watched session's question is answered by sending a prompt, as lykos steer answers it");
        return true;
      case "close":
        this.kill();
        return true;
      default:
        return true;
    }
  }

  kill(): boolean {
    if (!this.connected) return false;
    this.connected = false;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.opts.onExit();
    return true;
  }

  private emit(data: EventData): void {
    this.opts.onMessage({ kind: "event", data });
  }

  private system(text: string): void {
    this.emit({ type: "system", text });
  }

  private status(status: SessionStatus): void {
    this.opts.onMessage({ kind: "status", status, ledgerSessionId: this.opts.id });
  }

  private poll(): void {
    if (this.polling || !this.connected) return;
    this.polling = true;
    try {
      const view = delegatedView(this.opts.workspace, this.opts.id);
      this.readTranscript();
      const state = view?.state ?? "missing";
      if (state !== this.state) this.changed(state, view);
      else if (view !== undefined && view.question !== this.question) this.asked(view.question);
    } catch (err) {
      this.system(`cannot read the session: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.polling = false;
    }
  }

  private changed(state: SessionView["state"] | "missing", view: SessionView | undefined): void {
    const first = this.state === undefined;
    this.state = state;
    if (state === "running") return this.status("running");
    if (state === "waiting") {
      this.status("idle");
      return this.asked(view?.question ?? null);
    }
    this.endTurn();
    this.status("idle");
    if (state === "missing") this.system(`no delegated session ${this.opts.id} in this project`);
    else if (state === "crashed") this.system(`its owner is gone: lykos recover ${this.opts.id} takes it over`);
    else this.system(`the session ${first ? "had ended" : "ended"}: ${state}`);
    // Nothing more comes once it ended: the transcript is read whole, so the watch stops reading.
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private asked(question: string | null): void {
    this.question = question;
    if (question !== null) this.system(`the session asks: ${question}\nA prompt answers it.`);
  }

  private endTurn(): void {
    this.events.endTurn();
  }

  /** The transcript's lines written since the last read; a line still being written waits for the next. */
  private readTranscript(): void {
    if (!existsSync(this.path)) return;
    const size = statSync(this.path).size;
    if (size <= this.offset) return;
    const fd = openSync(this.path, "r");
    let chunk: Buffer;
    try {
      chunk = Buffer.alloc(size - this.offset);
      readSync(fd, chunk, 0, chunk.length, this.offset);
    } finally {
      closeSync(fd);
    }
    this.offset = size;
    const lines = (this.partial + chunk.toString("utf8")).split("\n");
    this.partial = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        this.events.record(JSON.parse(line) as TranscriptRecord);
      } catch {
        // A line that is not JSON is the writer's to explain, not the watcher's: `lykos show` reports it.
      }
    }
  }
}
