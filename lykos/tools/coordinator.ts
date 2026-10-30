// Two-way questions in delegated sessions (ADR-0056).
//
// `ask_coordinator` allows a delegated session to ask the coordinator one specific question
// when a choice would change what is built. Pauses the session until answered.
// `give_up` ends the session without another model turn, returning needs_answer outcome.

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const COORDINATOR_ASK_TOOL_NAME = "ask_coordinator";
export const COORDINATOR_GIVE_UP_TOOL_NAME = "give_up";

export interface Coordinator {
  ask(question: string, signal?: AbortSignal): Promise<string>;
  giveUp(question: string): void;
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
