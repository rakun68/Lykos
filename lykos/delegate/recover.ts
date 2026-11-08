// `lykos recover <id>` (T246, ADR-0060 amended, spec decisions 5 and 15): continue, by hand, a delegated session
// whose owner is gone. Fail-closed throughout:
//   - an owner that is `alive` or `unknown` is refused, naming its pid: recover never kills anything;
//   - everything the session started must be confirmed gone first (T256);
//   - ownership moves with one conditional update of the `owners` row, the tree lock with it; a second recover
//     racing it loses and says so;
//   - the session continues with a standard turn, since a resume alone only waits;
//   - the sixth crash stops it, with the reason.

import { existsSync } from "node:fs";
import type { TrustSource } from "../gate/trust.js";
import { defaultLedgerPath, openLedgerSync, withLedgerSync, type Ledger } from "../ledger/use.js";
import { confirmQuiescence, type Quiescence, type QuiescenceDeps } from "../process/quiescence.js";
import type { Liveness } from "../process/identity.js";
import { runDelegated } from "./mcp-server.js";
import { giveBack, isLive, ownerLiveness, ownerRow, takeOver, type LivenessOf, type OwnerRow } from "./ownership.js";
import { REVIEW_ROLE } from "./review.js";
import { sessionModelPath } from "./session-base.js";
import type { SessionRunner } from "./session-protocol.js";

/** The turn a recovered session continues with. */
export const INTERRUPTED_TURN =
  "You were interrupted: the process running this session died. Tool calls marked interrupted have unknown outcomes. " +
  "Check the tree (git status, the files you were changing, the tests) before you trust anything you did, then continue the task.";

export interface RecoverOptions {
  trustSource: TrustSource;
  /** Added to the standard turn. */
  message?: string;
  /** The step cap of the continued run (`--max-steps`). */
  maxSteps?: number;
  /** T236: `false` for a session a review cycle owns; a question nobody answers in time then stops it. */
  decideAlone?: false;
  /** T236: the caller is the cycle the session is a step of, recovering it in place. */
  fromCycle?: true;
  signal?: AbortSignal;
  onProgress?: (line: string) => void;
  /** Tests pass stand-ins. */
  run?: SessionRunner;
  livenessOf?: LivenessOf;
  quiescence?: QuiescenceDeps;
}

export type RecoverRefusal = {
  outcome: "error";
  message: string;
  sessionId: string;
  next: "fix_environment" | "wait" | "resume" | "recover";
  cycle_id?: string;
  owner_pid?: number;
  owner_liveness?: Exclude<Liveness, "dead">;
  not_stopped?: Quiescence["notStopped"];
};

function refuse(sessionId: string, message: string, next: RecoverRefusal["next"], extra: Partial<RecoverRefusal> = {}): RecoverRefusal {
  return { outcome: "error", message: `lykos recover: ${message}`, sessionId, next, ...extra };
}

