/**
 * A side question (`/btw`, P5 #38): one answer from the session's model and context so far, with no tools, that
 * never enters the conversation. OpenCode's `feature-plugins/prompt/btw.tsx` at `4332e24` does the same through
 * `session.generate`; the instructions say the same in Lykos's words.
 *
 * The call goes through the session's own model runtime (so credential rotation serves it as any other call) and
 * is counted in the session's usage as a call of source `aside`, which the ledger ingests with the rest.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { addSideCall, type StandaloneSessionState } from "./session.js";

const INSTRUCTIONS =
  "This is an aside, not part of the task: answer the question below briefly, in markdown, from the conversation " +
  "and what you already know. Use no tools and change nothing.";

/** pi-ai is Pi's own dependency, not Lykos's: its message type is read off the runtime that returns it. */
export type AssistantMessage = Awaited<ReturnType<AgentSession["modelRuntime"]["completeSimple"]>>;

export interface AsideAnswer {
  answer: string;
  /** provider/model that answered. */
  model: string;
}

/** The parts of a Pi session an aside reads. `AgentSession` has them all. */
export type AsideSession = Pick<AgentSession, "model" | "modelRuntime" | "messages" | "systemPrompt" | "sessionId">;

export async function askAside(session: AsideSession, state: StandaloneSessionState, question: string): Promise<AsideAnswer> {
  const model = session.model;
  if (model === undefined) throw new Error("no model is selected");
  const started = Date.now();
  const reply: AssistantMessage = await session.modelRuntime.completeSimple(
    model,
    {
      systemPrompt: session.systemPrompt,
      messages: [...convertToLlm(session.messages), { role: "user", content: `${INSTRUCTIONS}\n\n${question}`, timestamp: started }],
    },
    { sessionId: session.sessionId },
  );
  addSideCall(state, reply, "aside", Date.now() - started);
  if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? `the model stopped: ${reply.stopReason}`);
  const answer = reply.content
    .filter((b): b is Extract<AssistantMessage["content"][number], { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  return { answer, model: `${reply.provider}/${reply.model}` };
}
