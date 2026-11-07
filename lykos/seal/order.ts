// T232 (spec decision 11): the order the harness verifies a sealed session in.
//
//   1. no new writer starts      (the session's job registry is closed)
//   2. quiescence is confirmed   (T256: everything the session started is proven gone, or verification is refused)
//   3. sealed paths are checked and restored
//   4. the seal record is validated, working tree and index included
//   5. verification runs         (the gate's command)
//   6. integrity is rechecked    (a restore now means something wrote a sealed file while the command ran)
//
// A restore at step 6 fails the verdict with SEALED-EDIT after one rerun of the command, on the restored tree: the
// run that saw an edited sealed test says nothing about the work. Steps 1 to 4 are `prepare`; 6 is `recheck`; step 5
// is the gate's own command, between them (`gate/verify-gate.ts`).
//
// The order exists only for a session with an active seal that the guard is enforced against; any other session has
// `createSealOrder` return undefined and is verified exactly as before.

import { loadConfig } from "../config/load.js";
import { DEFAULT_SEAL_ENFORCE_FOR, DEFAULT_SEAL_WRITERS } from "../config/defaults.js";
import { DEFAULT_SPECIALIST } from "../config/specialists.js";
import { openLedgerSync, recordSealEvent } from "../ledger/use.js";
import type { ProcessRecordRow } from "../ledger/ledger.js";
import { confirmQuiescence, type NotStopped, type QuiescenceDeps } from "../process/quiescence.js";
import { activeSeals, type ActiveSeal } from "./active.js";
import { sealEnforced } from "./enforce.js";
import { restoreSealed, type SealRestore } from "./guard.js";
import { verifySeals } from "./verify.js";

export interface SealOrder {
  /** Steps 1 to 4. `refuse` is the reason verification must not run. */
  prepare(): Promise<{ refuse: string } | undefined>;
  /** Step 6. `rerun` runs the verification command once more. A result blocks the verdict. */
  recheck(rerun: () => Promise<unknown>): Promise<{ blockReason: string } | undefined>;
}

export interface SealOrderInput {
  /** The session's own tree. */
  cwd: string;
  ledgerPath: string;
  sessionId: string;
  /** The id the session's owner row and process records are filed under; defaults to `sessionId`. */
  ownerId?: string | undefined;
  specialist?: string | undefined;
  readOnly?: boolean | undefined;
  /** Step 1: whatever can start a process for the session stops being able to. */
  closeWriters: () => void;
  env?: NodeJS.ProcessEnv | undefined;
  /** Test seam for step 2. */
  quiescence?: QuiescenceDeps | undefined;
}

/** The guard compares the seals of the checked-out HEAD; a missing one is no seal to guard. */
function sealsOf(cwd: string, env?: NodeJS.ProcessEnv): ActiveSeal[] {
  try {
    return activeSeals({ cwd, ...(env !== undefined ? { env } : {}) });
  } catch {
    return [];
  }
}

function describeNotStopped(list: readonly NotStopped[]): string {
  return list
    .map((n) => `${n.kind}${n.pid !== undefined ? ` ${n.pid}` : ""}${n.container !== undefined ? ` ${n.container}` : ""} (${n.liveness})`)
    .join(", ");
}

export function createSealOrder(input: SealOrderInput): SealOrder | undefined {
  const { resolved: config } = loadConfig({ cwd: input.cwd, ...(input.env !== undefined ? { env: input.env } : {}) });
  const specialist = input.specialist ?? DEFAULT_SPECIALIST;
  const enforced = sealEnforced({
    specialist,
    readOnly: input.readOnly,
    writers: config.seal.writers ?? DEFAULT_SEAL_WRITERS,
    enforceFor: config.seal.enforce_for ?? DEFAULT_SEAL_ENFORCE_FOR,
  });
  if (!enforced || sealsOf(input.cwd, input.env).length === 0) return undefined;

  const event = async (
    kind: "restored" | "tampered",
    seals: readonly ActiveSeal[],
    paths: readonly string[],
    detail: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await recordSealEvent(input.ledgerPath, {
        branch: seals[0]?.seal.branch ?? "",
        sessionId: input.sessionId,
        creator: input.sessionId,
        specialist,
        kind,
        paths: [...paths],
        detail: JSON.stringify(detail),
      });
    } catch {
      // The verdict does not depend on the ledger row.
    }
  };

  const restore = async (phase: "before verification" | "during verification"): Promise<SealRestore> => {
    const current = sealsOf(input.cwd, input.env);
    const outcome = restoreSealed(input.cwd, current, input.env);
    if (outcome.restored.length > 0 || outcome.failed.length > 0) {
      await event("restored", current, [...outcome.restored.map((d) => d.path), ...outcome.failed], {
        flag: "SEALED-EDIT",
        source: "verification",
        by: `a process of the session ${phase}`,
        restored: outcome.restored.map((d) => ({ path: d.path, where: d.where })),
        ...(outcome.failed.length > 0 ? { failed: outcome.failed } : {}),
      });
    }
    return outcome;
  };

  return {
    async prepare() {
      input.closeWriters();

      const ledger = openLedgerSync(input.ledgerPath);
      let notStopped: NotStopped[] | undefined;
      try {
        const q = await confirmQuiescence(ledger, input.ownerId ?? input.sessionId, {
          // This process is the session: its owner row and its own child record are not things it started. Its
          // container is still serving the verification command, and is removed after the gate.
          ignoreOwner: true,
          ignoreRecord: (r: ProcessRecordRow) => r.kind === "container" || (r.kind === "child" && r.pid === process.pid),
          ...(input.quiescence ?? {}),
        });
        notStopped = q.quiet ? undefined : q.notStopped;
      } finally {
        ledger.close();
      }
      if (notStopped !== undefined) {
        return { refuse: `[lykos-seal] Verification not run: the session's processes are not confirmed stopped: ${describeNotStopped(notStopped)}` };
      }

      await restore("before verification");

      const verified = await verifySeals({
        cwd: input.cwd,
        record: false,
        workingTree: true,
        ...(input.env !== undefined ? { env: input.env } : {}),
      });
      if (!verified.ok) {
        const bad = verified.seals.filter((s) => !s.valid);
        const causes = bad.flatMap((s) => s.causes);
        await event("tampered", sealsOf(input.cwd, input.env), bad.flatMap((s) => s.sealedPaths), { causes });
        return { refuse: `[lykos-seal] Verification not run: the seal record does not validate: ${causes.join("; ")}` };
      }
      return undefined;
    },

    async recheck(rerun) {
      const first = await restore("during verification");
      if (first.restored.length === 0 && first.failed.length === 0) return undefined;
      await rerun();
      const second = await restore("during verification");
      const failed = first.failed.length + second.failed.length > 0;
      const paths = [
        ...new Set([...first.restored.map((d) => d.path), ...first.failed, ...second.restored.map((d) => d.path), ...second.failed]),
      ];
      return {
        blockReason:
          `[lykos-seal] SEALED-EDIT: ${paths.map((p) => `"${p}"`).join(", ")} changed while the verification command ran and ` +
          `${failed ? "could not be restored" : "was restored"}; the command was rerun once on the restored tree. ` +
          `Sealed tests cannot be edited; if a test is wrong, dispute it.`,
      };
    },
  };
}
