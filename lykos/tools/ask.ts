// T103 — structured clarification (`docs/24-strength-and-tooling-audit.md`
// §2.10, `docs/27-phase12-tasks.md`).
//
// WHAT IS MISSING, and the premise holds. Lykos can steer — human → agent,
// through `session.steer()`, which is the reason Pi was chosen as the base
// runtime — and has no channel in the other direction. There is no agent →
// human question that blocks and returns an answer. The approval gate
// (`gate/approval.ts`) is close and is not the same thing: it asks "may I do
// this specific write", after the model has already decided what to do.
//
// WHY IT IS WORTH ONE SCHEMA. Misalignment is Pocock's failure mode #1, and
// it is the one where a cheap model's cost is *unbounded*: it builds the
// wrong thing completely, confidently, and the ledger records a full task
// with a real dollar figure and nothing to show. One round trip at the
// moment of uncertainty is the cheapest correction available anywhere in
// this system — cheaper than the post-edit check, cheaper than the gate, and
// far cheaper than the task.
//
// THE HARD PART IS THE ABSENCE OF A HUMAN, not the presence of one. Lykos
// runs three ways and only one of them has somebody watching. A one-shot
// `lykos run`, an MCP worker under an orchestrator, and a spawned subagent all
// have no terminal to ask at. A tool that blocks forever in those shapes
// would be strictly worse than not having it, so:
//
//   - the tool is registered ONLY when a human channel exists. A session
//     with nobody watching does not carry the schema at all, which also
//     means it does not pay for it;
//   - if the channel disappears mid-session (EOF on stdin, a closed
//     terminal), the call returns a usable instruction rather than hanging:
//     proceed on the stated assumption and say which one was taken.
//
// AN UNANSWERED QUESTION IS NOT A FAILURE. `ask` returning "no human
// available" is a legitimate answer, and the model is told exactly what to
// do with it. The alternative — refusing to continue — converts a missing
// human into a dead session, which is the same trade T87 refused for a
// declined write.
//
// COST, recorded at the moment the tool is added (rule 3): one small schema,
// resident only on sessions that have a human. It fires when the model is
// uncertain, which is the cheapest possible moment to spend a round trip.
//
// ---------------------------------------------------------------------------
// P10.6 (ticket 20, D8) — MEASURED AGAINST THE REFERENCE. CONTRACT ONLY.
// ---------------------------------------------------------------------------
//
// D8 is narrow on purpose: it fixes the gaps that are CONTRACT or SCHEMA.
// **The rich rendering
// is P5 and is deliberately not built here** — no multi-question batches, no
// recommended answers, no option descriptions or previews, and no timeout
// auto-select. None of them appears in this file and `ask.test.ts` asserts the
// schema still has exactly three properties, so a later edit that means well
// cannot smuggle one in ahead of its phase.
//
// WHAT WAS CLOSED, because each is contract rather than rendering:
//
//   - **An empty question is refused.** The reference guards an empty
//     `questions` array at runtime and returns an error payload rather than
//     opening an empty dialog. Lykos would happily put an empty string in
//     front of a human and count it as asked. So would an empty `assumption`,
//     which is worse: the assumption is the whole reason an unanswered
//     question is safe, and an empty one turns "proceed on your assumption"
//     into advice with no content.
//   - **`details` says what actually happened.** The reference returns the
//     question, the options, what was selected and whether it timed out;
//     Lykos returned `{ answered: boolean }` and nothing else, so a caller
//     reading the structured half could not tell which of three quite
//     different things occurred. `source` now distinguishes them: `option`
//     (the human picked one), `free_text` (they typed their own), `assumption`
//     (they saw the question and pressed enter, accepting the stated default)
//     and `none` (there was nobody there). The module comment above has said
//     since T103 that the last two are NOT the same thing; until now the
//     details said they were.
//
// WHAT DIFFERS DELIBERATELY, recorded rather than left silent:
//
//   - **One question per call.** The reference takes `questions[]`. That is
//     the batching half of P5's rich rendering and it changes the wire schema
//     of a RESIDENT tool, so it waits for the phase that owns it.
//   - **Options are bare strings, not `{label, description, preview}`.** Same
//     reason, and the same phase.
//   - **No timeout.** The reference auto-selects the recommended option when
//     `ask.timeout` elapses. Lykos has no timeout at all: an unanswered
//     question already returns a usable instruction instead of blocking, so
//     the failure a timeout exists to prevent cannot happen here. A timeout
//     that silently CHOOSES for the human is a different feature, and it
//     belongs with the recommendation mechanism it depends on.
//   - **Cancellation is not an exception.** The reference throws
//     `ToolAbortError` when a human cancels. Lykos treats an absent answer as
//     an answer, for T87's reason — converting a missing human into a dead
//     session is the trade this project has already refused once.

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface AskRequest {
  question: string;
  /** Short labels the human may pick between. Empty means a free-text answer. */
  options: string[];
  /** What the model will assume if nobody answers. Required — see `ASK_DEFAULT_RULE`. */
  assumption: string;
}

