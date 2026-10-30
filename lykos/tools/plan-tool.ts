// Leaving Plan mode, on the model's own initiative.
//
// **Why a tool and not just a keystroke.** Shift+Tab already cycles the
// mode, so the cheap version of Plan mode is "the model plans, you read it,
// you cycle out". The maintainer chose the tool anyway, against the
// recommendation: in the tool the model
// presents the plan and asks to proceed, and approving it is one keystroke
// on a prompt that is already in front of you rather than a mode change you
// have to remember to make.
//
// **THE SCHEMA TAX, ITEMISED HERE BECAUSE RULE 3 SAYS TO RECORD IT AT THE
// MOMENT THE TOOL IS ADDED: 114 tokens, 456 bytes** (measured 2026-09-08 by
// `measureToolset(["read","bash","exit_plan"])` minus the same set without
// it, on `SCHEMA_TOKENS_BASIS`). That is carried in every request of every
// session that registers this tool. `plan-tool.test.ts` asserts the figure,
// so the bill is a number in the repository rather than a recollection and a
// description edit that doubles it fails a test instead of passing silently.
//
// **It is registered only when a human channel exists**, following T103's
// rule for `ask` exactly: a session running as an MCP worker under Claude
// Code has nobody to approve a plan, so it neither pays the schema nor can
// hang waiting on an approval that will never come.
//
// **It is not a way to widen permissions.** The tool cannot choose which
// mode it lands in and it cannot switch modes by itself — it asks, and the
// human's answer decides. A model that calls it while not in Plan mode is
// told so and nothing changes. That keeps this on the same side of the line
// as T104's checkpoint tool, which the agent is likewise not allowed to
// call.

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MODE_INFO, type InteractionMode } from "../gate/modes.js";

export const EXIT_PLAN_TOOL_NAME = "exit_plan";

export interface PlanState {
  /** Plans presented. The "did anyone ever use this?" counter rule 5 asks every capability to carry. */
  presented: number;
  /** Plans the human accepted, leaving Plan mode. */
  approved: number;
  /** Plans the human declined, staying in Plan mode. */
  rejected: number;
  /** Calls made while not in Plan mode, which change nothing. Counted because a nonzero value means the model misunderstands the tool. */
  misfired: number;
}

export function newPlanState(): PlanState {
  return { presented: 0, approved: 0, rejected: 0, misfired: 0 };
}

export interface ExitPlanToolOpts {
  state: PlanState;
  /** The mode in force right now. */
  currentMode?: () => InteractionMode;
  /** Whether the session is currently in planning posture. */
  isPlanning?: () => boolean;
  /**
   * Put the plan in front of the human and return the mode to continue in,
   * or `null` if they declined. The caller owns the prompt; this tool owns
   * neither the UI nor the decision.
   */
  requestExit: (plan: string) => Promise<InteractionMode | null>;
  /** T53: a presented plan and its outcome belong in the transcript. */
  record?: (plan: string, outcome: "approved" | "rejected") => void;
}

/** What the model is told when it calls this outside Plan mode. Exported so the test asserts the exact text rather than a substring of it. */
export const NOT_PLANNING_NOTICE =
  "Not in Plan mode, so there is nothing to exit. You are already permitted to act; continue with the task.";

/** What the model is told when the human declines. It must be actionable, not just a refusal. */
export const PLAN_DECLINED_NOTICE =
  "The plan was not accepted. Stay in Plan mode: revise it, or ask what should change. Do not begin editing.";

export function buildExitPlanTool(opts: ExitPlanToolOpts): ToolDefinition {
  return defineTool({
    name: EXIT_PLAN_TOOL_NAME,
    label: "Exit plan",
    description:
      "Present your finished plan and ask to start carrying it out. Only in Plan mode, and only once the " +
      "plan is complete enough to act on. The human decides; you never leave Plan mode on your own.",
    promptSnippet: "Present a finished plan and ask to begin work",
    parameters: Type.Object({
      plan: Type.String({
        description: "The plan itself, in full. What you will change, in what order, and how you will check it.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const text = (s: string) => [{ type: "text" as const, text: s }];

      // The read-only posture (interactive.ts `readOnlyPosture`) supplies this; no mode named plan exists.
      const isPlanning = opts.isPlanning?.() ?? true;

      if (!isPlanning) {
        opts.state.misfired += 1;
        return { content: text(NOT_PLANNING_NOTICE), details: { exited: false, reason: "not-planning" } };
      }

      opts.state.presented += 1;
      let next: InteractionMode | null;
      try {
        next = await opts.requestExit(params.plan);
      } catch {
        // A broken channel is a human who did not answer, not a failed turn —
        // the same call `ask` makes. Staying in Plan mode is the safe side.
        next = null;
      }

      if (next === null) {
        opts.state.rejected += 1;
        opts.record?.(params.plan, "rejected");
        return { content: text(PLAN_DECLINED_NOTICE), details: { exited: false, reason: "declined" } };
      }

      opts.state.approved += 1;
      opts.record?.(params.plan, "approved");
      const label = next ? MODE_INFO[next].label : "Manual";
      const desc = next ? MODE_INFO[next].description : MODE_INFO.manual.description;
      return {
        content: text(
          `The plan was accepted and the interaction mode is now ${label}: ` +
            `${desc}. Carry out the plan.`,
        ),
        details: { exited: true, mode: next },
      };
    },
  });
}
