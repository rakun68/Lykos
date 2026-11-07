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
import { defaultLedgerPath, openLedgerSync } from "../ledger/use.js";
import { confirmQuiescence, type Quiescence, type QuiescenceDeps } from "../process/quiescence.js";
import type { Liveness } from "../process/identity.js";
import { runDelegated } from "./mcp-server.js";
import { isLive, ownerLiveness, ownerRow, takeOver, type LivenessOf, type OwnerRow } from "./ownership.js";
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
  /** T236: `false` for a session a review cycle owns; a question nobody answers in time then stops it. */
  decideAlone?: false;
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
  next: "fix_environment" | "wait" | "resume";
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
      ...(row.write_in_place === 1 ? { write_in_place: true } : {}),
      ...(opts.decideAlone === false ? { decide_alone: false as const } : {}),
    },
    {
      trustSource: opts.trustSource,
      adopt: true,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
      ...(opts.run !== undefined ? { run: opts.run } : {}),
    },
  );
  return { ...result, recovered: { from_pid: row.owner_pid, crashes } };
}
