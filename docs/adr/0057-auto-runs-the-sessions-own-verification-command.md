# Auto runs the session's own verification command

Decided by the maintainer in the single-engine and delegation review. **Amends
ADR-0041** (three permission modes, chosen by
the user and remembered per project).

## The decision

**In Auto mode, an action matching the session's exact verification command runs without asking.**

- **Exact match only.** The command must match `verifyCommand.trim()` after trimming surrounding
  whitespace on both sides. No broader variants, subpaths, flags, pipes, redirects, chaining
  (`&&`, `;`, `||`, `&`), subshells, or command substitutions are covered.
- **Auto mode only.** Manual and Accept Edits are unchanged: both prompt (or deny in a delegated
  session) for the verification command.
- **Non-destructive only.** If the configured verification command is classified as `destructive`
  by `classifyCommandRisk(verifyCommand)`, it is never run silently and always prompts.
- **The read-only ceiling still binds.** A read-only specialist (`readOnly: true`, e.g. review) or
  session is denied the verification command under Auto, exactly as it is denied any other bash
  write or execution.
- **PowerShell arm is untouched.** The PowerShell arm has no command string and never matches the
  allowance.
- **Session lifecycle only; never persisted.** The allowance is resolved per session from the active
  verification gate policy (`resolveSessionGatePolicy()`), is not written to the per-project
  permission store (`permissions.json`), and is never offered as "always".
- **Inherited by subagents.** Child and subagent gates inherit the parent's `verifyCommand` and
  apply the same carve-out under Auto mode.
- **Withheld on untrusted projects on the host.** In accordance with T194, if an untrusted project's
  discovered verification script is withheld on the host, the allowance has no command and does not
  apply.

## Why

A delegated coding agent running in Auto mode is expected to iterate with tests: modify code, run the
project's test suite to verify, and commit or adjust. Under ADR-0041, ordinary commands in Auto prompted
once to offer remembering the pattern (`npm test`). But a delegated session (MCP worker or `lykos run`)
has nobody to answer interactive prompts (`dontAsk`), turning all prompts into denials. As a result,
delegated workers in Auto could not run the very verification command configured for the task without
a prior out-of-band allowlist entry.

The carve-out is kept strictly narrow:
1. **Exact trimmed string:** Allowing `npm test` must not silently allow `npm test -- --watch`,
   `npm test; rm -rf /`, `npm test && git push`, or `npm run build`. Allowing variations or prefix
   matching would open command-injection or chaining loopholes.
2. **Non-destructive:** Even if a user misconfigures a destructive command as the gate command,
   Auto must never run destructive operations silently.
3. **No automatic persistence:** Project permission files should only contain explicit user approvals,
   not transient session gate discovery.

## Options considered

- **Treat any test runner command as safe in Auto.** Rejected: arbitrary test commands can execute
  arbitrary scripts or carry destructive side effects. Only the project's own verified gate command
  is safe for autonomous execution.
- **Add a new configuration flag to opt into running verification commands.** Rejected: Auto mode's
  core purpose is autonomous completion of safe work; adding a separate flag adds configuration
  clutter without safety gains over the exact-string check.
- **Allow in Accept Edits as well.** Rejected: Accept Edits is designed around file mutations and
  common file commands; running arbitrary build/test commands remains subject to confirmation.

## Consequences

- `decideForMode` accepts an optional `verifyCommand` option.
- Delegated gates and interactive approval modal gates receive the resolved session verification
  command.
- Delegated sessions running in Auto mode can verify their work autonomously without prompt denials.
