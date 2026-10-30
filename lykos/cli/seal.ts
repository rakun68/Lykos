import { sealKeyInit } from "../seal/keys.js";
import { sealCreate } from "../seal/create.js";
import { sealStatus } from "../seal/status.js";
import { verifySeals } from "../seal/verify.js";
import { installSealHook } from "../seal/hook.js";
import { stdoutWrite } from "../tui/io-mode.js";

export async function runSeal(cwd: string, args: string[]): Promise<number> {
  const [sub, ...rest] = args;

  if (sub === "key") {
    const [subKey] = rest;
    if (subKey === "init") {
      try {
        const homeDir = process.env.HOME || process.env.USERPROFILE;
        const res = sealKeyInit(cwd, homeDir);
        stdoutWrite(
          `Initialized seal key ${res.keyId}\nPublic key committed at ${res.pubRelPath}\nPrivate key saved at ${res.privPath}\n`,
        );
        return 0;
      } catch (err: unknown) {
        process.stderr.write(
          `lykos seal key init: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 1;
      }
    }
    process.stderr.write('lykos seal key: expected "init"\n');
    return 1;
  }

  if (sub === "create") {
    let branch: string | undefined;
    let commit: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === "--branch") {
        branch = rest[++i];
      } else if (a.startsWith("--branch=")) {
        branch = a.slice("--branch=".length);
      } else if (!a.startsWith("-") && !commit) {
        commit = a;
      }
    }

    try {
      const homeDir = process.env.HOME || process.env.USERPROFILE;
      const res = await sealCreate({
        cwd,
        targetCommit: commit,
        homeDir,
        branch,
      });
      if (!res.ok) {
        for (const err of res.errors ?? ["seal creation failed"]) {
          process.stderr.write(`${err}\n`);
        }
        return 1;
      }
      if (res.warnings) {
        for (const w of res.warnings) {
          process.stderr.write(`${w}\n`);
        }
      }
      stdoutWrite(
        `Sealed branch "${res.seal!.branch}" at commit ${res.sealCommit!.slice(0, 7)}\n`,
      );
      return 0;
    } catch (err: unknown) {
      process.stderr.write(
        `lykos seal create: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }

  if (sub === "status") {
    const isJson = rest.includes("--json");
    let branch: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === "--branch") {
        branch = rest[++i];
      } else if (a.startsWith("--branch=")) {
        branch = a.slice("--branch=".length);
      }
    }

    try {
      const res = sealStatus({ cwd, json: isJson, branch });
      stdoutWrite(res.output);
      return res.code;
    } catch (err: unknown) {
      process.stderr.write(
        `lykos seal status: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }

  if (sub === "verify") {
    let branch: string | undefined;
    let commit: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i]!;
      if (a === "--branch") {
        branch = rest[++i];
      } else if (a.startsWith("--branch=")) {
        branch = a.slice("--branch=".length);
      } else if (a === "--commit") {
        commit = rest[++i];
      } else if (a.startsWith("--commit=")) {
        commit = a.slice("--commit=".length);
      }
    }

    try {
      const res = await verifySeals({ cwd, branch, commit });
      if (res.code === 0) {
        stdoutWrite(res.output);
      } else {
        process.stderr.write(res.output);
      }
      return res.code;
    } catch (err: unknown) {
      process.stderr.write(
        `lykos seal verify: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return 1;
    }
  }

  if (sub === "hook") {
    const [subHook] = rest;
    if (subHook === "install") {
      try {
        const res = installSealHook(cwd);
        stdoutWrite(`${res.message}\n`);
        return 0;
      } catch (err: unknown) {
        process.stderr.write(
          `lykos seal hook install: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 1;
      }
    }
    process.stderr.write('lykos seal hook: expected "install"\n');
    return 1;
  }

  process.stderr.write('lykos seal: expected "key init", "create", "status", "verify", or "hook install"\n');
  return 1;
}
