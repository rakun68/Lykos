// Two-way questions in delegated sessions (ADR-0056).
//
// `ask_coordinator` allows a delegated session to ask the coordinator one specific question
// when a choice would change what is built. Pauses the session until answered.
// `give_up` ends the session without another model turn, returning needs_answer outcome.
// `claim` (T234, ADR-0059) records something the session says is true of its work, with a check the harness runs
// after the session ends; the harness, not the session, decides the verdict.

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CLAIM_CHECK_KINDS, CLAIM_CHECK_SHAPES, parseClaimCheck, type ClaimCheck } from "../delegate/claims.js";

export const COORDINATOR_ASK_TOOL_NAME = "ask_coordinator";
export const COORDINATOR_GIVE_UP_TOOL_NAME = "give_up";
export const CLAIM_TOOL_NAME = "claim";

export interface Coordinator {
  ask(question: string, signal?: AbortSignal): Promise<string>;
  giveUp(question: string): void;
  /** T234: records a claim whose check is valid and returns its id. Absent: the session has no `claim` tool. */
  claim?(text: string, check: ClaimCheck): number;
}

export function buildCoordinatorAskTool(coordinator: Coordinator): ToolDefinition {
  return defineTool({
    name: COORDINATOR_ASK_TOOL_NAME,
    label: "Ask Coordinator",
    description: "Ask the coordinator one specific question when a choice would change what you build. Pauses the session until answered.",
    promptSnippet: "Ask the coordinator a specific question",
    executionMode: "sequential",
    parameters: Type.Object({
      question: Type.String({ description: "One specific question." }),
    }),
    async execute(_toolCallId, params, signal) {
      const q = typeof params?.question === "string" ? params.question.trim() : "";
      if (q.length === 0) {
        return {
          content: [{ type: "text", text: "lykos ask_coordinator: `question` is empty. State the specific choice you need decided." }],
          isError: true,
          details: { error: "empty_question" } as Record<string, unknown>,
        };
      }
      const answer = await coordinator.ask(params.question, signal);
      return {
        content: [{ type: "text", text: answer }],
        details: { question: params.question, answer } as Record<string, unknown>,
      };
    },
  });
}

export function buildCoordinatorGiveUpTool(coordinator: Coordinator): ToolDefinition {
  return defineTool({
    name: COORDINATOR_GIVE_UP_TOOL_NAME,
    label: "Give Up",
    description: "Give up on the current task and report to the coordinator that an answer is needed to proceed. Ends the session.",
    promptSnippet: "Give up and end the session when unable to proceed without an answer",
    executionMode: "sequential",
    parameters: Type.Object({
      question: Type.String({ description: "The question that must be answered to proceed." }),
    }),
    async execute(_toolCallId, params) {
      const q = typeof params?.question === "string" ? params.question.trim() : "";
      if (q.length === 0) {
        return {
          content: [{ type: "text", text: "lykos give_up: `question` is empty. State the question that must be answered to proceed." }],
          isError: true,
          details: { error: "empty_question" } as Record<string, unknown>,
        };
      }
      coordinator.giveUp(params.question);
      return {
        content: [{ type: "text", text: `Gave up: ${params.question}` }],
        terminate: true,
        details: { question: params.question, gaveUp: true } as Record<string, unknown>,
      };
    },
  });
}

export function buildClaimTool(coordinator: Coordinator): ToolDefinition {
  return defineTool({
    name: CLAIM_TOOL_NAME,
    label: "Claim",
    description:
      "Record something you say is true of your work, with a check the harness runs itself after you finish, at the final commit. " +
      "A claim whose check fails is reported to the coordinator as MISREPORT; a claim not made here is only your own word. " +
      "Checks: a line (path, line, text it contains), a search (pattern, how many lines match), a command (and its exit code), " +
      "or a reproduction (a new test file and the tests that must fail).",
    promptSnippet: "Record a claim with a check the harness will run",
    executionMode: "sequential",
    parameters: Type.Object({
      text: Type.String({ description: "What you claim, in one sentence." }),
      check: Type.Object(
        {
          kind: Type.Union(
            CLAIM_CHECK_KINDS.map((k) => Type.Literal(k)),
            { description: "line, search, command or reproduction." },
          ),
          path: Type.Optional(Type.String({ description: "line: the file, relative to the repository root." })),
          line: Type.Optional(Type.Integer({ description: "line: the 1-based line number." })),
          text: Type.Optional(Type.String({ description: "line: text the line contains." })),
          pattern: Type.Optional(Type.String({ description: "search: a regular expression, matched per line." })),
          matches: Type.Optional(Type.Integer({ description: "search: how many lines match." })),
          paths: Type.Optional(Type.Array(Type.String(), { description: "search: restrict to these files or folders." })),
          command: Type.Optional(Type.String({ description: "command: the command to run." })),
          exit: Type.Optional(Type.Integer({ description: "command: the exit code it must give." })),
          file: Type.Optional(Type.String({ description: "reproduction: a new test file, relative to the repository root." })),
          content: Type.Optional(Type.String({ description: "reproduction: the test file's text." })),
          fails: Type.Optional(Type.Array(Type.String(), { description: "reproduction: names of the tests that must fail." })),
        },
        { description: "The check, by kind." },
      ),
    }),
    async execute(_toolCallId, params) {
      const text = typeof params?.text === "string" ? params.text.trim() : "";
      const refuse = (message: string) => ({
        content: [{ type: "text" as const, text: `lykos claim: ${message}\nNothing was recorded. A check is one of:\n${CLAIM_CHECK_SHAPES}` }],
        isError: true,
        details: { error: "invalid_claim" } as Record<string, unknown>,
      });
      if (text === "") return refuse("`text` is empty. State what you claim.");
      const parsed = parseClaimCheck(params.check);
      if (!parsed.ok) return refuse(parsed.message);
      if (coordinator.claim === undefined) return refuse("this session cannot record claims.");
      const id = coordinator.claim(text, parsed.check);
      return {
        content: [{ type: "text" as const, text: `Recorded claim ${id}. The harness runs its check when you finish; a check that fails is reported as MISREPORT.` }],
        details: { id, kind: parsed.check.kind } as Record<string, unknown>,
      };
    },
  });
}
