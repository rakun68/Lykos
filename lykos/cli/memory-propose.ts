// `lykos memory propose|proposals|accept` — CLI adapter: parse args, call the
// domain, print.
//
// P10.6 (ticket 18, D3): the domain that used to live here is now
// `memory/proposals.ts` and reaches this file through `memory.ts`, because a
// tool cannot import from `cli/` and the proposal queue is the mechanism
// `retain` and `learn` propose into. Nothing about the queue changed in the
// move; the reasoning for it is at the top of `memory/proposals.ts`, where the
// code is. The names are re-exported here so `cli.ts` and this module's own
// tests still find them at the path they have always used.
//
// **`accept` is the human's verb and it lives ONLY here.** ADR-0017 kept the
// acceptance rule when it dropped the scope restriction: a model proposes, a
// human accepts. No tool imports `acceptProposal`, and `tools/memory-tools.ts`
// is given a dependency object that does not contain it — so "no tool can
// activate a memory" is a fact about what is reachable, not a rule somebody
// has to remember.

import { stdoutWrite } from "../tui/io-mode.js";
import {
  acceptProposal,
  DEFAULT_PROMOTE_AFTER,
  normalizeLesson,
  proposalSeenCount,
  proposedPath,
  proposeMemory,
  readProposals,
  type AcceptResult,
  type ProposeOptions,
  type ProposeResult,
} from "../memory.js";

export {
  acceptProposal,
  DEFAULT_PROMOTE_AFTER,
  normalizeLesson,
  proposedPath,
  proposeMemory,
  type AcceptResult,
  type ProposeOptions,
  type ProposeResult,
};

// --------------------------------------------------------------- CLI verbs

export function runMemoryPropose(cwd: string, text: string, opts: ProposeOptions = {}): number {
  if (!text || text.trim().length === 0) {
    process.stderr.write('lykos memory propose: expected text, e.g. `lykos memory propose "..."`\n');
    return 1;
  }
  const r = proposeMemory(cwd, text, opts);
  if (r.status === "repeated") {
    stdoutWrite(
      `[${r.id}] proposed again — seen ${r.seen} time(s). ` +
        `${r.seen >= DEFAULT_PROMOTE_AFTER ? "Ready for `lykos memory accept`." : "Not yet promotable."}\n`,
    );
  } else {
    stdoutWrite(
      `queued [${r.id}] in ${proposedPath(cwd)} — seen once, never injected. ` +
        "A lesson observed once is an anecdote; propose it again if it recurs.\n",
    );
  }
  return 0;
}

export function runMemoryProposals(cwd: string): number {
  const { entries } = readProposals(cwd);
  const open = entries.filter((e) => !e.meta.invalid);
  if (entries.length === 0) {
    stdoutWrite("no proposals queued. Nothing here is ever injected; a human accepts or nothing happens.\n");
    return 0;
  }
  stdoutWrite(`${open.length} open proposal(s), ${entries.length - open.length} already accepted:\n`);
  for (const e of open) {
    const seen = proposalSeenCount(e);
    const ready = seen >= DEFAULT_PROMOTE_AFTER ? "READY" : `${seen}/${DEFAULT_PROMOTE_AFTER}`;
    stdoutWrite(`  [${e.id}] ${ready.padEnd(6)} -> ${e.meta.target ?? "gotchas"}  ${e.text}\n`);
  }
  stdoutWrite("\nAccept one with `lykos memory accept <id>`. There is no automatic promotion, by design.\n");
  return 0;
}

export function runMemoryAccept(cwd: string, idOrMatch: string): number {
  if (!idOrMatch) {
    process.stderr.write("lykos memory accept: expected a proposal id, e.g. `lykos memory accept a1b2c3d4`\n");
    return 1;
  }
  const r = acceptProposal(cwd, idOrMatch);
  switch (r.status) {
    case "not_found":
      process.stderr.write(`lykos memory accept: no single open proposal matching "${idOrMatch}"\n`);
      return 1;
    case "already_accepted":
      stdoutWrite(`[${r.entry.id}] was already accepted (${r.entry.meta.reason ?? "no note"})\n`);
      return 0;
    case "below_threshold":
      process.stderr.write(
        `lykos memory accept: [${r.entry.id}] has been proposed ${r.seen} time(s), needs ${r.needed}. ` +
          "A lesson observed once is an anecdote.\n",
      );
      return 1;
    case "accepted":
      stdoutWrite(`accepted [${r.entry.id}] into ${r.target} as [${r.newId}] — it will be injected from now on\n`);
      return 0;
  }
}
