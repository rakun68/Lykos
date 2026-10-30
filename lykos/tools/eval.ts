// The tool: one persistent evaluation cell.
//
// **Why it exists.** Computing something today is a `bash` call into `node -e`
// that loses its variables the moment it returns, so every follow-up question
// re-does the setup. One call is one cell here, and the next call sees what
// the last one left behind.
//
// **THE RUNTIME IS A CHILD PROCESS, NEVER THE AGENT'S OWN (D5).** That
// decision, and the proof of it, live in `eval-runtime.ts`; this file only
// dispatches to it. The short version, because it is the reason this tool
// exists in the shape it does: evaluated code must not be able to reach the
// session objects, the ledger or the gate, and a `node:vm` context in this
// process is one `require.cache` walk away from all three.
//
// **JAVASCRIPT SHIPS; PYTHON IS DECLARED AND UNCONFIGURED (D6).** `language`
// takes `js` and `py`. `py` looks for a configured interpreter and, finding
// none, returns the sentence naming `eval.python` — the same shape `github`
// uses for a missing `gh` and `lsp` uses for a missing language server. The
// knob exists, the default is Lykos's own, and the unbuilt half says it is
// unbuilt rather than pretending not to exist. A model told "python is not
// configured, here is the key" can ask a human to set it; a model told
// "unknown language" concludes Python is impossible.
//
// **THE GATE, ON EVERY CALL.** `eval` is `hard-write` and open-world because
// it runs arbitrary code, and there is no version of that which is a read.
// `authorizeEvalCell` shows the human the whole cell as the approval body, and
// deliberately does NOT reach `classifyCommandRisk` — see its own comment for
// why a POSIX shell parser has nothing true to say about a JavaScript cell.
//
// **THE SCHEMA TAX, RECORDED AT THE MOMENT THE TOOL IS ADDED (AGENTS.md rule
// 3): this tool rides NO request.** Mounted with `hidden` prompt presence
// (D10), reached through `tool_call`. The measured numbers are asserted in
// `eval.test.ts`, so a description that doubles the bill fails a test rather
// than passing silently.

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ApprovalDeniedError, authorizeEvalCell, type ApprovalGate, type DenialLog } from "../gate/approval.js";
import {
  EVAL_DEFAULT_TIMEOUT_SECONDS,
  EVAL_LANGUAGES,
  EVAL_MAX_TIMEOUT_SECONDS,
  type EvalLanguage,
  type EvalOutcome,
  type EvalRuntimePool,
} from "./eval-runtime.js";

export const EVAL_TOOL_NAME = "eval";

/** D6: the configuration key the unconfigured half names. `config/types.ts` owns the field; this owns the sentence. */
export const EVAL_PYTHON_CONFIG_KEY = "eval.python";

/**
 * D6's sentence, exported and asserted verbatim so it cannot decay into
 * "unsupported language" by a later edit that means well.
 *
 * It names the key, says where the file is, and says what to do instead —
 * because the model reading it has a task in front of it and "python is off"
 * is not an answer to that task.
 */
export const EVAL_PYTHON_UNCONFIGURED_NOTICE =
  `Python evaluation is declared but not configured, so no Python ran and nothing was changed. Set ` +
  `\`${EVAL_PYTHON_CONFIG_KEY}\` in .lykos/config.yaml to the interpreter to use (for example ` +
  `\`${EVAL_PYTHON_CONFIG_KEY}: python3\`) — a human has to do that, this tool cannot. Until then use ` +
  `\`language: "js"\`, which is the runtime Lykos ships, or run a script through bash.`;

export const EVAL_DESCRIPTION =
  "Run one cell of code in a runtime that keeps its variables between calls. One call is one cell: declare " +
  "something in this call and the next call can still see it, which is what makes this different from a `bash` " +
  "call into `node -e`. Use it to compute, parse, reshape and check things rather than reasoning about them in " +
  "your head. `language` is \"js\" today; \"py\" reports how to configure an interpreter. The result is the " +
  "cell's final value plus anything it printed. `reset: true` throws the retained state away and starts clean " +
  "before running. A cell that does not finish within `timeout` seconds (default " +
  `${EVAL_DEFAULT_TIMEOUT_SECONDS}) is abandoned and the runtime is restarted, which loses every variable — the ` +
  "result says so when it happens. Top-level `await` works. The code runs in a separate process: it cannot see " +
  "this session, its ledger or its approvals, and it reaches the filesystem only as any other program would.";