/**
 * Returns the human's answer, or `null` when nobody answered — a closed
 * terminal, an EOF, a timeout, or a session that never had a human.
 */
export type AskHuman = (req: AskRequest) => Promise<string | null>;

export interface AskState {
  /** Questions asked. The "did anyone ever use this?" counter. */
  asked: number;
  /** Questions a human actually answered. */
  answered: number;
  /** Questions that fell back to the model's own stated assumption. */
  unanswered: number;
}

export function newAskState(): AskState {
  return { asked: 0, answered: 0, unanswered: 0 };
}

export const ASK_TOOL_NAME = "ask";

/**
 * The rule that makes an unanswered question safe, and the reason
 * `assumption` is a REQUIRED parameter rather than an optional one.
 *
 * A model that must write down what it would do anyway has already done most
 * of the work of not being blocked. It also makes the question better: "which
 * database?" is a worse question than "I am going to use SQLite unless you
 * say otherwise — is that right?", and requiring the assumption forces the
 * second shape.
 */
export const ASK_DEFAULT_RULE =
  "No answer was available. Proceed on your stated assumption and say, in your next message, " +
  "which assumption you took and that nobody confirmed it.";

export function renderAskPrompt(req: AskRequest): string {
  const lines = [`lykos: the agent is asking —`, ``, req.question];
  if (req.options.length > 0) {
    lines.push("");
    req.options.forEach((opt, i) => lines.push(`  ${i + 1}. ${opt}`));
    lines.push("");
    lines.push(`Answer with a number, or type your own. Empty accepts: ${req.assumption}`);
  } else {
    lines.push("");
    lines.push(`Empty accepts: ${req.assumption}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Turns whatever the human typed into an answer. A bare number selects an
 * option — the cheapest thing to type and the least ambiguous to parse — and
 * anything else is taken verbatim, because a clarification the human phrased
 * themselves is worth more than one the tool forced into a menu.
 *
 * An empty line means "take your assumption", which is deliberately NOT the
 * same as no answer at all: the human saw the question and declined to
 * redirect, and the model should say it proceeded on the assumption without
 * also saying nobody was there.
 */
export function parseAskAnswer(raw: string | null, req: AskRequest): string | null {
  return parseAskReply(raw, req).answer;
}

/**
 * D8: where the answer came from, which the details half now reports.
 *
 * `assumption` and `none` are different events and the module comment above
 * has said so since T103 — a human who saw the question and pressed enter has
 * declined to redirect, and nobody being there has not. Reporting both as
 * "answered: false", or both as true, loses the distinction at exactly the
 * point where the model is deciding what to say about it.
 */
export type AskAnswerSource = "option" | "free_text" | "assumption" | "none";

export interface AskReply {
  answer: string | null;
  source: AskAnswerSource;
  /** The 1-based option the human picked, when they picked one. */
  option?: number;
}

export function parseAskReply(raw: string | null, req: AskRequest): AskReply {
  if (raw === null) return { answer: null, source: "none" };
  const text = raw.trim();
  if (text.length === 0) return { answer: req.assumption, source: "assumption" };
  const asNumber = Number(text);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= req.options.length) {
    return { answer: req.options[asNumber - 1]!, source: "option", option: asNumber };
  }
  return { answer: text, source: "free_text" };
}

export interface AskToolOpts {
  state: AskState;
  askHuman: AskHuman;
  /** T53: the question and its answer belong in the transcript. */
  record?: (question: string, answer: string) => void;
}

export function buildAskTool(opts: AskToolOpts): ToolDefinition {
  return defineTool({
    name: ASK_TOOL_NAME,
    label: "Ask",
    description:
      "Ask the human one blocking question when a choice would change what you build. Say what you " +
      "will assume if nobody answers — you are never blocked. Use it before doing the work, not after.",
    promptSnippet: "Ask the human one blocking question before building the wrong thing",
    parameters: Type.Object({
      question: Type.String({ description: "One specific question. Not a status update." }),
      assumption: Type.String({
        description: "What you will do if nobody answers. Required — this is what makes asking safe.",
      }),
      options: Type.Optional(
        Type.Array(Type.String(), { description: "Short choices the human can pick by number." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const text = (s: string) => [{ type: "text" as const, text: s }];
      const req: AskRequest = {
        question: (params.question ?? "").trim(),
        assumption: (params.assumption ?? "").trim(),
        options: (params.options ?? []).map((o) => o.trim()).filter((o) => o.length > 0),
      };

      // D8: the reference's runtime guard, which this tool did not have. A
      // refusal, not a question — nothing was put in front of the human, so
      // nothing was asked and the counter does not move.
      if (req.question === "") {
        return {
          content: text(
            "lykos ask: `question` is empty. Nobody was asked anything. State the one specific choice you need " +
              "decided, and what you will do if nobody answers.",
          ),
          isError: true,
          details: { answered: false, asked: false, source: "none", reason: "empty_question" },
        };
      }
      if (req.assumption === "") {
        return {
          content: text(
            "lykos ask: `assumption` is empty. Nobody was asked anything. The assumption is what makes asking " +
              "safe — write what you will do if nobody answers, then ask.",
          ),
          isError: true,
          details: { answered: false, asked: false, source: "none", reason: "empty_assumption" },
        };
      }

      opts.state.asked += 1;

      let raw: string | null;
      try {
        raw = await opts.askHuman(req);
      } catch {
        // A broken channel is an absent human, not an error worth failing the
        // turn over.
        raw = null;
      }
      const reply = parseAskReply(raw, req);
      if (reply.answer === null) {
        opts.state.unanswered += 1;
        return {
          content: text(`${ASK_DEFAULT_RULE}\n\nYour assumption: ${req.assumption}`),
          details: {
            answered: false,
            asked: true,
            source: reply.source,
            question: req.question,
            options: req.options,
            assumption: req.assumption,
          },
        };
      }
      opts.state.answered += 1;
      opts.record?.(req.question, reply.answer);
      return {
        content: text(reply.answer),
        details: {
          answered: true,
          asked: true,
          source: reply.source,
          question: req.question,
          options: req.options,
          assumption: req.assumption,
          answer: reply.answer,
          ...(reply.option !== undefined ? { option: reply.option } : {}),
        },
      };
    },
  });
}

/**
 * The terminal channel. Serialized onto one outstanding read, for exactly the
 * reason `TerminalApprovalGate` documents at length: Pi runs a model's
 * parallel tool calls concurrently, and two questions each registering their
 * own `once("line")` on a shared readline would both be resolved by one typed
 * answer — the second question silently "answered" by a line meant for the
 * first.
 */
export class TerminalAsk {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly nextLine: () => Promise<string | null>,
    private readonly output: { write(chunk: string): unknown },
    /** The UI renders the question as a block; this then only reads the answer. */
    private readonly onRequest?: (req: AskRequest) => void,
  ) {}

  readonly ask: AskHuman = (req) => {
    const run = this.queue.then(() => this.askOne(req));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  private async askOne(req: AskRequest): Promise<string | null> {
    if (this.onRequest) this.onRequest(req);
    else this.output.write(renderAskPrompt(req));
    return this.nextLine();
  }
}
