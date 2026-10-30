// T88 — a hung `bash` call must return.
// (`docs/25-phase15-sharpening-tasks.md` T88.)
//
// T88.1 was "find out what Pi's default actually is", because nothing in
// this repo recorded it. The answer, read from the shipped tool rather than
// assumed:
//
//   timeout: Type.Optional(Type.Number({
//     description: "Timeout in seconds (optional, no default timeout)" }))
//
//   function resolveTimeoutMs(timeout) {
//     if (timeout === undefined) return undefined;   // <- no default
//     ...
//   }
//
// So there is **no default timeout**. A command only stops if the model
// thought to pass one, and a cheap model does not think to pass one. An
// agent that starts a dev server, an interactive REPL, or an `npm` command
// that stops for a prompt blocks the session with no way out but the human —
// and in a one-shot `lykos run` there is no human watching.
//
// WHY THIS CANNOT BE A SKILL OR AN EXTENSION. It is process control beneath
// the tool. `tool_call` could rewrite the arguments to inject a timeout, but
// that is a worse version of this: it changes what the model asked for
// without telling it, and it cannot turn the resulting throw into usable
// output. Lykos already owns `BashOperations` for the approval gate, which
// is the correct seam and the one this uses.
//
// WHAT IT DOES NOT DO: cap a timeout the model chose. If the model asks for
// 600 seconds it gets 600 seconds — it is allowed to know its own build is
// slow. The default applies only when nothing was asked for.

/**
 * Applied when the caller passed no timeout. Chosen to sit well above a
 * normal test suite (this repo's own is ~60s) so the brake never fires on
 * work that was going to finish, and well below "the session is lost".
 */
export const DEFAULT_BASH_TIMEOUT_SECONDS = 300;

/** `LYKOS_BASH_TIMEOUT=0` restores Pi's unbounded behaviour. */
export function bashTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.LYKOS_BASH_TIMEOUT;
  if (raw === undefined || raw.trim() === "") return DEFAULT_BASH_TIMEOUT_SECONDS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

/**
 * The timeout to actually pass down: the model's if it named one, ours if it
 * did not, and none if the operator turned the default off.
 */
export function resolveBashTimeout(
  requested: number | undefined,
  fallback: number | undefined,
): number | undefined {
  if (typeof requested === "number" && Number.isFinite(requested) && requested > 0) return requested;
  return fallback;
}

/** Pi throws `timeout:<seconds>` from its own exec when its timer fires. */
export function isTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /^timeout:/.test(msg);
}

/**
 * The note appended to whatever the command managed to print.
 *
 * T88.3/T88.4: the partial output is the point. A build that hung after
 * printing two hundred lines has usually already printed the reason, and a
 * bare "timed out" throws that away. The remedies are named in the harness's
 * own vocabulary because the model's next move is otherwise the same call.
 */
export function timeoutNotice(command: string, seconds: number, sawOutput: boolean): string {
  const printed = sawOutput
    ? "The output above is everything it printed before it was killed."
    : "It printed nothing at all before it was killed, which usually means it was waiting for input.";
  return (
    `\n[lykos-timeout] Killed after ${seconds}s: \`${command}\` did not exit.\n` +
    `${printed}\n` +
    `Do not simply re-run it. If it is a long-running process (a server, a watcher), ` +
    `start it in the background and redirect its output to a file. If it may be waiting for input, ` +
    `re-run it with a non-interactive flag. If it is genuinely slow, pass an explicit larger timeout.`
  );
}

/** Exit code reported for a timed-out command. 124 is what `timeout(1)` uses. */
export const TIMEOUT_EXIT_CODE = 124;
