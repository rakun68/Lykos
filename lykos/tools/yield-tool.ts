// How a subagent hands its answer back, and what happens when the answer is the
// wrong shape.
//
// **THE SCHEMA GOES BACK TO THE MODEL, NOT TO A REPAIR STEP (D5).** When the
// caller asked for an output schema and the yielded result does not match it,
// this tool returns the schema AND the validation failure to the model, and
// records nothing. The model corrects and yields again. This is the same
// principle `tool_call` already uses for a malformed call — `validateMountedTool
// Arguments` puts the schema in the error text — and it has the same
// justification: a malformed answer corrected in place by the thing that wrote
// it is cheap and correct, while a downstream repair is a second model guessing
// what the first one meant. The parent never receives a result that does not
// match what it asked for, and never receives one somebody else reshaped.
//
// **THE SCHEMA IS A KNOB WITH A LYKOS DEFAULT, AND THE DEFAULT IS NONE.**
// `YieldToolOpts.schema` is what the caller asked for. Absent — which is the
// shipped default — every yield is accepted as text, because most subagents
// are asked a question in English and answer in English, and demanding JSON of
// them would be a tax on the common case. A caller that wants structure sets
// it, and from that moment the contract is enforced rather than hoped for.
//
// **AN INTERMEDIATE YIELD IS NOT CHECKED, DELIBERATELY.** `final: false` is a
// progress report — "here is what I have so far" — and a progress report is
// prose by nature. Validating it would force a model to produce the finished
// shape before it has the finished answer, which is exactly the pressure that
// produces a confidently wrong result. The contract is on the answer, so the
// check is on the answer.
//
// **`yield` IS OPTIONAL.** Lykos's children finish by returning their final text
// through `runStandaloneTask`, and that path is not changed here — making
// `yield` mandatory would change how every existing child terminates, which is
// not this ticket. So `yield` is the structured channel a child MAY use and the
// only one that enforces a schema; the plain text path still works exactly as
// it did. What that costs is recorded rather than hidden: a caller that sets a
// schema gets it enforced on yields and not on a child that never yields.
//
// **THE SCHEMA TAX, RECORDED AT THE MOMENT THE TOOL IS ADDED (AGENTS.md rule
// 3): this tool rides NO request.** Mounted with `hidden` prompt presence
// (D9), reached through `tool_call`. The measured numbers are asserted in
// `yield-tool.test.ts`.

import { Type, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

export const YIELD_TOOL_NAME = "yield";

/** How many characters of a rejected result are quoted back. The model wrote it; it does not need the whole thing read to it. */
export const YIELD_ECHO_WIDTH = 600;

export interface YieldRecord {
  /** The result as the model wrote it. */
  raw: string;
  /** The parsed value, when a schema was in force and the result matched it. */
  value?: unknown;
  final: boolean;
  at: string;
}

export interface YieldState {
  /** Everything accepted, in order. The final one, if there is one, is the answer. */
  accepted: YieldRecord[];
  /** Yields handed back for not matching the schema. The counter D5 exists to make nonzero-able. */
  rejected: number;
  calls: number;
}

export function newYieldState(): YieldState {
  return { accepted: [], rejected: 0, calls: 0 };
}

export interface YieldToolOpts {
  state: YieldState;
  /**
   * The JSON Schema the caller asked the final result to match. Absent — the
   * shipped default — accepts any text.
   */
  schema?: unknown;
  /** Injectable clock, so a test can assert a timestamp. */
  now?: () => Date;
}

function text(s: string) {
  return [{ type: "text" as const, text: s }];
}

interface YieldToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: Record<string, unknown>;
}

export type SchemaCheck =
  | { status: "ok"; value: unknown }
  | { status: "not_json"; message: string }
  | { status: "mismatch"; errors: string[] }
  /** The configured schema itself could not be compiled. A caller's bug, not the model's. */
  | { status: "unusable"; message: string };

/**
 * Checks a yielded string against a JSON Schema.
 *
 * The result arrives as a string because that is what a model writes, so the
 * two failures are kept apart: "this is not JSON" and "this is JSON of the
 * wrong shape" need different corrections, and telling a model its object is
 * malformed when it actually sent prose sends it looking in the wrong place.
 */
