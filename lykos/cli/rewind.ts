// `lykos rewind` — T104's human-facing half
// (`docs/24-strength-and-tooling-audit.md` §2.8).
//
// The agent never calls this. There is no `rewind` tool, no schema, and no
// path from a model to it: an agent that can rewind its own work is an agent
// that can erase the evidence of what it did, which is the opposite of a
// project whose first rule about its own archive is that nothing it runs is
// ever deleted.
//
// `lykos rewind` lists. `lykos rewind <hash>` (or `<n>`) restores. Nothing
// else, because anything else is `git` and the user already has it.
//
// T165: a hash is what `lykos show` prints, because an index shifts every time
// a new checkpoint is written and a copied `lykos rewind 2` would later restore
// a different one. Indexes still work.

import {
  createCheckpoint,
  findCheckpointByHash,
  isGitRepo,
  listCheckpoints,
  MIN_HASH_PREFIX,
  renderCheckpointList,
  renderRestore,
  restoreCheckpoint,
  restoreCheckpointByHash,
  shortHash,
} from "../loop/checkpoint.js";
import { stdoutWrite } from "../tui/io-mode.js";

export interface RewindOptions {
  /** Positional argument, if any: which checkpoint to restore — a hash prefix or an index. */
  index?: string;
  /** `lykos rewind --now` takes one by hand, e.g. before something risky. */
  now?: boolean;
}

export type RewindTarget = { index: number } | { hash: string } | { indexOrHash: string };

/**
 * T165: what the positional argument names. Fewer than MIN_HASH_PREFIX digits
 * is an index; hex of at least that length is a hash prefix. A run of digits
 * that long could be either, so it is resolved against the ref.
 */
export function parseRewindTarget(raw: string | undefined): RewindTarget | { error: string } | null {
  if (raw === undefined) return null;
  if (/^\d+$/.test(raw)) {
    return raw.length < MIN_HASH_PREFIX ? { index: Number(raw) } : { indexOrHash: raw };
  }
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length >= MIN_HASH_PREFIX) return { hash: raw };
  return {
    error:
      `expected a checkpoint hash (at least ${MIN_HASH_PREFIX} hex characters) ` +
      `or a checkpoint number (0 is the most recent), got "${raw}"`,
  };
}

export function runRewindCli(cwd: string, opts: RewindOptions): number {
  if (!isGitRepo({ cwd })) {
    process.stderr.write(
      "lykos rewind: not a git repository — checkpoints are git commits on a scratch ref, so there is nowhere to put them\n",
    );
    return 1;
  }

  if (opts.now === true) {
    const result = createCheckpoint({ cwd }, "manual checkpoint");
    if (result.status === "created") {
      stdoutWrite(`lykos rewind: checkpoint ${result.commit.slice(0, 8)} taken\n`);
      return 0;
    }
    if (result.status === "unchanged") {
      stdoutWrite("lykos rewind: nothing has changed since the last checkpoint — none taken\n");
      return 0;
    }
    process.stderr.write(`lykos rewind: ${result.reason}\n`);
    return 1;
  }

  const parsed = parseRewindTarget(opts.index);
  if (parsed === null) {
    stdoutWrite(`${renderCheckpointList(listCheckpoints({ cwd }))}\n`);
    return 0;
  }
  if ("error" in parsed) {
    process.stderr.write(`lykos rewind: ${parsed.error}\n`);
    return 1;
  }

  let result;
  if ("hash" in parsed) {
    result = restoreCheckpointByHash({ cwd }, parsed.hash);
  } else if ("index" in parsed) {
    result = restoreCheckpoint({ cwd }, parsed.index);
  } else {
    // All digits and long enough to be a hash: a hash that matches wins over
    // an index, unless the index names a checkpoint too — then neither is guessed.
    const raw = parsed.indexOrHash;
    const byHash = findCheckpointByHash({ cwd }, raw);
    const index = Number(raw);
    const byIndex = Number.isSafeInteger(index) ? listCheckpoints({ cwd }, index + 1)[index] : undefined;
    if ("entry" in byHash && byIndex !== undefined && byIndex.commit !== byHash.entry.commit) {
      process.stderr.write(
        `lykos rewind: "${raw}" is both checkpoint number ${index} (${shortHash(byIndex.commit)}) and the hash of ` +
          `${shortHash(byHash.entry.commit)}; give more of the hash. Nothing was restored.\n`,
      );
      return 1;
    }
    result =
      "entry" in byHash || byHash.matched.length > 1
        ? restoreCheckpointByHash({ cwd }, raw)
        : restoreCheckpoint({ cwd }, index);
  }
  const text = renderRestore(result);
  if (result.status === "error") {
    process.stderr.write(`${text}${text.endsWith(".") ? "" : "."} Nothing was restored.\n`);
    return 1;
  }
  stdoutWrite(`${text}\n`);
  return 0;
}
