import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { gitExec } from "./git.js";

export interface SealHookInstallResult {
  ok: boolean;
  hookPath: string;
  action: "installed" | "updated" | "kept";
  message: string;
}

const BEGIN_MARKER = "# --- lykos seal hook begin ---";
const END_MARKER = "# --- lykos seal hook end ---";

export function resolveGitHooksDir(cwd: string, env?: NodeJS.ProcessEnv): string {
  const relOrAbs = gitExec(["rev-parse", "--git-path", "hooks"], cwd, env);
  return isAbsolute(relOrAbs) ? relOrAbs : resolve(cwd, relOrAbs);
}

function isShellScript(content: string): boolean {
  const firstLine = content.split("\n")[0]?.trim() ?? "";
  if (!firstLine.startsWith("#!")) {
    return true;
  }
  const cmd = firstLine.slice(2).trim();
  const parts = cmd.split(/\s+/);
  const prog = parts[parts.length - 1] ?? "";
  const baseProg = prog.split("/").pop() ?? "";
  return ["sh", "bash", "dash", "zsh", "ash"].includes(baseProg);
}

export function buildHookScript(): string {
  const cliPath = resolve(import.meta.dirname, "..", "cli.ts");
  let tsxImport = "";
  try {
    tsxImport = import.meta.resolve("tsx");
  } catch {}

  // The lykos that installed the hook runs it. A `lykos` on PATH is only the fallback:
  // an older global install without `seal` would otherwise fail every push.
  const fwd = (p: string) => p.replace(/\\/g, "/");
  const node = fwd(process.execPath);
  const cli = fwd(cliPath);
  const installed = tsxImport && cliPath.endsWith(".ts")
    ? `"${node}" --import "${tsxImport}" "${cli}"`
    : `"${node}" "${cli}"`;

  return [
    BEGIN_MARKER,
    `lykos_run_verify() {`,
    `  if [ -x "${node}" ] && [ -f "${cli}" ]; then`,
    `    set -- ${installed} seal verify ${"$"}{1:+--commit "$1"}`,
    `  else`,
    `    set -- lykos seal verify ${"$"}{1:+--commit "$1"}`,
    `  fi`,
    `  "$@" </dev/null`,
    `}`,
    `lykos_tmp=$(mktemp 2>/dev/null || echo "/tmp/lykos-hook-$$")`,
    `cat > "$lykos_tmp"`,
    `if [ -s "$lykos_tmp" ]; then`,
    `  while read -r local_ref local_sha remote_ref remote_sha; do`,
    `    case "$local_sha" in`,
    `      ""|0000000000000000000000000000000000000000*) continue ;;`,
    `    esac`,
    `    lykos_run_verify "$local_sha"`,
    `    status=$?`,
    `    if [ $status -ne 0 ]; then`,
    `      rm -f "$lykos_tmp"`,
    `      exit $status`,
    `    fi`,
    `  done < "$lykos_tmp"`,
    `  exec < "$lykos_tmp"`,
    `  rm -f "$lykos_tmp"`,
    `else`,
    `  rm -f "$lykos_tmp"`,
    `  lykos_run_verify`,
    `  status=$?`,
    `  if [ $status -ne 0 ]; then`,
    `    exit $status`,
    `  fi`,
    `fi`,
    END_MARKER,
  ].join("\n");
}

export function installSealHook(cwd: string, env?: NodeJS.ProcessEnv): SealHookInstallResult {
  const hooksDir = resolveGitHooksDir(cwd, env);
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "pre-push");

  const hookBlock = buildHookScript();

  if (!existsSync(hookPath)) {
    const fullContent = `#!/bin/sh\n${hookBlock}\n`;
    writeFileSync(hookPath, fullContent, { mode: 0o755 });
    chmodSync(hookPath, 0o755);
    return {
      ok: true,
      hookPath,
      action: "installed",
      message: `Installed pre-push hook at ${hookPath}`,
    };
  }

  const existingContent = readFileSync(hookPath, "utf8");

  if (existingContent.includes(BEGIN_MARKER) && existingContent.includes(END_MARKER)) {
    const before = existingContent.slice(0, existingContent.indexOf(BEGIN_MARKER));
    const after = existingContent.slice(existingContent.indexOf(END_MARKER) + END_MARKER.length);
    const newContent = `${before}${hookBlock}${after}`;
    writeFileSync(hookPath, newContent, { mode: 0o755 });
    chmodSync(hookPath, 0o755);
    return {
      ok: true,
      hookPath,
      action: "updated",
      message: `Updated Lykos pre-push hook at ${hookPath}`,
    };
  }

  if (isShellScript(existingContent)) {
    const lines = existingContent.split("\n");
    let newContent: string;
    if (lines.length > 0 && lines[0]!.startsWith("#!")) {
      newContent = `${lines[0]}\n${hookBlock}\n${lines.slice(1).join("\n")}`;
    } else {
      newContent = `#!/bin/sh\n${hookBlock}\n${existingContent}`;
    }

    writeFileSync(hookPath, newContent, { mode: 0o755 });
    chmodSync(hookPath, 0o755);
    return {
      ok: true,
      hookPath,
      action: "updated",
      message: `Added Lykos pre-push hook to existing hook at ${hookPath}`,
    };
  }

  // Non-shell hook: move to pre-push.user and delegate to it
  let userHookName = "pre-push.user";
  let counter = 1;
  while (existsSync(join(hooksDir, userHookName))) {
    userHookName = `pre-push.user.${counter++}`;
  }
  const userHookPath = join(hooksDir, userHookName);
  renameSync(hookPath, userHookPath);
  chmodSync(userHookPath, 0o755);

  const delegator = [
    `USER_HOOK="$(dirname "$0")/${userHookName}"`,
    `if [ -x "$USER_HOOK" ]; then`,
    `  exec "$USER_HOOK" "$@"`,
    `fi`,
  ].join("\n");

  const newContent = `#!/bin/sh\n${hookBlock}\n${delegator}\n`;
  writeFileSync(hookPath, newContent, { mode: 0o755 });
  chmodSync(hookPath, 0o755);
  return {
    ok: true,
    hookPath,
    action: "updated",
    message: `Added Lykos pre-push hook and preserved existing non-shell hook as ${userHookName}`,
  };
}