export function checkAgainstSchema(schema: unknown, raw: string): SchemaCheck {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return { status: "not_json", message: err instanceof Error ? err.message : String(err) };
  }
  let validator: ReturnType<typeof Compile>;
  try {
    validator = Compile(schema as TSchema);
  } catch (err) {
    return { status: "unusable", message: err instanceof Error ? err.message : String(err) };
  }
  if (validator.Check(value)) return { status: "ok", value };
  const errors = Array.from(validator.Errors(value)).map(
    (e) => `  - ${(e.instancePath ?? "").replace(/^\//, "").replace(/\//g, ".") || "root"}: ${e.message}`,
  );
  return { status: "mismatch", errors: errors.length > 0 ? errors : ["  - root: does not match the schema"] };
}

function echo(raw: string): string {
  const flat = raw.length > YIELD_ECHO_WIDTH ? `${raw.slice(0, YIELD_ECHO_WIDTH - 1)}…` : raw;
  return flat;
}

export const YIELD_DESCRIPTION =
  "Hand your result back to whoever asked for this work. `final: true` — the default — is the answer; " +
  "`final: false` is a progress report that changes nothing. If the caller asked for a particular output shape, " +
  "`result` must be JSON matching it: a result that does not match is handed straight back to you with the " +
  "schema and what was wrong, and nothing is recorded, so correct it here rather than hoping something " +
  "downstream will. When no shape was asked for, write the answer as ordinary text.";

export const YIELD_PARAMETERS = Type.Object({
  result: Type.String({
    description: "The result itself. JSON matching the requested schema when one was requested; otherwise plain text.",
  }),
  final: Type.Optional(
    Type.Boolean({ description: "False for a progress report. Defaults to true, which is the answer." }),
  ),
});

export function buildYieldTool(opts: YieldToolOpts): ToolDefinition {
  return defineTool({
    name: YIELD_TOOL_NAME,
    label: "Yield",
    description: YIELD_DESCRIPTION,
    promptSnippet: "Hand a result back, checked against the requested shape",
    parameters: YIELD_PARAMETERS,
    async execute(_id, params): Promise<YieldToolResult> {
      const state = opts.state;
      state.calls += 1;
      const raw = String(params.result ?? "");
      const final = params.final !== false;

      if (raw.trim() === "") {
        return {
          content: text("lykos yield: `result` is empty. An empty result is a mis-call, not an answer."),
          isError: true,
          details: { accepted: false, reason: "empty_result" },
        };
      }

      const schema = opts.schema;
      // An intermediate yield is prose by nature; the contract is on the
      // answer, so the check is on the answer.
      if (schema !== undefined && final) {
        const check = checkAgainstSchema(schema, raw);
        if (check.status === "not_json" || check.status === "mismatch") {
          state.rejected += 1;
          const why =
            check.status === "not_json"
              ? `That result is not JSON (${check.message}).`
              : `That result is JSON, but does not match the requested shape:\n${check.errors.join("\n")}`;
          return {
            content: text(
              `${why}\n\nNothing was recorded and nothing downstream will repair it — yield again with a result ` +
                `that matches this schema:\n${JSON.stringify(schema, null, 2)}\n\nWhat you sent:\n${echo(raw)}`,
            ),
            isError: true,
            details: {
              accepted: false,
              reason: check.status,
              schema,
              ...(check.status === "mismatch" ? { errors: check.errors } : {}),
              rejected: state.rejected,
            },
          };
        }
        if (check.status === "unusable") {
          // The caller's schema, not the model's result. Refusing here would
          // trap a child that can never satisfy a schema nothing can compile.
          const record: YieldRecord = { raw, final, at: (opts.now?.() ?? new Date()).toISOString() };
          state.accepted.push(record);
          return {
            content: text(
              `Result accepted, but the requested output schema could not be compiled (${check.message}), so it ` +
                "was NOT checked against it. That is a problem with what was asked for, not with what you sent — " +
                "say so in your answer.",
            ),
            details: { accepted: true, final, checked: false, reason: "unusable_schema" },
          };
        }
        const record: YieldRecord = {
          raw,
          value: check.value,
          final,
          at: (opts.now?.() ?? new Date()).toISOString(),
        };
        state.accepted.push(record);
        return {
          content: text("Result accepted: it matches the requested shape. Stop here — this is the answer."),
          details: { accepted: true, final: true, checked: true, yields: state.accepted.length },
        };
      }

      const record: YieldRecord = { raw, final, at: (opts.now?.() ?? new Date()).toISOString() };
      state.accepted.push(record);
      return {
        content: text(
          final
            ? "Result accepted. No output shape was requested, so it was taken as written. Stop here — this is the answer."
            : "Progress noted. Nothing is settled by an intermediate yield; carry on and yield again when you have the answer.",
        ),
        details: { accepted: true, final, checked: false, yields: state.accepted.length },
      };
    },
  }) as ToolDefinition;
}
