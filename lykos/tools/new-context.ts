// An isolated sub-context whose conclusion comes back and whose transcript does
// not.
//
// **WHY IT EXISTS.** A long exploration costs twice: once while it runs, and
// again on every later request, because every file it read and every dead end
// it walked down is still in the conversation being re-sent. `new_context`
// pays the first and not the second.
//
// **IT REUSES THE SPAWN MACHINERY, AND THE REUSE IS LITERAL (D3).** D3 says to
// reuse it rather than build a second child mechanism, so `runChildSession()`
// in `spawn.ts` — specialist resolution, the per-run cap, the preflight budget
// check, the ledger rows, the family's bus seat and the recursive
// `runStandaloneTask` — is the same function `Agent` calls. It was the body of
// `Agent`'s `execute` before this ticket and became a function precisely so
// there is one of it. Nothing about child sessions is decided here.
//
// So `new_context` and `Agent` differ in exactly two things, both of them
// above that line: the default specialist, and how much of the child is shown
// to the parent. `Agent` prints the child's session id, its resumability and
// its answer, because `Agent` is how you delegate a piece of work and the
// parent is expected to follow it up. `new_context` prints the conclusion and
// one line saying where the rest is, because the whole point is that the rest
// does not enter this conversation.
//
// **THE PARENT CANNOT SEE THE TRANSCRIPT, STRUCTURALLY (D3).** `ChildRunOutcome`
// carries `text` — the child's final answer — and no messages, no tool calls
// and no intermediate results. There is nothing for this file to leak even by
// accident, because there is nothing in its hand to leak. The child's full
// transcript is not lost: it is a Lykos session with its own archive and its
// own ledger rows, resumable like any other (T39.3), and the result names the
// session id so a human can open it. "Nothing Lykos runs is ever deleted"
// holds; what changes is what the parent pays to carry.
//
// **WHY A CHILD SESSION.** Rolling the CURRENT session's context window over,
// keeping a notebook and dropping the rest, needs mid-session context rebuilding, which
// AGENTS.md rule 9 rules out here — the head is frozen for the session, and
// rebuilding the message array behind it throws away the prompt cache for the
// whole conversation. The ticket's own words are the shape Lykos builds
// instead: "start an isolated sub-context for exploratory work and return only
// its conclusion". A separate session is how you get an isolated context
// without touching this one's frozen prefix.
//
// **THE SCHEMA TAX, RECORDED AT THE MOMENT THE TOOL IS ADDED (AGENTS.md rule
// 3): this tool rides NO request.** Mounted with `hidden` prompt presence
// (D9), reached through `tool_call`. The measured numbers are asserted in
// `new-context.test.ts`.

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { runChildSession, type ChildRunOutcome, type ChildRunRequest, type SpawnContext } from "./spawn.js";

export const NEW_CONTEXT_TOOL_NAME = "new_context";

/** The specialist an exploration runs as unless the caller names another. Read-only, which is what exploration is. */
export const NEW_CONTEXT_DEFAULT_SPECIALIST = "explore";

export interface NewContextToolOpts {
  /**
   * The family this session can spawn into. Absent on a session that cannot
   * spawn — a subagent, or a host that never opted in — and the tool says so
   * rather than failing.
   */
  spawn?: SpawnContext;
  /**
   * Omitted, `runChildSession`. Injected by a test so the conclusion-only
   * contract can be asserted against a child that produced a real answer,
   * without a model.
   */
  run?: (ctx: SpawnContext, req: ChildRunRequest) => Promise<ChildRunOutcome>;
}

function text(s: string) {
  return [{ type: "text" as const, text: s }];
}

interface NewContextResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: Record<string, unknown>;
}

/** What a session with nowhere to spawn is told. Exported so the test asserts the sentence rather than a substring of it. */
export const NO_SUB_CONTEXT_NOTICE =
  "lykos: this session cannot open a sub-context — it is itself a subagent, or subagents are not enabled for it. " +
  "Nothing was started. Do the exploration here and keep it short, or ask the human to run this session with " +
  "subagents enabled.";

export const NEW_CONTEXT_DESCRIPTION =
  "Do a piece of exploratory work in a fresh context and get back only its conclusion. The work runs as its own " +
  "Lykos session with an empty context: it does not see this conversation, and this conversation never sees what " +
  "it read, searched or tried — only the answer it finishes with. Use it when finding something out would cost " +
  "more context than the answer is worth: which of forty files defines a behaviour, whether an approach is even " +
  "viable, what a large unfamiliar module does. Write `task` as if for someone who just walked in, because that " +
  "is exactly what they are — no history, no assumptions, nothing you have already ruled out unless you say so. " +
  "Say what shape the answer should take. The sub-context is read-only by default, so use Agent instead when the " +
  "work has to change files.";

export const NEW_CONTEXT_PARAMETERS = Type.Object({
  task: Type.String({
    description: "The question, self-contained. Say what you want to know, what you already ruled out, and how long the answer should be.",
  }),
  label: Type.Optional(
    Type.String({ description: "Three to five words naming the exploration, for the session list. Defaults to `sub-context`." }),
  ),
  specialist: Type.Optional(
    Type.String({ description: `Specialist to explore as. Default ${NEW_CONTEXT_DEFAULT_SPECIALIST}, which is read-only.` }),
  ),
});

export function buildNewContextTool(opts: NewContextToolOpts): ToolDefinition {
  const run = opts.run ?? runChildSession;
  return defineTool({
    name: NEW_CONTEXT_TOOL_NAME,
    label: "New context",
    description: NEW_CONTEXT_DESCRIPTION,
    promptSnippet: "Explore in a fresh context and get back only the conclusion",
    parameters: NEW_CONTEXT_PARAMETERS,
    async execute(_id, params): Promise<NewContextResult> {
      const task = String(params.task ?? "").trim();
      if (task === "") {
        return {
          content: text(
            "lykos new_context: `task` is empty. A sub-context starts with no history at all, so an empty brief " +
              "is a session that cannot begin. Nothing was started.",
          ),
          isError: true,
          details: { started: false, reason: "empty_task" },
        };
      }
      if (opts.spawn === undefined) {
        return { content: text(NO_SUB_CONTEXT_NOTICE), isError: true, details: { started: false, reason: "no_spawn" } };
      }

      const label = String(params.label ?? "").trim() || "sub-context";
      const role = String(params.specialist ?? "").trim() || NEW_CONTEXT_DEFAULT_SPECIALIST;
      const outcome = await run(opts.spawn, { prompt: task, description: label, role });
      if (outcome.status !== "finished") {
        return { content: text(outcome.message), isError: true, details: { started: false, ...outcome.details } };
      }

      // The conclusion, and one line saying where the rest is. Everything the
      // sub-context did on the way to this answer stays in its own session.
      const conclusion = outcome.text ?? "(the sub-context finished without an answer)";
      return {
        content: text(
          `${conclusion}\n\n` +
            `— the conclusion of sub-context ${outcome.sessionId} (${outcome.role}). Its transcript is its own ` +
            `session and is not in this conversation; it is archived and resumable if a human wants to read it.`,
        ),
        details: {
          started: true,
          sessionId: outcome.sessionId,
          role: outcome.role,
          resumable: true,
          transcriptIncluded: false,
        },
      };
    },
  }) as ToolDefinition;
}