export const EVAL_PARAMETERS = Type.Object({
  language: Type.String({ description: `Which runtime: ${EVAL_LANGUAGES.join(" or ")}.` }),
  code: Type.String({ description: "The cell body, verbatim. Its last expression is the value reported back." }),
  timeout: Type.Optional(
    Type.Number({
      description: `Seconds before the cell is abandoned and the runtime restarted (default ${EVAL_DEFAULT_TIMEOUT_SECONDS}, at most ${EVAL_MAX_TIMEOUT_SECONDS}).`,
    }),
  ),
  reset: Type.Optional(
    Type.Boolean({ description: "Discard everything the retained runtime holds and start a fresh one before running this cell." }),
  ),
});

export interface EvalToolOpts {
  cwd: string;
  gate: ApprovalGate;
  denials?: DenialLog;
  /** The session's runtimes. Owned by the session, not by this tool: created per session and disposed at teardown. */
  runtimes: EvalRuntimePool;
  /**
   * D6: the configured Python interpreter, from `eval.python`. Absent — which
   * is the shipped default — is what makes `py` report itself unconfigured.
   */
  python?: string;
}

function text(s: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text" as const, text: s }];
}

/**
 * One result shape for every branch, for `memory-tools.ts`'s reason: under
 * `exactOptionalPropertyTypes` TypeScript will not unify five differently
 * shaped `details` objects on its own, and naming the shape once is cheaper
 * than five casts — and keeps `isError` from being forgotten on a refusal.
 */
interface EvalToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: Record<string, unknown>;
}

export function isEvalLanguage(value: string): value is EvalLanguage {
  return (EVAL_LANGUAGES as readonly string[]).includes(value);
}

/** Clamp to the band the schema advertises. A model that asks for a day gets an hour, and one that asks for zero gets the default rather than no watchdog at all. */
export function resolveEvalTimeoutMs(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return EVAL_DEFAULT_TIMEOUT_SECONDS * 1000;
  return Math.min(Math.floor(raw), EVAL_MAX_TIMEOUT_SECONDS) * 1000;
}

/**
 * What the human is asked. The first non-empty line of the cell, because that
 * is what a cell is usually about; the whole cell is the approval BODY, so
 * nothing is hidden by the shortening.
 */
export function cellHeadline(code: string, width = 120): string {
  const first = code.split("\n").find((line) => line.trim() !== "")?.trim() ?? "(empty cell)";
  return first.length > width ? `${first.slice(0, width - 1)}…` : first;
}

/** D8/D9 in the result, not only in the description: the model has to be told what it lost and what it did not see. */
export function renderOutcome(outcome: EvalOutcome, language: EvalLanguage): string {
  if (outcome.status === "timeout") {
    return (
      `The cell did not finish within its timeout, so it was abandoned and the ${language} runtime was restarted. ` +
      `EVERY VARIABLE IS GONE: a process stopped mid-evaluation has unknown state, so it is replaced rather than ` +
      `reused. Re-create what you need, and if the work is genuinely long-running raise \`timeout\` or start it ` +
      `with hub instead.`
    );
  }
  if (outcome.status === "crashed") {
    return (
      `The ${language} runtime died while the cell was running, so its state is gone and a fresh one starts on the ` +
      `next call.` + (outcome.error !== undefined ? `\n\n${outcome.error}` : "")
    );
  }

  const parts: string[] = [];
  if (outcome.restarted === true) parts.push(`(Retained state was discarded before this cell ran.)`);
  const printed = outcome.output.replace(/\s+$/, "");
  if (printed !== "") parts.push(printed);
  if (outcome.status === "error") {
    parts.push(outcome.error ?? "The cell threw, but the runtime reported no error text.");
  } else if (outcome.value !== undefined) {
    parts.push(`=> ${outcome.value}`);
  }
  if (parts.length === 0 || (parts.length === 1 && outcome.restarted === true)) {
    parts.push("(no output, and the cell evaluated to undefined)");
  }
  if (outcome.truncated) {
    parts.push(
      `(Output passed the cap and was cut here — this is a prefix, not all of it. Print less, or write it to a ` +
        `file and read the part you need.)`,
    );
  }
  if (outcome.wrappedForAwait === true) {
    parts.push(
      `(This cell used top-level await or a bare return, so it ran inside an async wrapper. Two consequences: its ` +
        `own \`let\` and \`const\` declarations did NOT persist — assign to a property of globalThis if a later ` +
        `cell needs them — and its value comes from an explicit \`return\`, not from its last expression.)`,
    );
  }
  return parts.join("\n");
}