/** Recovers `sessionId`: the result contract of the continued run, or why it was refused. */
export async function recoverSession(workspace: string, sessionId: string, opts: RecoverOptions): Promise<Record<string, unknown>> {
  const ledgerPath = defaultLedgerPath(workspace);
  if (!existsSync(ledgerPath)) return refuse(sessionId, `unknown session id: ${sessionId}`, "fix_environment");
  let row: OwnerRow;
  let crashes: number;
  let modelPath: string | undefined;
  const ledger = openLedgerSync(ledgerPath);
  try {
    const found = ownerRow(ledger, sessionId);
    if (found === undefined) return refuse(sessionId, `unknown session id: ${sessionId}`, "fix_environment");
    row = found;
    if (!isLive(row.state)) return refuse(sessionId, `session ${sessionId} is ${row.state}, not crashed; continue it with \`lykos continue\``, "resume");
    const liveness = (opts.livenessOf ?? ownerLiveness)(row);
    if (liveness !== "dead") {
      return refuse(
        sessionId,
        liveness === "alive"
          ? `its owner, pid ${row.owner_pid}, is alive; stop it first (\`lykos stop ${sessionId}\`, or end pid ${row.owner_pid}); recover never kills anything`
          : `the OS will not say whether its owner, pid ${row.owner_pid}, is alive; make sure pid ${row.owner_pid} is gone first; recover never kills anything`,
        liveness === "alive" ? "wait" : "fix_environment",
        { owner_pid: row.owner_pid, owner_liveness: liveness },
      );
    }
    // A session that is the running step of a review cycle is recovered with its cycle: recovering it alone would
    // leave the cycle crashed, and the cycle's own recover would then find the step's session ended.
    if (opts.fromCycle !== true) {
      const cycle = runningCycleOf(ledger, sessionId);
      if (cycle !== undefined) {
        return refuse(sessionId, `session ${sessionId} is the running step of review cycle ${cycle}; recover the cycle (\`lykos recover ${cycle}\`), which recovers this session in place`, "recover", { cycle_id: cycle });
      }
    }
    const quiet = await confirmQuiescence(ledger, sessionId, opts.quiescence ?? {});
    if (!quiet.quiet) {
      const named = quiet.notStopped.map((n) => `${n.kind}${n.pid !== undefined ? ` pid ${n.pid}` : ""}${n.container !== undefined ? ` ${n.container}` : ""} (${n.liveness})`);
      return refuse(sessionId, `what the session started is not confirmed stopped: ${named.join(", ")}; stop it first; recover never kills anything`, "fix_environment", {
        not_stopped: quiet.notStopped,
      });
    }
    const taken = takeOver(ledger, row);
    if (!taken.ok) return refuse(sessionId, taken.reason, taken.kind === "lost" ? "wait" : "fix_environment");
    crashes = taken.crashes;
    modelPath = sessionModelPath(ledger, sessionId);
  } finally {
    ledger.close();
  }
  opts.onProgress?.(`took session ${sessionId} over from dead pid ${row.owner_pid} (crash ${crashes})`);
  const brief = opts.message !== undefined && opts.message.trim() !== "" ? `${INTERRUPTED_TURN}\n\n${opts.message}` : INTERRUPTED_TURN;
  const result = await runDelegated(
    workspace,
    {
      brief,
      session_id: sessionId,
      // The model it ran on, by its full path: the bare id the ledger shows would name the wrong provider.
      ...(modelPath !== undefined ? { model: modelPath } : {}),
      ...(row.specialist !== null ? { specialist: row.specialist } : {}),
      // A reviewer keeps its `finding` tool: every review session (`lykos review`, a cycle's) runs as REVIEW_ROLE.
      ...(row.specialist === REVIEW_ROLE ? { review: true as const } : {}),
      ...(row.write_in_place === 1 ? { write_in_place: true } : {}),
      ...(opts.decideAlone === false ? { decide_alone: false as const } : {}),
      ...(opts.maxSteps !== undefined ? { max_steps: opts.maxSteps } : {}),
    },
    {
      trustSource: opts.trustSource,
      adopt: true,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
      ...(opts.run !== undefined ? { run: opts.run } : {}),
    },
  );
  // A run refused before it started (the project cap, say) leaves the row this process's and live: it is given back,
  // so the refusal counts no crash and the session stays crashed, to be recovered again.
  let givenBack = false;
  try {
    givenBack = withLedgerSync(ledgerPath, (l) => giveBack(l, row, crashes));
  } catch {}
  if (givenBack) {
    opts.onProgress?.(`session ${sessionId} did not start; it is crashed again, owned by dead pid ${row.owner_pid}`);
    return result;
  }
  return { ...result, recovered: { from_pid: row.owner_pid, crashes } };
}

/** The running review cycle whose started step is this session, if any. */
function runningCycleOf(ledger: Ledger, sessionId: string): string | undefined {
  const row = ledger.db
    .prepare(
      `SELECT s.cycle_id AS id FROM cycle_steps s JOIN cycles c ON c.id = s.cycle_id
       WHERE c.state = 'running' AND s.state = 'started'
         AND (s.session_id = @id OR s.request_id IN (SELECT request_id FROM owner_requests WHERE session_id = @id))
       LIMIT 1`,
    )
    .get({ id: sessionId }) as { id: string } | undefined;
  return row?.id;
}
