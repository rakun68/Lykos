import { resolve } from "node:path";
import { detectDefaultBase, loadConfig } from "../config/load.js";
import { parseYaml } from "../config/yaml-file.js";
import { defaultLedgerPath, recordSealEvent } from "../ledger/use.js";
import { activeSeals } from "./active.js";
import {
  getFileAtCommit,
  getModifiedFilesSince,
  isAncestor,
  resolveHead,
  resolveRef,
} from "./git.js";

export interface VerifySealsOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  base?: string | undefined;
  branch?: string | undefined;
  commit?: string | undefined;
  record?: boolean | undefined;
  ledgerPath?: string | undefined;
}

export interface SealVerifyItem {
  branch: string;
  relPath: string;
  valid: boolean;
  sealCommit: string;
  writerCommit: string;
  keyId: string;
  sealedPaths: string[];
  causes: string[];
  changedPaths: string[];
}

export interface VerifySealsResult {
  ok: boolean;
  code: number;
  output: string;
  seals: SealVerifyItem[];
  changedPaths?: string[];
}

function getHeadTestCommand(head: string, cwd: string, env?: NodeJS.ProcessEnv): string {
  const headYaml = getFileAtCommit(head, ".lykos/config.yaml", cwd, env);
  if (headYaml) {
    try {
      const parsed = parseYaml(headYaml) as Record<string, unknown> | null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const seal = parsed.seal as Record<string, unknown> | undefined;
        if (seal && typeof seal === "object" && typeof seal.test_command === "string") {
          return seal.test_command;
        }
      }
    } catch {}
  }
  const { resolved: config } = loadConfig({ cwd, ...(env ? { env } : {}) });
  return config.seal.test_command;
}

export async function verifySeals(opts: VerifySealsOptions = {}): Promise<VerifySealsResult> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  let head: string;
  if (opts.commit) {
    const resolved = resolveRef(opts.commit, cwd, env);
    if (!resolved) {
      const output = `lykos seal verify: commit "${opts.commit}" could not be resolved\n`;
      return { ok: false, code: 1, output, seals: [] };
    }
    head = resolved;
  } else {
    try {
      head = resolveHead(cwd, env);
    } catch {
      return { ok: false, code: 1, output: "lykos seal verify: could not resolve HEAD\n", seals: [] };
    }
  }

  const { resolved: config } = loadConfig({ cwd, ...(env ? { env } : {}) });

  if (opts.base) {
    const baseSha = resolveRef(opts.base, cwd, env);
    if (!baseSha) {
      const output = `lykos seal verify: base branch "${opts.base}" could not be resolved\n`;
      return { ok: false, code: 1, output, seals: [] };
    }
  }

  const active = activeSeals({
    cwd,
    env,
    ...(opts.base ? { base: opts.base } : {}),
    branch: opts.branch,
    commit: head,
  });

  if (active.length === 0) {
    const output = opts.branch
      ? `no active seal for branch "${opts.branch}"\n`
      : "no active seal\n";
    return { ok: true, code: 0, output, seals: [] };
  }

  const headTestCommand = getHeadTestCommand(head, cwd, env);
  const seals: SealVerifyItem[] = [];
  const lines: string[] = [];

  const ledgerPath =
    opts.ledgerPath ??
    (config.telemetry.ledger === ".lykos/ledger.db"
      ? defaultLedgerPath(cwd)
      : resolve(cwd, config.telemetry.ledger));

  for (const item of active) {
    const { relPath, sealCommit, seal, missingAtHead, modifiedAtHead, deletedInHistory, baseChanged, untrustedKey, invalidSignature } = item;
    const causes: string[] = [];

    if (untrustedKey) {
      causes.push(`untrusted key: public key "${seal.key_id}" not committed at merge-base`);
    }

    if (invalidSignature) {
      causes.push("invalid signature: seal signature verification failed");
    }

    if (baseChanged) {
      causes.push("seal base changed");
    }

    if (missingAtHead) {
      causes.push(`seal file deleted: ${relPath}`);
    } else if (deletedInHistory) {
      causes.push(`seal file deleted in history: ${relPath}`);
    } else if (item.rolledBackAtHead) {
      causes.push(`seal file rolled back: ${relPath}`);
    } else if (modifiedAtHead) {
      causes.push(`seal file modified: ${relPath}`);
    }

    const targetDesc = opts.commit ? opts.commit : "HEAD";
    if (!isAncestor(seal.writer_commit, head, cwd, env)) {
      causes.push(`seal writer commit ${seal.writer_commit.slice(0, 7)} is not an ancestor of ${targetDesc}`);
    }

    if (!isAncestor(sealCommit, head, cwd, env)) {
      causes.push(`seal commit ${sealCommit.slice(0, 7)} is not an ancestor of ${targetDesc}`);
    }

    const nonSealPaths = seal.sealed_paths.filter((p) => p !== relPath);
    const modified = getModifiedFilesSince(sealCommit, nonSealPaths, cwd, env, head);
    if (modified.length > 0) {
      const deleted = modified.filter((p) => getFileAtCommit(head, p, cwd, env) === null);
      if (deleted.length > 0) {
        causes.push(`deleted sealed paths: ${deleted.join(", ")}`);
      }
      causes.push(`changed sealed paths: ${modified.join(", ")}`);
    }

    if (seal.test_command !== headTestCommand) {
      causes.push(
        `changed test command: test_command "${seal.test_command}" differs from config at HEAD "${headTestCommand}"`,
      );
    }

    const valid = causes.length === 0;

    const changedPaths: string[] = [...modified];
    if (missingAtHead || modifiedAtHead || deletedInHistory || item.rolledBackAtHead) {
      changedPaths.push(relPath);
    }
    changedPaths.sort();

    seals.push({
      branch: seal.branch,
      relPath,
      valid,
      sealCommit,
      writerCommit: seal.writer_commit,
      keyId: seal.key_id,
      sealedPaths: seal.sealed_paths,
      causes,
      changedPaths,
    });

    if (valid) {
      lines.push(`Seal for branch "${seal.branch}" verified (${sealCommit.slice(0, 7)})`);
    } else {
      lines.push(`Seal verification failed for branch "${seal.branch}":`);
      for (const cause of causes) {
        lines.push(`  - ${cause}`);
      }
    }

    if (opts.record !== false) {
      try {
        await recordSealEvent(ledgerPath, {
          branch: seal.branch,
          kind: valid ? "verified" : "tampered",
          paths: seal.sealed_paths,
          creator: "cli",
          detail: {
            seal_commit: sealCommit,
            writer_commit: seal.writer_commit,
            key_id: seal.key_id,
            ...(causes.length > 0 ? { causes } : {}),
          },
        });
      } catch (err: unknown) {
        process.stderr.write(
          `lykos seal verify: warning: failed to record seal event in ledger: ${err instanceof Error ? err.message : String(err)}\n`,
        );
      }
    }
  }

  const ok = seals.every((s) => s.valid);
  const code = ok ? 0 : 1;
  const output = lines.join("\n") + "\n";
  const allChanged = Array.from(new Set(seals.flatMap((s) => s.changedPaths))).sort();

  return { ok, code, output, seals, ...(allChanged.length > 0 ? { changedPaths: allChanged } : {}) };
}