export function buildEvalTool(opts: EvalToolOpts): ToolDefinition {
  return defineTool({
    name: EVAL_TOOL_NAME,
    label: "Eval",
    description: EVAL_DESCRIPTION,
    promptSnippet: "Run one cell of code in a runtime that keeps its state",
    promptGuidelines: [
      "Reach for this rather than a bash call into `node -e` whenever the next question will build on this answer.",
    ],
    parameters: EVAL_PARAMETERS,
    async execute(_toolCallId, params): Promise<EvalToolResult> {
      const language = String(params.language ?? "").trim();
      if (!isEvalLanguage(language)) {
        const reason =
          `lykos eval: unknown language ${JSON.stringify(params.language)}. There are two: ` +
          `${EVAL_LANGUAGES.join(", ")}.`;
        return { content: text(reason), isError: true, details: { error: reason } };
      }

      const code = String(params.code ?? "");
      if (code.trim() === "") {
        const reason = "lykos eval: `code` is empty. An empty cell is a mis-call, not a no-op.";
        return { content: text(reason), isError: true, details: { error: reason } };
      }

      // D6: the unbuilt half, before anything is approved or spawned. An
      // unconfigured interpreter is an answer, not an error — `success: false`
      // and no `isError`, exactly as `lsp` reports a missing language server.
      if (language === "py" && (opts.python === undefined || opts.python.trim() === "")) {
        return {
          content: text(EVAL_PYTHON_UNCONFIGURED_NOTICE),
          details: {
            language,
            success: false,
            configured: false,
            setting: EVAL_PYTHON_CONFIG_KEY,
          },
        };
      }
      if (language === "py") {
        // A configured interpreter is still an unbuilt backend. Saying so is
        // the honest answer; silently running JavaScript instead would be the
        // dishonest one, and the reference is explicit that the tool never
        // substitutes another language.
        return {
          content: text(
            `\`${EVAL_PYTHON_CONFIG_KEY}\` names ${JSON.stringify(opts.python)}, but the Python backend is not ` +
              `built yet, so no Python ran. Use \`language: "js"\`, or run the interpreter through bash.`,
          ),
          details: { language, success: false, configured: true, setting: EVAL_PYTHON_CONFIG_KEY },
        };
      }

      try {
        await authorizeEvalCell(
          opts.cwd,
          opts.gate,
          `evaluate a ${language} cell in the retained runtime`,
          cellHeadline(code),
          code,
          opts.denials,
        );
      } catch (err) {
        if (err instanceof ApprovalDeniedError) {
          return { content: text(err.message), isError: true, details: { language, error: err.message } };
        }
        throw err;
      }

      const runtime = opts.runtimes.runtimeFor(language);
      const outcome = await runtime.evaluate(code, {
        timeoutMs: resolveEvalTimeoutMs(params.timeout as number | undefined),
        ...(params.reset === true ? { reset: true } : {}),
      });

      return {
        content: text(renderOutcome(outcome, language)),
        // A cell that threw is NOT a failed tool call: the model asked what
        // this code does and "it throws a TypeError" is the answer. A timeout
        // and a crash are, because the model's next cell would be written
        // against state that no longer exists.
        ...(outcome.status === "timeout" || outcome.status === "crashed" ? { isError: true as const } : {}),
        details: {
          language,
          status: outcome.status,
          success: outcome.status === "ok" || outcome.status === "error",
          truncated: outcome.truncated,
          durationMs: outcome.durationMs,
          ...(outcome.restarted === true ? { restarted: true } : {}),
        },
      };
    },
  }) as ToolDefinition;
}
