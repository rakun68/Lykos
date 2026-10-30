import { detectDefaultBase, loadConfig } from "../config/load.js";
import { activeSeals } from "./active.js";
import { getFileAtCommit, getModifiedFilesSince, isAncestor, resolveHead, resolveRef } from "./git.js";
import type { SealStatus, SealVerdict } from "./types.js";

export interface SealStatusOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv | undefined;
  json?: boolean | undefined;
  base?: string | undefined;
  branch?: string | undefined;
}

export interface SealStatusResult {
  code: number;
  output: string;
  seals: SealStatus[];
}

export function sealStatus(opts: SealStatusOptions): SealStatusResult {
  const cwd = opts.cwd;
  const env = opts.env ?? process.env;

  const head = resolveHead(cwd, env);
  const { resolved: config } = loadConfig({ cwd, env });
  const base = opts.base || config.seal.base || detectDefaultBase(cwd);
  const baseSha = resolveRef(base, cwd, env);

  if (!baseSha) {
    const output = `lykos seal status: base branch "${base}" could not be resolved\n`;
    return { code: 1, output, seals: [] };
  }

  const active = activeSeals({ cwd, env, base, branch: opts.branch });
  const sealStatuses: SealStatus[] = [];

  for (const item of active) {
    const { relPath, sealCommit, seal, missingAtHead, modifiedAtHead, rolledBackAtHead, untrustedKey, invalidSignature } = item;
    let verdict: SealVerdict = "valid";
    let reason: string | undefined;

    if (untrustedKey) {
      verdict = "untrusted_key";
      reason = `public key "${seal.key_id}" not committed at merge-base`;
    } else if (invalidSignature) {
      verdict = "tampered";
      reason = "seal signature verification failed";
    } else if (item.baseChanged) {
      verdict = "tampered";
      reason = "seal base changed";
    } else if (missingAtHead) {
      verdict = "tampered";
      reason = `seal file "${relPath}" missing at HEAD`;
    } else if (item.deletedInHistory) {
      verdict = "tampered";
      reason = `seal file "${relPath}" deleted in history`;
    } else if (rolledBackAtHead) {
      verdict = "tampered";
      reason = `seal file "${relPath}" rolled back to an older version`;
    } else if (modifiedAtHead) {
      verdict = "tampered";
      reason = `seal file "${relPath}" modified since seal commit (${sealCommit.slice(0, 7)})`;
    } else if (!isAncestor(seal.writer_commit, head, cwd, env)) {
      verdict = "stale";
      reason = `writer_commit ${seal.writer_commit.slice(0, 7)} is not an ancestor of HEAD`;
    } else {
      const nonSealPaths = seal.sealed_paths.filter((p) => p !== relPath);
      const modified = getModifiedFilesSince(sealCommit, nonSealPaths, cwd, env);
      if (modified.length > 0) {
        const deleted = modified.filter((p) => getFileAtCommit(head, p, cwd, env) === null);
        if (deleted.length > 0) {
          verdict = "tampered";
          reason = `sealed paths deleted since seal commit: ${deleted.join(", ")}`;
        } else {
          verdict = "stale";
          reason = `sealed paths modified since writer_commit: ${modified.join(", ")}`;
        }
      }
    }

    sealStatuses.push({
      branch: seal.branch,
      verdict,
      sealCommit,
      writerCommit: seal.writer_commit,
      keyId: seal.key_id,
      sealedPaths: seal.sealed_paths,
      red: seal.red,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  if (opts.json) {
    const output = JSON.stringify(sealStatuses, null, 2) + "\n";
    const code = sealStatuses.some((s) => s.verdict !== "valid") ? 1 : 0;
    return { code, output, seals: sealStatuses };
  }

  if (sealStatuses.length === 0) {
    return { code: 0, output: "no active seals found\n", seals: [] };
  }

  const lines: string[] = [];
  for (const s of sealStatuses) {
    lines.push(`Seal for branch "${s.branch}":`);
    lines.push(`  Status: ${s.verdict}${s.reason ? ` (${s.reason})` : ""}`);
    lines.push(`  Seal commit: ${s.sealCommit}`);
    lines.push(`  Writer commit: ${s.writerCommit}`);
    lines.push(`  Key ID: ${s.keyId}`);
    lines.push(`  Sealed paths (${s.sealedPaths.length}):`);
    for (const p of s.sealedPaths) {
      lines.push(`    ${p}`);
    }
    lines.push(`  Red tests (${s.red.length}):`);
    for (const r of s.red) {
      const d = r.describe.length > 0 ? `${r.describe.join(" > ")} > ` : "";
      lines.push(`    ${r.file} > ${d}${r.name} [${r.failure}]`);
    }
  }

  const output = lines.join("\n") + "\n";
  const code = sealStatuses.some((s) => s.verdict !== "valid") ? 1 : 0;
  return { code, output, seals: sealStatuses };
}
