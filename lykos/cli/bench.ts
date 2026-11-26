// `lykos bench import` and `lykos bench check` (T258): one public benchmark task imported as a task file, and its hidden
// tests run on a finished branch with the outcome in the project ledger. The work is in `lykos/bench/swe-live.ts`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  asInstance,
  BenchError,
  checkInstance,
  fetchInstance,
  importInstance,
  pythonLogParser,
  recordCheck,
  type SweLiveInstance,
} from "../bench/swe-live.js";
import { defaultLedgerPath, withLedger } from "../ledger/use.js";
import { stderrWrite, stdoutWrite } from "../io-mode.js";
import { positionals } from "./args.js";

export const DEFAULT_BENCH_DATASET = "SWE-bench-Live/Windows";

const IMPORT_USAGE = "lykos bench import <instance-id> --out <dir> [--dataset <hf-dataset>] [--from <row.json>]";
const CHECK_USAGE = "lykos bench check <instance-id> [--repo <dir>] [--ref <ref>] [--python <exe>]";
const VALUED = ["out", "dataset", "from", "repo", "ref", "python"];

function flag(args: readonly string[], name: string): string | undefined {
  const inline = args.find((a) => a.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}

function print(value: unknown): void {
  stdoutWrite(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runBench(cwd: string, args: readonly string[]): Promise<number> {
  const [sub, instanceId, ...extra] = positionals(args, VALUED);
  if (sub !== "import" && sub !== "check") {
    stderrWrite(`lykos bench: expected \`import\` or \`check\`\n  ${IMPORT_USAGE}\n  ${CHECK_USAGE}\n`);
    return 1;
  }
  if (instanceId === undefined || extra.length > 0) {
    stderrWrite(`lykos bench ${sub}: ${sub === "import" ? IMPORT_USAGE : CHECK_USAGE}\n`);
    return 1;
  }
  try {
    return sub === "import" ? await benchImport(cwd, instanceId, args) : await benchCheck(cwd, instanceId, args);
  } catch (err) {
    if (err instanceof BenchError) {
      stderrWrite(`lykos ${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

async function benchImport(cwd: string, instanceId: string, args: readonly string[]): Promise<number> {
  const out = flag(args, "out");
  if (out === undefined) {
    stderrWrite(`lykos bench import: --out <dir> is required\n  ${IMPORT_USAGE}\n`);
    return 1;
  }
  const dataset = flag(args, "dataset") ?? DEFAULT_BENCH_DATASET;
  const from = flag(args, "from");
  let instance: SweLiveInstance;
  let revision: string;
  if (from !== undefined) {
    // A row saved earlier: its revision is whatever the file says, else unknown.
    const parsed = JSON.parse(readFileSync(resolve(cwd, from), "utf8")) as Record<string, unknown>;
    const row = "instance" in parsed ? parsed.instance : parsed;
    instance = asInstance(row);
    revision = typeof parsed.revision === "string" ? parsed.revision : "unknown";
  } else {
    ({ instance, revision } = await fetchInstance(dataset, instanceId));
  }
  if (instance.instance_id !== instanceId) throw new BenchError(`bench: the row is ${instance.instance_id}, not ${instanceId}`);
  const result = importInstance({ dataset, revision, instance, out: resolve(cwd, out) });
  print({
    instance: result.instanceId,
    dataset,
    revision,
    repo: result.repoDir,
    task: result.taskFile,
    hidden: result.stored,
    then: `lykos cycle ${result.taskFile} (from ${result.repoDir}), then lykos bench check ${result.instanceId} --repo ${result.repoDir} --ref <branch>`,
  });
  return 0;
}

async function benchCheck(cwd: string, instanceId: string, args: readonly string[]): Promise<number> {
  const repo = resolve(cwd, flag(args, "repo") ?? ".");
  const ref = flag(args, "ref") ?? "HEAD";
  const python = flag(args, "python");
  const result = await checkInstance({ repo, ref, instanceId, ...(python !== undefined ? { parseLog: pythonLogParser(python) } : {}) });
  const id = await withLedger(defaultLedgerPath(repo), async (ledger) => recordCheck(ledger, result));
  print({ ...result, ledger_row: id });
  return result.status === "resolved" ? 0 : result.status === "unresolved" ? 1 : 2;
}
